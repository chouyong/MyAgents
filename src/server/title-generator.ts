/**
 * title-generator.ts — AI-powered session title generation.
 *
 * Runtime-aware:
 *   - builtin  → Claude Agent SDK query() with provider-env (current behavior)
 *   - external → spawns a fresh short-lived process of the session's runtime
 *                (claude-code / codex / gemini) with the title system prompt.
 *                Model, CLI auth, etc. are inherited from the active runtime
 *                so Gemini/Codex sessions no longer fall back to Anthropic SDK.
 *
 * Always single-turn; never persists the title session. Timing: triggered
 * after 3+ QA rounds (frontend shows truncated first message for 1–2 rounds).
 */

import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeCli, buildClaudeSessionEnv, startOneShotBridge, type ProviderEnv } from './agent-session';
import { ClaudeCodeRuntime } from './runtimes/claude-code';
import { CodexRuntime } from './runtimes/codex';
import { GeminiRuntime } from './runtimes/gemini';
import type { AgentRuntime, RuntimeProcess } from './runtimes/types';
import type { RuntimeType } from '../shared/types/runtime';
import { ensureDirSync } from './utils/fs-utils';

const TITLE_MAX_LENGTH = 30;
const TIMEOUT_MS = 15_000;
/** External runtimes (Gemini/Codex/CC) have higher cold-start cost — node/CLI
 *  spawn + ACP/JSON-RPC handshake + potential OAuth refresh. Gemini alone can
 *  take ~10s to first token. 30s keeps headroom without stalling the UI. */
const EXTERNAL_TIMEOUT_MS = 30_000;
/** Max chars per user/assistant message when building context */
const PER_MESSAGE_LIMIT = 200;

const SYSTEM_PROMPT = `You are a conversation title generator. Output ONLY the title — nothing else.

Rules:
- Maximum 30 characters (CJK counts as 1)
- Language MUST match the user's language (Chinese → Chinese title, English → English)
- Identify the MAIN TOPIC or GOAL across all rounds, not just the first message
- Use specific nouns/verbs — e.g. "Redis 缓存优化" not "技术讨论"
- NEVER copy a sentence or phrase directly from the conversation
- NEVER use generic words: help, question, discussion, issue, request, 帮助, 问题, 讨论, 请求
- NEVER output meta-text about the title itself (e.g. "对话标题应该是…", "The title should be…")
- Just output the title directly, like: SSE 流式调试`;

export interface TitleRound {
  user: string;
  assistant: string;
}

function buildUserPrompt(rounds: TitleRound[]): string {
  const parts = rounds.map((r, i) => {
    const user = r.user.slice(0, PER_MESSAGE_LIMIT);
    const assistant = r.assistant.slice(0, PER_MESSAGE_LIMIT);
    return `[Round ${i + 1}]\nUser: ${user}\nAssistant: ${assistant}`;
  });
  return `<conversation>\n${parts.join('\n\n')}\n</conversation>\n\nFollow the System Instruction to generate a short title for the conversation above.`;
}

/**
 * Clean up the generated title: remove surrounding quotes, punctuation, whitespace,
 * and truncate to TITLE_MAX_LENGTH characters.
 */
