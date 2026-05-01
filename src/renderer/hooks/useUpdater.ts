// React hook for managing auto-updates (silent background updates)
//
// Flow:
// 1. Rust checks and downloads updates silently on startup
// 2. When ready, Rust emits 'updater:ready-to-restart' event
// 3. This hook receives the event and sets updateReady = true
// 4. UI shows "Restart to Update" button in titlebar
// 5. User clicks → restartAndUpdate() → app restarts with new version

import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';

import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { compareVersions } from '../../shared/utils';

export interface UpdateReadyInfo {
    version: string;
}

/** Result of a manual update check, used by caller for user-facing feedback (toast) */
export type CheckUpdateResult = 'up-to-date' | 'downloading' | 'error';

/** Result of restartAndUpdate, used by caller to show an error toast. 'ok' means
 *  install actually started (process is about to exit) — the renderer just won't
 *  see the resolution because Rust calls exit(0). */
export type RestartUpdateResult = 'ok' | 'network-error' | 'version-mismatch' | 'error';

interface UseUpdaterResult {
    /** Whether an update has been downloaded and is ready to install */
    updateReady: boolean;
    /** The version that's ready to install */
    updateVersion: string | null;
    /** Restart the app to apply the update. Returns the outcome so the caller
     *  can surface a toast for failure modes. */
    restartAndUpdate: () => Promise<RestartUpdateResult>;
    /** Whether a manual check is in progress */
    checking: boolean;
    /** Whether an update is being downloaded */
    downloading: boolean;
    /** Whether an install is currently in flight (button click → install start) */
    installing: boolean;
    /** Whether a silent download is currently writing the next pending package
     *  to disk. Mutually exclusive with the install button: while preparing,
     *  the button hides because the version it claims to be "ready" may be
     *  about to be replaced (or, on first-time download, isn't on disk yet). */
    preparing: boolean;
    /** Manually trigger an update check. Returns result for caller to show toast feedback. */
    checkForUpdate: () => Promise<CheckUpdateResult>;
    /** Version of a pending update discovered on startup (Windows only, from disk) */
    pendingUpdateOnStartup: string | null;
    /** Dismiss the startup pending update dialog (keeps "Restart to Update" button visible) */
    dismissPendingUpdate: () => void;
}

// Detect Windows platform
const isWindows = typeof navigator !== 'undefined' && navigator.platform?.includes('Win');

