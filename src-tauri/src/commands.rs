// Tauri IPC commands for sidecar management and app operations
// Supports both legacy single-instance and new multi-instance APIs

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::sidecar::{
    // Legacy exports
    get_sidecar_status, start_sidecar, stop_sidecar, restart_sidecar,
    ensure_sidecar_running, check_process_alive,
    ManagedSidecar, LegacySidecarConfig, SidecarStatus,
    // New multi-instance exports
    start_tab_sidecar, stop_tab_sidecar, get_tab_server_url, get_tab_sidecar_status,
    start_global_sidecar, stop_all_sidecars, GLOBAL_SIDECAR_ID,
    // Update shutdown
    shutdown_for_update,
};
use crate::logger;
use crate::{ulog_error, ulog_info, ulog_warn};

// ============= Legacy Commands (for backward compatibility) =============

/// Command: Start the sidecar for a project (legacy single-instance)
#[tauri::command]
pub async fn cmd_start_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    agent_dir: String,
    initial_prompt: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, format!("[sidecar] Starting for project: {}", agent_dir));

    let config = LegacySidecarConfig {
        port: find_available_port().unwrap_or(31415),
        agent_dir: PathBuf::from(&agent_dir),
        initial_prompt,
    };

    match start_sidecar(&app_handle, &state, config) {
        Ok(_) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Started on port {}", status.port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Failed to start: {}", e));
            Err(e)
        }
    }
}

/// Command: Stop the sidecar (legacy)
#[tauri::command]
pub async fn cmd_stop_sidecar(state: State<'_, ManagedSidecar>) -> Result<(), String> {
    stop_sidecar(&state)
}

/// Command: Get sidecar status (legacy)
#[tauri::command]
pub async fn cmd_get_sidecar_status(
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    get_sidecar_status(&state)
}

/// Command: Get the backend server URL (legacy)
#[tauri::command]
pub async fn cmd_get_server_url(state: State<'_, ManagedSidecar>) -> Result<String, String> {
    let status = get_sidecar_status(&state)?;
    if status.running {
        Ok(format!("http://127.0.0.1:{}", status.port))
    } else {
        Err("Sidecar is not running".to_string())
    }
}

/// Command: Restart the sidecar (legacy)
#[tauri::command]
pub async fn cmd_restart_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Restart requested".to_string());

    match restart_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Restarted on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Restart failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Ensure sidecar is running (legacy)
#[tauri::command]
pub async fn cmd_ensure_sidecar_running<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    match ensure_sidecar_running(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::debug(&app_handle, format!("[sidecar] Ensured running on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Ensure running failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Check if sidecar process is alive (legacy)
#[tauri::command]
pub async fn cmd_check_sidecar_alive(
    state: State<'_, ManagedSidecar>,
) -> Result<bool, String> {
    check_process_alive(&state)
}

// ============= New Multi-instance Commands =============

/// Command: Start a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_start_tab_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
    agent_dir: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(
        &app_handle,
        format!("[sidecar] Starting for tab {}, agent_dir: {:?}", tab_id, agent_dir),
    );

    let agent_path = agent_dir.map(PathBuf::from);

    match start_tab_sidecar(&app_handle, &state, &tab_id, agent_path) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, &tab_id)?;
            logger::info(&app_handle, format!("[sidecar] Tab {} started on port {}", tab_id, port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Tab {} failed to start: {}", tab_id, e));
            Err(e)
        }
    }
}

/// Command: Stop a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_stop_tab_sidecar(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<(), String> {
    logger::info(&app_handle, format!("[sidecar] Stopping tab {}", tab_id));
    stop_tab_sidecar(&state, &tab_id)
}

/// Command: Get server URL for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_server_url(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<String, String> {
    get_tab_server_url(&state, &tab_id)
}

/// Command: Get sidecar status for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_sidecar_status(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<SidecarStatus, String> {
    get_tab_sidecar_status(&state, &tab_id)
}

