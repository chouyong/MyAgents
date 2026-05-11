// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-auth.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-auth.' + fn + '() not implemented in Bridge mode'); }
}

export async function resolveProviderAuthProfileApiKey() { _w('resolveProviderAuthProfileApiKey'); return undefined; }
export function isProviderApiKeyConfigured() { _w('isProviderApiKeyConfigured'); return false; }
export function listUsableProviderAuthProfileIds() { _w('listUsableProviderAuthProfileIds'); return []; }
export function isProviderAuthProfileConfigured() { _w('isProviderAuthProfileConfigured'); return false; }
export const CLAUDE_CLI_PROFILE_ID = undefined;
export const CODEX_CLI_PROFILE_ID = undefined;
export function ensureAuthProfileStore() { _w('ensureAuthProfileStore'); return undefined; }
export function ensureAuthProfileStoreForLocalUpdate() { _w('ensureAuthProfileStoreForLocalUpdate'); return undefined; }
export function updateAuthProfileStoreWithLock() { _w('updateAuthProfileStoreWithLock'); return undefined; }
export function listProfilesForProvider() { _w('listProfilesForProvider'); return []; }
export function removeProviderAuthProfilesWithLock() { _w('removeProviderAuthProfilesWithLock'); return undefined; }
export function upsertAuthProfile() { _w('upsertAuthProfile'); return undefined; }
export function upsertAuthProfileWithLock() { _w('upsertAuthProfileWithLock'); return undefined; }
export function resolveEnvApiKey() { _w('resolveEnvApiKey'); return undefined; }
export function readClaudeCliCredentialsCached() { _w('readClaudeCliCredentialsCached'); return undefined; }
export function suggestOAuthProfileIdForLegacyDefault() { _w('suggestOAuthProfileIdForLegacyDefault'); return undefined; }
export const CUSTOM_LOCAL_AUTH_MARKER = undefined;
export const MINIMAX_OAUTH_MARKER = undefined;
export function isKnownEnvApiKeyMarker() { _w('isKnownEnvApiKeyMarker'); return false; }
export function isNonSecretApiKeyMarker() { _w('isNonSecretApiKeyMarker'); return false; }
export function resolveOAuthApiKeyMarker() { _w('resolveOAuthApiKeyMarker'); return undefined; }
export function resolveNonEnvSecretRefApiKeyMarker() { _w('resolveNonEnvSecretRefApiKeyMarker'); return undefined; }
export function formatApiKeyPreview() { _w('formatApiKeyPreview'); return ""; }
export function normalizeApiKeyInput() { _w('normalizeApiKeyInput'); return ""; }
export function validateApiKeyInput() { _w('validateApiKeyInput'); return undefined; }
export function ensureApiKeyFromEnvOrPrompt() { _w('ensureApiKeyFromEnvOrPrompt'); return undefined; }
export function ensureApiKeyFromOptionEnvOrPrompt() { _w('ensureApiKeyFromOptionEnvOrPrompt'); return undefined; }
export function normalizeSecretInputModeInput() { _w('normalizeSecretInputModeInput'); return ""; }
export function promptSecretRefForSetup() { _w('promptSecretRefForSetup'); return undefined; }
export function resolveSecretInputModeForEnvSelection() { _w('resolveSecretInputModeForEnvSelection'); return undefined; }
export function normalizeApiKeyConfig() { _w('normalizeApiKeyConfig'); return ""; }
export function buildTokenProfileId() { _w('buildTokenProfileId'); return undefined; }
export function validateAnthropicSetupToken() { _w('validateAnthropicSetupToken'); return undefined; }
export function applyAuthProfileConfig() { _w('applyAuthProfileConfig'); return undefined; }
export function buildApiKeyCredential() { _w('buildApiKeyCredential'); return undefined; }
export function upsertApiKeyProfile() { _w('upsertApiKeyProfile'); return undefined; }
export function writeOAuthCredentials() { _w('writeOAuthCredentials'); return undefined; }
export function createProviderApiKeyAuthMethod() { _w('createProviderApiKeyAuthMethod'); return undefined; }
export function coerceSecretRef() { _w('coerceSecretRef'); return undefined; }
export function hasConfiguredSecretInput() { _w('hasConfiguredSecretInput'); return false; }
export function resolveDefaultSecretProviderAlias() { _w('resolveDefaultSecretProviderAlias'); return undefined; }
export function resolveRequiredHomeDir() { _w('resolveRequiredHomeDir'); return undefined; }
export function resolveOpenClawAgentDir() { _w('resolveOpenClawAgentDir'); return undefined; }
export function normalizeOptionalSecretInput() { _w('normalizeOptionalSecretInput'); return ""; }
export function normalizeSecretInput() { _w('normalizeSecretInput'); return ""; }
export function listKnownProviderAuthEnvVarNames() { _w('listKnownProviderAuthEnvVarNames'); return []; }
export function omitEnvKeysCaseInsensitive() { _w('omitEnvKeysCaseInsensitive'); return undefined; }
export function buildOauthProviderAuthResult() { _w('buildOauthProviderAuthResult'); return undefined; }
export function generateHexPkceVerifierChallenge() { _w('generateHexPkceVerifierChallenge'); return undefined; }
export function generatePkceVerifierChallenge() { _w('generatePkceVerifierChallenge'); return undefined; }
export function toFormUrlEncoded() { _w('toFormUrlEncoded'); return undefined; }
export const DEFAULT_OAUTH_REFRESH_MARGIN_MS = undefined;
export function hasUsableOAuthCredential() { _w('hasUsableOAuthCredential'); return false; }
