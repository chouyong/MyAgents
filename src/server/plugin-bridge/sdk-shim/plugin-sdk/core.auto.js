// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/core.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/core.' + fn + '() not implemented in Bridge mode'); }
}

export async function ensureConfiguredAcpBindingReady() { _w('ensureConfiguredAcpBindingReady'); return undefined; }
export function getChatChannelMeta() { _w('getChatChannelMeta'); return undefined; }
export function recoverCurrentThreadSessionId() { _w('recoverCurrentThreadSessionId'); return undefined; }
export function buildThreadAwareOutboundSessionRoute() { _w('buildThreadAwareOutboundSessionRoute'); return undefined; }
export function defineSetupPluginEntry() { _w('defineSetupPluginEntry'); return undefined; }
export function isSecretRef() { _w('isSecretRef'); return false; }
export function definePluginEntry() { _w('definePluginEntry'); return undefined; }
export function buildPluginConfigSchema() { _w('buildPluginConfigSchema'); return undefined; }
export function emptyPluginConfigSchema() { _w('emptyPluginConfigSchema'); return undefined; }
export function KeyedAsyncQueue() { _w('KeyedAsyncQueue'); return undefined; }
export function enqueueKeyedTask() { _w('enqueueKeyedTask'); return undefined; }
export function createDedupeCache() { _w('createDedupeCache'); return undefined; }
export function resolveGlobalDedupeCache() { _w('resolveGlobalDedupeCache'); return undefined; }
export function generateSecureToken() { _w('generateSecureToken'); return undefined; }
export function generateSecureUuid() { _w('generateSecureUuid'); return undefined; }
export function buildMemorySystemPromptAddition() { _w('buildMemorySystemPromptAddition'); return undefined; }
export function delegateCompactionToRuntime() { _w('delegateCompactionToRuntime'); return undefined; }
export function buildChannelConfigSchema() { _w('buildChannelConfigSchema'); return undefined; }
export function emptyChannelConfigSchema() { _w('emptyChannelConfigSchema'); return undefined; }
export function applyAccountNameToChannelSection() { _w('applyAccountNameToChannelSection'); return undefined; }
export function migrateBaseNameToDefaultAccount() { _w('migrateBaseNameToDefaultAccount'); return undefined; }
export function clearAccountEntryFields() { _w('clearAccountEntryFields'); return undefined; }
export function deleteAccountFromConfigSection() { _w('deleteAccountFromConfigSection'); return undefined; }
export function setAccountEnabledInConfigSection() { _w('setAccountEnabledInConfigSection'); return undefined; }
export function formatPairingApproveHint() { _w('formatPairingApproveHint'); return ""; }
export function parseOptionalDelimitedEntries() { _w('parseOptionalDelimitedEntries'); return undefined; }
export function channelTargetSchema() { _w('channelTargetSchema'); return undefined; }
export function channelTargetsSchema() { _w('channelTargetsSchema'); return undefined; }
export function optionalStringEnum() { _w('optionalStringEnum'); return undefined; }
export function stringEnum() { _w('stringEnum'); return undefined; }
export const DEFAULT_SECRET_FILE_MAX_BYTES = undefined;
export function loadSecretFileSync() { _w('loadSecretFileSync'); return undefined; }
export function readSecretFileSync() { _w('readSecretFileSync'); return undefined; }
export function tryReadSecretFileSync() { _w('tryReadSecretFileSync'); return undefined; }
export function resolveGatewayBindUrl() { _w('resolveGatewayBindUrl'); return undefined; }
export function resolveGatewayPort() { _w('resolveGatewayPort'); return undefined; }
export function createSubsystemLogger() { _w('createSubsystemLogger'); return undefined; }
export function normalizeAtHashSlug() { _w('normalizeAtHashSlug'); return ""; }
export function normalizeHyphenSlug() { _w('normalizeHyphenSlug'); return ""; }
export function createActionGate() { _w('createActionGate'); return undefined; }
export function jsonResult() { _w('jsonResult'); return undefined; }
export function readNumberParam() { _w('readNumberParam'); return undefined; }
export function readReactionParams() { _w('readReactionParams'); return undefined; }
export function readStringArrayParam() { _w('readStringArrayParam'); return undefined; }
export function readStringParam() { _w('readStringParam'); return undefined; }
export function parseStrictPositiveInteger() { _w('parseStrictPositiveInteger'); return undefined; }
export function isTrustedProxyAddress() { _w('isTrustedProxyAddress'); return false; }
export function resolveClientIp() { _w('resolveClientIp'); return undefined; }
export function formatZonedTimestamp() { _w('formatZonedTimestamp'); return ""; }
export function resolveConfiguredAcpBindingRecord() { _w('resolveConfiguredAcpBindingRecord'); return undefined; }
export function resolveTailnetHostWithRunner() { _w('resolveTailnetHostWithRunner'); return undefined; }
export function buildAgentSessionKey() { _w('buildAgentSessionKey'); return undefined; }
export function resolveThreadSessionKeys() { _w('resolveThreadSessionKeys'); return undefined; }
