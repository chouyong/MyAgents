// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-stream-shared.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-stream-shared.' + fn + '() not implemented in Bridge mode'); }
}

export function composeProviderStreamWrappers() { _w('composeProviderStreamWrappers'); return undefined; }
export function defaultToolStreamExtraParams() { _w('defaultToolStreamExtraParams'); return undefined; }
export function decodeHtmlEntitiesInObject() { _w('decodeHtmlEntitiesInObject'); return ""; }
export function wrapStreamMessageObjects() { _w('wrapStreamMessageObjects'); return undefined; }
export function createHtmlEntityToolCallArgumentDecodingWrapper() { _w('createHtmlEntityToolCallArgumentDecodingWrapper'); return undefined; }
export function createPayloadPatchStreamWrapper() { _w('createPayloadPatchStreamWrapper'); return undefined; }
export function stripTrailingAnthropicAssistantPrefillWhenThinking() { _w('stripTrailingAnthropicAssistantPrefillWhenThinking'); return ""; }
export function createAnthropicThinkingPrefillPayloadWrapper() { _w('createAnthropicThinkingPrefillPayloadWrapper'); return undefined; }
export function isOpenAICompatibleThinkingEnabled() { _w('isOpenAICompatibleThinkingEnabled'); return false; }
export function createDeepSeekV4OpenAICompatibleThinkingWrapper() { _w('createDeepSeekV4OpenAICompatibleThinkingWrapper'); return undefined; }
export function isGoogleThinkingRequiredModel() { _w('isGoogleThinkingRequiredModel'); return false; }
export function isGoogleGemini25ThinkingBudgetModel() { _w('isGoogleGemini25ThinkingBudgetModel'); return false; }
export function isGoogleGemini3ProModel() { _w('isGoogleGemini3ProModel'); return false; }
export function isGoogleGemini3FlashModel() { _w('isGoogleGemini3FlashModel'); return false; }
export function isGoogleGemini3ThinkingLevelModel() { _w('isGoogleGemini3ThinkingLevelModel'); return false; }
export function resolveGoogleGemini3ThinkingLevel() { _w('resolveGoogleGemini3ThinkingLevel'); return undefined; }
export function stripInvalidGoogleThinkingBudget() { _w('stripInvalidGoogleThinkingBudget'); return ""; }
export function sanitizeGoogleThinkingPayload() { _w('sanitizeGoogleThinkingPayload'); return ""; }
export function createGoogleThinkingPayloadWrapper() { _w('createGoogleThinkingPayloadWrapper'); return undefined; }
export function createGoogleThinkingStreamWrapper() { _w('createGoogleThinkingStreamWrapper'); return undefined; }
export function applyAnthropicPayloadPolicyToParams() { _w('applyAnthropicPayloadPolicyToParams'); return undefined; }
export function resolveAnthropicPayloadPolicy() { _w('resolveAnthropicPayloadPolicy'); return undefined; }
export function buildCopilotDynamicHeaders() { _w('buildCopilotDynamicHeaders'); return undefined; }
export function hasCopilotVisionInput() { _w('hasCopilotVisionInput'); return false; }
export function applyAnthropicEphemeralCacheControlMarkers() { _w('applyAnthropicEphemeralCacheControlMarkers'); return undefined; }
export function createBedrockNoCacheWrapper() { _w('createBedrockNoCacheWrapper'); return undefined; }
export function isAnthropicBedrockModel() { _w('isAnthropicBedrockModel'); return false; }
export function createMoonshotThinkingWrapper() { _w('createMoonshotThinkingWrapper'); return undefined; }
export function resolveMoonshotThinkingType() { _w('resolveMoonshotThinkingType'); return undefined; }
export function streamWithPayloadPatch() { _w('streamWithPayloadPatch'); return undefined; }
export function createToolStreamWrapper() { _w('createToolStreamWrapper'); return undefined; }
export function createZaiToolStreamWrapper() { _w('createZaiToolStreamWrapper'); return undefined; }
