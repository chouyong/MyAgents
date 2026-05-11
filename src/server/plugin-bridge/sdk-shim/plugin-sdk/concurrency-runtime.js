// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/concurrency-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/concurrency-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function runTasksWithConcurrency() { _w('runTasksWithConcurrency'); return undefined; }
