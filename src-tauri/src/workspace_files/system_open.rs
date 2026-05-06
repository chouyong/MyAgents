//! "Open in Finder/Explorer" + "Open with default app".
//!
//! Four commands:
//! - `cmd_workspace_open_in_finder` — workspace-relative path, reveals in OS
//!   file manager (`open -R` / `explorer /select,` / `xdg-open <parent>`).
//! - `cmd_workspace_open_with_default` — workspace-relative path, hands off
//!   to the OS default-app dispatcher.
//! - `cmd_open_path_external` (Phase D.5) — absolute path, used by the
//!   Skill/Command detail panels to reveal `~/.myagents/skills/...` files
//!   that live OUTSIDE any chat workspace. Validated against `home_dir` /
//!   `tmp_dir` prefix (mirrors sidecar `/agent/open-path`) so a malicious
//!   absolute path can't escape into `/etc` or similar.
//! - `cmd_open_path_with_default` (issue #125) — absolute path, opens with
//!   the OS default app. Used by BrowserPanel's "open in external browser"
//!   button when previewing a local HTML file. Same safety surface as
//!   `cmd_open_path_external` (canonicalize + home/tmp prefix + credential
//!   blacklist) — only the spawn target differs (`open <path>` vs `open -R`).
//!   The renderer's `openExternal()` helper detects `file://` URLs and
//!   absolute paths and routes through this command, because Tauri's
//!   `shell:allow-open` scope regex `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`
//!   rejects both. v0.2.7 had a partial fix that extracted the bare path
//!   from `file://` and called `shell.open(<path>)` — that also failed the
//!   regex (and produced `/C:/...` paths on Windows).
//!
//! Issue #125 follow-up: both `cmd_open_path_external` and
//! `cmd_open_path_with_default` accept an optional `workspace` argument.
//! When the caller is operating inside a chat workspace (BrowserPanel
//! previewing a workspace HTML file, SkillDetailPanel revealing a
//! project-scoped skill at `<project>/.claude/skills/<name>/`, etc.), the
//! workspace root is canonicalized and added as a third trusted prefix
//! alongside home/tmp. Otherwise Windows users with workspaces on `D:\`
//! (or any non-system drive / mapped drive) hit `Path not allowed` because
//! `D:\workspace\foo.html` doesn't start with `USERPROFILE` (typically
//! `C:\Users\...`) nor with `%TEMP%`.
//!
//! The home-anchored credential blacklist (`<home>/.ssh`, `<home>/.aws`,
//! `Library/Keychains`, …) still applies. It does NOT cover credential
//! dirs placed inside the workspace (`<workspace>/.ssh/`) — that's
//! consistent with the rest of the app's blacklist, which keys on the
//! current user's home dir. The two extra workspace-arg defenses
//! (filesystem-root rejection + canonicalized system-blacklist check)
//! exist to keep `workspace = "/"` or `workspace = "/private"` from
//! turning the home-anchored blacklist into the only line of defense.
//!
//! All variants fire-and-forget — the spawned command's stdout/stderr is
//! dropped deliberately so we don't block the IPC reply. Rust
//! `process_cmd::new` is used (not raw `std::process::Command`) so Windows
//! builds suppress the console-window flash per the CLAUDE.md red-line.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::path_safety::{resolve_existing_inside_workspace, validate_workspace_root};
use crate::process_cmd;

/// Optional workspace context passed by the renderer to widen the
/// trusted-roots whitelist beyond home/tmp. `None` for callers that
/// have no workspace concept (e.g. a global skill at
/// `~/.myagents/skills/<name>/`); `Some(path)` for callers that know the
/// path being opened belongs to a specific chat workspace (BrowserPanel
/// preview, project-scope SkillDetailPanel / CommandDetailPanel).
type WorkspaceArg = Option<String>;

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
    // MUST use the canonicalizing resolver, NOT lexical `resolve_inside_workspace`.
    // A symlink inside the workspace pointing at `~/.ssh/id_rsa` (or any system
    // path) passes the lexical check — the relative segment is just a filename
    // — and `spawn_reveal` then calls `open -R` against the symlink, which
    // follows it and reveals the real target. `resolve_existing_inside_workspace`
    // canonicalizes both ends and rejects when the canonical target sits
    // outside the canonical workspace root. The existence guard moves into the
    // resolver too — `fs::canonicalize` fails on missing paths and the resolver
    // surfaces that as "File not found".
    let target = resolve_existing_inside_workspace(&workspace_root, path.trim())?;
    spawn_reveal(&target)?;
    Ok(SystemOpenResult { success: true })
}

