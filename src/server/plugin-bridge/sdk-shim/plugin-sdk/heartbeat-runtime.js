// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/heartbeat-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/heartbeat-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveIndicatorType() { _w('resolveIndicatorType'); return undefined; }
export function emitHeartbeatEvent() { _w('emitHeartbeatEvent'); return undefined; }
export function onHeartbeatEvent() { _w('onHeartbeatEvent'); return undefined; }
export function getLastHeartbeatEvent() { _w('getLastHeartbeatEvent'); return undefined; }
export function resetHeartbeatEventsForTest() { _w('resetHeartbeatEventsForTest'); return undefined; }
export function resolveHeartbeatVisibility() { _w('resolveHeartbeatVisibility'); return undefined; }
