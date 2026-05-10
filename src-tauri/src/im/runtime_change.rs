//! Runtime-change session detach (v0.2.14 dogfood fix).
//!
//! Backstory: every IM session is created with `snapshotForImSession()` in
//! `src/server/utils/session-snapshot.ts`, which stores ONLY the session's
//! `runtime` and leaves `model / permissionMode / mcpEnabledServers /
//! providerId / providerEnvJson / configSnapshotAt` undefined — the D4
//! "live-follow agent config" policy. Works fine while runtime is stable.
//!
//! Runtime change is the one config delta D4 cannot live-follow: an SDK
//! conversation under runtime A cannot be resumed under runtime B because
//! the on-disk session format is runtime-specific (Claude Code's signed
//! transcript, Codex's threadId, builtin's SDK message log, …). Forcing a
//! cross-runtime resume gets you "Session ID is already in use" + 404
//! errors on the next message — exactly what dogfood hit.
//!
//! This module orchestrates the fix: when an agent's runtime is about to
//! change, every bot-bound session in that agent is "frozen" with the
//! agent's about-to-be-replaced config (matching the desktop session
//! snapshot policy from `snapshotForOwnedSession`), then the binding's
//! `peer_session.session_id` is rotated to a fresh UUID and the channel
//! is notified. The result:
//!
//!   * Old session → detached from the bot, fully self-contained snapshot.
//!     Reopening it from desktop's session history works exactly like any
//!     other historical session — sidecar boots with the OLD runtime +
//!     OLD model/provider/mcp/permission, picking those from session
//!     metadata via the existing `configSnapshotAt`-driven snapshot path.
//!   * New session_id → empty, no sidecar yet. Next IM message arriving
//!     for the channel spawns a fresh sidecar with the NEW runtime.
//!   * IM user → sees a one-line notification explaining the switch +
//!     the new session's 8-char prefix (matching `/new` IM affordance).

use std::time::Duration;
use std::time::Instant;

use serde_json::{json, Value};
use uuid::Uuid;

use super::adapter::ImAdapter;
use super::AgentInstance;
use crate::sidecar::{release_session_sidecar, ManagedSidecarManager, SidecarOwner};
use crate::utils::file_lock::{with_file_lock, FileLockOptions};
use crate::{ulog_info, ulog_warn};

/// 6-field payload of "the agent config that was active when the session was
/// detached". MUST stay aligned with the TS Pick in
/// `src/server/utils/session-snapshot.ts::OwnedSessionSnapshot` (sans
/// `configSnapshotAt` — that field is a writer-stamped marker, not part of
/// the payload, set by both the sidecar `/api/session/freeze` endpoint and
/// the Rust file-lock fallback writer to "now" at write time).
///
/// Made `pub` so `cmd_update_agent_config` can build this BEFORE applying
/// any other patch.* fields to the agent's RwLocks (snapshot must reflect
/// the state about to be replaced, not the half-mutated state). The
/// agent-state→snapshot mapping is the `build_snapshot_from_agent_state`
/// helper below.
pub struct OwnedSessionSnapshot {
    runtime: String,
    model: Option<String>,
    permission_mode: Option<String>,
    mcp_enabled_servers: Option<Vec<String>>,
    provider_id: Option<String>,
    provider_env_json: Option<String>,
}

impl OwnedSessionSnapshot {
    fn to_json(&self) -> Value {
        // configSnapshotAt is intentionally omitted — both the sidecar
        // freeze endpoint AND the file-lock fallback below stamp `now`
        // themselves, so the marker reflects when the write actually
        // committed (not when Rust composed the payload).
        let mut obj = serde_json::Map::new();
        obj.insert("runtime".into(), json!(self.runtime));
        if let Some(ref m) = self.model {
            obj.insert("model".into(), json!(m));
        }
        if let Some(ref pm) = self.permission_mode {
            obj.insert("permissionMode".into(), json!(pm));
        }
        if let Some(ref mcp) = self.mcp_enabled_servers {
            obj.insert("mcpEnabledServers".into(), json!(mcp));
        }
        if let Some(ref pid) = self.provider_id {
            obj.insert("providerId".into(), json!(pid));
        }
        if let Some(ref penv) = self.provider_env_json {
            obj.insert("providerEnvJson".into(), json!(penv));
        }
        Value::Object(obj)
    }
}

