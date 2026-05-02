//! "Open in Finder/Explorer" + "Open with default app".
//!
//! Three commands:
//! - `cmd_workspace_open_in_finder` — workspace-relative path, reveals in OS
//!   file manager (`open -R` / `explorer /select,` / `xdg-open <parent>`).
//! - `cmd_workspace_open_with_default` — workspace-relative path, hands off
//!   to the OS default-app dispatcher.
//! - `cmd_open_path_external` (Phase D.5) — absolute path, used by the
//!   Skill/Command detail panels to reveal `~/.myagents/skills/...` files
//!   that live OUTSIDE any chat workspace. Validated against `home_dir` /
//!   `tmp_dir` prefix (mirrors sidecar `/agent/open-path`) so a malicious
//!   absolute path can't escape into `/etc` or similar.
//!
//! All variants fire-and-forget — the spawned command's stdout/stderr is
//! dropped deliberately so we don't block the IPC reply. Rust
//! `process_cmd::new` is used (not raw `std::process::Command`) so Windows
//! builds suppress the console-window flash per the CLAUDE.md red-line.

use std::path::{Path, PathBuf};

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

/// Reveal an **absolute** path in the OS file manager. Used by the
/// Skill/Command detail panels to open `~/.myagents/skills/<name>/SKILL.md`
/// (which lives outside any chat workspace).
///
/// Security model: the path must canonicalize to somewhere under the user's
/// home directory or the system tmp directory. This mirrors sidecar
/// `/agent/open-path` and rejects paths under `/etc`, `/System`, etc. Symlink
/// escape is closed by canonicalizing both ends (the path AND the home dir)
/// before the prefix check.
#[tauri::command]
pub async fn cmd_open_path_external(full_path: String) -> Result<SystemOpenResult, String> {
    let trimmed = full_path.trim();
    if trimmed.is_empty() {
        return Err("fullPath is required".to_string());
    }
    let target = validate_external_open_path(trimmed)?;
    spawn_reveal(&target)?;
    Ok(SystemOpenResult { success: true })
}

/// Validate that `full_path` (absolute) canonicalizes to somewhere safe to
/// reveal in the OS file manager: under home_dir or tmp_dir, NOT under any
/// credential / system blacklist (`~/.ssh`, `~/.aws`, `Library/Keychains`,
/// etc.), and the path must currently exist. Returns the canonical path on
/// success.
///
/// Cross-review round 2 (Codex MED-1): the home/tmp prefix check alone is
/// insufficient — `~/.ssh/id_rsa` lives under home and would slip through.
/// Additionally calling `validate_file_path` (the project-wide credential
/// blacklist used by templates / sidecar) closes that gap. The sidecar
/// `/agent/open-path` did NOT have this guard; this is a deliberate
/// hardening over the original behavior.
fn validate_external_open_path(full_path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(full_path);
    if !target.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    // Canonicalize the candidate first — fails clean if the path doesn't
    // exist, which is the right surface for a reveal-in-finder call (the
    // sidecar returned 404 in this case; we surface it as an error).
    let canonical = std::fs::canonicalize(&target)
        .map_err(|_| "File or folder not found".to_string())?;

    let home = home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    let canonical_home = std::fs::canonicalize(&home).unwrap_or(home);

    let tmp = std::env::temp_dir();
    let canonical_tmp = std::fs::canonicalize(&tmp).unwrap_or(tmp);

    // Prefix-check against canonicalized roots so a symlink chain can't
    // escape into /etc via a tmp/home-shaped lure.
    if !canonical.starts_with(&canonical_home) && !canonical.starts_with(&canonical_tmp) {
        return Err("Path not allowed".to_string());
    }
    // Apply the project-wide credential / system blacklist on the
    // canonicalized path — blocks `~/.ssh`, `~/.gnupg`, `~/.aws`, Library/
    // Keychains, Library/Cookies, etc. even though the home prefix passed.
    if let Some(s) = canonical.to_str() {
        crate::commands::validate_file_path(s)?;
    }
    Ok(canonical)
}

