// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/retry-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/retry-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveRetryConfig() { _w('resolveRetryConfig'); return undefined; }
export function retryAsync() { _w('retryAsync'); return undefined; }
export function createRateLimitRetryRunner() { _w('createRateLimitRetryRunner'); return undefined; }
export function createTelegramRetryRunner() { _w('createTelegramRetryRunner'); return undefined; }
export const TELEGRAM_RETRY_DEFAULTS = undefined;
