// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/media-mime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/media-mime.' + fn + '() not implemented in Bridge mode'); }
}

export function detectMime() { _w('detectMime'); return undefined; }
export function extensionForMime() { _w('extensionForMime'); return undefined; }
export function getFileExtension() { _w('getFileExtension'); return undefined; }
export function normalizeMimeType() { _w('normalizeMimeType'); return ""; }
export function mediaKindFromMime() { _w('mediaKindFromMime'); return undefined; }
