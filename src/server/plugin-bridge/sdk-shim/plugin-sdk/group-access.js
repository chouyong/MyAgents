// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/group-access.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/group-access.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveSenderScopedGroupPolicy() { _w('resolveSenderScopedGroupPolicy'); return undefined; }
export function evaluateGroupRouteAccessForPolicy() { _w('evaluateGroupRouteAccessForPolicy'); return undefined; }
export function evaluateMatchedGroupAccessForPolicy() { _w('evaluateMatchedGroupAccessForPolicy'); return undefined; }
export function evaluateSenderGroupAccessForPolicy() { _w('evaluateSenderGroupAccessForPolicy'); return undefined; }
export function evaluateSenderGroupAccess() { _w('evaluateSenderGroupAccess'); return undefined; }
export function resolveOpenProviderRuntimeGroupPolicy() { _w('resolveOpenProviderRuntimeGroupPolicy'); return undefined; }