/// Command: Start the global sidecar (for Settings page)
#[tauri::command]
pub async fn cmd_start_global_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Starting global sidecar".to_string());

    match start_global_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, GLOBAL_SIDECAR_ID)?;
            logger::info(&app_handle, format!("[sidecar] Global sidecar started on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Global sidecar failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Get global sidecar server URL
#[tauri::command]
pub async fn cmd_get_global_server_url(
    state: State<'_, ManagedSidecar>,
) -> Result<String, String> {
    get_tab_server_url(&state, GLOBAL_SIDECAR_ID)
}

/// Command: Stop all sidecar instances (for app exit)
#[tauri::command]
pub async fn cmd_stop_all_sidecars(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Stopping all instances".to_string());
    stop_all_sidecars(&state)
}

/// Command: Shutdown for update — blocks until all child processes are fully terminated.
/// Must be called before relaunch() to prevent NSIS installer file-lock errors on Windows.
#[tauri::command]
pub async fn cmd_shutdown_for_update(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Shutdown for update requested".to_string());
    shutdown_for_update(&state)
}

// ============= Utility Functions =============

/// Find an available port
fn find_available_port() -> Option<u16> {
    let preferred = [31415, 31416, 31417, 31418, 31419];

    for &port in &preferred {
        if is_port_available(port) {
            return Some(port);
        }
    }

    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

// ============= Platform & Device Info Commands =============

/// Command: Get platform identifier (matches build target naming)
/// Returns: darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64, etc.
#[tauri::command]
pub fn cmd_get_platform() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64".to_string();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64".to_string();

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unknown".to_string();
}

/// Command: Get or create device ID
/// Stored in ~/.myagents/device_id to persist across app reinstalls
/// Only regenerates if the file is deleted by user
#[tauri::command]
pub fn cmd_get_device_id() -> Result<String, String> {
    use std::fs;
    use uuid::Uuid;

    // Get home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;

    // ~/.myagents/ directory
    let myagents_dir = home_dir.join(".myagents");
    let device_id_file = myagents_dir.join("device_id");

    // Try to read existing device_id
    if device_id_file.exists() {
        match fs::read_to_string(&device_id_file) {
            Ok(id) => {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Ok(id);
                }
            }
            Err(_) => {
                // File exists but can't read, will regenerate
            }
        }
    }

    // Generate new UUID
    let new_id = Uuid::new_v4().to_string();

    // Ensure directory exists
    if !myagents_dir.exists() {
        fs::create_dir_all(&myagents_dir)
            .map_err(|e| format!("Failed to create ~/.myagents directory: {}", e))?;
    }

    // Write device_id to file
    fs::write(&device_id_file, &new_id)
        .map_err(|e| format!("Failed to write device_id file: {}", e))?;

    Ok(new_id)
}

// ============= Bundled Workspace Commands =============

#[derive(serde::Serialize)]
pub struct InitBundledWorkspaceResult {
    pub path: String,
    pub is_new: bool,
}

/// Command: Initialize bundled workspace (mino) on first launch
/// Copies from app resources to ~/.myagents/projects/mino/
#[tauri::command]
pub fn cmd_initialize_bundled_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let mino_dest = home_dir.join(".myagents").join("projects").join("mino");

    if mino_dest.exists() {
        return Ok(InitBundledWorkspaceResult {
            path: mino_dest.to_string_lossy().to_string(),
            is_new: false,
        });
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let mino_src = resource_dir.join("mino");
    if !mino_src.exists() || !mino_src.join("CLAUDE.md").exists() {
        return Err(format!(
            "Bundled mino not found or incomplete in resources: {:?}",
            mino_src
        ));
    }

    ulog_info!("[workspace] Initializing bundled workspace from {:?}", mino_src);
    copy_dir_recursive(&mino_src, &mino_dest)
        .map_err(|e| format!("Failed to copy mino workspace: {}", e))?;

    // Validate the copy produced a valid workspace
    if !mino_dest.join("CLAUDE.md").exists() {
        let _ = fs::remove_dir_all(&mino_dest);
        return Err("Bundled mino copy produced incomplete workspace".to_string());
    }

    Ok(InitBundledWorkspaceResult {
        path: mino_dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Create a dedicated workspace for an IM Bot by copying bundled mino template.
/// Sanitizes the name for path safety and auto-appends numeric suffix on collision.
/// Falls back to local mino copy if bundled resources are incomplete.
/// Returns the created workspace path.
#[tauri::command]
pub fn cmd_create_bot_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
    workspace_name: String,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".myagents").join("projects");

    // Sanitize name: remove @, replace non-alphanumeric (except CJK) with dash, trim
    let sanitized = sanitize_workspace_name(&workspace_name);
    if sanitized.is_empty() {
        return Err("Workspace name is empty after sanitization".to_string());
    }

    // Find available path (handle collisions with numeric suffix)
    let dest = find_available_workspace_path(&projects_dir, &sanitized);

    // Primary: copy from bundled resources
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let mino_src = resource_dir.join("mino");

    if mino_src.exists() && mino_src.join("CLAUDE.md").exists() {
        ulog_info!("[workspace] Copying bundled mino from {:?} to {:?}", mino_src, dest);
        copy_dir_recursive(&mino_src, &dest)
            .map_err(|e| format!("Failed to copy workspace template: {}", e))?;
    }

    // Validate: CLAUDE.md must exist in destination (marker file for a valid mino template)
    if !dest.join("CLAUDE.md").exists() {
        // Fallback: copy from the local mino created on first launch
        let local_mino = projects_dir.join("mino");
        if local_mino.exists() && local_mino.join("CLAUDE.md").exists() {
            ulog_warn!("[workspace] Bundled mino incomplete, falling back to local {:?}", local_mino);
            // Clean up the potentially empty dest before fallback copy
            let _ = fs::remove_dir_all(&dest);
            copy_dir_recursive(&local_mino, &dest)
                .map_err(|e| format!("Failed to copy from local mino: {}", e))?;
        } else {
            // Clean up the empty dest
            let _ = fs::remove_dir_all(&dest);
            return Err("Mino template not found: bundled resources incomplete and no local copy available".to_string());
        }
    }

    ulog_info!("[workspace] Bot workspace created: {:?}", dest);
    Ok(InitBundledWorkspaceResult {
        path: dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Remove a workspace directory created by `cmd_create_bot_workspace`.
/// Safety: only allows deleting directories under `~/.myagents/projects/`.
#[tauri::command]
pub fn cmd_remove_bot_workspace(workspace_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".myagents").join("projects");

    let target = PathBuf::from(&workspace_path);
    // Canonicalize both paths to prevent traversal attacks
    let canon_projects = projects_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve projects dir: {}", e))?;
    let canon_target = target.canonicalize()
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    if !canon_target.starts_with(&canon_projects) || canon_target == canon_projects {
        return Err("Refusing to delete: path is not inside ~/.myagents/projects/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove workspace directory: {}", e))?;

    Ok(())
}

/// Command: Remove a template directory from ~/.myagents/templates/.
/// Safety: only allows deleting directories under ~/.myagents/templates/.
#[tauri::command]
pub fn cmd_remove_template_folder(template_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".myagents").join("templates");

    if !templates_dir.exists() {
        return Err("Templates directory does not exist".to_string());
    }

    let target = PathBuf::from(&template_path);

    // If the folder no longer exists, treat as success (already cleaned up)
    if !target.exists() {
        ulog_info!("[template] Template folder already removed: {:?}", target);
        return Ok(());
    }

    let canon_templates = templates_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
    let canon_target = target.canonicalize()
        .map_err(|e| format!("Failed to resolve template path: {}", e))?;

    if !canon_target.starts_with(&canon_templates) || canon_target == canon_templates {
        return Err("Refusing to delete: path is not inside ~/.myagents/templates/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove template directory: {}", e))?;

    ulog_info!("[template] Removed template folder: {:?}", canon_target);
    Ok(())
}

/// Sanitize a workspace name for use as a directory name.
/// Keeps alphanumeric, CJK characters, hyphens, and underscores.
fn sanitize_workspace_name(name: &str) -> String {
    let result: String = name
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else if c == ' ' || c == '@' || c == '/' || c == '\\' {
                Some('-')
            } else if c > '\u{2E7F}' {
                // Keep CJK and other non-ASCII characters
                Some(c)
            } else {
                None
            }
        })
        .collect();

    // Trim leading/trailing dashes and collapse consecutive dashes
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in result.chars() {
        if c == '-' {
            if !prev_dash && !collapsed.is_empty() {
                collapsed.push(c);
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    collapsed.trim_end_matches('-').to_string()
}

/// Find an available workspace path, appending numeric suffix on collision.
fn find_available_workspace_path(projects_dir: &Path, base_name: &str) -> PathBuf {
    let first = projects_dir.join(base_name);
    if !first.exists() {
        return first;
    }
    for i in 2..=100 {
        let candidate = projects_dir.join(format!("{}-{}", base_name, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Extremely unlikely fallback
    projects_dir.join(format!("{}-{}", base_name, uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("x")))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // Skip .git and node_modules
        if name == ".git" || name == "node_modules" {
            continue;
        }
        // Skip symlinks to avoid circular copies and unexpected data
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let dest = dst.join(name);
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(&entry.path(), &dest)?;
        }
    }
    Ok(())
}

// ============= Workspace Template Commands =============

/// Command: Create a workspace from a user template (copy source dir to dest dir).
/// Reuses copy_dir_recursive which skips .git and node_modules.
/// Safety: source_path must be under ~/.myagents/templates/.
/// The dest_path parent must exist; the dest_path itself must NOT exist.
#[tauri::command]
pub fn cmd_create_workspace_from_template(
    source_path: String,
    dest_path: String,
) -> Result<(), String> {
    let src = PathBuf::from(&source_path);
    let dst = PathBuf::from(&dest_path);

    if !src.exists() {
        return Err(format!("Template source not found: {}", source_path));
    }

    // Validate source is under ~/.myagents/templates/
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".myagents").join("templates");
    if templates_dir.exists() {
        let canon_templates = templates_dir.canonicalize()
            .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
        let canon_src = src.canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        if !canon_src.starts_with(&canon_templates) {
            return Err("Source path must be inside ~/.myagents/templates/".to_string());
        }
    } else {
        return Err("Templates directory does not exist".to_string());
    }

    if dst.exists() {
        return Err(format!("Destination already exists: {}", dest_path));
    }
    // Ensure parent directory exists
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    ulog_info!("[template] Copying template from {:?} to {:?}", src, dst);
    copy_dir_recursive(&src, &dst)
        .map_err(|e| format!("Failed to copy template: {}", e))?;

    Ok(())
}

/// Command: Create a workspace from a bundled (preset) template.
/// Copies from app resources/<template_id> to dest_path.
/// Falls back to local copy at ~/.myagents/projects/<template_id> if bundled is incomplete.
/// Safety: template_id is sanitized to prevent path traversal.
#[tauri::command]
pub fn cmd_create_workspace_from_bundled_template<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: String,
    dest_path: String,
) -> Result<(), String> {
    // Sanitize template_id (single source of truth in `validate_template_id`).
    validate_template_id(&template_id)?;

    let dst = PathBuf::from(&dest_path);
    if dst.exists() {
        return Err(format!("Destination already exists: {}", dest_path));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    // Primary: copy from bundled resources
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let template_src = resource_dir.join(&template_id);

    if template_src.exists() && template_src.join("CLAUDE.md").exists() {
        ulog_info!("[template] Copying bundled template '{}' from {:?} to {:?}", template_id, template_src, dst);
        copy_dir_recursive(&template_src, &dst)
            .map_err(|e| format!("Failed to copy bundled template: {}", e))?;
        return Ok(());
    }

    // Fallback: copy from local projects/<template_id>
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let local_src = home_dir.join(".myagents").join("projects").join(&template_id);
    if local_src.exists() && local_src.join("CLAUDE.md").exists() {
        ulog_warn!("[template] Bundled template '{}' incomplete, falling back to local {:?}", template_id, local_src);
        copy_dir_recursive(&local_src, &dst)
            .map_err(|e| format!("Failed to copy from local template: {}", e))?;
        return Ok(());
    }

    Err(format!("Template '{}' not found in bundled resources or local copies", template_id))
}

/// Validate a bundled template_id — rejects path separators, traversal, and empty IDs.
/// Single source of truth so all template-using commands inherit the same rules.
fn validate_template_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
    {
        return Err("Invalid template ID".to_string());
    }
    Ok(())
}

/// Validate a workspace destination path for template apply. Reuses `validate_file_path`'s
/// system/credential blacklist (so we can't accidentally write template files into `~/.ssh`,
/// `/etc`, or other protected dirs) AND requires the path to exist as a real directory.
/// Returns the resolved (`..`-free) absolute path so the caller uses a single canonical form.
fn validate_workspace_dest(dest_path: &str) -> Result<PathBuf, String> {
    let resolved = validate_file_path(dest_path)?;
    if !resolved.exists() {
        return Err(format!("Workspace does not exist: {}", dest_path));
    }
    if !resolved.is_dir() {
        return Err(format!("Workspace path is not a directory: {}", dest_path));
    }
    Ok(resolved)
}

/// Resolve a template source directory from either a bundled template_id or a user
/// template source_path. Returns the CANONICAL path (symlinks resolved) — callers must
/// use this exact path for any subsequent reads/copies, otherwise a TOCTOU window opens
/// where an attacker could replace the validated source with a symlink to elsewhere
/// between this validation and the later read.
fn resolve_template_source<R: Runtime>(
    app_handle: &AppHandle<R>,
    template_id: Option<String>,
    source_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(id) = template_id.as_deref() {
        validate_template_id(id)?;
        let resource_dir = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        let bundled = resource_dir.join(id);
        if bundled.exists() && bundled.join("CLAUDE.md").exists() {
            // Canonicalize so subsequent reads can't be redirected via symlink swap.
            return bundled.canonicalize()
                .map_err(|e| format!("Failed to resolve bundled template path: {}", e));
        }
        let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
        let local = home_dir.join(".myagents").join("projects").join(id);
        if local.exists() && local.join("CLAUDE.md").exists() {
            return local.canonicalize()
                .map_err(|e| format!("Failed to resolve local template path: {}", e));
        }
        return Err(format!("Bundled template '{}' not found", id));
    }
    if let Some(p) = source_path.as_deref() {
        let src = PathBuf::from(p);
        if !src.exists() {
            return Err(format!("Template source not found: {}", p));
        }
        let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
        let templates_dir = home_dir.join(".myagents").join("templates");
        if !templates_dir.exists() {
            return Err("Templates directory does not exist".to_string());
        }
        let canon_templates = templates_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
        let canon_src = src
            .canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        if !canon_src.starts_with(&canon_templates) {
            return Err("Source path must be inside ~/.myagents/templates/".to_string());
        }
        // Return canonical path (not the original `src`) — closes the TOCTOU between
        // validation and consumption, since the caller will read from canon_src directly.
        return Ok(canon_src);
    }
    Err("Either template_id or source_path is required".to_string())
}

/// Walk a template directory and collect relative file paths (skipping .git / node_modules /
/// symlinks). Used by the preview command to compute overwrite vs add classifications.
fn list_template_files_rel(src: &Path) -> std::io::Result<Vec<PathBuf>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let p = entry.path();
            if file_type.is_dir() {
                walk(root, &p, out)?;
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(src, src, &mut out)?;
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct TemplateApplyPreview {
    pub overwrite: Vec<String>,
    pub add: Vec<String>,
}

/// Command: Preview which files a template would overwrite vs add when applied to an
/// existing workspace. Used to drive the confirmation UI before the destructive merge.
/// Either `template_id` (bundled) or `source_path` (user template) must be provided.
#[tauri::command]
pub fn cmd_template_apply_preview<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: Option<String>,
    source_path: Option<String>,
    dest_path: String,
) -> Result<TemplateApplyPreview, String> {
    // `validate_workspace_dest` forbids system/credential dirs (mirroring the
    // file-read/write commands' blacklist) so a misbehaving renderer can't redirect a
    // template apply at e.g. `~/.ssh` or `/etc`.
    let dst = validate_workspace_dest(&dest_path)?;
    let src = resolve_template_source(&app_handle, template_id, source_path)?;
    let files = list_template_files_rel(&src)
        .map_err(|e| format!("Failed to walk template: {}", e))?;
    let mut overwrite = Vec::new();
    let mut add = Vec::new();
    for rel in files {
        let target = dst.join(&rel);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if target.exists() {
            overwrite.push(rel_str);
        } else {
            add.push(rel_str);
        }
    }
    overwrite.sort();
    add.sort();
    Ok(TemplateApplyPreview { overwrite, add })
}

/// Command: Apply a template to an EXISTING workspace by merging files (same-name overwrite,
/// other files preserved). This is the destructive counterpart to `cmd_template_apply_preview`
/// — callers should always preview + confirm with the user before invoking apply.
#[tauri::command]
pub fn cmd_apply_template_to_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: Option<String>,
    source_path: Option<String>,
    dest_path: String,
) -> Result<(), String> {
    let dst = validate_workspace_dest(&dest_path)?;
    let src = resolve_template_source(&app_handle, template_id, source_path)?;
    ulog_info!("[template] Merging template from {:?} into existing workspace {:?}", src, dst);
    merge_dir_recursive(&src, &dst)
        .map_err(|e| format!("Failed to apply template: {}", e))?;
    Ok(())
}

/// Command: Copy a local folder into the templates library (~/.myagents/templates/<name>/).
/// Returns the destination path.
#[tauri::command]
pub fn cmd_copy_folder_to_templates(
    source_path: String,
    template_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() || !src.is_dir() {
        return Err(format!("Source folder not found: {}", source_path));
    }

    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".myagents").join("templates");
    fs::create_dir_all(&templates_dir)
        .map_err(|e| format!("Failed to create templates dir: {}", e))?;

    // Sanitize name and find available path
    let sanitized = sanitize_workspace_name(&template_name);
    if sanitized.is_empty() {
        return Err("Template name is empty after sanitization".to_string());
    }
    let dest = find_available_workspace_path(&templates_dir, &sanitized);

    // Prevent overlapping source/destination (would cause infinite recursion)
    let canon_src = src.canonicalize()
        .map_err(|e| format!("Failed to resolve source: {}", e))?;
    let canon_templates = templates_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
    if canon_src.starts_with(&canon_templates) {
        return Err("Source folder is already inside the templates directory".to_string());
    }

    ulog_info!("[template] Copying folder {:?} to template library {:?}", src, dest);
    copy_dir_recursive(&src, &dest)
        .map_err(|e| format!("Failed to copy to template library: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

// ============= Admin Agent Sync =============

const ADMIN_AGENT_VERSION: &str = "14";

/// Merge bundled admin agent files into ~/.myagents/
/// Version-gated: only runs when ADMIN_AGENT_VERSION changes.
#[tauri::command]
pub fn cmd_sync_admin_agent<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let dest = home.join(".myagents");

    // Version gate
    let ver_file = dest.join(".admin-agent-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == ADMIN_AGENT_VERSION {
            return Ok(false);
        }
    }

    // Source: app resources
    let res = app_handle.path().resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let src = res.join("bundled-agents").join("myagents_helper");
    if !src.exists() {
        return Err(format!("Admin agent not found: {:?}", src));
    }

    // Merge into ~/.myagents/
    merge_dir_recursive(&src, &dest)
        .map_err(|e| format!("Merge failed: {}", e))?;

    fs::write(&ver_file, ADMIN_AGENT_VERSION)
        .map_err(|e| format!("Version write failed: {}", e))?;

    ulog_info!("[admin-agent] Synced v{}", ADMIN_AGENT_VERSION);
    Ok(true)
}

// ============= CLI Sync =============

const CLI_VERSION: &str = "13";

/// Sync the CLI script from bundled resources to ~/.myagents/bin/.
/// Version-gated: only runs when CLI_VERSION changes.
/// Sources `resources/cli/myagents.js` (esbuild bundle, shebang `#!/usr/bin/env node`)
/// and copies it to `~/.myagents/bin/myagents` with 0755 on Unix.
#[tauri::command]
pub fn cmd_sync_cli<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let bin_dir = home.join(".myagents").join("bin");

    // Version gate
    let ver_file = home.join(".myagents").join(".cli-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == CLI_VERSION {
            return Ok(false);
        }
    }

    // Source: app resources/cli/ (esbuild output from `npm run build:cli`)
    let res = app_handle.path().resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let cli_src = res.join("cli");
    if !cli_src.exists() {
        return Err(format!("CLI source not found: {:?}", cli_src));
    }

    // Ensure ~/.myagents/bin/ exists
    fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create bin dir: {}", e))?;

    // Copy myagents.js → myagents (strip extension, shebang handles node invocation on Unix;
    // Windows uses myagents.cmd wrapper below).
    let src_script = cli_src.join("myagents.js");
    let dst_script = bin_dir.join("myagents");
    if !src_script.exists() {
        return Err(format!("CLI script not found: {:?} (run `npm run build:cli`?)", src_script));
    }
    // Atomic-replace via tmp + rename, so a `myagents` process currently
    // executing the old binary doesn't block the upgrade. On Windows
    // `fs::copy` directly to a path held open by another process returns
    // ERROR_SHARING_VIOLATION; the tmp+rename pattern dodges this since
    // rename atomically swaps inodes (or, on Windows ≥1.81, calls
    // `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` which works even when the
    // destination is open). Codex C6 from cross-review.
    let tmp_script = dst_script.with_extension("tmp.new");
    fs::copy(&src_script, &tmp_script)
        .map_err(|e| format!("Failed to copy CLI script tmp: {}", e))?;
    if let Err(e) = fs::rename(&tmp_script, &dst_script) {
        // Best-effort tmp cleanup so a stale `myagents.tmp.new` doesn't
        // pile up on every failed sync.
        let _ = fs::remove_file(&tmp_script);
        return Err(format!("Failed to install CLI script: {}", e));
    }
    // Ensure executable permission on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        fs::set_permissions(&dst_script, perms)
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

    // Write Windows launcher (myagents.cmd) pinned to the bundled Node.js binary.
    // v0.2.0+: the source myagents.cmd uses `for %%b in (node.exe)` which searches
    // the user's PATH — but when a user runs `myagents` from their own terminal, the
    // app bundle's Node directory is NOT in PATH (only injected when the app spawns
    // its own subprocesses). Result on Windows-without-system-Node: ENOENT. We fix
    // this at sync time by baking the absolute bundled node.exe path into the
    // launcher, so terminal invocations don't depend on the system install.
    #[cfg(target_os = "windows")]
    {
        let bundled_node = app_handle
            .path()
            .resource_dir()
            .ok()
            .map(|r| r.join("nodejs").join("node.exe"))
            .filter(|p| p.exists());

        let dst_cmd = bin_dir.join("myagents.cmd");
        let cmd_contents = if let Some(node_path) = bundled_node {
            // Absolute path: no PATH dependency; survives terminal launch.
            let node_str = node_path.to_string_lossy();
            format!(
                "@echo off\r\n\
                 :: myagents CLI wrapper — generated by cmd_sync_cli; invokes bundled Node.js.\r\n\
                 setlocal\r\n\
                 \"{}\" \"%~dp0myagents\" %*\r\n\
                 exit /b %ERRORLEVEL%\r\n",
                node_str
            )
        } else {
            // Dev / packaging-in-progress fallback: behave like the source .cmd,
            // expecting node.exe in PATH.
            let src_cmd = cli_src.join("myagents.cmd");
            match fs::read_to_string(&src_cmd) {
                Ok(s) => s,
                Err(e) => return Err(format!("Failed to read source myagents.cmd: {}", e)),
            }
        };
        // Same tmp+rename atomic-replace pattern as above (an open
        // myagents.cmd shell window would otherwise block the upgrade
        // with ERROR_SHARING_VIOLATION).
        let tmp_cmd = dst_cmd.with_extension("cmd.tmp.new");
        fs::write(&tmp_cmd, cmd_contents)
            .map_err(|e| format!("Failed to write myagents.cmd tmp: {}", e))?;
        if let Err(e) = fs::rename(&tmp_cmd, &dst_cmd) {
            let _ = fs::remove_file(&tmp_cmd);
            return Err(format!("Failed to install myagents.cmd: {}", e));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Non-Windows: copy the source .cmd as-is for completeness (unused at runtime).
        let src_cmd = cli_src.join("myagents.cmd");
        let dst_cmd = bin_dir.join("myagents.cmd");
        if src_cmd.exists() {
            fs::copy(&src_cmd, &dst_cmd)
                .map_err(|e| format!("Failed to copy CLI cmd script: {}", e))?;
        }
    }

    // Write version gate
    fs::write(&ver_file, CLI_VERSION)
        .map_err(|e| format!("CLI version write failed: {}", e))?;

    ulog_info!("[cli] Synced CLI v{}", CLI_VERSION);
    Ok(true)
}

// ============= System Skills Sync =============
//
// A distinct tier from the "seed once" bundled-skills behaviour
// (src/server/index.ts::seedBundledSkills). Those are open-ended utility
// skills users are encouraged to customise — we copy them in on first
// launch and then never touch them again.
//
// System skills are different: they encode flow-level contracts that
// must evolve in lockstep with Rust / CLI / shape changes. Example:
// `/task-implement` used to call `myagents task update-progress <id>
// "..."`; when we removed that CLI in v0.1.69+ the skill had to update
// in the same release, else existing users' AI calls would fail with
// "unknown command". The seed-once path can't deliver updates — we
// need version-gated force-overwrite, same pattern as ADMIN_AGENT
// and CLI above.
//
// To add a new system skill: put the folder in bundled-skills/, append
// its name to SYSTEM_SKILLS below, and bump SYSTEM_SKILLS_VERSION. The
// matching exclusion list in src/server/index.ts::seedBundledSkills
// MUST be kept in sync (comment there points back here).

const SYSTEM_SKILLS_VERSION: &str = "8";

/// Skills that ship with the app and MUST stay at the bundled version —
/// the app's flows depend on them, users are not meant to customise.
/// Keep in sync with the exclusion list in Bun's `seedBundledSkills()`.
const SYSTEM_SKILLS: &[&str] = &[
    "task-alignment",
    "task-implement",
    "ultra-research",
    "download-anything",
    // v8: agent-browser promoted from utility → system skill. The CLI is
    // no longer bundled with the app; the SKILL.md teaches AI to self-install
    // on first use (`npm install -g agent-browser@<pinned>`). Existing users
    // need the updated SKILL.md to land or their AI will hit `command not
    // found` after upgrading. System-skill status forces the overwrite.
    "agent-browser",
];

/// Skills unavailable on certain platforms due to upstream bugs.
/// MUST stay in sync with `src/server/utils/platform.ts::PLATFORM_BLOCKED_SKILLS`.
/// Used by `cmd_sync_system_skills` to skip force-syncing skills that the
/// Node-side runtime would later filter out anyway — prevents orphan files
/// in `~/.myagents/skills/` that confuse users.
fn is_skill_blocked_on_platform(skill_folder: &str) -> bool {
    match skill_folder {
        // agent-browser daemon broken on Windows: vercel-labs/agent-browser#398
        "agent-browser" => cfg!(target_os = "windows"),
        _ => false,
    }
}

/// Force-sync every system skill from the app bundle to
/// `~/.myagents/skills/<name>/`. Runs once per `SYSTEM_SKILLS_VERSION`
/// bump — idempotent otherwise. User edits to these directories will
/// be overwritten when the version changes, by design (see module
/// comment above).
#[tauri::command]
pub fn cmd_sync_system_skills<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let myagents_dir = home.join(".myagents");
    let skills_dir = myagents_dir.join("skills");

    // Version gate — skip the whole sweep if we've already landed
    // SYSTEM_SKILLS_VERSION on this install.
    let ver_file = myagents_dir.join(".system-skills-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == SYSTEM_SKILLS_VERSION {
            return Ok(false);
        }
    }

    // Source: app bundle resources/bundled-skills/
    let res = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let bundled_skills_dir = res.join("bundled-skills");
    if !bundled_skills_dir.exists() {
        return Err(format!("bundled-skills not found: {:?}", bundled_skills_dir));
    }

    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Failed to create skills dir: {}", e))?;

    let mut synced = Vec::new();
    let mut missing = Vec::new();
    let mut platform_skipped = Vec::new();
    for skill_name in SYSTEM_SKILLS {
        // Platform block: keep parity with Node-side `isSkillBlockedOnPlatform`
        // (src/server/utils/platform.ts). Without this, a skill marked
        // unavailable on the current platform (e.g. agent-browser on Windows
        // due to upstream daemon bug) would be force-synced into
        // ~/.myagents/skills/ but invisible to the SDK runtime — orphan
        // disk files that confuse users and serve no purpose.
        if is_skill_blocked_on_platform(skill_name) {
            platform_skipped.push(*skill_name);
            continue;
        }
        let src = bundled_skills_dir.join(skill_name);
        let dst = skills_dir.join(skill_name);
        if !src.exists() {
            // Packaging miss — skill listed in SYSTEM_SKILLS but not
            // present in the bundle. Log and continue so one missing
            // skill doesn't block the rest.
            ulog_warn!("[system-skills] bundled skill missing: {}", skill_name);
            missing.push(skill_name.to_string());
            continue;
        }
        // Remove any existing target directory so stale files (e.g.
        // renamed .md, old examples) don't linger. `merge_dir_recursive`
        // only overwrites files it encounters; it can't delete removed
        // ones, and SYSTEM_SKILLS_VERSION bumps specifically mean "the
        // whole skill snapshot is new, replace it wholesale".
        if dst.exists() {
            if let Err(e) = fs::remove_dir_all(&dst) {
                ulog_warn!(
                    "[system-skills] failed to clear {}: {} — falling back to merge",
                    skill_name,
                    e
                );
            }
        }
        merge_dir_recursive(&src, &dst)
            .map_err(|e| format!("sync {}: {}", skill_name, e))?;
        synced.push(*skill_name);
    }

    fs::write(&ver_file, SYSTEM_SKILLS_VERSION)
        .map_err(|e| format!("version write failed: {}", e))?;

    ulog_info!(
        "[system-skills] Synced v{} — ok: {:?}, missing: {:?}, platform-skipped: {:?}",
        SYSTEM_SKILLS_VERSION,
        synced,
        missing,
        platform_skipped
    );
    Ok(true)
}

