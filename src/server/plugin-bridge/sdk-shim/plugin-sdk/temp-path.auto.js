// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/temp-path.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/temp-path.' + fn + '() not implemented in Bridge mode'); }
}

export function createTempDownloadTarget() { _w('createTempDownloadTarget'); return undefined; }
export function resolvePreferredOpenClawTmpDir() { _w('resolvePreferredOpenClawTmpDir'); return undefined; }
export function sanitizeTempFileName() { _w('sanitizeTempFileName'); return ""; }
