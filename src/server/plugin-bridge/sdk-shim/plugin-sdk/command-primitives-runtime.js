// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/command-primitives-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/command-primitives-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function isAbortRequestText() { _w('isAbortRequestText'); return false; }
export function isBtwRequestText() { _w('isBtwRequestText'); return false; }
