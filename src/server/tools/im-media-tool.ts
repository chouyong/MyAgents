// IM media context — sidecar-side state for IM/agent-channel sessions.
//
// Historical note: this module used to host an in-process MCP server
// (`im-media`) with a single `send_media` tool. The MCP was retired in
// v0.2.11 in favour of the universal `myagents im send-media` CLI command
// + the system prompt's <myagents-cli-im-media> guidance (see
// system-prompt-cli-tools.ts). The CLI handler lives in
// admin-api.ts::handleImSendMedia and reaches the same Rust Management
// API endpoint the old MCP did.
//
// What this file still owns: the per-Sidecar IM context that downstream
// CLI handlers (handleImSendMedia / handleImWake) and the permission
// gate read to know "is the active session an IM session?" and "what
// bot / chat is bound to this Sidecar?".

// ===== IM Media Context =====

interface ImMediaContext {
  botId: string;
  chatId: string;
  platform: string; // "telegram" | "feishu" | "dingtalk" | OpenClaw plugin id
  /**
   * Workspace root the current session is scoped to — set by callers so
   * file paths supplied via `myagents im send-media` can be canonicalised
   * against a safe root (workspace / tmp / scratch). Leaving this unset
   * disables the prefix check; only do that when the call site has its
   * own equivalent guard (e.g., admin-api always validates).
   */
  workspacePath?: string;
}

let imMediaContext: ImMediaContext | null = null;

export function setImMediaContext(ctx: ImMediaContext): void {
  imMediaContext = ctx;
  console.log(`[im-media] Context set: botId=${ctx.botId}, chatId=${ctx.chatId}, platform=${ctx.platform}`);
}

export function clearImMediaContext(): void {
  imMediaContext = null;
  console.log('[im-media] Context cleared');
}

export function getImMediaContext(): ImMediaContext | null {
  return imMediaContext;
}
