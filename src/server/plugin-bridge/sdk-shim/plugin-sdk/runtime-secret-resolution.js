// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/runtime-secret-resolution.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime-secret-resolution.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveCommandSecretRefsViaGateway() { _w('resolveCommandSecretRefsViaGateway'); return undefined; }
export function getChannelsCommandSecretTargetIds() { _w('getChannelsCommandSecretTargetIds'); return undefined; }
export function resolveSecretRefValues() { _w('resolveSecretRefValues'); return undefined; }
export function applyResolvedAssignments() { _w('applyResolvedAssignments'); return undefined; }
export function createResolverContext() { _w('createResolverContext'); return undefined; }
