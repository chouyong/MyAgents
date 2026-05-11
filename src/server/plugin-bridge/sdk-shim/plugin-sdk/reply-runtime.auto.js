// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/reply-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/reply-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function chunkMarkdownText() { _w('chunkMarkdownText'); return undefined; }
export function dispatchInboundMessage() { _w('dispatchInboundMessage'); return undefined; }
export function normalizeGroupActivation() { _w('normalizeGroupActivation'); return ""; }
export const HEARTBEAT_PROMPT = undefined;
export function resolveHeartbeatReplyPayload() { _w('resolveHeartbeatReplyPayload'); return undefined; }
export function getReplyFromConfig() { _w('getReplyFromConfig'); return undefined; }
export const HEARTBEAT_TOKEN = undefined;
export function isAbortRequestText() { _w('isAbortRequestText'); return false; }
export function isBtwRequestText() { _w('isBtwRequestText'); return false; }
export function resetInboundDedupe() { _w('resetInboundDedupe'); return undefined; }
export function finalizeInboundContext() { _w('finalizeInboundContext'); return undefined; }
export function createInboundDebouncer() { _w('createInboundDebouncer'); return undefined; }
export function resolveInboundDebounceMs() { _w('resolveInboundDebounceMs'); return undefined; }
export function dispatchReplyWithBufferedBlockDispatcher() { _w('dispatchReplyWithBufferedBlockDispatcher'); return undefined; }
export function createReplyDispatcher() { _w('createReplyDispatcher'); return undefined; }
export function createReplyReferencePlanner() { _w('createReplyReferencePlanner'); return undefined; }
export function generateConversationLabel() { _w('generateConversationLabel'); return undefined; }
