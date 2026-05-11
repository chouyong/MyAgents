// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/time-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/time-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function formatUtcTimestamp() { _w('formatUtcTimestamp'); return ""; }
export function formatZonedTimestamp() { _w('formatZonedTimestamp'); return ""; }
export function resolveTimezone() { _w('resolveTimezone'); return undefined; }
