// Cron Task Manager for MyAgents
// Manages scheduled task execution with persistence and recovery
// Includes Rust-layer scheduler that directly executes tasks via Sidecar
//
// Key responsibilities:
// - Task lifecycle management (create, start, pause, stop, complete)
// - Interval-based scheduling with overlap prevention
// - Session activation/deactivation coordination with SidecarManager
// - Persistence to ~/.myagents/cron_tasks.json with auto-recovery on startup

use chrono::{DateTime, Utc};
use cron::Schedule as CronExprSchedule;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tokio::time::Duration;
use uuid::Uuid;

use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};
use crate::sidecar::{
    execute_cron_task, CronExecutePayload, ManagedSidecarManager, ProviderEnv,
    SidecarOwner, ensure_session_sidecar, release_session_sidecar,
};

/// Normalize a path for comparison (removes trailing slashes)
/// This ensures consistent path matching regardless of how paths are formatted
fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_string() // Keep original if it's root path
    } else {
        trimmed.to_string()
    }
}

/// Validate a cron expression (and optional timezone) at data-boundary time
/// so bad input is rejected when saved, not silently swallowed at next fire
/// (which would leave the scheduler dead and the task status "running" with
/// no tick). Returns `Ok(())` when the expression parses and the tz (if
/// supplied) is an IANA id we recognize.
pub fn validate_cron_expression(expr: &str, tz: Option<&str>) -> Result<(), String> {
    // `next_cron_fire_time` already does both checks and throws away the
    // result; reuse it so the validator stays in lockstep with the runtime
    // parser — no way for validation to diverge from execution.
    next_cron_fire_time(expr, tz).map(|_| ())
}

/// Parse a cron expression and compute the next fire time as a wall-clock UTC timestamp.
/// Accepts standard 5-field cron expressions (min hour dom month dow) and
/// converts to the 7-field format required by the `cron` crate (sec min hour dom month dow year).
fn next_cron_fire_time(expr: &str, tz: Option<&str>) -> Result<DateTime<Utc>, String> {
    // Normalize: 5-field → 7-field by prepending "0 " (seconds) and appending " *" (year)
    let expr7 = {
        let fields: Vec<&str> = expr.trim().split_whitespace().collect();
        match fields.len() {
            5 => format!("0 {} *", expr.trim()),
            6 => format!("0 {}", expr.trim()),  // already has year
            7 => expr.trim().to_string(),         // already full 7-field
            _ => return Err(format!("Invalid cron expression '{}': expected 5-7 fields, got {}", expr, fields.len())),
        }
    };

    let schedule = CronExprSchedule::from_str(&expr7)
        .map_err(|e| format!("Failed to parse cron expression '{}' (normalized: '{}'): {}", expr, expr7, e))?;

    // Resolve timezone
    let now = if let Some(tz_str) = tz {
        let tz: chrono_tz::Tz = tz_str.parse()
            .map_err(|_| format!("Invalid timezone '{}' for cron expression", tz_str))?;
        Utc::now().with_timezone(&tz)
    } else {
        // Default to UTC — use a fixed-offset representation
        Utc::now().with_timezone(&chrono_tz::UTC)
    };

    let next = schedule.after(&now).next()
        .ok_or_else(|| format!("No upcoming fire time for cron expression '{}'", expr))?;

    Ok(next.with_timezone(&Utc))
}

/// Wall-clock aware sleep that survives system suspend/hibernate.
///
/// Unlike `tokio::time::sleep(duration)` which uses monotonic time (pauses during
/// system sleep on macOS), this function polls `Utc::now()` (wall clock) every
/// POLL_INTERVAL seconds, correctly detecting that the scheduled time has passed
/// even after the system wakes from sleep.
///
/// Returns `true` if target time was reached, `false` if shutdown was requested.
async fn sleep_until_wallclock(
    target: DateTime<Utc>,
    shutdown: &RwLock<bool>,
    task_id: &str,
) -> bool {
    const POLL_SECS: u64 = 30;
    loop {
        let now = Utc::now();
        if now >= target {
            return true;
        }
        // Check shutdown flag
        if *shutdown.read().await {
            ulog_info!("[CronTask] Task {} wallclock sleep interrupted by shutdown", task_id);
            return false;
        }
        // Sleep for min(remaining, POLL_SECS) — short sleeps survive system suspend
        let remaining_secs = (target - now).num_seconds().max(0) as u64;
        let sleep_secs = remaining_secs.min(POLL_SECS).max(1);
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

/// Atomic file save helper - writes to temp file first, then renames
/// This prevents data corruption if the process crashes mid-write.
///
/// Pattern 5 (single-writer invariant): wraps the read-modify-write in
/// `with_file_lock` against a sibling `cron_tasks.json.lock` directory and
/// uses a unique tmp suffix (`.tmp.{pid}.{nanos}`) so two concurrent saves
/// don't race on the same temp path.
async fn atomic_save_tasks(
    storage_path: &PathBuf,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
) -> Result<(), String> {
    // Read tasks under lock
    let tasks_snapshot = {
        let tasks_guard = tasks.read().await;
        tasks_guard.values().cloned().collect::<Vec<_>>()
    };
    // Lock released here

    let store = CronTaskStore { tasks: tasks_snapshot };
    let task_count = store.tasks.len();

    let content = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("Failed to serialize cron tasks: {}", e))?;

    // Ensure directory exists
    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cron tasks directory: {}", e))?;
    }

    let lock_path = storage_path.with_file_name("cron_tasks.json.lock");
    let storage_path_owned = storage_path.clone();

    crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            // Unique tmp suffix avoids two concurrent savers stepping on
            // each other's `cron_tasks.tmp` (the bug from Pattern 5 §5.1).
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let tmp_path = storage_path_owned.with_file_name(format!(
                "cron_tasks.json.tmp.{}.{}",
                std::process::id(),
                nanos
            ));

            std::fs::write(&tmp_path, &content).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to write cron tasks temp file: {}", e),
                ))
            })?;
            std::fs::rename(&tmp_path, &storage_path_owned).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to rename cron tasks file: {}", e),
                ))
            })?;
            Ok(())
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    ulog_debug!("[CronTask] Atomically saved {} tasks to disk", task_count);
    Ok(())
}

/// Run mode for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Keep session context between executions
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}

/// Task status (simplified: only Running and Stopped)
/// Stopped includes: manual stop, end conditions met, AI exit
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is running and will execute at intervals
    Running,
    /// Task was stopped (includes: manual stop, end conditions met, AI exit)
    Stopped,
}

/// End conditions for a cron task
///
/// `skip_serializing_if = "Option::is_none"` on the optional fields is
/// load-bearing: without it, Rust serializes `None` as JSON `null`, and the
/// renderer's modal init code (`CronTaskSettingsModal::endCondInit`) checks
/// `ec.maxExecutions !== undefined` to decide whether the task has end
/// conditions. `null !== undefined` is `true` in JS, so a "永久运行" task
/// (deadline=None, max_executions=None, ai_can_exit=false) would round-trip
/// through Rust as `{deadline: null, maxExecutions: null, aiCanExit: false}`
/// and the modal would mistakenly display "条件停止 + 执行次数 10". Skipping
/// the None fields keeps the JSON shape aligned with TS optional convention
/// (omit the property → `undefined` in the consumer).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EndConditions {
    /// Task will stop after this time (ISO timestamp)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<DateTime<Utc>>,
    /// Task will stop after this many executions
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    /// Allow AI to exit the task via ExitCronTask tool
    pub ai_can_exit: bool,
}

/// Provider environment for task execution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens_param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_format: Option<String>,
}

/// Explicit provider routing intent for a cron task (PRD #119, 2026-05).
///
/// Pre-#119, cron tasks could not unambiguously express their routing
/// intent: `provider_env: None` could mean "follow the workspace agent"
/// (legacy default) OR "explicitly use Anthropic subscription". The
/// sidecar handler had to guess — and silently picked "follow agent",
/// which caused subscription-intent crons to inherit a third-party
/// `providerEnvJson` from the agent snapshot when the user later changed
/// the agent's provider. The mirror failure (third-party intent silently
/// overridden by agent snapshot) was the original report.
///
/// This enum makes intent first-class:
///
///   - `FollowAgent` — pre-#119 default. Snapshot resolution at execute
///     time; agent changes between ticks affect this cron. Legacy tasks
///     deserialize into this variant via serde default.
///
///   - `Subscription` — cron explicitly runs on Anthropic subscription
///     auth, regardless of what the agent looks like at execute time.
///     `provider_env` is ignored.
///
///   - `Explicit` — cron runs on the captured `provider_env` regardless
///     of agent changes. `provider_env` MUST be `Some(...)` when this
///     variant is used.
///
/// Behavior at execute time (sidecar `/cron/execute(-sync)`): the handler
/// branches on intent and either follows the snapshot path (`FollowAgent`)
/// or short-circuits to the task's own values (`Subscription` /
/// `Explicit`). See `src/server/index.ts` for the resolution code.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderIntent {
    /// Snapshot-based: follow the workspace agent at execute time. Legacy
    /// default for crons created before #119 — present in this variant
    /// because serde fills missing fields with `Default::default()`.
    #[default]
    FollowAgent,
    /// Explicitly use Anthropic subscription. Ignores `provider_env`.
    Subscription,
    /// Explicitly use the captured `provider_env`. Snapshot is bypassed.
    /// Caller MUST ensure `provider_env` is `Some(...)` when this variant
    /// is selected; an `Explicit` intent with `provider_env: None` is a
    /// malformed task — the sidecar handler fails the request with
    /// HTTP 400 rather than silently degrading to subscription, which
    /// could still produce the model+endpoint mismatch this enum was
    /// introduced to prevent.
    Explicit,
}

/// Delivery target for IM Bot cron task results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDelivery {
    pub bot_id: String,
    pub chat_id: String,
    pub platform: String,
}

/// Flexible schedule types for cron tasks (v0.1.21)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CronSchedule {
    /// One-shot: execute at a specific time, then stop
    At { at: String },
    /// Recurring interval in minutes, with optional delayed start
    Every { minutes: u32, #[serde(default, skip_serializing_if = "Option::is_none")] start_at: Option<String> },
    /// Cron expression with optional timezone
    Cron { expr: String, tz: Option<String> },
    /// Ralph Loop: completion-triggered re-execution (no time-based scheduling)
    /// AI finishes → 3s buffer → execute again. Exponential backoff on failure.
    Loop,
}

/// A scheduled cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    pub status: TaskStatus,
    #[serde(default)]
    pub execution_count: u32,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_executed_at: Option<DateTime<Utc>>,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    /// Tab ID associated with this task (for frontend reference)
    #[serde(default)]
    pub tab_id: Option<String>,
    /// Exit reason (set when AI calls ExitCronTask)
    #[serde(default)]
    pub exit_reason: Option<String>,
    /// Permission mode for execution (auto, plan, fullAgency, custom)
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Model to use for execution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider environment (API key, base URL).
    ///
    /// PRD 0.2.9 — DEPRECATED. Read-only legacy field: deserialization
    /// honored so 0.2.8 `cron_tasks.json` still loads and the in-memory
    /// CronTask still routes correctly via the `Explicit` intent path. But
    /// `skip_serializing` ensures we **never write this back to disk** —
    /// so on the next `save_to_disk()` (any field edit) the credential
    /// copy disappears and the cron either runs subscription/follow or the
    /// user re-picks a provider. PRD 0.2.9 R2 invariant: zero credential
    /// copies in `~/.myagents/cron_tasks.json`.
    #[serde(default, skip_serializing)]
    pub provider_env: Option<TaskProviderEnv>,
    /// PRD 0.2.9 — Per-task provider id (live-resolution intent).
    ///
    /// Replaces `provider_env` as the canonical persistence shape. When set,
    /// the sidecar calls `resolveProviderEnv(providerId)` at every tick from
    /// `~/.myagents/config.json`, so:
    ///   * API key rotation propagates instantly (no need to re-save tasks)
    ///   * Provider deletion fails the next tick with a clear error
    ///   * No credential copies in `cron_tasks.json`
    ///
    /// `None` retains the FollowAgent / legacy snapshot semantics. See
    /// `tech_docs/task_provider_routing.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Routing intent for this cron — see `ProviderIntent` for full design.
    /// Defaults to `FollowAgent` (legacy snapshot behavior) so pre-#119 tasks
    /// keep their existing semantics across upgrade.
    /// PRD 0.2.9 — when `provider_id` is set, the sidecar ignores this field
    /// (live-resolution path takes precedence). Retained so 0.2.8 cron tasks
    /// still resolve correctly.
    #[serde(default)]
    pub provider_intent: ProviderIntent,
    /// Agent runtime snapshot for external Runtime tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Runtime-scoped config snapshot for external Runtime tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4). Snapshot from
    /// the parent Task at projection time. `None` = follow workspace MCP
    /// config; `Some([...])` = enable only these server ids for the task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Last error message (if any)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Last run success flag — denormalized from `cron_runs/<id>.jsonl` so
    /// `cron list` doesn't need to crack open every jsonl on every list call.
    /// Updated by `record_execution_result()` after each tick. PRD 0.2.5 R6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ok: Option<bool>,
    /// Last run duration in milliseconds — same denormalization rationale as
    /// `last_run_ok`. PRD 0.2.5 R6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_duration_ms: Option<u64>,
    // ===== IM Bot cron fields (v0.1.21) =====
    /// Source IM Bot ID that created this task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    /// Where to deliver execution results
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    /// Flexible schedule (overrides interval_minutes when present)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    /// Human-readable name for the task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Computed next execution time (enriched at read time, not persisted)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_execution_at: Option<String>,
    /// Internal SDK session ID where conversation data is stored.
    /// Differs from `session_id` (Sidecar session key) — this tracks the actual
    /// SDK session UUID for frontend to load conversation history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_session_id: Option<String>,
    /// Last activity timestamp — updated on create, start, stop, execute.
    /// Used by frontend to sort tasks by most recent activity.
    #[serde(default = "chrono::Utc::now")]
    pub updated_at: DateTime<Utc>,
    /// Reverse pointer into the Task Center (v0.1.69, PRD §11.2). When set,
    /// this CronTask was created by a Task dispatch; each firing looks up the
    /// `Task.dispatchOrigin` + `task.md` to build the prompt dynamically
    /// (PRD §9.3.1) instead of using the `prompt` field as a frozen string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

/// Configuration for creating a new cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskConfig {
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9 — DEPRECATED. New callers SHOULD pass `provider_id` instead;
    /// retained for the legacy IM-Bot / heartbeat paths that still build a
    /// frozen env at schedule time. See `provider_id` below.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
    /// PRD 0.2.9 — Per-task provider id (live-resolution intent). Preferred
    /// over `provider_env` for all new callers. `None` keeps FollowAgent /
    /// legacy snapshot semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Provider routing intent (PRD #119). Callers without explicit intent —
    /// legacy IM Bot path, Task Center dispatch — leave this as
    /// `FollowAgent` (the serde default) and keep snapshot semantics.
    /// Frontend cron creation paths set this to `Subscription` or `Explicit`
    /// based on what the user picked when scheduling.
    /// PRD 0.2.9 — when `provider_id` is set, the sidecar ignores this field.
    #[serde(default)]
    pub provider_intent: ProviderIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list snapshot (PRD 0.2.4 §需求 4). Mirrors the
    /// `Task.mcp_enabled_servers` override; `None` = follow workspace MCP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    // ===== IM Bot cron fields (v0.1.21) =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Reverse pointer into Task Center (v0.1.69, PRD §11.2). Set when the
    /// CronTask is dispatched by a Task Center task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Default permission_mode for new cron tasks: empty string = sentinel for
/// "user didn't pick" → resolved to runtime max at execution time
/// (see src/shared/types/runtime.ts::resolveCronPermissionMode).
///
/// Pre-v0.2.5 this returned "auto", which the cron resolver respected
/// literally as acceptEdits — silently breaking unattended runs whenever
/// WebSearch / Bash / mcp__* hit the human-approval queue. PRD 0.2.5 R3.
fn default_permission_mode() -> String {
    String::new()
}

impl Default for RunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}

/// Persistent storage for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CronTaskStore {
    #[serde(default)]
    tasks: Vec<CronTask>,
}

// ============ Cron Run Records (execution history) ============

const MAX_RUN_RECORDS: usize = 500;

/// Sentinel prefix used by `execute_task_directly` to flag an `Err` that is
/// NOT an execution failure but a deliberate "linked Task is in terminal
/// state, we've already called `stop_task`" short-circuit (v0.1.69 H2
/// cross-review follow-up).
///
/// The outer scheduler loop detects this prefix and skips:
///   1. writing a failure record to `cron_runs/<id>.jsonl`
///   2. setting `task.last_error`
///   3. emitting `cron:execution-error`
/// — without it, the graceful terminal-state stop would still surface to the
/// UI as a failed tick, giving the user a misleading "最近一次失败" badge
/// seconds before the task's real status flips to Stopped.
const TERMINAL_STOP_SENTINEL: &str = "__TERMINAL_STOP__:";

