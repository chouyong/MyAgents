// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/plugin-entry.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/plugin-entry.' + fn + '() not implemented in Bridge mode'); }
}

export function buildPluginConfigSchema() { _w('buildPluginConfigSchema'); return undefined; }
export function emptyPluginConfigSchema() { _w('emptyPluginConfigSchema'); return undefined; }
