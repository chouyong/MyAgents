//! Task store for Task Center (v0.1.69).
//!
//! Tasks are workspace-scoped execution units. The primary index lives in
//! `~/.myagents/tasks.jsonl` (one task per line, atomic full-rewrite on change).
//! Associated markdown documents live under `~/.myagents/tasks/<taskId>/{task.md,
//! verify.md, progress.md, alignment.md}` (moved out of the workspace in
//! v0.1.69 — see `task_docs_dir` doc for the rationale). This module
//! manages `task.md` and `progress.md` but treats `verify.md` /
//! `alignment.md` as externally managed (written by `/task-alignment` skill
//! + Agent).
//!
//! See PRD `specs/prd/prd_0.1.69_task_center.md`:
//! - §3.2 — schema
//! - §9.1 — state machine + transitions table
//! - §10.2.1 — `update-status` handler: transition validity, actor/source guard,
//!   atomic history append, side-effect dispatch, progress.md, notification, SSE.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::cron_task::{EndConditions as CronEndConditions, RunMode as CronRunMode};
use crate::{ulog_debug, ulog_info, ulog_warn};
use tauri::Emitter;

/// Task-layer `RunMode`. Same semantics as `cron_task::RunMode` but emits PRD-
/// specified kebab-case JSON (`"single-session"` / `"new-session"`). We do NOT
/// reuse `cron_task::RunMode` directly because it emits snake_case which would
/// silently diverge from the TS shared type. Convert at the cron-adapter boundary
/// via `From`/`Into`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskRunMode {
    #[serde(rename = "single-session")]
    SingleSession,
    #[serde(rename = "new-session")]
    NewSession,
}

impl From<CronRunMode> for TaskRunMode {
    fn from(m: CronRunMode) -> Self {
        match m {
            CronRunMode::SingleSession => Self::SingleSession,
            CronRunMode::NewSession => Self::NewSession,
        }
    }
}
impl From<TaskRunMode> for CronRunMode {
    fn from(m: TaskRunMode) -> Self {
        match m {
            TaskRunMode::SingleSession => Self::SingleSession,
            TaskRunMode::NewSession => Self::NewSession,
        }
    }
}

/// Task-layer `EndConditions` — PRD-compatible shape.
///
/// `deadline` is a Unix timestamp in milliseconds (JS `Date.now()` compatible),
/// not a `DateTime<Utc>` like `cron_task::EndConditions`. We convert at the
/// cron-adapter boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEndConditions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    #[serde(default = "default_true")]
    pub ai_can_exit: bool,
}

impl From<CronEndConditions> for TaskEndConditions {
    fn from(c: CronEndConditions) -> Self {
        Self {
            deadline: c.deadline.map(|dt| dt.timestamp_millis()),
            max_executions: c.max_executions,
            ai_can_exit: c.ai_can_exit,
        }
    }
}

impl From<TaskEndConditions> for CronEndConditions {
    fn from(t: TaskEndConditions) -> Self {
        use chrono::TimeZone;
        Self {
            deadline: t
                .deadline
                .and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).single()),
            max_executions: t.max_executions,
            ai_can_exit: t.ai_can_exit,
        }
    }
}

// ================ Enums ================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Todo,
    Running,
    Verifying,
    Done,
    Blocked,
    Stopped,
    Archived,
    /// Pseudo-state used ONLY as the `to` field of a soft-delete audit entry
    /// (PRD §10.2.2). Never a legal transition target via `update_status`;
    /// only `delete()` may write it. A Task whose `status` equals `Deleted`
    /// is equivalent to `deleted=true` and is filtered out of all list
    /// queries by default.
    Deleted,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::Done => "done",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Archived => "archived",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionActor {
    System,
    User,
    Agent,
}

impl TransitionActor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionSource {
    Cli,
    Ui,
    Watchdog,
    Crash,
    Scheduler,
    EndCondition,
    Rerun,
    /// Task was created by the legacy-cron → new-model upgrade path
    /// (`legacy_upgrade::upgrade_legacy_cron`). Rendered in the status-
    /// history panel so the user can tell upgrade-originated tasks from
    /// user-authored ones.
    Migration,
}

impl TransitionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Ui => "ui",
            Self::Watchdog => "watchdog",
            Self::Crash => "crash",
            Self::Scheduler => "scheduler",
            Self::EndCondition => "endCondition",
            Self::Rerun => "rerun",
            Self::Migration => "migration",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutionMode {
    Once,
    Scheduled,
    Recurring,
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutor {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskDispatchOrigin {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "ai-aligned")]
    AiAligned,
}

/// Backfill payload for `TaskStore::heal_missing_schedule_fields`. The caller
/// translates its CronTask representation into this enum so `task.rs` stays
/// independent of `cron_task::CronSchedule`'s exact shape.
#[derive(Debug, Clone)]
pub enum ScheduleBackfill {
    IntervalMinutes(u32),
    Cron {
        expression: String,
        timezone: Option<String>,
    },
    DispatchAt(i64),
}

// ================ Struct ================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTransition {
    /// `None` represents the implicit pre-creation state.
    pub from: Option<TaskStatus>,
    pub to: TaskStatus,
    pub at: i64,
    pub actor: TransitionActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TransitionSource>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub desktop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_thread: Option<String>,
    /// Defaults to `['done', 'blocked', 'endCondition']` when absent; keep as
    /// `Option<Vec>` so omitted-means-default is distinguishable from explicit empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<String>>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub workspace_id: String,
    /// Absolute path to the workspace — Sidecar cwd and AI-bash base. Task
    /// docs live in `~/.myagents/tasks/<id>/` (user-scoped, v0.1.69+), not
    /// here. Stored so UI and execution don't have to resolve it separately.
    #[serde(default)]
    pub workspace_path: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_conditions: Option<TaskEndConditions>,
    /// Recurring-mode fixed interval (minutes). Set when
    /// `execution_mode == Recurring` and `cron_expression` is absent. The
    /// linked CronTask's `interval_minutes` is kept in sync via
    /// `TaskStore::update`'s projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Advanced-mode cron expression (takes precedence over
    /// `interval_minutes` when set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
    /// IANA timezone id for `cron_expression` (e.g. `Asia/Shanghai`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_timezone: Option<String>,
    /// Dedicated "when to fire" timestamp for `Scheduled` mode
    /// (ms since epoch). Decouples from `end_conditions.deadline`,
    /// which semantically means "when to stop running".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_at: Option<i64>,
    /// Per-task model override. When `None`, the linked Agent's default
    /// model is used. Proxied into `CronTaskConfig.model` at cron-ensure
    /// time.
    ///
    /// PRD 0.2.9 pairing rule (asymmetric, by design): when `provider_id`
    /// is set, `model` MUST also be set (validated by
    /// `validate_task_provider_routing`) — provider-without-model would
    /// silently route the picked provider's API to the agent's default
    /// model and reproduce the cross-provider misroute that #130 surfaced.
    /// The reverse is intentionally NOT rejected: model-only means "use
    /// the Agent's currently-resolved provider but override model id",
    /// reachable from the CLI / management API for legacy / advanced use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. When `None` the cron
    /// follows the workspace agent (legacy snapshot semantics). When set,
    /// the sidecar live-resolves env on every tick from
    /// `~/.myagents/config.json`, so credential rotation propagates without
    /// a re-save and credential copies never land in `tasks.jsonl` /
    /// `cron_tasks.json`.
    ///
    /// Mutually exclusive with `runtime ∈ {claude-code, codex, gemini}`
    /// (external runtimes manage their own provider) — enforced by
    /// `validate_task_provider_routing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Per-task permission mode override (auto / plan / fullAgency / custom).
    /// When `None`, the linked Agent's default is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// For `single-session` run mode: id of a pre-existing SDK session to
    /// continue instead of minting a fresh uuid on first dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preselected_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4). When `None`
    /// the executor falls back to the Agent workspace's `mcpEnabledServers`.
    /// `Some(vec![])` means "explicitly run with no MCP servers".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<i64>,
    #[serde(default)]
    pub status_history: Vec<StatusTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationConfig>,
    pub dispatch_origin: TaskDispatchOrigin,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

/// Absolute paths to a task's markdown documents. Returned by `cmd_task_get`
/// as a sibling of `Task` so the CLI / AI can read & edit the docs directly
/// via standard file-system tools (Read / Edit / Write) without having to
/// re-derive the paths from `task_docs_dir()`'s convention. Single source of
/// truth for "where do the task docs live" — callers never guess the layout.
///
/// A doc path is only included when the file actually exists on disk
/// (except `task_md`, which is always created at task creation time and is
/// therefore always surfaced). This lets the consumer distinguish "AI has
/// started working" (progress.md / verify.md present) from "fresh task"
/// without a second `fs.exists()` round-trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDocs {
    /// Absolute path to the task's docs directory.
    pub dir: String,
    /// task.md — always created at task creation; always surfaced.
    pub task_md: String,
    /// verify.md — present when the AI or user has written verification rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_md: Option<String>,
    /// progress.md — present when the AI has started recording execution progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_md: Option<String>,
    /// alignment.md — present when the task was created via /task-alignment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment_md: Option<String>,
}

/// Build a [`TaskDocs`] for a task id by resolving `task_docs_dir()` and
/// checking the on-disk existence of each optional doc file.
pub fn build_task_docs(task_id: &str) -> Result<TaskDocs, String> {
    let dir = task_docs_dir(task_id)?;
    let dir_str = dir.to_string_lossy().into_owned();
    let file_if_exists = |name: &str| -> Option<String> {
        let p = dir.join(name);
        if p.exists() {
            Some(p.to_string_lossy().into_owned())
        } else {
            None
        }
    };
    Ok(TaskDocs {
        dir: dir_str,
        task_md: dir.join("task.md").to_string_lossy().into_owned(),
        verify_md: file_if_exists("verify.md"),
        progress_md: file_if_exists("progress.md"),
        alignment_md: file_if_exists("alignment.md"),
    })
}

/// Response shape for `cmd_task_get` — flattens [`Task`] and adjoins a
/// computed [`TaskDocs`]. `#[serde(flatten)]` keeps the JSON shape
/// backwards-compatible (all prior Task fields appear at the top level);
/// only `docs` is new. Consumers that don't know about `docs` ignore it.
#[derive(Debug, Clone, Serialize)]
pub struct TaskWithDocs {
    #[serde(flatten)]
    pub task: Task,
    pub docs: TaskDocs,
}

// ================ Input DTOs ================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateDirectInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    /// Contents of `task.md` — the "executor" prompt that will be sent on dispatch.
    pub task_md_content: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Scheduling detail fields (v0.1.69 unified model) ────────────────
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub cron_timezone: Option<String>,
    #[serde(default)]
    pub dispatch_at: Option<i64>,
    // ── Execution overrides ──────────────────────────────────────────────
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. MUST be paired with
    /// `model` (validated by `validate_task_provider_routing`).
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateFromAlignmentInput {
    pub name: String,
    pub executor: TaskExecutor,
    #[serde(default)]
    pub description: Option<String>,
    /// Optional from v0.1.69 — when missing, read from the alignment dir's
    /// `metadata.json` (written at the 「AI 讨论」 launch point). Lets the
    /// AI caller pass just `--name` and inherit the rest from session
    /// metadata instead of re-typing 3 long UUIDs.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// Source directory `~/.myagents/tasks/<alignmentSessionId>/` — its
    /// contents are moved (renamed) to `~/.myagents/tasks/<newTaskId>/`.
    pub alignment_session_id: String,
    pub execution_mode: TaskExecutionMode,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Execution overrides (must stay in lockstep with TaskCreateDirectInput) ──
    // Without these fields the Bun admin-api would accept `--model` /
    // `--permissionMode` flags from the CLI, validate them, enrich the success
    // response as if the override took effect — and then serde would silently
    // drop the keys here, leaving the persisted Task with `None` for both.
    // That's exactly the silent-data-loss bug the cross-review flagged.
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override. MUST be paired with
    /// `model` (validated by `validate_task_provider_routing`).
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
}

/// Sidecar metadata persisted to `~/.myagents/tasks/<alignmentSessionId>/metadata.json`
/// at the moment the 「AI 讨论」 flow creates the alignment session. Lets
/// `create_from_alignment` inherit the workspace + thought ids without the
/// AI caller having to re-pass them through the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentSessionMetadata {
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub source_thought_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub executor: Option<TaskExecutor>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<TaskExecutionMode>,
    #[serde(default)]
    pub run_mode: Option<TaskRunMode>,
    #[serde(default)]
    pub end_conditions: Option<TaskEndConditions>,
    // ── Scheduling detail fields ────────────────────────────────────────
    #[serde(default)]
    pub interval_minutes: Option<u32>,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub cron_timezone: Option<String>,
    #[serde(default)]
    pub dispatch_at: Option<i64>,
    // ── Execution overrides ──────────────────────────────────────────────
    #[serde(default)]
    pub model: Option<String>,
    /// PRD 0.2.9 — Per-task provider id override.
    ///
    /// On update semantics: `None` means "leave provider_id unchanged"
    /// (Option-of-Option would be the principled choice but the surrounding
    /// fields all use `None = no change` so we mirror that). To clear the
    /// override, callers MUST send the JSON `{"providerId": null, "model":
    /// null}` pair — `update` accepts the explicit `clear_overrides` flag
    /// below for the no-ambiguity case. Validated by
    /// `validate_task_provider_routing`.
    #[serde(default)]
    pub provider_id: Option<String>,
    /// PRD 0.2.9 — Explicit "clear all builtin-runtime overrides" flag. When
    /// true, `provider_id` and `model` are both reset to `None` regardless
    /// of what the corresponding fields above carry. Lets the renderer's
    /// "跟随 Agent" picker option round-trip cleanly without inventing a
    /// double-Option serde shape.
    #[serde(default)]
    pub clear_provider_override: bool,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub preselected_session_id: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,
    /// PRD #131 / Codex-review #2 — symmetric "clear runtime override"
    /// flag. When true, `runtime` AND `runtime_config` are both reset to
    /// `None` regardless of what the corresponding fields above carry.
    /// Without this, the renderer's "跟随 Agent" runtime option could
    /// not round-trip a clear: `runtime: undefined` over JSON deserializes
    /// to `None`, but the apply path uses `if let Some(v) = input.runtime`
    /// which leaves the existing override untouched. Mirrors the
    /// established pattern from `clear_provider_override`.
    #[serde(default)]
    pub clear_runtime_override: bool,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    /// `Some(vec![])` clears overrides (= follow Agent); `None` = leave
    /// existing override untouched.
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub notification: Option<NotificationConfig>,
    /// When `Some`, the new contents are atomically written to
    /// `~/.myagents/tasks/<id>/task.md` under the same write lock that persists the
    /// JSONL row. Empty string is rejected — prompt must have content.
    #[serde(default)]
    pub prompt: Option<String>,
}