/// A single execution record for a cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    pub ts: i64,                    // Unix timestamp (ms)
    pub ok: bool,                   // Whether execution succeeded
    pub duration_ms: u64,           // Execution duration
    pub content: Option<String>,    // AI output text (delivery content)
    pub error: Option<String>,      // Error message on failure
}

/// PRD 0.2.5 R4 — return shape for `trigger_now()`. Echoed back to the
/// caller (CLI / HTTP) so they can display "what got fired, where to look".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerNowInfo {
    pub task_id: String,
    pub session_id: String,
    pub dispatched_at: String,
}

/// Sanitize task_id to prevent path traversal (remove path separators and dots sequences)
fn sanitize_task_id(task_id: &str) -> String {
    task_id
        .replace(['/', '\\', '\0'], "")
        .replace("..", "")
}

/// Get the JSONL file path for a task's run records
fn run_record_path(task_id: &str) -> PathBuf {
    let safe_id = sanitize_task_id(task_id);
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("cron_runs")
        .join(format!("{}.jsonl", safe_id))
}

/// Append a run record to ~/.myagents/cron_runs/<taskId>.jsonl
/// Truncates to MAX_RUN_RECORDS if exceeded.
pub fn record_cron_run(task_id: &str, record: &CronRunRecord) -> Result<(), String> {
    let path = run_record_path(task_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cron_runs dir: {}", e))?;
    }

    let line = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize run record: {}", e))?
        + "\n";

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open run record file: {}", e))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write run record: {}", e))?;

    // Truncate if over limit
    truncate_run_file_if_needed(&path, MAX_RUN_RECORDS);
    Ok(())
}

/// Read the most recent `limit` run records (returned in chronological order)
pub fn read_cron_runs(task_id: &str, limit: usize) -> Vec<CronRunRecord> {
    let path = run_record_path(task_id);
    if !path.exists() {
        return vec![];
    }

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let capped = limit.min(100);
    let records: Vec<CronRunRecord> = content
        .lines()
        .rev()
        .take(capped)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // Reverse back to chronological order
    records.into_iter().rev().collect()
}

/// Truncate a JSONL file to keep only the last `max` lines
fn truncate_run_file_if_needed(path: &PathBuf, max: usize) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max {
        return;
    }

    // Keep only the last `max` lines
    let kept: Vec<&str> = lines[lines.len() - max..].to_vec();
    let new_content = kept.join("\n") + "\n";
    let _ = fs::write(path, new_content);
}

/// Event payload for cron task execution trigger
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskTriggerPayload {
    pub task_id: String,
    pub prompt: String,
    pub is_first_execution: bool,
    pub ai_can_exit: bool,
    pub workspace_path: String,
    pub session_id: String,
    pub run_mode: RunMode,
    pub notify_enabled: bool,
    pub tab_id: Option<String>,
}

// ============ Recovery Event Types (方案 A: Rust 统一恢复) ============

/// Event payload for a single task recovery success
/// Emitted as "cron:task-recovered" for each successfully recovered task
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskRecoveredPayload {
    pub task_id: String,
    pub session_id: String,
    pub workspace_path: String,
    pub port: u16,
    pub status: String,
    pub execution_count: u32,
    pub interval_minutes: u32,
}

/// Event payload for task status changes
/// Emitted as "cron:task-status-changed" when task status changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskStatusChangedPayload {
    pub task_id: String,
    pub session_id: String,
    pub old_status: String,
    pub new_status: String,
    pub reason: Option<String>,
}

/// Event payload for recovery summary
/// Emitted as "cron:recovery-summary" after all recovery attempts complete
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRecoverySummaryPayload {
    pub total_tasks: u32,
    pub recovered_count: u32,
    pub failed_count: u32,
    pub failed_tasks: Vec<CronRecoveryFailedTask>,
}

/// Info about a single failed recovery
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRecoveryFailedTask {
    pub task_id: String,
    pub workspace_path: String,
    pub error: String,
}

