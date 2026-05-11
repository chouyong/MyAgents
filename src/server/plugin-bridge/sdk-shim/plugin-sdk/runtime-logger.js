// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/runtime-logger.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime-logger.' + fn + '() not implemented in Bridge mode'); }
}

export function createLoggerBackedRuntime() { _w('createLoggerBackedRuntime'); return undefined; }
export function resolveRuntimeEnv() { _w('resolveRuntimeEnv'); return undefined; }
export function resolveRuntimeEnvWithUnavailableExit() { _w('resolveRuntimeEnvWithUnavailableExit'); return undefined; }