/// Cross-platform home dir lookup. We avoid the `home` crate to keep
/// dependencies tight; `HOME` (Unix) / `USERPROFILE` (Windows) are stable
/// since the early '90s and the rest of the codebase already relies on them.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
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

    // ── cmd_open_path_external — Phase D.5 ──

    #[tokio::test]
    async fn open_path_external_rejects_relative() {
        let res = cmd_open_path_external("relative/path".to_string()).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("absolute"));
    }

    #[tokio::test]
    async fn open_path_external_rejects_empty() {
        let res = cmd_open_path_external("".to_string()).await;
        assert!(res.is_err());
        let res = cmd_open_path_external("   ".to_string()).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn open_path_external_rejects_missing() {
        let nonexistent = std::env::temp_dir()
            .join(format!("ws_open_external_missing_{}", std::process::id()));
        // Don't create — should fail at canonicalize.
        let res = cmd_open_path_external(nonexistent.to_string_lossy().to_string()).await;
        assert!(res.is_err());
    }

    // Path under the user home dir — validation passes (we don't invoke
    // spawn in tests; just check the validator).
    #[test]
    fn validate_external_open_accepts_home_path() {
        // Use a real existing file under home: the test workspace itself
        // (which we just created via make_test_workspace).
        let ws = make_test_workspace("system_open_external_home");
        fs::write(ws.join("inside.md"), "x").unwrap();
        let res = validate_external_open_path(
            ws.join("inside.md").to_string_lossy().as_ref(),
        );
        assert!(res.is_ok(), "home-dir path should validate, got {:?}", res);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validate_external_open_accepts_tmp_path() {
        let p = std::env::temp_dir()
            .join(format!("ws_open_tmp_test_{}", std::process::id()));
        fs::write(&p, "x").unwrap();
        let res = validate_external_open_path(p.to_string_lossy().as_ref());
        assert!(res.is_ok(), "tmp path should validate, got {:?}", res);
        let _ = fs::remove_file(&p);
    }

    // Path under a forbidden system dir → rejected. /etc/hosts exists on
    // every macOS/Linux and is outside both home and tmp.
    #[cfg(not(windows))]
    #[test]
    fn validate_external_open_rejects_etc() {
        let res = validate_external_open_path("/etc/hosts");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not allowed"));
    }

    // Cross-review round 2 (Codex MED-1): `~/.ssh/id_rsa` passes the
    // home-prefix check but MUST be blocked by the credential blacklist.
    // Reveal-in-finder would otherwise let a malicious AI tool / skill emit
    // a button that opens Finder on a private key — left-clicking it could
    // open the file in TextEdit and surface the secret on screen.
    #[cfg(unix)]
    #[test]
    fn validate_external_open_blocks_ssh_dir() {
        // Write a stub file under `~/.ssh`. If the user already has a real
        // ~/.ssh with sensitive contents we don't want to touch it; create a
        // unique-named stub instead.
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let Some(home) = home else { return };
        let ssh_dir = home.join(".ssh");
        let stub = ssh_dir.join(format!(
            "myagents_test_stub_{}",
            std::process::id()
        ));
        // Skip if we can't create (no .ssh dir, permission, etc.) — rather
        // than trying to mkdir which would touch real config.
        if !ssh_dir.is_dir() {
            return;
        }
        if std::fs::write(&stub, b"x").is_err() {
            return;
        }
        let res = validate_external_open_path(stub.to_string_lossy().as_ref());
        let _ = std::fs::remove_file(&stub);
        assert!(
            res.is_err(),
            "~/.ssh/<stub> must be blocked by credential blacklist; got {:?}",
            res
        );
    }

    // Symlink ESCAPE from a tmp-shaped lure: a tmp file linking to /etc/hosts
    // must be rejected because canonicalize resolves through the link before
    // the prefix check.
    #[cfg(unix)]
    #[test]
    fn validate_external_open_blocks_symlink_escape() {
        use std::os::unix::fs::symlink;
        let lure = std::env::temp_dir()
            .join(format!("ws_open_lure_{}", std::process::id()));
        // Symlink in tmp (allowed prefix) → /etc/hosts (forbidden target).
        let target = "/etc/hosts";
        if !std::path::Path::new(target).exists() {
            // Skip on systems without /etc/hosts (Windows, sandboxed CI).
            return;
        }
        let _ = std::fs::remove_file(&lure);
        symlink(target, &lure).unwrap();
        let res = validate_external_open_path(lure.to_string_lossy().as_ref());
        assert!(res.is_err(), "symlink to /etc must be rejected, got {:?}", res);
        let _ = std::fs::remove_file(&lure);
    }
}
