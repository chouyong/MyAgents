//! Workspace directory tree — initial walk + lazy expand.
//!
//! Mirrors the sidecar `dir-info.ts::buildDirectoryTree` / `expandDirectory`
//! contract bit-for-bit so the existing DirectoryPanel React tree model
//! consumes the same shape from Rust as it did from `/agent/dir`. Caps come
//! from the same place too — the comment-heavy rationale at
//! `src/server/dir-info.ts:27-49` explains why depth=4 / entries=10000 is the
//! initial-walk sweet spot; we duplicate that here as constants rather than
//! letting the frontend pass arbitrary numbers (security defense).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::path_safety::{resolve_inside_workspace, validate_workspace_root};

const DEFAULT_TREE_MAX_DEPTH: usize = 4;
const DEFAULT_TREE_MAX_ENTRIES: usize = 10_000;
const DEFAULT_EXPAND_MAX_DEPTH: usize = 3;
const DEFAULT_EXPAND_MAX_ENTRIES: usize = 1_000;

/// Default ignore set — must match `dir-info.ts::DEFAULT_IGNORES` so a
/// directory hidden in chat-tab is also hidden in launcher.
fn default_ignores() -> HashSet<&'static str> {
    let mut set = HashSet::new();
    set.insert(".git");
    set.insert("node_modules");
    set.insert("out");
    set.insert("dist");
    set.insert("tmp");
    set
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryTreeNode {
    /// Stable id — relative path from workspace root, "root" for top.
    pub id: String,
    pub name: String,
    pub path: String,
    /// "file" | "dir"
    #[serde(rename = "type")]
    pub kind: NodeKind,
    /// Only set when kind == Dir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<DirectoryTreeNode>>,
    /// `false` = directory not fully loaded due to depth/entry caps; UI shows
    /// expand affordance. `true` (or omitted) = fully loaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loaded: Option<bool>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Dir,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryTreeSummary {
    pub total_files: usize,
    pub total_dirs: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryTreeResult {
    pub root: String,
    pub summary: DirectoryTreeSummary,
    pub tree: DirectoryTreeNode,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExpandDirectoryResult {
    pub children: Vec<DirectoryTreeNode>,
    pub loaded: bool,
}

#[tauri::command]
pub async fn cmd_workspace_dir_tree(
    workspace: String,
) -> Result<DirectoryTreeResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let ws = workspace_root.clone();
    tokio::task::spawn_blocking(move || build_tree(&ws))
        .await
        .map_err(|e| format!("dir tree task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_workspace_dir_expand(
    workspace: String,
    path: String,
) -> Result<ExpandDirectoryResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let target = resolve_inside_workspace(&workspace_root, &path)?;
    let ws = workspace_root.clone();
    let target_clone = target.clone();
    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || expand_dir(&ws, &target_clone, &path_clone))
        .await
        .map_err(|e| format!("dir expand task failed: {}", e))?
}

fn build_tree(root: &Path) -> Result<DirectoryTreeResult, String> {
    let mut state = WalkState {
        max_depth: DEFAULT_TREE_MAX_DEPTH,
        max_entries: DEFAULT_TREE_MAX_ENTRIES,
        ignores: default_ignores(),
        entries_count: 0,
        truncated: false,
        total_files: 0,
        total_dirs: 0,
    };
    let tree = walk_dir(root, root, "", 0, &mut state);
    Ok(DirectoryTreeResult {
        root: root.to_string_lossy().to_string(),
        summary: DirectoryTreeSummary {
            total_files: state.total_files,
            total_dirs: state.total_dirs,
        },
        tree: DirectoryTreeNode {
            id: "root".to_string(),
            name: ".".to_string(),
            path: String::new(),
            kind: NodeKind::Dir,
            children: tree.children,
            loaded: tree.loaded,
        },
        truncated: state.truncated,
    })
}

fn expand_dir(
    root: &Path,
    target: &Path,
    target_relative: &str,
) -> Result<ExpandDirectoryResult, String> {
    let mut state = WalkState {
        max_depth: DEFAULT_EXPAND_MAX_DEPTH,
        max_entries: DEFAULT_EXPAND_MAX_ENTRIES,
        ignores: default_ignores(),
        entries_count: 0,
        truncated: false,
        total_files: 0,
        total_dirs: 0,
    };
    let walked = walk_dir(root, target, target_relative, 0, &mut state);
    let loaded_flag = walked.loaded.unwrap_or(true);
    Ok(ExpandDirectoryResult {
        children: walked.children.unwrap_or_default(),
        loaded: !state.truncated && loaded_flag,
    })
}

struct WalkState<'a> {
    max_depth: usize,
    max_entries: usize,
    ignores: HashSet<&'a str>,
    entries_count: usize,
    truncated: bool,
    total_files: usize,
    total_dirs: usize,
}

