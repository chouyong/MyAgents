// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/text-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/text-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function hasNonEmptyString() { _w('hasNonEmptyString'); return false; }
export function localeLowercasePreservingWhitespace() { _w('localeLowercasePreservingWhitespace'); return undefined; }
export function lowercasePreservingWhitespace() { _w('lowercasePreservingWhitespace'); return undefined; }
export function normalizeLowercaseStringOrEmpty() { _w('normalizeLowercaseStringOrEmpty'); return ""; }
export function normalizeNullableString() { _w('normalizeNullableString'); return ""; }
export function normalizeOptionalLowercaseString() { _w('normalizeOptionalLowercaseString'); return ""; }
export function normalizeOptionalString() { _w('normalizeOptionalString'); return ""; }
export function normalizeStringifiedOptionalString() { _w('normalizeStringifiedOptionalString'); return ""; }
export function readStringValue() { _w('readStringValue'); return undefined; }
export const CONFIG_DIR = undefined;
export function clamp() { _w('clamp'); return undefined; }
export function clampInt() { _w('clampInt'); return undefined; }
export function clampNumber() { _w('clampNumber'); return undefined; }
export function displayPath() { _w('displayPath'); return undefined; }
export function displayString() { _w('displayString'); return undefined; }
export function ensureDir() { _w('ensureDir'); return undefined; }
export function escapeRegExp() { _w('escapeRegExp'); return undefined; }
export function isRecord() { _w('isRecord'); return false; }
export function normalizeE164() { _w('normalizeE164'); return ""; }
export function pathExists() { _w('pathExists'); return undefined; }
export function resolveConfigDir() { _w('resolveConfigDir'); return undefined; }
export function resolveHomeDir() { _w('resolveHomeDir'); return undefined; }
export function resolveUserPath() { _w('resolveUserPath'); return undefined; }
export function safeParseJson() { _w('safeParseJson'); return undefined; }
export function shortenHomeInString() { _w('shortenHomeInString'); return undefined; }
export function shortenHomePath() { _w('shortenHomePath'); return undefined; }
export function sleep() { _w('sleep'); return undefined; }
export function sliceUtf16Safe() { _w('sliceUtf16Safe'); return undefined; }
export function truncateUtf16Safe() { _w('truncateUtf16Safe'); return undefined; }
export function logInfo() { _w('logInfo'); return undefined; }
export function logWarn() { _w('logWarn'); return undefined; }
export function logSuccess() { _w('logSuccess'); return undefined; }
export function logError() { _w('logError'); return undefined; }
export function logDebug() { _w('logDebug'); return undefined; }
export function resolveStuckSessionWarnMs() { _w('resolveStuckSessionWarnMs'); return undefined; }
export function logWebhookReceived() { _w('logWebhookReceived'); return undefined; }
export function logWebhookProcessed() { _w('logWebhookProcessed'); return undefined; }
export function logWebhookError() { _w('logWebhookError'); return undefined; }
export function logMessageQueued() { _w('logMessageQueued'); return undefined; }
export function logMessageProcessed() { _w('logMessageProcessed'); return undefined; }
export function logSessionStateChange() { _w('logSessionStateChange'); return undefined; }
export function logSessionStuck() { _w('logSessionStuck'); return undefined; }
export function logRunAttempt() { _w('logRunAttempt'); return undefined; }
export function logToolLoopAction() { _w('logToolLoopAction'); return undefined; }
export function logActiveRuns() { _w('logActiveRuns'); return undefined; }
export function startDiagnosticHeartbeat() { _w('startDiagnosticHeartbeat'); return undefined; }
export function stopDiagnosticHeartbeat() { _w('stopDiagnosticHeartbeat'); return undefined; }
export function getDiagnosticSessionStateCountForTest() { _w('getDiagnosticSessionStateCountForTest'); return undefined; }
export function resetDiagnosticStateForTest() { _w('resetDiagnosticStateForTest'); return undefined; }
export function diagnosticLogger() { _w('diagnosticLogger'); return undefined; }
export function logLaneDequeue() { _w('logLaneDequeue'); return undefined; }
export function logLaneEnqueue() { _w('logLaneEnqueue'); return undefined; }
export function isFileLogLevelEnabled() { _w('isFileLogLevelEnabled'); return false; }
export function getLogger() { _w('getLogger'); return undefined; }
export function getChildLogger() { _w('getChildLogger'); return undefined; }
export function toPinoLikeLogger() { _w('toPinoLikeLogger'); return undefined; }
export function getResolvedLoggerSettings() { _w('getResolvedLoggerSettings'); return undefined; }
export function setLoggerOverride() { _w('setLoggerOverride'); return undefined; }
export function resetLogger() { _w('resetLogger'); return undefined; }
export const DEFAULT_LOG_DIR = undefined;
export const DEFAULT_LOG_FILE = undefined;
export const __test__ = undefined;
export function resolveRedactOptions() { _w('resolveRedactOptions'); return undefined; }
export function redactSensitiveText() { _w('redactSensitiveText'); return undefined; }
export function redactToolDetail() { _w('redactToolDetail'); return undefined; }
export function redactToolPayloadText() { _w('redactToolPayloadText'); return undefined; }
export function getDefaultRedactPatterns() { _w('getDefaultRedactPatterns'); return undefined; }
export function redactSensitiveLines() { _w('redactSensitiveLines'); return undefined; }
export function sha256HexPrefix() { _w('sha256HexPrefix'); return undefined; }
export function redactIdentifier() { _w('redactIdentifier'); return undefined; }
export function sliceMarkdownIR() { _w('sliceMarkdownIR'); return undefined; }
export function markdownToIR() { _w('markdownToIR'); return undefined; }
export function markdownToIRWithMeta() { _w('markdownToIRWithMeta'); return undefined; }
export function chunkMarkdownIR() { _w('chunkMarkdownIR'); return undefined; }
export function renderMarkdownIRChunksWithinLimit() { _w('renderMarkdownIRChunksWithinLimit'); return undefined; }
export function renderMarkdownWithMarkers() { _w('renderMarkdownWithMarkers'); return undefined; }
export function convertMarkdownTables() { _w('convertMarkdownTables'); return undefined; }
export function resolveGlobalSingleton() { _w('resolveGlobalSingleton'); return undefined; }
export function resolveGlobalMap() { _w('resolveGlobalMap'); return undefined; }
export function asRecord() { _w('asRecord'); return undefined; }
export function readStringField() { _w('readStringField'); return undefined; }
export function asOptionalRecord() { _w('asOptionalRecord'); return undefined; }
export function asNullableRecord() { _w('asNullableRecord'); return undefined; }
export function asOptionalObjectRecord() { _w('asOptionalObjectRecord'); return undefined; }
export function asNullableObjectRecord() { _w('asNullableObjectRecord'); return undefined; }
export function createScopedExpiringIdCache() { _w('createScopedExpiringIdCache'); return undefined; }
export function normalizeFastMode() { _w('normalizeFastMode'); return ""; }
export function resolvePrimaryStringValue() { _w('resolvePrimaryStringValue'); return undefined; }
export function normalizeOptionalThreadValue() { _w('normalizeOptionalThreadValue'); return ""; }
export function normalizeOptionalStringifiedId() { _w('normalizeOptionalStringifiedId'); return ""; }
export function normalizeStringEntries() { _w('normalizeStringEntries'); return ""; }
export function normalizeStringEntriesLower() { _w('normalizeStringEntriesLower'); return ""; }
export function normalizeTrimmedStringList() { _w('normalizeTrimmedStringList'); return ""; }
export function normalizeOptionalTrimmedStringList() { _w('normalizeOptionalTrimmedStringList'); return ""; }
export function normalizeArrayBackedTrimmedStringList() { _w('normalizeArrayBackedTrimmedStringList'); return ""; }
export function normalizeSingleOrTrimmedStringList() { _w('normalizeSingleOrTrimmedStringList'); return ""; }
export function normalizeCsvOrLooseStringList() { _w('normalizeCsvOrLooseStringList'); return ""; }
export function normalizeHyphenSlug() { _w('normalizeHyphenSlug'); return ""; }
export function normalizeAtHashSlug() { _w('normalizeAtHashSlug'); return ""; }
export function summarizeStringEntries() { _w('summarizeStringEntries'); return undefined; }
export function stripToolCallXmlTags() { _w('stripToolCallXmlTags'); return ""; }
export function stripMinimaxToolCallXml() { _w('stripMinimaxToolCallXml'); return ""; }
export function stripDowngradedToolCallText() { _w('stripDowngradedToolCallText'); return ""; }
export function sanitizeAssistantVisibleTextWithProfile() { _w('sanitizeAssistantVisibleTextWithProfile'); return ""; }
export function stripAssistantInternalScaffolding() { _w('stripAssistantInternalScaffolding'); return ""; }
export function sanitizeAssistantVisibleText() { _w('sanitizeAssistantVisibleText'); return ""; }
export function sanitizeAssistantVisibleTextWithOptions() { _w('sanitizeAssistantVisibleTextWithOptions'); return ""; }
export function isAutoLinkedFileRef() { _w('isAutoLinkedFileRef'); return false; }
export const FILE_REF_EXTENSIONS_WITH_TLD = undefined;
export function findCodeRegions() { _w('findCodeRegions'); return undefined; }
export function isInsideCode() { _w('isInsideCode'); return false; }
export function hasOrphanReasoningCloseBoundary() { _w('hasOrphanReasoningCloseBoundary'); return false; }
export function stripReasoningTagsFromText() { _w('stripReasoningTagsFromText'); return ""; }
export function sanitizeTerminalText() { _w('sanitizeTerminalText'); return ""; }
export function hasSystemMark() { _w('hasSystemMark'); return false; }
export function prefixSystemMessage() { _w('prefixSystemMessage'); return undefined; }
export const SYSTEM_MARK = undefined;
export function stripInlineDirectiveTagsForDisplay() { _w('stripInlineDirectiveTagsForDisplay'); return ""; }
export function sanitizeReplyDirectiveId() { _w('sanitizeReplyDirectiveId'); return ""; }
export function stripInlineDirectiveTagsForDelivery() { _w('stripInlineDirectiveTagsForDelivery'); return ""; }
export function stripInlineDirectiveTagsFromMessageForDisplay() { _w('stripInlineDirectiveTagsFromMessageForDisplay'); return ""; }
export function parseInlineDirectives() { _w('parseInlineDirectives'); return undefined; }
export function chunkItems() { _w('chunkItems'); return undefined; }
export async function fetchWithTimeout() { _w('fetchWithTimeout'); return undefined; }
export function bindAbortRelay() { _w('bindAbortRelay'); return undefined; }
export function buildTimeoutAbortSignal() { _w('buildTimeoutAbortSignal'); return undefined; }
export function resolveReactionLevel() { _w('resolveReactionLevel'); return undefined; }
export function withTimeout() { _w('withTimeout'); return undefined; }
