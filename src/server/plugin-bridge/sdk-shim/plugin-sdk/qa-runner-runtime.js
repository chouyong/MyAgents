// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/qa-runner-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/qa-runner-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function loadQaRuntimeModule() { _w('loadQaRuntimeModule'); return undefined; }
export function loadQaRunnerBundledPluginTestApi() { _w('loadQaRunnerBundledPluginTestApi'); return undefined; }
export function isQaRuntimeAvailable() { _w('isQaRuntimeAvailable'); return false; }
export function listQaRunnerCliContributions() { _w('listQaRunnerCliContributions'); return []; }
