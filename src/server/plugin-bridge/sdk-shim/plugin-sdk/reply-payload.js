// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/reply-payload.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/reply-payload.' + fn + '() not implemented in Bridge mode'); }
}

export async function sendPayloadWithChunkedTextAndMedia() { _w('sendPayloadWithChunkedTextAndMedia'); return undefined; }
export async function sendPayloadMediaSequence() { _w('sendPayloadMediaSequence'); return undefined; }
export async function sendPayloadMediaSequenceOrFallback() { _w('sendPayloadMediaSequenceOrFallback'); return undefined; }
export async function sendPayloadMediaSequenceAndFinalize() { _w('sendPayloadMediaSequenceAndFinalize'); return undefined; }
export async function sendTextMediaPayload() { _w('sendTextMediaPayload'); return undefined; }
export async function sendMediaWithLeadingCaption() { _w('sendMediaWithLeadingCaption'); return undefined; }
export async function deliverTextOrMediaReply() { _w('deliverTextOrMediaReply'); return undefined; }
export async function deliverFormattedTextWithAttachments() { _w('deliverFormattedTextWithAttachments'); return undefined; }
export function isReasoningReplyPayload() { _w('isReasoningReplyPayload'); return false; }
export function normalizeOutboundReplyPayload() { _w('normalizeOutboundReplyPayload'); return ""; }
export function createNormalizedOutboundDeliverer() { _w('createNormalizedOutboundDeliverer'); return undefined; }
export function resolveOutboundMediaUrls() { _w('resolveOutboundMediaUrls'); return undefined; }
export function resolvePayloadMediaUrls() { _w('resolvePayloadMediaUrls'); return undefined; }
export function countOutboundMedia() { _w('countOutboundMedia'); return undefined; }
export function hasOutboundMedia() { _w('hasOutboundMedia'); return false; }
export function hasOutboundText() { _w('hasOutboundText'); return false; }
export function hasOutboundReplyContent() { _w('hasOutboundReplyContent'); return false; }
export function resolveSendableOutboundReplyParts() { _w('resolveSendableOutboundReplyParts'); return undefined; }
export function resolveTextChunksWithFallback() { _w('resolveTextChunksWithFallback'); return undefined; }
export function isNumericTargetId() { _w('isNumericTargetId'); return false; }
export function formatTextWithAttachmentLinks() { _w('formatTextWithAttachmentLinks'); return ""; }
export function buildMediaPayload() { _w('buildMediaPayload'); return undefined; }
