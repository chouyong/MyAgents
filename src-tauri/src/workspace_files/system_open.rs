//! "Open in Finder/Explorer" + "Open with default app".
//!
//! Both fire-and-forget — the spawned command's stdout/stderr is dropped
//! deliberately so we don't block the IPC reply. Rust `process_cmd::new` is
//! used (not raw `std::process::Command`) so Windows builds suppress the
//! console-window flash per the CLAUDE.md red-line.

use std::path::Path;

use serde::Serialize;

use super::path_safety::{resolve_inside_workspace, validate_workspace_root};
use crate::process_cmd;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOpenResult {
    pub success: bool,
}

#[tauri::command]
pub async fn cmd_workspace_open_in_finder(
    workspace: String,
    path: String,
) -> Result<SystemOpenResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let target = resolve_inside_workspace(&workspace_root, path.trim())?;
    if !target.exists() {
        return Err("File or folder not found".to_string());
    }
    spawn_reveal(&target)?;
    Ok(SystemOpenResult { success: true })
}

#[tauri::command]
pub async fn cmd_workspace_open_with_default(
    workspace: String,
    path: String,
) -> Result<SystemOpenResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let target = resolve_inside_workspace(&workspace_root, path.trim())?;
    if !target.exists() {
        return Err("File not found".to_string());
    }
    spawn_default_open(&target)?;
    Ok(SystemOpenResult { success: true })
}

#[cfg(target_os = "macos")]
fn spawn_reveal(target: &Path) -> Result<(), String> {
    process_cmd::new("open")
        .arg("-R")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open -R failed: {}", e))
}

#[cfg(target_os = "windows")]
fn spawn_reveal(target: &Path) -> Result<(), String> {
    process_cmd::new("explorer")
        .arg("/select,")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("explorer /select failed: {}", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_reveal(target: &Path) -> Result<(), String> {
    let parent = target.parent().unwrap_or(target);
    process_cmd::new("xdg-open")
        .arg(parent)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open failed: {}", e))
}

#[cfg(target_os = "macos")]
fn spawn_default_open(target: &Path) -> Result<(), String> {
    process_cmd::new("open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open failed: {}", e))
}

#[cfg(target_os = "windows")]
fn spawn_default_open(target: &Path) -> Result<(), String> {
    // PowerShell `Start-Process` avoids `cmd /c` interpreting & | > as
    // command operators when filenames contain them. Single-quote-escape
    // single quotes in the path before interpolation.
    let escaped = target.to_string_lossy().replace('\'', "''");
    process_cmd::new("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(format!("Start-Process -FilePath '{}'", escaped))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("powershell Start-Process failed: {}", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_default_open(target: &Path) -> Result<(), String> {
    process_cmd::new("xdg-open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    #[tokio::test]
    async fn rejects_missing_target() {
        let ws = make_test_workspace("system_open_missing");
        let res = cmd_workspace_open_with_default(
            ws.to_string_lossy().to_string(),
            "nope.txt".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_test_workspace("system_open_traversal");
        let res = cmd_workspace_open_with_default(
            ws.to_string_lossy().to_string(),
            "../etc/hosts".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // We don't actually invoke the spawn — that'd open a Finder window from
    // the test runner. The validation paths above cover the safety surface.
}