/// Compute the next execution time for a cron task (enrichment helper).
/// Returns an RFC3339 string or None if the task is stopped / no schedule.
///
/// v0.1.69 cross-review: past-due values (cold start before first execution,
/// or catch-up after system sleep) used to be returned verbatim — e.g. an
/// `At` task whose target time has passed returned the stale timestamp, a
/// cold-started `Every` task returned `created_at + interval` even though
/// the scheduler actually fires `~2 s` after spawn. SummaryCard now prefers
/// this value over its own cron-parser, so stale timestamps would show
/// "下次触发 5 分钟前" — obviously wrong. Fix: clamp any past-due result
/// forward to match the scheduler's own "fire in 2s / 5s" fallback in
/// `start_task_scheduler`'s `initial_target` block, so the UI and the
/// scheduler agree.
fn compute_next_execution(task: &CronTask) -> Option<String> {
    if task.status != TaskStatus::Running {
        return None;
    }

    // Mirror of scheduler's `initial_target` fallback (cron_task.rs ~912):
    // cold-start / first-execution with no better signal fires +2s; past-due
    // fires +5s. `clamp_forward` keeps `compute_next_execution` in lockstep
    // with those minimums so the UI never displays a moment in the past.
    fn clamp_forward(candidate: DateTime<Utc>, min_ahead_secs: i64) -> DateTime<Utc> {
        let min_target = Utc::now() + chrono::Duration::seconds(min_ahead_secs);
        if candidate > min_target {
            candidate
        } else {
            min_target
        }
    }

    match &task.schedule {
        Some(CronSchedule::At { at }) => {
            // One-shot. Past-due → scheduler fires in ~2s after spawn.
            match DateTime::parse_from_rfc3339(at)
                .or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S"))
            {
                Ok(target) => Some(clamp_forward(target.with_timezone(&Utc), 2).to_rfc3339()),
                Err(_) => None,
            }
        }
        Some(CronSchedule::Every { minutes, start_at }) => {
            // Explicit `start_at` (future) wins for the first execution.
            if let Some(ref sa) = start_at {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(sa) {
                    let target = parsed.with_timezone(&Utc);
                    if target > Utc::now() && task.execution_count == 0 {
                        return Some(target.to_rfc3339());
                    }
                }
            }
            // First ever run with no last_executed_at → scheduler fires +2s.
            if task.execution_count == 0 && task.last_executed_at.is_none() {
                return Some(
                    (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339(),
                );
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(*minutes as i64);
            // Past-due (catch-up after sleep) → scheduler fires +5s.
            Some(clamp_forward(next, 5).to_rfc3339())
        }
        Some(CronSchedule::Cron { expr, tz }) => {
            match next_cron_fire_time(expr, tz.as_deref()) {
                Ok(next) => Some(next.to_rfc3339()),
                Err(_) => None,
            }
        }
        Some(CronSchedule::Loop) => {
            // Ralph Loop: no scheduled time, triggered by completion
            None
        }
        None => {
            // Legacy: use interval_minutes — same cold-start clamp as `Every`.
            if task.execution_count == 0 && task.last_executed_at.is_none() {
                return Some(
                    (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339(),
                );
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(task.interval_minutes as i64);
            Some(clamp_forward(next, 5).to_rfc3339())
        }
    }
}

/// Enrich a CronTask with computed next_execution_at
fn enrich_task(mut task: CronTask) -> CronTask {
    task.next_execution_at = compute_next_execution(&task);
    task
}

/// Public alias for `enrich_task` used by management_api projection paths
/// that don't go through the manager's accessor methods (e.g. echoing the
/// just-updated task back from `update_cron_handler`). Issue #115.
pub fn enrich_for_summary(task: CronTask) -> CronTask {
    enrich_task(task)
}

/// Manager for cron tasks
pub struct CronTaskManager {
    pub(crate) tasks: Arc<RwLock<HashMap<String, CronTask>>>,
    storage_path: PathBuf,
    /// Flag to stop all scheduler loops
    shutdown: Arc<RwLock<bool>>,
    /// Track which tasks are currently executing (for overlap prevention)
    executing_tasks: Arc<RwLock<HashSet<String>>>,
    /// Track which tasks have active schedulers (prevents duplicate scheduler spawns)
    active_schedulers: Arc<RwLock<HashSet<String>>>,
    /// JoinHandles for scheduler tasks — enables graceful shutdown
    scheduler_handles: Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// Tauri app handle for emitting events (set after initialization)
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl CronTaskManager {
    /// Create a new CronTaskManager with persistence at ~/.myagents/cron_tasks.json
    pub fn new() -> Self {
        let storage_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".myagents")
            .join("cron_tasks.json");

        // Load persisted tasks synchronously before creating the manager
        // This avoids the need for block_on with async locks
        let initial_tasks = Self::load_tasks_from_file(&storage_path);

        // PRD 0.2.5 cross-review I4 — run R3 migration in-memory at
        // construction time (synchronous), so the manager is correct from
        // the moment `get_cron_task_manager()` returns. Async migration in
        // `initialize_cron_manager` was racy with management_api startup.
        // The disk write is best-effort and happens lazily via the next
        // mutation (or eagerly via initialize_cron_manager), which is fine
        // because the migration is idempotent across restarts.
        let mut initial_tasks = initial_tasks;
        let migrated = Self::migrate_in_memory_legacy_auto_permission_mode(&mut initial_tasks);

        let task_count = initial_tasks.len();
        let manager = Self {
            tasks: Arc::new(RwLock::new(initial_tasks)),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
            app_handle: Arc::new(RwLock::new(None)),
        };

        if task_count > 0 {
            ulog_info!("[CronTask] Loaded {} tasks from disk", task_count);
        }
        if migrated > 0 {
            ulog_info!(
                "[CronTask] Migrated {} task(s) in-memory: permissionMode='auto' → '' (v0.2.5 R3); will persist on next save",
                migrated
            );
        }

        manager
    }

    /// PRD 0.2.5 cross-review I4 — sync, in-memory portion of the legacy
    /// `permission_mode = "auto"` migration. Runs at construction time so
    /// the manager state is correct before any async caller (management
    /// API, scheduler) can read it. Disk persistence happens lazily.
    /// Returns the number of migrated tasks.
    fn migrate_in_memory_legacy_auto_permission_mode(
        tasks: &mut HashMap<String, CronTask>,
    ) -> usize {
        let mut migrated = 0usize;
        for task in tasks.values_mut() {
            if task.permission_mode == "auto" {
                task.permission_mode = String::new();
                migrated += 1;
            }
        }
        migrated
    }

    /// Load tasks from file synchronously (used during initialization)
    /// Returns empty HashMap on any error (logged as warning)
    /// Uses per-task fallback: if whole-store parse fails, tries parsing tasks individually
    fn load_tasks_from_file(storage_path: &PathBuf) -> HashMap<String, CronTask> {
        if !storage_path.exists() {
            return HashMap::new();
        }

        let content = match fs::read_to_string(storage_path) {
            Ok(c) => c,
            Err(e) => {
                ulog_warn!("[CronTask] Failed to read cron tasks file: {}", e);
                return HashMap::new();
            }
        };

        // Try whole-store deserialization first (fast path)
        match serde_json::from_str::<CronTaskStore>(&content) {
            Ok(store) => {
                let result: HashMap<String, CronTask> = store
                    .tasks
                    .into_iter()
                    .map(|t| (t.id.clone(), t))
                    .collect();
                // PRD 0.2.9 R9 — Count tasks still carrying the deprecated
                // `provider_env` snapshot (apiKey + baseUrl frozen at create
                // time). The sidecar live-resolves provider_id on every tick
                // for new tasks; legacy ones still work via the legacy
                // `Explicit` intent path until the user re-saves them.
                let legacy_count = result
                    .values()
                    .filter(|t| t.provider_env.is_some() && t.provider_id.is_none())
                    .count();
                if legacy_count > 0 {
                    ulog_info!(
                        "[CronTask] {} legacy task(s) still carry frozen provider_env (PRD 0.2.9). They run via legacy Explicit intent until re-saved. Edit & save once in 任务编辑 to migrate to live-resolve.",
                        legacy_count
                    );
                }
                return result;
            }
            Err(e) => {
                ulog_warn!("[CronTask] Whole-store parse failed ({}), trying per-task fallback", e);
            }
        }

        // Fallback: parse as raw JSON value, then deserialize tasks individually
        let raw: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!("[CronTask] Failed to parse cron tasks as JSON at all: {}", e);
                return HashMap::new();
            }
        };

        let tasks_array = match raw.get("tasks").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => {
                ulog_warn!("[CronTask] No 'tasks' array found in cron_tasks.json");
                return HashMap::new();
            }
        };

        let mut result = HashMap::new();
        let mut skipped = 0u32;
        for (i, task_val) in tasks_array.iter().enumerate() {
            match serde_json::from_value::<CronTask>(task_val.clone()) {
                Ok(task) => {
                    result.insert(task.id.clone(), task);
                }
                Err(e) => {
                    let task_id = task_val.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    ulog_warn!(
                        "[CronTask] Skipping corrupted task[{}] id={}: {}",
                        i, task_id, e
                    );
                    skipped += 1;
                }
            }
        }

        if skipped > 0 {
            ulog_warn!(
                "[CronTask] Per-task fallback: loaded {} tasks, skipped {} corrupted",
                result.len(), skipped
            );
        }

        result
    }

    /// Set the Tauri app handle for emitting events
    /// Must be called during app setup before starting any tasks
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.write().await;
        *app_handle = Some(handle);
        ulog_info!("[CronTask] App handle set");
    }

    /// Start the scheduler for a task
    /// This spawns a background tokio task that directly executes via Sidecar at intervals
    pub async fn start_task_scheduler(&self, task_id: &str) -> Result<(), String> {
        let task = self.get_task(task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status != TaskStatus::Running {
            return Err(format!("Task {} is not in running status", task_id));
        }

        // Liveness check + reservation must be atomic.
        //
        // Why a single critical section (v0.1.69 M2 → cross-review follow-up):
        // The prior shape split the check (read `active_schedulers`), the
        // cleanup (write both maps), and the spawn+store (separate `tokio::spawn`
        // followed by `scheduler_handles.write()`) into three serialisable
        // sections. Two concurrent callers for the same task_id could each
        // observe the other's intermediate state:
        //   - both see `active` without the task_id → both insert → both spawn
        //     → the second `scheduler_handles.insert()` overwrites the first
        //     JoinHandle → first tokio task orphaned, un-joinable, running
        //     forever in parallel with the second.
        //   - one sees "active but handle missing" (caller A between its own
        //     active-insert and handle-insert) and judges that entry stale,
        //     cleaning it up and spawning a duplicate.
        // Fix: hold `scheduler_handles.write()` across the whole flow
        // (check → cleanup → reserve → spawn → store). The scheduler body
        // itself never touches `scheduler_handles`, and `shutdown_all()` (the
        // only other writer) already expects to wait for in-flight starts —
        // so holding the write lock across `tokio::spawn` is safe.
        //
        // `active_schedulers` is retained as legacy bookkeeping used by
        // shutdown paths elsewhere; we keep it synced inside the same
        // critical section.
        let mut handles_guard = self.scheduler_handles.write().await;
        if let Some(existing) = handles_guard.get(task_id) {
            // `tauri::async_runtime::JoinHandle` wraps `tokio::task::JoinHandle`;
            // `is_finished` lives on the inner one (the wrapper exposes Future +
            // `abort()` only).
            if !existing.inner().is_finished() {
                ulog_info!("[CronTask] Scheduler already running for task {}, skipping", task_id);
                return Ok(());
            }
            // Stale: previous tokio task panicked / aborted / returned early
            // without passing through our cleanup path. Drop the dead handle
            // before respawning so the `.insert()` at the end overwrites a
            // known-finished entry (never a live one).
            ulog_warn!(
                "[CronTask] Scheduler handle for task {} was finished — respawning",
                task_id
            );
            handles_guard.remove(task_id);
        }
        {
            let mut active = self.active_schedulers.write().await;
            active.insert(task_id.to_string());
        }

        let tasks = Arc::clone(&self.tasks);
        let shutdown = Arc::clone(&self.shutdown);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let active_schedulers = Arc::clone(&self.active_schedulers);
        let app_handle = Arc::clone(&self.app_handle);
        let storage_path = self.storage_path.clone();
        let task_id_owned = task_id.to_string();
        let schedule = task.schedule.clone();
        let interval_mins = match &schedule {
            Some(CronSchedule::Every { minutes, .. }) => *minutes,
            _ => task.interval_minutes,
        };
        let last_executed = task.last_executed_at;
        let execution_count = task.execution_count;
        let task_id_for_handle = task_id.to_string();

        // Spawn the scheduler loop and store the JoinHandle for graceful shutdown
        let handle = tauri::async_runtime::spawn(async move {
            ulog_info!("[CronTask] Scheduler started for task {} (interval: {} min, executions: {})", task_id_owned, interval_mins, execution_count);

            // Wait for app_handle to be available (with timeout)
            // This handles the race condition where scheduler starts before initialize_cron_manager completes
            let mut app_handle_ready = false;
            for i in 0..50 {  // 5 seconds max wait (50 * 100ms)
                let handle_opt = app_handle.read().await;
                if handle_opt.is_some() {
                    app_handle_ready = true;
                    break;
                }
                drop(handle_opt);
                if i == 0 {
                    ulog_warn!("[CronTask] App handle not ready for task {}, waiting...", task_id_owned);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            if !app_handle_ready {
                ulog_error!("[CronTask] App handle not available after 5 seconds, aborting scheduler for task {}", task_id_owned);
                // Clean up: remove from active schedulers
                {
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                }
                return;
            }

            // Emit scheduler started event to frontend
            {
                let handle_opt = app_handle.read().await;
                if let Some(ref handle) = *handle_opt {
                    let _ = handle.emit("cron:scheduler-started", serde_json::json!({
                        "taskId": task_id_owned,
                        "intervalMinutes": interval_mins,
                        "executionCount": execution_count
                    }));
                }
            }

            // Calculate initial wait time
            // For CronSchedule::At — calculate delay until target time, then one-shot
            // For CronSchedule::Cron — compute next fire time from cron expression
            let is_one_shot = matches!(&schedule, Some(CronSchedule::At { .. }));
            let is_cron_expr = matches!(&schedule, Some(CronSchedule::Cron { .. }));
            let is_loop = matches!(&schedule, Some(CronSchedule::Loop));
            let cron_expr_info = match &schedule {
                Some(CronSchedule::Cron { expr, tz }) => Some((expr.clone(), tz.clone())),
                _ => None,
            };
            let interval_secs = interval_mins.max(5) as i64 * 60;
            // Compute initial target as a wall-clock time (not a Duration).
            // This is critical: we use sleep_until_wallclock() which polls Utc::now()
            // instead of tokio::time::sleep() which uses monotonic time that pauses
            // during system sleep/suspend.
            let initial_target: Option<DateTime<Utc>> = if is_loop {
                // Ralph Loop: execute immediately (2s startup delay)
                ulog_info!("[CronTask] Task {} Ralph Loop mode, executing in 2 seconds", task_id_owned);
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(CronSchedule::At { ref at }) = schedule {
                // One-shot: target is the specified time
                match DateTime::parse_from_rfc3339(at).or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S")) {
                    Ok(target) => {
                        let target_utc = target.with_timezone(&Utc);
                        let now = Utc::now();
                        if target_utc > now {
                            ulog_info!("[CronTask] Task {} scheduled at {}, waiting {} seconds", task_id_owned, at, (target_utc - now).num_seconds());
                            Some(target_utc)
                        } else {
                            ulog_info!("[CronTask] Task {} target time {} already passed, executing immediately", task_id_owned, at);
                            Some(now + chrono::Duration::seconds(2))
                        }
                    }
                    Err(e) => {
                        ulog_warn!("[CronTask] Task {} invalid 'at' time '{}': {}, executing in 2s", task_id_owned, at, e);
                        Some(Utc::now() + chrono::Duration::seconds(2))
                    }
                }
            } else if let Some(CronSchedule::Cron { ref expr, ref tz }) = schedule {
                // Cron expression: compute next fire time from wall clock
                match next_cron_fire_time(expr, tz.as_deref()) {
                    Ok(target) => {
                        ulog_info!("[CronTask] Task {} cron expr '{}' (tz={:?}), next fire at {} (in {} seconds)",
                            task_id_owned, expr, tz, target, (target - Utc::now()).num_seconds());
                        Some(target)
                    }
                    Err(e) => {
                        ulog_error!("[CronTask] Task {} invalid cron config: {}, stopping scheduler", task_id_owned, e);
                        {
                            let mut active = active_schedulers.write().await;
                            active.remove(&task_id_owned);
                        }
                        return;
                    }
                }
            } else if let Some(CronSchedule::Every { start_at: Some(ref sa), .. }) = schedule {
                // Every with start_at: wait until the specified start time for first execution
                if execution_count == 0 {
                    match DateTime::parse_from_rfc3339(sa) {
                        Ok(target) => {
                            let target_utc = target.with_timezone(&Utc);
                            let now = Utc::now();
                            if target_utc > now {
                                ulog_info!("[CronTask] Task {} delayed start at {}, waiting {} seconds", task_id_owned, sa, (target_utc - now).num_seconds());
                                Some(target_utc)
                            } else {
                                ulog_info!("[CronTask] Task {} start time {} already passed, executing in 2 seconds", task_id_owned, sa);
                                Some(now + chrono::Duration::seconds(2))
                            }
                        }
                        Err(_) => {
                            ulog_warn!("[CronTask] Task {} invalid start_at '{}', starting in 2 seconds", task_id_owned, sa);
                            Some(Utc::now() + chrono::Duration::seconds(2))
                        }
                    }
                } else if let Some(last_exec) = last_executed {
                    let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                    Some(next_exec)
                } else {
                    Some(Utc::now() + chrono::Duration::seconds(2))
                }
            } else if execution_count == 0 {
                ulog_info!("[CronTask] Task {} first execution, starting in 2 seconds", task_id_owned);
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(last_exec) = last_executed {
                let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                let now = Utc::now();
                if next_exec > now {
                    ulog_info!("[CronTask] Task {} next execution at {} (in {} seconds, based on lastExecutedAt)",
                        task_id_owned, next_exec, (next_exec - now).num_seconds());
                    Some(next_exec)
                } else {
                    ulog_info!("[CronTask] Task {} is past due, executing in 5 seconds", task_id_owned);
                    Some(now + chrono::Duration::seconds(5))
                }
            } else {
                ulog_info!("[CronTask] Task {} no lastExecutedAt but count={}, waiting full interval", task_id_owned, execution_count);
                Some(Utc::now() + chrono::Duration::seconds(interval_secs))
            };

            // Ralph Loop: track consecutive failures for exponential backoff
            let mut loop_consecutive_failures: u32 = 0;

            // Wait for initial period using wall-clock polling (survives system sleep)
            if let Some(target) = initial_target {
                if !sleep_until_wallclock(target, &shutdown, &task_id_owned).await {
                    // Shutdown requested during wait
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                    return;
                }
            }

            loop {

                // Check shutdown flag
                {
                    let shutdown_flag = shutdown.read().await;
                    if *shutdown_flag {
                        ulog_info!("[CronTask] Scheduler shutdown for task {}", task_id_owned);
                        break;
                    }
                }

                // Check task status
                let task_opt = {
                    let tasks_guard = tasks.read().await;
                    tasks_guard.get(&task_id_owned).cloned()
                };

                let task = match task_opt {
                    Some(t) => t,
                    None => {
                        ulog_info!("[CronTask] Task {} no longer exists, stopping scheduler", task_id_owned);
                        break;
                    }
                };

                // Only execute if task is still running
                if task.status != TaskStatus::Running {
                    ulog_info!("[CronTask] Task {} status changed to {:?}, stopping scheduler", task_id_owned, task.status);
                    break;
                }

                // Check end conditions before execution
                let should_complete = check_end_conditions_static(&task);
                if should_complete {
                    ulog_info!("[CronTask] Task {} reached end condition, completing", task_id_owned);
                    // Complete task and deactivate session
                    if let Some(ref handle) = *app_handle.read().await {
                        stop_task_internal(handle, &tasks, &task_id_owned, None).await;
                    }
                    break;
                }

                // Get app handle for execution (BEFORE reserving the
                // executing slot — if no handle, no point holding the lock).
                let handle_opt = {
                    let handle_guard = app_handle.read().await;
                    handle_guard.clone()
                };

                let Some(handle) = handle_opt else {
                    ulog_error!("[CronTask] No app handle available for task {}, will retry next interval", task_id_owned);
                    // Short wait before retrying (prevents tight loop)
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                };

                // PRD 0.2.5 cross-review C4 — atomic check-and-insert under
                // a single write lock. Closes the TOCTOU window where a
                // concurrent `trigger_now` could double-fire.
                let reserved = {
                    let mut executing = executing_tasks.write().await;
                    if executing.contains(&task_id_owned) {
                        false
                    } else {
                        executing.insert(task_id_owned.clone());
                        true
                    }
                };
                if !reserved {
                    ulog_warn!("[CronTask] Task {} is still executing, skipping this interval", task_id_owned);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }

                let is_first = task.execution_count == 0;
                ulog_info!("[CronTask] Executing task {} (execution #{})", task_id_owned, task.execution_count + 1);

                // Emit execution starting event to frontend
                let _ = handle.emit("cron:execution-starting", serde_json::json!({
                    "taskId": task_id_owned,
                    "executionNumber": task.execution_count + 1,
                    "isFirstExecution": is_first
                }));

                ulog_info!("[CronTask] About to call execute_task_directly for task {}", task_id_owned);

                // Emit debug event for frontend visibility
                let _ = handle.emit("cron:debug", serde_json::json!({
                    "taskId": task_id_owned,
                    "message": "About to call execute_task_directly"
                }));

                // Execute directly via Sidecar with timeout to prevent indefinite hanging
                let exec_start = std::time::Instant::now();
                let execution_result = tokio::time::timeout(
                    Duration::from_secs(3600), // 60 minutes timeout
                    execute_task_directly(&handle, &task, is_first)
                ).await;

                let execution_result = match execution_result {
                    Ok(result) => result,
                    Err(_) => {
                        ulog_error!("[CronTask] Task {} execution timed out after 60 minutes", task_id_owned);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": "Execution timed out after 60 minutes",
                            "error": true
                        }));
                        Err("Execution timed out".to_string())
                    }
                };
                let duration_ms = exec_start.elapsed().as_millis() as u64;

                // Record execution history to JSONL
                // Cap content at 2000 chars to prevent JSONL bloat (500 records * large output)
                const MAX_CONTENT_LEN: usize = 2000;
                // Detect graceful terminal-state short-circuit (H2 sentinel).
                // Pulled out of the match below so every side-effect arm can
                // short-circuit uniformly without re-parsing the prefix.
                let terminal_stop = matches!(&execution_result, Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL));

                // PRD 0.2.5 cross-review C5 — if the task was deleted while
                // this tick was in flight, skip the JSONL write so we don't
                // recreate an orphan run-history file right after
                // `delete_task()` cleaned it up. The in-memory cleanup path
                // below (`tasks_guard.get_mut`) already short-circuits when
                // the task is gone, but the JSONL write happens FIRST and
                // would resurrect the file. Check existence under the
                // tasks lock to keep the decision atomic.
                let task_still_alive = {
                    let g = tasks.read().await;
                    g.contains_key(&task_id_owned)
                };

                match &execution_result {
                    Ok((success, _, output_text, _)) => {
                        let run_record = CronRunRecord {
                            ts: Utc::now().timestamp_millis(),
                            ok: *success,
                            duration_ms,
                            content: output_text.as_ref().map(|t| {
                                if t.len() > MAX_CONTENT_LEN {
                                    // Find a valid UTF-8 boundary near the limit
                                    let end = t.char_indices()
                                        .take_while(|(i, _)| *i < MAX_CONTENT_LEN)
                                        .last()
                                        .map(|(i, c)| i + c.len_utf8())
                                        .unwrap_or(MAX_CONTENT_LEN.min(t.len()));
                                    format!("{}...", &t[..end])
                                } else {
                                    t.clone()
                                }
                            }),
                            error: None,
                        };
                        if task_still_alive {
                            if let Err(e) = record_cron_run(&task_id_owned, &run_record) {
                                ulog_warn!("[CronTask] Failed to record run: {}", e);
                            }
                        } else {
                            ulog_info!("[CronTask] Skip recording run for deleted task {}", task_id_owned);
                        }
                    }
                    Err(_) if terminal_stop => {
                        // Graceful stop — `stop_task()` was already called
                        // inside `execute_task_directly`. Skipping the
                        // JSONL write keeps "最近一次" stats clean.
                    }
                    Err(ref e) => {
                        let run_record = CronRunRecord {
                            ts: Utc::now().timestamp_millis(),
                            ok: false,
                            duration_ms,
                            content: None,
                            error: Some(e.clone()),
                        };
                        if task_still_alive {
                            let _ = record_cron_run(&task_id_owned, &run_record);
                        }
                    }
                }

                // Log the actual execution outcome (not just is_ok which only means "no Rust error")
                match &execution_result {
                    Ok((success, _, _, _)) => {
                        ulog_info!("[CronTask] execute_task_directly completed for task {}: task_success={}", task_id_owned, success);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_directly completed: task_success={}", success)
                        }));
                    }
                    Err(_) if terminal_stop => {
                        // Already logged at `ulog_warn!` inside the guard —
                        // no additional "failed" log/emit so the user's log
                        // timeline shows one clean stop, not a stop + a
                        // redundant failure.
                    }
                    Err(ref e) => {
                        ulog_warn!("[CronTask] execute_task_directly failed for task {}: {}", task_id_owned, e);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_directly failed: {}", e),
                            "error": true
                        }));
                    }
                }

                // Mark task as no longer executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.remove(&task_id_owned);
                }

                // Handle execution result
                match execution_result {
                    Ok((success, ai_exit_reason, output_text, internal_sid)) => {
                        // Update execution count, last_executed_at, and internal_session_id
                        let updated_execution_count;
                        {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                let now = Utc::now();
                                t.execution_count += 1;
                                t.last_executed_at = Some(now);
                                t.updated_at = now;
                                t.last_error = None;
                                // PRD 0.2.5 R6 — denormalized last-run summary
                                // for `cron list` (no jsonl read on list path).
                                t.last_run_ok = Some(success);
                                t.last_run_duration_ms = Some(duration_ms);
                                // Track the internal SDK session ID for frontend session loading
                                if internal_sid.is_some() {
                                    t.internal_session_id = internal_sid.clone();
                                }
                                updated_execution_count = t.execution_count;
                            } else {
                                updated_execution_count = task.execution_count + 1;
                            }
                        }

                        // Ralph Loop: reset failure counter on success, increment on logical failure
                        if is_loop {
                            if success {
                                loop_consecutive_failures = 0;
                            } else {
                                loop_consecutive_failures += 1;
                                if loop_consecutive_failures >= 10 {
                                    ulog_error!("[CronTask] Task {} Ralph Loop: 10 consecutive failures (logical), stopping", task_id_owned);
                                    stop_task_internal(&handle, &tasks, &task_id_owned,
                                        Some("Ralph Loop: 10 consecutive failures".to_string())).await;
                                    break;
                                }
                                let backoff_secs = match loop_consecutive_failures {
                                    1 => 3, 2 => 10, 3 => 30, 4 => 60, 5 => 120, _ => 300,
                                };
                                ulog_warn!("[CronTask] Task {} Ralph Loop: logical failure #{}, backoff {}s",
                                    task_id_owned, loop_consecutive_failures, backoff_secs);
                            }
                        }

                        // Emit execution-complete for ALL success paths
                        // (one-shot, AI exit, end condition, and normal continue)
                        // Must happen before any break so frontend always gets the update
                        ulog_info!("[CronTask] Emitting cron:execution-complete for task {} with executionCount={}", task_id_owned, updated_execution_count);
                        let _ = handle.emit("cron:execution-complete", serde_json::json!({
                            "taskId": task_id_owned,
                            "success": success,
                            "executionCount": updated_execution_count,
                            "internalSessionId": internal_sid
                        }));

                        // Deliver results to IM Bot + wake heartbeat (v0.1.21)
                        // Use actual AI output when available, fallback to generic summary
                        if let Some(ref delivery) = task.delivery {
                            let content = output_text.unwrap_or_else(|| {
                                if success {
                                    format!("Cron task '{}' completed successfully.", task.name.as_deref().unwrap_or(&task_id_owned))
                                } else {
                                    format!("Cron task '{}' completed with issues.", task.name.as_deref().unwrap_or(&task_id_owned))
                                }
                            });
                            deliver_cron_result_to_bot(&handle, delivery, &task_id_owned, &content).await;
                        }

                        // Check if AI requested exit
                        if let Some(reason) = ai_exit_reason {
                            ulog_info!("[CronTask] Task {} AI requested exit: {}", task_id_owned, reason);
                            stop_task_internal(&handle, &tasks, &task_id_owned, Some(reason)).await;
                            break;
                        }

                        // One-shot tasks (CronSchedule::At) auto-delete after first execution
                        if is_one_shot {
                            ulog_info!("[CronTask] Task {} is one-shot (schedule::at), auto-deleting after execution", task_id_owned);
                            stop_task_internal(&handle, &tasks, &task_id_owned, Some("One-shot task completed".to_string())).await;
                            // Remove from persistence (CT-08: one-shot tasks auto-delete)
                            {
                                let mut tasks_guard = tasks.write().await;
                                tasks_guard.remove(&task_id_owned);
                            }
                            let manager = get_cron_task_manager();
                            if let Err(e) = manager.save_to_disk().await {
                                ulog_warn!("[CronTask] Failed to save after one-shot deletion: {}", e);
                            }
                            break;
                        }

                        // Check end conditions after execution
                        let should_stop = {
                            let tasks_guard = tasks.read().await;
                            tasks_guard.get(&task_id_owned)
                                .map(|t| check_end_conditions_static(t))
                                .unwrap_or(false)
                        };
                        if should_stop {
                            ulog_info!("[CronTask] Task {} reached end condition after execution", task_id_owned);
                            stop_task_internal(&handle, &tasks, &task_id_owned, None).await;
                            break;
                        }
                    }
                    Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL) => {
                        // Graceful stop via H2 sentinel — `stop_task()` was
                        // already called inside `execute_task_directly`, so
                        // the CronTask is now Stopped. The next loop
                        // iteration's status check (line ~964) will break.
                        // Skip `last_error` + `cron:execution-error` so the
                        // UI doesn't briefly show this as a failed tick.
                        // Also skip the Ralph Loop backoff branch — this is
                        // a terminal stop, not a retryable failure.
                        ulog_info!(
                            "[CronTask] Task {} exited via terminal-stop sentinel: {}",
                            task_id_owned,
                            e.trim_start_matches(TERMINAL_STOP_SENTINEL)
                        );
                    }
                    Err(e) => {
                        ulog_error!("[CronTask] Task {} execution failed: {}", task_id_owned, e);
                        // Update last_error + denormalized last-run summary
                        {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                t.last_error = Some(e.clone());
                                // PRD 0.2.5 R6 — same denormalization as Ok path.
                                t.last_run_ok = Some(false);
                                t.last_run_duration_ms = Some(duration_ms);
                            }
                        }
                        // Emit error event for frontend
                        let _ = handle.emit("cron:execution-error", serde_json::json!({
                            "taskId": task_id_owned,
                            "error": e
                        }));

                        // Ralph Loop: exponential backoff on failure (3→10→30→60→120→300s, max 10 consecutive)
                        if is_loop {
                            loop_consecutive_failures += 1;
                            if loop_consecutive_failures >= 10 {
                                ulog_error!("[CronTask] Task {} Ralph Loop: 10 consecutive failures, stopping", task_id_owned);
                                stop_task_internal(&handle, &tasks, &task_id_owned,
                                    Some("Ralph Loop: 10 consecutive failures".to_string())).await;
                                break;
                            }
                            let backoff_secs = match loop_consecutive_failures {
                                1 => 3, 2 => 10, 3 => 30, 4 => 60, 5 => 120, _ => 300,
                            };
                            ulog_warn!("[CronTask] Task {} Ralph Loop: failure #{}, backoff {}s",
                                task_id_owned, loop_consecutive_failures, backoff_secs);
                            let backoff_target = Utc::now() + chrono::Duration::seconds(backoff_secs as i64);
                            if !sleep_until_wallclock(backoff_target, &shutdown, &task_id_owned).await {
                                ulog_info!("[CronTask] Task {} shutdown during Loop backoff", task_id_owned);
                                break;
                            }
                        }
                        // Continue to next interval (don't break on error)
                    }
                }

                // Save updated state atomically (temp file + rename)
                if let Err(e) = atomic_save_tasks(&storage_path, &tasks).await {
                    ulog_warn!("[CronTask] Failed to save task state: {}", e);
                }

                // Ralph Loop: skip time-based scheduling, re-execute after 3s buffer
                if is_loop {
                    ulog_info!("[CronTask] Task {} Ralph Loop: next execution in 3 seconds", task_id_owned);
                    let buffer_target = Utc::now() + chrono::Duration::seconds(3);
                    if !sleep_until_wallclock(buffer_target, &shutdown, &task_id_owned).await {
                        ulog_info!("[CronTask] Task {} shutdown during Loop buffer", task_id_owned);
                        break;
                    }
                    continue;
                }

                // Wait for the next execution time using wall-clock polling.
                // This survives system sleep/suspend — after wake, the poll detects
                // that wall-clock time has passed and fires within ≤30 seconds.
                let next_target = if is_cron_expr {
                    if let Some((ref expr, ref tz)) = cron_expr_info {
                        match next_cron_fire_time(expr, tz.as_deref()) {
                            Ok(target) => {
                                ulog_info!("[CronTask] Task {} cron next fire at {} (in {} seconds)",
                                    task_id_owned, target, (target - Utc::now()).num_seconds());
                                target
                            }
                            Err(e) => {
                                ulog_error!("[CronTask] Task {} cron schedule error: {}, stopping", task_id_owned, e);
                                break;
                            }
                        }
                    } else {
                        break; // Should not happen — cron_expr_info is always Some for is_cron_expr
                    }
                } else {
                    // Fixed interval: next = now + interval
                    let target = Utc::now() + chrono::Duration::seconds(interval_secs);
                    ulog_info!("[CronTask] Task {} next execution at {} (in {} minutes)",
                        task_id_owned, target, interval_mins);
                    target
                };
                if !sleep_until_wallclock(next_target, &shutdown, &task_id_owned).await {
                    ulog_info!("[CronTask] Task {} shutdown during wait", task_id_owned);
                    break;
                }
            }

            // Clean up: remove from active schedulers
            {
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
            }
            ulog_info!("[CronTask] Scheduler loop exited for task {}", task_id_owned);
        });

        // Store JoinHandle under the same critical section that gated the
        // liveness check above — no race window between `tokio::spawn` and
        // the insert. `handles_guard` is released when `start_task_scheduler`
        // returns; the spawned task is already running, so no work is
        // blocked on this release.
        handles_guard.insert(task_id_for_handle, handle);
        drop(handles_guard);

        Ok(())
    }

    /// Mark a task as currently executing (called when execution starts)
    pub async fn mark_task_executing(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.insert(task_id.to_string());
        ulog_debug!("[CronTask] Task {} marked as executing", task_id);
    }

    /// Mark a task as no longer executing (called when execution completes)
    pub async fn mark_task_complete(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.remove(task_id);
        ulog_debug!("[CronTask] Task {} marked as complete", task_id);
    }

    /// Check if a task is currently executing
    pub async fn is_task_executing(&self, task_id: &str) -> bool {
        let executing = self.executing_tasks.read().await;
        executing.contains(task_id)
    }

    /// PRD 0.2.5 R9 — clone the currently-executing set in one read-lock
    /// acquisition. Lets `list_cron_handler` mark `currently_executing`
    /// per task without N separate `is_task_executing` calls.
    pub async fn executing_snapshot(&self) -> HashSet<String> {
        self.executing_tasks.read().await.clone()
    }

    /// PRD 0.2.5 (cross-review C4) — atomic check-and-insert. Returns true if
    /// the task was successfully reserved (was NOT executing), false if it
    /// was already executing. Caller MUST `mark_task_complete` if true is
    /// returned, or release via `mark_task_complete` when done.
    ///
    /// Why: a separate `is_task_executing` then `mark_task_executing` opens
    /// a TOCTOU window where two concurrent dispatchers (scheduler tick +
    /// `trigger_now`, or two `trigger_now` calls) can both observe "not
    /// executing" and both insert. This single-write-lock variant closes
    /// the window.
    pub async fn try_mark_task_executing(&self, task_id: &str) -> bool {
        let mut executing = self.executing_tasks.write().await;
        if executing.contains(task_id) {
            return false;
        }
        executing.insert(task_id.to_string());
        ulog_debug!("[CronTask] Task {} reserved as executing (atomic)", task_id);
        true
    }

    /// Save tasks to disk using atomic writes (temp file + rename)
    pub(crate) async fn save_to_disk(&self) -> Result<(), String> {
        atomic_save_tasks(&self.storage_path, &self.tasks).await
    }

    /// PRD 0.2.5 R4 — fire one immediate execution of an existing cron task
    /// without changing its `status` / `next_execution_at` / any schedule
    /// fields. Fire-and-forget: returns as soon as the execution is dispatched.
    ///
    /// Conflict semantics: if the task is currently in `executing_tasks`
    /// (single_session running), return Err with a hint to retry later.
    /// new_session tasks have no inherent conflict (each tick spawns a fresh
    /// sidecar) but we still gate on `executing_tasks` for symmetry.
    ///
    /// Returns `(taskId, sessionId, dispatchedAtRfc3339)` for the CLI to print.
    pub async fn trigger_now(&self, task_id: &str) -> Result<TriggerNowInfo, String> {
        let task = self.get_task(task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        // PRD 0.2.5 cross-review I1 — validate app_handle BEFORE reserving
        // the executing slot. Otherwise an early Err here would leak the
        // reservation forever (no cleanup path).
        let handle = self.app_handle.read().await.clone()
            .ok_or_else(|| "App handle not initialized".to_string())?;

        // PRD 0.2.5 cross-review C4 — atomic check-and-reserve. Closes the
        // TOCTOU window where a concurrent scheduler tick or another
        // `trigger_now` call could both observe "not executing" between
        // is_task_executing() and mark_task_executing().
        if !self.try_mark_task_executing(task_id).await {
            return Err(format!(
                "Cannot run-now: a scheduled tick or earlier run-now is firing for {} this instant. \
                 Wait for it to finish (typically <60s); see `myagents cron runs {} --limit 1` after.",
                task_id, task_id
            ));
        }

        let dispatched_at = Utc::now();
        let session_id = task.session_id.clone();
        let task_id_owned = task_id.to_string();
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let tasks_arc = Arc::clone(&self.tasks);

        // Fire-and-forget: spawn the execution off-task. The caller (CLI /
        // HTTP handler) returns to the user the moment dispatch starts.
        // CLAUDE.md ban on tokio::spawn — use tauri::async_runtime::spawn.
        tauri::async_runtime::spawn(async move {
            // Snapshot the latest task state inside the spawned task so we
            // pick up any in-memory mutation since the trigger arrived.
            let task_snapshot = {
                let tasks = tasks_arc.read().await;
                tasks.get(&task_id_owned).cloned()
            };
            let Some(t) = task_snapshot else {
                ulog_warn!("[CronTask] trigger_now: task {} disappeared before dispatch", task_id_owned);
                let mut executing = executing_tasks.write().await;
                executing.remove(&task_id_owned);
                return;
            };

            // PRD 0.2.5 cross-review I3 — emit execution-starting event so
            // frontend/IM users see the same lifecycle signals as a scheduled
            // tick (the scheduler emits this before each tick).
            let _ = handle.emit("cron:execution-starting", serde_json::json!({
                "taskId": task_id_owned,
                "executionNumber": t.execution_count + 1,
                "isFirstExecution": false,
                "trigger": "manual",  // distinguishes from scheduler ticks
            }));

            // PRD 0.2.5 cross-review I3 — 60min timeout matches scheduler's
            // `tokio::time::timeout(Duration::from_secs(3600), ...)`. Without
            // this, a hung manual run would keep the task permanently
            // reserved in `executing_tasks`.
            let exec_start = std::time::Instant::now();
            let timed = tokio::time::timeout(
                Duration::from_secs(3600),
                execute_task_directly(&handle, &t, false /* is_first_execution */),
            ).await;
            let duration_ms = exec_start.elapsed().as_millis() as u64;
            let result = match timed {
                Ok(r) => r,
                Err(_) => {
                    ulog_error!("[CronTask] trigger_now: task {} timed out after 60 minutes", task_id_owned);
                    Err("Execution timed out".to_string())
                }
            };

            // PRD 0.2.5 cross-review C5 — skip JSONL write if task was
            // deleted while this manual run was in flight. Otherwise we'd
            // resurrect the run-history file delete_task() just cleaned.
            let task_still_alive = {
                let g = tasks_arc.read().await;
                g.contains_key(&task_id_owned)
            };

            const MAX_CONTENT_LEN: usize = 2000;
            let terminal_stop = matches!(&result, Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL));
            match &result {
                Ok((success, ai_exit_reason, output_text, internal_sid)) => {
                    let run_record = CronRunRecord {
                        ts: Utc::now().timestamp_millis(),
                        ok: *success,
                        duration_ms,
                        content: output_text.as_ref().map(|t| {
                            if t.len() > MAX_CONTENT_LEN {
                                let end = t.char_indices()
                                    .take_while(|(i, _)| *i < MAX_CONTENT_LEN)
                                    .last()
                                    .map(|(i, c)| i + c.len_utf8())
                                    .unwrap_or(MAX_CONTENT_LEN.min(t.len()));
                                format!("{}...", &t[..end])
                            } else {
                                t.clone()
                            }
                        }),
                        error: None,
                    };
                    if task_still_alive {
                        let _ = record_cron_run(&task_id_owned, &run_record);
                    }

                    // PRD 0.2.5 cross-review I3 — denormalize + post-process
                    // mirror of scheduler's Ok branch (cron_task.rs ~1252-1320).
                    let updated_execution_count = {
                        let mut tasks_guard = tasks_arc.write().await;
                        if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                            t.execution_count += 1;
                            t.last_executed_at = Some(Utc::now());
                            t.updated_at = Utc::now();
                            t.last_error = None;
                            t.last_run_ok = Some(*success);
                            t.last_run_duration_ms = Some(duration_ms);
                            if internal_sid.is_some() {
                                t.internal_session_id = internal_sid.clone();
                            }
                            t.execution_count
                        } else {
                            t.execution_count + 1
                        }
                    };

                    let _ = handle.emit("cron:execution-complete", serde_json::json!({
                        "taskId": task_id_owned,
                        "success": success,
                        "executionCount": updated_execution_count,
                        "internalSessionId": internal_sid,
                        "trigger": "manual",
                    }));

                    // IM delivery — AI output to configured channel
                    if let Some(ref delivery) = t.delivery {
                        let content = output_text.clone().unwrap_or_else(|| {
                            if *success {
                                format!("Cron task '{}' completed successfully.", t.name.as_deref().unwrap_or(&task_id_owned))
                            } else {
                                format!("Cron task '{}' completed with issues.", t.name.as_deref().unwrap_or(&task_id_owned))
                            }
                        });
                        deliver_cron_result_to_bot(&handle, delivery, &task_id_owned, &content).await;
                    }

                    // ai_exit_reason → stop the task. Even on a manual
                    // trigger, if the AI calls ExitCronTask we honor the
                    // request (consistent with scheduler behavior).
                    if let Some(reason) = ai_exit_reason.clone() {
                        ulog_info!("[CronTask] trigger_now: task {} AI requested exit: {}", task_id_owned, reason);
                        stop_task_internal(&handle, &tasks_arc, &task_id_owned, Some(reason)).await;
                    } else {
                        // End condition check (deadline / max_executions)
                        let should_stop = {
                            let tasks_guard = tasks_arc.read().await;
                            tasks_guard.get(&task_id_owned)
                                .map(check_end_conditions_static)
                                .unwrap_or(false)
                        };
                        if should_stop {
                            ulog_info!("[CronTask] trigger_now: task {} reached end condition", task_id_owned);
                            stop_task_internal(&handle, &tasks_arc, &task_id_owned, None).await;
                        }
                    }
                }
                Err(_) if terminal_stop => {
                    // Graceful stop already executed inside execute_task_directly.
                }
                Err(ref e) => {
                    let run_record = CronRunRecord {
                        ts: Utc::now().timestamp_millis(),
                        ok: false,
                        duration_ms,
                        content: None,
                        error: Some(e.clone()),
                    };
                    if task_still_alive {
                        let _ = record_cron_run(&task_id_owned, &run_record);
                    }
                    {
                        let mut tasks_guard = tasks_arc.write().await;
                        if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                            t.last_error = Some(e.clone());
                            t.last_run_ok = Some(false);
                            t.last_run_duration_ms = Some(duration_ms);
                        }
                    }
                    let _ = handle.emit("cron:execution-error", serde_json::json!({
                        "taskId": task_id_owned,
                        "error": e,
                        "trigger": "manual",
                    }));
                }
            }

            // Persist updates (best-effort) via singleton.
            if let Err(e) = get_cron_task_manager().save_to_disk().await {
                ulog_warn!("[CronTask] trigger_now: failed to persist post-run state: {}", e);
            }

            // Release the executing lock — must run on every path.
            let mut executing = executing_tasks.write().await;
            executing.remove(&task_id_owned);

            ulog_info!("[CronTask] trigger_now completed for task {} in {}ms", task_id_owned, duration_ms);
        });

        Ok(TriggerNowInfo {
            task_id: task_id.to_string(),
            session_id,
            dispatched_at: dispatched_at.to_rfc3339(),
        })
    }

    /// Create a new cron task (does not start it)
    pub async fn create_task(&self, mut config: CronTaskConfig) -> Result<CronTask, String> {
        // Validate minimum interval (5 minutes, matches frontend MIN_CRON_INTERVAL)
        if config.interval_minutes < 5 {
            return Err("Interval must be at least 5 minutes".to_string());
        }

        // PRD 0.2.9 — Apply the same provider-routing invariants as the
        // Task layer (`task::validate_task_provider_routing`). All callers
        // of this function (frontend cron creation paths, IM cron tool,
        // ensure_cron_for_task projection) flow through here, so this is
        // the choke point that prevents IM-bot / CLI / direct-Tauri
        // callers from persisting half-state CronTasks. Mirrors the pin
        // semantics: provider_id with no runtime → pin builtin.
        if config.provider_id.is_some() && config.runtime.is_none() {
            config.runtime = Some("builtin".to_string());
        }
        if config.provider_id.is_some() && config.model.is_none() {
            return Err(
                "providerId 必须与 model 配对设置（CronTask 创建路径校验）".to_string(),
            );
        }
        if let Some(rt) = config.runtime.as_deref() {
            if matches!(rt, "claude-code" | "codex" | "gemini")
                && config.provider_id.is_some()
            {
                return Err(format!(
                    "外部 runtime '{}' 不允许同时指定 providerId（CronTask 创建路径校验）",
                    rt
                ));
            }
        }

        let task = CronTask {
            id: format!("cron_{}", Uuid::new_v4().to_string().replace("-", "")[..12].to_string()),
            workspace_path: config.workspace_path,
            session_id: config.session_id,
            prompt: config.prompt,
            interval_minutes: config.interval_minutes,
            end_conditions: config.end_conditions,
            run_mode: config.run_mode,
            status: TaskStatus::Stopped, // Start stopped, caller must explicitly start
            execution_count: 0,
            created_at: Utc::now(),
            last_executed_at: None,
            notify_enabled: config.notify_enabled,
            tab_id: config.tab_id,
            exit_reason: None,
            permission_mode: config.permission_mode,
            model: config.model,
            provider_env: config.provider_env,
            provider_id: config.provider_id,
            provider_intent: config.provider_intent,
            runtime: config.runtime,
            runtime_config: config.runtime_config,
            mcp_enabled_servers: config.mcp_enabled_servers,
            last_error: None,
            last_run_ok: None,
            last_run_duration_ms: None,
            source_bot_id: config.source_bot_id,
            delivery: config.delivery,
            schedule: config.schedule,
            name: config.name,
            next_execution_at: None, // Enriched at read time
            internal_session_id: None, // Set after first execution
            updated_at: Utc::now(),
            task_id: config.task_id.clone(),
        };

        let mut tasks = self.tasks.write().await;
        tasks.insert(task.id.clone(), task.clone());
        drop(tasks);

        self.save_to_disk().await?;
        ulog_info!("[CronTask] Created task: {}", task.id);

        Ok(task)
    }

    /// Get a task by ID (enriched with next_execution_at)
    pub async fn get_task(&self, task_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned().map(enrich_task)
    }

    /// Look up a CronTask by its Task Center reverse pointer (PRD §11.2).
    /// Returns the first match; tasks are expected to be 1:1 with CronTasks.
    pub async fn find_by_task_id(&self, ta_task_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.task_id.as_deref() == Some(ta_task_id))
            .cloned()
            .map(enrich_task)
    }

    /// Delete every CronTask linked to the given Task Center id. Used when a
    /// Task is archived / deleted / rerun so stale scheduler entries don't
    /// keep firing.
    pub async fn delete_by_task_id(&self, ta_task_id: &str) -> Result<usize, String> {
        let ids: Vec<String> = {
            let tasks = self.tasks.read().await;
            tasks
                .values()
                .filter(|t| t.task_id.as_deref() == Some(ta_task_id))
                .map(|t| t.id.clone())
                .collect()
        };
        for id in &ids {
            let _ = self.delete_task(id).await;
        }
        Ok(ids.len())
    }

    /// Get all tasks (enriched with next_execution_at)
    pub async fn get_all_tasks(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().map(enrich_task).collect()
    }

    /// Get tasks for a specific workspace (enriched with next_execution_at)
    /// Uses normalized path comparison to handle trailing slashes and other inconsistencies
    pub async fn get_tasks_for_workspace(&self, workspace_path: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        let normalized_query = normalize_path(workspace_path);
        let result: Vec<CronTask> = tasks
            .values()
            .filter(|t| normalize_path(&t.workspace_path) == normalized_query)
            .cloned()
            .map(enrich_task)
            .collect();

        ulog_debug!(
            "[CronTask] get_tasks_for_workspace: query='{}' (normalized='{}'), found {} tasks",
            workspace_path, normalized_query, result.len()
        );

        result
    }

    /// Get active task for a specific session (running only, enriched)
    pub async fn get_active_task_for_session(&self, session_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.session_id == session_id && t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
    }

    /// Get active task for a specific tab (running only, enriched)
    pub async fn get_active_task_for_tab(&self, tab_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.tab_id.as_deref() == Some(tab_id) && t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
    }

    /// Get tasks created by a specific IM Bot (v0.1.21, enriched)
    pub async fn get_tasks_for_bot(&self, bot_id: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.source_bot_id.as_deref() == Some(bot_id))
            .cloned()
            .map(enrich_task)
            .collect()
    }

    /// Update task fields (partial update, for management API)
    pub async fn update_task_fields(&self, task_id: &str, patch: serde_json::Value) -> Result<CronTask, String> {
        // Capture pre-patch state so we can decide whether the scheduler needs
        // to be bounced. The scheduler tokio task captures `schedule`/
        // `interval_mins`/`cron_expr_info` by value at spawn time
        // (`start_task_scheduler` line ~731), so editing these fields on disk
        // alone is invisible to the running loop. If we don't restart the
        // scheduler, the user sees "save succeeded" but the task keeps firing
        // at the old cadence until natural stop/start.
        let (was_running, prev_schedule, prev_interval, prev_end_conditions) = {
            let tasks = self.tasks.read().await;
            let task = tasks
                .get(task_id)
                .ok_or_else(|| format!("Task not found: {}", task_id))?;
            (
                task.status == TaskStatus::Running,
                task.schedule.clone(),
                task.interval_minutes,
                task.end_conditions.clone(),
            )
        };

        // Pit-of-success: do the stop BEFORE mutating, so a concurrent
        // scheduler tick (reading stale schedule) doesn't interleave with the
        // write. Mirrors `cmd_update_cron_task_fields`'s dance.
        if was_running {
            self.stop_task(task_id, None).await?;
            let mut active = self.active_schedulers.write().await;
            active.remove(task_id);
        }

        let mut tasks = self.tasks.write().await;
        // Apply patches to a CLONE so a late-stage validation failure
        // (PRD 0.2.9 invariants below) doesn't leave the in-memory store
        // half-patched — found during cross-review of dev/0.2.9.
        let mut task: CronTask = tasks
            .get(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?
            .clone();
        let task = &mut task;

        // Apply allowed patches
        if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
            task.name = Some(name.to_string());
        }
        // Accept both "prompt" and "message" (Bun normalizes, but defend in depth)
        if let Some(prompt) = patch.get("prompt").and_then(|v| v.as_str())
            .or_else(|| patch.get("message").and_then(|v| v.as_str()))
        {
            task.prompt = prompt.to_string();
        }
        if let Some(interval) = patch.get("intervalMinutes").and_then(|v| v.as_u64()) {
            task.interval_minutes = interval.max(5) as u32;
        }
        if let Some(schedule_val) = patch.get("schedule") {
            if schedule_val.is_null() {
                task.schedule = None;
            } else if let Ok(s) = serde_json::from_value::<CronSchedule>(schedule_val.clone()) {
                // Issue #115 Bug B — preserve `tz` when patch is a bare cron
                // expression that didn't specify one. CLI's
                // `normalizeScheduleFlag` for the bare-string form returns
                // `{kind:cron, expr}` with no `tz` field, so this is the
                // typical "user just wanted to change the firing pattern"
                // intent; silently dropping the existing tz changes the
                // meaning of the schedule from the user's local TZ to UTC.
                //
                // Merge rule: Cron-with-no-tz patch onto Cron-with-tz prev
                // → inherit tz. All other transitions (Every↔Cron, explicit
                // tz set, switch to At/Loop) replace wholesale, matching
                // user's explicit intent.
                let merged = match (&prev_schedule, s) {
                    (
                        Some(CronSchedule::Cron { tz: Some(prev_tz), .. }),
                        CronSchedule::Cron { expr, tz: None },
                    ) => CronSchedule::Cron { expr, tz: Some(prev_tz.clone()) },
                    (_, other) => other,
                };
                // Mirror interval_minutes when switching to a fixed-interval schedule,
                // so any downstream reader that falls back to the legacy field stays
                // consistent.
                if let CronSchedule::Every { minutes, .. } = &merged {
                    task.interval_minutes = *minutes;
                }
                task.schedule = Some(merged);
            }
        }
        if let Some(end_conditions_val) = patch.get("endConditions") {
            // Issue #115 cross-review (Pattern B) — endConditions is a
            // nested struct with three independently-meaningful fields
            // (deadline / max_executions / ai_can_exit). Treating the
            // patch as a wholesale replacement silently zeroes out any
            // field the caller didn't include — e.g. a CLI `cron update
            // --endConditions '{"deadline":"..."}'` would lose the
            // previously-set max_executions and ai_can_exit. Merge per
            // field, only overwriting keys the patch actually carries.
            if let Some(obj) = end_conditions_val.as_object() {
                if obj.contains_key("deadline") {
                    if let Some(v) = obj.get("deadline") {
                        task.end_conditions.deadline = if v.is_null() {
                            None
                        } else {
                            serde_json::from_value(v.clone()).unwrap_or(task.end_conditions.deadline)
                        };
                    }
                }
                if obj.contains_key("maxExecutions") {
                    if let Some(v) = obj.get("maxExecutions") {
                        task.end_conditions.max_executions = if v.is_null() {
                            None
                        } else {
                            v.as_u64().map(|n| n as u32).or(task.end_conditions.max_executions)
                        };
                    }
                }
                if obj.contains_key("aiCanExit") {
                    if let Some(b) = obj.get("aiCanExit").and_then(|v| v.as_bool()) {
                        task.end_conditions.ai_can_exit = b;
                    }
                }
            } else if let Ok(ec) = serde_json::from_value::<EndConditions>(end_conditions_val.clone()) {
                // Non-object form (e.g. legacy callers passing a fully-typed
                // struct) — fall back to wholesale replace, which is what
                // the old behavior was. The merge above only kicks in for
                // partial-object patches, which is the common CLI case.
                task.end_conditions = ec;
            }
        }
        if let Some(notify) = patch.get("notifyEnabled").and_then(|v| v.as_bool()) {
            task.notify_enabled = notify;
        }
        if let Some(model) = patch.get("model") {
            if model.is_null() {
                task.model = None;
            } else if let Some(s) = model.as_str() {
                task.model = Some(s.to_string());
            }
        }
        // PRD 0.2.9 — Project per-task provider id from Task → CronTask. Two
        // states (mirrors model semantics):
        //   null     → clear (= follow Agent)
        //   "id"     → set the per-task override
        // The sidecar live-resolves env from this id on every tick, so we
        // never write a credential snapshot to disk here.
        if let Some(provider_id) = patch.get("providerId") {
            if provider_id.is_null() {
                task.provider_id = None;
            } else if let Some(s) = provider_id.as_str() {
                task.provider_id = if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                };
            }
        }

        if let Some(pm) = patch.get("permissionMode").and_then(|v| v.as_str()) {
            task.permission_mode = pm.to_string();
        }
        // PRD #131 / Codex-review #1 — runtime + runtimeConfig projection
        // from Task → CronTask. Same two-state semantics as model/providerId:
        //   null     → clear (= follow Agent runtime)
        //   string   → set the per-task runtime override (builtin / codex / …)
        // Without these, an existing recurring task whose runtime was
        // edited in the Task panel kept executing on the original runtime
        // forever — Task and CronTask drifted out of sync.
        if let Some(runtime_val) = patch.get("runtime") {
            if runtime_val.is_null() {
                task.runtime = None;
            } else if let Some(s) = runtime_val.as_str() {
                task.runtime = if s.is_empty() { None } else { Some(s.to_string()) };
            }
        }
        if let Some(rc_val) = patch.get("runtimeConfig") {
            if rc_val.is_null() {
                task.runtime_config = None;
            } else {
                task.runtime_config = Some(rc_val.clone());
            }
        }
        // PRD 0.2.4 §需求 4 — Task → CronTask projection of MCP override.
        // Two-state semantics (mirrors `task.rs::update`):
        //   null OR empty array  → clear (= follow workspace)
        //   array of ids         → set as the per-task override
        if let Some(mcp_val) = patch.get("mcpEnabledServers") {
            if mcp_val.is_null() {
                task.mcp_enabled_servers = None;
            } else if let Ok(list) = serde_json::from_value::<Vec<String>>(mcp_val.clone()) {
                task.mcp_enabled_servers = if list.is_empty() { None } else { Some(list) };
            }
        }
        if let Some(delivery_val) = patch.get("delivery") {
            if delivery_val.is_null() {
                task.delivery = None;
            } else if let Ok(d) = serde_json::from_value::<CronDelivery>(delivery_val.clone()) {
                task.delivery = Some(d);
            }
        } else if patch.get("clearDelivery").and_then(|v| v.as_bool()) == Some(true) {
            task.delivery = None;
        }

        // PRD 0.2.9 — Re-run the create-time invariants on the merged state.
        // The sibling `create_task` choke point gates the create path, but
        // this `update_task_fields` path (used by `/api/cron/update` and the
        // CLI / IM patch flows) was missing the same gate, so a patch like
        // `{"providerId": "openai-x"}` against an existing CronTask with
        // `runtime: Some("codex")` would silently land — exactly the half-
        // state the validator is designed to refuse. Found by CC review on
        // dev/0.2.9. Same pin-runtime semantics: provider_id with no runtime
        // → pin builtin so a later Agent runtime flip doesn't cross-talk.
        // Patches were applied to a CLONE above, so a validation failure
        // here aborts cleanly without touching the in-memory store.
        if task.provider_id.is_some() && task.runtime.is_none() {
            task.runtime = Some("builtin".to_string());
        }
        if task.provider_id.is_some() && task.model.is_none() {
            return Err(
                "providerId 必须与 model 配对设置（CronTask 更新路径校验）".to_string(),
            );
        }
        if let Some(rt) = task.runtime.as_deref() {
            if matches!(rt, "claude-code" | "codex" | "gemini")
                && task.provider_id.is_some()
            {
                return Err(format!(
                    "外部 runtime '{}' 不允许同时指定 providerId（CronTask 更新路径校验）",
                    rt
                ));
            }
        }

        task.updated_at = Utc::now();
        // Detect schedule-shape change so we know whether to restart the
        // scheduler (even shape-unchanged edits still go through this path
        // for model/permission/name; those don't need a bounce).
        let schedule_changed = task.schedule != prev_schedule
            || task.interval_minutes != prev_interval
            || task.end_conditions != prev_end_conditions;
        let updated = task.clone();
        // Commit the validated clone back to the map.
        tasks.insert(task_id.to_string(), updated.clone());
        drop(tasks);
        self.save_to_disk().await?;
        ulog_info!("[CronTask] Updated task fields: {}", task_id);

        if was_running {
            // Whether or not schedule changed, we stopped it — restart it so
            // the task keeps running. If schedule changed, the restart is
            // what makes the edit take effect; if not, it's just restoring
            // the pre-edit state.
            self.start_task(task_id).await?;
            self.start_task_scheduler(task_id).await?;
            if schedule_changed {
                ulog_info!(
                    "[CronTask] bounced scheduler for {} after schedule-shape edit",
                    task_id
                );
            }
        }

        Ok(updated)
    }

    /// Write the `task_id` back-pointer used by the Task Center to find the
    /// CronTask that backs a given new-model Task. Used by the legacy-upgrade
    /// path — once the pointer is set, the legacy surfacing filter (see
    /// `TaskListPanel.fetchLegacyCronTasks`) hides this row from the legacy
    /// list and the Task Center drives it through the new detail overlay.
    ///
    /// Concurrency guard (`require_null = true`) — when two upgrade flows
    /// race to link the same CronTask, only the first succeeds. The second
    /// sees `ALREADY_LINKED` and its caller can roll back the stale
    /// Task/Thought rows it just created. Pass `require_null = false` for
    /// explicit relink or clear operations.
    pub async fn set_task_id(
        &self,
        cron_task_id: &str,
        task_id: Option<String>,
        require_null: bool,
    ) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(cron_task_id)
            .ok_or_else(|| format!("CronTask not found: {}", cron_task_id))?;
        if require_null {
            if let Some(existing) = &task.task_id {
                if Some(existing) != task_id.as_ref() {
                    return Err(format!(
                        "ALREADY_LINKED: CronTask {} is already linked to Task {}",
                        cron_task_id, existing
                    ));
                }
            }
        }
        task.task_id = task_id;
        task.updated_at = Utc::now();
        let updated = task.clone();
        drop(tasks);
        self.save_to_disk().await?;
        ulog_info!("[CronTask] Set task_id: {}", cron_task_id);
        Ok(updated)
    }

    /// Start a task (begin scheduling)
    /// Can start a task in Stopped status (e.g., after creation or after previous stop)
    pub async fn start_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status == TaskStatus::Running {
            return Err("Task is already running".to_string());
        }

        task.status = TaskStatus::Running;
        task.updated_at = Utc::now();
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;
        ulog_info!("[CronTask] Started task: {}", task_id);

        Ok(task_clone)
    }

    /// Stop a task (with optional exit reason)
    /// Also deactivates the associated session and unregisters the CronTask user
    /// exit_reason can be set when AI calls ExitCronTask tool or end conditions are met
    pub async fn stop_task(&self, task_id: &str, exit_reason: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        task.status = TaskStatus::Stopped;
        task.exit_reason = exit_reason.clone();
        task.updated_at = Utc::now();
        let task_clone = task.clone();
        drop(tasks);

        // Release CronTask's ownership of the Session Sidecar
        // If Tab still owns it, Sidecar continues running
        self.stop_cron_task_sidecar_internal(&session_id, task_id).await;

        // Deactivate session via app handle
        self.deactivate_session_internal(&session_id).await;

        self.save_to_disk().await?;

        // Emit stopped event for frontend listeners (e.g., RecentTasks badge refresh)
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            let _ = handle.emit("cron:task-stopped", serde_json::json!({
                "taskId": task_id,
                "exitReason": exit_reason
            }));
        }

        ulog_info!("[CronTask] Stopped task: {} (CronTask released from session {})", task_id, session_id);

        Ok(task_clone)
    }

    /// Internal helper to deactivate a session via SidecarManager
    async fn deactivate_session_internal(&self, session_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                match sidecar_state.lock() {
                    Ok(mut manager) => {
                        manager.deactivate_session(session_id);
                        ulog_debug!("[CronTask] Deactivated session: {}", session_id);
                    }
                    Err(e) => {
                        ulog_error!("[CronTask] Cannot deactivate session {}: lock poisoned: {}", session_id, e);
                    }
                }
            } else {
                ulog_warn!("[CronTask] Cannot deactivate session {}: SidecarManager state not found", session_id);
            }
        } else {
            ulog_warn!("[CronTask] Cannot deactivate session {}: app handle not available", session_id);
        }
    }

    /// Internal helper to release CronTask's ownership of the Session Sidecar
    /// With Session-centric Sidecar (Owner model), this only releases the CronTask owner.
    /// If Tab still owns the Sidecar, it continues running.
    async fn stop_cron_task_sidecar_internal(&self, session_id: &str, task_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                let owner = SidecarOwner::CronTask(task_id.to_string());
                match release_session_sidecar(&sidecar_state, session_id, &owner) {
                    Ok(stopped) => {
                        if stopped {
                            ulog_info!(
                                "[CronTask] Released CronTask {} from session {}, Sidecar stopped (was last owner)",
                                task_id, session_id
                            );
                        } else {
                            ulog_info!(
                                "[CronTask] Released CronTask {} from session {}, Sidecar continues (Tab still owns it)",
                                task_id, session_id
                            );
                        }
                    }
                    Err(e) => {
                        ulog_error!(
                            "[CronTask] Failed to release CronTask {} from session {}: {}",
                            task_id, session_id, e
                        );
                    }
                }
            } else {
                ulog_warn!("[CronTask] Cannot release CronTask {}: SidecarManager state not found", task_id);
            }
        } else {
            ulog_warn!("[CronTask] Cannot release CronTask {}: app handle not available", task_id);
        }
    }

    /// Delete a task
    /// Also releases CronTask's Sidecar ownership and deactivates session if task was running
    pub async fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.remove(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let was_running = task.status == TaskStatus::Running;
        drop(tasks);

        // Release CronTask's Sidecar ownership and deactivate session if task was running
        if was_running {
            self.stop_cron_task_sidecar_internal(&session_id, task_id).await;
            self.deactivate_session_internal(&session_id).await;
        }

        self.save_to_disk().await?;

        // Cascade-clean the run history file. Best-effort: failure must not
        // block delete (file may not exist if task never executed).
        let runs_path = run_record_path(task_id);
        if runs_path.exists() {
            match std::fs::remove_file(&runs_path) {
                Ok(()) => ulog_info!("[CronTask] Removed run history: {}", runs_path.display()),
                Err(e) => ulog_warn!("[CronTask] Failed to remove run history {}: {}", runs_path.display(), e),
            }
        }

        ulog_info!("[CronTask] Deleted task: {} (was_running: {}, CronTask released)", task_id, was_running);

        Ok(())
    }

    /// Record task execution
    pub async fn record_execution(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let now = Utc::now();
        task.execution_count += 1;
        task.last_executed_at = Some(now);
        task.updated_at = now;

        // Check end conditions
        let should_stop = self.check_end_conditions(task);
        if should_stop {
            task.status = TaskStatus::Stopped;
        }

        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Check if task should end based on conditions
    fn check_end_conditions(&self, task: &CronTask) -> bool {
        // Check deadline
        if let Some(deadline) = task.end_conditions.deadline {
            if Utc::now() >= deadline {
                ulog_info!("[CronTask] Task {} reached deadline", task.id);
                return true;
            }
        }

        // Check max executions
        if let Some(max) = task.end_conditions.max_executions {
            if task.execution_count >= max {
                ulog_info!("[CronTask] Task {} reached max executions ({})", task.id, max);
                return true;
            }
        }

        false
    }

    /// Get tasks that need to be recovered (running status on app restart, enriched)
    pub async fn get_tasks_to_recover(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
            .collect()
    }

    /// Update task's tab association
    pub async fn update_task_tab(&self, task_id: &str, tab_id: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        task.tab_id = tab_id;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Update task's session ID (called when session is created after task creation)
    pub async fn update_task_session(&self, task_id: &str, session_id: String) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        ulog_info!("[CronTask] Updating task {} sessionId: {:?} -> {}", task_id, task.session_id, session_id);
        task.session_id = session_id;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Shutdown the manager (stop all scheduler loops)
    pub async fn shutdown(&self) {
        {
            let mut shutdown = self.shutdown.write().await;
            *shutdown = true;
        }
        ulog_info!("[CronTask] Manager shutdown initiated, awaiting scheduler handles...");

        // Drain and await all scheduler handles (with timeout)
        let handles: Vec<(String, tauri::async_runtime::JoinHandle<()>)> = {
            let mut h = self.scheduler_handles.write().await;
            h.drain().collect()
        };
        for (id, handle) in handles {
            match tokio::time::timeout(Duration::from_secs(5), handle).await {
                Ok(Ok(())) => ulog_debug!("[CronTask] Scheduler {} joined", id),
                Ok(Err(e)) => ulog_warn!("[CronTask] Scheduler {} panicked: {}", id, e),
                Err(_) => ulog_warn!("[CronTask] Scheduler {} join timed out", id),
            }
        }
        ulog_info!("[CronTask] Manager shutdown complete");
    }

    /// Check if shutdown has been requested
    pub async fn is_shutdown(&self) -> bool {
        let shutdown = self.shutdown.read().await;
        *shutdown
    }
}

// ============ Helper Functions ============

/// Check if task should end based on conditions (static version for use in scheduler)
fn check_end_conditions_static(task: &CronTask) -> bool {
    // Check deadline
    if let Some(deadline) = task.end_conditions.deadline {
        if Utc::now() >= deadline {
            ulog_info!("[CronTask] Task {} reached deadline", task.id);
            return true;
        }
    }

    // Check max executions
    if let Some(max) = task.end_conditions.max_executions {
        if task.execution_count >= max {
            ulog_info!("[CronTask] Task {} reached max executions ({})", task.id, max);
            return true;
        }
    }

    false
}

/// Rotate the session id for a `NewSession` cron task ahead of the next execution.
///
/// Keeps the Rust `ManagedSidecar` registry key and Bun's actual session id in
/// lockstep. Without this, `task.session_id` stayed as the placeholder forever
/// and Bun generated its own id inside `switchToSession(createSession(...))` —
/// the two diverged, the registry no longer found the live sidecar by the
/// real session id, and opening the session from history spawned a duplicate
/// read-only sidecar that couldn't see the in-flight execution.
///
/// Side effects:
///   - Releases the CronTask's ownership of the previous session's sidecar.
///     If that was the only owner, the sidecar stops. If a Tab had joined it
///     (rare for new_session mode, but possible if the user opened it mid-run),
///     the tab stays the remaining owner and the sidecar continues — benign.
///   - Writes the new id back to `tasks[task.id].session_id` so subsequent
///     ticks / crash-recovery / release paths see a consistent value.
///   - Does NOT persist to `cron_tasks.json` synchronously; the periodic
///     save path picks it up. Rotation always produces a fresh UUID so even
///     if the process dies mid-tick the stored placeholder id never collides.
async fn rotate_new_session_id(handle: &AppHandle, task: &CronTask) -> Result<String, String> {
    let new_session_id = Uuid::new_v4().to_string();
    let old_session_id = task.session_id.clone();

    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        let owner = SidecarOwner::CronTask(task.id.clone());
        if let Err(e) = release_session_sidecar(&sidecar_state, &old_session_id, &owner) {
            // Non-fatal: release failure just means the sidecar may linger
            // until another owner releases it or the app exits.
            ulog_warn!(
                "[CronTask] rotate_new_session_id: release old session {} failed: {} (non-fatal)",
                old_session_id, e
            );
        }
    }

    let manager = get_cron_task_manager();
    {
        let mut tasks_guard = manager.tasks.write().await;
        if let Some(t) = tasks_guard.get_mut(&task.id) {
            t.session_id = new_session_id.clone();
            // Keep `internal_session_id` in lockstep so any consumer that
            // falls back to `internalSessionId || sessionId` (Chat.tsx,
            // CronTaskDetailPanel, useTaskCenterData) doesn't observe a
            // tick-start window where they disagree. Post-rotation these
            // are semantically the same thing: Bun's real session id.
            t.internal_session_id = Some(new_session_id.clone());
            t.updated_at = Utc::now();
        }
    }

    // Persist the rotation synchronously. The previous docstring claimed a
    // "periodic save path picks it up" — no such periodic loop exists.
    // Without this `save_to_disk`, a Rust crash between rotate and the next
    // mutation-triggered save would leave `cron_tasks.json` pointing at a
    // stale session id; on restart `try_recover_single_task` would ensure
    // a sidecar for the dead id and waste I/O before the next tick rotates
    // again. Rotation is low-frequency (once per cron tick); the ~few KB
    // atomic write cost is negligible.
    if let Err(e) = manager.save_to_disk().await {
        // Non-fatal — execution proceeds on the in-memory id. Next successful
        // save will catch up. Log as warn so persistence issues are visible.
        ulog_warn!(
            "[CronTask] rotate_new_session_id: save_to_disk failed for task {}: {} (non-fatal, in-memory id in use)",
            task.id, e
        );
    }

    ulog_info!(
        "[CronTask] new_session rotate: task {} session_id {} → {}",
        task.id, old_session_id, new_session_id
    );

    Ok(new_session_id)
}

