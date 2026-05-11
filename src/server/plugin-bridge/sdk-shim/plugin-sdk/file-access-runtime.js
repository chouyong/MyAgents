// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/file-access-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/file-access-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function readFileWithinRoot() { _w('readFileWithinRoot'); return undefined; }
export function writeFileWithinRoot() { _w('writeFileWithinRoot'); return undefined; }
export function basenameFromMediaSource() { _w('basenameFromMediaSource'); return undefined; }
export function safeFileURLToPath() { _w('safeFileURLToPath'); return undefined; }