#[tauri::command]
pub async fn cmd_workspace_open_with_default(
    workspace: String,
    path: String,
) -> Result<SystemOpenResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    // Same hardening as cmd_workspace_open_in_finder above — symlink inside
    // workspace pointing at a credential file would otherwise be opened by
    // the OS default app. resolve_existing_inside_workspace blocks the escape.
    let target = resolve_existing_inside_workspace(&workspace_root, path.trim())?;
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
pub async fn cmd_open_path_external(
    full_path: String,
    workspace: WorkspaceArg,
) -> Result<SystemOpenResult, String> {
    let trimmed = full_path.trim();
    if trimmed.is_empty() {
        return Err("fullPath is required".to_string());
    }
    let target = validate_external_open_path(trimmed, workspace.as_deref())?;
    spawn_reveal(&target)?;
    Ok(SystemOpenResult { success: true })
}

/// Open an **absolute** path with the OS default application (i.e. hand off
/// like `open <path>` / Windows `Start-Process` / `xdg-open <path>`). Used
/// by `BrowserPanel`'s "open in external browser" button when the embedded
/// preview is a local HTML file (issue #125). Also covers any future
/// `openExternal(file:// | absolute path)` call — the renderer helper
/// auto-routes file targets through this command because Tauri's
/// `shell:allow-open` scope regex rejects file targets entirely.
///
/// Same safety surface as `cmd_open_path_external` — see
/// `validate_external_open_path` for the canonicalize + home/tmp prefix +
/// credential blacklist guard. The only difference is the spawn target
/// (`spawn_default_open` vs `spawn_reveal`).
#[tauri::command]
pub async fn cmd_open_path_with_default(
    full_path: String,
    workspace: WorkspaceArg,
) -> Result<SystemOpenResult, String> {
    let trimmed = full_path.trim();
    if trimmed.is_empty() {
        return Err("fullPath is required".to_string());
    }
    let target = validate_external_open_path(trimmed, workspace.as_deref())?;
    spawn_default_open(&target)?;
    Ok(SystemOpenResult { success: true })
}

