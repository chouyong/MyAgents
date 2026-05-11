// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-logging.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-logging.' + fn + '() not implemented in Bridge mode'); }
}

export function logAckFailure() { _w('logAckFailure'); return undefined; }
export function logInboundDrop() { _w('logInboundDrop'); return undefined; }
export function logTypingFailure() { _w('logTypingFailure'); return undefined; }
