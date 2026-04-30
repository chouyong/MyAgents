/**
 * Admin API — Self-Configuration endpoints for the CLI tool.
 *
 * All handlers follow the same pattern:
 *   1. Validate input
 *   2. If dry-run → return preview
 *   3. Write config (atomicModifyConfig)
 *   4. Update Sidecar in-memory state
 *   5. Broadcast SSE event for frontend sync
 *   6. Return result
 */

import type { McpServerDefinition } from '../renderer/config/types';
import { PRESET_PROVIDERS } from '../renderer/config/types';
import { SDK_RESERVED_MCP_NAMES } from './agent-session';
import {
  loadConfig,
  atomicModifyConfig,
  getAllMcpServers,
  getEnabledMcpServerIds,
  loadProjects,
  saveProjects,
  redactSecret,
  findProvider,
  getProvidersDir,
  loadCustomProviderFiles,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ChannelConfigSlim,
} from './utils/admin-config';
import { cancellableFetch } from './utils/cancellation';
import { readLoopbackJson } from './utils/loopback-response';

// Localhost loopback timeout for management / sidecar self-calls.
// 10s is generous for an in-process Rust handler or a same-process Hono
// route — anything slower means the backend is wedged, in which case we'd
// rather surface a CLI error than hang the user's terminal indefinitely.
const ADMIN_LOOPBACK_TIMEOUT_MS = 10_000;
import { existsSync , writeFileSync, unlinkSync } from 'fs';
import { ensureDirSync } from './utils/fs-utils';
import { resolve } from 'path';
import { setMcpServers, setAgents, getMcpServers, getAgentState, getSidecarPort, forceReloadActiveSession } from './agent-session';
import { loadEnabledAgents } from './agents/agent-loader';
import { getHomeDirOrNull } from './utils/platform';
import { join } from 'path';
import { broadcast } from './sse';
import { getCronTaskContext, CRON_TASK_EXIT_TEXT } from './tools/cron-tools';
import { getImMediaContext } from './tools/im-media-tool';
import { buildReadMeContent } from './tools/generative-ui-tool';
import { assertSafeFilePath } from './utils/safe-file-path';
import {
  VALID_RUNTIMES,
  RUNTIME_DISPLAY_NAMES,
  getRuntimePermissionModes,
  getDefaultRuntimePermissionMode,
  type RuntimeType,
  type RecoveryHint,
  type RuntimePermissionMode,
  type RuntimeModelInfo,
  type RuntimeDetection,
} from '../shared/types/runtime';
import { getExternalRuntime, isRuntimeSupported } from './runtimes/factory';
import { queryRuntimeModels } from './runtimes/external-session';
import { trackServer } from './analytics';

/**
 * Infer the analytics `source` for a CLI-originated request.
 *
 * - `MYAGENTS_PORT` is injected into AI subproc env by `buildClaudeSessionEnv()`
 *   (cli_architecture.md). When it's set, the caller is an AI agent invoking
 *   the CLI as a tool (`cli_agent`). Otherwise it's the user typing in their
 *   terminal (`cli`).
 *
 * Same logic that `handleTaskUpdateStatus` already uses for the persisted
 * `actor` field — extracted so every CLI handler can tag analytics events
 * consistently without re-deriving the heuristic.
 */
function cliSource(): 'cli' | 'cli_agent' {
  return process.env.MYAGENTS_PORT ? 'cli_agent' : 'cli';
}

// ---------------------------------------------------------------------------
// Management API forwarding (Node Sidecar → Rust)
// ---------------------------------------------------------------------------

const MGMT_PORT = process.env.MYAGENTS_MANAGEMENT_PORT;

async function managementApi(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!MGMT_PORT) {
    // Happens when the Node Sidecar is up but the Rust-side Management API
    // isn't — during app cold boot, after a crashed restart, or in the
    // standalone dev sidecar used for CLI smoke tests. Returning the hint
    // alongside the error lets `wrapMgmtResponse` propagate it to the CLI
    // so the reader sees `→ Run: myagents status` instead of a dead-end.
    return {
      ok: false,
      error: 'Management API not available (app may still be starting)',
      recoveryHint: {
        recoveryCommand: 'myagents status',
        message: 'Check whether the app backend is fully up; if not, retry in a few seconds.',
      },
    };
  }
  const url = `http://127.0.0.1:${MGMT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, { timeoutMs: ADMIN_LOOPBACK_TIMEOUT_MS });
    // Issue #114 — defensive read via shared helper.
    return await readLoopbackJson(resp, 'Management API');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Management API unreachable: ${msg}`,
      recoveryHint: {
        recoveryCommand: 'myagents status',
        message: 'Check backend health; restart the app if the problem persists.',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Sidecar self-loopback (for thin wrappers over existing /api/skill/* routes)
// ---------------------------------------------------------------------------

async function sidecarSelf(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' = 'GET',
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sidecarPort = getSidecarPort();
  if (!sidecarPort) {
    return { status: 500, json: { success: false, error: 'Sidecar port not initialized' } };
  }
  const url = `http://127.0.0.1:${sidecarPort}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, { timeoutMs: ADMIN_LOOPBACK_TIMEOUT_MS });
    // Issue #114 — defensive read via shared helper. Map to this caller's
    // legacy {status, json} shape (sidecarSelf has callers that branch on
    // status code, so we preserve that envelope rather than collapsing to
    // a flat error object).
    const json = await readLoopbackJson(resp, 'Sidecar self-call');
    return { status: resp.status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, json: { success: false, error: `Sidecar self-call failed: ${msg}` } };
  }
}

/**
 * Build an AdminResponse error from a Management API failure, preserving any
 * `recoveryHint` the helper attached (currently: unreachable-backend cases).
 *
 * Use this instead of `{ success: false, error: String(resp.error ?? 'X') }`
 * in handlers that transform the shape (e.g. list handlers that unwrap
 * `resp.tasks` / `resp.runs`) — those bypass `wrapMgmtResponse` but still
 * deserve the hint propagation. Sites that already go through
 * `wrapMgmtResponse` don't need to change.
 */
function mgmtError(resp: Record<string, unknown>, fallbackMsg: string): AdminResponse {
  const response: AdminResponse = {
    success: false,
    error: String(resp.error ?? fallbackMsg),
  };
  const hint = resp.recoveryHint;
  if (hint && typeof hint === 'object' && !Array.isArray(hint)) {
    response.recoveryHint = hint as RecoveryHint;
  }
  return response;
}

/** Convert Management API response ({ ok, ... }) to Admin API response ({ success, data, error }) */
function wrapMgmtResponse(mgmt: Record<string, unknown>): AdminResponse {
  if (mgmt.ok) {
    const { ok: _ok, recoveryHint: _rh, ...rest } = mgmt;
    return { success: true, data: rest };
  }
  const response: AdminResponse = {
    success: false,
    error: String(mgmt.error ?? 'Unknown error'),
  };
  // Propagate the `recoveryHint` if the Management API helper attached one
  // (currently only for unreachable-backend scenarios — see `managementApi`).
  const maybeHint = mgmt.recoveryHint;
  if (maybeHint && typeof maybeHint === 'object' && !Array.isArray(maybeHint)) {
    response.recoveryHint = maybeHint as RecoveryHint;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Free-form success tip ("Server added.", "Restart required."). Purely
   * informational — distinct from `recoveryHint` which is a structured,
   * actionable recovery path for a failed request.
   */
  hint?: string;
  /**
   * Structured recovery path for recoverable errors. The CLI renders this
   * under the error line as `→ Run: <command>` so the caller (AI or human)
   * can copy-paste to correct course without digging through --help.
   *
   * Pair a `recoveryHint` with `success: false` + `error` — never emit one
   * on a success path; use `hint` there.
   */
  recoveryHint?: RecoveryHint;
  dryRun?: boolean;
  preview?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP Handlers
// ---------------------------------------------------------------------------

export function handleMcpList(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = new Set(getEnabledMcpServerIds(config));

  const data = allServers.map(s => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: enabledIds.has(s.id),
    isBuiltin: s.isBuiltin,
    command: s.command,
    url: s.url,
    requiresConfig: s.requiresConfig,
    hasEnv: !!(s.env && Object.keys(s.env).length > 0),
  }));

  return { success: true, data };
}

/**
 * `myagents mcp show <id>` — details for a single MCP server.
 *
 * Mirrors handleAgentShow: parses user-facing config + workspace enable state
 * into one consolidated payload the AI / user can inspect without dumping the
 * whole list. Env values are redacted so an AI transcript never leaks API keys
 * (same redaction rule the model-list endpoint already uses).
 */
export function handleMcpShow(payload: { id?: string }): AdminResponse {
  const id = payload.id;
  if (!id) {
    return {
      success: false,
      error: 'Missing required argument: <mcp-id>',
      recoveryHint: {
        recoveryCommand: 'myagents mcp list',
        message: 'See valid MCP server ids.',
      },
    };
  }
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const server = allServers.find(s => s.id === id);
  if (!server) {
    return {
      success: false,
      error: `MCP server '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents mcp list',
        message: 'See valid MCP server ids.',
      },
    };
  }

  const globalEnabled = new Set(getEnabledMcpServerIds(config));
  const workspacePath = getCurrentWorkspacePath();
  let projectEnabled: boolean | null = null;
  if (workspacePath) {
    const projects = loadProjects();
    const project = projects.find(p => p.path === workspacePath);
    projectEnabled = new Set(project?.mcpEnabledServers ?? []).has(id);
  }

  // Redact env values — mirrors what `model list` does for provider api keys.
  const env = server.env ? Object.fromEntries(
    Object.entries(server.env).map(([k, v]) => [k, redactSecret(v)]),
  ) : undefined;

  return {
    success: true,
    data: {
      id: server.id,
      name: server.name,
      type: server.type,
      description: server.description,
      isBuiltin: !!server.isBuiltin,
      requiresConfig: !!server.requiresConfig,
      websiteUrl: server.websiteUrl,
      command: server.command,
      args: server.args,
      url: server.url,
      // Headers (for http/sse) and env (for stdio) — redacted values only.
      headers: server.headers ? Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [k, redactSecret(v)]),
      ) : undefined,
      env,
      enabled: {
        global: globalEnabled.has(id),
        // null = no current workspace session → project scope n/a.
        project: projectEnabled,
      },
      workspacePath: workspacePath ?? null,
    },
  };
}

export async function handleMcpAdd(payload: {
  server: Partial<McpServerDefinition>;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  const { dryRun } = payload;
  const s = payload.server;

  // Validate required fields
  if (!s.id) return { success: false, error: 'Missing required field: id' };
  if (!s.type) return { success: false, error: 'Missing required field: type' };

  // Reject SDK reserved MCP names — these cause the Claude Agent SDK to crash (exit code 1)
  // with "Invalid MCP configuration: X is a reserved MCP name."
  const normalizedId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (SDK_RESERVED_MCP_NAMES.includes(normalizedId)) {
    return { success: false, error: `MCP ID "${s.id}" 与 Claude SDK 内置保留名冲突，请使用其他名称（如 "my-${s.id}"）` };
  }

  if (s.type === 'stdio' && !s.command) {
    return { success: false, error: 'stdio type requires "command" field' };
  }
  if ((s.type === 'sse' || s.type === 'http') && !s.url) {
    return { success: false, error: `${s.type} type requires "url" field` };
  }

  const server: McpServerDefinition = {
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    description: s.description,
    command: s.command,
    // Defensive: CLI may send non-array args (boolean, string) due to parsing edge cases
    args: Array.isArray(s.args) ? s.args : undefined,
    env: s.env,
    url: s.url,
    headers: s.headers,
    isBuiltin: false,
    requiresConfig: s.requiresConfig,
    websiteUrl: s.websiteUrl,
    configHint: s.configHint,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: server };
  }

  await atomicModifyConfig(c => ({
    ...c,
    mcpServers: [...(c.mcpServers || []).filter(x => x.id !== server.id), server],
  }));

  notifyMcpChange('add', server.id);
  return {
    success: true,
    data: { id: server.id, name: server.name },
    hint: 'Server added. Use "myagents mcp enable" to activate.',
  };
}

export async function handleMcpRemove(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Check if it's a built-in preset
  const allServers = getAllMcpServers();
  const target = allServers.find(s => s.id === id);
  if (!target) return { success: false, error: `MCP server '${id}' not found` };
  if (target.isBuiltin) {
    return { success: false, error: `Cannot remove built-in MCP server '${id}'. Only custom servers can be removed.` };
  }

  await atomicModifyConfig(c => {
    const servers = (c.mcpServers || []).filter(s => s.id !== id);
    const enabled = (c.mcpEnabledServers || []).filter(s => s !== id);
    const envOverrides = { ...(c.mcpServerEnv || {}) };
    delete envOverrides[id];
    const argsOverrides = { ...(c.mcpServerArgs || {}) };
    delete argsOverrides[id];
    return { ...c, mcpServers: servers, mcpEnabledServers: enabled, mcpServerEnv: envOverrides, mcpServerArgs: argsOverrides };
  });

  notifyMcpChange('remove', id);
  return { success: true, data: { id }, hint: 'Server removed.' };
}

export async function handleMcpEnable(payload: { id: string; scope?: string }): Promise<AdminResponse> {
  const { id, scope = 'both' } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Verify server exists
  const allServers = getAllMcpServers();
  if (!allServers.find(s => s.id === id)) {
    return { success: false, error: `MCP server '${id}' not found` };
  }

  if (scope === 'global' || scope === 'both') {
    await atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.add(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  if (scope === 'project' || scope === 'both') {
    enableMcpForCurrentProject(id);
  }

  notifyMcpChange('enable', id);
  const scopeLabel = scope === 'both' ? 'global + project' : scope;
  return { success: true, data: { id, scope: scopeLabel }, hint: `Enabled ${id} (${scopeLabel}).` };
}

export async function handleMcpDisable(payload: { id: string; scope?: string }): Promise<AdminResponse> {
  const { id, scope = 'both' } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (scope === 'global' || scope === 'both') {
    await atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.delete(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  if (scope === 'project' || scope === 'both') {
    disableMcpForCurrentProject(id);
  }

  notifyMcpChange('disable', id);
  return { success: true, data: { id } };
}

export async function handleMcpEnv(payload: {
  id: string;
  action: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): Promise<AdminResponse> {
  const { id, action, env } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (action === 'get') {
    const config = loadConfig();
    const serverEnv = (config.mcpServerEnv ?? {})[id] ?? {};
    // Redact values for safety
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverEnv)) {
      redacted[k] = redactSecret(v);
    }
    return { success: true, data: { id, env: redacted } };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    await atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      mcpServerEnv[id] = { ...(mcpServerEnv[id] || {}), ...env };
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, keys: Object.keys(env) }, hint: 'Environment variables updated.' };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    await atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      if (mcpServerEnv[id]) {
        // Deep-copy per-server env to avoid mutating the original config object
        const serverEnv = { ...mcpServerEnv[id] };
        for (const key of Object.keys(env)) {
          delete serverEnv[key];
        }
        if (Object.keys(serverEnv).length === 0) {
          delete mcpServerEnv[id];
        } else {
          mcpServerEnv[id] = serverEnv;
        }
      }
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, deletedKeys: Object.keys(env) } };
  }

  return { success: false, error: `Unknown action: ${action}. Use 'set', 'get', or 'delete'.` };
}

export async function handleMcpTest(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { success: false, error: `MCP server '${id}' not found` };

  // Validate config completeness
  if (server.type === 'stdio' && !server.command) {
    return { success: false, error: `MCP server '${id}' has no command configured` };
  }
  if ((server.type === 'sse' || server.type === 'http') && !server.url) {
    return { success: false, error: `MCP server '${id}' has no URL configured` };
  }

  // Built-in MCP: delegate to registry.
  // getBuiltinMcpInstance() force-loads the tool module (SDK+zod+server
  // construction) on first hit; it returns undefined only when the id isn't
  // registered in META. META is registered via agent-session.ts's side-effect
  // import of './tools/builtin-mcp-meta', which already ran before any admin
  // handler can fire — no need to force-import META here.
  if (server.command === '__builtin__') {
    const { getBuiltinMcpInstance } = await import('./tools/builtin-mcp-registry');
    const entryPromise = getBuiltinMcpInstance(server.id);
    if (!entryPromise) {
      return { success: false, error: `Built-in MCP '${server.id}' not registered` };
    }
    // Don't swallow factory/import errors — a failing `myagents mcp test` must
    // surface as "failure" so users/agents diagnose the actual issue instead of
    // getting a false "validated" green light while the session keeps breaking.
    try {
      const entry = await entryPromise;
      if (entry.validate) {
        const validationError = await entry.validate(server.env || {});
        if (validationError) {
          const errMsg = typeof validationError === 'string' ? validationError : JSON.stringify(validationError);
          return { success: false, error: errMsg };
        }
      }
    } catch (err) {
      return {
        success: false,
        error: `Built-in MCP '${server.id}' load failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { success: true, data: { id, type: 'builtin' }, hint: 'Built-in MCP validated.' };
  }

  // Bundled cuse (computer-use) binary: resolve via runtime helper and
  // check the resolved path exists. Skip the generic `which` preflight —
  // __bundled_cuse__ is a sentinel, not a real PATH lookup. Response
  // surface deliberately omits the resolved absolute path so the sentinel
  // mapping never leaks to user-facing UI.
  if (server.command === '__bundled_cuse__') {
    const { getBundledCusePath } = await import('./utils/runtime');
    const cusePath = getBundledCusePath();
    if (!cusePath) {
      return {
        success: false,
        error: `cuse 二进制未安装 (platform=${process.platform})。macOS/Windows 构建会自动包含；开发环境请运行 scripts/download_cuse.sh。`,
      };
    }
    return { success: true, data: { id, type: 'stdio' }, hint: 'Bundled cuse validated.' };
  }

  // SSE/HTTP: test URL reachability
  if (server.type === 'sse' || server.type === 'http') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      // Inject stored OAuth token if no explicit Authorization header
      const { resolveAuthHeaders } = await import('./mcp-oauth');
      const configHeaders = server.headers || {};
      const hasExplicitAuth = Object.keys(configHeaders).some(k => k.toLowerCase() === 'authorization');
      const oauthHeaders = hasExplicitAuth ? {} : await resolveAuthHeaders(server.id);

      const headers: Record<string, string> = {
        'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
        'Accept-Encoding': 'identity',
        ...configHeaders,
        ...oauthHeaders,
      };

      const resp = server.type === 'http'
        ? await fetch(server.url!, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'MyAgents', version: '1.0' } } }),
            signal: controller.signal,
          })
        : await fetch(server.url!, { method: 'GET', headers, signal: controller.signal });

      clearTimeout(timeout);

      if (resp.status === 401 || resp.status === 403) {
        const hint = oauthHeaders['Authorization']
          ? 'OAuth token may be expired or revoked. Try re-authorizing.'
          : 'This server may require OAuth authorization. Use Settings UI or `myagents mcp oauth start`.';
        return { success: false, error: `Authentication failed (HTTP ${resp.status}). ${hint}` };
      }
      if (!resp.ok) {
        return { success: false, error: `Server returned HTTP ${resp.status}` };
      }

      return { success: true, data: { id, type: server.type, status: resp.status }, hint: `Connection OK (HTTP ${resp.status}).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) return { success: false, error: 'Connection timed out (15s).' };
      return { success: false, error: `Connection failed: ${msg}` };
    }
  }

  // stdio: check command exists in PATH
  if (server.type === 'stdio' && server.command && server.command !== '__builtin__') {
    try {
      const { getShellEnv } = await import('./utils/shell');
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      const { spawn } = await import('child_process');
      const code = await new Promise<number | null>(resolve => {
        const proc = spawn(checkCmd, [server.command!], { stdio: 'ignore', env: getShellEnv() });
        proc.on('close', resolve);
        proc.on('error', () => resolve(null));
      });
      if (code === 0) {
        return { success: true, data: { id, type: 'stdio', command: server.command }, hint: `Command '${server.command}' found.` };
      }
      return { success: false, error: `Command '${server.command}' not found in PATH.` };
    } catch (err) {
      return { success: false, error: `Failed to check command: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { success: true, data: { id, type: server.type }, hint: 'Configuration valid.' };
}

