// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/state-paths.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/state-paths.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveOAuthDir() { _w('resolveOAuthDir'); return undefined; }
export function resolveStateDir() { _w('resolveStateDir'); return undefined; }
export const STATE_DIR = undefined;
export function resolveRequiredHomeDir() { _w('resolveRequiredHomeDir'); return undefined; }
