// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/conversation-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/conversation-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function createConversationBindingRecord() { _w('createConversationBindingRecord'); return undefined; }
export function getConversationBindingCapabilities() { _w('getConversationBindingCapabilities'); return undefined; }
export function listSessionBindingRecords() { _w('listSessionBindingRecords'); return []; }
export function resolveConversationBindingRecord() { _w('resolveConversationBindingRecord'); return undefined; }
export function touchConversationBindingRecord() { _w('touchConversationBindingRecord'); return undefined; }
export function unbindConversationBindingRecord() { _w('unbindConversationBindingRecord'); return undefined; }
export function ensureConfiguredBindingRouteReady() { _w('ensureConfiguredBindingRouteReady'); return undefined; }
export function resolveConfiguredBindingRoute() { _w('resolveConfiguredBindingRoute'); return undefined; }
export function resolveRuntimeConversationBindingRoute() { _w('resolveRuntimeConversationBindingRoute'); return undefined; }
export function primeConfiguredBindingRegistry() { _w('primeConfiguredBindingRegistry'); return undefined; }
export function resolveConfiguredBinding() { _w('resolveConfiguredBinding'); return undefined; }
export function resolveConfiguredBindingRecord() { _w('resolveConfiguredBindingRecord'); return undefined; }
export function resolveConfiguredBindingRecordBySessionKey() { _w('resolveConfiguredBindingRecordBySessionKey'); return undefined; }
export function resolveConfiguredBindingRecordForConversation() { _w('resolveConfiguredBindingRecordForConversation'); return undefined; }
export function ensureConfiguredBindingTargetReady() { _w('ensureConfiguredBindingTargetReady'); return undefined; }
export function ensureConfiguredBindingTargetSession() { _w('ensureConfiguredBindingTargetSession'); return undefined; }
export function resetConfiguredBindingTargetInPlace() { _w('resetConfiguredBindingTargetInPlace'); return undefined; }
export function resolveConversationLabel() { _w('resolveConversationLabel'); return undefined; }
export function recordInboundSession() { _w('recordInboundSession'); return undefined; }
export function recordInboundSessionMetaSafe() { _w('recordInboundSessionMetaSafe'); return undefined; }
export function resolveThreadBindingConversationIdFromBindingId() { _w('resolveThreadBindingConversationIdFromBindingId'); return undefined; }
export function createScopedAccountReplyToModeResolver() { _w('createScopedAccountReplyToModeResolver'); return undefined; }
export function createStaticReplyToModeResolver() { _w('createStaticReplyToModeResolver'); return undefined; }
export function createTopLevelChannelReplyToModeResolver() { _w('createTopLevelChannelReplyToModeResolver'); return undefined; }
export function formatThreadBindingDurationLabel() { _w('formatThreadBindingDurationLabel'); return ""; }
export function resolveThreadBindingFarewellText() { _w('resolveThreadBindingFarewellText'); return undefined; }
export function resolveThreadBindingIntroText() { _w('resolveThreadBindingIntroText'); return undefined; }
export function resolveThreadBindingThreadName() { _w('resolveThreadBindingThreadName'); return undefined; }
export function formatThreadBindingDisabledError() { _w('formatThreadBindingDisabledError'); return ""; }
export function resolveThreadBindingEffectiveExpiresAt() { _w('resolveThreadBindingEffectiveExpiresAt'); return undefined; }
export function resolveThreadBindingIdleTimeoutMs() { _w('resolveThreadBindingIdleTimeoutMs'); return undefined; }
export function resolveThreadBindingIdleTimeoutMsForChannel() { _w('resolveThreadBindingIdleTimeoutMsForChannel'); return undefined; }
export function resolveThreadBindingLifecycle() { _w('resolveThreadBindingLifecycle'); return undefined; }
export function resolveThreadBindingMaxAgeMs() { _w('resolveThreadBindingMaxAgeMs'); return undefined; }
export function resolveThreadBindingMaxAgeMsForChannel() { _w('resolveThreadBindingMaxAgeMsForChannel'); return undefined; }
export function resolveThreadBindingsEnabled() { _w('resolveThreadBindingsEnabled'); return undefined; }
export function resolveThreadBindingSpawnPolicy() { _w('resolveThreadBindingSpawnPolicy'); return undefined; }
export function SessionBindingError() { _w('SessionBindingError'); return undefined; }
export function getSessionBindingService() { _w('getSessionBindingService'); return undefined; }
export function isSessionBindingError() { _w('isSessionBindingError'); return false; }
export function registerSessionBindingAdapter() { _w('registerSessionBindingAdapter'); return undefined; }
export function unregisterSessionBindingAdapter() { _w('unregisterSessionBindingAdapter'); return undefined; }
export function __testing() { _w('__testing'); return undefined; }
export function resolvePairingIdLabel() { _w('resolvePairingIdLabel'); return undefined; }
export function buildPluginBindingApprovalCustomId() { _w('buildPluginBindingApprovalCustomId'); return undefined; }
export function buildPluginBindingDeclinedText() { _w('buildPluginBindingDeclinedText'); return undefined; }
export function buildPluginBindingErrorText() { _w('buildPluginBindingErrorText'); return undefined; }
export function buildPluginBindingResolvedText() { _w('buildPluginBindingResolvedText'); return undefined; }
export function buildPluginBindingUnavailableText() { _w('buildPluginBindingUnavailableText'); return undefined; }
export function detachPluginConversationBinding() { _w('detachPluginConversationBinding'); return undefined; }
export function getCurrentPluginConversationBinding() { _w('getCurrentPluginConversationBinding'); return undefined; }
export function hasShownPluginBindingFallbackNotice() { _w('hasShownPluginBindingFallbackNotice'); return false; }
export function isPluginOwnedBindingMetadata() { _w('isPluginOwnedBindingMetadata'); return false; }
export function isPluginOwnedSessionBindingRecord() { _w('isPluginOwnedSessionBindingRecord'); return false; }
export function markPluginBindingFallbackNoticeShown() { _w('markPluginBindingFallbackNoticeShown'); return undefined; }
export function parsePluginBindingApprovalCustomId() { _w('parsePluginBindingApprovalCustomId'); return undefined; }
export function requestPluginConversationBinding() { _w('requestPluginConversationBinding'); return undefined; }
export function resolvePluginConversationBindingApproval() { _w('resolvePluginConversationBindingApproval'); return undefined; }
export function toPluginConversationBinding() { _w('toPluginConversationBinding'); return undefined; }
export function resolvePinnedMainDmOwnerFromAllowlist() { _w('resolvePinnedMainDmOwnerFromAllowlist'); return undefined; }
export async function issuePairingChallenge() { _w('issuePairingChallenge'); return undefined; }
export function buildPairingReply() { _w('buildPairingReply'); return undefined; }
export async function readLegacyChannelAllowFromStore() { _w('readLegacyChannelAllowFromStore'); return undefined; }
export async function readChannelAllowFromStore() { _w('readChannelAllowFromStore'); return undefined; }
export async function addChannelAllowFromStoreEntry() { _w('addChannelAllowFromStoreEntry'); return undefined; }
export async function removeChannelAllowFromStoreEntry() { _w('removeChannelAllowFromStoreEntry'); return undefined; }
export async function listChannelPairingRequests() { _w('listChannelPairingRequests'); return []; }
export async function upsertChannelPairingRequest() { _w('upsertChannelPairingRequest'); return undefined; }
export async function approveChannelPairingCode() { _w('approveChannelPairingCode'); return undefined; }
export function resolveChannelAllowFromPath() { _w('resolveChannelAllowFromPath'); return undefined; }
export function readLegacyChannelAllowFromStoreSync() { _w('readLegacyChannelAllowFromStoreSync'); return undefined; }
export function readChannelAllowFromStoreSync() { _w('readChannelAllowFromStoreSync'); return undefined; }
export function clearPairingAllowFromReadCacheForTest() { _w('clearPairingAllowFromReadCacheForTest'); return undefined; }