/// Validate that `full_path` (absolute) canonicalizes to somewhere safe to
/// reveal in the OS file manager: under home_dir, tmp_dir, or — when the
/// caller passes one — the active chat workspace root. The path MUST NOT
/// resolve under any credential / system blacklist enforced by
/// `validate_file_path` (`~/.ssh`, `~/.aws`, `Library/Keychains`,
/// `/etc`, `C:\Windows`, etc.), and it must currently exist. Returns the
/// canonical path on success.
///
/// Workspace whitelist (issue #125 follow-up): on Windows, workspaces
/// frequently live on non-system drives (`D:\`, mapped drives), so the
/// home/tmp predicate alone rejects every legitimate "open in external
/// browser" / "reveal project skill" click. Trusting a caller-provided
/// workspace closes that gap, but the workspace arg itself MUST be hardened:
///
/// 1. `validate_workspace_root` rejects blacklisted roots (`/etc`,
///    `C:\Windows`, …).
/// 2. We additionally reject filesystem roots (`/`, `C:\`, `D:\`, …).
///    Without this, `workspace = "/"` passes step 1 (root is not in any
///    blacklist), then `canonical.starts_with("/")` matches everything.
///    On macOS the project-wide blacklist would still let `/etc/hosts`
///    through that hole because `/etc` is a symlink to `/private/etc` and
///    the blacklist matches the source rather than the canonicalized
///    target — so anchoring the workspace at `/` would expose the entire
///    filesystem to the credential blacklist's blind spots.
///
/// Note on workspace-relative credentials: the project-wide
/// `validate_file_path` blacklist matches `<home>/.ssh`, `<home>/.gnupg`,
/// etc. — NOT `<workspace>/.ssh`. A user who chooses to put credential
/// directories inside their workspace (atypical) won't get extra
/// protection from this command. The protection is best-effort and
/// matches the rest of the app's surface; if/when the project-wide
/// blacklist gains workspace-relative rules, this command inherits them
/// for free.
///
/// Cross-review round 2 (Codex MED-1): the home/tmp prefix check alone is
/// insufficient — `~/.ssh/id_rsa` lives under home and would slip through.
/// Additionally calling `validate_file_path` (the project-wide credential
/// blacklist used by templates / sidecar) closes that gap. The sidecar
/// `/agent/open-path` did NOT have this guard; this is a deliberate
/// hardening over the original behavior.
fn validate_external_open_path(
    full_path: &str,
    workspace: Option<&str>,
) -> Result<PathBuf, String> {
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

    // Workspace prefix is canonicalized via the same path the rest of the
    // workspace_files commands use. `validate_workspace_root` rejects
    // blacklisted roots (`/etc`, `C:\Windows`, etc.). We additionally
    // reject filesystem roots (`/`, drive roots like `C:\`) so a malicious
    // caller can't pass `workspace = "/"` and turn `canonical.starts_with`
    // into a tautology — which on macOS would expose `/etc/hosts` etc.
    // because the blacklist matches `/etc` but canonicalize resolves to
    // `/private/etc` (Codex cross-review HIGH-1, issue #125 follow-up).
    let canonical_workspace: Option<PathBuf> = match workspace {
        Some(w) if !w.trim().is_empty() => {
            let resolved = validate_workspace_root(w.trim())?;
            let canonical = std::fs::canonicalize(&resolved).unwrap_or(resolved);
            if is_filesystem_root(&canonical) {
                return Err("Workspace root must not be a filesystem root".to_string());
            }
            Some(canonical)
        }
        _ => None,
    };

    // Prefix-check against canonicalized roots so a symlink chain can't
    // escape into /etc via a tmp/home/workspace-shaped lure.
    let Some(TrustedPrefixMatch { in_home, in_tmp, in_workspace }) = match_trusted_prefix(
        &canonical,
        &canonical_home,
        &canonical_tmp,
        canonical_workspace.as_deref(),
    ) else {
        return Err("Path not allowed".to_string());
    };
    // Apply the project-wide credential / system blacklist on the
    // canonicalized path — blocks `~/.ssh`, `~/.gnupg`, `~/.aws`, Library/
    // Keychains, Library/Cookies, etc. even though the home prefix passed.
    //
    // On Windows, `canonicalize` returns paths with the `\\?\` verbatim
    // prefix, while `validate_file_path` builds blacklist roots via
    // `home.join(".ssh")` etc. without that prefix. Strip the prefix via
    // `normalize_external_path` first, otherwise `starts_with` comparisons
    // inside `validate_file_path` would silently miss and let
    // `~/.ssh/id_rsa` slip through (issue #125 cross-review).
    //
    // Note: `validate_file_path` keys on `<home>/.ssh` etc., NOT
    // `<workspace>/.ssh` — a credential dir placed inside the workspace
    // is NOT covered by this guard. That's consistent with the rest of
    // the app's blacklist surface.
    let normalized = crate::sidecar::normalize_external_path(canonical.clone());
    if let Some(s) = normalized.to_str() {
        crate::commands::validate_file_path(s)?;
    }

    // Defense-in-depth against the macOS `/etc → /private/etc` symlink
    // gap: `validate_file_path`'s blacklist is keyed lexically on `/etc`,
    // but the canonical target `/private/etc/hosts` doesn't start_with
    // `/etc`. Canonicalize each blacklisted system root ourselves and
    // re-check. Without this, a renderer passing
    // `workspace = "/private"` (which `validate_workspace_root` accepts)
    // could open `/etc/hosts` because the canonical target lives under
    // both the canonical workspace and the post-canonicalize form of
    // `/etc`. Keeping this check inside the open-path command keeps the
    // shared `validate_file_path` surface untouched (Codex re-review
    // HIGH-1, #125 follow-up).
    //
    // Only applied when the path got through the prefix check **purely**
    // via the workspace branch — paths under home/tmp are already
    // trusted by the existing rules, and tmp on macOS lives under
    // `/private/var/folders/...` which would otherwise trip the
    // canonicalized `/var` entry.
    if in_workspace && !in_home && !in_tmp && canonical_starts_with_canonical_blacklist(&canonical) {
        return Err("Path not allowed".to_string());
    }
    Ok(canonical)
}

