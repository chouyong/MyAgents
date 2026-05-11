// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/outbound-send-deps.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/outbound-send-deps.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveLegacyOutboundSendDepKeys() { _w('resolveLegacyOutboundSendDepKeys'); return undefined; }
export function resolveOutboundSendDep() { _w('resolveOutboundSendDep'); return undefined; }
