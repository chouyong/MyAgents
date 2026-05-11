// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-core-host-engine-embeddings.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-core-host-engine-embeddings.' + fn + '() not implemented in Bridge mode'); }
}

export function getMemoryEmbeddingProvider() { _w('getMemoryEmbeddingProvider'); return undefined; }
export function listMemoryEmbeddingProviders() { _w('listMemoryEmbeddingProviders'); return []; }
export function listRegisteredMemoryEmbeddingProviderAdapters() { _w('listRegisteredMemoryEmbeddingProviderAdapters'); return []; }
export function listRegisteredMemoryEmbeddingProviders() { _w('listRegisteredMemoryEmbeddingProviders'); return []; }
export function clearMemoryEmbeddingProviders() { _w('clearMemoryEmbeddingProviders'); return undefined; }
export function registerMemoryEmbeddingProvider() { _w('registerMemoryEmbeddingProvider'); return undefined; }
export function createLocalEmbeddingProvider() { _w('createLocalEmbeddingProvider'); return undefined; }
export const DEFAULT_LOCAL_MODEL = undefined;
export function extractBatchErrorMessage() { _w('extractBatchErrorMessage'); return undefined; }
export function formatUnavailableBatchError() { _w('formatUnavailableBatchError'); return ""; }
export function postJsonWithRetry() { _w('postJsonWithRetry'); return undefined; }
export function applyEmbeddingBatchOutputLine() { _w('applyEmbeddingBatchOutputLine'); return undefined; }
export const EMBEDDING_BATCH_ENDPOINT = undefined;
export function buildEmbeddingBatchGroupOptions() { _w('buildEmbeddingBatchGroupOptions'); return undefined; }
export function runEmbeddingBatchGroups() { _w('runEmbeddingBatchGroups'); return undefined; }
export function resolveBatchCompletionFromStatus() { _w('resolveBatchCompletionFromStatus'); return undefined; }
export function resolveCompletedBatchResult() { _w('resolveCompletedBatchResult'); return undefined; }
export function throwIfBatchTerminalFailure() { _w('throwIfBatchTerminalFailure'); return undefined; }
export function uploadBatchJsonlFile() { _w('uploadBatchJsonlFile'); return undefined; }
export function buildBatchHeaders() { _w('buildBatchHeaders'); return undefined; }
export function normalizeBatchBaseUrl() { _w('normalizeBatchBaseUrl'); return ""; }
export function enforceEmbeddingMaxInputTokens() { _w('enforceEmbeddingMaxInputTokens'); return undefined; }
export function isMissingEmbeddingApiKeyError() { _w('isMissingEmbeddingApiKeyError'); return false; }
export function mapBatchEmbeddingsByIndex() { _w('mapBatchEmbeddingsByIndex'); return undefined; }
export function sanitizeEmbeddingCacheHeaders() { _w('sanitizeEmbeddingCacheHeaders'); return ""; }
export function sanitizeAndNormalizeEmbedding() { _w('sanitizeAndNormalizeEmbedding'); return ""; }
export function debugEmbeddingsLog() { _w('debugEmbeddingsLog'); return undefined; }
export function normalizeEmbeddingModelWithPrefixes() { _w('normalizeEmbeddingModelWithPrefixes'); return ""; }
export function resolveRemoteEmbeddingBearerClient() { _w('resolveRemoteEmbeddingBearerClient'); return undefined; }
export function createRemoteEmbeddingProvider() { _w('createRemoteEmbeddingProvider'); return undefined; }
export function resolveRemoteEmbeddingClient() { _w('resolveRemoteEmbeddingClient'); return undefined; }
export function fetchRemoteEmbeddingVectors() { _w('fetchRemoteEmbeddingVectors'); return undefined; }
export function estimateStructuredEmbeddingInputBytes() { _w('estimateStructuredEmbeddingInputBytes'); return undefined; }
export function estimateUtf8Bytes() { _w('estimateUtf8Bytes'); return undefined; }
export function hasNonTextEmbeddingParts() { _w('hasNonTextEmbeddingParts'); return false; }
export function buildRemoteBaseUrlPolicy() { _w('buildRemoteBaseUrlPolicy'); return undefined; }
export function withRemoteHttpResponse() { _w('withRemoteHttpResponse'); return undefined; }
export function buildCaseInsensitiveExtensionGlob() { _w('buildCaseInsensitiveExtensionGlob'); return undefined; }
export function classifyMemoryMultimodalPath() { _w('classifyMemoryMultimodalPath'); return undefined; }
export function getMemoryMultimodalExtensions() { _w('getMemoryMultimodalExtensions'); return undefined; }