/// Execute a task directly via Sidecar (without going through frontend)
/// Returns (success, ai_exit_reason, output_text, internal_session_id) tuple
async fn execute_task_directly(
    handle: &AppHandle,
    task: &CronTask,
    is_first_execution: bool,
) -> Result<(bool, Option<String>, Option<String>, Option<String>), String> {
    ulog_info!("[CronTask] execute_task_directly starting for task {}", task.id);

    // Emit debug event: entering function
    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": "execute_task_directly: entering function"
    }));

    // Get SidecarManager state
    let sidecar_state = match handle.try_state::<ManagedSidecarManager>() {
        Some(state) => {
            let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": "execute_task_directly: got SidecarManager state"
            }));
            state
        }
        None => {
            ulog_error!("[CronTask] SidecarManager state not available for task {}", task.id);
            let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": "execute_task_directly: SidecarManager state NOT available",
                "error": true
            }));
            return Err("SidecarManager state not available".to_string());
        }
    };

    ulog_info!("[CronTask] Got SidecarManager state for task {}", task.id);

    // Convert run_mode enum to string for payload
    let run_mode_str = match task.run_mode {
        RunMode::SingleSession => "single_session",
        RunMode::NewSession => "new_session",
    };

    // Per-tick session-id rotation for new_session mode.
    //
    // Before this, `task.session_id` was a stable placeholder and Bun would
    // create its OWN session id internally via `switchToSession(createSession(...))`.
    // That split-brain meant the Rust `ManagedSidecar` registry was keyed by
    // the placeholder while Bun was actually running a different session —
    // opening the real session via history could not find the live sidecar
    // and spawned a duplicate read-only one that loaded a stale on-disk
    // snapshot (Bug A, v0.1.69). We now generate the real session id here,
    // use it as BOTH the Rust registry key and the id Bun switches into,
    // so a tab opening the session joins the live sidecar and sees
    // execution in-flight.
    //
    // For single_session mode: `task.session_id` is the stable identity of
    // the ongoing conversation; never rotated.
    let effective_session_id = if task.run_mode == RunMode::NewSession {
        rotate_new_session_id(handle, task).await?
    } else {
        task.session_id.clone()
    };

    // If this cron is bound to a Task Center Task, append the session id to
    // `task.sessionIds[]` so the "任务执行" panel in TaskDetailOverlay can
    // surface every execution (one row per tick for new_session, one stable
    // row for single_session). `append_session` is idempotent (dedup'd on
    // line 1864) so the single_session case safely no-ops after the first
    // tick.
    //
    // Design deliberately does NOT delegate this to the AI agent via CLI
    // (previous PRD text suggested that). Relying on the AI to remember a
    // `myagents task append-session` call at session end is a pit-of-
    // not-success: it only works when the AI explicitly does it, which is
    // unobservable until users report "my task executed but the history
    // is empty." Doing it at the Rust dispatch point guarantees coverage
    // for every execution, regardless of AI cooperation.
    if let Some(ref ta_id) = task.task_id {
        if let Some(ta_store) = crate::task::get_task_store() {
            if let Err(e) = ta_store.append_session(ta_id, &effective_session_id).await {
                // Non-fatal — the execution proceeds; the missing link just
                // means this run won't appear in the task detail 任务执行
                // list. Surface as warn so the gap is auditable.
                ulog_warn!(
                    "[CronTask] append_session(task={}, session={}) failed: {} — 任务执行 UI will miss this run",
                    ta_id, effective_session_id, e
                );
            }
        }
    }

    // Build execution payload
    // execution_number is 1-based (first execution = 1)
    let execution_number = task.execution_count + 1;

    // PRD §9.3.1: if this CronTask is linked to a Task Center task, construct
    // the prompt dynamically from the latest `~/.myagents/tasks/<id>/task.md`
    // (or alignment state) instead of using the CronTask's frozen `prompt`
    // field. This lets the user edit task.md between firings and the next
    // execution picks up the change.
    //
    // Short-circuit + block guards (CC review C1c + C2):
    //   - linked Task is deleted / archived / in terminal state → skip this
    //     tick AND actually stop the CronTask (status=Stopped + release
    //     sidecar ownership + emit event) so subsequent scheduler iterations
    //     exit via the `status != Running` break on line ~934.
    //     Without this the scheduler would keep firing every tick, each time
    //     hitting this guard, returning Err, recording a failed run, and
    //     trying again next interval — a silent error loop that burns disk
    //     on `~/.myagents/cron_runs/` and spams the unified log. (v0.1.69 H2)
    //   - task.md missing / empty for a direct task → transition the Task to
    //     Blocked with the error as message (rather than sending a meaningless
    //     placeholder prompt to the model)
    let prompt_to_send = if let Some(ref ta_id) = task.task_id {
        if let Some(ta_store) = crate::task::get_task_store() {
            if let Some(ta) = ta_store.get(ta_id).await {
                if ta.deleted
                    || matches!(
                        ta.status,
                        crate::task::TaskStatus::Deleted
                            | crate::task::TaskStatus::Archived
                            | crate::task::TaskStatus::Stopped
                            | crate::task::TaskStatus::Blocked
                            | crate::task::TaskStatus::Done
                    )
                {
                    let reason = format!(
                        "linked Task {} in terminal state '{}'",
                        ta_id,
                        ta.status.as_str()
                    );
                    ulog_warn!(
                        "[CronTask] task {} {} — stopping CronTask to prevent scheduler loop",
                        task.id,
                        reason
                    );
                    // Actually stop — flips status to Stopped + releases
                    // sidecar + emits `cron:task-stopped`. The scheduler's
                    // next iteration reads the new status and breaks.
                    // Failure to stop is logged but non-fatal: even without
                    // the manager update, returning Err still aborts this
                    // tick; worst case we fall back to the old loop
                    // behavior instead of crashing.
                    let stop_result = get_cron_task_manager()
                        .stop_task(&task.id, Some(reason.clone()))
                        .await;
                    if let Err(e) = stop_result {
                        ulog_error!(
                            "[CronTask] failed to stop task {} after terminal-state detection: {}",
                            task.id,
                            e
                        );
                    }
                    // Wrap the reason with the sentinel so the outer
                    // scheduler loop recognises this as a graceful stop
                    // (not a real execution failure) and skips recording
                    // a failure / setting last_error / emitting
                    // execution-error. See `TERMINAL_STOP_SENTINEL` docs.
                    return Err(format!("{}{}", TERMINAL_STOP_SENTINEL, reason));
                }
            }
        }

        match crate::task::build_dispatch_prompt(ta_id).await {
            Some(Ok(p)) => p,
            Some(Err(e)) => {
                ulog_error!(
                    "[CronTask] task {} linked to Task {} but dispatch prompt build failed: {} — blocking Task",
                    task.id, ta_id, e
                );
                // Transition Task to Blocked so the UI surfaces the problem.
                if let Some(ta_store) = crate::task::get_task_store() {
                    let _ = ta_store
                        .update_status(crate::task::TaskUpdateStatusInput {
                            id: ta_id.clone(),
                            status: crate::task::TaskStatus::Blocked,
                            message: Some(format!("dispatch prompt build failed: {}", e)),
                            actor: crate::task::TransitionActor::System,
                            source: Some(crate::task::TransitionSource::Crash),
                        })
                        .await;
                }
                return Err(format!("dispatch prompt build failed: {}", e));
            }
            None => task.prompt.clone(),
        }
    } else {
        task.prompt.clone()
    };

    let payload = CronExecutePayload {
        task_id: task.id.clone(),
        prompt: prompt_to_send,
        session_id: Some(effective_session_id.clone()),
        is_first_execution: Some(is_first_execution),
        ai_can_exit: Some(task.end_conditions.ai_can_exit),
        permission_mode: Some(task.permission_mode.clone()),
        model: task.model.clone(),
        // PRD 0.2.9: legacy snapshot path — only forwarded for tasks persisted
        // in 0.2.8 or earlier (when `provider_env` was the persistence shape).
        // New crons have `provider_env: None` and `provider_id: Some(_)`; the
        // sidecar prefers `provider_id` and live-resolves on every tick.
        provider_env: task.provider_env.as_ref().map(|env| ProviderEnv {
            base_url: env.base_url.clone(),
            api_key: env.api_key.clone(),
            api_protocol: env.api_protocol.clone(),
            max_output_tokens: env.max_output_tokens,
            max_output_tokens_param_name: env.max_output_tokens_param_name.clone(),
            upstream_format: env.upstream_format.clone(),
        }),
        provider_id: task.provider_id.clone(),
        // PRD #119: forward routing intent so the sidecar handler can
        // either honor the snapshot path (FollowAgent / legacy) or
        // short-circuit to task-owned values (Subscription / Explicit).
        provider_intent: Some(task.provider_intent),
        runtime: task.runtime.clone(),
        runtime_config: task.runtime_config.clone(),
        mcp_enabled_servers: task.mcp_enabled_servers.clone(),
        run_mode: Some(run_mode_str.to_string()),
        interval_minutes: Some(task.interval_minutes),
        execution_number: Some(execution_number),
    };

    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_directly: calling execute_cron_task, workspace={}", task.workspace_path)
    }));

    ulog_info!("[CronTask] Built payload for task {}, calling execute_cron_task with workspace: {}", task.id, task.workspace_path);

    // Execute via Sidecar
    let result = execute_cron_task(handle, &sidecar_state, &task.workspace_path, payload).await
        .map_err(|e| {
            ulog_error!("[CronTask] execute_cron_task failed for task {}: {}", task.id, e);
            let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": format!("execute_task_directly: execute_cron_task FAILED: {}", e),
                "error": true
            }));
            e
        })?;

    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_directly: execute_cron_task completed, task_success={}", result.success)
    }));

    ulog_info!("[CronTask] execute_cron_task completed for task {}, task_success={}", task.id, result.success);

    // PRD 0.2.9 — Provider-resolution failure should permanently Block the
    // linked Task, not just record `last_run_ok=false`. The sidecar surfaces
    // these via `success:false` + an error string starting with
    // "Provider 'X'" (set in src/server/index.ts::resolveCronProviderRouting):
    //   - "Provider 'X' not found in config" — provider deleted
    //   - "Provider 'X' has no API Key" — credential removed
    // Both are deterministic per-tick failures: re-running on the next tick
    // will fail the same way until the user re-picks a provider. Mark the
    // Task as Blocked so the UI surfaces the actionable error and the
    // scheduler stops retrying. Mirrors the build_dispatch_prompt failure
    // path above.
    if !result.success {
        let err_msg = result.error.clone().unwrap_or_default();
        let is_provider_resolution_failure = err_msg.starts_with("Provider '")
            && (err_msg.contains("not found in config")
                || err_msg.contains("has no API Key"));
        if is_provider_resolution_failure {
            if let Some(ta_id) = task.task_id.as_ref() {
                ulog_error!(
                    "[CronTask] task {} provider resolution failed: {} — blocking linked Task {}",
                    task.id,
                    err_msg,
                    ta_id
                );
                if let Some(ta_store) = crate::task::get_task_store() {
                    let _ = ta_store
                        .update_status(crate::task::TaskUpdateStatusInput {
                            id: ta_id.clone(),
                            status: crate::task::TaskStatus::Blocked,
                            message: Some(err_msg.clone()),
                            actor: crate::task::TransitionActor::System,
                            source: Some(crate::task::TransitionSource::Crash),
                        })
                        .await;
                }
            }
            // Stop the underlying CronTask too so the scheduler doesn't keep
            // retrying every interval. The user's UI action (re-pick provider
            // → save) will rebuild and restart it via ensure_cron_for_task.
            let _ = get_cron_task_manager()
                .stop_task(&task.id, Some(format!("provider unavailable: {}", err_msg)))
                .await;
        }
    }

    // Send notification if enabled
    if task.notify_enabled {
        send_task_notification(handle, task, &result);
    }

    let ai_exit_reason = if result.ai_requested_exit == Some(true) {
        result.exit_reason
    } else {
        None
    };

    Ok((result.success, ai_exit_reason, result.output_text, result.session_id))
}

