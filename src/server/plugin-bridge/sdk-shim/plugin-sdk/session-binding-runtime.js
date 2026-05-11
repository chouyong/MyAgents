// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/session-binding-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/session-binding-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function __testing() { _w('__testing'); return undefined; }
export function getSessionBindingService() { _w('getSessionBindingService'); return undefined; }
export function registerSessionBindingAdapter() { _w('registerSessionBindingAdapter'); return undefined; }