// ---------------------------------------------------------------------------
// MCP OAuth Handlers (CLI-facing wrappers around mcp-oauth module)
// ---------------------------------------------------------------------------

/** Resolve MCP server URL from config by ID */
function getMcpServerUrl(id: string): { url: string } | { error: string } {
  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { error: `MCP server '${id}' not found` };
  if (server.type !== 'sse' && server.type !== 'http') {
    return { error: `MCP server '${id}' is type '${server.type}' — OAuth only applies to sse/http servers.` };
  }
  if (!server.url) return { error: `MCP server '${id}' has no URL configured` };
  return { url: server.url };
}

export async function handleMcpOAuthDiscover(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { probeOAuthRequirement } = await import('./mcp-oauth');
    const result = await probeOAuthRequirement(id, resolved.url, true);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return { success: false, error: `OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthStart(payload: {
  id: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  callbackPort?: number;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { authorizeServer } = await import('./mcp-oauth');
    const manualConfig = payload.clientId ? {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      scopes: payload.scopes ? payload.scopes.split(/[,\s]+/).filter(Boolean) : undefined,
      callbackPort: payload.callbackPort,
    } : undefined;

    const { authUrl, waitForCompletion } = await authorizeServer(id, resolved.url, manualConfig);

    // Fire-and-forget: log completion but don't block the HTTP response.
    // CLI should poll `mcp oauth status <id>` to check completion.
    waitForCompletion.then(ok => {
      console.log(`[admin] OAuth ${ok ? 'completed' : 'failed/cancelled'} for MCP ${id}`);
    });

    return { success: true, data: { id, authUrl }, hint: 'Authorization started. Complete in browser, then check with `mcp oauth status`.' };
  } catch (err) {
    return { success: false, error: `OAuth start failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthStatus(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { getOAuthStatus } = await import('./mcp-oauth');
    const result = getOAuthStatus(id);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return { success: false, error: `OAuth status check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthRevoke(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { revokeAuthorization } = await import('./mcp-oauth');
    await revokeAuthorization(id);
    return { success: true, data: { id }, hint: 'OAuth authorization revoked.' };
  } catch (err) {
    return { success: false, error: `OAuth revoke failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Model Provider Handlers
// ---------------------------------------------------------------------------

export function handleModelList(): AdminResponse {
  const config = loadConfig();
  const apiKeys = config.providerApiKeys ?? {};
  const verifyStatus = config.providerVerifyStatus ?? {};

  // Load preset providers (statically imported — see top of file).
  // Cast via `unknown` because `Provider` doesn't carry a string index
  // signature; the downstream loop accesses fields by name through `String(p.id)`
  // and `p.config as Record<string, unknown> | undefined`, which works on
  // both shapes uniformly.
  const presetProviders: Array<Record<string, unknown>> = (PRESET_PROVIDERS ?? []) as unknown as Array<Record<string, unknown>>;

  // Load custom providers
  const customProviders = loadCustomProviderFiles();

  const allProviders = [...presetProviders, ...customProviders];
  const data = allProviders.map(p => {
    const id = String(p.id);
    const cfg = p.config as Record<string, unknown> | undefined;
    return {
      id,
      name: String(p.name),
      vendor: p.vendor ? String(p.vendor) : undefined,
      baseUrl: cfg?.baseUrl ? String(cfg.baseUrl) : undefined,
      isBuiltin: !!p.isBuiltin,
      protocol: p.apiProtocol ? String(p.apiProtocol) : 'anthropic',
      hasApiKey: !!apiKeys[id],
      status: (verifyStatus[id] as Record<string, unknown>)?.status ?? 'not-set',
    };
  });

  return { success: true, data };
}

export async function handleModelSetKey(payload: { id: string; apiKey: string }): Promise<AdminResponse> {
  const { id, apiKey } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!apiKey) return { success: false, error: 'Missing required field: apiKey' };

  await atomicModifyConfig(c => ({
    ...c,
    providerApiKeys: { ...(c.providerApiKeys || {}), [id]: apiKey },
  }));

  broadcast('config:changed', { section: 'model', action: 'set-key', id });
  return { success: true, data: { id }, hint: `API key saved for ${id}.` };
}

export async function handleModelSetDefault(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  await atomicModifyConfig(c => ({
    ...c,
    defaultProviderId: id,
  }));

  broadcast('config:changed', { section: 'model', action: 'set-default', id });
  return { success: true, data: { id }, hint: `Default provider set to ${id}.` };
}

export async function handleModelVerify(payload: { id: string; model?: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const apiKey = (config.providerApiKeys ?? {})[id];
  if (!apiKey) {
    return { success: false, error: `No API key set for provider '${id}'. Use 'myagents model set-key' first.` };
  }

  // Look up provider config (preset or custom)
  const provider = findProvider(id);
  if (!provider) {
    return { success: false, error: `Provider '${id}' not found in presets or custom providers.` };
  }

  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const baseUrl = String(providerConfig.baseUrl ?? '');
  const authType = String(provider.authType ?? 'both');
  const apiProtocol = provider.apiProtocol as 'anthropic' | 'openai' | undefined;
  const userPrimary = (config.providerPrimaryModels as Record<string, string> | undefined)?.[id];
  const verifyModel = payload.model ?? userPrimary ?? String(provider.primaryModel ?? '');

  try {
    const { verifyProviderViaSdk } = await import('./provider-verify');
    const result = await verifyProviderViaSdk(
      baseUrl, apiKey, authType, verifyModel,
      apiProtocol,
      provider.maxOutputTokens ? Number(provider.maxOutputTokens) : undefined,
      provider.maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
      provider.upstreamFormat as 'chat_completions' | 'responses' | undefined,
    );

    if (result.success) {
      // Persist verify status
      await atomicModifyConfig(c => ({
        ...c,
        providerVerifyStatus: {
          ...(c.providerVerifyStatus ?? {}),
          [id]: { status: 'valid', verifiedAt: new Date().toISOString() },
        },
      }));
      broadcast('config:changed', { section: 'model', action: 'verify', id });
      return { success: true, data: { id, model: verifyModel }, hint: 'Verification successful.' };
    }

    return { success: false, error: result.error ?? 'Verification failed', data: { id, detail: result.detail } };
  } catch (err) {
    return { success: false, error: `Verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleModelAdd(payload: {
  provider: Record<string, unknown>;
  dryRun?: boolean;
}): AdminResponse {
  const { dryRun } = payload;
  const p = payload.provider;

  // Validate required fields
  if (!p.id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(String(p.id))) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };
  if (!p.name) return { success: false, error: 'Missing required field: name' };
  if (!p.baseUrl) return { success: false, error: 'Missing required field: baseUrl (API endpoint)' };
  if (!p.models || !Array.isArray(p.models) || p.models.length === 0) {
    return { success: false, error: 'Missing required field: models (at least one model ID required)' };
  }

  // Build model entities
  const modelSeries = (p.modelSeries as string) || String(p.id);
  const modelIds = p.models as string[];
  const modelNames = (p.modelNames as string[]) || modelIds;
  const models = modelIds.map((model, i) => ({
    model,
    modelName: modelNames[i] || model,
    modelSeries,
  }));

  // Build aliases
  let modelAliases: Record<string, string> | undefined;
  if (p.aliases && typeof p.aliases === 'object') {
    modelAliases = p.aliases as Record<string, string>;
  } else if (modelIds.length > 0) {
    // Default: map sonnet/opus/haiku to first model
    modelAliases = { sonnet: modelIds[0], opus: modelIds[0], haiku: modelIds[0] };
  }

  const providerObj = {
    id: String(p.id),
    name: String(p.name),
    vendor: String(p.vendor ?? p.name),
    cloudProvider: String(p.cloudProvider ?? ''),
    type: 'api' as const,
    primaryModel: String(p.primaryModel ?? modelIds[0]),
    isBuiltin: false,
    config: {
      baseUrl: String(p.baseUrl),
      ...(p.timeout ? { timeout: Number(p.timeout) } : {}),
      ...(p.disableNonessential ? { disableNonessential: true } : {}),
    },
    authType: String(p.authType ?? 'auth_token'),
    ...(p.protocol === 'openai' || p.apiProtocol === 'openai' ? {
      apiProtocol: 'openai' as const,
      ...(p.maxOutputTokens ? { maxOutputTokens: Number(p.maxOutputTokens) } : {}),
      ...(p.maxOutputTokensParamName ? { maxOutputTokensParamName: String(p.maxOutputTokensParamName) } : {}),
      upstreamFormat: String(p.upstreamFormat ?? 'chat_completions') as 'chat_completions' | 'responses',
    } : {}),
    websiteUrl: p.websiteUrl ? String(p.websiteUrl) : undefined,
    models,
    modelAliases,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: providerObj };
  }

  // Write to ~/.myagents/providers/{id}.json
  saveCustomProviderFile(providerObj);
  broadcast('config:changed', { section: 'model', action: 'add', id: providerObj.id });
  return {
    success: true,
    data: { id: providerObj.id, name: providerObj.name, models: modelIds },
    hint: `Provider added. Use 'myagents model set-key ${providerObj.id} <key>' to set API key.`,
  };
}

export async function handleModelRemove(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(id)) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };

  // Check if it's a preset
  const provider = findProvider(id);
  if (provider?.isBuiltin) {
    return { success: false, error: `Cannot remove built-in provider '${id}'. Only custom providers can be removed.` };
  }

  // Delete provider file
  if (!deleteCustomProviderFile(id)) {
    return { success: false, error: `Custom provider '${id}' not found.` };
  }

  // Clean up API key and verify status
  await atomicModifyConfig(c => {
    const apiKeys = { ...(c.providerApiKeys ?? {}) };
    delete apiKeys[id];
    const verifyStatus = { ...(c.providerVerifyStatus ?? {}) };
    delete verifyStatus[id];
    // If this was the default provider, clear it
    const defaultId = c.defaultProviderId === id ? undefined : c.defaultProviderId;
    return { ...c, providerApiKeys: apiKeys, providerVerifyStatus: verifyStatus, defaultProviderId: defaultId };
  });

  broadcast('config:changed', { section: 'model', action: 'remove', id });
  return { success: true, data: { id }, hint: 'Provider removed.' };
}

// ---------------------------------------------------------------------------
// Agent Handlers
// ---------------------------------------------------------------------------

export function handleAgentList(): AdminResponse {
  const config = loadConfig();
  const agents = (config.agents ?? []).map(a => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    workspacePath: a.workspacePath,
    channelCount: (a.channels ?? []).length,
    channels: (a.channels ?? []).map(ch => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      enabled: ch.enabled,
    })),
  }));
  return { success: true, data: agents };
}

export async function handleAgentEnable(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: true }), 'enable');
}

export async function handleAgentDisable(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: false }), 'disable');
}

export async function handleAgentSet(payload: { id: string; key: string; value: unknown }): Promise<AdminResponse> {
  const { id, key, value } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Protect sensitive/structural fields
  const protectedFields = ['id', 'channels'];
  if (protectedFields.includes(key)) {
    return { success: false, error: `Cannot directly set field '${key}'. Use specific commands instead.` };
  }

  return modifyAgent(id, agent => ({ ...agent, [key]: value }), 'set');
}

export function handleAgentChannelList(payload: { agentId: string }): AdminResponse {
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === payload.agentId);
  if (!agent) return { success: false, error: `Agent '${payload.agentId}' not found` };

  return { success: true, data: (agent.channels ?? []).map(ch => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
  })) };
}

export async function handleAgentChannelAdd(payload: {
  agentId: string;
  channel: Record<string, unknown>;
}): Promise<AdminResponse> {
  const { agentId, channel } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channel.type) return { success: false, error: 'Missing required field: channel.type' };

  const channelId = channel.id as string || crypto.randomUUID();
  const newChannel: ChannelConfigSlim = {
    ...channel,        // user-provided fields first
    id: channelId,     // override with guaranteed values
    type: channel.type as string,
    name: channel.name as string || `${channel.type} channel`,
    enabled: channel.enabled !== undefined ? !!channel.enabled : true,
  };

  const result = await modifyAgent(agentId, agent => ({
    ...agent,
    channels: [...(agent.channels ?? []), newChannel],
  }), 'channel-add');
  if (result.success) {
    trackServer('agent_channel_create', {
      source: cliSource(),
      platform: newChannel.type,
    });
  }
  return result;
}

export async function handleAgentChannelRemove(payload: { agentId: string; channelId: string }): Promise<AdminResponse> {
  const { agentId, channelId } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channelId) return { success: false, error: 'Missing required field: channelId' };

  // Capture platform BEFORE the channel is removed — once `modifyAgent`
  // commits, the channel is gone and we can't read its type. Best-effort:
  // if the lookup fails (agent missing, channel missing) we still attempt
  // the remove and report `platform: 'unknown'` rather than skipping
  // analytics entirely.
  let platform = 'unknown';
  try {
    const config = loadConfig();
    const agent = (config.agents ?? []).find(a => a.id === agentId);
    const ch = agent?.channels?.find(c => c.id === channelId);
    if (ch?.type) platform = ch.type;
  } catch {
    // Silent — analytics must not affect the main flow.
  }

  const result = await modifyAgent(agentId, agent => ({
    ...agent,
    channels: (agent.channels ?? []).filter(ch => ch.id !== channelId),
  }), 'channel-remove');
  if (result.success) {
    trackServer('agent_channel_remove', { source: cliSource(), platform });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config Handlers
// ---------------------------------------------------------------------------

export function handleConfigGet(payload: { key: string }): AdminResponse {
  const { key } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  const config = loadConfig();
  const value = getNestedValue(config, key);
  if (value === undefined) {
    return { success: false, error: `Config key '${key}' not found` };
  }

  // Redact sensitive fields recursively
  const redacted = redactSensitiveValues(key, value);
  return { success: true, data: { key, value: redacted } };
}

export async function handleConfigSet(payload: { key: string; value: unknown; dryRun?: boolean }): Promise<AdminResponse> {
  const { key, value, dryRun } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Reject dangerous key paths (prototype pollution)
  if (hasDangerousKeySegment(key)) {
    return { success: false, error: 'Invalid key path' };
  }

  // Protect structural/sensitive keys that have dedicated commands
  const protectedKeys = ['providerApiKeys', 'providerVerifyStatus', 'agents', 'mcpServers', 'mcpEnabledServers', 'mcpServerEnv', 'mcpServerArgs', 'imBotConfigs'];
  const rootKey = key.split('.')[0];
  if (protectedKeys.includes(rootKey)) {
    return { success: false, error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'myagents mcp', 'myagents agent', 'myagents model set-key').` };
  }

  if (dryRun) {
    return { success: true, dryRun: true, preview: { key, value } };
  }

  await atomicModifyConfig(c => setNestedValue(c, key, value));
  broadcast('config:changed', { section: 'config', action: 'set', key });
  return { success: true, data: { key }, hint: `Config '${key}' updated.` };
}

// ---------------------------------------------------------------------------
// Status & Reload
// ---------------------------------------------------------------------------

export function handleStatus(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = getEnabledMcpServerIds(config);
  const currentMcp = getMcpServers();

  return {
    success: true,
    data: {
      mcpServers: { total: allServers.length, enabled: enabledIds.length },
      activeMcpInSession: currentMcp ? currentMcp.length : 0,
      defaultProvider: config.defaultProviderId ?? 'not set',
      agents: (config.agents ?? []).length,
    },
  };
}

export function handleReload(workspacePath?: string): AdminResponse {
  // Re-read config from disk and push effective MCP + sub-agents to in-memory state.
  // Workspace resolution: prefer explicit arg → fall back to the session's agentDir.
  // Without this fallback, sub-agent reload would only see global agents.
  const effectiveWorkspace = workspacePath || getCurrentWorkspacePath();

  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  let effectiveServers: McpServerDefinition[];

  if (effectiveWorkspace) {
    // Filter by project if workspace is known
    const projects = loadProjects();
    const project = projects.find(p => p.path === effectiveWorkspace);
    if (project) {
      const projectEnabled = new Set(project.mcpEnabledServers ?? []);
      effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
    } else {
      // Workspace path doesn't match any registered project (transient state
      // during project-rename, or unregistered workspace). Without this
      // branch we'd silently push ZERO MCP servers — cross-review Agent-1
      // W6. Fall back to the "no workspace" branch (globally enabled) so
      // reload is a no-op on MCP rather than a destructive clear.
      console.warn(
        `[admin-api] handleReload: workspace ${effectiveWorkspace} not found in projects; falling back to global MCP set`,
      );
      effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
    }
  } else {
    // Fallback: use all globally enabled servers
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
  }

  // Sub-agent reload: re-scan the .md files on disk so edits to frontmatter
  // (model, description, tools) take effect without restarting the app.
  // Mirror /api/agents/enabled's resolution — project dir (if any) + user dir.
  //
  // We read BOTH sources of truth (MCP from config.json + agents from .md files)
  // before mutating any in-memory state, so a scan failure doesn't leave the
  // caller with a half-applied reload (MCP pushed but agents stale).
  const home = getHomeDirOrNull();
  const userAgentsBaseDir = home ? join(home, '.myagents', 'agents') : '';
  const projAgentsDir = effectiveWorkspace ? join(effectiveWorkspace, '.claude', 'agents') : '';
  let agents: ReturnType<typeof loadEnabledAgents>;
  try {
    agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin-api] handleReload: sub-agent re-scan failed:', err);
    return {
      success: false,
      error: `Failed to reload sub-agents from disk: ${msg}`,
    };
  }

  // Both sources loaded cleanly — now commit the in-memory state atomically
  // (well, as atomically as two module-level setters allow) and trigger the
  // forced restart that applies them.
  setMcpServers(effectiveServers);
  setAgents(agents);
  const agentCount = Object.keys(agents).length;

  // Force a session restart even for snapshotted (Tab / Cron / Background)
  // sessions — reload is an explicit request, not noise from React state
  // sync. Without this the in-memory config is refreshed but the running
  // SDK subprocess keeps delegating to the old sub-agent definitions (#98).
  forceReloadActiveSession('agents');

  broadcast('config:changed', { section: 'all', action: 'reload' });
  return {
    success: true,
    hint: `Configuration reloaded (MCP: ${effectiveServers.length}, sub-agents: ${agentCount}). The session will restart on the next turn to apply changes.`,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

// Build the runtime enum line from the single source of truth (VALID_RUNTIMES).
// This prevents silent drift between docs and validator — if a runtime is
// added to the RuntimeType union, `--help` picks it up automatically.
const RUNTIMES_ENUM_LINE = VALID_RUNTIMES.join(' | ');

const HELP_TEXTS: Record<string, string> = {
  mcp: `myagents mcp — Manage MCP tool servers

Commands:
  list                     List all MCP servers
  show <id>                Show one MCP server's config + enable state (env/headers redacted)
  add                      Add a new MCP server
  remove <id>              Remove a custom MCP server
  enable <id>              Enable an MCP server
  disable <id>             Disable an MCP server
  test <id>                Validate MCP server connectivity
  env <id> <action>        Manage environment variables
  oauth <action> <id>      Manage OAuth for HTTP/SSE servers

Options for 'add':
  --id          Server ID (required)
  --name        Display name (defaults to id)
  --type        stdio | sse | http (default: stdio)
  --command     Command to run (for stdio)
  --args        Arguments (repeatable)
  --url         Endpoint URL (for sse/http)
  --env         KEY=VALUE (repeatable)
  --headers     KEY=VALUE (repeatable, for sse/http)

Options for 'enable' / 'disable':
  --scope       global | project | both (default: both)

Options for 'env':
  set KEY=VALUE [KEY2=VALUE2 ...]
  get
  delete KEY [KEY2 ...]

OAuth subcommands:
  oauth discover <id>      Probe server for OAuth requirements
  oauth start <id>         Start OAuth authorization (opens browser)
  oauth status <id>        Check OAuth status
  oauth revoke <id>        Revoke stored OAuth token

Options for 'oauth start' (manual mode):
  --client-id      OAuth client ID (skip for auto mode)
  --client-secret  OAuth client secret
  --scopes         Scopes (comma or space separated)
  --callback-port  Local callback port`,

  model: `myagents model — Manage model providers

Commands:
  list                     List all providers (preset + custom)
  add                      Add a custom provider
  remove <id>              Remove a custom provider
  set-key <id> <api-key>   Set API key for a provider
  verify <id> [--model m]  Verify API key (sends a test message)
  set-default <id>         Set default provider

Options for 'add':
  --id            Provider ID (required)
  --name          Display name (required)
  --base-url      API endpoint URL (required)
  --models        Model IDs (repeatable, at least one)
  --model-names   Display names for models (repeatable)
  --primary-model Default model (default: first in --models)
  --auth-type     auth_token | api_key | both (default: auth_token)
  --protocol      anthropic | openai (default: anthropic)
  --upstream-format  chat_completions | responses (openai only)
  --max-output-tokens  Max output limit (openai only)
  --aliases       SDK alias mapping: sonnet=model,opus=model,haiku=model
  --vendor        Vendor name
  --website-url   Provider website`,

  config: `myagents config — Read/write application config

Commands:
  get <key>               Read a config value
  set <key> <value>       Set a config value`,

  cron: `myagents cron — Manage scheduled tasks

Commands:
  list                     List all cron tasks
  add                      Create a new cron task
  start <id>               Start a stopped task
  stop <id>                Stop a running task
  remove <id>              Delete a task
  update <id>              Update task fields
  runs <id>                View execution history
  status                   Show cron task summary

Options for 'add':
  --name         Task name
  --prompt       AI prompt (required; alias: --message)
  --prompt-file  Read prompt body from a file (preferred for multi-line /
                 quoted / backtick content; max 1 MB)
  --schedule     Either a cron expression (e.g. "*/30 * * * *") OR a JSON
                 CronSchedule object:
                   '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
                   '{"kind":"every","minutes":30}'
                   '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
                   '{"kind":"loop"}'
                 Non-JSON input is treated as a cron expression.
  --every        Interval in minutes (alternative to --schedule)
  --workspace    Workspace path (required)

Options for 'update' <id>:
  Same flags as add (plus --model, --permissionMode). --message is also
  accepted as an alias for --prompt here.

See 'myagents cron readme' for long-form usage + exit-from-task flow.`,

  plugin: `myagents plugin — Manage OpenClaw channel plugins

Commands:
  list                     List installed plugins
  install <npm-spec>       Install a plugin from npm
  remove <plugin-id>       Uninstall a plugin`,

  runtime: `myagents runtime — Inspect Agent Runtimes (v0.1.69+)

Commands:
  list                            List all known runtimes + install status
  describe <runtime>              Show models + permission modes for a runtime

Valid runtimes: ${RUNTIMES_ENUM_LINE}

Examples:
  myagents runtime list                       # which runtimes are installed?
  myagents runtime list --json
  myagents runtime describe codex             # models + permission modes for codex
  myagents runtime describe gemini --json

Why this exists:
  'runtime describe' is the command to consult BEFORE choosing values for
  'task create-direct --runtime / --model / --permissionMode'. The help text
  for those flags intentionally does NOT list models or modes — values depend
  on which CLI you have installed and are dynamic. Use this command instead.`,

  task: `myagents task — Manage Task Center tasks (v0.1.69+)

Commands:
  list                            List tasks (filter via --workspaceId / --status / --tag)
  get <taskId>                    Task metadata + .task/ doc paths
  create-direct <name>            Create a task with inline task.md content
  create-from-alignment <sid>     Materialize a task from an alignment session
  update-status <taskId> <status> Transition state (running/verifying/done/blocked/stopped)
  append-session <taskId> <sid>   Link an SDK session id to a task
  run <taskId>                    Dispatch a todo task for execution
  rerun <taskId>                  Reset to 'todo' and dispatch
  archive <taskId>                Soft-archive (with 30d retention)
  delete <taskId>                 Hard delete

Options for 'create-direct':
  --name               Task name (required; may also be the 1st positional)
  --executor           'agent' | 'user' (default: agent)
  --description        Short description
  --workspaceId        Workspace id (required)
  --workspacePath      Absolute workspace path (required)
  --taskMdFile <path>  Read task.md body from a file (preferred for multi-line
                       markdown — avoids shell-escape hell). Max 1 MB.
  --taskMdContent      Inline task.md body (use --taskMdFile instead when
                       content spans multiple lines / has backticks / quotes).
                       Exactly one of --taskMdFile / --taskMdContent must be set.
  --executionMode      'once' | 'scheduled' | 'recurring' | 'loop' (default: once)
  --runMode            'single-session' | 'new-session'
  --tags               Comma-separated tag list
  --sourceThoughtId    Link back to the originating thought

Per-task RUNTIME overrides (all optional; omit to inherit workspace defaults):
  --runtime            Override runtime (${RUNTIMES_ENUM_LINE})
                       See: myagents runtime list
  --model              Override model — values depend on runtime
                       See: myagents runtime describe <runtime>
  --permissionMode     Override permission mode — values depend on runtime
                       See: myagents runtime describe <runtime>
  --runtimeConfig      JSON string for runtime-specific extra config

Options for 'create-from-alignment' (identical override flags):
  Positional: <alignmentSessionId>
  --name               Task name (required)
  --executor --description --workspaceId --workspacePath
  --executionMode --runMode --tags --sourceThoughtId
  --runtime --model --permissionMode --runtimeConfig   (per-task overrides)

Options for 'update-status':
  Positional: <taskId> <status>
  --message            Optional message attached to the transition

Output:
  - Default (human-readable) mode prints a compact summary + any override echo.
  - --json returns the full structured payload (task id, overrides, overridden[],
    inheritedFromWorkspace[], nextSteps.{dispatch,inspect}).

Examples:
  myagents task list --workspaceId my-proj
  myagents task create-direct --name "review PR" \\
      --workspaceId my-proj --workspacePath /path/to/my-proj \\
      --taskMdContent "Review the latest PR and file findings in progress.md" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
  myagents task create-from-alignment sess_abc --name "Ship feature X" --runtime claude-code
  myagents task run t_abc123
  myagents task update-status t_abc123 done --message "shipped in v0.1.70"

Related:
  myagents agent show <id>          Inspect an agent's effective defaults first,
                                    so you know what you are overriding.`,

  agent: `myagents agent — Manage agents & channels

Commands:
  list                            List all agents
  show <id>                       Show an agent's effective runtime/model/permissionMode defaults
  enable <id>                     Enable an agent
  disable <id>                    Disable an agent
  set <id> <key> <value>          Set agent config field
  runtime-status                  Runtime drift status across agents
  channel list <agent-id>         List channels
  channel add <agent-id>          Add a channel
  channel remove <a-id> <ch-id>   Remove a channel

Options for 'channel add':
  --type        telegram | feishu | dingtalk (required)
  --token       Bot token (for telegram)
  --app-id      App ID (for feishu/dingtalk)
  --app-secret  App Secret (for feishu/dingtalk)

Typical flow (AI preparing a task override):
  1. myagents agent show <id>          — learn current defaults
  2. myagents runtime describe <rt>    — see valid model + permission values
  3. myagents task create-direct ... --runtime <rt> --model <m>`,
};

export function handleHelp(payload: { path?: string[] }): AdminResponse {
  const path = payload.path ?? [];
  const group = path[0];

  if (group && HELP_TEXTS[group]) {
    return { success: true, data: { text: HELP_TEXTS[group] } };
  }

  return {
    success: true,
    data: {
      text: `Available command groups: mcp, model, agent, config, cron, plugin, status, reload
Use "myagents <group> --help" for details on a specific group.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export function handleVersion(): AdminResponse {
  // npm_package_version is set by npm/bun when launched via npm scripts;
  // MYAGENTS_VERSION can be injected by the build system as a fallback.
  const version = process.env.npm_package_version
    ?? process.env.MYAGENTS_VERSION
    ?? '0.1.70';
  return { success: true, data: { version } };
}

// ---------------------------------------------------------------------------
// Cron Task forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handleCronList(payload: { workspacePath?: string }): Promise<AdminResponse> {
  const qs = payload.workspacePath ? `?workspacePath=${encodeURIComponent(payload.workspacePath)}` : '';
  const resp = await managementApi(`/api/cron/list${qs}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).tasks ?? [] };
  }
  return mgmtError(resp, 'Failed to list cron tasks');
}

export async function handleCronCreate(payload: Record<string, unknown>): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/create', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStop(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/stop', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStart(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/run', 'POST', payload);
  return wrapMgmtResponse(resp);
}

/// PRD 0.2.5 R4 — fire one immediate execution without changing schedule.
/// Returns { taskId, sessionId, dispatchedAt } on success; { error, code } on
/// conflict (task currently executing).
export async function handleCronRunNow(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/trigger', 'POST', payload);
  if (resp.ok) {
    return {
      success: true,
      data: {
        taskId: (resp as Record<string, unknown>).taskId,
        sessionId: (resp as Record<string, unknown>).sessionId,
        dispatchedAt: (resp as Record<string, unknown>).dispatchedAt,
      },
    };
  }
  return mgmtError(resp, 'Failed to trigger cron');
}

export async function handleCronDelete(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/delete', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronUpdate(payload: { taskId: string; patch: Record<string, unknown> }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/update', 'POST', payload);
  if (resp.ok) {
    // Issue #115 — surface the post-update task summary so CLI can echo
    // `nextExecutionAt` (computed with tz) right after `✓ update`. Avoids
    // the "I just changed schedule, why does the next run show +1h" UX
    // confusion that strict-after-now causes when the user re-checks
    // later via `cron list`.
    return { success: true, data: (resp as Record<string, unknown>).task ?? null };
  }
  return mgmtError(resp, 'Failed to update cron task');
}

export async function handleCronRuns(payload: { taskId: string; limit?: number }): Promise<AdminResponse> {
  const qs = `?taskId=${encodeURIComponent(payload.taskId)}${payload.limit ? `&limit=${payload.limit}` : ''}`;
  const resp = await managementApi(`/api/cron/runs${qs}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).runs ?? [] };
  }
  return mgmtError(resp, 'Failed to get cron runs');
}

export async function handleCronStatus(payload: { workspacePath?: string }): Promise<AdminResponse> {
  const qs = payload.workspacePath ? `?workspacePath=${encodeURIComponent(payload.workspacePath)}` : '';
  const resp = await managementApi(`/api/cron/status${qs}`);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Task Center forwarding (v0.1.69)
//
// Trust-boundary note: the CLI stamps `actor` + `source` from its own env
// (AI subprocess = agent/cli, user terminal = user/cli) BEFORE posting here.
// We forward these fields verbatim to the Rust Management API. The renderer-
// originated path (Tauri IPC) never reaches this module — it goes through
// `cmd_task_update_status` in Rust which stamps `user/ui` authoritatively.
// ---------------------------------------------------------------------------

function qsFrom(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function handleTaskList(payload: {
  workspaceId?: string;
  status?: string;
  tag?: string;
  includeDeleted?: boolean;
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/task/list${qsFrom(payload)}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).tasks ?? [] };
  }
  return mgmtError(resp, 'Failed to list tasks');
}

export async function handleTaskGet(payload: { id: string }): Promise<AdminResponse> {
  const resp = await managementApi(`/api/task/get${qsFrom({ id: payload.id })}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).task };
  }
  return mgmtError(resp, 'Failed to get task');
}

export async function handleTaskCreateDirect(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const validationError = await validateTaskOverrides(payload);
  if (validationError) return validationError;

  const overridden = computeOverriddenFields(payload);
  const resp = await managementApi('/api/task/create-direct', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, payload, overridden);
  if (enriched.success) {
    trackServer('task_create', {
      source: cliSource(),
      origin: 'manual',
      has_workspace: typeof payload.workspacePath === 'string' && payload.workspacePath.length > 0,
    });
  }
  return enriched;
}

export async function handleTaskCreateFromAlignment(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const validationError = await validateTaskOverrides(payload);
  if (validationError) return validationError;

  const overridden = computeOverriddenFields(payload);
  const resp = await managementApi('/api/task/create-from-alignment', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, payload, overridden);
  if (enriched.success) {
    trackServer('task_create', {
      source: cliSource(),
      origin: 'thought_dispatch',
      has_workspace: typeof payload.workspacePath === 'string' && payload.workspacePath.length > 0,
    });
  }
  return enriched;
}

/**
 * Read the task's `sessionIds.length` from Rust before kicking off a run.
 * Returns `null` if the read fails — analytics call sites then fall back to
 * `null` for `run_count` so we don't fabricate a count. Best-effort: a
 * failed pre-fetch does NOT abort the run itself.
 */
async function fetchTaskSessionCount(id: string): Promise<number | null> {
  try {
    const resp = await managementApi(`/api/task/get${qsFrom({ id })}`);
    if (!resp.ok) return null;
    const task = (resp as Record<string, unknown>).task as Record<string, unknown> | undefined;
    const sessions = task?.sessionIds;
    return Array.isArray(sessions) ? sessions.length : null;
  } catch {
    return null;
  }
}

export async function handleTaskRun(payload: { id: string }): Promise<AdminResponse> {
  // Fetch run count BEFORE the run so the analytics value matches the GUI's
  // `task.sessionIds.length + 1` semantic (i.e. "if this run succeeds, it'll
  // be the Nth"). Doing it after would over-count by 1 since the run
  // appends a new sessionId.
  const priorCount = await fetchTaskSessionCount(payload.id);
  const resp = await managementApi('/api/task/run', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_run', {
      source: cliSource(),
      run_count: priorCount !== null ? priorCount + 1 : null,
    });
  }
  return wrapped;
}

