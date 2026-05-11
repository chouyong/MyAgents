// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/approval-client-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/approval-client-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function createChannelExecApprovalProfile() { _w('createChannelExecApprovalProfile'); return undefined; }
export function getExecApprovalReplyMetadata() { _w('getExecApprovalReplyMetadata'); return undefined; }
export function isChannelExecApprovalClientEnabledFromConfig() { _w('isChannelExecApprovalClientEnabledFromConfig'); return false; }
export function isChannelExecApprovalTargetRecipient() { _w('isChannelExecApprovalTargetRecipient'); return false; }
export function matchesApprovalRequestFilters() { _w('matchesApprovalRequestFilters'); return undefined; }
