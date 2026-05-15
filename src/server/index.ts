import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync , rmSync, renameSync } from 'fs';
import { copyFile as copyFileAsync, readdir as readdirAsync, rm, stat } from 'fs/promises';
import { spawn as subprocessSpawn } from './utils/subprocess';
import { fileResponse, sniffMime } from './utils/file-response';
import { lookupExternalAttachment } from './runtimes/tool-attachments';
import { getToolAttachmentRoot, validateExternalReadPathNode } from './utils/path-safety';
import { serve as honoServe } from '@hono/node-server';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Hard upper bound on a single multipart request body (aggregate of all files
 * + text fields). Sidecar lives on 127.0.0.1 so the threat model is mostly
 * local WebView / same-machine callers, but we still gate to prevent runaway
 * uploads from OOM-ing the Node.js heap. Node's standard `Request.formData()`
 * buffers the entire body before resolving — there is no streaming multipart
 * parser in the Web API — so this cap must be enforced via Content-Length
 * BEFORE calling `.formData()`.
 */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Check request Content-Length against MAX_UPLOAD_BYTES.
 * Returns a 413 Response to hand back, or null when within budget.
 * Missing Content-Length is treated as unknown — we still allow `.formData()`
 * to run, but callers should prefer Content-Length-aware clients.
 */
function rejectIfOversizedUpload(request: Request): Response | null {
  const lenHeader = request.headers.get('content-length');
  if (!lenHeader) return null;
  const len = Number(lenHeader);
  if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
    return jsonResponse(
      { error: `Upload too large (${len} bytes > ${MAX_UPLOAD_BYTES} limit).` },
      413,
    );
  }
  return null;
}

/**
 * Write an incoming Web `File` (multipart upload) to disk via streaming.
 *
 * NOTE: Node's `Request.formData()` already buffers the full body before
 * resolving the FormData — `file.stream()` here is reading from an
 * in-memory Blob, not from the live socket. The pipeline-to-disk still
 * helps by avoiding an extra `arrayBuffer() + Buffer.from()` copy, but
 * it does NOT bound memory during the parse itself. That bound is
 * enforced by `rejectIfOversizedUpload()` at the route edge.
 *
 * On error mid-pipeline, the partially-written destination is removed so
 * callers don't observe half-files on disk.
 */
async function streamUploadToFile(file: File, destination: string): Promise<void> {
  const webStream = file.stream() as unknown as ReadableStream<Uint8Array>;
  const nodeReadable = Readable.fromWeb(webStream as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
  try {
    await pipeline(nodeReadable, createWriteStream(destination));
  } catch (err) {
    await rm(destination, { force: true }).catch(() => { /* best-effort cleanup */ });
    throw err;
  }
}
import { basename, dirname, isAbsolute, join, relative, resolve, extname, sep } from 'path';
import { tmpdir, homedir } from 'os';
import { randomUUID } from 'crypto';
// adm-zip lazy-loaded at its one call site below (/api/skill/upload with zip
// content) — saves ~30ms of module-init cost when users never upload skills.
import {
  parseSkillFrontmatter,
  extractCommandName,
  parseFullSkillContent,
  parseFullCommandContent,
  serializeSkillContent,
  serializeCommandContent,
  type SkillFrontmatter,
  type CommandFrontmatter
} from '../shared/slashCommands';
import { sanitizeFolderName, isWindowsReservedName } from '../shared/utils';
import { resolveSkillUrl } from './skills/url-resolver';
import { fetchSkillZip, TarballFetchError } from './skills/tarball-fetcher';
import { analyseTree, buildInstallPayload, writeSkillFiles, type SkillCandidate } from './skills/installer';
import type { SessionSource } from './types/session';
import { parseAgentFrontmatter, parseFullAgentContent, serializeAgentContent } from '../shared/agentCommands';
import { scanAgents, readWorkspaceConfig, writeWorkspaceConfig, loadEnabledAgents, readAgentMeta, writeAgentMeta, findAgent } from './agents/agent-loader';
import type { AgentFrontmatter, AgentMeta, AgentWorkspaceConfig } from '../shared/agentTypes';
import type { McpServerDefinition } from '../shared/config-types';
import { ensureDirSync, ensureDir, isDirEntry } from './utils/fs-utils';
import {
  setCronTaskContext,
  clearCronTaskContext,
  CRON_TASK_COMPLETE_PATTERN,
  CRON_TASK_EXIT_TEXT,
  CRON_TASK_EXIT_REASON_PATTERN,
} from './tools/cron-tools';
import { setImCronContext } from './tools/im-cron-tool';
// admin-api module (~2900 lines, depends on zod + full config/session/cron surface)
// is lazy-loaded on first /api/admin/* hit to shave ~150ms off sidecar cold
// start. All handlers are only used inside routeAdminApi() below.
type AdminApiModule = typeof import('./admin-api');
let _adminApi: Promise<AdminApiModule> | null = null;
const getAdminApi = (): Promise<AdminApiModule> => (_adminApi ??= import('./admin-api'));
import { setImMediaContext } from './tools/im-media-tool';
import { setImBridgeToolsContext } from './tools/im-bridge-tools';
import { getBuiltinMcpInstance } from './tools/builtin-mcp-registry';
// NOTE: builtin MCP META is auto-registered when agent-session.ts side-effect-imports
// './tools/builtin-mcp-meta'. No duplicate import needed here.

// ============= CRASH DIAGNOSTICS =============
// Pattern 6 §6.3.6: crash logs live under ~/.myagents/logs/crash/ (NOT tmpdir,
// so they're inside the unified log export bundle). Each crash gets its own
// file; we keep the most recent CRASH_LOG_MAX_FILES and evict oldest.
const CRASH_LOG_DIR = join(homedir(), '.myagents', 'logs', 'crash');
const CRASH_LOG_MAX_FILES = 20;
// PRD #132 — hard cap on a single crash log file. The bug was: a recursive
// EPIPE loop appended ~50–200 KB per iteration and grew a single file to
// 95–105 GB. The recursion is fixed below by ignoring stdio EPIPE + a re-
// entry guard, but a hard ceiling stays as belt-and-suspenders so any
// future regression can't fill the user's disk again. 50 MB matches the
// per-file cap used by UnifiedLogger.
const CRASH_LOG_FILE_MAX_BYTES = 50 * 1024 * 1024;
// PRD #133 — total-bytes cap on the crash directory. CRASH_LOG_MAX_FILES
// alone bounds at file COUNT (~20 × 50 MB = 1 GB worst case); a user that
// hits 20 different short-lived sidecar crashes still loses 1 GB. 200 MB
// matches an order-of-magnitude budget for crash diagnostics across many
// process lifetimes.
const CRASH_LOG_DIR_MAX_BYTES = 200 * 1024 * 1024;
// PRD #133 — repeat-exception throttle. The first N times an error
// fingerprint (name + code + first stack line) appears in the rolling
// window, the full 200-line context dump goes through. After that we
// suppress the dump for the rest of the window — the per-file ceiling
// would also stop us eventually, but this preserves the ceiling budget
// for diverse errors that might actually help debug instead of burning
// it on 1000 copies of the same trace.
const CRASH_DEDUPE_WINDOW_MS = 60_000;
const CRASH_DEDUPE_DUMP_LIMIT = 3;
// Per-process crash log path: a single file per sidecar lifetime, holding all
// the lifecycle/error events for THIS process. The filename uses the start
// time so we can sort/evict by name. We append throughout the process.
const CRASH_LOG_FILE = (() => {
  try {
    if (!existsSync(CRASH_LOG_DIR)) {
      // Best-effort directory creation. recursive:true handles parent dirs.
      // Don't reach for ensureDirSync — this IIFE runs during module init
      // before some helper's transitive deps are guaranteed warm.
      mkdirSync(CRASH_LOG_DIR, { recursive: true });
    }
  } catch { /* fall through; later writes will retry */ }
  const ts = new Date().toISOString().replace(/[:]/g, '-');
  return join(CRASH_LOG_DIR, `${ts}.log`);
})();

// PRD #132 — ceiling tracker. We checkpoint file size every Nth append (not
// every append) so the ceiling check itself is cheap: an `appendFileSync`
// that already grew the file by 200 KB is fine, the *next* one will be
// blocked. ceilingHit is sticky for this process lifetime — once tripped we
// stop appending entirely so the file stays at its current size.
let crashLogCeilingHit = false;
let crashLogAppendCount = 0;

function evictOldCrashLogs(): void {
  try {
    if (!existsSync(CRASH_LOG_DIR)) return;
    const entries = readdirSync(CRASH_LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const p = join(CRASH_LOG_DIR, f);
        try {
          const st = statSync(p);
          return { path: p, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; mtimeMs: number; size: number } => x !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    // Pass 1: file-count cap (PRD #132).
    for (const e of entries.slice(CRASH_LOG_MAX_FILES)) {
      try { unlinkSync(e.path); } catch { /* ignore */ }
    }

    // Pass 2: total-bytes cap (PRD #133). Walk newest→oldest summing sizes
    // until budget exceeded, then unlink the rest. Always keep the very
    // newest file (this process's own active crash log) so we don't kill
    // what we're still appending to.
    const survivors = entries.slice(0, CRASH_LOG_MAX_FILES);
    let runningTotal = 0;
    for (let i = 0; i < survivors.length; i++) {
      runningTotal += survivors[i].size;
      if (i > 0 && runningTotal > CRASH_LOG_DIR_MAX_BYTES) {
        // Drop everything from i onwards (oldest). Skip i=0 to protect the
        // active file even if it alone is over budget — the per-file
        // ceiling already caps that case at 50 MB.
        for (let j = i; j < survivors.length; j++) {
          try { unlinkSync(survivors[j].path); } catch { /* ignore */ }
        }
        break;
      }
    }
  } catch { /* ignore */ }
}

// PRD #133 — exception fingerprint table. Map<fingerprint, state>. We only
// use it for `dumpCrashContext` gating; the 1-line `crashLog` is cheap and
// doesn't need throttling beyond the ceiling.
const dumpFingerprints = new Map<string, { count: number; firstSeen: number; suppressed: boolean }>();

function fingerprintError(err: unknown): string {
  if (!err) return 'null';
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    const stackHead = (err.stack ?? err.message ?? '').split('\n').slice(0, 2).join('|').slice(0, 200);
    return `${err.name}:${code}:${stackHead}`;
  }
  return String(err).slice(0, 200);
}

/** PRD #133 — should we run the 200-line context dump for this error?
 *  False once we've dumped ≥ N times for the same fingerprint within the
 *  rolling window. Independent counter per fingerprint; window resets on
 *  first sighting OR after expiry. */
function shouldDumpContextFor(err: unknown): boolean {
  const fp = fingerprintError(err);
  const now = Date.now();
  // Cheap GC: when the table grows beyond a sane size, drop expired entries.
  if (dumpFingerprints.size > 50) {
    for (const [k, v] of dumpFingerprints) {
      if (now - v.firstSeen > CRASH_DEDUPE_WINDOW_MS) dumpFingerprints.delete(k);
    }
  }
  const entry = dumpFingerprints.get(fp);
  if (!entry || (now - entry.firstSeen) > CRASH_DEDUPE_WINDOW_MS) {
    dumpFingerprints.set(fp, { count: 1, firstSeen: now, suppressed: false });
    return true;
  }
  entry.count++;
  if (entry.count <= CRASH_DEDUPE_DUMP_LIMIT) return true;
  if (!entry.suppressed) {
    entry.suppressed = true;
    // One-shot transition log so a future post-mortem sees the dedup kicked in.
    appendFileSyncSafely(`[${new Date().toISOString()}] SUPPRESS_CONTEXT fingerprint=${fp.slice(0, 100)} count=${entry.count} — further dumps for this fingerprint suppressed for the next ${CRASH_DEDUPE_WINDOW_MS / 1000}s\n`);
  }
  return false;
}

/** Internal helper: append a single line to the crash log file with the
 *  same ceiling discipline as `crashLog()`, without going through its
 *  arg-formatting path. Used by helpers that already have a formatted
 *  string to avoid re-shaping. */
function appendFileSyncSafely(line: string): void {
  if (crashLogCeilingHit) return;
  try { appendFileSync(CRASH_LOG_FILE, line); } catch { /* ignore */ }
}

/** PRD #132 + #133 — re-stat current crash file and trip the ceiling +
 *  evict if either single-file or directory budget is exceeded. Called
 *  after any append by `crashLog`/`dumpCrashContext` rather than left
 *  to `dumpCrashContext` alone (which the original code did, leaving
 *  `crashLog`-only sidecar lifecycles uncapped per Codex review). */
function checkCrashLogBudgets(): void {
  if (crashLogCeilingHit) return;
  try {
    const sz = statSync(CRASH_LOG_FILE).size;
    if (sz > CRASH_LOG_FILE_MAX_BYTES) {
      crashLogCeilingHit = true;
      try {
        appendFileSync(
          CRASH_LOG_FILE,
          `[${new Date().toISOString()}] CEILING_HIT crash log capped at ${CRASH_LOG_FILE_MAX_BYTES} bytes; further events suppressed for this sidecar lifetime\n`,
        );
      } catch { /* ignore */ }
    }
  } catch { /* stat failed — keep going */ }
  // Always run directory eviction, even when single file is under cap —
  // multi-process crash bursts could violate the dir budget independently.
  evictOldCrashLogs();
}

function crashLog(prefix: string, ...args: unknown[]) {
  if (crashLogCeilingHit) return;
  try {
    const msg = args.map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'object') return JSON.stringify(a);
      return String(a);
    }).join(' ');
    appendFileSync(CRASH_LOG_FILE, `[${new Date().toISOString()}] ${prefix} ${msg}\n`);
    // Budget check every 32 appends (cheap, but frequent enough that an
    // append that overshoots by a few KB is bounded). PRD #133 — also
    // run this for crashLog-only call paths (STDIO_CLOSED, EXIT,
    // BEFORE_EXIT, SIGTERM, EPIPE fast-path); previously these bypassed
    // eviction entirely because evictOldCrashLogs was only called from
    // dumpCrashContext, leaving short-lived sidecars to accumulate
    // unlimited .log files.
    if ((++crashLogAppendCount & 0x1f) === 0) {
      checkCrashLogBudgets();
    }
  } catch { /* ignore */ }
}

/**
 * On a hard crash (uncaughtException / unhandledRejection / fatal signal),
 * snapshot the last ~200 unified log lines into the crash file so post-mortem
 * has cross-process context, not just the bare error.
 *
 * PRD #133 — guarded by `shouldDumpContextFor(err)` so a recurring non-EPIPE
 * exception (e.g. a runtime/model misconfiguration that keeps re-throwing
 * the same error) doesn't burn the entire 50 MB single-file budget on 200
 * copies of the same trace. After writing, re-stat to trip the ceiling
 * immediately if a single oversized dump pushed us over (a 200-line sample
 * with rare jumbo log lines can be 10s of MB).
 */
function dumpCrashContext(reason: string, errForFingerprint?: unknown): void {
  if (crashLogCeilingHit) return;
  if (errForFingerprint !== undefined && !shouldDumpContextFor(errForFingerprint)) return;
  try {
    const lines = getRecentLogLines(200);
    if (lines.length === 0) return;
    const banner = `\n--- crash context (${reason}, last ${lines.length} unified lines) ---\n`;
    appendFileSync(CRASH_LOG_FILE, banner + lines.join('') + '--- end crash context ---\n');
    // Re-check budgets immediately after dump — a single jumbo dump can
    // shoot past the per-file ceiling on its own and would otherwise wait
    // for the next 32-append crashLog window to notice.
    checkCrashLogBudgets();
  } catch { /* ignore */ }
}

// Top-level beacon: fires BEFORE main(), proves JS module loading succeeded
try { process.stderr.write(`[startup] module loaded, pid=${process.pid}\n`); } catch { /* ignore */ }

// PRD #132 — silence stdio EPIPE before it can become an uncaughtException.
//
// When Tauri kills the sidecar's stdout/stderr pipe but the sidecar keeps
// running (orphaned via SIGKILL of parent, helper sidecar outliving owner,
// dev-server reload not killing children cleanly), the next write fails
// with EPIPE. Without an 'error' listener Node turns the unhandled stream
// error into uncaughtException, which our handler responded to by calling
// console.error → another EPIPE → another uncaughtException → a recursive
// loop that wrote 50–200 KB to the crash log per iteration at SSD-bound
// rate, growing a single file to 95–105 GB in minutes (issue #132).
//
// Installing 'error' listeners that swallow EPIPE/EBADF/ENOTCONN cuts the
// loop at the source: the failed write resolves to a no-op instead of
// fanning out into the fault handler. Other stdio errors keep their
// existing behavior so we still notice non-pipe-closure faults. Once the
// stdio sink is broken we mark `stdioBroken` and the wrapper console below
// stops attempting to write to it — defense in depth against any code path
// that bypasses our listener.
let stdioBroken = false;
const STDIO_BENIGN_CLOSE_CODES = new Set(['EPIPE', 'EBADF', 'ENOTCONN', 'ECONNRESET']);
function onStdioError(stream: 'stdout' | 'stderr') {
  return (err: NodeJS.ErrnoException) => {
    if (STDIO_BENIGN_CLOSE_CODES.has(err.code ?? '')) {
      if (!stdioBroken) {
        stdioBroken = true;
        // Best-effort note in crash log; this MUST NOT call console.* (which
        // would re-enter the same broken pipe and re-trigger the loop).
        try {
          crashLog('STDIO_CLOSED', `${stream} ${err.code ?? 'unknown'} — disabling future stdio writes for this sidecar`);
        } catch { /* ignore */ }
      }
      return; // swallow
    }
    // Non-pipe-closure error — record once, do not propagate.
    try { crashLog('STDIO_ERROR', `${stream} ${err.code ?? ''} ${err.message ?? ''}`); } catch { /* ignore */ }
  };
}
try { process.stdout.on('error', onStdioError('stdout')); } catch { /* ignore */ }
try { process.stderr.on('error', onStdioError('stderr')); } catch { /* ignore */ }
export function isStdioBroken(): boolean { return stdioBroken; }
export function markStdioBroken(): void { stdioBroken = true; }

process.on('exit', (code) => {
  crashLog('EXIT', `code=${code}`);
});

process.on('beforeExit', (code) => {
  crashLog('BEFORE_EXIT', `code=${code}`);
});

// PRD #132 — uncaughtException re-entry guard + EPIPE-aware short circuit.
//
// Even with the stdio listeners above, an in-flight async write may still
// emit an EPIPE that becomes uncaughtException (timing window between the
// write call and the listener being invoked). Two defenses:
//   1. Re-entry guard: if the handler is already running (sync or
//      promise-resumed), drop subsequent fires until it returns. Prevents
//      a deep stack of nested handlers from forming.
//   2. EPIPE fast path: skip dumpCrashContext (the 200-line dump is what
//      grew the file by 50–200 KB per iteration) and skip the console.error
//      "feedback" line (the original recursion seed). Just record one
//      bare line so post-mortem still sees we hit it.
let inUncaughtHandler = false;
function isStdioPipeError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as NodeJS.ErrnoException).code;
  if (code && STDIO_BENIGN_CLOSE_CODES.has(code)) return true;
  const msg = (e as Error).message ?? '';
  return /\bwrite\s+(EPIPE|EBADF|ENOTCONN)\b/i.test(msg);
}

process.on('uncaughtException', (err) => {
  if (inUncaughtHandler) {
    // Re-entry — drop. Recording even one line here would risk re-triggering.
    return;
  }
  inUncaughtHandler = true;
  try {
    if (isStdioPipeError(err)) {
      // Lightweight path: one line, no context dump, no console.error.
      // The stdio listeners above mark stdioBroken which makes the rest
      // of the process drop console writes anyway.
      crashLog('UNCAUGHT_EPIPE', err);
      stdioBroken = true;
      return;
    }
    crashLog('UNCAUGHT_EXCEPTION', err);
    dumpCrashContext('uncaughtException', err);
    if (!stdioBroken) {
      try { console.error('[process] uncaughtException:', err); } catch { /* ignore */ }
    }
  } finally {
    inUncaughtHandler = false;
  }
});

process.on('unhandledRejection', (reason) => {
  if (inUncaughtHandler) return;
  inUncaughtHandler = true;
  try {
    if (isStdioPipeError(reason)) {
      crashLog('UNHANDLED_REJECTION_EPIPE', reason);
      stdioBroken = true;
      return;
    }
    crashLog('UNHANDLED_REJECTION', reason);
    dumpCrashContext('unhandledRejection', reason);
    if (!stdioBroken) {
      try { console.error('[process] unhandledRejection:', reason); } catch { /* ignore */ }
    }
  } finally {
    inUncaughtHandler = false;
  }
});

process.on('SIGTERM', () => {
  crashLog('SIGNAL', 'SIGTERM');
  if (!stdioBroken) {
    try { console.log('[process] SIGTERM received, shutting down...'); } catch { /* ignore */ }
  }
  process.exit(0);  // Trigger SDK's process.on('exit') handler → SIGTERM CLI subprocess
});

process.on('SIGINT', () => {
  crashLog('SIGNAL', 'SIGINT');
  if (!stdioBroken) {
    try { console.log('[process] SIGINT received, shutting down...'); } catch { /* ignore */ }
  }
  process.exit(0);
});

crashLog('STARTUP', 'Server starting...');
// ============= END CRASH DIAGNOSTICS =============

import {
  enqueueUserMessage,
  cancelQueueItem,
  forceExecuteQueueItem,
  getQueueStatus,
  getAgentState,
  getLogLines,
  getMessages,
  getSessionId,
  getSystemInitInfo,
  initializeAgent,
  interruptCurrentResponse,
  isTurnInFlight,
  getStreamingAssistantId,
  switchToSession,
  setMcpServers,
  getMcpServers,
  getCurrentMcpServers,
  applyMcpOverrideAndAwaitReady,
  withCronDispatchLock,
  setAgents,
  setSessionModel,
  resetSession,
  waitForSessionIdle,
  cancelImRequest,
  setGroupToolsDeny,
  setInteractionScenario,
  resetInteractionScenario,
  rewindSession,
  forkSession,
  getPendingInteractiveRequests,
  stripPlaywrightResults,
  setSidecarPort,
  hasActiveBridge,
  getSessionModel,
  syncProjectUserConfig,
  setProxyConfig,
  initSocksBridgeFromEnv,
  getHistoricalSessionMessages,
  ensureSdkMcpInSync,
  type ProviderEnv,
} from './agent-session';
import { getHomeDirOrNull, isSkillBlockedOnPlatform } from './utils/platform';
import { getScriptDir } from './utils/runtime';
import {
  createSession,
  deleteSession,
  getAllSessionMetadata,
  getSessionData,
  getSessionMetadata,
  getSessionsByAgentDir,
  updateSessionMetadata,
  getAttachmentPath,
} from './SessionStore';
import { findAgentByWorkspacePath, findProvider, getAllMcpServers, getEffectiveMcpServers, resolveProviderEnv } from './utils/admin-config';
import { snapshotForOwnedSession } from './utils/session-snapshot';
import { resolveSessionConfig } from './utils/resolve-session-config';
import type { AgentConfig } from '../shared/types/agent';
import type { SessionMetadata } from './types/session';
import { initLogger, getLoggerDiagnostics, withLogContext, setStdioBrokenProbe } from './logger';
// `isStdioBroken` / `markStdioBroken` are defined above (in the crash-
// diagnostics block) and consumed by `setStdioBrokenProbe` below to wire
// the logger's safe-write wrapper to the stdio-state bit.
import {
  buildGateResponseBody,
  buildReadyResponseBody,
  markDeferredInitFailed,
  markDeferredInitReady,
  setDeferredInitPhase,
} from './readiness-state';
import { appendUnifiedLogBatch, getRecentLogLines, getActiveUnifiedLogPath } from './UnifiedLogger';
import { getActiveSessionLogPath } from './AgentLogger';
import { runLogRetentionSweep, startPeriodicSweep } from './log-retention';
import { broadcast, createSseClient, getClients } from './sse';
import { imEventBus } from './utils/im-event-bus';
import { imRequestRegistry } from './utils/im-request-registry';
import type { CancelReason } from './utils/cancellation';
import { checkAnthropicSubscription, verifyProviderViaSdk, verifySubscription } from './provider-verify';
// openai-bridge is lazy-loaded via ensureBridgeHandler() below — only users on
// OpenAI-protocol providers (DeepSeek/Moonshot/etc.) ever hit /v1/messages, so
// most sessions never need to pay the 2.6k-line module's init cost.
import type { BridgeHandler } from './openai-bridge/handler';
import { registerBridgeSeedFn } from './bridge-cache';
// title-generator is dynamically imported in the /api/title-generate handler
// below — it value-imports the Claude Agent SDK + claude-code/codex/gemini
// runtime classes, all of which are large. Pulling that into the Tier 0
// startup graph delayed `/health` bind on cold start (cf. v0.2.0 Tier 0
// goals) and crashed the sidecar before it could serve a 503 if the SDK
// native binary failed to load. The handler is in the post-bind path, so
// dynamic-import there is free.
import {
  shouldUseExternalRuntime,
  sendExternalMessage,
  enqueueExternalSendForDesktop,
  respondExternalPermission,
  respondExternalAskUserQuestion,
  hasPendingExternalAskUserQuestion,
  stopExternalSession,
  isExternalSessionActive,
  queryRuntimeModels,
  getRuntimePermissionModes,
  getActiveRuntimeType,
  restoreExternalSessionState,
  cancelExternalImRequest,
  waitForExternalSessionIdle,
  getLastExternalAssistantText,
  setExternalModel,
  setExternalPermissionMode,
  didLastTurnSucceed,
  getExternalSessionState,
  getExternalSystemInitPayload,
  getExternalPendingInteractiveRequests,
  getExternalSessionId,
  getExternalLiveAssistantMessage,
  getExternalSessionModel,
  getExternalSessionPermissionMode,
  prewarmExternalSession,
  awaitExternalSessionStarting,
  getCurrentBoundSessionId,
  popLastUserMessageForRetry,
} from './runtimes/external-session';
import type { ImagePayload } from './runtimes/types';
import { VALID_RUNTIMES, resolveCronPermissionMode } from '../shared/types/runtime';
import type { RuntimeConfig, RuntimeType } from '../shared/types/runtime';

type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

/**
 * Runtime download URLs for common MCP commands
 */
const RUNTIME_DOWNLOAD_URLS: Record<string, { name: string; url: string }> = {
  'node': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npx': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npm': { name: 'Node.js', url: 'https://nodejs.org/' },
  'python': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'python3': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'deno': { name: 'Deno', url: 'https://deno.land/' },
  'uv': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
  'uvx': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
};

/**
 * Get download info for a command
 */
function getCommandDownloadInfo(command: string): { runtimeName?: string; downloadUrl?: string } {
  const info = RUNTIME_DOWNLOAD_URLS[command];
  if (info) {
    return { runtimeName: info.name, downloadUrl: info.url };
  }
  return {};
}

type SendMessagePayload = {
  text?: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
  runtimeConfig?: RuntimeConfig;
  model?: string;
  // 'subscription' = explicit switch to Anthropic subscription (from desktop)
  // undefined/missing = "keep current provider" (safe default for IM/Cron callers)
  // object = use this specific third-party provider
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
  } | 'subscription';
};

function getRuntimeConfigModel(runtimeConfig?: RuntimeConfig | null): string | undefined {
  const model = runtimeConfig?.model?.trim();
  return model ? model : undefined;
}

function getRuntimeConfigPermissionMode(runtimeConfig?: RuntimeConfig | null): string | undefined {
  const permissionMode = runtimeConfig?.permissionMode?.trim();
  return permissionMode ? permissionMode : undefined;
}

/**
 * PRD 0.2.9: live-resolve a per-task `providerId` into the value
 * `enqueueUserMessage` expects:
 *
 *   - api-type provider with apiKey      → ProviderEnv object
 *   - subscription-type provider         → `'subscription'` sentinel (clears
 *                                          the session's current providerEnv)
 *   - provider missing / api-type w/o key → throws (caller surfaces 400)
 *
 * The `'subscription'` sentinel is the documented contract of
 * `enqueueUserMessage` (agent-session.ts:5375-5383). Callers MUST forward
 * the literal string when switching to subscription, not `undefined` —
 * `undefined` means "keep current provider", which is the bug PRD 0.2.9 R1
 * was tracking.
 */
function resolveCronProviderRouting(
  providerId: string,
): ProviderEnv | 'subscription' {
  const provider = findProvider(providerId);
  if (!provider) {
    throw new Error(
      `Provider '${providerId}' not found in config — task references a provider that has been deleted. Re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  if (provider.type === 'subscription') {
    return 'subscription';
  }
  const env = resolveProviderEnv(providerId);
  if (!env) {
    // Provider exists but has no apiKey configured.
    throw new Error(
      `Provider '${providerId}' has no API Key — open 设置 → 模型供应商 to configure it, or re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  return env;
}

// Cron task execution payload
type CronExecutePayload = {
  taskId: string;
  prompt: string;
  /** Session ID for single_session mode (reuse existing session) */
  sessionId?: string;
  isFirstExecution?: boolean;
  aiCanExit?: boolean;
  permissionMode?: PermissionMode;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
  model?: string;
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
  };
  /**
   * PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the
   * provider env via `resolveProviderEnv(providerId)` at each tick — this
   * keeps API key rotation / subscription switches in sync without
   * persisting credentials in the cron task. Mutually exclusive with
   * `providerEnv` (legacy explicit-snapshot path).
   *
   * Resolution outcomes:
   *   - provider not found / api-type with no apiKey → 400 (refuse to run,
   *     caller marks Task as Blocked)
   *   - subscription provider → effectiveProviderEnv = 'subscription'
   *     (sentinel cleared on session)
   *   - api provider → effectiveProviderEnv = ResolvedProviderEnv object
   */
  providerId?: string;
  /**
   * PRD #119 / 0.2.9: explicit routing intent. Controls how the handler
   * resolves effective model + providerEnv when `providerId` is absent:
   *   - `'followAgent'` (default if absent) — snapshot-based, follows agent
   *   - `'subscription'` — force subscription clear
   *   - `'explicit'`     — force `effectiveProviderEnv = payload.providerEnv`
   * Mirrors Rust's `cron_task::ProviderIntent`. New code prefers `providerId`.
   */
  providerIntent?: 'followAgent' | 'subscription' | 'explicit';
  /**
   * Per-task MCP enable list override (PRD 0.2.4 §需求 4).
   * `undefined` = follow workspace MCP (`config.agents[].mcpEnabledServers`).
   * `[id, id, ...]` = enable only these MCP server ids for this task.
   * Sidecar applies via `setMcpServers()` before `enqueueUserMessage`.
   */
  mcpEnabledServers?: string[];
  /** Run mode: "single_session" (keep context) or "new_session" (fresh each time) */
  runMode?: 'single_session' | 'new_session';
  /** Task execution interval in minutes (for System Prompt context) */
  intervalMinutes?: number;
  /** Current execution number, 1-based (for System Prompt context) */
  executionNumber?: number;
};

function parseArgs(argv: string[]): { agentDir: string; initialPrompt?: string; port: number; sessionId?: string; noPreWarm?: boolean } {
  const args = argv.slice(2);
  const getArgValue = (flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) {
      return null;
    }
    return args[index + 1] ?? null;
  };

  const agentDir = getArgValue('--agent-dir') ?? '';
  const initialPrompt = getArgValue('--prompt') ?? undefined;
  const port = Number(getArgValue('--port') ?? 3000);
  const sessionId = getArgValue('--session-id') ?? undefined;
  const noPreWarm = args.includes('--no-pre-warm');

  if (!agentDir) {
    throw new Error('Missing required argument: --agent-dir <path>');
  }

  return { agentDir, initialPrompt, port: Number.isNaN(port) ? 3000 : port, sessionId, noPreWarm };
}

/**
 * Expand ~ to user's home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    const homeDir = getHomeDirOrNull() || '';
    return path.replace(/^~/, homeDir);
  }
  return path;
}

async function ensureAgentDir(dir: string): Promise<string> {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) {
    await ensureDir(resolved);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Agent directory is not a directory: ${resolved}`);
  }
  return resolved;
}

// ============= SKILLS CONFIG & SEED =============

interface SkillsConfig {
  seeded: string[];
  disabled: string[];
  generation: number;  // Monotonic counter — incremented on every skill CRUD operation
}

function getSkillsConfigPath(): string {
  const homeDir = getHomeDirOrNull() || '';
  return join(homeDir, '.myagents', 'skills-config.json');
}

function readSkillsConfig(): SkillsConfig {
  const configPath = getSkillsConfigPath();
  const defaults: SkillsConfig = { seeded: [], disabled: [], generation: 0 };
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return {
        seeded: Array.isArray(raw?.seeded) ? raw.seeded : defaults.seeded,
        disabled: Array.isArray(raw?.disabled) ? raw.disabled : defaults.disabled,
        generation: typeof raw?.generation === 'number' ? raw.generation : 0,
      };
    }
  } catch (err) {
    console.warn('[skills-config] Error reading config:', err);
  }
  return defaults;
}

function writeSkillsConfig(config: SkillsConfig): void {
  const configPath = getSkillsConfigPath();
  try {
    const dir = dirname(configPath);
    ensureDirSync(dir);
    // Auto-increment generation on every write — signals Tab Sidecars to re-sync symlinks
    config.generation = (config.generation || 0) + 1;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[skills-config] Error writing config:', err);
  }
}

/**
 * Bump skills generation counter without changing seeded/disabled lists.
 * Called after skill CRUD operations (create/update/delete/upload/import)
 * that don't go through writeSkillsConfig but DO change the available skill set.
 * Tab Sidecars detect this change and re-sync symlinks on next /api/commands fetch.
 */
function bumpSkillsGeneration(): void {
  const config = readSkillsConfig();
  writeSkillsConfig(config);
}

/**
 * Lazy skill sync: Track the last generation we synced to avoid redundant sync work.
 * When a Tab Sidecar's /api/commands or /api/skills is called, we compare the current
 * generation in skills-config.json against this value. Only if they differ do we run
 * syncProjectUserConfig(). This covers the case where the Global Sidecar modified
 * global skills (create/toggle/delete) without the Tab Sidecar knowing.
 */
// Phase E (PRD 0.2.7): the `syncSkillsIfNeeded` wrapper + generation-tracking
// optimization is gone. Rust `cmd_list_slash_commands` is the canonical UI
// path and runs `sync_workspace_skills` (idempotent) every call. The sidecar
// only syncs as a side-effect of skill/command CRUD via direct
// `syncProjectUserConfig(...)` calls; CRUD-time correctness is what matters
// (the picker UI lives in Rust now). `markSkillsSynced` is also gone — there's
// no longer a generation-cached fast-path to invalidate.

/**
 * Resolve bundled-skills directory.
 * - Production (macOS): Contents/Resources/bundled-skills/
 * - Production (Windows): <install-dir>/bundled-skills/
 * - Development: <project-root>/bundled-skills/
 */
function resolveBundledSkillsDir(): string | null {
  const scriptDir = getScriptDir();

  // Production: bundled-skills is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, 'bundled-skills');
  if (existsSync(prodPath)) return prodPath;

  // Development: bundled-skills is at project root
  // In dev, scriptDir is something like <project>/src/server/utils
  // Walk up to find bundled-skills at project root
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, 'bundled-skills');
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }

  return null;
}

/**
 * System skills — owned by the app, version-gated by the Rust side
 * (`SYSTEM_SKILLS` + `SYSTEM_SKILLS_VERSION` in `src-tauri/src/commands.rs`).
 * These are skipped by `seedBundledSkills` below because their lifecycle
 * is "force-overwrite on every version bump", not "seed once then leave
 * alone". Keep this list in sync with the Rust constant — a mismatch
 * would either double-seed (harmless but confusing logs) or skip a
 * genuine user skill named identically.
 */
const SYSTEM_SKILLS: readonly string[] = [
  'task-alignment',
  'task-implement',
  // v10: ultra-research removed — not generic enough.
  'download-anything',
  // v8: see commands.rs::SYSTEM_SKILLS — agent-browser promoted to system
  // skill so existing users get the updated self-install SKILL.md after
  // the bundled CLI is removed.
  'agent-browser',
  // v9: myagents-cli — global skill that exposes the entire `myagents`
  // CLI surface (cron / task / mcp / model / agent / runtime / skill /
  // plugin / widget / im / config) to every AI session in the product.
  // Force-synced because SKILL.md must track CLI changes in lockstep.
  'myagents-cli',
];

/**
 * Seed bundled skills to ~/.myagents/skills/ on first launch.
 * Only copies skills that haven't been seeded before (tracked in skills-config.json).
 *
 * System skills (SYSTEM_SKILLS above) are owned by Rust's
 * `cmd_sync_system_skills` and are skipped here — they need the
 * version-gated force-overwrite path, not the seed-once-then-hands-off
 * path. If we seeded them here AND Rust overwrote them, the interaction
 * would be harmless (Rust always wins, ordering-wise) but we'd log a
 * "skipped existing folder" every boot, and the `config.seeded` array
 * would grow stale entries users don't recognise.
 */