/// Merge src/ into dst/ recursively. Creates missing dirs, overwrites files, never deletes.
fn merge_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" { continue; }
        let ft = entry.file_type()?;
        if ft.is_symlink() { continue; }
        let d = dst.join(&name);
        if ft.is_dir() {
            merge_dir_recursive(&entry.path(), &d)?;
        } else {
            fs::copy(&entry.path(), &d)?;
        }
    }
    Ok(())
}

/// Validate that a file path does not target sensitive system or credential directories.
/// Resolves `..` components to prevent path traversal. Mirrors `isSafeReadPath()` in Bun.
fn validate_file_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw_path);

    if !path.is_absolute() {
        return Err("Path must be absolute".to_string());
    }

    // Resolve .. and . components without requiring the file to exist
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => { resolved.pop(); },
            std::path::Component::CurDir => {},
            _ => resolved.push(component),
        }
    }

    let home = dirs::home_dir().unwrap_or_default();

    // System directories blacklist
    #[cfg(windows)]
    let forbidden_system: Vec<PathBuf> = vec![
        "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
        "C:\\ProgramData", "C:\\Recovery", "C:\\$Recycle.Bin",
    ].into_iter().map(PathBuf::from).collect();

    #[cfg(not(windows))]
    let forbidden_system: Vec<PathBuf> = vec![
        "/etc", "/var", "/usr", "/bin", "/sbin",
        "/boot", "/root", "/sys", "/proc", "/dev",
    ].into_iter().map(PathBuf::from).collect();

    for dir in &forbidden_system {
        if resolved.starts_with(dir) {
            return Err("Access denied: protected system directory".to_string());
        }
    }

    // Credential / key store directories
    if !home.as_os_str().is_empty() {
        let credential_dirs = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/op"];
        for name in &credential_dirs {
            if resolved.starts_with(home.join(name)) {
                return Err("Access denied: protected credential directory".to_string());
            }
        }

        #[cfg(target_os = "macos")]
        {
            let mac_sensitive = ["Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages", "Library/Safari"];
            for name in &mac_sensitive {
                if resolved.starts_with(home.join(name)) {
                    return Err("Access denied: protected system directory".to_string());
                }
            }
        }

        #[cfg(windows)]
        if resolved.starts_with(home.join("AppData").join("Local").join("Microsoft")) {
            return Err("Access denied: protected system directory".to_string());
        }
    }

    Ok(resolved)
}

