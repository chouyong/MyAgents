// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-auth-api-key.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-auth-api-key.' + fn + '() not implemented in Bridge mode'); }
}

export function upsertAuthProfile() { _w('upsertAuthProfile'); return undefined; }
export function formatApiKeyPreview() { _w('formatApiKeyPreview'); return ""; }
export function normalizeApiKeyInput() { _w('normalizeApiKeyInput'); return ""; }
export function validateApiKeyInput() { _w('validateApiKeyInput'); return undefined; }
export function ensureApiKeyFromOptionEnvOrPrompt() { _w('ensureApiKeyFromOptionEnvOrPrompt'); return undefined; }
export function normalizeSecretInputModeInput() { _w('normalizeSecretInputModeInput'); return ""; }
export function promptSecretRefForSetup() { _w('promptSecretRefForSetup'); return undefined; }
export function resolveSecretInputModeForEnvSelection() { _w('resolveSecretInputModeForEnvSelection'); return undefined; }
export function applyAuthProfileConfig() { _w('applyAuthProfileConfig'); return undefined; }
export function buildApiKeyCredential() { _w('buildApiKeyCredential'); return undefined; }
export function upsertApiKeyProfile() { _w('upsertApiKeyProfile'); return undefined; }
export function createProviderApiKeyAuthMethod() { _w('createProviderApiKeyAuthMethod'); return undefined; }
export function normalizeOptionalSecretInput() { _w('normalizeOptionalSecretInput'); return ""; }
export function normalizeSecretInput() { _w('normalizeSecretInput'); return ""; }
