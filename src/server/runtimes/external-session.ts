// External Runtime Session Handler (v0.1.59)
//
// Manages the lifecycle of an external CLI runtime session (Claude Code, Codex).
// This module parallels agent-session.ts but is drastically simpler because
// the external CLI handles all SDK interaction, tool execution, and session persistence.
// We only need to: spawn process, relay events, and handle permission delegation.

import { broadcast } from '../sse';
import { killWithEscalation } from './utils/kill-with-escalation';
import { buildSystemPromptAppend } from '../system-prompt';
import type { InteractionScenario } from '../system-prompt';
import type { AgentRuntime, RuntimeProcess, UnifiedEvent, ImagePayload } from './types';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import { StaleRuntimeSessionError } from './types';
import { awaitInFlightSaves, rebuildAttachmentRegistryFromBlocks } from './tool-attachments';
import type { AskUserQuestionInput } from '../../shared/types/askUserQuestion';
import { getExternalRuntime, getCurrentRuntimeType, isExternalRuntime } from './factory';
import { resolveCodexWorkspaceInstructions } from './workspace-instructions';
import type { RuntimeType } from '../../shared/types/runtime';
import { isPendingSessionId } from '../../shared/constants';
import { saveSessionMetadata, saveSessionMessages, updateSessionMetadata, getSessionMetadata, getSessionData } from '../SessionStore';
import { createSessionMetadata } from '../types/session';
import { snapshotForImSession, snapshotForOwnedSession } from '../utils/session-snapshot';
import { findAgentByWorkspacePath } from '../utils/admin-config';
import type { AgentConfig } from '../../shared/types/agent';
import type { MessageUsage, SessionMessage } from '../types/session';
import type { SystemInitInfo } from '../../shared/types/system';
import { trackServer } from '../analytics';
import {
  addUsageTotals,
  diffUsageTotals,
  getPrimaryModel,
  normalizeUsage,
  restoreRuntimeUsageTotals,
} from './usage-utils';
import { imEventBus, type ImEventType } from '../utils/im-event-bus';
import { imRequestRegistry } from '../utils/im-request-registry';

// ─── Module state ───

let activeProcess: RuntimeProcess | null = null;
let activeRuntime: AgentRuntime | null = null;
let isRunning = false;
let turnCompleted = false;
let startingPromise: Promise<void> | null = null;  // Guard against concurrent startExternalSession
// Target sessionId of the in-flight startExternalSession. Set the moment
// startExternalSession is called (before _doStartExternalSession's spawn-and-handshake
// even begins), cleared in finally. Lets /sessions/switch detect that an in-flight
// prewarm is going to land on the same session it wants to switch to — making the
// switch a no-op without paying the 8-10s gemini --acp cold-start.
let startingSessionId: string | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;  // Hung process detection

// Track session context for multi-turn resume (CC -p mode exits after each turn)
let lastSessionId = '';
let lastWorkspacePath = '';
let lastScenario: InteractionScenario = { type: 'desktop' };
let lastRuntimeSessionId = '';  // Runtime's session ID (CC: from hook/init; Codex: threadId)
let lastModel = '';             // Latest model from config sync (passed on resume)
let lastRuntimeReportedModel = ''; // Actual model reported by runtime (session_init/model_update)
let lastPermissionMode = '';    // Latest permission mode from config sync
let lastPersistedRuntimeUsageTotals: MessageUsage | null = null;

// Message accumulation for SessionStore persistence
// allSessionMessages grows across turns — saveSessionMessages expects the FULL cumulative array
// (it uses messages.slice(existingCount) internally to find new messages to append)
let allSessionMessages: SessionMessage[] = [];
let currentAssistantText = '';  // Accumulate streaming text for the current assistant message (also used by getLastExternalAssistantText)
let currentTurnStartTime = 0;

// ─── Structured content block accumulation ───
// Mirrors the builtin runtime's ContentBlock[] pattern so that session history
// preserves thinking, tool_use, and text blocks (not just flattened text).
// The frontend's JSON parse path (TabProvider.tsx:1969) handles this format.
interface PersistContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  tool?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    inputJson?: string;
    isLoading?: boolean;
    result?: string;
    isError?: boolean;
    resultMeta?: {
      exitCode?: number | null;
      durationMs?: number | null;
      cwd?: string;
      processId?: string | null;
      status?: string;
    };
    streamIndex: number;
    // PRD 0.2.15 — rich-media attachments. Persisted with the tool block so
    // history replay can re-render images without re-running the tool.
    attachments?: ToolAttachment[];
  };
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  thinkingStreamIndex?: number;
  isComplete?: boolean;
}

let currentContentBlocks: PersistContentBlock[] = [];
let pendingTextBuffer = '';         // text_delta accumulator between block boundaries
let pendingThinkingText = '';       // thinking_delta accumulator for current thinking block
let pendingThinkingIndex = 0;       // index of current thinking block
let pendingThinkingActive = false;  // reasoning block started, even if no delta text arrived yet
let pendingThinkingStartedAt = 0;   // timestamp for duration calculation / history reopen parity
const pendingToolInputs = new Map<string, { name: string; inputJson: string }>(); // toolUseId → input accumulator
type ExternalSessionState = 'idle' | 'running' | 'error';
type ExternalPendingInteractiveRequest =
  | {
    type: 'permission:request';
    data: {
      requestId: string;
      toolName: string;
      toolUseId: string;
      input: string;
    };
  }
  | {
    type: 'ask-user-question:request';
    data: {
      requestId: string;
      questions: AskUserQuestionInput['questions'];
      previewFormat: 'html' | 'markdown';
    };
  };
let externalSessionState: ExternalSessionState = 'idle';
let externalSystemInitPayload: { info: SystemInitInfo; sessionId: string; prewarm?: boolean; runtime: RuntimeType } | null = null;
// True between the start of a pre-warm (no initialMessage) and the first real user turn.
// Consumed by the session_init broadcast so the frontend knows not to flip isLoading:true
// — a pre-warmed process is "alive but idle", not "processing a turn". Cleared when the
// first user message arrives or on session reset.
let isPrewarmingSession = false;
// Set by sendExternalMessage when it pre-broadcasts the user message for instant display.
// Consumed by _doStartExternalSession / Case 3 to reuse the message (skip duplicate broadcast).
let earlyBroadcastedUserMsg: SessionMessage | null = null;
// Issue #188 — Serializes desktop /chat/send dispatches so concurrent sends
// don't race through waitForExternalSessionIdle and double-write to the
// persistent runtime stdin / clobber the shared earlyBroadcastedUserMsg.
// Chained onto by enqueueExternalSendForDesktop. Cron / IM callers keep their
// existing direct sendExternalMessage await semantics (they're already
// serialized at the caller level by single-flight cron/heartbeat loops).
let externalDesktopSendTail: Promise<unknown> = Promise.resolve();
// Deferred runtimeSessionId: set when session_init fires before metadata exists (pre-warm).
// Consumed by registerSessionMetadataIfNew to patch runtimeSessionId onto newly created metadata.
// Includes forSessionId to prevent cross-session contamination if session switches between set and consume.
let deferredRuntimeSessionId: { forSessionId: string; runtimeSessionId: string } | null = null;
const pendingExternalInteractiveRequests = new Map<string, ExternalPendingInteractiveRequest>();

function setExternalSessionState(state: ExternalSessionState): void {
  externalSessionState = state;
  broadcast('chat:status', { sessionState: state });
}

/** Reset all module-level state for a clean session transition.
 *  Prevents cross-session contamination when Sidecar is reused (Handover scenario 4). */
function resetModuleState(): void {
  activeProcess = null;
  activeRuntime = null;
  isRunning = false;
  turnCompleted = false;
  startingPromise = null;
  startingSessionId = null;
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  lastRuntimeSessionId = '';
  lastModel = '';
  lastRuntimeReportedModel = '';
  lastPermissionMode = '';
  lastPersistedRuntimeUsageTotals = null;
  allSessionMessages = [];
  currentAssistantText = '';
  currentTurnStartTime = 0;
  currentContentBlocks = [];
  pendingTextBuffer = '';
  pendingThinkingText = '';
  pendingThinkingIndex = 0;
  pendingThinkingActive = false;
  pendingThinkingStartedAt = 0;
  pendingToolInputs.clear();
  pendingPermissionSuggestions.clear();
  drainPendingInteractiveRequestsAsExpired('reset');
  pendingExternalAskUserQuestions.clear();
  pendingExternalInteractiveRequests.clear();
  externalSystemInitPayload = null;
  externalSessionState = 'idle';
  isPrewarmingSession = false;
  earlyBroadcastedUserMsg = null;
  deferredRuntimeSessionId = null;
}

/**
 * PRD #131 (Codex review #4) — drain pending interactive requests by
 * broadcasting `*:expired` so the frontend modal clears before we wipe the
 * map. Mirrors the builtin handlers' lifecycle (handleAskUserQuestion's
 * timer/onAbort paths in agent-session.ts). Without this, an external
 * runtime stop / crash / watchdog kill leaves the AskUserQuestion card
 * visible; the user's late submit then routes to the builtin handler as
 * "Unknown request".
 *
 * `reason` is included in the SSE payload so the frontend (and a future
 * automated test) can distinguish stop-driven vs error-driven expiry.
 * Currently the frontend just clears the modal regardless, but keeping
 * the channel typed lets us add user-visible messaging later without a
 * second round-trip.
 */
function drainPendingInteractiveRequestsAsExpired(reason: 'stop' | 'error' | 'reset'): void {
  // `pendingExternalInteractiveRequests` only ever holds
  // `ask-user-question:request` (structured wizard) or `permission:request`
  // (generic allow/deny card). External runtimes (CC / Codex / Gemini) don't
  // expose ExitPlanMode / EnterPlanMode tools today, so those `*:expired`
  // channels stay builtin-only. Filtering by entry.type keeps the broadcast
  // honest if a future runtime starts using those interactive types.
  for (const [requestId, entry] of pendingExternalInteractiveRequests) {
    if (entry.type !== 'ask-user-question:request') continue;
    try {
      broadcast('ask-user-question:expired', { requestId, reason });
    } catch (e) {
      console.warn(`[external-session] broadcast ask-user-question:expired for ${requestId} failed:`, e);
    }
  }
}

/** Flush accumulated text into a text content block */
function flushPendingText(): void {
  if (pendingTextBuffer) {
    currentContentBlocks.push({ type: 'text', text: pendingTextBuffer });
    pendingTextBuffer = '';
  }
}

function buildPendingThinkingBlock(isComplete: boolean): PersistContentBlock | null {
  if (!pendingThinkingActive) return null;

  return {
    type: 'thinking',
    thinking: pendingThinkingText,
    thinkingStartedAt: pendingThinkingStartedAt || undefined,
    thinkingDurationMs: isComplete && pendingThinkingStartedAt
      ? Date.now() - pendingThinkingStartedAt
      : undefined,
    thinkingStreamIndex: pendingThinkingIndex,
    isComplete,
  };
}

function clearPendingThinking(): void {
  pendingThinkingText = '';
  pendingThinkingIndex = 0;
  pendingThinkingActive = false;
  pendingThinkingStartedAt = 0;
}

/** Register a new session in SessionStore on first user message.
 *  Idempotent: no-op if metadata already exists. Used by both the initial
 *  message path (_doStartExternalSession) and the post-pre-warm Case 3 path
 *  (sendExternalMessage) — both need the same registration, so the logic
 *  lives here to prevent drift.
 *
 *  Snapshot policy mirrors agent-session.ts:enqueueUserMessage — desktop/cron
 *  owners freeze config into the session (D2/D3/D9), IM owners live-follow
 *  agent config (D4). The scenario flag is what v0.1.69 pre-warm broke:
 *  pre-warm Tab → Case 3 first message used to always take the IM path, which
 *  silently leaked agent config changes into owned desktop sessions. */
