// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-plugin-common.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-plugin-common.' + fn + '() not implemented in Bridge mode'); }
}

export function buildChannelConfigSchema() { _w('buildChannelConfigSchema'); return undefined; }
export function clearAccountEntryFields() { _w('clearAccountEntryFields'); return undefined; }
