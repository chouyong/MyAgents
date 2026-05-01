//! Read the current git branch name for the workspace.
//!
//! Mirrors sidecar `getGitBranch(cwd)` which shells out to
//! `git rev-parse --abbrev-ref HEAD`. Non-fatal — workspace not being a git
//! repo / git not on PATH both return `None` instead of bubbling errors.

use std::path::Path;

use serde::Serialize;

use super::path_safety::validate_workspace_root;
use crate::process_cmd;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchResult {
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn cmd_workspace_git_branch(workspace: String) -> Result<GitBranchResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let ws = workspace_root.clone();
    let branch = tokio::task::spawn_blocking(move || run_git_branch(&ws))
        .await
        .map_err(|e| format!("git branch task failed: {}", e))?;
    Ok(GitBranchResult { branch })
}

fn run_git_branch(cwd: &Path) -> Option<String> {
    let output = process_cmd::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(cwd)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    #[tokio::test]
    async fn returns_none_for_non_git_dir() {
        let ws = make_test_workspace("git_branch_none");
        let res = cmd_workspace_git_branch(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(res.branch.is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    // Returning a real branch requires running `git init`; we skip that to
    // keep the test runner free of git side-effects. The non-git case
    // exercises the error-tolerance path which is the more interesting bit.
}