async function registerSessionMetadataIfNew(
  sessionId: string,
  workspacePath: string,
  messageText: string,
  origin: string,
  scenario: InteractionScenario,
): Promise<void> {
  if (!sessionId || getSessionMetadata(sessionId)) return;
  const useLiveFollow = scenario.type === 'im' || scenario.type === 'agent-channel';
  // Runtime field is overwritten below with `getCurrentRuntimeType()` to honor
  // the actual sidecar runtime regardless of what the agent record claims
  // (defense in depth — pre-warm Tab might have forced a different runtime).
  const lazyAgent = findAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
  const lazySnapshot = lazyAgent
    ? (useLiveFollow ? snapshotForImSession(lazyAgent) : snapshotForOwnedSession(lazyAgent))
    : undefined;
  const meta = createSessionMetadata(workspacePath, lazySnapshot);
  meta.id = sessionId;
  meta.runtime = getCurrentRuntimeType();
  // Patch deferred runtimeSessionId from pre-warm session_init (if any).
  // During pre-warm, session_init fires before metadata exists, so runtimeSessionId
  // couldn't be persisted. Consume it here when metadata is first created.
  // Session affinity check prevents cross-session contamination.
  if (deferredRuntimeSessionId && deferredRuntimeSessionId.forSessionId === sessionId) {
    meta.runtimeSessionId = deferredRuntimeSessionId.runtimeSessionId;
    deferredRuntimeSessionId = null;
  }
  const trimmed = messageText.trim();
  meta.title = trimmed.slice(0, 40);
  if (meta.title.length < trimmed.length) meta.title += '...';
  await saveSessionMetadata(meta);
  console.log(`[external-session] session ${sessionId} persisted to SessionStore (${origin})`);
}

function flushPendingThinking(forceComplete: boolean): void {
  const thinkingBlock = buildPendingThinkingBlock(forceComplete);
  if (thinkingBlock) {
    currentContentBlocks.push(thinkingBlock);
  }
  clearPendingThinking();
}

/** Flush any incomplete blocks (thinking/tool) at turn boundary — handles interrupts */
function flushAllPending(): void {
  flushPendingText();
  flushPendingThinking(true);
  // Flush any uncompleted tool uses (interrupted mid-stream)
  for (const [toolId, entry] of pendingToolInputs) {
    let parsedInput: Record<string, unknown> = {};
    try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
    currentContentBlocks.push({
      type: 'tool_use',
      tool: {
        id: toolId,
        name: entry.name,
        input: parsedInput,
        inputJson: entry.inputJson,
        streamIndex: currentContentBlocks.length,
      },
    });
  }
  pendingToolInputs.clear();
}

// ─── Watchdog timer (10 min inactivity → kill hung process) ───
const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;

function resetWatchdog(): void {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(async () => {
    console.error('[external-session] Watchdog timeout — no activity for 10 minutes, killing process');
    broadcast('chat:agent-error', { message: 'External runtime timed out (no activity for 10 minutes)' });
    broadcast('chat:message-error', 'External runtime timed out');
    fireImCallback('error', 'External runtime timed out');
    await stopExternalSession();
  }, WATCHDOG_TIMEOUT_MS);
}

function clearWatchdog(): void {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

// ─── Turn outcome tracking (stale text protection for cron/heartbeat) ───
let lastTurnSucceeded = false;

// ─── Token usage accumulation ───
type ExternalTurnUsage = MessageUsage & { semantics?: 'delta' | 'running_total' };
let currentTurnUsage: ExternalTurnUsage | null = null;

/** Reset all per-turn accumulators */
function resetTurnAccumulators(): void {
  currentAssistantText = '';
  currentContentBlocks = [];
  pendingTextBuffer = '';
  pendingThinkingText = '';
  pendingThinkingIndex = 0;
  pendingThinkingActive = false;
  pendingThinkingStartedAt = 0;
  pendingToolInputs.clear();
  currentTurnUsage = null;
}

function buildPersistedTurnUsage(): MessageUsage | undefined {
  const fallbackModel = currentTurnUsage?.model
    || lastRuntimeReportedModel
    || lastModel
    || getPrimaryModel(currentTurnUsage?.modelUsage);

  if (!currentTurnUsage) {
    if (!fallbackModel) return undefined;
    return {
      inputTokens: 0,
      outputTokens: 0,
      model: fallbackModel,
    };
  }

  const normalizedCurrent = normalizeUsage({
    ...currentTurnUsage,
    model: fallbackModel,
  });
  if (!normalizedCurrent) return undefined;

  if (currentTurnUsage.semantics === 'running_total') {
    const delta = normalizeUsage(diffUsageTotals(lastPersistedRuntimeUsageTotals, normalizedCurrent));
    lastPersistedRuntimeUsageTotals = normalizedCurrent;
    return delta ?? {
      inputTokens: 0,
      outputTokens: 0,
      model: fallbackModel,
    };
  }

  lastPersistedRuntimeUsageTotals = addUsageTotals(lastPersistedRuntimeUsageTotals, normalizedCurrent);
  return normalizedCurrent;
}

/** Check if content looks like JSON ContentBlock[] (matches frontend heuristic in TabProvider.tsx:1969) */
function isContentBlockJson(content: string): boolean {
  return content.startsWith('[') && content.includes('"type"');
}

/** Extract plain text preview from content (handles both JSON ContentBlock[] and plain text) */
function extractTextPreview(content: string, maxLen = 100): string {
  if (isContentBlockJson(content)) {
    try {
      const blocks = JSON.parse(content) as PersistContentBlock[];
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('');
      return text.slice(0, maxLen);
    } catch { /* fall through */ }
  }
  return content.slice(0, maxLen);
}

// Pattern B — IM Pipeline v2: ImEventBus replaces the legacy single-callback model.
// `activeRequestId` is the trace ID of the user message currently being processed
// by the external runtime; UnifiedEvent → ImEvent translation tags each event with
// this ID so /api/im/chat subscribers can filter/route to the right reply slot.
// Mirrors `agent-session.ts::activeRequestId` semantics — same bus instance.
let activeRequestId: string | null = null;

// Pending permission suggestions — keyed by requestId, consumed by respondExternalPermission.
// CC sends permission_suggestions in control_request; we echo them back as updatedPermissions
// in control_response for "always_allow" so CC persists the rule.
const pendingPermissionSuggestions = new Map<string, unknown[] | undefined>();

// AskUserQuestion requests routed through external runtime (currently only CC has this tool).
// CC sends the question payload via can_use_tool; we render the structured prompt in the UI
// and echo the user's answers back as updatedInput when allowing the tool.
const pendingExternalAskUserQuestions = new Map<string, { input: Record<string, unknown> }>();

// Mirrors agent-session.ts `isValidAskUserQuestionInput`. Malformed input would crash
// AskUserQuestionPrompt (which maps over `options` etc.); the fallback path on failure
// is the generic permission card, so the user at least sees a denial affordance.
function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;
  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      question.options.length >= 2 &&
      typeof question.multiSelect === 'boolean'
    );
  });
}

/** Pattern B — emit per-request IM event. Subscribers in /api/im/chat filter
 *  by matching requestId. No-op when no active IM trace (desktop / cron). */
function fireImCallback(type: ImEventType, data: string): void {
  if (activeRequestId !== null) {
    imEventBus.emit(activeRequestId, type, data);
  }
}

/**
 * Set the runtime's session ID (CC: from hook/system.init; Codex: from thread/start).
 * Used for session resume in multi-turn conversations.
 */
export function setRuntimeSessionId(id: string): void {
  lastRuntimeSessionId = id;
  console.log(`[external-session] Runtime session ID set: ${id}`);
}

/**
 * Restore module-level state after Sidecar restart (session resume).
 * Called from index.ts when an external runtime session is reopened from history.
 * Sets lastRuntimeSessionId so sendExternalMessage uses resume instead of new session.
 */
export function restoreExternalSessionState(
  sessionId: string,
  workspacePath: string,
  scenario: InteractionScenario,
): void {
  // If switching to a different session, reset all accumulated state to prevent contamination
  if (sessionId !== lastSessionId) {
    resetModuleState();
  }
  lastSessionId = sessionId;
  lastWorkspacePath = workspacePath;
  lastScenario = scenario;

  // Restore the runtime's own session ID from persisted metadata.
  // Four cases:
  // 0. Cross-runtime mismatch (session created by different external runtime) → fresh start
  // 1. Codex session with runtimeSessionId persisted → use it (threadId)
  // 2. CC session (no runtimeSessionId, but has runtime + messages) → sessionId (CC uses our ID)
  // 3. Brand new session (no messages, or no metadata) → empty string → sendExternalMessage hits Case 1 (fresh start)
  const meta = getSessionMetadata(sessionId);
  const data = getSessionData(sessionId);
  const hasExistingMessages = !!(data?.messages?.length);
  const currentRuntimeType = getCurrentRuntimeType();

  // Cross-runtime guard: session created by a different runtime (e.g., Codex session in CC Sidecar).
  // The other runtime's session ID / threadId is meaningless here — must start fresh.
  const isCrossRuntime = meta?.runtime && meta.runtime !== currentRuntimeType;

  if (isCrossRuntime) {
    lastRuntimeSessionId = ''; // Different runtime — cannot resume
    console.log(`[external-session] Cross-runtime session: meta.runtime=${meta!.runtime}, current=${currentRuntimeType}, will start fresh`);
  } else if (meta?.runtimeSessionId) {
    lastRuntimeSessionId = meta.runtimeSessionId;
  } else if (meta?.runtime && meta.runtime !== 'builtin' && hasExistingMessages) {
    lastRuntimeSessionId = sessionId; // CC: session ID === runtime session ID
  } else {
    lastRuntimeSessionId = ''; // New session: nothing to resume
  }

  // Load existing messages for correct incremental save (or clear stale in-memory state)
  allSessionMessages = hasExistingMessages ? data!.messages : [];

  // PRD 0.2.15 Review F2 — repopulate the external-path attachment registry
  // from persisted ContentBlock[] so /api/attachment/tool/... can still resolve
  // Codex savedPath attachments after a sidecar restart / Handover. Without
  // this rebuild, history replay shows broken images for any savedPath that
  // didn't land in our trusted root.
  if (hasExistingMessages) {
    for (const msg of allSessionMessages) {
      if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
      try {
        const blocks = JSON.parse(msg.content);
        if (Array.isArray(blocks)) {
          rebuildAttachmentRegistryFromBlocks(sessionId, blocks, msg.id);
        }
      } catch {
        // Plain-text assistant messages have no blocks — fine.
      }
    }
  }
  lastPersistedRuntimeUsageTotals = restoreRuntimeUsageTotals(
    currentRuntimeType,
    allSessionMessages,
    meta?.runtimeUsageTotals,
  );
  lastRuntimeReportedModel = meta?.runtimeUsageTotals?.model
    || allSessionMessages
      .slice()
      .reverse()
      .find((msg) => msg.role === 'assistant' && msg.usage?.model)?.usage?.model
    || '';
  // Rehydrate model/permission from session snapshot so a Tab that joins an
  // idle external Sidecar via /sessions/switch can adopt the session's last
  // known config via /api/session/config. Without this, a fresh switch into
  // an existing session (sidecar process not yet running) leaves
  // lastModel/lastPermissionMode empty and adoption silently no-ops.
  if (meta?.model) {
    lastModel = meta.model;
  }
  if (meta?.permissionMode) {
    lastPermissionMode = meta.permissionMode;
  }
  console.log(`[external-session] Restored state for session ${sessionId}, runtimeSessionId=${lastRuntimeSessionId} (${allSessionMessages.length} messages)`);
}

// Pattern B — `setExternalImStreamCallback` removed. The /api/im/chat handler
// in index.ts subscribes to `imEventBus` directly and filters by requestId.
// This deletes the duplicate single-callback infrastructure that mirrored
// agent-session.ts; both builtin and external runtimes now share the same bus.

// ─── Config change handlers ───

/**
 * Set model for external runtime. Stops any running process so the next
 * sendExternalMessage resumes with the new model.
 * Called from index.ts /api/model/set when runtime is external.
 */
