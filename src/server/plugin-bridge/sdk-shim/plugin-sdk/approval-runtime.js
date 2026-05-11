// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/approval-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/approval-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = undefined;
export function resolveExecApprovalAllowedDecisions() { _w('resolveExecApprovalAllowedDecisions'); return undefined; }
export function resolveExecApprovalRequestAllowedDecisions() { _w('resolveExecApprovalRequestAllowedDecisions'); return undefined; }
export function buildExecApprovalPendingReplyPayload() { _w('buildExecApprovalPendingReplyPayload'); return undefined; }
export function getExecApprovalApproverDmNoticeText() { _w('getExecApprovalApproverDmNoticeText'); return undefined; }
export function getExecApprovalReplyMetadata() { _w('getExecApprovalReplyMetadata'); return undefined; }
export function resolveExecApprovalCommandDisplay() { _w('resolveExecApprovalCommandDisplay'); return undefined; }
export function formatApprovalDisplayPath() { _w('formatApprovalDisplayPath'); return ""; }
export function createChannelApproverDmTargetResolver() { _w('createChannelApproverDmTargetResolver'); return undefined; }
export function createChannelNativeOriginTargetResolver() { _w('createChannelNativeOriginTargetResolver'); return undefined; }
export function resolveApprovalRequestOriginTarget() { _w('resolveApprovalRequestOriginTarget'); return undefined; }
export function resolveApprovalRequestSessionTarget() { _w('resolveApprovalRequestSessionTarget'); return undefined; }
export function resolveExecApprovalSessionTarget() { _w('resolveExecApprovalSessionTarget'); return undefined; }
export function doesApprovalRequestMatchChannelAccount() { _w('doesApprovalRequestMatchChannelAccount'); return false; }
export function resolveApprovalRequestAccountId() { _w('resolveApprovalRequestAccountId'); return undefined; }
export function resolveApprovalRequestChannelAccountId() { _w('resolveApprovalRequestChannelAccountId'); return undefined; }
export function buildPluginApprovalExpiredMessage() { _w('buildPluginApprovalExpiredMessage'); return undefined; }
export function buildPluginApprovalRequestMessage() { _w('buildPluginApprovalRequestMessage'); return undefined; }
export function buildPluginApprovalResolvedMessage() { _w('buildPluginApprovalResolvedMessage'); return undefined; }
export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = undefined;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = undefined;
export function createResolvedApproverActionAuthAdapter() { _w('createResolvedApproverActionAuthAdapter'); return undefined; }
export function createChannelExecApprovalProfile() { _w('createChannelExecApprovalProfile'); return undefined; }
export function isChannelExecApprovalClientEnabledFromConfig() { _w('isChannelExecApprovalClientEnabledFromConfig'); return false; }
export function isChannelExecApprovalTargetRecipient() { _w('isChannelExecApprovalTargetRecipient'); return false; }
export function createChannelNativeApprovalRuntime() { _w('createChannelNativeApprovalRuntime'); return undefined; }
export function createApproverRestrictedNativeApprovalAdapter() { _w('createApproverRestrictedNativeApprovalAdapter'); return undefined; }
export function createApproverRestrictedNativeApprovalCapability() { _w('createApproverRestrictedNativeApprovalCapability'); return undefined; }
export function createChannelApprovalCapability() { _w('createChannelApprovalCapability'); return undefined; }
export function splitChannelApprovalCapability() { _w('splitChannelApprovalCapability'); return undefined; }
export function resolveApprovalApprovers() { _w('resolveApprovalApprovers'); return undefined; }
export function matchesApprovalRequestFilters() { _w('matchesApprovalRequestFilters'); return undefined; }
export function matchesApprovalRequestSessionFilter() { _w('matchesApprovalRequestSessionFilter'); return undefined; }
export function buildApprovalPendingReplyPayload() { _w('buildApprovalPendingReplyPayload'); return undefined; }
export function buildApprovalResolvedReplyPayload() { _w('buildApprovalResolvedReplyPayload'); return undefined; }
export function buildPluginApprovalPendingReplyPayload() { _w('buildPluginApprovalPendingReplyPayload'); return undefined; }
export function buildPluginApprovalResolvedReplyPayload() { _w('buildPluginApprovalResolvedReplyPayload'); return undefined; }
