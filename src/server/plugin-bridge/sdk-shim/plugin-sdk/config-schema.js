// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/config-schema.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/config-schema.' + fn + '() not implemented in Bridge mode'); }
}

export const OpenClawSchema = undefined;
export function validateJsonSchemaValue() { _w('validateJsonSchemaValue'); return undefined; }
