// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/runtime-doctor.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime-doctor.' + fn + '() not implemented in Bridge mode'); }
}

export function collectProviderDangerousNameMatchingScopes() { _w('collectProviderDangerousNameMatchingScopes'); return []; }
export function asObjectRecord() { _w('asObjectRecord'); return undefined; }
export function hasLegacyAccountStreamingAliases() { _w('hasLegacyAccountStreamingAliases'); return false; }
export function hasLegacyStreamingAliases() { _w('hasLegacyStreamingAliases'); return false; }
export function normalizeLegacyChannelAliases() { _w('normalizeLegacyChannelAliases'); return ""; }
export function normalizeLegacyDmAliases() { _w('normalizeLegacyDmAliases'); return ""; }
export function normalizeLegacyStreamingAliases() { _w('normalizeLegacyStreamingAliases'); return ""; }
export function detectPluginInstallPathIssue() { _w('detectPluginInstallPathIssue'); return undefined; }
export function formatPluginInstallPathIssue() { _w('formatPluginInstallPathIssue'); return ""; }
export function removePluginFromConfig() { _w('removePluginFromConfig'); return undefined; }
