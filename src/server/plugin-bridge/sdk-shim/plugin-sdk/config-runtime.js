// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/config-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/config-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveDefaultAgentId() { _w('resolveDefaultAgentId'); return undefined; }
export function requireRuntimeConfig() { _w('requireRuntimeConfig'); return undefined; }
export function resolveLivePluginConfigObject() { _w('resolveLivePluginConfigObject'); return undefined; }
export function resolvePluginConfigObject() { _w('resolvePluginConfigObject'); return undefined; }
export function clearConfigCache() { _w('clearConfigCache'); return undefined; }
export function clearRuntimeConfigSnapshot() { _w('clearRuntimeConfigSnapshot'); return undefined; }
export function getRuntimeConfigSourceSnapshot() { _w('getRuntimeConfigSourceSnapshot'); return undefined; }
export function getRuntimeConfigSnapshot() { _w('getRuntimeConfigSnapshot'); return undefined; }
export function getRuntimeConfig() { _w('getRuntimeConfig'); return undefined; }
export function loadConfig() { _w('loadConfig'); return undefined; }
export function readConfigFileSnapshotForWrite() { _w('readConfigFileSnapshotForWrite'); return undefined; }
export function setRuntimeConfigSnapshot() { _w('setRuntimeConfigSnapshot'); return undefined; }
export function writeConfigFile() { _w('writeConfigFile'); return undefined; }
export function mutateConfigFile() { _w('mutateConfigFile'); return undefined; }
export function replaceConfigFile() { _w('replaceConfigFile'); return undefined; }
export function logConfigUpdated() { _w('logConfigUpdated'); return undefined; }
export function updateConfig() { _w('updateConfig'); return undefined; }
export function resolveChannelModelOverride() { _w('resolveChannelModelOverride'); return undefined; }
export function evaluateSupplementalContextVisibility() { _w('evaluateSupplementalContextVisibility'); return undefined; }
export function filterSupplementalContextItems() { _w('filterSupplementalContextItems'); return undefined; }
export function resolveChannelContextVisibilityMode() { _w('resolveChannelContextVisibilityMode'); return undefined; }
export function resolveDefaultContextVisibility() { _w('resolveDefaultContextVisibility'); return undefined; }
export function resolveMarkdownTableMode() { _w('resolveMarkdownTableMode'); return undefined; }
export function resolveChannelGroupPolicy() { _w('resolveChannelGroupPolicy'); return undefined; }
export function resolveChannelGroupRequireMention() { _w('resolveChannelGroupRequireMention'); return undefined; }
export function resolveToolsBySender() { _w('resolveToolsBySender'); return undefined; }
export const GROUP_POLICY_BLOCKED_LABEL = undefined;
export function resolveAllowlistProviderRuntimeGroupPolicy() { _w('resolveAllowlistProviderRuntimeGroupPolicy'); return undefined; }
export function resolveDefaultGroupPolicy() { _w('resolveDefaultGroupPolicy'); return undefined; }
export function resolveOpenProviderRuntimeGroupPolicy() { _w('resolveOpenProviderRuntimeGroupPolicy'); return undefined; }
export function warnMissingProviderGroupPolicyFallbackOnce() { _w('warnMissingProviderGroupPolicyFallbackOnce'); return undefined; }
export function isNativeCommandsExplicitlyDisabled() { _w('isNativeCommandsExplicitlyDisabled'); return false; }
export function resolveNativeCommandsEnabled() { _w('resolveNativeCommandsEnabled'); return undefined; }
export function resolveNativeSkillsEnabled() { _w('resolveNativeSkillsEnabled'); return undefined; }
export const TELEGRAM_COMMAND_NAME_PATTERN = undefined;
export function normalizeTelegramCommandName() { _w('normalizeTelegramCommandName'); return ""; }
export function resolveTelegramCustomCommands() { _w('resolveTelegramCustomCommands'); return undefined; }
export function resolveActiveTalkProviderConfig() { _w('resolveActiveTalkProviderConfig'); return undefined; }
export function resolveAgentMaxConcurrent() { _w('resolveAgentMaxConcurrent'); return undefined; }
export function loadCronStore() { _w('loadCronStore'); return undefined; }
export function resolveCronStorePath() { _w('resolveCronStorePath'); return undefined; }
export function saveCronStore() { _w('saveCronStore'); return undefined; }
export function applyModelOverrideToSessionEntry() { _w('applyModelOverrideToSessionEntry'); return undefined; }
export function coerceSecretRef() { _w('coerceSecretRef'); return undefined; }
export function resolveConfiguredSecretInputString() { _w('resolveConfiguredSecretInputString'); return undefined; }
export function resolveConfiguredSecretInputWithFallback() { _w('resolveConfiguredSecretInputWithFallback'); return undefined; }
export function resolveRequiredConfiguredSecretRefInputString() { _w('resolveRequiredConfiguredSecretRefInputString'); return undefined; }
export function clearSessionStoreCacheForTest() { _w('clearSessionStoreCacheForTest'); return undefined; }
export function loadSessionStore() { _w('loadSessionStore'); return undefined; }
export function readSessionUpdatedAt() { _w('readSessionUpdatedAt'); return undefined; }
export function recordSessionMetaFromInbound() { _w('recordSessionMetaFromInbound'); return undefined; }
export function saveSessionStore() { _w('saveSessionStore'); return undefined; }
export function updateLastRoute() { _w('updateLastRoute'); return undefined; }
export function updateSessionStore() { _w('updateSessionStore'); return undefined; }
export function resolveSessionStoreEntry() { _w('resolveSessionStoreEntry'); return undefined; }
export function resolveSessionKey() { _w('resolveSessionKey'); return undefined; }
export function resolveStorePath() { _w('resolveStorePath'); return undefined; }
export function resolveGroupSessionKey() { _w('resolveGroupSessionKey'); return undefined; }
export function canonicalizeMainSessionAlias() { _w('canonicalizeMainSessionAlias'); return undefined; }
export function evaluateSessionFreshness() { _w('evaluateSessionFreshness'); return undefined; }
export function resolveChannelResetConfig() { _w('resolveChannelResetConfig'); return undefined; }
export function resolveSessionResetPolicy() { _w('resolveSessionResetPolicy'); return undefined; }
export function resolveSessionResetType() { _w('resolveSessionResetType'); return undefined; }
export function resolveThreadFlag() { _w('resolveThreadFlag'); return undefined; }
export function isDangerousNameMatchingEnabled() { _w('isDangerousNameMatchingEnabled'); return false; }
export function resolveDangerousNameMatchingEnabled() { _w('resolveDangerousNameMatchingEnabled'); return undefined; }