/// Stop a task, unregister CronTask user, and deactivate its session (internal helper)
/// Used by scheduler when end conditions are met or AI requests exit
/// With Session-centric Sidecar (Owner model), this releases CronTask's ownership.
async fn stop_task_internal(
    handle: &AppHandle,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    task_id: &str,
    exit_reason: Option<String>,
) {
    // Get session ID before updating status
    let session_id = {
        let tasks_guard = tasks.read().await;
        tasks_guard.get(task_id).map(|t| t.session_id.clone())
    };

    let Some(session_id) = session_id else {
        ulog_warn!("[CronTask] Task {} not found in stop_task_internal", task_id);
        return;
    };

    // Release CronTask's ownership of the Session Sidecar
    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        let owner = SidecarOwner::CronTask(task_id.to_string());
        match release_session_sidecar(&sidecar_state, &session_id, &owner) {
            Ok(stopped) => {
                if stopped {
                    ulog_info!(
                        "[CronTask] Released CronTask {} from session {}, Sidecar stopped",
                        task_id, session_id
                    );
                } else {
                    ulog_info!(
                        "[CronTask] Released CronTask {} from session {}, Sidecar continues",
                        task_id, session_id
                    );
                }
            }
            Err(e) => {
                ulog_error!(
                    "[CronTask] Failed to release CronTask {} from session {}: {}",
                    task_id, session_id, e
                );
            }
        }

        // Deactivate session (for legacy session tracking)
        if let Ok(mut manager) = sidecar_state.lock() {
            manager.deactivate_session(&session_id);
            ulog_info!("[CronTask] Deactivated session {} for stopped task {}", session_id, task_id);
        }
    }

    // Update task status
    {
        let mut tasks_guard = tasks.write().await;
        if let Some(task) = tasks_guard.get_mut(task_id) {
            task.status = TaskStatus::Stopped;
            task.exit_reason = exit_reason.clone();
        }
    }

    // Save to disk atomically (prevents data corruption on crash)
    if let Some(parent) = dirs::home_dir() {
        let storage_path = parent.join(".myagents").join("cron_tasks.json");
        if let Err(e) = atomic_save_tasks(&storage_path, &tasks).await {
            ulog_error!("[CronTask] Failed to save tasks on stop: {}", e);
        }
    }

    // Emit stopped event
    let _ = handle.emit("cron:task-stopped", serde_json::json!({
        "taskId": task_id,
        "exitReason": exit_reason.clone()
    }));

    // PRD §11 — propagate completion to Task Center if this CronTask is linked
    // to a Task (best-effort, failures logged).
    crate::task::mark_cron_completion_if_linked(task_id, exit_reason.as_deref()).await;

    ulog_info!("[CronTask] Task {} stopped", task_id);
}

