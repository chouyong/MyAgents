// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-core-host-multimodal.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-core-host-multimodal.' + fn + '() not implemented in Bridge mode'); }
}

export function isMemoryMultimodalEnabled() { _w('isMemoryMultimodalEnabled'); return false; }
export function normalizeMemoryMultimodalSettings() { _w('normalizeMemoryMultimodalSettings'); return ""; }