/// Internal-only status-transition payload. Accepts explicit `actor`/`source`
/// because crash recovery, scheduler ticks, end-condition firing, watchdog,
/// and CLI adapters all need to assert *their* actor — not the client's.
///
/// The public Tauri command uses `UiTaskUpdateStatusInput` which omits these
/// fields and the Tauri layer stamps `actor=user, source=ui` authoritatively
/// (PRD §10.2.1 caller-inference table row 3: UI button → user/ui). This
/// prevents a malicious/buggy renderer from spoofing `actor=agent` or
/// `source=endCondition`.
#[derive(Debug, Clone)]
pub struct TaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub actor: TransitionActor,
    pub source: Option<TransitionSource>,
}

/// Public DTO for the Tauri command. NOT serde-tagged with `actor`/`source` — those
/// are stamped by the command handler from its trusted entry context.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTaskUpdateStatusInput {
    pub id: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub message: Option<String>,
}

/// Accepts either a single status (`"running"`) or an array (`["running", "done"]`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StatusFilter {
    One(TaskStatus),
    Many(Vec<TaskStatus>),
}

impl StatusFilter {
    fn matches(&self, s: TaskStatus) -> bool {
        match self {
            Self::One(x) => *x == s,
            Self::Many(xs) => xs.iter().any(|x| *x == s),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListFilter {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub status: Option<StatusFilter>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub include_deleted: Option<bool>,
}

// ================ Errors ================

/// Transition-related rejection returned to the caller. Rendered as `{code, message}`
/// so the UI / CLI can branch on `code` rather than string-match messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOpError {
    pub code: String,
    pub message: String,
}

impl TaskOpError {
    fn invalid_transition(from: TaskStatus, to: TaskStatus) -> Self {
        Self {
            code: "invalid_transition".to_string(),
            message: format!(
                "invalid transition from {} to {}",
                from.as_str(),
                to.as_str()
            ),
        }
    }
    fn archive_user_only() -> Self {
        Self {
            code: "archive_user_only".to_string(),
            message: "archive is user-only (PRD §9.1)".to_string(),
        }
    }
    fn agent_source_must_be_cli() -> Self {
        Self {
            code: "agent_source_must_be_cli".to_string(),
            message: "agent transitions must come through CLI (source='cli')".to_string(),
        }
    }
    fn not_found(id: &str) -> Self {
        Self {
            code: "not_found".to_string(),
            message: format!("task not found: {}", id),
        }
    }
    fn already_deleted() -> Self {
        Self {
            code: "already_deleted".to_string(),
            message: "task has been deleted".to_string(),
        }
    }
    fn update_rejected_while_running() -> Self {
        Self {
            code: "update_rejected_running".to_string(),
            message: "cannot edit task fields while running/verifying".to_string(),
        }
    }
}

impl From<TaskOpError> for String {
    fn from(e: TaskOpError) -> Self {
        // When serialized to the CLI / invoke() caller, preserve `code` by
        // embedding a JSON-stringified payload. Callers that just want a message
        // can parse it back; ones that don't care just show it.
        serde_json::to_string(&e).unwrap_or_else(|_| e.message.clone())
    }
}

// ================ State machine ================

/// The exhaustive transition table from PRD §9.1 (v1.4, with lenient
/// verifying → running). Returns `true` if the transition is legal at the
/// machine level (actor/source guards are applied separately).
pub fn is_transition_legal(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    matches!(
        (from, to),
        // Forward progression
        (Todo, Running)
        | (Running, Verifying)
        | (Running, Done)
        | (Running, Blocked)
        | (Running, Stopped)
        | (Verifying, Running)     // v1.4 lenient mode
        | (Verifying, Done)
        | (Verifying, Blocked)
        | (Verifying, Stopped)
        // Re-run / reset
        | (Blocked, Todo)
        | (Stopped, Todo)
        | (Done, Todo)
        | (Archived, Todo)
        // Archiving
        | (Done, Archived)
    )
}

// ================ Store ================

pub struct TaskStore {
    /// taskId → Task (full row)
    inner: Arc<RwLock<HashMap<String, Task>>>,
    jsonl_path: PathBuf,
}

impl TaskStore {
    /// Create a new store. Scans disk, runs crash-recovery migration on any
    /// running/verifying rows (PRD §9.1.1), and returns a handle with the live
    /// (post-recovery) map.
    pub fn new(data_dir: PathBuf) -> Self {
        let jsonl_path = data_dir.join("tasks.jsonl");
        if let Some(parent) = jsonl_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let (initial, needs_rewrite) = Self::load_and_recover(&jsonl_path);
        // Write back the recovery results synchronously so a second crash doesn't
        // lose the migration. This runs during app `setup()` before any command is
        // dispatchable, so there is no contention.
        if needs_rewrite {
            if let Err(e) = Self::persist_locked(&jsonl_path, &initial) {
                ulog_warn!("[task] crash-recovery persist failed: {}", e);
            } else {
                ulog_info!("[task] crash-recovery applied: leftover running/verifying → blocked");
            }
        }
        Self {
            inner: Arc::new(RwLock::new(initial)),
            jsonl_path,
        }
    }

    fn load_and_recover(path: &Path) -> (HashMap<String, Task>, bool) {
        let mut map = Self::load_jsonl(path);
        let now = now_ms();
        let mut changed = false;
        for task in map.values_mut() {
            if !matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
                continue;
            }
            let from = task.status;
            // Crash recovery classification matrix:
            //
            //   (status, mode)                         → outcome
            //   (Running, Recurring | Loop)            → stay Running + self-loop audit
            //   everything else (Once, Scheduled, or Verifying × any mode)
            //                                          → Blocked + user intervention
            //
            // Rationale for each branch:
            //
            // * `Running × Recurring|Loop`: the linked CronTask's schedule
            //   is still alive; the scheduler will fire at the next planned
            //   trigger. The Task belongs in the "进行中" bucket (PRD §7.3)
            //   — not "规划中" (Todo) or "已阻塞" (Blocked). A self-loop
            //   StatusTransition (from == to == Running) records the
            //   crash in the history; the UI renders same-from-to rows as
            //   a single event pill without an arrow.
            //
            // * `Verifying × any mode`: Verifying is a hand-off state
            //   (AI finished; verification is in progress). Demoting
            //   silently to Running would lose that hand-off and could
            //   cause the next scheduler tick to re-fire the task,
            //   burning tokens and producing duplicate side effects. Safer
            //   to escalate to Blocked so the user explicitly re-verifies
            //   or rerans.
            //
            // * `Running × Once|Scheduled`: their fire window has either
            //   passed (app died mid-run) or was explicit; they need user
            //   intervention.
            let keep_running = matches!(
                (from, task.execution_mode),
                (
                    TaskStatus::Running,
                    TaskExecutionMode::Recurring | TaskExecutionMode::Loop
                )
            );
            if keep_running {
                // Status unchanged (already Running); only the
                // self-loop history entry records the event.
                //
                // Deduplication (v0.1.69+): if the most recent transition
                // is already a crash self-loop (from == to, source=crash),
                // don't write another one. The rationale:
                //
                //   - User closes laptop for lunch → app exits. We already
                //     wrote "上次运行被应用重启中断" once on the last boot.
                //   - User reopens laptop → app boots → recovery runs again.
                //     Without dedup we'd write the identical message again,
                //     and again, and again — one per suspend/resume cycle.
                //   - Real-world users saw 20+ identical crash rows for the
                //     same task across a week of daily laptop use, drowning
                //     out meaningful state transitions.
                //
                // Dedup breaks the moment the scheduler actually fires a
                // tick: that pushes a non-crash transition (e.g.
                // running→verifying, or the post-execution running→running
                // "heartbeat"), and on the next crash we'll write a fresh
                // crash row — this one carrying real signal ("we were
                // interrupted AFTER a successful tick since last boot").
                let last_is_crash_selfloop = task.status_history.last().is_some_and(|t| {
                    t.source == Some(TransitionSource::Crash) && t.from == Some(t.to)
                });
                if !last_is_crash_selfloop {
                    task.updated_at = now;
                    task.status_history.push(StatusTransition {
                        from: Some(from),
                        to: TaskStatus::Running,
                        at: now,
                        actor: TransitionActor::System,
                        message: Some(
                            "上次运行被应用重启中断,调度器将在下次计划时间继续触发"
                                .to_string(),
                        ),
                        source: Some(TransitionSource::Crash),
                    });
                    changed = true;
                }
                continue;
            } else {
                task.status = TaskStatus::Blocked;
                task.updated_at = now;
                task.status_history.push(StatusTransition {
                    from: Some(from),
                    to: TaskStatus::Blocked,
                    at: now,
                    actor: TransitionActor::System,
                    message: Some(
                        "上次运行被应用重启中断,可重新派发以继续"
                            .to_string(),
                    ),
                    source: Some(TransitionSource::Crash),
                });
            }
            changed = true;
        }
        (map, changed)
    }

    fn load_jsonl(path: &Path) -> HashMap<String, Task> {
        let mut map: HashMap<String, Task> = HashMap::new();
        let Ok(file) = fs::File::open(path) else {
            return map;
        };
        let reader = BufReader::new(file);
        let mut ok = 0usize;
        let mut bad = 0usize;
        let mut io_err = 0usize;
        for (i, line) in reader.lines().enumerate() {
            let raw = match line {
                Ok(l) => l,
                Err(e) => {
                    io_err += 1;
                    ulog_warn!("[task] line {} I/O error, skipped: {}", i + 1, e);
                    continue;
                }
            };
            if raw.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Task>(&raw) {
                Ok(t) => {
                    map.insert(t.id.clone(), t);
                    ok += 1;
                }
                Err(e) => {
                    bad += 1;
                    ulog_warn!("[task] line {} malformed, skipped: {}", i + 1, e);
                }
            }
        }
        ulog_info!(
            "[task] loaded {} task(s) from disk ({} malformed, {} io-err)",
            ok,
            bad,
            io_err
        );
        map
    }

    /// Atomically rewrite the jsonl file from the provided map.
    ///
    /// Crash-durable atomic-write pattern: write + `sync_all` the tmp file, then
    /// rename, then fsync the containing directory. On any error the tmp file is
    /// best-effort unlinked. Caller MUST hold `inner.write()`; this function does
    /// not take the lock itself.
    fn persist_locked(
        path: &Path,
        map: &HashMap<String, Task>,
    ) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create tasks dir: {}", e))?;
        }
        let tmp = path.with_extension("jsonl.tmp");
        let write_res = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)
                .map_err(|e| format!("Failed to open tasks tmp: {}", e))?;
            // Deterministic ordering by createdAt for easier diffing.
            let mut rows: Vec<&Task> = map.values().collect();
            rows.sort_by_key(|t| t.created_at);
            for t in rows {
                let line = serde_json::to_string(t)
                    .map_err(|e| format!("serialize task: {}", e))?;
                file.write_all(line.as_bytes())
                    .map_err(|e| format!("write task line: {}", e))?;
                file.write_all(b"\n")
                    .map_err(|e| format!("write newline: {}", e))?;
            }
            file.flush()
                .map_err(|e| format!("flush tasks tmp: {}", e))?;
            // Durability: force the tmp file contents to disk BEFORE rename.
            file.sync_all()
                .map_err(|e| format!("sync tasks tmp: {}", e))?;
            Ok(())
        })();
        if let Err(e) = write_res {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp); // best-effort cleanup
            return Err(format!("rename tasks.jsonl: {}", e));
        }
        // Best-effort: fsync the containing directory so the rename is durable.
        // Failure here is logged but not fatal — the rename is already committed
        // at kernel level; dir-fsync is just power-loss insurance.
        if let Some(parent) = path.parent() {
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        ulog_debug!("[task] atomically persisted {} tasks", map.len());
        Ok(())
    }

    // ---- Create ----

    pub async fn create_direct(&self, mut input: TaskCreateDirectInput) -> Result<Task, String> {
        // Validate workspace_path + name up front so we don't half-write.
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;
        validate_task_name(&input.name)?;
        // PRD 0.2.9 — Pin runtime='builtin' when provider_id is set with no
        // explicit runtime (closes the "Agent runtime later flips to
        // external" cross-talk hole). Idempotent.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        // PRD 0.2.9 — Provider routing invariants (pairing + runtime-exclusion).
        validate_task_provider_routing(&input.provider_id, &input.model, &input.runtime)?;
        // Cron expression validation at the boundary — same contract as
        // `update()`; ensures the scheduler never gets handed a malformed
        // expression that would make it die silently at first fire.
        if let Some(expr) = input.cron_expression.as_deref() {
            if !expr.trim().is_empty() {
                crate::cron_task::validate_cron_expression(
                    expr,
                    input.cron_timezone.as_deref(),
                )
                .map_err(|e| format!("cron expression invalid: {}", e))?;
            }
        }
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it always passes; the guard is for callers that pass external ids.
        let task_dir = task_docs_dir(&id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            cron_task_id: None,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: input.interval_minutes,
            cron_expression: input.cron_expression,
            cron_timezone: input.cron_timezone,
            dispatch_at: input.dispatch_at,
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            source_thought_id: input.source_thought_id,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor: TransitionActor::User,
                message: Some("created (direct)".to_string()),
                source: Some(TransitionSource::Ui),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            deleted: false,
            deleted_at: None,
        };

        // Materialize task.md FIRST, commit JSONL LAST (fix cross-review C3):
        // if the docs dir is unwritable (disk full, permissions, etc.) the task.md
        // write fails before the JSONL row is durable. Previous ordering left an
        // "orphan JSONL row with no task.md" on disk after restart — a real
        // integrity violation, not just a recoverable hiccup. Worst case now is
        // an orphan empty directory with no JSONL row referencing it, which is
        // harmless (never shows up in list()) and can be swept by a background
        // cleanup job later.
        let mut inner = self.inner.write().await;
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &input.task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            // JSONL write failed — roll back the docs dir so we don't leave
            // orphan directories on disk. `remove_dir_all` is best-effort
            // (already-interrupted filesystem may leave stragglers); log and
            // continue so the caller gets the actual error, not a cleanup one.
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        ulog_info!("[task] created direct id={} name={}", id, t.name);

        // Broadcast so every open Task Center panel refreshes (CC review C5).
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::User.as_str(),
                "source": TransitionSource::Ui.as_str(),
                "message": "created (direct)",
                "event": "created",
            }),
        );
        Ok(t)
    }

    /// Create a Task at an explicit initial status, bypassing the default
    /// Todo entry point. Used ONLY by the legacy-cron upgrade path
    /// (`legacy_upgrade::upgrade_legacy_cron`) — migrations preserve the
    /// cron's lifecycle state (running crons → Running task, naturally
    /// ended crons → Done, user-paused crons → Stopped) so the Task
    /// Center doesn't spuriously mass-categorise every upgraded row as
    /// 待启动. The status-history entry records `actor=System,
    /// source=Migration` so the audit trail is clear.
    ///
    /// `initial_status` is validated against a whitelist of legitimate
    /// migration targets — the full state-machine alphabet isn't
    /// appropriate here (a migration can't plausibly land in Verifying
    /// or Blocked, and Deleted / Archived aren't reachable via this
    /// path).
    pub async fn create_migrated(
        &self,
        mut input: TaskCreateDirectInput,
        initial_status: TaskStatus,
        message: String,
    ) -> Result<Task, String> {
        validate_task_name(&input.name)?;
        // PRD 0.2.9 — Same pin+validate sequence as create_direct.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        validate_task_provider_routing(&input.provider_id, &input.model, &input.runtime)?;
        if !matches!(
            initial_status,
            TaskStatus::Todo | TaskStatus::Running | TaskStatus::Done | TaskStatus::Stopped
        ) {
            return Err(format!(
                "invalid migration target status: {}",
                initial_status.as_str()
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let workspace_path = canonicalize_workspace_path(&input.workspace_path)?;

        // task_docs_dir() internally validates `id`, but `id` is our freshly-minted
        // UUID so it cannot fail; the explicit check is still cheap insurance.
        let task_dir = task_docs_dir(&id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id: input.workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            cron_task_id: None,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: input.interval_minutes,
            cron_expression: input.cron_expression,
            cron_timezone: input.cron_timezone,
            dispatch_at: input.dispatch_at,
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: input.preselected_session_id,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            source_thought_id: input.source_thought_id,
            session_ids: Vec::new(),
            status: initial_status,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            status_history: vec![StatusTransition {
                from: None,
                to: initial_status,
                at: now,
                actor: TransitionActor::System,
                message: Some(message.clone()),
                source: Some(TransitionSource::Migration),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::Direct,
            deleted: false,
            deleted_at: None,
        };

        // Materialize task.md FIRST, commit JSONL LAST (same ordering invariant
        // as create_direct — see fix for C3). Orphan docs dir on JSONL failure is
        // harmless; orphan JSONL row without task.md is an integrity violation.
        let mut inner = self.inner.write().await;
        fs::create_dir_all(&task_dir)
            .map_err(|e| format!("Failed to create task doc dir: {}", e))?;
        let task_md = task_dir.join("task.md");
        write_atomic_text(&task_md, &input.task_md_content)
            .map_err(|e| format!("Failed to write task.md: {}", e))?;

        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            if let Err(cleanup_err) = fs::remove_dir_all(&task_dir) {
                ulog_warn!(
                    "[task] migrated jsonl write failed AND task_dir cleanup failed id={} path={} err={}",
                    id,
                    task_dir.display(),
                    cleanup_err
                );
            }
            return Err(e);
        }
        *inner = next;
        drop(inner);
        ulog_info!(
            "[task] created migrated id={} name={} status={}",
            id,
            t.name,
            initial_status.as_str()
        );

        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": initial_status.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::System.as_str(),
                "source": TransitionSource::Migration.as_str(),
                "message": message,
                "event": "created",
            }),
        );
        Ok(t)
    }

    pub async fn create_from_alignment(
        &self,
        mut input: TaskCreateFromAlignmentInput,
    ) -> Result<Task, String> {
        validate_task_name(&input.name)?;
        validate_safe_id(&input.alignment_session_id, "alignmentSessionId")?;
        // PRD 0.2.9 — Same pin+validate sequence as create_direct.
        pin_runtime_for_provider_id(&input.provider_id, &mut input.runtime);
        validate_task_provider_routing(&input.provider_id, &input.model, &input.runtime)?;
        // The AI-discussion path (想法 → /task-alignment → create-from-alignment)
        // does not surface schedule fields in its input contract, yet the
        // `executionMode` is passed through unchanged. If we accept recurring /
        // scheduled / loop here we persist a Task with `interval_minutes=None`,
        // `cron_expression=None`, `dispatch_at=None` — a subsequent `task run`
        // fails with "no resolvable schedule" and the user cannot fix it from
        // the CLI (no --cron flag on this subcommand). Gate at the boundary so
        // the error surfaces at creation time with actionable guidance.
        if !matches!(input.execution_mode, TaskExecutionMode::Once) {
            return Err(format!(
                "create-from-alignment only supports executionMode=once; \
                 to set a schedule, create the task and then `myagents task update <id> \
                 --cronExpression <expr>` or use `create-direct` (got {:?})",
                input.execution_mode
            ));
        }

        let src = task_docs_dir(&input.alignment_session_id)?;
        if !src.exists() {
            return Err(format!("alignment dir not found: {}", src.display()));
        }

        // Resolve workspace_id / workspace_path: explicit args win; if missing,
        // try to read `<alignment_dir>/metadata.json` (written at 「AI 讨论」
        // launch time). Falling back to the sidecar file means AI callers can
        // just pass `--name` — no need to re-type UUIDs already baked in at
        // session creation.
        // Distinguish "file missing" from "file corrupt":
        // - missing → fallback to explicit args (the documented happy path)
        // - corrupt → log and fall back, so post-mortem log search reveals
        //   the real cause instead of the misleading "workspaceId missing"
        //   error that would otherwise surface below.
        let meta_path = src.join("metadata.json");
        let metadata: Option<AlignmentSessionMetadata> = match fs::read_to_string(&meta_path) {
            Ok(s) => match serde_json::from_str::<AlignmentSessionMetadata>(&s) {
                Ok(m) => Some(m),
                Err(e) => {
                    ulog_warn!(
                        "[task] alignment metadata.json parse failed at {}: {} — falling back to explicit args",
                        meta_path.display(),
                        e,
                    );
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                ulog_warn!(
                    "[task] alignment metadata.json read failed at {}: {} — falling back to explicit args",
                    meta_path.display(),
                    e,
                );
                None
            }
        };

        let workspace_id = input
            .workspace_id
            .clone()
            .or_else(|| metadata.as_ref().map(|m| m.workspace_id.clone()))
            .ok_or_else(|| {
                "workspaceId missing — pass --workspaceId or ensure alignment metadata.json exists"
                    .to_string()
            })?;
        let raw_workspace_path = input
            .workspace_path
            .clone()
            .or_else(|| metadata.as_ref().map(|m| m.workspace_path.clone()))
            .ok_or_else(|| {
                "workspacePath missing — pass --workspacePath or ensure alignment metadata.json exists"
                    .to_string()
            })?;
        let workspace_path = canonicalize_workspace_path(&raw_workspace_path)?;
        let source_thought_id = input
            .source_thought_id
            .clone()
            .or_else(|| metadata.as_ref().and_then(|m| m.source_thought_id.clone()));

        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let dst = task_docs_dir(&id)?;

        let t = Task {
            id: id.clone(),
            name: input.name,
            executor: input.executor,
            description: input.description,
            workspace_id,
            workspace_path: workspace_path.clone(),
            execution_mode: input.execution_mode,
            cron_task_id: None,
            run_mode: input.run_mode,
            end_conditions: input.end_conditions,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            dispatch_at: None,
            // Per-task overrides — surface the CLI-provided values so the
            // execution path in Bun (`/cron/execute-sync` via T15 snapshot
            // resolution) actually picks them up. Prior to v0.1.69's
            // cross-review fixes these were hardcoded `None` which silently
            // dropped every `--model` / `--permissionMode` flag passed to
            // `task create-from-alignment`.
            model: input.model,
            provider_id: input.provider_id,
            permission_mode: input.permission_mode,
            preselected_session_id: None,
            runtime: input.runtime,
            runtime_config: input.runtime_config,
            mcp_enabled_servers: normalize_mcp_override(input.mcp_enabled_servers),
            source_thought_id,
            session_ids: Vec::new(),
            status: TaskStatus::Todo,
            tags: input.tags,
            created_at: now,
            updated_at: now,
            last_executed_at: None,
            status_history: vec![StatusTransition {
                from: None,
                to: TaskStatus::Todo,
                at: now,
                actor: TransitionActor::Agent,
                message: Some("created (ai-aligned)".to_string()),
                source: Some(TransitionSource::Cli),
            }],
            notification: input.notification,
            dispatch_origin: TaskDispatchOrigin::AiAligned,
            deleted: false,
            deleted_at: None,
        };

        // Transactional order (PRD design):
        // 1. Persist the row to jsonl FIRST. If this fails, the alignment dir is
        //    untouched — retry is safe.
        // 2. Move the alignment dir to `~/.myagents/tasks/<newId>/`. If this fails, we unwind
        //    the row from jsonl so the store stays consistent.
        // 3. Swap in-memory state only after both succeed.
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        next.insert(id.clone(), t.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;

        if let Err(e) = move_alignment_dir(&src, &dst) {
            // Roll back jsonl — remove the task row we just persisted.
            next.remove(&id);
            if let Err(persist_err) = Self::persist_locked(&self.jsonl_path, &next) {
                ulog_warn!(
                    "[task] create_from_alignment rollback failed: {} (original error: {})",
                    persist_err,
                    e
                );
            }
            return Err(format!("move alignment dir: {}", e));
        }

        *inner = next;
        drop(inner);
        ulog_info!("[task] created ai-aligned id={} name={}", id, t.name);

        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": t.id,
                "from": serde_json::Value::Null,
                "to": TaskStatus::Todo.as_str(),
                "at": t.created_at,
                "actor": TransitionActor::Agent.as_str(),
                "source": TransitionSource::Cli.as_str(),
                "message": "created (ai-aligned)",
                "event": "created",
            }),
        );
        Ok(t)
    }

    // ---- Read ----

    pub async fn get(&self, id: &str) -> Option<Task> {
        self.inner.read().await.get(id).cloned()
    }

    /// Check-and-write `~/.myagents/tasks/<id>/<filename>` atomically with respect to
    /// the running/verifying lock. The status check and the file write
    /// both happen under the same write lock so a concurrent
    /// `update_status(running)` can't slip in between and let us mutate
    /// a doc on an already-executing task. PRD §9.4.
    ///
    /// On success `updated_at` is bumped so listings re-sort.
    pub async fn write_doc(
        &self,
        id: &str,
        filename: &str,
        content: &str,
    ) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(
                TaskOpError::update_rejected_while_running(),
            ));
        }
        // Resolve path through the sandbox guard — rejects id escape.
        let dir = task_docs_dir(&existing.id)?;
        let path = dir.join(filename);

        // Persist the markdown file first. If this fails we haven't
        // touched the JSONL yet, so the store stays consistent.
        write_atomic_text(&path, content)?;

        // Bump `updated_at` and persist under the same lock.
        let mut updated = existing;
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated);
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(())
    }

    pub async fn list(&self, filter: TaskListFilter) -> Vec<Task> {
        let inner = self.inner.read().await;
        let mut out: Vec<Task> = inner.values().cloned().collect();

        if !filter.include_deleted.unwrap_or(false) {
            out.retain(|t| !t.deleted);
        }
        if let Some(ws) = filter.workspace_id.as_deref() {
            out.retain(|t| t.workspace_id == ws);
        }
        if let Some(status_filter) = filter.status.as_ref() {
            out.retain(|t| status_filter.matches(t.status));
        }
        if let Some(tag) = filter.tag.as_deref() {
            let needle = tag.to_lowercase();
            out.retain(|t| t.tags.iter().any(|x| x.to_lowercase() == needle));
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    // ---- Update fields ----

    pub async fn update(&self, input: TaskUpdateInput) -> Result<Task, String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }
        if matches!(existing.status, TaskStatus::Running | TaskStatus::Verifying) {
            return Err(String::from(
                TaskOpError::update_rejected_while_running(),
            ));
        }
        // PRD 0.2.9 invariant 3 — reject contradictory clear-vs-set inputs at
        // the input layer (rather than silently letting the merge order
        // decide). Surfaces client bugs instead of swallowing them.
        if input.clear_provider_override
            && input.provider_id.as_deref().is_some_and(|s| !s.is_empty())
        {
            return Err(
                "providerId 与 clearProviderOverride=true 冲突 — 调用方必须二选一".to_string(),
            );
        }
        let mut updated = existing.clone();
        if let Some(v) = input.name {
            validate_task_name(&v)?;
            updated.name = v;
        }
        if let Some(v) = input.executor {
            updated.executor = v;
        }
        if let Some(v) = input.description {
            updated.description = Some(v);
        }
        if let Some(v) = input.execution_mode {
            updated.execution_mode = v;
        }
        if let Some(v) = input.run_mode {
            updated.run_mode = Some(v);
        }
        if let Some(v) = input.end_conditions {
            updated.end_conditions = Some(v);
        }
        if let Some(v) = input.interval_minutes {
            updated.interval_minutes = Some(v);
        }
        if let Some(v) = input.cron_expression {
            // Empty string clears — the renderer uses "" to mean "switch back
            // from advanced mode".
            updated.cron_expression = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.cron_timezone {
            updated.cron_timezone = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.dispatch_at {
            updated.dispatch_at = Some(v);
        }
        if let Some(v) = input.model {
            updated.model = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.provider_id {
            updated.provider_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        // PRD 0.2.9 — Explicit "follow Agent" reset: clears both provider_id
        // and model atomically. Renderer's "跟随 Agent" picker option sends
        // this flag rather than relying on an empty-string round-trip,
        // which would only clear one field if the renderer accidentally
        // omitted the other.
        if input.clear_provider_override {
            updated.provider_id = None;
            updated.model = None;
        }
        if let Some(v) = input.permission_mode {
            updated.permission_mode = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.preselected_session_id {
            updated.preselected_session_id = if v.trim().is_empty() { None } else { Some(v) };
        }
        if let Some(v) = input.runtime {
            updated.runtime = Some(v);
        }
        if let Some(v) = input.runtime_config {
            updated.runtime_config = Some(v);
        }
        // PRD #131 / Codex-review #2 — atomic clear of runtime + runtime_config.
        // Applied AFTER the merge so explicit field values get overridden
        // (matches `clear_provider_override` semantics, line above).
        if input.clear_runtime_override {
            updated.runtime = None;
            updated.runtime_config = None;
        }
        if let Some(v) = input.mcp_enabled_servers {
            // Two-state semantics (PRD 0.2.4 §需求 4 — "先简单点"):
            //   None / Some([])  → "follow Agent" (no override)
            //   Some([a, b, …])  → snapshot the chosen servers onto the task
            // Goes through the shared `normalize_mcp_override` helper so
            // create / update / legacy paths all enforce the same shape.
            updated.mcp_enabled_servers = normalize_mcp_override(Some(v));
        }
        if let Some(v) = input.tags {
            updated.tags = v;
        }
        if let Some(v) = input.notification {
            updated.notification = Some(v);
        }
        // PRD 0.2.9 — Pin runtime='builtin' on the merged state when the
        // post-merge shape has provider_id set without an explicit runtime.
        // Mirrors the pin done in create_direct; closes the cross-talk hole.
        pin_runtime_for_provider_id(&updated.provider_id, &mut updated.runtime);
        // Provider routing invariants on merged state. Runs after pin so the
        // external-exclusion rule fires correctly, and after all field merges
        // (including clear_provider_override) so the rules see the actual
        // post-update shape, not the input fragments.
        validate_task_provider_routing(&updated.provider_id, &updated.model, &updated.runtime)?;
        updated.updated_at = now_ms();

        // Mode-transition hygiene: `run_mode` / `end_conditions` / the
        // schedule-detail fields are only meaningful for certain execution
        // modes. When the user flips `execution_mode → Once`, lingering
        // recurring/scheduled fields would pollute `ensure_cron_for_task`.
        // `TaskUpdateInput` uses `Option<T>` so the client can't express
        // "clear me", so we clear server-side the moment the mode no longer
        // needs them.
        match updated.execution_mode {
            TaskExecutionMode::Once => {
                updated.run_mode = None;
                updated.end_conditions = None;
                updated.interval_minutes = None;
                updated.cron_expression = None;
                updated.cron_timezone = None;
                updated.dispatch_at = None;
            }
            TaskExecutionMode::Scheduled => {
                // Scheduled only needs dispatch_at; clear recurring knobs.
                // Also strip any legacy `endConditions.deadline` that a
                // pre-v0.1.69 row might be carrying — once dispatch_at is
                // populated (either by the user editing or by the
                // legacy-upgrade path), the deadline has no remaining
                // meaning here and only confuses later readers that still
                // treat `endConditions.deadline` as "when to stop running".
                updated.interval_minutes = None;
                updated.cron_expression = None;
                updated.cron_timezone = None;
                if let Some(ref mut ec) = updated.end_conditions {
                    ec.deadline = None;
                }
            }
            TaskExecutionMode::Recurring | TaskExecutionMode::Loop => {
                // dispatch_at belongs to Scheduled only.
                updated.dispatch_at = None;
            }
        }

        // Validate cron_expression at the boundary so malformed input can't
        // reach the scheduler (it would silently die at first fire, leaving
        // the task "running" but never ticking).
        if let Some(expr) = updated.cron_expression.as_deref() {
            if !expr.trim().is_empty() {
                crate::cron_task::validate_cron_expression(
                    expr,
                    updated.cron_timezone.as_deref(),
                )
                .map_err(|e| format!("cron expression invalid: {}", e))?;
            }
        }

        // Atomic task.md write — when the client sent `prompt`, we want the
        // new markdown body committed under the same write lock that
        // persists the JSONL row. Status was already verified above, so a
        // concurrent `update_status(running)` can't land between these two
        // writes.
        if let Some(ref prompt) = input.prompt {
            if prompt.trim().is_empty() {
                return Err("prompt is empty".to_string());
            }
            if matches!(updated.dispatch_origin, TaskDispatchOrigin::AiAligned) {
                return Err(
                    "ai-aligned tasks use /task-implement; edit alignment.md instead"
                        .to_string(),
                );
            }
            let dir = task_docs_dir(&updated.id)?;
            fs::create_dir_all(&dir)
                .map_err(|e| format!("mkdir task dir: {}", e))?;
            write_atomic_text(&dir.join("task.md"), prompt)?;
        }

        // Detect what the caller actually changed so we can decide how to
        // propagate to the linked CronTask (PRD §11.2):
        //   * "kind" change (execution_mode) → detach + rebuild next run
        //   * field-only change (interval / cron / model / permission /
        //     end_conditions / run_mode / notification) → project via
        //     `update_task_fields` so `executionCount` and `cron_runs/*.jsonl`
        //     history are preserved.
        let kind_changed = existing.execution_mode != updated.execution_mode;
        let schedule_detail_changed = existing.run_mode != updated.run_mode
            || existing.end_conditions != updated.end_conditions
            || existing.interval_minutes != updated.interval_minutes
            || existing.cron_expression != updated.cron_expression
            || existing.cron_timezone != updated.cron_timezone
            || existing.dispatch_at != updated.dispatch_at;
        let exec_overrides_changed = existing.model != updated.model
            || existing.provider_id != updated.provider_id
            || existing.permission_mode != updated.permission_mode
            || existing.mcp_enabled_servers != updated.mcp_enabled_servers
            // PRD #131 / Codex-review #1 — runtime + runtime_config edits
            // also need to project to the linked CronTask. Without these in
            // the change-detection set, switching a recurring task from
            // builtin to Codex (or changing runtimeConfig.model) updated
            // the Task row but the CronTask kept executing with the stale
            // runtime forever.
            || existing.runtime != updated.runtime
            || existing.runtime_config != updated.runtime_config;
        let notification_changed = existing.notification != updated.notification;
        let name_or_prompt_changed = existing.name != updated.name || input.prompt.is_some();

        let invalidated_cron_id = if kind_changed {
            let taken = updated.cron_task_id.take();
            if taken.is_some() {
                ulog_info!(
                    "[task] execution-mode changed for {} → detaching CronTask {:?}",
                    updated.id,
                    taken
                );
            }
            taken
        } else {
            None
        };

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);

        // Best-effort CronTask cleanup — the orphaned CronTask (if any) is
        // removed from the scheduler AFTER persist so a crash between the two
        // steps is safe: on reboot the Task shows no back-pointer and the
        // scheduler will simply stop firing the orphaned CronTask once its
        // endConditions trigger (or user removes it from the cron panel).
        if let Some(cron_id) = invalidated_cron_id {
            let manager = crate::cron_task::get_cron_task_manager();
            if let Err(e) = manager.delete_task(&cron_id).await {
                ulog_warn!(
                    "[task] failed to delete orphaned CronTask {}: {}",
                    cron_id,
                    e
                );
            }
        } else if let Some(cron_id) = updated.cron_task_id.clone() {
            // Project the surviving CronTask — preserve executionCount /
            // lastExecutedAt / linked Session. Only forward fields that
            // actually changed so we don't stomp unrelated CronTask knobs.
            if schedule_detail_changed
                || exec_overrides_changed
                || notification_changed
                || name_or_prompt_changed
            {
                let mut patch = serde_json::Map::new();
                if existing.name != updated.name {
                    patch.insert(
                        "name".to_string(),
                        serde_json::Value::String(updated.name.clone()),
                    );
                }
                if let Some(ref prompt_body) = input.prompt {
                    // Mirror the task.md body into the CronTask for legacy
                    // read paths (IM delivery, cron prompt fallback). Use the
                    // in-memory value we just wrote — re-reading from disk
                    // would be both redundant and silently hide transient
                    // I/O failures mid-update.
                    patch.insert(
                        "prompt".to_string(),
                        serde_json::Value::String(prompt_body.clone()),
                    );
                }
                if schedule_detail_changed {
                    // Only project when we can resolve a concrete schedule.
                    // Scheduled with no dispatch_at → None; skip the projection
                    // so we don't corrupt the CronTask with a stale schedule
                    // (the user will get a "需要执行时间" error at next run).
                    if let Some(schedule) = crate::management_api::schedule_from_task(&updated) {
                        patch.insert(
                            "schedule".to_string(),
                            serde_json::to_value(&schedule).unwrap_or(serde_json::Value::Null),
                        );
                    }
                    if let Some(ec) = updated.end_conditions.clone() {
                        let cron_ec: crate::cron_task::EndConditions = ec.into();
                        patch.insert(
                            "endConditions".to_string(),
                            serde_json::to_value(&cron_ec)
                                .unwrap_or(serde_json::Value::Null),
                        );
                    }
                }
                if existing.model != updated.model {
                    patch.insert(
                        "model".to_string(),
                        updated
                            .model
                            .clone()
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null),
                    );
                }
                if existing.provider_id != updated.provider_id {
                    // PRD 0.2.9 — Project the per-task provider id into the
                    // linked CronTask so the next dispatch tick uses the
                    // up-to-date provider. `null` clears (= follow Agent),
                    // a string sets it. Sidecar live-resolves env from this
                    // provider id at every tick — no env snapshot lands here.
                    patch.insert(
                        "providerId".to_string(),
                        updated
                            .provider_id
                            .clone()
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null),
                    );
                }
                if existing.permission_mode != updated.permission_mode {
                    // PRD 0.2.4 §需求 4 (4b): unset = runtime maximum
                    // permission, NOT "auto". Unattended task dispatch
                    // would otherwise block on the first tool call.
                    // For the SDK builtin runtime the legacy fallback
                    // "auto" was wrong; we now project to the explicit
                    // bypass-permissions sentinel which the cron exec
                    // path translates into the right runtime-specific
                    // value. (See `/cron/execute-sync` permission
                    // resolution in `src/server/index.ts`.)
                    patch.insert(
                        "permissionMode".to_string(),
                        serde_json::Value::String(
                            updated
                                .permission_mode
                                .clone()
                                .unwrap_or_else(|| "fullAgency".to_string()),
                        ),
                    );
                }
                if existing.mcp_enabled_servers != updated.mcp_enabled_servers {
                    // PRD 0.2.4 §需求 4 — push MCP override to the linked
                    // CronTask so the next dispatch tick carries it forward.
                    // null clears (= follow workspace), an array sets it.
                    patch.insert(
                        "mcpEnabledServers".to_string(),
                        match updated.mcp_enabled_servers.as_ref() {
                            Some(list) => serde_json::Value::Array(
                                list.iter()
                                    .map(|s| serde_json::Value::String(s.clone()))
                                    .collect(),
                            ),
                            None => serde_json::Value::Null,
                        },
                    );
                }
                // PRD #131 / Codex-review #1 — same projection contract for
                // `runtime` / `runtimeConfig`. null clears (= follow Agent),
                // a value sets it. Without these, switching the runtime in
                // a recurring task's editor left the linked CronTask with
                // the original runtime forever.
                if existing.runtime != updated.runtime {
                    patch.insert(
                        "runtime".to_string(),
                        updated
                            .runtime
                            .clone()
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null),
                    );
                }
                if existing.runtime_config != updated.runtime_config {
                    patch.insert(
                        "runtimeConfig".to_string(),
                        updated
                            .runtime_config
                            .clone()
                            .unwrap_or(serde_json::Value::Null),
                    );
                }
                if notification_changed {
                    let enabled = updated
                        .notification
                        .as_ref()
                        .map(|n| n.desktop)
                        .unwrap_or(true);
                    patch.insert(
                        "notifyEnabled".to_string(),
                        serde_json::Value::Bool(enabled),
                    );

                    // IM delivery routing — mirror Task.notification
                    // .botChannelId into CronTask.delivery so the
                    // scheduler tick reaches the right bot. Kept in
                    // lockstep with `ensure_cron_for_task` above; when
                    // the bot channel is cleared, we explicitly push
                    // `"clearDelivery": true` so `update_task_fields`
                    // tears down the stale delivery instead of keeping
                    // the old routing around.
                    let bot_channel_id = updated
                        .notification
                        .as_ref()
                        .and_then(|n| n.bot_channel_id.as_deref())
                        .filter(|s| !s.is_empty());
                    if let Some(bot_id) = bot_channel_id {
                        let chat_id = updated
                            .notification
                            .as_ref()
                            .and_then(|n| n.bot_thread.as_deref())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("_auto_")
                            .to_string();
                        patch.insert(
                            "delivery".to_string(),
                            serde_json::json!({
                                "botId": bot_id,
                                "chatId": chat_id,
                                "platform": "task-center",
                            }),
                        );
                    } else {
                        patch.insert(
                            "clearDelivery".to_string(),
                            serde_json::Value::Bool(true),
                        );
                    }
                }

                if !patch.is_empty() {
                    let manager = crate::cron_task::get_cron_task_manager();
                    if let Err(e) = manager
                        .update_task_fields(&cron_id, serde_json::Value::Object(patch))
                        .await
                    {
                        ulog_warn!(
                            "[task] CronTask {} projection failed: {}",
                            cron_id,
                            e
                        );
                    }
                }
            }
        }

        Ok(updated)
    }

    // ---- Status transition ----

    /// Apply a status transition with PRD §10.2.1 core semantics:
    ///   1. transition-table legality
    ///   2. actor/source guards (archived user-only, agent→cli only,
    ///      `Deleted` never accepted here — only `delete()` may write it)
    ///   3. persist-then-swap atomic history append
    ///
    /// `actor` is explicit (not inferred): callers MUST assert their actor. The
    /// Tauri command layer sets `actor=User, source=Ui` authoritatively so a
    /// malicious renderer cannot spoof `agent` / `system`.
    ///
    /// Returns `(updated_task, transition_written)`. Progress.md / notification /
    /// SSE side-effects are caller responsibility (Phase 4/5 wiring).
    pub async fn update_status(
        &self,
        input: TaskUpdateStatusInput,
    ) -> Result<(Task, StatusTransition), String> {
        // `Deleted` is reserved for `delete()`.
        if input.status == TaskStatus::Deleted {
            return Err(String::from(TaskOpError::invalid_transition(
                TaskStatus::Deleted,
                TaskStatus::Deleted,
            )));
        }

        let mut inner = self.inner.write().await;
        let existing = inner
            .get(&input.id)
            .ok_or_else(|| String::from(TaskOpError::not_found(&input.id)))?
            .clone();
        if existing.deleted {
            return Err(String::from(TaskOpError::already_deleted()));
        }

        let from = existing.status;
        let to = input.status;

        // 1. legality
        if !is_transition_legal(from, to) {
            return Err(String::from(TaskOpError::invalid_transition(from, to)));
        }

        // 2. actor/source guard
        let actor = input.actor;
        let source = input.source;
        if to == TaskStatus::Archived && actor != TransitionActor::User {
            return Err(String::from(TaskOpError::archive_user_only()));
        }
        if actor == TransitionActor::Agent && source != Some(TransitionSource::Cli) {
            return Err(String::from(TaskOpError::agent_source_must_be_cli()));
        }

        let now = now_ms();
        let mut updated = existing;
        updated.status = to;
        updated.updated_at = now;
        if to == TaskStatus::Running {
            updated.last_executed_at = Some(now);
        }

        let transition = StatusTransition {
            from: Some(from),
            to,
            at: now,
            actor,
            message: input.message,
            source,
        };
        updated.status_history.push(transition.clone());

        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        // Drop the write lock before firing side-effects so listeners that
        // refetch via `get()` don't contend with us.
        drop(inner);

        ulog_info!(
            "[task] status {}: {} → {} (actor={}, source={:?})",
            updated.id,
            from.as_str(),
            to.as_str(),
            actor.as_str(),
            source.map(|s| s.as_str())
        );

        // CC review C3 — when the Task reaches a terminal/idle state while a
        // linked CronTask is still scheduled, stop the CronTask so its next
        // tick doesn't re-dispatch a stopped/blocked task. Fires for:
        //   - stopped / blocked / archived (user / agent / system decided to halt)
        //   - done when NOT a recurring/loop that's still within endConditions
        //     (conservative: if the Task says done, user considers it finished
        //     → stop the scheduler, they can `rerun` to re-arm)
        if matches!(
            to,
            TaskStatus::Stopped | TaskStatus::Blocked | TaskStatus::Archived | TaskStatus::Done
        ) {
            if let Some(cron_id) = updated.cron_task_id.clone() {
                let manager = crate::cron_task::get_cron_task_manager();
                let _ = manager
                    .stop_task(&cron_id, Some(format!("task → {}", to.as_str())))
                    .await;
            }
        }

        // NB: progress.md is intentionally NOT touched here. It's the
        // AI's own workspace document — `/task-alignment` creates it
        // with a structured template and `/task-implement` updates it
        // via standard Read / Edit / Write tools. The program code only
        // writes `status_history` (authoritative audit log, above). The
        // UI's "执行日志" panel reads progress.md directly from disk.
        // (v0.1.69+: previously `append_progress_line` polluted the AI's
        // doc with machine-format lines — removed.)

        // PRD §10.2.1 step 6: notification dispatch (desktop + bot) for
        // subscribed transitions. Side-effects fire AFTER persist so a
        // crash between write and notify is recoverable from disk state.
        dispatch_notification(&updated, &transition);

        // PRD §10.2.1 step 7: SSE broadcast. Renderer listens on
        // `task:status-changed` for live refresh across all open Task Center
        // tabs.
        emit_task_event(
            "task:status-changed",
            serde_json::json!({
                "taskId": updated.id,
                "from": transition.from.map(|s| s.as_str()),
                "to": transition.to.as_str(),
                "at": transition.at,
                "actor": transition.actor.as_str(),
                "source": transition.source.map(|s| s.as_str()),
                "message": transition.message.clone(),
            }),
        );

        Ok((updated, transition))
    }

    // ---- Convenience: append session / update progress / cron link ----

    /// Post-boot safety net (PRD §9.3.3): heal recurring/scheduled tasks whose
    /// schedule fields were lost but whose linked CronTask still carries the
    /// authoritative schedule. Triggered from `initialize_cron_manager` after
    /// both stores are loaded.
    ///
    /// We only fill missing fields — never overwrite an existing value. Once /
    /// Loop tasks have nothing to heal (no user-visible schedule detail).
    ///
    /// Returns the list of task IDs that were healed, for logging.
    pub async fn heal_missing_schedule_fields(
        &self,
        lookup: impl Fn(&str) -> Option<ScheduleBackfill>,
    ) -> Vec<String> {
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        let mut healed: Vec<String> = Vec::new();
        let now = now_ms();
        for (id, task) in inner.iter() {
            if task.deleted {
                continue;
            }
            let needs_heal = match task.execution_mode {
                TaskExecutionMode::Recurring => {
                    task.cron_expression.is_none() && task.interval_minutes.is_none()
                }
                TaskExecutionMode::Scheduled => task.dispatch_at.is_none(),
                TaskExecutionMode::Once | TaskExecutionMode::Loop => false,
            };
            if !needs_heal {
                continue;
            }
            let Some(cron_id) = task.cron_task_id.as_deref() else {
                continue;
            };
            let Some(backfill) = lookup(cron_id) else {
                continue;
            };
            let mut updated = task.clone();
            match (&task.execution_mode, backfill) {
                (TaskExecutionMode::Recurring, ScheduleBackfill::IntervalMinutes(m)) => {
                    updated.interval_minutes = Some(m);
                }
                (
                    TaskExecutionMode::Recurring,
                    ScheduleBackfill::Cron { expression, timezone },
                ) => {
                    updated.cron_expression = Some(expression);
                    updated.cron_timezone = timezone;
                }
                (TaskExecutionMode::Scheduled, ScheduleBackfill::DispatchAt(ts)) => {
                    updated.dispatch_at = Some(ts);
                }
                // Mode / backfill mismatch (e.g. linked CronTask is Loop but
                // Task says Recurring) — skip silently; a later user edit
                // will reconcile.
                _ => continue,
            }
            updated.updated_at = now;
            next.insert(id.clone(), updated);
            healed.push(id.clone());
        }
        if healed.is_empty() {
            return healed;
        }
        if let Err(e) = Self::persist_locked(&self.jsonl_path, &next) {
            ulog_warn!("[task] heal persist failed: {}", e);
            return Vec::new();
        }
        *inner = next;
        healed
    }

    pub async fn append_session(&self, id: &str, session_id: &str) -> Result<Task, String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        let mut changed = false;
        if !updated.session_ids.iter().any(|s| s == session_id) {
            updated.session_ids.push(session_id.to_string());
            updated.updated_at = now_ms();
            let mut next = inner.clone();
            next.insert(updated.id.clone(), updated.clone());
            Self::persist_locked(&self.jsonl_path, &next)?;
            *inner = next;
            changed = true;
        }
        // Drop the write lock before emitting — listeners may call back
        // into TaskStore (e.g. overlay refetch) and we don't want a
        // re-entrant deadlock.
        drop(inner);
        if changed {
            // Surfaces newly-linked sessions to TaskDetailOverlay while it's
            // already open. Without this the "任务执行" section under-reports
            // until the user closes and reopens the overlay (review HIGH
            // finding: a pre-existing silent mutation that became visible
            // after promoting TaskSessionsList to the second block).
            emit_task_event(
                "task:session-appended",
                serde_json::json!({
                    "taskId": updated.id,
                    "sessionId": session_id,
                }),
            );
        }
        Ok(updated)
    }


    pub async fn set_cron_task_id(
        &self,
        id: &str,
        cron_id: Option<String>,
    ) -> Result<Task, String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        let mut updated = existing;
        updated.cron_task_id = cron_id;
        updated.updated_at = now_ms();
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated.clone());
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        Ok(updated)
    }

    // ---- Archive / Delete ----

    /// User-only archive entry. Emits `Done → Archived` with actor=user.
    /// `update_status` already tears down the linked CronTask on terminal
    /// states (CC review C3), so archived recurring/loop tasks won't keep
    /// firing after archival.
    pub async fn archive(&self, id: &str, message: Option<String>) -> Result<Task, String> {
        let (task, _) = self
            .update_status(TaskUpdateStatusInput {
                id: id.to_string(),
                status: TaskStatus::Archived,
                message,
                actor: TransitionActor::User,
                source: Some(TransitionSource::Ui),
            })
            .await?;
        Ok(task)
    }

    /// Soft-delete. Writes a proper synthetic `→ Deleted` pseudo-transition to
    /// `statusHistory` (PRD §10.2.2), sets `status=Deleted`, flips the
    /// `deleted` flag, and **tears down the linked CronTask** so the scheduler
    /// stops firing against a ghost Task (CC review C1). Downstream auditors
    /// can filter `statusHistory` on `to == Deleted` to find all removed tasks.
    /// Physical cleanup happens out-of-band (§9.5, 30-day retention).
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        let existing = inner
            .get(id)
            .ok_or_else(|| String::from(TaskOpError::not_found(id)))?
            .clone();
        if existing.deleted {
            return Ok(());
        }
        let mut updated = existing;
        let now = now_ms();
        let from = updated.status;
        updated.status_history.push(StatusTransition {
            from: Some(from),
            to: TaskStatus::Deleted,
            at: now,
            actor: TransitionActor::User,
            message: Some("deleted".to_string()),
            source: Some(TransitionSource::Ui),
        });
        updated.status = TaskStatus::Deleted;
        updated.deleted = true;
        updated.deleted_at = Some(now);
        updated.updated_at = now;
        updated.cron_task_id = None;
        let mut next = inner.clone();
        next.insert(updated.id.clone(), updated);
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);

        // Tear down any scheduler entries linked to this task so a recurring /
        // loop task soft-deleted by the user doesn't keep burning tokens.
        let manager = crate::cron_task::get_cron_task_manager();
        if let Ok(n) = manager.delete_by_task_id(id).await {
            if n > 0 {
                ulog_info!("[task] soft-deleted id={} + removed {} linked CronTask(s)", id, n);
                return Ok(());
            }
        }
        ulog_info!("[task] soft-deleted id={}", id);
        Ok(())
    }
}

