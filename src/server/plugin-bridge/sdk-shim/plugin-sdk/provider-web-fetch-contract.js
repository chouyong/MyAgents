// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-web-fetch-contract.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-web-fetch-contract.' + fn + '() not implemented in Bridge mode'); }
}

export function enablePluginInConfig() { _w('enablePluginInConfig'); return undefined; }
