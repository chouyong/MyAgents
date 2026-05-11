// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-route.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-route.' + fn + '() not implemented in Bridge mode'); }
}

export function normalizeRouteThreadId() { _w('normalizeRouteThreadId'); return ""; }
export function stringifyRouteThreadId() { _w('stringifyRouteThreadId'); return undefined; }
export function normalizeChannelRouteRef() { _w('normalizeChannelRouteRef'); return ""; }
export function channelRouteTarget() { _w('channelRouteTarget'); return undefined; }
export function channelRouteThreadId() { _w('channelRouteThreadId'); return undefined; }
export function normalizeChannelRouteTarget() { _w('normalizeChannelRouteTarget'); return ""; }
export function resolveChannelRouteTargetWithParser() { _w('resolveChannelRouteTargetWithParser'); return undefined; }
export function channelRouteDedupeKey() { _w('channelRouteDedupeKey'); return undefined; }
export function channelRouteIdentityKey() { _w('channelRouteIdentityKey'); return undefined; }
export function channelRoutesMatchExact() { _w('channelRoutesMatchExact'); return undefined; }
export function channelRoutesShareConversation() { _w('channelRoutesShareConversation'); return undefined; }
export function channelRouteTargetsMatchExact() { _w('channelRouteTargetsMatchExact'); return undefined; }
export function channelRouteTargetsShareConversation() { _w('channelRouteTargetsShareConversation'); return undefined; }
export function channelRouteCompactKey() { _w('channelRouteCompactKey'); return undefined; }
export function channelRouteKey() { _w('channelRouteKey'); return undefined; }