function seedBundledSkills(): void {
  try {
    const bundledDir = resolveBundledSkillsDir();
    if (!bundledDir) {
      console.log('[seed] Bundled skills directory not found, skipping seed');
      return;
    }

    const config = readSkillsConfig();
    const homeDir = getHomeDirOrNull() || '';
    const userSkillsDir = join(homeDir, '.myagents', 'skills');

    ensureDirSync(userSkillsDir);

    const bundledFolders = readdirSync(bundledDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let changed = false;
    for (const folder of bundledFolders) {
      if (SYSTEM_SKILLS.includes(folder)) {
        // Owned by Rust version gate — skip silently.
        continue;
      }
      if (isSkillBlockedOnPlatform(folder)) {
        console.log(`[seed] Skipping ${folder} on ${process.platform} (platform blocked)`);
        continue;
      }
      const dst = join(userSkillsDir, folder);

      // Detect broken symlinks at dst BEFORE any operation that resolves the
      // path. Node v24's cpSync C++ implementation calls
      // `std::filesystem::equivalent(src, dst)` for src/dst equality
      // detection; on a broken symlink that throws an uncaught C++ exception
      // (`libc++abi: ... filesystem error: in equivalent: Operation not
      // supported`) which terminates the entire sidecar — JS try/catch
      // cannot intercept it. existsSync follows the link and returns false,
      // hiding the symlink from every guard below, so we must lstat first.
      // Repro: `node -e 'fs.cpSync("/tmp/src", "/tmp/dangling", {recursive:true})'`
      // where /tmp/dangling -> /nonexistent. Reported as user crash on v0.2.5
      // (~/.myagents/skills/docx pointed at a deleted target).
      let dstLstat: ReturnType<typeof lstatSync> | null = null;
      try {
        dstLstat = lstatSync(dst);
      } catch {
        // dst doesn't exist — fall through to seed path
      }
      const dstExists = existsSync(dst); // follows symlinks
      const isBrokenSymlink = dstLstat?.isSymbolicLink() && !dstExists;

      if (isBrokenSymlink) {
        try {
          unlinkSync(dst);
          console.warn(`[seed] Removed broken symlink at ${dst} so the bundled skill can seed`);
        } catch (err) {
          console.warn(`[seed] Failed to remove broken symlink ${dst}, skipping:`, err);
          continue;
        }
      }

      // Re-seed if marked as seeded but directory was deleted (or was a broken symlink we just cleared)
      if (config.seeded.includes(folder) && dstExists) continue;

      const src = join(bundledDir, folder);
      // Skip if destination already exists (don't overwrite user's custom content)
      if (dstExists) {
        config.seeded.push(folder);
        changed = true;
        console.log(`[seed] Skipped existing folder: ${folder}`);
        continue;
      }
      try {
        cpSync(src, dst, { recursive: true });
        console.log(`[seed] Seeded skill: ${folder}`);
      } catch (err) {
        console.warn(`[seed] Failed to seed skill ${folder}:`, err);
        continue;
      }

      config.seeded.push(folder);
      changed = true;
    }

    if (changed) {
      writeSkillsConfig(config);
    }
  } catch (err) {
    console.error('[seed] Error seeding bundled skills:', err);
  }
}

/**
 * Clean up stale Playwright MCP profile lock files left by a crashed Chromium.
 *
 * Independent of the agent-browser bundle removal — this exists because
 * Chromium leaves SingletonLock / SingletonSocket / SingletonCookie files in
 * the user-data-dir when the process crashes (or the OS kills it on app exit
 * without a clean shutdown). Subsequent Chromium launches with the same
 * user-data-dir refuse to start with "ProfileInUse" until the locks clear.
 *
 * Playwright's own startup mostly handles this, but the legacy
 * `~/.playwright-mcp-profile/` directory pre-dates Playwright MCP's improved
 * recovery paths and we've seen real "Chromium hangs forever" reports tied to
 * stale locks here. Cheap idempotent cleanup at sidecar boot.
 */
function cleanupStalePlaywrightProfile(): void {
  try {
    const homeDir = getHomeDirOrNull();
    if (!homeDir) return;

    const profileDir = join(homeDir, '.playwright-mcp-profile');
    const lockPath = join(profileDir, 'SingletonLock');

    if (!existsSync(lockPath)) return;

    // SingletonLock content: "hostname-pid" (POSIX symlink target on macOS/Linux,
    // regular file content on Windows).
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(lockPath);
    } catch {
      try {
        linkTarget = readFileSync(lockPath, 'utf-8').trim();
      } catch {
        return; // Can't read — bail
      }
    }

    const pidMatch = linkTarget.match(/-(\d+)$/);
    if (!pidMatch) return;
    const pid = parseInt(pidMatch[1], 10);

    // Probe pid liveness; if the process is alive, leave its locks alone.
    try {
      process.kill(pid, 0);
      return;
    } catch {
      // Process is dead → safe to clean up
    }

    for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const filePath = join(profileDir, file);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch { /* best effort */ }
    }

    console.log(`[startup] Cleaned up stale Playwright MCP profile lock (pid ${pid} dead)`);
  } catch (err) {
    console.warn('[startup] Playwright profile cleanup failed:', err);
  }
}

// ============= END SKILLS CONFIG & SEED =============

/**
 * Validate that the agent directory is safe to access.
 * Prevents directory traversal attacks and access to sensitive directories.
 */
function isValidAgentDir(dir: string): { valid: boolean; reason?: string } {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  const homeDir = getHomeDirOrNull() || '';

  // Must be an absolute path (use isAbsolute for cross-platform correctness)
  if (!isAbsolute(resolved)) {
    return { valid: false, reason: 'Path must be absolute' };
  }

  // Forbidden system directories (deny-list approach)
  const forbiddenPaths = [
    // Unix system directories
    '/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/root', '/sys', '/proc', '/dev',
    // User sensitive directories
    join(homeDir, '.ssh'),
    join(homeDir, '.gnupg'),
    join(homeDir, '.config/op'),  // 1Password
    join(homeDir, 'Library/Keychains'),
    // Windows system directories
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];

  const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();
  for (const forbidden of forbiddenPaths) {
    const normalizedForbidden = forbidden.replace(/\\/g, '/').toLowerCase();
    if (normalizedResolved === normalizedForbidden || normalizedResolved.startsWith(normalizedForbidden + '/')) {
      return { valid: false, reason: `Access to ${forbidden} is not allowed` };
    }
  }

  // Reject filesystem roots as workspace (too broad, not a real project)
  // Windows: "C:\", "D:\" etc.  Unix: "/"
  if (resolved === '/' || resolved.match(/^[A-Z]:\\?$/i)) {
    return { valid: false, reason: 'Cannot use filesystem root as workspace' };
  }

  return { valid: true };
}

function resolveAgentPath(root: string, relativePath: string): string | null {
  // Strip leading slashes (both / and \ for Windows compatibility)
  const normalized = relativePath.replace(/^[/\\]+/, '');
  const resolved = resolve(root, normalized);
  // Use root + sep to prevent prefix collision (e.g. /agent matching /agent-other)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

// Phase E (PRD 0.2.7): the legacy read-side helpers `isSafeReadPath`,
// `resolveReadPath`, `isPreviewableText` are removed. Their gates now live
// in Rust workspace_files (`path_safety::validate_workspace_root`,
// `resolve_existing_inside_workspace`, `read_preview::is_previewable`).

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Strip credential-bearing fields from a SessionMetadata before returning to clients.
 * Replaces providerEnvJson with '[redacted]' when present (so the client can still tell
 * a provider override exists without seeing the raw API key). Used by GET /sessions,
 * GET /sessions/:id, and PATCH /sessions/:id response shapes — zero-trust parity.
 */
function redactSessionMetadata<T extends { providerEnvJson?: string }>(meta: T): T {
  if (meta.providerEnvJson === undefined) return meta;
  return { ...meta, providerEnvJson: '[redacted]' };
}

/**
 * Route /api/admin/* requests to the appropriate handler.
 * Keeps the route matching logic clean and separated from business logic (in admin-api.ts).
 */
async function routeAdminApi(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Strip the prefix for matching
  const route = pathname.replace('/api/admin/', '');

  // Lazy-load admin-api (~150ms on first hit, cached thereafter)
  const api = await getAdminApi();

  // MCP commands
  if (route === 'mcp/list') return api.handleMcpList();
  if (route === 'mcp/show') return api.handleMcpShow(payload as Parameters<typeof api.handleMcpShow>[0]);
  if (route === 'mcp/add') return api.handleMcpAdd(payload as Parameters<typeof api.handleMcpAdd>[0]);
  if (route === 'mcp/remove') return api.handleMcpRemove(payload as Parameters<typeof api.handleMcpRemove>[0]);
  if (route === 'mcp/enable') return api.handleMcpEnable(payload as Parameters<typeof api.handleMcpEnable>[0]);
  if (route === 'mcp/disable') return api.handleMcpDisable(payload as Parameters<typeof api.handleMcpDisable>[0]);
  if (route === 'mcp/env') return api.handleMcpEnv(payload as Parameters<typeof api.handleMcpEnv>[0]);
  if (route === 'mcp/test') return await api.handleMcpTest(payload as Parameters<typeof api.handleMcpTest>[0]);
  if (route === 'mcp/oauth/discover') return await api.handleMcpOAuthDiscover(payload as Parameters<typeof api.handleMcpOAuthDiscover>[0]);
  if (route === 'mcp/oauth/start') return await api.handleMcpOAuthStart(payload as Parameters<typeof api.handleMcpOAuthStart>[0]);
  if (route === 'mcp/oauth/status') return await api.handleMcpOAuthStatus(payload as Parameters<typeof api.handleMcpOAuthStatus>[0]);
  if (route === 'mcp/oauth/revoke') return await api.handleMcpOAuthRevoke(payload as Parameters<typeof api.handleMcpOAuthRevoke>[0]);

  // Model commands
  if (route === 'model/list') return api.handleModelList();
  if (route === 'model/add') return api.handleModelAdd(payload as Parameters<typeof api.handleModelAdd>[0]);
  if (route === 'model/remove') return api.handleModelRemove(payload as Parameters<typeof api.handleModelRemove>[0]);
  if (route === 'model/set-key') return api.handleModelSetKey(payload as Parameters<typeof api.handleModelSetKey>[0]);
  if (route === 'model/set-default') return api.handleModelSetDefault(payload as Parameters<typeof api.handleModelSetDefault>[0]);
  if (route === 'model/verify') return await api.handleModelVerify(payload as Parameters<typeof api.handleModelVerify>[0]);

  // Agent commands
  if (route === 'agent/list') return api.handleAgentList();
  if (route === 'agent/show') return api.handleAgentShow(payload as Parameters<typeof api.handleAgentShow>[0]);
  if (route === 'agent/enable') return api.handleAgentEnable(payload as Parameters<typeof api.handleAgentEnable>[0]);
  if (route === 'agent/disable') return api.handleAgentDisable(payload as Parameters<typeof api.handleAgentDisable>[0]);
  if (route === 'agent/set') return api.handleAgentSet(payload as Parameters<typeof api.handleAgentSet>[0]);
  if (route === 'agent/channel/list') return api.handleAgentChannelList(payload as Parameters<typeof api.handleAgentChannelList>[0]);
  if (route === 'agent/channel/add') return api.handleAgentChannelAdd(payload as Parameters<typeof api.handleAgentChannelAdd>[0]);
  if (route === 'agent/channel/remove') return api.handleAgentChannelRemove(payload as Parameters<typeof api.handleAgentChannelRemove>[0]);
  if (route === 'runtime/list') return await api.handleRuntimeList();
  if (route === 'runtime/describe') return await api.handleRuntimeDescribe(payload as Parameters<typeof api.handleRuntimeDescribe>[0]);
  if (route === 'runtime/diagnose') return await api.handleRuntimeDiagnose(payload as Parameters<typeof api.handleRuntimeDiagnose>[0]);
  if (route === 'diagnose/runtime') return await api.handleRuntimeDiagnose(payload as Parameters<typeof api.handleRuntimeDiagnose>[0]);

  // Agent runtime status
  if (route === 'agent/runtime-status') return await api.handleAgentRuntimeStatus();

  // Cron task commands
  if (route === 'cron/list') return await api.handleCronList(payload as Parameters<typeof api.handleCronList>[0]);
  if (route === 'cron/add') return await api.handleCronCreate(payload);
  if (route === 'cron/start') return await api.handleCronStart(payload as Parameters<typeof api.handleCronStart>[0]);
  if (route === 'cron/run-now') return await api.handleCronRunNow(payload as Parameters<typeof api.handleCronRunNow>[0]);
  if (route === 'cron/stop') return await api.handleCronStop(payload as Parameters<typeof api.handleCronStop>[0]);
  if (route === 'cron/remove') return await api.handleCronDelete(payload as Parameters<typeof api.handleCronDelete>[0]);
  if (route === 'cron/update') return await api.handleCronUpdate(payload as Parameters<typeof api.handleCronUpdate>[0]);
  if (route === 'cron/runs') return await api.handleCronRuns(payload as Parameters<typeof api.handleCronRuns>[0]);
  if (route === 'cron/status') return await api.handleCronStatus(payload as Parameters<typeof api.handleCronStatus>[0]);
  if (route === 'cron/exit') return api.handleCronExit(payload as Parameters<typeof api.handleCronExit>[0]);

  // IM runtime commands. send-media + wake are session-scoped (require an
  // IM Bot / Agent Channel context — handlers reject otherwise). channels is
  // not session-scoped: it discovers all configured IM bots and works in any
  // session, including desktop, so the AI can reference targets when creating
  // cron tasks that deliver to IM.
  if (route === 'im/send-media') return await api.handleImSendMedia(payload as Parameters<typeof api.handleImSendMedia>[0]);
  if (route === 'im/wake') return await api.handleImWake(payload as Parameters<typeof api.handleImWake>[0]);
  if (route === 'im/channels') return await api.handleImChannels();

  // Tool readme — progressive-disclosure helpers for external runtimes
  if (route === 'readme/cron' || route === 'readme/im' || route === 'readme/widget' || route === 'readme/thought') {
    const topic = route.split('/')[1];
    return api.handleReadme({
      topic,
      modules: Array.isArray(payload.modules) ? (payload.modules as string[]) : undefined,
    });
  }

  // Plugin commands
  if (route === 'plugin/list') return await api.handlePluginList();
  if (route === 'plugin/install') return await api.handlePluginInstall(payload as Parameters<typeof api.handlePluginInstall>[0]);
  if (route === 'plugin/remove') return await api.handlePluginUninstall(payload as Parameters<typeof api.handlePluginUninstall>[0]);

  // Skill commands
  if (route === 'skill/list') return await api.handleSkillList();
  if (route === 'skill/info') return await api.handleSkillInfo(payload as Parameters<typeof api.handleSkillInfo>[0]);
  if (route === 'skill/add') return await api.handleSkillAdd(payload as Parameters<typeof api.handleSkillAdd>[0]);
  if (route === 'skill/remove') return await api.handleSkillRemove(payload as Parameters<typeof api.handleSkillRemove>[0]);
  if (route === 'skill/enable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: true });
  if (route === 'skill/disable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: false });
  if (route === 'skill/sync') return await api.handleSkillSync();

  // Config commands
  if (route === 'config/get') return api.handleConfigGet(payload as Parameters<typeof api.handleConfigGet>[0]);
  if (route === 'config/set') return api.handleConfigSet(payload as Parameters<typeof api.handleConfigSet>[0]);

  // Task Center — thoughts + tasks (v0.1.69)
  if (route === 'task/list') return await api.handleTaskList(payload as Parameters<typeof api.handleTaskList>[0]);
  if (route === 'task/get') return await api.handleTaskGet(payload as Parameters<typeof api.handleTaskGet>[0]);
  if (route === 'task/create-direct') return await api.handleTaskCreateDirect(payload);
  if (route === 'task/create-from-alignment') return await api.handleTaskCreateFromAlignment(payload);
  if (route === 'task/run') return await api.handleTaskRun(payload as Parameters<typeof api.handleTaskRun>[0]);
  if (route === 'task/rerun') return await api.handleTaskRerun(payload as Parameters<typeof api.handleTaskRerun>[0]);
  if (route === 'task/update-status') return await api.handleTaskUpdateStatus(payload);
  if (route === 'task/append-session') return await api.handleTaskAppendSession(payload as Parameters<typeof api.handleTaskAppendSession>[0]);
  if (route === 'task/archive') return await api.handleTaskArchive(payload as Parameters<typeof api.handleTaskArchive>[0]);
  if (route === 'task/delete') return await api.handleTaskDelete(payload as Parameters<typeof api.handleTaskDelete>[0]);
  if (route === 'task/read-doc') return await api.handleTaskReadDoc(payload as Parameters<typeof api.handleTaskReadDoc>[0]);
  if (route === 'task/write-doc') return await api.handleTaskWriteDoc(payload as Parameters<typeof api.handleTaskWriteDoc>[0]);
  if (route === 'thought/list') return await api.handleThoughtList(payload as Parameters<typeof api.handleThoughtList>[0]);
  if (route === 'thought/create') return await api.handleThoughtCreate(payload as Parameters<typeof api.handleThoughtCreate>[0]);

  // System commands
  if (route === 'status') return api.handleStatus();
  if (route === 'reload') return api.handleReload(payload.workspacePath as string | undefined);
  if (route === 'version') return api.handleVersion();
  if (route === 'help') return api.handleHelp(payload as Parameters<typeof api.handleHelp>[0]);

  return { success: false, error: `Unknown admin route: ${pathname}` };
}

/**
 * Strip HEARTBEAT_OK token from AI response and determine if it's silent or has content.
 * Supports markdown/HTML wrapping around the token.
 */
function stripHeartbeatToken(text: string, ackMaxChars: number): { status: string; text?: string; reason?: string } {
  if (!text || !text.trim()) {
    return { status: 'silent', reason: 'empty' };
  }

  // Check if HEARTBEAT_OK appears in the text (case-insensitive)
  if (!/HEARTBEAT_OK/i.test(text)) {
    // No token at all — this is real content
    return { status: 'content', text };
  }

  // Strip the token (supports markdown bold, code wrapping)
  const stripped = text
    .replace(/\*{0,2}HEARTBEAT_OK\*{0,2}/gi, '')
    .replace(/`HEARTBEAT_OK`/gi, '')
    .trim();

  // If remaining text is short enough, treat as silent acknowledgment
  if (stripped.length <= ackMaxChars) {
    return { status: 'silent', reason: 'heartbeat_ok' };
  }

  // Remaining text has substance — treat as content (but strip the token)
  return { status: 'content', text: stripped };
}

/**
 * Strip YAML frontmatter from file content.
 * Frontmatter is delimited by --- at the start and a second --- line.
 */
function stripYamlFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return trimmed;
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return trimmed;
  return trimmed.slice(endIndex + 3).trim();
}

/**
 * Recursively copy a directory using fs/promises.
 * Every filesystem call yields to the event loop — important for HTTP handlers
 * that bulk-copy multiple folders. A sync implementation would block Bun's
 * event loop long enough for the Rust health monitor (/health with 2 s timeout,
 * 15 s interval) to declare the sidecar unresponsive and respawn it on a fresh
 * port mid-copy — which was the root cause of the "sync-from-claude crashes
 * the sidecar" report in issue #96.
 *
 * Security: Skips symbolic links to prevent following links to sensitive locations.
 */
async function copyDirRecursive(src: string, dest: string, logPrefix = '[copyDir]'): Promise<void> {
  await ensureDir(dest);
  const entries = await readdirAsync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      console.warn(`${logPrefix} Skipping symlink: ${srcPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, logPrefix);
    } else {
      await copyFileAsync(srcPath, destPath);
    }
  }
}

/**
 * Validate folder name for security (no path traversal)
 */
function isValidFolderName(name: string): boolean {
  return !name.includes('..') && !name.includes('/') && !name.includes('\\') && name.length > 0;
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const distRoot = resolve(process.cwd(), 'dist');
  const resolvedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(distRoot, resolvedPath);
  // Prevent path traversal: resolved path must stay within distRoot
  if (!filePath.startsWith(distRoot + sep)) {
    return null;
  }
  const fileResp = await fileResponse(filePath, { contentType: sniffMime(filePath) });
  if (fileResp) return fileResp;

  const indexPath = join(distRoot, 'index.html');
  const indexResp = await fileResponse(indexPath, { contentType: sniffMime(indexPath) });
  if (indexResp) return indexResp;

  return null;
}

interface SwitchPayload {
  agentDir: string;
  initialPrompt?: string;
}

// System event queue for heartbeat relay (cron completion, etc.)
// Capped to prevent unbounded memory growth if heartbeat consumer is absent
const SYSTEM_EVENT_QUEUE_MAX = 500;
const systemEventQueue: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];

/** Push a system event, evicting oldest if at capacity */
function pushSystemEvent(event: { event: string; content: string; timestamp: number; taskId?: string }) {
  if (systemEventQueue.length >= SYSTEM_EVENT_QUEUE_MAX) {
    systemEventQueue.splice(0, systemEventQueue.length - SYSTEM_EVENT_QUEUE_MAX + 1);
  }
  systemEventQueue.push(event);
}

/** Drain all pending system events (used by heartbeat endpoint) */
export function drainSystemEvents(): Array<{ event: string; content: string; timestamp: number; taskId?: string }> {
  return systemEventQueue.splice(0);
}

/** Build a dedicated prompt for cron completion events (replaces standard heartbeat prompt) */
function buildCronEventPrompt(
  cronEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }>
): string {
  const now = new Date().toLocaleString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  if (cronEvents.length === 1) {
    const e = cronEvents[0];
    return (
      'A scheduled task has been triggered and completed. ' +
      'Please relay these results to the user in a helpful and friendly way.\n' +
      `Task id: ${e.taskId || 'unknown'}\n` +
      `Current time: ${now}\n` +
      'The task results are:\n' +
      '```markdown\n' +
      e.content + '\n' +
      '```'
    );
  }

  // Multiple tasks
  let prompt =
    'Scheduled tasks have been triggered and completed. ' +
    'Please relay these results to the user in a helpful and friendly way.\n' +
    `Current time: ${now}\n`;

  for (const e of cronEvents) {
    prompt +=
      `\nTask id: ${e.taskId || 'unknown'}\n` +
      'The task results are:\n' +
      '```markdown\n' +
      e.content + '\n' +
      '```\n';
  }
  return prompt;
}

/**
 * Write a startup beacon directly to unified log file (bypasses initLogger).
 * This is critical for diagnosing Windows startup hangs where initLogger
 * may not be reached yet and zero NODE logs appear.
 */
function startupBeacon(step: string): void {
  // Write to stderr — captured by Rust drain thread → unified log
  try { process.stderr.write(`[startup] ${step}\n`); } catch { /* ignore */ }
  // Also write directly to unified log file.
  // NOTE: 内联时间戳格式而非 import localTimestamp()，因为此函数在 initLogger() 之前运行，
  // 需保持零依赖以诊断 Windows 上 initLogger 未到达的 hang 问题。
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const logsDir = join(homedir(), '.myagents', 'logs');
    ensureDirSync(logsDir);
    const filePath = join(logsDir, `unified-${y}-${m}-${d}.log`);
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const ts = `${y}-${m}-${d} ${h}:${mi}:${s}.${ms}`;
    appendFileSync(filePath, `${ts} [NODE ] [INFO ] [startup] ${step}\n`);
  } catch { /* ignore */ }
}