// ================ Helpers ================

/// Normalise the per-task `mcp_enabled_servers` override at storage time
/// (PRD 0.2.4 §需求 4 — two-state semantics).
///
///   `None`      → "follow Agent"      (no override stored)
///   `Some([])`  → "follow Agent"      (collapsed: empty intent ≡ no override)
///   `Some([…])` → "explicit override" (snapshot the chosen server ids)
///
/// Applied at every storage boundary (create_direct, create_from_alignment,
/// legacy_upgrade, update) so direct API/CLI callers can never produce a
/// `Some(vec![])` row that the rest of the code would have to special-case.
fn normalize_mcp_override(input: Option<Vec<String>>) -> Option<Vec<String>> {
    match input {
        None => None,
        Some(v) if v.is_empty() => None,
        Some(v) => Some(v),
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Strict id validator — rejects `..`, path separators, `\0`, leading `.`, and
/// anything not ASCII alphanumeric / `-` / `_`. Also rejects Windows reserved
/// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) case-insensitively —
/// creating a file/dir with these names on Windows triggers OS-level errors
/// regardless of extension. This is the pit-of-success guard against
/// `taskId="../../etc/passwd"` and similar injections (CC + Codex review).
pub fn validate_safe_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{} is empty or too long", label));
    }
    if value.starts_with('.') {
        return Err(format!("{} may not start with '.'", label));
    }
    for ch in value.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if !ok {
            return Err(format!("{} contains invalid character {:?}", label, ch));
        }
    }
    let upper = value.to_ascii_uppercase();
    const WINDOWS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if WINDOWS_RESERVED.iter().any(|r| upper == *r) {
        return Err(format!(
            "{} matches a Windows reserved device name ({})",
            label, upper
        ));
    }
    Ok(())
}

