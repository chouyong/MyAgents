// CodexRuntime — drives the Codex CLI as a subprocess via app-server (v0.1.60)
//
// Communication: JSON-RPC 2.0 over stdio (codex app-server)
// Process lifecycle: persistent across turns (unlike CC's -p mode)
// Permission: Server-initiated Requests with RPC Responses
// System prompt: thread/start → developerInstructions
// Session: thread/start (new) / thread/resume (continuing)

import { spawn, type Subprocess, type SubprocessStdin } from '../utils/subprocess';
import { writeFileSync , existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { RuntimeDetection, RuntimeModelInfo, RuntimePermissionMode, RuntimeType } from '../../shared/types/runtime';
import { CODEX_PERMISSION_MODES } from '../../shared/types/runtime';
import type { AgentRuntime, RuntimeProcess, SessionStartOptions, UnifiedEvent, UnifiedEventCallback, ImagePayload } from './types';
import { StaleRuntimeSessionError } from './types';
import { augmentedProcessEnv, resolveCommand, stripAnsi } from './env-utils';
import { ensureDirSync } from '../utils/fs-utils';
import { killWithEscalation } from './utils/kill-with-escalation';
import { withLogContext } from '../logger-context';

// ─── Temp image directory for Codex (which requires file paths, not base64) ───
const TEMP_IMG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.myagents', 'tmp', 'codex-images',
);

/**
 * Write base64 image to a temp file and return its path.
 * Codex CLI accepts `localImage` input with file paths.
 */
function writeImageToTempFile(img: ImagePayload): string {
  if (!existsSync(TEMP_IMG_DIR)) {
    ensureDirSync(TEMP_IMG_DIR);
  }
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length === 0) throw new Error('Empty image data');
  const subtype = img.mimeType.split('/')[1]?.split('+')[0] || 'png';  // 'jpeg' from 'image/jpeg', 'svg' from 'image/svg+xml'
  const ext = subtype === 'jpeg' ? 'jpg' : subtype;
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = join(TEMP_IMG_DIR, filename);
  writeFileSync(filepath, buf);
  return filepath;
}

/**
 * Clean up stale temp images older than 1 hour.
 * Called at session start to prevent unbounded directory growth.
 */
