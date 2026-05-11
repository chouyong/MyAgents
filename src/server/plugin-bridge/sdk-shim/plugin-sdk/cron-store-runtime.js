// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/cron-store-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/cron-store-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function loadCronStore() { _w('loadCronStore'); return undefined; }
export function resolveCronStorePath() { _w('resolveCronStorePath'); return undefined; }
export function saveCronStore() { _w('saveCronStore'); return undefined; }
