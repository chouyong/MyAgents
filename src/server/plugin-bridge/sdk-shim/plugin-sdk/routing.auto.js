// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/routing.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/routing.' + fn + '() not implemented in Bridge mode'); }
}

export function isAcpSessionKey() { _w('isAcpSessionKey'); return false; }
export function parseThreadSessionSuffix() { _w('parseThreadSessionSuffix'); return undefined; }