export async function handleTaskRerun(payload: { id: string }): Promise<AdminResponse> {
  const priorCount = await fetchTaskSessionCount(payload.id);
  const resp = await managementApi('/api/task/rerun', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_run', {
      source: cliSource(),
      run_count: priorCount !== null ? priorCount + 1 : null,
    });
  }
  return wrapped;
}

/**
 * Enrich a successful task-create response with:
 *   - the override values **as actually persisted** (read from the returned
 *     Task record, not echoed from the request — this proves the round-trip
 *     survived serde rather than just restating what the client sent);
 *   - `overridden` — the list of override fields the caller supplied that
 *     also show up on the persisted task (so "requested but dropped" is
 *     visible as a mismatch);
 *   - `nextSteps` — the next CLI commands the caller is most likely to run.
 *
 * No-op on failed responses (leaves the existing error / recoveryHint shape
 * untouched).
 */
function enrichTaskCreateResponse(
  response: AdminResponse,
  payload: Record<string, unknown>,
  requestedOverrides: string[],
): AdminResponse {
  if (!response.success) return response;
  const existing = (response.data ?? {}) as Record<string, unknown>;
  // Rust returns `{ task: {...} }` for task creation — unwrap so we can read
  // the authoritative persisted values.
  const persistedTask =
    (existing.task as Record<string, unknown> | undefined)
    ?? existing; // fallback for older Rust shapes that returned the task inline
  const taskId =
    typeof persistedTask.id === 'string'
      ? persistedTask.id
      : typeof existing.task_id === 'string'
        ? existing.task_id
        : typeof existing.taskId === 'string'
          ? existing.taskId
          : undefined;

  // Read the overrides from the persisted Task, NOT from the request payload.
  // If serde dropped a field (e.g., prior to v0.1.69 when `TaskCreateFromAlignmentInput`
  // lacked model/permission_mode), we want the mismatch to be visible here.
  const persistedOverrides = {
    runtime: (persistedTask.runtime as string | undefined) ?? null,
    model: (persistedTask.model as string | undefined) ?? null,
    permissionMode: (persistedTask.permissionMode as string | undefined) ?? null,
    runtimeConfig: persistedTask.runtimeConfig ?? null,
  };

  // The authoritative "overridden" list: fields the caller requested AND that
  // actually landed on the persisted task. If the two diverge, the extra
  // `overridesRequested` field (below) lets the caller detect the drop.
  const fieldsWithValue = Object.entries(persistedOverrides)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k]) => k);

  const enriched: Record<string, unknown> = {
    ...existing,
    overrides: persistedOverrides,
    overridden: fieldsWithValue,
    // If the client requested an override that didn't land, this exposes the
    // drift (a diff between these two arrays means "server silently dropped
    // a field you sent").
    overridesRequested: requestedOverrides,
    inheritedFromWorkspace:
      ['runtime', 'model', 'permissionMode'].filter(f => !fieldsWithValue.includes(f)),
  };
  if (taskId) {
    enriched.nextSteps = {
      dispatch: `myagents task run ${taskId}`,
      inspect: `myagents task get ${taskId}`,
    };
  }
  return { ...response, data: enriched };
}