function cleanTitle(raw: string): string {
  let cleaned = raw.trim();
  // Remove surrounding quotes (single, double, Chinese quotes)
  cleaned = cleaned.replace(/^["'「『《【"']+|["'」』》】"']+$/g, '');
  // Remove trailing punctuation
  cleaned = cleaned.replace(/[。，、；：！？.,:;!?…]+$/, '');
  // Remove common AI preamble patterns
  cleaned = cleaned.replace(/^(标题[：:]|Title[：:])\s*/i, '');
  // Defense-in-depth: strip angle brackets so a model-injected "<script>" never reaches
  // a consumer that might render titles as HTML/Markdown raw. Frontend uses text nodes
  // today, but title is long-lived metadata and cheap to harden here.
  cleaned = cleaned.replace(/[<>]/g, '');
  cleaned = cleaned.trim();
  if (cleaned.length > TITLE_MAX_LENGTH) {
    cleaned = cleaned.slice(0, TITLE_MAX_LENGTH);
  }
  return cleaned;
}

/**
 * Generate a short session title using the SDK query() path.
 * Accepts multiple QA rounds (typically 3) for richer context.
 * Uses the user's current model and provider — single-turn, non-persistent.
 * Returns cleaned title string on success, null on any failure (silent).
 */
export async function generateTitle(
  rounds: TitleRound[],
  model: string,
  providerEnv?: ProviderEnv,
): Promise<string | null> {
  // PRD #124: register a per-call bridge token if the title-gen provider is
  // OpenAI-protocol — the SDK subprocess routes to ITS upstream via a
  // dedicated /bridge/<token> path, fully isolated from the active session.
  // For Anthropic-direct / subscription title-gen, no token is needed.
  const bridge = providerEnv?.apiProtocol === 'openai'
    ? startOneShotBridge(providerEnv, model, `title-gen:${providerEnv.baseUrl ?? 'anthropic'}`)
    : null;
  try {
    return await generateTitleInner(rounds, model, providerEnv, bridge?.token);
  } finally {
    bridge?.release();
  }
}

async function generateTitleInner(
  rounds: TitleRound[],
  model: string,
  providerEnv?: ProviderEnv,
  bridgeToken?: string,
): Promise<string | null> {
  const startTime = Date.now();
  const sessionId = randomUUID();

  try {
    const cliPath = resolveClaudeCodeCli();
    const cwd = join(homedir(), '.myagents', 'projects');
    ensureDirSync(cwd);

    // Pass `model` as the override so CLAUDE_CODE_AUTO_COMPACT_WINDOW is
    // computed for the title-gen model, not the active Tab session's model.
    const env = buildClaudeSessionEnv(providerEnv, model, { bridgeToken });
    const prompt = buildUserPrompt(rounds);

    async function* titlePrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: prompt },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    }

    const titleQuery = query({
      prompt: titlePrompt(),
      options: {
        maxTurns: 1,
        sessionId,
        cwd,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: cliPath,
        env,
        systemPrompt: SYSTEM_PROMPT,
        includePartialMessages: false,
        persistSession: false,
        mcpServers: {},
        ...(model ? { model } : {}),
      },
    });

    let titleText: string | null = null;

    // Race: SDK response vs timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), TIMEOUT_MS);
    });

    const queryPromise = (async (): Promise<string | null> => {
      for await (const message of titleQuery) {
        if (message.type === 'assistant') {
          const msg = message as { message?: { content?: Array<{ text?: string }> } };
          const text = msg.message?.content?.[0]?.text;
          if (text) return text;
        }
        // result type — extract from last assistant message if available
        if (message.type === 'result') {
          const resultMsg = message as { subtype?: string; messages?: Array<{ role: string; content?: Array<{ text?: string }> }> };
          if (resultMsg.subtype === 'success' && resultMsg.messages) {
            const lastAssistant = resultMsg.messages.filter(m => m.role === 'assistant').pop();
            const text = lastAssistant?.content?.[0]?.text;
            if (text) return text;
          }
        }
      }
      return null;
    })();

    titleText = await Promise.race([queryPromise, timeoutPromise]);

    // If timeout won, terminate the SDK iterator to release the subprocess
    if (titleText === null) {
      try { titleQuery.return(undefined as never); } catch { /* ignore */ }
    }

    if (!titleText) {
      console.warn(`[title-generator] No title text returned (${Date.now() - startTime}ms)`);
      return null;
    }

    const cleaned = cleanTitle(titleText);
    console.log(`[title-generator] Generated title: "${cleaned}" (${Date.now() - startTime}ms, ${rounds.length} rounds)`);
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    console.warn('[title-generator] SDK query failed:', err);
    return null;
  }
}

// ─── External runtime title generation ───

/**
 * Create a FRESH runtime instance (not the cached factory singleton) for title
 * generation. This isolates title-gen's process lifecycle from the main
 * session's runtime — CC's singleton keeps block-index maps on the instance,
 * and a concurrent title-gen startSession would clear those maps and corrupt
 * the main session's tool-tracking state.
 */
function createFreshRuntime(type: RuntimeType): AgentRuntime {
  switch (type) {
    case 'claude-code': return new ClaudeCodeRuntime();
    case 'codex': return new CodexRuntime();
    case 'gemini': return new GeminiRuntime();
    default:
      throw new Error(`Unsupported external runtime for title generation: ${type}`);
  }
}

/**
 * Force the most permissive / no-prompt mode for each runtime so the title
 * turn never blocks on permission requests. Title generation is text-only,
 * the LLM should not invoke tools, but we still bypass approval to be safe.
 */
function titlePermissionMode(runtimeType: RuntimeType): string {
  switch (runtimeType) {
    case 'claude-code': return 'fullAgency';  // → bypassPermissions
    case 'codex': return 'full-auto';         // → approvalPolicy=never + sandbox=workspace-write
    case 'gemini': return 'yolo';             // → ACP yolo mode
    default: return 'auto';
  }
}

/**
 * Generate a title using the session's external runtime (claude-code / codex /
 * gemini). Spawns a brand-new short-lived process, sends the title prompt as
 * initialMessage, accumulates text_delta, returns on turn_complete or
 * session_complete. The process is always stopped afterwards (including on
 * timeout), so Gemini's temporary GEMINI_SYSTEM_MD file is cleaned up.
 *
 * Silent-fail contract matches generateTitle(): any error → null, frontend
 * falls back to truncated first message.
 */
