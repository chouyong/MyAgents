// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/transport-ready-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/transport-ready-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function waitForTransportReady() { _w('waitForTransportReady'); return undefined; }
