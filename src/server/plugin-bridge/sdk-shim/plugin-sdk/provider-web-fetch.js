// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-web-fetch.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-web-fetch.' + fn + '() not implemented in Bridge mode'); }
}

export function jsonResult() { _w('jsonResult'); return undefined; }
export function readNumberParam() { _w('readNumberParam'); return undefined; }
export function readStringParam() { _w('readStringParam'); return undefined; }
export function withStrictWebToolsEndpoint() { _w('withStrictWebToolsEndpoint'); return undefined; }
export function withTrustedWebToolsEndpoint() { _w('withTrustedWebToolsEndpoint'); return undefined; }
export function markdownToText() { _w('markdownToText'); return undefined; }
export function truncateText() { _w('truncateText'); return undefined; }
export const DEFAULT_CACHE_TTL_MINUTES = undefined;
export const DEFAULT_TIMEOUT_SECONDS = undefined;
export function normalizeCacheKey() { _w('normalizeCacheKey'); return ""; }
export function readCache() { _w('readCache'); return undefined; }
export function readResponseText() { _w('readResponseText'); return undefined; }
export function resolveCacheTtlMs() { _w('resolveCacheTtlMs'); return undefined; }
export function resolveTimeoutSeconds() { _w('resolveTimeoutSeconds'); return undefined; }
export function writeCache() { _w('writeCache'); return undefined; }
export function enablePluginInConfig() { _w('enablePluginInConfig'); return undefined; }
export function wrapExternalContent() { _w('wrapExternalContent'); return undefined; }
export function wrapWebContent() { _w('wrapWebContent'); return undefined; }