export async function handleTaskUpdateStatus(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  // Infer actor/source if caller omitted them:
  //   Inside an AI subprocess → MYAGENTS_PORT is set → actor=agent, source=cli.
  //   Otherwise (user ran `myagents` in their terminal) → actor=user, source=cli.
  // `MYAGENTS_PORT` is injected by `buildClaudeSessionEnv()` into SDK subproc
  // env (see cli_architecture.md); the user's own shell does NOT have it set
  // (the user's CLI binary reads `~/.myagents/sidecar.port` instead).
  if (payload.actor === undefined) {
    payload.actor = process.env.MYAGENTS_PORT ? 'agent' : 'user';
  }
  if (payload.source === undefined) {
    payload.source = 'cli';
  }
  const resp = await managementApi('/api/task/update-status', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  // Only `stopped` counts as a "stop" event in analytics terms — other
  // status transitions (running/done/blocked/etc) flow through the same
  // endpoint but aren't user-initiated stops.
  if (wrapped.success && payload.status === 'stopped') {
    trackServer('task_stop', { source: cliSource() });
  }
  return wrapped;
}

export async function handleTaskAppendSession(payload: {
  id: string;
  sessionId: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/append-session', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskArchive(payload: {
  id: string;
  message?: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/archive', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskDelete(payload: { id: string }): Promise<AdminResponse> {
  // Fetch the task's status BEFORE the delete so we can report it in the
  // analytics event. Best-effort — if the read fails (e.g. id doesn't exist),
  // we still attempt the delete and just report `status: 'unknown'`. We
  // accept the extra round-trip because delete is a low-frequency action
  // and the status field is the most useful dimension for understanding
  // what users are pruning (orphan todos vs. completed work etc.).
  let status = 'unknown';
  try {
    const fetched = await managementApi(`/api/task/get${qsFrom({ id: payload.id })}`);
    if (fetched.ok) {
      const task = (fetched as Record<string, unknown>).task as
        | Record<string, unknown>
        | undefined;
      if (task && typeof task.status === 'string') {
        status = task.status;
      }
    }
  } catch {
    // Silent — analytics must not affect the main flow.
  }
  const resp = await managementApi('/api/task/delete', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_delete', { source: cliSource(), status });
  }
  return wrapped;
}

/**
 * Read a task's markdown doc (`task.md` / `verify.md` / `progress.md` /
 * `alignment.md`). Missing files return `{ ok: true, content: "" }` so
 * CLI scripting is idempotent. Task docs live under `~/.myagents/tasks/<id>/`
 * since v0.1.69 — this endpoint is the agent-facing read path because the
 * AI runs in the workspace cwd and can't know the user-profile dir.
 */
export async function handleTaskReadDoc(payload: {
  id: string;
  doc: string;
}): Promise<AdminResponse> {
  const resp = await managementApi(
    `/api/task/read-doc${qsFrom(payload)}`,
  );
  if (resp.ok) {
    return { success: true, data: { content: (resp as Record<string, unknown>).content ?? '' } };
  }
  return mgmtError(resp, 'Failed to read task doc');
}

/**
 * Write `task.md` or `verify.md`. `progress.md` is agent-appended during
 * runs and rejected here; `alignment.md` is written by the alignment
 * skill via direct file-system access (not through this API).
 */
export async function handleTaskWriteDoc(payload: {
  id: string;
  doc: string;
  content: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/write-doc', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleThoughtList(payload: {
  tag?: string;
  query?: string;
  limit?: number;
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/thought/list${qsFrom(payload)}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).thoughts ?? [] };
  }
  return mgmtError(resp, 'Failed to list thoughts');
}

