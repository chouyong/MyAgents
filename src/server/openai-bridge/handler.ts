// Bridge HTTP handler: receives Anthropic requests, translates to OpenAI, forwards, translates back

// MUST import `fetch` from undici (not use global fetch). Node 24's built-in
// fetch is undici 7.21.0, but our `package.json` pins `undici@^8`. Passing an
// undici-8 ProxyAgent dispatcher into undici-7's global fetch crashes with
// `UND_ERR_INVALID_ARG: invalid onRequestStart method` (internal API drift
// between majors). Importing fetch from the same package guarantees the
// dispatcher and fetch share the same internal contract.
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { BridgeConfig, UpstreamConfig } from './types/bridge';
import type { AnthropicRequest } from './types/anthropic';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from './types/openai';
import type { ResponsesResponse, ResponsesStreamEvent } from './types/openai-responses';
import { translateRequest } from './translate/request';
import { translateResponse } from './translate/response';
import { translateRequestToResponses } from './translate/request-responses';
import { translateResponsesResponse, ResponsesApiError } from './translate/response-responses';
import { createToolImageSaver, type ToolImageSaver } from './translate/multimodal';
import { StreamTranslator } from './translate/stream';
import { ResponsesStreamTranslator } from './translate/stream-responses';
import { translateError } from './translate/errors';
import { SSEParser } from './utils/sse-parser';
import { formatSSE } from './utils/sse-writer';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const THOUGHT_SIG_CACHE_MAX = 500; // Max cached thought_signatures to prevent unbounded growth

// Gemini-documented dummy value to skip thought_signature validation
// when the real signature is unavailable (e.g., cross-model history, injected tool calls).
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
const THOUGHT_SIG_SKIP_VALIDATOR = 'skip_thought_signature_validator';

/**
 * Last upstream-connectivity failure observed by the bridge.
 *
 * Purpose is purely diagnostic: when `verifyViaSdk`'s outer 30s timeout fires,
 * it inspects this ref to surface the real connect-layer error (TLS rejection,
 * socket closed, DNS failure, proxy-intercepted TLS, …) instead of the generic
 * "验证超时，请检查网络连接" message. These errors live only in the bridge's
 * fetch-catch path — the SDK sees our 502 and retries until the outer timeout
 * fires, so the real reason never reaches verify through the normal code path.
 *
 * Scoped by wall-clock: readers filter by `timestamp >= theirStartTime` so
 * stale errors from unrelated sessions don't leak into new verify attempts.
 * Last-writer-wins across concurrent sessions is an acceptable trade-off —
 * this is a failure-mode diagnostic, not a correctness surface.
 */
let lastBridgeError: { message: string; timestamp: number; upstreamUrl: string } | undefined;

export function getLastBridgeError(): { message: string; timestamp: number; upstreamUrl: string } | undefined {
  return lastBridgeError;
}

/** Detect proxy URL from environment (respects no_proxy for the target URL) */
export function getProxyForUrl(url: string): string | undefined {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return undefined;

  // Check no_proxy
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  if (noProxy === '*') return undefined;
  if (noProxy) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const excluded = noProxy.split(',').some(p => {
        const pattern = p.trim().toLowerCase();
        return host === pattern || host.endsWith(`.${pattern}`);
      });
      if (excluded) return undefined;
    } catch { /* invalid URL, skip no_proxy check */ }
  }

  return proxy;
}

/**
 * Per-proxy-URL dispatcher cache.
 *
 * Node.js `fetch()` is undici under the hood, and undici routes upstream HTTP
 * traffic via the `dispatcher` field — NOT a `proxy` string (that's Bun-only).
 * Each `ProxyAgent` carries its own connection pool, so we keep one per URL
 * and reuse it across requests rather than creating one per fetch.
 *
 * Note: SOCKS5 is handled upstream by `setProxyConfig()` (agent-session.ts) —
 * it spins up a local HTTP-to-SOCKS5 bridge and sets `HTTP_PROXY` to the
 * bridge's HTTP URL, so by the time we read `getProxyForUrl()` here the URL
 * is always plain http://.
 */
const proxyDispatchers = new Map<string, Dispatcher>();

