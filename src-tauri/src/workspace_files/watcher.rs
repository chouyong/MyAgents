//! Workspace filesystem watcher.
//!
//! DirectoryPanel needs to refresh its tree when the user / AI / external
//! tool mutates files in the workspace. Pre-PRD-0.2.7 the sidecar emitted an
//! SSE `agent:files-changed` event from a Node `chokidar` watcher; PRD 0.2.7
//! Phase D moves the watch to Rust so the panel doesn't depend on a sidecar
//! being alive.
//!
//! # Reference counting
//!
//! Multiple Tabs / panels can be open against the same workspace. We keep
//! exactly one OS-level watcher per workspace path and ref-count starts/stops
//! so the resource is released when the last consumer goes away. Mirrors how
//! `search/watcher.rs` runs as a single per-process watcher (we just generalize
//! to per-workspace).
//!
//! # Event shape
//!
//! Each fired event is a Tauri event named `workspace:files-changed:<hash>`
//! where `<hash>` is `WORKSPACE_KEY_PREFIX + sha-like(workspace_path)`. The
//! frontend hashes the same way and listens to its own workspace's stream;
//! this avoids quoting / escaping the raw path inside the event name string.
//!
//! # Debouncing
//!
//! Same 5s sliding window as the session watcher. DirectoryPanel adds its
//! own 300ms debounce on top so a burst of events still produces only one
//! tree refresh.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer, FileIdMap,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{ulog_info, ulog_warn};

use super::path_safety::validate_workspace_root;

const DEBOUNCE_WINDOW: Duration = Duration::from_secs(5);

/// Tauri State entry — a process-wide registry of active workspace watchers.
/// `Mutex` is fine here: start/stop are rare (Tab open/close), the lock is
/// only held briefly to mutate the registry.
#[derive(Default)]
pub struct WorkspaceWatchers {
    inner: Mutex<HashMap<String, WatcherEntry>>,
}

struct WatcherEntry {
    /// Ref-count of frontend consumers. The last `stop` drops the entry.
    refs: usize,
    /// Holding the debouncer alive keeps the watch active. Dropping it stops
    /// the OS-level watch.
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
}

/// Compute the stable event-key suffix for a workspace path. Uses
/// `DefaultHasher` (FxHash-equivalent) — we don't need cryptographic strength,
/// just a consistent string that's safe to embed in a Tauri event name.
pub fn event_key_for_workspace(workspace_path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    workspace_path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
pub async fn cmd_workspace_watch_start(
    workspace: String,
    app: AppHandle,
    state: tauri::State<'_, Arc<WorkspaceWatchers>>,
) -> Result<(), String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let key = event_key_for_workspace(&workspace_root.to_string_lossy());
    let mut guard = state.inner.lock().map_err(|e| format!("lock: {}", e))?;

    if let Some(entry) = guard.get_mut(&key) {
        entry.refs += 1;
        return Ok(());
    }

    // Spin up a new debouncer. Channel sends DebounceEventResult; spawn a
    // dedicated thread to drain it so the Tauri runtime stays responsive.
    let (tx, rx) = std::sync::mpsc::channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(DEBOUNCE_WINDOW, None, tx)
        .map_err(|e| format!("create debouncer failed: {}", e))?;
    debouncer
        .watch(&workspace_root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch workspace failed: {}", e))?;

    let app_clone = app.clone();
    let event_name = format!("workspace:files-changed:{}", key);
    let workspace_path_str = workspace_root.to_string_lossy().to_string();
    std::thread::Builder::new()
        .name(format!("ws-watcher:{}", &key[..8]))
        .spawn(move || {
            for result in rx {
                match result {
                    Ok(_events) => {
                        // Coarse signal — frontend re-fetches the tree on its
                        // own. Keeping the payload minimal avoids serializing
                        // change-event metadata that the panel ignores.
                        if let Err(e) = app_clone.emit(&event_name, &workspace_path_str) {
                            ulog_warn!(
                                "[workspace_files::watcher] emit failed for {}: {}",
                                event_name,
                                e
                            );
                        }
                    }
                    Err(errors) => {
                        for e in errors {
                            ulog_warn!("[workspace_files::watcher] event error: {}", e);
                        }
                    }
                }
            }
        })
        .map_err(|e| format!("spawn watcher thread failed: {}", e))?;

    ulog_info!(
        "[workspace_files::watcher] started for {} (key={})",
        workspace_root.display(),
        key
    );

    guard.insert(
        key,
        WatcherEntry {
            refs: 1,
            _debouncer: debouncer,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_workspace_watch_stop(
    workspace: String,
    state: tauri::State<'_, Arc<WorkspaceWatchers>>,
) -> Result<(), String> {
    // workspace may have been deleted out from under us; lookup by path is
    // best-effort. Use the resolved path if validation passes, fall back to
    // the raw input so we can still drop a stale registry entry.
    let key = match validate_workspace_root(&workspace) {
        Ok(p) => event_key_for_workspace(&p.to_string_lossy()),
        Err(_) => event_key_for_workspace(&workspace),
    };
    let mut guard = state.inner.lock().map_err(|e| format!("lock: {}", e))?;
    if let Some(entry) = guard.get_mut(&key) {
        if entry.refs > 1 {
            entry.refs -= 1;
        } else {
            // Drop the entry — the debouncer's Drop tears down the OS watch.
            guard.remove(&key);
            ulog_info!("[workspace_files::watcher] stopped (key={})", key);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_workspace_watch_event_key(workspace: String) -> Result<String, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    Ok(event_key_for_workspace(&workspace_root.to_string_lossy()))
}

/// Register the watcher state into the Tauri builder. Called once from `lib.rs`.
pub fn register(app: &AppHandle) {
    if app.try_state::<Arc<WorkspaceWatchers>>().is_none() {
        app.manage::<Arc<WorkspaceWatchers>>(Arc::new(WorkspaceWatchers::default()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_key_is_deterministic() {
        let k1 = event_key_for_workspace("/Users/alice/proj");
        let k2 = event_key_for_workspace("/Users/alice/proj");
        assert_eq!(k1, k2);
        let k3 = event_key_for_workspace("/Users/alice/other");
        assert_ne!(k1, k3);
    }

    #[test]
    fn event_key_is_hex_16chars() {
        let k = event_key_for_workspace("any-path");
        assert_eq!(k.len(), 16);
        assert!(k.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
