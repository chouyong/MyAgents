// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/hook-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/hook-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function initializeGlobalHookRunner() { _w('initializeGlobalHookRunner'); return undefined; }
export function resetGlobalHookRunner() { _w('resetGlobalHookRunner'); return undefined; }
export function formatHookErrorForLog() { _w('formatHookErrorForLog'); return ""; }
export function fireAndForgetHook() { _w('fireAndForgetHook'); return undefined; }
export function fireAndForgetBoundedHook() { _w('fireAndForgetBoundedHook'); return undefined; }
export async function triggerInternalHook() { _w('triggerInternalHook'); return undefined; }
export function registerInternalHook() { _w('registerInternalHook'); return undefined; }
export function unregisterInternalHook() { _w('unregisterInternalHook'); return undefined; }
export function clearInternalHooks() { _w('clearInternalHooks'); return undefined; }
export function setInternalHooksEnabled() { _w('setInternalHooksEnabled'); return undefined; }
export function getRegisteredEventKeys() { _w('getRegisteredEventKeys'); return undefined; }
export function hasInternalHookListeners() { _w('hasInternalHookListeners'); return false; }
export function createInternalHookEvent() { _w('createInternalHookEvent'); return undefined; }
export function isAgentBootstrapEvent() { _w('isAgentBootstrapEvent'); return false; }
export function isGatewayStartupEvent() { _w('isGatewayStartupEvent'); return false; }
export function isMessageReceivedEvent() { _w('isMessageReceivedEvent'); return false; }
export function isMessageSentEvent() { _w('isMessageSentEvent'); return false; }
export function isMessageTranscribedEvent() { _w('isMessageTranscribedEvent'); return false; }
export function isMessagePreprocessedEvent() { _w('isMessagePreprocessedEvent'); return false; }
export function isSessionPatchEvent() { _w('isSessionPatchEvent'); return false; }
export function deriveInboundMessageHookContext() { _w('deriveInboundMessageHookContext'); return undefined; }
export function buildCanonicalSentMessageHookContext() { _w('buildCanonicalSentMessageHookContext'); return undefined; }
export function toPluginMessageContext() { _w('toPluginMessageContext'); return undefined; }
export function toPluginInboundClaimContext() { _w('toPluginInboundClaimContext'); return undefined; }
export function toPluginInboundClaimEvent() { _w('toPluginInboundClaimEvent'); return undefined; }
export function toPluginMessageReceivedEvent() { _w('toPluginMessageReceivedEvent'); return undefined; }
export function toPluginMessageSentEvent() { _w('toPluginMessageSentEvent'); return undefined; }
export function toInternalMessageReceivedContext() { _w('toInternalMessageReceivedContext'); return undefined; }
export function toInternalMessageTranscribedContext() { _w('toInternalMessageTranscribedContext'); return undefined; }
export function toInternalMessagePreprocessedContext() { _w('toInternalMessagePreprocessedContext'); return undefined; }
export function toInternalMessageSentContext() { _w('toInternalMessageSentContext'); return undefined; }
