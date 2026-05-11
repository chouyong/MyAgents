// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/direct-dm-access.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/direct-dm-access.' + fn + '() not implemented in Bridge mode'); }
}

export async function resolveInboundDirectDmAccessWithRuntime() { _w('resolveInboundDirectDmAccessWithRuntime'); return undefined; }
export function createPreCryptoDirectDmAuthorizer() { _w('createPreCryptoDirectDmAuthorizer'); return undefined; }