export async function handleThoughtCreate(payload: {
  content: string;
  images?: string[];
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/thought/create', 'POST', payload);
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    // No `location` for CLI — the field is GUI-specific (launcher vs
    // task_center surface). Set to null so the column type stays uniform.
    trackServer('thought_create', { source: cliSource(), location: null });
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Session-scoped capabilities for external runtimes (v0.1.67)
//
// These handlers expose Pattern 1 (context-injected) MCP tools to the `myagents`
// CLI so the AI running on external runtimes (Claude Code / Codex / Gemini CLI)
// can reach MyAgents-specific capabilities through plain shell tool calls
// instead of a Claude-Agent-SDK-only MCP protocol. See prd_0.1.67.
//
// Authorization model: Sidecar is session-scoped (1 Sidecar = 1 session), so
// the ambient session context (cron context / im-media context) is already
// correctly bound to the calling Sidecar — no MYAGENTS_SESSION_ID plumbing.
// ---------------------------------------------------------------------------

export function handleCronExit(payload: { reason?: string }): AdminResponse {
  const ctx = getCronTaskContext();
  if (!ctx.taskId) {
    return { success: false, error: 'No active cron task in this session. This command only works inside a cron task run.' };
  }
  if (!ctx.canExit) {
    return { success: false, error: 'This cron task has "Allow AI to exit" disabled — only the user can stop it from the UI.' };
  }
  const reason = payload.reason?.trim() || 'AI requested task exit';
  broadcast('cron:task-exit-requested', {
    taskId: ctx.taskId,
    reason,
    timestamp: new Date().toISOString(),
  });
  return {
    success: true,
    data: { taskId: ctx.taskId, reason },
    hint: `${CRON_TASK_EXIT_TEXT}. Reason: ${reason}`,
  };
}

export async function handleImSendMedia(payload: { filePath?: string; caption?: string }): Promise<AdminResponse> {
  if (!payload.filePath) {
    return { success: false, error: 'Missing required field: --file <absolute-path>' };
  }
  const ctx = getImMediaContext();
  if (!ctx) {
    return { success: false, error: 'No IM context in this session. This command only works inside an IM Bot / Agent Channel session.' };
  }
  // Path traversal guard: prompt-injected AI on an external runtime could be
  // steered into `myagents im send-media --file ~/.ssh/id_rsa` and exfiltrate
  // secrets to the chat peer. assertSafeFilePath canonicalises (dereferencing
  // symlinks) and requires the real path to live under workspace / tmp / the
  // myagents scratch dir. Any other location is rejected with a clear error.
  const { agentDir } = getAgentState();
  let safePath: string;
  try {
    safePath = assertSafeFilePath(payload.filePath, { workspacePath: agentDir });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const resp = await managementApi('/api/im/send-media', 'POST', {
    botId: ctx.botId,
    chatId: ctx.chatId,
    platform: ctx.platform,
    filePath: safePath,
    caption: payload.caption,
  });
  if (resp.ok) {
    return {
      success: true,
      data: {
        fileName: (resp as Record<string, unknown>).fileName,
        fileSize: (resp as Record<string, unknown>).fileSize,
      },
      hint: 'File sent to IM chat.',
    };
  }
  return mgmtError(resp, 'Failed to send media');
}

// ---------------------------------------------------------------------------
// Tool readme lookups — progressive disclosure (v0.1.67)
//
// Skill layer pre-injects BRIEF descriptions of these tools into the system
// prompt (system-prompt-cli-tools.ts). When the AI actually needs to use one,
// it calls `myagents X readme` to pull the full usage doc on demand.
// ---------------------------------------------------------------------------

const README_CRON = `myagents cron — Scheduled task management

WHAT
  Create, list, inspect, stop, and delete scheduled AI tasks (cron / interval /
  one-shot). Tasks run inside MyAgents regardless of which runtime the current
  chat uses. A task can deliver results to an IM channel.

COMMANDS
  list                            List tasks in the current workspace
  status                          Totals + next execution time
  add OPTIONS                     Create a new task
  start <taskId>                  Enable scheduled task (resume from stopped).
                                  Does NOT trigger immediate execution — use
                                  'cron run-now <taskId>' for that.
  run-now <taskId>                Fire one execution immediately without
                                  changing the task's schedule or status.
  stop <taskId>                   Pause a running task
  remove <taskId>                 Delete a task
  update <taskId> OPTIONS         Change name / prompt / schedule
  runs <taskId> [--limit N]       Show recent execution records (output
                                  truncated to 80 chars per row; pass --full
                                  for untruncated output)

STATUS VOCABULARY (in 'list' / 'status' output and --json)
  Two ORTHOGONAL concepts. Don't confuse them.

  status field — the persistent scheduler state:
    Running    Scheduler is enabled. The task fires at its next scheduled
               time (see the 'Next' column). NOT the same as "currently
               executing" — see currentlyExecuting below.
    Stopped    Scheduler is disabled. The task never fires while in this
               state, even when the schedule expression matches. Resume
               with 'cron start <taskId>'.

  currentlyExecuting field (--json) / '*' marker after the ID (plain text):
    A tick is firing this very instant — either a scheduled fire or a
    'cron run-now' invocation. Calling 'cron run-now' on a task whose
    marker is showing returns a busy error.

  status=Running  +  no '*' marker     →  scheduled, not firing right now
  status=Running  +  '*' marker        →  scheduled AND firing this instant
  status=Stopped  +  no '*' marker     →  disabled, not firing
  status=Stopped  +  '*' marker        →  rare; a scheduled tick was already
                                          in flight when the task got stopped

CREATE OPTIONS (myagents cron add ...)
  --name <text>                   Human-readable label (optional)
  --prompt <text>                 The prompt the AI runs each tick. For short
                                  prompts use this. For multi-line / complex
                                  prompts, prefer --prompt-file.
                                  (Alias: --message.)
  --prompt-file <path>            Read prompt body from a file (recommended for
                                  anything longer than ~80 chars — avoids shell
                                  escape issues with quotes, newlines, \`\`\`).
  --every <minutes>               Run every N minutes (min 5)
  --schedule <expr|json>          Either a cron expression, e.g. "0 9 * * *",
                                  OR a JSON CronSchedule object:
                                    '{"kind":"at","at":"2026-04-23T09:10+08:00"}'
                                    '{"kind":"every","minutes":30}'
                                    '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
                                    '{"kind":"loop"}'
                                  Non-JSON values are treated as cron expressions.
  --workspace <path>              Workspace the task runs in. Defaults to the
                                  current session workspace.

UPDATE OPTIONS (myagents cron update <taskId> ...)
  --name / --prompt / --message / --schedule / --every / --model / --permissionMode
  (Same semantics as create. --message is an alias for --prompt.)

EXAMPLES
  # Short prompt, 30 min interval
  myagents cron add --name ping --prompt "ping example.com, report latency" --every 30

  # Long prompt from file (the recommended path)
  printf '%s\\n' 'Check the build log for new errors.' \\
    'If errors found, summarize and tag me.' > /tmp/cron-check.txt
  myagents cron add --name build-watch --prompt-file /tmp/cron-check.txt --every 15

  # Look at recent runs
  myagents cron list
  myagents cron runs <taskId> --limit 5

EXIT FROM INSIDE A TASK (cron scenario only)
  If you are currently running as a cron task AND the task creator enabled
  "Allow AI to exit", call:
    myagents cron exit --reason "goal achieved"
  to mark the task complete and stop future executions.

DO NOT
  Use system cron / crontab / at / launchctl — they can't see MyAgents state.
  Only \`myagents cron\` can create tasks inside MyAgents.`;

const README_IM = `myagents im — IM Bot capabilities

WHAT
  Commands that act on the current IM chat (Telegram / Feishu / DingTalk /
  OpenClaw plugin channels). Only work inside an IM Bot session or
  Agent Channel session; in desktop sessions they return an error.

COMMANDS
  send-media --file <path> [--caption <text>]
      Send a file to the current chat. Images (jpg/png/gif/webp/svg — max
      10 MB) are sent as native photos; everything else (pdf/doc/xls/csv/json/
      audio/video/archives) as a file upload (max 50 MB).
      Write the file first using normal file-writing tools, then call this
      with the absolute path. Use for things the user explicitly wants to
      receive — not for intermediate work files.

EXAMPLES
  # Generate a CSV and send it
  myagents im send-media --file /tmp/report.csv --caption "Today's numbers"

  # Send a generated chart image
  myagents im send-media --file /tmp/chart.png`;

const README_WIDGET = `myagents widget — Generative UI widget design guidelines

WHAT
  Returns the MyAgents widget design system (color palette, component specs,
  layout rules) and the output format you MUST use to embed an interactive
  widget in a chat reply. Widgets render inline in the conversation — charts,
  SVG diagrams, interactive explainers, dashboards.

WHEN TO CALL
  Before outputting your first <generative-ui-widget> tag in a desktop chat
  response, when the user asks to visualize / chart / draw / build an
  interactive explainer. Skip it for simple text answers, code snippets, and
  static markdown tables.

WHEN NOT TO CALL
  - User explicitly asks for plain text / code / markdown
  - IM bot sessions (widgets only render in the desktop client)
  - Simple answers that don't benefit from visual layout

COMMAND
  myagents widget readme <module1> [<module2> ...]

MODULES
  chart         Chart.js line/bar/pie patterns, palette hex values, dashboards
  diagram       SVG flowcharts, architecture diagrams, connectors, markers
  interactive   Sliders, calculators, comparison cards, data records
  dashboard     Combines chart + interactive (multi-chart layouts + controls)
  art           SVG illustration / visual metaphor

EXAMPLES
  myagents widget readme chart
  myagents widget readme chart interactive
  myagents widget readme dashboard

The output begins with the required <generative-ui-widget> output format
contract; do not skip reading it.`;

export function handleReadme(payload: { topic?: string; modules?: string[] }): AdminResponse {
  const topic = (payload.topic ?? '').toLowerCase();
  if (topic === 'cron') {
    return { success: true, data: { text: README_CRON } };
  }
  if (topic === 'im' || topic === 'im-media' || topic === 'media') {
    return { success: true, data: { text: README_IM } };
  }
  if (topic === 'widget' || topic === 'generative-ui' || topic === 'ui') {
    const modules = (payload.modules ?? []).filter(m => typeof m === 'string' && m.length > 0);
    if (modules.length === 0) {
      // No modules passed → return the meta-readme describing modules
      return { success: true, data: { text: README_WIDGET } };
    }
    const text = buildReadMeContent(modules);
    // buildReadMeContent returns a generic "Unknown module(s). Available: ..."
    // sentinel when it can't resolve any of the given modules. Surface that as
    // a failure so the CLI exits non-zero and the AI gets a clear error.
    if (text.startsWith('Unknown module(s)')) {
      return { success: false, error: text };
    }
    return { success: true, data: { text } };
  }
  return {
    success: false,
    error: `Unknown readme topic "${payload.topic}". Available: cron, im, widget.`,
  };
}

// ---------------------------------------------------------------------------
// Plugin forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handlePluginList(): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/list');
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).plugins ?? [] };
  }
  return mgmtError(resp, 'Failed to list plugins');
}

