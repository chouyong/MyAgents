// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/agent-harness.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/agent-harness.' + fn + '() not implemented in Bridge mode'); }
}

export function createOpenClawCodingTools() { _w('createOpenClawCodingTools'); return undefined; }
export function inferToolMetaFromArgs() { _w('inferToolMetaFromArgs'); return undefined; }
export function formatToolProgressOutput() { _w('formatToolProgressOutput'); return ""; }
export function classifyAgentHarnessTerminalOutcome() { _w('classifyAgentHarnessTerminalOutcome'); return undefined; }
export const TOOL_PROGRESS_OUTPUT_MAX_CHARS = undefined;
export const OPENCLAW_VERSION = undefined;
export function formatErrorMessage() { _w('formatErrorMessage'); return ""; }
export function formatApprovalDisplayPath() { _w('formatApprovalDisplayPath'); return ""; }
export function emitAgentEvent() { _w('emitAgentEvent'); return undefined; }
export function onAgentEvent() { _w('onAgentEvent'); return undefined; }
export function resetAgentEventsForTest() { _w('resetAgentEventsForTest'); return undefined; }
export function embeddedAgentLog() { _w('embeddedAgentLog'); return undefined; }
export function buildAgentRuntimePlan() { _w('buildAgentRuntimePlan'); return undefined; }
export function classifyEmbeddedPiRunResultForModelFallback() { _w('classifyEmbeddedPiRunResultForModelFallback'); return undefined; }
export function resolveEmbeddedAgentRuntime() { _w('resolveEmbeddedAgentRuntime'); return undefined; }
export function resolveUserPath() { _w('resolveUserPath'); return undefined; }
export function callGatewayTool() { _w('callGatewayTool'); return undefined; }
export function listNodes() { _w('listNodes'); return []; }
export function resolveNodeIdFromList() { _w('resolveNodeIdFromList'); return undefined; }
export function selectDefaultNodeFromList() { _w('selectDefaultNodeFromList'); return undefined; }
export function formatToolAggregate() { _w('formatToolAggregate'); return ""; }
export function isMessagingTool() { _w('isMessagingTool'); return false; }
export function isMessagingToolSendAction() { _w('isMessagingToolSendAction'); return false; }
export function extractToolResultMediaArtifact() { _w('extractToolResultMediaArtifact'); return undefined; }
export function filterToolResultMediaUrls() { _w('filterToolResultMediaUrls'); return undefined; }
export function normalizeUsage() { _w('normalizeUsage'); return ""; }
export function resolveOpenClawAgentDir() { _w('resolveOpenClawAgentDir'); return undefined; }
export function resolveSessionAgentIds() { _w('resolveSessionAgentIds'); return undefined; }
export function resolveModelAuthMode() { _w('resolveModelAuthMode'); return undefined; }
export function supportsModelTools() { _w('supportsModelTools'); return false; }
export function resolveAttemptSpawnWorkspaceDir() { _w('resolveAttemptSpawnWorkspaceDir'); return undefined; }
export function buildEmbeddedAttemptToolRunContext() { _w('buildEmbeddedAttemptToolRunContext'); return undefined; }
export function abortAgentHarnessRun() { _w('abortAgentHarnessRun'); return undefined; }
export function clearActiveEmbeddedRun() { _w('clearActiveEmbeddedRun'); return undefined; }
export function queueAgentHarnessMessage() { _w('queueAgentHarnessMessage'); return undefined; }
export function setActiveEmbeddedRun() { _w('setActiveEmbeddedRun'); return undefined; }
export function disposeRegisteredAgentHarnesses() { _w('disposeRegisteredAgentHarnesses'); return undefined; }
export function logAgentRuntimeToolDiagnostics() { _w('logAgentRuntimeToolDiagnostics'); return undefined; }
export function normalizeAgentRuntimeTools() { _w('normalizeAgentRuntimeTools'); return ""; }
export function normalizeProviderToolSchemas() { _w('normalizeProviderToolSchemas'); return ""; }
export function resolveSandboxContext() { _w('resolveSandboxContext'); return undefined; }
export function isSubagentSessionKey() { _w('isSubagentSessionKey'); return false; }
export function acquireSessionWriteLock() { _w('acquireSessionWriteLock'); return undefined; }
export function emitSessionTranscriptUpdate() { _w('emitSessionTranscriptUpdate'); return undefined; }
export function isToolWrappedWithBeforeToolCallHook() { _w('isToolWrappedWithBeforeToolCallHook'); return false; }
export function wrapToolWithBeforeToolCallHook() { _w('wrapToolWithBeforeToolCallHook'); return undefined; }
export function resolveAgentHarnessBeforePromptBuildResult() { _w('resolveAgentHarnessBeforePromptBuildResult'); return undefined; }
export function runAgentHarnessAfterCompactionHook() { _w('runAgentHarnessAfterCompactionHook'); return undefined; }
export function runAgentHarnessBeforeCompactionHook() { _w('runAgentHarnessBeforeCompactionHook'); return undefined; }
export function createCodexAppServerToolResultExtensionRunner() { _w('createCodexAppServerToolResultExtensionRunner'); return undefined; }
export function createAgentToolResultMiddlewareRunner() { _w('createAgentToolResultMiddlewareRunner'); return undefined; }
export function assembleHarnessContextEngine() { _w('assembleHarnessContextEngine'); return undefined; }
export function bootstrapHarnessContextEngine() { _w('bootstrapHarnessContextEngine'); return undefined; }
export function buildHarnessContextEngineRuntimeContext() { _w('buildHarnessContextEngineRuntimeContext'); return undefined; }
export function buildHarnessContextEngineRuntimeContextFromUsage() { _w('buildHarnessContextEngineRuntimeContextFromUsage'); return undefined; }
export function finalizeHarnessContextEngineTurn() { _w('finalizeHarnessContextEngineTurn'); return undefined; }
export function isActiveHarnessContextEngine() { _w('isActiveHarnessContextEngine'); return false; }
export function runHarnessContextEngineMaintenance() { _w('runHarnessContextEngineMaintenance'); return undefined; }
export function runAgentHarnessAfterToolCallHook() { _w('runAgentHarnessAfterToolCallHook'); return undefined; }
export function runAgentHarnessBeforeMessageWriteHook() { _w('runAgentHarnessBeforeMessageWriteHook'); return undefined; }
export function runAgentHarnessBeforeAgentFinalizeHook() { _w('runAgentHarnessBeforeAgentFinalizeHook'); return undefined; }
export function runAgentHarnessAgentEndHook() { _w('runAgentHarnessAgentEndHook'); return undefined; }
export function runAgentHarnessLlmInputHook() { _w('runAgentHarnessLlmInputHook'); return undefined; }
export function runAgentHarnessLlmOutputHook() { _w('runAgentHarnessLlmOutputHook'); return undefined; }
export function buildNativeHookRelayCommand() { _w('buildNativeHookRelayCommand'); return undefined; }
export function nativeHookRelayTesting() { _w('nativeHookRelayTesting'); return undefined; }
export function registerNativeHookRelay() { _w('registerNativeHookRelay'); return undefined; }