/// Clean + validate a caller-supplied workspace path. Requires non-empty absolute
/// path. Does NOT perform `.canonicalize()` (that would require the path to exist
/// at call time — tasks may reference workspaces that have been moved).
fn canonicalize_workspace_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("workspacePath is empty".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err(format!("workspacePath must be absolute: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn validate_task_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("task name is empty".to_string());
    }
    // PRD §3.2 says "短，<60 字符" — enforce char count (not bytes).
    if trimmed.chars().count() > 120 {
        return Err("task name exceeds 120 chars".to_string());
    }
    Ok(())
}

/// PRD 0.2.9 — Validate the per-task provider routing invariants.
///
/// Three invariants enforced uniformly across all Task / CronTask write
/// paths (`create_direct`, `create_from_alignment`, `update`,
/// `create_migrated`, plus `CronTaskManager::create_task`):
///
///   1. **Pairing**: `provider_id.is_some()` ⇒ `model.is_some()`. Picking
///      a provider without a model silently routes the chosen provider's
///      API to the agent's default model — exactly the cross-provider
///      misroute that #130 surfaced.
///
///   2. **External-runtime exclusion**: external runtimes (claude-code /
///      codex / gemini) MUST NOT carry a builtin `provider_id`; they
///      self-manage providers via their own CLI. A task with
///      `runtime='codex' + provider_id='openai-...'` would either fail
///      validation or, worse, get a model id that codex doesn't recognise.
///
///      `runtime: None` is treated as "force builtin" when `provider_id`
///      is set — see invariant 3 below. This closes the codex-review
///      finding "Agent runtime later switched to Codex/Gemini → task
///      survives with `providerId+model` and silently ignores them at
///      execute time" (Codex P1 #5 against PRD 0.2.9): with `provider_id`
///      set, the only valid runtime is `'builtin'` or `None` AND we
///      additionally pin runtime='builtin' on save (see callers).
///
///   3. **No contradictory clear**: `clear_provider_override == true`
///      together with `provider_id == Some(_)` is rejected at the input
///      layer. The Rust merge order (apply provider_id, then clear)
///      makes "clear win", but accepting the contradictory shape silently
///      hides client bugs. Callers must send one or the other.
///
/// `provider_id`-aware runtime materialization (the matching pin) lives at
/// the call sites — see `create_direct` / `update`.
fn validate_task_provider_routing(
    provider_id: &Option<String>,
    model: &Option<String>,
    runtime: &Option<String>,
) -> Result<(), String> {
    if provider_id.is_some() && model.is_none() {
        return Err(
            "providerId 必须与 model 配对设置 — 选了 provider 后请同时选择该 provider 下的具体 model"
                .to_string(),
        );
    }
    if let Some(rt) = runtime.as_deref() {
        let is_external = matches!(rt, "claude-code" | "codex" | "gemini");
        if is_external && provider_id.is_some() {
            return Err(format!(
                "外部 runtime '{}' 自管 provider — 不允许同时指定 providerId（请在该 runtime 自身的设置中切换 provider）",
                rt
            ));
        }
    }
    Ok(())
}

/// PRD 0.2.9 — Materialize `runtime: Some("builtin")` whenever a
/// `provider_id` is set with `runtime: None`. This closes the cross-talk
/// hole flagged by Codex review (P1 #5):
///
///     - User saves task with `runtime: None, provider_id: 'openai-...'`
///       (relying on Agent runtime = builtin).
///     - Later: user changes Agent runtime to codex.
///     - Without pinning, the task survives validation but its provider
///       fields are silently ignored at execute time (codex branch reads
///       only runtimeConfig.model).
///     - Pinning `runtime: 'builtin'` makes the task fail validation at
///       next save (provider_id + external runtime is invariant 2),
///       AND keeps execution honoring the chosen provider regardless of
///       Agent's later runtime switch — providerId IS the user's pinned
///       intent for THIS task.
///
/// Idempotent: if `runtime` is already `Some(_)`, do nothing. Validator
/// runs after this materialization, so any non-None+external case still
/// surfaces as a "外部 runtime 不允许 providerId" error.
fn pin_runtime_for_provider_id(provider_id: &Option<String>, runtime: &mut Option<String>) {
    if provider_id.is_some() && runtime.is_none() {
        *runtime = Some("builtin".to_string());
    }
}

/// Resolve `~/.myagents/tasks/<id>/` and verify the resolved path stays inside
/// `~/.myagents/tasks/`. This is the pit-of-success guard — centralizing path
/// join + boundary check here means no caller can accidentally escape the
/// sandbox via a bad id.
///
/// v0.1.69 relocation: task docs used to live under `<workspace>/.task/<id>/`,
/// keyed by the absolute workspace path. That coupled application data
/// (markdown describing how the task runs) to project content (which could
/// be moved, renamed, deleted, or tracked in git by accident). Tasks are
/// now a first-class user-scoped artifact, alongside `thoughts/`,
/// `sessions/`, and `cron_runs/` — the workspace remains the *execution
/// context* (Sidecar cwd, AI bash tool base) but no longer the storage.
pub fn task_docs_dir(task_id: &str) -> Result<PathBuf, String> {
    validate_safe_id(task_id, "taskId")?;
    let base = task_docs_root()?;
    let resolved = base.join(task_id);
    // Defense in depth: after the `validate_safe_id` check above, any resolved
    // path must still lexically start with `~/.myagents/tasks/`. This catches
    // future bypasses if the validator is weakened.
    if !resolved.starts_with(&base) {
        return Err(format!(
            "task_docs_dir escaped base: {} (base={})",
            resolved.display(),
            base.display()
        ));
    }
    Ok(resolved)
}

/// Root dir for all task documents — `~/.myagents/tasks/`.
///
/// Honors `MYAGENTS_TASK_DOCS_ROOT` **only in debug / test builds** so tests
/// (and the one-off migration script) can redirect to a tempdir without
/// touching the real user profile. Production builds ignore the env var to
/// shut down the "user's shell rc or a rogue child-process env accidentally
/// redirects application data" risk. The env var MUST be an absolute path;
/// relative values are rejected so a stray `./tasks` in CI doesn't pollute
/// the cwd.
fn task_docs_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(override_path) = std::env::var("MYAGENTS_TASK_DOCS_ROOT") {
            let p = PathBuf::from(&override_path);
            if !p.is_absolute() {
                return Err(format!(
                    "MYAGENTS_TASK_DOCS_ROOT must be absolute, got {}",
                    override_path
                ));
            }
            return Ok(p);
        }
    }
    // Route through `app_dirs::myagents_data_dir()` so future dev/prod data
    // isolation (see `app_dirs.rs` doc — e.g. `~/.myagents-dev/` for debug
    // builds) picks up this path automatically. Don't hardcode home dir.
    crate::app_dirs::myagents_data_dir()
        .map(|d| d.join("tasks"))
        .ok_or_else(|| "cannot resolve myagents data dir for task docs".to_string())
}

