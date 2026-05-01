//! `.gitignore` pattern injection.
//!
//! Used right after `myagents_files/` is populated to ensure the imported
//! attachments don't get committed by mistake. Idempotent: if the pattern
//! already matches a line, we no-op.
//!
//! Concurrency: the read-then-append flow goes through `with_file_lock_blocking`
//! per CLAUDE.md red-line rule "单写者文件裸 append / read-modify-write —
//! 应用内多 owner race". Concrete race we've already paid for elsewhere: drag-drop
//! upload + cron tick + sidecar's `enqueueUserMessage` modality fallback all hit
//! the same `.gitignore`. Lock makes the idempotency check atomic.

use std::fs;
use std::io::Write;
use std::time::Duration;

use serde::Serialize;

use crate::utils::file_lock::{with_file_lock_blocking, FileLockOptions};

use super::path_safety::validate_workspace_root;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreResult {
    pub success: bool,
    pub added: bool,
    pub reason: String,
}

#[tauri::command]
pub async fn cmd_workspace_add_gitignore(
    workspace: String,
    pattern: String,
) -> Result<GitignoreResult, String> {
    if pattern.trim().is_empty() {
        return Err("pattern is required".to_string());
    }

    let workspace_root = validate_workspace_root(&workspace)?;
    let gitignore_path = workspace_root.join(".gitignore");
    let lock_path = workspace_root.join(".gitignore.lock");

    // Lock + read-modify-write under `spawn_blocking` so the (fs-bound) lock
    // wait doesn't peg the async runtime. Mirrors `config_io.rs` pattern.
    tokio::task::spawn_blocking(move || -> Result<GitignoreResult, String> {
        with_file_lock_blocking(
            &lock_path,
            FileLockOptions {
                timeout: Duration::from_secs(5),
                ..Default::default()
            },
            || apply_gitignore_pattern(&gitignore_path, &pattern),
        )
        .map_err(|e| format!("Failed to lock .gitignore: {}", e))
    })
    .await
    .map_err(|e| format!("gitignore task join failed: {}", e))?
}

fn apply_gitignore_pattern(
    gitignore_path: &std::path::Path,
    pattern: &str,
) -> Result<GitignoreResult, crate::utils::file_lock::FileLockError> {
    use crate::utils::file_lock::FileLockError;
    if !gitignore_path.exists() {
        fs::write(gitignore_path, format!("{}\n", pattern)).map_err(FileLockError::Io)?;
        return Ok(GitignoreResult {
            success: true,
            added: true,
            reason: "created new .gitignore".to_string(),
        });
    }

    let existing = fs::read_to_string(gitignore_path).map_err(FileLockError::Io)?;
    let trimmed = pattern.trim();
    if existing.lines().any(|l| l.trim() == trimmed) {
        return Ok(GitignoreResult {
            success: true,
            added: false,
            reason: "pattern already exists".to_string(),
        });
    }

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(gitignore_path)
        .map_err(FileLockError::Io)?;
    let prefix = if existing.ends_with('\n') { "" } else { "\n" };
    writeln!(file, "{}{}", prefix, pattern).map_err(FileLockError::Io)?;

    Ok(GitignoreResult {
        success: true,
        added: true,
        reason: "appended".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::path::PathBuf;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("gitignore")
    }

    #[tokio::test]
    async fn creates_when_missing() {
        let ws = make_tmp_workspace();
        let res = cmd_workspace_add_gitignore(
            ws.to_string_lossy().to_string(),
            "myagents_files/".to_string(),
        )
        .await
        .unwrap();
        assert!(res.added);
        assert_eq!(
            fs::read_to_string(ws.join(".gitignore")).unwrap(),
            "myagents_files/\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn idempotent_when_pattern_present() {
        let ws = make_tmp_workspace();
        fs::write(ws.join(".gitignore"), "myagents_files/\nnode_modules\n").unwrap();
        let res = cmd_workspace_add_gitignore(
            ws.to_string_lossy().to_string(),
            "myagents_files/".to_string(),
        )
        .await
        .unwrap();
        assert!(!res.added);
        assert_eq!(
            fs::read_to_string(ws.join(".gitignore")).unwrap(),
            "myagents_files/\nnode_modules\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn appends_when_no_trailing_newline() {
        let ws = make_tmp_workspace();
        fs::write(ws.join(".gitignore"), "node_modules").unwrap();
        let res = cmd_workspace_add_gitignore(
            ws.to_string_lossy().to_string(),
            "myagents_files/".to_string(),
        )
        .await
        .unwrap();
        assert!(res.added);
        assert_eq!(
            fs::read_to_string(ws.join(".gitignore")).unwrap(),
            "node_modules\nmyagents_files/\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_empty_pattern() {
        let ws = make_tmp_workspace();
        let res =
            cmd_workspace_add_gitignore(ws.to_string_lossy().to_string(), "  ".to_string()).await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