function cleanupStaleTempImages(): void {
  try {
    if (!existsSync(TEMP_IMG_DIR)) return;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const file of readdirSync(TEMP_IMG_DIR)) {
      const filepath = join(TEMP_IMG_DIR, file);
      try {
        if (statSync(filepath).mtimeMs < cutoff) unlinkSync(filepath);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore cleanup errors */ }
}

/**
 * Build Codex input array with optional images.
 * Images are written to temp files and referenced via `localImage` type.
 */
function buildCodexInput(text: string, images?: ImagePayload[]): unknown[] {
  const input: unknown[] = [];
  if (images && images.length > 0) {
    for (const img of images) {
      const filepath = writeImageToTempFile(img);
      input.push({ type: 'localImage', path: filepath });
    }
  }
  input.push({ type: 'text', text, text_elements: [] });
  return input;
}

// ─── Model cache ───

let modelCache: { models: RuntimeModelInfo[]; timestamp: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── JSON-RPC 2.0 Client ───

/**
 * Lightweight JSON-RPC 2.0 client for Codex app-server.
 *
 * Handles three message types:
 * - Client → Server Requests (call): send request, await response by matching id
 * - Server → Client Notifications (no id): dispatched via onNotification callback
 * - Server → Client Requests (with id): dispatched via onServerRequest, client must respond
 */
class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onServerRequest: ((id: number, method: string, params: unknown) => void) | null = null;
  private encoder = new TextEncoder();
  private sink: SubprocessStdin;
  private reading = false;

  constructor(
    private proc: Subprocess,
  ) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error('stdin not available');
    this.sink = stdin;
  }

  /** Register notification handler (server → client, no id) */
  setNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.onNotification = handler;
  }

  /** Register server-request handler (server → client, with id, expects response) */
  setServerRequestHandler(handler: (id: number, method: string, params: unknown) => void): void {
    this.onServerRequest = handler;
  }

  /** Send a JSON-RPC request and wait for the matching response */
  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.write(msg);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC call "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Clear timeout on resolution
      const orig = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); orig.resolve(r); },
        reject: (e) => { clearTimeout(timer); orig.reject(e); },
      });
    });
  }

  /** Send a JSON-RPC response (for server-initiated requests) */
  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Send a JSON-RPC error response */
  respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Start the background reader loop. Must be called once after construction. */
  async startReading(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const stdout = this.proc.stdout;
    if (!stdout) return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch (err) {
      // Stream closed or process exited
      if (String(err).includes('cancel') || String(err).includes('closed')) return;
      console.error('[codex-rpc] Reader error:', err);
    } finally {
      reader.releaseLock();
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(new Error('app-server process exited'));
      }
      this.pending.clear();
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Non-JSON output, ignore
    }

    // Response to our request (has id + result/error, no method)
    if ('id' in msg && !('method' in msg)) {
      const id = msg.id as number;
      const handler = this.pending.get(id);
      if (handler) {
        this.pending.delete(id);
        if (msg.error) {
          const err = msg.error as { code: number; message: string; data?: { details?: string } };
          // Carry err.data.details into the message so downstream stale-session
          // detection (and humans reading logs) see the actionable diagnostic,
          // not just the generic JSON-RPC "Internal error" wrapper.
          const details = typeof err.data?.details === 'string' ? `: ${err.data.details}` : '';
          handler.reject(new Error(`RPC error ${err.code}: ${err.message}${details}`));
        } else {
          handler.resolve(msg.result);
        }
      }
      return;
    }

    // Server notification (has method, no id)
    if ('method' in msg && !('id' in msg)) {
      this.onNotification?.(msg.method as string, msg.params);
      return;
    }

    // Server-initiated request (has method AND id)
    if ('method' in msg && 'id' in msg) {
      this.onServerRequest?.(msg.id as number, msg.method as string, msg.params);
      return;
    }
  }

  private write(msg: unknown): void {
    // Fire-and-forget. sink.write() returns a Promise; back-pressure is
    // absorbed by Node's internal buffer. Rejection (e.g. stdin closed)
    // is swallowed — JSON-RPC layer detects liveness via process exit.
    void this.sink.write(this.encoder.encode(JSON.stringify(msg) + '\n')).catch(() => { /* stdin may be closed */ });
  }

  /** Clean up: reject all pending requests */
  destroy(): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error('Client destroyed'));
    }
    this.pending.clear();
  }
}

// ─── CodexProcess wrapper ───

class CodexProcess implements RuntimeProcess {
  readonly pid: number;
  exited = false;
  private proc: Subprocess;

  // Codex-specific state
  rpc: JsonRpcClient;
  threadId = '';
  currentTurnId = '';
  agentMessageTextById = new Map<string, string>();
  // True when the startSession catch-handler killed the process itself (stale
  // resume, init failure, etc.). Suppresses the synthetic "Codex process
  // exited with code 143" session_complete emitted by proc.exited.then — the
  // caller already owns the error surface. Issue #105.
  intentionalKillDuringStartup = false;

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
    this.rpc = new JsonRpcClient(proc);
  }

  async writeLine(_line: string): Promise<void> {
    // For Codex, messages go through RPC, not raw stdin.
    // This is kept for interface compliance; actual messaging uses rpc.call().
    throw new Error('Codex uses JSON-RPC, not raw stdin. Use rpc.call() instead.');
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15);
    } catch { /* already dead */ }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  /** Close stdin to signal the process to finish (awaits EOF flush). */
  async closeStdin(): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin) return;
    try {
      await stdin.end();
    } catch { /* already closed / EPIPE */ }
  }
}

// ─── Permission mode mapping ───

function mapPermissionMode(mode: string): { approval: string; sandbox: string } {
  switch (mode) {
    case 'suggest':
      return { approval: 'untrusted', sandbox: 'read-only' };
    case 'auto-edit':
      return { approval: 'on-request', sandbox: 'workspace-write' };
    case 'full-auto':
      return { approval: 'never', sandbox: 'workspace-write' };
    case 'no-restrictions':
      return { approval: 'never', sandbox: 'danger-full-access' };
    default:
      return { approval: 'on-request', sandbox: 'workspace-write' };
  }
}

// ─── CodexRuntime ───

