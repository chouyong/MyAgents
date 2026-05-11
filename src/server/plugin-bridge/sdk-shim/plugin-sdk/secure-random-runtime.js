// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/secure-random-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/secure-random-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function generateSecureToken() { _w('generateSecureToken'); return undefined; }
export function generateSecureUuid() { _w('generateSecureUuid'); return undefined; }