/// Read a workspace text file. Returns content if exists, null if not.
/// Bypasses Tauri fs plugin scope (which only covers ~/.myagents).
#[tauri::command]
pub async fn cmd_read_workspace_file(path: String) -> Result<Option<String>, String> {
    let resolved = validate_file_path(&path)?;
    match tokio::fs::read_to_string(&resolved).await {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read {}: {}", path, e)),
    }
}

/// Write content to a workspace text file, creating parent directories if needed.
/// Bypasses Tauri fs plugin scope (which only covers ~/.myagents).
#[tauri::command]
pub async fn cmd_write_workspace_file(path: String, content: String) -> Result<(), String> {
    let resolved = validate_file_path(&path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    tokio::fs::write(&resolved, content).await
        .map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Delete a workspace file. Returns true if deleted, false if not found.
/// Bypasses Tauri fs plugin scope (which only covers ~/.myagents).
#[tauri::command]
pub async fn cmd_delete_workspace_file(path: String) -> Result<bool, String> {
    let resolved = validate_file_path(&path)?;
    match tokio::fs::remove_file(&resolved).await {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Failed to delete {}: {}", path, e)),
    }
}

/// Read a local file and return its contents as base64.
/// Used by the audio player to create blob URLs without asset protocol scope issues.
#[tauri::command]
pub async fn cmd_read_file_base64(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    let resolved = validate_file_path(&path)?;
    let bytes = tokio::fs::read(&resolved).await.map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(BASE64.encode(&bytes))
}

/// Open a local file with the system default application.
/// Bypasses shell plugin URL-only scope restriction.
#[tauri::command]
pub async fn cmd_open_file(path: String) -> Result<(), String> {
    // Validate: path must resolve to an existing file (prevents opening arbitrary commands)
    let canonical = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
    if !canonical.is_file() {
        return Err(format!("Not a file: {}", canonical.display()));
    }
    let safe_path = canonical.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    #[cfg(target_os = "windows")]
    {
        // Use explorer.exe instead of cmd /C start to avoid shell metacharacter injection
        std::process::Command::new("explorer")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WeCom QR Code — generate & poll for bot credentials
// Uses the public WeCom QR API (same flow as @wecom/wecom-openclaw-cli).
// These are external HTTPS requests — use proxy_config for outbound proxy.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct WecomQrGenerateResult {
    pub scode: String,
    pub auth_url: String,
}

/// Generate a WeCom QR code for one-click bot creation.
/// Returns scode (for polling) and auth_url (to render as QR image).
#[tauri::command]
pub async fn cmd_wecom_qr_generate() -> Result<WecomQrGenerateResult, String> {
    let plat = if cfg!(target_os = "macos") { 1 }
               else if cfg!(target_os = "windows") { 2 }
               else { 3 };
    let url = format!(
        "https://work.weixin.qq.com/ai/qc/generate?source=myagents&plat={}",
        plat
    );

    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;

    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WeCom QR generate request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("WeCom QR generate parse failed: {}", e))?;

    // Check for API-level errors (same pattern as poll)
    let errcode = resp["errcode"].as_i64().unwrap_or(0);
    if errcode != 0 {
        let errmsg = resp["errmsg"].as_str().unwrap_or("unknown error");
        return Err(format!("WeCom QR generate API error {}: {}", errcode, errmsg));
    }

    let data = resp.get("data").ok_or("WeCom QR response missing 'data'")?;
    let scode = data["scode"]
        .as_str()
        .ok_or("WeCom QR response missing 'scode'")?
        .to_string();
    let auth_url = data["auth_url"]
        .as_str()
        .ok_or("WeCom QR response missing 'auth_url'")?
        .to_string();

    let scode_preview: String = scode.chars().take(8).collect();
    ulog_info!("[wecom-qr] Generated QR code, scode={}", scode_preview);
    Ok(WecomQrGenerateResult { scode, auth_url })
}

#[derive(serde::Serialize)]
pub struct WecomQrPollResult {
    /// "waiting" — user hasn't scanned yet; "success" — bot created, credentials available
    pub status: String,
    pub bot_id: Option<String>,
    pub secret: Option<String>,
}

/// Poll the WeCom QR scan result. Call repeatedly until status is "success".
/// `poll_index` is used for periodic logging (log every 10th poll to reduce noise).
#[tauri::command]
pub async fn cmd_wecom_qr_poll(scode: String, poll_index: Option<u32>) -> Result<WecomQrPollResult, String> {
    // Sanitize scode: only allow alphanumeric (defense-in-depth against URL injection)
    let safe_scode: String = scode.chars().filter(|c| c.is_alphanumeric()).collect();
    let url = format!(
        "https://work.weixin.qq.com/ai/qc/query_result?scode={}",
        safe_scode
    );

    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;

    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WeCom QR poll failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("WeCom QR poll parse failed: {}", e))?;

    // Check for API-level errors first
    let errcode = resp["errcode"].as_i64().unwrap_or(0);
    if errcode != 0 {
        let errmsg = resp["errmsg"].as_str().unwrap_or("unknown error");
        ulog_error!("[wecom-qr] Poll API error {}: {}", errcode, errmsg);
        return Err(format!("WeCom QR poll API error {}: {}", errcode, errmsg));
    }

    let status_str = resp["data"]["status"].as_str().unwrap_or("waiting");
    let idx = poll_index.unwrap_or(0);

    match status_str {
        "success" => {
            let bot_info = &resp["data"]["bot_info"];
            let bot_id = bot_info["botid"].as_str().map(String::from);
            let secret = bot_info["secret"].as_str().map(String::from);
            if bot_id.is_some() && secret.is_some() {
                ulog_info!("[wecom-qr] QR scan success, bot created (poll #{})", idx);
                Ok(WecomQrPollResult { status: "success".into(), bot_id, secret })
            } else {
                // Log raw response for debugging unexpected format
                ulog_error!("[wecom-qr] Poll #{} status=success but bot_info incomplete: {}", idx, resp);
                Err("WeCom QR scan succeeded but bot_info is incomplete".into())
            }
        }
        "expired" | "cancelled" | "denied" => {
            ulog_info!("[wecom-qr] Poll #{} terminal status: {}", idx, status_str);
            Ok(WecomQrPollResult { status: status_str.into(), bot_id: None, secret: None })
        }
        _ => {
            // Periodic logging: first poll, then every 10th
            if idx == 0 || idx % 10 == 0 {
                let scode_preview: String = safe_scode.chars().take(8).collect();
                ulog_info!("[wecom-qr] Poll #{} scode={} status={}", idx, scode_preview, status_str);
            }
            Ok(WecomQrPollResult { status: "waiting".into(), bot_id: None, secret: None })
        }
    }
}

// ============= Model Discovery =============

/// Fetch provider model list via external API.
/// Returns raw JSON response — parsing is done in the frontend.
#[tauri::command]
pub async fn cmd_fetch_provider_models(
    url: String,
    auth_header_name: String,
    auth_header_value: String,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    ulog_info!("[model-discovery] Fetching models from {}", url);

    // Determine if URL points to localhost — if so, use local_http (no proxy) to avoid
    // the system-proxy-intercepts-localhost bug. Otherwise, use proxy_config for external APIs.
    let is_localhost = url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("https://127.0.0.1")
        || url.starts_with("https://localhost");

    let client = if is_localhost {
        crate::local_http::json_client(std::time::Duration::from_secs(15))
    } else {
        let builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15));
        crate::proxy_config::build_client_with_proxy(builder)?
    };

    let mut request = client.get(&url)
        .header(&auth_header_name, &auth_header_value);

    if let Some(headers) = extra_headers {
        for (key, value) in headers {
            request = request.header(key, value);
        }
    }

    let response = request.send().await
        .map_err(|e| {
            ulog_error!("[model-discovery] Network error for {}: {}", url, e);
            format!("Network error: {}", e)
        })?;

    let status = response.status();
    if !status.is_success() {
        // Limit error body to ~2KB to avoid unbounded allocation (char-boundary safe for UTF-8)
        let body = response.text().await.unwrap_or_default();
        let truncated = match body.char_indices().nth(2048) {
            Some((byte_pos, _)) => &body[..byte_pos],
            None => &body,
        };
        ulog_error!("[model-discovery] HTTP {} from {}", status.as_u16(), url);
        return Err(format!("HTTP {}: {}", status.as_u16(), truncated));
    }

    let result = response.json::<serde_json::Value>().await
        .map_err(|e| {
            ulog_error!("[model-discovery] Invalid JSON from {}: {}", url, e);
            format!("Invalid JSON response: {}", e)
        })?;

    ulog_info!("[model-discovery] Success from {}", url);
    Ok(result)
}

