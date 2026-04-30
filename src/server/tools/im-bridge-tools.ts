// IM Bot Bridge Tools — Dynamic MCP proxy for OpenClaw plugin tools
// Fetches tool definitions from Bridge's /mcp/tools endpoint at context-set time,
// then creates one MCP tool per plugin tool — transparent passthrough, no hardcoding.
//
// SDK + zod loaded lazily inside setImBridgeToolsContext() — plain IM sessions
// never pull in this module's bulk unless a plugin bridge is actually attached.

import { cancellableFetch } from '../utils/cancellation';
import { getCurrentTurnSignal } from '../utils/turn-abort';
import { maybeSpill } from '../utils/large-value-store';

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== Auto-auth helper =====

/** Trigger the plugin's "feishu_auth" command to send an OAuth card to the user. */
async function triggerAutoAuth(ctx: ImBridgeToolsContext): Promise<CallToolResult> {
  console.log('[im-bridge-tools] need_user_authorization detected, triggering auto-auth via feishu_auth command');
  try {
    // Pattern 1: 15s cap on local 127.0.0.1 Bridge command call.
    // Pattern 1 follow-up: derive parent signal from the active turn so a
    // user stop releases this fetch immediately rather than waiting on the
    // 15s ceiling.
    const resp = await cancellableFetch(
      `http://127.0.0.1:${ctx.bridgePort}/execute-command`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'feishu_auth',
          args: '',
          userId: ctx.senderId || '',
          chatId: ctx.chatId || '',
        }),
      },
      { timeoutMs: 15_000, parentSignal: getCurrentTurnSignal() },
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[im-bridge-tools] Auto-auth command failed (${resp.status}): ${errText}`);
      return {
        content: [{ type: 'text', text: `该操作需要用户授权飞书权限。自动发送授权卡片失败 (${resp.status})，请用户使用 /feishu_auth 命令手动授权后重试。` }],
        isError: true,
      };
    }
    const result = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (result && !result.ok) {
      console.warn(`[im-bridge-tools] Auto-auth command returned error: ${result.error}`);
      return {
        content: [{ type: 'text', text: `该操作需要用户授权飞书权限。授权流程出错: ${result.error || 'unknown'}，请用户使用 /feishu_auth 命令手动授权后重试。` }],
        isError: true,
      };
    }
  } catch (e) {
    console.warn('[im-bridge-tools] Auto-auth request failed:', e);
    return {
      content: [{ type: 'text', text: '该操作需要用户授权飞书权限。自动授权请求失败，请用户使用 /feishu_auth 命令手动授权后重试。' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: '该操作需要用户授权飞书权限。已自动发送授权卡片，请用户在飞书中点击"前往授权"完成授权后重试。' }],
  };
}

// ===== Bridge Tools Context =====

interface ImBridgeToolsContext {
  bridgePort: number;
  enabledToolGroups: string[];
  pluginId: string;
  /** Feishu sender open_id for tool calls that need user context */
  senderId?: string;
  /** Chat ID for sending messages (e.g., auth cards) back to the user */
  chatId?: string;
  /** Whether the sender is in the allowed_users whitelist (owner) */
  isOwner?: boolean;
  /** Chat type: 'private' (p2p) or 'group' */
  sourceType?: string;
  /** Feishu account ID for multi-account routing (default: 'default') */
  accountId?: string;
}

let bridgeToolsContext: ImBridgeToolsContext | null = null;

/** Cached dynamic MCP server — rebuilt when context changes.
 *  Typed as `McpSdkServerConfigWithInstance | null` via type-only import
 *  (erased at compile time → zero runtime cost). */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
let dynamicServer: McpSdkServerConfigWithInstance | null = null;
/** Generation token — incremented whenever a new context is set so stale
 *  async completions from a previous setImBridgeToolsContext call can be
 *  detected and discarded. Prevents a narrow race where a new context is
 *  set while the previous call's `await fetch(...)` is still in flight. */
let contextGeneration = 0;

/**
 * Set bridge tools context and dynamically create MCP server from plugin tools.
 * Fetches actual tool definitions from Bridge and creates one MCP tool per plugin tool.
 */
export async function setImBridgeToolsContext(ctx: ImBridgeToolsContext): Promise<void> {
  bridgeToolsContext = ctx;
  // Clear the stale server object BEFORE the first await — otherwise
  // buildSdkMcpServers() could see the new context paired with an old server
  // (whose tool closures captured old plugin tool names) during the async gap.
  dynamicServer = null;
  const myGeneration = ++contextGeneration;
  console.log(`[im-bridge-tools] Context set: bridge=${ctx.bridgePort}, groups=${ctx.enabledToolGroups.join(',')}, plugin=${ctx.pluginId}, gen=${myGeneration}`);

  // SDK + zod imported here (not at module top) so plain IM sessions that
  // never attach a plugin bridge pay zero cost for this module.
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');

  // Bail if a newer context was set while we were awaiting imports.
  if (myGeneration !== contextGeneration) {
    console.log(`[im-bridge-tools] Context superseded (gen ${myGeneration} → ${contextGeneration}), discarding`);
    return;
  }

  // Fetch tools from Bridge and build dynamic MCP server
  try {
    // Always inject 'interaction' group for auth recovery (oauth, ask_user_question).
    const allGroups = [...new Set([...ctx.enabledToolGroups, 'interaction'])];
    const groups = allGroups.join(',');
    const url = `http://127.0.0.1:${ctx.bridgePort}/mcp/tools${groups ? `?groups=${groups}` : ''}`;
    // Pattern 1: bound the local Bridge call. 15s = local 127.0.0.1 — anything
    // longer means the Bridge is wedged. Without this an im-bridge tool turn
    // could hang forever waiting on a stuck Bridge.
    const resp = await cancellableFetch(
      url,
      { headers: { 'Content-Type': 'application/json' } },
      { timeoutMs: 15_000 },
    );
    // Issue #114 horizontal — Bridge is a separate Node process; on
    // crash/restart it can return non-JSON (HTML error page, plain text)
    // even with status 200. Read text first, then verify content-type.
    const bridgeBody = await resp.text();
    const bridgeCT = resp.headers.get('content-type') ?? '';
    if (!resp.ok || !bridgeCT.includes('application/json')) {
      console.warn(`[im-bridge-tools] Bridge /mcp/tools ${resp.status} (ct=${bridgeCT}): ${bridgeBody.slice(0, 200)}`);
      if (myGeneration === contextGeneration) dynamicServer = null;
      return;
    }

    let data: {
      ok: boolean;
      tools: Array<{ name: string; description: string; group: string; parameters: Record<string, unknown> }>;
    };
    try {
      data = JSON.parse(bridgeBody);
    } catch {
      console.warn(`[im-bridge-tools] Malformed JSON from /mcp/tools: ${bridgeBody.slice(0, 200)}`);
      if (myGeneration === contextGeneration) dynamicServer = null;
      return;
    }

    if (!data.ok || !data.tools || data.tools.length === 0) {
      // Not an error — some plugins (e.g. WeChat) don't provide MCP tools.
      // Use console.log so the unified-log INFO/WARN/ERROR mapping matches
      // intent (an empty tool list isn't a fault).
      console.log('[im-bridge-tools] No tools available from Bridge (plugin may not provide tools, this is normal)');
      if (myGeneration === contextGeneration) dynamicServer = null;
      return;
    }

    // Create one MCP tool per plugin tool — transparent passthrough
    // Filter out tools with missing names, and ensure description is always a string
    //
    // W9 fix: capture the *current* context as `localCtx` at server-build time
    // rather than dereferencing the module-global `bridgeToolsContext` inside
    // each tool callback. Concurrent IM turns (Pipeline v2 protocol-split
    // allows two messages from the same peer to be enqueued back-to-back) can
    // overwrite the module-global with the next turn's identity while the
    // previous turn's tool calls are still resolving — without per-server
    // capture, an in-flight Feishu OAuth call could end up using the wrong
    // sender open_id / chat_id / account_id.
    const localCtx: ImBridgeToolsContext = ctx;
    const dynamicTools = data.tools.filter(t => t.name).map(pluginTool =>
      tool(
        pluginTool.name,
        pluginTool.description || '',
        // Pass through all arguments as a generic record.
        // The plugin's description already documents the expected parameters.
        { args: z.record(z.string(), z.any()).describe('Tool arguments as key-value pairs') },
        async (params: { args: Record<string, unknown> }): Promise<CallToolResult> => {
          try {
            const callUrl = `http://127.0.0.1:${localCtx.bridgePort}/mcp/call-tool`;
            // Pattern 1: 30s for plugin tool calls — they may hit remote APIs
            // (Feishu, Lark, …) but should never hang indefinitely. The plugin
            // itself is responsible for finer-grained timeouts; this is the
            // outer guard.
            // Pattern 1 follow-up: parent signal = active turn, so stop button
            // releases this immediately even before the 30s ceiling.
            const callResp = await cancellableFetch(
              callUrl,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  toolName: pluginTool.name,
                  args: params.args,
                  userId: localCtx.senderId,
                  isOwner: localCtx.isOwner ?? false,
                  enabledGroups: [...new Set([...localCtx.enabledToolGroups, 'interaction'])],
                  // Ticket context for LarkTicket injection (Feishu OAuth auto-auth)
                  chatId: localCtx.chatId,
                  chatType: localCtx.sourceType === 'group' ? 'group' : 'p2p',
                  accountId: localCtx.accountId,
                }),
              },
              { timeoutMs: 30_000, parentSignal: getCurrentTurnSignal() },
            );

            if (!callResp.ok) {
              const text = await callResp.text();
              return {
                content: [{ type: 'text', text: `Tool call failed (${callResp.status}): ${text}` }],
                isError: true,
              };
            }

            // Issue #114 horizontal — even with 2xx, Bridge may return
            // non-JSON if the underlying plugin tool emits text. Verify
            // content-type before parsing.
            const callBody = await callResp.text();
            const callCT = callResp.headers.get('content-type') ?? '';
            if (!callCT.includes('application/json')) {
              return {
                content: [{ type: 'text', text: `Tool returned non-JSON response (ct=${callCT}): ${callBody.slice(0, 500)}` }],
                isError: true,
              };
            }
            let result: { ok: boolean; result?: unknown; error?: string };
            try {
              result = JSON.parse(callBody);
            } catch (parseErr) {
              const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
              return {
                content: [{ type: 'text', text: `Tool returned malformed JSON: ${msg}\n${callBody.slice(0, 500)}` }],
                isError: true,
              };
            }
            if (!result.ok) {
              // Auto-trigger OAuth for need_user_authorization (may come as Bridge-level error)
              if (result.error?.includes('need_user_authorization') && localCtx.chatId) {
                return await triggerAutoAuth(localCtx);
              }
              return {
                content: [{ type: 'text', text: `Tool error: ${result.error || 'unknown'}` }],
                isError: true,
              };
            }

            // OpenClaw tools return {content: [{type:'text', text:'...'}], details: ...}
            // Extract content[0].text directly to avoid double-encoding JSON
            const raw = result.result as Record<string, unknown> | string | null | undefined;
            let resultText: string;
            if (typeof raw === 'string') {
              resultText = raw;
            } else if (raw != null && Array.isArray((raw as Record<string, unknown>).content)) {
              const content = (raw as { content: Array<{ type: string; text?: string }> }).content;
              resultText = content.map(c => c.text ?? '').join('\n') || 'OK (empty result)';
            } else if (raw != null) {
              resultText = JSON.stringify(raw, null, 2);
            } else {
              resultText = 'OK (no data returned)';
            }

            // Auto-trigger OAuth when Feishu returns need_user_authorization.
            if (resultText.includes('need_user_authorization') && localCtx.chatId) {
              return await triggerAutoAuth(localCtx);
            }

            // Pattern 2 §F — Cap large tool results. Anything over 256KB is
            // spilled to ~/.myagents/refs/<id> and we return a preview-only
            // tool result with a `@ref:<id>` marker pointing to the full body.
            // Keeps a 10MB plugin response from blasting through SSE / IPC /
            // disk in one go.
            const spilled = await maybeSpill(resultText, {
              mimetype: 'text/plain; charset=utf-8',
              sessionId: localCtx.pluginId,
            });
            if ('inline' in spilled) {
              return { content: [{ type: 'text', text: resultText }] };
            }
            // Returned a ref — show the preview to the SDK with an explicit
            // pointer to the full body. The SDK can request the full ref
            // through the proxyFetch path (renderer) or a future bridge
            // helper if it needs the rest.
            const previewText =
              `${spilled.preview}\n\n…(truncated; ${spilled.sizeBytes} bytes total) ` +
              `@ref:${spilled.id} (mimetype=${spilled.mimetype})`;
            return {
              content: [{ type: 'text', text: previewText }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    );

    // Final generation check — a newer context may have been set during the
    // fetch-tools round-trip. If so, don't publish this stale server.
    if (myGeneration !== contextGeneration) {
      console.log(`[im-bridge-tools] Context superseded post-fetch (gen ${myGeneration} → ${contextGeneration}), discarding`);
      return;
    }
    dynamicServer = createSdkMcpServer({
      name: 'im-bridge-tools',
      version: '1.0.0',
      tools: dynamicTools,
    });

    console.log(`[im-bridge-tools] Dynamic MCP server created with ${data.tools.length} tools: ${data.tools.map(t => t.name).join(', ')}`);
  } catch (err) {
    console.warn(`[im-bridge-tools] Failed to create dynamic server: ${err}`);
    // Only clear if this call is still the current generation — otherwise
    // we'd clobber a newer setup that superseded us.
    if (myGeneration === contextGeneration) {
      dynamicServer = null;
    }
  }
}

export function clearImBridgeToolsContext(): void {
  bridgeToolsContext = null;
  dynamicServer = null;
  console.log('[im-bridge-tools] Context cleared');
}

export function getImBridgeToolsContext(): ImBridgeToolsContext | null {
  return bridgeToolsContext;
}

/**
 * Get the dynamically created MCP server (null if no tools available).
 * Called by buildSdkMcpServers() in agent-session.ts. The type-only import
 * at the top of this file gives us a real SDK type with no runtime cost.
 */
export function getImBridgeToolServer(): McpSdkServerConfigWithInstance | null {
  return dynamicServer;
}
