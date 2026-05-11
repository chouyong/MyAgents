// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/interactive-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/interactive-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function reduceInteractiveReply() { _w('reduceInteractiveReply'); return undefined; }
export function hasInteractiveReplyBlocks() { _w('hasInteractiveReplyBlocks'); return false; }
export function hasMessagePresentationBlocks() { _w('hasMessagePresentationBlocks'); return false; }
export function hasReplyChannelData() { _w('hasReplyChannelData'); return false; }
export function hasReplyContent() { _w('hasReplyContent'); return false; }
export function interactiveReplyToPresentation() { _w('interactiveReplyToPresentation'); return undefined; }
export function normalizeMessagePresentation() { _w('normalizeMessagePresentation'); return ""; }
export function normalizeInteractiveReply() { _w('normalizeInteractiveReply'); return ""; }
export function presentationToInteractiveReply() { _w('presentationToInteractiveReply'); return undefined; }
export function renderMessagePresentationFallbackText() { _w('renderMessagePresentationFallbackText'); return undefined; }
export function resolveInteractiveTextFallback() { _w('resolveInteractiveTextFallback'); return undefined; }