/// Crash-durable atomic text write: tmp write → sync_all → rename → cleanup
/// on any failure. Mirrors `persist_locked` guarantees for arbitrary files.
fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    let write_res = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("open tmp: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        file.flush().map_err(|e| format!("flush tmp: {}", e))?;
        file.sync_all().map_err(|e| format!("sync tmp: {}", e))?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename: {}", e));
    }
    Ok(())
}

/// Move `src` directory to `dst`. Tries `fs::rename` first (fast path, atomic on
/// the same filesystem). On cross-filesystem or other error, falls back to
/// `copy_dir_recursive` + `remove_dir_all(src)`. Symlinks and unusual file types
/// return `Err` — task docs must be plain files/dirs only.
fn move_alignment_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| format!("mkdir dst: {}", e))?;
    copy_dir_recursive(src, dst).map_err(|e| format!("copy: {}", e))?;
    fs::remove_dir_all(src).map_err(|e| format!("remove src: {}", e))?;
    Ok(())
}

/// PRD §11 bridge — when the CronTask scheduler concludes a Task-linked cron
/// (endConditions / AI exit / one-shot completion), transition the linked
/// Task to `done` with the right actor/source. Called from cron_task.rs
/// completion paths. Safe to invoke even when no Task is linked (no-op).
///
/// Error paths (watchdog / SDK crash) are handled separately; this helper only
/// runs for the "good exit" flow.
pub async fn mark_cron_completion_if_linked(cron_task_id: &str, exit_reason: Option<&str>) {
    // Look up the CronTask → find its Task back-pointer.
    let ta_id = {
        let manager = crate::cron_task::get_cron_task_manager();
        let Some(ct) = manager.get_task(cron_task_id).await else {
            return;
        };
        let Some(ta_id) = ct.task_id.clone() else {
            return;
        };
        ta_id
    };

    let Some(store) = get_task_store() else {
        return;
    };
    let Some(task) = store.get(&ta_id).await else {
        return;
    };

    // Only fire for tasks still in "active" states — don't re-transition a
    // task the user already marked done/blocked/stopped via the UI.
    if !matches!(task.status, TaskStatus::Running | TaskStatus::Verifying) {
        return;
    }

    // Classify the exit reason (PRD §9.1 + §12.2 caller-inference):
    //   - `None` or "completed" / "executions" / "deadline" → endCondition → done
    //   - explicit string from ExitCronTask tool (AI) → agent/cli → done
    let (message, actor, source) = match exit_reason {
        None => (
            "cron endCondition fired".to_string(),
            TransitionActor::System,
            TransitionSource::EndCondition,
        ),
        Some(reason) => {
            let low = reason.to_lowercase();
            if low.contains("one-shot")
                || low.contains("max executions")
                || low.contains("deadline")
                || low.contains("endcondition")
            {
                (
                    reason.to_string(),
                    TransitionActor::System,
                    TransitionSource::EndCondition,
                )
            } else {
                // AI-requested exit via ExitCronTask tool.
                (
                    reason.to_string(),
                    TransitionActor::Agent,
                    TransitionSource::Cli,
                )
            }
        }
    };

    if let Err(e) = store
        .update_status(TaskUpdateStatusInput {
            id: ta_id.clone(),
            status: TaskStatus::Done,
            message: Some(message),
            actor,
            source: Some(source),
        })
        .await
    {
        ulog_warn!(
            "[task] cron-linked completion for {}: update_status failed: {}",
            ta_id,
            e
        );
    }
}

