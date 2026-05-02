//! Batch existence check for workspace-relative paths.
//!
//! Mirrors the sidecar `/agent/check-paths` endpoint: takes an array of
//! workspace-relative paths and returns a `{ exists, type }` map. Used by
//! `FileActionContext` to decorate inline-code path mentions in AI output
//! (turn `<code>src/foo.ts</code>` into a clickable preview affordance only
//! when the file actually exists).
//!
//! # Why we mirror the sidecar shape
//!
//! `FileActionContext` already coalesces calls into a 50ms batch + a 200-path
//! cap. We keep the same `Record<string, {exists, type}>` shape so the
//! renderer side is a one-line wiring change.
//!
//! # Path checks
//!
//! Bad inputs (empty string, traversal escape, non-existent) collapse to
//! `{ exists: false, type: 'file' }` rather than erroring the whole batch —
//! matches the sidecar fallback so a single bad path doesn't poison the
//! cache for the others.
//!
//! `Path::exists()` is sufficient here: we only need to know "is there any
//! directory entry at this resolved path" — broken-symlink false-negative is
//! actually the *desired* behavior (a broken symlink shouldn't get a clickable
//! preview affordance). For the destructive-operation pit-of-success rule
//! we use `symlink_metadata` (see `crud.rs::slot_occupied`); this is the
//! read-only / preview side and the policies are different.

use std::collections::HashMap;
use std::fs;

use serde::Serialize;

use super::path_safety::{resolve_inside_workspace, validate_workspace_root};

/// Hard cap on inputs — matches sidecar `/agent/check-paths` (200) so a typo
/// in renderer code can't fan out an unbounded `stat()` storm.
const MAX_BATCH_SIZE: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub exists: bool,
    /// "file" | "dir" — defaults to "file" for not-found / invalid entries
    /// to mirror the sidecar's fallback shape.
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckPathsResult {
    /// Map preserves the input order of distinct paths via insertion order
    /// (HashMap is fine here — the renderer keys lookups by path string).
    pub results: HashMap<String, PathInfo>,
}

#[tauri::command]
pub async fn cmd_workspace_check_paths(
    workspace: String,
    paths: Vec<String>,
) -> Result<CheckPathsResult, String> {
    if paths.len() > MAX_BATCH_SIZE {
        return Err(format!("Too many paths (max {}).", MAX_BATCH_SIZE));
    }
    let workspace_root = validate_workspace_root(&workspace)?;

    let mut results: HashMap<String, PathInfo> = HashMap::with_capacity(paths.len());
    for raw in paths {
        let info = check_one(&workspace_root, &raw);
        results.insert(raw, info);
    }
    Ok(CheckPathsResult { results })
}

fn check_one(workspace_root: &std::path::Path, raw: &str) -> PathInfo {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return PathInfo {
            exists: false,
            kind: "file".to_string(),
        };
    }
    let resolved = match resolve_inside_workspace(workspace_root, trimmed) {
        Ok(p) => p,
        Err(_) => {
            return PathInfo {
                exists: false,
                kind: "file".to_string(),
            }
        }
    };
    match fs::metadata(&resolved) {
        Ok(m) if m.is_dir() => PathInfo {
            exists: true,
            kind: "dir".to_string(),
        },
        Ok(_) => PathInfo {
            exists: true,
            kind: "file".to_string(),
        },
        Err(_) => PathInfo {
            exists: false,
            kind: "file".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    #[tokio::test]
    async fn returns_correct_kinds() {
        let ws = make_test_workspace("check_paths_kinds");
        fs::write(ws.join("a.txt"), "x").unwrap();
        fs::create_dir_all(ws.join("b")).unwrap();
        let res = cmd_workspace_check_paths(
            ws.to_string_lossy().to_string(),
            vec!["a.txt".to_string(), "b".to_string(), "missing".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(res.results.get("a.txt").unwrap().exists, true);
        assert_eq!(res.results.get("a.txt").unwrap().kind, "file");
        assert_eq!(res.results.get("b").unwrap().exists, true);
        assert_eq!(res.results.get("b").unwrap().kind, "dir");
        assert_eq!(res.results.get("missing").unwrap().exists, false);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn traversal_collapses_to_not_found() {
        let ws = make_test_workspace("check_paths_traversal");
        let res = cmd_workspace_check_paths(
            ws.to_string_lossy().to_string(),
            vec!["../etc/hosts".to_string(), "/etc/passwd".to_string()],
        )
        .await
        .unwrap();
        // Both invalid → exists:false, no error surfaced (mirrors sidecar).
        assert_eq!(
            res.results.get("../etc/hosts").unwrap().exists,
            false
        );
        assert_eq!(res.results.get("/etc/passwd").unwrap().exists, false);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn empty_batch_is_ok() {
        let ws = make_test_workspace("check_paths_empty");
        let res = cmd_workspace_check_paths(
            ws.to_string_lossy().to_string(),
            vec![],
        )
        .await
        .unwrap();
        assert!(res.results.is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_oversized_batch() {
        let ws = make_test_workspace("check_paths_too_many");
        let paths: Vec<String> = (0..MAX_BATCH_SIZE + 1)
            .map(|i| format!("p{}", i))
            .collect();
        let res = cmd_workspace_check_paths(
            ws.to_string_lossy().to_string(),
            paths,
        )
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("max"));
        let _ = fs::remove_dir_all(&ws);
    }

    // Empty / whitespace-only path → exists:false (matches sidecar "skip" path
    // for `if (typeof p !== 'string' || !p)`).
    #[tokio::test]
    async fn empty_string_path_is_not_found() {
        let ws = make_test_workspace("check_paths_empty_str");
        let res = cmd_workspace_check_paths(
            ws.to_string_lossy().to_string(),
            vec!["".to_string(), "  ".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(res.results.get("").unwrap().exists, false);
        assert_eq!(res.results.get("  ").unwrap().exists, false);
        let _ = fs::remove_dir_all(&ws);
    }

    // The renderer uses the input path string as a cache key, so even though
    // paths internally normalize, the response MUST echo the keys verbatim.
    #[tokio::test]
    async fn response_keys_echo_input() {
        let ws = make_test_workspace("check_paths_echo");
        fs::write(ws.join("a.txt"), "").unwrap();
        let res = cmd_workspace_check_paths(
            ws.to_string_lossy().to_string(),
            vec!["a.txt".to_string()],
        )
        .await
        .unwrap();
        assert!(res.results.contains_key("a.txt"));
        let _ = fs::remove_dir_all(&ws);
    }
}
