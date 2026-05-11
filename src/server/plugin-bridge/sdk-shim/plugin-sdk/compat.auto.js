// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/compat.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/compat.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveControlCommandGate() { _w('resolveControlCommandGate'); return undefined; }
export function applyAuthProfileConfig() { _w('applyAuthProfileConfig'); return undefined; }
export function buildApiKeyCredential() { _w('buildApiKeyCredential'); return undefined; }
export function upsertApiKeyProfile() { _w('upsertApiKeyProfile'); return undefined; }
export function writeOAuthCredentials() { _w('writeOAuthCredentials'); return undefined; }
export function createAccountStatusSink() { _w('createAccountStatusSink'); return undefined; }
export function KeyedAsyncQueue() { _w('KeyedAsyncQueue'); return undefined; }
export function createHybridChannelConfigAdapter() { _w('createHybridChannelConfigAdapter'); return undefined; }
export function createHybridChannelConfigBase() { _w('createHybridChannelConfigBase'); return undefined; }
export function createScopedAccountConfigAccessors() { _w('createScopedAccountConfigAccessors'); return undefined; }
export function createScopedChannelConfigAdapter() { _w('createScopedChannelConfigAdapter'); return undefined; }
export function createScopedChannelConfigBase() { _w('createScopedChannelConfigBase'); return undefined; }
export function createScopedDmSecurityResolver() { _w('createScopedDmSecurityResolver'); return undefined; }
export function createTopLevelChannelConfigAdapter() { _w('createTopLevelChannelConfigAdapter'); return undefined; }
export function createTopLevelChannelConfigBase() { _w('createTopLevelChannelConfigBase'); return undefined; }
export function formatNormalizedAllowFromEntries() { _w('formatNormalizedAllowFromEntries'); return ""; }
export function mapAllowlistResolutionInputs() { _w('mapAllowlistResolutionInputs'); return undefined; }
export function resolveBlueBubblesGroupRequireMention() { _w('resolveBlueBubblesGroupRequireMention'); return undefined; }
export function resolveBlueBubblesGroupToolPolicy() { _w('resolveBlueBubblesGroupToolPolicy'); return undefined; }
export function collectBlueBubblesStatusIssues() { _w('collectBlueBubblesStatusIssues'); return []; }
export const AllowFromListSchema = undefined;
export function buildCatchallMultiAccountChannelSchema() { _w('buildCatchallMultiAccountChannelSchema'); return undefined; }
export function buildNestedDmConfigSchema() { _w('buildNestedDmConfigSchema'); return undefined; }
export const BlockStreamingCoalesceSchema = undefined;
export const ContextVisibilityModeSchema = undefined;
export const DmConfigSchema = undefined;
export const DmPolicySchema = undefined;
export const GroupPolicySchema = undefined;
export const MarkdownConfigSchema = undefined;
export function ReplyRuntimeConfigSchemaShape() { _w('ReplyRuntimeConfigSchemaShape'); return undefined; }
export function requireOpenAllowFrom() { _w('requireOpenAllowFrom'); return undefined; }
export const ToolPolicySchema = undefined;
export function normalizeAllowFromList() { _w('normalizeAllowFromList'); return ""; }
export function coerceNativeSetting() { _w('coerceNativeSetting'); return undefined; }
export function createDangerousNameMatchingMutableAllowlistWarningCollector() { _w('createDangerousNameMatchingMutableAllowlistWarningCollector'); return undefined; }
export function createRestrictSendersChannelSecurity() { _w('createRestrictSendersChannelSecurity'); return undefined; }
export function composeAccountWarningCollectors() { _w('composeAccountWarningCollectors'); return undefined; }
export function buildOpenGroupPolicyConfigureRouteAllowlistWarning() { _w('buildOpenGroupPolicyConfigureRouteAllowlistWarning'); return undefined; }
export function composeWarningCollectors() { _w('composeWarningCollectors'); return undefined; }
export function createAllowlistProviderGroupPolicyWarningCollector() { _w('createAllowlistProviderGroupPolicyWarningCollector'); return undefined; }
export function createConditionalWarningCollector() { _w('createConditionalWarningCollector'); return undefined; }
export function createAllowlistProviderOpenWarningCollector() { _w('createAllowlistProviderOpenWarningCollector'); return undefined; }
export function createAllowlistProviderRouteAllowlistWarningCollector() { _w('createAllowlistProviderRouteAllowlistWarningCollector'); return undefined; }
export function createOpenGroupPolicyRestrictSendersWarningCollector() { _w('createOpenGroupPolicyRestrictSendersWarningCollector'); return undefined; }
export function createOpenProviderGroupPolicyWarningCollector() { _w('createOpenProviderGroupPolicyWarningCollector'); return undefined; }
export function createOpenProviderConfiguredRouteWarningCollector() { _w('createOpenProviderConfiguredRouteWarningCollector'); return undefined; }
export function buildOpenGroupPolicyRestrictSendersWarning() { _w('buildOpenGroupPolicyRestrictSendersWarning'); return undefined; }
export function buildOpenGroupPolicyWarning() { _w('buildOpenGroupPolicyWarning'); return undefined; }
export function collectAllowlistProviderGroupPolicyWarnings() { _w('collectAllowlistProviderGroupPolicyWarnings'); return []; }
export function collectOpenGroupPolicyRestrictSendersWarnings() { _w('collectOpenGroupPolicyRestrictSendersWarnings'); return []; }
export function collectOpenGroupPolicyRouteAllowlistWarnings() { _w('collectOpenGroupPolicyRouteAllowlistWarnings'); return []; }
export function collectOpenProviderGroupPolicyWarnings() { _w('collectOpenProviderGroupPolicyWarnings'); return []; }
export function projectAccountConfigWarningCollector() { _w('projectAccountConfigWarningCollector'); return undefined; }
export function projectAccountWarningCollector() { _w('projectAccountWarningCollector'); return undefined; }
export function projectConfigAccountIdWarningCollector() { _w('projectConfigAccountIdWarningCollector'); return undefined; }
export function projectConfigWarningCollector() { _w('projectConfigWarningCollector'); return undefined; }
export function projectWarningCollector() { _w('projectWarningCollector'); return undefined; }
export function buildAccountScopedDmSecurityPolicy() { _w('buildAccountScopedDmSecurityPolicy'); return undefined; }
export function resolveChannelGroupPolicy() { _w('resolveChannelGroupPolicy'); return undefined; }
export function resolveChannelGroupRequireMention() { _w('resolveChannelGroupRequireMention'); return undefined; }
export function resolveChannelGroupToolsPolicy() { _w('resolveChannelGroupToolsPolicy'); return undefined; }
export function resolveToolsBySender() { _w('resolveToolsBySender'); return undefined; }
export const DM_GROUP_ACCESS_REASON = undefined;
export function readStoreAllowFromForDmPolicy() { _w('readStoreAllowFromForDmPolicy'); return undefined; }
export function resolveDmGroupAccessWithCommandGate() { _w('resolveDmGroupAccessWithCommandGate'); return undefined; }
export function resolveDmGroupAccessWithLists() { _w('resolveDmGroupAccessWithLists'); return undefined; }
export function resolveEffectiveAllowFromLists() { _w('resolveEffectiveAllowFromLists'); return undefined; }
export function evaluateGroupRouteAccessForPolicy() { _w('evaluateGroupRouteAccessForPolicy'); return undefined; }
export function evaluateSenderGroupAccessForPolicy() { _w('evaluateSenderGroupAccessForPolicy'); return undefined; }
export function resolveSenderScopedGroupPolicy() { _w('resolveSenderScopedGroupPolicy'); return undefined; }
export function createAllowlistProviderRestrictSendersWarningCollector() { _w('createAllowlistProviderRestrictSendersWarningCollector'); return undefined; }
export const HISTORY_CONTEXT_MARKER = undefined;
export function buildHistoryContext() { _w('buildHistoryContext'); return undefined; }
export function buildHistoryContextFromEntries() { _w('buildHistoryContextFromEntries'); return undefined; }
export function buildHistoryContextFromMap() { _w('buildHistoryContextFromMap'); return undefined; }
export function clearHistoryEntries() { _w('clearHistoryEntries'); return undefined; }
export function evictOldHistoryKeys() { _w('evictOldHistoryKeys'); return undefined; }
export function recordPendingHistoryEntry() { _w('recordPendingHistoryEntry'); return undefined; }
export function createChannelDirectoryAdapter() { _w('createChannelDirectoryAdapter'); return undefined; }
export function createEmptyChannelDirectoryAdapter() { _w('createEmptyChannelDirectoryAdapter'); return undefined; }
export function emptyChannelDirectoryList() { _w('emptyChannelDirectoryList'); return undefined; }
export function nullChannelDirectorySelf() { _w('nullChannelDirectorySelf'); return undefined; }
export function applyDirectoryQueryAndLimit() { _w('applyDirectoryQueryAndLimit'); return undefined; }
export function collectNormalizedDirectoryIds() { _w('collectNormalizedDirectoryIds'); return []; }
export function createInspectedDirectoryEntriesLister() { _w('createInspectedDirectoryEntriesLister'); return undefined; }
export function createResolvedDirectoryEntriesLister() { _w('createResolvedDirectoryEntriesLister'); return undefined; }
export function listDirectoryEntriesFromSources() { _w('listDirectoryEntriesFromSources'); return []; }
export function listDirectoryGroupEntriesFromMapKeys() { _w('listDirectoryGroupEntriesFromMapKeys'); return []; }
export function listInspectedDirectoryEntriesFromSources() { _w('listInspectedDirectoryEntriesFromSources'); return []; }
export function listResolvedDirectoryEntriesFromSources() { _w('listResolvedDirectoryEntriesFromSources'); return []; }
export function listResolvedDirectoryGroupEntriesFromMapKeys() { _w('listResolvedDirectoryGroupEntriesFromMapKeys'); return []; }
export function listResolvedDirectoryUserEntriesFromAllowFrom() { _w('listResolvedDirectoryUserEntriesFromAllowFrom'); return []; }
export function listDirectoryUserEntriesFromAllowFrom() { _w('listDirectoryUserEntriesFromAllowFrom'); return []; }
export function toDirectoryEntries() { _w('toDirectoryEntries'); return undefined; }
export function createRuntimeDirectoryLiveAdapter() { _w('createRuntimeDirectoryLiveAdapter'); return undefined; }
export function inspectReadOnlyChannelAccount() { _w('inspectReadOnlyChannelAccount'); return undefined; }
