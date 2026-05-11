// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/fetch-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/fetch-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveFetch() { _w('resolveFetch'); return undefined; }
export function wrapFetchWithAbortSignal() { _w('wrapFetchWithAbortSignal'); return undefined; }
export function withTrustedEnvProxyGuardedFetchMode() { _w('withTrustedEnvProxyGuardedFetchMode'); return undefined; }
export function hasEnvHttpProxyConfigured() { _w('hasEnvHttpProxyConfigured'); return false; }
export function resolveEnvHttpProxyUrl() { _w('resolveEnvHttpProxyUrl'); return undefined; }
export function shouldUseEnvHttpProxyForUrl() { _w('shouldUseEnvHttpProxyForUrl'); return false; }
export function getProxyUrlFromFetch() { _w('getProxyUrlFromFetch'); return undefined; }
export function makeProxyFetch() { _w('makeProxyFetch'); return undefined; }
export function createPinnedLookup() { _w('createPinnedLookup'); return undefined; }