/// `relative_to_root` is the path of `dir` relative to `root` ("" when dir == root).
fn walk_dir(
    root: &Path,
    dir: &Path,
    relative_to_root: &str,
    depth: usize,
    state: &mut WalkState<'_>,
) -> DirectoryTreeNode {
    let mut node = DirectoryTreeNode {
        id: if relative_to_root.is_empty() {
            "root".to_string()
        } else {
            relative_to_root.to_string()
        },
        name: if relative_to_root.is_empty() {
            ".".to_string()
        } else {
            Path::new(relative_to_root)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| relative_to_root.to_string())
        },
        path: relative_to_root.to_string(),
        kind: NodeKind::Dir,
        children: Some(Vec::new()),
        loaded: Some(true),
    };

    if depth >= state.max_depth {
        node.loaded = Some(false);
        return node;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return node,
    };

    let mut dirs: Vec<(PathBuf, String, String)> = Vec::new();
    let mut files: Vec<(String, String)> = Vec::new();

    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if state.ignores.contains(name.as_str()) {
            continue;
        }
        let full_path = entry.path();
        let child_rel = if relative_to_root.is_empty() {
            name.clone()
        } else {
            // Use forward slashes throughout so the JS side gets a stable
            // chat-friendly path regardless of platform.
            format!("{}/{}", relative_to_root, name)
        };
        let metadata = match fs::symlink_metadata(&full_path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_dir = if metadata.is_symlink() {
            // For a symlink, follow once to decide bucket — matches the sidecar
            // behavior where symlinks resolve to file/dir via `stat`.
            match fs::metadata(&full_path) {
                Ok(m) => m.is_dir(),
                Err(_) => continue,
            }
        } else {
            metadata.is_dir()
        };

        if is_dir {
            dirs.push((full_path, child_rel, name));
        } else if metadata.is_file() || metadata.is_symlink() {
            files.push((child_rel, name));
        }
    }

    // dirs first, then files; both alphabetical by name (matches sidecar sort).
    dirs.sort_by(|a, b| a.2.to_lowercase().cmp(&b.2.to_lowercase()));
    files.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));

    let children = node.children.as_mut().unwrap();

    // First pass: add directory placeholders + files (level-complete before recursing).
    let mut dir_indices: Vec<usize> = Vec::with_capacity(dirs.len());
    for (full_path, child_rel, name) in &dirs {
        if state.entries_count >= state.max_entries {
            state.truncated = true;
            break;
        }
        state.total_dirs += 1;
        state.entries_count += 1;
        dir_indices.push(children.len());
        children.push(DirectoryTreeNode {
            id: child_rel.clone(),
            name: name.clone(),
            path: child_rel.clone(),
            kind: NodeKind::Dir,
            children: Some(Vec::new()),
            loaded: Some(false),
        });
        let _ = full_path;
    }

    for (child_rel, name) in &files {
        if state.entries_count >= state.max_entries {
            state.truncated = true;
            break;
        }
        state.total_files += 1;
        state.entries_count += 1;
        children.push(DirectoryTreeNode {
            id: child_rel.clone(),
            name: name.clone(),
            path: child_rel.clone(),
            kind: NodeKind::File,
            children: None,
            loaded: None,
        });
    }

    // Second pass: populate dir children if depth allows + not truncated.
    if depth + 1 < state.max_depth {
        for (i, idx) in dir_indices.iter().enumerate() {
            if state.truncated {
                break;
            }
            let (full_path, child_rel, _name) = &dirs[i];
            let populated = walk_dir(root, full_path, child_rel, depth + 1, state);
            if let Some(child) = children.get_mut(*idx) {
                child.children = populated.children;
                child.loaded = populated.loaded;
            }
        }
    }

    node
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    fn write_tree(root: &Path) {
        fs::create_dir_all(root.join("src/renderer")).unwrap();
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::create_dir_all(root.join("node_modules/foo")).unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join("src/index.ts"), "").unwrap();
        fs::write(root.join("src/renderer/App.tsx"), "").unwrap();
        fs::write(root.join("src-tauri/main.rs"), "").unwrap();
        fs::write(root.join("node_modules/foo/leaf.js"), "").unwrap();
    }

    #[tokio::test]
    async fn skips_ignored_dirs() {
        let ws = make_test_workspace("tree_ignore");
        write_tree(&ws);
        let res = cmd_workspace_dir_tree(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        // node_modules MUST not appear at any depth.
        let dump = serde_json::to_string(&res.tree).unwrap();
        assert!(!dump.contains("node_modules"));
        assert!(dump.contains("README.md"));
        assert!(dump.contains("App.tsx"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn caps_depth_marks_loaded_false() {
        let ws = make_test_workspace("tree_depth");
        // Depth 6 chain — exceeds DEFAULT_TREE_MAX_DEPTH = 4.
        let mut p = ws.clone();
        for d in 0..6 {
            p = p.join(format!("level{}", d));
            fs::create_dir_all(&p).unwrap();
        }
        fs::write(p.join("deep.txt"), "").unwrap();
        let res = cmd_workspace_dir_tree(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let dump = serde_json::to_string(&res.tree).unwrap();
        // Should have at least one dir with loaded:false somewhere along the chain.
        assert!(dump.contains("\"loaded\":false"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn expand_returns_subdir_children() {
        let ws = make_test_workspace("tree_expand");
        fs::create_dir_all(ws.join("a/b")).unwrap();
        fs::write(ws.join("a/inner.txt"), "").unwrap();
        let res = cmd_workspace_dir_expand(
            ws.to_string_lossy().to_string(),
            "a".to_string(),
        )
        .await
        .unwrap();
        assert!(res.children.iter().any(|c| c.name == "b"));
        assert!(res.children.iter().any(|c| c.name == "inner.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn expand_rejects_traversal() {
        let ws = make_test_workspace("tree_expand_traversal");
        fs::create_dir_all(ws.join("a")).unwrap();
        let res = cmd_workspace_dir_expand(
            ws.to_string_lossy().to_string(),
            "../etc".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn dirs_sorted_before_files() {
        let ws = make_test_workspace("tree_sort");
        fs::create_dir_all(ws.join("alpha_dir")).unwrap();
        fs::write(ws.join("aaa_file.txt"), "").unwrap();
        let res = cmd_workspace_dir_tree(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let children = res.tree.children.unwrap();
        // First non-skipped child should be the dir.
        assert_eq!(children[0].kind, NodeKind::Dir);
        assert_eq!(children[0].name, "alpha_dir");
        let _ = fs::remove_dir_all(&ws);
    }
}