/// Construct the first-message prompt for a dispatch tick (PRD §9.3.1).
///
/// - `dispatchOrigin='direct'`   → `执行任务：<task.md 正文>`
/// - `dispatchOrigin='ai-aligned'` → `/task-implement` slash command (the skill
///    reads `~/.myagents/tasks/<id>/{task,verify,progress,alignment}.md` on its own)
///
/// Returns `None` if the store isn't initialized or the task doesn't exist.
/// Returns `Some(Err(...))` for unrecoverable I/O (missing task.md on a
/// direct-path task). Callers fall back to the CronTask's stored `prompt`
/// on `None` so legacy tasks (no `task_id` back-pointer) keep working.
pub async fn build_dispatch_prompt(task_id: &str) -> Option<Result<String, String>> {
    let store = get_task_store()?;
    let task = store.get(task_id).await?;
    Some(compose_dispatch_prompt(&task))
}

fn compose_dispatch_prompt(task: &Task) -> Result<String, String> {
    match task.dispatch_origin {
        TaskDispatchOrigin::AiAligned => {
            // The task-implement skill discovers the four alignment docs from
            // `~/.myagents/tasks/<taskId>/` on its own. We just need to invoke it.
            Ok(format!("/task-implement {}", task.id))
        }
        TaskDispatchOrigin::Direct => {
            let dir = task_docs_dir(&task.id)?;
            let task_md = dir.join("task.md");
            match fs::read_to_string(&task_md) {
                Ok(body) => {
                    let trimmed = body.trim();
                    if trimmed.is_empty() {
                        Err(format!(
                            "task.md is empty for direct-dispatch task {}",
                            task.id
                        ))
                    } else {
                        Ok(format!("执行任务：{}", trimmed))
                    }
                }
                Err(e) => Err(format!(
                    "Failed to read task.md for {} ({}): {}",
                    task.id,
                    task_md.display(),
                    e
                )),
            }
        }
    }
}

/// Default events a task subscribes to when `NotificationConfig.events` is absent.
const DEFAULT_NOTIFICATION_EVENTS: &[&str] = &["done", "blocked", "endCondition"];

/// PRD §12.2 — check the per-task subscription and dispatch desktop + bot pushes.
/// Dispatch runs best-effort; bot push failure falls back to desktop (§12.6).
fn dispatch_notification(task: &Task, t: &StatusTransition) {
    // Event key — prefer the transition source if it's an `endCondition`
    // virtual event (PRD §12.2), else use the target status.
    let event_key: &str = match (t.source, t.to) {
        (Some(TransitionSource::EndCondition), _) => "endCondition",
        (_, TaskStatus::Done) => "done",
        (_, TaskStatus::Blocked) => "blocked",
        (_, TaskStatus::Stopped) => "stopped",
        (_, TaskStatus::Verifying) => "verifying",
        _ => return, // other transitions don't map to notification events
    };

    let cfg = task.notification.as_ref();
    let subscribed: Vec<String> = cfg
        .and_then(|c| c.events.clone())
        .unwrap_or_else(|| {
            DEFAULT_NOTIFICATION_EVENTS
                .iter()
                .map(|s| s.to_string())
                .collect()
        });
    if !subscribed.iter().any(|e| e == event_key) {
        return;
    }

    // Build the message (PRD §12.3): "任务「<name>」<动词短语>" + optional
    // `message` body. No emoji (v1.4 decision).
    let verb = match event_key {
        "done" => "已完成",
        "blocked" => "已阻塞",
        "stopped" => "已暂停",
        "verifying" => "进入验证",
        "endCondition" => "循环收敛",
        _ => "状态变更",
    };
    let title = format!("任务「{}」{}", task.name, verb);
    let body = t.message.clone().unwrap_or_default();

    let desktop_enabled = cfg.map(|c| c.desktop).unwrap_or(true);
    let bot_channel = cfg.and_then(|c| c.bot_channel_id.clone());

    let Some(handle) = crate::logger::get_app_handle() else {
        ulog_warn!("[task] notification skipped — no app handle");
        return;
    };

    // Fire desktop notification first (synchronous, best-effort).
    let fire_desktop = |title: &str, body: &str| {
        let _ = handle.emit(
            "notification:show",
            serde_json::json!({
                "title": title,
                "body": body,
                "taskId": task.id,
            }),
        );
    };

    if desktop_enabled {
        fire_desktop(&title, &body);
    }

    if let Some(channel) = bot_channel {
        let handle_cloned = handle.clone();
        let bot_thread = cfg.and_then(|c| c.bot_thread.clone());
        let summary = if body.is_empty() {
            title.clone()
        } else {
            format!("{}\n{}", title, body)
        };
        let task_id = task.id.clone();
        let title_owned = title.clone();
        let desktop_was_enabled = desktop_enabled;
        tauri::async_runtime::spawn(async move {
            // PRD §12.6 — bot push failure falls back to desktop so the user
            // isn't silently left without any notification. Even if the user
            // explicitly turned off `desktop`, a bot failure that left them
            // with zero notifications is a degraded experience we surface.
            let delivered = crate::cron_task::deliver_task_notification_to_bot_checked(
                &handle_cloned,
                &channel,
                bot_thread.as_deref(),
                &task_id,
                &summary,
            )
            .await;
            if !delivered {
                let fallback_body = if desktop_was_enabled {
                    format!("(bot 推送失败) {}", summary)
                } else {
                    format!("(bot 推送失败，降级桌面通知) {}", summary)
                };
                let _ = handle_cloned.emit(
                    "notification:show",
                    serde_json::json!({
                        "title": title_owned,
                        "body": fallback_body,
                        "taskId": task_id,
                    }),
                );
            }
        });
    }
}

/// SSE / frontend broadcast. Uses the global AppHandle from `logger` so any
/// module can emit without threading the handle through constructors.
fn emit_task_event(event: &str, payload: serde_json::Value) {
    if let Some(handle) = crate::logger::get_app_handle() {
        let _ = handle.emit(event, payload);
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            fs::create_dir_all(&target)?;
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            // Symlinks / sockets / fifos — refuse loudly rather than silently skip
            // (CC + Codex review: previous `// symlinks skipped` comment led to
            // cross-device semantics divergence when `fs::rename` preserved them
            // but the fallback dropped them).
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "unsupported file type in alignment dir: {}",
                    entry.path().display()
                ),
            ));
        }
    }
    Ok(())
}

// ================ Static access for Management API ================
//
// The Rust Management API (src/management_api.rs) serves HTTP requests from
// the Bun Sidecar on a loopback port. It runs as a tokio task without direct
// access to Tauri `State`, so we expose a singleton `OnceLock` just like
// `cron_task::CRON_TASK_MANAGER`. `lib.rs` calls `set_task_store()` during
// `setup()` with the same `Arc<TaskStore>` that's in managed state — the two
// handles point at the same inner store (Arc::clone), so mutations are
// visible to both the Tauri IPC path and the HTTP path.

