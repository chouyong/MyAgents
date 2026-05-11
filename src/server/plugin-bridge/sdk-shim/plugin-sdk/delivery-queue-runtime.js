// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/delivery-queue-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/delivery-queue-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export async function drainPendingDeliveries() { _w('drainPendingDeliveries'); return undefined; }
