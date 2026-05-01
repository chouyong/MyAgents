//! Read a workspace file as text for the preview modal.
//!
//! Mirrors sidecar `/agent/file` semantics:
//!   * Resolve relative path inside workspace.
//!   * Reject if file doesn't exist.
//!   * Reject non-previewable types (binary / unknown — UI shows the modal
//!     only when content can be displayed as text).
//!   * Cap response at 512KB so a forgotten 50MB JSON doesn't pin the IPC
//!     channel.
//! Returns the same `{ content, name, size }` shape so DirectoryPanel's
//! `FilePreviewModal` consumer doesn't need a parallel branch.

use std::fs;

use serde::Serialize;

use super::path_safety::{resolve_inside_workspace, validate_workspace_root};

const MAX_PREVIEW_BYTES: u64 = 512 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub content: String,
    pub name: String,
    pub size: u64,
}

#[tauri::command]
pub async fn cmd_workspace_read_preview(
    workspace: String,
    path: String,
) -> Result<PreviewResult, String> {
    if path.trim().is_empty() {
        return Err("Missing path".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    let resolved = resolve_inside_workspace(&workspace_root, &path)?;
    let metadata = fs::symlink_metadata(&resolved)
        .map_err(|_| "File not found".to_string())?;
    if metadata.is_symlink() {
        // Resolve once for size + previewability.
        let stat = fs::metadata(&resolved).map_err(|_| "Symlink target missing".to_string())?;
        if !stat.is_file() {
            return Err("Not a regular file".to_string());
        }
    } else if !metadata.is_file() {
        return Err("Not a regular file".to_string());
    }

    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    if !is_previewable(&name) {
        return Err("File type not supported".to_string());
    }

    let size = fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0);
    if size > MAX_PREVIEW_BYTES {
        return Err("File too large to preview".to_string());
    }

    let content = fs::read_to_string(&resolved)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(PreviewResult { content, name, size })
}

/// Mirrors the previewable extension set used by `src/shared/fileTypes.ts::isPreviewable`.
/// Kept as a small, hand-curated list — the sidecar version is also a static set.
fn is_previewable(name: &str) -> bool {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let Some(ext) = ext else {
        // Files without extension — preview only well-known names.
        return matches!(
            name,
            "README" | "LICENSE" | "CHANGELOG" | "Makefile" | "Dockerfile" | "Procfile" | ".gitignore"
        );
    };
    matches!(
        ext.as_str(),
        // Text / docs
        "md" | "mdx" | "txt" | "log" | "rst" | "tex"
            // Code
            | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs"
            | "rs" | "go" | "py" | "rb" | "java" | "kt" | "swift"
            | "c" | "h" | "cpp" | "hpp" | "cc" | "cs"
            | "sh" | "zsh" | "bash" | "fish" | "ps1" | "bat" | "cmd"
            | "lua" | "pl" | "php" | "scala" | "groovy" | "dart"
            | "vue" | "svelte" | "astro"
            // Markup / data
            | "json" | "json5" | "yaml" | "yml" | "toml" | "ini" | "env"
            | "html" | "htm" | "xml" | "svg" | "css" | "scss" | "sass" | "less"
            | "csv" | "tsv"
            | "graphql" | "gql"
            | "sql"
            // Config
            | "conf" | "cfg" | "rc" | "lock"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    #[tokio::test]
    async fn reads_text_file() {
        let ws = make_test_workspace("preview_text");
        fs::write(ws.join("hello.md"), "hi there").unwrap();
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "hello.md".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.content, "hi there");
        assert_eq!(res.name, "hello.md");
        assert_eq!(res.size, 8);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_missing() {
        let ws = make_test_workspace("preview_missing");
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "nope.md".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_non_previewable() {
        let ws = make_test_workspace("preview_binary");
        fs::write(ws.join("blob.bin"), b"\x00\x01\x02").unwrap();
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "blob.bin".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_oversize() {
        let ws = make_test_workspace("preview_oversize");
        let big = "a".repeat((MAX_PREVIEW_BYTES + 1) as usize);
        fs::write(ws.join("big.md"), &big).unwrap();
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "big.md".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_test_workspace("preview_traversal");
        let res = cmd_workspace_read_preview(
            ws.to_string_lossy().to_string(),
            "../etc/hosts".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
