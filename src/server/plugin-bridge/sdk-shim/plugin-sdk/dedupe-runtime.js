// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/dedupe-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/dedupe-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function createDedupeCache() { _w('createDedupeCache'); return undefined; }
export function resolveGlobalDedupeCache() { _w('resolveGlobalDedupeCache'); return undefined; }