/// Send system notification for task execution
fn send_task_notification(
    handle: &AppHandle,
    task: &CronTask,
    result: &crate::sidecar::CronExecuteResponse,
) {
    let title = if result.success {
        "定时任务执行完成".to_string()
    } else {
        "定时任务执行失败".to_string()
    };

    let body = if let Some(ref reason) = result.exit_reason {
        format!("AI 主动结束: {}", reason)
    } else if let Some(ref error) = result.error {
        format!("错误: {}", error)
    } else {
        format!("任务 #{} 已完成", task.execution_count + 1)
    };

    // Use tauri notification plugin — include tab_id for frontend navigation
    let _ = handle.emit("notification:show", serde_json::json!({
        "title": title,
        "body": body,
        "tabId": task.tab_id
    }));
}

/// Global singleton instance
static CRON_TASK_MANAGER: std::sync::OnceLock<CronTaskManager> = std::sync::OnceLock::new();

/// Get the global CronTaskManager instance
pub fn get_cron_task_manager() -> &'static CronTaskManager {
    CRON_TASK_MANAGER.get_or_init(CronTaskManager::new)
}

// ============ Tauri Commands ============

/// Create a new cron task
#[tauri::command]
pub async fn cmd_create_cron_task(config: CronTaskConfig) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.create_task(config).await
}