// Periodic check interval: 30 minutes
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function useUpdater(): UseUpdaterResult {
    const [updateReady, setUpdateReady] = useState(false);
    const [updateVersion, setUpdateVersion] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [preparing, setPreparing] = useState(false);
    // Windows: version from disk-persisted pending update (shown as startup dialog)
    const [pendingUpdateOnStartup, setPendingUpdateOnStartup] = useState<string | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const updateReadyRef = useRef(false);
    // Ref guards for checkForUpdate to prevent race conditions on rapid clicks.
    // State values in a useCallback closure can be stale; refs are always current.
    const checkingRef = useRef(false);
    const downloadingRef = useRef(false);
    const installingRef = useRef(false);
    // Cache app version — it never changes during a session, no need to IPC every time.
    const appVersionRef = useRef<string | null>(null);

    // Keep ref in sync with state
    useEffect(() => {
        updateReadyRef.current = updateReady;
    }, [updateReady]);

    // Manual update check: test connectivity → compare version → download if needed
    // Returns a result string so the caller can show appropriate toast feedback.
    const checkForUpdate = useCallback(async (): Promise<CheckUpdateResult> => {
        if (!isTauriEnvironment()) {
            console.warn('[useUpdater] Manual check not available outside Tauri');
            return 'error';
        }
        // Use refs for guards — immune to stale closure on rapid clicks
        if (updateReadyRef.current) return 'downloading';  // Already downloaded, pending restart
        if (checkingRef.current || downloadingRef.current) return 'downloading';  // In progress

        checkingRef.current = true;
        setChecking(true);
        // When background download is already in progress, we keep the downloading
        // spinner visible and let the updater:ready-to-restart event clear it.
        let keepDownloadingState = false;
        try {
            // Step 1: Get remote version
            const result = await invoke('test_update_connectivity') as string;
            const versionMatch = result.match(/version:\s*([^\n]+)/);
            if (!versionMatch) {
                throw new Error('无法解析远程版本信息');
            }
            const remoteVer = versionMatch[1].trim();

            // Step 2: Get local version (cached) and compare
            if (!appVersionRef.current) {
                appVersionRef.current = await getVersion();
            }
            const comparison = compareVersions(remoteVer, appVersionRef.current);

            if (comparison <= 0) {
                // Already up to date
                return 'up-to-date';
            }

            // Step 3: New version available → download
            checkingRef.current = false;
            setChecking(false);
            downloadingRef.current = true;
            setDownloading(true);
            setUpdateVersion(remoteVer);

            const downloaded = await invoke('check_and_download_update') as boolean;
            if (downloaded) {
                // updater:ready-to-restart event will also fire and set updateReady
                setUpdateReady(true);
                return 'downloading';
            }
            // check_and_download_update returned false, but we already confirmed
            // comparison > 0 (newer version exists). This typically means the Rust
            // background download is already in progress (UPDATE_IN_PROGRESS lock).
            // Keep downloading spinner visible — updater:ready-to-restart event will
            // call setDownloading(false) and setUpdateReady(true) when background finishes.
            keepDownloadingState = true;
            return 'downloading';
        } catch (err) {
            console.error('[useUpdater] Manual check failed:', err);
            return 'error';
        } finally {
            // Always reset checking guards
            checkingRef.current = false;
            setChecking(false);
            // Only reset downloading if not handed off to background download
            if (!keepDownloadingState) {
                downloadingRef.current = false;
                setDownloading(false);
            }
        }
    }, []); // Stable reference — all mutable state accessed via refs

    // Dismiss the startup pending update dialog (keeps "Restart to Update" button visible)
    const dismissPendingUpdate = useCallback(() => {
        setPendingUpdateOnStartup(null);
    }, []);

    // Restart app to apply the update.
    //
    // Returns the outcome so callers can show user feedback (toast).
    // On success the renderer never resumes — the OS process exits via NSIS
    // (Windows) or relaunch (macOS).
    //
    // Important: on Windows we no longer call cmd_shutdown_for_update from
    // here. The Rust install_pending_update handles shutdown internally,
    // AFTER it has resolved a usable Update object. Pre-killing the user's
    // sidecars and then failing the install (e.g., flaky network) was the
    // root cause of the "click does nothing" reports — the user was left in
    // a broken state with the install never actually starting.
    const restartAndUpdate = useCallback(async (): Promise<RestartUpdateResult> => {
        if (!isTauriEnvironment()) return 'error';
        if (installingRef.current) return 'ok';  // already in flight

        // Track update_install event before restarting
        if (updateVersion) {
            track('update_install', { version: updateVersion });
        } else {
            track('update_install');
        }

        installingRef.current = true;
        setInstalling(true);

        // Windows: use install_pending_update which launches NSIS from saved bytes
        // This avoids relaunch() which would just restart without applying the update
        if (isWindows) {
            try {
                await invoke('install_pending_update');
                // install_pending_update calls exit(0) on Windows, so we won't reach here.
                return 'ok';
            } catch (err) {
                const errStr = String(err);
                installingRef.current = false;
                setInstalling(false);
                if (errStr.includes('VERSION_MISMATCH')) {
                    console.warn('[useUpdater] Pending update version mismatch, will re-download');
                    setUpdateReady(false);
                    setUpdateVersion(null);
                    setPendingUpdateOnStartup(null);
                    // Trigger a fresh download (silent — toast tells user what's up)
                    void invoke('check_and_download_update');
                    return 'version-mismatch';
                }
                if (errStr.includes('NETWORK_ERROR')) {
                    // Network was unreachable for all retries. Keep the
                    // update-ready state so the user can retry once online.
                    console.warn('[useUpdater] Network required to verify update, will retry when online');
                    return 'network-error';
                }
                console.error('[useUpdater] install_pending_update failed:', err);
                return 'error';
            }
        }

        // macOS / Linux: relaunch picks up the already-installed update.
        // On macOS the .app was swapped during silent download_and_install;
        // on Linux the AppImage was overwritten in place. Either way the
        // bytes are committed by the time we get here, so a failure below
        // just means we couldn't gracefully reboot — far less severe than
        // the Windows pre-shutdown failure mode. Sidecar shutdown still
        // helps (releases child processes) but is best-effort.
        try {
            await invoke('cmd_shutdown_for_update');
        } catch (err) {
            console.warn('[useUpdater] Pre-restart cleanup failed:', err);
        }
        try {
            await relaunch();
            return 'ok';
        } catch (err) {
            console.error('[useUpdater] Restart failed:', err);
            try {
                await invoke('restart_app');
                return 'ok';
            } catch (e) {
                console.error('[useUpdater] Rust restart also failed:', e);
                installingRef.current = false;
                setInstalling(false);
                return 'error';
            }
        }
    }, [updateVersion]);

    // Listen for update ready event from Rust
    useEffect(() => {
        if (!isTauriEnvironment()) {
            if (isDebugMode()) {
                console.log('[useUpdater] Not in Tauri environment, skipping event listener setup');
            }
            return;
        }

        if (isDebugMode()) {
            console.log('[useUpdater] Setting up event listener for updater:ready-to-restart...');
        }
        let isMounted = true;
        // Multiple events feed the same state machine; collect their
        // unlisteners so the cleanup tears them down together.
        const unlisteners: UnlistenFn[] = [];

        const setup = async () => {
            try {
                unlisteners.push(await listen<UpdateReadyInfo>('updater:ready-to-restart', (event) => {
                    if (isDebugMode()) {
                        console.log('[useUpdater] Event received: updater:ready-to-restart', event.payload);
                    }
                    if (!isMounted) return;
                    setUpdateVersion(event.payload.version);
                    setUpdateReady(true);
                    setDownloading(false);
                    setPreparing(false);
                }));
                // `download-started` hides the install button: the bytes that
                // would back a click are mid-replacement, so the click target
                // is briefly inconsistent. Mirror via `download-failed` to
                // un-hide if the download couldn't commit.
                unlisteners.push(await listen<UpdateReadyInfo>('updater:download-started', (event) => {
                    if (isDebugMode()) {
                        console.log('[useUpdater] Event received: updater:download-started', event.payload);
                    }
                    if (!isMounted) return;
                    setPreparing(true);
                }));
                unlisteners.push(await listen<UpdateReadyInfo>('updater:download-failed', (event) => {
                    if (isDebugMode()) {
                        console.log('[useUpdater] Event received: updater:download-failed', event.payload);
                    }
                    if (!isMounted) return;
                    setPreparing(false);
                }));
                if (isDebugMode()) {
                    console.log('[useUpdater] Event listeners registered successfully');
                }
            } catch (err) {
                console.error('[useUpdater] Failed to setup event listener:', err);
                // Partial registration: still tear down whatever succeeded.
                for (const fn of unlisteners) fn();
            }
        };

        void setup();

        return () => {
            isMounted = false;
            for (const fn of unlisteners) fn();
        };
    }, []);

    // Windows: check for pending update on disk at startup
    // If found, show a dialog prompting the user to install it
    useEffect(() => {
        if (!isTauriEnvironment() || !isWindows) return;

        const checkPending = async () => {
            try {
                const version = await invoke('check_pending_update') as string | null;
                if (version) {
                    if (isDebugMode()) {
                        console.log(`[useUpdater] Found pending update v${version} on disk`);
                    }
                    setPendingUpdateOnStartup(version);
                    setUpdateVersion(version);
                    setUpdateReady(true);
                }
            } catch (err) {
                console.error('[useUpdater] Failed to check pending update:', err);
            }
        };

        void checkPending();
    }, []);

    // Periodic background check (silent - just triggers Rust to check and download)
    // Uses ref to avoid recreating interval when updateReady changes
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const doCheck = async () => {
            // Always check — even if an update is already ready.
            // The Rust backend tracks the downloaded version and only re-downloads
            // if the server has something NEWER (latest-wins protocol).
            // This ensures v0.1.61 replaces a cached v0.1.60 seamlessly.
            try {
                await invoke('check_and_download_update');
                // Track update_check event only after successful check
                track('update_check');
            } catch (err) {
                // Silent failure - don't bother user
                console.error('[useUpdater] Periodic check failed:', err);
            }
        };

        intervalRef.current = setInterval(() => {
            void doCheck();
        }, CHECK_INTERVAL_MS);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, []); // Empty deps - interval created once on mount

    return {
        updateReady,
        updateVersion,
        restartAndUpdate,
        checking,
        downloading,
        installing,
        preparing,
        checkForUpdate,
        pendingUpdateOnStartup,
        dismissPendingUpdate,
    };
}
