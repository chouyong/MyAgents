// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-activity-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-activity-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function recordChannelActivity() { _w('recordChannelActivity'); return undefined; }