/// Re-runs the system-directory blacklist using **canonicalized** root
/// forms. Catches the macOS `/etc → /private/etc` gap that the lexical
/// `validate_file_path` blacklist misses. The roots mirror those in
/// `validate_file_path` (kept in sync manually — both lists are short and
/// stable, and forking the lexical version is intentionally cheaper than
/// reworking `validate_file_path`'s shared callers).
fn canonical_starts_with_canonical_blacklist(canonical: &Path) -> bool {
    #[cfg(not(windows))]
    let raw_roots: &[&str] = &[
        "/etc", "/var", "/usr", "/bin", "/sbin", "/boot", "/root", "/sys",
        "/proc", "/dev", "/System", "/Library/Keychains", "/Library/Cookies",
    ];
    #[cfg(windows)]
    let raw_roots: &[&str] = &[
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\ProgramData",
        "C:\\Recovery",
        "C:\\$Recycle.Bin",
    ];
    for raw in raw_roots {
        // Use canonicalize when the root exists (resolves macOS symlink
        // farms like `/etc → /private/etc`), otherwise fall back to the
        // raw form. `unwrap_or` keeps the loop infallible — a missing
        // root just means there's nothing to match against on that host.
        let root = std::fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw));
        if canonical.starts_with(&root) {
            return true;
        }
    }
    false
}