static TASK_STORE: std::sync::OnceLock<Arc<TaskStore>> = std::sync::OnceLock::new();

pub fn set_task_store(store: Arc<TaskStore>) {
    let _ = TASK_STORE.set(store);
}

pub fn get_task_store() -> Option<&'static Arc<TaskStore>> {
    TASK_STORE.get()
}

// ================ Tauri commands ================
//
// The Tauri layer is the trust boundary for actor/source inference (PRD §10.2.1
// caller-inference table): UI button presses are authoritatively stamped as
// `actor=User, source=Ui`. The command DTOs therefore do NOT expose `actor`/
// `source` fields — a malicious renderer cannot spoof `agent` / `system`.
// Server-side callers (scheduler, CLI → Admin API) use the richer internal
// `TaskStore::update_status` API and supply their own trusted actor/source.
//
// Coordination with `ThoughtStore` (link / unlink `convertedTaskIds`) also lives
// in the command layer: it keeps `TaskStore` single-responsibility and lets us
// add SSE broadcast / notification dispatch here in later phases without
// touching the store.

pub type ManagedTaskStore = Arc<TaskStore>;

#[tauri::command]
pub async fn cmd_task_create_direct(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateDirectInput,
) -> Result<Task, String> {
    let source_thought_id = input.source_thought_id.clone();
    let created = task_state.create_direct(input).await?;
    if let Some(thought_id) = source_thought_id {
        if let Err(e) = thought_state.link_task(&thought_id, &created.id).await {
            ulog_warn!(
                "[task] created {} but thought link_task failed: {}",
                created.id,
                e
            );
        }
    }
    Ok(created)
}

#[tauri::command]
pub async fn cmd_task_create_from_alignment(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    input: TaskCreateFromAlignmentInput,
) -> Result<Task, String> {
    let created = task_state.create_from_alignment(input).await?;
    // Resolve thought↔task linkage from the CREATED task, not the raw input
    // (cross-review fix): source_thought_id may have been auto-inherited from
    // alignment metadata.json inside create_from_alignment, in which case the
    // input never carried it. Reading from `created` covers both code paths
    // uniformly and matches the HTTP handler in management_api.rs.
    if let Some(thought_id) = created.source_thought_id.clone() {
        if let Err(e) = thought_state.link_task(&thought_id, &created.id).await {
            ulog_warn!(
                "[task] created {} but thought link_task failed: {}",
                created.id,
                e
            );
        }
    }
    Ok(created)
}

#[tauri::command]
pub async fn cmd_task_list(
    state: tauri::State<'_, ManagedTaskStore>,
    filter: Option<TaskListFilter>,
) -> Result<Vec<Task>, String> {
    Ok(state.list(filter.unwrap_or_default()).await)
}

#[tauri::command]
pub async fn cmd_task_get(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<Option<TaskWithDocs>, String> {
    let Some(task) = state.get(&id).await else {
        return Ok(None);
    };
    let docs = build_task_docs(&task.id)?;
    Ok(Some(TaskWithDocs { task, docs }))
}

#[tauri::command]
pub async fn cmd_task_update(
    state: tauri::State<'_, ManagedTaskStore>,
    input: TaskUpdateInput,
) -> Result<Task, String> {
    state.update(input).await
}

#[tauri::command]
pub async fn cmd_task_update_status(
    state: tauri::State<'_, ManagedTaskStore>,
    input: UiTaskUpdateStatusInput,
) -> Result<Task, String> {
    // Trust boundary: UI callers are stamped as user/ui here. The internal
    // `update_status` API remains available for scheduler / watchdog / crash /
    // endCondition / rerun paths with their own actor/source context.
    state
        .update_status(TaskUpdateStatusInput {
            id: input.id,
            status: input.status,
            message: input.message,
            actor: TransitionActor::User,
            source: Some(TransitionSource::Ui),
        })
        .await
        .map(|(t, _)| t)
}

#[tauri::command]
pub async fn cmd_task_append_session(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    session_id: String,
) -> Result<Task, String> {
    state.append_session(&id, &session_id).await
}

/// Persist alignment-session sidecar metadata to
/// `~/.myagents/tasks/<alignmentSessionId>/metadata.json`.
///
/// Called at the moment the frontend spawns an 「AI 讨论」 session so that
/// `create_from_alignment` can later inherit workspace_id / workspace_path /
/// source_thought_id from the file instead of demanding the AI caller
/// re-pass them through the CLI. See the read side in
/// `TaskStore::create_from_alignment`.
///
/// Creates the alignment dir on demand — the frontend reaches here BEFORE
/// the AI has written any docs into that dir, so we must be the one that
/// ensures its existence. `validate_safe_id` guards against `..` / slashes
/// in the id per the rest of this module's path-safety pattern.
#[tauri::command]
pub async fn cmd_task_write_alignment_metadata(
    alignment_session_id: String,
    workspace_id: String,
    workspace_path: String,
    source_thought_id: Option<String>,
) -> Result<(), String> {
    validate_safe_id(&alignment_session_id, "alignmentSessionId")?;
    let dir = task_docs_dir(&alignment_session_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir alignment dir: {}", e))?;
    let meta = AlignmentSessionMetadata {
        workspace_id,
        workspace_path,
        source_thought_id,
        created_at: now_ms(),
    };
    let json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("serialize alignment metadata: {}", e))?;
    // Atomic tmp+rename — matches the module's `write_atomic_text` convention
    // (task.md / progress.md writes). Concurrent writers for the same
    // alignment id cannot produce a half-written file; a crash mid-write
    // leaves the old file (or no file) but never a corrupt one.
    write_atomic_text(&dir.join("metadata.json"), &json)?;
    ulog_debug!(
        "[task] wrote alignment metadata id={} thought={:?}",
        alignment_session_id,
        meta.source_thought_id,
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_task_archive(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    message: Option<String>,
) -> Result<Task, String> {
    state.archive(&id, message).await
}

#[tauri::command]
pub async fn cmd_task_delete(
    task_state: tauri::State<'_, ManagedTaskStore>,
    thought_state: tauri::State<'_, crate::thought::ManagedThoughtStore>,
    id: String,
) -> Result<(), String> {
    // Capture source_thought_id before delete so we can unlink after.
    let source_thought_id = task_state.get(&id).await.and_then(|t| t.source_thought_id);
    task_state.delete(&id).await?;
    if let Some(thought_id) = source_thought_id {
        if let Err(e) = thought_state.unlink_task(&thought_id, &id).await {
            ulog_warn!("[task] deleted {} but thought unlink_task failed: {}", id, e);
        }
    }
    Ok(())
}

/// Read one of the markdown documents attached to a Task.
///
/// - `task`: the executor prompt (`~/.myagents/tasks/<id>/task.md`). Authored by the user
///   at dispatch, editable from the task detail overlay.
/// - `verify`: acceptance criteria (`~/.myagents/tasks/<id>/verify.md`). Optional; may
///   be authored by the user or produced by the alignment flow. Returns an
///   empty string when the file does not yet exist.
/// - `progress`: read-only execution log (`~/.myagents/tasks/<id>/progress.md`). Agents
///   append to this file during runs; the UI renders it but does not write.
/// - `alignment`: AI-discussion decision record (`~/.myagents/tasks/<id>/alignment.md`).
///   Written by `/task-alignment` skill directly; read-only from the UI.
#[tauri::command]
pub async fn cmd_task_read_doc(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    doc: String,
) -> Result<String, String> {
    let task = state
        .get(&id)
        .await
        .ok_or_else(|| String::from(TaskOpError::not_found(&id)))?;
    let filename = task_doc_filename(&doc)?;
    let path = task_docs_dir(&task.id)?.join(filename);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {}", filename, e)),
    }
}

/// Write `task.md` or `verify.md` for a Task. `progress.md` is agent-only
/// (the CLI / SDK tool appends to it) and is rejected here. The running/
/// verifying lock is enforced atomically with the file write inside
/// `TaskStore::write_doc` — status check and file mutation happen under
/// the same lock so a concurrent `update_status(running)` can't land in
/// between and let us mutate a doc that's mid-execution.
#[tauri::command]
pub async fn cmd_task_write_doc(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
    doc: String,
    content: String,
) -> Result<(), String> {
    let filename = task_doc_filename(&doc)?;
    // progress.md + alignment.md are AI-owned workspace documents — the
    // `/task-alignment` skill creates alignment.md and `/task-implement`
    // writes progress.md using standard Read / Edit / Write tools against
    // the absolute path in `Task.docs`. The UI has no editor for them, so
    // this Tauri command (which backs `TaskEditPanel`) rejects writes to
    // both names — catches an accidental misroute rather than silently
    // corrupting the AI's workbook.
    if filename == "progress.md" || filename == "alignment.md" {
        return Err(format!(
            "{} is AI-owned and not writable via this API",
            filename
        ));
    }
    state.write_doc(&id, filename, &content).await
}

/// Reveal `~/.myagents/tasks/<id>/` in the OS file manager so the user
/// can inspect / edit `task.md`, `verify.md`, `progress.md`, `alignment.md`
/// directly. Sandboxed through `task_docs_dir` so we can't be coerced into
/// opening an arbitrary path. Creates the dir on demand — a fresh Task
/// has no docs dir until its first write.
#[tauri::command]
pub async fn cmd_task_open_docs_dir(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<(), String> {
    // Validate the task exists so the UI can't open a docs dir for a
    // deleted / unknown task (Finder would happily open an empty dir).
    let _task = state
        .get(&id)
        .await
        .ok_or_else(|| String::from(TaskOpError::not_found(&id)))?;
    let dir = task_docs_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir task dir: {}", e))?;
    let path = dir.to_string_lossy().to_string();

    // OS openers via process_cmd::new — CREATE_NO_WINDOW is a no-op for
    // GUI-subsystem binaries (open / explorer.exe / xdg-open) so the wrapper
    // is functionally equivalent to raw Command::new here, but going through
    // it preserves the single-mental-model rule from CLAUDE.md ("ALL child
    // processes use process_cmd::new").
    #[cfg(target_os = "macos")]
    {
        crate::process_cmd::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::process_cmd::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        crate::process_cmd::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open: {}", e))?;
    }
    Ok(())
}

/// Aggregate runtime telemetry for a Task, composed from:
///   * the Task row itself (`last_executed_at`, `session_ids.len()`)
///   * the linked CronTask (`execution_count`, scheduler status)
///   * the tail of `cron_runs/<id>.jsonl` (most recent success flag)
///
/// The renderer uses this in the detail overlay's "运行统计" section
/// without having to stitch three data sources together.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunStats {
    pub execution_count: u32,
    pub last_executed_at: Option<i64>,
    pub last_success: Option<bool>,
    pub last_duration_ms: Option<i64>,
    pub cron_status: Option<String>,
    pub cron_task_id: Option<String>,
    pub session_count: usize,
    /// Next scheduled fire time (ms since epoch). Parsed from the enriched
    /// CronTask's `next_execution_at` RFC3339 string — bypasses the
    /// frontend's `cron-parser` / timezone arithmetic so the overlay's
    /// "下次触发" readout matches what the Rust scheduler will actually
    /// run, avoiding tz / DST drift.
    pub next_execution_at: Option<i64>,
}

#[tauri::command]
pub async fn cmd_task_get_run_stats(
    state: tauri::State<'_, ManagedTaskStore>,
    id: String,
) -> Result<TaskRunStats, String> {
    let task = state
        .get(&id)
        .await
        .ok_or_else(|| String::from(TaskOpError::not_found(&id)))?;

    let mut stats = TaskRunStats {
        execution_count: 0,
        last_executed_at: task.last_executed_at,
        last_success: None,
        last_duration_ms: None,
        cron_status: None,
        cron_task_id: task.cron_task_id.clone(),
        session_count: task.session_ids.len(),
        next_execution_at: None,
    };

    if let Some(cron_id) = task.cron_task_id.as_deref() {
        let manager = crate::cron_task::get_cron_task_manager();
        if let Some(ct) = manager.get_task(cron_id).await {
            stats.execution_count = ct.execution_count;
            stats.cron_status = Some(format!("{:?}", ct.status).to_lowercase());
            if let Some(ts) = ct.last_executed_at {
                // Prefer the CronTask's timestamp (it's updated every tick);
                // the Task's `last_executed_at` only refreshes on status
                // transitions.
                stats.last_executed_at = Some(ts.timestamp_millis());
            }
            // Forward the Rust-computed next fire (parsed from the
            // enriched `next_execution_at` RFC3339 string) so the
            // frontend doesn't need cron-parser + tz math. `get_task`
            // already ran `enrich_task` which populated this field.
            if let Some(s) = ct.next_execution_at.as_deref() {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                    stats.next_execution_at = Some(dt.timestamp_millis());
                }
            }
        }

        // Delegate to `cron_task::read_cron_runs`, which owns the JSONL
        // file layout — keeps `task.rs` out of CronTask's private storage
        // schema and reuses the existing reverse-tail reader (already
        // used by `cmd_get_cron_runs`).
        let runs = crate::cron_task::read_cron_runs(cron_id, 1);
        if let Some(last) = runs.last() {
            stats.last_success = Some(last.ok);
            stats.last_duration_ms = Some(last.duration_ms as i64);
        }
    }

    Ok(stats)
}

/// Central doc-name whitelist for all task-md entry points (Tauri IPC
/// `cmd_task_read_doc`/`cmd_task_write_doc` + Management API
/// `/api/task/read-doc`/`/api/task/write-doc`). Keep these in lockstep —
/// divergence led to the v0.1.69 bug where Management API accepted
/// `alignment` but Tauri IPC rejected it, so the renderer couldn't read
/// alignment.md through the same path the CLI uses.
pub fn task_doc_filename(doc: &str) -> Result<&'static str, String> {
    match doc {
        "task" => Ok("task.md"),
        "verify" => Ok("verify.md"),
        "progress" => Ok("progress.md"),
        "alignment" => Ok("alignment.md"),
        other => Err(format!(
            "unknown doc name: {} (expected task|verify|progress|alignment)",
            other
        )),
    }
}

