// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-targets.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-targets.' + fn + '() not implemented in Bridge mode'); }
}

export function applyChannelMatchMeta() { _w('applyChannelMatchMeta'); return undefined; }
export function buildChannelKeyCandidates() { _w('buildChannelKeyCandidates'); return undefined; }
export function normalizeChannelSlug() { _w('normalizeChannelSlug'); return ""; }
export function resolveChannelEntryMatch() { _w('resolveChannelEntryMatch'); return undefined; }
export function resolveChannelEntryMatchWithFallback() { _w('resolveChannelEntryMatchWithFallback'); return undefined; }
export function resolveChannelMatchConfig() { _w('resolveChannelMatchConfig'); return undefined; }
export function resolveNestedAllowlistDecision() { _w('resolveNestedAllowlistDecision'); return undefined; }
export function buildMessagingTarget() { _w('buildMessagingTarget'); return undefined; }
export function ensureTargetId() { _w('ensureTargetId'); return undefined; }
export function normalizeTargetId() { _w('normalizeTargetId'); return ""; }
export function parseAtUserTarget() { _w('parseAtUserTarget'); return undefined; }
export function parseMentionPrefixOrAtUserTarget() { _w('parseMentionPrefixOrAtUserTarget'); return undefined; }
export function parseTargetMention() { _w('parseTargetMention'); return undefined; }
export function parseTargetPrefix() { _w('parseTargetPrefix'); return undefined; }
export function parseTargetPrefixes() { _w('parseTargetPrefixes'); return undefined; }
export function requireTargetKind() { _w('requireTargetKind'); return undefined; }
export function createAllowedChatSenderMatcher() { _w('createAllowedChatSenderMatcher'); return undefined; }
export function parseChatAllowTargetPrefixes() { _w('parseChatAllowTargetPrefixes'); return undefined; }
export function parseChatTargetPrefixesOrThrow() { _w('parseChatTargetPrefixesOrThrow'); return undefined; }
export function resolveServicePrefixedAllowTarget() { _w('resolveServicePrefixedAllowTarget'); return undefined; }
export function resolveServicePrefixedChatTarget() { _w('resolveServicePrefixedChatTarget'); return undefined; }
export function resolveServicePrefixedOrChatAllowTarget() { _w('resolveServicePrefixedOrChatAllowTarget'); return undefined; }
export function resolveServicePrefixedTarget() { _w('resolveServicePrefixedTarget'); return undefined; }
export function normalizeChannelId() { _w('normalizeChannelId'); return ""; }
export function resolveChannelTtsVoiceDelivery() { _w('resolveChannelTtsVoiceDelivery'); return undefined; }
export function buildUnresolvedTargetResults() { _w('buildUnresolvedTargetResults'); return undefined; }
export function resolveTargetsWithOptionalToken() { _w('resolveTargetsWithOptionalToken'); return undefined; }
