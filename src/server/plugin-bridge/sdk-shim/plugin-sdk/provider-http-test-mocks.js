// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-http-test-mocks.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-http-test-mocks.' + fn + '() not implemented in Bridge mode'); }
}

export function getProviderHttpMocks() { _w('getProviderHttpMocks'); return undefined; }
export function installProviderHttpMockCleanup() { _w('installProviderHttpMockCleanup'); return undefined; }