export async function handlePluginInstall(payload: { npmSpec: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/install', 'POST', payload);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).plugin, hint: 'Plugin installed successfully.' };
  }
  return mgmtError(resp, 'Failed to install plugin');
}

export async function handlePluginUninstall(payload: { pluginId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/uninstall', 'POST', payload);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Skill handlers (thin wrappers over /api/skill/* self-loopback)
// ---------------------------------------------------------------------------

export async function handleSkillList(): Promise<AdminResponse> {
  const { json } = await sidecarSelf('/api/skills?scope=all');
  if (json.success) {
    return { success: true, data: json.skills ?? [] };
  }
  return { success: false, error: String(json.error ?? 'Failed to list skills') };
}

export async function handleSkillInfo(payload: { name: string; scope?: 'user' | 'project' }): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const scope = payload.scope ?? 'user';
  const { json } = await sidecarSelf(`/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`);
  if (json.success) {
    return { success: true, data: json.skill ?? null };
  }
  return { success: false, error: String(json.error ?? 'Skill not found') };
}

export async function handleSkillAdd(payload: {
  url: string;
  scope?: 'user' | 'project';
  plugin?: string;
  skill?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  if (!payload.url) return { success: false, error: 'url is required' };

  // Step 1: probe (no confirmedSelection) to learn the mode
  const scope = payload.scope ?? 'user';
  const probe = await sidecarSelf('/api/skill/install-from-url', 'POST', {
    url: payload.url,
    scope,
  });
  if (!probe.json.success) {
    return { success: false, error: String(probe.json.error ?? 'Install probe failed') };
  }

  const mode = probe.json.mode as string | undefined;

  // Already auto-installed (single, no conflict)
  if (mode === 'installed') {
    if (payload.dryRun) return { success: true, data: probe.json, hint: '[dry-run] would install the above' };
    return {
      success: true,
      data: probe.json,
      hint: `Installed ${(probe.json.installed as unknown[] | undefined)?.length ?? 0} skill(s)`,
    };
  }

  // Marketplace — require --plugin, install all skills in that plugin
  if (mode === 'marketplace') {
    const preview = probe.json.preview as {
      plugins: Array<{
        name: string;
        description: string;
        skills: Array<{ suggestedFolderName: string; name: string; conflict?: boolean }>;
      }>;
    };
    if (!payload.plugin) {
      return {
        success: false,
        error: '该仓库是 Claude Plugins 市场，请用 --plugin <name> 指定要安装的 plugin 合集',
        data: { availablePlugins: preview.plugins.map(p => ({ name: p.name, description: p.description, skillCount: p.skills.length })) },
      };
    }
    const plugin = preview.plugins.find(p => p.name === payload.plugin);
    if (!plugin) {
      return { success: false, error: `plugin "${payload.plugin}" 不存在` };
    }
    const conflicts = plugin.skills.filter(s => s.conflict).map(s => s.suggestedFolderName);
    if (conflicts.length > 0 && !payload.force) {
      return {
        success: false,
        error: `以下 skill 已存在：${conflicts.join(', ')}。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        hint: `[dry-run] would install ${plugin.skills.length} skill(s) from plugin "${plugin.name}"`,
        data: { plugin: plugin.name, skills: plugin.skills.map(s => s.suggestedFolderName) },
      };
    }
    const commit = await sidecarSelf('/api/skill/install-from-url', 'POST', {
      url: payload.url,
      scope,
      confirmedSelection: {
        pluginName: plugin.name,
        folderNames: plugin.skills.map(s => s.suggestedFolderName),
        overwrite: payload.force ? conflicts : [],
      },
    });
    if (!commit.json.success) {
      return { success: false, error: String(commit.json.error ?? 'Install failed') };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s) from ${plugin.name}`,
    };
  }

  // Multi — require --skill or install all
  if (mode === 'multi') {
    const preview = probe.json.preview as {
      candidates: Array<{ suggestedFolderName: string; name: string; conflict?: boolean }>;
    };
    let wanted = preview.candidates;
    if (payload.skill) {
      wanted = preview.candidates.filter(
        c => c.name === payload.skill || c.suggestedFolderName === payload.skill,
      );
      if (wanted.length === 0) {
        return {
          success: false,
          error: `未找到 skill "${payload.skill}"。可用：${preview.candidates.map(c => c.suggestedFolderName).join(', ')}`,
        };
      }
    }
    const conflicts = wanted.filter(c => c.conflict).map(c => c.suggestedFolderName);
    if (conflicts.length > 0 && !payload.force) {
      return { success: false, error: `已存在：${conflicts.join(', ')}。使用 --force 覆盖。` };
    }
    if (payload.dryRun) {
      return {
        success: true,
        hint: `[dry-run] would install ${wanted.length} skill(s)`,
        data: { skills: wanted.map(c => c.suggestedFolderName) },
      };
    }
    const commit = await sidecarSelf('/api/skill/install-from-url', 'POST', {
      url: payload.url,
      scope,
      confirmedSelection: {
        folderNames: wanted.map(c => c.suggestedFolderName),
        overwrite: payload.force ? conflicts : [],
      },
    });
    if (!commit.json.success) {
      return { success: false, error: String(commit.json.error ?? 'Install failed') };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s)`,
    };
  }

  // single-conflict — need --force to overwrite
  if (mode === 'single-conflict') {
    const preview = probe.json.preview as { skill: { suggestedFolderName: string; name: string } };
    if (!payload.force) {
      return {
        success: false,
        error: `技能 "${preview.skill.suggestedFolderName}" 已存在。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        hint: `[dry-run] would overwrite "${preview.skill.suggestedFolderName}"`,
      };
    }
    const commit = await sidecarSelf('/api/skill/install-from-url', 'POST', {
      url: payload.url,
      scope,
      confirmedSelection: {
        folderNames: [preview.skill.suggestedFolderName],
        overwrite: [preview.skill.suggestedFolderName],
      },
    });
    if (!commit.json.success) {
      return { success: false, error: String(commit.json.error ?? 'Install failed') };
    }
    return { success: true, data: commit.json, hint: `Overwrote "${preview.skill.suggestedFolderName}"` };
  }

  return { success: false, error: `未知的 install mode: ${mode}` };
}

export async function handleSkillRemove(payload: { name: string; scope?: 'user' | 'project' }): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const scope = payload.scope ?? 'user';
  const { json } = await sidecarSelf(
    `/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`,
    'DELETE',
  );
  if (json.success) return { success: true, data: { name: payload.name } };
  return { success: false, error: String(json.error ?? 'Failed to remove skill') };
}

