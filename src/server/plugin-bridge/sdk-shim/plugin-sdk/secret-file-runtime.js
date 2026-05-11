// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/secret-file-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/secret-file-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export const DEFAULT_SECRET_FILE_MAX_BYTES = undefined;
export const PRIVATE_SECRET_DIR_MODE = undefined;
export const PRIVATE_SECRET_FILE_MODE = undefined;
export function loadSecretFileSync() { _w('loadSecretFileSync'); return undefined; }
export function readSecretFileSync() { _w('readSecretFileSync'); return undefined; }
export function writePrivateSecretFileAtomic() { _w('writePrivateSecretFileAtomic'); return undefined; }
export function tryReadSecretFileSync() { _w('tryReadSecretFileSync'); return undefined; }
