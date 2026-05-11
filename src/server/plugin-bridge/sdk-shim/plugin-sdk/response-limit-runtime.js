// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/response-limit-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/response-limit-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function readResponseWithLimit() { _w('readResponseWithLimit'); return undefined; }
