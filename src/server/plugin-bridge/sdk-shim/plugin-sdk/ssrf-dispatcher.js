// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/ssrf-dispatcher.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/ssrf-dispatcher.' + fn + '() not implemented in Bridge mode'); }
}

export function closeDispatcher() { _w('closeDispatcher'); return undefined; }
export function createPinnedDispatcher() { _w('createPinnedDispatcher'); return undefined; }
export function resolvePinnedHostnameWithPolicy() { _w('resolvePinnedHostnameWithPolicy'); return undefined; }
