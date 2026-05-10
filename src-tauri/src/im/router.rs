// Session Router — maps IM peers to Sidecar instances
// Handles: peer→Sidecar mapping, crash recovery, idle session collection, and HTTP client factory.
//
// Concurrency model:
//   Global semaphore + per-peer locks live OUTSIDE the router (in the processing loop).
//   The router lock is only held briefly for data operations (ensure_sidecar, record_response).
//   SSE streaming to Sidecars happens WITHOUT the router lock, enabling true per-peer parallelism.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::json;
use tauri::{AppHandle, Runtime};
use crate::{ulog_info, ulog_warn};

use crate::sidecar::{
    ensure_session_sidecar, release_session_sidecar, ManagedSidecarManager, SidecarOwner,
};

use super::types::{ImMessage, ImSourceType, PeerSession};

/// Max concurrent AI requests across all peers
pub const GLOBAL_CONCURRENCY: usize = 8;
/// Idle session timeout (30 minutes)
const IDLE_TIMEOUT_SECS: u64 = 1800;
/// Max Sidecar restart attempts (reserved for future reconnect logic)
#[allow(dead_code)]
const MAX_RESTART_ATTEMPTS: u32 = 5;
/// Initial restart backoff (seconds)
#[allow(dead_code)]
const INITIAL_RESTART_BACKOFF_SECS: u64 = 1;
/// Max restart backoff (seconds)
#[allow(dead_code)]
const MAX_RESTART_BACKOFF_SECS: u64 = 30;
/// HTTP timeout for Sidecar API calls
const SIDECAR_HTTP_TIMEOUT_SECS: u64 = 300;

/// Result of Phase 1 of ensure_sidecar: either the sidecar is healthy, or we need to create one.
pub enum EnsureSidecarPrep {
    /// Existing sidecar is healthy — return immediately with port.
    Healthy(u16),
    /// Need to create/restart sidecar — extracted info for Phase 2.
    NeedCreate(EnsureSidecarInfo),
}

/// Info extracted from router state needed to create a sidecar (Phase 2).
/// Cloned out so the router lock can be released during the blocking create.
#[derive(Clone)]
pub struct EnsureSidecarInfo {
    pub session_key: String,
    pub session_id: String,
    pub workspace: PathBuf,
    pub prev_count: u32,
}

/// Error from Sidecar routing — distinguishes bufferable vs non-bufferable failures.
#[derive(Debug)]
pub enum RouteError {
    /// Sidecar setup failed (ensure_sidecar error)
    Setup(String),
    /// HTTP request failed (connection error, timeout) — message should be buffered
    Unavailable(String),
    /// Sidecar returned non-success HTTP status
    Response(u16, String),
}

impl RouteError {
    pub fn should_buffer(&self) -> bool {
        matches!(self, Self::Unavailable(_))
    }
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Setup(e) => write!(f, "{}", e),
            Self::Unavailable(e) => write!(f, "Sidecar unavailable: {}", e),
            Self::Response(status, body) => write!(f, "Sidecar returned {}: {}", status, body),
        }
    }
}

pub struct SessionRouter {
    peer_sessions: HashMap<String, PeerSession>,
    default_workspace: PathBuf,
    http_client: Client,
    /// Agent ID (if this router belongs to an Agent channel). None for legacy IM bots.
    agent_id: Option<String>,
}

/// Create an HTTP client configured for local Sidecar communication.
pub fn create_sidecar_http_client() -> Client {
    crate::local_http::json_client(Duration::from_secs(SIDECAR_HTTP_TIMEOUT_SECS))
}

/// HTTP client for SSE streaming (read_timeout as idle timeout, not overall timeout).
/// No overall timeout — the stream stays open until the turn completes.
/// read_timeout acts as idle timeout: if no bytes arrive within 300s, the connection drops.
/// Heartbeat from Sidecar is 15s; 300s margin covers cold-start SDK initialization.
pub fn create_sidecar_stream_client() -> Client {
    crate::local_http::sse_client()
}

impl SessionRouter {
    pub fn new(default_workspace: PathBuf) -> Self {
        Self {
            peer_sessions: HashMap::new(),
            default_workspace,
            http_client: create_sidecar_http_client(),
            agent_id: None,
        }
    }

    /// Create a router for an Agent channel (uses `agent:` session key format).
    pub fn new_for_agent(default_workspace: PathBuf, agent_id: String) -> Self {
        Self {
            peer_sessions: HashMap::new(),
            default_workspace,
            http_client: create_sidecar_http_client(),
            agent_id: Some(agent_id),
        }
    }

