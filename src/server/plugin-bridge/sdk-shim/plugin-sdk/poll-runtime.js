// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/poll-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/poll-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function normalizePollDurationHours() { _w('normalizePollDurationHours'); return ""; }
export function normalizePollInput() { _w('normalizePollInput'); return ""; }
export function resolvePollMaxSelections() { _w('resolvePollMaxSelections'); return undefined; }