export async function handleSkillToggle(payload: { name: string; enabled: boolean }): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const { json } = await sidecarSelf('/api/skill/toggle-enable', 'POST', {
    folderName: payload.name,
    enabled: payload.enabled,
  });
  if (json.success) return { success: true, data: { name: payload.name, enabled: payload.enabled } };
  return { success: false, error: String(json.error ?? 'Failed to toggle skill') };
}

export async function handleSkillSync(): Promise<AdminResponse> {
  const { json } = await sidecarSelf('/api/skill/sync-from-claude', 'POST', {});
  if (json.success) {
    return {
      success: true,
      data: { synced: json.synced ?? 0, failed: json.failed ?? 0 },
      hint: `Synced ${json.synced ?? 0} skill(s) from ~/.claude/skills`,
    };
  }
  return { success: false, error: String(json.error ?? 'Sync failed') };
}

// ---------------------------------------------------------------------------
// Agent runtime status forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handleAgentRuntimeStatus(): Promise<AdminResponse> {
  const resp = await managementApi('/api/agent/runtime-status');
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).agents ?? {} };
  }
  return mgmtError(resp, 'Failed to get agent runtime status');
}

// ---------------------------------------------------------------------------
// Runtime discovery handlers (v0.1.69+)
//
// Give AI agents (and humans) a way to answer "what am I allowed to pass to
// --runtime / --model / --permissionMode?" *before* they commit to creating
// a task. Without this, the only feedback loop is "task gets created, task
// fails at dispatch time" — the AI then has to unwind multiple async steps
// to figure out it filled the wrong value.
// ---------------------------------------------------------------------------

/** One row in `runtime list` output. */
interface RuntimeListRow {
  runtime: RuntimeType;
  displayName: string;
  installed: boolean;
  version?: string;
  path?: string;
  /** Present when `installed=false` — suggests the install/inspect command. */
  notInstalledHint?: string;
}

/** Payload for `runtime describe <runtime>`. */
interface RuntimeDescribeResult {
  runtime: RuntimeType;
  displayName: string;
  installed: boolean;
  version?: string;
  models: RuntimeModelInfo[];
  permissionModes: RuntimePermissionMode[];
  defaultPermissionMode: string;
}

/** Per-runtime detection timeout — a wedged `<cli> --version` binary shouldn't
 *  block the whole command. Race each detect() against this timeout. */
const RUNTIME_DETECT_TIMEOUT_MS = 2_000;

/**
 * Race a promise against a timeout; on timeout resolves to `fallback`.
 * Used by `handleRuntimeList` / `handleRuntimeDescribe` so one misbehaving
 * runtime CLI doesn't hang the whole Admin API request.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * List every runtime MyAgents knows about with its install status.
 *
 * Detection is best-effort and actually gated at `RUNTIME_DETECT_TIMEOUT_MS`
 * per runtime — each runtime's `detect()` spawns `<cli> --version`, and a
 * wedged binary would otherwise block the whole list. We *always* return the
 * full row list — even for not-installed runtimes — so the CLI reader sees
 * every valid `--runtime` value and can learn which ones need installing.
 */
export async function handleRuntimeList(): Promise<AdminResponse> {
  const rows: RuntimeListRow[] = [];
  for (const runtime of VALID_RUNTIMES) {
    if (runtime === 'builtin') {
      // builtin is always "installed" — it's the embedded Claude Agent SDK.
      rows.push({
        runtime,
        displayName: RUNTIME_DISPLAY_NAMES[runtime],
        installed: true,
      });
      continue;
    }
    let detection: RuntimeDetection = { installed: false };
    try {
      const rt = getExternalRuntime(runtime);
      detection = await raceWithTimeout(rt.detect(), RUNTIME_DETECT_TIMEOUT_MS, { installed: false });
    } catch {
      // Runtime not supported in this build (should not happen given
      // VALID_RUNTIMES ⊆ supported types, but keep defensive).
    }
    const row: RuntimeListRow = {
      runtime,
      displayName: RUNTIME_DISPLAY_NAMES[runtime],
      installed: detection.installed,
      version: detection.version,
      path: detection.path,
    };
    if (!detection.installed) {
      row.notInstalledHint = hintForMissingRuntime(runtime);
    }
    rows.push(row);
  }
  return { success: true, data: rows };
}

/**
 * Describe a single runtime — its installed state, available models, and
 * permission modes. This is the command the AI is supposed to consult
 * *before* choosing values for `--model` / `--permissionMode`.
 */
export async function handleRuntimeDescribe(payload: {
  runtime?: string;
}): Promise<AdminResponse> {
  const runtimeArg = payload.runtime;
  if (!runtimeArg) {
    return {
      success: false,
      error: 'Missing required argument: runtime',
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names.',
      },
    };
  }
  if (!isValidRuntimeType(runtimeArg)) {
    return {
      success: false,
      error: `Unknown runtime: '${runtimeArg}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names + install status.',
      },
    };
  }

  // builtin has no external CLI — models come from the configured provider,
  // not a spawnable CLI, so we intentionally return `models: []`. Permission
  // modes DO come from a static allowlist (PermissionMode enum) and are
  // surfaced so `runtime describe builtin` is as useful as `describe codex`.
  if (runtimeArg === 'builtin') {
    return {
      success: true,
      data: {
        runtime: runtimeArg,
        displayName: RUNTIME_DISPLAY_NAMES.builtin,
        installed: true,
        models: [],
        permissionModes: getRuntimePermissionModes('builtin'),
        defaultPermissionMode: getDefaultRuntimePermissionMode('builtin'),
        note:
          'Built-in runtime uses the configured provider + model from `myagents model list`. '
          + 'It does not have a runtime-specific model catalogue — override `--model` with any '
          + 'model id supported by the active provider.',
      } satisfies RuntimeDescribeResult & { note: string },
    };
  }

  let detection: RuntimeDetection = { installed: false };
  try {
    detection = await raceWithTimeout(
      getExternalRuntime(runtimeArg).detect(),
      RUNTIME_DETECT_TIMEOUT_MS,
      { installed: false },
    );
  } catch {
    /* detection returns installed:false below */
  }

  // Only query models when the CLI is actually installed — otherwise we'd
  // waste 10+ seconds trying to spawn a binary that doesn't exist.
  const models: RuntimeModelInfo[] = detection.installed
    ? ((await queryRuntimeModels(runtimeArg)) as RuntimeModelInfo[])
    : [];
  const permissionModes = getRuntimePermissionModes(runtimeArg);
  const defaultPermissionMode = getDefaultRuntimePermissionMode(runtimeArg);

  return {
    success: true,
    data: {
      runtime: runtimeArg,
      displayName: RUNTIME_DISPLAY_NAMES[runtimeArg],
      installed: detection.installed,
      version: detection.version,
      models,
      permissionModes,
      defaultPermissionMode,
    } satisfies RuntimeDescribeResult,
  };
}

/**
 * Show one agent's effective defaults so the AI can decide whether a given
 * task override is a no-op (same as workspace default) or meaningful.
 */
export function handleAgentShow(payload: { id?: string }): AdminResponse {
  const id = payload.id;
  if (!id) {
    return {
      success: false,
      error: 'Missing required argument: <agent-id>',
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === id);
  if (!agent) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }

  // AgentConfigSlim is intentionally permissive (`[key: string]: unknown`) —
  // runtime / permissionMode / runtimeConfig exist on the full AgentConfig
  // but not on the slim shape. Extract defensively.
  const runtime = (agent.runtime as RuntimeType | undefined) ?? 'builtin';
  const agentPermissionMode = (agent.permissionMode as string | undefined) ?? '';
  const runtimeConfig = (agent.runtimeConfig as Record<string, unknown> | undefined) ?? undefined;

  // Per-runtime resolution of "effective" model / permissionMode
  // (cross-review fix, v0.1.69):
  //   - builtin       → read from agent.{model, permissionMode}
  //   - CC/Codex/Gemini → prefer agent.runtimeConfig.{model, permissionMode};
  //     fall back to the top-level agent fields only when absent.
  //
  // External runtimes use distinct permission-mode vocabularies (`suggest`,
  // `auto-edit`, `full-auto`, etc.) that do NOT intersect with the builtin
  // enum. Reporting `agent.permissionMode = 'fullAgency'` as the effective
  // value for a Codex agent would be actively misleading — the dispatch
  // path never consults that field.
  const isExternal = runtime !== 'builtin';
  const rcModel = isExternal ? (runtimeConfig?.model as string | undefined) : undefined;
  const rcPermissionMode = isExternal
    ? (runtimeConfig?.permissionMode as string | undefined)
    : undefined;
  const effectiveModel = rcModel ?? (agent.model as string | undefined);
  const effectivePermissionMode = rcPermissionMode ?? agentPermissionMode;

  return {
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      workspacePath: agent.workspacePath,
      effectiveDefaults: {
        runtime,
        model: effectiveModel || null,
        permissionMode: effectivePermissionMode || null,
        providerId: agent.providerId ?? null,
        runtimeConfig: runtimeConfig ?? null,
      },
      channelCount: (agent.channels ?? []).length,
    },
  };
}

/** Type guard for `runtime` string coming from CLI payloads. */
function isValidRuntimeType(runtime: unknown): runtime is RuntimeType {
  return typeof runtime === 'string' && (VALID_RUNTIMES as readonly string[]).includes(runtime);
}

/** Install guidance keyed by runtime. Shown when a runtime is NOT installed. */
function hintForMissingRuntime(runtime: RuntimeType): string {
  switch (runtime) {
    case 'claude-code':
      return 'Install the Claude Code CLI — see https://docs.anthropic.com/claude/docs/claude-code';
    case 'codex':
      return 'Install the OpenAI Codex CLI — `npm i -g @openai/codex` or see https://github.com/openai/codex';
    case 'gemini':
      return 'Install the Gemini CLI — `npm i -g @google/gemini-cli` or see https://github.com/google/gemini-cli';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Task-creation pre-flight validation (v0.1.69+)
//
// Reject bad runtime/model/permissionMode overrides *here* in Node admin-api,
// before the payload hits Rust. Three reasons:
//   1. We have first-class access to `RuntimeFactory.detect()` / queryModels,
//      Rust does not.
//   2. Error strings here can cite the exact CLI recovery command — across
//      the Rust boundary those would turn into opaque serde errors.
//   3. The CLI is the primary caller; keeping validation adjacent to the CLI
//      glue means changes to flag semantics and error copy land in one file.
// ---------------------------------------------------------------------------

/** Fields on a task-create payload that we validate as overrides. */
interface TaskOverrideFields {
  runtime?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  /** Workspace path — used to resolve the agent's default runtime when the
   *  caller passes --model / --permissionMode *without* --runtime. */
  workspacePath?: unknown;
  /** Workspace id — alternative identifier for the same lookup as workspacePath. */
  workspaceId?: unknown;
}

/**
 * Validate the runtime/model/permissionMode fields on a task-create payload.
 * Returns an error `AdminResponse` on first failure, or `null` if all fields
 * are present-and-valid or absent.
 *
 * Effective-runtime resolution (cross-review fix, v0.1.69):
 *   - If `payload.runtime` is set → use it.
 *   - Else if `payload.model` / `payload.permissionMode` is set → resolve the
 *     agent's default runtime from `workspacePath` so we can still validate
 *     the model/mode against the correct allowlist. Without this step a
 *     caller like `--model o3` with no `--runtime` would silently bypass
 *     validation and ship a garbage payload to Rust.
 *   - Else → no overrides at all; nothing to validate.
 */
async function validateTaskOverrides(
  payload: TaskOverrideFields,
): Promise<AdminResponse | null> {
  // Step 1: resolve the effective runtime that downstream checks should use.
  let effectiveRuntime: RuntimeType | undefined;
  if (payload.runtime !== undefined && payload.runtime !== null && payload.runtime !== '') {
    if (typeof payload.runtime !== 'string' || !isValidRuntimeType(payload.runtime)) {
      return {
        success: false,
        error: `Invalid --runtime value: '${String(payload.runtime)}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
        recoveryHint: {
          recoveryCommand: 'myagents runtime list',
          message: 'See valid runtimes + install status.',
        },
      };
    }
    effectiveRuntime = payload.runtime;
    if (effectiveRuntime !== 'builtin' && isRuntimeSupported(effectiveRuntime)) {
      try {
        const detection = await getExternalRuntime(effectiveRuntime).detect();
        if (!detection.installed) {
          return {
            success: false,
            error: `Runtime '${effectiveRuntime}' is not installed on this machine.`,
            recoveryHint: {
              recoveryCommand: 'myagents runtime list',
              message: 'See which runtimes are available + install hints.',
            },
          };
        }
      } catch {
        return {
          success: false,
          error: `Runtime '${effectiveRuntime}' detection failed.`,
          recoveryHint: {
            recoveryCommand: 'myagents runtime list',
            message: 'See which runtimes are available.',
          },
        };
      }
    }
  } else if (
    (payload.model !== undefined && payload.model !== null && payload.model !== '')
    || (payload.permissionMode !== undefined && payload.permissionMode !== null && payload.permissionMode !== '')
  ) {
    // --model / --permissionMode passed without --runtime: try to resolve the
    // workspace's agent default so we can still validate against the correct
    // allowlist. If resolution fails, reject rather than silently trust.
    const resolved = resolveAgentRuntimeFromWorkspace(payload);
    if (resolved === undefined) {
      return {
        success: false,
        error:
          '--model / --permissionMode requires either an explicit --runtime, '
          + 'or a resolvable workspace (via --workspacePath / --workspaceId matching an agent).',
        recoveryHint: {
          recoveryCommand: 'myagents agent list',
          message: 'Find your agent, then `myagents agent show <id>` to see its default runtime.',
        },
      };
    }
    effectiveRuntime = resolved;
  } else {
    // No overrides at all — nothing to validate.
    return null;
  }

  // Step 2: permissionMode is validated against the runtime's allowlist.
  // Works for both builtin (BUILTIN_PERMISSION_MODES: auto/plan/fullAgency/custom)
  // and external runtimes (CC/Codex/Gemini) — since `getRuntimePermissionModes`
  // returns an exhaustive list for every runtime including builtin, we don't
  // need a separate builtin escape hatch. Previously builtin was skipped on
  // the assumption that Rust validates it, but Rust stores the field as
  // `Option<String>` with no enum constraint, so a typo like `--permissionMode
  // fulAgency` would land silently.
  if (
    payload.permissionMode !== undefined
    && payload.permissionMode !== null
    && payload.permissionMode !== ''
  ) {
    if (typeof payload.permissionMode !== 'string') {
      return {
        success: false,
        error: `--permissionMode must be a string (got ${typeof payload.permissionMode}).`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid permission modes.',
        },
      };
    }
    const modes = getRuntimePermissionModes(effectiveRuntime);
    if (modes.length > 0 && !modes.some(m => m.value === payload.permissionMode)) {
      return {
        success: false,
        error: `--permissionMode '${payload.permissionMode}' is not valid for runtime '${effectiveRuntime}'. Valid: ${modes.map(m => m.value).join(', ')}.`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid permission modes for this runtime.',
        },
      };
    }
  }

  // Step 3: model is validated for *external* runtimes that expose a known
  // model list. External CLI model lists can be dynamic (Gemini calls the
  // server to discover them) so an empty list is treated as "can't validate,
  // trust the caller". builtin runtime model ids depend on the active
  // provider — out of scope for this validator.
  if (
    payload.model !== undefined
    && payload.model !== null
    && payload.model !== ''
    && effectiveRuntime !== 'builtin'
  ) {
    if (typeof payload.model !== 'string') {
      return {
        success: false,
        error: `--model must be a string (got ${typeof payload.model}).`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid model ids for this runtime.',
        },
      };
    }
    try {
      const models = (await queryRuntimeModels(effectiveRuntime)) as RuntimeModelInfo[];
      // Empty list means either "runtime is not installed" (handled above)
      // or "discovery failed transiently" — in both cases, don't block the
      // write. The Rust side will surface the real dispatch error if any.
      if (models.length > 0 && !models.some(m => m.value === payload.model)) {
        const examples = models.slice(0, 5).map(m => m.value).filter(Boolean).join(', ');
        return {
          success: false,
          error: `--model '${payload.model}' is not available for runtime '${effectiveRuntime}'. Examples: ${examples || '(none found)'}.`,
          recoveryHint: {
            recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
            message: 'See the full model list.',
          },
        };
      }
    } catch {
      /* swallow — same "trust and forward" rationale as above */
    }
  }

  return null;
}

