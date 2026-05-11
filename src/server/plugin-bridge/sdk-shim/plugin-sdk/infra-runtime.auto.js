// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/infra-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/infra-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function areDiagnosticsEnabledForProcess() { _w('areDiagnosticsEnabledForProcess'); return undefined; }
export function emitDiagnosticEvent() { _w('emitDiagnosticEvent'); return undefined; }
export function isDiagnosticsEnabled() { _w('isDiagnosticsEnabled'); return false; }
export function onDiagnosticEvent() { _w('onDiagnosticEvent'); return undefined; }
export function createRuntimeOutboundDelegates() { _w('createRuntimeOutboundDelegates'); return undefined; }
export async function drainPendingDeliveries() { _w('drainPendingDeliveries'); return undefined; }
export async function sleepWithAbort() { _w('sleepWithAbort'); return undefined; }
export function computeBackoff() { _w('computeBackoff'); return undefined; }
export function recordChannelActivity() { _w('recordChannelActivity'); return undefined; }
export function getChannelActivity() { _w('getChannelActivity'); return undefined; }
export function resetChannelActivityForTest() { _w('resetChannelActivityForTest'); return undefined; }
export function createDedupeCache() { _w('createDedupeCache'); return undefined; }
export function resolveGlobalDedupeCache() { _w('resolveGlobalDedupeCache'); return undefined; }
export function resolveDiagnosticFlags() { _w('resolveDiagnosticFlags'); return undefined; }
export function matchesDiagnosticFlag() { _w('matchesDiagnosticFlag'); return undefined; }
export function isDiagnosticFlagEnabled() { _w('isDiagnosticFlagEnabled'); return false; }
export function logAcceptedEnvOption() { _w('logAcceptedEnvOption'); return undefined; }
export function normalizeZaiEnv() { _w('normalizeZaiEnv'); return ""; }
export function isTruthyEnvValue() { _w('isTruthyEnvValue'); return false; }
export function isVitestRuntimeEnv() { _w('isVitestRuntimeEnv'); return false; }
export function normalizeEnv() { _w('normalizeEnv'); return ""; }
export function extractErrorCode() { _w('extractErrorCode'); return undefined; }
export function readErrorName() { _w('readErrorName'); return undefined; }
export function collectErrorGraphCandidates() { _w('collectErrorGraphCandidates'); return []; }
export function isErrno() { _w('isErrno'); return false; }
export function hasErrnoCode() { _w('hasErrnoCode'); return false; }
export function formatErrorMessage() { _w('formatErrorMessage'); return ""; }
export function formatUncaughtError() { _w('formatUncaughtError'); return ""; }
export function detectErrorKind() { _w('detectErrorKind'); return undefined; }
export function sanitizeExecApprovalDisplayText() { _w('sanitizeExecApprovalDisplayText'); return ""; }
export function resolveExecApprovalCommandDisplay() { _w('resolveExecApprovalCommandDisplay'); return undefined; }
export function isExecApprovalChannelRuntimeTerminalStartError() { _w('isExecApprovalChannelRuntimeTerminalStartError'); return false; }
export function createExecApprovalChannelRuntime() { _w('createExecApprovalChannelRuntime'); return undefined; }
export class ExecApprovalChannelRuntimeTerminalStartError { constructor() { _w('ExecApprovalChannelRuntimeTerminalStartError'); } }
export function buildExecApprovalCommandText() { _w('buildExecApprovalCommandText'); return undefined; }
export function buildExecApprovalActionDescriptors() { _w('buildExecApprovalActionDescriptors'); return undefined; }
export function buildApprovalInteractiveReplyFromActionDescriptors() { _w('buildApprovalInteractiveReplyFromActionDescriptors'); return undefined; }
export function buildApprovalInteractiveReply() { _w('buildApprovalInteractiveReply'); return undefined; }
export function buildExecApprovalInteractiveReply() { _w('buildExecApprovalInteractiveReply'); return undefined; }
export function getExecApprovalApproverDmNoticeText() { _w('getExecApprovalApproverDmNoticeText'); return undefined; }
export function parseExecApprovalCommandText() { _w('parseExecApprovalCommandText'); return undefined; }
export function formatExecApprovalExpiresIn() { _w('formatExecApprovalExpiresIn'); return ""; }
export function getExecApprovalReplyMetadata() { _w('getExecApprovalReplyMetadata'); return undefined; }
export function buildExecApprovalPendingReplyPayload() { _w('buildExecApprovalPendingReplyPayload'); return undefined; }
export function buildExecApprovalUnavailableReplyPayload() { _w('buildExecApprovalUnavailableReplyPayload'); return undefined; }
export function resolveApprovalRequestSessionConversation() { _w('resolveApprovalRequestSessionConversation'); return undefined; }
export function resolveExecApprovalSessionTarget() { _w('resolveExecApprovalSessionTarget'); return undefined; }
export function resolveApprovalRequestSessionTarget() { _w('resolveApprovalRequestSessionTarget'); return undefined; }
export function resolveApprovalRequestOriginTarget() { _w('resolveApprovalRequestOriginTarget'); return undefined; }
export function doesApprovalRequestMatchChannelAccount() { _w('doesApprovalRequestMatchChannelAccount'); return false; }
export function resolveApprovalRequestAccountId() { _w('resolveApprovalRequestAccountId'); return undefined; }
export function resolveApprovalRequestChannelAccountId() { _w('resolveApprovalRequestChannelAccountId'); return undefined; }
export async function requestExecApprovalViaSocket() { _w('requestExecApprovalViaSocket'); return undefined; }
export function normalizeExecHost() { _w('normalizeExecHost'); return ""; }
export function normalizeExecTarget() { _w('normalizeExecTarget'); return ""; }
export function normalizeExecSecurity() { _w('normalizeExecSecurity'); return ""; }
export function normalizeExecAsk() { _w('normalizeExecAsk'); return ""; }
export function resolveExecApprovalsPath() { _w('resolveExecApprovalsPath'); return undefined; }
export function resolveExecApprovalsSocketPath() { _w('resolveExecApprovalsSocketPath'); return undefined; }
export function normalizeExecApprovals() { _w('normalizeExecApprovals'); return ""; }
export function mergeExecApprovalsSocketDefaults() { _w('mergeExecApprovalsSocketDefaults'); return undefined; }
export function readExecApprovalsSnapshot() { _w('readExecApprovalsSnapshot'); return undefined; }
export function loadExecApprovals() { _w('loadExecApprovals'); return undefined; }
export function saveExecApprovals() { _w('saveExecApprovals'); return undefined; }
export function restoreExecApprovalsSnapshot() { _w('restoreExecApprovalsSnapshot'); return undefined; }
export function ensureExecApprovals() { _w('ensureExecApprovals'); return undefined; }
export function resolveExecApprovals() { _w('resolveExecApprovals'); return undefined; }
export function resolveExecApprovalsFromFile() { _w('resolveExecApprovalsFromFile'); return undefined; }
export function requiresExecApproval() { _w('requiresExecApproval'); return undefined; }
export function hasDurableExecApproval() { _w('hasDurableExecApproval'); return false; }
export function recordAllowlistUse() { _w('recordAllowlistUse'); return undefined; }
export function recordAllowlistMatchesUse() { _w('recordAllowlistMatchesUse'); return undefined; }
export function addAllowlistEntry() { _w('addAllowlistEntry'); return undefined; }
export function addDurableCommandApproval() { _w('addDurableCommandApproval'); return undefined; }
export function persistAllowAlwaysPatterns() { _w('persistAllowAlwaysPatterns'); return undefined; }
export function minSecurity() { _w('minSecurity'); return undefined; }
export function maxAsk() { _w('maxAsk'); return undefined; }
export function resolveExecApprovalAllowedDecisions() { _w('resolveExecApprovalAllowedDecisions'); return undefined; }
export function resolveExecApprovalRequestAllowedDecisions() { _w('resolveExecApprovalRequestAllowedDecisions'); return undefined; }
export function isExecApprovalDecisionAllowed() { _w('isExecApprovalDecisionAllowed'); return false; }
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = undefined;
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK = undefined;
export const DEFAULT_EXEC_APPROVAL_DECISIONS = undefined;
export function isWindowsPlatform() { _w('isWindowsPlatform'); return false; }
export function splitCommandChainWithOperators() { _w('splitCommandChainWithOperators'); return undefined; }
export function windowsEscapeArg() { _w('windowsEscapeArg'); return undefined; }
export function buildSafeShellCommand() { _w('buildSafeShellCommand'); return undefined; }
export function resolvePlannedSegmentArgv() { _w('resolvePlannedSegmentArgv'); return undefined; }
export function buildSafeBinsShellCommand() { _w('buildSafeBinsShellCommand'); return undefined; }
export function buildEnforcedShellCommand() { _w('buildEnforcedShellCommand'); return undefined; }
export function splitCommandChain() { _w('splitCommandChain'); return undefined; }
export function analyzeShellCommand() { _w('analyzeShellCommand'); return undefined; }
export function analyzeArgvCommand() { _w('analyzeArgvCommand'); return undefined; }
export function matchAllowlist() { _w('matchAllowlist'); return undefined; }
export function parseExecArgvToken() { _w('parseExecArgvToken'); return undefined; }
export function resolveAllowlistCandidatePath() { _w('resolveAllowlistCandidatePath'); return undefined; }
export function resolveApprovalAuditCandidatePath() { _w('resolveApprovalAuditCandidatePath'); return undefined; }
export function resolveCommandResolution() { _w('resolveCommandResolution'); return undefined; }
export function resolveCommandResolutionFromArgv() { _w('resolveCommandResolutionFromArgv'); return undefined; }
export function resolveExecutionTargetCandidatePath() { _w('resolveExecutionTargetCandidatePath'); return undefined; }
export function resolveExecutionTargetResolution() { _w('resolveExecutionTargetResolution'); return undefined; }
export function resolvePolicyAllowlistCandidatePath() { _w('resolvePolicyAllowlistCandidatePath'); return undefined; }
export function resolvePolicyTargetCandidatePath() { _w('resolvePolicyTargetCandidatePath'); return undefined; }
export function resolvePolicyTargetResolution() { _w('resolvePolicyTargetResolution'); return undefined; }
export function normalizeSafeBins() { _w('normalizeSafeBins'); return ""; }
export function resolveSafeBins() { _w('resolveSafeBins'); return undefined; }
export function isSafeBinUsage() { _w('isSafeBinUsage'); return false; }
export function evaluateExecAllowlist() { _w('evaluateExecAllowlist'); return undefined; }
export function resolveAllowAlwaysPatternEntries() { _w('resolveAllowAlwaysPatternEntries'); return undefined; }
export function resolveAllowAlwaysPatterns() { _w('resolveAllowAlwaysPatterns'); return undefined; }
export function evaluateShellAllowlist() { _w('evaluateShellAllowlist'); return undefined; }
export async function resolveChannelNativeApprovalDeliveryPlan() { _w('resolveChannelNativeApprovalDeliveryPlan'); return undefined; }
export async function deliverApprovalRequestViaChannelNativePlan() { _w('deliverApprovalRequestViaChannelNativePlan'); return undefined; }
export function createChannelNativeApprovalRuntime() { _w('createChannelNativeApprovalRuntime'); return undefined; }
export function formatApprovalDisplayPath() { _w('formatApprovalDisplayPath'); return ""; }
export function approvalDecisionLabel() { _w('approvalDecisionLabel'); return undefined; }
export function buildPluginApprovalRequestMessage() { _w('buildPluginApprovalRequestMessage'); return undefined; }
export function buildPluginApprovalResolvedMessage() { _w('buildPluginApprovalResolvedMessage'); return undefined; }
export function buildPluginApprovalExpiredMessage() { _w('buildPluginApprovalExpiredMessage'); return undefined; }
export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = undefined;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = undefined;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = undefined;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = undefined;
export function wrapFetchWithAbortSignal() { _w('wrapFetchWithAbortSignal'); return undefined; }
export function resolveFetch() { _w('resolveFetch'); return undefined; }
export function drainFileLockStateForTest() { _w('drainFileLockStateForTest'); return undefined; }
export const FILE_LOCK_TIMEOUT_ERROR_CODE = undefined;
export function resetFileLockStateForTest() { _w('resetFileLockStateForTest'); return undefined; }
export function formatDurationSeconds() { _w('formatDurationSeconds'); return ""; }
export function formatDurationPrecise() { _w('formatDurationPrecise'); return ""; }
export function formatDurationCompact() { _w('formatDurationCompact'); return ""; }
export function formatDurationHuman() { _w('formatDurationHuman'); return ""; }
export async function openFileWithinRoot() { _w('openFileWithinRoot'); return undefined; }
export async function readFileWithinRoot() { _w('readFileWithinRoot'); return undefined; }
export async function readPathWithinRoot() { _w('readPathWithinRoot'); return undefined; }
export async function readLocalFileSafely() { _w('readLocalFileSafely'); return undefined; }
export async function openLocalFileSafely() { _w('openLocalFileSafely'); return undefined; }
export async function resolveOpenedFileRealPathForHandle() { _w('resolveOpenedFileRealPathForHandle'); return undefined; }
export async function openWritableFileWithinRoot() { _w('openWritableFileWithinRoot'); return undefined; }
export async function appendFileWithinRoot() { _w('appendFileWithinRoot'); return undefined; }
export async function removePathWithinRoot() { _w('removePathWithinRoot'); return undefined; }
export async function mkdirPathWithinRoot() { _w('mkdirPathWithinRoot'); return undefined; }
export async function writeFileWithinRoot() { _w('writeFileWithinRoot'); return undefined; }
export async function copyFileWithinRoot() { _w('copyFileWithinRoot'); return undefined; }
export async function writeFileFromPathWithinRoot() { _w('writeFileFromPathWithinRoot'); return undefined; }
export function __setFsSafeTestHooksForTest() { _w('__setFsSafeTestHooksForTest'); return undefined; }
export function createRootScopedReadFile() { _w('createRootScopedReadFile'); return undefined; }
export class SafeOpenError { constructor() { _w('SafeOpenError'); } }
export function resolveIndicatorType() { _w('resolveIndicatorType'); return undefined; }
export function emitHeartbeatEvent() { _w('emitHeartbeatEvent'); return undefined; }
export function onHeartbeatEvent() { _w('onHeartbeatEvent'); return undefined; }
export function getLastHeartbeatEvent() { _w('getLastHeartbeatEvent'); return undefined; }
export function resetHeartbeatEventsForTest() { _w('resetHeartbeatEventsForTest'); return undefined; }
export function isHeartbeatEnabledForAgent() { _w('isHeartbeatEnabledForAgent'); return false; }
export function resolveHeartbeatIntervalMs() { _w('resolveHeartbeatIntervalMs'); return undefined; }
export function resolveHeartbeatSummaryForAgent() { _w('resolveHeartbeatSummaryForAgent'); return undefined; }
export function resolveHeartbeatVisibility() { _w('resolveHeartbeatVisibility'); return undefined; }
export function resolveEffectiveHomeDir() { _w('resolveEffectiveHomeDir'); return undefined; }
export function resolveOsHomeDir() { _w('resolveOsHomeDir'); return undefined; }
export function resolveRequiredHomeDir() { _w('resolveRequiredHomeDir'); return undefined; }
export function resolveRequiredOsHomeDir() { _w('resolveRequiredOsHomeDir'); return undefined; }
export function expandHomePrefix() { _w('expandHomePrefix'); return undefined; }
export function resolveHomeRelativePath() { _w('resolveHomeRelativePath'); return undefined; }
export function resolveOsHomeRelativePath() { _w('resolveOsHomeRelativePath'); return undefined; }
export async function readRequestBodyWithLimit() { _w('readRequestBodyWithLimit'); return undefined; }
export async function readJsonBodyWithLimit() { _w('readJsonBodyWithLimit'); return undefined; }
export function isRequestBodyLimitError() { _w('isRequestBodyLimitError'); return false; }
export function requestBodyErrorToText() { _w('requestBodyErrorToText'); return undefined; }
export function installRequestBodyLimitGuard() { _w('installRequestBodyLimitGuard'); return undefined; }
export class RequestBodyLimitError { constructor() { _w('RequestBodyLimitError'); } }
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = undefined;
export const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = undefined;
export async function readJsonFile() { _w('readJsonFile'); return undefined; }
export async function readDurableJsonFile() { _w('readDurableJsonFile'); return undefined; }
export async function writeJsonAtomic() { _w('writeJsonAtomic'); return undefined; }
export async function writeTextAtomic() { _w('writeTextAtomic'); return undefined; }
export function readJsonFileSync() { _w('readJsonFileSync'); return undefined; }
export function createAsyncLock() { _w('createAsyncLock'); return undefined; }
export class JsonFileReadError { constructor() { _w('JsonFileReadError'); } }
export function hasEncodedFileUrlSeparator() { _w('hasEncodedFileUrlSeparator'); return false; }
export function isWindowsNetworkPath() { _w('isWindowsNetworkPath'); return false; }
export function assertNoWindowsNetworkPath() { _w('assertNoWindowsNetworkPath'); return undefined; }
export function safeFileURLToPath() { _w('safeFileURLToPath'); return undefined; }
export function trySafeFileURLToPath() { _w('trySafeFileURLToPath'); return undefined; }
export function basenameFromMediaSource() { _w('basenameFromMediaSource'); return undefined; }
export function pruneMapToMaxSize() { _w('pruneMapToMaxSize'); return undefined; }
export function normalizeHostname() { _w('normalizeHostname'); return ""; }
export async function fetchWithSsrFGuard() { _w('fetchWithSsrFGuard'); return undefined; }
export function withStrictGuardedFetchMode() { _w('withStrictGuardedFetchMode'); return undefined; }
export function withTrustedEnvProxyGuardedFetchMode() { _w('withTrustedEnvProxyGuardedFetchMode'); return undefined; }
export function withTrustedExplicitProxyGuardedFetchMode() { _w('withTrustedExplicitProxyGuardedFetchMode'); return undefined; }
export function retainSafeHeadersForCrossOriginRedirectHeaders() { _w('retainSafeHeadersForCrossOriginRedirectHeaders'); return undefined; }
export const GUARDED_FETCH_MODE = undefined;
export function fetchWithRuntimeDispatcher() { _w('fetchWithRuntimeDispatcher'); return undefined; }
export function hasProxyEnvConfigured() { _w('hasProxyEnvConfigured'); return false; }
export function resolveEnvHttpProxyUrl() { _w('resolveEnvHttpProxyUrl'); return undefined; }
export function hasEnvHttpProxyConfigured() { _w('hasEnvHttpProxyConfigured'); return false; }
export function resolveEnvHttpProxyAgentOptions() { _w('resolveEnvHttpProxyAgentOptions'); return undefined; }
export function hasEnvHttpProxyAgentConfigured() { _w('hasEnvHttpProxyAgentConfigured'); return false; }
export function shouldUseEnvHttpProxyForUrl() { _w('shouldUseEnvHttpProxyForUrl'); return false; }
export function matchesNoProxy() { _w('matchesNoProxy'); return undefined; }
export const PROXY_ENV_KEYS = undefined;
export function makeProxyFetch() { _w('makeProxyFetch'); return undefined; }
export function getProxyUrlFromFetch() { _w('getProxyUrlFromFetch'); return undefined; }
export function resolveProxyFetchFromEnv() { _w('resolveProxyFetchFromEnv'); return undefined; }
export const PROXY_FETCH_PROXY_URL = undefined;
export function ensureGlobalUndiciEnvProxyDispatcher() { _w('ensureGlobalUndiciEnvProxyDispatcher'); return undefined; }
export function ensureGlobalUndiciStreamTimeouts() { _w('ensureGlobalUndiciStreamTimeouts'); return undefined; }
export function resetGlobalUndiciStreamTimeoutsForTests() { _w('resetGlobalUndiciStreamTimeoutsForTests'); return undefined; }
export function forceResetGlobalDispatcher() { _w('forceResetGlobalDispatcher'); return undefined; }
export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = undefined;
export const _globalUndiciStreamTimeoutMs = undefined;
export async function resolvePinnedHostnameWithPolicy() { _w('resolvePinnedHostnameWithPolicy'); return undefined; }
export async function resolvePinnedHostname() { _w('resolvePinnedHostname'); return undefined; }
export async function closeDispatcher() { _w('closeDispatcher'); return undefined; }
export async function assertPublicHostname() { _w('assertPublicHostname'); return undefined; }
export function isSameSsrFPolicy() { _w('isSameSsrFPolicy'); return false; }
export function ssrfPolicyFromHttpBaseUrlAllowedHostname() { _w('ssrfPolicyFromHttpBaseUrlAllowedHostname'); return undefined; }
export function normalizeHostnameAllowlist() { _w('normalizeHostnameAllowlist'); return ""; }
export function isPrivateNetworkAllowedByPolicy() { _w('isPrivateNetworkAllowedByPolicy'); return false; }
export function isHostnameAllowedByPattern() { _w('isHostnameAllowedByPattern'); return false; }
export function matchesHostnameAllowlist() { _w('matchesHostnameAllowlist'); return undefined; }
export function isPrivateIpAddress() { _w('isPrivateIpAddress'); return false; }
export function isBlockedHostname() { _w('isBlockedHostname'); return false; }
export function isBlockedHostnameOrIp() { _w('isBlockedHostnameOrIp'); return false; }
export function createPinnedLookup() { _w('createPinnedLookup'); return undefined; }
export function assertHostnameAllowedWithPolicy() { _w('assertHostnameAllowedWithPolicy'); return undefined; }
export function createPinnedDispatcher() { _w('createPinnedDispatcher'); return undefined; }
export class SsrFBlockedError { constructor() { _w('SsrFBlockedError'); } }
export function normalizeOutboundIdentity() { _w('normalizeOutboundIdentity'); return ""; }
export function resolveAgentOutboundIdentity() { _w('resolveAgentOutboundIdentity'); return undefined; }
export function sanitizeForPlainText() { _w('sanitizeForPlainText'); return ""; }
export function parseFiniteNumber() { _w('parseFiniteNumber'); return undefined; }
export function parseStrictInteger() { _w('parseStrictInteger'); return undefined; }
export function parseStrictPositiveInteger() { _w('parseStrictPositiveInteger'); return undefined; }
export function parseStrictNonNegativeInteger() { _w('parseStrictNonNegativeInteger'); return undefined; }
export function resolveLegacyOutboundSendDepKeys() { _w('resolveLegacyOutboundSendDepKeys'); return undefined; }
export function resolveOutboundSendDep() { _w('resolveOutboundSendDep'); return undefined; }
export async function retryAsync() { _w('retryAsync'); return undefined; }
export function resolveRetryConfig() { _w('resolveRetryConfig'); return undefined; }
export function createRateLimitRetryRunner() { _w('createRateLimitRetryRunner'); return undefined; }
export function createChannelApiRetryRunner() { _w('createChannelApiRetryRunner'); return undefined; }
export const CHANNEL_API_RETRY_DEFAULTS = undefined;
export function normalizeScpRemoteHost() { _w('normalizeScpRemoteHost'); return ""; }
export function isSafeScpRemoteHost() { _w('isSafeScpRemoteHost'); return false; }
export function normalizeScpRemotePath() { _w('normalizeScpRemotePath'); return ""; }
export function isSafeScpRemotePath() { _w('isSafeScpRemotePath'); return false; }
export async function writePrivateSecretFileAtomic() { _w('writePrivateSecretFileAtomic'); return undefined; }
export function loadSecretFileSync() { _w('loadSecretFileSync'); return undefined; }
export function readSecretFileSync() { _w('readSecretFileSync'); return undefined; }
export function tryReadSecretFileSync() { _w('tryReadSecretFileSync'); return undefined; }
export const DEFAULT_SECRET_FILE_MAX_BYTES = undefined;
export const PRIVATE_SECRET_DIR_MODE = undefined;
export const PRIVATE_SECRET_FILE_MODE = undefined;
export function generateSecureUuid() { _w('generateSecureUuid'); return undefined; }
export function generateSecureToken() { _w('generateSecureToken'); return undefined; }
export function generateSecureHex() { _w('generateSecureHex'); return undefined; }
export function generateSecureFraction() { _w('generateSecureFraction'); return undefined; }
export function generateSecureInt() { _w('generateSecureInt'); return undefined; }
export function isSystemEventContextChanged() { _w('isSystemEventContextChanged'); return false; }
export function enqueueSystemEvent() { _w('enqueueSystemEvent'); return undefined; }
export function drainSystemEventEntries() { _w('drainSystemEventEntries'); return undefined; }
export function consumeSystemEventEntries() { _w('consumeSystemEventEntries'); return undefined; }
export function drainSystemEvents() { _w('drainSystemEvents'); return undefined; }
export function peekSystemEventEntries() { _w('peekSystemEventEntries'); return undefined; }
export function peekSystemEvents() { _w('peekSystemEvents'); return undefined; }
export function hasSystemEvents() { _w('hasSystemEvents'); return false; }
export function resolveSystemEventDeliveryContext() { _w('resolveSystemEventDeliveryContext'); return undefined; }
export function resetSystemEventsForTest() { _w('resetSystemEventsForTest'); return undefined; }
export function hasSystemMark() { _w('hasSystemMark'); return false; }
export function prefixSystemMessage() { _w('prefixSystemMessage'); return undefined; }
export const SYSTEM_MARK = undefined;
export const POSIX_OPENCLAW_TMP_DIR = undefined;
export async function waitForTransportReady() { _w('waitForTransportReady'); return undefined; }
export async function isWSL() { _w('isWSL'); return false; }
export function resetWSLStateForTests() { _w('resetWSLStateForTests'); return undefined; }
export function isWSLEnv() { _w('isWSLEnv'); return false; }
export function isWSLSync() { _w('isWSLSync'); return false; }
export function isWSL2Sync() { _w('isWSL2Sync'); return false; }
export async function fetchWithTimeout() { _w('fetchWithTimeout'); return undefined; }
export function bindAbortRelay() { _w('bindAbortRelay'); return undefined; }
export function buildTimeoutAbortSignal() { _w('buildTimeoutAbortSignal'); return undefined; }
export async function runTasksWithConcurrency() { _w('runTasksWithConcurrency'); return undefined; }
export async function assertHttpUrlTargetsPrivateNetwork() { _w('assertHttpUrlTargetsPrivateNetwork'); return undefined; }
export function isPrivateNetworkOptInEnabled() { _w('isPrivateNetworkOptInEnabled'); return false; }
export function ssrfPolicyFromPrivateNetworkOptIn() { _w('ssrfPolicyFromPrivateNetworkOptIn'); return undefined; }
export function ssrfPolicyFromDangerouslyAllowPrivateNetwork() { _w('ssrfPolicyFromDangerouslyAllowPrivateNetwork'); return undefined; }
export function mergeSsrFPolicies() { _w('mergeSsrFPolicies'); return undefined; }
export function hasLegacyFlatAllowPrivateNetworkAlias() { _w('hasLegacyFlatAllowPrivateNetworkAlias'); return false; }
export function migrateLegacyFlatAllowPrivateNetworkAlias() { _w('migrateLegacyFlatAllowPrivateNetworkAlias'); return undefined; }
export function createLegacyPrivateNetworkDoctorContract() { _w('createLegacyPrivateNetworkDoctorContract'); return undefined; }
export function ssrfPolicyFromAllowPrivateNetwork() { _w('ssrfPolicyFromAllowPrivateNetwork'); return undefined; }
export function normalizeHostnameSuffixAllowlist() { _w('normalizeHostnameSuffixAllowlist'); return ""; }
export function isHttpsUrlAllowedByHostnameSuffixAllowlist() { _w('isHttpsUrlAllowedByHostnameSuffixAllowlist'); return false; }
export function buildHostnameAllowlistPolicyFromSuffixAllowlist() { _w('buildHostnameAllowlistPolicyFromSuffixAllowlist'); return undefined; }