// ============= Agent Runtime Detection (v0.1.59) =============

/// Runtime detection result for a single CLI
#[derive(serde::Serialize, Clone)]
pub struct RuntimeDetectionResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Detect whether external Agent Runtime CLIs are installed
#[tauri::command]
pub fn cmd_detect_runtimes() -> HashMap<String, RuntimeDetectionResult> {
    let mut results = HashMap::new();

    // Builtin is always available
    results.insert("builtin".to_string(), RuntimeDetectionResult {
        installed: true,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        path: None,
    });

    // Claude Code CLI
    results.insert("claude-code".to_string(), detect_cli("claude"));

    // Codex CLI
    results.insert("codex".to_string(), detect_cli("codex"));

    // Gemini CLI (v0.1.66)
    results.insert("gemini".to_string(), detect_cli("gemini"));

    results
}

fn detect_cli(binary_name: &str) -> RuntimeDetectionResult {
    match crate::system_binary::find(binary_name) {
        Some(path) => {
            // Try to get version — MUST use process_cmd::new() to prevent Windows console flash
            let version = crate::process_cmd::new(&path)
                .arg("--version")
                .output()
                .ok()
                .and_then(|output| {
                    if output.status.success() {
                        String::from_utf8(output.stdout).ok().map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                });

            RuntimeDetectionResult {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        None => RuntimeDetectionResult {
            installed: false,
            version: None,
            path: None,
        },
    }
}