/**
 * Compute which override fields the caller actually provided.
 * Surfaced in the success response so the AI can confirm its intent took
 * effect (vs. silently falling back to the workspace default).
 */
function computeOverriddenFields(payload: Record<string, unknown>): string[] {
  const fields = ['runtime', 'model', 'permissionMode', 'runtimeConfig'];
  return fields.filter(f => {
    const v = payload[f];
    return v !== undefined && v !== null && v !== '';
  });
}

/**
 * Look up the workspace's agent from config and return the agent's default
 * runtime (falling back to 'builtin' when unset). Used by `validateTaskOverrides`
 * to decide which runtime's permission-mode / model allowlist to validate
 * against when the caller passes `--model` / `--permissionMode` without
 * `--runtime`.
 *
 * Returns `undefined` when neither `workspacePath` nor `workspaceId` matches
 * an agent — forces the validator to reject rather than guess.
 */
function resolveAgentRuntimeFromWorkspace(
  payload: { workspacePath?: unknown; workspaceId?: unknown },
): RuntimeType | undefined {
  const wsPath = typeof payload.workspacePath === 'string' ? payload.workspacePath : undefined;
  const wsId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
  if (!wsPath && !wsId) return undefined;

  const config = loadConfig();
  const agents = config.agents ?? [];
  // Match by workspacePath first (most specific), then by workspaceId.
  const agent =
    (wsPath && agents.find(a => a.workspacePath === wsPath))
    ?? (wsId && agents.find(a => a.id === wsId))
    ?? undefined;
  if (!agent) return undefined;

  const raw = agent.runtime as unknown;
  if (typeof raw === 'string' && isValidRuntimeType(raw)) return raw;
  return 'builtin';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate that an ID is safe for use as a filename (prevent path traversal) */
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/** Reject dangerous property names to prevent prototype pollution */
function hasDangerousKeySegment(key: string): boolean {
  return key.split('.').some(p => p === '__proto__' || p === 'constructor' || p === 'prototype');
}

// ---------------------------------------------------------------------------
// Provider file I/O (~/.myagents/providers/{id}.json)
// ---------------------------------------------------------------------------

// findProvider, getProvidersDir, loadCustomProviderFiles → imported from admin-config.ts

/** Save a custom provider JSON file */
function saveCustomProviderFile(provider: Record<string, unknown>): void {
  const dir = getProvidersDir();
  ensureDirSync(dir);
  const filePath = resolve(dir, `${provider.id}.json`);
  writeFileSync(filePath, JSON.stringify(provider, null, 2), 'utf-8');
}

/** Delete a custom provider file. Returns true if file existed. */
function deleteCustomProviderFile(id: string): boolean {
  const filePath = resolve(getProvidersDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

/** Update Sidecar MCP state and notify frontend after config change.
 *  Respects project-scope: only servers enabled both globally AND in the
 *  current workspace project are pushed to the session. */
function notifyMcpChange(action: string, id: string): void {
  const workspacePath = getCurrentWorkspacePath();
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  let effectiveServers: McpServerDefinition[];
  if (workspacePath) {
    const projects = loadProjects();
    const project = projects.find(p => p.path === workspacePath);
    const projectEnabled = new Set(project?.mcpEnabledServers ?? []);
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
  } else {
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
  }

  setMcpServers(effectiveServers);
  broadcast('config:changed', { section: 'mcp', action, id });
}

/** Enable MCP for the current workspace project */
function enableMcpForCurrentProject(serverId: string): void {
  // The workspace path is set via process-global; use it to find the project
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return;

  const projects = loadProjects();
  const idx = projects.findIndex(p => p.path === workspacePath);
  if (idx < 0) return;

  const project = projects[idx];
  const enabled = new Set(project.mcpEnabledServers ?? []);
  enabled.add(serverId);
  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
  saveProjects(projects);
}

/** Disable MCP for the current workspace project */
function disableMcpForCurrentProject(serverId: string): void {
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return;

  const projects = loadProjects();
  const idx = projects.findIndex(p => p.path === workspacePath);
  if (idx < 0) return;

  const project = projects[idx];
  const enabled = new Set(project.mcpEnabledServers ?? []);
  enabled.delete(serverId);
  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
  saveProjects(projects);
}

/** Get workspace path from agent-session (set during session init) */
function getCurrentWorkspacePath(): string | undefined {
  const state = getAgentState();
  return state.agentDir || undefined;
}

/** Modify an agent in config by ID */
async function modifyAgent(
  id: string,
  modifier: (agent: AgentConfigSlim) => AgentConfigSlim,
  action: string,
): Promise<AdminResponse> {
  // Pre-check existence (fast-fail before acquiring write)
  const config = loadConfig();
  if (!(config.agents ?? []).some(a => a.id === id)) {
    return { success: false, error: `Agent '${id}' not found` };
  }

  // Find by ID inside the modifier to avoid TOCTOU stale-index bugs
  await atomicModifyConfig(c => {
    const updated = [...(c.agents ?? [])];
    const freshIdx = updated.findIndex(a => a.id === id);
    if (freshIdx < 0) return c; // agent disappeared between reads — no-op
    updated[freshIdx] = modifier(updated[freshIdx]);
    return { ...c, agents: updated };
  });

  broadcast('config:changed', { section: 'agent', action, id });
  return { success: true, data: { id } };
}

/** Keys and patterns that contain secrets and must be redacted in config get */
const SENSITIVE_KEY_PATTERNS = /apikey|api_key|secret|token|password/i;
const SENSITIVE_TOP_KEYS = new Set(['providerApiKeys', 'mcpServerEnv']);

/** Recursively redact sensitive values in config output */
function redactSensitiveValues(key: string, value: unknown): unknown {
  const rootKey = key.split('.')[0];

  // Top-level known sensitive maps
  if (SENSITIVE_TOP_KEYS.has(rootKey) && typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  // Any key path containing sensitive patterns
  if (SENSITIVE_KEY_PATTERNS.test(key) && typeof value === 'string') {
    return redactSecret(value);
  }

  // For arrays/objects that may contain sensitive nested fields (e.g., agents, imBotConfigs)
  if (typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  return value;
}

/** Recursively walk an object and redact string values whose keys match sensitive patterns */
function deepRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepRedact(item));
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && SENSITIVE_KEY_PATTERNS.test(k)) {
        result[k] = redactSecret(v);
      } else if (typeof v === 'object' && v !== null) {
        result[k] = deepRedact(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
  return obj;
}

/** Get nested value from object by dot-separated key */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object by dot-separated key */
function setNestedValue(obj: AdminAppConfig, key: string, value: unknown): AdminAppConfig {
  const parts = key.split('.');
  if (parts.length === 1) {
    return { ...obj, [key]: value };
  }
  const [first, ...rest] = parts;
  const child = (obj[first] ?? {}) as Record<string, unknown>;
  return { ...obj, [first]: setNestedValue(child as AdminAppConfig, rest.join('.'), value) };
}
