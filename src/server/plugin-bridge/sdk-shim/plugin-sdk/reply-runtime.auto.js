// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/reply-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/reply-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function createInboundDebouncer() { _w('createInboundDebouncer'); return undefined; }
export function resolveInboundDebounceMs() { _w('resolveInboundDebounceMs'); return undefined; }
export function generateConversationLabel() { _w('generateConversationLabel'); return undefined; }
