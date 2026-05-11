// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-transport-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-transport-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function buildGuardedModelFetch() { _w('buildGuardedModelFetch'); return undefined; }
export function buildOpenAICompletionsParams() { _w('buildOpenAICompletionsParams'); return undefined; }
export function stripSystemPromptCacheBoundary() { _w('stripSystemPromptCacheBoundary'); return ""; }
export function transformTransportMessages() { _w('transformTransportMessages'); return undefined; }
export function coerceTransportToolCallArguments() { _w('coerceTransportToolCallArguments'); return undefined; }
export function createEmptyTransportUsage() { _w('createEmptyTransportUsage'); return undefined; }
export function createWritableTransportEventStream() { _w('createWritableTransportEventStream'); return undefined; }
export function failTransportStream() { _w('failTransportStream'); return undefined; }
export function finalizeTransportStream() { _w('finalizeTransportStream'); return undefined; }
export function mergeTransportHeaders() { _w('mergeTransportHeaders'); return undefined; }
export function sanitizeTransportPayloadText() { _w('sanitizeTransportPayloadText'); return ""; }