export async function generateTitleExternal(
  rounds: TitleRound[],
  runtimeType: RuntimeType,
  model: string,
  workspacePath: string,
): Promise<string | null> {
  const startTime = Date.now();
  const titleSessionId = `title-${randomUUID()}`;
  const userPrompt = buildUserPrompt(rounds);

  let runtime: AgentRuntime;
  try {
    runtime = createFreshRuntime(runtimeType);
  } catch (err) {
    console.warn('[title-generator] external runtime unavailable:', err);
    return null;
  }

  let collected = '';
  let handle: RuntimeProcess | null = null;
  let resolved = false;
  let settle: (val: string | null) => void = () => { /* placeholder replaced by promise ctor */ };
  let outcome: 'ok' | 'empty' | 'timeout' | 'start-failed' | 'error' | 'permission' = 'timeout';

  const resultPromise = new Promise<string | null>((resolve) => {
    settle = (val: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };
  });

  // Hoist startSession out of the Promise ctor so we can await it on the timeout path —
  // without that, a 30s timeout during Gemini's cold-start handshake leaves `handle === null`
  // forever, stranding the child process + its GEMINI_SYSTEM_MD tmp file.
  const startPromise = runtime.startSession({
    sessionId: titleSessionId,
    workspacePath,
    initialMessage: userPrompt,
    systemPromptAppend: SYSTEM_PROMPT,
    ...(model ? { model } : {}),
    permissionMode: titlePermissionMode(runtimeType),
    maxTurns: 1,
    // Placeholder — title-gen passes its own systemPromptAppend and explicit permissionMode,
    // so scenario-driven branches in each runtime (default-mode/L2-prompt) never fire.
    scenario: { type: 'desktop' },
  }, (event) => {
    // Guard: events can still stream in after we've settled (timeout winner / late turn_complete).
    if (resolved) return;
    if (event.kind === 'text_delta') {
      collected += event.text;
    } else if (event.kind === 'turn_complete') {
      outcome = collected ? 'ok' : 'empty';
      settle(collected || null);
    } else if (event.kind === 'session_complete') {
      // On non-success (Gemini session/prompt error, Codex turn error) a few tokens may have
      // streamed before the failure — those partial fragments make garbage titles. Settle null.
      if (event.subtype === 'success') {
        outcome = collected ? 'ok' : 'empty';
        settle(collected || null);
      } else {
        outcome = 'error';
        settle(null);
      }
    } else if (event.kind === 'permission_request') {
      // Title-gen is text-only and forces the most permissive mode per runtime so this shouldn't
      // fire. If it does (e.g. Gemini set_mode non-fatally fell back to default), don't deadlock
      // waiting on an approval we'd never grant — settle with whatever text we have and let the
      // cleanup path kill the process. No respondPermission call needed.
      outcome = 'permission';
      settle(collected || null);
    }
  });

  startPromise.then((h) => {
    handle = h;
    // Late handle after timeout already fired — kill immediately, nobody else will.
    if (resolved) {
      runtime.stopSession(h).catch(() => { /* ignore */ });
    }
  }).catch((err) => {
    outcome = 'start-failed';
    console.warn('[title-generator] external startSession failed:', err);
    settle(null);
  });

  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), EXTERNAL_TIMEOUT_MS));
  const titleText = await Promise.race([resultPromise, timeoutPromise]);

  // Cleanup path — three cases:
  //   1. handle already set → stopSession directly.
  //   2. handle still null because we timed out mid-handshake → wait briefly (5s) for startSession
  //      to resolve, then stop. This is the critical leak fix: without it, Gemini's ACP handshake
  //      could complete AFTER our 30s budget, assign `handle` via the .then() above, and nobody
  //      would ever kill the subprocess.
  //   3. startPromise rejects during the grace window → .catch above already fired, no handle to
  //      stop. Swallow rejection in the race so we don't propagate.
  if (handle) {
    try { await runtime.stopSession(handle); } catch { /* ignore */ }
  } else {
    const lateHandle = await Promise.race([
      startPromise.catch(() => null),
      new Promise<RuntimeProcess | null>((r) => setTimeout(() => r(null), 5_000)),
    ]);
    if (lateHandle) {
      try { await runtime.stopSession(lateHandle); } catch { /* ignore */ }
    }
  }

  const durationMs = Date.now() - startTime;
  if (!titleText || !titleText.trim()) {
    // Preserve the outcome tag the callback/catch/timeout set so ops can distinguish
    // timeout / start-failed / error / empty in the logs.
    console.warn(`[title-generator] external ${runtimeType} produced no title (outcome=${outcome}, ${durationMs}ms)`);
    return null;
  }

  const cleaned = cleanTitle(titleText);
  console.log(`[title-generator] Generated title via ${runtimeType}: "${cleaned}" (outcome=${outcome}, ${durationMs}ms, ${rounds.length} rounds)`);
  return cleaned.length > 0 ? cleaned : null;
}
