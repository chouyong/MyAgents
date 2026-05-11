// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/command-gating.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/command-gating.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveCommandAuthorizedFromAuthorizers() { _w('resolveCommandAuthorizedFromAuthorizers'); return undefined; }
export function resolveControlCommandGate() { _w('resolveControlCommandGate'); return undefined; }
export function resolveDualTextControlCommandGate() { _w('resolveDualTextControlCommandGate'); return undefined; }