function getDispatcherForProxy(proxyUrl: string): Dispatcher {
  let agent = proxyDispatchers.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyDispatchers.set(proxyUrl, agent);
  }
  return agent;
}

export interface BridgeHandler {
  /** Handle an incoming Anthropic-format request */
  (request: Request): Promise<Response>;
  /** Seed the thought_signature cache (e.g., from persisted session history) */
  seedThoughtSignatures(entries: Array<{ id: string; thought_signature: string }>): void;
}

/** Create a bridge handler that translates Anthropic → OpenAI → Anthropic */
export function createBridgeHandler(config: BridgeConfig): BridgeHandler {
  const log = config.logger === null ? () => {} : (config.logger ?? console.log);
  const timeout = config.upstreamTimeout ?? DEFAULT_TIMEOUT;
  const translateReasoning = config.translateReasoning ?? true;
  const imageSaver: ToolImageSaver | undefined = config.workspacePath
    ? createToolImageSaver(config.workspacePath)
    : undefined;

  // Cache tool_call_id → thought_signature across requests.
  // Gemini thinking models require round-tripping thought_signature on every request
  // that includes tool calls in history. The Claude Agent SDK strips non-standard fields,
  // so we must cache them here and re-inject on outgoing requests.
  // Capped at THOUGHT_SIG_CACHE_MAX to prevent unbounded growth in long-lived sessions.
  const thoughtSignatureCache = new Map<string, string>();

  const handler = async (request: Request): Promise<Response> => {
    // 1. Extract API key from request headers
    const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace('Bearer ', '') || '';

    // 2. Parse Anthropic request body
    let anthropicReq: AnthropicRequest;
    try {
      anthropicReq = await request.json() as AnthropicRequest;
    } catch {
      return jsonError(400, 'invalid_request_error', 'Invalid JSON in request body');
    }

    // 3. Get upstream config
    let upstream: UpstreamConfig;
    try {
      upstream = await config.getUpstreamConfig(request);
    } catch (err) {
      log(`[bridge] Failed to get upstream config: ${err}`);
      return jsonError(500, 'api_error', 'Bridge configuration error');
    }

    const effectiveApiKey = upstream.apiKey || apiKey;
    const baseUrl = upstream.baseUrl.replace(/\/+$/, ''); // trim trailing slashes
    const isResponses = upstream.upstreamFormat === 'responses';

    // 4. Translate request (choose format based on upstream config)
    // PRD #124: per-request model mapping (carried on UpstreamConfig, set by
    // the route closure from the bridge token's registry entry) takes
    // priority over the handler-wide BridgeConfig.modelMapping. This is what
    // lets concurrent SDK subprocesses with different sub-agent rules
    // coexist without cross-pollination.
    const effectiveModelMapping = upstream.modelMapping ?? config.modelMapping;
    const translatedReq = isResponses
      ? translateRequestToResponses(anthropicReq, { modelOverride: upstream.model, modelMapping: effectiveModelMapping, imageSaver })
      : translateRequest(anthropicReq, { modelMapping: effectiveModelMapping, modelOverride: upstream.model, imageSaver });

    // 4a. Normalize thought_signatures on tool_calls (Gemini thinking models).
    // Gemini requires thought_signature on tool_calls in conversation history.
    // In OpenAI-compat format, Gemini expects it at extra_content.google.thought_signature.
    // The Claude Agent SDK strips non-standard fields, so we re-inject from cache.
    // We normalize ALL tool_calls to have BOTH locations (direct + extra_content):
    //   - Sig exists at one location → copy to the other (normalization)
    //   - No sig at either → inject from cache or Google-documented dummy fallback
    if (!isResponses) {
      const chatReq = translatedReq as OpenAIRequest;
      let injectedCached = 0;
      let injectedDummy = 0;
      let normalized = 0;
      for (const msg of chatReq.messages) {
        if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const existingSig = tc.thought_signature
              || tc.extra_content?.google?.thought_signature;
            if (existingSig) {
              // Normalize: ensure both locations have the sig
              if (!tc.thought_signature || !tc.extra_content?.google?.thought_signature) {
                tc.thought_signature = existingSig;
                tc.extra_content = { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: existingSig } };
                normalized++;
              }
            } else {
              // No sig anywhere — inject from cache or dummy
              const cached = thoughtSignatureCache.get(tc.id);
              const sig = cached || THOUGHT_SIG_SKIP_VALIDATOR;
              tc.thought_signature = sig;
              tc.extra_content = { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: sig } };
              if (cached) injectedCached++;
              else injectedDummy++;
            }
          }
        }
      }
      if (injectedCached > 0 || injectedDummy > 0 || normalized > 0) {
        log(`[bridge] thought_signatures: ${injectedCached} cached, ${injectedDummy} dummy, ${normalized} normalized`);
      }
    }

    // 4b. Inject token limit if configured.
    // Request translators intentionally omit token limits (SDK sends Claude-scale values
    // that are meaningless for other providers). Only inject when the user explicitly
    // configured a cap via maxOutputTokens in provider settings.
    const maxOutputTokensCap = upstream.maxOutputTokens ?? config.maxOutputTokens;
    if (maxOutputTokensCap) {
      if (isResponses) {
        // Responses API always uses max_output_tokens
        (translatedReq as { max_output_tokens?: number }).max_output_tokens = maxOutputTokensCap;
        log(`[bridge] Injecting max_output_tokens=${maxOutputTokensCap}`);
      } else {
        // Chat Completions: use user-configured param name (default max_tokens for widest compatibility)
        const paramName = upstream.maxOutputTokensParamName ?? 'max_tokens';
        const chatReq = translatedReq as OpenAIRequest & { [key: string]: unknown };
        chatReq[paramName] = maxOutputTokensCap;
        log(`[bridge] Injecting ${paramName}=${maxOutputTokensCap}`);
      }
    }

    const logModel = (translatedReq as { model: string }).model;
    log(`[bridge] ${anthropicReq.model} → ${logModel} stream=${!!anthropicReq.stream} tools=${anthropicReq.tools?.length ?? 0} format=${isResponses ? 'responses' : 'chat_completions'}`);

    // 5. Forward to upstream
    const upstreamUrl = isResponses
      ? `${baseUrl}/responses`
      : `${baseUrl}/chat/completions`;

    // Pattern 1: the AbortController's lifetime now spans the entire stream,
    // not just the headers-arrival phase. The previous code cleared the
    // timeout (which also released our handle on the controller for any
    // post-headers cancellation) right after `await fetch`, so neither a
    // downstream cancel nor an idle timeout could reach the upstream socket
    // mid-stream — we just kept reading until the body ended naturally.
    const controller = new AbortController();
    const headersTimer = setTimeout(
      () => controller.abort(new Error(`Upstream headers timeout after ${timeout}ms`)),
      timeout,
    );

    // Forward downstream request abort (renderer cancelled, /v1/messages
    // request signal aborted) to the upstream fetch. The Hono handler's
    // `request.signal` is the parent.
    const onDownstreamAbort = (): void => {
      try {
        controller.abort(new Error('Downstream request aborted'));
      } catch { /* ignore */ }
    };
    if (request.signal) {
      if (request.signal.aborted) {
        onDownstreamAbort();
      } else {
        request.signal.addEventListener('abort', onDownstreamAbort, { once: true });
      }
    }

    let upstreamResp: Response;
    try {
      // Detect proxy for upstream URL (reads from sidecar's process.env, respects no_proxy)
      const proxyUrl = getProxyForUrl(upstreamUrl);
      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${effectiveApiKey}`,
        },
        body: JSON.stringify(translatedReq),
        signal: controller.signal,
      };
      if (proxyUrl) {
        fetchInit.dispatcher = getDispatcherForProxy(proxyUrl);
      }
      // Cast to global Response — undici.Response is structurally identical at
      // runtime; the type drift is only in @types/node vs undici/types Headers
      // iterators. Downstream handlers (handleStreamResponse etc.) treat the
      // body as a ReadableStream<Uint8Array>, which works for both shapes.
      upstreamResp = await fetch(upstreamUrl, fetchInit as Parameters<typeof fetch>[1]) as unknown as Response;
    } catch (err) {
      clearTimeout(headersTimer);
      if (request.signal) {
        request.signal.removeEventListener('abort', onDownstreamAbort);
      }
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      // undici surfaces the real reason on `err.cause` (TypeError: fetch failed
      // is the wrapper). Inline the cause so logs aren't useless.
      const causeRaw = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      const causeMsg = causeRaw instanceof Error ? causeRaw.message : (causeRaw ? String(causeRaw) : '');
      const baseMsg = err instanceof Error ? err.message : String(err);
      const errMsg = causeMsg ? `${baseMsg} (cause: ${causeMsg})` : baseMsg;
      log(`[bridge] Upstream ${isTimeout ? 'timeout' : 'error'}: ${errMsg}`);
      // Record for verify-timeout diagnostics (see getLastBridgeError docstring).
      // Only the connect-layer catch path — HTTP error responses (!upstreamResp.ok)
      // are already surfaced through the SDK's assistant.error path to verify.
      lastBridgeError = { message: errMsg, timestamp: Date.now(), upstreamUrl };
      return jsonError(
        isTimeout ? 408 : 502,
        'api_error',
        isTimeout ? 'Upstream request timed out' : `Upstream connection error: ${errMsg}`,
      );
    }

    // 6. Handle upstream errors
    if (!upstreamResp.ok) {
      clearTimeout(headersTimer);
      if (request.signal) {
        request.signal.removeEventListener('abort', onDownstreamAbort);
      }
      const errBody = await upstreamResp.text();
      log(`[bridge] Upstream error ${upstreamResp.status}: ${errBody.slice(0, 300)}`);
      const { status, body } = translateError(upstreamResp.status, errBody);
      if (status !== upstreamResp.status) {
        log(`[bridge] Remapped ${upstreamResp.status} → ${status} (${body.error.type})`);
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Headers arrived → cancel the headers timeout (we now switch to per-read
    // idle timeout inside the stream handler). The controller stays live for
    // the stream's lifetime so cancel() can reach it.
    clearTimeout(headersTimer);

    // 7. Detect Content-Type to handle unexpected SSE on non-stream requests
    const contentType = upstreamResp.headers.get('content-type') ?? '';
    const isSSEResponse = contentType.includes('text/event-stream');

    // 8. Translate response
    if (anthropicReq.stream || isSSEResponse) {
      // Stream response (or non-stream request that got SSE back — auto-fallback)
      if (isSSEResponse && !anthropicReq.stream) {
        log('[bridge] Non-stream request received SSE response — auto-falling back to stream processing');
      }
      // Hand off lifecycle ownership to the stream handler — it owns:
      //  - controller (so stream.cancel() can abort upstream fetch)
      //  - request.signal listener cleanup
      //  - idle timeout enforcement (60s)
      return isResponses
        ? handleResponsesStreamResponse(upstreamResp, anthropicReq.model, log, controller, request.signal, onDownstreamAbort)
        : handleStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log, thoughtSignatureCache, controller, request.signal, onDownstreamAbort);
    } else {
      // Non-stream branch: response body is read with a single await; the
      // request.signal listener can be detached now (controller lives only
      // through the body read, which translateXxxResponse owns).
      if (request.signal) {
        request.signal.removeEventListener('abort', onDownstreamAbort);
      }
      return isResponses
        ? handleResponsesNonStreamResponse(upstreamResp, anthropicReq.model, log)
        : handleNonStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log, thoughtSignatureCache);
    }
  };

  // Expose cache seeding for session resume (thought_signatures from persisted history)
  // Uses cacheThoughtSignatures() to enforce THOUGHT_SIG_CACHE_MAX consistently.
  handler.seedThoughtSignatures = (entries: Array<{ id: string; thought_signature: string }>) => {
    cacheThoughtSignatures(entries, thoughtSignatureCache, THOUGHT_SIG_CACHE_MAX);
    if (entries.length > 0) {
      log(`[bridge] Seeded ${entries.length} thought_signature(s) from session history`);
    }
  };

  // Safe: function object with an attached method property matches BridgeHandler's callable + method shape
  return handler as BridgeHandler;
}

async function handleNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
  thoughtSignatureCache?: Map<string, string>,
): Promise<Response> {
  // Use text() + manual JSON.parse to tolerate non-standard Content-Type
  let openaiResp: OpenAIResponse;
  try {
    const text = await upstreamResp.text();
    openaiResp = JSON.parse(text) as OpenAIResponse;
  } catch {
    log('[bridge] Failed to parse upstream JSON response');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  // Cache thought_signatures from tool calls (Gemini thinking models)
  if (thoughtSignatureCache) {
    cacheThoughtSignatures(openaiResp.choices?.[0]?.message?.tool_calls, thoughtSignatureCache);
  }

  const anthropicResp = translateResponse(openaiResp, requestModel, translateReasoning);
  return new Response(JSON.stringify(anthropicResp), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Pattern 1: idle timeout for upstream SSE. If no bytes arrive for this many
 * milliseconds, the upstream fetch is aborted with reason='timeout'.
 * Bridge-level safety net — providers occasionally drop the TCP socket
 * silently mid-stream (no FIN), and without an idle bound we'd block on
 * `reader.read()` forever.
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

function handleStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
  thoughtSignatureCache: Map<string, string> | undefined,
  upstreamController: AbortController,
  downstreamSignal: AbortSignal | undefined,
  onDownstreamAbort: () => void,
): Response {
  // Pattern 2 §2.3.3 — TransformStream pipeline replaces the manual
  // ReadableStream { start } loop. The pipeline is:
  //
  //   upstream body  ── pipeThrough ──> sseParseTransform ──> translateTransform ──> response.body
  //
  // Backpressure: when the downstream (Hono response → Rust proxy → renderer)
  // is slow, `pipeThrough` automatically applies pull pressure on the upstream
  // reader through the chain. We don't need to manually check desiredSize —
  // the readable side of each TransformStream stops calling transform() once
  // its internal queue fills up, which in turn stops the upstream reader.
  //
  // Cancellation: downstream cancel propagates via the readable's cancel(),
  // which we wire to abort the upstream fetch (Pattern 1's protocol).
  const translator = new StreamTranslator(requestModel, translateReasoning);
  const sseParser = new SSEParser();
  if (!upstreamResp.body) {
    return new Response('', { status: 200, headers: streamHeaders() });
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`[bridge] Upstream idle ${UPSTREAM_IDLE_TIMEOUT_MS}ms — aborting (reason=timeout)`);
      try { upstreamController.abort(new Error('Upstream idle timeout')); } catch { /* ignore */ }
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const cleanupIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const detachDownstream = (): void => {
    if (downstreamSignal) {
      try { downstreamSignal.removeEventListener('abort', onDownstreamAbort); } catch { /* ignore */ }
    }
  };

  // Stage 1: bytes → SSE events (parse via SSEParser).
  const decoder = new TextDecoder();
  const sseParseTransform = new TransformStream<Uint8Array, OpenAIStreamChunk>({
    start() {
      armIdleTimer();
    },
    transform(chunk, controller) {
      armIdleTimer();
      const text = decoder.decode(chunk, { stream: true });
      const sseEvents = sseParser.feed(text);
      for (const sseEvent of sseEvents) {
        if (sseEvent.data === '[DONE]') continue;
        try {
          controller.enqueue(JSON.parse(sseEvent.data) as OpenAIStreamChunk);
        } catch {
          // Skip malformed chunks
        }
      }
    },
    flush() {
      cleanupIdleTimer();
    },
  });

  // Stage 2: OpenAI chunks → Anthropic events.
  const encoder = new TextEncoder();
  const translateTransform = new TransformStream<OpenAIStreamChunk, Uint8Array>({
    transform(chunk, controller) {
      // Cache thought_signatures from streaming tool call chunks (Gemini thinking models).
      if (thoughtSignatureCache) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              const sig = tc.thought_signature
                || tc.extra_content?.google?.thought_signature;
              if (sig) {
                thoughtSignatureCache.set(tc.id, sig);
                log(`[bridge] Cached thought_signature for ${tc.id} (len=${sig.length})`);
              }
            }
          }
          // Evict oldest if over cap
          if (thoughtSignatureCache.size > THOUGHT_SIG_CACHE_MAX) {
            const excess = thoughtSignatureCache.size - THOUGHT_SIG_CACHE_MAX;
            const iter = thoughtSignatureCache.keys();
            for (let i = 0; i < excess; i++) {
              thoughtSignatureCache.delete(iter.next().value!);
            }
          }
        }
      }
      const anthropicEvents = translator.feed(chunk);
      for (const event of anthropicEvents) {
        controller.enqueue(encoder.encode(formatSSE(event)));
      }
    },
    flush(controller) {
      // Emit closing events for incomplete streams (no-op if already finished).
      const finalEvents = translator.finalize();
      for (const event of finalEvents) {
        controller.enqueue(encoder.encode(formatSSE(event)));
      }
      detachDownstream();
    },
  });

  // Compose the pipeline. piped through cancels propagate up through
  // pipeThrough; failures in either transform are caught when the consumer
  // reads the response body, which Hono surfaces as a 500.
  const upstreamReadable = upstreamResp.body;
  const finalReadable = upstreamReadable
    .pipeThrough(sseParseTransform)
    .pipeThrough(translateTransform);

  // Wrap once more to catch downstream cancellation and route it back to the
  // upstream AbortController. pipeThrough() forwards cancel() through each
  // stage, but our Pattern 1 contract demands we ALSO abort the upstream
  // fetch, which neither TransformStream knows about.
  //
  // Backpressure: drive the read loop from `pull()` rather than recursing
  // unconditionally after each enqueue. Web Streams calls `pull` once per
  // "queue has room"; if we recurse after enqueue we drain the upstream as
  // fast as it produces and the pipeline's natural backpressure is silently
  // broken (the queue grows unbounded).
  const reader = finalReadable.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { controller.close(); } catch { /* ignore */ }
          cleanupIdleTimer();
          // Fix #8: detach the downstream-abort listener on the done path
          // too. Without this, request.signal kept a strong ref to
          // onDownstreamAbort until GC, leaking listeners across streamed
          // sessions. Also covers the "upstream errored before any chunk"
          // case — pull sees done:true immediately and the listener would
          // otherwise survive until process exit.
          detachDownstream();
          return;
        }
        controller.enqueue(value);
        // Don't recurse — Web Streams will call pull() again when desiredSize > 0.
      } catch (err) {
        log(`[bridge] Stream error: ${err}`);
        try { controller.error(err); } catch { /* ignore */ }
        cleanupIdleTimer();
        detachDownstream();
      }
    },
    cancel(reason): void {
      const reasonStr = reason instanceof Error ? reason.message : String(reason ?? 'unknown');
      log(`[bridge] Downstream cancelled stream: ${reasonStr.slice(0, 200)}`);
      cleanupIdleTimer();
      detachDownstream();
      try { upstreamController.abort(new Error('Downstream cancel')); } catch { /* ignore */ }
      try {
        // Cancel the composed pipe — this propagates to the SSE parse
        // transform's source (the upstream body reader) automatically.
        finalReadable.cancel(reason).catch((e) => {
          // Fix #8: surface (debug) the "stream is locked" path that the
          // legacy code silently swallowed — we still don't want it as a
          // warning (cancel after pipeThrough often hits this), but
          // observable for diagnostics.
          console.debug(`[bridge] cancel() on finalReadable failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch { /* ignore */ }
    },
  });

  return new Response(guarded, {
    status: 200,
    headers: streamHeaders(),
  });
}

function streamHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };
}

// ==================== Responses API handlers ====================

async function handleResponsesNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  log: (msg: string) => void,
): Promise<Response> {
  let responsesResp: ResponsesResponse;
  try {
    const text = await upstreamResp.text();
    responsesResp = JSON.parse(text) as ResponsesResponse;
  } catch {
    log('[bridge] Failed to parse upstream Responses JSON');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  try {
    const anthropicResp = translateResponsesResponse(responsesResp, requestModel);
    return new Response(JSON.stringify(anthropicResp), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof ResponsesApiError) {
      log(`[bridge] Responses API failed: [${err.code}] ${err.message}`);
      return jsonError(502, err.code, err.message);
    }
    throw err;
  }
}

function handleResponsesStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  log: (msg: string) => void,
  upstreamController: AbortController,
  downstreamSignal: AbortSignal | undefined,
  onDownstreamAbort: () => void,
): Response {
  // Pattern 2 §2.3.3 — TransformStream pipeline (mirror of handleStreamResponse).
  const translator = new ResponsesStreamTranslator(requestModel);
  const sseParser = new SSEParser();
  if (!upstreamResp.body) {
    return new Response('', { status: 200, headers: streamHeaders() });
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`[bridge] Upstream Responses idle ${UPSTREAM_IDLE_TIMEOUT_MS}ms — aborting (reason=timeout)`);
      try { upstreamController.abort(new Error('Upstream idle timeout')); } catch { /* ignore */ }
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const cleanupIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const detachDownstream = (): void => {
    if (downstreamSignal) {
      try { downstreamSignal.removeEventListener('abort', onDownstreamAbort); } catch { /* ignore */ }
    }
  };

  const decoder = new TextDecoder();
  const sseParseTransform = new TransformStream<Uint8Array, ResponsesStreamEvent>({
    start() { armIdleTimer(); },
    transform(chunk, controller) {
      armIdleTimer();
      const text = decoder.decode(chunk, { stream: true });
      const sseEvents = sseParser.feed(text);
      for (const sseEvent of sseEvents) {
        if (sseEvent.data === '[DONE]') continue;
        try {
          controller.enqueue(JSON.parse(sseEvent.data) as ResponsesStreamEvent);
        } catch {
          /* skip malformed */
        }
      }
    },
    flush() { cleanupIdleTimer(); },
  });

  const encoder = new TextEncoder();
  const translateTransform = new TransformStream<ResponsesStreamEvent, Uint8Array>({
    transform(event, controller) {
      const anthropicEvents = translator.feed(event);
      for (const ae of anthropicEvents) {
        controller.enqueue(encoder.encode(formatSSE(ae)));
      }
    },
    flush(controller) {
      const finalEvents = translator.finalize();
      for (const event of finalEvents) {
        controller.enqueue(encoder.encode(formatSSE(event)));
      }
      detachDownstream();
    },
  });

  const finalReadable = upstreamResp.body
    .pipeThrough(sseParseTransform)
    .pipeThrough(translateTransform);

  // Backpressure: pull-driven, see notes in handleStreamResponse.
  const reader = finalReadable.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { controller.close(); } catch { /* ignore */ }
          cleanupIdleTimer();
          // Fix #8: detach downstream listener on done too — covers both
          // normal completion and "upstream errored before any chunk" path
          // (immediate done:true without a flush).
          detachDownstream();
          return;
        }
        controller.enqueue(value);
        // Don't recurse — Web Streams will call pull() again when desiredSize > 0.
      } catch (err) {
        log(`[bridge] Responses stream error: ${err}`);
        try { controller.error(err); } catch { /* ignore */ }
        cleanupIdleTimer();
        detachDownstream();
      }
    },
    cancel(reason): void {
      const reasonStr = reason instanceof Error ? reason.message : String(reason ?? 'unknown');
      log(`[bridge] Downstream cancelled Responses stream: ${reasonStr.slice(0, 200)}`);
      cleanupIdleTimer();
      detachDownstream();
      try { upstreamController.abort(new Error('Downstream cancel')); } catch { /* ignore */ }
      try {
        finalReadable.cancel(reason).catch((e) => {
          console.debug(`[bridge] cancel() on Responses finalReadable failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch { /* ignore */ }
    },
  });

  return new Response(guarded, {
    status: 200,
    headers: streamHeaders(),
  });
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Extract and cache thought_signatures from tool calls (non-stream response).
 * Checks both direct thought_signature and extra_content.google.thought_signature (Gemini OpenAI-compat). */
function cacheThoughtSignatures(
  toolCalls: { id: string; thought_signature?: string; extra_content?: { google?: { thought_signature?: string } } }[] | undefined,
  cache: Map<string, string>,
  maxSize = THOUGHT_SIG_CACHE_MAX,
): void {
  if (!toolCalls) return;
  for (const tc of toolCalls) {
    const sig = tc.thought_signature || tc.extra_content?.google?.thought_signature;
    if (tc.id && sig) {
      cache.set(tc.id, sig);
    }
  }
  // Evict oldest entries if cache exceeds max size
  if (cache.size > maxSize) {
    const excess = cache.size - maxSize;
    const iter = cache.keys();
    for (let i = 0; i < excess; i++) {
      cache.delete(iter.next().value!);
    }
  }
}
