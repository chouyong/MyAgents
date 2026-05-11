// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/allow-from.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/allow-from.' + fn + '() not implemented in Bridge mode'); }
}

export function formatAllowFromLowercase() { _w('formatAllowFromLowercase'); return ""; }
export function compileAllowlist() { _w('compileAllowlist'); return undefined; }
export function firstDefined() { _w('firstDefined'); return undefined; }
export function addAllowlistUserEntriesFromConfigEntry() { _w('addAllowlistUserEntriesFromConfigEntry'); return undefined; }
