// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/test-node-mocks.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/test-node-mocks.' + fn + '() not implemented in Bridge mode'); }
}

export function mockNodeBuiltinModule() { _w('mockNodeBuiltinModule'); return undefined; }
export function mockNodeChildProcessExecFile() { _w('mockNodeChildProcessExecFile'); return undefined; }
export function mockNodeChildProcessSpawnSync() { _w('mockNodeChildProcessSpawnSync'); return undefined; }
