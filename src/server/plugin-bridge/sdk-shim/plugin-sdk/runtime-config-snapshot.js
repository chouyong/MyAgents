// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/runtime-config-snapshot.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime-config-snapshot.' + fn + '() not implemented in Bridge mode'); }
}

export function clearRuntimeConfigSnapshot() { _w('clearRuntimeConfigSnapshot'); return undefined; }
export function getRuntimeConfigSnapshot() { _w('getRuntimeConfigSnapshot'); return undefined; }
export function selectApplicableRuntimeConfig() { _w('selectApplicableRuntimeConfig'); return undefined; }
export function setRuntimeConfigSnapshot() { _w('setRuntimeConfigSnapshot'); return undefined; }
export function clearConfigCache() { _w('clearConfigCache'); return undefined; }
export function getRuntimeConfig() { _w('getRuntimeConfig'); return undefined; }
export function getRuntimeConfigSourceSnapshot() { _w('getRuntimeConfigSourceSnapshot'); return undefined; }
