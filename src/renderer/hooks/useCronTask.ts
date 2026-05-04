// Hook for managing cron task state within a Tab
import { useState, useCallback, useRef, useEffect } from 'react';
import type { CronTask, CronTaskConfig, CronDelivery, CronEndConditions, CronRunMode, CronTaskTriggerPayload, CronSchedule } from '@/types/cronTask';
import type { RuntimeConfig, RuntimeType } from '../../shared/types/runtime';
import {
  createCronTask,
  startCronTask,
  stopCronTask,
  getCronTask,
  recordCronExecution,
  startCronScheduler,
  markTaskExecuting,
  markTaskComplete,
  updateCronTaskSession,
} from '@/api/cronTaskClient';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { createSyncStateRef } from '@/utils/syncStateRef';
import { listenWithCleanup } from '@/utils/tauriListen';

export interface CronTaskState {
  /** Whether cron mode is enabled (before task is created) */
  isEnabled: boolean;
  /** Cron task configuration (set before task creation) */
  config: {
    prompt: string;
    intervalMinutes: number;
    endConditions: CronEndConditions;
    runMode: CronRunMode;
    notifyEnabled: boolean;
    /** Model to use for task execution (captured at task creation time) */
    model?: string;
    /** Permission mode (captured at task creation time) */
    permissionMode?: string;
    /** PRD 0.2.9 — DEPRECATED legacy frozen env. Kept for back-compat
     *  with paths that haven't been collapsed to providerId yet. */
    providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses' };
    /** PRD 0.2.9 — Per-cron provider id; sidecar live-resolves env at every tick. */
    providerId?: string;
    /** PRD #119 / 0.2.9: explicit routing intent — see `CronProviderIntent`.
     *  Sidecar ignores this when `providerId` is set. */
    providerIntent?: 'followAgent' | 'subscription' | 'explicit';
    /** Agent runtime snapshot for external Runtime tasks */
    runtime?: RuntimeType;
    /** Runtime-scoped config snapshot for external Runtime tasks */
    runtimeConfig?: RuntimeConfig;
    /** Flexible schedule (overrides intervalMinutes when present) */
    schedule?: CronSchedule;
    /** Execution target: current_session (legacy) or new_task (standalone) */
    executionTarget?: 'current_session' | 'new_task';
    /** Where to deliver execution results (IM channel) */
    delivery?: CronDelivery;
    /** Per-task MCP enable list — see `CronTaskConfig.mcpEnabledServers`. */
    mcpEnabledServers?: string[];
  } | null;
  /** Active cron task (after creation) */
  task: CronTask | null;
  /** Whether task is currently being created/started */
  isStarting: boolean;
  /** Error message if any */
  error: string | null;
}

const initialState: CronTaskState = {
  isEnabled: false,
  config: null,
  task: null,
  isStarting: false,
  error: null,
};

export interface UseCronTaskOptions {
  workspacePath: string;
  sessionId: string;
  tabId: string;
  /** Callback to execute cron task (send message via sidecar /cron/execute endpoint) */
  onExecute?: (taskId: string, prompt: string, isFirstExecution: boolean, aiCanExit: boolean) => Promise<void>;
  /** Callback when task completes (stops) */
  onComplete?: (task: CronTask, reason?: string) => void;
  /** Callback when a single execution completes (task may continue running) */
  onExecutionComplete?: (task: CronTask, success: boolean) => void;
  /** Ref to register the cron task exit handler (provided by TabContext) */
  onCronTaskExitRequestedRef?: React.MutableRefObject<((taskId: string, reason: string) => void) | null>;
}