export async function setExternalModel(model: string): Promise<void> {
  // Wait for any in-flight startExternalSession (notably pre-warm) to finish
  // before dispatching. Without this, a user-initiated model change during
  // the 10–14s handshake window sees `activeProcess=null` → skips the in-place
  // path → falls through to `stopExternalSession()` which itself early-returns
  // on `!activeProcess` → the change is silently lost: the live runtime keeps
  // its original model and `runtime.sendMessage` in Case 3 routes future turns
  // through the stale session. Serializing here lets the correct branch run.
  if (startingPromise) {
    await startingPromise;
  }

  // In-place setModel path (currently Gemini via ACP `session/set_model`):
  // ALWAYS call through, even on duplicate-value pushes. Reasons:
  //   1. Runtime-layer setModel is idempotent at the protocol layer — calling
  //      with an unchanged model is a no-op for the runtime.
  //   2. Short-circuiting here would lose self-healing: if a previous concurrent
  //      pair of setModel calls landed out of order (later request wrote
  //      `lastModel` first, earlier request's RPC completed last → runtime model
  //      drifts from `lastModel`), the user's only recovery is to re-select
  //      their intended model. A `lastModel === model` short-circuit would
  //      silently swallow that recovery click.
  //   3. The cost of a redundant in-place RPC is one cheap protocol roundtrip.
  if (isExternalSessionActive() && activeProcess && activeRuntime?.setModel) {
    lastModel = model;
    console.log(`[external-session] Model set to "${model}" (in-place)`);
    try {
      await activeRuntime.setModel(activeProcess, model);
      return;
    } catch (err) {
      console.warn(`[external-session] In-place setModel failed — falling back to process restart:`, err);
      // Fall through to the stop-and-resume path below.
    }
  }

  // Fallback restart path: stop running process so next message resumes with
  // the new model. Idempotent short-circuit on duplicate value — frontend
  // dedupe is best-effort, so a redundant push here would otherwise cause
  // a needless kill+respawn (paying ~10s cold restart for nothing). Safe at
  // this point because there's no in-flight runtime RPC to race against.
  if (model === lastModel) return;
  lastModel = model;
  console.log(`[external-session] Model set to "${model}" (will restart on next send)`);
  if (isRunning || activeProcess) {
    console.log('[external-session] Stopping process for model change');
    await stopExternalSession();
  }
}

/**
 * Set permission mode for external runtime. Stops any running process so the next
 * sendExternalMessage resumes with the new permission mode.
 * Called from index.ts /api/session/permission-mode when runtime is external.
 */
export async function setExternalPermissionMode(mode: string): Promise<void> {
  // Wait for any in-flight startExternalSession (notably pre-warm) to finish
  // before dispatching — same reasoning as setExternalModel: during handshake
  // `activeProcess=null` makes `stopExternalSession()` early-return, and the
  // change is lost against the stale live session.
  if (startingPromise) {
    await startingPromise;
  }
  // Idempotent short-circuit on duplicate value — symmetric with setExternalModel's
  // fallback-path guard. Safe to short-circuit unconditionally here because all
  // runtimes implement permission-mode change via stop+restart (no in-place RPC),
  // so there's no concurrent ordering race that would require self-healing.
  if (mode === lastPermissionMode) return;
  lastPermissionMode = mode;
  console.log(`[external-session] Permission mode set to "${mode}"`);
  if (isRunning || activeProcess) {
    console.log('[external-session] Stopping process for permission mode change');
    await stopExternalSession();
  }
}

// ─── Public API ───

/**
 * Check if we should use an external runtime for this sidecar
 */
export function shouldUseExternalRuntime(): boolean {
  return isExternalRuntime(getCurrentRuntimeType());
}

/**
 * Wait for any in-flight startExternalSession (notably pre-warm) to finish.
 * Used by callers that touch module state which the spawn path will write to —
 * /sessions/switch's external branch races against pre-warm post-spawn writes
 * if it doesn't serialize. setExternalModel / setExternalPermissionMode use
 * the same pattern internally; this exported helper is for HTTP-route callers
 * that don't have direct access to `startingPromise`.
 */
export async function awaitExternalSessionStarting(): Promise<void> {
  if (startingPromise) {
    await startingPromise;
  }
}

export function getExternalSessionState(): ExternalSessionState {
  return externalSessionState;
}

export function getExternalSystemInitPayload(): { info: SystemInitInfo; sessionId: string; prewarm?: boolean; runtime: RuntimeType } | null {
  return externalSystemInitPayload;
}

export function getExternalPendingInteractiveRequests(): ExternalPendingInteractiveRequest[] {
  return Array.from(pendingExternalInteractiveRequests.values());
}

export function getExternalSessionId(): string {
  return lastSessionId;
}

/** The session this Sidecar is bound to right now — either already committed
 *  (lastSessionId, set by restoreExternalSessionState at boot or by a completed
 *  start) or about to be committed by an in-flight prewarm/start (startingSessionId).
 *  Used by /sessions/switch to detect a no-op switch (target matches the bound
 *  session) without awaiting the prewarm's CLI cold-start. */
export function getCurrentBoundSessionId(): string {
  return startingSessionId || lastSessionId;
}

export function getExternalSessionModel(): string | null {
  return lastRuntimeReportedModel || lastModel || null;
}

export function getExternalSessionPermissionMode(): string | null {
  return lastPermissionMode || null;
}

function buildCurrentAssistantSnapshotContent(): string | null {
  const blocks: PersistContentBlock[] = currentContentBlocks.map((block) => ({
    ...block,
    ...(block.tool ? {
      tool: {
        ...block.tool,
        input: { ...block.tool.input },
        ...(block.tool.resultMeta ? { resultMeta: { ...block.tool.resultMeta } } : {}),
      },
    } : {}),
  }));

  if (pendingTextBuffer) {
    blocks.push({ type: 'text', text: pendingTextBuffer });
  }

  const pendingThinkingBlock = buildPendingThinkingBlock(false);
  if (pendingThinkingBlock) {
    blocks.push(pendingThinkingBlock);
  }

  for (const [toolId, entry] of pendingToolInputs) {
    let parsedInput: Record<string, unknown> = {};
    try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
    blocks.push({
      type: 'tool_use',
      tool: {
        id: toolId,
        name: entry.name,
        input: parsedInput,
        inputJson: entry.inputJson,
        isLoading: true,
        streamIndex: blocks.length,
      },
    });
  }

  if (blocks.length > 0) {
    return JSON.stringify(blocks);
  }

  if (currentAssistantText.trim()) {
    return currentAssistantText;
  }

  return null;
}

export function getExternalLiveAssistantMessage(): SessionMessage | null {
  if (!lastSessionId || externalSessionState !== 'running') {
    return null;
  }
  const content = buildCurrentAssistantSnapshotContent();
  if (!content) {
    return null;
  }
  return {
    id: `external-live-${lastSessionId}`,
    role: 'assistant',
    content,
    timestamp: new Date(currentTurnStartTime || Date.now()).toISOString(),
  };
}

/**
 * Get the current external runtime type, or null if builtin
 */
export function getActiveRuntimeType(): RuntimeType {
  return getCurrentRuntimeType();
}

/**
 * Wait for external session to become idle.
 * Detects two idle patterns:
 * - CC -p mode: process exits after each turn → !isRunning && !activeProcess
 * - Codex app-server: process stays alive, turn completes → turnCompleted flag
 * Returns true if completed within timeout, false otherwise.
 */
export async function waitForExternalSessionIdle(timeoutMs: number, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Brief initial delay to let sendExternalMessage → startExternalSession set isRunning.
  // Without this, polling could see the pre-start state (!isRunning && !activeProcess) and
  // return true immediately before the CC process has even started.
  if (!isRunning && !activeProcess) {
    await new Promise(r => setTimeout(r, 200));
    if (!isRunning && !activeProcess) return true; // genuinely idle
  }
  while (Date.now() < deadline) {
    if (!isRunning && !activeProcess) return true;  // CC: process exited
    if (activeProcess?.exited) return true;          // CC: process exited (alt check)
    if (turnCompleted) return true;                  // Codex: turn done, process alive
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Check if the last external turn completed successfully.
 * Used by cron/heartbeat to avoid reading stale assistant text after a crash.
 */
export function didLastTurnSucceed(): boolean {
  return lastTurnSucceeded;
}

/**
 * Get the last assistant message text from the current session.
 * Used by Cron handler and IM heartbeat to extract response text.
 * Handles both JSON ContentBlock[] and plain text formats.
 */
export function getLastExternalAssistantText(): string {
  for (let i = allSessionMessages.length - 1; i >= 0; i--) {
    const msg = allSessionMessages[i];
    if (msg.role === 'assistant') {
      const content = msg.content ?? '';
      // If stored as JSON ContentBlock[], extract text blocks
      if (isContentBlockJson(content)) {
        try {
          const blocks = JSON.parse(content) as PersistContentBlock[];
          return blocks
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
        } catch { /* fall through to plain text */ }
      }
      return content;
    }
  }
  return '';
}

/**
 * Resolve the agent's envPolicy from disk. Thin wrapper over the shared
 * helper in `env-utils.ts` — kept as a local re-export so existing call
 * sites in this file stay 1-line. See `env-utils.resolveAgentEnvPolicy` for
 * validation contract.
 */
async function resolveAgentEnvPolicy(
  workspacePath: string,
): Promise<import('../../shared/types/runtime').RuntimeEnvPolicy | undefined> {
  const { resolveAgentEnvPolicy: shared } = await import('./env-utils');
  return shared(workspacePath);
}

/**
 * Start an external runtime session.
 * Called instead of the builtin startStreamingSession() when runtime is external.
 */
export async function startExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  initialImages?: ImagePayload[];
  model?: string;
  permissionMode?: string;
  scenario: InteractionScenario;
  resumeSessionId?: string;
  /** Issue #194 — per-agent env policy (proxy: myagents/terminal/direct). */
  envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy;
}): Promise<void> {
  // Concurrency guard — wait for any in-flight start to finish
  if (startingPromise) {
    await startingPromise;
  }
  if (isRunning) {
    console.warn('[external-session] Session already running, ignoring start request');
    return;
  }

  // Wrap the body so concurrent callers serialize via startingPromise.
  // startingSessionId is set BEFORE _doStartExternalSession runs so that any
  // concurrent /sessions/switch into the same target can short-circuit even
  // while the spawn is still mid-flight (lastSessionId isn't written until
  // _doStartExternalSession reaches its session-context-bind step).
  let resolveStarting: () => void;
  startingPromise = new Promise(r => { resolveStarting = r; });
  startingSessionId = options.sessionId;

  try {
    await _doStartExternalSession(options);
  } finally {
    startingPromise = null;
    startingSessionId = null;
    resolveStarting!();
  }
}

