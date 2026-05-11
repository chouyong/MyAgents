// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/secret-input-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/secret-input-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function coerceSecretRef() { _w('coerceSecretRef'); return undefined; }
export function hasConfiguredSecretInput() { _w('hasConfiguredSecretInput'); return false; }
export function isSecretRef() { _w('isSecretRef'); return false; }
export function normalizeResolvedSecretInputString() { _w('normalizeResolvedSecretInputString'); return ""; }
export function normalizeSecretInputString() { _w('normalizeSecretInputString'); return ""; }
export function resolveSecretInputString() { _w('resolveSecretInputString'); return undefined; }
export function resolveConfiguredSecretInputString() { _w('resolveConfiguredSecretInputString'); return undefined; }
export function resolveConfiguredSecretInputWithFallback() { _w('resolveConfiguredSecretInputWithFallback'); return undefined; }
export function resolveRequiredConfiguredSecretRefInputString() { _w('resolveRequiredConfiguredSecretRefInputString'); return undefined; }
