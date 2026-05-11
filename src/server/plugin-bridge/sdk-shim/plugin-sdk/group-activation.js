// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/group-activation.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/group-activation.' + fn + '() not implemented in Bridge mode'); }
}

export function normalizeGroupActivation() { _w('normalizeGroupActivation'); return ""; }
export function parseActivationCommand() { _w('parseActivationCommand'); return undefined; }