/// True if `path` is a filesystem root (`/`, drive root like `C:\`, or
/// the verbatim form `\\?\C:\`). Walking the components and checking for
/// at least one `Component::Normal` is portable across Unix / Windows /
/// the verbatim-prefix variants `canonicalize` produces on Windows.
///
/// Used to reject `workspace = "/"` etc. — see `validate_external_open_path`.
fn is_filesystem_root(path: &Path) -> bool {
    !path
        .components()
        .any(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Outcome of the trusted-prefix check. The downstream blacklist logic
/// branches on `in_home` / `in_tmp` (existing trust) vs `in_workspace`
/// only (workspace branch wants extra canonicalized-blacklist scrutiny).
struct TrustedPrefixMatch {
    in_home: bool,
    in_tmp: bool,
    in_workspace: bool,
}

/// Pure predicate over canonicalized inputs: returns `Some(match)` if
/// `canonical` starts with **any** of `canonical_home`, `canonical_tmp`,
/// or `canonical_workspace`, otherwise `None`. Extracted so the
/// workspace branch is unit-testable without filesystem setup.
fn match_trusted_prefix(
    canonical: &Path,
    canonical_home: &Path,
    canonical_tmp: &Path,
    canonical_workspace: Option<&Path>,
) -> Option<TrustedPrefixMatch> {
    let in_home = canonical.starts_with(canonical_home);
    let in_tmp = canonical.starts_with(canonical_tmp);
    let in_workspace = canonical_workspace
        .map(|ws| canonical.starts_with(ws))
        .unwrap_or(false);
    if !in_home && !in_tmp && !in_workspace {
        return None;
    }
    Some(TrustedPrefixMatch { in_home, in_tmp, in_workspace })
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
        let res = cmd_open_path_external("relative/path".to_string(), None).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("absolute"));
    }

    #[tokio::test]
    async fn open_path_with_default_rejects_relative_and_empty() {
        let res = cmd_open_path_with_default("relative/path".to_string(), None).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("absolute"));
        let res = cmd_open_path_with_default("".to_string(), None).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn open_path_external_rejects_empty() {
        let res = cmd_open_path_external("".to_string(), None).await;
        assert!(res.is_err());
        let res = cmd_open_path_external("   ".to_string(), None).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn open_path_external_rejects_missing() {
        let nonexistent = std::env::temp_dir()
            .join(format!("ws_open_external_missing_{}", std::process::id()));
        // Don't create — should fail at canonicalize.
        let res = cmd_open_path_external(nonexistent.to_string_lossy().to_string(), None).await;
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
            None,
        );
        assert!(res.is_ok(), "home-dir path should validate, got {:?}", res);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validate_external_open_accepts_tmp_path() {
        let p = std::env::temp_dir()
            .join(format!("ws_open_tmp_test_{}", std::process::id()));
        fs::write(&p, "x").unwrap();
        let res = validate_external_open_path(p.to_string_lossy().as_ref(), None);
        assert!(res.is_ok(), "tmp path should validate, got {:?}", res);
        let _ = fs::remove_file(&p);
    }

    // Path under a forbidden system dir → rejected. /etc/hosts exists on
    // every macOS/Linux and is outside both home and tmp.
    #[cfg(not(windows))]
    #[test]
    fn validate_external_open_rejects_etc() {
        let res = validate_external_open_path("/etc/hosts", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not allowed"));
    }

    // Issue #125 follow-up: a workspace path outside home/tmp (the canonical
    // case is a Windows `D:\workspace` but on macOS we simulate it with a
    // tmp dir, since tmp is allowed by both branches we exercise the
    // workspace branch by NOT passing the workspace and verifying the path
    // outside home is rejected, then re-running with the workspace and
    // verifying it's accepted.
    //
    // Simulating "outside home/tmp" on macOS: we'd need write access to a
    // dir outside both. The closest portable proxy is to make the test
    // workspace itself, then verify the validator with workspace=Some(ws)
    // accepts a path inside it. We rely on the fact that `make_test_workspace`
    // returns a path inside tmp — so without the workspace arg it'd ALSO
    // pass (via tmp). To get a true regression guard we need a non-tmp,
    // non-home dir, which isn't portably writable. We compromise: the test
    // verifies the workspace-arg branch is wired up and works (no error),
    // and we add a separate negative test that an arbitrary path outside
    // home/tmp/ws is still rejected.
    #[test]
    fn validate_external_open_accepts_workspace_path() {
        let ws = make_test_workspace("system_open_external_workspace");
        let inside = ws.join("preview.html");
        fs::write(&inside, "<html/>").unwrap();
        // Without workspace arg — passes anyway because tmp covers it on
        // most CI; the assertion is that with workspace arg it ALSO passes.
        let res = validate_external_open_path(
            inside.to_string_lossy().as_ref(),
            Some(ws.to_string_lossy().as_ref()),
        );
        assert!(res.is_ok(), "workspace path should validate, got {:?}", res);
        let _ = fs::remove_dir_all(&ws);
    }

    // Workspace arg MUST NOT disable the project-wide credential
    // blacklist. Concrete check: if target = `<home>/.ssh/<stub>` and
    // workspace = home_dir (or any other allowed root), the blacklist
    // must still reject it.
    #[cfg(unix)]
    #[test]
    fn validate_external_open_workspace_does_not_bypass_home_blacklist() {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let Some(home) = home else { return };
        let ssh_dir = home.join(".ssh");
        if !ssh_dir.is_dir() {
            return; // Skip on systems without ~/.ssh.
        }
        let stub = ssh_dir.join(format!(
            "myagents_ws_bypass_test_{}",
            std::process::id()
        ));
        if std::fs::write(&stub, b"x").is_err() {
            return;
        }
        // Pass workspace=home_dir explicitly — the prefix check accepts
        // the path under canonical_home AND under canonical_workspace,
        // but the credential blacklist must still reject.
        let res = validate_external_open_path(
            stub.to_string_lossy().as_ref(),
            Some(home.to_string_lossy().as_ref()),
        );
        let _ = std::fs::remove_file(&stub);
        assert!(
            res.is_err(),
            "~/.ssh/<stub> must be blocked even with workspace=home, got {:?}",
            res
        );
    }

    // Workspace arg widens the whitelist but must reject blacklisted roots.
    // Caller cannot pass `workspace = "/etc"` etc.: `validate_workspace_root`
    // rejects those upfront.
    #[cfg(not(windows))]
    #[test]
    fn validate_external_open_rejects_blacklisted_workspace_arg() {
        // workspace=/etc → validate_workspace_root rejects.
        let res = validate_external_open_path("/etc/hosts", Some("/etc"));
        assert!(res.is_err(), "blacklisted workspace must be rejected");
    }

    // Filesystem-root workspace (`/`, `C:\`) is rejected — without this
    // guard, `canonical.starts_with(workspace)` would match every path,
    // and the macOS `/etc → /private/etc` symlink quirk would bypass
    // `validate_file_path`'s `/etc` blacklist entry.
    #[cfg(not(windows))]
    #[test]
    fn validate_external_open_rejects_filesystem_root_workspace() {
        let p = std::env::temp_dir()
            .join(format!("ws_open_root_arg_{}", std::process::id()));
        fs::write(&p, "x").unwrap();
        let res = validate_external_open_path(
            p.to_string_lossy().as_ref(),
            Some("/"),
        );
        let _ = fs::remove_file(&p);
        assert!(res.is_err(), "workspace='/' must be rejected, got {:?}", res);
        let err = res.unwrap_err();
        assert!(
            err.contains("filesystem root") || err.contains("not allowed"),
            "expected filesystem-root rejection, got: {}",
            err
        );
    }

    // Concrete macOS regression: the bypass that motivated the filesystem-
    // root rejection. With workspace=/ accepted, /etc/hosts canonicalizes
    // to /private/etc/hosts which slips past `validate_file_path` (whose
    // blacklist entry is `/etc`, not `/private/etc`). The guard above
    // closes this — verify it does.
    #[cfg(target_os = "macos")]
    #[test]
    fn validate_external_open_rejects_etc_hosts_via_root_workspace() {
        let res = validate_external_open_path("/etc/hosts", Some("/"));
        assert!(
            res.is_err(),
            "/etc/hosts via workspace='/' must be rejected, got {:?}",
            res
        );
    }

    // Pure unit tests for `match_trusted_prefix` — exercise the workspace
    // branch directly with synthetic paths so the test doesn't depend on
    // the host's home/tmp layout. Codex re-review MED-2: the original
    // workspace test passed via the tmp fallback under macOS, so the
    // workspace branch wasn't being verified.
    #[test]
    fn match_trusted_prefix_workspace_only() {
        // canonical lives under workspace, NOT under home or tmp.
        let m = match_trusted_prefix(
            Path::new("/data/project/foo.html"),
            Path::new("/Users/alice"),
            Path::new("/private/var/folders/x"),
            Some(Path::new("/data/project")),
        )
        .expect("path under workspace must match");
        assert!(!m.in_home);
        assert!(!m.in_tmp);
        assert!(m.in_workspace);
    }

    #[test]
    fn match_trusted_prefix_rejects_outside_all() {
        let m = match_trusted_prefix(
            Path::new("/elsewhere/foo.html"),
            Path::new("/Users/alice"),
            Path::new("/private/var/folders/x"),
            Some(Path::new("/data/project")),
        );
        assert!(m.is_none(), "path outside all roots must fail");
    }

    #[test]
    fn match_trusted_prefix_no_workspace_arg_uses_home_only() {
        // Without a workspace arg, only home/tmp are trusted.
        let m = match_trusted_prefix(
            Path::new("/Users/alice/project/foo.html"),
            Path::new("/Users/alice"),
            Path::new("/private/var/folders/x"),
            None,
        )
        .expect("home path must match");
        assert!(m.in_home);
        assert!(!m.in_tmp);
        assert!(!m.in_workspace);
    }

    #[test]
    fn match_trusted_prefix_overlap_marks_both_branches() {
        // Workspace inside home — both branches should match. Downstream
        // logic uses the in_home flag to skip the canonical blacklist.
        let m = match_trusted_prefix(
            Path::new("/Users/alice/project/foo.html"),
            Path::new("/Users/alice"),
            Path::new("/private/var/folders/x"),
            Some(Path::new("/Users/alice/project")),
        )
        .expect("path matches both home and workspace");
        assert!(m.in_home);
        assert!(m.in_workspace);
    }

    // Sanity check for `is_filesystem_root` — Unix, Windows drive,
    // verbatim, and UNC shapes.
    #[test]
    fn is_filesystem_root_recognizes_roots_and_paths() {
        assert!(is_filesystem_root(Path::new("/")));
        assert!(!is_filesystem_root(Path::new("/Users/foo")));
        assert!(!is_filesystem_root(Path::new("/tmp/x")));
        // Verbatim / drive / UNC Windows shapes — all should be classified
        // as roots when no Normal component follows. UNC `\\server\share`
        // is treated as a root (a share root is structurally equivalent
        // to a drive root); `\\server\share\project` has a Normal segment
        // and is therefore not a root.
        #[cfg(windows)]
        {
            assert!(is_filesystem_root(Path::new("C:\\")));
            assert!(is_filesystem_root(Path::new("\\\\?\\C:\\")));
            assert!(!is_filesystem_root(Path::new("C:\\Users\\foo")));
            assert!(is_filesystem_root(Path::new("\\\\server\\share")));
            assert!(!is_filesystem_root(Path::new("\\\\server\\share\\project")));
        }
    }

    // Codex re-review: the macOS `/etc → /private/etc` gap also reaches
    // `/private` and `/private/etc` as workspace args. `/etc/hosts`
    // canonicalizes to `/private/etc/hosts`, which under the lexical
    // blacklist `/etc` does NOT match. The canonicalized-blacklist
    // re-check must close this.
    #[cfg(target_os = "macos")]
    #[test]
    fn validate_external_open_rejects_etc_hosts_via_private_workspace() {
        // /private exists on macOS as a real directory.
        let res = validate_external_open_path("/etc/hosts", Some("/private"));
        assert!(
            res.is_err(),
            "/etc/hosts via workspace='/private' must be rejected, got {:?}",
            res
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn validate_external_open_rejects_etc_hosts_via_private_etc_workspace() {
        let res = validate_external_open_path("/etc/hosts", Some("/private/etc"));
        assert!(
            res.is_err(),
            "/etc/hosts via workspace='/private/etc' must be rejected, got {:?}",
            res
        );
    }

    // Defense-in-depth check stands on its own: even with workspace=None,
    // a target directly under a canonicalized blacklist root (the rare
    // case where the lexical guard misses) is still rejected.
    #[cfg(target_os = "macos")]
    #[test]
    fn canonical_blacklist_catches_private_etc() {
        // /private/etc/hosts exists (it's where /etc resolves to).
        assert!(canonical_starts_with_canonical_blacklist(Path::new(
            "/private/etc/hosts"
        )));
        // /private/var same shape.
        assert!(canonical_starts_with_canonical_blacklist(Path::new(
            "/private/var/log"
        )));
        // Home dir or arbitrary user path is NOT in the blacklist.
        assert!(!canonical_starts_with_canonical_blacklist(Path::new(
            "/Users/foo/project"
        )));
    }

    // Empty / whitespace-only workspace string is treated as no workspace
    // (fall through to home/tmp). Ensures the renderer can pass `workspace:
    // workspace ?? null` without surprising errors.
    #[test]
    fn validate_external_open_treats_empty_workspace_as_none() {
        let p = std::env::temp_dir()
            .join(format!("ws_open_empty_arg_{}", std::process::id()));
        fs::write(&p, "x").unwrap();
        let res = validate_external_open_path(p.to_string_lossy().as_ref(), Some(""));
        assert!(res.is_ok(), "empty workspace should be ignored, got {:?}", res);
        let res2 = validate_external_open_path(p.to_string_lossy().as_ref(), Some("   "));
        assert!(res2.is_ok(), "whitespace workspace should be ignored, got {:?}", res2);
        let _ = fs::remove_file(&p);
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
        let res = validate_external_open_path(stub.to_string_lossy().as_ref(), None);
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
        let res = validate_external_open_path(lure.to_string_lossy().as_ref(), None);
        assert!(res.is_err(), "symlink to /etc must be rejected, got {:?}", res);
        let _ = std::fs::remove_file(&lure);
    }

    // ── workspace-relative open: cmd_workspace_open_in_finder /
    // cmd_workspace_open_with_default ──
    //
    // Regression for codex adversarial review (2026-05-07): the workspace-
    // relative open commands previously used lexical `resolve_inside_workspace`,
    // which doesn't follow symlinks during validation but `spawn_reveal` /
    // `spawn_default_open` then ask the OS to open the path — the OS follows
    // the symlink. So a malicious or even just careless `leak → ~/.ssh/id_rsa`
    // symlink committed to a repo would leak the credential.
    //
    // We don't invoke the public `cmd_*` async functions directly because
    // they call `spawn_reveal` (which actually launches `open`), but we DO
    // exercise the underlying resolver — that's the gate that has to
    // reject the lure before any spawn happens.
    #[cfg(unix)]
    #[test]
    fn workspace_open_blocks_symlink_to_credential() {
        use std::os::unix::fs::symlink;
        use crate::workspace_files::path_safety::resolve_existing_inside_workspace;

        let target = "/etc/hosts";
        if !std::path::Path::new(target).exists() {
            return;
        }
        // Build a workspace under home (NOT /tmp — on macOS that's
        // /var/folders/... which trips the `/var` system blacklist before
        // we even get to canonicalize-and-prefix-check).
        let Some(home) = home_dir() else { return };
        let ws_root = home.join(format!(".myagents-test-ws-sym-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws_root);
        std::fs::create_dir_all(&ws_root).unwrap();
        let lure = ws_root.join("leak");
        symlink(target, &lure).unwrap();

        let res = resolve_existing_inside_workspace(&ws_root, "leak");
        let _ = std::fs::remove_dir_all(&ws_root);

        assert!(
            res.is_err(),
            "symlink-out-of-workspace must be rejected by workspace open path, got Ok({:?})",
            res
        );
        // Be specific about the failure mode so a future refactor that
        // accidentally short-circuits to "File not found" or similar still
        // catches the security regression.
        let err = res.unwrap_err();
        assert!(
            err.contains("escapes workspace") || err.contains("escape"),
            "unexpected error message: {}",
            err
        );
    }

    // Counterpoint: a legitimate symlink that points back inside the
    // workspace (e.g. `latest -> versions/v1`) MUST still resolve.
    #[cfg(unix)]
    #[test]
    fn workspace_open_allows_inside_workspace_symlink() {
        use std::os::unix::fs::symlink;
        use crate::workspace_files::path_safety::resolve_existing_inside_workspace;

        let Some(home) = home_dir() else { return };
        let ws_root = home.join(format!(".myagents-test-ws-sym-in-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws_root);
        std::fs::create_dir_all(ws_root.join("versions/v1")).unwrap();
        std::fs::write(ws_root.join("versions/v1/file.txt"), "hi").unwrap();
        symlink(ws_root.join("versions/v1"), ws_root.join("latest")).unwrap();

        let res = resolve_existing_inside_workspace(&ws_root, "latest/file.txt");
        let cleanup = std::fs::remove_dir_all(&ws_root);

        assert!(res.is_ok(), "in-workspace symlink must resolve, got {:?}", res);
        let _ = cleanup;
    }
}
