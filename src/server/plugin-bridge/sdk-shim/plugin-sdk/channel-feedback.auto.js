// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-feedback.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-feedback.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveAckReaction() { _w('resolveAckReaction'); return undefined; }
export function createAckReactionHandle() { _w('createAckReactionHandle'); return undefined; }
export function removeAckReactionHandleAfterReply() { _w('removeAckReactionHandleAfterReply'); return undefined; }
