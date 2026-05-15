// MyAgents Tauri Application
// Main entry point with sidecar lifecycle management

pub mod app_dirs;
pub mod attachment_protocol;
pub mod cli;
pub mod config_io;
mod commands;
pub mod cron_task;
mod global_shortcut;
pub mod im;
pub mod notification;
pub mod local_http;
pub mod logger;
pub mod legacy_upgrade;
#[cfg(target_os = "macos")]
mod macos_arrow_filter;
pub mod management_api;
pub mod process_cleanup;
pub mod process_cmd;
mod proxy_config;
pub mod system_binary;
mod sidecar;
mod sse_proxy;
pub mod task;
pub mod terminal;
pub mod browser;
pub mod search;
pub mod thought;
pub mod workspace_files;
mod tray;
mod updater;
pub mod utils;

use sidecar::{
    cleanup_stale_sidecars, cleanup_stale_sidecars_preamble, init_startup_cleanup_barrier,
    create_sidecar_state, stop_all_sidecars,
    // Session activation commands (for Session singleton tracking)
    cmd_get_session_activation, cmd_activate_session, cmd_deactivate_session,
    cmd_update_session_tab,
    // Cron task execution command
    cmd_execute_cron_task,
    // Session-centric Sidecar API (v0.1.11)
    cmd_ensure_session_sidecar, cmd_release_session_sidecar, cmd_get_session_port,
    cmd_upgrade_session_id, cmd_session_has_persistent_owners,
    // Background session completion
    cmd_start_background_completion, cmd_cancel_background_completion,
    cmd_get_background_sessions,
    // Proxy hot-reload
    cmd_propagate_proxy,
};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::{Emitter, Listener, LogicalPosition, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;

// Note: lib.rs is the crate root, so `#[macro_export]` macros (ulog_info!,
// ulog_error!, etc.) are already in scope here without `use`. Importing them
// would cause E0255 "name defined multiple times".

/// Check if CLI arguments indicate CLI mode (delegates to cli module).
pub fn is_cli_mode(args: &[String]) -> bool {
    cli::is_cli_mode(args)
}

/// Run in CLI mode — forward args to the Bun CLI script and return exit code.
pub fn run_cli(args: &[String]) -> i32 {
    cli::run(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── DIAGNOSTIC PANIC HOOK (April 2026 crash investigation) ─────────────
    // Install BEFORE any other init so we capture every panic, including
    // setup-time / did_finish_launching ones that don't reach the unified
    // logger. Writes to ~/.myagents/logs/panic-{pid}-{timestamp}.log so a
    // post-mortem has the actual panic message even when the app aborts
    // before normal log flush.
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let log_dir = app_dirs::myagents_data_dir()
                .map(|d| d.join("logs"))
                .unwrap_or_else(|| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&log_dir);
            let pid = std::process::id();
            let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
            let path = log_dir.join(format!("panic-{}-{}.log", pid, ts));
            let backtrace = std::backtrace::Backtrace::force_capture();
            let payload = format!(
                "TIME: {}\nPID: {}\nINFO: {}\nLOCATION: {:?}\n\nBACKTRACE:\n{}\n",
                chrono::Local::now().to_rfc3339(),
                pid,
                info,
                info.location(),
                backtrace,
            );
            let _ = std::fs::write(&path, &payload);
            // Also try to print to stderr as a fallback
            eprintln!("[PANIC-HOOK] wrote {}", path.display());
            eprintln!("{}", payload);
            prev(info);
        }));
    }

    // NOTE: cleanup_stale_sidecars() was moved into .setup() callback below.
    // This ensures it only runs for the PRIMARY app instance, not when a second
    // instance is launched (which would kill the running app's sidecar processes).
    // The single-instance plugin exits the second process before .setup() is called.

    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();

    // Create IM Bot managed state
    let im_bot_state = im::create_im_bot_state();
    // Create Agent managed state (v0.1.41)
    let agent_state = im::create_agent_state();
    let sidecar_state_for_window = sidecar_state.clone();
    let sidecar_state_for_exit = sidecar_state.clone();
    let sidecar_state_for_monitor = sidecar_state.clone();
    let sidecar_state_for_session_monitor = sidecar_state.clone();
    let sidecar_state_for_terminal_forwarder = sidecar_state.clone();

    let im_state_for_management = im_bot_state.clone();
    let agent_state_for_management = agent_state.clone();
    let sidecar_state_for_management = sidecar_state.clone();
    let im_state_for_window = im_bot_state.clone();
    let im_state_for_exit = im_bot_state.clone();
    let agent_state_for_window = agent_state.clone();
    let agent_state_for_exit = agent_state.clone();

    // Track if cleanup has been performed to avoid duplicate cleanup
    // All clones share the same underlying AtomicBool - whichever exit path
    // triggers first will do cleanup, and all others will see the flag as true
    // and skip. The separate variables are needed because each is moved into
    // a different closure (window event, app exit).
    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_done_for_window = cleanup_done.clone();
    let cleanup_done_for_exit = cleanup_done.clone();
    let cleanup_done_for_monitor = cleanup_done.clone();
    let cleanup_done_for_session_monitor = cleanup_done.clone();
    let cleanup_done_for_agent_monitor = cleanup_done.clone();
    let cleanup_done_for_terminal_forwarder = cleanup_done.clone();

    // Create terminal manager state
    let terminal_state = terminal::TerminalManager::new();
    let terminal_state_for_exit = terminal_state.clone();
    let terminal_state_for_window = terminal_state.clone();

    // Create browser manager state
    let browser_state = browser::BrowserManager::new();
    let browser_state_for_exit = browser_state.clone();
    let browser_state_for_window = browser_state.clone();

    // Create Task Center state (v0.1.69 — thought & task stores)
    let data_dir = app_dirs::myagents_data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let thought_state: thought::ManagedThoughtStore =
        Arc::new(thought::ThoughtStore::new(data_dir.join("thoughts")));
    let task_state: task::ManagedTaskStore =
        Arc::new(task::TaskStore::new(data_dir.clone()));
    // Expose the same Arcs via OnceLock singletons so the Rust Management API
    // (used by Bun CLI bridge → /api/admin/task/*) can read/write tasks without
    // access to Tauri `State`. They point at the same inner store.
    thought::set_thought_store(thought_state.clone());
    task::set_task_store(task_state.clone());

    // Create SSE proxy state
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());

    // Build the app first, then run with event handler
    // This allows us to handle RunEvent::ExitRequested for Cmd+Q and Dock quit
    let app = tauri::Builder::default()
        // Builder-level menu event handler (canonical Tauri 2 pattern).
        // Routes Window > Close Tab (Cmd+W accelerator + mouse click) to the
        // frontend, which walks its own overlay/tab close hierarchy.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "cmd-w-close" {
                if let Err(e) = app.emit("window:cmd-w", ()) {
                    ulog_warn!("[App] Cmd+W emit failed: {}", e);
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol("myagents", attachment_protocol::handle)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Another instance was launched — bring the existing window to the
            // foreground. Reuses the same routine as tray click and toast click
            // so all three "raise window" entry points stay in lockstep.
            tray::show_main_window(app);
            // Notify the front-end that the user just re-activated the app via
            // an external trigger (taskbar icon, dock click on Linux, etc.).
            // The notification module piggy-backs on this to consume any
            // pending deep-link target from a recently-clicked toast on
            // platforms where in-process Activated callbacks aren't available
            // (macOS / Linux fallback path).
            notification::on_window_activated_externally(app);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(global_shortcut::build_plugin())
        .manage(sidecar_state)
        .manage(sse_proxy_state)
        .manage(im_bot_state)
        .manage(agent_state)
        .manage(terminal_state)
        .manage(browser_state)
        .manage(thought_state)
        .manage(task_state)
        // PRD 0.2.7 Phase D: per-process registry of active workspace
        // filesystem watchers (one debouncer per workspace, ref-counted).
        .manage(std::sync::Arc::new(workspace_files::watcher::WorkspaceWatchers::default()))
        // SearchEngine will be added as managed state in .setup()
        .invoke_handler(tauri::generate_handler![
            // Legacy commands (backward compatibility)
            commands::cmd_start_sidecar,
            commands::cmd_stop_sidecar,
            commands::cmd_get_sidecar_status,
            commands::cmd_get_server_url,
            commands::cmd_restart_sidecar,
            commands::cmd_ensure_sidecar_running,
            commands::cmd_check_sidecar_alive,
            // New multi-instance commands
            commands::cmd_start_tab_sidecar,
            commands::cmd_stop_tab_sidecar,
            commands::cmd_get_tab_server_url,
            commands::cmd_get_tab_sidecar_status,
            commands::cmd_start_global_sidecar,
            commands::cmd_get_global_server_url,
            commands::cmd_stop_all_sidecars,
            commands::cmd_shutdown_for_update,
            // SSE proxy commands (multi-instance)
            sse_proxy::start_sse_proxy,
            sse_proxy::stop_sse_proxy,
            sse_proxy::stop_all_sse_proxies,
            sse_proxy::proxy_http_request,
            // Updater commands
            updater::check_and_download_update,
            updater::restart_app,
            updater::test_update_connectivity,
            updater::check_pending_update,
            updater::install_pending_update,
            // Platform & device info
            commands::cmd_get_platform,
            commands::cmd_get_device_id,
            // Bundled workspace initialization
            commands::cmd_initialize_bundled_workspace,
            commands::cmd_create_bot_workspace,
            commands::cmd_remove_bot_workspace,
            // Agent Runtime detection (v0.1.59)
            commands::cmd_detect_runtimes,
            // Workspace template commands
            commands::cmd_create_workspace_from_template,
            commands::cmd_create_workspace_from_bundled_template,
            commands::cmd_template_apply_preview,
            commands::cmd_apply_template_to_workspace,
            commands::cmd_copy_folder_to_templates,
            commands::cmd_remove_template_folder,
            // Admin agent sync
            commands::cmd_sync_admin_agent,
            // CLI sync (independent version gate)
            commands::cmd_sync_cli,
            // System skills sync (task-alignment / task-implement etc.)
            commands::cmd_sync_system_skills,
            // Cron task commands
            cron_task::cmd_create_cron_task,
            cron_task::cmd_start_cron_task,
            cron_task::cmd_stop_cron_task,
            cron_task::cmd_delete_cron_task,
            cron_task::cmd_get_cron_task,
            cron_task::cmd_get_cron_tasks,
            cron_task::cmd_get_workspace_cron_tasks,
            cron_task::cmd_get_session_cron_task,
            cron_task::cmd_get_tab_cron_task,
            cron_task::cmd_record_cron_execution,
            cron_task::cmd_update_cron_task_tab,
            cron_task::cmd_update_cron_task_session,
            cron_task::cmd_get_tasks_to_recover,
            // Cron scheduler commands
            cron_task::cmd_start_cron_scheduler,
            cron_task::cmd_mark_task_executing,
            cron_task::cmd_mark_task_complete,
            cron_task::cmd_is_task_executing,
            cron_task::cmd_get_cron_runs,
            cron_task::cmd_update_cron_task_fields,
            // Session activation commands (for Session singleton)
            cmd_get_session_activation,
            cmd_activate_session,
            cmd_deactivate_session,
            cmd_update_session_tab,
            // Cron task execution (Rust -> Sidecar direct call)
            cmd_execute_cron_task,
            // Session-centric Sidecar API (v0.1.11)
            cmd_ensure_session_sidecar,
            cmd_release_session_sidecar,
            cmd_get_session_port,
            cmd_upgrade_session_id,
            cmd_session_has_persistent_owners,
            // Background session completion
            cmd_start_background_completion,
            cmd_cancel_background_completion,
            cmd_get_background_sessions,
            // Proxy hot-reload
            cmd_propagate_proxy,
            // Global shortcut (summon-or-toggle, PRD 0.2.16)
            global_shortcut::cmd_get_global_summon_shortcut,
            global_shortcut::cmd_set_global_summon_shortcut,
            // OS notification + click-to-foreground deep-link (v0.2.14)
            notification::cmd_show_notification,
            notification::cmd_consume_notification_click,
            // IM Bot commands (non-deprecated survivors)
            im::cmd_im_conversations,
            // Group permission commands (v0.1.28)
            im::cmd_approve_group,
            im::cmd_reject_group,
            im::cmd_remove_group,
            // OpenClaw Channel Plugin commands
            im::cmd_install_openclaw_plugin,
            im::cmd_list_openclaw_plugins,
            im::cmd_uninstall_openclaw_plugin,
            im::cmd_restart_channels_using_plugin,
            im::cmd_plugin_qr_login_start,
            im::cmd_plugin_qr_login_wait,
            im::cmd_plugin_restart_gateway,
            // Agent commands (v0.1.41)
            im::cmd_start_agent_channel,
            im::cmd_stop_agent_channel,
            im::cmd_agent_channel_status,
            im::cmd_agent_status,
            im::cmd_all_agents_status,
            im::cmd_update_agent_config,
            im::cmd_create_agent,
            im::cmd_delete_agent,
            // Session ↔ channel surface handover (PRD 0.2.14)
            im::handover::cmd_session_new_with_surface_migration,
            im::handover::cmd_handover_session_to_channel,
            // WeCom QR code commands (public API, not plugin gateway)
            commands::cmd_wecom_qr_generate,
            commands::cmd_wecom_qr_poll,
            // Model discovery
            commands::cmd_fetch_provider_models,
            // Terminal commands (embedded PTY)
            terminal::cmd_terminal_create,
            terminal::cmd_terminal_write,
            terminal::cmd_terminal_resize,
            terminal::cmd_terminal_close,
            // Browser commands (embedded webview)
            browser::cmd_browser_create,
            browser::cmd_browser_navigate,
            browser::cmd_browser_go_back,
            browser::cmd_browser_go_forward,
            browser::cmd_browser_reload,
            browser::cmd_browser_resize,
            browser::cmd_browser_show,
            browser::cmd_browser_hide,
            browser::cmd_browser_close,
            // File utility commands
            commands::cmd_read_workspace_file,
            commands::cmd_write_workspace_file,
            commands::cmd_delete_workspace_file,
            commands::cmd_read_file_base64,
            commands::cmd_open_file,
            config_io::cmd_fsync_path,
            // Workspace file IO (workspace_files module).
            // Phase A (input-box unification): files_b64 / transfer / gitignore /
            //   search / delete / slash.
            // Phase D (DirectoryPanel migration): tree / read_preview / download /
            //   crud / system_open / git_branch / watcher.
            //
            // These replace sidecar HTTP endpoints (/api/files/*, /agent/*,
            // /api/commands, /api/git/branch). See PRD 0.2.7.
            //
            // tauri::generate_handler! resolves auto-generated `__cmd__<name>` wrappers
            // from the same module that defined the command, so we MUST use the
            // submodule path (e.g. `workspace_files::files_b64::cmd_…`), not the
            // re-export at the parent module level.
            workspace_files::files_b64::cmd_workspace_import_files_b64,
            workspace_files::files_b64::cmd_workspace_read_files_b64,
            workspace_files::check_paths::cmd_workspace_check_paths,
            workspace_files::transfer::cmd_workspace_copy_paths,
            workspace_files::gitignore::cmd_workspace_add_gitignore,
            workspace_files::search::cmd_workspace_search_files_fuzzy,
            workspace_files::delete::cmd_workspace_delete,
            workspace_files::slash::cmd_list_slash_commands,
            workspace_files::tree::cmd_workspace_dir_tree,
            workspace_files::tree::cmd_workspace_dir_expand,
            workspace_files::read_preview::cmd_workspace_read_preview,
            workspace_files::download::cmd_workspace_download_file,
            workspace_files::save_file::cmd_workspace_save_file,
            workspace_files::claude_md::cmd_workspace_read_claude_md,
            workspace_files::claude_md::cmd_workspace_write_claude_md,
            workspace_files::crud::cmd_workspace_new_file,
            workspace_files::crud::cmd_workspace_new_folder,
            workspace_files::crud::cmd_workspace_rename,
            workspace_files::crud::cmd_workspace_move,
            workspace_files::system_open::cmd_workspace_open_in_finder,
            workspace_files::system_open::cmd_workspace_open_with_default,
            workspace_files::system_open::cmd_open_path_external,
            workspace_files::system_open::cmd_open_path_with_default,
            workspace_files::git_branch::cmd_workspace_git_branch,
            workspace_files::watcher::cmd_workspace_watch_start,
            workspace_files::watcher::cmd_workspace_watch_stop,
            // Full-text search commands
            search::cmd_search_sessions,
            search::cmd_search_workspace_files,
            search::cmd_search_index_status,
            search::cmd_invalidate_workspace_index,
            search::cmd_refresh_workspace_index,
            search::cmd_search_thoughts,
            search::cmd_search_tasks,
            // Task Center — Thought commands (v0.1.69)
            thought::cmd_thought_create,
            thought::cmd_thought_list,
            thought::cmd_thought_get,
            thought::cmd_thought_update,
            thought::cmd_thought_delete,
            thought::cmd_thought_merge,
            thought::cmd_thought_open_dir,
            thought::cmd_thought_set_archived,
            // Task Center — Task commands (v0.1.69)
            task::cmd_task_create_direct,
            task::cmd_task_create_from_alignment,
            task::cmd_task_list,
            task::cmd_task_get,
            task::cmd_task_update,
            task::cmd_task_update_status,
            task::cmd_task_append_session,
            task::cmd_task_write_alignment_metadata,
            task::cmd_task_archive,
            task::cmd_task_delete,
            task::cmd_task_read_doc,
            task::cmd_task_write_doc,
            task::cmd_task_open_docs_dir,
            task::cmd_task_get_run_stats,
            legacy_upgrade::cmd_task_upgrade_legacy_cron,
        ])
        .setup(|app| {
            // Initialize logging before acquire_lock() and cleanup_stale_sidecars()
            // because those paths need a logger backend for log::warn!/info! calls.
            use tauri_plugin_log::{Target, TargetKind};

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;

            // Initialize global AppHandle for unified logging (IM module etc.)
            logger::init_app_handle(app.handle().clone());

            // Pattern 6: spawn the buffered writer task so subsequent
            // ulog_*! calls go through the bounded mpsc → BufWriter path
            // instead of opening/appending/closing per line. Pre-init
            // calls (extremely early startup) fall back to a synchronous
            // append protected by a mutex.
            logger::init_buffered_writer();

            // Main window: programmatic creation so we can attach
            // `on_navigation` to block external top-frame navigation. The
            // native WKWebView context menu's "Open Link" entry triggers a
            // direct top-frame navigation that bypasses React `onClick`
            // handlers — without this gate the entire app gets replaced by
            // the linked page with no way back (bug: right-click → 软件报废).
            //
            // Why programmatic instead of config: Tauri 2.x has no setter for
            // `on_navigation` on an already-created window. So
            // `tauri.conf.json` has `windows: []` and we build here. All other
            // original config (size, decorations, traffic light position) is
            // replicated below. `WebviewUrl::default()` resolves to the
            // configured devUrl (dev) / `tauri://localhost` (prod)
            // automatically — no manual dev/prod branching needed.
            //
            // Order: must be BEFORE macos_arrow_filter::install_arrow_key_filter
            // because the filter looks up the WryWebView ObjC class which is
            // only registered after the first webview is constructed.
            let main_window_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::default(),
            )
            .title("MyAgents")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .fullscreen(false)
            .center()
            .decorations(true)
            // `transparent(false)` is the default in Tauri and the setter is
            // gated behind `macos-private-api` on macOS, so we omit it (the
            // original config field was effectively a no-op).
            .on_navigation(|url: &Url| {
                let scheme = url.scheme();
                // Tauri-internal / renderer-internal schemes: always allow.
                // - tauri / ipc: Tauri 2.x core IPC bridges
                // - asset: tauri-plugin-fs asset serving
                // - myagents / myagents-internal: app's custom protocols
                // - about / blob / data: renderer-side internal URLs
                if matches!(
                    scheme,
                    "tauri"
                        | "ipc"
                        | "asset"
                        | "myagents"
                        | "myagents-internal"
                        | "about"
                        | "blob"
                        | "data"
                ) {
                    return true;
                }
                // http(s): allow only localhost / 127.0.0.1 / tauri.localhost /
                // ipc.localhost. Dev mode loads from http://localhost:5173,
                // Windows prod loads from http://tauri.localhost, IPC bridges
                // use http://ipc.localhost. Anything else is an external URL —
                // hand it to the OS default browser and cancel the navigation
                // so the main webview stays on the app.
                if scheme == "http" || scheme == "https" {
                    let host = url.host_str().unwrap_or("");
                    if matches!(
                        host,
                        "localhost" | "127.0.0.1" | "tauri.localhost" | "ipc.localhost"
                    ) {
                        return true;
                    }
                    ulog_info!(
                        "[main-window] BLOCKED external nav → system browser: {}",
                        url
                    );
                    browser::spawn_external_open(url.as_str());
                    return false;
                }
                // mailto / tel: route to OS default handler, cancel nav.
                if matches!(scheme, "mailto" | "tel") {
                    browser::spawn_external_open(url.as_str());
                    return false;
                }
                // Everything else (javascript:, file:, unknown schemes) — block.
                ulog_warn!(
                    "[main-window] BLOCKED nav with scheme {}: {}",
                    scheme,
                    url
                );
                false
            });

            // Platform-specific window chrome — replicates the original
            // tauri.conf.json fields. macOS uses the Overlay title bar style
            // (custom titlebar + native traffic lights at LogicalPosition).
            // Windows handles decorations later in setup (see "Windows: Remove
            // system decorations" block below); the builder runs uniformly.
            #[cfg(target_os = "macos")]
            let main_window_builder = main_window_builder
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .traffic_light_position(LogicalPosition::new(14.0, 20.0));

            main_window_builder
                .build()
                .map_err(|e| {
                    ulog_error!("[App] Failed to build main window: {}", e);
                    e
                })?;

            // macOS WKWebView function-key tofu workaround. Must run AFTER
            // the main window is built so the WryWebView ObjC class is
            // registered with the runtime (the class is created lazily on
            // first webview construction). ObjC method lookup is dynamic, so
            // adding methods here affects the already-created instance before
            // the user can type.
            #[cfg(target_os = "macos")]
            macos_arrow_filter::install_arrow_key_filter();

            // Acquire PID lock — kills any stale instance that macOS auto-restarted
            // (e.g., after build_dev.sh pkill). Must run before cleanup_stale_sidecars
            // so we don't kill sidecars belonging to an instance we're about to replace.
            // The single-instance plugin handles the "user double-clicked" case via IPC;
            // this lock handles the "build script killed + macOS restarted" case via PID.
            let lock_state = app_dirs::acquire_lock();
            let had_prior_instance = lock_state.had_prior_instance();

            // Stale sidecar cleanup:
            //   1. Run the fast preamble (remove stale port file) synchronously
            //      so CLI / admin-api see a consistent state immediately.
            //   2. Hoist the heavy scan onto a blocking worker. Previously this
            //      ran synchronously on the main thread and blocked Tauri
            //      `setup()` for 5–15 s on Windows (PowerShell/WMI cold
            //      start × 6 patterns), which directly caused the
            //      "frontend freezes on first launch" user report. The new
            //      `process_cleanup` module uses native `sysinfo` (no
            //      subprocess spawn) and completes in ~10–200 ms.
            //   3. `start_tab_sidecar` waits on the barrier before
            //      spawning, so port allocation still serializes with
            //      cleanup — no correctness regression.
            init_startup_cleanup_barrier();
            cleanup_stale_sidecars_preamble();
            tauri::async_runtime::spawn_blocking(move || {
                // Panic-safe: if cleanup panics (sysinfo crash, etc.) we
                // still MUST mark the barrier done, otherwise every future
                // sidecar spawn will wait the full 15 s timeout. The outer
                // guard fires regardless of whether the inner closure
                // returned normally or unwound.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cleanup_stale_sidecars(had_prior_instance);
                }));
                // Always mark done — cleanup_stale_sidecars normally marks
                // internally on success, but we cover both the panic path
                // and any early-return paths we might add in the future.
                sidecar::mark_startup_cleanup_done();
                if let Err(panic) = result {
                    // Try to log something useful about the panic.
                    let msg = panic
                        .downcast_ref::<&'static str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "<non-string panic payload>".to_string());
                    ulog_error!(
                        "[sidecar] cleanup_stale_sidecars panicked: {} — barrier released so startup can proceed",
                        msg
                    );
                }
            });

            // ── Boot Banner: single-line consolidated diagnostics for AI grep ──
            {
                let pkg = app.package_info();
                let version = pkg.version.to_string();
                let build_mode = if cfg!(debug_assertions) { "debug" } else { "release" };
                let os = std::env::consts::OS;
                let arch = std::env::consts::ARCH;
                let data_dir = app_dirs::myagents_data_dir();
                let dir_str = data_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "?".into());

                // Read config.json for counts (best-effort)
                let (mut provider, mut mcp, mut agents, mut channels, mut cron, mut proxy) =
                    ("?".to_string(), 0u32, 0u32, 0u32, 0u32, false);
                if let Some(ref dir) = data_dir {
                    if let Ok(c) = std::fs::read_to_string(dir.join("config.json"))
                        .ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).ok_or(()) {
                        // won't reach — see below
                        let _ = c;
                    }
                    // Simpler: parse as Value directly. strip_bom tolerates a
                    // Windows-editor-prepended UTF-8 BOM (issue #170 #6) so the
                    // boot log reflects real config values instead of "?".
                    if let Ok(cfg) = std::fs::read_to_string(dir.join("config.json"))
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&s)).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))) {
                        provider = cfg.get("defaultProviderId").and_then(|v| v.as_str()).unwrap_or("none").to_string();
                        mcp = cfg.get("mcpEnabledServers").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0);
                        if let Some(ags) = cfg.get("agents").and_then(|v| v.as_array()) {
                            agents = ags.len() as u32;
                            for a in ags { channels += a.get("channels").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0); }
                        }
                        proxy = cfg.get("proxySettings").and_then(|v| v.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
                    }
                    if let Ok(s) = std::fs::read_to_string(dir.join("cron_tasks.json")) {
                        // Structure: {"tasks": [{...,"enabled":true/false}, ...]}
                        cron = serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&s)).ok()
                            .and_then(|v| v.get("tasks")?.as_array().map(|tasks|
                                tasks.iter().filter(|t| t.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)).count() as u32
                            )).unwrap_or(0);
                    }
                }

                ulog_info!("[boot] v={} build={} os={}-{} provider={} mcp={} agents={} channels={} cron={} proxy={} dir={}", version, build_mode, os, arch, provider, mcp, agents, channels, cron, proxy, dir_str);
            }

            // Setup system tray
            if let Err(e) = tray::setup_tray(app) {
                ulog_error!("[App] Failed to setup system tray: {}", e);
            }

            // Register global summon shortcut from config (PRD 0.2.16).
            // Failures are non-fatal — they surface in the Settings panel.
            global_shortcut::setup_on_startup(app.handle());

            // Frontend confirms exit (from X button → ConfirmDialog → "退出" button).
            // Delegate to `AppHandle::exit(0)` and let `RunEvent::ExitRequested` run
            // cleanup on the main run-loop thread. Running cleanup inline here would
            // deadlock/panic: this callback fires from within the `plugin:event|emit`
            // async command (a Tokio worker), and `tauri::async_runtime::block_on`
            // inside a Tokio worker panics with "Cannot start a runtime from within
            // a runtime" — the panic is swallowed and `exit(0)` never runs, which is
            // why X-button close silently failed before.
            let app_handle_for_tray = app.handle().clone();
            app.listen("tray:confirm-exit", move |_| {
                ulog_info!("[App] Frontend confirmed exit, delegating to run-loop cleanup");
                app_handle_for_tray.exit(0);
            });

            // Open DevTools in debug builds
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // macOS: Custom menu — replace native "Close Window" (Cmd+W) with a custom
            // menu item that emits window:cmd-w to the frontend. This separates the
            // Cmd+W path (overlay → tab → launcher → stop) from the X button path
            // (CloseRequested → tray/exit). Without this, Cmd+W triggers CloseRequested
            // which hides the window before JS can handle it.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem, WINDOW_SUBMENU_ID};

                let app_name = app.package_info().name.clone();
                let app_handle = app.handle();

                let close_tab = MenuItemBuilder::with_id("cmd-w-close", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app_handle)?;

                let app_menu = SubmenuBuilder::new(app_handle, &app_name)
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                // Use `WINDOW_SUBMENU_ID` (the magic Tauri 2 constant) so
                // `init_app_menu` calls `NSApp.setWindowsMenu(menu)` — i.e.
                // marks this submenu as macOS's official Window menu (used
                // for the open-window tracking list, "Bring All to Front",
                // etc.). Tauri's default Window menu uses the same ID; we
                // mirror that pattern when supplying our own.
                let window_menu = SubmenuBuilder::with_id(app_handle, WINDOW_SUBMENU_ID, "Window")
                    .item(&close_tab)
                    .item(&PredefinedMenuItem::minimize(app_handle, None)?)
                    .item(&PredefinedMenuItem::maximize(app_handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app_handle, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app_handle)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&window_menu)
                    .build()?;

                app.set_menu(menu)?;
                // Note: the matching `on_menu_event` handler lives at Builder
                // level at the top of `run()`.
            }

            // Windows: Remove system decorations for custom title bar
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    ulog_info!("[App] Windows: Disabled system decorations for custom title bar");
                }
            }

            // Inject IM/Agent/Sidecar state into management API (for /api/im/wake endpoint etc.)
            management_api::set_im_bots_state(im_state_for_management);
            management_api::set_agent_state(agent_state_for_management);
            management_api::set_sidecar_state(sidecar_state_for_management);

            // Start management API (internal HTTP server for Bun→Rust IPC)
            tauri::async_runtime::spawn(async move {
                match management_api::start_management_api().await {
                    Ok(port) => ulog_info!("[App] Management API started on port {}", port),
                    Err(e) => ulog_error!("[App] Failed to start management API: {}", e),
                }
            });

            // Bridge `SidecarManager::terminal_events` → `session:sidecar-terminal`
            // Tauri event. Renderer's App.tsx listens and resets `tab.sessionId`
            // bindings whose underlying sidecar has been definitively released
            // (no owners remained at removal → no auto-restart will revive it).
            // Without this bridge, voluntary-release leaves stale Tab.sessionId
            // values which `planSessionOpen` then "jump-to-tab"s into → empty
            // UI + sidecar-not-running errors. See `forward_terminal_events_to_renderer`
            // doc-comment for the full rationale.
            //
            // Spawn order: BEFORE cron/IM auto-start so any sidecar created
            // and terminally-removed by those subsystems on startup is captured.
            // The forwarder subscribes synchronously inside the spawned task
            // (first await is `rx.recv()`); broadcast channel buffers up to 64
            // events so the few-millisecond gap before `subscribe()` runs is
            // covered. (Codex review ADV-4.)
            let app_handle_for_terminal_forwarder = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::forward_terminal_events_to_renderer(
                    app_handle_for_terminal_forwarder,
                    sidecar_state_for_terminal_forwarder,
                    cleanup_done_for_terminal_forwarder,
                ).await;
            });
            ulog_info!("[App] Sidecar terminal-event forwarder spawned");

            // Initialize cron task manager with app handle
            let cron_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                cron_task::initialize_cron_manager(cron_app_handle).await;
            });
            ulog_info!("[App] Cron task manager initialization scheduled");

            // Initialize SearchEngine (full-text search)
            if let Some(data_dir) = app_dirs::myagents_data_dir() {
                match search::SearchEngine::new(data_dir) {
                    Ok(engine) => {
                        engine.start_background_indexing();
                        app.manage(Arc::new(engine));
                        ulog_info!("[App] SearchEngine initialized");
                    }
                    Err(e) => {
                        ulog_error!("[App] Failed to create SearchEngine: {}", e);
                    }
                }
            }

            // Auto-start IM Bot if previously enabled (3s delay)
            im::schedule_auto_start(app.handle().clone());
            ulog_info!("[App] IM Bot auto-start scheduled");

            // Auto-start Agent channels (4s delay, after IM bots)
            im::schedule_agent_auto_start(app.handle().clone());
            ulog_info!("[App] Agent auto-start scheduled");

            // Start Global Sidecar health monitor
            // Periodically checks if the Global Sidecar is alive and auto-restarts it
            // This prevents the "all network broken" state on Windows when the window
            // is minimized to tray and the OS kills child processes
            let app_handle_for_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_global_sidecar(
                    app_handle_for_monitor,
                    sidecar_state_for_monitor,
                    cleanup_done_for_monitor,
                ).await;
            });
            ulog_info!("[App] Global sidecar health monitor spawned");

            // Start Session Sidecar health monitor (20s initial delay)
            let app_handle_for_session_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_session_sidecars(
                    app_handle_for_session_monitor,
                    sidecar_state_for_session_monitor,
                    cleanup_done_for_session_monitor,
                ).await;
            });
            ulog_info!("[App] Session sidecar health monitor spawned");

            // Start Agent Channel health monitor (15s initial delay)
            let app_handle_for_agent_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                im::monitor_agent_channels(
                    app_handle_for_agent_monitor,
                    cleanup_done_for_agent_monitor,
                ).await;
            });
            ulog_info!("[App] Agent channel health monitor spawned");

            // Start background update check (5 second delay to let app initialize)
            ulog_info!("[App] Setup complete, spawning background update check task...");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ulog_info!("[App] Background update task started, waiting 5 seconds...");
                updater::check_update_on_startup(app_handle).await;
                ulog_info!("[App] Background update task completed");
            });
            ulog_info!("[App] Background update task spawned successfully");

            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Handle window close request (X button) - minimize to tray instead
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Check if minimize to tray is enabled
                    // Emit event to frontend to check config and decide
                    ulog_info!("[App] Window close requested, emitting event to frontend");
                    let _ = window.emit("window:close-requested", ());
                    // Prevent default close behavior - let frontend decide
                    api.prevent_close();
                }
                // Clean up when window is actually destroyed
                tauri::WindowEvent::Destroyed => {
                    use std::sync::atomic::Ordering::Relaxed;
                    if !cleanup_done_for_window.swap(true, Relaxed) {
                        ulog_info!("[App] Window destroyed, cleaning up sidecars...");
                        im::signal_all_agents_shutdown(&agent_state_for_window);
                        im::signal_all_bots_shutdown(&im_state_for_window);
                        let _ = stop_all_sidecars(&sidecar_state_for_window);
                        // Clean up terminal PTY sessions
                        let ts = terminal_state_for_window.clone();
                        tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                        // Clean up browser webviews
                        let bs = browser_state_for_window.clone();
                        let app_for_browser = window.app_handle().clone();
                        tauri::async_runtime::block_on(browser::close_all_browsers(&bs, &app_for_browser));
                        app_dirs::release_lock();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to catch Cmd+Q, Dock quit, and Dock click
    app.run(move |_app_handle, event| {
        match event {
            // Handle app exit events (Cmd+Q, Dock right-click quit, etc.)
            tauri::RunEvent::ExitRequested { .. } => {
                // Only cleanup once (Relaxed is sufficient for simple flag)
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_exit.swap(true, Relaxed) {
                    ulog_info!("[App] Exit requested (Cmd+Q or Dock quit), cleaning up sidecars...");
                    im::signal_all_agents_shutdown(&agent_state_for_exit);
                    im::signal_all_bots_shutdown(&im_state_for_exit);
                    let _ = stop_all_sidecars(&sidecar_state_for_exit);
                    // Clean up terminal PTY sessions
                    let ts = terminal_state_for_exit.clone();
                    tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                    // Clean up browser webviews
                    let bs = browser_state_for_exit.clone();
                    tauri::async_runtime::block_on(browser::close_all_browsers(&bs, _app_handle));
                    app_dirs::release_lock();
                }
            }
            // Handle Dock icon click on macOS (Reopen event)
            // This is triggered when user clicks the Dock icon while app is running but window is hidden
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                ulog_info!("[App] Dock icon clicked (Reopen), showing main window");
                use tauri::Manager;
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
}
