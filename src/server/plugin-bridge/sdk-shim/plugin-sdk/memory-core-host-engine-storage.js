// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-core-host-engine-storage.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-core-host-engine-storage.' + fn + '() not implemented in Bridge mode'); }
}

export function buildFileEntry() { _w('buildFileEntry'); return undefined; }
export function buildMultimodalChunkForIndexing() { _w('buildMultimodalChunkForIndexing'); return undefined; }
export function chunkMarkdown() { _w('chunkMarkdown'); return undefined; }
export function cosineSimilarity() { _w('cosineSimilarity'); return undefined; }
export function ensureDir() { _w('ensureDir'); return undefined; }
export function hashText() { _w('hashText'); return undefined; }
export function listMemoryFiles() { _w('listMemoryFiles'); return []; }
export function normalizeExtraMemoryPaths() { _w('normalizeExtraMemoryPaths'); return ""; }
export function parseEmbedding() { _w('parseEmbedding'); return undefined; }
export function remapChunkLines() { _w('remapChunkLines'); return undefined; }
export function runWithConcurrency() { _w('runWithConcurrency'); return undefined; }
export function readMemoryFile() { _w('readMemoryFile'); return undefined; }
export function buildMemoryReadResult() { _w('buildMemoryReadResult'); return undefined; }
export function buildMemoryReadResultFromSlice() { _w('buildMemoryReadResultFromSlice'); return undefined; }
export const DEFAULT_MEMORY_READ_LINES = undefined;
export const DEFAULT_MEMORY_READ_MAX_CHARS = undefined;
export function resolveMemoryBackendConfig() { _w('resolveMemoryBackendConfig'); return undefined; }
export function ensureMemoryIndexSchema() { _w('ensureMemoryIndexSchema'); return undefined; }
export function loadSqliteVecExtension() { _w('loadSqliteVecExtension'); return undefined; }
export function closeMemorySqliteWalMaintenance() { _w('closeMemorySqliteWalMaintenance'); return undefined; }
export function configureMemorySqliteWalMaintenance() { _w('configureMemorySqliteWalMaintenance'); return undefined; }
export function requireNodeSqlite() { _w('requireNodeSqlite'); return undefined; }
export function isFileMissingError() { _w('isFileMissingError'); return false; }
export function statRegularFile() { _w('statRegularFile'); return undefined; }
