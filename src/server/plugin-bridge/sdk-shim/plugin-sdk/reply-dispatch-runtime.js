// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/reply-dispatch-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/reply-dispatch-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export const dispatchReplyWithBufferedBlockDispatcher = undefined;
export const dispatchReplyWithDispatcher = undefined;
export function resolveChunkMode() { _w('resolveChunkMode'); return undefined; }
export function generateConversationLabel() { _w('generateConversationLabel'); return undefined; }
export function finalizeInboundContext() { _w('finalizeInboundContext'); return undefined; }