/// Start a cron task
/// The cron task Sidecar will be started on-demand when the first execution runs
#[tauri::command]
pub async fn cmd_start_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    let task = manager.start_task(&task_id).await?;

    ulog_info!(
        "[CronTask] Started cron task {} for workspace {}",
        task.id, task.workspace_path
    );

    // Emit event so frontend task list refreshes immediately
    let _ = app_handle.emit("cron:task-started", serde_json::json!({
        "taskId": task.id,
    }));

    Ok(task)
}

/// Stop a cron task (with optional exit reason)
/// exit_reason can be set when AI calls ExitCronTask or end conditions are met
#[tauri::command]
pub async fn cmd_stop_cron_task(task_id: String, exit_reason: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.stop_task(&task_id, exit_reason).await
}

/// Delete a cron task
#[tauri::command]
pub async fn cmd_delete_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.delete_task(&task_id).await?;
    let _ = app_handle.emit("cron:task-deleted", serde_json::json!({ "taskId": task_id }));
    Ok(())
}

/// Get a cron task by ID
#[tauri::command]
pub async fn cmd_get_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))
}

/// Get all cron tasks
#[tauri::command]
pub async fn cmd_get_cron_tasks() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_all_tasks().await)
}

/// Get cron tasks for a workspace
#[tauri::command]
pub async fn cmd_get_workspace_cron_tasks(workspace_path: String) -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_for_workspace(&workspace_path).await)
}

/// Get active cron task for a session (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_cron_task(sessionId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_session(&sessionId).await)
}

/// Get active cron task for a tab (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_tab_cron_task(tabId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_tab(&tabId).await)
}

/// Record task execution (called by Sidecar after execution completes)
#[tauri::command]
pub async fn cmd_record_cron_execution(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.record_execution(&task_id).await
}

/// Update task's tab association
#[tauri::command]
pub async fn cmd_update_cron_task_tab(task_id: String, tab_id: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_tab(&task_id, tab_id).await
}

/// Update task's session ID (called when session is created after task creation)
#[tauri::command]
pub async fn cmd_update_cron_task_session(task_id: String, session_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_session(&task_id, session_id).await
}

/// Get tasks that need recovery (tasks that were running before app restart)
#[tauri::command]
pub async fn cmd_get_tasks_to_recover() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_to_recover().await)
}

