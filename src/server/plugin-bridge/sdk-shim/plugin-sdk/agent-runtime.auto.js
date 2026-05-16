// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/agent-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/agent-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveOpenClawAgentDir() { _w('resolveOpenClawAgentDir'); return undefined; }
export const CLAUDE_CLI_PROFILE_ID = undefined;
export const CODEX_CLI_PROFILE_ID = undefined;
export function dedupeProfileIds() { _w('dedupeProfileIds'); return undefined; }
export function listProfilesForProvider() { _w('listProfilesForProvider'); return []; }
export function markAuthProfileGood() { _w('markAuthProfileGood'); return undefined; }
export function setAuthProfileOrder() { _w('setAuthProfileOrder'); return undefined; }
export function upsertAuthProfile() { _w('upsertAuthProfile'); return undefined; }
export function upsertAuthProfileWithLock() { _w('upsertAuthProfileWithLock'); return undefined; }
export function repairOAuthProfileIdMismatch() { _w('repairOAuthProfileIdMismatch'); return undefined; }
export function suggestOAuthProfileIdForLegacyDefault() { _w('suggestOAuthProfileIdForLegacyDefault'); return undefined; }
export function clearRuntimeAuthProfileStoreSnapshots() { _w('clearRuntimeAuthProfileStoreSnapshots'); return undefined; }
export function ensureAuthProfileStore() { _w('ensureAuthProfileStore'); return undefined; }
export function loadAuthProfileStoreWithoutExternalProfiles() { _w('loadAuthProfileStoreWithoutExternalProfiles'); return undefined; }
export function loadAuthProfileStoreForSecretsRuntime() { _w('loadAuthProfileStoreForSecretsRuntime'); return undefined; }
export function loadAuthProfileStoreForRuntime() { _w('loadAuthProfileStoreForRuntime'); return undefined; }
export function replaceRuntimeAuthProfileStoreSnapshots() { _w('replaceRuntimeAuthProfileStoreSnapshots'); return undefined; }
export function loadAuthProfileStore() { _w('loadAuthProfileStore'); return undefined; }
export function saveAuthProfileStore() { _w('saveAuthProfileStore'); return undefined; }
export function calculateAuthProfileCooldownMs() { _w('calculateAuthProfileCooldownMs'); return undefined; }
export function clearAuthProfileCooldown() { _w('clearAuthProfileCooldown'); return undefined; }
export function clearExpiredCooldowns() { _w('clearExpiredCooldowns'); return undefined; }
export function getSoonestCooldownExpiry() { _w('getSoonestCooldownExpiry'); return undefined; }
export function isProfileInCooldown() { _w('isProfileInCooldown'); return false; }
export function markAuthProfileCooldown() { _w('markAuthProfileCooldown'); return undefined; }
export function markAuthProfileFailure() { _w('markAuthProfileFailure'); return undefined; }
export function markAuthProfileUsed() { _w('markAuthProfileUsed'); return undefined; }
export function resolveProfilesUnavailableReason() { _w('resolveProfilesUnavailableReason'); return undefined; }
export function resolveProfileUnusableUntilForDisplay() { _w('resolveProfileUnusableUntilForDisplay'); return undefined; }
export function resolveApiKeyForProfile() { _w('resolveApiKeyForProfile'); return undefined; }
export function resolveAuthProfileDisplayLabel() { _w('resolveAuthProfileDisplayLabel'); return undefined; }
export function formatAuthDoctorHint() { _w('formatAuthDoctorHint'); return ""; }
export function resolveAuthProfileEligibility() { _w('resolveAuthProfileEligibility'); return undefined; }
export function resolveAuthProfileOrder() { _w('resolveAuthProfileOrder'); return undefined; }
export function resolveAuthStorePathForDisplay() { _w('resolveAuthStorePathForDisplay'); return undefined; }
export function resolveSessionAgentIds() { _w('resolveSessionAgentIds'); return undefined; }
export function resolveSessionAgentId() { _w('resolveSessionAgentId'); return undefined; }
export function resolveAgentExecutionContract() { _w('resolveAgentExecutionContract'); return undefined; }
export function resolveAgentSkillsFilter() { _w('resolveAgentSkillsFilter'); return undefined; }
export function resolveAgentExplicitModelPrimary() { _w('resolveAgentExplicitModelPrimary'); return undefined; }
export function resolveAgentEffectiveModelPrimary() { _w('resolveAgentEffectiveModelPrimary'); return undefined; }
export function setAgentEffectiveModelPrimary() { _w('setAgentEffectiveModelPrimary'); return undefined; }
export function resolveAgentModelPrimary() { _w('resolveAgentModelPrimary'); return undefined; }
export function resolveAgentModelFallbacksOverride() { _w('resolveAgentModelFallbacksOverride'); return undefined; }
export function resolveFallbackAgentId() { _w('resolveFallbackAgentId'); return undefined; }
export function resolveRunModelFallbacksOverride() { _w('resolveRunModelFallbacksOverride'); return undefined; }
export function hasConfiguredModelFallbacks() { _w('hasConfiguredModelFallbacks'); return false; }
export function resolveEffectiveModelFallbacks() { _w('resolveEffectiveModelFallbacks'); return undefined; }
export function resolveAgentIdsByWorkspacePath() { _w('resolveAgentIdsByWorkspacePath'); return undefined; }
export function resolveAgentIdByWorkspacePath() { _w('resolveAgentIdByWorkspacePath'); return undefined; }
export function listAgentEntries() { _w('listAgentEntries'); return []; }
export function listAgentIds() { _w('listAgentIds'); return []; }
export function resolveAgentConfig() { _w('resolveAgentConfig'); return undefined; }
export function resolveAgentContextLimits() { _w('resolveAgentContextLimits'); return undefined; }
export function resolveAgentDir() { _w('resolveAgentDir'); return undefined; }
export function resolveAgentWorkspaceDir() { _w('resolveAgentWorkspaceDir'); return undefined; }
export function resolveDefaultAgentId() { _w('resolveDefaultAgentId'); return undefined; }
export function resolveAgentIdFromSessionKey() { _w('resolveAgentIdFromSessionKey'); return undefined; }
export function resolveCronStyleNow() { _w('resolveCronStyleNow'); return undefined; }
export function appendCronStyleCurrentTimeLine() { _w('appendCronStyleCurrentTimeLine'); return undefined; }
export function resolveUserTimezone() { _w('resolveUserTimezone'); return undefined; }
export function resolveUserTimeFormat() { _w('resolveUserTimeFormat'); return undefined; }
export function normalizeTimestamp() { _w('normalizeTimestamp'); return ""; }
export function withNormalizedTimestamp() { _w('withNormalizedTimestamp'); return undefined; }
export function formatUserTime() { _w('formatUserTime'); return ""; }
export function resolvePublicAgentAvatarSource() { _w('resolvePublicAgentAvatarSource'); return undefined; }
export function resolveAgentAvatar() { _w('resolveAgentAvatar'); return undefined; }
export function resolveAgentIdentity() { _w('resolveAgentIdentity'); return undefined; }
export function resolveAckReaction() { _w('resolveAckReaction'); return undefined; }
export function resolveIdentityNamePrefix() { _w('resolveIdentityNamePrefix'); return undefined; }
export function resolveMessagePrefix() { _w('resolveMessagePrefix'); return undefined; }
export function resolveResponsePrefix() { _w('resolveResponsePrefix'); return undefined; }
export function resolveEffectiveMessagesConfig() { _w('resolveEffectiveMessagesConfig'); return undefined; }
export function resolveHumanDelayConfig() { _w('resolveHumanDelayConfig'); return undefined; }
export function listKnownNonSecretApiKeyMarkers() { _w('listKnownNonSecretApiKeyMarkers'); return []; }
export function isAwsSdkAuthMarker() { _w('isAwsSdkAuthMarker'); return false; }
export function isKnownEnvApiKeyMarker() { _w('isKnownEnvApiKeyMarker'); return false; }
export function resolveOAuthApiKeyMarker() { _w('resolveOAuthApiKeyMarker'); return undefined; }
export function isOAuthApiKeyMarker() { _w('isOAuthApiKeyMarker'); return false; }
export function resolveNonEnvSecretRefApiKeyMarker() { _w('resolveNonEnvSecretRefApiKeyMarker'); return undefined; }
export function resolveNonEnvSecretRefHeaderValueMarker() { _w('resolveNonEnvSecretRefHeaderValueMarker'); return undefined; }
export function resolveEnvSecretRefHeaderValueMarker() { _w('resolveEnvSecretRefHeaderValueMarker'); return undefined; }
export function isSecretRefHeaderValueMarker() { _w('isSecretRefHeaderValueMarker'); return false; }
export function isNonSecretApiKeyMarker() { _w('isNonSecretApiKeyMarker'); return false; }
export const MINIMAX_OAUTH_MARKER = undefined;
export const OAUTH_API_KEY_MARKER_PREFIX = undefined;
export const OLLAMA_LOCAL_AUTH_MARKER = undefined;
export const CUSTOM_LOCAL_AUTH_MARKER = undefined;
export const GCP_VERTEX_CREDENTIALS_MARKER = undefined;
export const NON_ENV_SECRETREF_MARKER = undefined;
export const SECRETREF_ENV_HEADER_MARKER_PREFIX = undefined;
export async function resolveApiKeyForProvider() { _w('resolveApiKeyForProvider'); return undefined; }
export async function hasAvailableAuthForProvider() { _w('hasAvailableAuthForProvider'); return false; }
export async function getApiKeyForModel() { _w('getApiKeyForModel'); return undefined; }
export function getCustomProviderApiKey() { _w('getCustomProviderApiKey'); return undefined; }
export function resolveUsableCustomProviderApiKey() { _w('resolveUsableCustomProviderApiKey'); return undefined; }
export function hasUsableCustomProviderApiKey() { _w('hasUsableCustomProviderApiKey'); return false; }
export function shouldPreferExplicitConfigApiKeyAuth() { _w('shouldPreferExplicitConfigApiKeyAuth'); return false; }
export function resolveModelAuthMode() { _w('resolveModelAuthMode'); return undefined; }
export function applyLocalNoAuthHeaderOverride() { _w('applyLocalNoAuthHeaderOverride'); return undefined; }
export function applyAuthHeaderOverride() { _w('applyAuthHeaderOverride'); return undefined; }
export function requireApiKey() { _w('requireApiKey'); return undefined; }
export function resolveAwsSdkEnvVarName() { _w('resolveAwsSdkEnvVarName'); return undefined; }
export function resolveEnvApiKey() { _w('resolveEnvApiKey'); return undefined; }
export async function loadModelCatalog() { _w('loadModelCatalog'); return undefined; }
export function resetModelCatalogCache() { _w('resetModelCatalogCache'); return undefined; }
export function resetModelCatalogCacheForTest() { _w('resetModelCatalogCacheForTest'); return undefined; }
export function __setModelCatalogImportForTest() { _w('__setModelCatalogImportForTest'); return undefined; }
export function modelSupportsVision() { _w('modelSupportsVision'); return undefined; }
export function modelSupportsDocument() { _w('modelSupportsDocument'); return undefined; }
export function findModelCatalogEntry() { _w('findModelCatalogEntry'); return undefined; }
export function findModelInCatalog() { _w('findModelInCatalog'); return undefined; }
export function modelSupportsInput() { _w('modelSupportsInput'); return undefined; }
export function resolvePersistedOverrideModelRef() { _w('resolvePersistedOverrideModelRef'); return undefined; }
export function resolvePersistedModelRef() { _w('resolvePersistedModelRef'); return undefined; }
export function resolvePersistedSelectedModelRef() { _w('resolvePersistedSelectedModelRef'); return undefined; }
export function normalizeStoredOverrideModel() { _w('normalizeStoredOverrideModel'); return ""; }
export function resolveAllowlistModelKey() { _w('resolveAllowlistModelKey'); return undefined; }
export function resolveDefaultModelForAgent() { _w('resolveDefaultModelForAgent'); return undefined; }
export function resolveSubagentConfiguredModelSelection() { _w('resolveSubagentConfiguredModelSelection'); return undefined; }
export function resolveSubagentSpawnModelSelection() { _w('resolveSubagentSpawnModelSelection'); return undefined; }
export function buildAllowedModelSet() { _w('buildAllowedModelSet'); return undefined; }
export function getModelRefStatus() { _w('getModelRefStatus'); return undefined; }
export function resolveAllowedModelRef() { _w('resolveAllowedModelRef'); return undefined; }
export function resolveReasoningDefault() { _w('resolveReasoningDefault'); return undefined; }
export function resolveThinkingDefault() { _w('resolveThinkingDefault'); return undefined; }
export function buildConfiguredAllowlistKeys() { _w('buildConfiguredAllowlistKeys'); return undefined; }
export function buildConfiguredModelCatalog() { _w('buildConfiguredModelCatalog'); return undefined; }
export function buildModelAliasIndex() { _w('buildModelAliasIndex'); return undefined; }
export function findNormalizedProviderKey() { _w('findNormalizedProviderKey'); return undefined; }
export function findNormalizedProviderValue() { _w('findNormalizedProviderValue'); return undefined; }
export function inferUniqueProviderFromConfiguredModels() { _w('inferUniqueProviderFromConfiguredModels'); return undefined; }
export function inferUniqueProviderFromCatalog() { _w('inferUniqueProviderFromCatalog'); return undefined; }
export function legacyModelKey() { _w('legacyModelKey'); return undefined; }
export function modelKey() { _w('modelKey'); return undefined; }
export function normalizeModelRef() { _w('normalizeModelRef'); return ""; }
export function normalizeModelSelection() { _w('normalizeModelSelection'); return ""; }
export function normalizeProviderIdForAuth() { _w('normalizeProviderIdForAuth'); return ""; }
export function parseModelRef() { _w('parseModelRef'); return undefined; }
export function resolveBareModelDefaultProvider() { _w('resolveBareModelDefaultProvider'); return undefined; }
export function resolveConfiguredModelRef() { _w('resolveConfiguredModelRef'); return undefined; }
export function resolveHooksGmailModel() { _w('resolveHooksGmailModel'); return undefined; }
export function resolveModelRefFromString() { _w('resolveModelRefFromString'); return undefined; }
export function isCliProvider() { _w('isCliProvider'); return false; }
export async function prepareSimpleCompletionModel() { _w('prepareSimpleCompletionModel'); return undefined; }
export async function prepareSimpleCompletionModelForAgent() { _w('prepareSimpleCompletionModelForAgent'); return undefined; }
export async function completeWithPreparedSimpleCompletionModel() { _w('completeWithPreparedSimpleCompletionModel'); return undefined; }
export function resolveSimpleCompletionSelectionForAgent() { _w('resolveSimpleCompletionSelectionForAgent'); return undefined; }
export class EmbeddedBlockChunker { constructor() { _w('EmbeddedBlockChunker'); } }
export function isAssistantMessage() { _w('isAssistantMessage'); return false; }
export function stripThinkingTagsFromText() { _w('stripThinkingTagsFromText'); return ""; }
export function extractAssistantVisibleText() { _w('extractAssistantVisibleText'); return undefined; }
export function extractAssistantText() { _w('extractAssistantText'); return undefined; }
export function extractAssistantThinking() { _w('extractAssistantThinking'); return undefined; }
export function formatReasoningMessage() { _w('formatReasoningMessage'); return ""; }
export function splitThinkingTaggedText() { _w('splitThinkingTaggedText'); return undefined; }
export function promoteThinkingTagsToBlocks() { _w('promoteThinkingTagsToBlocks'); return undefined; }
export function extractThinkingFromTaggedText() { _w('extractThinkingFromTaggedText'); return undefined; }
export function extractThinkingFromTaggedStream() { _w('extractThinkingFromTaggedStream'); return undefined; }
export function inferToolMetaFromArgs() { _w('inferToolMetaFromArgs'); return undefined; }
export const THINKING_TAG_SCAN_RE = undefined;
export function stripDowngradedToolCallText() { _w('stripDowngradedToolCallText'); return ""; }
export function stripMinimaxToolCallXml() { _w('stripMinimaxToolCallXml'); return ""; }
export function stripModelSpecialTokens() { _w('stripModelSpecialTokens'); return ""; }
export function resetProviderAuthAliasMapCacheForTest() { _w('resetProviderAuthAliasMapCacheForTest'); return undefined; }
export function resolveProviderAuthAliasMap() { _w('resolveProviderAuthAliasMap'); return undefined; }
export function resolveProviderIdForAuth() { _w('resolveProviderIdForAuth'); return undefined; }
export async function assertSandboxPath() { _w('assertSandboxPath'); return undefined; }
export async function resolveAllowedManagedMediaPath() { _w('resolveAllowedManagedMediaPath'); return undefined; }
export async function resolveSandboxedMediaSource() { _w('resolveSandboxedMediaSource'); return undefined; }
export function resolveSandboxInputPath() { _w('resolveSandboxInputPath'); return undefined; }
export function resolveSandboxPath() { _w('resolveSandboxPath'); return undefined; }
export function assertMediaNotDataUrl() { _w('assertMediaNotDataUrl'); return undefined; }
export function channelTargetSchema() { _w('channelTargetSchema'); return undefined; }
export function channelTargetsSchema() { _w('channelTargetsSchema'); return undefined; }
export function optionalStringEnum() { _w('optionalStringEnum'); return undefined; }
export function stringEnum() { _w('stringEnum'); return undefined; }
export async function imageResult() { _w('imageResult'); return undefined; }
export async function imageResultFromFile() { _w('imageResultFromFile'); return undefined; }
export function asToolParamsRecord() { _w('asToolParamsRecord'); return undefined; }
export function readReactionParams() { _w('readReactionParams'); return undefined; }
export function parseAvailableTags() { _w('parseAvailableTags'); return undefined; }
export async function fetchWithWebToolsNetworkGuard() { _w('fetchWithWebToolsNetworkGuard'); return undefined; }
export async function withTrustedWebToolsEndpoint() { _w('withTrustedWebToolsEndpoint'); return undefined; }
export async function withStrictWebToolsEndpoint() { _w('withStrictWebToolsEndpoint'); return undefined; }
export async function readResponseText() { _w('readResponseText'); return undefined; }
export function resolveTimeoutSeconds() { _w('resolveTimeoutSeconds'); return undefined; }
export function resolveCacheTtlMs() { _w('resolveCacheTtlMs'); return undefined; }
export function normalizeCacheKey() { _w('normalizeCacheKey'); return ""; }
export function readCache() { _w('readCache'); return undefined; }
export function writeCache() { _w('writeCache'); return undefined; }
export function withTimeout() { _w('withTimeout'); return undefined; }
export const DEFAULT_TIMEOUT_SECONDS = undefined;
export const DEFAULT_CACHE_TTL_MINUTES = undefined;
export async function extractBasicHtmlContent() { _w('extractBasicHtmlContent'); return undefined; }
export function normalizeWhitespace() { _w('normalizeWhitespace'); return ""; }
export function htmlToMarkdown() { _w('htmlToMarkdown'); return undefined; }
export function markdownToText() { _w('markdownToText'); return undefined; }
export function truncateText() { _w('truncateText'); return undefined; }
export async function agentCommand() { _w('agentCommand'); return undefined; }
export async function agentCommandFromIngress() { _w('agentCommandFromIngress'); return undefined; }
export const __testing = undefined;
export function _test() { _w('_test'); return undefined; }
export function buildTtsSystemPromptHint() { _w('buildTtsSystemPromptHint'); return undefined; }
export function getLastTtsAttempt() { _w('getLastTtsAttempt'); return undefined; }
export function getResolvedSpeechProviderConfig() { _w('getResolvedSpeechProviderConfig'); return undefined; }
export function getTtsMaxLength() { _w('getTtsMaxLength'); return undefined; }
export function getTtsPersona() { _w('getTtsPersona'); return undefined; }
export function getTtsProvider() { _w('getTtsProvider'); return undefined; }
export function isSummarizationEnabled() { _w('isSummarizationEnabled'); return false; }
export function isTtsEnabled() { _w('isTtsEnabled'); return false; }
export function isTtsProviderConfigured() { _w('isTtsProviderConfigured'); return false; }
export function listSpeechVoices() { _w('listSpeechVoices'); return []; }
export function listTtsPersonas() { _w('listTtsPersonas'); return []; }
export function maybeApplyTtsToPayload() { _w('maybeApplyTtsToPayload'); return undefined; }
export function resolveExplicitTtsOverrides() { _w('resolveExplicitTtsOverrides'); return undefined; }
export function resolveTtsAutoMode() { _w('resolveTtsAutoMode'); return undefined; }
export function resolveTtsConfig() { _w('resolveTtsConfig'); return undefined; }
export function resolveTtsPrefsPath() { _w('resolveTtsPrefsPath'); return undefined; }
export function resolveTtsProviderOrder() { _w('resolveTtsProviderOrder'); return undefined; }
export function setLastTtsAttempt() { _w('setLastTtsAttempt'); return undefined; }
export function setSummarizationEnabled() { _w('setSummarizationEnabled'); return undefined; }
export function setTtsAutoMode() { _w('setTtsAutoMode'); return undefined; }
export function setTtsEnabled() { _w('setTtsEnabled'); return undefined; }
export function setTtsMaxLength() { _w('setTtsMaxLength'); return undefined; }
export function setTtsPersona() { _w('setTtsPersona'); return undefined; }
export function setTtsProvider() { _w('setTtsProvider'); return undefined; }
export function synthesizeSpeech() { _w('synthesizeSpeech'); return undefined; }
export function textToSpeech() { _w('textToSpeech'); return undefined; }
export function textToSpeechTelephony() { _w('textToSpeechTelephony'); return undefined; }
