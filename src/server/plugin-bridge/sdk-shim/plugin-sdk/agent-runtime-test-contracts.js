// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/agent-runtime-test-contracts.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/agent-runtime-test-contracts.' + fn + '() not implemented in Bridge mode'); }
}

export const AUTH_PROFILE_RUNTIME_CONTRACT = undefined;
export function createAuthAliasManifestRegistry() { _w('createAuthAliasManifestRegistry'); return undefined; }
export function expectedForwardedAuthProfile() { _w('expectedForwardedAuthProfile'); return undefined; }
export const DELIVERY_NO_REPLY_RUNTIME_CONTRACT = undefined;
export function installCodexToolResultMiddleware() { _w('installCodexToolResultMiddleware'); return undefined; }
export function installOpenClawOwnedToolHooks() { _w('installOpenClawOwnedToolHooks'); return undefined; }
export function mediaToolResult() { _w('mediaToolResult'); return undefined; }
export function resetOpenClawOwnedToolHooks() { _w('resetOpenClawOwnedToolHooks'); return undefined; }
export function textToolResult() { _w('textToolResult'); return undefined; }
export function createContractFallbackConfig() { _w('createContractFallbackConfig'); return undefined; }
export function createContractRunResult() { _w('createContractRunResult'); return undefined; }
export const OUTCOME_FALLBACK_RUNTIME_CONTRACT = undefined;
export const CODEX_CONTRACT_PROVIDER_ID = undefined;
export function codexPromptOverlayContext() { _w('codexPromptOverlayContext'); return undefined; }
export const GPT5_CONTRACT_MODEL_ID = undefined;
export const GPT5_PREFIXED_CONTRACT_MODEL_ID = undefined;
export const NON_GPT5_CONTRACT_MODEL_ID = undefined;
export const NON_OPENAI_CONTRACT_PROVIDER_ID = undefined;
export const OPENAI_CODEX_CONTRACT_PROVIDER_ID = undefined;
export const OPENAI_CONTRACT_PROVIDER_ID = undefined;
export function openAiPluginPersonalityConfig() { _w('openAiPluginPersonalityConfig'); return undefined; }
export function sharedGpt5PersonalityConfig() { _w('sharedGpt5PersonalityConfig'); return undefined; }
export function createNativeOpenAICodexResponsesModel() { _w('createNativeOpenAICodexResponsesModel'); return undefined; }
export function createNativeOpenAIResponsesModel() { _w('createNativeOpenAIResponsesModel'); return undefined; }
export function createParameterFreeTool() { _w('createParameterFreeTool'); return undefined; }
export function createPermissiveTool() { _w('createPermissiveTool'); return undefined; }
export function createProxyOpenAIResponsesModel() { _w('createProxyOpenAIResponsesModel'); return undefined; }
export function createStrictCompatibleTool() { _w('createStrictCompatibleTool'); return undefined; }
export function normalizedParameterFreeSchema() { _w('normalizedParameterFreeSchema'); return ""; }
export function assistantHistoryMessage() { _w('assistantHistoryMessage'); return undefined; }
export function currentPromptHistoryMessage() { _w('currentPromptHistoryMessage'); return undefined; }
export function inlineDataUriOrphanLeaf() { _w('inlineDataUriOrphanLeaf'); return undefined; }
export function mediaOnlyHistoryMessage() { _w('mediaOnlyHistoryMessage'); return undefined; }
export const QUEUED_USER_MESSAGE_MARKER = undefined;
export function structuredHistoryMessage() { _w('structuredHistoryMessage'); return undefined; }
export function structuredOrphanLeaf() { _w('structuredOrphanLeaf'); return undefined; }
export function textOrphanLeaf() { _w('textOrphanLeaf'); return undefined; }
