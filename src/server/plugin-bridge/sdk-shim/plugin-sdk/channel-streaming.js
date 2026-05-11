// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-streaming.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-streaming.' + fn + '() not implemented in Bridge mode'); }
}

export function getChannelStreamingConfigObject() { _w('getChannelStreamingConfigObject'); return undefined; }
export function resolveChannelStreamingChunkMode() { _w('resolveChannelStreamingChunkMode'); return undefined; }
export function resolveChannelStreamingBlockEnabled() { _w('resolveChannelStreamingBlockEnabled'); return undefined; }
export function resolveChannelStreamingBlockCoalesce() { _w('resolveChannelStreamingBlockCoalesce'); return undefined; }
export function resolveChannelStreamingPreviewChunk() { _w('resolveChannelStreamingPreviewChunk'); return undefined; }
export function resolveChannelStreamingPreviewToolProgress() { _w('resolveChannelStreamingPreviewToolProgress'); return undefined; }
export function resolveChannelStreamingNativeTransport() { _w('resolveChannelStreamingNativeTransport'); return undefined; }
export function resolveChannelPreviewStreamMode() { _w('resolveChannelPreviewStreamMode'); return undefined; }
