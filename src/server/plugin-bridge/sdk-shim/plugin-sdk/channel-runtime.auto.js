// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function normalizeChannelId() { _w('normalizeChannelId'); return ""; }
export function enqueueSystemEvent() { _w('enqueueSystemEvent'); return undefined; }
export function resetSystemEventsForTest() { _w('resetSystemEventsForTest'); return undefined; }
export function recordChannelActivity() { _w('recordChannelActivity'); return undefined; }
export function resolveIndicatorType() { _w('resolveIndicatorType'); return undefined; }
export function emitHeartbeatEvent() { _w('emitHeartbeatEvent'); return undefined; }
export function onHeartbeatEvent() { _w('onHeartbeatEvent'); return undefined; }
export function getLastHeartbeatEvent() { _w('getLastHeartbeatEvent'); return undefined; }
export function resetHeartbeatEventsForTest() { _w('resetHeartbeatEventsForTest'); return undefined; }
export function resolveHeartbeatVisibility() { _w('resolveHeartbeatVisibility'); return undefined; }
export async function waitForTransportReady() { _w('waitForTransportReady'); return undefined; }