/// Start the scheduler for a task
/// This function is called both for initial task start and for recovery after app restart.
/// With Session-centric Sidecar (Owner model), this ensures CronTask is added as owner.
#[tauri::command]
pub async fn cmd_start_cron_scheduler(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    ulog_info!("[CronTask] cmd_start_cron_scheduler called for task: {}", task_id);

    let manager = get_cron_task_manager();
    ulog_debug!("[CronTask] Got manager, getting task...");

    // Get task info for session activation
    let task = manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;
    ulog_debug!("[CronTask] Got task: {}, session_id: {}", task_id, task.session_id);

    // Ensure Session has a Sidecar with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    if let Some(sidecar_state) = app_handle.try_state::<ManagedSidecarManager>() {
        ulog_debug!("[CronTask] Got sidecar state, ensuring session sidecar...");

        // Clone data for spawn_blocking (requires 'static lifetime)
        let app_handle_clone = app_handle.clone();
        let sidecar_state_clone = sidecar_state.inner().clone();
        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        let owner = SidecarOwner::CronTask(task_id.clone());
        let task_id_for_log = task_id.clone();
        let tab_id = task.tab_id.clone();

        ulog_info!("[CronTask] Calling ensure_session_sidecar for session: {}", session_id);

        // Run blocking sidecar operations in a dedicated thread pool
        let result = tokio::task::spawn_blocking(move || {
            let workspace = std::path::Path::new(&workspace_path);
            ensure_session_sidecar(&app_handle_clone, &sidecar_state_clone, &session_id, workspace, owner)
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?;

        match result {
            Ok(result) => {
                ulog_info!(
                    "[CronTask] Ensured Sidecar for session {} (port={}, is_new={})",
                    task.session_id, result.port, result.is_new
                );

                // Activate session (for legacy session tracking)
                if let Ok(mut sidecar_manager) = sidecar_state.lock() {
                    sidecar_manager.activate_session(
                        task.session_id.clone(),
                        tab_id,
                        Some(task_id_for_log),
                        result.port,
                        task.workspace_path.clone(),
                        true, // is_cron_task = true
                    );
                }
            }
            Err(e) => {
                ulog_error!(
                    "[CronTask] Failed to ensure Sidecar for task {}: {}",
                    task_id, e
                );
                return Err(e);
            }
        }
    }

    // Start the scheduler loop
    manager.start_task_scheduler(&task_id).await
}

/// Mark a task as currently executing (called when execution starts)
#[tauri::command]
pub async fn cmd_mark_task_executing(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_executing(&task_id).await;
    Ok(())
}

/// Mark a task as no longer executing (called when execution completes)
#[tauri::command]
pub async fn cmd_mark_task_complete(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_complete(&task_id).await;
    Ok(())
}

/// Check if a task is currently executing
#[tauri::command]
pub async fn cmd_is_task_executing(task_id: String) -> Result<bool, String> {
    let manager = get_cron_task_manager();
    Ok(manager.is_task_executing(&task_id).await)
}

/// Get execution history (run records) for a cron task
#[tauri::command]
pub fn cmd_get_cron_runs(task_id: String, limit: Option<usize>) -> Result<Vec<CronRunRecord>, String> {
    Ok(read_cron_runs(&task_id, limit.unwrap_or(20)))
}

/// Update editable fields of a cron task (name, prompt, schedule, endConditions)
/// If the task is running, it will be stopped, updated, and restarted.
#[tauri::command]
pub async fn cmd_update_cron_task_fields(
    app_handle: tauri::AppHandle,
    task_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<CronSchedule>,
    interval_minutes: Option<u32>,
    end_conditions: Option<EndConditions>,
    notify_enabled: Option<bool>,
    model: Option<String>,
    permission_mode: Option<String>,
    delivery: Option<CronDelivery>,
    clear_delivery: Option<bool>,
) -> Result<CronTask, String> {
    // Delegate to the single-source-of-truth implementation in
    // `update_task_fields`. It handles the stop→apply→restart bounce
    // uniformly for every caller (Tauri command + Task Center projection),
    // so changing a running cron's schedule through any surface takes effect
    // immediately.
    let manager = get_cron_task_manager();
    let mut patch = serde_json::Map::new();
    if let Some(n) = name {
        patch.insert("name".to_string(), serde_json::Value::String(n));
    }
    if let Some(p) = prompt {
        patch.insert("prompt".to_string(), serde_json::Value::String(p));
    }
    if let Some(s) = schedule {
        patch.insert(
            "schedule".to_string(),
            serde_json::to_value(&s).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(im) = interval_minutes {
        patch.insert(
            "intervalMinutes".to_string(),
            serde_json::Value::Number(serde_json::Number::from(im)),
        );
    }
    if let Some(ec) = end_conditions {
        patch.insert(
            "endConditions".to_string(),
            serde_json::to_value(&ec).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(ne) = notify_enabled {
        patch.insert("notifyEnabled".to_string(), serde_json::Value::Bool(ne));
    }
    if let Some(m) = model {
        patch.insert("model".to_string(), serde_json::Value::String(m));
    }
    if let Some(pm) = permission_mode {
        patch.insert("permissionMode".to_string(), serde_json::Value::String(pm));
    }
    if let Some(d) = delivery {
        patch.insert(
            "delivery".to_string(),
            serde_json::to_value(&d).unwrap_or(serde_json::Value::Null),
        );
    } else if clear_delivery == Some(true) {
        patch.insert("clearDelivery".to_string(), serde_json::Value::Bool(true));
    }

    let updated = manager
        .update_task_fields(&task_id, serde_json::Value::Object(patch))
        .await?;

    let _ = app_handle.emit("cron:task-updated", serde_json::json!({ "taskId": task_id }));
    Ok(updated)
}

/// Task Center adapter (v0.1.69) — deliver a Task status notification to an IM
/// Bot via the existing cron delivery pipeline. The caller supplies the bot
/// channel id and (optional) chat thread; platform is looked up on the fly.
///
/// Safe to call from outside `cron_task`; it handles the case where IM state
/// is missing, the bot isn't running, etc. — all errors are logged and swallowed.
pub async fn deliver_task_notification_to_bot(
    handle: &AppHandle,
    bot_channel_id: &str,
    bot_thread: Option<&str>,
    task_id: &str,
    summary: &str,
) {
    let _ = deliver_task_notification_to_bot_checked(
        handle,
        bot_channel_id,
        bot_thread,
        task_id,
        summary,
    )
    .await;
}

/// Same as `deliver_task_notification_to_bot` but returns `true` when the bot
/// lookup + dispatch happened, `false` when the bot wasn't registered /
/// offline / IM state missing. The Task Center uses the bool to decide
/// whether to fire a desktop fallback (PRD §12.6).
pub async fn deliver_task_notification_to_bot_checked(
    handle: &AppHandle,
    bot_channel_id: &str,
    bot_thread: Option<&str>,
    task_id: &str,
    summary: &str,
) -> bool {
    // Structural precheck — confirm the bot channel is actually registered
    // somewhere the router can reach. This catches the majority of failure
    // modes (bot offline, bot removed, IM state not yet initialized).
    let reachable = {
        let mut found = false;
        if let Some(agent_state) = handle.try_state::<crate::im::ManagedAgents>() {
            let agents_guard = agent_state.lock().await;
            for (_, agent) in agents_guard.iter() {
                if agent.channels.contains_key(bot_channel_id) {
                    found = true;
                    break;
                }
            }
        }
        if !found {
            if let Some(im_state) = handle.try_state::<crate::im::ManagedImBots>() {
                let guard = im_state.lock().await;
                if guard.contains_key(bot_channel_id) {
                    found = true;
                }
            }
        }
        found
    };
    if !reachable {
        ulog_warn!(
            "[CronTask] Task notification for {} targeted bot {} but channel is not registered",
            task_id,
            bot_channel_id
        );
        return false;
    }

    let delivery = CronDelivery {
        bot_id: bot_channel_id.to_string(),
        chat_id: bot_thread.unwrap_or("").to_string(),
        platform: "task-center".to_string(),
    };
    deliver_cron_result_to_bot(handle, &delivery, task_id, summary).await;
    true
}

/// Deliver cron task completion result to IM Bot.
///
/// **v0.2.4 redesign:** the cron event payload now lives in
/// `ImBotInstance.pending_cron_events` (Rust-side, durable across sidecar
/// process restarts). The heartbeat runner snapshots that vec on each cycle
/// and ships it to the sidecar via heartbeat HTTP body, then clears delivered
/// entries only after the IM platform actually accepted the relay. This makes
/// the cron→IM hand-off at-least-once — sidecar death, AI silent reply, and
/// `push_text_preferring_stream` failure all leave the entry pending for the
/// next heartbeat to retry.
///
/// Steps:
///   1. Append a `PendingCronEvent` to the bot's pending vec.
///   2. Wake the heartbeat runner (which will deliver it).
///
/// (The legacy POST `/api/im/system-event` + sidecar `systemEventQueue` path
/// is no longer used for cron events. Sidecar still accepts that endpoint for
/// other event kinds — body field takes precedence when both are present.)
async fn deliver_cron_result_to_bot(
    handle: &AppHandle,
    delivery: &CronDelivery,
    task_id: &str,
    summary: &str,
) {
    ulog_info!(
        "[CronTask] Delivering result for task {} to bot {} (platform: {})",
        task_id, delivery.bot_id, delivery.platform
    );

    // Look up the bot's pending vec + wake channel. We try the Agent state
    // first (v0.1.41 channels), then fall back to legacy ManagedImBots. Both
    // ultimately point at the same per-channel ImBotInstance Arc fields.
    let im_state: tauri::State<'_, crate::im::ManagedImBots> = match handle.try_state() {
        Some(s) => s,
        None => {
            ulog_warn!("[CronTask] Cannot deliver result: IM state not available");
            return;
        }
    };

    let (pending_cron_events, wake_tx) = {
        let agent_refs = if let Some(agent_state) = handle.try_state::<crate::im::ManagedAgents>() {
            let agents_guard = agent_state.lock().await;
            let mut found = None;
            for (_agent_id, agent) in agents_guard.iter() {
                if let Some(ch) = agent.channels.get(&delivery.bot_id) {
                    found = Some((
                        std::sync::Arc::clone(&ch.bot_instance.pending_cron_events),
                        ch.bot_instance.heartbeat_wake_tx.clone(),
                    ));
                    break;
                }
            }
            found
        } else {
            None
        };

        if let Some(refs) = agent_refs {
            refs
        } else {
            let im_guard = im_state.lock().await;
            let instance = match im_guard.get(&delivery.bot_id) {
                Some(i) => i,
                None => {
                    ulog_warn!(
                        "[CronTask] Cannot deliver result: Bot {} not found or not running. \
                         Task result stored in execution history only. \
                         User needs to start the channel in Agent settings.",
                        delivery.bot_id
                    );
                    return;
                }
            };
            (
                std::sync::Arc::clone(&instance.pending_cron_events),
                instance.heartbeat_wake_tx.clone(),
            )
        }
    }; // guards dropped here

    // 1. Append to pending. Cap to keep memory bounded if the bot is offline
    // for an extended period — daily reports are 1/day so 50 covers ~7 weeks
    // before the oldest gets evicted (FIFO). Eviction logs a warning so the
    // operator notices delivery is silently dropping.
    const MAX_PENDING_CRON_EVENTS: usize = 50;
    {
        let mut pending = pending_cron_events.lock().await;
        while pending.len() >= MAX_PENDING_CRON_EVENTS {
            let evicted = pending.remove(0);
            ulog_warn!(
                "[CronTask] pending_cron_events at cap ({}) for bot {} — evicting oldest task_id={}",
                MAX_PENDING_CRON_EVENTS, delivery.bot_id, evicted.task_id
            );
        }
        pending.push(crate::im::types::PendingCronEvent {
            event: "cron_complete".to_string(),
            task_id: task_id.to_string(),
            content: summary.to_string(),
            // Local-side timestamp; only used internally as a dedup-clear
            // disambiguator, never displayed to the user.
            timestamp: chrono::Utc::now().timestamp_millis().max(0) as u64,
        });
        ulog_info!(
            "[CronTask] Appended cron event to bot {} pending (now {} pending)",
            delivery.bot_id, pending.len()
        );
    }

    // 2. Wake the heartbeat runner. The wake reason still carries (task_id,
    // summary) for log readability; the heartbeat runner reads pending from
    // the Arc directly, not from the wake reason.
    if let Some(ref wake_tx) = wake_tx {
        let reason = crate::im::types::WakeReason::CronComplete {
            task_id: task_id.to_string(),
            summary: summary.to_string(),
        };
        if let Err(e) = wake_tx.send(reason).await {
            ulog_warn!("[CronTask] Failed to wake heartbeat: {}", e);
        } else {
            ulog_info!("[CronTask] Heartbeat wake sent for bot {}", delivery.bot_id);
        }
    } else {
        ulog_warn!(
            "[CronTask] Bot {} has no heartbeat_wake_tx — cron event will sit in \
             pending until next interval tick (up to heartbeat interval)",
            delivery.bot_id
        );
    }
}

/// Initialize cron task manager with app handle (called during app setup)
/// Now includes unified recovery logic (方案 A: Rust 统一恢复)
/// Emits "cron:manager-ready" event when initialization is complete
/// Emits "cron:task-recovered" for each recovered task
/// Emits "cron:recovery-summary" after all recovery attempts complete
pub async fn initialize_cron_manager(handle: AppHandle) {
    let manager = get_cron_task_manager();
    manager.set_app_handle(handle.clone()).await;
    ulog_info!("[CronTask] Manager initialized with app handle");

    // PRD 0.2.5 R3 — persist the in-memory migration done at construction
    // time (see CronTaskManager::new + migrate_in_memory_legacy_auto_permission_mode).
    // Eagerly saving here means the migration is durable even if the app
    // crashes before the next mutation. Idempotent: if no tasks needed
    // migration, this is just a no-op rewrite of the same content.
    persist_legacy_auto_migration(manager).await;

    // Safety-net heal: recurring/scheduled Tasks whose schedule fields
    // were wiped by an earlier migration bug can be repaired from the
    // linked CronTask, which still carries the authoritative schedule.
    // Must run before `recover_running_tasks` so the recovery pass sees
    // the healed schedule (and `ensure_cron_for_task` doesn't silently
    // fall back to the 60-minute default for a task the user set to
    // "every day at 11am").
    heal_task_schedule_fields(manager).await;

    // Recover running tasks (方案 A: Rust 层统一恢复)
    recover_running_tasks(&handle).await;

    // Emit event to notify frontend that cron manager is ready
    // Frontend no longer needs to call recoverCronTasks
    let _ = handle.emit("cron:manager-ready", serde_json::json!({}));
    ulog_info!("[CronTask] Emitted cron:manager-ready event");
}

/// PRD 0.2.5 R3 — persist the legacy permissionMode='auto' migration that
/// already ran in-memory at `CronTaskManager::new()` (see
/// `migrate_in_memory_legacy_auto_permission_mode`).
///
/// Why split: the in-memory mutation must happen before any async caller
/// can read tasks (management API serves concurrently with cron init).
/// The disk persist requires async I/O, so it runs here in the async
/// init path. Idempotent — if no tasks needed migration, save_to_disk
/// rewrites the same content. Safe across restarts.
async fn persist_legacy_auto_migration(manager: &CronTaskManager) {
    // Detect whether any in-memory state actually needs persisting (i.e.,
    // whether the construction-time pass migrated anything). We can't tell
    // directly from the manager — but we can compare against the current
    // disk snapshot to decide if a save is needed. Simpler: just save
    // unconditionally. atomic_save_tasks is cheap (single file rewrite),
    // and idempotent persistence is fine.
    if let Err(e) = manager.save_to_disk().await {
        ulog_warn!(
            "[CronTask] R3 migration persist failed (in-memory state still \
             correct; next mutation will persist): {}",
            e
        );
    }
}

/// Scan every live CronTask, take a snapshot of its schedule, and offer it
/// to `TaskStore` as backfill material for any linked Task with missing
/// schedule fields. The backfill helper only writes when a field is
/// actually empty — stable tasks are untouched.
async fn heal_task_schedule_fields(manager: &CronTaskManager) {
    let Some(task_store) = crate::task::get_task_store() else {
        return;
    };
    let cron_tasks = manager.get_all_tasks().await;
    // Build a lookup by cron task id so the TaskStore heal pass can answer
    // "what schedule does this CronTask have?" without holding the cron
    // manager lock while we iterate the Task map.
    let snapshot: std::collections::HashMap<String, crate::task::ScheduleBackfill> = cron_tasks
        .into_iter()
        .filter_map(|ct| {
            let backfill = match ct.schedule.as_ref()? {
                CronSchedule::Every { minutes, .. } => {
                    crate::task::ScheduleBackfill::IntervalMinutes(*minutes)
                }
                CronSchedule::Cron { expr, tz } => crate::task::ScheduleBackfill::Cron {
                    expression: expr.clone(),
                    timezone: tz.clone(),
                },
                CronSchedule::At { at } => crate::task::ScheduleBackfill::DispatchAt(
                    chrono::DateTime::parse_from_rfc3339(at).ok()?.timestamp_millis(),
                ),
                CronSchedule::Loop => return None,
            };
            Some((ct.id, backfill))
        })
        .collect();

    if snapshot.is_empty() {
        return;
    }

    let healed = task_store
        .heal_missing_schedule_fields(|cron_id| snapshot.get(cron_id).cloned())
        .await;
    if !healed.is_empty() {
        ulog_info!(
            "[task] safety-net heal: back-filled schedule on {} task(s) from linked CronTasks: {:?}",
            healed.len(),
            healed
        );
    }
}

/// Recover all tasks that were running before app restart (方案 A: Rust 统一恢复)
/// This function:
/// 1. Gets all tasks with status=Running
/// 2. For each task: starts Sidecar, activates session, starts scheduler
/// 3. Emits cron:task-recovered for each success
/// 4. Emits cron:recovery-summary when done
async fn recover_running_tasks(handle: &AppHandle) {
    let manager = get_cron_task_manager();
    let tasks_to_recover = manager.get_tasks_to_recover().await;

    if tasks_to_recover.is_empty() {
        ulog_info!("[CronTask] No tasks to recover");
        // Emit empty summary
        let _ = handle.emit("cron:recovery-summary", CronRecoverySummaryPayload {
            total_tasks: 0,
            recovered_count: 0,
            failed_count: 0,
            failed_tasks: vec![],
        });
        return;
    }

    ulog_info!("[CronTask] Recovering {} task(s)...", tasks_to_recover.len());

    let mut recovered_count = 0u32;
    let mut failed_tasks: Vec<CronRecoveryFailedTask> = vec![];

    for task in &tasks_to_recover {
        match try_recover_single_task(handle, task).await {
            Ok(port) => {
                recovered_count += 1;
                ulog_info!("[CronTask] Recovered task {} on port {}", task.id, port);

                // Emit task-recovered event for frontend
                let _ = handle.emit("cron:task-recovered", CronTaskRecoveredPayload {
                    task_id: task.id.clone(),
                    session_id: task.session_id.clone(),
                    workspace_path: task.workspace_path.clone(),
                    port,
                    status: "running".to_string(),
                    execution_count: task.execution_count,
                    interval_minutes: task.interval_minutes,
                });
            }
            Err(e) => {
                ulog_error!("[CronTask] Failed to recover task {}: {}", task.id, e);
                failed_tasks.push(CronRecoveryFailedTask {
                    task_id: task.id.clone(),
                    workspace_path: task.workspace_path.clone(),
                    error: e,
                });
            }
        }
    }

    let total = tasks_to_recover.len() as u32;
    let failed_count = failed_tasks.len() as u32;

    ulog_info!(
        "[CronTask] Recovery complete: {}/{} tasks recovered, {} failed",
        recovered_count, total, failed_count
    );

    // Emit recovery summary
    let _ = handle.emit("cron:recovery-summary", CronRecoverySummaryPayload {
        total_tasks: total,
        recovered_count,
        failed_count,
        failed_tasks,
    });
}

/// Try to recover a single task
/// Returns the Sidecar port on success
async fn try_recover_single_task(handle: &AppHandle, task: &CronTask) -> Result<u16, String> {
    ulog_info!(
        "[CronTask] Recovering task {} for workspace {}",
        task.id, task.workspace_path
    );

    // Step 1: Ensure Session has a Sidecar with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let sidecar_state = handle.try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;

    // Clone data for spawn_blocking (requires 'static lifetime)
    let handle_clone = handle.clone();
    let sidecar_state_clone = sidecar_state.inner().clone();
    let session_id = task.session_id.clone();
    let workspace_path = task.workspace_path.clone();
    let task_id = task.id.clone();
    let tab_id = task.tab_id.clone();
    let owner = SidecarOwner::CronTask(task_id.clone());

    // Run blocking sidecar operations in a dedicated thread pool
    let result = tokio::task::spawn_blocking(move || {
        let workspace = std::path::Path::new(&workspace_path);
        ensure_session_sidecar(&handle_clone, &sidecar_state_clone, &session_id, workspace, owner)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))??;

    ulog_info!(
        "[CronTask] Session {} Sidecar ensured: port={}, is_new={}",
        task.session_id, result.port, result.is_new
    );

    // Step 2: Activate session (for legacy session tracking)
    {
        let mut manager = sidecar_state.lock()
            .map_err(|e| format!("Failed to lock SidecarManager: {}", e))?;

        manager.activate_session(
            task.session_id.clone(),
            tab_id,
            Some(task_id),
            result.port,
            task.workspace_path.clone(),
            true, // is_cron_task = true
        );
        ulog_info!("[CronTask] Session {} activated for task {}", task.session_id, task.id);
    }

    // Step 3: Start scheduler
    let cron_manager = get_cron_task_manager();
    cron_manager.start_task_scheduler(&task.id).await?;
    ulog_info!("[CronTask] Scheduler started for task {}", task.id);

    Ok(result.port)
}
