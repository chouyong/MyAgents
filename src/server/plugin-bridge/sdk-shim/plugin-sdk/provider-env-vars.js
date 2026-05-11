// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-env-vars.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-env-vars.' + fn + '() not implemented in Bridge mode'); }
}

export function getProviderEnvVars() { _w('getProviderEnvVars'); return undefined; }
export function listKnownProviderAuthEnvVarNames() { _w('listKnownProviderAuthEnvVarNames'); return []; }
export function omitEnvKeysCaseInsensitive() { _w('omitEnvKeysCaseInsensitive'); return undefined; }
export function resolveProviderAuthEnvVarCandidates() { _w('resolveProviderAuthEnvVarCandidates'); return undefined; }
