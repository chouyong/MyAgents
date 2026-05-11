// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-envelope.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-envelope.' + fn + '() not implemented in Bridge mode'); }
}

export function formatInboundEnvelope() { _w('formatInboundEnvelope'); return ""; }
export function resolveEnvelopeFormatOptions() { _w('resolveEnvelopeFormatOptions'); return undefined; }