/// Build the OwnedSessionSnapshot from the agent's CURRENT in-memory config.
///
/// MUST be called BEFORE the patched fields (runtime / model / mcp / provider)
/// are written to the agent state — otherwise we'd snapshot the NEW config and
/// the detached session would inherit the post-change settings (defeating the
/// whole point: the detached session must remember what it was running on).
///
/// Marked `pub` so the caller in `cmd_update_agent_config` can capture the
/// snapshot at function entry (before any `patch.*` is applied to the agent's
/// RwLocks) and pass it to `freeze_and_rotate_for_runtime_change`.
pub async fn build_snapshot_from_agent_state(agent: &AgentInstance) -> OwnedSessionSnapshot {
    OwnedSessionSnapshot {
        runtime: agent.runtime.read().await.clone(),
        model: agent.current_model.read().await.clone(),
        permission_mode: Some(agent.permission_mode.read().await.clone()),
        // mcp_servers_json is the FULL list-of-servers JSON; we only want
        // the enabled ids (matches `snapshotForOwnedSession.mcpEnabledServers`).
        mcp_enabled_servers: agent
            .mcp_servers_json
            .read()
            .await
            .as_ref()
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
            .map(|servers| {
                servers
                    .iter()
                    .filter(|s| s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))
                    .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(String::from))
                    .collect::<Vec<_>>()
            }),
        // provider_id / provider_env_json — see module-level note: provider_id
        // is currently NOT hot-reloaded into AgentInstance (no Arc<RwLock>),
        // so we use the boot-time value from agent.config. provider_env IS
        // hot-reloaded so we read from the live RwLock and serialize.
        provider_id: agent.config.provider_id.clone(),
        provider_env_json: agent
            .current_provider_env
            .read()
            .await
            .as_ref()
            .map(|v| v.to_string()),
    }
}

/// Push the snapshot into the running sidecar via HTTP (`/api/session/freeze`).
/// Returns `Ok(())` on 2xx, otherwise a `String` describing the failure for
/// the caller to log + fall back to the Rust file-lock writer.
async fn freeze_via_sidecar(
    http: &reqwest::Client,
    port: u16,
    session_id: &str,
    snapshot_json: &Value,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/api/session/freeze", port);
    let resp = http
        .post(&url)
        .json(&json!({
            "sessionId": session_id,
            "snapshot": snapshot_json,
        }))
        .send()
        .await
        .map_err(|e| format!("freeze HTTP send failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("freeze returned {}: {}", status, body));
    }
    Ok(())
}

/// Rust fallback writer — used when the session's sidecar is dead at freeze
/// time (port==0 from a prior `release_all_sidecars_preserve_bindings` or a
/// natural exit). We still need the session to carry its OLD config so that
/// a future desktop reopen behaves correctly; without this, the session's
/// metadata stays D4-shaped (runtime field only) and the reopen would pick
/// up the agent's NEW runtime config — same bug we're trying to avoid.
///
/// Uses the SAME on-disk `~/.myagents/sessions.lock` that the Node sidecar's
/// `withSessionsLock` uses (`SessionStore.ts:32`). This is a cross-process
/// writer pair, so the lock convention MUST match exactly.
async fn freeze_via_file_lock(
    session_id: &str,
    snapshot: &OwnedSessionSnapshot,
) -> Result<(), String> {
    let myagents_dir = dirs::home_dir()
        .ok_or_else(|| "home_dir unavailable".to_string())?
        .join(".myagents");
    let sessions_path = myagents_dir.join("sessions.json");
    let tmp_path = myagents_dir.join("sessions.json.tmp");
    let lock_path = myagents_dir.join("sessions.lock");

    // Pre-build the JSON value the snapshot would write — done OUTSIDE the
    // closure so all the borrowed `&self` fields stay on the async side.
    let snapshot_json = snapshot.to_json();
    let session_id_owned = session_id.to_string();

    let result = with_file_lock(
        &lock_path,
        FileLockOptions::default(),
        move || -> Result<bool, crate::utils::file_lock::FileLockError> {
            let content = match std::fs::read_to_string(&sessions_path) {
                Ok(s) => s,
                Err(e) => {
                    return Err(crate::utils::file_lock::FileLockError::Io(e));
                }
            };
            let mut sessions: Value = serde_json::from_str(&content).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("parse sessions.json: {}", e),
                ))
            })?;
            let arr = match sessions.as_array_mut() {
                Some(a) => a,
                None => return Ok(false),
            };
            let mut found = false;
            for entry in arr.iter_mut() {
                if entry.get("id").and_then(|v| v.as_str()) == Some(session_id_owned.as_str()) {
                    if let Some(obj) = entry.as_object_mut() {
                        if let Some(snap_obj) = snapshot_json.as_object() {
                            for (k, v) in snap_obj {
                                obj.insert(k.clone(), v.clone());
                            }
                        }
                        // Stamp the freeze marker. Same convention as the
                        // sidecar endpoint: write happens here = "now" lives
                        // here. ISO-8601 to match Node `new Date().toISOString()`.
                        let now = chrono::Utc::now()
                            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                            .to_string();
                        obj.insert("configSnapshotAt".into(), json!(now));
                        found = true;
                        break;
                    }
                }
            }
            if !found {
                return Ok(false);
            }

            let new_content = serde_json::to_string_pretty(&sessions).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("serialize sessions.json: {}", e),
                ))
            })?;
            std::fs::write(&tmp_path, new_content)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            std::fs::rename(&tmp_path, &sessions_path)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            Ok(true)
        },
    )
    .await;

    match result {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("session {} not found in sessions.json", session_id)),
        Err(e) => Err(e.to_string()),
    }
}

fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

/// Per-channel iteration: for each peer_session, freeze (HTTP if sidecar is
/// alive, file-lock fallback otherwise), rotate session_id to a fresh UUID,
/// release the old Agent owner, and push a notification to the IM chat.
///
/// Caller (`cmd_update_agent_config` runtime branch) is responsible for:
///
///   * Detecting that runtime is actually changing (no-op if same).
///   * Capturing the `snapshot` via `build_snapshot_from_agent_state(agent)`
///     AT FUNCTION ENTRY of cmd_update_agent_config — BEFORE any `patch.*`
///     mutates `current_model` / `current_provider_env` / `permission_mode` /
///     `mcp_servers_json`. (review-by-codex F1: the previous version
///     captured snapshot at orchestrator-call time, after those four had
///     already been replaced — defeating the whole feature.)
///   * Calling this function inside the existing runtime branch so that the
///     rest of the patch (release_all_sidecars_preserve_bindings, etc.)
///     runs after — those become near no-ops for the rotated peer_sessions.
///
/// Errors per peer_session are logged + swallowed — partial success is
/// preferable to refusing to apply the runtime change and leaving the user
/// in a confused state.
pub async fn freeze_and_rotate_for_runtime_change(
    agent: &AgentInstance,
    old_runtime: &str,
    new_runtime: &str,
    sidecar_manager: &ManagedSidecarManager,
    snapshot: OwnedSessionSnapshot,
) {
    let snapshot_json = snapshot.to_json();

    // Reuse a single short-timeout HTTP client across all freeze calls.
    // Localhost only — `local_http::builder()` per the project red-line.
    // Build failure is non-fatal: we log it and proceed; every per-session
    // freeze attempt below will then go straight to the file-lock fallback,
    // which is fully functional without HTTP. (review-by-codex F4: original
    // returned early here, leaving bindings completely un-rotated.)
    let http: Option<reqwest::Client> = match crate::local_http::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => Some(c),
        Err(e) => {
            ulog_warn!(
                "[runtime-change] HTTP client build failed ({}); all freezes will use file-lock fallback",
                e
            );
            None
        }
    };

    let mut total_bindings = 0usize;
    let mut frozen_via_sidecar = 0usize;
    let mut frozen_via_fallback = 0usize;
    let mut rotated = 0usize;
    let mut notified = 0usize;

    for (channel_id, ch_inst) in &agent.channels {
        let mut router = ch_inst.bot_instance.router.lock().await;
        let keys: Vec<String> = router.peer_session_keys();
        if keys.is_empty() {
            continue;
        }
        let adapter = ch_inst.bot_instance.adapter.clone();

        for key in keys {
            total_bindings += 1;

            // Snapshot prior session for chat_id + sidecar port, then rotate.
            let prior = match router.peer_session_snapshot(&key) {
                Some(p) => p,
                None => continue, // race: removed under us — skip safely
            };
            let old_session_id = prior.session_id.clone();
            let port = prior.sidecar_port;
            let chat_id = prior.source_id.clone();

            // ----- 1. Freeze old session (HTTP if alive AND client built;
            //         file-lock fallback otherwise). The two paths must be
            //         symmetric — both stamp configSnapshotAt=now and merge
            //         only present snapshot fields (review-by-codex F2).
            let try_http = port != 0 && http.is_some();
            if try_http {
                let client = http.as_ref().unwrap();
                match freeze_via_sidecar(client, port, &old_session_id, &snapshot_json).await {
                    Ok(()) => {
                        frozen_via_sidecar += 1;
                        ulog_info!(
                            "[runtime-change] froze session {} via sidecar port {}",
                            short_id(&old_session_id),
                            port
                        );
                    }
                    Err(e) => {
                        ulog_warn!(
                            "[runtime-change] sidecar freeze failed (channel={} session={}): {} — falling back to file lock",
                            channel_id,
                            short_id(&old_session_id),
                            e
                        );
                        match freeze_via_file_lock(&old_session_id, &snapshot).await {
                            Ok(()) => {
                                frozen_via_fallback += 1;
                                ulog_info!(
                                    "[runtime-change] froze session {} via file lock (sidecar fallback)",
                                    short_id(&old_session_id)
                                );
                            }
                            Err(e2) => ulog_warn!(
                                "[runtime-change] file-lock freeze ALSO failed for session {}: {}",
                                short_id(&old_session_id),
                                e2
                            ),
                        }
                    }
                }
            } else {
                // Sidecar dead (port==0 from previous preserve_bindings) OR
                // HTTP client failed to build. Go straight to file-lock.
                match freeze_via_file_lock(&old_session_id, &snapshot).await {
                    Ok(()) => {
                        frozen_via_fallback += 1;
                        ulog_info!(
                            "[runtime-change] froze session {} via file lock (no HTTP path available)",
                            short_id(&old_session_id)
                        );
                    }
                    Err(e) => ulog_warn!(
                        "[runtime-change] file-lock freeze failed for session {}: {}",
                        short_id(&old_session_id),
                        e
                    ),
                }
            }

            // ----- 2. Mint fresh session_id and rotate the binding.
            //         `last_active = Instant::now()` matches every other
            //         peer_session creation site (`add_peer_session` /
            //         `handover.rs::cmd_handover_session_to_channel` step 5);
            //         keeping the prior's stale timestamp would make the
            //         fresh binding look "old" to most_recent_peer_session_key
            //         and similar last-write-wins selectors.
            //         (review-by-codex F4.)
            let new_session_id = Uuid::new_v4().to_string();
            let mut new_peer = prior.clone();
            new_peer.session_id = new_session_id.clone();
            new_peer.sidecar_port = 0; // next IM message spawns a fresh sidecar with NEW runtime
            new_peer.message_count = 0;
            new_peer.last_active = Instant::now();
            router.upsert_peer_session(new_peer);
            rotated += 1;
            ulog_info!(
                "[runtime-change] rotated peer_session {} → {} (channel={})",
                short_id(&old_session_id),
                short_id(&new_session_id),
                channel_id,
            );

            // ----- 3. Release the OLD session's Agent owner. The sidecar
            // dies if no other owner remains (typical case for IM-only
            // bindings); a desktop tab on the same session keeps its
            // sidecar alive (Tab owner persists), and that's correct —
            // the user gets to keep using the old session as a regular
            // historical session backed by the snapshot we just wrote.
            let owner = SidecarOwner::Agent(key.clone());
            let _ = release_session_sidecar(sidecar_manager, &old_session_id, &owner);

            // ----- 4. Notify the IM chat.
            let notification = format!(
                "Agent 工作区 Runtime 从「{}」更新为「{}」，开始新会话（{}）",
                old_runtime,
                new_runtime,
                short_id(&new_session_id),
            );
            match adapter.send_message(&chat_id, &notification).await {
                Ok(_) => {
                    notified += 1;
                    ulog_info!(
                        "[runtime-change] notified channel={} chat={}",
                        channel_id,
                        chat_id
                    );
                }
                Err(e) => ulog_warn!(
                    "[runtime-change] notification send failed (channel={} chat={}): {}",
                    channel_id,
                    chat_id,
                    e
                ),
            }
        }
    }

    if total_bindings > 0 {
        ulog_info!(
            "[runtime-change] agent={} {} → {}: bindings={} frozen(sidecar={}, fallback={}) rotated={} notified={}",
            agent.agent_id,
            old_runtime,
            new_runtime,
            total_bindings,
            frozen_via_sidecar,
            frozen_via_fallback,
            rotated,
            notified,
        );
    }
}