export function useCronTask(options: UseCronTaskOptions) {
  const { workspacePath, sessionId, tabId, onCronTaskExitRequestedRef } = options;

  const [state, setStateRaw] = useState<CronTaskState>(initialState);
  const isExecutingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // `stateRef` is the canonical "latest" snapshot, synchronously written by
  // `setState` BEFORE the React update is scheduled. This is the single
  // mechanism preventing the `enableCronMode → startTask same-tick race`
  // bug — see `createSyncStateRef` for the rationale and unit tests.
  //
  // Rule for this file: NEVER call `setStateRaw` directly. Always
  // `setState(...)`. The wrapper guarantees ref/state stay coupled. Both
  // `stateRef` and `setState` come from a `useRef`-stashed instance, so
  // both are referentially stable across renders — safe to omit from
  // useCallback dep arrays (and consistently included where listed for
  // ESLint's exhaustive-deps satisfaction).
  const stateRef = useRef(createSyncStateRef(state, setStateRaw)).current;
  const setState = stateRef.set;

  // Track component mount state to prevent setState after unmount
  const mountedRef = useRef(true);

  // Refs for Tauri event handlers to avoid recreating listeners on handler changes
  // These refs are updated when handlers change, but the listeners always call through refs
  const handleSchedulerStartedRef = useRef<((payload: { taskId: string; intervalMinutes: number; executionCount: number }) => void) | null>(null);
  const handleExecutionStartingRef = useRef<((payload: { taskId: string; executionNumber: number; isFirstExecution: boolean }) => void) | null>(null);
  const handleDebugEventRef = useRef<((payload: { taskId: string; message: string; error?: boolean }) => void) | null>(null);
  const handleSchedulerTriggerRef = useRef<((payload: CronTaskTriggerPayload) => Promise<void>) | null>(null);
  const handleExecutionCompleteRef = useRef<((payload: { taskId: string; success: boolean; executionCount: number }) => Promise<void>) | null>(null);
  const handleExecutionErrorRef = useRef<((payload: { taskId: string; error: string }) => void) | null>(null);
  // Track whether Tauri event listeners are ready (for debugging race conditions)
  const listenersReadyRef = useRef(false);

  // Enable cron mode with initial config
  // Note: model, permissionMode, and providerEnv are captured here to ensure the task uses
  // the same settings that were active when the user enabled cron mode,
  // not the settings at execution time (which might have changed)
  const enableCronMode = useCallback((config: Omit<CronTaskConfig, 'workspacePath' | 'sessionId' | 'tabId'> & { executionTarget?: 'current_session' | 'new_task' }) => {
    setState({
      isEnabled: true,
      config: {
        prompt: config.prompt,
        intervalMinutes: config.intervalMinutes,
        endConditions: config.endConditions,
        runMode: config.runMode,
        notifyEnabled: config.notifyEnabled,
        model: config.model,
        permissionMode: config.permissionMode,
        // PRD 0.2.9 — Prefer `providerId` (live-resolve at sidecar) over
        // `providerEnv` (deprecated frozen snapshot). Both are accepted so
        // legacy callers still work; sidecar prefers providerId when set.
        providerEnv: config.providerEnv,
        providerId: config.providerId,
        // PRD #119 / 0.2.9 — When providerId is set, intent is ignored by
        // sidecar (live-resolve takes precedence). Otherwise we fall back
        // to the legacy explicit-vs-subscription split derived from
        // providerEnv presence so legacy crons still route correctly.
        providerIntent:
          config.providerIntent
          ?? (config.providerId
            ? undefined
            : config.providerEnv
              ? 'explicit'
              : 'subscription'),
        runtime: config.runtime,
        runtimeConfig: config.runtimeConfig,
        schedule: config.schedule,
        executionTarget: config.executionTarget,
        delivery: config.delivery,
        mcpEnabledServers: config.mcpEnabledServers,
      },
      task: null,
      isStarting: false,
      error: null,
    });
  }, [setState]);

  // Disable cron mode (cancel before starting)
  const disableCronMode = useCallback(() => {
    setState(initialState);
  }, [setState]);

  // Update config while in cron mode (before task starts)
  const updateConfig = useCallback((config: Partial<CronTaskState['config']>) => {
    setState(prev => ({
      ...prev,
      config: prev.config ? { ...prev.config, ...config } : null,
    }));
  }, [setState]);

  // Update config for a running task (preserves task state)
  // Note: Some config changes (like intervalMinutes) won't affect the currently running scheduler
  // They will take effect on the next task start. Only notifyEnabled takes effect immediately.
  const updateRunningConfig = useCallback((config: Partial<CronTaskState['config']>) => {
    setState(prev => {
      if (!prev.task) return prev; // No running task, do nothing
      return {
        ...prev,
        config: prev.config ? { ...prev.config, ...config } : null,
      };
    });
  }, [setState]);

  // Create and start the cron task
  // Optional prompt parameter allows caller to pass the prompt directly,
  // avoiding React state update timing issues (stale closure problem).
  //
  // Throws on:
  //  - missing config (caller didn't enableCronMode first)
  //  - missing prompt
  //  - re-entry (a previous startTask is still in flight)
  // The thrown error propagates to the caller so the UI layer (e.g.
  // `Chat.tsx` autoSend's catch path) can restore the launcher draft
  // instead of silently consuming the user's input. (Codex review
  // Medium #1: previously this returned silently, leaving Chat.tsx to
  // mark `initialMessage` consumed even though no task was created.)
  const startTask = useCallback(async (promptOverride?: string) => {
    // Reads from `stateRef.current` (synchronously written by `setState`
    // above) — safe even if the caller invoked enableCronMode in the same
    // tick, because every mutation goes through the wrapper.
    const currentConfig = stateRef.current.config;
    if (!currentConfig) {
      throw new Error(
        '[useCronTask] startTask called with no config — caller must enableCronMode first'
      );
    }

    // Re-entry guard (Codex review adversarial): without this, two rapid
    // sends would each createCronTask + startCronScheduler, producing
    // duplicate Rust-side tasks running the same prompt. Throwing forces
    // the caller (typically the send-button handler) to await the first
    // start before issuing a second.
    if (stateRef.current.isStarting) {
      throw new Error('[useCronTask] startTask is already in flight');
    }

    // Use promptOverride if provided, otherwise fall back to config.prompt
    // This fixes the timing issue where updateConfig() hasn't updated the ref yet
    const effectivePrompt = promptOverride ?? currentConfig.prompt;

    if (!effectivePrompt) {
      setState(prev => ({
        ...prev,
        error: 'Prompt is required to start the task',
      }));
      throw new Error('[useCronTask] Cannot start task: prompt is empty');
    }

    setState(prev => ({ ...prev, isStarting: true, error: null }));

    let createdTaskId: string | null = null;
    try {
      // PRD 0.2.9 — Forward providerId (live-resolve) when set; fall back
      // to legacy providerEnv path otherwise. Both can coexist on the
      // payload; sidecar prefers providerId when present.
      const task = await createCronTask({
        workspacePath,
        sessionId,
        tabId,
        prompt: effectivePrompt,
        intervalMinutes: currentConfig.intervalMinutes,
        endConditions: currentConfig.endConditions,
        runMode: currentConfig.runMode,
        notifyEnabled: currentConfig.notifyEnabled,
        model: currentConfig.model,
        permissionMode: currentConfig.permissionMode,
        providerEnv: currentConfig.providerEnv,
        providerId: currentConfig.providerId,
        // PRD #119 / 0.2.9 — see enableCronMode for the same fallback rules.
        providerIntent:
          currentConfig.providerIntent
          ?? (currentConfig.providerId
            ? undefined
            : currentConfig.providerEnv
              ? 'explicit'
              : 'subscription'),
        runtime: currentConfig.runtime,
        runtimeConfig: currentConfig.runtimeConfig,
        schedule: currentConfig.schedule,
        delivery: currentConfig.delivery,
        // Threading the launcher's MCP set into the task makes the
        // first scheduler-triggered execution take the override branch
        // in /cron/execute-sync (line ~2402), pinning MCP to the same
        // set the pre-warm session already has —
        // applyMcpOverrideAndAwaitReady becomes a fingerprint-match no-op
        // (line 1282 of agent-session.ts) instead of an abort+restart.
        // Saves ~5s on every launcher cron handoff.
        mcpEnabledServers: currentConfig.mcpEnabledServers,
      });
      createdTaskId = task.id;

      // Cancellation check (Codex review Medium #2): user can call
      // disableCronMode() while we're awaiting Rust round-trips. That
      // resets `isEnabled` to false. Without this guard, the success
      // setState below would resurrect a "ghost" running task on top of
      // the disabled UI state (`isEnabled: false, task: startedTask`).
      // Detect via `isEnabled` because `task` is null in initialState
      // AND null mid-flight before we set it — only `isEnabled` cleanly
      // distinguishes "user cancelled" from normal in-flight.
      if (!stateRef.current.isEnabled) {
        // Best-effort: clean up the orphaned Rust task we just created.
        // If this fails, log but don't propagate — the user already
        // cancelled, surfacing a stop-failure error would be noise.
        try {
          await stopCronTask(task.id);
        } catch (cleanupErr) {
          console.warn('[useCronTask] failed to stop orphaned task after cancel:', cleanupErr);
        }
        return;
      }

      // Start the task (updates status to 'running')
      const startedTask = await startCronTask(task.id);

      // Re-check after the second await, same rationale.
      if (!stateRef.current.isEnabled) {
        try {
          await stopCronTask(task.id);
        } catch (cleanupErr) {
          console.warn('[useCronTask] failed to stop orphaned task after cancel:', cleanupErr);
        }
        return;
      }

      setState(prev => ({ ...prev, task: startedTask, isStarting: false }));

      // Log state after update for debugging
      if (isDebugMode()) {
        console.log('[useCronTask] Task created:', startedTask.id);
      }

      // Start the Rust-layer scheduler
      // The scheduler will execute immediately for first time (execution_count == 0)
      // This ensures consistent execution path for both first and subsequent executions
      console.log('[useCronTask] Starting scheduler for task:', task.id);
      await startCronScheduler(task.id);
      console.log('[useCronTask] Scheduler started successfully:', startedTask.id);
    } catch (error) {
      console.error('[useCronTask] Failed to start task:', error);
      // Reset only if state still reflects this in-flight start. If
      // disableCronMode already reset to initialState during the await,
      // don't overwrite that reset with our error.
      if (stateRef.current.isEnabled && stateRef.current.isStarting) {
        setState(prev => ({
          ...prev,
          isStarting: false,
          error: error instanceof Error ? error.message : 'Failed to start task',
        }));
      }
      // If we did create a Rust task before the error, attempt cleanup.
      if (createdTaskId) {
        try {
          await stopCronTask(createdTaskId);
        } catch (cleanupErr) {
          console.warn('[useCronTask] failed to stop partial task on error:', cleanupErr);
        }
      }
      // Re-throw so the caller's catch path runs (Codex review Medium #1).
      throw error;
    }
  }, [workspacePath, sessionId, tabId, setState, stateRef]);

  // Helper to calculate task duration in minutes
  const getTaskDurationMinutes = (task: CronTask): number => {
    if (!task.createdAt) return 0;
    const createdAt = new Date(task.createdAt).getTime();
    const now = Date.now();
    return Math.round((now - createdAt) / (1000 * 60));
  };

  // Helper to map exit reason to tracking reason
  const mapExitReason = (exitReason?: string): string => {
    if (!exitReason) return 'manual';
    if (exitReason.includes('time') || exitReason.includes('duration')) return 'time_limit';
    if (exitReason.includes('count') || exitReason.includes('execution')) return 'count_limit';
    if (exitReason.includes('AI') || exitReason.includes('exit_cron_task')) return 'ai_exit';
    if (exitReason.includes('error')) return 'error';
    return 'manual';
  };

  // Stop the task
  // Returns the original prompt so it can be restored to the input field
  const stop = useCallback(async (): Promise<string | null> => {
    const currentTask = stateRef.current.task;
    const currentConfig = stateRef.current.config;
    if (!currentTask) return null;

    // Get the original prompt before resetting state
    const originalPrompt = currentTask.prompt || currentConfig?.prompt || null;

    try {
      const stoppedTask = await stopCronTask(currentTask.id);
      // Track cron_stop event (manual stop)
      track('cron_stop', {
        reason: 'manual',
        execution_count: stoppedTask.executionCount ?? currentTask.executionCount ?? 0,
        duration_minutes: getTaskDurationMinutes(currentTask),
      });
      // Rust scheduler will detect status change and stop
      setState(initialState);
      console.log('[useCronTask] Task stopped:', stoppedTask.id);
      return originalPrompt;
    } catch (error) {
      console.error('[useCronTask] Failed to stop task:', error);
      return null;
    }
  }, [setState, stateRef]);

  // Refresh task state from server
  const refresh = useCallback(async () => {
    const currentTask = stateRef.current.task;
    if (!currentTask) return;

    try {
      const task = await getCronTask(currentTask.id);
      setState(prev => ({ ...prev, task }));

      // Check if task is stopped (end conditions met or AI exit)
      if (task.status === 'stopped' && task.exitReason) {
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(task, task.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } catch (error) {
      console.error('[useCronTask] Failed to refresh task:', error);
    }
  }, [setState, stateRef]);

  // Handle AI-initiated task exit (via exit_cron_task tool)
  const handleTaskExitRequested = useCallback(async (taskId: string, reason: string) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== taskId) return;

    console.log('[useCronTask] AI requested task exit:', taskId, reason);
    try {
      const stoppedTask = await stopCronTask(taskId, reason);
      // Track cron_stop event (AI exit)
      track('cron_stop', {
        reason: 'ai_exit',
        execution_count: stoppedTask.executionCount ?? currentTask.executionCount ?? 0,
        duration_minutes: getTaskDurationMinutes(currentTask),
      });
      // Update task state before calling onComplete
      setState(prev => ({ ...prev, task: stoppedTask }));

      if (optionsRef.current.onComplete) {
        optionsRef.current.onComplete(stoppedTask, reason);
      }

      setState(initialState);
    } catch (error) {
      console.error('[useCronTask] Failed to stop task:', error);
    }
  }, [setState, stateRef]);

  // Handle Rust scheduler trigger event
  const handleSchedulerTrigger = useCallback(async (payload: CronTaskTriggerPayload) => {
    const currentTask = stateRef.current.task;

    // Verify this trigger is for our task and tab
    if (!currentTask || currentTask.id !== payload.taskId || payload.tabId !== tabId) {
      return;
    }

    // Skip if already executing
    if (isExecutingRef.current) {
      console.log('[useCronTask] Skipping trigger - already executing');
      return;
    }

    console.log('[useCronTask] Scheduler triggered execution for task:', payload.taskId);

    // Track cron_start on first execution
    if (payload.isFirstExecution) {
      const config = stateRef.current.config;
      track('cron_start', {
        interval_minutes: currentTask.intervalMinutes,
        model: config?.model ?? 'default',
        provider_type: config?.providerEnv ? 'third_party' : 'subscription',
      });
    }

    isExecutingRef.current = true;
    await markTaskExecuting(payload.taskId);

    try {
      if (optionsRef.current.onExecute) {
        await optionsRef.current.onExecute(
          payload.taskId,
          payload.prompt,
          payload.isFirstExecution,
          payload.aiCanExit
        );
      }

      // Record execution
      const updatedTask = await recordCronExecution(payload.taskId);
      setState(prev => ({ ...prev, task: updatedTask }));

      // Check if task stopped (end conditions met)
      if (updatedTask.status === 'stopped') {
        // Track cron_stop event (end conditions met)
        track('cron_stop', {
          reason: mapExitReason(updatedTask.exitReason),
          execution_count: updatedTask.executionCount ?? 0,
          duration_minutes: getTaskDurationMinutes(currentTask),
        });
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(updatedTask, updatedTask.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } finally {
      await markTaskComplete(payload.taskId);
      isExecutingRef.current = false;
    }
  }, [tabId, setState, stateRef]);

  // Handle Rust scheduler execution complete event
  // This is emitted after Rust directly executes via Sidecar (not via frontend)
  const handleExecutionComplete = useCallback(async (payload: { taskId: string; success: boolean; executionCount: number }) => {
    const currentTask = stateRef.current.task;

    // Debug logging (only in debug mode to avoid production noise)
    if (isDebugMode()) {
      console.log('[useCronTask] cron:execution-complete received:', payload.taskId, 'eventCount:', payload.executionCount);
      console.log('[useCronTask] handleExecutionComplete state:', {
        hasCurrentTask: !!currentTask,
        currentTaskId: currentTask?.id,
        payloadTaskId: payload.taskId,
      });
    }

    // If task ID doesn't match, this event is for a different Tab - ignore it
    // cron:execution-complete is a global event, all Tabs receive it
    if (currentTask && currentTask.id !== payload.taskId) {
      return;
    }

    // If no current task, ignore the event
    // We don't do fallback refresh because:
    // 1. The event's taskId might belong to a different Tab
    // 2. Without currentTask, we can't verify ownership
    // 3. The Tab that owns this task will handle the event
    if (!currentTask) {
      return;
    }

    // Refresh task state from server to get updated lastExecutedAt and executionCount
    try {
      const task = await getCronTask(payload.taskId);
      // Check if component is still mounted before updating state
      if (!mountedRef.current) return;

      setState(prev => ({ ...prev, task }));

      // Notify caller that execution completed (for UI refresh, loading state reset, etc.)
      // Pass success flag so caller can decide whether to refresh (e.g., skip on timeout)
      if (optionsRef.current.onExecutionComplete) {
        optionsRef.current.onExecutionComplete(task, payload.success);
      }

      // Check if task stopped (end conditions met or AI exit)
      if (task.status === 'stopped') {
        // Track cron_stop event (end conditions met via Rust execution)
        track('cron_stop', {
          reason: mapExitReason(task.exitReason),
          execution_count: task.executionCount ?? 0,
          duration_minutes: getTaskDurationMinutes(task),
        });
        if (optionsRef.current.onComplete) {
          optionsRef.current.onComplete(task, task.exitReason ?? undefined);
        }
        setState(initialState);
      }
    } catch (error) {
      console.error('[useCronTask] Failed to refresh task after execution:', error);
    }
  }, [setState, stateRef]);

  // Handle Rust scheduler execution error event
  const handleExecutionError = useCallback((payload: { taskId: string; error: string }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;

    console.error('[useCronTask] Execution error from Rust scheduler:', payload);
    // Task will continue to next interval, just log the error
    // Optionally refresh to get updated lastError
    getCronTask(payload.taskId).then(task => {
      if (!mountedRef.current) return;
      setState(prev => ({ ...prev, task }));
    }).catch(() => {
      // Ignore refresh errors
    });
  }, [setState, stateRef]);

  // Handle scheduler started event (for debugging visibility)
  const handleSchedulerStarted = useCallback((payload: { taskId: string; intervalMinutes: number; executionCount: number }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    console.log('[useCronTask] Scheduler started:', payload);
  }, [stateRef]);

  // Handle execution starting event (for debugging visibility)
  const handleExecutionStarting = useCallback((payload: { taskId: string; executionNumber: number; isFirstExecution: boolean }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    console.log('[useCronTask] Execution starting:', payload);
  }, [stateRef]);

  // Handle debug events from Rust (for debugging visibility)
  const handleDebugEvent = useCallback((payload: { taskId: string; message: string; error?: boolean }) => {
    const currentTask = stateRef.current.task;
    if (!currentTask || currentTask.id !== payload.taskId) return;
    if (payload.error) {
      console.error('[useCronTask] Debug:', payload.message);
    } else {
      console.log('[useCronTask] Debug:', payload.message);
    }
  }, [stateRef]);

  // Update refs with latest handler functions
  // This ensures listeners always call the latest handlers without needing to re-subscribe
  handleSchedulerStartedRef.current = handleSchedulerStarted;
  handleExecutionStartingRef.current = handleExecutionStarting;
  handleDebugEventRef.current = handleDebugEvent;
  handleSchedulerTriggerRef.current = handleSchedulerTrigger;
  handleExecutionCompleteRef.current = handleExecutionComplete;
  handleExecutionErrorRef.current = handleExecutionError;

  // Listen for Tauri events (cron:trigger-execution, cron:execution-complete, cron:execution-error, cron:scheduler-started, cron:execution-starting, cron:debug)
  // Note: We use refs for handlers so this effect only runs once (on mount) and doesn't need
  // to re-subscribe when tabId or other dependencies change
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();

    // Promise.all the registrations so `listenersReadyRef.current = true`
    // only flips ON after every Tauri-side registration is genuinely
    // complete. Before this fix, ready was set immediately after the sync
    // void-prefixed calls — i.e. before any registration had resolved —
    // which produced a false "ready" window where downstream consumers
    // could poll the flag and act on it before the Tauri handlers were
    // actually attached. (Codex review WARN-3 of the migration.)
    Promise.all([
      // Scheduler started event (for debugging)
      listenWithCleanup<{ taskId: string; intervalMinutes: number; executionCount: number }>(
        'cron:scheduler-started',
        (event) => { handleSchedulerStartedRef.current?.(event.payload); },
        ac.signal,
      ),
      // Execution starting event (for debugging)
      listenWithCleanup<{ taskId: string; executionNumber: number; isFirstExecution: boolean }>(
        'cron:execution-starting',
        (event) => { handleExecutionStartingRef.current?.(event.payload); },
        ac.signal,
      ),
      // Debug events from Rust
      listenWithCleanup<{ taskId: string; message: string; error?: boolean }>(
        'cron:debug',
        (event) => { handleDebugEventRef.current?.(event.payload); },
        ac.signal,
      ),
      // Legacy: trigger from Rust to frontend to execute
      listenWithCleanup<CronTaskTriggerPayload>(
        'cron:trigger-execution',
        (event) => { handleSchedulerTriggerRef.current?.(event.payload); },
        ac.signal,
      ),
      // New: Rust executed directly, notify frontend to update UI
      listenWithCleanup<{ taskId: string; success: boolean; executionCount: number }>(
        'cron:execution-complete',
        (event) => {
          if (handleExecutionCompleteRef.current) {
            handleExecutionCompleteRef.current(event.payload);
          } else if (isDebugMode()) {
            console.warn('[useCronTask] cron:execution-complete handler not ready');
          }
        },
        ac.signal,
      ),
      listenWithCleanup<{ taskId: string; error: string }>(
        'cron:execution-error',
        (event) => { handleExecutionErrorRef.current?.(event.payload); },
        ac.signal,
      ),
    ]).then(() => {
      if (ac.signal.aborted) return;
      listenersReadyRef.current = true;
      if (isDebugMode()) {
        console.log('[useCronTask] Tauri event listeners ready');
      }
    });

    return () => {
      mountedRef.current = false;
      listenersReadyRef.current = false;
      ac.abort();
    };
  }, []);

  // Register handler for SSE events (cron:task-exit-requested from AI tool)
  // The handler is registered via the ref provided by TabContext
  useEffect(() => {
    if (!onCronTaskExitRequestedRef) return;

    // Register our handler
    onCronTaskExitRequestedRef.current = handleTaskExitRequested;

    return () => {
      // Unregister on cleanup
      if (onCronTaskExitRequestedRef.current === handleTaskExitRequested) {
        onCronTaskExitRequestedRef.current = null;
      }
    };
  }, [onCronTaskExitRequestedRef, handleTaskExitRequested]);

  // Restore state from an existing cron task (for app restart recovery)
  const restoreFromTask = useCallback((task: CronTask) => {
    console.log('[useCronTask] Restoring from task:', task.id, task.status);
    // Reverse-derive executionTarget from runMode. Rust's CronTask schema
    // doesn't store executionTarget (it's a UI-only distinction that the
    // modal collapses into runMode at confirm time), so on restore we
    // recompute it. Without this the editor would default to
    // 'current_session' regardless of the actual task — Bug 2A's second
    // half (the first half is fixed by threading executionTarget through
    // the launcher → autoSend handoff). The mapping mirrors the modal's
    // forward direction: `executionTarget==='current_session'` ↔
    // `runMode==='single_session'`; `'new_task'` ↔ `'new_session'`.
    // schedule.kind === 'loop' forces single_session in the modal but
    // doesn't constrain executionTarget; recover from runMode is still
    // the right inverse.
    const recoveredExecutionTarget: 'current_session' | 'new_task' =
      task.runMode === 'new_session' ? 'new_task' : 'current_session';
    setState({
      isEnabled: true,
      config: {
        prompt: task.prompt,
        intervalMinutes: task.intervalMinutes,
        endConditions: task.endConditions,
        runMode: task.runMode,
        notifyEnabled: task.notifyEnabled,
        model: task.model,
        permissionMode: task.permissionMode,
        // PRD 0.2.9 — Restore `providerId` so editing/re-saving a
        // live-resolve cron through this state preserves the new path.
        // Without this, edit-then-save would silently drop the field
        // (Codex P2.3). `providerEnv` is kept as a legacy fallback for
        // pre-0.2.9 cron tasks that haven't yet migrated.
        providerEnv: task.providerEnv,
        providerId: task.providerId,
        runtime: task.runtime,
        runtimeConfig: task.runtimeConfig,
        delivery: task.delivery,
        executionTarget: recoveredExecutionTarget,
        mcpEnabledServers: task.mcpEnabledServers,
      },
      task,
      isStarting: false,
      error: null,
    });
  }, [setState]);

  // Update task's sessionId (called when session is created after task creation)
  const updateSessionId = useCallback(async (newSessionId: string) => {
    const currentTask = stateRef.current.task;
    if (!currentTask) return;

    try {
      const updatedTask = await updateCronTaskSession(currentTask.id, newSessionId);
      setState(prev => ({ ...prev, task: updatedTask }));
      console.log('[useCronTask] Updated sessionId:', updatedTask.id, updatedTask.sessionId);
    } catch (error) {
      console.error('[useCronTask] Failed to update sessionId:', error);
    }
  }, [setState, stateRef]);

  return {
    state,
    enableCronMode,
    disableCronMode,
    updateConfig,
    updateRunningConfig,
    startTask,
    stop,
    refresh,
    restoreFromTask,
    updateSessionId,
  };
}