/** Internal start implementation — called through concurrency guard above */
async function _doStartExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  initialImages?: ImagePayload[];
  model?: string;
  permissionMode?: string;
  scenario: InteractionScenario;
  resumeSessionId?: string;
  envPolicy?: import('../../shared/types/runtime').RuntimeEnvPolicy;
}): Promise<void> {

  const runtimeType = getCurrentRuntimeType();
  const runtime = getExternalRuntime(runtimeType);
  activeRuntime = runtime;

  // Issue #194 — resolve agent envPolicy from disk if caller didn't pass it
  // explicitly. Most call sites (sendExternalMessage, prewarm) don't have
  // access to the agent config, so doing it here avoids N copies of the lookup.
  const resolvedEnvPolicy = options.envPolicy
    ?? await resolveAgentEnvPolicy(options.workspacePath);

  // Build system prompt using MyAgents' three-layer architecture.
  // Pass the current runtime so L1 identity text reports the correct CLI
  // (e.g. "Google Gemini CLI" instead of the builtin default).
  //
  // cliToolsEnabled: true — teach the AI about `myagents cron …` / `myagents
  // im send-media` / `myagents im wake|channels` via a progressive-disclosure
  // appendix. v0.2.11+ also enables this on the builtin path (agent-session.ts)
  // because the corresponding in-process MCP servers (`cron-tools`, `im-cron`,
  // `im-media`) were retired in favour of the CLI surface — single source of
  // truth across builtin + external runtimes. See
  // prd_0.1.67_external_runtime_cli_skill.md for the original design.
  //
  // Generative-UI widget guidance is universal (no MCP equivalent) and is
  // injected unconditionally for desktop scenarios via buildWidgetSection().
  const baseSystemPrompt = buildSystemPromptAppend(options.scenario, {
    runtime: runtimeType,
    cliToolsEnabled: true,
  });

  // Cross-runtime workspace protocol: append workspace instruction files
  // so external runtimes receive the same project context as the builtin SDK.
  //   - Codex: only .claude/rules/*.md (CLAUDE.md is loaded natively via -c flag)
  //   - Gemini: full chain fallback (handled inside writeSessionSystemPrompt)
  //   - Claude Code: no injection needed (reads CLAUDE.md natively)
  const workspaceInstructions = runtimeType === 'codex'
    ? resolveCodexWorkspaceInstructions(options.workspacePath)
    : '';  // Gemini handles it in writeSessionSystemPrompt; CC reads natively
  if (workspaceInstructions) {
    console.log(`[external-session] Injecting workspace instructions for ${runtimeType} (${workspaceInstructions.length} bytes)`);
  }
  const systemPromptAppend = workspaceInstructions
    ? baseSystemPrompt + '\n\n' + workspaceInstructions
    : baseSystemPrompt;

  // External runtimes don't go through the SDK's session creation flow, so the
  // "pending-{tabId}" placeholder that the frontend assigns never gets upgraded
  // to a real UUID. A pending-prefixed ID in SessionStore breaks history reload
  // because the frontend's loadSession guard skips any session whose ID starts
  // with "pending-". Fix: mint a real UUID here on the first start (not resume).
  if (isPendingSessionId(options.sessionId) && !options.resumeSessionId) {
    const realId = crypto.randomUUID();
    console.log(`[external-session] Upgrading pending session ID: ${options.sessionId} → ${realId}`);
    options.sessionId = realId;
  }

  console.log(`[external-session] Starting ${runtimeType} session for ${options.sessionId}, model=${options.model || '(default)'}, permissionMode=${options.permissionMode || '(default)'}, scenario=${options.scenario.type}, resume=${options.resumeSessionId || 'none'}`);
  // Detect pre-warm: prewarmExternalSession calls us with initialMessage=undefined.
  // Stamp this onto the session_init broadcast so the frontend doesn't enter the
  // "loading" state for a process that hasn't started processing any turn yet.
  isPrewarmingSession = !options.initialMessage;
  turnCompleted = false;
  lastTurnSucceeded = false;  // Reset — success only set after turn_complete
  resetTurnAccumulators();
  // Watchdog is per-turn, not per-process. Pre-warm (no initialMessage) leaves
  // the process idle awaiting a user message — starting a 10-min timer here
  // would fire a bogus "timed out" toast if the user takes >10 min to type.
  // The real watchdog is armed when the first turn begins (Case 3 in
  // sendExternalMessage, or the initialMessage block below).
  if (options.initialMessage) {
    resetWatchdog();
  }
  currentTurnStartTime = 0;
  // Track latest config for resume
  if (options.model !== undefined) lastModel = options.model;
  if (options.permissionMode !== undefined) lastPermissionMode = options.permissionMode;
  // Only clear message history for new sessions, not resumes
  if (!options.resumeSessionId) {
    allSessionMessages = [];
  }

  // Record user message for SessionStore persistence.
  // If sendExternalMessage already broadcast this message (earlyBroadcastedUserMsg),
  // reuse that instance to keep IDs consistent and skip the redundant SSE broadcast.
  if (options.initialMessage) {
    const userMsg: SessionMessage = earlyBroadcastedUserMsg ?? {
      id: `user-${Date.now()}`,
      role: 'user',
      content: options.initialMessage,
      timestamp: new Date().toISOString(),
    };
    if (!earlyBroadcastedUserMsg) {
      broadcast('chat:message-replay', { message: userMsg });
    }
    earlyBroadcastedUserMsg = null;  // Consumed
    allSessionMessages.push(userMsg);
    resetTurnAccumulators();
    currentTurnStartTime = Date.now();

    // Persist user message immediately (crash safety — don't wait for turn_complete)
    try { await saveSessionMessages(options.sessionId, allSessionMessages); }
    catch (err) { console.error('[external-session] Failed to persist user message:', err); }

    // Register session in history index (mirrors agent-session.ts enqueueUserMessage logic)
    if (!options.resumeSessionId) {
      await registerSessionMetadataIfNew(options.sessionId, options.workspacePath, options.initialMessage, 'initial message', options.scenario);
    }
  }

  // Pre-warm path (no initialMessage) keeps state as 'idle' so the UI doesn't
  // show a spinner for a process that isn't actually processing a turn. Real
  // turn activity transitions to 'running' via Case 3 in sendExternalMessage
  // or the initial message path below.
  if (options.initialMessage) {
    setExternalSessionState('running');
  }

  // Set session context BEFORE startSession so that events fired during startup
  // (e.g., Codex's synchronous session_init) can reference lastSessionId for persistence.
  lastSessionId = options.sessionId;
  lastWorkspacePath = options.workspacePath;
  lastScenario = options.scenario;

  // Set isRunning BEFORE spawning — prevents waitForExternalSessionIdle from
  // seeing the pre-start state and returning true prematurely. Reset in catch.
  isRunning = true;

  const startOnce = (resumeId: string | undefined): Promise<RuntimeProcess> =>
    runtime.startSession(
      {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        initialMessage: options.initialMessage,
        initialImages: options.initialImages,
        systemPromptAppend,
        model: options.model,
        permissionMode: options.permissionMode,
        scenario: options.scenario,
        resumeSessionId: resumeId,
        envPolicy: resolvedEnvPolicy,
      },
      handleUnifiedEvent,
    );

  try {
    let process: RuntimeProcess;
    try {
      process = await startOnce(options.resumeSessionId);
    } catch (err) {
      // Stale resume recovery (issue #105): the runtime reports our persisted
      // runtimeSessionId is dead (Codex rollout GC'd, Gemini session dropped
      // across CLI upgrade, etc.). Invalidate both the in-memory pointer and
      // the on-disk metadata, then retry fresh once so the user's message
      // still lands instead of looping on the stale id forever. If the fresh
      // retry also fails, fall through to the normal error surface.
      if (err instanceof StaleRuntimeSessionError && options.resumeSessionId) {
        console.warn(`[external-session] ${runtimeType} resume rejected as stale (id=${err.runtimeSessionId}): ${err.message} — invalidating and retrying fresh`);
        lastRuntimeSessionId = '';
        if (options.sessionId) {
          try {
            await updateSessionMetadata(options.sessionId, { runtimeSessionId: '' });
          } catch (metaErr) {
            console.warn('[external-session] Failed to clear stale runtimeSessionId on disk:', metaErr);
          }
        }
        // Also drop any pre-warm deferred pointer that belongs to a now-dead
        // resume — letting it survive would re-patch the stale id onto the
        // next metadata registration.
        if (deferredRuntimeSessionId?.forSessionId === options.sessionId) {
          deferredRuntimeSessionId = null;
        }
        process = await startOnce(undefined);
        console.log(`[external-session] ${runtimeType} recovered via fresh start after stale resume`);
      } else {
        throw err;
      }
    }

    activeProcess = process;
    console.log(`[external-session] ${runtimeType} process started, pid=${activeProcess.pid}`);
  } catch (err) {
    isRunning = false;
    activeProcess = null;
    activeRuntime = null;
    clearWatchdog();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[external-session] Failed to start ${runtimeType}:`, message);
    // Pre-warm failures are silent — the user didn't ask for this optimization
    // and shouldn't see an error toast for it. The next real user message will
    // retry via the normal send path; if that also fails, the error surfaces
    // there with full context (which runtime, which sessionId, etc).
    if (options.initialMessage) {
      setExternalSessionState('error');
      broadcast('chat:agent-error', { message: `Failed to start ${runtimeType}: ${message}` });
    }
    // Re-throw so the HTTP handler returns an error response
    throw err;
  }
}

/**
 * Session context for first-time initialization (passed from index.ts)
 */
export interface ExternalSendContext {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;  // Runtime-specific model (e.g., "sonnet", "opus")
  // Pattern B — IM trace ID. Forwarded from /api/im/chat (Rust generates at edge).
  // Tags every UnifiedEvent emitted to ImEventBus so the bus subscriber for this
  // request can route delta/block-end/etc. to the correct reply slot.
  // Desktop / cron callers omit (no IM identity) — events drop silently.
  requestId?: string;
}

/**
 * Send a user message via external runtime.
 * Handles three cases:
 * 1. No previous session → start a new one (first message)
 * 2. Previous process exited → resume with --resume (CC -p mode multi-turn)
 * 3. Process still running → send via stdin (shouldn't happen in -p mode)
 *
 * Modality scope (V1): the model-input-modality filter (see
 * `agent-session.ts::enqueueUserMessage` + `model-capabilities.ts::modelSupportsModality`)
 * lives only on the builtin Claude Agent SDK path. External runtimes (Claude
 * Code CLI / Codex / Gemini CLI) pass `images` through unfiltered here.
 * Rationale:
 *   - Each external runtime has its own modality contract (Codex blocks
 *     images, Gemini accepts image+video+audio, CC CLI accepts images).
 *   - External runtime models aren't in MyAgents' PRESET_PROVIDERS registry,
 *     so `lookupModelCapability` would return undefined → optimistic
 *     default-allow → effectively no filter, just runtime overhead.
 *   - The frontend toast in `SimpleChatInput` is gated behind
 *     `!isExternalRuntime` to keep UX honest (no false "will be filtered"
 *     promises on runtimes that pass images through).
 * If you ever wire modality lookups for external-runtime models, add the
 * filter here and lift the frontend gate.
 */
export async function sendExternalMessage(
  text: string,
  images?: ImagePayload[],
  _permissionMode?: string,
  _model?: string,
  context?: ExternalSendContext,
  preBroadcasted?: SessionMessage,
): Promise<{ queued: boolean; error?: string }> {
  const hasImages = images && images.length > 0;

  // Show user message immediately — don't block on pre-warm or turn serialization.
  // The message appears in the chat as soon as the user presses send, giving
  // responsive feedback even when the runtime takes 10-15s to cold-start.
  // Downstream code (Case 1/2/3) also calls broadcast('chat:message-replay')
  // for the same message — we set earlyBroadcastedUserMsg so they can skip
  // the redundant broadcast while still recording for persistence.
  //
  // Issue #188 — when the caller (enqueueExternalSendForDesktop) has already
  // broadcast the bubble synchronously so the renderer sees it immediately,
  // adopt that SessionMessage here instead of re-broadcasting. Without this,
  // the user's bubble would flash twice with different IDs.
  let earlyUserMsg: SessionMessage;
  if (preBroadcasted) {
    earlyUserMsg = preBroadcasted;
  } else {
    earlyUserMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    broadcast('chat:message-replay', { message: earlyUserMsg });
  }
  earlyBroadcastedUserMsg = earlyUserMsg;

  // If a pre-warm (or other concurrent start) is still bringing the process
  // up, wait for it to finish before deciding which case to take. Without
  // this await, a user-send racing an in-flight pre-warm would see
  // `isRunning=true` but `activeProcess=null` — falling into Case 2's resume
  // path, which calls startExternalSession again, which then hits the
  // `if (isRunning) return` early-exit and silently drops the user's message.
  if (startingPromise) {
    await startingPromise;
  }

  // Serialize against any in-flight turn. Persistent-process runtimes (Codex
  // app-server, Gemini --acp) accept one turn at a time — dispatching a
  // second user message while the first is still running can cause silent
  // drops or interleaved output. `turnCompleted=false && currentTurnStartTime
  // !== 0` means a previous user turn kicked off and hasn't finished. On
  // crash, session_complete resets currentTurnStartTime via
  // resetTurnAccumulators(), so this gate doesn't spuriously trip.
  //
  // Issue #188 — if the busy turn doesn't settle within the cap, do NOT fall
  // through to Case 3 and dispatch into a still-running runtime. That used to
  // silently drop the message (or interleave with the active turn). Return a
  // queue-style error so the caller can surface it to the user.
  if (!turnCompleted && currentTurnStartTime !== 0 && activeProcess && !activeProcess.exited) {
    const settled = await waitForExternalSessionIdle(5 * 60 * 1000, 100);
    if (!settled) {
      earlyBroadcastedUserMsg = null;
      return { queued: false, error: '上一个回合超过 5 分钟未完成，消息未发送，请稍后重试。' };
    }
  }

  // Pattern B — set the active IM trace ID *after* the previous turn has
  // settled. Setting it earlier (pre-fix) caused tail deltas/complete events
  // from the running turn A to be tagged with turn B's requestId during the
  // wait window, mis-routing them to the wrong IM subscriber and breaking
  // cancellation attribution. session-end (session_complete /
  // stopExternalSession) clears it again. No-op when context.requestId is
  // undefined (desktop / cron paths).
  if (context?.requestId) {
    activeRequestId = context.requestId;
  }

  // Case 1: No previous session — start fresh
  if (!lastRuntimeSessionId && !isRunning) {
    if (!context) {
      return { queued: false, error: 'No session context for first message' };
    }
    try {
      await startExternalSession({
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        initialMessage: text,
        initialImages: hasImages ? images : undefined,
        model: context.model,
        permissionMode: context.permissionMode,
        scenario: context.scenario,
      });
      return { queued: true };
    } catch (err) {
      earlyBroadcastedUserMsg = null;  // Defensive: prevent stale msg leaking to next send
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 2: Previous process exited — resume (CC -p mode multi-turn)
  if (!activeProcess || activeProcess.exited) {
    // CC supports custom session IDs (--session-id) — resume with our MyAgents session ID.
    // Codex doesn't support custom IDs — resume with Codex's own threadId (lastRuntimeSessionId).
    const runtimeType = getCurrentRuntimeType();
    const resumeId = runtimeType === 'claude-code' ? lastSessionId : lastRuntimeSessionId;
    const nextScenario = context?.scenario ?? lastScenario;
    const nextModel = context ? context.model : lastModel;
    const nextPermissionMode = context ? context.permissionMode : lastPermissionMode;
    console.log(`[external-session] Previous process exited, resuming ${runtimeType} session ${resumeId}`);
    try {
      await startExternalSession({
        sessionId: lastSessionId,
        workspacePath: lastWorkspacePath,
        initialMessage: text,
        initialImages: hasImages ? images : undefined,
        model: nextModel,
        permissionMode: nextPermissionMode,
        scenario: nextScenario,
        resumeSessionId: resumeId, // CC: --resume <myagents-session-id>; Codex: --resume <threadId>
      });
      return { queued: true };
    } catch (err) {
      earlyBroadcastedUserMsg = null;  // Defensive: prevent stale msg leaking to next send
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 3: Process still running — send via runtime.sendMessage
  // This is the normal path for persistent-process runtimes like Codex app-server.
  if (!activeRuntime) {
    return { queued: false, error: 'No active runtime' };
  }
  try {
    // Record user message for persistence. Reuse early-broadcast message if available
    // (sendExternalMessage already showed it to the user for instant feedback).
    const userMsg: SessionMessage = earlyBroadcastedUserMsg ?? {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    if (!earlyBroadcastedUserMsg) {
      broadcast('chat:message-replay', { message: userMsg });
    }
    earlyBroadcastedUserMsg = null;  // Consumed
    allSessionMessages.push(userMsg);
    turnCompleted = false;
    lastTurnSucceeded = false;  // Reset for this turn (prevents stale text on failure)
    resetTurnAccumulators();
    resetWatchdog();  // Start watchdog for this turn (Case 3 bypasses startExternalSession)
    currentTurnStartTime = Date.now();

    // First real user turn clears the pre-warm marker. Also strip it from the
    // cached system_init payload so SSE reconnect replay reflects the current
    // "actually processing a turn" state, not the stale "alive but idle" hint.
    isPrewarmingSession = false;
    if (externalSystemInitPayload) {
      externalSystemInitPayload = { ...externalSystemInitPayload, prewarm: undefined };
    }

    // Register session metadata on first real message of a pre-warmed session.
    // Normally this happens inside startExternalSession's initialMessage block,
    // but pre-warm calls startExternalSession WITHOUT an initialMessage, so we
    // have to register here when the first actual message arrives via Case 3.
    await registerSessionMetadataIfNew(lastSessionId, lastWorkspacePath, text, 'first message after pre-warm', lastScenario);

    // Persist user message immediately (crash safety)
    if (lastSessionId) {
      try { await saveSessionMessages(lastSessionId, allSessionMessages); }
      catch (err) { console.error('[external-session] Failed to persist user message:', err); }
    }

    setExternalSessionState('running');
    await activeRuntime.sendMessage(activeProcess, text, hasImages ? images : undefined);
    return { queued: true };
  } catch (err) {
    return { queued: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Desktop /chat/send entry — fire-and-forget dispatch with proper serialization.
 *
 * Issue #188:
 *   sendExternalMessage internally awaits waitForExternalSessionIdle(5*60s)
 *   to serialize against an in-flight turn. The Rust SSE proxy's overall HTTP
 *   timeout is 120s, so directly awaiting sendExternalMessage from the HTTP
 *   handler made the request die with the proxy's generic "操作超时" error,
 *   which the renderer surfaced as "AI 调用失败：网络错误". This helper
 *   decouples the HTTP response from runtime dispatch:
 *
 *   1. Broadcast the user-message bubble synchronously so the renderer shows
 *      it the moment the user clicks send (regardless of queue depth).
 *   2. Chain the actual sendExternalMessage onto a module-level promise tail
 *      so concurrent desktop sends serialize against each other. Without this
 *      tail, multiple sends would all wake from the same turnCompleted gate
 *      simultaneously, overwrite earlyBroadcastedUserMsg, and double-write
 *      to the persistent-runtime stdin.
 *   3. Return the dispatch promise. Callers should fire-and-forget and
 *      surface failures via chat:agent-error since the HTTP response is
 *      already on its way back to the renderer.
 */
export function enqueueExternalSendForDesktop(
  text: string,
  images: ImagePayload[] | undefined,
  permissionMode: string | undefined,
  model: string | undefined,
  context: ExternalSendContext,
): Promise<{ queued: boolean; error?: string }> {
  const userMsg: SessionMessage = {
    id: `user-${Date.now()}`,
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
  };
  broadcast('chat:message-replay', { message: userMsg });

  const task = externalDesktopSendTail.then(() =>
    sendExternalMessage(text, images, permissionMode, model, context, userMsg)
  );
  externalDesktopSendTail = task.catch(() => undefined);
  return task;
}

/**
 * Respond to a permission request from the external runtime.
 * @param decision - 'deny' | 'allow_once' | 'always_allow'
 *   For CC: always_allow includes updatedPermissions from the original permission_suggestions
 *   so CC persists the rule and won't re-prompt for the same tool.
 */
export async function respondExternalPermission(
  requestId: string,
  decision: 'deny' | 'allow_once' | 'always_allow',
  reason?: string,
): Promise<void> {
  if (!activeProcess || !activeRuntime) {
    console.warn('[external-session] No active process for permission response');
    return;
  }
  // Retrieve and consume stored suggestions for this request
  const suggestions = pendingPermissionSuggestions.get(requestId);
  pendingPermissionSuggestions.delete(requestId);
  pendingExternalInteractiveRequests.delete(requestId);
  console.log(`[external-session] Permission response: ${decision} for requestId=${requestId}${suggestions?.length ? `, with ${suggestions.length} suggestion(s)` : ''}`);
  await activeRuntime.respondPermission(activeProcess, requestId, decision, reason, suggestions);
}

/**
 * Whether an outstanding external AskUserQuestion request is tracked for this requestId.
 * Used by the HTTP layer to route /api/ask-user-question/respond to the external runtime
 * when the request originated from CC (rather than the builtin SDK handler).
 */
export function hasPendingExternalAskUserQuestion(requestId: string): boolean {
  return pendingExternalAskUserQuestions.has(requestId);
}

/**
 * Deliver the user's AskUserQuestion answers (or a cancellation) back to the external runtime.
 * For CC: allow the tool call with `updatedInput = { ...original, answers }`, or deny on cancel.
 */
export async function respondExternalAskUserQuestion(
  requestId: string,
  answers: Record<string, string> | null,
): Promise<boolean> {
  const pending = pendingExternalAskUserQuestions.get(requestId);
  if (!pending) {
    console.warn(`[external-session] Unknown AskUserQuestion requestId: ${requestId}`);
    return false;
  }
  // Check process liveness BEFORE consuming the pending entry (cross-review C4):
  // previously we deleted up front, so a transient "process gone" state silently
  // discarded the answer and left the user with no affordance to retry. Keeping
  // the entry when we can't deliver lets the caller observe the failure and the
  // routing layer keep sending it to the external handler, not the builtin one.
  if (!activeProcess || !activeRuntime) {
    console.warn(`[external-session] No active process for AskUserQuestion response requestId=${requestId} — session likely stopped before user answered`);
    return false;
  }

  try {
    if (answers === null) {
      console.log(`[external-session] AskUserQuestion cancelled for requestId=${requestId}`);
      // PRD #131 — `interrupt: true` so AskUserQuestion cancel terminates
      // the whole assistant turn rather than only this single tool call.
      // Without it, CC keeps the turn alive and the model just calls
      // another tool, defeating the user's "I'm stopping this" intent.
      // Mirrors the builtin canUseTool path in agent-session.ts.
      await activeRuntime.respondPermission(
        activeProcess,
        requestId,
        'deny',
        '用户取消了问答',
        undefined,
        undefined,
        true,
      );
    } else {
      console.log(`[external-session] AskUserQuestion answered for requestId=${requestId}`);
      const updatedInput = { ...pending.input, answers };
      await activeRuntime.respondPermission(activeProcess, requestId, 'allow_once', undefined, undefined, updatedInput);
    }
    // Delete only after successful delivery — if respondPermission throws
    // (e.g. stdin closed mid-write) the caller can retry.
    pendingExternalAskUserQuestions.delete(requestId);
    pendingExternalInteractiveRequests.delete(requestId);
    return true;
  } catch (err) {
    console.error(`[external-session] respondPermission failed for requestId=${requestId}:`, err);
    return false;
  }
}

/**
 * Pattern D — IM trace-id-targeted cancellation for external runtimes.
 * For CC/Codex/Gemini we don't have a per-request granularity (the runtime
 * processes turns sequentially), so cancellation degenerates to "stop the
 * active session if `requestId` matches `activeRequestId`". Returns
 * { aborted, mode } same shape as the builtin `cancelImRequest`.
 */
export async function cancelExternalImRequest(
  requestId: string,
  _reason: string = 'user',
): Promise<{ aborted: boolean; mode: 'running' | 'queued' | 'unknown' }> {
  if (activeRequestId === requestId && isExternalSessionActive()) {
    console.log(`[external-session] cancelExternalImRequest requestId=${requestId} mode=running`);
    await stopExternalSession();
    return { aborted: true, mode: 'running' };
  }
  return { aborted: false, mode: 'unknown' };
}

/**
 * Stop the active external session
 */
export async function stopExternalSession(): Promise<boolean> {
  clearWatchdog();
  if (!activeProcess || !activeRuntime) return false;
  try {
    await activeRuntime.stopSession(activeProcess);
    return true;
  } catch (err) {
    console.error('[external-session] Error stopping session:', err);
    // Pattern 1 P0-1 fix #11: previously fell through to a single
    // SIGTERM-default kill that could hang indefinitely. Now bound the
    // shutdown via killWithEscalation: 2s graceful → 1s hard → orphan log.
    const proc = activeProcess;
    void killWithEscalation(
      {
        pid: proc.pid,
        exited: proc.exited,
        kill: (signal) => {
          // RuntimeProcess.kill accepts number; map signal names to SIGTERM/SIGKILL ints.
          const num = typeof signal === 'string'
            ? (signal === 'SIGKILL' ? 9 : 15)
            : (signal ?? 15);
          proc.kill(num);
        },
        waitForExit: () => proc.waitForExit(),
      },
      {
        gracefulMs: 2000,
        hardMs: 1000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') console.warn(`[external-session] catch fallback orphan pid=${info.pid}`);
        },
      },
    );
    return true;
  } finally {
    activeProcess = null;
    activeRuntime = null;
    isRunning = false;
    // Any pre-warm that raced with a stop is no longer relevant. Keeping the
    // flag around would leak 'prewarm' into a subsequent session's session_init
    // broadcast. _doStartExternalSession resets this per-call too, but some
    // paths (setExternalPermissionMode fallback) call stopExternalSession
    // without a follow-up start — explicit reset here keeps the state machine
    // consistent regardless of what runs next.
    isPrewarmingSession = false;
    pendingPermissionSuggestions.clear();  // Prevent stale suggestions leaking across sessions
    drainPendingInteractiveRequestsAsExpired('stop');  // PRD #131 — clear stale modals before wiping map
    pendingExternalAskUserQuestions.clear();  // Stale AskUserQuestion requestIds would misroute to new session
    pendingExternalInteractiveRequests.clear();
    externalSystemInitPayload = null;
    // Pattern B: notify IM bus subscribers (prevents orphaned SSE streams on user-stop) + clear active ID.
    // Pattern C: also unregister from request registry.
    fireImCallback('error', 'Session stopped');
    if (activeRequestId) {
      imRequestRegistry.setStatus(activeRequestId, 'failed');
      imRequestRegistry.unregister(activeRequestId);
    }
    activeRequestId = null;
    setExternalSessionState('idle');
  }
}

/**
 * Check if an external session is active
 */
export function isExternalSessionActive(): boolean {
  return isRunning && activeProcess !== null && !activeProcess.exited;
}

/**
 * Truncate `allSessionMessages` at the given user message id and persist the
 * truncation. Returns the popped user message's content + attachments so the
 * caller can re-send.
 *
 * External-runtime equivalent of builtin `rewindSession()`. Used by the
 * retry button when the previous turn failed (e.g. model capacity). External
 * runtimes don't support /chat/rewind because there's no SDK resume anchor /
 * file checkpoint to roll back, but a "drop the failed user turn + resend"
 * semantic is still sound: the failed turn never produced an assistant
 * message (persistTurnResult only fires on subtype=success), so the local
 * history just has a dangling user message at the tail.
 *
 * Caller is responsible for invoking sendExternalMessage with the returned
 * content. We don't do the resend here so the existing send path's
 * MCP/agents/model wiring stays the single source of truth.
 *
 * Refuses if a turn is currently in flight — the user must abort first.
 */
export async function popLastUserMessageForRetry(userMessageId: string): Promise<{
  success: boolean;
  error?: string;
  content?: string;
  attachments?: SessionMessage['attachments'];
}> {
  if (!lastSessionId) {
    return { success: false, error: 'No active external session' };
  }
  if (isExternalSessionActive()) {
    return { success: false, error: 'Cannot retry while a turn is in progress' };
  }
  const targetIndex = allSessionMessages.findIndex(
    m => m.id === userMessageId && m.role === 'user',
  );
  if (targetIndex < 0) {
    return { success: false, error: 'Message not found' };
  }
  const target = allSessionMessages[targetIndex];
  const content = typeof target.content === 'string' ? target.content : '';
  const attachments = target.attachments;

  // Truncate (drops the failed user msg + any partial assistant blocks left
  // behind from a half-finalized turn). saveSessionMessages already detects
  // `messages.length < existingCount` and rewrites the JSONL.
  allSessionMessages.length = targetIndex;
  try {
    await saveSessionMessages(lastSessionId, allSessionMessages);
  } catch (err) {
    console.error('[external-session] popLastUserMessageForRetry: failed to persist truncation:', err);
    return { success: false, error: 'Failed to persist truncation' };
  }
  return { success: true, content, attachments };
}

/**
 * Pre-warm an external runtime process so the first user message skips the
 * cold-start cost (spawn + `initialize` + `session/new` + prompt-file write).
 *
 * Called from the `/api/runtime/prewarm` HTTP endpoint when the frontend opens
 * a Chat tab whose runtime is Gemini or Codex (both persistent JSON-RPC
 * processes). Claude Code's `-p` mode exits after every turn, so pre-warming
 * it is wasted work — the endpoint gates that out before reaching this path.
 *
 * Flow:
 *   1. Bail out if a session is already active (pre-warm is idempotent).
 *   2. Call startExternalSession with NO initialMessage — the runtime spawns
 *      the CLI, does its handshake, opens a session, and then sits idle.
 *   3. First real user message hits sendExternalMessage Case 3 (process alive)
 *      and writes directly to stdin via activeRuntime.sendMessage — no cold
 *      boot.
 *
 * The startExternalSession `startingPromise` guard serializes pre-warm against
 * any concurrent send, so a user who sends a message before pre-warm finishes
 * spawning is safely queued behind it.
 */
export async function prewarmExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  model?: string;
  permissionMode?: string;
}): Promise<{ prewarmed: boolean; reason?: string }> {
  const runtimeType = getCurrentRuntimeType();
  // Only Gemini and Codex run as persistent JSON-RPC processes — pre-warming
  // CC's `-p` mode is wasted because the process exits after each turn.
  if (runtimeType !== 'gemini' && runtimeType !== 'codex') {
    return { prewarmed: false, reason: `Pre-warm not applicable for runtime=${runtimeType}` };
  }
  // Already warm (from previous pre-warm or live session) — no-op.
  if (isExternalSessionActive() || isRunning || startingPromise) {
    return { prewarmed: false, reason: 'Session already active or starting' };
  }

  // Cross-runtime guard — refuse to warm a session whose persisted metadata
  // names a different runtime. Frontend Chat.tsx also guards this, but the
  // frontend's sessionRuntime is populated async via loadSession, so the
  // effect may fire before that state settles. Backend check uses the
  // authoritative source (SessionStore) and closes the race-window hole.
  const meta = getSessionMetadata(options.sessionId);
  if (meta?.runtime && meta.runtime !== runtimeType) {
    return { prewarmed: false, reason: `Session runtime mismatch: persisted=${meta.runtime}, current=${runtimeType}` };
  }

  // Pick resume ID if restoreExternalSessionState populated one — but only if
  // it actually belongs to this session. lastRuntimeSessionId is module-level
  // state that can carry over from a previous session in Handover scenario 4,
  // or simply be stale if restoreExternalSessionState hasn't run yet for this
  // sessionId. Using a mismatched resume ID would produce "No conversation
  // found" from the CLI and wipe user intent.
  const resumeSessionId = (lastSessionId === options.sessionId && lastRuntimeSessionId)
    ? lastRuntimeSessionId
    : undefined;

  console.log(`[external-session] Pre-warming ${runtimeType} for session ${options.sessionId}${resumeSessionId ? ` (resume=${resumeSessionId})` : ' (fresh)'}`);

  await startExternalSession({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    // initialMessage intentionally omitted — this is the pre-warm signal
    model: options.model,
    permissionMode: options.permissionMode,
    scenario: options.scenario,
    resumeSessionId,
  });

  return { prewarmed: true };
}

/**
 * Query models for a given runtime type
 */
export async function queryRuntimeModels(runtimeType: RuntimeType): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return await runtime.queryModels();
  } catch (err) {
    console.error(`[external-session] Failed to query models for ${runtimeType}:`, err);
    return [];
  }
}

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtimeType: RuntimeType): unknown[] {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return runtime.getPermissionModes();
  } catch {
    return [];
  }
}

// ─── Private: shared turn finalization (used by both turn_complete and session_complete) ───

/** Flush accumulated content blocks, persist to SessionStore, and broadcast completion.
 * Called by both turn_complete (Codex) and session_complete (CC) to avoid duplication. */
async function persistTurnResult(): Promise<void> {
  // Defense-in-depth: the `session_complete` handler reads `persistInFlight`
  // to decide whether to fire `setExternalSessionState('idle')` synchronously.
  // When persistInFlight=true, idle is deferred to this function. If we throw
  // BEFORE reaching the explicit setExternalSessionState('idle') below
  // (e.g. JSON.stringify on a circular currentContentBlocks, or
  // flushAllPending throws sync), the renderer would be stuck in `running`
  // forever for that session. Outer try/finally guarantees idle ALWAYS fires.
  // Caller still gets the error via the fire-and-forget `.catch` for logging.
  // v0.2.14 cross-bugfix follow-up.
  try {
    const turnDurationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined;
    flushAllPending();

    // PRD 0.2.15 Review A4 fix — drain in-flight attachment saves so the
    // placeholder attachments embedded in currentContentBlocks get patched
    // BEFORE we snapshot to disk. Without this await, large/slow saves land
    // their `tool_attachment_update` after `currentContentBlocks = []` reset
    // and the disk JSON keeps the "生成中" placeholder forever.
    await awaitInFlightSaves();

    const usageData = buildPersistedTurnUsage();
    const turnToolCount = currentContentBlocks.filter(b => b.type === 'tool_use').length;
    const runtimeType = getCurrentRuntimeType();

    if (currentContentBlocks.length > 0) {
      const content = JSON.stringify(currentContentBlocks);
      allSessionMessages.push({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: new Date().toISOString(),
        durationMs: turnDurationMs,
        usage: usageData,
        toolCount: turnToolCount || undefined,
      });
      resetTurnAccumulators();
    } else if (currentAssistantText.trim()) {
      // Fallback: no structured blocks, just plain text (e.g. CC slash commands)
      allSessionMessages.push({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: currentAssistantText,
        timestamp: new Date().toISOString(),
        durationMs: turnDurationMs,
        usage: usageData,
      });
      resetTurnAccumulators();
    }

    // Save cumulative messages to disk (saveSessionMessages uses .slice(existingCount) to append)
    if (allSessionMessages.length > 0 && lastSessionId) {
      try {
        await saveSessionMessages(lastSessionId, allSessionMessages);
        const lastMsg = allSessionMessages[allSessionMessages.length - 1];
        await updateSessionMetadata(lastSessionId, {
          lastActiveAt: new Date().toISOString(),
          lastMessagePreview: extractTextPreview(lastMsg?.content ?? ''),
          runtimeUsageTotals: lastPersistedRuntimeUsageTotals ?? undefined,
        });
      } catch (err) {
        console.error('[external-session] Failed to save session messages:', err);
      }
    }

    broadcast('chat:message-complete', {
      ...(usageData ? {
        model: usageData.model,
        input_tokens: usageData.inputTokens,
        output_tokens: usageData.outputTokens,
        cache_read_tokens: usageData.cacheReadTokens,
        cache_creation_tokens: usageData.cacheCreationTokens,
      } : {}),
      ...(turnToolCount > 0 ? { tool_count: turnToolCount } : {}),
      ...(turnDurationMs ? { duration_ms: turnDurationMs } : {}),
    });
    trackServer('ai_turn_complete', {
      source: lastScenario.type,
      platform: lastScenario.type === 'im' ? lastScenario.platform : null,
      runtime: runtimeType,
      model: usageData?.model || lastRuntimeReportedModel || lastModel || null,
      input_tokens: usageData?.inputTokens ?? 0,
      output_tokens: usageData?.outputTokens ?? 0,
      cache_read_tokens: usageData?.cacheReadTokens ?? 0,
      cache_creation_tokens: usageData?.cacheCreationTokens ?? 0,
      tool_count: turnToolCount,
      duration_ms: turnDurationMs ?? 0,
    });
  } finally {
    // Always reach idle, even if the body above threw. The
    // session_complete handler counts on us to drain the deferred idle.
    setExternalSessionState('idle');
    fireImCallback('complete', '');
    // Pattern B/C: turn complete — clear active trace ID + unregister from registry.
    if (activeRequestId) {
      imRequestRegistry.setStatus(activeRequestId, 'completed');
      imRequestRegistry.unregister(activeRequestId);
    }
    activeRequestId = null;
  }
}

// ─── Private: UnifiedEvent → SSE broadcast ───

function handleUnifiedEvent(event: UnifiedEvent): void {
  switch (event.kind) {
    case 'text_delta':
      broadcast('chat:message-chunk', event.text);
      currentAssistantText += event.text;
      pendingTextBuffer += event.text;
      fireImCallback('delta', event.text);
      resetWatchdog();
      break;

    case 'text_stop':
      // Text block ended — flush accumulated text into a content block
      console.log(`[external-session] text_stop: accumulated ${currentAssistantText.length} chars`);
      flushPendingText();
      fireImCallback('block-end', '');
      break;

    case 'thinking_start':
      flushPendingText();  // Close any open text block before thinking
      if (pendingThinkingActive) {
        // Defensive close: a new reasoning block implies the previous one ended,
        // even if the runtime never sent an explicit stop.
        flushPendingThinking(true);
      }
      pendingThinkingText = '';
      pendingThinkingIndex = event.index;
      pendingThinkingActive = true;
      pendingThinkingStartedAt = Date.now();
      broadcast('chat:thinking-start', { index: event.index });
      fireImCallback('activity', '');
      break;

    case 'thinking_delta':
      if (!pendingThinkingActive) {
        pendingThinkingActive = true;
        pendingThinkingIndex = event.index;
        pendingThinkingStartedAt = Date.now();
      }
      pendingThinkingText += event.text;
      // Frontend expects { index, delta } — match builtin SSE shape
      broadcast('chat:thinking-chunk', { index: event.index, delta: event.text });
      resetWatchdog();
      break;

    case 'thinking_stop':
      flushPendingThinking(true);
      // Emit content-block-stop so frontend closes the thinking block
      broadcast('chat:content-block-stop', { index: event.index, type: 'thinking' });
      break;

    case 'tool_use_start':
      flushPendingText();  // Close any open text block before tool use
      pendingToolInputs.set(event.toolUseId, {
        name: event.toolName,
        inputJson: event.input ? JSON.stringify(event.input, null, 2) : '',
      });
      broadcast('chat:tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: event.input ?? {},
      });
      fireImCallback('activity', '');
      break;

    case 'tool_input_delta': {
      const toolEntry = pendingToolInputs.get(event.toolUseId);
      if (toolEntry) {
        toolEntry.inputJson += event.delta;
      }
      broadcast('chat:tool-input-delta', {
        toolId: event.toolUseId,
        delta: event.delta,
      });
      resetWatchdog();  // Tool streaming is activity — prevent killing long-running tools
      break;
    }

    case 'tool_use_stop': {
      // Finalize tool use block from accumulated input
      const entry = pendingToolInputs.get(event.toolUseId);
      if (entry) {
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
        currentContentBlocks.push({
          type: 'tool_use',
          tool: {
            id: event.toolUseId,
            name: entry.name,
            input: parsedInput,
            inputJson: entry.inputJson,
            streamIndex: currentContentBlocks.length,
          },
        });
        pendingToolInputs.delete(event.toolUseId);
      }
      broadcast('chat:content-block-stop', {
        type: 'tool_use',
        toolId: event.toolUseId,
      });
      break;
    }

    case 'tool_result_delta':
      broadcast('chat:tool-result-delta', {
        toolUseId: event.toolUseId,
        delta: event.delta,
      });
      resetWatchdog();
      break;

    case 'tool_result':
      // Update the matching tool_use block's result + attachments (PRD 0.2.15)
      for (let i = currentContentBlocks.length - 1; i >= 0; i--) {
        if (currentContentBlocks[i].type === 'tool_use' && currentContentBlocks[i].tool?.id === event.toolUseId) {
          currentContentBlocks[i].tool!.result = event.content;
          currentContentBlocks[i].tool!.isError = event.isError ?? false;
          currentContentBlocks[i].tool!.resultMeta = event.metadata;
          if (event.attachments && event.attachments.length > 0) {
            currentContentBlocks[i].tool!.attachments = event.attachments;
          }
          break;
        }
      }
      broadcast('chat:tool-result-start', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError ?? false,
        metadata: event.metadata,
        attachments: event.attachments,
      });
      // Emit complete immediately — external runtimes deliver tool results as a single event
      // (no streaming delta). Frontend needs this to clear tool loading spinner + trigger file refresh.
      broadcast('chat:tool-result-complete', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError ?? false,
        metadata: event.metadata,
        attachments: event.attachments,
      });
      resetWatchdog();
      break;

    case 'tool_attachment_update': {
      // Async fulfillment of a placeholder attachment (PRD 0.2.15 §4.7.1).
      // Find the persisted tool block and replace the matching placeholder in-place,
      // then broadcast the same shape so the frontend can patch the rendered gallery.
      for (let i = currentContentBlocks.length - 1; i >= 0; i--) {
        const block = currentContentBlocks[i];
        if (block.type === 'tool_use' && block.tool?.id === event.toolUseId && block.tool.attachments) {
          const idx = block.tool.attachments.findIndex(a => a.pendingId === event.pendingId);
          if (idx >= 0) {
            block.tool.attachments[idx] = event.attachment;
          }
          break;
        }
      }
      broadcast('chat:tool-attachment-update', {
        toolUseId: event.toolUseId,
        pendingId: event.pendingId,
        attachment: event.attachment,
      });
      resetWatchdog();
      break;
    }

    case 'permission_request':
      // AskUserQuestion carries a structured payload (questions/options/previews) and
      // needs the dedicated wizard UI, not the generic allow/deny card. Route it through
      // the ask-user-question:request channel so the frontend mounts AskUserQuestionPrompt
      // and the user's answers flow back as CC `updatedInput.answers`.
      if (event.toolName === 'AskUserQuestion' && isAskUserQuestionInput(event.input)) {
        pendingExternalAskUserQuestions.set(event.requestId, { input: event.input as Record<string, unknown> });
        const questions = event.input.questions;
        const previewFormat: 'html' | 'markdown' = 'html';
        pendingExternalInteractiveRequests.set(event.requestId, {
          type: 'ask-user-question:request',
          data: { requestId: event.requestId, questions, previewFormat },
        });
        broadcast('ask-user-question:request', {
          requestId: event.requestId,
          questions,
          previewFormat,
        });
        // IM/agent-channel bots can't render AskUserQuestion; claude-code.ts already
        // puts it in --disallowed-tools for those scenarios, so no imEventBus fan-out here.
        break;
      }

      // Store suggestions so respondExternalPermission can echo them back for "always_allow"
      pendingPermissionSuggestions.set(event.requestId, event.suggestions);
      pendingExternalInteractiveRequests.set(event.requestId, {
        type: 'permission:request',
        data: {
          requestId: event.requestId,
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          input: typeof event.input === 'object' ? JSON.stringify(event.input).slice(0, 500) : String(event.input ?? '').slice(0, 500),
        },
      });
      broadcast('permission:request', {
        requestId: event.requestId,
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: typeof event.input === 'object' ? JSON.stringify(event.input).slice(0, 500) : String(event.input ?? '').slice(0, 500),
      });
      fireImCallback('permission-request', JSON.stringify({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
      }));
      break;

    case 'session_init': {
      // Capture runtime's session ID for multi-turn resume
      // CC: session_id from hook; Codex: threadId from thread/start response; Gemini: from session/new
      if (event.sessionId) {
        lastRuntimeSessionId = event.sessionId;
        // Persist to SessionMetadata for cross-restart resume.
        // During pre-warm, metadata may not exist yet (registerSessionMetadataIfNew
        // runs on first user message, not on pre-warm). Attempt update; if metadata
        // doesn't exist yet, store the ID in-memory — it will be persisted when
        // registerSessionMetadataIfNew runs and then updateSessionMetadata succeeds
        // on the next session_init or turn_complete.
        if (lastSessionId && event.sessionId !== lastSessionId) {
          // Eagerly schedule the deferred patch with session affinity. If
          // updateSessionMetadata succeeds (metadata already exists), clear it.
          // If metadata doesn't exist yet (pre-warm path), the deferred entry
          // will be consumed later by registerSessionMetadataIfNew.
          // handleUnifiedEvent is a sync stream callback — fire-and-forget the
          // async lock-protected write.
          const targetSessionId = lastSessionId;
          const targetRuntimeId = event.sessionId;
          deferredRuntimeSessionId = { forSessionId: targetSessionId, runtimeSessionId: targetRuntimeId };
          void updateSessionMetadata(targetSessionId, { runtimeSessionId: targetRuntimeId })
            .then((updated) => {
              if (updated && deferredRuntimeSessionId?.forSessionId === targetSessionId
                  && deferredRuntimeSessionId.runtimeSessionId === targetRuntimeId) {
                // Metadata existed — persist succeeded; drop the deferred slot.
                deferredRuntimeSessionId = null;
              }
            })
            .catch((err) => console.warn('[external-session] runtimeSessionId persist failed:', err));
        }
      }
      const info: SystemInitInfo = {
        timestamp: new Date().toISOString(),
        session_id: event.sessionId,
        model: event.model,
        tools: event.tools,
      };
      if (event.model) {
        lastRuntimeReportedModel = event.model;
      }
      // Match builtin broadcast shape: { info: {...}, sessionId } — top-level sessionId
      // is read by frontend for session ID sync (TabProvider).
      // `prewarm` distinguishes a cold-start session_init (fired before any user
      // turn) from one triggered by the user's first message. The frontend uses
      // it to decide whether to flip isLoading:true — a pre-warmed process is
      // alive but idle, and stamping loading state on it would leave the UI
      // stuck showing a spinner until the user finally sends something.
      externalSystemInitPayload = {
        info: {
          ...info,
        },
        sessionId: lastSessionId,
        prewarm: isPrewarmingSession || undefined,
        // Authoritative runtime tag — the spawning runtime is the one running this
        // process, regardless of any later agent.runtime drift. Frontend uses this
        // to freeze sessionRuntime at session-creation time so the bottom-bar
        // display stays consistent with how messages actually route.
        runtime: getCurrentRuntimeType(),
      };
      broadcast('chat:system-init', externalSystemInitPayload);
      break;
    }

    case 'model_update':
      if (event.model) {
        lastRuntimeReportedModel = event.model;
        if (currentTurnUsage) {
          currentTurnUsage.model = event.model;
        }
      }
      break;

    case 'runtime_diagnostics': {
      // Issue #194: runtime's self-report (auth, features, MCP, apps, effective env).
      // Sidecar log keeps a snapshot for unified-log triage; renderer renders the
      // diagnostic strip / details panel.
      console.log(`[external-session] runtime_diagnostics: runtime=${event.diagnostics.runtime} features=${event.diagnostics.features?.length ?? 0} mcp=${event.diagnostics.mcpServers?.length ?? 0} apps=${event.diagnostics.apps?.length ?? 0} auth=${event.diagnostics.auth?.authMethod ?? 'none'}`);
      broadcast('chat:runtime-diagnostics', event.diagnostics);

      // Banner v2 only renders BLOCKING issues (auth.requiresLogin + total
      // RPC failure). Non-blocking signals — app/list 403, individual MCP
      // server failure, feature-flag query error — used to show up in the
      // yellow banner too; users (rightly) complained about chronic noise
      // from transient Codex backend hiccups. Route them through chat:log
      // instead so the Logs panel shows them but the chat header stays
      // clean. Sidecar console / unified log still has the full snapshot.
      const d = event.diagnostics;
      const emitDiagnosticLog = (level: 'warn' | 'error', message: string): void => {
        broadcast('chat:log', {
          source: 'bun',
          level,
          message,
          timestamp: new Date().toISOString(),
          runtime: getCurrentRuntimeType(),
        });
      };
      const errOf = (s: typeof d.status.auth): string | null =>
        s && typeof s === 'object' && 'error' in s ? String(s.error) : null;
      const authErr = errOf(d.status.auth);
      const appsErr = errOf(d.status.apps);
      const mcpErr = errOf(d.status.mcpServers);
      const featErr = errOf(d.status.features);
      // `error` for ones the banner would have considered "warn-tier" in v1;
      // `warn` for purely informational. Severity here drives Logs panel
      // sort/filter — it isn't what makes the banner appear.
      if (authErr) emitDiagnosticLog('error', `[codex-diag] auth status query failed: ${authErr.slice(0, 200)}`);
      if (appsErr) emitDiagnosticLog('warn', `[codex-diag] app/list failed: ${appsErr.slice(0, 200)}`);
      if (mcpErr) emitDiagnosticLog('warn', `[codex-diag] mcpServerStatus/list failed: ${mcpErr.slice(0, 200)}`);
      if (featErr) emitDiagnosticLog('warn', `[codex-diag] experimentalFeature/list failed: ${featErr.slice(0, 200)}`);
      if (d.apps) {
        const inaccessible = d.apps.filter(a => a.isEnabled && !a.isAccessible);
        if (inaccessible.length > 0) {
          emitDiagnosticLog(
            'warn',
            `[codex-diag] ${inaccessible.length} app(s) enabled but not accessible: ${inaccessible.map(a => a.id).slice(0, 5).join(', ')}`,
          );
        }
      }
      if (d.mcpServers) {
        const failed = d.mcpServers.filter(s => s.state === 'failed');
        if (failed.length > 0) {
          emitDiagnosticLog(
            'warn',
            `[codex-diag] MCP server(s) in failed state: ${failed.map(s => s.name).join(', ')}`,
          );
        }
      }
      break;
    }

    case 'status_change': {
      // Map runtime states to frontend session states (match builtin runtime behavior)
      const stateMap: Record<string, string> = { running: 'running', error: 'error', waiting_permission: 'running' };
      setExternalSessionState((stateMap[event.state ?? ''] ?? 'idle') as ExternalSessionState);
      break;
    }

    case 'turn_complete': {
      // Mark turn complete — session_complete will follow for CC -p mode
      turnCompleted = true;
      lastTurnSucceeded = true;
      clearWatchdog();
      console.log(`[external-session] turn_complete: text=${currentAssistantText.length}chars, blocks=${currentContentBlocks.length}, elapsed=${currentTurnStartTime ? Date.now() - currentTurnStartTime : 0}ms`);
      // Fire-and-forget: handleUnifiedEvent is a sync stream callback; persistTurnResult is async.
      void persistTurnResult().catch((err) => console.error('[external-session] persistTurnResult (turn_complete) failed:', err));
      break;
    }

    case 'session_complete': {
      clearWatchdog();
      console.log(`[external-session] session_complete: subtype=${event.subtype}, result=${(event.result || '').length > 0 ? `${(event.result || '').length}chars` : 'empty'}, turnCompleted=${turnCompleted}, assistantText=${currentAssistantText.length}chars`);
      // Track whether persistTurnResult is in-flight (or was already fired by
      // turn_complete). When true, persistTurnResult will broadcast
      // chat:message-complete + setExternalSessionState('idle') itself, in
      // that order. We MUST NOT fire idle synchronously below, because
      // persistTurnResult is async (awaits disk writes) and the synchronous
      // idle would race ahead of message-complete on the SSE wire — the
      // renderer's chat:status idle handler clears isStreamingRef, and the
      // subsequent flushPendingChunks at message-complete bails its updater,
      // dropping every chunk that hadn't yet RAF-flushed. v0.2.14 cross-bugfix.
      //
      // Initialize from `turnCompleted`: turn_complete handler already fires
      // persistTurnResult fire-and-forget (Codex/Gemini path), so it's in-flight
      // regardless of whether this session_complete carries success or error
      // subtype. Set this BEFORE the if/else so the error branch also honours
      // the in-flight contract.
      let persistInFlight = turnCompleted;
      // Pre-warm exit: process died after spawn but before any user turn
      // started. `currentTurnStartTime === 0` distinguishes this from a
      // mid-turn exit (which sets the timestamp at turn kickoff). Applies to
      // BOTH subtypes:
      //   - subtype='error' (SIGKILL / init timeout) → silent retry on send
      //   - subtype='success' (graceful exit code 0 during our timeout kill)
      //     → would otherwise fall through to persistTurnResult and broadcast
      //     chat:message-complete — triggering a misleading "任务完成" OS
      //     notification on an empty tab that never ran a turn.
      const isPrewarmExit = !turnCompleted && currentTurnStartTime === 0;
      if (isPrewarmExit) {
        console.log(`[external-session] Ignoring pre-warm exit (subtype=${event.subtype}) — no user turn was in flight; next send will start fresh`);
      } else if (event.subtype === 'success') {
        // CC slash commands (e.g. /context, /cost) return output directly in `result`
        // without streaming text_delta events. Only broadcast if NO turn completed
        // (turnCompleted means text was already streamed + persisted normally).
        if (event.result && !turnCompleted && !currentAssistantText.trim()) {
          broadcast('chat:message-chunk', event.result);
          currentAssistantText += event.result;
          pendingTextBuffer += event.result;
        }
        // Only finalize if turn_complete didn't already (Codex emits turn_complete; CC uses session_complete only)
        if (!turnCompleted) {
          lastTurnSucceeded = true;
          // Fire-and-forget: handleUnifiedEvent is a sync stream callback; persistTurnResult is async.
          void persistTurnResult().catch((err) => console.error('[external-session] persistTurnResult (session_complete) failed:', err));
          persistInFlight = true;
        }
        // else: turn_complete already fired persistTurnResult — persistInFlight
        // was already set true above by the `let persistInFlight = turnCompleted`
        // initializer. The async broadcast it emits after chat:message-complete
        // is the authoritative idle.
      } else {
        const errorMessage = event.result || 'Session ended with error';
        // Suppress user-visible error when the external runtime's persistent process
        // dies while idle (after a turn already completed, with no new turn in flight).
        // Common cause: OS memory pressure / SIGKILL (exit 137) after tens of minutes
        // of inactivity on Codex/Gemini. The next sendExternalMessage will hit the
        // "Previous process exited, resuming" branch and transparently spawn a fresh
        // process — the user never needed to see an error in the first place.
        //
        // Repro: user reported "Gemini process exited with code 137" toast after
        // leaving a session idle for 26 minutes with no interaction. See
        // ~/Downloads/myagents-logs-2026-04-14T17-28-53.txt final session_complete line.
        const isIdleExit = turnCompleted && !currentAssistantText.trim();
        if (isIdleExit) {
          console.log(`[external-session] Ignoring idle-exit "${errorMessage}" — process was between turns; next message will auto-resume`);
        } else {
          broadcast('chat:agent-error', { message: errorMessage });
          broadcast('chat:message-error', errorMessage);
          fireImCallback('error', errorMessage);
          resetTurnAccumulators(); // Prevent stale content leaking into next turn
        }
      }
      pendingPermissionSuggestions.clear();
      drainPendingInteractiveRequestsAsExpired('error');  // PRD #131 — runtime crash/watchdog kill: clear stale modals
      pendingExternalAskUserQuestions.clear();
      pendingExternalInteractiveRequests.clear();
      externalSystemInitPayload = null;
      // Only set idle synchronously when persistTurnResult is NOT going to
      // do it itself. Otherwise we'd race chat:status idle ahead of
      // chat:message-complete (see persistInFlight comment above).
      if (!persistInFlight) {
        setExternalSessionState('idle');
      }
      // Clean up module state — prevents stuck sessions on CC crash
      isRunning = false;
      activeProcess = null;
      activeRuntime = null;
      break;
    }

    case 'usage':
      // Store latest token usage.
      // Codex emits running totals, while other runtimes may emit per-turn deltas.
      currentTurnUsage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        model: event.model || currentTurnUsage?.model || lastRuntimeReportedModel || undefined,
        modelUsage: event.modelUsage,
        semantics: event.semantics,
      };
      break;

    case 'log':
      if (event.level === 'error') {
        console.error(`[external-runtime] ${event.message}`);
      } else if (event.level === 'warn') {
        console.warn(`[external-runtime] ${event.message}`);
      } else {
        console.log(`[external-runtime] ${event.message}`);
      }
      // Issue #194: surface warn/error to the renderer so the user sees them
      // in the chat log panel rather than only the unified log. Info-level is
      // log-only — it's high-volume runtime noise (turn/tool lifecycle).
      // Shape MUST match LogEntry (src/renderer/types/log.ts) — the renderer's
      // `chat:log` handler discriminates on `source in data` and drops anything
      // without it. `source: 'bun'` is correct: the sidecar is the writer.
      if (event.level === 'warn' || event.level === 'error') {
        broadcast('chat:log', {
          source: 'bun',
          level: event.level,
          message: event.message,
          timestamp: new Date().toISOString(),
          runtime: getCurrentRuntimeType(),
        });
      }
      break;

    case 'message_replay': {
      // CC's --include-partial-messages outputs complete message objects alongside streaming.
      // Three categories:
      //   1. role=assistant — partial snapshots (SKIP: stream_event deltas already delivered content)
      //   2. role=user, content=string — real user message echo (SKIP if duplicate, REPLAY for resume)
      //   3. role=user, content=array — CC tool_result containers (SKIP as user msg, EXTRACT tool results)
      const replayRole = event.message.role;
      const replayContent = event.message.content;

      if (replayRole === 'user' && Array.isArray(replayContent)) {
        // CC sends tool results as type='user' messages with content=[{type:'tool_result',...}].
        // Don't broadcast as user message (creates ghost empty bubbles).
        // Instead, extract tool_result blocks and emit proper tool-result-complete events
        // so the frontend can close tool loading indicators.
        for (const block of replayContent as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<Record<string, unknown>>).map(b => (b.text as string) || '').join('\n')
                : (block.content != null ? JSON.stringify(block.content) : '');
            broadcast('chat:tool-result-complete', {
              toolUseId: block.tool_use_id,
              content: resultText.slice(0, 2000),  // Truncate for SSE
              isError: block.is_error === true,
            });
            // Update the already-persisted tool_use block with its result.
            // tool_use_stop already consumed pendingToolInputs and pushed to currentContentBlocks,
            // so we find the existing block and add the result (same pattern as tool_result handler).
            const toolBlockIdx = currentContentBlocks.findIndex(
              b => b.type === 'tool_use' && b.tool?.id === block.tool_use_id
            );
            if (toolBlockIdx >= 0 && currentContentBlocks[toolBlockIdx].tool) {
              currentContentBlocks[toolBlockIdx].tool!.result = resultText.slice(0, 5000);
              currentContentBlocks[toolBlockIdx].tool!.isError = block.is_error === true;
            }
            resetWatchdog();
          }
        }
        break;
      }

      if (replayRole === 'user') {
        // Real user message replay (for session resume scenarios).
        // Skip during active streaming — we already broadcast user message from sendExternalMessage.
        if (isRunning && allSessionMessages.length > 0) {
          break;
        }
        // Ensure timestamp exists for frontend rendering
        const replayMsg = event.message.timestamp
          ? event.message
          : { ...event.message, timestamp: new Date().toISOString() };
        broadcast('chat:message-replay', { message: replayMsg });
      }
      // Assistant replay: normally dropped because stream_event deltas already delivered
      // the content. But if stream deltas were missing (short response, rate limiting,
      // API truncation), the replay is the only source of truth. Use it as fallback.
      if (replayRole === 'assistant' && !currentAssistantText.trim()) {
        const content = replayContent;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = (content as Array<Record<string, unknown>>)
            .filter(b => b.type === 'text')
            .map(b => (b.text as string) || '')
            .join('');
        }
        if (text.trim()) {
          console.log(`[external-session] Assistant message_replay fallback: stream had no text, using replay (${text.length} chars)`);
          broadcast('chat:message-chunk', text);
          currentAssistantText += text;
          pendingTextBuffer += text;
          resetWatchdog();
        }
      }
      break;
    }

    case 'raw':
      // Unrecognized event — ignore
      break;
  }
}