// ================ Tests ================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    use tempfile::tempdir;

    /// Shared task-docs root for the entire test binary. Initialised
    /// exactly once via `ensure_test_docs_root()` before any test touches
    /// `task_docs_dir()`. Each test uses a fresh UUID task id, so writes
    /// never collide even though the root is shared.
    ///
    /// Per-test tempdir + env-var swapping doesn't work here: `cargo test`
    /// runs tests in parallel within one process, and env vars are
    /// process-global — two concurrent tests would race each other's
    /// redirects. `std::env::set_var` is also technically unsound when
    /// called from multiple threads (Rust 2024 edition marks it `unsafe`
    /// for this reason), so we call it exactly once inside
    /// `get_or_init`'s closure.
    static TEST_DOCS_ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();

    fn ensure_test_docs_root() {
        TEST_DOCS_ROOT.get_or_init(|| {
            let dir = tempdir().expect("create shared test docs tempdir");
            std::env::set_var("MYAGENTS_TASK_DOCS_ROOT", dir.path());
            dir
        });
    }

    fn sample_direct_input(ws: &PathBuf) -> TaskCreateDirectInput {
        TaskCreateDirectInput {
            name: "升级 openclaw lark 适配器".to_string(),
            executor: TaskExecutor::Agent,
            description: None,
            workspace_id: "ws-myagents".to_string(),
            workspace_path: ws.to_string_lossy().into_owned(),
            task_md_content: "跑通 v2.4".to_string(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            dispatch_at: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            source_thought_id: Some("thought-1".to_string()),
            tags: vec!["MyAgents".to_string()],
            notification: None,
        }
    }

    fn status_input(
        id: &str,
        to: TaskStatus,
        actor: TransitionActor,
        source: Option<TransitionSource>,
    ) -> TaskUpdateStatusInput {
        TaskUpdateStatusInput {
            id: id.to_string(),
            status: to,
            message: None,
            actor,
            source,
        }
    }

    #[test]
    fn transition_table_allows_lenient_verifying_to_running() {
        use TaskStatus::*;
        assert!(is_transition_legal(Verifying, Running));
        assert!(is_transition_legal(Running, Verifying));
        assert!(is_transition_legal(Verifying, Done));
        assert!(is_transition_legal(Running, Done));
        assert!(is_transition_legal(Done, Archived));
        assert!(is_transition_legal(Archived, Todo));
    }

    #[test]
    fn transition_table_rejects_bad_paths() {
        use TaskStatus::*;
        assert!(!is_transition_legal(Todo, Done));        // no skipping run
        assert!(!is_transition_legal(Todo, Archived));    // archive only from done
        assert!(!is_transition_legal(Blocked, Archived)); // must reset first
        assert!(!is_transition_legal(Stopped, Archived));
        assert!(!is_transition_legal(Running, Archived));
    }

    #[tokio::test]
    async fn create_direct_writes_task_md_and_history() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        std::fs::create_dir_all(&store_dir).unwrap();
        let store = TaskStore::new(store_dir);

        let input = sample_direct_input(&ws);
        let created = store.create_direct(input).await.unwrap();
        assert_eq!(created.status, TaskStatus::Todo);
        assert_eq!(created.status_history.len(), 1);
        assert_eq!(created.status_history[0].to, TaskStatus::Todo);
        assert_eq!(created.status_history[0].actor, TransitionActor::User);
        assert_eq!(created.dispatch_origin, TaskDispatchOrigin::Direct);

        // task.md materialized at the user-scoped location (no longer under
        // `<workspace>/.task/`).
        let md = task_docs_dir(&created.id).unwrap().join("task.md");
        assert!(md.exists());
        let body = std::fs::read_to_string(&md).unwrap();
        assert_eq!(body, "跑通 v2.4");
    }

    #[tokio::test]
    async fn update_status_appends_history_and_persists() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());

        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        // todo → running (system)
        let (t, tr) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);
        assert_eq!(tr.from, Some(TaskStatus::Todo));
        assert_eq!(t.status_history.len(), 2);
        assert!(t.last_executed_at.is_some());

        // running → verifying (agent/cli)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Verifying);

        // lenient: verifying → running (v1.4)
        let (t, _) = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        assert_eq!(t.status, TaskStatus::Running);

        // verify persistence across reopen
        drop(store);
        let store2 = TaskStore::new(store_dir);
        let reloaded = store2.get(&created.id).await.unwrap();
        // Crash recovery kicks in — running rows are rewritten to blocked at load.
        assert_eq!(reloaded.status, TaskStatus::Blocked);
        // 4 transitions from the runtime session + 1 crash-recovery transition.
        assert_eq!(reloaded.status_history.len(), 5);
        let last = reloaded.status_history.last().unwrap();
        assert_eq!(last.actor, TransitionActor::System);
        assert_eq!(last.source, Some(TransitionSource::Crash));
    }

    #[tokio::test]
    async fn update_status_rejects_invalid_transition() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("illegal transition should fail");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_deleted_as_target() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Deleted,
                TransitionActor::User,
                Some(TransitionSource::Ui),
            ))
            .await
            .expect_err("Deleted is delete()-only");
        assert!(err.contains("invalid_transition"));
    }

    #[tokio::test]
    async fn update_status_rejects_agent_without_cli_source() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Ui), // <-- wrong
            ))
            .await
            .expect_err("agent must come from cli");
        assert!(err.contains("agent_source_must_be_cli"));
    }

    #[tokio::test]
    async fn archive_rejects_non_user_actor() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        // todo → running → done
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();

        // agent cannot archive
        let err = store
            .update_status(status_input(
                &created.id,
                TaskStatus::Archived,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .expect_err("agent cannot archive");
        assert!(err.contains("archive_user_only"));

        // user can
        let archived = store.archive(&created.id, None).await.unwrap();
        assert_eq!(archived.status, TaskStatus::Archived);
    }

    #[tokio::test]
    async fn update_rejects_while_running() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &created.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();

        let err = store
            .update(TaskUpdateInput {
                id: created.id.clone(),
                name: Some("new".to_string()),
                executor: None,
                description: None,
                execution_mode: None,
                run_mode: None,
                end_conditions: None,
                interval_minutes: None,
                cron_expression: None,
                cron_timezone: None,
                dispatch_at: None,
                model: None,
                provider_id: None,
                clear_provider_override: false,
                permission_mode: None,
                preselected_session_id: None,
                runtime: None,
                runtime_config: None,
                clear_runtime_override: false,
                mcp_enabled_servers: None,
                tags: None,
                notification: None,
                prompt: None,
            })
            .await
            .expect_err("should reject");
        assert!(err.contains("update_rejected_running"));
    }

    #[tokio::test]
    async fn delete_soft_and_idempotent() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();

        store.delete(&created.id).await.unwrap();
        // list excludes deleted by default
        assert!(store.list(TaskListFilter::default()).await.is_empty());
        // include_deleted shows it
        let all = store
            .list(TaskListFilter {
                include_deleted: Some(true),
                ..Default::default()
            })
            .await;
        assert_eq!(all.len(), 1);
        assert!(all[0].deleted);
        // Delete writes a proper `→ Deleted` pseudo-transition (not from==to).
        assert_eq!(all[0].status, TaskStatus::Deleted);
        let last = all[0].status_history.last().unwrap();
        assert_eq!(last.to, TaskStatus::Deleted);
        assert_eq!(last.from, Some(TaskStatus::Todo));
        assert_eq!(last.actor, TransitionActor::User);

        // second delete is a no-op
        store.delete(&created.id).await.unwrap();
    }

    #[test]
    fn task_docs_dir_rejects_traversal() {
        assert!(task_docs_dir("../etc").is_err());
        assert!(task_docs_dir("..").is_err());
        assert!(task_docs_dir("a/b").is_err());
        assert!(task_docs_dir("a\\b").is_err());
        assert!(task_docs_dir(".hidden").is_err());
        assert!(task_docs_dir("").is_err());
        // Valid UUID-ish id works
        assert!(task_docs_dir("abc-123_ok").is_ok());
    }

    /// PRD 0.2.9 — verify the provider-routing validator enforces both
    /// invariants (pairing + external-runtime exclusion) and accepts the
    /// "follow Agent" empty state plus the legacy `model`-only shape.
    #[test]
    fn validate_task_provider_routing_enforces_pairing_and_runtime_exclusion() {
        // 1. Empty (= follow Agent) — accepted.
        assert!(validate_task_provider_routing(&None, &None, &None).is_ok());

        // 2. Pair (provider + model) on builtin runtime — accepted.
        assert!(validate_task_provider_routing(
            &Some("openai-x".into()),
            &Some("gpt-4o".into()),
            &Some("builtin".into()),
        )
        .is_ok());

        // 3. providerId without model — rejected (cross-provider misroute risk).
        let err = validate_task_provider_routing(
            &Some("openai-x".into()),
            &None,
            &None,
        )
        .unwrap_err();
        assert!(err.contains("providerId"), "got: {}", err);
        assert!(err.contains("model"), "got: {}", err);

        // 4. External runtime + providerId — rejected (codex / cc / gemini
        //    self-manage providers).
        for rt in ["claude-code", "codex", "gemini"] {
            let err = validate_task_provider_routing(
                &Some("openai-x".into()),
                &Some("gpt-4o".into()),
                &Some(rt.to_string()),
            )
            .unwrap_err();
            assert!(err.contains(rt), "got: {}", err);
        }

        // 5. Legacy `model`-only (pre-0.2.9 task) — accepted as FollowAgent.
        assert!(validate_task_provider_routing(
            &None,
            &Some("legacy-model".into()),
            &None,
        )
        .is_ok());

        // 6. External runtime without provider override — accepted (the
        //    common case for codex/gemini/cc tasks).
        assert!(validate_task_provider_routing(
            &None,
            &None,
            &Some("codex".into()),
        )
        .is_ok());
    }

    /// PRD 0.2.9 — verify `pin_runtime_for_provider_id` materialises
    /// `runtime: 'builtin'` when `provider_id` is set with no explicit
    /// runtime. Closes the cross-talk hole flagged by Codex review.
    #[test]
    fn pin_runtime_for_provider_id_materialises_builtin() {
        // 1. provider_id set, runtime None → pin to builtin.
        let mut rt: Option<String> = None;
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt);
        assert_eq!(rt, Some("builtin".into()));

        // 2. provider_id None, runtime None → no change.
        let mut rt2: Option<String> = None;
        pin_runtime_for_provider_id(&None, &mut rt2);
        assert_eq!(rt2, None);

        // 3. provider_id set, runtime already set → no change (idempotent).
        let mut rt3: Option<String> = Some("builtin".into());
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt3);
        assert_eq!(rt3, Some("builtin".into()));

        // 4. provider_id set, runtime explicitly external → no change here
        //    (validator catches the conflict afterward).
        let mut rt4: Option<String> = Some("codex".into());
        pin_runtime_for_provider_id(&Some("openai-x".into()), &mut rt4);
        assert_eq!(rt4, Some("codex".into()));
    }

    #[tokio::test]
    async fn crash_recovery_rewrites_running_to_blocked_on_reload() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store_dir = dir.path().join("data");
        let store = TaskStore::new(store_dir.clone());
        let a = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        let b = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store
            .update_status(status_input(
                &a.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Ui),
            ))
            .await
            .unwrap();
        store
            .update_status(status_input(
                &b.id,
                TaskStatus::Verifying,
                TransitionActor::Agent,
                Some(TransitionSource::Cli),
            ))
            .await
            .unwrap();
        drop(store);

        let recovered = TaskStore::new(store_dir);
        let ra = recovered.get(&a.id).await.unwrap();
        let rb = recovered.get(&b.id).await.unwrap();
        assert_eq!(ra.status, TaskStatus::Blocked);
        assert_eq!(rb.status, TaskStatus::Blocked);
        // Each has a crash-recovery transition appended.
        assert_eq!(
            ra.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
        assert_eq!(
            rb.status_history.last().unwrap().source,
            Some(TransitionSource::Crash)
        );
    }

    #[tokio::test]
    async fn status_filter_accepts_single_or_array() {
        use serde_json::json;
        // Single value
        let f: TaskListFilter =
            serde_json::from_value(json!({"status": "running"})).unwrap();
        assert!(f.status.is_some());
        // Array of values
        let f: TaskListFilter =
            serde_json::from_value(json!({"status": ["running", "done"]})).unwrap();
        assert!(f.status.is_some());
    }

    #[tokio::test]
    async fn dispatch_origin_and_run_mode_serialize_kebab_case() {
        // PRD §3.2 / TS shared types — these wire values must match exactly.
        let d = TaskDispatchOrigin::AiAligned;
        assert_eq!(serde_json::to_string(&d).unwrap(), "\"ai-aligned\"");
        let r = TaskRunMode::SingleSession;
        assert_eq!(serde_json::to_string(&r).unwrap(), "\"single-session\"");
    }

    #[tokio::test]
    async fn end_conditions_deadline_serializes_as_ms() {
        let ec = TaskEndConditions {
            deadline: Some(1_700_000_000_000),
            max_executions: Some(5),
            ai_can_exit: true,
        };
        let s = serde_json::to_string(&ec).unwrap();
        assert!(s.contains("\"deadline\":1700000000000"));
    }

    #[tokio::test]
    // `tokio::spawn` is fine inside `#[tokio::test]` — the test attribute
    // provides the runtime context. Allow the project-wide ban only here.
    #[allow(clippy::disallowed_methods)]
    async fn concurrent_creates_preserve_all_rows() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = Arc::new(TaskStore::new(dir.path().join("data")));

        let mut handles = Vec::new();
        for i in 0..20 {
            let s = store.clone();
            let w = ws.clone();
            handles.push(tokio::spawn(async move {
                let mut input = sample_direct_input(&w);
                input.name = format!("task {}", i);
                s.create_direct(input).await.unwrap()
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let listed = store.list(TaskListFilter::default()).await;
        assert_eq!(listed.len(), 20);
    }

    #[tokio::test]
    async fn append_session_idempotent() {
        ensure_test_docs_root();
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let store = TaskStore::new(dir.path().join("data"));
        let created = store.create_direct(sample_direct_input(&ws)).await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-1").await.unwrap();
        store.append_session(&created.id, "sess-2").await.unwrap();
        let reloaded = store.get(&created.id).await.unwrap();
        assert_eq!(reloaded.session_ids, vec!["sess-1".to_string(), "sess-2".to_string()]);
    }

    // Removed `update_progress_appends_to_file` test: targeted `TaskStore::update_progress`
    // which was renamed/removed in v0.1.69+ (see comment at line 1935 about
    // append_progress_line). Test code was stale dead reference blocking the
    // workspace test binary from compiling. Cleaned up incidentally during
    // PRD 0.2.7 Phase A so workspace_files unit tests can run.
}
