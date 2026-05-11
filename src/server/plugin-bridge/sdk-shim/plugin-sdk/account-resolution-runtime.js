// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/account-resolution-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/account-resolution-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveMergedAccountConfig() { _w('resolveMergedAccountConfig'); return undefined; }
export function resolveNormalizedAccountEntry() { _w('resolveNormalizedAccountEntry'); return undefined; }
export function listConfiguredAccountIds() { _w('listConfiguredAccountIds'); return []; }
