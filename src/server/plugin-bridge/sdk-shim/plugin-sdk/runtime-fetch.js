// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/runtime-fetch.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime-fetch.' + fn + '() not implemented in Bridge mode'); }
}

export function fetchWithRuntimeDispatcher() { _w('fetchWithRuntimeDispatcher'); return undefined; }
export function fetchWithRuntimeDispatcherOrMockedGlobal() { _w('fetchWithRuntimeDispatcherOrMockedGlobal'); return undefined; }
export function isMockedFetch() { _w('isMockedFetch'); return false; }