export class CodexRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'codex';

  async detect(): Promise<RuntimeDetection> {
    try {
      const proc = spawn([resolveCommand('codex'), '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: augmentedProcessEnv(),
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return {
          installed: true,
          version: text.trim().replace(/^codex-cli\s*/i, ''),
          path: 'codex',
        };
      }
    } catch { /* not installed */ }
    return { installed: false };
  }

  async queryModels(): Promise<RuntimeModelInfo[]> {
    // Return cached if fresh
    if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
      return modelCache.models;
    }

    try {
      const models = await this.queryModelsViaAppServer();
      modelCache = { models, timestamp: Date.now() };
      return models;
    } catch (err) {
      console.error('[codex] Failed to query models:', err);
      // Return cached even if stale, or empty
      return modelCache?.models ?? [];
    }
  }

  private async queryModelsViaAppServer(): Promise<RuntimeModelInfo[]> {
    // Spawn a temporary app-server to query model/list
    const proc = spawn([resolveCommand('codex'), 'app-server'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      env: augmentedProcessEnv(),
    });

    const rpc = new JsonRpcClient(proc);
    // Start reader in background (awaited in finally block below)
    const readerDone = rpc.startReading();

    try {
      // Initialize handshake
      await rpc.call('initialize', {
        clientInfo: { name: 'MyAgents', title: null, version: process.env.MYAGENTS_VERSION || '0.1.60' },
        capabilities: null,
      }, 10_000);

      // Query model list
      const result = await rpc.call('model/list', {}, 10_000) as {
        data: Array<{
          id: string;
          displayName: string;
          description: string;
          hidden: boolean;
          isDefault: boolean;
        }>;
      };

      return result.data
        .filter(m => !m.hidden)
        .map(m => ({
          value: m.id,
          displayName: m.displayName || m.id,
          description: m.description,
          isDefault: m.isDefault,
        }));
    } finally {
      rpc.destroy();
      try { proc.kill(); } catch { /* ignore */ }
      await readerDone.catch(() => {});
    }
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return CODEX_PERMISSION_MODES;
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    // Clean up stale temp images from previous sessions
    cleanupStaleTempImages();

    // Cross-runtime workspace protocol: make Codex natively discover CLAUDE.md
    // when no AGENTS.md is present. The -c flag overrides config.toml at runtime
    // without modifying any external config files. Codex's search order becomes:
    // AGENTS.override.md → AGENTS.md → CLAUDE.md (per directory, first found wins).
    const proc = spawn([
      resolveCommand('codex'),
      '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]',
      'app-server',
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd: options.workspacePath,
      env: augmentedProcessEnv(),
      // Detached → child becomes its own process-group leader on POSIX so
      // killWithEscalation({ killTree: true }) below can take down the entire
      // model/tool tree, not just the wrapper.
      //
      // Windows: `detached: true` + stdio:'pipe' breaks parent's stdout reads
      // — the JSON-RPC `initialize` call hangs forever (issue #170 #3). Windows
      // doesn't have process groups; tree-kill uses `taskkill /F /T /PID` which
      // works regardless of detached. `windowsHide: true` suppresses the console
      // window flash from cmd.exe wrapping the codex.cmd shim.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const codexProc = new CodexProcess(proc);

    // Dedup guard: prevent double session_complete from notification + process exit
    let sessionCompleteEmitted = false;
    // Pattern 6: every event delivery is wrapped in an ALS frame stamped
    // with `runtime: 'codex'` so any nested console.* (in onEvent or its
    // downstream handlers) is correlated. Frames are short-lived (one per
    // event) which keeps ALS overhead bounded.
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') {
        if (sessionCompleteEmitted) return; // Already emitted, skip duplicate
        sessionCompleteEmitted = true;
      }
      withLogContext({ runtime: 'codex' }, () => onEvent(event));
    };

    // Wire up notification handler to emit UnifiedEvents
    codexProc.rpc.setNotificationHandler((method, params) => {
      // Skip noisy notifications from logging: deltas, legacy duplicates, account events
      const isNoisy = method.startsWith('codex/event/') || method.startsWith('account/')
        || method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta'
        || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta';
      if (!isNoisy) {
        const p = params as Record<string, unknown> | undefined;
        let detail = '';
        if (method === 'item/started' || method === 'item/completed') {
          const item = p?.item as Record<string, unknown> | undefined;
          if (item) {
            detail = ` type=${item.type}`;
            if (item.id) detail += ` id=${(item.id as string).slice(0, 12)}`;
            // Tool-specific context
            if (item.type === 'commandExecution' && item.command) detail += ` cmd=${(item.command as string).slice(0, 80)}`;
            if (item.type === 'fileChange' && Array.isArray(item.changes)) detail += ` files=${(item.changes as Array<{path:string}>).map(c => c.path).join(',')}`;
            if ((item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') && item.tool) detail += ` tool=${item.tool}`;
            if (item.type === 'agentMessage' && typeof item.text === 'string') detail += ` text=${(item.text as string).length}chars`;
            // Exit code / error for completed items
            if (method === 'item/completed') {
              if (item.exitCode != null) detail += ` exit=${item.exitCode}`;
              if (item.error) detail += ` error=${((item.error as Record<string, unknown>).message as string || '')}`;
            }
          }
        } else if (method === 'turn/completed') {
          const turn = p?.turn as Record<string, unknown> | undefined;
          detail = turn ? ` status=${turn.status}` : '';
          if (turn?.error) detail += ` error=${((turn.error as Record<string, unknown>).message as string || '')}`;
        } else if (method === 'thread/tokenUsage/updated') {
          const usage = (p?.tokenUsage as Record<string, unknown>)?.total as Record<string, unknown> | undefined;
          if (usage) detail = ` in=${usage.inputTokens} out=${usage.outputTokens}`;
        } else if (method === 'thread/status/changed') {
          const status = p?.status as Record<string, unknown> | undefined;
          if (status) detail = ` type=${status.type}`;
        } else if (method === 'thread/started') {
          const thread = p?.thread as Record<string, unknown> | undefined;
          if (thread?.id) detail = ` threadId=${thread.id}`;
        }
        console.log(`[codex] ${method}${detail}`);
      }
      const result = this.parseNotification(codexProc, method, params);
      if (!result) return;
      // parseNotification may return one event or an array (e.g., tool_use_stop + tool_result)
      const events = Array.isArray(result) ? result : [result];
      for (const event of events) wrappedOnEvent(event);
    });

    // Wire up server-request handler for approval requests
    codexProc.rpc.setServerRequestHandler((id, method, params) => {
      this.handleServerRequest(codexProc, id, method, params, wrappedOnEvent);
    });

    // Start background reader (runs for lifetime of session)
    codexProc.rpc.startReading();

    // Track process exit — emit session_complete if not already emitted by protocol.
    // Skipped when the startup catch-handler killed the process itself (e.g. stale
    // `thread/resume`): the caller's error surface already names the real cause,
    // and emitting a synthetic "exited with code 143" here would layer a noisy
    // SIGTERM echo on top. See issue #105.
    proc.exited.then((code) => {
      codexProc.exited = true;
      if (codexProc.intentionalKillDuringStartup) return;
      wrappedOnEvent({
        kind: 'session_complete',
        result: code === 0 ? '' : `Codex process exited with code ${code}`,
        subtype: code === 0 ? 'success' : 'error',
      });
    });

    // Read stderr in background
    if (proc.stderr) {
      (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true }).trim();
            if (text) console.error(`[codex-stderr] ${stripAnsi(text)}`);
          }
        } catch { /* ignore */ } finally {
          reader.releaseLock();
        }
      })();
    }

    try {
      // 1. Initialize handshake
      await codexProc.rpc.call('initialize', {
        clientInfo: { name: 'MyAgents', title: null, version: process.env.MYAGENTS_VERSION || '0.1.60' },
        capabilities: null,
      }, 15_000);

      // 2. Determine permission mode
      const isImOrCron = options.scenario.type === 'im' || options.scenario.type === 'agent-channel' || options.scenario.type === 'cron';
      const permMode = options.permissionMode || (isImOrCron ? 'no-restrictions' : 'full-auto');
      const { approval, sandbox } = mapPermissionMode(permMode);

      // 3. Start or resume thread
      if (options.resumeSessionId) {
        // Resume existing thread
        const resumeParams = {
          threadId: options.resumeSessionId,
          model: options.model || null,
          approvalPolicy: approval,
          sandbox,
          developerInstructions: options.systemPromptAppend || null,
        };
        console.log(`[codex] RPC thread/resume: ${JSON.stringify(resumeParams)}`);
        const result = await codexProc.rpc.call('thread/resume', resumeParams, 30_000) as { thread: { id: string } };
        codexProc.threadId = result.thread.id;

        // Emit synthetic session_init — thread/resume doesn't trigger notifications
        // but external-session needs it for session ID sync and frontend needs
        // chat:system-init for model/tools info after Sidecar restart
        onEvent({
          kind: 'session_init',
          sessionId: result.thread.id,
          model: options.model || '',
          tools: [],
        });
      } else {
        // New thread
        const startParams = {
          cwd: options.workspacePath,
          model: options.model || null,
          approvalPolicy: approval,
          sandbox,
          developerInstructions: options.systemPromptAppend || null,
          ephemeral: false,
        };
        console.log(`[codex] RPC thread/start: ${JSON.stringify(startParams)}`);
        const result = await codexProc.rpc.call('thread/start', startParams, 30_000) as { thread: { id: string }; model: string };
        codexProc.threadId = result.thread.id;

        // Emit session_init so external-session.ts captures threadId
        onEvent({
          kind: 'session_init',
          sessionId: result.thread.id,
          model: result.model || '',
          tools: [],
        });
      }

      // 4. Send initial message if provided
      if (options.initialMessage) {
        const input = buildCodexInput(options.initialMessage, options.initialImages);
        const turnResult = await codexProc.rpc.call('turn/start', {
          threadId: codexProc.threadId,
          input,
          summary: 'concise', // Enable reasoning summary streaming for thinking UI
        }, 15_000) as { turn: { id: string } };
        codexProc.currentTurnId = turnResult.turn.id;
      }
    } catch (err) {
      // Clean up on startup failure.
      // Flag must be set BEFORE proc.kill so proc.exited.then observes it.
      codexProc.intentionalKillDuringStartup = true;
      try { proc.kill(); } catch { /* ignore */ }
      codexProc.exited = true;

      // Detect the specific "rollout was dropped" failure so the caller can
      // invalidate the stale threadId and retry fresh instead of looping on a
      // dead pointer forever. Codex worded this slightly differently across
      // CLI versions (observed on v0.122.0-alpha.1) — match loosely.
      const msg = err instanceof Error ? err.message : String(err);
      if (options.resumeSessionId && /no rollout found|thread not found|conversation not found/i.test(msg)) {
        throw new StaleRuntimeSessionError(options.resumeSessionId, msg);
      }
      throw err;
    }

    return codexProc;
  }

  async sendMessage(process: RuntimeProcess, message: string, images?: ImagePayload[]): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) throw new Error('Codex process has exited');

    const input = buildCodexInput(message, images);
    const turnResult = await codexProc.rpc.call('turn/start', {
      threadId: codexProc.threadId,
      input,
      summary: 'concise',
    }, 15_000) as { turn: { id: string } };
    codexProc.currentTurnId = turnResult.turn.id;
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    /* PRD #131 — interface-uniformity params; Codex's protocol has no
       suggestions / updatedInput / interrupt knobs, so they're accepted
       and ignored. Keeping the signature in lockstep with claude-code.ts
       lets the call site pass arguments unconditionally. */
    _reason?: string,
    _suggestions?: unknown[],
    _updatedInput?: Record<string, unknown>,
    _interrupt?: boolean,
  ): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;

    // requestId for Codex is the JSON-RPC request id (number stored as string)
    const rpcId = parseInt(requestId, 10);
    if (isNaN(rpcId)) {
      console.error('[codex] Invalid approval requestId:', requestId);
      return;
    }

    codexProc.rpc.respond(rpcId, {
      decision: decision === 'deny' ? 'decline' : 'accept',
    });
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    const codexProc = process as CodexProcess;
    if (codexProc.exited) return;

    try {
      // 1. Interrupt current turn if any
      if (codexProc.currentTurnId) {
        await codexProc.rpc.call('turn/interrupt', {
          threadId: codexProc.threadId,
          turnId: codexProc.currentTurnId,
        }, 3_000).catch(() => {});
      }
      // 2. Close stdin — signals app-server to shut down (like CC's closeStdin)
      await codexProc.closeStdin();
    } catch { /* ignore */ }

    try {
      await killWithEscalation(codexProc, {
        gracefulMs: 3_000,
        hardMs: 2_000,
        killTree: true,
        onStep: (step, info) => {
          if (step === 'orphan') {
            console.warn(`[codex] Process pid=${info.pid} did not exit after SIGKILL; continuing with orphan risk`);
          }
        },
      });
    } catch { /* ignore */ } finally {
      codexProc.rpc.destroy();
    }
  }

  // ─── Notification parsing (v2 typed notifications) ───

  private parseNotification(codexProc: CodexProcess, method: string, params: unknown): UnifiedEvent | UnifiedEvent[] | null {
    const p = params as Record<string, unknown>;

    switch (method) {
      // ── Thread lifecycle ──
      case 'thread/started':
        // Thread started notification — no UnifiedEvent needed (session_init already emitted)
        return null;

      case 'thread/status/changed': {
        const status = p.status as { type: string } | undefined;
        if (!status) return null;
        if (status.type === 'active') return { kind: 'status_change', state: 'running' };
        if (status.type === 'idle') return { kind: 'status_change', state: 'idle' };
        if (status.type === 'systemError') return { kind: 'status_change', state: 'error' };
        return null;
      }

      case 'thread/closed':
        return { kind: 'session_complete', result: '', subtype: 'success' };

      // ── Turn lifecycle ──
      case 'turn/started':
        return { kind: 'status_change', state: 'running' };

      case 'turn/completed': {
        const turn = p.turn as { status: string; error?: { message: string } } | undefined;
        if (turn?.status === 'failed') {
          return {
            kind: 'session_complete',
            result: turn.error?.message || 'Turn failed',
            subtype: 'error',
          };
        }
        return { kind: 'turn_complete' };
      }

      // ── Text streaming ──
      case 'item/agentMessage/delta': {
        const itemId = (p.itemId as string) || '';
        const text = (p.delta as string) || '';
        if (itemId && text) {
          codexProc.agentMessageTextById.set(itemId, (codexProc.agentMessageTextById.get(itemId) || '') + text);
        }
        return { kind: 'text_delta', text };
      }

      // ── Reasoning streaming ──
      case 'item/reasoning/summaryTextDelta':
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: (p.summaryIndex as number) || 0,
        };

      case 'item/reasoning/textDelta':
        // Raw reasoning content — also map to thinking for display
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: (p.contentIndex as number) || 0,
        };

      // ── Plan streaming ──
      case 'item/plan/delta':
        // Map plan to thinking display
        return {
          kind: 'thinking_delta',
          text: (p.delta as string) || '',
          index: 0,
        };

      // ── Tool/item lifecycle ──
      // Tool name mapping: Codex item types → existing frontend badge names
      // (Bash, Edit, Grep, Read, Write, WebFetch, Glob, etc.)
      case 'item/started': {
        const item = p.item as {
          type: string; id: string;
          command?: string; cwd?: string; tool?: string; server?: string;
          text?: string; query?: string; arguments?: unknown;
          path?: string; revisedPrompt?: string;
          changes?: Array<{ path: string }>;
          commandActions?: unknown[];
        } | undefined;
        if (!item) return null;
        switch (item.type) {
          case 'commandExecution': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Bash',
              input: {
                command: item.command ?? '',
                ...(item.cwd ? { cwd: item.cwd } : {}),
                ...(Array.isArray(item.commandActions) ? { commandActions: item.commandActions } : {}),
              },
            };
          }
          case 'fileChange': {
            const firstPath = item.changes?.[0]?.path;
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Edit',
              input: {
                ...(firstPath ? { file_path: firstPath } : {}),
                ...(item.cwd ? { cwd: item.cwd } : {}),
                ...(item.changes?.length ? { changes: item.changes } : {}),
              },
            };
          }
          case 'mcpToolCall': {
            // Prefix with mcp__ to match frontend MCP tool badge patterns
            const toolName = item.server && item.tool ? `mcp__${item.server}__${item.tool}` : (item.tool || 'MCP Tool');
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName,
              input: (item.arguments && typeof item.arguments === 'object')
                ? item.arguments as Record<string, unknown>
                : undefined,
            };
          }
          case 'dynamicToolCall': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: item.tool || 'Tool',
              input: (item.arguments && typeof item.arguments === 'object')
                ? item.arguments as Record<string, unknown>
                : undefined,
            };
          }
          case 'webSearch': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'WebSearch',
              input: { query: item.query ?? '' },
            };
          }
          case 'imageView': {
            return {
              kind: 'tool_use_start',
              toolUseId: item.id,
              toolName: 'Read',
              input: item.path ? { file_path: item.path } : undefined,
            };
          }
          case 'imageGeneration':
            return { kind: 'tool_use_start', toolUseId: item.id, toolName: 'ImageGeneration' };
          case 'reasoning':
            return { kind: 'thinking_start', index: 0 };
          case 'agentMessage':
          case 'userMessage':
          case 'plan':
          case 'contextCompaction':
            return null;
          default:
            return null;
        }
      }

      case 'item/completed': {
        const item = p.item as {
          type: string; id: string;
          command?: string; aggregatedOutput?: string; exitCode?: number; durationMs?: number; cwd?: string; processId?: string; status?: string;
          changes?: Array<{ path: string; kind: string; diff: string }>;
          tool?: string; result?: unknown; error?: { message: string };
          text?: string; summary?: string[];
          query?: string; action?: { type: string; url?: string; queries?: string[] };
          path?: string; revisedPrompt?: string;
          contentItems?: Array<{ type: string; text?: string }>;
          success?: boolean;
        } | undefined;
        if (!item) return null;

        // For tool items, emit tool_use_stop + tool_result as a pair
        // (frontend expects stop before result, matching CC's content_block_stop → tool_result)
        switch (item.type) {
          case 'commandExecution':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              {
                kind: 'tool_result',
                toolUseId: item.id,
                content: item.aggregatedOutput || '',
                isError: item.exitCode != null && item.exitCode !== 0,
                metadata: {
                  exitCode: item.exitCode ?? null,
                  durationMs: item.durationMs ?? null,
                  cwd: item.cwd,
                  processId: item.processId ?? null,
                  status: item.status,
                },
              },
            ];
          case 'fileChange': {
            // Show file paths and diffs for each changed file
            const details = Array.isArray(item.changes)
              ? item.changes.map(c => `${c.kind}: ${c.path}${c.diff ? '\n' + c.diff : ''}`).join('\n\n')
              : 'File changed';
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: details },
            ];
          }
          case 'mcpToolCall': {
            // Extract text content from MCP result
            const resultContent = (item.result as { content?: Array<{ text?: string }> })?.content;
            const text = resultContent?.map(c => c.text || '').filter(Boolean).join('\n') || JSON.stringify(item.result ?? '');
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: item.error?.message || text, isError: !!item.error },
            ];
          }
          case 'dynamicToolCall': {
            const text = item.contentItems?.map(c => c.text || '').filter(Boolean).join('\n') || JSON.stringify(item.result ?? '');
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: text, isError: item.success === false },
            ];
          }
          case 'webSearch': {
            const parts: string[] = [];
            if (item.query) parts.push(`Query: ${item.query}`);
            if (item.action?.url) parts.push(`URL: ${item.action.url}`);
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: parts.join('\n') || 'Search completed' },
            ];
          }
          case 'imageView':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: item.path || 'Image viewed' },
            ];
          case 'imageGeneration':
            return [
              { kind: 'tool_use_stop', toolUseId: item.id },
              { kind: 'tool_result', toolUseId: item.id, content: item.revisedPrompt || item.status || 'Image generated' },
            ];
          case 'reasoning':
            return { kind: 'thinking_stop', index: 0 };
          case 'agentMessage': {
            const finalText = typeof item.text === 'string' ? item.text : '';
            const streamedText = codexProc.agentMessageTextById.get(item.id) || '';
            codexProc.agentMessageTextById.delete(item.id);

            if (finalText) {
              if (!streamedText) {
                console.log(`[codex] agentMessage completed without delta; backfilling ${finalText.length} chars`);
                return [
                  { kind: 'text_delta', text: finalText },
                  { kind: 'text_stop' },
                ];
              }

              if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
                const tail = finalText.slice(streamedText.length);
                console.log(`[codex] agentMessage completed with missing tail; backfilling ${tail.length} chars`);
                return [
                  { kind: 'text_delta', text: tail },
                  { kind: 'text_stop' },
                ];
              }
            }

            return { kind: 'text_stop' };
          }
          default:
            return null;
        }
      }

      // ── Command execution output ──
      case 'item/commandExecution/outputDelta':
        return {
          kind: 'tool_result_delta',
          toolUseId: (p.itemId as string) || '',
          delta: (p.delta as string) || '',
        };

      // ── File change output ──
      case 'item/fileChange/outputDelta':
        return {
          kind: 'tool_result_delta',
          toolUseId: (p.itemId as string) || '',
          delta: (p.delta as string) || '',
        };

      // ── Token usage ──
      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { total: { inputTokens: number; outputTokens: number } } | undefined;
        if (usage?.total) {
          return {
            kind: 'usage',
            inputTokens: usage.total.inputTokens || 0,
            outputTokens: usage.total.outputTokens || 0,
            semantics: 'running_total',
          };
        }
        return null;
      }

      // ── Errors ──
      case 'error': {
        const error = p.error as { message: string } | undefined;
        return { kind: 'log', level: 'error', message: error?.message || 'Unknown error' };
      }

      // ── Thread name / diff / plan updates ──
      case 'model/rerouted': {
        const model = typeof p.model === 'string'
          ? p.model
          : typeof p.routedModel === 'string'
            ? p.routedModel
            : typeof p.to === 'string'
              ? p.to
              : typeof p.newModel === 'string'
                ? p.newModel
                : '';
        return model ? { kind: 'model_update', model } : null;
      }

      case 'thread/name/updated':
      case 'turn/diff/updated':
      case 'turn/plan/updated':
      case 'deprecationNotice':
      case 'configWarning':
      case 'skills/changed':
      case 'serverRequest/resolved':
      case 'account/updated':
      case 'account/rateLimits/updated':
      case 'account/login/completed':
      case 'app/list/updated':
      case 'item/mcpToolCall/progress':
      case 'thread/compacted':
      case 'thread/archived':
      case 'thread/unarchived':
        // Not relevant to our event stream — ignore
        return null;

      default: {
        // Legacy codex/event/* notifications — ignore (we use v2 typed notifications)
        if (method.startsWith('codex/event/')) return null;
        // Realtime/Windows — ignore
        if (method.startsWith('thread/realtime/') || method.startsWith('windows/')) return null;
        if (method.startsWith('mcpServer/') || method.startsWith('fuzzyFileSearch/')) return null;
        // Unknown notification
        console.log(`[codex] Unhandled notification: ${method}`);
        return null;
      }
    }
  }

  // ─── Server-initiated request handling (approval) ───

  private handleServerRequest(
    codexProc: CodexProcess,
    rpcId: number,
    method: string,
    params: unknown,
    onEvent: UnifiedEventCallback,
  ): void {
    const p = params as Record<string, unknown>;

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        // Emit permission_request — use rpcId as requestId so respondPermission can reply
        onEvent({
          kind: 'permission_request',
          requestId: String(rpcId),
          toolName: 'Shell',
          toolUseId: (p.itemId as string) || '',
          input: {
            command: (p.command as string) || '',
            cwd: (p.cwd as string) || '',
            reason: (p.reason as string) || undefined,
          },
        });
        break;
      }

      case 'item/fileChange/requestApproval': {
        onEvent({
          kind: 'permission_request',
          requestId: String(rpcId),
          toolName: 'FileEdit',
          toolUseId: (p.itemId as string) || '',
          input: {
            reason: (p.reason as string) || '',
            grantRoot: (p.grantRoot as string) || undefined,
          },
        });
        break;
      }

      case 'item/tool/requestUserInput': {
        // Map to permission_request for user input
        onEvent({
          kind: 'permission_request',
          requestId: String(rpcId),
          toolName: 'UserInput',
          toolUseId: (p.itemId as string) || '',
          input: { questions: p.questions || [] },
        });
        break;
      }

      case 'execCommandApproval':
      case 'applyPatchApproval': {
        // Legacy approval methods — auto-approve in non-interactive contexts
        // The v2 methods above are preferred
        codexProc.rpc.respond(rpcId, { decision: 'accept' });
        break;
      }

      default: {
        // Unknown server request — respond with error
        console.warn(`[codex] Unhandled server request: ${method}`);
        codexProc.rpc.respondError(rpcId, -32601, `Method not supported: ${method}`);
        break;
      }
    }
  }
}