    /// Generate session key from IM message.
    /// If agent_id is set, uses new format: agent:{agentId}:{channelType}:{type}:{id}
    /// Otherwise falls back to legacy: im:{platform}:{type}:{id}
    pub fn session_key(&self, msg: &ImMessage) -> String {
        if let Some(ref agent_id) = self.agent_id {
            let source = match msg.source_type {
                ImSourceType::Private => "private",
                ImSourceType::Group => "group",
            };
            format!("agent:{}:{}:{}:{}", agent_id, msg.platform, source, msg.chat_id)
        } else {
            msg.session_key()
        }
    }

    /// Ensure a Sidecar is running for the given session key.
    /// Returns `(port, is_new_sidecar)` — `is_new_sidecar` is true when a new Sidecar was created
    /// (caller should sync AI config like model/MCP after creation).
    ///
    /// IMPORTANT: This method holds the router lock for the ENTIRE duration including
    /// the blocking `ensure_session_sidecar` call (up to 5 minutes). For callers that can
    /// release the lock between phases, use the 3-phase split instead:
    /// `prepare_ensure_sidecar` → `create_sidecar_blocking` → `commit_ensure_sidecar`.
    /// This single-lock method is kept for the message processing loop where per-peer locks
    /// already serialize same-peer access.
    pub async fn ensure_sidecar<R: Runtime>(
        &mut self,
        session_key: &str,
        app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<(u16, bool), String> {
        // Phase 1: Check existing healthy sidecar (brief)
        let prep = self.prepare_ensure_sidecar(session_key).await;
        if let EnsureSidecarPrep::Healthy(port) = prep {
            return Ok((port, false));
        }

        // Phase 2: Create sidecar (blocking — holds lock the entire time)
        let info = match prep {
            EnsureSidecarPrep::NeedCreate(info) => info,
            EnsureSidecarPrep::Healthy(_) => unreachable!(),
        };
        let port = Self::create_sidecar_blocking(info.clone(), app_handle, manager).await?;

        // Phase 3: Write result back
        self.commit_ensure_sidecar(session_key, &info, port);

        Ok((port, true))
    }

    // ---- Split ensure_sidecar into 3 phases for lock-free blocking ----

    /// Phase 1: Check if sidecar is healthy, or extract info needed to create one.
    /// If unhealthy, zeros `sidecar_port` to prevent idle-collector from killing
    /// the sidecar that Phase 2 will create (TOCTOU guard).
    /// Holds the lock briefly (health check ~4.5s worst case).
    pub async fn prepare_ensure_sidecar(&mut self, session_key: &str) -> EnsureSidecarPrep {
        // Check existing peer session
        if let Some(ps) = self.peer_sessions.get(session_key) {
            if ps.sidecar_port > 0 {
                if self.check_sidecar_health(ps.sidecar_port).await {
                    return EnsureSidecarPrep::Healthy(ps.sidecar_port);
                }
                ulog_warn!(
                    "[im-router] Sidecar on port {} unhealthy for {}",
                    ps.sidecar_port,
                    session_key
                );
            }
        }
        // Zero the port BEFORE releasing the lock. This prevents idle-collector
        // from calling release_session_sidecar on a sidecar that Phase 2 is about
        // to create (idle-collector skips entries with port=0).
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.sidecar_port = 0;
        }

        let prev_count = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.message_count)
            .unwrap_or(0);