async function main() {
  startupBeacon(`main() entered, pid=${process.pid}, platform=${process.platform}, argv=${process.argv.length} args`);

  const { agentDir, initialPrompt, port, sessionId: initialSessionId, noPreWarm } = parseArgs(process.argv);
  const dirDisplay = agentDir.length > 50 ? agentDir.slice(0, 3) + '...' + agentDir.slice(-44) : agentDir;
  startupBeacon(`args parsed, port=${port}, agentDir=${dirDisplay}`);

  let currentAgentDir = await ensureAgentDir(agentDir);
  startupBeacon('ensureAgentDir done');

  // Initialize unified logging system (intercepts console.log and sends to SSE)
  // PRD #132 — wire the stdio-broken probe + marker so the logger wrapper
  // stops calling originalConsole.* once a stdio EPIPE has marked the sink
  // dead, and so a sync write-throw can flip the bit immediately.
  setStdioBrokenProbe(isStdioBroken, markStdioBroken);
  initLogger(getClients);
  startupBeacon('initLogger done — switching to console.log');

  // Store sidecar port BEFORE initializeAgent() so that:
  //   1. pre-warm's buildClaudeSessionEnv() reads the correct sidecarPort
  //      (OpenAI bridge loopback URL + MYAGENTS_PORT injection both need it).
  //   2. setSidecarPort's process.env.MYAGENTS_PORT side effect is in place
  //      before any external runtime subprocess (or `myagents` CLI invocation
  //      from pre-warm bash tools) can spawn. This eliminates a subtle timing
  //      coincidence where the old ordering depended on pre-warm's 500ms
  //      debounce outlasting the few µs between these two calls.
  setSidecarPort(port);

  // ── Deferred init gate ──────────────────────────────────────────────────
  // Everything heavy (skill seed, socks bridge, initializeAgent, external
  // runtime restore) moves to AFTER
  // honoServe() binds, so Rust's TCP health check unblocks in < 100ms
  // instead of waiting ~2s for this work to complete. Routes that need
  // agent state `await deferredInit` at the top of the fetch handler.
  //
  // /health is exempt so the sidecar becomes "healthy" from Rust's
  // perspective the moment the HTTP server accepts TCP connections —
  // letting the frontend render the Tab UI while deferred init still runs.
  let resolveDeferredInit!: () => void;
  let rejectDeferredInit!: (e: unknown) => void;
  const deferredInitPromise: Promise<void> = new Promise((res, rej) => {
    resolveDeferredInit = res;
    rejectDeferredInit = rej;
  });
  // Route handlers that need agent state call `await awaitDeferredInit()`.
  // Exposed on globalThis so the hono fetch handler (below) can reach it
  // without changing signatures.
  (globalThis as { __myagentsDeferredInit?: Promise<void> }).__myagentsDeferredInit =
    deferredInitPromise;

  /**
   * Extract the bridge token from a `/bridge/<token>/v1/messages` URL.
   * Returns the token string or `null` for any URL that doesn't match
   * the expected shape. PRD #124.
   */
  function extractBridgeTokenFromUrl(rawUrl: string): string | null {
    try {
      const u = new URL(rawUrl);
      const m = u.pathname.match(/^\/bridge\/([^/]+)\/v1\/messages(?:\/count_tokens)?$/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ── OpenAI bridge: lazy + per-token (PRD #124) ─────────────────────────
  // Only users on OpenAI-protocol providers hit `/bridge/<token>/v1/messages`.
  // Importing `./openai-bridge` (~2600 lines, includes translate/utils/types
  // subtrees) at startup costs ~120ms for zero benefit on Anthropic-native
  // setups, so the factory stays lazy.
  //
  // The handler is stateless across tokens: every request carries its
  // bridge token in the URL path; getUpstreamConfig parses the token and
  // looks it up in `bridge-registry`. Each SDK subprocess (active session,
  // verify, title-gen, sub-agent) registers under its own token, so they
  // route to their own upstream without cross-pollination. See
  // `bridge-registry.ts` for the lifecycle contract.
  let bridgeHandlerPromise: Promise<BridgeHandler> | null = null;
  const ensureBridgeHandler = (): Promise<BridgeHandler> => {
    if (bridgeHandlerPromise) return bridgeHandlerPromise;
    bridgeHandlerPromise = (async () => {
      const [{ createBridgeHandler }, { lookupBridge }] = await Promise.all([
        import('./openai-bridge'),
        import('./openai-bridge/bridge-registry'),
      ]);
      const handler = createBridgeHandler({
          workspacePath: agentDir || undefined,
          getUpstreamConfig: (request) => {
            const token = extractBridgeTokenFromUrl(request.url);
            if (!token) {
              throw new Error('Bridge request missing token in URL path');
            }
            const cfg = lookupBridge(token);
            if (!cfg) {
              throw new Error(`Unknown bridge token: ${token}`);
            }
            // Per-request modelMapping bound to THIS token's aliases —
            // ensures concurrent bridges with different sub-agent rules
            // don't cross-pollinate (the original #124 bug class).
            const aliases = cfg.modelAliases;
            const modelMapping = aliases
              ? (requestModel: string): string | undefined => {
                  if (requestModel.startsWith('claude') && requestModel.includes('sonnet') && aliases.sonnet) return aliases.sonnet;
                  if (requestModel.startsWith('claude') && requestModel.includes('opus') && aliases.opus) return aliases.opus;
                  if (requestModel.startsWith('claude') && requestModel.includes('haiku') && aliases.haiku) return aliases.haiku;
                  // Last-resort: claude-* with no specific alias → use the
                  // bridge's own active model (per-token, no global leakage).
                  if (requestModel.startsWith('claude-')) return cfg.model || undefined;
                  return undefined;
                }
              : undefined;
            return {
              baseUrl: cfg.baseUrl,
              apiKey: cfg.apiKey,
              model: cfg.model,
              maxOutputTokens: cfg.maxOutputTokens,
              maxOutputTokensParamName: cfg.maxOutputTokensParamName,
              upstreamFormat: cfg.upstreamFormat,
              modelMapping,
            };
          },
          logger: (msg) => console.log(msg),
        });
      // Register seed callback now that the handler exists. bridge-cache
      // flushes any entries buffered during pre-registration.
      registerBridgeSeedFn((entries) => handler.seedThoughtSignatures(entries));
      return handler;
    })();
    return bridgeHandlerPromise;
  };

  console.log(`[startup] HTTP server binding to 127.0.0.1:${port}...`);

  honoServe({
    // Explicit 127.0.0.1 for Rust proxy compatibility (IPv4).
    port,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      // Pattern 6 (HTTP request boundary): each request runs inside an ALS
      // frame so any nested console.* call automatically gets correlation
      // fields injected. Renderer-side code (`tauriClient.ts`) attaches
      // X-MyAgents-Session-Id / X-MyAgents-Tab-Id; the server generates a
      // fresh requestId (or honours an inbound `X-MyAgents-Request-Id` from
      // the Rust proxy if it pre-populated one).
      const incomingRequestId = request.headers.get('x-myagents-request-id') ?? undefined;
      const requestId = incomingRequestId ?? randomUUIDv4Short();
      const sessionId = request.headers.get('x-myagents-session-id') ?? undefined;
      const tabId = request.headers.get('x-myagents-tab-id') ?? undefined;
      return withLogContext({ requestId, sessionId, tabId }, () => handleRequest(request));
    },
  } as Parameters<typeof honoServe>[0]);

  /**
   * Pattern 6 helper: short stable id for HTTP request correlation.
   * crypto.randomUUID is ~36 chars; we collapse to 8 hex for grep-ability.
   */
  function randomUUIDv4Short(): string {
    // randomUUID is imported above; we re-derive from the same 16-byte source.
    return randomUUID().replace(/-/g, '').slice(0, 8);
  }

  /**
   * Pattern 1 (last-consumer disconnect grace) state.
   *
   * Audit C: when the last renderer client closes its `/chat/stream` SSE while
   * a turn is in flight, the SDK keeps generating into the void — burning
   * tokens and queuing chunks no one reads. Counter-design: a 3-second grace
   * window. If a new client connects within the window (renderer reload
   * typically reconnects in ~1s), cancel the schedule. Otherwise, interrupt
   * the SDK with reason 'shutdown'.
   *
   * Scoped to the sidecar process. IM/Cron/BackgroundCompletion sessions
   * never have an SSE client connected in the first place, so the
   * `clients.size === 0` check naturally excludes them — no interrupt fires
   * for those owners.
   */
  const LAST_CONSUMER_GRACE_MS = 3000;
  let lastConsumerGraceTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelLastConsumerGrace(): void {
    if (lastConsumerGraceTimer) {
      clearTimeout(lastConsumerGraceTimer);
      lastConsumerGraceTimer = null;
    }
  }

  function handleChatStreamClose(): void {
    // Recompute on close — after our own client was removed in sse.ts, the
    // remaining count is what matters.
    const remainingClients = getClients().length;
    if (remainingClients > 0) {
      // Other tabs still watching; nothing to do.
      return;
    }
    if (!isTurnInFlight()) {
      // No active turn → no tokens being burned; nothing to do.
      return;
    }
    if (lastConsumerGraceTimer) {
      // Already armed — let the existing window run out.
      return;
    }
    console.warn('[chat-stream] last consumer disconnected; arming 3s grace before interrupt (reason=shutdown)');
    lastConsumerGraceTimer = setTimeout(() => {
      lastConsumerGraceTimer = null;
      // Re-check at fire time — a new client may have raced past our gate.
      if (getClients().length > 0) {
        console.warn('[chat-stream] grace fired but a client reconnected; skipping interrupt');
        return;
      }
      if (!isTurnInFlight()) {
        // Turn already finished naturally; nothing to interrupt.
        return;
      }
      console.warn('[chat-stream] grace expired; interrupting SDK turn (reason=shutdown)');
      interruptCurrentResponse('shutdown').catch((err) => {
        console.warn(`[chat-stream] interrupt after grace failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, LAST_CONSUMER_GRACE_MS);
    lastConsumerGraceTimer.unref?.();
  }

  /**
   * Original Hono fetch body, unchanged except for being moved into a named
   * function so the outer wrapper can run inside `withLogContext`.
   */
  async function handleRequest(request: Request): Promise<Response> {
    {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Skip logging high-frequency polling/config-sync paths to reduce unified log noise.
      // These fire every 15s (health) or on every Tab focus (commands/agents/mcp) with zero diagnostic value.
      const SILENT_PATHS = new Set([
        '/health', '/api/unified-log', '/agent/dir', '/sessions',
        '/api/commands', '/api/agents/enabled', '/api/git/branch',
      ]);
      if (!SILENT_PATHS.has(pathname)) {
        console.debug(`[http] ${request.method} ${pathname}`);
      }

      // Handle CORS preflight requests (for browser dev mode via Vite proxy)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        });
      }

      // 🩺 Health check endpoints - used by Rust sidecar manager and renderer.
      //
      // Pattern 4 splits the historical "/health = healthy" signal into three:
      //   - /health         → liveness (TCP bind succeeded; legacy alias kept
      //                       so existing Rust watchdogs keep working)
      //   - /health/live    → same as /health, explicit name
      //   - /health/ready   → deferred init complete; structured 503 + phase
      //                       while pending or failed
      //   - /health/functional → core feature can serve (sidecar mirrors live;
      //                       Plugin Bridge implements the real check)
      //
      // All four bypass the deferred-init gate below — they MUST respond
      // immediately, otherwise probes can't distinguish "still warming up"
      // from "wedged".
      if ((pathname === '/health' || pathname === '/health/live') && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }
      if (pathname === '/health/ready' && request.method === 'GET') {
        const { status, body } = buildReadyResponseBody();
        return jsonResponse(body, status);
      }
      if (pathname === '/health/functional' && request.method === 'GET') {
        // Sidecar's "functional" mirrors readiness for now — once ready, the
        // Hono handler is serving requests. Plugin Bridge has a more
        // meaningful gateway-forwarding check.
        const { status, body } = buildReadyResponseBody();
        return jsonResponse(body, status);
      }
      // (removed) `POST /health/ready/retry` — pre-0.2.0 endpoint that reset
      // DeferredInitState to `pending` and returned 202 promising a re-run,
      // but no in-process re-runner exists (the deferred init block is a
      // single IIFE). The renderer never observed progress and was misled.
      // Retry today is a process restart; if/when an extracted re-callable
      // init lands we can reintroduce a real retry endpoint.

      // 📦 Pattern 2 §2.3.1 — Large-value ref retrieval. SSE / IPC payloads
      // over the spill threshold leave a `{kind:'ref', id, ...}` placeholder
      // here; consumers fetch the full body via this endpoint. Streamed via
      // createReadStream so multi-MB bodies don't get loaded into memory.
      // Bypasses the deferred-init gate — refs are independent of agent
      // state, and the /chat/* SSE consumer may be mid-replay during init.
      if (pathname.startsWith('/refs/') && request.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/refs/'.length));
        // Mirror the strict regex inside large-value-store.getRefStreamPath:
        // 8–32 lowercase hex (uuid-prefix shape). The route check used to be
        // looser (`/^[a-f0-9]+$/i`, no length cap, case-insensitive), which
        // meant attacker-style upper-case probes returned 404 from the inner
        // store after also satisfying the route — defense-in-depth without
        // observable behavior change for legitimate refs.
        if (!id || !/^[a-f0-9]{8,32}$/.test(id)) {
          return jsonResponse({ error: 'invalid ref id' }, 400);
        }
        const { getRefStreamPath } = await import('./utils/large-value-store');
        const refInfo = await getRefStreamPath(id);
        if (!refInfo) {
          return jsonResponse({ error: 'ref not found or expired' }, 404);
        }
        // Stream from disk so multi-MB bodies don't buffer into memory.
        //
        // `Access-Control-Allow-Origin: *` is the load-bearing header here
        // (issue #109 root cause). The renderer's proxyFetch pulls this URL
        // via WebKit's native `fetch()` (the spill path bypasses Tauri IPC
        // because the body is too large to ship through the invoke channel).
        // Without an explicit ACAO header, WebKit/WKWebView silently rejects
        // the response as opaque cross-origin and surfaces it to JS as the
        // notoriously diagnostic-free `TypeError: Load failed`. Other
        // sidecar paths skip CORS because they go through Tauri IPC, which
        // bypasses the browser's same-origin machinery entirely; this one
        // doesn't, so it must opt in. Use `*` (not the renderer's origin)
        // because the sidecar is bound to 127.0.0.1 and trusts everything
        // on loopback already.
        const fr = await fileResponse(refInfo.path, {
          contentType: refInfo.mimetype,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        });
        if (!fr) {
          return jsonResponse({ error: 'ref body missing' }, 404);
        }
        return fr;
      }

      // ── Deferred init gate ────────────────────────────────────────────────
      // All other routes depend on agent state (currentAgentDir, MCP servers,
      // session metadata, bridge handler). Pattern 4: instead of awaiting
      // the bare promise (which either blocks indefinitely or rethrows as a
      // 500 on failure), consult the state machine and return a structured
      // 503 if init is pending/phase/failed. Once `kind === 'ready'`, the
      // gate is a no-op (sub-µs) for steady-state requests.
      const gate = buildGateResponseBody();
      if (gate) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (gate.body.state === 'pending' || gate.body.state === 'phase') {
          headers['Retry-After'] = '1';
        }
        return new Response(JSON.stringify(gate.body), { status: gate.status, headers });
      }

      // Tool attachment endpoint (PRD 0.2.15) — rich-media tool outputs (image/audio/pdf/file).
      // URL shape: GET /api/attachment/tool/<sessionId>/<turnId>/<filename>
      //
      // Resolution:
      //   1. Look up the external-path registry (Codex savedPath, dynamic URLs after fetch).
      //      Hit → serve that real path.
      //   2. Miss → fall back to the trusted attachment root <home>/.myagents/generated/
      //      tool-attachments/<s>/<t>/<f> (where base64 / URL downloads land).
      //
      // Security: the registry only holds paths registered by saveToolAttachment, which
      // pre-validated them via validateExternalReadPathNode (system/credential blacklist).
      // The trusted-root fallback is by construction inside the MyAgents-owned tree.
      if (pathname.startsWith('/api/attachment/tool/') && request.method === 'GET') {
        // Codex review EP1: decodeURIComponent throws URIError on malformed
        // %xx escapes — wrap explicitly so we return 400 (with CORS) instead
        // of crashing the request and leaving the renderer with an opaque error.
        let rest: string;
        try {
          rest = decodeURIComponent(pathname.slice('/api/attachment/tool/'.length));
        } catch {
          return new Response('Bad Request', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const segs = rest.split('/').filter(Boolean);
        if (segs.length !== 3) {
          return new Response('Bad Request', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const [sid, tid, fname] = segs;
        // Guard against `..` / `/` / `\` / control chars in any segment.
        const hasUnsafeChar = (s: string): boolean => {
          if (s.includes('..')) return true;
          for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            if (code < 0x20) return true;
            if (s[i] === '/' || s[i] === '\\') return true;
          }
          return false;
        };
        if (segs.some(hasUnsafeChar)) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        let realPath = lookupExternalAttachment(sid, tid, fname);
        if (!realPath) {
          // Fall back to the trusted root for base64/URL-downloaded attachments.
          realPath = join(getToolAttachmentRoot(), sid, tid, fname);
        }
        // Defense-in-depth: blacklist check (paths in registry have already passed,
        // but if a session-resume rebuild ever fed in a bad path we'd refuse here).
        const check = validateExternalReadPathNode(realPath);
        if (!check.ok) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const fileResp = await fileResponse(check.canonical, {
          contentType: sniffMime(check.canonical),
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
        return fileResp ?? new Response('Not Found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Browser dev-mode fallback for attachment files.
      // Production uses the Tauri `myagents://attachment/<path>` custom protocol
      // (`src-tauri/src/attachment_protocol.rs`) which serves bytes directly
      // through WebKit without round-tripping JSON. In dev (vite + browser) the
      // custom scheme isn't registered, so this route serves the same bytes
      // via a plain HTTP GET. fileResponse() streams via createReadStream to
      // avoid buffering large attachments.
      if (pathname.startsWith('/api/attachment/') && request.method === 'GET') {
        const rel = decodeURIComponent(pathname.replace('/api/attachment/', ''));
        // Reject path traversal: no `..` segments and no absolute paths.
        if (rel.includes('..') || rel.startsWith('/')) {
          return new Response('Forbidden', { status: 403 });
        }
        const absolute = getAttachmentPath(rel);
        const fileResp = await fileResponse(absolute, {
          contentType: sniffMime(absolute),
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
        return fileResp ?? new Response('Not Found', { status: 404 });
      }

      // Session state endpoint - used by Rust background completion polling
      if (pathname === '/api/session-state' && request.method === 'GET') {
        const sessionState = shouldUseExternalRuntime()
          ? getExternalSessionState()
          : getAgentState().sessionState;
        return jsonResponse({ sessionState });
      }

      // Read historical session messages from SDK's persisted session files (v0.2.59+)
      // Works without an active Sidecar — reads directly from .claude/ session data
      if (pathname === '/api/session/messages' && request.method === 'GET') {
        const sdkSessionId = url.searchParams.get('sdkSessionId');
        if (!sdkSessionId) {
          return jsonResponse({ success: false, error: 'sdkSessionId is required' }, 400);
        }
        const dir = url.searchParams.get('dir') || undefined;
        const rawLimit = url.searchParams.get('limit');
        const rawOffset = url.searchParams.get('offset');
        const limit = rawLimit ? (Number.isFinite(+rawLimit) && +rawLimit >= 0 ? Math.floor(+rawLimit) : undefined) : undefined;
        const offset = rawOffset ? (Number.isFinite(+rawOffset) && +rawOffset >= 0 ? Math.floor(+rawOffset) : undefined) : undefined;
        try {
          const messages = await getHistoricalSessionMessages(sdkSessionId, dir, limit, offset);
          return jsonResponse({ success: true, messages });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read session messages' },
            500
          );
        }
      }

      // 🔍 Debug endpoint: Expose logger diagnostics via HTTP
      if (pathname === '/debug/logger' && request.method === 'GET') {
        const diagnostics = getLoggerDiagnostics();
        const clientsCount = getClients().length;
        return jsonResponse({
          ...diagnostics,
          currentClientsCount: clientsCount,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      if (pathname === '/chat/stream' && request.method === 'GET') {
        // Pattern 1: a new SSE consumer cancels any pending "last consumer
        // disconnect" grace timer — the renderer just reconnected, no
        // interrupt needed.
        cancelLastConsumerGrace();
        const { client, response } = createSseClient(handleChatStreamClose);
        const state = shouldUseExternalRuntime()
          ? { ...getAgentState(), sessionState: getExternalSessionState() }
          : getAgentState();
        client.send('chat:init', state);
        const allMessages = getMessages();
        // When a turn is in-flight, skip the streaming assistant message.
        // Live SSE events (thinking-start, thinking-chunk, message-chunk) will build it from
        // scratch. Replaying it here would create a duplicate in historyMessages alongside the
        // streamingMessage being assembled from live events → duplicate thinking blocks.
        // Filter by message ID (not array position) because mid-turn queued user messages
        // can appear after the streaming assistant in messages[].
        const streamingId = getStreamingAssistantId();
        allMessages.forEach((message) => {
          if (streamingId && message.id === streamingId) return; // skip streaming message
          // Strip Playwright tool results from replay to avoid sending large base64 data to frontend
          const stripped = typeof message.content !== 'string'
            ? { ...message, content: stripPlaywrightResults(message.content) }
            : message;
          client.send('chat:message-replay', { message: stripped });
        });
        client.send('chat:logs', { lines: getLogLines() });
        if (shouldUseExternalRuntime()) {
          const externalSystemInitPayload = getExternalSystemInitPayload();
          if (externalSystemInitPayload) {
            client.send('chat:system-init', externalSystemInitPayload);
          }
        } else {
          const systemInitInfo = getSystemInitInfo();
          if (systemInitInfo) {
            client.send('chat:system-init', { info: systemInitInfo });
          }
        }
        // Replay pending interactive requests (permission, ask-user-question)
        // so that a Tab joining mid-session can display and respond to them.
        const pendingRequests = shouldUseExternalRuntime()
          ? getExternalPendingInteractiveRequests()
          : getPendingInteractiveRequests();
        for (const pending of pendingRequests) {
          client.send(pending.type, pending.data);
        }
        return response;
      }

      if (pathname === '/chat/send' && request.method === 'POST') {
        let payload: SendMessagePayload;
        try {
          payload = (await request.json()) as SendMessagePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        const text = payload?.text?.trim() ?? '';
        const images = payload?.images ?? [];
        const permissionMode = payload?.permissionMode ?? 'auto';
        const model = payload?.model;
        const providerEnv = payload?.providerEnv;

        // Allow sending with just images or just text
        if (!text && images.length === 0) {
          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);
        }

        // ─── External Runtime branch (v0.1.59) ───
        if (shouldUseExternalRuntime()) {
          const runtimeType = getActiveRuntimeType();
          console.log(`[chat] send via ${runtimeType}: text="${text.slice(0, 200)}"`);

          // Issue #188 — Fire-and-forget dispatch via enqueueExternalSendForDesktop.
          //
          // sendExternalMessage internally serializes against in-flight turns
          // by awaiting waitForExternalSessionIdle(5 * 60 * 1000). That wait
          // exceeds the Rust SSE proxy's HTTP_PROXY_TIMEOUT_SECS=120s cap, so
          // if a long Codex/Gemini turn is mid-flight the HTTP request dies
          // at 120s and the renderer surfaces it as "AI 调用失败：网络错误"
          // even though the sidecar is healthy.
          //
          // enqueueExternalSendForDesktop synchronously broadcasts the user
          // bubble so the renderer shows it immediately, then chains the
          // wait+dispatch onto a module-level tail so concurrent desktop
          // sends serialize cleanly (otherwise they'd all wake from the same
          // turnCompleted gate and race to write to the persistent runtime).
          // Errors that previously came back over HTTP now broadcast via
          // chat:agent-error — the renderer already routes that event to the
          // same agentError state the HTTP .then(response.error) branch used.
          //
          // Note: cron/IM internal callers still `await` sendExternalMessage
          // directly (they're inside the sidecar event loop, no 120s ceiling,
          // and already single-flighted at the caller level).
          const sendCtx = {
            sessionId: getSessionId(),
            workspacePath: agentDir,
            scenario: { type: 'desktop' as const },
            permissionMode,
            model: model ?? undefined,
          };
          void enqueueExternalSendForDesktop(text, images, permissionMode, model ?? undefined, sendCtx)
            .then((result) => {
              if (!result.queued && result.error) {
                console.error(`[chat] external send failed: ${result.error}`);
                broadcast('chat:agent-error', { message: result.error });
              }
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[chat] external send threw: ${msg}`);
              broadcast('chat:agent-error', { message: msg });
            });
          return jsonResponse({ success: true, queued: true });
        }

        // ─── Builtin Runtime (existing path) ───
        try {
          const providerLabel = typeof providerEnv === 'object' ? providerEnv?.baseUrl ?? 'anthropic' : (providerEnv ?? 'anthropic');
          console.log(`[chat] send text="${text.slice(0, 200)}" images=${images.length} mode=${permissionMode} model=${model ?? 'default'} baseUrl=${providerLabel}`);
          // PRD 0.2.14 — tag desktop-origin messages so the desktop→IM mirror
          // (im-mirror.ts) can opt this turn into channel fan-out. Without
          // this, agent-session.ts sees `metadata?.source === undefined` and
          // skips the mirror call.
          const result = await enqueueUserMessage(
            text,
            images,
            permissionMode,
            model,
            providerEnv,
            { source: 'desktop' as SessionSource },
          );
          if (result.error) {
            return jsonResponse({ success: false, error: result.error }, 429);
          }
          return jsonResponse({
            success: true,
            queued: result.queued,
            queueId: result.queueId,
            isInFlight: result.isInFlight,
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/chat/stop' && request.method === 'POST') {
        try {
          console.log('[chat] stop');

          // External Runtime: stop the subprocess
          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            const stopped = await stopExternalSession();
            return jsonResponse({ success: true, alreadyStopped: !stopped });
          }

          // Builtin Runtime: existing path
          const stopped = await interruptCurrentResponse();
          if (!stopped) {
            return jsonResponse({ success: true, alreadyStopped: true });
          }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // ─── Runtime API endpoints (v0.1.59) ───

      if (pathname === '/api/runtime/type' && request.method === 'GET') {
        return jsonResponse({ runtime: getActiveRuntimeType() });
      }

      if (pathname === '/api/runtime/models' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!type) return jsonResponse({ error: 'Missing type parameter' }, 400);
        try {
          const models = await queryRuntimeModels(type as import('../shared/types/runtime').RuntimeType);
          return jsonResponse({ models });
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
        }
      }

      if (pathname === '/api/runtime/permission-modes' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!type) return jsonResponse({ error: 'Missing type parameter' }, 400);
        const modes = getRuntimePermissionModes(type as import('../shared/types/runtime').RuntimeType);
        return jsonResponse({ modes });
      }

      if (pathname === '/api/runtime/config' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          runtime?: string;
          runtimeConfig?: {
            model?: string | null;
            permissionMode?: string | null;
          } | null;
        };
        const activeRuntime = getActiveRuntimeType();
        if (activeRuntime === 'builtin') {
          return jsonResponse({ success: false, error: 'Runtime config endpoint is only for external runtimes' }, 400);
        }
        if (body.runtime && body.runtime !== activeRuntime) {
          return jsonResponse({ success: false, error: `Runtime mismatch: sidecar=${activeRuntime}, payload=${body.runtime}` }, 400);
        }

        const runtimeConfig = body.runtimeConfig ?? {};
        if ('model' in runtimeConfig) {
          await setExternalModel(runtimeConfig.model ?? '');
        }
        if ('permissionMode' in runtimeConfig) {
          await setExternalPermissionMode(runtimeConfig.permissionMode ?? '');
        }

        return jsonResponse({ success: true, runtime: activeRuntime });
      }

      // Pre-warm the external runtime process (v0.1.68)
      //
      // Called by the frontend when a Chat tab opens a Gemini/Codex session.
      // Spawns the CLI, completes the JSON-RPC handshake, and opens a session
      // so the user's first message can hit sendExternalMessage Case 3 (write
      // to stdin of an already-warm process) instead of paying the ~11s cold
      // boot — which on Gemini includes base-prompt extraction + session/new
      // round-trips over the ACP channel.
      //
      // Idempotent + fire-safe: the endpoint short-circuits if a session is
      // already active/starting, and relies on prewarmExternalSession to skip
      // non-persistent runtimes (CC -p mode) with a reason string.
      if (pathname === '/api/runtime/prewarm' && request.method === 'POST') {
        if (!shouldUseExternalRuntime()) {
          return jsonResponse({ success: false, error: 'Pre-warm is only for external runtimes' }, 400);
        }
        const body = (await request.json().catch(() => ({}))) as {
          sessionId?: string;
          model?: string;
          permissionMode?: string;
        };
        const sessionId = body.sessionId || getSessionId();
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'No sessionId available' }, 400);
        }
        try {
          const result = await prewarmExternalSession({
            sessionId,
            workspacePath: currentAgentDir,
            scenario: { type: 'desktop' },
            model: body.model,
            permissionMode: body.permissionMode,
          });
          return jsonResponse({ success: true, ...result });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500,
          );
        }
      }

      if (pathname === '/api/runtime/permission-response' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const requestId = body.requestId as string;
        // Accept both legacy { approved: boolean } and new { decision: enum } format
        const decision: 'deny' | 'allow_once' | 'always_allow' = (body.decision as string) === 'deny' ? 'deny'
          : (body.decision as string) === 'always_allow' ? 'always_allow'
          : (body.decision as string) === 'allow_once' ? 'allow_once'
          : (body.approved === true) ? 'allow_once' : 'deny';
        const reason = body.reason as string | undefined;
        if (!requestId) return jsonResponse({ error: 'Missing requestId' }, 400);
        try {
          await respondExternalPermission(requestId, decision, reason);
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
        }
      }

      // CC SessionStart hook receiver (v0.1.59)
      // CC fires this hook when a session starts/resumes/compacts.
      // The forwarder script (cc-session-hook-forwarder.cjs) POSTs the hook input here.
      if (pathname === '/hook/session-start' && request.method === 'POST') {
        try {
          const hookData = (await request.json()) as Record<string, unknown>;
          const ccSessionId = (hookData.session_id as string) || (hookData.sessionId as string) || '';
          if (ccSessionId) {
            console.log(`[hook] CC SessionStart: session_id=${ccSessionId}, source=${hookData.source}`);
            // Import and update the external session's CC session ID
            const { setRuntimeSessionId } = await import('./runtimes/external-session');
            setRuntimeSessionId(ccSessionId);
          }
          return jsonResponse({ ok: true });
        } catch {
          return jsonResponse({ ok: false }, 500);
        }
      }

      // Rewind session to a specific user message (time travel)
      if (pathname === '/chat/rewind' && request.method === 'POST') {
        if (shouldUseExternalRuntime()) {
          return jsonResponse({ success: false, error: 'Rewind is not supported for external runtimes (CC/Codex)' }, 400);
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
        if (!userMessageId) {
          return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
        }
        const result = await rewindSession(userMessageId);
        return jsonResponse(result);
      }

      // External-runtime retry: truncate the failed user turn from
      // allSessionMessages and return its content for re-send. Builtin uses
      // /chat/rewind which has SDK resume-anchor + file-checkpoint semantics;
      // external runtimes don't have those, but a "drop the tail + resend"
      // semantic is still sound when the previous turn never produced an
      // assistant message (model capacity, network error, etc.). Issue #192.
      if (pathname === '/chat/external-retry' && request.method === 'POST') {
        if (!shouldUseExternalRuntime()) {
          return jsonResponse({ success: false, error: 'external-retry is only for external runtimes; builtin uses /chat/rewind' }, 400);
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
        if (!userMessageId) {
          return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
        }
        const result = await popLastUserMessageForRetry(userMessageId);
        return jsonResponse(result);
      }

      // Fork session at a specific assistant message (create branch)
      if (pathname === '/sessions/fork' && request.method === 'POST') {
        if (shouldUseExternalRuntime()) {
          return jsonResponse({ success: false, error: 'Fork is not supported for external runtimes (CC/Codex)' }, 400);
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const messageId = typeof body.messageId === 'string' ? body.messageId : '';
        if (!messageId) {
          return jsonResponse({ success: false, error: 'Missing messageId' }, 400);
        }
        const result = await forkSession(messageId);
        return jsonResponse(result);
      }

      // Cancel a queued message
      if (pathname === '/chat/queue/cancel' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        const cancelledText = cancelQueueItem(queueId);
        if (cancelledText === null) {
          return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
        }
        return jsonResponse({ success: true, cancelledText });
      }

      // Force-execute a queued message (interrupt current + run queued)
      if (pathname === '/chat/queue/force' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        try {
          const result = await forceExecuteQueueItem(queueId);
          if (!result) {
            return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
          }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Get queue status
      if (pathname === '/chat/queue/status' && request.method === 'GET') {
        return jsonResponse({ success: true, queue: getQueueStatus() });
      }

      // Poll background task output file for live stats
      if (pathname === '/api/task/poll-background' && request.method === 'POST') {
        try {
          const body = await request.json() as { outputFile?: string; offset?: number };
          const { outputFile, offset = 0 } = body;

          // Validate outputFile path: resolve to canonical path then verify it falls
          // under the user's home directory and matches expected suffix.
          // This prevents path traversal attacks (e.g., "/../../../etc/passwd.output").
          if (!outputFile || typeof outputFile !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }
          const resolvedOutputFile = resolve(outputFile);
          const homeDir = getHomeDirOrNull() || '';
          const isUnderHome = homeDir && resolvedOutputFile.startsWith(homeDir + sep);
          if (!isUnderHome || !resolvedOutputFile.endsWith('.output')) {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }

          // Check file existence
          if (!existsSync(resolvedOutputFile)) {
            return jsonResponse({ success: true, stats: null, newOffset: 0, isComplete: false });
          }

          const fileStat = statSync(resolvedOutputFile);
          const fileSize = fileStat.size;

          // No new data
          if (offset >= fileSize) {
            return jsonResponse({ success: true, stats: null, newOffset: offset, isComplete: false });
          }

          // Read incremental data (cap at 1MB)
          const MAX_READ = 1024 * 1024;
          const readEnd = Math.min(offset + MAX_READ, fileSize);
          const { open } = await import('node:fs/promises');
          const fh = await open(resolvedOutputFile, 'r');
          let text: string;
          try {
            const length = readEnd - offset;
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);
            text = buf.toString('utf8');
          } finally {
            await fh.close();
          }

          // Parse JSONL lines
          let toolCount = 0;
          let assistantCount = 0;
          let userCount = 0;
          let progressCount = 0;
          let firstTimestamp = 0;
          let lastTimestamp = 0;
          let lastLineType = '';
          let lastLineHasToolUse = false;

          const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
              if (ts && !firstTimestamp) firstTimestamp = ts;
              if (ts) lastTimestamp = ts;

              if (parsed.type === 'assistant') {
                assistantCount++;
                lastLineType = 'assistant';
                lastLineHasToolUse = false;
                // Count tool_use blocks in content
                if (Array.isArray(parsed.message?.content)) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_use') {
                      toolCount++;
                      lastLineHasToolUse = true;
                    }
                  }
                }
              } else if (parsed.type === 'user') {
                userCount++;
                lastLineType = 'user';
                lastLineHasToolUse = false;
              } else if (parsed.type === 'progress') {
                progressCount++;
              }
            } catch {
              // Skip truncated/invalid lines
            }
          }

          const elapsed = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;

          // Detect completion: last line is assistant with only text (no tool_use)
          const isComplete = lastLineType === 'assistant' && !lastLineHasToolUse;

          return jsonResponse({
            success: true,
            stats: { toolCount, assistantCount, userCount, progressCount, elapsed },
            newOffset: readEnd,
            isComplete
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Reset session for "new conversation" - clears all messages and state
      if (pathname === '/chat/reset' && request.method === 'POST') {
        try {
          console.log('[chat] reset (new conversation)');
          // Stop external runtime subprocess if active (prevents orphaned processes)
          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            await stopExternalSession();
          }
          await resetSession();
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // ============= CRON TASK API =============

      // GET /cron/check-completion - Check if the last response indicates task completion
      if (pathname === '/cron/check-completion' && request.method === 'GET') {
        try {
          const messages = getMessages();
          const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');

          if (!lastAssistantMessage) {
            return jsonResponse({ success: true, completed: false, reason: null });
          }

          // Extract text content from the message
          let textContent = '';
          if (typeof lastAssistantMessage.content === 'string') {
            textContent = lastAssistantMessage.content;
          } else if (Array.isArray(lastAssistantMessage.content)) {
            textContent = lastAssistantMessage.content
              .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
              .map(block => block.text)
              .join('\n');
          }

          // Check for completion marker
          const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
          if (completionMatch) {
            return jsonResponse({
              success: true,
              completed: true,
              reason: completionMatch[1].trim()
            });
          }

          return jsonResponse({ success: true, completed: false, reason: null });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // POST /cron/execute - Execute a scheduled task
      // This endpoint wraps the user's prompt with cron-specific instructions
      // and enables the exit_cron_task custom tool
      if (pathname === '/cron/execute' && request.method === 'POST') {
        let payload: CronExecutePayload;
        try {
          payload = (await request.json()) as CronExecutePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const { taskId, prompt, aiCanExit, model, providerEnv, intervalMinutes, executionNumber } = payload;

        if (!taskId || !prompt) {
          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);
        }

        // Get current session ID for context isolation
        const currentSessionId = getSessionId();

        // Set cron task context so the exit_cron_task tool knows which task is running
        // Pass sessionId for proper isolation between concurrent tasks
        setCronTaskContext(taskId, aiCanExit ?? false, currentSessionId);

        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)
        setInteractionScenario({
          type: 'cron',
          taskId,
          intervalMinutes: intervalMinutes ?? 15,
          aiCanExit: aiCanExit ?? false,
        });

        try {
          console.log(`[cron] execute taskId=${taskId} sessionId=${currentSessionId} interval=${intervalMinutes}min exec#=${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);
          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)
          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;

          // PRD #119: intent-driven resolution — see /cron/execute-sync for
          // the full design comment. This endpoint runs against whatever
          // session is already loaded (no session switch), so the snapshot
          // path operates on the current session's metadata. For Subscription
          // / Explicit intents we bypass the snapshot entirely and use the
          // payload's values directly.
          // PRD 0.2.9: provider routing precedence:
          //   1. payload.providerId (new) — live-resolve from config.json on
          //      every tick. This is the path used by Task Center + the
          //      collapsed Launcher/Chat/IM-cron writers (PRD 0.2.9 R7).
          //   2. payload.providerIntent (legacy #119 path) — kept for in-flight
          //      cron tasks persisted by 0.2.8 and earlier.
          //   3. neither — followAgent (snapshot resolve from session meta).
          const intent = payload.providerIntent ?? 'followAgent';
          let effectiveModel = model;
          let effectiveProviderEnv: ProviderEnv | 'subscription' | undefined = providerEnv;
          let effectiveRuntimeConfig = payload.runtimeConfig;

          if (payload.providerId) {
            // PRD 0.2.9 — Per-tick live-resolve. Throws on missing provider /
            // missing apiKey; we surface as 400 and let Rust mark Task Blocked.
            try {
              effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              console.error(`[cron] execute: provider resolution failed for '${payload.providerId}': ${errMsg}`);
              clearCronTaskContext(currentSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: errMsg }, 400);
            }
            if (payload.model) effectiveModel = payload.model;
            if (effectiveRuntimeConfig) {
              effectiveRuntimeConfig = { ...effectiveRuntimeConfig, model: payload.model ?? effectiveRuntimeConfig.model };
            }
            console.log(`[cron] execute providerId=${payload.providerId} resolved=${effectiveProviderEnv === 'subscription' ? 'subscription' : (effectiveProviderEnv as ProviderEnv).baseUrl ?? 'anthropic'} model=${effectiveModel ?? 'default'}`);
          } else if (intent === 'followAgent') {
            if (currentSessionId) {
              const sessionMeta = getSessionMetadata(currentSessionId);
              const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;
              if (sessionMeta && agent) {
                const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');
                if (resolved.model !== undefined) effectiveModel = resolved.model;
                if (resolved.providerEnvJson) {
                  try {
                    effectiveProviderEnv = JSON.parse(resolved.providerEnvJson) as ProviderEnv;
                  } catch (e) {
                    console.warn(`[cron] execute followAgent: failed to parse providerEnvJson for session ${currentSessionId}, falling back to task-frozen value`, e);
                  }
                } else if (resolved.providerId) {
                  // Issue #197 — agent persists `providerId` (post-PRD 0.2.9
                  // canonical state) but rarely a frozen `providerEnvJson`,
                  // so the snapshot path was dropping provider context for
                  // CLI/legacy crons that came in with intent=FollowAgent.
                  // Live-resolve env from providerId so the SDK gets the
                  // right ANTHROPIC_API_KEY/BASE_URL instead of falling
                  // back to subscription (apiKeySource=none, model=
                  // claude-sonnet-4-6 default).
                  try {
                    const env = resolveProviderEnv(resolved.providerId);
                    if (env) {
                      effectiveProviderEnv = env as ProviderEnv;
                      // Pair model with provider when neither snapshot nor
                      // agent has one — without this, SDK uses its default.
                      if (effectiveModel === undefined) {
                        const provider = findProvider(resolved.providerId);
                        const primary = provider
                          ? (provider as Record<string, unknown>).primaryModel as string | undefined
                          : undefined;
                        if (primary) effectiveModel = primary;
                      }
                    }
                  } catch (e) {
                    console.warn(`[cron] execute followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${currentSessionId}`, e);
                  }
                }
                if (resolved.runtime !== 'builtin') {
                  effectiveRuntimeConfig = {
                    ...(payload.runtimeConfig ?? {}),
                    model: resolved.model ?? payload.runtimeConfig?.model,
                    permissionMode: resolved.permissionMode ?? payload.runtimeConfig?.permissionMode,
                  };
                }
              }
            }
            // Backward-compat with the pre-#119 pragmatic fix — see /cron/execute-sync above.
            if (payload.model) effectiveModel = payload.model;
            if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;
          } else if (intent === 'subscription') {
            // PRD 0.2.9 R1 — pass the explicit 'subscription' sentinel (NOT
            // undefined) so `enqueueUserMessage` clears the session's current
            // providerEnv. Passing undefined here was the original bug:
            // agent-session.ts:5381-5383 treats undefined as "keep current".
            effectiveProviderEnv = 'subscription';
            if (payload.model) effectiveModel = payload.model;
            if (effectiveRuntimeConfig) {
              effectiveRuntimeConfig = { ...effectiveRuntimeConfig, model: payload.model ?? effectiveRuntimeConfig.model };
            }
          } else if (intent === 'explicit') {
            if (!payload.providerEnv) {
              console.error(`[cron] execute intent=explicit but payload.providerEnv is missing — refusing to run`);
              clearCronTaskContext(currentSessionId);
              resetInteractionScenario();
              return jsonResponse({
                success: false,
                error: 'Cron task has explicit provider intent but no providerEnv — task data is malformed.',
              }, 400);
            }
            effectiveProviderEnv = payload.providerEnv;
            if (payload.model) effectiveModel = payload.model;
            if (effectiveRuntimeConfig) {
              effectiveRuntimeConfig = { ...effectiveRuntimeConfig, model: payload.model ?? effectiveRuntimeConfig.model };
            }
          }

          // Cron tasks are unattended — "user didn't pick" must map to the
          // runtime's MAX permission (not its interactive default), or
          // WebSearch / Bash / mcp__* sit in the approval queue until the
          // 10-minute deadline kills the run. Sentinels for "didn't pick" are
          // undefined and empty string. PRD 0.2.5 R2 / regression of 07bc560d.
          const cronRuntimeType: RuntimeType = shouldUseExternalRuntime() ? getActiveRuntimeType() : 'builtin';
          const effectivePermissionMode = resolveCronPermissionMode(
            payload.permissionMode,
            effectiveRuntimeConfig?.permissionMode,
            cronRuntimeType,
          );

          if (shouldUseExternalRuntime()) {
            const runtimeResult = await sendExternalMessage(
              wrappedPrompt, undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'cron', taskId, intervalMinutes: intervalMinutes ?? 15, aiCanExit: aiCanExit ?? false },
                permissionMode: effectivePermissionMode,
                model: getRuntimeConfigModel(effectiveRuntimeConfig ?? null),
              },
            );
            if (!runtimeResult.queued) {
              return jsonResponse({ success: false, error: runtimeResult.error ?? 'Failed to start cron via external runtime' }, 503);
            }
          } else {
            await enqueueUserMessage(wrappedPrompt, [], effectivePermissionMode as PermissionMode, effectiveModel, effectiveProviderEnv);
          }
          // Reset scenario after enqueue — already consumed by startStreamingSession()
          resetInteractionScenario();
          return jsonResponse({ success: true });
        } catch (error) {
          // Clear context on error
          clearCronTaskContext(currentSessionId);
          resetInteractionScenario();
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // POST /cron/execute-sync - Execute a scheduled task synchronously
      // This endpoint is used by Rust for direct Sidecar invocation without frontend
      // It waits for the execution to complete and returns the result
      if (pathname === '/cron/execute-sync' && request.method === 'POST') {
        console.log('[cron] execute-sync: endpoint matched');

        let payload: CronExecutePayload;
        try {
          payload = (await request.json()) as CronExecutePayload;
          console.log('[cron] execute-sync: payload parsed', { taskId: payload.taskId, hasPrompt: !!payload.prompt, runMode: payload.runMode });
        } catch (e) {
          console.error('[cron] execute-sync: JSON parse error', e);
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const { taskId, prompt, sessionId, aiCanExit, model, providerEnv, runMode, intervalMinutes, executionNumber } = payload;

        if (!taskId || !prompt) {
          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);
        }

        // Wrap the entire cron handler body in `withCronDispatchLock` so two
        // concurrent ticks within a single sidecar can't interleave on
        // shared global state — `currentMcpServers`, the active session,
        // `cronTaskContext`, `interactionScenario`. Without this, request
        // A's session switch / scenario could be silently overwritten by
        // request B before A reaches `enqueueUserMessage`. PRD 0.2.4 §3.6
        // (cross-review B7).
        return await withCronDispatchLock(async () => {
        // Handle session setup based on runMode
        const effectiveRunMode = runMode ?? 'single_session';
        const { agentDir } = getAgentState();

        // Clear any existing cron context before switching sessions
        // This prevents context pollution when sessions change
        clearCronTaskContext();

        let effectiveSessionId = sessionId;

        if (effectiveRunMode === 'new_session') {
          // Create a fresh session for each execution (no memory of previous runs).
          // v0.1.69: Cron new_task ticks are structurally 'owned' — every tick reads the
          // current Agent and freezes a snapshot into the new SessionMetadata. Per-tick
          // freshness keeps "live-follow" semantics for cron without inventing a third
          // owner kind in resolveSessionConfig (PRD D4 footnote).
          const cronAgent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;
          const cronSnapshot: Partial<SessionMetadata> = cronAgent ? snapshotForOwnedSession(cronAgent) : {};
          // PRD #119: stamp the cron's explicit routing intent into the
          // freshly-built snapshot. For Subscription / Explicit intents,
          // the snapshot reflects the cron's own provider — NOT the agent's
          // — so other readers (session details panel, history view) see
          // an accurate record of what config the run actually used. This
          // also lets the unified `resolveSessionConfig` path read back the
          // right values without intent-aware branching at read time.
          // PRD 0.2.9 — When `providerId` is set on the payload, the
          // session metadata snapshot tracks it (so the resolved env can
                  // be re-derived per tick by the runtime resolver), and
          // pre-#119 fields are explicitly cleared. This precedence runs
          // BEFORE the legacy intent path below so a corrupt payload
          // carrying both `providerId` and `providerEnv` can't poison the
          // snapshot with the latter (Codex P2.1 finding).
          if (payload.providerId) {
            cronSnapshot.providerId = payload.providerId;
            cronSnapshot.providerEnvJson = undefined;
            if (payload.model) cronSnapshot.model = payload.model;
          } else {
            const cronIntent = payload.providerIntent ?? 'followAgent';
            if (cronIntent === 'subscription') {
              cronSnapshot.providerId = undefined;
              cronSnapshot.providerEnvJson = undefined;
              if (payload.model) cronSnapshot.model = payload.model;
            } else if (cronIntent === 'explicit' && payload.providerEnv) {
              cronSnapshot.providerId = undefined;
              cronSnapshot.providerEnvJson = JSON.stringify(payload.providerEnv);
              if (payload.model) cronSnapshot.model = payload.model;
            }
            // FollowAgent (legacy): cronSnapshot keeps the agent's values verbatim.
          }
          const overrideRuntime = payload.runtime ?? getActiveRuntimeType();
          if (overrideRuntime) cronSnapshot.runtime = overrideRuntime;
          // PRD 0.2.4 §需求 4 — stamp per-task MCP override into the new
          // session's metadata BEFORE creation, so the session is born with
          // the right MCP set. The setMcpServers() call further down still
          // runs for safety, but for new_session mode it's typically a
          // no-op because the snapshot already matches the override.
          if (payload.mcpEnabledServers !== undefined) {
            cronSnapshot.mcpEnabledServers = payload.mcpEnabledServers;
          }
          // Rust rotates a fresh UUID per tick for new_session mode (see
          // cron_task.rs::rotate_new_session_id) and passes it as
          // payload.sessionId. Honour that id here — if we generated our
          // own instead, Rust's ManagedSidecar registry would be keyed by
          // the Rust-chosen id while the actual running session used a
          // different Bun-chosen id, and opening the session via history
          // would spawn a duplicate read-only sidecar (Bug A, v0.1.69).
          //
          // Fallback to a fresh random id only when payload.sessionId is
          // missing — keeps backward-compat with older Rust builds that
          // didn't pre-generate the id.
          if (sessionId) {
            cronSnapshot.id = sessionId;
          }
          const newSession = await createSession(agentDir, cronSnapshot);
          const switched = await switchToSession(newSession.id);
          if (!switched) {
            console.error(`[cron] execute-sync taskId=${taskId} failed to switch to new session ${newSession.id}`);
            return jsonResponse({ success: false, error: 'Failed to create new session for execution.' }, 500);
          }
          effectiveSessionId = newSession.id;
          console.log(`[cron] execute-sync taskId=${taskId} new_session mode: created fresh session ${newSession.id} (from=${sessionId ? 'rust-payload' : 'bun-fallback'})`);
        } else if (sessionId) {
          // single_session mode: switch to the task's stored session (keeps context)
          // If already in the target session, skip switchToSession to avoid aborting
          // an active AI response and clearing the message queue.
          const currentSessionId = getSessionId();
          if (currentSessionId === sessionId) {
            console.log(`[cron] execute-sync taskId=${taskId} single_session mode: already in session ${sessionId}, skipping switch`);
          } else {
            console.log(`[cron] execute-sync taskId=${taskId} attempting to switch to session ${sessionId}`);
            const switched = await switchToSession(sessionId);
            if (!switched) {
              console.warn(`[cron] execute-sync taskId=${taskId} failed to switch to session ${sessionId}, will use current session instead`);
              // Log current session state for debugging
              const currentState = getAgentState();
              console.log(`[cron] execute-sync taskId=${taskId} current session state: agentDir=${currentState.agentDir}, sessionState=${currentState.sessionState}, hasInitialPrompt=${currentState.hasInitialPrompt}`);
            } else {
              console.log(`[cron] execute-sync taskId=${taskId} single_session mode: switched to session ${sessionId}`);
            }
          }
        } else {
          console.log(`[cron] execute-sync taskId=${taskId} no sessionId provided, using current session`);
        }

        // ── Intent-driven resolution (PRD #119, 2026-05) ──────────────────
        //
        // Cron tasks declare their routing intent explicitly. Three branches:
        //
        //   - `subscription` — cron uses Anthropic subscription regardless of
        //     what the agent currently looks like. effectiveProviderEnv is
        //     forced to undefined; agent's third-party `providerEnvJson` is
        //     IGNORED. effectiveModel comes from payload.
        //
        //   - `explicit`     — cron uses its own captured providerEnv. Snapshot
        //     is bypassed entirely. effectiveModel + effectiveProviderEnv come
        //     from payload, atomic. (Pre-#119 the handler re-resolved from the
        //     agent snapshot, which silently overwrote providerEnv with the
        //     agent's even though model came from the cron — model+endpoint
        //     mismatch → 400 + silent empty output.)
        //
        //   - `followAgent`  — pre-#119 default. Read the session snapshot,
        //     fall back to agent for unset fields. Behavior preserved for
        //     legacy crons (those persisted before #119 deserialize as
        //     `followAgent` via serde default).
        //
        // The snapshot itself was already updated above for new_session mode
        // to match intent, so a future read still returns coherent values —
        // but we don't rely on that here; we drive directly from intent +
        // payload so single_session and new_session behave identically.
        //
        // permissionMode override is intent-independent: it overrides the
        // resolved value if payload.permissionMode is set, else falls back
        // to the resolver / runtime default.
        // PRD 0.2.9: provider routing precedence — see /cron/execute above
        // for the full design comment. providerId (new) > providerIntent
        // (legacy #119) > followAgent (default).
        const intent = payload.providerIntent ?? 'followAgent';

        let effectiveModel = model;
        let effectiveProviderEnv: ProviderEnv | 'subscription' | undefined = providerEnv;
        let effectiveRuntimeConfig = payload.runtimeConfig;

        if (payload.providerId) {
          // PRD 0.2.9 — Per-tick live-resolve.
          try {
            effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.error(`[cron] execute-sync: provider resolution failed for '${payload.providerId}': ${errMsg}`);
            clearCronTaskContext(effectiveSessionId);
            resetInteractionScenario();
            return jsonResponse({ success: false, error: errMsg }, 400);
          }
          if (payload.model) effectiveModel = payload.model;
          if (effectiveRuntimeConfig) {
            effectiveRuntimeConfig = { ...effectiveRuntimeConfig, model: payload.model ?? effectiveRuntimeConfig.model };
          }
          console.log(`[cron] execute-sync providerId=${payload.providerId} resolved=${effectiveProviderEnv === 'subscription' ? 'subscription' : (effectiveProviderEnv as ProviderEnv).baseUrl ?? 'anthropic'} runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'}`);
        } else if (intent === 'followAgent') {
          // Legacy snapshot-based resolution.
          const snapshotSessionId = effectiveSessionId ?? getSessionId();
          if (snapshotSessionId) {
            const sessionMeta = getSessionMetadata(snapshotSessionId);
            const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;
            if (sessionMeta && agent) {
              const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');
              if (resolved.model !== undefined) effectiveModel = resolved.model;
              if (resolved.providerEnvJson) {
                try {
                  effectiveProviderEnv = JSON.parse(resolved.providerEnvJson) as ProviderEnv;
                } catch (e) {
                  console.warn(`[cron] execute-sync followAgent: failed to parse providerEnvJson for session ${snapshotSessionId}, falling back to task-frozen value`, e);
                }
              } else if (resolved.providerId) {
                // Issue #197 — see /cron/execute above for the full rationale.
                // Agent persists `providerId` (post-PRD 0.2.9 canonical state)
                // but rarely a frozen `providerEnvJson`. Live-resolve env from
                // providerId so the SDK gets the right credentials instead of
                // falling back to subscription with empty apiKey.
                try {
                  const env = resolveProviderEnv(resolved.providerId);
                  if (env) {
                    effectiveProviderEnv = env as ProviderEnv;
                    if (effectiveModel === undefined) {
                      const provider = findProvider(resolved.providerId);
                      const primary = provider
                        ? (provider as Record<string, unknown>).primaryModel as string | undefined
                        : undefined;
                      if (primary) effectiveModel = primary;
                    }
                  }
                } catch (e) {
                  console.warn(`[cron] execute-sync followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${snapshotSessionId}`, e);
                }
              }
              if (resolved.runtime !== 'builtin') {
                effectiveRuntimeConfig = {
                  ...(payload.runtimeConfig ?? {}),
                  model: resolved.model ?? payload.runtimeConfig?.model,
                  permissionMode: resolved.permissionMode ?? payload.runtimeConfig?.permissionMode,
                };
              }
              console.log(`[cron] execute-sync intent=followAgent session=${snapshotSessionId} runMode=${effectiveRunMode} snapshotLocked=${Boolean(sessionMeta.configSnapshotAt)} model=${effectiveModel ?? 'default'} runtime=${resolved.runtime}`);
            }
          }
          // #119 followAgent backward-compat: pre-#119 the pragmatic fix
          // (commit 502f89c3) re-applied payload.model + payload.providerEnv
          // AFTER snapshot resolve so legacy crons that captured those at
          // schedule time still won the model+provider-bundle race against
          // a later-changed agent. We preserve that behavior here for any
          // cron that deserialized as `followAgent` (legacy default) but
          // still has explicit payload.* values — without it, those tasks
          // regress to following the agent snapshot they explicitly tried
          // to override.
          if (payload.model) effectiveModel = payload.model;
          if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;
        } else if (intent === 'subscription') {
          // PRD 0.2.9 R1 — explicit 'subscription' sentinel, not undefined.
          // See /cron/execute above for the full rationale.
          effectiveProviderEnv = 'subscription';
          if (payload.model) effectiveModel = payload.model;
          if (effectiveRuntimeConfig) {
            effectiveRuntimeConfig = { ...effectiveRuntimeConfig, model: payload.model ?? effectiveRuntimeConfig.model };
          }
          console.log(`[cron] execute-sync intent=subscription runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'} (snapshot bypassed)`);
        } else if (intent === 'explicit') {
          // Cron explicitly wants its captured provider — never inherit from agent.
          // payload.providerEnv MUST be present. A missing providerEnv with
          // explicit intent is a malformed task — fail closed rather than
          // silently routing the cron's model to a different upstream
          // (subscription / agent snapshot). This is the #119 root cause:
          // model and provider are an atomic routing bundle.
          if (!payload.providerEnv) {
            console.error(`[cron] execute-sync intent=explicit but payload.providerEnv is missing — refusing to run (would mismatch model+endpoint)`);
            clearCronTaskContext(effectiveSessionId);
            resetInteractionScenario();
            return jsonResponse({
              success: false,
              error: 'Cron task has explicit provider intent but no providerEnv — task data is malformed. Re-create the task.',
            }, 400);
          }
          effectiveProviderEnv = payload.providerEnv;
          if (payload.model) effectiveModel = payload.model;
          if (effectiveRuntimeConfig) {
            effectiveRuntimeConfig = { ...effectiveRuntimeConfig, model: payload.model ?? effectiveRuntimeConfig.model };
          }
          // Type-narrow for the log: the explicit branch can only land on a
          // ProviderEnv object (assigned just above from `payload.providerEnv`,
          // which the early-return refuses to be undefined). Mirror the
          // shape used at the providerId branch for consistency, including
          // the `'anthropic'` fallback when `baseUrl` is omitted (subscription
          // providers carry no baseUrl but use Anthropic's default endpoint).
          console.log(`[cron] execute-sync intent=explicit runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'} provider=${(effectiveProviderEnv as ProviderEnv | undefined)?.baseUrl ?? 'anthropic'}`);
        }

        // Permission mode override is intent-independent.
        if (payload.permissionMode) {
          effectiveRuntimeConfig = {
            ...(effectiveRuntimeConfig ?? {}),
            permissionMode: payload.permissionMode,
          };
        }

        // Set cron task context so the exit_cron_task tool knows which task is running
        // Pass sessionId for proper isolation between concurrent tasks
        setCronTaskContext(taskId, aiCanExit ?? false, effectiveSessionId);
        console.log(`[cron] execute-sync: cron context set for taskId=${taskId}`);

        // Set System Prompt append for cron task context
        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)
        try {
          setInteractionScenario({
            type: 'cron',
            taskId,
            intervalMinutes: intervalMinutes ?? 15,
            aiCanExit: aiCanExit ?? false,
          });
          console.log('[cron] execute-sync: interaction scenario set');
        } catch (e) {
          console.error('[cron] execute-sync: error setting interaction scenario', e);
          clearCronTaskContext(effectiveSessionId);
          return jsonResponse({ success: false, error: `System prompt error: ${e}` }, 500);
        }

        try {
          console.log(`[cron] execute-sync taskId=${taskId} runMode=${effectiveRunMode} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);

          // Enqueue the message (this starts the async execution)
          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)
          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;
          console.log('[cron] execute-sync: about to enqueue user message');

          let textContent = '';

          // PRD 0.2.5 R2 — unified "user didn't pick → runtime max" resolver.
          // Sentinels for "didn't pick" are undefined and empty string.
          // Concrete values (auto/plan/fullAgency/default/etc.) are respected
          // literally. See src/shared/types/runtime.ts::resolveCronPermissionMode.
          const cronRuntimeType: RuntimeType = shouldUseExternalRuntime() ? getActiveRuntimeType() : 'builtin';
          const effectivePermissionMode = resolveCronPermissionMode(
            payload.permissionMode,
            effectiveRuntimeConfig?.permissionMode,
            cronRuntimeType,
          );

          if (shouldUseExternalRuntime()) {
            // ─── External Runtime (CC/Codex): cron task ───
            // T15: effectiveRuntimeConfig carries snapshot-resolved model/permissionMode
            const ccResult = await sendExternalMessage(
              wrappedPrompt, undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'cron', taskId: taskId ?? 'unknown', intervalMinutes: intervalMinutes ?? 0, aiCanExit: aiCanExit ?? false },
                permissionMode: effectivePermissionMode,
                model: getRuntimeConfigModel(effectiveRuntimeConfig ?? null),
              },
            );
            if (!ccResult.queued) {
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: ccResult.error ?? 'Failed to start cron via external runtime' }, 503);
            }

            const completed = await waitForExternalSessionIdle(3600000, 1000);
            if (!completed) {
              console.warn(`[cron] execute-sync taskId=${taskId} timed out (external runtime)`);
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: 'Execution timed out' }, 408);
            }

            if (!didLastTurnSucceed()) {
              console.warn(`[cron] execute-sync taskId=${taskId} external runtime turn failed`);
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: 'External runtime turn failed' }, 503);
            }

            textContent = getLastExternalAssistantText();
          } else {
            // ─── Builtin Runtime: existing path ───

            // PRD 0.2.4 §需求 4 — reconcile MCP set + run the turn under
            // a single locked critical section so two concurrent cron
            // ticks never interleave their abort/restart with each
            // other's in-flight turn (cross-review B5).
            //
            // Target MCP set:
            //   1. Task carries an override → apply that exact list.
            //   2. Task has no override ("follow Agent") → reconcile to
            //      the workspace's effective MCP. This is critical because
            //      `currentMcpServers` is module-global state that the
            //      previous task's override may have mutated. Without an
            //      explicit reset, "follow Agent" silently inherits the
            //      previous task's override (cross-review B1).
            //
            // The helper is fingerprint-gated, so when the desired set
            // already matches `currentMcpServers` it's a cheap no-op.
            let target: McpServerDefinition[];
            if (payload.mcpEnabledServers !== undefined) {
              const overrideIds = new Set(payload.mcpEnabledServers);
              // Prefer `currentMcpServers` (set by frontend's /api/mcp/set)
              // when its IDs cover all override IDs. Sidecar's
              // `getAllMcpServers()` and the renderer's mcpService produce
              // McpServerDefinition objects with subtly different env/args
              // shapes, and feeding sidecar-shaped definitions back through
              // `applyMcpOverrideAndAwaitReady` triggers a fingerprint
              // mismatch → abort+restart that wastes ~5s on the launcher
              // cron handoff. When the frontend already pushed shapes that
              // cover the override set, reusing those keeps the fingerprint
              // stable and the call becomes a cheap no-op.
              const fromCurrent = (getCurrentMcpServers() ?? []).filter(
                (s) => overrideIds.has(s.id),
              );
              if (fromCurrent.length === overrideIds.size) {
                target = fromCurrent;
              } else {
                const allServers = getAllMcpServers();
                target = allServers.filter((s) => overrideIds.has(s.id));
              }
              console.log(
                `[cron] execute-sync taskId=${taskId} applying task MCP override: [${
                  target.map((s) => s.id).join(',') || '(empty)'
                }]`,
              );
            } else {
              // No override → reconcile to workspace effective MCP so a
              // previous task's override doesn't leak into this run.
              target = getEffectiveMcpServers(agentDir);
            }

            // Apply MCP set first (this may abort + restart the session;
            // the outer `withCronDispatchLock` keeps two concurrent ticks
            // from interleaving across the abort/restart window).
            await applyMcpOverrideAndAwaitReady(target);

            // PRD 0.2.5 R2: effectivePermissionMode resolved above via
            // resolveCronPermissionMode (shared with external runtime branch).
            // T15: effectiveModel / effectiveProviderEnv come from the session snapshot
            //      (single_session) or payload defaults (new_session / fallback).
            const enqueueResult = await enqueueUserMessage(wrappedPrompt, [], effectivePermissionMode as PermissionMode, effectiveModel, effectiveProviderEnv);
            console.log('[cron] execute-sync: user message enqueued, queued:', enqueueResult.queued, 'queueId:', enqueueResult.queueId);

            // Wait for session to become idle (execution complete)
            // Timeout: 60 minutes max execution time (matches Rust cron_task timeout)
            const completed = await waitForSessionIdle(3600000, 1000);

            if (!completed) {
              console.warn(`[cron] execute-sync taskId=${taskId} timed out`);
              if (enqueueResult.queued && enqueueResult.queueId) {
                cancelQueueItem(enqueueResult.queueId);
              }
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: 'Execution timed out' }, 408);
            }

            // Extract response text from builtin session messages
            const messages = getMessages();
            const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');
            if (lastAssistantMessage) {
              if (typeof lastAssistantMessage.content === 'string') {
                textContent = lastAssistantMessage.content;
              } else if (Array.isArray(lastAssistantMessage.content)) {
                textContent = lastAssistantMessage.content
                  .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                  .map(block => block.text)
                  .join('\n');
              }
            }
          }

          // Check if AI requested exit (works for both runtimes — checks text patterns)
          let aiRequestedExit = false;
          let exitReason: string | undefined;

          if (textContent) {
            const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
            if (completionMatch) {
              aiRequestedExit = true;
              exitReason = completionMatch[1].trim();
            }
            if (textContent.includes(CRON_TASK_EXIT_TEXT)) {
              aiRequestedExit = true;
              const reasonMatch = textContent.match(CRON_TASK_EXIT_REASON_PATTERN);
              if (reasonMatch) {
                exitReason = reasonMatch[1].trim();
              }
            }
          }

          // Clear cron task context after execution
          clearCronTaskContext(effectiveSessionId);
          // Reset scenario — already consumed by startStreamingSession() at session creation
          resetInteractionScenario();

          console.log(`[cron] execute-sync taskId=${taskId} completed, aiRequestedExit=${aiRequestedExit}, exitReason=${exitReason}`);

          // Return the Sidecar session ID (our internal storage key) so Rust can
          // pass it to frontend for loading conversation data from our message store.
          const actualSessionId = getSessionId();

          const response = {
            success: true,
            aiRequestedExit,
            exitReason,
            outputText: textContent || undefined,
            sessionId: actualSessionId,
          };
          console.log(`[cron] execute-sync taskId=${taskId} returning response:`, JSON.stringify(response));
          return jsonResponse(response);
        } catch (error) {
          // Clear context on error
          clearCronTaskContext(effectiveSessionId);
          resetInteractionScenario();
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[cron] execute-sync taskId=${taskId} error:`, error);
          const errorResponse = { success: false, error: errorMessage };
          console.log(`[cron] execute-sync taskId=${taskId} returning error response:`, JSON.stringify(errorResponse));
          return jsonResponse(errorResponse, 500);
        }
        }); // end withCronDispatchLock
      }

      // ============= GLOBAL STATS API =============

      // GET /api/global-stats?range=7d|30d|60d - Aggregated token usage across all sessions
      if (pathname === '/api/global-stats' && request.method === 'GET') {
        try {
          const range = url.searchParams.get('range') || '30d';
          if (!['7d', '30d', '60d'].includes(range)) {
            return jsonResponse({ success: false, error: 'Invalid range. Use 7d, 30d, or 60d.' }, 400);
          }

          const allSessions = getAllSessionMetadata();

          // Filter sessions by time range using lastActiveAt as a coarse pre-filter
          const now = Date.now();
          const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 60;
          const cutoff = now - rangeDays * 86400_000;

          const sessions = allSessions.filter(s => new Date(s.lastActiveAt).getTime() >= cutoff);

          // Helper: convert ISO timestamp to local date string "YYYY-MM-DD"
          const toLocalDate = (isoStr: string): string => {
            const d = new Date(isoStr);
            const y = d.getFullYear();
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${mo}-${day}`;
          };

          // Cutoff as YYYY-MM-DD for cheap string comparison against each message's local
          // date. Pre-2026-04 the summary numbers came from session-lifetime `s.stats` and
          // ignored cutoff entirely — that produced "summary says 31.5M tokens, daily chart
          // says 5M" mismatches because the summary leaked all historical totals from any
          // recently-active session. Now ALL summary/daily/byModel aggregations are derived
          // from the same in-range message walk so they stay consistent.
          const cutoffDateStr = toLocalDate(new Date(cutoff).toISOString());

          const totalSessions = sessions.length;
          let messageCount = 0;
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          let totalCacheReadTokens = 0;
          let totalCacheCreationTokens = 0;

          // Single pass through messages: aggregate summary + daily + byModel together so
          // they're guaranteed to agree about what falls inside the range.
          const dailyMap: Record<string, { inputTokens: number; outputTokens: number; messageCount: number }> = {};
          const byModel: Record<string, {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheCreationTokens: number;
            count: number;
          }> = {};

          for (const s of sessions) {
            const sessionData = getSessionData(s.id);
            if (!sessionData) continue;

            let lastUserDate = toLocalDate(s.createdAt); // fallback date for first assistant msg

            for (const msg of sessionData.messages) {
              // Determine each message's local date so summary and chart agree on cutoff.
              let msgDate: string;
              if (msg.role === 'user') {
                msgDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;
                lastUserDate = msgDate;
              } else if (msg.role === 'assistant') {
                msgDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;
              } else {
                continue;
              }
              if (msgDate < cutoffDateStr) continue;

              messageCount++;

              if (msg.role !== 'assistant' || !msg.usage) continue;

              const date = msgDate;
              totalInputTokens += msg.usage.inputTokens ?? 0;
              totalOutputTokens += msg.usage.outputTokens ?? 0;
              totalCacheReadTokens += msg.usage.cacheReadTokens ?? 0;
              totalCacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;

              // Daily aggregation
              if (!dailyMap[date]) {
                dailyMap[date] = { inputTokens: 0, outputTokens: 0, messageCount: 0 };
              }
              dailyMap[date].inputTokens += msg.usage.inputTokens ?? 0;
              dailyMap[date].outputTokens += msg.usage.outputTokens ?? 0;
              dailyMap[date].messageCount++;

              // byModel aggregation
              if (msg.usage.modelUsage) {
                for (const [model, mu] of Object.entries(msg.usage.modelUsage)) {
                  if (!byModel[model]) {
                    byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
                  }
                  byModel[model].inputTokens += mu.inputTokens ?? 0;
                  byModel[model].outputTokens += mu.outputTokens ?? 0;
                  byModel[model].cacheReadTokens += mu.cacheReadTokens ?? 0;
                  byModel[model].cacheCreationTokens += mu.cacheCreationTokens ?? 0;
                  byModel[model].count++;
                }
              } else {
                const model = msg.usage.model || 'unknown';
                if (!byModel[model]) {
                  byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
                }
                byModel[model].inputTokens += msg.usage.inputTokens ?? 0;
                byModel[model].outputTokens += msg.usage.outputTokens ?? 0;
                byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
                byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
                byModel[model].count++;
              }
            }
          }

          // Sort daily entries chronologically
          const daily = Object.entries(dailyMap)
            .map(([date, d]) => ({ date, ...d }))
            .sort((a, b) => a.date.localeCompare(b.date));

          return jsonResponse({
            success: true,
            stats: {
              summary: {
                totalSessions,
                messageCount,
                totalInputTokens,
                totalOutputTokens,
                totalCacheReadTokens,
                totalCacheCreationTokens,
              },
              daily,
              byModel,
            },
          });
        } catch (error) {
          console.error('[global-stats] Error:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 500);
        }
      }

      // ============= SESSION API =============

      // GET /sessions - List all sessions or filter by agentDir
      if (pathname === '/sessions' && request.method === 'GET') {
        try {
          const agentDirParam = url.searchParams.get('agentDir');
          const sessions = agentDirParam
            ? getSessionsByAgentDir(agentDirParam)
            : getAllSessionMetadata();
          // Zero-trust: strip providerEnvJson before handing to clients.
          // Matches PATCH response behavior (see PATCH /sessions/:id).
          const safeSessions = sessions.map(redactSessionMetadata);
          return jsonResponse({ success: true, sessions: safeSessions });
        } catch (error) {
          console.error('[sessions] Error in GET /sessions:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error in SessionStore'
          }, 500);
        }
      }

      // POST /sessions - Create a new session
      if (pathname === '/sessions' && request.method === 'POST') {
        let payload: { agentDir: string; runtime?: string };
        try {
          payload = (await request.json()) as { agentDir: string; runtime?: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const agentDirValue = payload?.agentDir?.trim();
        if (!agentDirValue) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        // Use the shared VALID_RUNTIMES constant — same list that drives
        // admin-api validation and HELP_TEXTS. A local literal here used to
        // silently drift when new runtimes landed.
        const runtimeValue = (VALID_RUNTIMES as readonly string[]).includes(payload?.runtime as string)
          ? (payload.runtime as import('../shared/types/runtime').RuntimeType)
          : undefined;
        // v0.1.69 Desktop session = owned snapshot. Capture model/permission/mcp/provider
        // from AgentConfig so the session is self-contained from creation onward.
        // The frontend's runtime override (payload.runtime) wins over agent.runtime — Tab UI
        // can pin a session to a specific runtime independent of the Agent's default.
        const agent = findAgentByWorkspacePath(agentDirValue) as AgentConfig | undefined;
        const baseSnapshot = agent ? snapshotForOwnedSession(agent) : {};
        if (runtimeValue) baseSnapshot.runtime = runtimeValue;
        const session = await createSession(agentDirValue, baseSnapshot);
        return jsonResponse({ success: true, session });
      }

      // GET /sessions/:id/since/:lastMessageId - Incremental tail fetch
      // Called by the cron:execution-complete handler to pull only the messages
      // appended by a background task, instead of reloading the whole session.
      // This is what keeps a foreground tab responsive after a background cron
      // task completes: the old full-reload path bundled P0+P1 penalties
      // (base64 attachments + Virtuoso remount) into a single freeze spike.
      // Must be BEFORE the generic /sessions/:id route.
      if (pathname.match(/^\/sessions\/[^/]+\/since\/[^/]+$/) && request.method === 'GET') {
        const match = pathname.match(/^\/sessions\/([^/]+)\/since\/([^/]+)$/);
        if (!match) {
          return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
        }
        const sessionId = decodeURIComponent(match[1]);
        const lastMessageId = decodeURIComponent(match[2]);

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        const idx = session.messages.findIndex(m => m.id === lastMessageId);
        // idx === -1 signals "caller's baseline is gone" (session was rewound,
        // compacted, or otherwise rewritten). Caller falls back to full reload.
        if (idx === -1) {
          return jsonResponse({ success: true, fromIndex: -1, messages: [] });
        }

        const tail = session.messages.slice(idx + 1);
        // Same metadata-only shape as GET /sessions/:id (P0) — previews are
        // resolved via the myagents:// custom protocol on the client.
        return jsonResponse({ success: true, fromIndex: idx, messages: tail });
      }

      // GET /sessions/:id/stats - Get detailed session statistics
      // NOTE: This route must be BEFORE /sessions/:id to avoid being caught by the generic route
      if (pathname.match(/^\/sessions\/[^/]+\/stats$/) && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '').replace('/stats', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // Group stats by model
        const byModel: Record<string, {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          count: number;
        }> = {};

        // Build message details
        const messageDetails: Array<{
          userQuery: string;
          model?: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
          toolCount?: number;
          durationMs?: number;
        }> = [];

        let currentUserQuery = '';
        for (const msg of session.messages) {
          if (msg.role === 'user') {
            currentUserQuery = typeof msg.content === 'string'
              ? msg.content.slice(0, 100)
              : JSON.stringify(msg.content).slice(0, 100);
          } else if (msg.role === 'assistant' && msg.usage) {
            // Use modelUsage for per-model breakdown if available, fallback to single model
            if (msg.usage.modelUsage) {
              for (const [model, stats] of Object.entries(msg.usage.modelUsage)) {
                if (!byModel[model]) {
                  byModel[model] = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    count: 0,
                  };
                }
                byModel[model].inputTokens += stats.inputTokens ?? 0;
                byModel[model].outputTokens += stats.outputTokens ?? 0;
                byModel[model].cacheReadTokens += stats.cacheReadTokens ?? 0;
                byModel[model].cacheCreationTokens += stats.cacheCreationTokens ?? 0;
                byModel[model].count++;
              }
            } else {
              // Fallback for older messages without modelUsage
              const model = msg.usage.model || 'unknown';
              if (!byModel[model]) {
                byModel[model] = {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                  count: 0,
                };
              }
              byModel[model].inputTokens += msg.usage.inputTokens ?? 0;
              byModel[model].outputTokens += msg.usage.outputTokens ?? 0;
              byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
              byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
              byModel[model].count++;
            }

            // Message details always use aggregate values
            messageDetails.push({
              userQuery: currentUserQuery,
              model: msg.usage.model,
              inputTokens: msg.usage.inputTokens ?? 0,
              outputTokens: msg.usage.outputTokens ?? 0,
              cacheReadTokens: msg.usage.cacheReadTokens,
              cacheCreationTokens: msg.usage.cacheCreationTokens,
              toolCount: msg.toolCount,
              durationMs: msg.durationMs,
            });
          }
        }

        const metadata = getSessionMetadata(sessionId);
        return jsonResponse({
          success: true,
          stats: {
            summary: metadata?.stats ?? {
              messageCount: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
            },
            byModel,
            messageDetails,
          },
        });
      }

      // GET /sessions/:id - Get session details
      if (pathname.startsWith('/sessions/') && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          // An active session may not yet have on-disk metadata: external runtimes
          // pre-warm before the first user message, and builtin can race in the
          // window between Tab open and first persisted turn. Treat the active
          // session as an empty session-in-progress instead of 404 (which the
          // frontend retries, producing log noise).
          const isActiveBuiltin = sessionId === getSessionId();
          const isActiveExternal = shouldUseExternalRuntime() && sessionId === getExternalSessionId();
          if (isActiveBuiltin || isActiveExternal) {
            // CRITICAL: include `runtime` so the frontend's TabProvider doesn't
            // fall back to `'builtin'` (line 2645: `runtime || 'builtin'`). For
            // a pre-warmed external session whose metadata hasn't been persisted
            // yet, omitting runtime makes `currentRuntime` resolve to 'builtin',
            // which then triggers the unified model-push effect to send the
            // builtin preset model — killing the just-prewarmed external process.
            return jsonResponse({
              success: true,
              session: {
                id: sessionId,
                runtime: isActiveExternal ? getActiveRuntimeType() : 'builtin',
                messages: [],
                liveStreamingMessage: null,
                liveSessionState: isActiveExternal ? getExternalSessionState() : undefined,
                totalCount: 0,
                hasMoreBefore: false,
              },
            });
          }
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // Pagination: `?limit=N` returns only the most recent N messages,
        // keeping the first-paint JSON body tiny even for 600-message sessions.
        // `?before=<messageId>` loads the N messages immediately older than the
        // given id, used by the MessageList startReached handler to lazily
        // fetch history as the user scrolls up.
        //
        // Clamp limit to [1, 500]. 0 / missing means "full load" (preserved for
        // callers that genuinely need all messages, e.g. sessions/fork UI).
        const rawLimit = parseInt(url.searchParams.get('limit') ?? '0', 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 0;
        const before = url.searchParams.get('before');

        let liveStreamingMessage: {
          id: string;
          role: 'assistant';
          content: string;
          timestamp: string;
          sdkUuid?: string;
        } | null = null;

        // If this is the currently active session, merge in-memory messages.
        // In-memory messages include the current turn's in-progress content
        // (thinking, text, tool_use) that hasn't been persisted to disk yet.
        // This is critical for shared Sidecar: when a Tab opens an IM session
        // mid-turn, it needs to see the partial assistant response.
        let mergedMessages = session.messages;
        if (shouldUseExternalRuntime() && sessionId === getExternalSessionId()) {
          const liveMessage = getExternalLiveAssistantMessage();
          if (liveMessage) {
            liveStreamingMessage = {
              id: liveMessage.id,
              role: 'assistant',
              content: liveMessage.content,
              timestamp: liveMessage.timestamp,
            };
          }
        } else if (sessionId === getSessionId()) {
          const inMemory = getMessages();
          if (inMemory.length > 0) {
            const diskIds = new Set(session.messages.map(m => m.id));
            const newMessages = inMemory
              .filter(m => !diskIds.has(m.id))
              .map(m => ({
                id: m.id,
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(stripPlaywrightResults(m.content)),
                timestamp: m.timestamp,
                sdkUuid: m.sdkUuid,
                attachments: m.attachments?.map(a => ({
                  id: a.id,
                  name: a.name,
                  mimeType: a.mimeType,
                  path: a.savedPath ?? a.relativePath ?? '',
                })),
                metadata: m.metadata,
              }));
            if (newMessages.length > 0) {
              mergedMessages = [...session.messages, ...newMessages];
            }
          }
        }

        // Apply pagination slice. hasMoreBefore tells the client whether there
        // are older messages on disk that it could fetch with ?before=.
        const totalCount = mergedMessages.length;
        let paginatedMessages = mergedMessages;
        let hasMoreBefore = false;
        if (limit > 0) {
          if (before) {
            const beforeIdx = mergedMessages.findIndex(m => m.id === before);
            // beforeIdx < 0 is a stale cursor — the client's baseline is gone,
            // so return an empty page and let the client fall back to full load.
            if (beforeIdx < 0) {
              paginatedMessages = [];
              hasMoreBefore = false;
            } else {
              const start = Math.max(0, beforeIdx - limit);
              paginatedMessages = mergedMessages.slice(start, beforeIdx);
              hasMoreBefore = start > 0;
            }
          } else {
            const start = Math.max(0, totalCount - limit);
            paginatedMessages = mergedMessages.slice(start);
            hasMoreBefore = start > 0;
          }
        }

        // Attachments ship as metadata only. Binary previews are served by the
        // Tauri `myagents://attachment/<path>` custom protocol (zero-copy, no JSON
        // round-trip), keeping the JSON body small even for sessions with dozens
        // of screenshots. Browser dev mode uses the /api/attachment/* fallback
        // route below.
        const sessionWithPreview = {
          ...redactSessionMetadata(session),
          liveStreamingMessage,
          liveSessionState: shouldUseExternalRuntime() && sessionId === getExternalSessionId()
            ? getExternalSessionState()
            : undefined,
          messages: paginatedMessages,
          totalCount,
          hasMoreBefore,
        };

        return jsonResponse({ success: true, session: sessionWithPreview });
      }

      // DELETE /sessions/:id - Delete a session
      if (pathname.startsWith('/sessions/') && request.method === 'DELETE') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const deleted = await deleteSession(sessionId);
        if (!deleted) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        return jsonResponse({ success: true });
      }

      // PATCH /sessions/:id - Update session metadata (incl. v0.1.69 config snapshot)
      if (pathname.startsWith('/sessions/') && request.method === 'PATCH') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        // Snapshot fields (v0.1.69): send `null` to clear (revert to agent fallback);
        // omit a field to leave it unchanged.
        interface PatchPayload {
          title?: string;
          titleSource?: 'default' | 'auto' | 'user';
          /** Pin/unpin to the 收藏 filter view. Storage convention: only
           *  `true` is persisted; `false` is stored as `undefined` so a
           *  freshly toggled-off session matches "never favorited" exactly
           *  on disk. */
          favorite?: boolean;
          model?: string | null;
          permissionMode?: string | null;
          mcpEnabledServers?: string[] | null;
          providerId?: string | null;
          providerEnvJson?: string | null;
        }

        let payload: PatchPayload;
        try {
          payload = (await request.json()) as PatchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        // `lastActiveAt` is the recency signal that drives history sort
        // order. Bumping it on EVERY PATCH means a pure-UI flag change
        // (favorite toggle) makes an old session jump to the top of the
        // dropdown — confusing UX (Codex round-4 caught). Only the fields
        // that genuinely represent "session was used" should refresh it.
        const RECENCY_BUMP_FIELDS = new Set([
          'title',           // user-edited title implies engagement
          'titleSource',
          'model',
          'permissionMode',
          'mcpEnabledServers',
          'providerId',
          'providerEnvJson',
        ]);
        const touchedRecencyField = (Object.keys(payload) as Array<keyof PatchPayload>)
          .filter((k) => payload[k] !== undefined)
          .some((k) => RECENCY_BUMP_FIELDS.has(k));

        const updates: Record<string, unknown> = touchedRecencyField
          ? { lastActiveAt: new Date().toISOString() }
          : {};
        if (payload.title !== undefined) updates.title = String(payload.title).slice(0, 100);
        if (payload.titleSource !== undefined) updates.titleSource = payload.titleSource;
        if (payload.favorite !== undefined) {
          // Convert false → undefined so the on-disk shape stays minimal
          // (the JSON serializer drops undefined keys).
          updates.favorite = payload.favorite === true ? true : undefined;
        }

        // Snapshot fields: null → clear (undefined in stored JSON); value → set.
        // `undefined` in stored metadata is how the resolver recognizes "fall back to agent".
        const snapshotKeys = [
          'model',
          'permissionMode',
          'mcpEnabledServers',
          'providerId',
          'providerEnvJson',
        ] as const;
        let wroteSnapshotField = false;
        for (const key of snapshotKeys) {
          const v = payload[key];
          if (v === undefined) continue;
          updates[key] = v === null ? undefined : v;
          wroteSnapshotField = true;
        }

        // Stamp configSnapshotAt on the first snapshot write (lazy migration).
        // Also bumps on subsequent writes — harmless, useful for debugging.
        if (wroteSnapshotField) {
          updates.configSnapshotAt = new Date().toISOString();
        }

        const updated = await updateSessionMetadata(sessionId, updates);

        if (!updated) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // Zero-trust: redact credential-bearing fields from the echo payload.
        // The client already owns what it sent; no need to round-trip secrets.
        return jsonResponse({ success: true, session: redactSessionMetadata(updated) });
      }

      // POST /sessions/switch - Switch to existing session for resume
      if (pathname === '/sessions/switch' && request.method === 'POST') {
        let payload: { sessionId?: string };
        try {
          payload = (await request.json()) as { sessionId?: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        if (!payload.sessionId) {
          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);
        }

        // External runtime path: builtin's `switchToSession` looks up the session
        // in builtin SessionStore, but external sessions are persisted lazily
        // (only on first user message — pre-warm doesn't write metadata). Falling
        // through to builtin would always 404 for a freshly-prewarmed external
        // session and pollute the log with misleading "session not found" errors.
        // Handle external runtime directly without consulting builtin's store.
        if (shouldUseExternalRuntime()) {
          // Fast path: the Sidecar is already (or about to be) bound to this
          // session. Boot's restoreExternalSessionState and any in-flight prewarm
          // both converge on the same module state, so a switch into that target
          // is a no-op. Skipping the prewarm await here is what makes opening
          // Gemini session history feel instant instead of paying the 8-10s
          // CLI cold-start. sendExternalMessage's own startingPromise guard
          // (external-session.ts) still serializes any user message that races
          // an in-flight prewarm, so this fast return is safe.
          if (getCurrentBoundSessionId() === payload.sessionId) {
            return jsonResponse({ success: true, sessionId: payload.sessionId });
          }

          // Cross-session switch: must serialize against any in-flight prewarm
          // so its post-spawn writes (lastSessionId / lastModel / etc.) don't
          // clobber the state restoreExternalSessionState is about to set up
          // for the new target. Mirrors the guard in setExternalModel /
          // setExternalPermissionMode (different races, same serialization).
          await awaitExternalSessionStarting();

          // Validate target: cross-session switches must point at a real
          // persisted session — same-target switches were already handled by
          // the fast path above and don't require metadata (a freshly-prewarmed
          // session writes metadata only on first user message).
          const meta = getSessionMetadata(payload.sessionId);
          if (!meta) {
            return jsonResponse({ success: false, error: 'Session not found.' }, 404);
          }
          // Cross-runtime guard — refuse to attach to a session created by
          // a different runtime. The cross-runtime fork flow goes through
          // new-session creation, not switch.
          if (meta.runtime && meta.runtime !== getActiveRuntimeType()) {
            return jsonResponse(
              { success: false, error: `Session runtime mismatch: persisted=${meta.runtime}, current=${getActiveRuntimeType()}` },
              409,
            );
          }

          // Tear down the previous live session before binding to the new
          // one. (Same-target reattach was handled by the fast path; if we
          // reach here, the bound session is genuinely different.)
          if (isExternalSessionActive()) {
            await stopExternalSession();
          }
          restoreExternalSessionState(payload.sessionId, agentDir, { type: 'desktop' });
          console.log(`[sessions] Switched to external session: ${payload.sessionId}`);
          return jsonResponse({ success: true, sessionId: payload.sessionId });
        }

        const success = await switchToSession(payload.sessionId);
        if (!success) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        console.log(`[sessions] Switched to session: ${payload.sessionId}`);
        return jsonResponse({ success: true, sessionId: payload.sessionId });
      }

      // POST /api/generate-session-title - AI-generate a short session title
      // Accepts `rounds` array (3+ QA rounds) for rich context.
      // Also accepts legacy `userMessage`/`assistantReply` for backward compatibility.
      if (pathname === '/api/generate-session-title' && request.method === 'POST') {
        let payload: {
          sessionId: string;
          rounds?: Array<{ user: string; assistant: string }>;
          // Legacy fields (single-round fallback)
          userMessage?: string;
          assistantReply?: string;
          model: string;
          providerEnv?: ProviderEnv;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        if (!payload.sessionId) {
          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);
        }

        // Build rounds from payload — prefer `rounds` array, fall back to legacy fields
        let rounds: Array<{ user: string; assistant: string }>;
        if (payload.rounds && Array.isArray(payload.rounds) && payload.rounds.length > 0) {
          // Cap to 10 rounds max, validate shape, enforce length limits
          rounds = payload.rounds.slice(0, 10)
            .filter((r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object')
            .map(r => ({
              user: (typeof r.user === 'string' ? r.user : '').slice(0, 500),
              assistant: (typeof r.assistant === 'string' ? r.assistant : '').slice(0, 500),
            }));
          if (rounds.length === 0) {
            return jsonResponse({ success: false, error: 'rounds must contain valid entries.' }, 400);
          }
        } else if (payload.userMessage) {
          // Legacy single-round format
          rounds = [{
            user: payload.userMessage.slice(0, 1000),
            assistant: (payload.assistantReply || '').slice(0, 1000),
          }];
        } else {
          return jsonResponse({ success: false, error: 'rounds or userMessage is required.' }, 400);
        }

        payload.model = (payload.model || '').slice(0, 200);

        // Skip if session not found or user has manually renamed
        const meta = getSessionMetadata(payload.sessionId);
        if (!meta) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }
        if (meta.titleSource === 'user') {
          return jsonResponse({ success: false, skipped: true });
        }

        // Runtime-aware dispatch: builtin uses the Claude Agent SDK path with
        // provider-env; external runtimes (CC/Codex/Gemini) spawn a fresh
        // short-lived CLI process of the same runtime so the title respects the
        // session's actual model + CLI auth. See title-generator.ts for rationale.
        const activeRuntime = getActiveRuntimeType();
        const { generateTitle, generateTitleExternal } = await import('./title-generator');
        let title: string | null;
        if (activeRuntime === 'builtin') {
          title = await generateTitle(
            rounds,
            payload.model || '',
            payload.providerEnv,
          );
        } else {
          // External runtimes don't need providerEnv — auth is CLI-owned
          // (claude login / codex login / gemini OAuth). workspacePath comes
          // from session metadata so Gemini/Codex inherit project context.
          title = await generateTitleExternal(
            rounds,
            activeRuntime,
            payload.model || '',
            meta.agentDir,
          );
        }

        if (title) {
          // Re-check titleSource before writing to prevent TOCTOU race with user rename
          const currentMeta = getSessionMetadata(payload.sessionId);
          if (currentMeta?.titleSource === 'user') {
            return jsonResponse({ success: false, skipped: true });
          }
          await updateSessionMetadata(payload.sessionId, { title, titleSource: 'auto' } as Parameters<typeof updateSessionMetadata>[1]);
          return jsonResponse({ success: true, title });
        }

        return jsonResponse({ success: false });
      }

      // ============= END SESSION API =============

      // Switch agent directory at runtime (for browser development mode)
      if (pathname === '/agent/switch' && request.method === 'POST') {
        let payload: SwitchPayload;
        try {
          payload = (await request.json()) as SwitchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const newDir = payload?.agentDir?.trim();
        if (!newDir) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        // Security: validate the path before allowing access
        const validation = isValidAgentDir(newDir);
        if (!validation.valid) {
          console.warn(`[agent] blocked switch to "${newDir}": ${validation.reason}`);
          return jsonResponse({
            success: false,
            error: validation.reason || 'Invalid directory path'
          }, 403);
        }

        try {
          console.log(`[agent] switch to dir="${newDir}"`);
          currentAgentDir = await ensureAgentDir(newDir);
          await initializeAgent(currentAgentDir, payload.initialPrompt);
          return jsonResponse({
            success: true,
            agentDir: currentAgentDir
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }








      if (pathname === '/agent/upload' && request.method === 'POST') {
        const targetParam = url.searchParams.get('path') ?? '';
        const resolvedTarget =
          targetParam ? resolveAgentPath(currentAgentDir, targetParam) : currentAgentDir;
        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        try {
          const oversized = rejectIfOversizedUpload(request);
          if (oversized) return oversized;
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];
          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }
          await ensureDir(resolvedTarget);
          const saved: string[] = [];
          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await streamUploadToFile(file, destination);
            saved.push(relative(currentAgentDir, destination));
          }
          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }










      // ============= FILE MANAGEMENT API =============





      // GET /api/image?path=... - Serve generated images (for browser dev mode)
      if (pathname === '/api/image' && request.method === 'GET') {
        try {
          const imagePath = url.searchParams.get('path');
          if (!imagePath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }

          // Security: allow reading from workspace/myagents_files/{generated_images,temp}/ or legacy paths
          const resolvedPath = resolve(imagePath);
          const legacyDir = join(homedir(), '.myagents', 'generated');
          const legacyDirSep = legacyDir.endsWith(sep) ? legacyDir : legacyDir + sep;
          // New unified paths + backward compat with myagents-generated/images/
          const allowedDirs = currentAgentDir ? [
            join(currentAgentDir, 'myagents_files', 'generated_images'),
            join(currentAgentDir, 'myagents_files', 'temp'),
            join(currentAgentDir, 'myagents-generated', 'images'), // backward compat
          ] : [];
          const allowed = resolvedPath.startsWith(legacyDirSep)
            || allowedDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));
          if (!allowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated directory' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Image not found' }, 404);
          }

          const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

          const resp = await fileResponse(resolvedPath, {
            contentType: mimeType,
            headers: { 'Cache-Control': 'public, max-age=86400' },
          });
          return resp ?? jsonResponse({ success: false, error: 'Image not found' }, 404);
        } catch (error) {
          console.error('[api/image] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve image' },
            500
          );
        }
      }

      // GET /api/audio?path=... - Serve generated audio (for browser dev mode)
      if (pathname === '/api/audio' && request.method === 'GET') {
        try {
          const audioPath = url.searchParams.get('path');
          if (!audioPath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }

          // Security: allow reading from workspace/myagents_files/generated_audio/ or legacy paths
          const resolvedPath = resolve(audioPath);
          const legacyAudioDir = join(homedir(), '.myagents', 'generated_audio');
          const legacyAudioDirSep = legacyAudioDir.endsWith(sep) ? legacyAudioDir : legacyAudioDir + sep;
          // New unified path + backward compat with myagents-generated/audio/
          const allowedAudioDirs = currentAgentDir ? [
            join(currentAgentDir, 'myagents_files', 'generated_audio'),
            join(currentAgentDir, 'myagents-generated', 'audio'), // backward compat
          ] : [];
          const audioAllowed = resolvedPath.startsWith(legacyAudioDirSep)
            || allowedAudioDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));
          if (!audioAllowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated_audio directory' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Audio not found' }, 404);
          }

          const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeTypes: Record<string, string> = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            webm: 'audio/webm',
            opus: 'audio/opus',
            aac: 'audio/aac',
            m4a: 'audio/mp4',
          };
          const mimeType = mimeTypes[ext || ''] || 'audio/mpeg';

          const resp = await fileResponse(resolvedPath, {
            contentType: mimeType,
            headers: { 'Cache-Control': 'public, max-age=86400' },
          });
          return resp ?? jsonResponse({ success: false, error: 'Audio not found' }, 404);
        } catch (error) {
          console.error('[api/audio] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve audio' },
            500
          );
        }
      }

      // POST /api/edge-tts/preview - Preview TTS from Settings (independent of MCP server state)
      if (pathname === '/api/edge-tts/preview' && request.method === 'POST') {
        try {
          const body = await request.json() as {
            text?: string;
            voice?: string;
            rate?: string;
            volume?: string;
            pitch?: string;
            outputFormat?: string;
          };

          if (!body.text?.trim()) {
            return jsonResponse({ success: false, error: 'Missing text parameter' }, 400);
          }

          // Apply same text length limit as the MCP tool
          if (body.text.length > 10000) {
            return jsonResponse({ success: false, error: `Text too long (${body.text.length} chars). Maximum is 10000.` }, 400);
          }

          const { synthesizePreview } = await import('./tools/edge-tts-tool');
          const result = await synthesizePreview({
            text: body.text,
            voice: body.voice || 'zh-CN-XiaoxiaoNeural',
            rate: body.rate || '0%',
            volume: body.volume || '0%',
            pitch: body.pitch || '+0Hz',
            outputFormat: body.outputFormat || 'audio-24khz-48kbitrate-mono-mp3',
          });

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/edge-tts/preview] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Preview failed' },
            500
          );
        }
      }

      // ============= END FILE MANAGEMENT API =============

      // ============= UNIFIED LOGGING API =============

      // POST /api/unified-log - Receive frontend logs for persistence
      if (pathname === '/api/unified-log' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            entries?: Array<{
              source: 'react' | 'bun' | 'rust';
              level: 'info' | 'warn' | 'error' | 'debug';
              message: string;
              timestamp: string;
            }>;
          };

          if (payload.entries && Array.isArray(payload.entries)) {
            appendUnifiedLogBatch(payload.entries);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to log'
          }, 500);
        }
      }

      // GET /api/logs/export - Export recent unified logs as zip
      if (pathname === '/api/logs/export' && request.method === 'GET') {
        try {
          const { readdirSync, statSync } = await import('fs');
          const { join: joinPath } = await import('path');
          const { homedir } = await import('os');
          const logsDir = joinPath(homedir(), '.myagents', 'logs');

          // Collect last 3 days of unified-*.log files
          const now = Date.now();
          const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
          const files = readdirSync(logsDir)
            .filter(f => f.startsWith('unified-') && f.endsWith('.log'))
            .filter(f => {
              try {
                return now - statSync(joinPath(logsDir, f)).mtimeMs < threeDaysMs;
              } catch { return false; }
            })
            .sort();

          if (files.length === 0) {
            return jsonResponse({ success: false, error: '没有找到近3天的运行日志' }, 404);
          }

          // Output to Desktop
          const desktopDir = joinPath(homedir(), 'Desktop');
          const timestamp = new Date().toISOString().slice(0, 10);
          const zipName = `MyAgents-logs-${timestamp}.zip`;
          const zipPath = joinPath(desktopDir, zipName);

          // Create zip using platform-appropriate command
          const isWin = process.platform === 'win32';
          const filePaths = files.map(f => joinPath(logsDir, f));

          // stdout/stderr must be ignored — zip/Compress-Archive emit per-file progress
          // that can exceed the 64KB pipe buffer on large log sets and deadlock the
          // child waiting for us to read.
          if (isWin) {
            // PowerShell Compress-Archive
            const proc = subprocessSpawn(['powershell', '-Command',
              `Compress-Archive -Path '${filePaths.join("','")}' -DestinationPath '${zipPath}' -Force`
            ], { stdout: 'ignore', stderr: 'ignore' });
            await proc.exited;
          } else {
            // macOS/Linux: zip command
            const proc = subprocessSpawn(['zip', '-j', zipPath, ...filePaths], {
              stdout: 'ignore',
              stderr: 'ignore',
            });
            await proc.exited;
          }

          return jsonResponse({ success: true, path: zipPath });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to export logs'
          }, 500);
        }
      }

      // ============= PROVIDER VERIFICATION API =============

      // POST /api/provider/verify - Verify API key via SDK (same path as normal chat)
      if (pathname === '/api/provider/verify' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            baseUrl?: string;
            apiKey?: string;
            model?: string;
            authType?: string;
            apiProtocol?: string;
            maxOutputTokens?: number;
            maxOutputTokensParamName?: string;
            upstreamFormat?: string;
          };

          const { baseUrl, apiKey, model, authType, apiProtocol, maxOutputTokens, maxOutputTokensParamName, upstreamFormat } = payload;

          if (!baseUrl || !apiKey) {
            return jsonResponse({ success: false, error: 'baseUrl and apiKey are required.' }, 400);
          }

          console.log(`[api/provider/verify] =========================`);
          console.log(`[api/provider/verify] baseUrl: ${baseUrl}`);
          console.log(`[api/provider/verify] apiKey: ${apiKey.slice(0, 10)}...`);
          console.log(`[api/provider/verify] model: ${model ?? 'default'}`);
          console.log(`[api/provider/verify] authType: ${authType ?? 'both'}`);
          console.log(`[api/provider/verify] apiProtocol: ${apiProtocol ?? 'anthropic'}`);
          console.log(`[api/provider/verify] maxOutputTokens: ${maxOutputTokens ?? 'none'}`);

          // Unified SDK verification for all protocols (Anthropic + OpenAI)
          // For OpenAI protocol: SDK → CLI → bridge loopback → upstream (end-to-end)
          // For Anthropic protocol: SDK → CLI → upstream (same as before)
          const result = await verifyProviderViaSdk(
            baseUrl, apiKey, authType ?? 'both', model || undefined,
            apiProtocol === 'openai' ? 'openai' : undefined,
            maxOutputTokens,
            maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
            upstreamFormat === 'responses' ? 'responses' : undefined,
          );

          console.log(`[api/provider/verify] result:`, JSON.stringify(result));
          console.log(`[api/provider/verify] =========================`);

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/provider/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // GET /api/subscription/status - Check Anthropic local subscription status
      if (pathname === '/api/subscription/status' && request.method === 'GET') {
        try {
          const status = checkAnthropicSubscription();
          return jsonResponse(status);
        } catch (error) {
          console.error('[api/subscription/status] Error:', error);
          return jsonResponse(
            { available: false, error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/subscription/verify - Verify Anthropic subscription by sending test request via SDK
      if (pathname === '/api/subscription/verify' && request.method === 'POST') {
        try {
          console.log('[api/subscription/verify] Starting verification...');
          const result = await verifySubscription();
          console.log('[api/subscription/verify] Result:', JSON.stringify(result));
          return jsonResponse(result);
        } catch (error) {
          console.error('[api/subscription/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }


      // GET /api/assets/qr-code - Fetch QR code image with local caching
      // Downloads from CDN on first launch and caches locally for subsequent requests
      // Cache refreshes every hour to get updated QR codes from cloud
      if (pathname === '/api/assets/qr-code' && request.method === 'GET') {
        try {
          const QR_CODE_URL = 'https://download.myagents.io/assets/feedback_qr_code.png';

          // Use tmpdir for cache (simple and safe approach)
          const CACHE_DIR = join(tmpdir(), 'myagents-cache');
          const CACHE_FILE = join(CACHE_DIR, 'feedback_qr_code.png');
          const LOCK_FILE = `${CACHE_FILE}.lock`;
          const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour (faster updates)

          const startTime = Date.now();
          let needsDownload = true;

          // Check if cached file exists and is fresh
          if (existsSync(CACHE_FILE)) {
            const stats = statSync(CACHE_FILE);
            const age = Date.now() - stats.mtimeMs;
            if (age < CACHE_MAX_AGE_MS) {
              needsDownload = false;
              console.log(`[api/assets/qr-code] Cache hit (age: ${Math.round(age / 1000 / 60)}min)`);
            } else {
              console.log(`[api/assets/qr-code] Cache expired (age: ${Math.round(age / 1000 / 60)}min), re-downloading`);
            }
          } else {
            console.log('[api/assets/qr-code] Cache miss, downloading');
          }

          // Download if needed (with file lock to prevent concurrent writes)
          if (needsDownload) {
            // Check if another process is already downloading
            if (existsSync(LOCK_FILE)) {
              const lockStats = statSync(LOCK_FILE);
              const lockAge = Date.now() - lockStats.mtimeMs;
              if (lockAge < 30000) { // Lock valid for 30s
                console.log('[api/assets/qr-code] Download in progress, waiting...');
                // Wait and use existing cache if available
                if (existsSync(CACHE_FILE)) {
                  const imageBuffer = readFileSync(CACHE_FILE);
                  const base64 = imageBuffer.toString('base64');
                  return jsonResponse({
                    success: true,
                    dataUrl: `data:image/png;base64,${base64}`
                  });
                }
              } else {
                // Stale lock, remove it
                rmSync(LOCK_FILE, { force: true });
              }
            }

            // Acquire lock
            if (!existsSync(CACHE_DIR)) {
              ensureDirSync(CACHE_DIR);
            }
            writeFileSync(LOCK_FILE, String(Date.now()));

            try {
              const downloadStartTime = Date.now();
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

              const response = await fetch(QR_CODE_URL, { signal: controller.signal });
              clearTimeout(timeoutId);

              if (!response.ok) {
                // If download fails but cache exists, use stale cache
                if (existsSync(CACHE_FILE)) {
                  console.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using stale cache`);
                } else {
                  throw new Error(`下载失败: HTTP ${response.status}`);
                }
              } else {
                // Save to cache using atomic write pattern
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const downloadTime = Date.now() - downloadStartTime;

                // Write to temp file first
                const tmpFile = `${CACHE_FILE}.${Date.now()}.tmp`;
                writeFileSync(tmpFile, buffer);

                // Atomic rename (POSIX guarantee)
                renameSync(tmpFile, CACHE_FILE);
                console.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${downloadTime}ms)`);
              }
            } finally {
              // Release lock
              rmSync(LOCK_FILE, { force: true });
            }
          }

          // Read from cache and return as base64
          if (!existsSync(CACHE_FILE)) {
            return jsonResponse({ success: false, error: 'QR code not available' }, 503);
          }

          const imageBuffer = readFileSync(CACHE_FILE);
          const base64 = imageBuffer.toString('base64');
          const mimeType = 'image/png';
          const totalTime = Date.now() - startTime;

          console.log(`[api/assets/qr-code] Request completed in ${totalTime}ms`);

          return jsonResponse({
            success: true,
            dataUrl: `data:${mimeType};base64,${base64}`
          });
        } catch (error) {
          console.error('[api/assets/qr-code] Error:', error);
          const isTimeout = error instanceof Error && error.name === 'AbortError';
          return jsonResponse(
            { success: false, error: isTimeout ? '网络请求超时' : (error instanceof Error ? error.message : '加载失败') },
            isTimeout ? 504 : 503
          );
        }
      }

      // ============= END PROVIDER VERIFICATION API =============

      // ============= PROXY API =============

      // POST /api/proxy/set - Hot-reload proxy config into this Sidecar process
      if (pathname === '/api/proxy/set' && request.method === 'POST') {
        try {
          const payload = await request.json();
          setProxyConfig(payload);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/proxy/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set proxy config' },
            500
          );
        }
      }

      // ============= MCP API =============

      // POST /api/mcp/set - Set MCP servers for current workspace
      if (pathname === '/api/mcp/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { servers?: McpServerDefinition[] };
          const servers = payload?.servers ?? [];
          // Multi-Agent Runtime gate (defense-in-depth): builtin SDK pre-warm
          // path is irrelevant for external runtimes (Claude Code CLI / Codex /
          // Gemini), which carry their own MCP config via their CLI flags.
          // Driving setMcpServers() here would only trigger noisy fingerprint-
          // diff + 500ms-debounced pre-warm in the builtin path. Renderer-side
          // gate exists in Chat.tsx; this is the server-side belt.
          if (shouldUseExternalRuntime()) {
            return jsonResponse({ success: true, servers: servers.map(s => s.id), skipped: 'external-runtime' });
          }
          setMcpServers(servers);
          return jsonResponse({ success: true, servers: servers.map(s => s.id) });
        } catch (error) {
          console.error('[api/mcp/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },
            500
          );
        }
      }

      // GET /api/mcp - Get current MCP servers
      if (pathname === '/api/mcp' && request.method === 'GET') {
        try {
          const servers = getMcpServers();
          return jsonResponse({ success: true, servers });
        } catch (error) {
          console.error('[api/mcp] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get MCP servers' },
            500
          );
        }
      }

      // POST /api/mcp/enable - Validate and enable MCP server
      // For preset MCP (npx): warmup npm/npx cache (system npx → bundled npx → bun x)
      // For custom MCP: check if command exists
      if (pathname === '/api/mcp/enable' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            server: McpServerDefinition;
          };

          const server = payload.server;
          if (!server) {
            return jsonResponse({ success: false, error: 'Missing server' }, 400);
          }

          // Resolve sentinel commands to display names for logs, so
          // __bundled_cuse__ / __builtin__ never leak into unified logs or
          // user-facing error surfaces.
          const displayCommand = server.command === '__builtin__'
            ? '(builtin)'
            : server.command === '__bundled_cuse__' ? 'cuse' : server.command;
          console.log(`[api/mcp/enable] Enabling MCP: ${server.id}, type: ${server.type}, command: ${displayCommand}`);

          // Built-in MCP (in-process) — delegate validation to registry.
          // getBuiltinMcpInstance() force-loads the tool module (SDK+zod) on
          // first hit; subsequent enables for the same id hit the cached entry.
          if (server.command === '__builtin__') {
            const entryPromise = getBuiltinMcpInstance(server.id);
            if (entryPromise) {
              const entry = await entryPromise;
              if (entry.validate) {
                const error = await entry.validate(server.env || {});
                if (error) {
                  return jsonResponse({ success: false, error });
                }
              }
            }
            console.log(`[api/mcp/enable] Built-in MCP: ${server.id} — enabled`);
            return jsonResponse({ success: true });
          }

          // Bundled cuse (computer-use) binary — resolve the sentinel to
          // the real path via runtime helper. This is the primary enable
          // path hit by the Settings UI toggle, so it MUST short-circuit
          // the generic `which` preflight below (which would fail with a
          // sentinel-leaking "命令 __bundled_cuse__ 未找到" error).
          if (server.command === '__bundled_cuse__') {
            const { getBundledCusePath } = await import('./utils/runtime');
            const cusePath = getBundledCusePath();
            if (!cusePath) {
              return jsonResponse({
                success: false,
                error: {
                  type: 'command_not_found',
                  command: 'cuse',
                  message: `Cuse 二进制未安装 (platform=${process.platform})。仅支持 macOS 与 Windows。`,
                },
              });
            }
            console.log(`[api/mcp/enable] Bundled cuse: ${server.id} — resolved to ${cusePath}`);
            return jsonResponse({ success: true });
          }

          // SSE/HTTP types: validate remote URL is reachable and protocol matches
          if (server.type === 'sse' || server.type === 'http') {
            if (!server.url) {
              return jsonResponse({
                success: false,
                error: { type: 'connection_failed', message: '缺少服务器 URL' }
              });
            }

            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 15000);

              const headers: Record<string, string> = {
                // Streamable HTTP 规范要求同时声明两种格式；SSE 只需 event-stream
                'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
                // Request uncompressed response to avoid ZlibError.
                // Some servers (e.g., behind WAF/CDN like Huawei Cloud) return
                // content-encoding: gzip with a non-compressed body, causing Bun's
                // fetch() auto-decompression to crash. Validation doesn't need compression.
                'Accept-Encoding': 'identity',
                ...(server.headers || {}),
              };

              let response: Response;

              if (server.type === 'http') {
                // Streamable HTTP: send MCP initialize JSON-RPC request
                response = await fetch(server.url, {
                  method: 'POST',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                      protocolVersion: '2025-03-26',
                      capabilities: {},
                      clientInfo: { name: 'MyAgents', version: '0.1.29' },
                    },
                  }),
                  signal: controller.signal,
                });
              } else {
                // SSE: send GET request to check if endpoint is reachable
                response = await fetch(server.url, {
                  method: 'GET',
                  headers,
                  signal: controller.signal,
                });
              }

              clearTimeout(timeout);

              // Helper: abort the underlying connection to prevent resource leaks
              // (especially important for SSE — the response is an infinite stream).
              const cleanup = () => { try { controller.abort(); } catch { /* ignore abort errors */ } };

              // Check HTTP status
              if (response.status === 401 || response.status === 403) {
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `认证失败 (HTTP ${response.status})，请检查 Headers 配置`,
                  }
                });
              }

              if (response.status === 404) {
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `端点不存在 (HTTP 404)，请检查 URL 是否正确`,
                  }
                });
              }

              if (response.status === 405) {
                // 405 Method Not Allowed: protocol mismatch
                cleanup();
                const hint = server.type === 'sse'
                  ? '。该端点不支持 GET，可能是 Streamable HTTP 端点，请尝试切换传输协议'
                  : '。该端点不支持 POST，可能是 SSE 端点，请尝试切换传输协议';
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `请求方法不被允许 (HTTP 405)${hint}`,
                  }
                });
              }

              if (!response.ok) {
                // 尝试读取 response body 以获取更具体的错误信息
                let detail = '';
                try {
                  const body = await response.json() as Record<string, unknown>;
                  const raw = String(body.message || body.msg || body.error || '');
                  detail = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
                } catch { /* body 不是 JSON，忽略 */ }
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `服务器返回错误 (HTTP ${response.status})${detail ? '：' + detail : ''}`,
                  }
                });
              }

              // Protocol-specific validation
              const contentType = response.headers.get('content-type') || '';

              if (server.type === 'sse') {
                // SSE validation only needs headers — abort the infinite stream immediately
                cleanup();

                // SSE endpoint should return text/event-stream
                if (!contentType.includes('text/event-stream')) {
                  // If the URL returns JSON, it's likely a Streamable HTTP endpoint
                  const hint = contentType.includes('application/json') || contentType.includes('text/html')
                    ? '。该 URL 可能是 Streamable HTTP 端点，请尝试切换传输协议为 "Streamable HTTP"'
                    : '';
                  return jsonResponse({
                    success: false,
                    error: {
                      type: 'connection_failed',
                      message: `服务器返回的内容类型不是 SSE (${contentType || 'unknown'})${hint}`,
                    }
                  });
                }
              } else {
                // Streamable HTTP: server may respond with JSON or SSE (both valid per spec)
                // (response.ok is guaranteed here — non-ok statuses returned above)
                if (contentType.includes('text/event-stream')) {
                  // SSE response to POST — valid per MCP Streamable HTTP spec.
                  // Read enough to extract the first JSON-RPC message from SSE data lines.
                  try {
                    const text = await response.text();
                    cleanup();
                    const dataLine = text.split('\n').find(l => l.startsWith('data:'));
                    if (dataLine) {
                      const body = JSON.parse(dataLine.slice(5));
                      if (!body.jsonrpc && !body.result && !body.error) {
                        return jsonResponse({
                          success: false,
                          error: {
                            type: 'connection_failed',
                            message: '服务器 SSE 响应中的数据不是有效的 JSON-RPC 格式',
                          }
                        });
                      }
                    }
                    // SSE stream with valid data or empty (server might send events later) — accept
                  } catch {
                    cleanup();
                    return jsonResponse({
                      success: false,
                      error: {
                        type: 'connection_failed',
                        message: '无法解析服务器的 SSE 响应，请检查 URL 和传输协议',
                      }
                    });
                  }
                } else {
                  // JSON response — original path
                  try {
                    const body = await response.json();
                    cleanup();
                    if (!body.jsonrpc && !body.result && !body.error) {
                      return jsonResponse({
                        success: false,
                        error: {
                          type: 'connection_failed',
                          message: '服务器响应不是有效的 JSON-RPC 格式，请检查 URL 和传输协议',
                        }
                      });
                    }
                  } catch {
                    cleanup();
                    return jsonResponse({
                      success: false,
                      error: {
                        type: 'connection_failed',
                        message: `服务器响应不是有效的 JSON 格式 (${contentType || 'unknown'})`,
                      }
                    });
                  }
                }
              }

              console.log(`[api/mcp/enable] Remote MCP validated: ${server.id} (${server.type}) → ${server.url}`);
              return jsonResponse({ success: true });

            } catch (err: unknown) {
              const error = err instanceof Error ? err : new Error(String(err));
              console.error(`[api/mcp/enable] Remote MCP validation failed: ${server.id}`, error.message);

              let message: string;
              if (error.name === 'AbortError') {
                message = '连接超时（15秒），请检查 URL 是否正确或服务器是否可达';
              } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
                message = 'DNS 解析失败，请检查 URL 域名是否正确';
              } else if (error.message.includes('ECONNREFUSED')) {
                message = '连接被拒绝，请检查服务器是否在运行';
              } else if (error.message.includes('ECONNRESET')) {
                message = '连接被重置，请检查网络或服务器状态';
              } else if (error.message.includes('certificate') || error.message.includes('SSL') || error.message.includes('TLS')) {
                message = 'SSL/TLS 证书错误，请检查服务器证书配置';
              } else if (error.message.includes('Zlib') || error.message.includes('Decompression')) {
                // WAF/CDN may return content-encoding: gzip with non-compressed body.
                // Bun's fetch auto-decompression crashes. Skip validation and let SDK handle it.
                console.warn(`[api/mcp/enable] ZlibError during validation (WAF/CDN issue), allowing MCP: ${server.id}`);
                return jsonResponse({ success: true });
              } else {
                message = `连接失败: ${error.message}`;
              }

              return jsonResponse({
                success: false,
                error: { type: 'connection_failed', message }
              });
            }
          }

          // stdio type: validate command
          if (server.type === 'stdio' && server.command) {
            const command = server.command;

            // Preset MCP (isBuiltin: true) with npx → warmup to download and cache package
            if (server.isBuiltin && command === 'npx') {
              const { getBundledNodeDir, getSystemNpxPaths, findExistingPath } = await import('./utils/runtime');
              const { pinMcpPackageVersions } = await import('./agent-session');
              const args = pinMcpPackageVersions(server.args || []);

              // Route through utils/subprocess.spawn — on Windows the bundled
              // and system npx are both `npx.cmd` shims. Calling .cmd via raw
              // `child_process.spawn` returns EINVAL on Node ≥20.12 (CVE-2024-27980),
              // and Node's own `shell: true` workaround does NOT escape inner
              // quotes / metachars in args. The wrapper handles both — see
              // utils/subprocess.ts::spawn for the cmd.exe wrapping + cross-spawn
              // escape algorithm.
              const { spawn: wrappedSpawn } = await import('./utils/subprocess');
              const { getShellEnv } = await import('./utils/shell');
              const baseEnv = getShellEnv();

              // Priority: system npx → bundled Node.js npx → hard fail.
              // v0.2.0+ removed the "bun x" emergency branch — bundled Node is always present
              // in release builds, and dev builds fall back to system node via runtime.ts.
              const systemNpx = findExistingPath(getSystemNpxPaths());
              const nodeDir = getBundledNodeDir();
              let warmupCmd: string;
              let warmupArgs: string[];

              if (systemNpx) {
                // 1. System npx available — most reliable, user-maintained
                warmupCmd = systemNpx;
                warmupArgs = ['-y', ...args, '--help'];

                // Ensure system npx's directory is in PATH (GUI-launched apps may have minimal PATH)
                const { dirname } = await import('path');
                const npxDir = dirname(systemNpx);
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                const sep = process.platform === 'win32' ? ';' : ':';
                if (!(baseEnv[pathKey] || '').includes(npxDir)) {
                  baseEnv[pathKey] = npxDir + sep + (baseEnv[pathKey] || '');
                }

                console.log(`[api/mcp/enable] Warming up with system npx: ${warmupArgs.join(' ')}`);
              } else if (nodeDir) {
                // 2. Fallback to bundled Node.js npx
                const npxPath = process.platform === 'win32'
                  ? join(nodeDir, 'npx.cmd')
                  : join(nodeDir, 'npx');
                warmupCmd = npxPath;
                warmupArgs = ['-y', ...args, '--help'];

                // Ensure bundled Node.js bin dir is in PATH for npx to find node
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                const sep = process.platform === 'win32' ? ';' : ':';
                baseEnv[pathKey] = nodeDir + sep + (baseEnv[pathKey] || '');

                console.log(`[api/mcp/enable] Warming up with bundled npx: ${warmupArgs.join(' ')}`);
              } else {
                // 3. Neither system nor bundled Node.js found — hard fail.
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'runtime_error',
                    message: '运行时不可用（系统/内置 Node.js 均未找到）',
                  }
                });
              }

              const handle = wrappedSpawn([warmupCmd, ...warmupArgs], {
                env: baseEnv,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
              });

              // Drain stderr — wrappedSpawn exposes it as a Web ReadableStream
              // (Bun.spawn-shape parity), not a Node Readable, so we read with
              // the Web reader API.
              let stderr = '';
              const stderrDone = (async () => {
                if (!handle.stderr) return;
                const reader = handle.stderr.getReader();
                const decoder = new TextDecoder();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    stderr += decoder.decode(value, { stream: true });
                  }
                } catch { /* ignore — process exit will settle handle.exited */ }
                finally {
                  reader.releaseLock();
                }
              })();

              // 2 min timeout (was the old `timeout` spawn option). If npx
              // hangs (e.g. tarball download stalled), kill the wrapper +
              // surface a warmup failure instead of leaving the request open.
              let timedOut = false;
              const timer = setTimeout(() => {
                timedOut = true;
                try { handle.kill('SIGTERM'); } catch { /* ignore */ }
              }, 120000);

              const code = await handle.exited;
              clearTimeout(timer);
              await stderrDone; // make sure all stderr bytes are captured before classifying

              // Spawn-failure path (ENOENT / bad arch / EINVAL): handle.error
              // is populated and code === -1.
              if (handle.error) {
                console.error('[api/mcp/enable] Warmup error:', handle.error);
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: `预热失败: ${handle.error.message}`,
                  },
                });
              }

              if (timedOut) {
                console.warn('[api/mcp/enable] Warmup timed out after 120s');
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: '预热超时（120s），请检查网络或代理设置',
                  },
                });
              }

              console.log(`[api/mcp/enable] Warmup exited with code ${code}`);
              // Code 0 or 1 is acceptable (--help may return 1 for some packages)
              // Check stderr for real errors (package not found, network issues, etc.)
              const stderrLower = stderr.toLowerCase();
              const networkKeywords = [
                'enotfound',     // DNS resolution failed
                'etimedout',     // Connection timeout
                'econnrefused',  // Connection refused
                'econnreset',    // Connection reset
                'proxy error',   // Proxy failures
                'proxy authentication', // Proxy auth required
                'bad gateway',   // Proxy 502
                'socket hang up',// Connection dropped
              ];
              const packageKeywords = [
                '404',                // HTTP 404 not found
                'package not found',  // npm/npx package resolution
                'module not found',   // Module resolution failure
                'err!',               // npm error indicator
              ];
              const isNetworkError = networkKeywords.some(kw => stderrLower.includes(kw));
              const isPackageError = packageKeywords.some(kw => stderrLower.includes(kw));

              if (isNetworkError) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: '网络连接失败，请检查网络或代理设置',
                  },
                });
              }
              if (isPackageError) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'package_not_found',
                    message: '包不存在或无法下载，请检查包名',
                  },
                });
              }
              if (code !== 0 && code !== 1) {
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'warmup_failed',
                    message: `预热异常退出 (code ${code})`,
                  },
                });
              }
              return jsonResponse({ success: true });
            }

            // Custom MCP or non-npx command → check if command exists in user's shell PATH
            const { spawn } = await import('child_process');
            const { getShellEnv } = await import('./utils/shell');
            const checkCmd = process.platform === 'win32' ? 'where' : 'which';

            return new Promise<Response>((resolve) => {
              const proc = spawn(checkCmd, [command], { stdio: 'ignore', env: getShellEnv() });

              proc.on('error', () => {
                resolve(jsonResponse({
                  success: false,
                  error: {
                    type: 'command_not_found',
                    command,
                    message: `命令 "${command}" 未找到`,
                    ...getCommandDownloadInfo(command),
                  }
                }));
              });

              proc.on('close', (code) => {
                if (code === 0) {
                  resolve(jsonResponse({ success: true }));
                } else {
                  resolve(jsonResponse({
                    success: false,
                    error: {
                      type: 'command_not_found',
                      command,
                      message: `命令 "${command}" 未找到`,
                      ...getCommandDownloadInfo(command),
                    }
                  }));
                }
              });
            });
          }

          // Default: allow
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/enable] Error:', error);
          return jsonResponse({
            success: false,
            error: {
              type: 'unknown',
              message: error instanceof Error ? error.message : '启用失败',
            }
          }, 500);
        }
      }

      // POST /api/permission/respond - Handle user permission decision
      // Auto-routes to external runtime (CC/Codex) when active, otherwise uses builtin SDK handler.
      if (pathname === '/api/permission/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            // External runtime: pass full decision so CC can persist "always_allow" rules
            await respondExternalPermission(payload.requestId, payload.decision);
            return jsonResponse({ success: true });
          }

          const { handlePermissionResponse } = await import('./agent-session');
          const success = handlePermissionResponse(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/permission] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/ask-user-question/respond - Handle user's answers to AskUserQuestion
      // Auto-routes to external runtime (CC) when the request was originated there, otherwise
      // uses builtin SDK handler. External-runtime tracking lives in external-session.ts.
      if (pathname === '/api/ask-user-question/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            answers: Record<string, string> | null;  // null means user cancelled
          };

          // Route by pending-request ownership, NOT live session state
          // (cross-review C4): if we track this requestId as external, the
          // answer belongs to CC even if the process just died. Deferring to
          // the builtin handler would return "unknown request" and silently
          // lose the user's input. External handler returns false + logs on
          // process-gone, surfacing the failure to the UI.
          if (shouldUseExternalRuntime() && hasPendingExternalAskUserQuestion(payload.requestId)) {
            const success = await respondExternalAskUserQuestion(payload.requestId, payload.answers);
            return jsonResponse({ success });
          }

          const { handleAskUserQuestionResponse } = await import('./agent-session');
          const success = handleAskUserQuestionResponse(payload.requestId, payload.answers);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/ask-user-question] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }
      // POST /api/exit-plan-mode/respond - Handle user's approval/rejection of ExitPlanMode.
      // `feedback` (optional, issue #182): user's modification comment used as
      // deny.message when rejecting, so the AI revises the plan in the same turn.
      if (pathname === '/api/exit-plan-mode/respond' && request.method === 'POST') {
        try {
          const raw = await request.json() as Record<string, unknown>;
          // Runtime validation — typed `as ExitPlanModeResponse` cast accepts
          // truthy strings like `approved: "false"` which would silently
          // approve the plan (review-by-codex finding). Validate explicitly.
          if (typeof raw?.requestId !== 'string' || typeof raw?.approved !== 'boolean'
              || (raw.feedback !== undefined && typeof raw.feedback !== 'string')) {
            return jsonResponse({ success: false, error: 'invalid payload' }, 400);
          }
          const { handleExitPlanModeResponse } = await import('./agent-session');
          const success = handleExitPlanModeResponse(raw.requestId, raw.approved, raw.feedback as string | undefined);
          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/exit-plan-mode] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/enter-plan-mode/respond - Handle user's approval/rejection of EnterPlanMode
      if (pathname === '/api/enter-plan-mode/respond' && request.method === 'POST') {
        try {
          const raw = await request.json() as Record<string, unknown>;
          // Runtime validation — match the exit-plan-mode endpoint's defense
          // (review-by-cc finding: parallel endpoint had unsafe cast). A
          // payload like `{requestId:"x", approved:"false"}` would otherwise
          // pass the cast and `approved` would be the truthy string,
          // silently entering plan mode against user intent.
          if (typeof raw?.requestId !== 'string' || typeof raw?.approved !== 'boolean') {
            return jsonResponse({ success: false, error: 'invalid payload' }, 400);
          }
          const { handleEnterPlanModeResponse } = await import('./agent-session');
          const success = handleEnterPlanModeResponse(raw.requestId, raw.approved);
          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/enter-plan-mode] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // ============= MCP OAuth API =============

      // POST /api/mcp/oauth/discover - Probe MCP server for OAuth requirements
      if (pathname === '/api/mcp/oauth/discover' && request.method === 'POST') {
        try {
          const payload = await request.json() as { serverId: string; mcpUrl: string; forceRefresh?: boolean };
          if (!payload.serverId || !payload.mcpUrl) {
            return jsonResponse({ success: false, error: 'Missing serverId or mcpUrl' }, 400);
          }
          const { probeOAuthRequirement } = await import('./mcp-oauth');
          const result = await probeOAuthRequirement(payload.serverId, payload.mcpUrl, payload.forceRefresh);
          return jsonResponse({ success: true, ...result });
        } catch (error) {
          console.error('[api/mcp/oauth/discover] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Discovery failed' }, 500);
        }
      }

      // POST /api/mcp/oauth/start - Start OAuth flow (auto or manual mode)
      if (pathname === '/api/mcp/oauth/start' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            serverId: string;
            serverUrl: string;
            // Manual mode fields (all optional — omit for auto mode)
            clientId?: string;
            clientSecret?: string;
            scopes?: string[];
            callbackPort?: number;
            authorizationUrl?: string;
            tokenUrl?: string;
          };

          if (!payload.serverId || !payload.serverUrl) {
            return jsonResponse({ success: false, error: 'Missing serverId or serverUrl' }, 400);
          }

          const { authorizeServer } = await import('./mcp-oauth');
          const manualConfig = payload.clientId ? {
            clientId: payload.clientId,
            clientSecret: payload.clientSecret,
            scopes: payload.scopes,
            callbackPort: payload.callbackPort,
            authorizationUrl: payload.authorizationUrl,
            tokenUrl: payload.tokenUrl,
          } : undefined;

          const { authUrl, waitForCompletion } = await authorizeServer(
            payload.serverId,
            payload.serverUrl,
            manualConfig,
          );

          // Don't await completion — return the auth URL immediately
          waitForCompletion.then((success) => {
            if (success) {
              console.log(`[api/mcp/oauth] Authorization completed for ${payload.serverId}`);
            } else {
              console.warn(`[api/mcp/oauth] Authorization failed or cancelled for ${payload.serverId}`);
            }
          });

          return jsonResponse({ success: true, authUrl });
        } catch (error) {
          console.error('[api/mcp/oauth/start] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to start OAuth flow' },
            500
          );
        }
      }

      // GET /api/mcp/oauth/status/:serverId - Get OAuth status
      if (pathname.startsWith('/api/mcp/oauth/status/') && request.method === 'GET') {
        try {
          const serverId = decodeURIComponent(pathname.slice('/api/mcp/oauth/status/'.length));
          const { getOAuthStatus } = await import('./mcp-oauth');
          const result = getOAuthStatus(serverId);
          return jsonResponse({
            success: true,
            status: result.status,
            hasToken: result.status === 'connected' || result.status === 'expired',
            expiresAt: result.expiresAt,
            scope: result.scope,
          });
        } catch (error) {
          console.error('[api/mcp/oauth/status] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/mcp/oauth/refresh - Manually refresh OAuth token
      if (pathname === '/api/mcp/oauth/refresh' && request.method === 'POST') {
        try {
          const payload = await request.json() as { serverId: string };
          const { manualRefreshToken } = await import('./mcp-oauth');
          const refreshed = await manualRefreshToken(payload.serverId);
          return jsonResponse({ success: refreshed, refreshed });
        } catch (error) {
          console.error('[api/mcp/oauth/refresh] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // DELETE /api/mcp/oauth/token - Revoke OAuth authorization
      if (pathname === '/api/mcp/oauth/token' && request.method === 'DELETE') {
        try {
          const payload = await request.json() as { serverId: string };
          const { revokeAuthorization } = await import('./mcp-oauth');
          await revokeAuthorization(payload.serverId);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/oauth/token] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // ============= END MCP OAuth API =============

      // ============= END MCP API =============

      // ============= ADMIN API (Self-Config CLI) =============
      if (pathname.startsWith('/api/admin/') && request.method === 'POST') {
        try {
          const payload = pathname === '/api/admin/status'
            ? {}
            : await request.json().catch(() => ({})) as Record<string, unknown>;

          const result = await routeAdminApi(pathname, payload);
          return jsonResponse(result, result.success ? 200 : 400);
        } catch (error) {
          console.error(`[admin] ${pathname} error:`, error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Admin API error' },
            500
          );
        }
      }
      // ============= END ADMIN API =============

      // ============= SLASH COMMANDS API =============

      // ============= CLAUDE.md API =============


      // Security: Validate item names to prevent path traversal attacks
      // Supports Unicode (Chinese, Japanese, etc.) while maintaining security
      // Defined here (before Rules and Skills APIs) so all endpoints can use it
      const isValidItemName = (name: string): boolean => {
        // Reject empty names
        if (!name || name.trim().length === 0) {
          return false;
        }
        // Reject path separators and parent directory references (security)
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          return false;
        }
        // Reject Windows reserved characters: < > : " | ? *
        // These cause issues on Windows file systems
        if (/[<>:"|?*]/.test(name)) {
          return false;
        }
        // Reject control characters (0x00-0x1F, 0x7F)
        // eslint-disable-next-line no-control-regex -- Intentional control character detection for filename validation
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return false;
        }
        // Reject names that are only dots (., ..) or start/end with spaces
        if (/^\.+$/.test(name) || name !== name.trim()) {
          return false;
        }
        // Reject Windows reserved file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (isWindowsReservedName(name)) {
          return false;
        }
        // Allow Unicode letters, numbers, hyphens, underscores, spaces, and common punctuation
        return true;
      };

      // ============= RULES FILES API =============
      // Manage .claude/rules/*.md files (system prompt rules)

      // GET /api/rules - List all rule files
      if (pathname === '/api/rules' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          if (!existsSync(rulesDir)) {
            return jsonResponse({ success: true, files: [] });
          }
          const files = readdirSync(rulesDir)
            .filter(f => f.endsWith('.md'))
            .sort();
          return jsonResponse({ success: true, files });
        } catch (error) {
          console.error('[api/rules] Error listing:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list rules' },
            500
          );
        }
      }

      // POST /api/rules - Create a new rule file
      if (pathname === '/api/rules' && request.method === 'POST') {
        try {
          const payload = await request.json() as { name: string; content?: string };
          if (!payload.name || !payload.name.trim()) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }
          // Ensure .md suffix
          let filename = payload.name.trim();
          if (!filename.endsWith('.md')) {
            filename = filename + '.md';
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          ensureDirSync(rulesDir);
          const filePath = join(rulesDir, filename);
          if (existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File already exists' }, 409);
          }
          writeFileSync(filePath, payload.content || '', 'utf-8');
          return jsonResponse({ success: true, filename });
        } catch (error) {
          console.error('[api/rules] Error creating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create rule file' },
            500
          );
        }
      }

      // PUT /api/rules/:filename/rename - Rename a rule file
      if (pathname.startsWith('/api/rules/') && pathname.endsWith('/rename') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length, -'/rename'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const oldNameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(oldNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { newName: string };
          if (!payload.newName || !payload.newName.trim()) {
            return jsonResponse({ success: false, error: 'New name is required' }, 400);
          }
          let newFilename = payload.newName.trim();
          if (!newFilename.endsWith('.md')) {
            newFilename = newFilename + '.md';
          }
          const newNameWithoutExt = newFilename.replace(/\.md$/, '');
          if (!isValidItemName(newNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const oldPath = join(rulesDir, filename);
          const newPath = join(rulesDir, newFilename);
          if (!existsSync(oldPath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          if (existsSync(newPath)) {
            return jsonResponse({ success: false, error: 'Target filename already exists' }, 409);
          }
          renameSync(oldPath, newPath);
          return jsonResponse({ success: true, filename: newFilename });
        } catch (error) {
          console.error('[api/rules] Error renaming:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to rename rule file' },
            500
          );
        }
      }

      // GET /api/rules/:filename - Read a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'GET') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: true, exists: false, content: '' });
          }
          const content = readFileSync(filePath, 'utf-8');
          return jsonResponse({ success: true, exists: true, content });
        } catch (error) {
          console.error('[api/rules] Error reading:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read rule file' },
            500
          );
        }
      }

      // PUT /api/rules/:filename - Update a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { content: string };
          if (typeof payload.content !== 'string') {
            return jsonResponse({ success: false, error: 'Content must be a string' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          ensureDirSync(rulesDir);
          const filePath = join(rulesDir, filename);
          writeFileSync(filePath, payload.content, 'utf-8');
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error updating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update rule file' },
            500
          );
        }
      }

      // DELETE /api/rules/:filename - Delete a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'DELETE') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          unlinkSync(filePath);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error deleting:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete rule file' },
            500
          );
        }
      }

      // ============= SKILLS MANAGEMENT API =============

      // Cross-platform home directory for user skills/commands
      const homeDir = getHomeDirOrNull() || '';
      const userSkillsBaseDir = join(homeDir, '.myagents', 'skills');
      const userCommandsBaseDir = join(homeDir, '.myagents', 'commands');

      // Helper: Get project base directories (supports explicit agentDir parameter)
      // Security: validates agentDir to prevent path traversal attacks
      const getProjectBaseDirs = (queryAgentDir: string | null) => {
        // If explicit agentDir provided, validate it first
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          // Invalid agentDir, fall back to currentAgentDir
          console.warn(`[getProjectBaseDirs] Invalid agentDir rejected: ${queryAgentDir}`);
          queryAgentDir = null;
        }
        // Use validated agentDir if provided, otherwise fall back to currentAgentDir
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return {
          skillsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'skills') : '',
          commandsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'commands') : '',
        };
      };

      // Default project paths (using currentAgentDir)
      const hasValidAgentDir = currentAgentDir && existsSync(currentAgentDir);
      const projectSkillsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'skills') : '';
      const projectCommandsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'commands') : '';

      // GET /api/skills - List all skills (with scope filter)
      // Supports ?agentDir= for listing skills from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/skills' && request.method === 'GET') {
        try {
          // Phase E (PRD 0.2.7): always-sync (cheap when nothing changed) —
          // the gen-tracking wrapper is gone.
          if (currentAgentDir) syncProjectUserConfig(currentAgentDir);

          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { skillsDir: effectiveSkillsDir } = getProjectBaseDirs(queryAgentDir);
          const skillsConfigForList = readSkillsConfig();
          const skills: Array<{
            name: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            folderName: string;
            author?: string;
            enabled?: boolean;
          }> = [];

          const scanSkills = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const folders = readdirSync(dir, { withFileTypes: true });
              for (const folder of folders) {
                // isDirEntry follows symlinks + Windows junctions (issue #104).
                if (!isDirEntry(folder, join(dir, folder.name))) continue;
                if (isSkillBlockedOnPlatform(folder.name)) continue;
                const skillMdPath = join(dir, folder.name, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;

                const content = readFileSync(skillMdPath, 'utf-8');
                const { name, description, author } = parseSkillFrontmatter(content);
                skills.push({
                  name: name || folder.name,
                  description: description || '',
                  scope: scopeType,
                  path: skillMdPath,
                  folderName: folder.name,
                  author,
                  enabled: scopeType === 'project' ? true : !skillsConfigForList.disabled.includes(folder.name),
                });
              }
            } catch (scanError) {
              console.warn(`[api/skills] Error scanning ${scopeType} skills:`, scanError);
            }
          };

          const resolvedProjectSkillsDir = effectiveSkillsDir || projectSkillsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectSkillsDir) {
            scanSkills(resolvedProjectSkillsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanSkills(userSkillsBaseDir, 'user');
          }

          return jsonResponse({ success: true, skills });
        } catch (error) {
          console.error('[api/skills] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list skills' },
            500
          );
        }
      }

      // POST /api/skill/toggle-enable - Enable/disable a user-level skill
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/toggle-enable' && request.method === 'POST') {
        try {
          const { folderName, enabled } = await request.json() as { folderName: string; enabled: boolean };
          if (!folderName || typeof folderName !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }
          const config = readSkillsConfig();
          if (enabled) {
            config.disabled = config.disabled.filter(n => n !== folderName);
          } else {
            if (!config.disabled.includes(folderName)) config.disabled.push(folderName);
          }
          writeSkillsConfig(config);
          // Re-sync project skill symlinks if this sidecar has an agentDir
          // (Global Sidecar has no agentDir; Tab Sidecars will sync on next /api/commands or /api/skills)
          if (agentDir) { syncProjectUserConfig(agentDir); }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill/toggle-enable] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' },
            500
          );
        }
      }

      // GET /api/skill/sync-check - Check if there are skills to sync from Claude Code
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-check' && request.method === 'GET') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get folders in Claude Code skills directory (follow junctions — issue #104).
          // Users sometimes mount their skills hub into ~/.claude/skills/ via
          // junction too; bare `isDirectory()` would miss them asymmetrically
          // with the myagentsFolders side.
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => isDirEntry(entry, join(claudeSkillsDir, entry.name)))
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get existing folders in MyAgents skills directory.
          // isDirEntry follows junctions (issue #104) so mounted skills count
          // as existing, preventing sync-from-claude from overwriting them.
          const myagentsFolders = new Set<string>();
          if (existsSync(userSkillsBaseDir)) {
            const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
            for (const entry of entries) {
              if (isDirEntry(entry, join(userSkillsBaseDir, entry.name))) {
                myagentsFolders.add(entry.name);
              }
            }
          }

          // Find folders that can be synced (exist in Claude but not in MyAgents)
          const syncableFolders = claudeFolders.filter(folder => !myagentsFolders.has(folder));

          return jsonResponse({
            canSync: syncableFolders.length > 0,
            count: syncableFolders.length,
            folders: syncableFolders
          });
        } catch (error) {
          console.error('[api/skill/sync-check] Error:', error);
          return jsonResponse(
            { canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/skill/sync-from-claude - Sync skills from Claude Code to MyAgents
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-from-claude' && request.method === 'POST') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, error: 'Claude Code skills directory not found' }, 404);
          }

          // Get folders in Claude Code skills directory (follow junctions — issue #104)
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => isDirEntry(entry, join(claudeSkillsDir, entry.name)))
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'No skills to sync' });
          }

          // Ensure MyAgents skills directory exists
          if (!existsSync(userSkillsBaseDir)) {
            ensureDirSync(userSkillsBaseDir);
          }

          // Get existing folders in MyAgents skills directory (follow junctions — issue #104)
          const myagentsFolders = new Set<string>();
          const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (isDirEntry(entry, join(userSkillsBaseDir, entry.name))) {
              myagentsFolders.add(entry.name);
            }
          }

          // Find folders that can be synced (filter out invalid folder names for security)
          const syncableFolders = claudeFolders.filter(folder =>
            !myagentsFolders.has(folder) && isValidFolderName(folder)
          );

          if (syncableFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'All skills already exist' });
          }

          // Copy each syncable folder
          let synced = 0;
          let failed = 0;
          const errors: string[] = [];

          // Async copy — yields to the event loop so the Rust health monitor's
          // /health probe (2 s timeout, 15 s interval) keeps succeeding while the
          // bulk sync runs. Blocking here was the root cause of the "sidecar
          // respawns mid-sync, port jumps" symptom users saw on Windows.
          for (const folder of syncableFolders) {
            const srcDir = join(claudeSkillsDir, folder);
            const destDir = join(userSkillsBaseDir, folder);

            try {
              await copyDirRecursive(srcDir, destDir, '[api/skill/sync-from-claude]');

              // Ensure SKILL.md exists — Claude Code may use different file names
              const skillMdPath = join(destDir, 'SKILL.md');
              if (!existsSync(skillMdPath)) {
                // Sanitize folder name for YAML frontmatter (escape quotes and backslashes)
                const safeName = folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                // Look for any .md file to use as the skill definition
                const mdFiles = readdirSync(destDir).filter(f => f.endsWith('.md') && f !== 'SKILL.md');
                if (mdFiles.length > 0) {
                  // Use the first .md file as SKILL.md source
                  const srcMd = join(destDir, mdFiles[0]);
                  const mdContent = readFileSync(srcMd, 'utf-8');
                  // Check if it already has frontmatter; if not, add minimal frontmatter
                  if (mdContent.startsWith('---')) {
                    writeFileSync(skillMdPath, mdContent, 'utf-8');
                  } else {
                    const skillContent = `---\nname: "${safeName}"\ndescription: "Imported from Claude Code"\n---\n\n${mdContent}`;
                    writeFileSync(skillMdPath, skillContent, 'utf-8');
                  }
                  console.log(`[api/skill/sync-from-claude] Created SKILL.md from ${mdFiles[0]} for "${folder}"`);
                } else {
                  // No .md files — create minimal SKILL.md
                  const minimalContent = `---\nname: "${safeName}"\ndescription: "Imported from Claude Code"\n---\n\nSkill imported from Claude Code.\n`;
                  writeFileSync(skillMdPath, minimalContent, 'utf-8');
                  console.log(`[api/skill/sync-from-claude] Created minimal SKILL.md for "${folder}"`);
                }
              }

              synced++;
              if (process.env.DEBUG === '1') {
                console.log(`[api/skill/sync-from-claude] Synced skill "${folder}"`);
              }
            } catch (copyError) {
              failed++;
              const errorMsg = copyError instanceof Error ? copyError.message : 'Unknown error';
              errors.push(`${folder}: ${errorMsg}`);
              console.error(`[api/skill/sync-from-claude] Failed to copy "${folder}":`, copyError);
            }
          }

          // Imported user skills — bump generation + sync symlinks into project
          if (synced > 0) {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({
            success: true,
            synced,
            failed,
            errors: errors.length > 0 ? errors : undefined
          });
        } catch (error) {
          console.error('[api/skill/sync-from-claude] Error:', error);
          return jsonResponse(
            { success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' },
            500
          );
        }
      }

      // GET /api/skill/:name - Get skill detail
      if (pathname.startsWith('/api/skill/') && request.method === 'GET') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillPath = join(baseDir, skillName, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          const content = readFileSync(skillPath, 'utf-8');
          const { frontmatter, body } = parseFullSkillContent(content);

          return jsonResponse({
            success: true,
            skill: {
              name: frontmatter.name || skillName,
              folderName: skillName,
              path: skillPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get skill' },
            500
          );
        }
      }

      // PUT /api/skill/:name - Update skill (with optional folder rename)
      if (pathname.startsWith('/api/skill/') && request.method === 'PUT') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<SkillFrontmatter>;
            body: string;
            newFolderName?: string; // Optional: rename folder if provided
            agentDir?: string; // Optional: explicit project directory
          };

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          let currentFolderName = skillName;
          let skillDir = join(baseDir, currentFolderName);
          let skillPath = join(skillDir, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          // Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;

            // Validate new folder name
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }

            const newSkillDir = join(baseDir, newFolderName);

            // Check for conflict
            if (existsSync(newSkillDir)) {
              return jsonResponse({ success: false, error: `技能文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, folder is renamed but content unchanged.
            const content = serializeSkillContent(payload.frontmatter, payload.body);

            // Rename the folder
            renameSync(skillDir, newSkillDir);
            skillDir = newSkillDir;
            skillPath = join(skillDir, 'SKILL.md');
            currentFolderName = newFolderName;

            // Write content to new location
            writeFileSync(skillPath, content, 'utf-8');

            // User skill renamed — bump generation + re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }
            return jsonResponse({
              success: true,
              path: skillPath,
              folderName: currentFolderName,
              fullPath: skillDir
            });
          }

          // No rename, just update content
          const content = serializeSkillContent(payload.frontmatter, payload.body);
          writeFileSync(skillPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: skillPath,
            folderName: currentFolderName,
            fullPath: skillDir
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },
            500
          );
        }
      }

      // DELETE /api/skill/:name - Delete skill
      if (pathname.startsWith('/api/skill/') && request.method === 'DELETE') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, skillName);

          if (!existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          rmSync(skillDir, { recursive: true, force: true });
          // User skill deleted — bump generation + re-sync to remove dangling symlinks
          if (scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },
            500
          );
        }
      }

      // POST /api/skill/copy-to-global - Copy a project skill to global (~/.myagents/skills/)
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/copy-to-global' && request.method === 'POST') {
        try {
          const { folderName } = await request.json() as { folderName: string };
          if (!folderName || typeof folderName !== 'string' || !isValidItemName(folderName)) {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }

          // Validate project skills directory
          if (!projectSkillsBaseDir) {
            return jsonResponse({ success: false, error: '当前没有项目工作目录' }, 400);
          }

          const srcDir = join(projectSkillsBaseDir, folderName);
          if (!existsSync(srcDir)) {
            return jsonResponse({ success: false, error: '项目技能不存在' }, 404);
          }

          // Check SKILL.md exists in source
          if (!existsSync(join(srcDir, 'SKILL.md'))) {
            return jsonResponse({ success: false, error: '项目技能缺少 SKILL.md' }, 400);
          }

          // Check if already exists in global
          const destDir = join(userSkillsBaseDir, folderName);
          if (existsSync(destDir)) {
            return jsonResponse({ success: false, error: '全局技能中已存在同名技能' }, 409);
          }

          // Ensure global skills directory exists
          ensureDirSync(userSkillsBaseDir);

          // Copy the skill folder — async variant so /health stays responsive
          // while large skills copy (see copyDirRecursive doc).
          await copyDirRecursive(srcDir, destDir, '[api/skill/copy-to-global]');

          // Bump generation + sync symlinks into project
          bumpSkillsGeneration();
          if (currentAgentDir) { syncProjectUserConfig(currentAgentDir); }

          return jsonResponse({ success: true, folderName });
        } catch (error) {
          console.error('[api/skill/copy-to-global] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to copy skill to global' },
            500
          );
        }
      }

      // POST /api/skill/create - Create new skill
      if (pathname === '/api/skill/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string; // Optional: explicit project directory
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for folder (supports Unicode)
          const folderName = sanitizeFolderName(payload.name);
          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, folderName);

          if (existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill already exists' }, 409);
          }

          // Create directory structure
          ensureDirSync(skillDir);

          // Create SKILL.md with default content
          const frontmatter: Partial<SkillFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your skill instructions here.`;
          const content = serializeSkillContent(frontmatter, body);

          const skillPath = join(skillDir, 'SKILL.md');
          writeFileSync(skillPath, content, 'utf-8');

          // New user skill — bump generation so Tab Sidecars re-sync symlinks
          if (payload.scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({ success: true, path: skillPath, folderName });
        } catch (error) {
          console.error('[api/skill/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create skill' },
            500
          );
        }
      }

      // POST /api/skill/upload - Upload skill from file (.zip, .skill, .md)
      if (pathname === '/api/skill/upload' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            filename: string;
            content: string; // Base64 encoded file content
            scope: 'user' | 'project';
            /**
             * Optional explicit folder name. Bypasses heuristic derivation from
             * filename / frontmatter. Required when uploading a bare `SKILL.md`
             * file — see `.md` branch below.
             */
            folderName?: string;
          };

          if (!payload.filename || !payload.content) {
            return jsonResponse({ success: false, error: 'Filename and content are required' }, 400);
          }

          const ext = extname(payload.filename).toLowerCase();
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Decode base64 content to buffer
          const fileBuffer = Buffer.from(payload.content, 'base64');

          // Helper: Try to extract name from SKILL.md frontmatter only.
          // Scope: `.zip` / `.skill` branch. Archives already have stronger
          // fallbacks (top-level directory, then filename stem) — we don't want
          // a body `# heading` to silently override them.
          const extractFrontmatterName = (content: string): string | null => {
            try {
              const parsed = parseFullSkillContent(content);
              if (parsed.frontmatter.name) {
                return parsed.frontmatter.name;
              }
            } catch {
              // Ignore parse errors
            }
            return null;
          };

          // Helper used only by the `.md` branch. Adds the first `# heading`
          // fallback so bare SKILL.md uploads without frontmatter `name:` can
          // still yield a meaningful directory name instead of the reserved
          // "SKILL" filename stem.
          const extractNameForMdUpload = (content: string): string | null => {
            try {
              const { name } = parseSkillFrontmatter(content);
              return name ?? null;
            } catch {
              return null;
            }
          };

          // `SKILL.md` is the convention-reserved filename inside every skill
          // folder — it identifies the file's role, not the skill's identity.
          // Using its stem as a folder-name fallback collapses every distinct
          // upload onto the same directory (issue #96).
          const isReservedSkillStem = (stem: string): boolean => /^skill$/i.test(stem);

          if (ext === '.zip' || ext === '.skill') {
            // Handle zip/skill files - extract to skills directory
            try {
              const { default: AdmZip } = await import('adm-zip');
              const zip = new AdmZip(fileBuffer);
              const entries = zip.getEntries();

              // Find the root folder name from zip (or use filename without extension)
              let rootFolderName = basename(payload.filename, ext);

              // Check if zip has a single root directory
              const topLevelDirs = new Set<string>();
              for (const entry of entries) {
                const parts = entry.entryName.split('/');
                if (parts[0] && parts[0] !== '__MACOSX') {
                  topLevelDirs.add(parts[0]);
                }
              }

              // If zip has a single root folder, use that as default folder name
              if (topLevelDirs.size === 1) {
                rootFolderName = Array.from(topLevelDirs)[0];
              }

              // Try to find and parse SKILL.md to get the name from frontmatter
              for (const entry of entries) {
                const entryName = entry.entryName.toLowerCase();
                if (entryName.endsWith('skill.md') && !entry.isDirectory) {
                  const mdContent = entry.getData().toString('utf-8');
                  const nameFromContent = extractFrontmatterName(mdContent);
                  if (nameFromContent) {
                    rootFolderName = nameFromContent;
                    break;
                  }
                }
              }

              // Sanitize folder name (supports Unicode)
              const folderName = sanitizeFolderName(rootFolderName);
              const skillDir = join(baseDir, folderName);

              if (existsSync(skillDir)) {
                return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
              }

              // Create skill directory
              ensureDirSync(skillDir);

              // Extract files, handling nested structure
              for (const entry of entries) {
                // Skip __MACOSX folder and directory entries
                if (entry.entryName.startsWith('__MACOSX') || entry.isDirectory) continue;

                // Calculate target path - if zip has root folder, strip it
                let targetPath = entry.entryName;
                if (topLevelDirs.size === 1) {
                  const parts = targetPath.split('/');
                  parts.shift(); // Remove root folder
                  targetPath = parts.join('/');
                }

                if (!targetPath) continue;

                const fullPath = resolve(join(skillDir, targetPath));
                // Zip-Slip protection: resolved path must stay within skillDir
                if (!fullPath.startsWith(skillDir + sep) && fullPath !== skillDir) {
                  console.warn(`[api/skill/upload] Blocked Zip-Slip path: ${entry.entryName}`);
                  continue;
                }
                const dir = dirname(fullPath);

                // Create subdirectories if needed
                if (!existsSync(dir)) {
                  ensureDirSync(dir);
                }

                // Write file
                writeFileSync(fullPath, entry.getData());
              }

              if (payload.scope === 'user') {
                bumpSkillsGeneration();
                if (agentDir) { syncProjectUserConfig(agentDir); }
              }
              return jsonResponse({
                success: true,
                folderName,
                path: skillDir,
                message: `已成功导入技能 "${folderName}"`
              });

            } catch (zipError) {
              console.error('[api/skill/upload] Zip extraction error:', zipError);
              return jsonResponse(
                { success: false, error: '无法解压文件，请确保是有效的 zip 文件' },
                400
              );
            }

          } else if (ext === '.md') {
            // Handle .md files - parse content and create folder
            const mdContent = fileBuffer.toString('utf-8');
            const mdFilename = basename(payload.filename, '.md');

            // Folder-name priority: explicit payload.folderName → frontmatter.name
            // (or first `# heading`) → filename stem, but NEVER the reserved stem
            // "SKILL" (the convention filename for every skill's definition file).
            const nameFromContent = extractNameForMdUpload(mdContent);
            const fallbackFromFilename = isReservedSkillStem(mdFilename) ? null : mdFilename;
            const rawFolderName = payload.folderName || nameFromContent || fallbackFromFilename;

            if (!rawFolderName) {
              return jsonResponse(
                {
                  success: false,
                  error:
                    '无法确定技能目录名：上传文件名为 SKILL.md 且正文缺少可用标识。请任选其一：在 frontmatter 中添加 name 字段、在正文添加 `# <技能名>` 标题、或在请求中提供 folderName 参数。',
                },
                400,
              );
            }

            const folderName = sanitizeFolderName(rawFolderName);
            const skillDir = join(baseDir, folderName);

            if (existsSync(skillDir)) {
              return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
            }

            // Create skill directory
            ensureDirSync(skillDir);

            // Write the md file as SKILL.md
            const skillPath = join(skillDir, 'SKILL.md');
            writeFileSync(skillPath, fileBuffer);

            if (payload.scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }
            return jsonResponse({
              success: true,
              folderName,
              path: skillPath,
              message: `已成功导入技能 "${folderName}"`
            });

          } else {
            return jsonResponse(
              { success: false, error: '不支持的文件类型，请上传 .zip、.skill 或 .md 文件' },
              400
            );
          }

        } catch (error) {
          console.error('[api/skill/upload] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to upload skill' },
            500
          );
        }
      }

      // POST /api/skill/import-folder - Import skill from a local folder path (Tauri only)
      if (pathname === '/api/skill/import-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            folderPath: string;
            scope: 'user' | 'project';
          };

          if (!payload.folderPath) {
            return jsonResponse({ success: false, error: 'Folder path is required' }, 400);
          }

          const sourcePath = payload.folderPath;
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Validate source folder exists
          if (!existsSync(sourcePath)) {
            return jsonResponse({ success: false, error: '指定的文件夹不存在' }, 400);
          }

          // Check if it's a directory
          try {
            const stats = statSync(sourcePath);
            if (!stats.isDirectory()) {
              return jsonResponse({ success: false, error: '指定的路径不是文件夹' }, 400);
            }
          } catch {
            return jsonResponse({ success: false, error: '无法读取文件夹信息' }, 400);
          }

          // Check for SKILL.md at root
          const skillMdPath = join(sourcePath, 'SKILL.md');
          if (!existsSync(skillMdPath)) {
            return jsonResponse({ success: false, error: '文件夹中未找到 SKILL.md 文件' }, 400);
          }

          // Read SKILL.md to get the skill name
          const skillMdContent = readFileSync(skillMdPath, 'utf-8');
          let folderName = basename(sourcePath);

          // Try to extract name from SKILL.md frontmatter
          try {
            const parsed = parseFullSkillContent(skillMdContent);
            if (parsed.frontmatter.name) {
              folderName = parsed.frontmatter.name;
            }
          } catch {
            // Use folder name as fallback
          }

          // Sanitize folder name
          folderName = sanitizeFolderName(folderName);
          const targetDir = join(baseDir, folderName);

          // Check if skill already exists
          if (existsSync(targetDir)) {
            return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
          }

          // Copy folder recursively — async so the sidecar's /health probe
          // stays responsive during large imports (see copyDirRecursive doc).
          // Keeps the hidden-file / __MACOSX filter that distinguishes this
          // path from the bulk-sync variant.
          const copyImportedSkillDir = async (src: string, dest: string): Promise<void> => {
            await ensureDir(dest);
            const entries = await readdirAsync(src, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
              if (entry.isSymbolicLink()) {
                console.warn(`[api/skill/import-folder] Skipping symlink: ${join(src, entry.name)}`);
                continue;
              }
              const srcPath = join(src, entry.name);
              const destPath = join(dest, entry.name);
              if (entry.isDirectory()) {
                await copyImportedSkillDir(srcPath, destPath);
              } else {
                await copyFileAsync(srcPath, destPath);
              }
            }
          };

          await copyImportedSkillDir(sourcePath, targetDir);

          if (payload.scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({
            success: true,
            folderName,
            path: targetDir,
            message: `已成功导入技能 "${folderName}"`
          });

        } catch (error) {
          console.error('[api/skill/import-folder] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to import skill folder' },
            500
          );
        }
      }

      // POST /api/skill/install-from-url - Install skill(s) from a GitHub repo / raw zip URL
      // Two-step flow: first call analyses and may return a preview for the user to confirm;
      // second call (with confirmedSelection) re-fetches and writes the chosen skills.
      if (pathname === '/api/skill/install-from-url' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            url: string;
            scope: 'user' | 'project';
            confirmedSelection?: {
              pluginName?: string;
              folderNames?: string[];
              overwrite?: string[];
              renames?: Record<string, string>;
            };
          };

          if (!payload.url || typeof payload.url !== 'string') {
            return jsonResponse({ success: false, error: 'url 参数必填' }, 400);
          }
          const scope = payload.scope === 'project' ? 'project' : 'user';
          const baseDir = scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // 1. Resolve URL
          let resolved;
          try {
            resolved = resolveSkillUrl(payload.url);
          } catch (err) {
            return jsonResponse(
              { success: false, error: err instanceof Error ? err.message : '链接解析失败' },
              400,
            );
          }

          // 2. Download + extract in memory
          let tree;
          try {
            tree = await fetchSkillZip(resolved);
          } catch (err) {
            const statusCode = err instanceof TarballFetchError ? err.statusCode : 500;
            return jsonResponse(
              { success: false, error: err instanceof Error ? err.message : '下载失败' },
              statusCode,
            );
          }

          // 3. Analyse
          const analysis = analyseTree(tree, resolved);

          if (analysis.mode === 'empty') {
            return jsonResponse({ success: false, error: analysis.reason }, 422);
          }

          // 4. Compute existing folder conflicts for a given candidate list
          const checkConflicts = (candidates: SkillCandidate[]) => {
            const conflicts: Array<{ suggestedFolderName: string; name: string }> = [];
            for (const cand of candidates) {
              const folder = sanitizeFolderName(cand.suggestedFolderName);
              if (existsSync(join(baseDir, folder))) {
                conflicts.push({ suggestedFolderName: folder, name: cand.name });
              }
            }
            return conflicts;
          };

          // ---------- Step B: confirmedSelection provided — write to disk ----------
          if (payload.confirmedSelection) {
            const overwrite = new Set(payload.confirmedSelection.overwrite ?? []);
            const renames = payload.confirmedSelection.renames ?? {};

            // Determine which candidates were chosen
            let chosen: SkillCandidate[];
            if (analysis.mode === 'marketplace') {
              const plugin = analysis.plugins.find(p => p.name === payload.confirmedSelection!.pluginName);
              if (!plugin) {
                return jsonResponse({ success: false, error: '指定的插件不存在' }, 400);
              }
              const wanted = new Set(
                (payload.confirmedSelection.folderNames ?? []).map(n => sanitizeFolderName(n)),
              );
              chosen = wanted.size > 0
                ? plugin.skills.filter(s => wanted.has(sanitizeFolderName(s.suggestedFolderName)))
                : plugin.skills;
            } else if (analysis.mode === 'multi') {
              const wanted = new Set(
                (payload.confirmedSelection.folderNames ?? []).map(n => sanitizeFolderName(n)),
              );
              chosen = analysis.candidates.filter(
                s => wanted.has(sanitizeFolderName(s.suggestedFolderName)),
              );
              if (chosen.length === 0) {
                return jsonResponse({ success: false, error: '未选择任何 skill' }, 400);
              }
            } else {
              chosen = [analysis.skill];
            }

            // ---------- Pre-validation before ANY disk writes ----------
            // Compute the final target folder name for every chosen skill,
            // honoring renames. Then check for:
            //   (1) duplicates within the chosen set (two skills collapsing to
            //       the same folder name — usually via frontmatter.name collision)
            //   (2) existing folders that aren't in overwrite
            //   (3) rename targets that collide with existing folders
            // All of these MUST fail before we write anything, otherwise a
            // partial install leaks. Pre-validation gives atomic-ish semantics
            // without a temp-dir dance.
            const plan: Array<{ cand: SkillCandidate; folderName: string; originalName: string }> = [];
            const seenTargets = new Set<string>();
            for (const cand of chosen) {
              const originalName = sanitizeFolderName(cand.suggestedFolderName);
              const renameTo = renames[originalName] ?? renames[cand.suggestedFolderName];
              const folderName = renameTo ? sanitizeFolderName(renameTo) : originalName;

              if (seenTargets.has(folderName)) {
                return jsonResponse(
                  {
                    success: false,
                    error: `多个 skill 解析到同一个文件夹名 "${folderName}"，请使用 renames 指定不同名称`,
                    conflict: true,
                    conflictFolder: folderName,
                  },
                  409,
                );
              }
              seenTargets.add(folderName);

              // If renamed, the rename target must not already exist on disk
              // (the user's original `overwrite` set was keyed on the original
              // name, not the rename target).
              if (renameTo && existsSync(join(baseDir, folderName))) {
                return jsonResponse(
                  {
                    success: false,
                    error: `重命名目标 "${folderName}" 已存在`,
                    conflict: true,
                    conflictFolder: folderName,
                  },
                  409,
                );
              }

              // Non-renamed conflict must be covered by `overwrite`
              if (!renameTo && existsSync(join(baseDir, folderName)) && !overwrite.has(folderName)) {
                return jsonResponse(
                  {
                    success: false,
                    error: `技能 "${folderName}" 已存在`,
                    conflict: true,
                    conflictFolder: folderName,
                  },
                  409,
                );
              }

              plan.push({ cand, folderName, originalName });
            }

            // ---------- Write phase (all validations have passed) ----------
            const payloadMap = buildInstallPayload(tree, chosen);
            const installed: Array<{ folderName: string; path: string; name: string; description: string }> = [];

            for (const { cand, folderName } of plan) {
              const files = payloadMap.get(cand.suggestedFolderName);
              if (!files) continue;

              const skillDir = join(baseDir, folderName);
              if (existsSync(skillDir) && overwrite.has(folderName)) {
                rmSync(skillDir, { recursive: true, force: true });
              }

              writeSkillFiles(skillDir, files);

              installed.push({
                folderName,
                path: skillDir,
                name: cand.name,
                description: cand.description,
              });
            }

            if (installed.length === 0) {
              return jsonResponse({ success: false, error: '没有任何 skill 被安装' }, 500);
            }

            if (scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }

            return jsonResponse({
              success: true,
              mode: 'installed',
              installed,
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          // ---------- Step A: no confirmedSelection — decide whether to auto-install or return preview ----------
          if (analysis.mode === 'marketplace') {
            return jsonResponse({
              success: true,
              mode: 'marketplace',
              preview: {
                marketplaceName: analysis.marketplaceName,
                marketplaceDescription: analysis.marketplaceDescription,
                plugins: analysis.plugins.map(p => ({
                  name: p.name,
                  description: p.description,
                  skills: p.skills.map(s => ({
                    suggestedFolderName: sanitizeFolderName(s.suggestedFolderName),
                    name: s.name,
                    description: s.description,
                    hasDangerousTools: s.hasDangerousTools,
                    conflict: existsSync(join(baseDir, sanitizeFolderName(s.suggestedFolderName))),
                  })),
                })),
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          if (analysis.mode === 'multi') {
            return jsonResponse({
              success: true,
              mode: 'multi',
              preview: {
                candidates: analysis.candidates.map(s => ({
                  suggestedFolderName: sanitizeFolderName(s.suggestedFolderName),
                  name: s.name,
                  description: s.description,
                  hasDangerousTools: s.hasDangerousTools,
                  rootPath: s.rootPath,
                  conflict: existsSync(join(baseDir, sanitizeFolderName(s.suggestedFolderName))),
                })),
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          // Single mode: check for conflict — if none, auto-install; if there is, return preview
          const cand = analysis.skill;
          const folderName = sanitizeFolderName(cand.suggestedFolderName);
          const conflicts = checkConflicts([cand]);

          if (conflicts.length > 0) {
            return jsonResponse({
              success: true,
              mode: 'single-conflict',
              preview: {
                skill: {
                  suggestedFolderName: folderName,
                  name: cand.name,
                  description: cand.description,
                  hasDangerousTools: cand.hasDangerousTools,
                  conflict: true,
                },
              },
              sourceUrl: tree.sourceUrl,
              effectiveRef: tree.effectiveRef,
            });
          }

          // Auto-install the single unambiguous skill
          const skillDir = join(baseDir, folderName);
          const files = buildInstallPayload(tree, [cand]).get(cand.suggestedFolderName);
          if (!files || files.size === 0) {
            return jsonResponse({ success: false, error: '未找到可安装的文件' }, 500);
          }

          writeSkillFiles(skillDir, files);

          if (scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }

          return jsonResponse({
            success: true,
            mode: 'installed',
            installed: [{
              folderName,
              path: skillDir,
              name: cand.name,
              description: cand.description,
            }],
            sourceUrl: tree.sourceUrl,
            effectiveRef: tree.effectiveRef,
          });
        } catch (error) {
          console.error('[api/skill/install-from-url] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Install failed' },
            500,
          );
        }
      }

      // ============= COMMANDS MANAGEMENT API =============
      // GET /api/command-items - List all commands
      // Supports ?agentDir= for listing commands from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/command-items' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { commandsDir: effectiveCommandsDir } = getProjectBaseDirs(queryAgentDir);
          const commandItems: Array<{
            name: string;
            fileName: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            author?: string;
          }> = [];

          const scanCommands = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const files = readdirSync(dir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(dir, file);
                const content = readFileSync(filePath, 'utf-8');
                const { frontmatter } = parseFullCommandContent(content);
                const fileName = extractCommandName(file);
                commandItems.push({
                  name: frontmatter.name || fileName,  // Prefer frontmatter name
                  fileName,  // Always include actual file name for reference
                  description: frontmatter.description || '',
                  scope: scopeType,
                  path: filePath,
                  author: frontmatter.author,
                });
              }
            } catch (scanError) {
              console.warn(`[api/command-items] Error scanning ${scopeType} commands:`, scanError);
            }
          };

          const resolvedProjectCommandsDir = effectiveCommandsDir || projectCommandsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectCommandsDir) {
            scanCommands(resolvedProjectCommandsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanCommands(userCommandsBaseDir, 'user');
          }

          return jsonResponse({ success: true, commands: commandItems });
        } catch (error) {
          console.error('[api/command-items] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list commands' },
            500
          );
        }
      }

      // GET /api/command-item/:name - Get command detail
      if (pathname.startsWith('/api/command-item/') && request.method === 'GET') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          const content = readFileSync(cmdPath, 'utf-8');
          const { frontmatter, body } = parseFullCommandContent(content);

          return jsonResponse({
            success: true,
            command: {
              name: frontmatter.name || cmdName,  // Prefer frontmatter name over file name
              fileName: cmdName,  // Always return the actual file name for reference
              path: cmdPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get command' },
            500
          );
        }
      }

      // PUT /api/command-item/:name - Update command
      if (pathname.startsWith('/api/command-item/') && request.method === 'PUT') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<CommandFrontmatter>;
            body: string;
            agentDir?: string; // Optional: explicit project directory
            newFileName?: string; // Optional: rename file if provided
          };

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : commandsDir;
          let currentFileName = cmdName;
          let cmdPath = join(baseDir, `${currentFileName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          // Handle file rename if newFileName is provided and different
          if (payload.newFileName && payload.newFileName !== currentFileName) {
            const newFileName = payload.newFileName;

            // Validate new file name
            if (!isValidItemName(newFileName)) {
              return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
            }

            const newCmdPath = join(baseDir, `${newFileName}.md`);

            // Check for conflict
            if (existsSync(newCmdPath)) {
              return jsonResponse({ success: false, error: `指令文件 "${newFileName}.md" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, file is renamed but content unchanged.
            const content = serializeCommandContent(payload.frontmatter, payload.body);

            // Rename the file
            renameSync(cmdPath, newCmdPath);
            cmdPath = newCmdPath;
            currentFileName = newFileName;

            // Write content to new location
            writeFileSync(cmdPath, content, 'utf-8');

            // User command renamed — re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
            return jsonResponse({
              success: true,
              path: cmdPath,
              fileName: currentFileName
            });
          }

          // No rename, just update content
          const content = serializeCommandContent(payload.frontmatter, payload.body);
          writeFileSync(cmdPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: cmdPath,
            fileName: currentFileName
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update command' },
            500
          );
        }
      }

      // DELETE /api/command-item/:name - Delete command
      if (pathname.startsWith('/api/command-item/') && request.method === 'DELETE') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          rmSync(cmdPath);
          // User command deleted — re-sync to remove dangling symlinks in project
          if (scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete command' },
            500
          );
        }
      }

      // POST /api/command-item/create - Create new command
      if (pathname === '/api/command-item/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for filename (supports Unicode characters like Chinese)
          const fileName = sanitizeFolderName(payload.name);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : projectCommandsBaseDir;

          // Ensure directory exists
          if (!existsSync(baseDir)) {
            ensureDirSync(baseDir);
          }

          const cmdPath = join(baseDir, `${fileName}.md`);

          if (existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command already exists' }, 409);
          }

          // Create command file with default content
          const frontmatter: Partial<CommandFrontmatter> = {
            name: payload.name,
            description: payload.description || '',
          };
          const body = `在这里编写指令的详细内容...`;
          const content = serializeCommandContent(frontmatter, body);

          writeFileSync(cmdPath, content, 'utf-8');

          // New user command — sync symlink into project so SDK can discover it
          if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true, path: cmdPath, name: fileName });
        } catch (error) {
          console.error('[api/command-item/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create command' },
            500
          );
        }
      }

      // ============= SUB-AGENTS API =============

      const userAgentsBaseDir = join(homeDir, '.myagents', 'agents');

      // Helper: Get project agents directory (supports explicit agentDir parameter)
      const getProjectAgentsDir = (queryAgentDir: string | null) => {
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          queryAgentDir = null;
        }
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return hasValidDir ? join(effectiveAgentDir, '.claude', 'agents') : '';
      };

      // Validate an agent folderName accepted by GET/PUT/DELETE /api/agent/:name.
      //
      // Unlike `isValidItemName` (which rejects '/'), agents now use a
      // path-like identity for the 'nested' layout (e.g. `team/reviewer`).
      // Security rests on two things: each segment still flows through
      // `isValidItemName` (blocking '..', '\\', Windows reserved names,
      // control chars, reserved punctuation), and findAgent() only ever
      // returns real on-disk paths produced by scanAgents — the value we
      // receive is matched by string equality against scanned folderNames,
      // never concatenated into a path.
      const isValidAgentFolderName = (name: string): boolean => {
        if (!name || name.length > 512) return false;
        if (name.includes('\\')) return false;
        // eslint-disable-next-line no-control-regex -- explicit control-char ban for filename-like input
        if (/[\x00-\x1f\x7f]/.test(name)) return false;
        for (const seg of name.split('/')) {
          if (!seg || seg === '.' || seg === '..') return false;
          if (!isValidItemName(seg)) return false;
        }
        return true;
      };

      // GET /api/agents - List all agents (with scope filter)
      if (pathname === '/api/agents' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const projAgentsDir = getProjectAgentsDir(queryAgentDir);

          let agents: Array<{ name: string; description: string; scope: 'user' | 'project'; path: string; folderName: string }> = [];

          if ((scope === 'all' || scope === 'project') && projAgentsDir) {
            agents = agents.concat(scanAgents(projAgentsDir, 'project'));
          }
          if (scope === 'all' || scope === 'user') {
            agents = agents.concat(scanAgents(userAgentsBaseDir, 'user'));
          }

          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' },
            500
          );
        }
      }

      // GET /api/agent/sync-check - Check if there are agents to sync from Claude Code
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      //
      // Driven by `scanAgents()` so the three SDK-recognised layouts (folder /
      // flat / nested) are all counted — same rule the loader uses for runtime
      // discovery. Agents that Claude Code's SDK sees but that only have a
      // top-level `.md` file (flat) or a subdirectory path (nested) used to
      // silently disappear from the sync UI; now they're first-class.
      if (pathname === '/api/agent/sync-check' && request.method === 'GET') {
        try {
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // scanAgents handles: junctions (via realpath), all 3 layouts,
          // frontmatter validation, dedup by folderName with layout priority.
          // Scope arg ('user') only affects the returned AgentItem.scope —
          // not the scan behavior.
          const claudeAgents = scanAgents(claudeAgentsDir, 'user');

          if (claudeAgents.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          const myagentsAgents = scanAgents(userAgentsBaseDir, 'user');
          const myagentsSet = new Set(myagentsAgents.map(a => a.folderName));

          // folderName is the canonical agent identity (e.g. "code-reviewer"
          // for flat, "team/reviewer" for nested, "novels" for folder). The
          // client passes these back to sync-from-claude, and we re-validate
          // them against scanAgents output at that time — no raw filesystem
          // name is trusted across the request boundary.
          const allFolders = claudeAgents.map(a => a.folderName);
          const newFolders = claudeAgents.filter(a => !myagentsSet.has(a.folderName)).map(a => a.folderName);
          const conflictFolders = claudeAgents.filter(a => myagentsSet.has(a.folderName)).map(a => a.folderName);

          return jsonResponse({
            canSync: allFolders.length > 0,
            count: allFolders.length,
            folders: allFolders,
            newFolders,
            conflictFolders,
          });
        } catch (error) {
          console.error('[api/agent/sync-check] Error:', error);
          return jsonResponse({ canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' }, 500);
        }
      }

      // POST /api/agent/sync-from-claude - Sync agents from Claude Code to MyAgents
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      // Supports conflict handling: mode = 'skip' (default) | 'overwrite'
      //
      // Preserves the source agent's layout:
      //   folder  (.claude/agents/foo/foo.md)        → ~/.myagents/agents/foo/foo.md  + _meta.json
      //   flat    (.claude/agents/foo.md)            → ~/.myagents/agents/foo.md       (no _meta.json — flat has no home for it)
      //   nested  (.claude/agents/team/reviewer.md)  → ~/.myagents/agents/team/reviewer.md  (ditto)
      //
      // Why preserve instead of canonicalize to `folder`: `nested` folderNames
      // contain `/` (e.g. "team/reviewer"), which collapses ambiguously if
      // flattened — "team/reviewer" and just "reviewer" would collide. Keeping
      // the source layout is lossless + matches Claude Code's own storage
      // convention. `scanAgents()` (loader side) already reads all three.
      if (pathname === '/api/agent/sync-from-claude' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { mode?: 'skip' | 'overwrite'; folders?: string[] };
          const conflictMode = payload.mode || 'skip';
          const selectedFolders = payload.folders; // Optional: sync only these specific folderNames

          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, skipped: 0, overwritten: 0, error: 'Claude Code agents directory not found' }, 404);
          }

          // Enumerate via the same protocol-aligned scanner that sync-check uses.
          // Index by folderName so selectedFolders can only reach agents the
          // scanner actually saw — no raw-path injection across the boundary.
          const claudeAgents = scanAgents(claudeAgentsDir, 'user');
          const claudeByName = new Map(claudeAgents.map(a => [a.folderName, a]));

          const foldersToSync = selectedFolders
            ? selectedFolders.filter(f => claudeByName.has(f))
            : Array.from(claudeByName.keys());

          if (foldersToSync.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, skipped: 0, overwritten: 0, message: 'No agents to sync' });
          }

          if (!existsSync(userAgentsBaseDir)) {
            ensureDirSync(userAgentsBaseDir);
          }

          let synced = 0;
          let failed = 0;
          let skipped = 0;
          let overwritten = 0;
          const errors: string[] = [];
          const conflicts: string[] = [];

          for (const folderName of foldersToSync) {
            const src = claudeByName.get(folderName);
            if (!src) continue;  // defensive, already filtered above

            try {
              // Conflict probe via the SAME scanner used for sync-check, so the
              // "conflict" decision is symmetric regardless of which layout the
              // existing agent lives in on our side (folder vs flat vs nested).
              const existing = findAgent(userAgentsBaseDir, 'user', folderName);
              if (existing) {
                if (conflictMode === 'skip') {
                  skipped++;
                  conflicts.push(folderName);
                  continue;
                }
                // Overwrite: delete the existing agent's own path, which may
                // be in a different layout than the source. `rm({ recursive,
                // force })` handles both file (flat/nested .md) and directory
                // (folder layout) targets. For folder layout we strip back to
                // the folder itself to avoid leaving a ghost _meta.json.
                const existingTarget = existing.layout === 'folder'
                  ? dirname(existing.path)  // the <folderName>/ directory
                  : existing.path;          // the .md file itself
                await rm(existingTarget, { recursive: true, force: true });
                overwritten++;
              }

              // Compute target path from the SOURCE's layout (preserve).
              // For folder layout, copy the whole source directory (may include
              // sibling resources like README.md, data files, etc.). For
              // flat/nested, it's a single-file copy.
              if (src.layout === 'folder') {
                const srcDir = dirname(src.path);
                const destDir = join(userAgentsBaseDir, folderName);
                await copyDirRecursive(srcDir, destDir, '[api/agent/sync-from-claude]');

                // Write _meta.json (only folder layout has a stable home for it).
                // Auto-generated from frontmatter.name so the UI shows a friendly
                // displayName and recognises the agent as synced via the
                // `claude-code-sync` author marker.
                const mdPath = join(destDir, `${folderName}.md`);
                const metaPath = join(destDir, '_meta.json');
                if (existsSync(mdPath) && !existsSync(metaPath)) {
                  try {
                    const content = readFileSync(mdPath, 'utf-8');
                    const { name: agentName } = parseAgentFrontmatter(content);
                    const meta = {
                      displayName: agentName || folderName,
                      author: 'claude-code-sync',
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    };
                    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                  } catch { /* _meta.json generation is optional */ }
                }
              } else {
                // flat or nested: single-file copy. For nested we need to
                // `ensureDir` the parent chain (e.g. "team/" for folderName
                // "team/reviewer"). For flat the parent is userAgentsBaseDir
                // which we already ensured above.
                //
                // folderName for flat is the stem ("foo" → "foo.md"); for
                // nested it's the POSIX stem path ("team/reviewer" →
                // "team/reviewer.md"). Joining with path.join naturally
                // produces the correct OS-specific path on Windows.
                const destPath = join(userAgentsBaseDir, `${folderName}.md`);
                await ensureDir(dirname(destPath));
                await copyFileAsync(src.path, destPath);
              }

              synced++;
            } catch (copyError) {
              failed++;
              errors.push(`${folderName}: ${copyError instanceof Error ? copyError.message : 'Unknown error'}`);
              console.error(`[api/agent/sync-from-claude] Failed to sync "${folderName}":`, copyError);
            }
          }

          return jsonResponse({
            success: true,
            synced,
            failed,
            skipped,
            overwritten,
            conflicts,
            errors: errors.length > 0 ? errors : undefined,
          });
        } catch (error) {
          console.error('[api/agent/sync-from-claude] Error:', error);
          return jsonResponse({ success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' }, 500);
        }
      }

      // POST /api/agent/create - Create new agent
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          const folderName = sanitizeFolderName(payload.name);
          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;

          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          const agentFolderDir = join(baseDir, folderName);
          if (existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: 'Agent already exists' }, 409);
          }

          ensureDirSync(agentFolderDir);

          const frontmatter: Partial<AgentFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your agent instructions here.`;
          const content = serializeAgentContent(frontmatter, body);

          const agentPath = join(agentFolderDir, `${folderName}.md`);
          writeFileSync(agentPath, content, 'utf-8');

          // Create default _meta.json
          writeAgentMeta(agentFolderDir, {
            displayName: payload.name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          return jsonResponse({ success: true, path: agentPath, folderName });
        } catch (error) {
          console.error('[api/agent/create] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to create agent' }, 500);
        }
      }

      // GET /api/agents/workspace-config - Read workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: true, config: { local: {}, global_refs: {} } });
          }
          const config = readWorkspaceConfig(effectiveDir);
          return jsonResponse({ success: true, config });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to read config' }, 500);
        }
      }

      // PUT /api/agents/workspace-config - Update workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'PUT') {
        try {
          const payload = await request.json() as { config: AgentWorkspaceConfig; agentDir?: string };
          const effectiveDir = (payload.agentDir && isValidAgentDir(payload.agentDir).valid ? payload.agentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
          writeWorkspaceConfig(effectiveDir, payload.config);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' }, 500);
        }
      }

      // GET /api/agents/enabled - Get enabled agents as SDK definitions
      if (pathname === '/api/agents/enabled' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          const projAgentsDir = effectiveDir ? join(effectiveDir, '.claude', 'agents') : '';
          const agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents/enabled] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to load agents' }, 500);
        }
      }

      // POST /api/agents/set - Set agents and trigger session resume
      if (pathname === '/api/agents/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { agents: Record<string, unknown> };
          // Multi-Agent Runtime gate (mirrors /api/mcp/set above): external
          // runtimes don't consume the SDK AgentDefinition map, so forwarding
          // to setAgents() in builtin agent-session would just churn the
          // pre-warm fingerprint without effect. The renderer should not be
          // posting here when external runtime is active; this is the
          // server-side belt for the cases when it does (heartbeat, IM Cron,
          // tooling that hasn't been migrated).
          if (shouldUseExternalRuntime()) {
            return jsonResponse({ success: true, skipped: 'external-runtime' });
          }
          // The payload.agents is already in SDK AgentDefinition format
          setAgents(payload.agents as Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);
        }
      }

      // GET /api/supported-models - Get available models from SDK
      // Spawns a lightweight SDK subprocess (same pattern as provider verify)
      if (pathname === '/api/supported-models' && request.method === 'GET') {
        try {
          const { fetchSdkSupportedModels } = await import('./provider-verify');
          const models = await fetchSdkSupportedModels();
          return jsonResponse({ models });
        } catch (error) {
          console.error('[api/supported-models] Error:', error);
          return jsonResponse({ models: [], error: error instanceof Error ? error.message : 'Failed to get models' });
        }
      }

      // POST /api/model/set - Set default model for this session
      if (pathname === '/api/model/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { model?: string };
          if (!payload?.model) {
            return jsonResponse({ success: false, error: 'model is required' }, 400);
          }
          if (shouldUseExternalRuntime()) {
            await setExternalModel(payload.model);
            return jsonResponse({ success: true });
          }
          setSessionModel(payload.model);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/model/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }

      // POST /api/provider/set - Set provider env for this session (called by Rust IM router on sidecar creation)
      if (pathname === '/api/provider/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { providerEnv?: Record<string, unknown> };
          const { setSessionProviderEnv } = await import('./agent-session');
          // Normalize null → undefined (Rust sends { "providerEnv": null } when clearing)
          setSessionProviderEnv((payload?.providerEnv ?? undefined) as import('./agent-session').ProviderEnv | undefined);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/provider/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set provider' }, 500);
        }
      }

      // POST /api/session/permission-mode - Set permission mode for this session (called by Rust IM router)
      if (pathname === '/api/session/permission-mode' && request.method === 'POST') {
        try {
          const payload = await request.json() as { permissionMode?: string };
          if (!payload?.permissionMode) {
            return jsonResponse({ success: false, error: 'permissionMode is required' }, 400);
          }
          if (shouldUseExternalRuntime()) {
            await setExternalPermissionMode(payload.permissionMode);
            return jsonResponse({ success: true });
          }
          const { setSessionPermissionMode } = await import('./agent-session');
          setSessionPermissionMode(payload.permissionMode as import('./agent-session').PermissionMode);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/session/permission-mode] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set permission mode' }, 500);
        }
      }

      // POST /api/session/freeze - Stamp an OwnedSessionSnapshot onto the
      // session metadata, converting it from D4 live-follow to a frozen
      // historical session.
      //
      // Used by the Rust `cmd_update_agent_config` runtime-change orchestrator:
      // when an agent's runtime is about to change, every bot-bound session
      // (peer_session) is frozen FIRST with the agent's about-to-be-replaced
      // config, then its session_id is rotated. The old session detaches and
      // becomes a regular historical session that, on reopen, uses its captured
      // OLD runtime + config (matching the desktop session reopening path).
      //
      // Body: { sessionId, snapshot: OwnedSessionSnapshot } — Rust supplies
      // the field values it just read from the agent state on disk. Only
      // fields that are present and pass per-field type validation are
      // patched onto the session metadata; absent or wrong-typed fields are
      // skipped (NOT cleared) — keeps the HTTP path symmetric with the Rust
      // file-lock fallback writer in `runtime_change.rs::freeze_via_file_lock`,
      // which only inserts present keys. (review-by-codex F2: original
      // unconditionally spread `undefined` into present fields, so a missing
      // `model` would silently nuke the existing model on the session.)
      //
      // `configSnapshotAt` is ALWAYS stamped here at write time, not passed
      // through the wire — the marker reflects when the freeze committed,
      // not when Rust composed the payload.
      if (pathname === '/api/session/freeze' && request.method === 'POST') {
        try {
          const raw = await request.json() as Record<string, unknown>;
          if (typeof raw?.sessionId !== 'string' || !raw.sessionId) {
            return jsonResponse({ success: false, error: 'sessionId required' }, 400);
          }
          const snapshot = raw.snapshot as Record<string, unknown> | undefined;
          if (!snapshot || typeof snapshot !== 'object') {
            return jsonResponse({ success: false, error: 'snapshot required' }, 400);
          }

          // Build a typed patch with ONLY the fields that are present AND
          // pass per-field validation. Always stamp configSnapshotAt.
          const { updateSessionMetadata } = await import('./SessionStore');
          type FreezePatch = Parameters<typeof updateSessionMetadata>[1];
          const patch: FreezePatch = {
            configSnapshotAt: new Date().toISOString(),
          };
          if (typeof snapshot.runtime === 'string' && snapshot.runtime.length > 0) {
            patch.runtime = snapshot.runtime as FreezePatch['runtime'];
          }
          if (typeof snapshot.model === 'string') {
            patch.model = snapshot.model;
          }
          if (typeof snapshot.permissionMode === 'string') {
            patch.permissionMode = snapshot.permissionMode;
          }
          if (Array.isArray(snapshot.mcpEnabledServers)) {
            const ids = snapshot.mcpEnabledServers.filter(
              (v): v is string => typeof v === 'string',
            );
            patch.mcpEnabledServers = ids;
          }
          if (typeof snapshot.providerId === 'string') {
            patch.providerId = snapshot.providerId;
          }
          if (typeof snapshot.providerEnvJson === 'string') {
            patch.providerEnvJson = snapshot.providerEnvJson;
          }

          const updated = await updateSessionMetadata(raw.sessionId, patch);
          if (!updated) {
            return jsonResponse({ success: false, error: 'session not found' }, 404);
          }
          console.log(`[api/session/freeze] frozen sessionId=${raw.sessionId.slice(0, 8)} runtime=${updated.runtime ?? 'builtin'}`);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/session/freeze] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to freeze session' }, 500);
        }
      }

      // GET /api/session/config - Read sidecar's current config state
      // Used by Tabs joining an existing sidecar (e.g. IM Bot session) to adopt
      // the session's config instead of pushing their own.
      if (pathname === '/api/session/config' && request.method === 'GET') {
        try {
          if (shouldUseExternalRuntime()) {
            return jsonResponse({
              success: true,
              runtime: getActiveRuntimeType(),
              model: getExternalSessionModel(),
              mcpServerIds: null,
              agentNames: null,
              permissionMode: getExternalSessionPermissionMode(),
            });
          }

          const { getSessionModel, getMcpServers, getAgents, getSessionPermissionMode } = await import('./agent-session');
          const model = getSessionModel();
          const mcpServers = getMcpServers();
          const agents = getAgents();
          const permissionMode = getSessionPermissionMode();
          return jsonResponse({
            success: true,
            runtime: 'builtin',
            model: model ?? null,
            mcpServerIds: mcpServers?.map(s => s.id) ?? null,
            agentNames: agents ? Object.keys(agents) : null,
            permissionMode,
          });
        } catch (error) {
          console.error('[api/session/config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get session config' }, 500);
        }
      }

      // GET /api/agent/:name - Get agent detail
      //
      // `folderName` is the UI-facing stable id (see agent-loader.ts for its
      // computation rules). We can't hard-assemble the path as
      // `<base>/<folderName>/<folderName>.md` anymore — flat/nested layouts
      // live elsewhere — so we scan and look up by folderName, reusing
      // `AgentItem.path` / `.layout` from there.
      if (pathname.startsWith('/api/agent/') && request.method === 'GET') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;

          const item = findAgent(baseDir, scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          const content = readFileSync(item.path, 'utf-8');
          const { frontmatter, body } = parseFullAgentContent(content);

          return jsonResponse({
            success: true,
            agent: {
              name: frontmatter.name || item.folderName,
              folderName: item.folderName,
              path: item.path,
              scope,
              layout: item.layout,
              frontmatter,
              body,
              ...(item.meta ? { meta: item.meta } : {}),
            }
          });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get agent' }, 500);
        }
      }

      // PUT /api/agent/:name - Update agent (with optional folder rename for
      // 'folder' layout only)
      //
      // Lookup is by (folderName, scope) via findAgent(); we never reassemble
      // the path. Rename stays restricted to the canonical 'folder' layout:
      //   - flat agents live next to siblings and would collide on rename
      //   - nested agents belong to a user-managed directory tree (Claude
      //     Code plugin, synced-in content, etc.) — renaming would mutate
      //     their container out from under them
      // Callers can relocate such agents by hand; UI should hide the rename
      // affordance when `layout !== 'folder'`.
      if (pathname.startsWith('/api/agent/') && request.method === 'PUT') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<AgentFrontmatter>;
            body: string;
            newFolderName?: string;
            agentDir?: string;
            meta?: AgentMeta;
          };

          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;

          const item = findAgent(baseDir, payload.scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          let currentFolderName = item.folderName;
          let agentPath = item.path;
          let agentFolderDir = dirname(item.path);

          // Rename is only meaningful for the 'folder' layout
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            if (item.layout !== 'folder') {
              return jsonResponse({
                success: false,
                error: `当前 Agent 布局为 ${item.layout}，不支持重命名。请手动调整文件结构后再试。`,
              }, 400);
            }
            const newFolderName = payload.newFolderName;
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }
            const newAgentDir = join(baseDir, newFolderName);
            if (existsSync(newAgentDir)) {
              return jsonResponse({ success: false, error: `Agent 文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            const content = serializeAgentContent(payload.frontmatter, payload.body);
            renameSync(agentFolderDir, newAgentDir);
            agentFolderDir = newAgentDir;
            currentFolderName = newFolderName;

            // Rename the .md file inside to match new folder name
            const oldMdPath = join(agentFolderDir, `${item.folderName}.md`);
            agentPath = join(agentFolderDir, `${newFolderName}.md`);
            if (existsSync(oldMdPath)) {
              renameSync(oldMdPath, agentPath);
            }

            writeFileSync(agentPath, content, 'utf-8');
            const existingMeta = readAgentMeta(agentFolderDir);
            const updatedMeta = { ...existingMeta, ...payload.meta, displayName: payload.frontmatter.name || newFolderName, updatedAt: new Date().toISOString() };
            writeAgentMeta(agentFolderDir, updatedMeta);
            return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
          }

          // No rename — update content in place regardless of layout
          const content = serializeAgentContent(payload.frontmatter, payload.body);
          writeFileSync(agentPath, content, 'utf-8');

          // _meta.json only lives next to 'folder' layout agents. For flat /
          // nested, skip — there's no unambiguous place for it.
          if (item.layout === 'folder') {
            const existingMeta = readAgentMeta(agentFolderDir);
            if (payload.meta || (payload.frontmatter.name && payload.frontmatter.name !== existingMeta?.displayName)) {
              const updatedMeta = { ...existingMeta, ...payload.meta, updatedAt: new Date().toISOString() };
              if (payload.frontmatter.name) updatedMeta.displayName = payload.frontmatter.name;
              writeAgentMeta(agentFolderDir, updatedMeta);
            }
          }
          return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update agent' }, 500);
        }
      }

      // DELETE /api/agent/:name - Delete agent
      //
      // Deletion shape depends on layout:
      //   - folder: remove the whole <base>/<folderName>/ directory
      //   - flat:   remove the single <base>/<folderName>.md file
      //   - nested: remove only the .md file, leave the surrounding directory
      //             structure alone (it's user- or plugin-managed)
      if (pathname.startsWith('/api/agent/') && request.method === 'DELETE') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;

          const item = findAgent(baseDir, scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          if (item.layout === 'folder') {
            rmSync(dirname(item.path), { recursive: true, force: true });
          } else {
            rmSync(item.path, { force: true });
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' }, 500);
        }
      }

      // ============= END SLASH COMMANDS API =============

      // ============= IM BOT API =============
      // These endpoints are called by the Rust IM layer (SessionRouter)

      // ============= IM Pipeline v2 (Pattern C/D) =============
      // /api/im/enqueue   — sync ACK, no SSE; peer_lock on Rust side only
      //                     wraps this call (ms-level), enabling true mid-turn
      //                     concurrency for same-chat messages.
      // /api/im/events    — long-poll SSE; one connection per peer_session,
      //                     events tagged with requestId, supports `since=<seq>`
      //                     for crash-recovery resume.
      // /api/im/cancel    — abort an in-flight request by requestId; ties into
      //                     v0.2.0 `cancellableFetch` / AbortSignal semantics.

      // POST /api/im/enqueue — Pattern C: enqueue an IM message and return immediately.
      // Replaces /api/im/chat. Body shape identical, but no SSE response — events
      // flow over /api/im/events long-poll instead.
      if (pathname === '/api/im/enqueue' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as {
            message: string;
            source: string;
            sourceId: string;
            senderName?: string;
            permissionMode?: string;
            providerEnv?: ProviderEnv;
            model?: string;
            runtime?: RuntimeType;
            runtimeConfig?: RuntimeConfig;
            images?: ImagePayload[];
            botId?: string;
            botName?: string;
            // Pattern A — Per-Request Identity. REQUIRED for /api/im/enqueue
            // (Rust generates at edge). The legacy /api/im/chat tolerated absence
            // because the SSE+callback model was 1:1; the new bus model needs the
            // ID to route events.
            requestId: string;
            sourceType?: 'group';
            groupName?: string;
            groupPlatform?: string;
            groupActivation?: 'mention' | 'always';
            isFirstGroupTurn?: boolean;
            pendingHistory?: string;
            groupToolsDeny?: string[];
            replyToBody?: string;
            groupSystemPrompt?: string;
            isMention?: boolean;
            messageCount?: number;
            bridgePort?: number;
            bridgePluginId?: string;
            bridgeEnabledToolGroups?: string[];
            senderId?: string;
            senderIsOwner?: boolean;
          };

          if (!payload.requestId) {
            return jsonResponse({ success: false, error: 'Missing requestId (Pattern C requires it)' }, 400);
          }
          const hasContent = payload.message?.trim() || (payload.images && payload.images.length > 0);
          if (!hasContent) {
            return jsonResponse({ success: false, error: 'Message or images required' }, 400);
          }

          // Register in registry up front so /api/im/cancel works even before
          // enqueueUserMessage returns. AbortController is paired here for
          // Pattern D wiring (cancellableFetch hooks below).
          // W7 fix: status='running' set BEFORE the enqueueUserMessage call so a
          // synchronous-completing turn (rare: queued message dequeues immediately)
          // doesn't race ahead and unregister the entry before we set 'running'.
          imRequestRegistry.register(payload.requestId, getSessionId() || null, payload.source);
          imRequestRegistry.setStatus(payload.requestId, 'running');

          try {

          // Set IM cron context for the im-cron tool (parity with /api/im/chat)
          if (payload.botId && process.env.MYAGENTS_MANAGEMENT_PORT) {
            const { getSessionModel } = await import('./agent-session');
            const payloadRuntime = payload.runtime ?? getActiveRuntimeType();
            const payloadRuntimeConfig = payload.runtimeConfig ?? null;
            const imCronModel = payloadRuntime === 'builtin'
              ? (payload.model ?? getSessionModel())
              : getRuntimeConfigModel(payloadRuntimeConfig);
            // PRD 0.2.9 — Resolve providerId from the workspace agent so
            // the IM cron tool can create live-resolve crons. Only meaningful
            // for builtin runtime (external runtimes manage their own provider).
            const imAgentForProvider = payloadRuntime === 'builtin'
              ? findAgentByWorkspacePath(agentDir)
              : null;
            const imProviderId = (imAgentForProvider?.providerId as string | undefined) ?? undefined;
            setImCronContext({
              botId: payload.botId,
              chatId: payload.sourceId,
              platform: payload.source.split('_')[0],
              workspacePath: agentDir,
              model: imCronModel,
              permissionMode: payloadRuntime === 'builtin'
                ? payload.permissionMode
                : getRuntimeConfigPermissionMode(payloadRuntimeConfig),
              // Legacy frozen env (kept for back-compat); sidecar prefers
              // `providerId` when both are present.
              providerEnv: payloadRuntime === 'builtin' && payload.providerEnv ? {
                baseUrl: payload.providerEnv.baseUrl,
                apiKey: payload.providerEnv.apiKey,
                authType: payload.providerEnv.authType,
                apiProtocol: payload.providerEnv.apiProtocol,
                maxOutputTokens: payload.providerEnv.maxOutputTokens,
                maxOutputTokensParamName: payload.providerEnv.maxOutputTokensParamName,
                upstreamFormat: payload.providerEnv.upstreamFormat,
              } : undefined,
              providerId: imProviderId,
              runtime: payloadRuntime,
              runtimeConfig: payloadRuntime === 'builtin' ? undefined : payloadRuntimeConfig ?? undefined,
            });
            setImMediaContext({
              botId: payload.botId,
              chatId: payload.sourceId,
              platform: payload.source.split('_')[0],
              workspacePath: agentDir,
            });
            if (payload.bridgePort && payload.bridgePluginId) {
              const bridgeSourceType = payload.source?.split('_')[1] as string | undefined;
              await setImBridgeToolsContext({
                bridgePort: payload.bridgePort,
                pluginId: payload.bridgePluginId,
                enabledToolGroups: payload.bridgeEnabledToolGroups || [],
                senderId: payload.senderId,
                chatId: payload.sourceId,
                isOwner: payload.senderIsOwner ?? false,
                sourceType: bridgeSourceType,
              });
            }

            // After IM context (which gates the `im-bridge-tools` MCP) is set,
            // sync the SDK's MCP list so it picks up the bridge server. Without
            // this, the pre-warmed SDK (started by heartbeat before any IM
            // message) keeps a stale mcpServers config and bridge plugin tools
            // appear "disconnected".
            //
            // (v0.2.11) `im-media` was retired here — `myagents im send-media`
            // CLI is the new path, no SDK sync needed for it. `im-bridge-tools`
            // is the only remaining context-injected MCP this re-sync targets.
            //
            // Position note: called BEFORE setInteractionScenario so the pre-warm's
            // current scenario (typically 'desktop' until the first IM message) is
            // preserved in the diff. Removing scenario-bound MCPs mid-session would
            // leave the SDK's frozen systemPrompt referencing tools that no longer
            // exist. This pass is purely additive for the IM-context tools the AI
            // is about to need; scenario alignment is a separate concern.
            //
            // Builtin runtime only — external runtimes (CC/Codex) manage their own MCP set.
            if (!shouldUseExternalRuntime()) {
              await ensureSdkMcpInSync();
            }
          }

          // Set IM interaction scenario (after MCP sync, see note above)
          {
            const [imPlatform, imSourceType] = payload.source.split('_') as ['telegram' | 'feishu', 'private' | 'group'];
            setInteractionScenario({
              type: 'im',
              platform: imPlatform,
              sourceType: imSourceType,
              botName: payload.botName,
            });
          }

          // Build final message with group context (identical to /api/im/chat)
          let finalMessage = payload.message || '';
          if (payload.sourceType === 'group') {
            const parts: string[] = [];
            const isAlways = payload.groupActivation === 'always';
            const sanitize = (s: string) => s.replace(/[<>[\]]/g, '').replace(/\n/g, ' ').trim();
            const botName = sanitize(payload.botName ?? 'AI');
            const platformLabel = sanitize(payload.groupPlatform ?? '');
            const messageCount = payload.messageCount ?? 0;
            const shouldInjectFullRules = payload.isFirstGroupTurn || (messageCount > 0 && messageCount % 10 === 0);

            if (shouldInjectFullRules) {
              const safeGroupName = sanitize(payload.groupName ?? '未知群聊');
              let reminder = `<system-reminder>\n[群聊信息]\n你正在「${safeGroupName}」${platformLabel}群聊中。你的名字是「${botName}」。`;
              if (isAlways) {
                reminder += '\n激活模式：全部消息（你会收到群里所有消息，包括不是发给你的）。';
              } else {
                reminder += '\n激活模式：仅 @提及（只有被 @、被回复或使用 /ask 时才会收到消息）。';
              }
              reminder += '\n你的回复会自动发送到群里，直接回复即可。\n群内不同人的消息会以 [from: 名字 时间] 标注发送者。';
              if (isAlways) {
                const mentionExample = payload.botName ? `（即 @${botName}）` : '';
                reminder += `\n\n[回复规则]\n你必须非常克制，大多数消息不需要你回复。仅在以下情况回复：\n1. 消息明确 @你${mentionExample}（即使消息同时也 @了其他人，只要 @了你就必须回复）\n2. 消息回复了你之前的消息\n3. 有人直接向你提问或请求帮助\n4. 你确信能提供明确价值的信息\n\n以下情况必须保持沉默：\n- 消息没有 @你，只 @了其他人或其他机器人\n- 普通闲聊、与你无关的讨论\n- 你不确定是否该回复时\n\n判断是否 @了你：看 [本条消息 @了你] 标记，而不是看消息正文中的 @用户名。\n不需要回复时，只回复 <NO_REPLY>，不要添加任何其他内容。`;
              }
              if (payload.groupSystemPrompt) {
                reminder += `\n\n[群聊指令]\n${payload.groupSystemPrompt}`;
              }
              reminder += '\n</system-reminder>';
              parts.push(reminder);
            } else if (isAlways) {
              parts.push(`<system-reminder>\n你是「${botName}」，当前处于群聊的全部消息模式 — 你会收到群聊内的全部信息，你需要自主判断是否需要回复消息。与自己无关的消息不要回复，没有 @你、仅 @了其他人的消息不要回复。注意：[本条消息 @了你] 标记才是判断依据，消息正文中可能同时 @了多人。当你判断不需要回复消息时，只输出字符<NO_REPLY>\n</system-reminder>`);
            }
            if (payload.pendingHistory) parts.push(payload.pendingHistory);
            if (payload.replyToBody) parts.push(`[引用回复]\n> ${payload.replyToBody.split('\n').join('\n> ')}`);
            const now = new Date();
            const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
            let messageBlock = '';
            if (isAlways) {
              messageBlock += payload.isMention ? '[本条消息 @了你，你需要回复]\n' : '[本条消息未 @你]\n';
            }
            // Fall back to senderId when the plugin didn't provide a senderName
            // (WeCom's aibot_msg_callback only carries `from.userid`, no name —
            // unlike Feishu which enriches senderName via contacts API). The
            // Rust group_history writer (im/mod.rs:2393/2419) already does the
            // same fallback; without it here the live message has no [from:]
            // tag while history entries do, breaking the system-reminder's
            // promise that "群内不同人的消息会以 [from: 名字 时间] 标注".
            const displaySender = payload.senderName || payload.senderId;
            messageBlock += displaySender ? `[from: ${sanitize(displaySender)} ${ts}]\n` : '';
            messageBlock += finalMessage;
            parts.push(messageBlock);
            finalMessage = parts.join('\n\n');
          } else if (payload.replyToBody) {
            finalMessage = `[引用回复]\n> ${payload.replyToBody.split('\n').join('\n> ')}\n\n${finalMessage}`;
          }

          const DEFAULT_GROUP_TOOLS_DENY = ['Bash', 'Edit', 'Write'];
          if (payload.sourceType === 'group') {
            const denyList = payload.groupToolsDeny !== undefined ? payload.groupToolsDeny : DEFAULT_GROUP_TOOLS_DENY;
            setGroupToolsDeny(denyList);
          } else {
            setGroupToolsDeny([]);
          }

          const metadata = {
            source: payload.source as SessionSource,
            sourceId: payload.sourceId,
            senderName: payload.senderName,
          };

          // Dispatch to runtime (External vs Builtin)
          if (shouldUseExternalRuntime()) {
            const imSource = payload.source.split('_')[0];
            const imSourceType = payload.source.includes('group') ? 'group' as const : 'private' as const;
            const payloadRuntime = payload.runtime ?? getActiveRuntimeType();
            const runtimeConfig = payload.runtimeConfig ?? null;
            if (payloadRuntime !== getActiveRuntimeType()) {
              console.error(
                `[im/enqueue] Runtime mismatch (Rust drift detection failed to catch): sidecar=${getActiveRuntimeType()} payload=${payloadRuntime}.`,
              );
            }
            const ccResult = await sendExternalMessage(
              finalMessage, payload.images ?? undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'agent-channel' as const, platform: imSource, sourceType: imSourceType, botName: payload.botName },
                permissionMode: getRuntimeConfigPermissionMode(runtimeConfig),
                model: getRuntimeConfigModel(runtimeConfig),
                requestId: payload.requestId,
              },
            );
            if (!ccResult.queued) {
              imRequestRegistry.unregister(payload.requestId);
              return jsonResponse({ success: false, error: ccResult.error ?? 'Failed to send via external runtime' }, 503);
            }
          } else {
            // PRD 0.2.14 Q4·A — handover-aware permission mode resolution.
            // After a desktop session is handed over to this channel, the
            // session carries a `configSnapshotAt` from its desktop creation.
            // In that case the user's intent is "the desktop session's mode
            // wins" (the desktop session is the authoritative state), so we
            // ignore the live Agent values that Rust passed in payload.
            // Pure IM-origin sessions never have a snapshot, so this branch
            // is a no-op for them and behavior matches v0.2.13.
            let resolvedPermissionMode: PermissionMode = (payload.permissionMode as PermissionMode) ?? 'plan';
            let resolvedModel: string | undefined = payload.model ?? undefined;
            let resolvedProviderEnv: ProviderEnv | undefined = payload.providerEnv ?? undefined;
            const sidForSnapshot = getSessionId();
            const snapshotMeta = sidForSnapshot ? getSessionMetadata(sidForSnapshot) : null;
            if (snapshotMeta?.configSnapshotAt) {
              if (snapshotMeta.permissionMode) {
                resolvedPermissionMode = snapshotMeta.permissionMode as PermissionMode;
              }
              if (snapshotMeta.model) {
                resolvedModel = snapshotMeta.model;
              }
              if (snapshotMeta.providerEnvJson) {
                try {
                  resolvedProviderEnv = JSON.parse(snapshotMeta.providerEnvJson) as ProviderEnv;
                } catch { /* malformed snapshot — fall back to live */ }
              }
            }

            const result = await enqueueUserMessage(
              finalMessage,
              payload.images,
              resolvedPermissionMode,
              resolvedModel,
              resolvedProviderEnv,
              metadata,
              payload.requestId,
            );
            if (result.error) {
              imRequestRegistry.unregister(payload.requestId);
              return jsonResponse({ success: false, error: result.error }, 503);
            }
          }

          const currentSessionId = getSessionId();
          if (currentSessionId) {
            const sessionMeta = getSessionMetadata(currentSessionId);
            if (sessionMeta && !sessionMeta.source) {
              await updateSessionMetadata(currentSessionId, { source: payload.source as SessionSource });
            }
          }

          return jsonResponse({
            success: true,
            requestId: payload.requestId,
            accepted: true,
            sessionId: currentSessionId,
          });

          } catch (innerError) {
            // W1 fix: any throw between register() and the dispatch result handlers
            // would leave a registry entry to leak for 6h until prune. Catch + clean.
            try { imRequestRegistry.unregister(payload.requestId); } catch { /* ignore */ }
            throw innerError;
          }
        } catch (error) {
          console.error('[im/enqueue] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'IM enqueue error' },
            500,
          );
        }
      }

      // GET /api/im/events?since=<seq> — Pattern C: long-poll SSE.
      // One connection per peer_session, events fan-in from all in-flight requests
      // tagged with their requestId. Caller filters per requestId on the Rust
      // side (ReplyRouter). `since` enables crash-recovery resume — ImEventBus
      // replays ring-buffered events with seq > since before going live.
      if (pathname === '/api/im/events' && request.method === 'GET') {
        const sinceParam = url.searchParams.get('since');
        const sinceSeq = sinceParam ? parseInt(sinceParam, 10) : imEventBus.currentSeq();
        const safeSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : imEventBus.currentSeq();

        const encoder = new TextEncoder();
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        let unsubscribe: (() => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`: connected since=${safeSince}\n\n`));
            // 15s heartbeat keep-alive
            heartbeatTimer = setInterval(() => {
              try { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')); }
              catch { /* stream closed */ }
            }, 15000);

            unsubscribe = imEventBus.subscribe(
              safeSince,
              (event) => {
                if (closed) return;
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch {
                  // Controller closed mid-emit — schedule cleanup
                  closed = true;
                  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
                  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                }
              },
              () => {
                // imEventBus.clear() force-cleared the subscription (session
                // reset). Close the SSE stream so the Rust event_consumer
                // sees end-of-stream and reconnects with `since=<lastSeq>` —
                // subscribe() will then synthesize the cross-generation gap
                // event so events from the new session aren't silently lost.
                if (closed) return;
                closed = true;
                if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
                try { controller.close(); } catch { /* already closed */ }
                // No need to call unsubscribe() — clear() already removed us
                // from both the subscribers Set and the clearedCallbacks Map.
                unsubscribe = null;
              },
            );
          },
          cancel() {
            closed = true;
            if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      // POST /api/im/cancel — Pattern D: abort an in-flight IM request.
      // Body: { requestId, reason? }. Drives THREE cancellation paths:
      //   1. Registry AbortController.abort(reason) — for callers that hold the
      //      signal directly (currently no in-tree consumers, kept for API parity)
      //   2. cancelImRequest / cancelExternalImRequest — actual SDK-level cancel
      //      via interruptCurrentResponse (builtin) or stopExternalSession (external).
      //      This is what stops the SDK turn from burning tokens.
      //   3. imEventBus.emit('cancelled', ...) — Rust ReplyRouter sees this and
      //      closes the reply slot (UI feedback).
      if (pathname === '/api/im/cancel' && request.method === 'POST') {
        try {
          const body = (await request.json()) as { requestId: string; reason?: string };
          if (!body.requestId) {
            return jsonResponse({ success: false, error: 'Missing requestId' }, 400);
          }
          const reason = body.reason ?? 'user';
          const entry = imRequestRegistry.get(body.requestId);
          if (!entry) {
            return jsonResponse({ success: false, error: 'Unknown or already-aborted requestId' }, 404);
          }

          // Step 1: registry abort signal (covers any pluggable subscribers).
          imRequestRegistry.abort(body.requestId, reason);

          // Step 2: actual SDK / queue cancel.
          let cancelResult;
          if (shouldUseExternalRuntime()) {
            cancelResult = await cancelExternalImRequest(body.requestId, reason);
          } else {
            cancelResult = await cancelImRequest(
              body.requestId,
              reason as CancelReason,
            );
          }

          // (v0.2.11 cross-bugfix #142 review-fix-3 medium #2)
          // mode === 'unknown' means the requestId wasn't in any cancellable
          // state — it could be a promote-then-cancel race (item already
          // handed off to generator, no longer in queue/pending). DO NOT
          // emit `cancelled` to the UI in that case: the SDK can still
          // process the message, and the client would see "cancelled"
          // while the AI keeps answering. Return 409 Conflict so the IM
          // client surfaces "cancel failed" instead.
          if (cancelResult.mode === 'unknown') {
            return jsonResponse(
              {
                success: false,
                requestId: body.requestId,
                mode: cancelResult.mode,
                error: 'Request not in a cancellable state — message may already be in flight',
              },
              409,
            );
          }

          // Step 3: bus event for UI feedback (so the reply slot closes promptly).
          imEventBus.emit(body.requestId, 'cancelled', reason);

          // Cleanup registry entry — abort already set status to 'cancelled'.
          imRequestRegistry.unregister(body.requestId);

          return jsonResponse({
            success: true,
            requestId: body.requestId,
            mode: cancelResult.mode,
          });
        } catch (error) {
          console.error('[im/cancel] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'IM cancel error' },
            500,
          );
        }
      }

      // ============= END IM Pipeline v2 =============

      // POST /api/im/heartbeat — Execute a heartbeat check (synchronous JSON response, not SSE)
      if (pathname === '/api/im/heartbeat' && request.method === 'POST') {
        // Track drained events so they can be re-queued on pre-enqueue failures
        let drainedEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];
        // Cron events are tracked separately because they have stricter durability —
        // the destructive drain MUST be reverted unless the heartbeat actually produced
        // deliverable content. Lifted to outer scope so the catch block + the response
        // helper below can both reach it without re-deriving from drainedEvents.
        let cronEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];
        let messageEnqueued = false;

        // Cron events represent durable work that MUST reach Feishu/IM — anything
        // short of `status === 'content'` (silent / error / timeout / HEARTBEAT_OK
        // false-strip) means the AI didn't relay them, and the destructive drain
        // we did at the top of this handler would otherwise lose them forever.
        // Wrap every post-drain return through this helper so the failure paths
        // (timeout, no_response, empty text, AI error, stripHeartbeatToken silent)
        // automatically push the events back into the in-memory queue. The next
        // heartbeat (interval or wake) will retry. Sets cronEvents=[] after re-queue
        // so the catch block doesn't double-push if a later step throws.
        const respondAfterDrain = (
          resp: { status: string; text?: string; reason?: string },
          code?: number,
        ): Response => {
          if (cronEvents.length > 0 && resp.status !== 'content') {
            for (const e of cronEvents) pushSystemEvent(e);
            console.warn(
              `[im/heartbeat] Re-queued ${cronEvents.length} cron event(s) for retry (status=${resp.status}${resp.reason ? ` reason=${resp.reason}` : ''})`,
            );
            cronEvents = [];
          }
          return jsonResponse(resp, code);
        };

        try {
          const payload = await request.json() as {
            prompt: string;
            source: string;
            sourceId: string;
            ackMaxChars?: number;
            isHighPriority?: boolean;
            runtime?: RuntimeType;
            runtimeConfig?: RuntimeConfig;
            // v0.2.4: Rust-side authoritative cron events. When non-empty, this
            // payload is the truth source and REPLACES any cron events in the
            // sidecar's in-memory `systemEventQueue` (Rust survives sidecar
            // restarts; the queue does not). Non-cron events still flow through
            // the queue. Field is camelCase to match the Rust serde attr.
            pendingCronEvents?: Array<{ event: string; taskId: string; content: string; timestamp: number }>;
          };

          if (!payload.prompt) {
            return jsonResponse({ status: 'silent', reason: 'empty' });
          }

          // --- Gate: Read HEARTBEAT.md from workspace root ---
          // The actual checklist lives in HEARTBEAT.md, not in config.
          // If the file body is empty/missing AND no system events → skip AI call.
          const heartbeatMdPath = join(currentAgentDir, 'HEARTBEAT.md');
          let heartbeatMdContent = '';
          try {
            const rawContent = readFileSync(heartbeatMdPath, 'utf-8');
            // Strip YAML frontmatter — only the body is used as prompt
            heartbeatMdContent = stripYamlFrontmatter(rawContent);
          } catch {
            // File doesn't exist — create with descriptive frontmatter
            try {
              const defaultHeartbeat = `---
description: >
  心跳清单 — Agent 按心跳间隔定时苏醒时会读取本文件的正文部分作为指令执行。
  正文为空时心跳会直接跳过，不请求 AI（节省 token）。
  你可以在正文中写入需要 Agent 定期检查的任务、监控项或提醒事项。
---
`;
              writeFileSync(heartbeatMdPath, defaultHeartbeat, 'utf-8');
              console.log(`[im/heartbeat] Created HEARTBEAT.md with frontmatter at ${heartbeatMdPath}`);
            } catch (writeErr) {
              console.warn(`[im/heartbeat] Failed to create HEARTBEAT.md: ${writeErr}`);
            }
          }

          // Drain pending system events from the in-memory queue. This is the
          // legacy transport buffer for non-cron events; cron events used to flow
          // here too but are now sourced from the request body (Rust truth).
          drainedEvents = drainSystemEvents();

          // Cron events come from two possible sources:
          //   - body.pendingCronEvents (Rust truth, v0.2.4+; durable across
          //     sidecar restarts, cleared from Rust on confirmed IM push)
          //   - systemEventQueue (legacy pre-v0.2.4 path; events that survived
          //     a partial migration or arrived via /api/im/system-event POSTs
          //     from older callers)
          //
          // We merge both sets, with body as the truth source for any taskId
          // that appears in both (Rust handles those — re-queuing the queue
          // copy would only duplicate the AI prompt). Queue cron events whose
          // taskId is NOT in the body are processed alongside as legacy work
          // and remain subject to the existing respondAfterDrain re-queue path
          // for at-least-once retry through the sidecar's own queue.
          const bodyCronEvents = (payload.pendingCronEvents ?? []).map(e => ({
            event: e.event,
            content: e.content,
            timestamp: e.timestamp,
            taskId: e.taskId,
          }));
          const queueCronEventsAll = drainedEvents.filter(e => e.event === 'cron_complete');
          const otherEvents = drainedEvents.filter(e => e.event !== 'cron_complete');

          const bodyTaskIds = new Set(
            bodyCronEvents.map(e => e.taskId).filter((id): id is string => !!id),
          );
          const orphanQueueCron = queueCronEventsAll.filter(
            e => !e.taskId || !bodyTaskIds.has(e.taskId),
          );

          // CRITICAL: process AT MOST ONE cron event per heartbeat (across body
          // and queue combined). Reason: AI partial-relay defense — if we
          // batched N events into one prompt and the AI relayed only some, the
          // success path (Rust clears all body snapshot entries, sidecar drains
          // queue events) would silently drop the un-relayed ones. By forcing
          // exactly one event in the prompt, every "content" response
          // corresponds to exactly one ack-able delivery.
          //
          // Selection priority: body[0] > orphanQueueCron[0]. body events are
          // Rust-truth and will be re-shipped on subsequent heartbeats; orphan
          // queue events that lose this round are pushed back into the
          // sidecar queue immediately so the next heartbeat picks them up.
          let effectiveCronEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];

          if (bodyCronEvents.length > 0) {
            effectiveCronEvents = [bodyCronEvents[0]];
            // Any extra body events (Rust would only ship 1 in practice, but be
            // defensive in case the contract changes) go nowhere here — Rust
            // will resend them on the next heartbeat from its own pending vec.
            if (bodyCronEvents.length > 1) {
              console.log(
                `[im/heartbeat] Body shipped ${bodyCronEvents.length} cron events; processing first only (Rust resends rest)`,
              );
            }
            // Push orphan queue events back so they get a turn next heartbeat.
            // (We can't use the respondAfterDrain rollback path for them
            // because we're going to return 'content' — that's a "success" from
            // the queue's perspective, even though we didn't actually process
            // these orphan events this round.)
            for (const e of orphanQueueCron) pushSystemEvent(e);
            // No queue cron events left for the rollback helper to manage.
            cronEvents = [];
          } else if (orphanQueueCron.length > 0) {
            effectiveCronEvents = [orphanQueueCron[0]];
            // Push the rest back for next heartbeat.
            for (let i = 1; i < orphanQueueCron.length; i++) {
              pushSystemEvent(orphanQueueCron[i]);
            }
            // The one event we ARE processing must be visible to the
            // respondAfterDrain rollback path so silent/error responses re-queue
            // it (queue cron events are sidecar-owned and need this rollback to
            // survive; body cron events have Rust holding them already).
            cronEvents = [orphanQueueCron[0]];
          }
          // else: both empty → effectiveCronEvents stays [], cronEvents stays []

          // Skip AI call if HEARTBEAT.md is empty AND no system events of any kind.
          // Body-sourced cron events count too — Rust ships them when there's
          // pending work, so an empty HEARTBEAT.md plus zero events on both
          // sources means there is genuinely nothing to do.
          if (
            !heartbeatMdContent
            && drainedEvents.length === 0
            && bodyCronEvents.length === 0
          ) {
            console.log('[im/heartbeat] Skipped: HEARTBEAT.md is empty and no pending events');
            return jsonResponse({ status: 'silent', reason: 'empty_heartbeat_md' });
          }

          let enrichedPrompt: string;

          if (effectiveCronEvents.length > 0) {
            // Cron event prompt: completely replaces standard heartbeat prompt
            enrichedPrompt = buildCronEventPrompt(effectiveCronEvents);
            // Push back non-cron events so they aren't lost — next heartbeat cycle will pick them up
            for (const e of otherEvents) {
              pushSystemEvent(e);
            }
          } else {
            // Standard heartbeat prompt (from Rust)
            enrichedPrompt = payload.prompt;
            if (otherEvents.length > 0) {
              const eventLines = otherEvents.map(
                e => `[System Event: ${e.event}] ${e.content}`
              ).join('\n');
              enrichedPrompt += `\n\n${eventLines}`;
            }
          }

          // Wrap the entire heartbeat message in <system-reminder><HEARTBEAT> tags
          enrichedPrompt = `<system-reminder>\n<HEARTBEAT>\n${enrichedPrompt}\n</HEARTBEAT>\n</system-reminder>`;

          const {
            enqueueUserMessage, waitForSessionIdle, getMessages,
            getSessionModel, getSessionProviderEnv,
            getAndClearLastAgentError,
          } = await import('./agent-session');

          // Inject heartbeat prompt as user message (wrapped in <system-reminder><HEARTBEAT> tags)
          // System prompt is already permanently injected at IM session creation (/api/im/chat)
          // Heartbeat is unattended — bypass all permissions so tool use doesn't block.
          // Pass current model + providerEnv for consistency (undefined is also safe —
          // enqueueUserMessage treats it as "keep current provider" via pit-of-success semantics).
          let text = '';

          if (shouldUseExternalRuntime()) {
            // ─── External Runtime (CC/Codex): heartbeat ───
            const runtimeConfig = payload.runtimeConfig ?? null;
            const ccResult = await sendExternalMessage(
              enrichedPrompt, undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'agent-channel', platform: payload.source?.split('_')[0] ?? 'unknown', sourceType: 'private' },
                permissionMode: getRuntimeConfigPermissionMode(runtimeConfig),
                model: getRuntimeConfigModel(runtimeConfig),
              },
            );
            if (!ccResult.queued) {
              return respondAfterDrain({ status: 'error', text: ccResult.error ?? 'External runtime failed' });
            }
            messageEnqueued = true;

            const completed = await waitForExternalSessionIdle(300000, 500);
            if (!completed) {
              return respondAfterDrain({ status: 'error', text: 'Heartbeat timeout' });
            }

            if (!didLastTurnSucceed()) {
              return respondAfterDrain({ status: 'error', text: 'External runtime turn failed' });
            }

            text = getLastExternalAssistantText();
          } else {
            // ─── Builtin Runtime: existing path ───
            getAndClearLastAgentError();
            await enqueueUserMessage(
              enrichedPrompt,
              [],
              'fullAgency',
              getSessionModel(),
              getSessionProviderEnv(),
              {
                source: payload.source as SessionSource,
                sourceId: payload.sourceId,
              },
            );
            messageEnqueued = true;

            const completed = await waitForSessionIdle(300000, 500);
            if (!completed) {
              return respondAfterDrain({ status: 'error', text: 'Heartbeat timeout' });
            }

            const messages = getMessages();
            const lastMsg = [...messages].reverse().find(m => m.role === 'assistant');
            if (!lastMsg) {
              return respondAfterDrain({ status: 'silent', reason: 'no_response' });
            }

            if (typeof lastMsg.content === 'string') {
              text = lastMsg.content;
            } else if (Array.isArray(lastMsg.content)) {
              text = lastMsg.content
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { type: string; text?: string }) => b.text || '')
                .join('\n');
            }
          }

          // Guard: message was enqueued but assistant response is empty → AI failed to respond
          // (SDK wraps API errors as synthetic assistant messages with empty content in messages[])
          if (!text.trim()) {
            const agentErr = getAndClearLastAgentError();
            return respondAfterDrain({ status: 'error', text: agentErr || 'AI did not respond' });
          }

          // Check HEARTBEAT_OK
          const ackMaxChars = payload.ackMaxChars ?? 300;
          const result = stripHeartbeatToken(text, ackMaxChars);

          // Note: when cron events were drained, a 'silent' result here means the AI
          // received the cron prompt but still replied with HEARTBEAT_OK (or empty
          // after strip). respondAfterDrain treats that as undelivered and re-queues
          // — the next heartbeat retries instead of silently dropping the daily report.
          return respondAfterDrain(result);
        } catch (error) {
          // Cron events represent durable work that MUST reach IM. On exception, even
          // if `messageEnqueued = true`, the AI relay didn't complete — re-queue them
          // unconditionally so the next heartbeat retries. The respondAfterDrain helper
          // clears `cronEvents` after handling its own re-queue path; if it ran first,
          // this no-ops.
          if (cronEvents.length > 0) {
            for (const e of cronEvents) pushSystemEvent(e);
            console.warn(`[im/heartbeat] Re-queued ${cronEvents.length} cron event(s) after exception`);
            cronEvents = [];
          }
          // Non-cron events: keep existing semantics — only re-queue if exception
          // happened before enqueueUserMessage (otherwise they're already in the AI's
          // prompt and re-queuing would duplicate).
          if (!messageEnqueued) {
            const others = drainedEvents.filter(e => e.event !== 'cron_complete');
            if (others.length > 0) {
              for (const e of others) pushSystemEvent(e);
              console.warn(`[im/heartbeat] Re-queued ${others.length} non-cron event(s) after pre-enqueue failure`);
            }
          }
          console.error('[im/heartbeat] Error:', error);
          return jsonResponse(
            { status: 'error', text: error instanceof Error ? error.message : 'Heartbeat error' },
            500,
          );
        }
      }

      // POST /api/memory/update — Trigger memory update in current session (v0.1.43)
      if (pathname === '/api/memory/update' && request.method === 'POST') {
        try {
          const payload = await request.json() as { source: 'auto' | 'manual' };
          const isAuto = payload.source === 'auto';

          // (issue #190 v0.2.15) Busy gate — refuse auto-injection when the
          // session is actively working. The Rust-side `lastActiveAt` cooldown
          // is only a disk-timestamp proxy and ages past its 15-min threshold
          // during a single long turn, so this check is the authoritative one.
          // Manual updates (user clicked the button) bypass — explicit user
          // intent is allowed to queue behind the active turn as expected.
          const { isSessionBusy, enqueueUserMessage, waitForSessionIdle, getSessionModel, getSessionProviderEnv } = await import('./agent-session');
          if (isAuto && isSessionBusy()) {
            console.log('[memory-update] Skipped: session busy (auto)');
            return jsonResponse({ status: 'skipped', reason: 'session_busy' });
          }

          // Read UPDATE_MEMORY.md from workspace root
          const updateMdPath = join(currentAgentDir, 'UPDATE_MEMORY.md');
          let rawContent = '';
          try {
            rawContent = readFileSync(updateMdPath, 'utf-8');
          } catch {
            return jsonResponse({ status: 'skipped', reason: 'file_not_found' });
          }

          // Strip YAML frontmatter
          const promptContent = stripYamlFrontmatter(rawContent);
          if (!promptContent.trim()) {
            return jsonResponse({ status: 'skipped', reason: 'empty_content' });
          }

          // Build prompt with <system-reminder> and <MEMORY_UPDATE> tags
          const now = new Date().toLocaleString('en-US', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
          });

          const prompt = `<system-reminder>\n<MEMORY_UPDATE>\n${promptContent}\n\nCurrent time: ${now}\n\n完成所有记忆维护操作后（包括文件读写和 git 操作），仅回复 MEMORY_UPDATE_OK，不要输出其他内容。\n</MEMORY_UPDATE>\n</system-reminder>`;

          // Inject as user message — memory update is unattended, bypass all permissions
          // so Bash/file tools (git commit, file writes) don't block waiting for approval.
          // Pass current model + providerEnv to avoid triggering provider-switch logic.
          await enqueueUserMessage(prompt, [], 'fullAgency', getSessionModel(), getSessionProviderEnv());

          // Wait synchronously for AI completion (60 min timeout — same as background tasks).
          // Memory update can be slow for large sessions: loading 100K+ token context,
          // reading multiple log/topic files, writing updates, git commit+push.
          const completed = await waitForSessionIdle(3600000, 1000);

          if (completed) {
            console.log(`[memory-update] AI completed memory update (source=${payload.source})`);
            return jsonResponse({ status: 'completed' });
          } else {
            console.warn('[memory-update] AI memory update timed out (10 min)');
            return jsonResponse({ status: 'timeout' });
          }
        } catch (error) {
          console.error('[memory-update] Error:', error);
          return jsonResponse(
            { status: 'error', reason: error instanceof Error ? error.message : 'Unknown error' },
            500,
          );
        }
      }

      // POST /api/im/system-event — Receive system events (e.g. cron task completion) for heartbeat relay
      if (pathname === '/api/im/system-event' && request.method === 'POST') {
        try {
          const { event, content, taskId } = (await request.json()) as {
            event: string;
            content: string;
            taskId?: string;
          };
          // Store in queue for next heartbeat to pick up
          pushSystemEvent({ event, content, timestamp: Date.now(), taskId });
          console.log(`[system-event] Queued: ${event} (queue size: ${systemEventQueue.length})`);
          return jsonResponse({ ok: true });
        } catch (_err) {
          return jsonResponse({ error: 'Invalid request' }, 400);
        }
      }

      // POST /api/im/permission-response — Handle IM user's permission decision (from approval card/button)
      // Auto-routes to external runtime when active (same pattern as /api/permission/respond).
      if (pathname === '/api/im/permission-response' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            await respondExternalPermission(payload.requestId, payload.decision);
            return jsonResponse({ success: true });
          }

          const { handlePermissionResponse } = await import('./agent-session');
          const success = handlePermissionResponse(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[im/permission-response] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/im/session/new — Start a new session (preserving workspace)
      if (pathname === '/api/im/session/new' && request.method === 'POST') {
        try {
          // Stop external runtime subprocess if active. First await any
          // in-flight start/pre-warm so isExternalSessionActive() is truthful
          // — otherwise a half-spawned subprocess (startingPromise pending,
          // activeProcess still null) slips past the check, and once it
          // finishes spawning it overwrites the freshly-rebound module
          // state with its own (now-stale) assignments. Same race the
          // /sessions/switch handler guards against.
          if (shouldUseExternalRuntime()) {
            await awaitExternalSessionStarting();
            if (isExternalSessionActive()) {
              await stopExternalSession();
            }
          }
          await resetSession();
          // External runtime: stopExternalSession only nulls activeProcess —
          // module-level lastSessionId / lastRuntimeSessionId / allSessionMessages
          // still point at the OLD conversation. Without an explicit re-bind,
          // the next /api/im/enqueue hits the resume branch in sendExternalMessage,
          // writes the new turn back into the old session_id, and leaves the
          // freshly minted sessionId orphaned (no metadata, no IM tag, AI reply
          // appears in the old chat instead of the new one). restoreExternalSessionState
          // calls resetModuleState internally on sessionId-change, then sets
          // lastSessionId to the fresh id — Case 1 (fresh start) on the next message.
          // Scenario is set provisionally; the next /api/im/enqueue overwrites it.
          if (shouldUseExternalRuntime()) {
            const newSessionId = getSessionId();
            if (newSessionId) {
              restoreExternalSessionState(newSessionId, agentDir, { type: 'desktop' });
            }
          }
          return jsonResponse({
            sessionId: getSessionId(),
          });
        } catch (error) {
          console.error('[im/session/new] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Reset error' },
            500,
          );
        }
      }

      // GET /api/im/session/:key/messages — Get messages for an IM session
      if (pathname.startsWith('/api/im/session/') && pathname.endsWith('/messages') && request.method === 'GET') {
        try {
          // Currently returns messages from the active session
          // In the future, could look up by session key
          const allMessages = getMessages();
          return jsonResponse({
            messages: allMessages.map(m => ({
              id: m.id,
              role: m.role,
              content: typeof m.content === 'string' ? m.content : m.content
                .filter((b: { type: string; text?: string }) => b.type === 'text')
                .map((b: { text?: string }) => b.text ?? '')
                .join('\n'),
              timestamp: m.timestamp,
              metadata: m.metadata,
            })),
          });
        } catch (error) {
          console.error('[im/session/messages] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Messages error' },
            500,
          );
        }
      }

      // ============= END IM BOT API =============

      // ============= OPENAI BRIDGE (Loopback, per-token) =============
      // PRD #124: each SDK subprocess registers under a unique token.
      // ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/bridge/<token>, so the
      // CLI sends POSTs to /bridge/<token>/v1/messages. The handler resolves
      // the token via `bridge-registry` and routes to that subprocess's own
      // upstream — no shared global state, no cross-pollination between
      // concurrent SDK invocations.
      const bridgeMessagesMatch = pathname.match(/^\/bridge\/([^/]+)\/v1\/messages$/);
      if (bridgeMessagesMatch && request.method === 'POST') {
        const token = bridgeMessagesMatch[1];
        try {
          const handler = await ensureBridgeHandler();
          return await handler(request);
        } catch (error) {
          // The handler's getUpstreamConfig throws when the token is unknown
          // (subprocess unregistered, or routing was wrong) — surface as 400
          // so the SDK sees a clean error instead of a 500.
          const msg = error instanceof Error ? error.message : 'Bridge error';
          const isUnknownToken = msg.startsWith('Unknown bridge token');
          if (isUnknownToken) {
            console.warn(`[bridge] rejecting request with unknown token=${token}: ${msg}`);
            return jsonResponse(
              { type: 'error', error: { type: 'invalid_request_error', message: msg } },
              400,
            );
          }
          console.error('[bridge] Handler error:', error);
          return jsonResponse(
            { type: 'error', error: { type: 'api_error', message: msg } },
            500,
          );
        }
      }

      // POST /bridge/<token>/v1/messages/count_tokens — CLI sends this for
      // context window management. OpenAI-compatible APIs have no equivalent,
      // so we return an estimated token count without involving the upstream.
      // We still require a valid token so untokened callers can't probe.
      const bridgeCountMatch = pathname.match(/^\/bridge\/([^/]+)\/v1\/messages\/count_tokens$/);
      if (bridgeCountMatch && request.method === 'POST') {
        const { lookupBridge } = await import('./openai-bridge/bridge-registry');
        const token = bridgeCountMatch[1];
        if (!lookupBridge(token)) {
          return jsonResponse(
            { type: 'error', error: { type: 'invalid_request_error', message: `Unknown bridge token: ${token}` } },
            400,
          );
        }
        try {
          const body = await request.json() as { messages?: unknown[]; system?: unknown; tools?: unknown[] };
          const contentLength = JSON.stringify(body.messages ?? []).length
            + JSON.stringify(body.system ?? '').length
            + JSON.stringify(body.tools ?? []).length;
          const estimatedTokens = Math.max(1, Math.ceil(contentLength / 4));
          return jsonResponse({ input_tokens: estimatedTokens });
        } catch {
          return jsonResponse({ input_tokens: 1024 }); // Safe fallback
        }
      }

      const staticResponse = await serveStatic(pathname);
      if (staticResponse) {
        return staticResponse;
      }

      return new Response('Not Found', { status: 404 });
    }
  }

  // The same HTTP server serves both purposes — Tauri client proxies all
  // /api/* + /sessions/* + /chat/stream traffic here via Rust local_http;
  // browser dev mode (`start_dev.sh`) additionally hits the `serveStatic`
  // fallback to load the React `dist/` bundle. Naming reflects the
  // production primary role.
  console.log(`[startup] Sidecar HTTP server ready on http://127.0.0.1:${port}`);

  // Pattern 2 §2.3.1 — Start the periodic GC for spilled large-value refs.
  // Runs every 60s; reaps any ref past its TTL (default 1h). The timer is
  // unref'd inside startRefsGc, so it doesn't keep the event loop alive.
  void import('./utils/large-value-store').then(({ startRefsGc }) => {
    startRefsGc(60_000);
  }).catch((err) => {
    console.warn(`[refs] failed to start GC: ${err instanceof Error ? err.message : String(err)}`);
  });

  // ── Deferred heavy init ─────────────────────────────────────────────────
  // Runs AFTER honoServe has bound the port. Rust's TCP health check now
  // passes within ~50ms instead of waiting ~2s for all this work to finish.
  // Routes (except /health) `await __myagentsDeferredInit` before running,
  // so correctness is preserved: anything that needs agent state (MCP,
  // model, file watcher, bridge) waits for this block to finish.
  //
  // Order within this block still matters:
  //   1. migrations/cleanup — best-effort, can interleave
  //   2. socks bridge BEFORE initializeAgent (pre-warm spawns SDK which
  //      reads HTTP_PROXY env vars set by initSocksBridgeFromEnv)
  //   3. initializeAgent — the big one
  //   4. external runtime restore
  //   5. boot banner — prints with fully resolved state
  // Pattern 4: track which phase is running so /health/ready can report
  // {phase: 'migration' | 'skill-seed' | 'sdk-init' | ...} on failure.
  let currentInitPhase = 'startup';
  (async () => {
    try {
      currentInitPhase = 'cleanup';
      setDeferredInitPhase(currentInitPhase);
      // Unified retention sweep (#121) — replaces v0.2.7's split between
      // cleanupOldLogs (per-session) + cleanupOldUnifiedLogs (unified). One
      // policy module covers age cutoff, byte budget, and the recent-data
      // floor across all sources. Per-session logs gained a byte budget
      // here for the first time.
      //
      // The active-file set protects BOTH the unified log we're appending
      // to AND the per-session log file (if AgentLogger has one open) from
      // budget eviction — without this, a long-lived session log past the
      // 7-day floor could be unlinked while the WriteStream is still open.
      const collectActivePaths = (): ReadonlySet<string> => {
        const paths = new Set<string>();
        const u = getActiveUnifiedLogPath();
        if (u) paths.add(u);
        const s = getActiveSessionLogPath();
        if (s) paths.add(s);
        return paths;
      };
      runLogRetentionSweep({ activeFilePaths: collectActivePaths() });
      // Hourly background sweep — bounds gradual growth without waiting
      // for the next 50MB rotation event. Active-file getter is invoked
      // at each sweep so day-rollovers are reflected.
      startPeriodicSweep(collectActivePaths);
      cleanupStalePlaywrightProfile();

      // Issue #194 follow-up — one-time scrub for stale agent.runtimeConfig
      // fields from before buildRuntimeChangePatch existed. Idempotent via
      // per-agent `_runtimeConfigScrubV1` marker; subsequent boots short-
      // circuit per agent. See doc comment in the migration module.
      try {
        const { scrubStaleRuntimeConfig } = await import('./migrations/scrub-stale-runtime-config');
        const result = await scrubStaleRuntimeConfig();
        if (result.scannedAgents > 0) {
          console.log(`[migration] runtimeConfig scrub: scanned=${result.scannedAgents} scrubbed=${result.scrubbedAgents}`);
          for (const d of result.details) {
            console.log(`[migration] runtimeConfig scrub: agent=${d.agentId} runtime=${d.runtime} dropped=${JSON.stringify(d.dropped)}`);
          }
        }
      } catch (err) {
        console.warn('[migration] runtimeConfig scrub failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }

      currentInitPhase = 'skill-seed';
      setDeferredInitPhase(currentInitPhase);
      seedBundledSkills();
      console.log('[startup] seedBundledSkills done');

      currentInitPhase = 'socks-bridge';
      setDeferredInitPhase(currentInitPhase);
      await initSocksBridgeFromEnv();

      currentInitPhase = 'sdk-init';
      setDeferredInitPhase(currentInitPhase);
      await initializeAgent(currentAgentDir, initialPrompt, initialSessionId, { preWarmDisabled: noPreWarm });
      console.log('[startup] initializeAgent done');

      if (shouldUseExternalRuntime() && initialSessionId) {
        currentInitPhase = 'external-runtime-restore';
        setDeferredInitPhase(currentInitPhase);
        restoreExternalSessionState(initialSessionId, currentAgentDir, { type: 'desktop' });
      }

      // ── Sidecar Boot Banner: single-line for AI grep ──
      {
        const model = getSessionModel() || '?';
        const mcpList = getMcpServers();
        const mcpNames = mcpList ? Object.keys(mcpList).join(',') || 'none' : 'none';
        const bridge = hasActiveBridge() ? 'yes' : 'no';
        // Health signal: confirm builtin-mcp-meta.ts's side-effect registration
        // actually fired. An empty list here is a red flag — the META file was
        // not imported by agent-session.ts, which means lazy MCP lookup will
        // return undefined for every builtin.
        const { listBuiltinMcpIds } = await import('./tools/builtin-mcp-registry');
        const builtinMcpMeta = listBuiltinMcpIds().join(',') || 'none';
        console.log(`[boot] pid=${process.pid} port=${port} node=${process.versions.node} workspace=${currentAgentDir} session=${initialSessionId ?? 'new'} resume=${!!initialSessionId} model=${model} bridge=${bridge} mcp=${mcpNames} builtin-mcp-meta=${builtinMcpMeta}`);
      }

      markDeferredInitReady();
      resolveDeferredInit();
    } catch (err) {
      console.error('[startup] Deferred init failed:', err);
      console.warn(`[health-state] Deferred init failed in phase=${currentInitPhase}: ${err instanceof Error ? err.message : String(err)}`);
      // Pattern 4: capture the phase for /health/ready's structured 503.
      // retryable=false until we have a real re-runner (TODO above).
      markDeferredInitFailed(currentInitPhase, err, false);
      rejectDeferredInit(err);
      // Don't re-throw — the server stays up so /health/* keeps responding
      // and the renderer can render the failure state instead of timing out.
    }
  })();

  // Kick off interactive-shell PATH detection in the background.
  // `warmupShellPath()` uses async `execFile` so it never blocks the event loop
  // (unlike the old `execSync` path, which starved TCP accept for 3–5s while
  // zsh -i -l sourced a heavy .zshrc — Rust's sidecar health check would retry
  // 15× before finally connecting).
  //
  // Startup returns immediately; detected PATH is applied whenever the shell
  // finishes. `getShellEnv()` keeps returning the platform fallback PATH until
  // then — sufficient for common binary lookups (.myagents/bin, homebrew, nvm,
  // fnm, volta, pnpm, cargo all in fallback).
  import('./utils/shell').then(({ warmupShellPath, getShellPath }) => {
    warmupShellPath().then(() => {
      console.log('[server] Startup PATH:', getShellPath());
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
