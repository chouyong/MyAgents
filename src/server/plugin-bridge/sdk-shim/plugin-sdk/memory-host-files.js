// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-host-files.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-host-files.' + fn + '() not implemented in Bridge mode'); }
}

export function listMemoryFiles() { _w('listMemoryFiles'); return []; }
export function normalizeExtraMemoryPaths() { _w('normalizeExtraMemoryPaths'); return ""; }
export function readAgentMemoryFile() { _w('readAgentMemoryFile'); return undefined; }
export function resolveMemoryBackendConfig() { _w('resolveMemoryBackendConfig'); return undefined; }
