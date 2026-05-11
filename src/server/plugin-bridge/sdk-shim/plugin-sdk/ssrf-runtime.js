// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/ssrf-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/ssrf-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function closeDispatcher() { _w('closeDispatcher'); return undefined; }
export function createPinnedDispatcher() { _w('createPinnedDispatcher'); return undefined; }
export function SsrFBlockedError() { _w('SsrFBlockedError'); return undefined; }
export function isBlockedHostnameOrIp() { _w('isBlockedHostnameOrIp'); return false; }
export function resolvePinnedHostname() { _w('resolvePinnedHostname'); return undefined; }
export function resolvePinnedHostnameWithPolicy() { _w('resolvePinnedHostnameWithPolicy'); return undefined; }
export function ssrfPolicyFromHttpBaseUrlAllowedHostname() { _w('ssrfPolicyFromHttpBaseUrlAllowedHostname'); return undefined; }
export function formatErrorMessage() { _w('formatErrorMessage'); return ""; }
export function fetchWithSsrFGuard() { _w('fetchWithSsrFGuard'); return undefined; }
export function assertHttpUrlTargetsPrivateNetwork() { _w('assertHttpUrlTargetsPrivateNetwork'); return undefined; }
export function buildHostnameAllowlistPolicyFromSuffixAllowlist() { _w('buildHostnameAllowlistPolicyFromSuffixAllowlist'); return undefined; }
export function createLegacyPrivateNetworkDoctorContract() { _w('createLegacyPrivateNetworkDoctorContract'); return undefined; }
export function hasLegacyFlatAllowPrivateNetworkAlias() { _w('hasLegacyFlatAllowPrivateNetworkAlias'); return false; }
export function isPrivateNetworkOptInEnabled() { _w('isPrivateNetworkOptInEnabled'); return false; }
export function mergeSsrFPolicies() { _w('mergeSsrFPolicies'); return undefined; }
export function migrateLegacyFlatAllowPrivateNetworkAlias() { _w('migrateLegacyFlatAllowPrivateNetworkAlias'); return undefined; }
export function ssrfPolicyFromDangerouslyAllowPrivateNetwork() { _w('ssrfPolicyFromDangerouslyAllowPrivateNetwork'); return undefined; }
export function ssrfPolicyFromPrivateNetworkOptIn() { _w('ssrfPolicyFromPrivateNetworkOptIn'); return undefined; }
export function ssrfPolicyFromAllowPrivateNetwork() { _w('ssrfPolicyFromAllowPrivateNetwork'); return undefined; }
export function isPrivateOrLoopbackHost() { _w('isPrivateOrLoopbackHost'); return false; }
