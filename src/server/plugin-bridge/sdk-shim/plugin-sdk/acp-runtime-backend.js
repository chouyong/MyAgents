// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/acp-runtime-backend.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/acp-runtime-backend.' + fn + '() not implemented in Bridge mode'); }
}

export async function tryDispatchAcpReplyHook() { _w('tryDispatchAcpReplyHook'); return undefined; }
export function AcpRuntimeError() { _w('AcpRuntimeError'); return undefined; }
export function isAcpRuntimeError() { _w('isAcpRuntimeError'); return false; }
export function getAcpRuntimeBackend() { _w('getAcpRuntimeBackend'); return undefined; }
export function registerAcpRuntimeBackend() { _w('registerAcpRuntimeBackend'); return undefined; }
export function requireAcpRuntimeBackend() { _w('requireAcpRuntimeBackend'); return undefined; }
export function unregisterAcpRuntimeBackend() { _w('unregisterAcpRuntimeBackend'); return undefined; }
