// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/reply-chunking.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/reply-chunking.' + fn + '() not implemented in Bridge mode'); }
}

export function chunkText() { _w('chunkText'); return undefined; }
export function chunkTextWithMode() { _w('chunkTextWithMode'); return undefined; }
export function chunkMarkdownTextWithMode() { _w('chunkMarkdownTextWithMode'); return undefined; }
export function resolveChunkMode() { _w('resolveChunkMode'); return undefined; }
export function resolveTextChunkLimit() { _w('resolveTextChunkLimit'); return undefined; }
export function isSilentReplyPayloadText() { _w('isSilentReplyPayloadText'); return false; }
export function isSilentReplyText() { _w('isSilentReplyText'); return false; }
export const SILENT_REPLY_TOKEN = undefined;
