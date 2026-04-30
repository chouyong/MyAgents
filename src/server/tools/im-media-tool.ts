// IM Bot Media Tool — AI-driven media sending for IM Bots
// Uses Rust Management API (via MYAGENTS_MANAGEMENT_PORT) for file upload/send.
// SDK + zod loaded lazily inside createImMediaToolServer() — see
// builtin-mcp-meta.ts for registration.
import { assertSafeFilePath } from '../utils/safe-file-path';
import { cancellableFetch } from '../utils/cancellation';
import { getCurrentTurnSignal } from '../utils/turn-abort';
import { readLoopbackJson } from '../utils/loopback-response';

// MCP Tool Result type
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== IM Media Context =====

interface ImMediaContext {
  botId: string;
  chatId: string;
  platform: string; // "telegram" | "feishu"
  /**
   * Workspace root the current session is scoped to — set by the caller so
   * `sendMediaHandler` can validate that AI-supplied file paths stay inside
   * a safe root (workspace / tmp). Optional for backwards-compat; callers
   * that don't set it get the previous "trust the AI" behaviour, which is
   * fine for desktop-only contexts where the user can vet the argument.
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

// ===== Management API client =====

const MANAGEMENT_PORT = process.env.MYAGENTS_MANAGEMENT_PORT;

async function managementApi(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  if (!MANAGEMENT_PORT) {
    throw new Error('MYAGENTS_MANAGEMENT_PORT not set — management API unavailable');
  }

  const url = `http://127.0.0.1:${MANAGEMENT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  // Pattern 1: 30s cap. Media send may transit larger payloads (file upload
  // → IM platform → confirm), so a longer ceiling than the plain CRUD case.
  // Pattern 1 follow-up: parent signal = active turn so stop releases this
  // even before the 30s ceiling.
  const resp = await cancellableFetch(url, options, {
    timeoutMs: 30_000,
    parentSignal: getCurrentTurnSignal(),
  });
  // Issue #114 — defensive read via shared helper.
  return await readLoopbackJson(resp, 'Management API');
}

// ===== Tool handler =====

async function sendMediaHandler(args: {
  file_path: string;
  caption?: string;
}): Promise<CallToolResult> {
  if (!MANAGEMENT_PORT) {
    return {
      content: [{ type: 'text', text: 'Error: Management API is not available (MYAGENTS_MANAGEMENT_PORT not set).' }],
      isError: true,
    };
  }

  // W9 fix: snapshot the IM context once at the start of the handler. The
  // module-global `imMediaContext` is overwritten on every /api/im/enqueue
  // (incl. multi-chat bots), so two reads inside this handler can otherwise
  // observe different (botId, chatId) pairs and deliver the file to the
  // wrong peer.
  const ctx = imMediaContext;
  if (!ctx) {
    return {
      content: [{ type: 'text', text: 'Error: No IM context available. This tool can only be used within an IM Bot session.' }],
      isError: true,
    };
  }

  // Path traversal guard (mirrors admin-api.ts::handleImSendMedia). Only
  // enforced when the context has workspacePath set — maintains backward-compat
  // for older call sites that haven't been updated yet. Prompt-injected AI
  // must not exfiltrate ~/.ssh/id_rsa etc. through an IM chat peer.
  let safeFilePath = args.file_path;
  if (ctx.workspacePath) {
    try {
      safeFilePath = assertSafeFilePath(args.file_path, {
        workspacePath: ctx.workspacePath,
      });
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  try {
    const result = await managementApi('/api/im/send-media', 'POST', {
      botId: ctx.botId,
      chatId: ctx.chatId,
      platform: ctx.platform,
      filePath: safeFilePath,
      caption: args.caption,
    }) as { ok: boolean; fileName?: string; fileSize?: number; error?: string };

    if (result.ok) {
      const sizeMb = result.fileSize ? `${(result.fileSize / (1024 * 1024)).toFixed(2)} MB` : 'unknown size';
      return {
        content: [{
          type: 'text',
          text: `File sent successfully: ${result.fileName} (${sizeMb})`,
        }],
      };
    }

    return {
      content: [{ type: 'text', text: `Failed to send file: ${result.error}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ===== Server creation =====

export async function createImMediaToolServer() {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  return createSdkMcpServer({
    name: 'im-media',
    version: '1.0.0',
    tools: [
      tool(
        'send_media',
        `Send a file (image, document, audio, video, archive) to the current IM chat.

Use this tool when the user asks you to:
- Send a file, image, screenshot, or document to the chat
- Share a generated file (CSV, PDF, chart image, etc.)
- Upload and deliver media content

The file must exist on disk. Write it first with file tools, then call send_media.

Supported formats:
- Images: jpg, jpeg, png, gif, webp, bmp, svg (sent as native photo, max 10 MB)
- Documents: pdf, doc/docx, xls/xlsx, ppt/pptx, csv, json, xml, html, txt
- Media: mp4, mp3, ogg, wav, avi, mov, mkv
- Archives: zip, rar, 7z, tar, gz
- Files over 10 MB (images) or 50 MB (other) will be rejected.

Do NOT use this tool for intermediate work files — only for files the user explicitly wants to receive.`,
        {
          file_path: z.string().describe('Absolute path to the file on disk'),
          caption: z.string().optional().describe('Optional caption/description to send with the file'),
        },
        sendMediaHandler,
      ),
    ],
  });
}

