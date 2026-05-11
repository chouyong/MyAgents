// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/thread-bindings-session-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/thread-bindings-session-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveThreadBindingFarewellText() { _w('resolveThreadBindingFarewellText'); return undefined; }
export function resolveThreadBindingLifecycle() { _w('resolveThreadBindingLifecycle'); return undefined; }
export function registerSessionBindingAdapter() { _w('registerSessionBindingAdapter'); return undefined; }
export function unregisterSessionBindingAdapter() { _w('unregisterSessionBindingAdapter'); return undefined; }