        let workspace = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.workspace_path.clone())
            .unwrap_or_else(|| self.default_workspace.clone());

        let session_id = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.session_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        EnsureSidecarPrep::NeedCreate(EnsureSidecarInfo {
            session_key: session_key.to_string(),
            session_id,
            workspace,
            prev_count,
        })
    }

    /// Phase 2: Create the sidecar (blocking, up to 5 minutes). Does NOT hold the router lock.
    /// This is a static method — callers invoke it after releasing the lock.
    pub async fn create_sidecar_blocking<R: Runtime>(
        info: EnsureSidecarInfo,
        app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<u16, String> {
        let owner = SidecarOwner::Agent(info.session_key.clone());
        let app_clone = app_handle.clone();
        let manager_clone = Arc::clone(manager);
        let sid = info.session_id.clone();
        let ws = info.workspace.clone();

        let result = tokio::task::spawn_blocking(move || {
            ensure_session_sidecar(&app_clone, &manager_clone, &sid, &ws, owner)
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?
        .map_err(|e| format!("Failed to ensure Sidecar: {}", e))?;

        ulog_info!(
            "[im-router] Sidecar ready for {} on port {} (workspace={})",
            info.session_key,
            result.port,
            info.workspace.display(),
        );

        Ok(result.port)
    }

    /// Phase 3: Write the new sidecar port back into the peer session map.
    /// Holds the lock briefly.
    pub fn commit_ensure_sidecar(
        &mut self,
        session_key: &str,
        info: &EnsureSidecarInfo,
        port: u16,
    ) {
        let (source_type, source_id) = parse_session_key(session_key);
        self.peer_sessions.insert(
            session_key.to_string(),
            PeerSession {
                session_key: session_key.to_string(),
                session_id: info.session_id.clone(),
                sidecar_port: port,
                workspace_path: info.workspace.clone(),
                source_type,
                source_id,
                message_count: info.prev_count,
                last_active: Instant::now(),
            },
        );
    }

    /// Get a reference to a peer session by session_key.
    pub fn get_peer_session(&self, session_key: &str) -> Option<&PeerSession> {
        self.peer_sessions.get(session_key)
    }

    /// Record a successful AI response — increment message_count and refresh activity.
    /// Note: session_id is NOT updated here. Use `upgrade_peer_session_id` when the
    /// Bun sidecar creates a new session internally (e.g., provider switch).
    pub fn record_response(&mut self, session_key: &str, _session_id: Option<&str>) {
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.message_count += 1;
            ps.last_active = Instant::now();
        }
    }

    /// Upgrade a peer's session_id when the Bun sidecar internally created a new session
    /// (e.g., provider switch third-party → Anthropic). Also upgrades the Sidecar Manager key.
    /// Returns true if the session_id was actually changed.
    pub fn upgrade_peer_session_id(
        &mut self,
        session_key: &str,
        new_session_id: &str,
        manager: &ManagedSidecarManager,
    ) -> bool {
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            if ps.session_id == new_session_id {
                return false; // no change
            }
            let old_id = ps.session_id.clone();
            {
                let mut mgr = manager.lock().unwrap();
                mgr.upgrade_session_id(&old_id, new_session_id);
            }
            ps.session_id = new_session_id.to_string();
            ulog_info!(
                "[im-router] Upgraded peer session_id: {} -> {} (session_key={})",
                old_id, new_session_id, session_key,
            );
            true
        } else {
            false
        }
    }

    /// Check if Sidecar is healthy via HTTP.
    /// Uses retry with increasing timeout to avoid false positives when Bun is
    /// temporarily busy (MCP tool execution, heavy computation, GC pause).
    async fn check_sidecar_health(&self, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{}/health", port);
        // Retry once with longer timeout before declaring unhealthy.
        // First attempt: 1.5s (handles normal load).
        // Retry: 3s (handles heavy MCP processing / GC pauses).
        for timeout_ms in [1500u64, 3000] {
            match self
                .http_client
                .get(&url)
                .timeout(Duration::from_millis(timeout_ms))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => return true,
                _ => {}
            }
        }
        false
    }

    /// Handle /new command — reset session for a peer.
    /// Upgrades the Sidecar Manager key so the running Sidecar can be found by the new session_id.
    /// Detect runtime drift for an IM peer session and reset it like a `/new`.
    ///
    /// When the user changes the agent's runtime in Settings (codex → gemini
    /// for example), any Sidecar that's still alive for this peer was spawned
    /// with the old MYAGENTS_RUNTIME env var and cannot switch in-place. The
    /// v0.1.62 session-stability rule — which pins a session to whichever
    /// runtime created it — is wrong for IM: peer session mapping is opaque
    /// to the user, they just see "my agent is now gemini" and expect the
    /// next IM message to reflect that.
    ///
    /// This method runs at the TOP of message processing (before
    /// `ensure_sidecar`). If drift is detected it:
    ///   1. Kills the running Sidecar process (best-effort).
    ///   2. Removes the entry from `ManagedSidecarManager`.
    ///   3. Regenerates `peer_sessions[session_key].session_id` to a fresh
    ///      UUID. The old session_id's messages remain on disk (SessionStore
    ///      persisted them) and stay findable via global search — we just
    ///      detach them from the IM peer map so the WeChat Bot's live chat
    ///      starts clean.
    ///
    /// Returns `Some((old_session_id, new_session_id))` when a reset happened
    /// so the caller can send the user a notification ("🔁 已自动创建新对话
    /// (xxxxxxxx)"). Returns `None` when no drift was detected.
    ///
    /// `desired_runtime` is the agent's CURRENT runtime as resolved from
    /// config (typically via `normalize_runtime_type(agent_config.runtime)`).
    /// Valid values: `"builtin"`, `"claude-code"`, `"codex"`, `"gemini"`.
    pub fn check_and_reset_on_runtime_drift(
        &mut self,
        session_key: &str,
        desired_runtime: &str,
        manager: &ManagedSidecarManager,
    ) -> Option<(String, String)> {
        let old_id = self.peer_sessions.get(session_key)?.session_id.clone();

        // Delegate the Sidecar-side half (compare spawn-time runtime, decide
        // whether killing is safe based on owner accounting) to SidecarManager
        // so router.rs doesn't reach into private fields.
        //
        // The tri-state result lets us distinguish:
        //   - NoDrift → no action
        //   - KilledAndRemoved → full kill happened, spawn path will recreate
        //   - DetectedKeptAlive → Sidecar stays alive (shared with desktop
        //     Tab/Cron/BackgroundCompletion), but we STILL regenerate the
        //     peer session_id to fork the IM conversation cleanly. The
        //     desktop session continues unperturbed on the old session_id.
        let drift_result = {
            let mut mgr = manager.lock().ok()?;
            mgr.kill_sidecar_if_runtime_differs(&old_id, desired_runtime)
        };
        if !drift_result.is_drift() {
            return None;
        }

        // Regenerate the peer's session_id. Zero the cached port so
        // prepare_ensure_sidecar re-enters the NeedCreate branch on the next
        // message. message_count=0 and last_active=now keep the peer session
        // looking like a freshly bootstrapped one for the idle collector.
        let new_id = uuid::Uuid::new_v4().to_string();
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.session_id = new_id.clone();
            ps.sidecar_port = 0;
            ps.message_count = 0;
            ps.last_active = Instant::now();
        }

        ulog_info!(
            "[im-router] Runtime drift: peer={} old={} → new={} desired={}",
            session_key,
            &old_id[..8.min(old_id.len())],
            &new_id[..8.min(new_id.len())],
            desired_runtime
        );

        Some((old_id, new_id))
    }

    pub async fn reset_session<R: Runtime>(
        &mut self,
        session_key: &str,
        _app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<String, String> {
        if let Some(ps) = self.peer_sessions.get(session_key) {
            let old_session_id = ps.session_id.clone();

            // Sidecar not running (restored from disk after app restart, or idle-collected).
            // Just reset session metadata; next message will start a fresh sidecar with the new ID.
            if ps.sidecar_port == 0 {
                let new_session_id = uuid::Uuid::new_v4().to_string();
                if let Some(ps) = self.peer_sessions.get_mut(session_key) {
                    ps.session_id = new_session_id.clone();
                    ps.message_count = 0;
                    ps.last_active = Instant::now();
                }
                return Ok(new_session_id);
            }

            let url = format!("http://127.0.0.1:{}/api/im/session/new", ps.sidecar_port);
            let resp = self
                .http_client
                .post(&url)
                .json(&json!({}))
                .send()
                .await
                .map_err(|e| format!("Reset session error: {}", e))?;

            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                let new_session_id = body["sessionId"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();

                // Upgrade Sidecar Manager key: old_session_id → new_session_id
                // So ensure_sidecar can find the running Sidecar by the new key
                {
                    let mut mgr = manager.lock().unwrap();
                    mgr.upgrade_session_id(&old_session_id, &new_session_id);
                }

                // Update peer session
                if let Some(ps) = self.peer_sessions.get_mut(session_key) {
                    ps.session_id = new_session_id.clone();
                    ps.message_count = 0;
                    ps.last_active = Instant::now();
                }

                return Ok(new_session_id);
            }
        }

        // No existing session — just return a new ID
        Ok(uuid::Uuid::new_v4().to_string())
    }

    /// Collect idle sessions that haven't been active for IDLE_TIMEOUT_SECS.
    /// Releases the Sidecar process but preserves the PeerSession (with port=0)
    /// so that the stable session_id can be reused for resume on next message.
    /// Returns the list of session_keys collected so callers can cancel any
    /// associated ImEventConsumer tasks (Pattern C lifecycle hook).
    pub fn collect_idle_sessions(&mut self, manager: &ManagedSidecarManager) -> Vec<String> {
        let now = Instant::now();
        let idle_keys: Vec<String> = self
            .peer_sessions
            .iter()
            .filter(|(_, ps)| {
                ps.sidecar_port > 0
                    && now.duration_since(ps.last_active).as_secs() >= IDLE_TIMEOUT_SECS
            })
            .map(|(k, _)| k.clone())
            .collect();

        for key in &idle_keys {
            if let Some(ps) = self.peer_sessions.get_mut(key) {
                ulog_info!(
                    "[im-router] Collecting idle session {} (inactive for {}s, preserving session_id={})",
                    key,
                    now.duration_since(ps.last_active).as_secs(),
                    &ps.session_id,
                );
                let owner = SidecarOwner::Agent(key.clone());
                let _ = release_session_sidecar(manager, &ps.session_id, &owner);
                ps.sidecar_port = 0; // Sidecar released, but session preserved for resume
            }
        }
        idle_keys
    }

    /// Get workspace path for a peer session (for attachment file saving).
    pub fn peer_session_workspace(&self, session_key: &str) -> Option<PathBuf> {
        self.peer_sessions
            .get(session_key)
            .map(|ps| ps.workspace_path.clone())
    }

    /// Get the default workspace path.
    pub fn default_workspace(&self) -> &PathBuf {
        &self.default_workspace
    }

    /// Find any active session with a running Sidecar.
    /// Returns (port, source_string, source_id) for cron tasks etc.
    /// Picks the most recently active session for deterministic behavior.
    pub fn find_any_active_session(&self) -> Option<(u16, String, String)> {
        self.peer_sessions
            .values()
            .filter(|ps| ps.sidecar_port > 0)
            .max_by_key(|ps| ps.last_active)
            .map(|ps| {
                (ps.sidecar_port, session_key_to_source_str(&ps.session_key), ps.source_id.clone())
            })
    }

    /// Find any peer session (regardless of sidecar status).
    /// Returns (session_key, source_string, source_id).
    /// Used by heartbeat/cron to find a session to wake up even if sidecar was idle-collected.
    /// Picks the most recently active session for deterministic behavior.
    pub fn find_any_peer_session(&self) -> Option<(String, String, String)> {
        self.peer_sessions
            .values()
            .filter(|ps| ps.source_type == ImSourceType::Private) // Skip groups for heartbeat
            .max_by_key(|ps| ps.last_active)
            .map(|ps| {
                (ps.session_key.clone(), session_key_to_source_str(&ps.session_key), ps.source_id.clone())
            })
    }

    /// Touch session activity timestamp to prevent idle collection.
    /// Called after heartbeat successfully uses a sidecar.
    pub fn touch_session_activity(&mut self, session_key: &str) {
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.last_active = Instant::now();
        }
    }

    // ===== Surface handover helpers (PRD 0.2.14) =====

    /// True if a peer_session entry exists for the given session_key.
    /// Used by `cmd_session_new_with_surface_migration` to find which channel
    /// owns a session_key without exposing the full HashMap.
    pub fn has_peer_session(&self, session_key: &str) -> bool {
        self.peer_sessions.contains_key(session_key)
    }

    /// Snapshot a peer_session for read-only inspection (e.g. capture
    /// `prior_session_id` before we overwrite the entry during handover).
    pub fn peer_session_snapshot(&self, session_key: &str) -> Option<PeerSession> {
        self.peer_sessions.get(session_key).cloned()
    }

    /// Insert-or-replace a peer_session — used by handover to redirect a
    /// channel binding to a new session_id. Caller is responsible for
    /// SidecarOwner accounting (release old, ensure new) — this method only
    /// touches the router's HashMap.
    pub fn upsert_peer_session(&mut self, ps: PeerSession) {
        self.peer_sessions.insert(ps.session_key.clone(), ps);
    }

    /// Pick the most-recently-active peer_session_key in this channel.
    /// Used as the handover target — preserves "talk to the same chat,
    /// different session backend" semantics.
    pub fn most_recent_peer_session_key(&self) -> Option<String> {
        self.peer_sessions
            .values()
            .max_by_key(|ps| ps.last_active)
            .map(|ps| ps.session_key.clone())
    }

    /// Iterate over the channel's peer_sessions (read-only). Used by the
    /// mirror endpoint (`/api/im/mirror`) to find which channel binds a given
    /// session_id without exposing the full HashMap.
    pub fn peer_sessions_iter(&self) -> impl Iterator<Item = &PeerSession> {
        self.peer_sessions.values()
    }

    /// Snapshot the set of peer_session_keys currently bound. Used by the
    /// runtime-change orchestrator (`runtime_change.rs`) to iterate without
    /// holding a borrow into the HashMap during async freeze HTTP calls.
    pub fn peer_session_keys(&self) -> Vec<String> {
        self.peer_sessions.keys().cloned().collect()
    }

    /// Get active peer session info (for health state)
    pub fn active_sessions(&self) -> Vec<super::types::ImActiveSession> {
        self.peer_sessions
            .values()
            .map(|ps| super::types::ImActiveSession {
                session_key: ps.session_key.clone(),
                session_id: ps.session_id.clone(),
                source_type: ps.source_type.clone(),
                workspace_path: ps.workspace_path.display().to_string(),
                message_count: ps.message_count,
                last_active: chrono::Utc::now().to_rfc3339(), // Approximate
            })
            .collect()
    }

    /// Restore peer sessions from persisted health state (startup recovery).
    /// Sidecar ports are set to 0 — the first message will trigger re-creation.
    ///
    /// Session IDs are restored from persisted state so Bun can resume the conversation
    /// via --session-id → SDK resume. This preserves IM conversation history across app restarts.
    ///
    /// Workspace is always set to the current `default_workspace` (from settings),
    /// NOT the persisted value. This ensures workspace changes take effect on restart.
    pub fn restore_sessions(&mut self, sessions: &[super::types::ImActiveSession]) {
        for s in sessions {
            // TD-2: Migrate session key format if router has agent_id but key uses legacy "im:" prefix.
            // Old keys: im:{platform}:{type}:{id} → new: agent:{agentId}:{platform}:{type}:{id}
            let session_key = if let Some(ref agent_id) = self.agent_id {
                if s.session_key.starts_with("im:") {
                    // Translate: im:{platform}:{type}:{id} → agent:{agentId}:{platform}:{type}:{id}
                    let rest = s.session_key.strip_prefix("im:").unwrap_or(&s.session_key);
                    let migrated = format!("agent:{}:{}", agent_id, rest);
                    ulog_info!(
                        "[im-router] Migrated session key: {} → {}",
                        s.session_key, migrated
                    );
                    migrated
                } else {
                    s.session_key.clone()
                }
            } else {
                s.session_key.clone()
            };
            let (source_type, source_id) = parse_session_key(&session_key);
            self.peer_sessions.insert(
                session_key.clone(),
                PeerSession {
                    session_key: session_key.clone(),
                    session_id: s.session_id.clone(), // Restore original session_id for resume
                    sidecar_port: 0, // Sidecar not running yet; ensure_sidecar will start it
                    workspace_path: self.default_workspace.clone(),
                    source_type,
                    source_id,
                    message_count: s.message_count,
                    last_active: Instant::now(),
                },
            );
        }
        if !sessions.is_empty() {
            ulog_info!(
                "[im-router] Restored {} peer session(s) from previous run (workspace={})",
                sessions.len(),
                self.default_workspace.display(),
            );
        }
    }

    /// Get all unique active Sidecar ports (for hot-reload config broadcast).
    pub fn active_sidecar_ports(&self) -> Vec<u16> {
        let mut seen = std::collections::HashSet::new();
        self.peer_sessions
            .values()
            .filter(|ps| ps.sidecar_port > 0)
            .filter_map(|ps| {
                if seen.insert(ps.sidecar_port) {
                    Some(ps.sidecar_port)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Update default workspace path (hot-reload, only affects new sessions).
    pub fn set_default_workspace(&mut self, path: PathBuf) {
        self.default_workspace = path;
    }

    /// Sync AI config (model + MCP + provider) to a newly created Sidecar.
    /// Called after ensure_sidecar returns is_new=true.
    pub async fn sync_ai_config(
        &self,
        port: u16,
        runtime: &str,
        runtime_config: Option<&serde_json::Value>,
        model: Option<&str>,
        mcp_servers_json: Option<&str>,
        provider_env: Option<&serde_json::Value>,
    ) {
        if matches!(runtime, "codex" | "claude-code" | "gemini") {
            let runtime_model = runtime_config
                .and_then(|v| v.get("model"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("(default)");
            ulog_info!(
                "[im-router] Runtime {} owns provider/model/MCP, skipped Builtin config sync to port {} (runtimeModel={})",
                runtime,
                port,
                runtime_model
            );
            return;
        }

        // 1. Provider env (sync BEFORE model so pre-warm uses the correct provider)
        if let Some(penv) = provider_env {
            let url = format!("http://127.0.0.1:{}/api/provider/set", port);
            match self.http_client.post(&url).json(&json!({ "providerEnv": penv })).send().await {
                Ok(_) => ulog_info!("[im-router] Synced provider env to port {}", port),
                Err(e) => ulog_warn!("[im-router] Failed to sync provider env to port {}: {}", port, e),
            }
        }

        // 2. Model
        if let Some(model_id) = model {
            let url = format!("http://127.0.0.1:{}/api/model/set", port);
            match self.http_client.post(&url).json(&json!({ "model": model_id })).send().await {
                Ok(_) => ulog_info!("[im-router] Synced model {} to port {}", model_id, port),
                Err(e) => ulog_warn!("[im-router] Failed to sync model to port {}: {}", port, e),
            }
        }

        // 3. MCP servers
        if let Some(mcp_json) = mcp_servers_json {
            if let Ok(servers) = serde_json::from_str::<Vec<serde_json::Value>>(mcp_json) {
                let url = format!("http://127.0.0.1:{}/api/mcp/set", port);
                match self.http_client.post(&url).json(&json!({ "servers": servers })).send().await {
                    Ok(_) => ulog_info!("[im-router] Synced {} MCP server(s) to port {}", servers.len(), port),
                    Err(e) => ulog_warn!("[im-router] Failed to sync MCP to port {}: {}", port, e),
                }
            }
        }
    }

    /// Get a reference to the HTTP client (for callers that need to sync config outside the lock).
    pub fn http_client(&self) -> &Client {
        &self.http_client
    }

    /// Static version of sync_ai_config — takes an explicit HTTP client instead of &self.
    /// Used by heartbeat to sync config WITHOUT holding the router lock.
    pub async fn sync_ai_config_with_client(
        client: &Client,
        port: u16,
        runtime: &str,
        runtime_config: Option<&serde_json::Value>,
        model: Option<&str>,
        mcp_servers_json: Option<&str>,
        provider_env: Option<&serde_json::Value>,
    ) {
        if matches!(runtime, "codex" | "claude-code" | "gemini") {
            let runtime_model = runtime_config
                .and_then(|v| v.get("model"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("(default)");
            ulog_info!(
                "[im-router] Runtime {} owns provider/model/MCP, skipped Builtin config sync to port {} (runtimeModel={})",
                runtime,
                port,
                runtime_model
            );
            return;
        }

        if let Some(penv) = provider_env {
            let url = format!("http://127.0.0.1:{}/api/provider/set", port);
            match client.post(&url).json(&json!({ "providerEnv": penv })).send().await {
                Ok(_) => ulog_info!("[im-router] Synced provider env to port {}", port),
                Err(e) => ulog_warn!("[im-router] Failed to sync provider env to port {}: {}", port, e),
            }
        }
        if let Some(model_id) = model {
            let url = format!("http://127.0.0.1:{}/api/model/set", port);
            match client.post(&url).json(&json!({ "model": model_id })).send().await {
                Ok(_) => ulog_info!("[im-router] Synced model {} to port {}", model_id, port),
                Err(e) => ulog_warn!("[im-router] Failed to sync model to port {}: {}", port, e),
            }
        }
        if let Some(mcp_json) = mcp_servers_json {
            if let Ok(servers) = serde_json::from_str::<Vec<serde_json::Value>>(mcp_json) {
                let url = format!("http://127.0.0.1:{}/api/mcp/set", port);
                match client.post(&url).json(&json!({ "servers": servers })).send().await {
                    Ok(_) => ulog_info!("[im-router] Synced {} MCP server(s) to port {}", servers.len(), port),
                    Err(e) => ulog_warn!("[im-router] Failed to sync MCP to port {}: {}", port, e),
                }
            }
        }
    }

    /// Sync permission mode to a Sidecar.
    pub async fn sync_permission_mode(&self, port: u16, mode: &str) {
        let url = format!("http://127.0.0.1:{}/api/session/permission-mode", port);
        match self.http_client.post(&url).json(&json!({ "permissionMode": mode })).send().await {
            Ok(_) => ulog_info!("[im-router] Synced permission mode '{}' to port {}", mode, port),
            Err(e) => ulog_warn!("[im-router] Failed to sync permission mode to port {}: {}", port, e),
        }
    }

    /// Release all sessions and DROP the peer→session binding map.
    ///
    /// **Destructive.** Use only when the bot itself is being torn down
    /// (`shutdown_bot_instance`) — after this call, `peer_sessions` is empty,
    /// so any handover / message-routing / `most_recent_peer_session_key`
    /// lookup will treat the channel as if it had never seen a chat. For
    /// hot-reload paths that just need sidecars to restart (e.g. runtime
    /// switch), use [`Self::release_all_sidecars_preserve_bindings`] instead.
    pub fn release_all(&mut self, manager: &ManagedSidecarManager) {
        let count = self.peer_sessions.len();
        let keys: Vec<String> = self.peer_sessions.keys().cloned().collect();
        for key in keys {
            if let Some(ps) = self.peer_sessions.remove(&key) {
                let owner = SidecarOwner::Agent(key);
                let _ = release_session_sidecar(manager, &ps.session_id, &owner);
            }
        }
        if count > 0 {
            ulog_info!(
                "[im-router] release_all: dropped {} peer_session(s) and released their sidecars",
                count,
            );
        }
    }

    /// Release running Sidecars but PRESERVE the peer→session bindings.
    ///
    /// Used by hot-reload paths where the next IM message must spawn a fresh
    /// Sidecar (e.g. runtime change from `builtin` → `claude-code`), but the
    /// channel→chat binding must survive so handover / message routing /
    /// `/new` resume keep working. Each entry's `sidecar_port` is zeroed —
    /// `prepare_ensure_sidecar` will see the existing peer_session and re-mint
    /// the Sidecar on the next dispatch, reusing the same `session_id` so the
    /// SDK conversation resumes seamlessly.
    pub fn release_all_sidecars_preserve_bindings(&mut self, manager: &ManagedSidecarManager) {
        let mut released = 0_usize;
        let keys: Vec<String> = self.peer_sessions.keys().cloned().collect();
        for key in keys {
            if let Some(ps) = self.peer_sessions.get_mut(&key) {
                let owner = SidecarOwner::Agent(key.clone());
                let _ = release_session_sidecar(manager, &ps.session_id, &owner);
                ps.sidecar_port = 0;
                released += 1;
            }
        }
        if released > 0 {
            ulog_info!(
                "[im-router] Released {} sidecar(s); {} peer_session binding(s) preserved for resume",
                released,
                self.peer_sessions.len(),
            );
        }
    }
}

/// Derive source string (e.g. "telegram_private") from session key.
fn session_key_to_source_str(session_key: &str) -> String {
    if session_key.contains("telegram") && session_key.contains("private") {
        "telegram_private".to_string()
    } else if session_key.contains("telegram") && session_key.contains("group") {
        "telegram_group".to_string()
    } else if session_key.contains("feishu") && session_key.contains("private") {
        "feishu_private".to_string()
    } else if session_key.contains("feishu") && session_key.contains("group") {
        "feishu_group".to_string()
    } else {
        "telegram_private".to_string()
    }
}

/// Parse session key into (source_type, source_id)
/// Supports both legacy and new format:
///   Legacy: im:{platform}:{private|group}:{id}
///   New:    agent:{agentId}:{channelType}:{private|group}:{id}
///
/// NOTE: Both channelType AND source_id may contain colons:
///   - channelType: "openclaw:feishu" (OpenClaw plugin names)
///   - source_id:   "group:abc123"    (DingTalk group chat IDs)
/// We search FORWARD from the platform start position for the FIRST
/// "private"/"group" token, since platform names never contain these words
/// while source_id may (e.g. DingTalk "group:{openConversationId}").
pub fn parse_session_key(session_key: &str) -> (ImSourceType, String) {
    let parts: Vec<&str> = session_key.split(':').collect();

    // Determine where to start searching (skip fixed prefix fields)
    let search_start = if parts.len() >= 5 && parts[0] == "agent" {
        2 // agent:{agentId}: — platform starts at index 2
    } else if parts.len() >= 4 {
        1 // im: — platform starts at index 1
    } else {
        return (ImSourceType::Private, session_key.to_string());
    };

    // Find the FIRST "private" or "group" after the prefix — this is the source_type marker.
    // Platform names (telegram, feishu, dingtalk, openclaw:xxx) don't contain these words.
    if let Some(rel_pos) = parts[search_start..].iter().position(|p| *p == "private" || *p == "group") {
        let abs_pos = search_start + rel_pos;
        let source_type = match parts[abs_pos] {
            "group" => ImSourceType::Group,
            _ => ImSourceType::Private,
        };
        let source_id = parts[abs_pos + 1..].join(":");
        (source_type, source_id)
    } else {
        (ImSourceType::Private, session_key.to_string())
    }
}
