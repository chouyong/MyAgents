// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/file-lock.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/file-lock.' + fn + '() not implemented in Bridge mode'); }
}

export async function drainFileLockStateForTest() { _w('drainFileLockStateForTest'); return undefined; }
export async function acquireFileLock() { _w('acquireFileLock'); return undefined; }
export async function withFileLock() { _w('withFileLock'); return undefined; }
export function resetFileLockStateForTest() { _w('resetFileLockStateForTest'); return undefined; }
export const FILE_LOCK_TIMEOUT_ERROR_CODE = undefined;
