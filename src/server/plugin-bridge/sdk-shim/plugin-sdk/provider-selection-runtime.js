// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-selection-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-selection-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function selectConfiguredOrAutoProvider() { _w('selectConfiguredOrAutoProvider'); return undefined; }
export function resolveProviderRawConfig() { _w('resolveProviderRawConfig'); return undefined; }
export function resolveConfiguredCapabilityProvider() { _w('resolveConfiguredCapabilityProvider'); return undefined; }
