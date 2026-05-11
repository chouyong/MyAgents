// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/context-visibility-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/context-visibility-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveChannelContextVisibilityMode() { _w('resolveChannelContextVisibilityMode'); return undefined; }
export function resolveDefaultContextVisibility() { _w('resolveDefaultContextVisibility'); return undefined; }
export function evaluateSupplementalContextVisibility() { _w('evaluateSupplementalContextVisibility'); return undefined; }
export function filterSupplementalContextItems() { _w('filterSupplementalContextItems'); return undefined; }
export function shouldIncludeSupplementalContext() { _w('shouldIncludeSupplementalContext'); return false; }
