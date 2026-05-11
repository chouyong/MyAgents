// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/process-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/process-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function prepareOomScoreAdjustedSpawn() { _w('prepareOomScoreAdjustedSpawn'); return undefined; }
export async function runExec() { _w('runExec'); return undefined; }
export async function runCommandWithTimeout() { _w('runCommandWithTimeout'); return undefined; }
export function shouldSpawnWithShell() { _w('shouldSpawnWithShell'); return false; }
export function resolveProcessExitCode() { _w('resolveProcessExitCode'); return undefined; }
export function resolveCommandEnv() { _w('resolveCommandEnv'); return undefined; }
