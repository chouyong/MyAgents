// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/ssrf-policy.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/ssrf-policy.' + fn + '() not implemented in Bridge mode'); }
}

export async function assertHttpUrlTargetsPrivateNetwork() { _w('assertHttpUrlTargetsPrivateNetwork'); return undefined; }
export function isPrivateNetworkOptInEnabled() { _w('isPrivateNetworkOptInEnabled'); return false; }
export function ssrfPolicyFromPrivateNetworkOptIn() { _w('ssrfPolicyFromPrivateNetworkOptIn'); return undefined; }
export function ssrfPolicyFromDangerouslyAllowPrivateNetwork() { _w('ssrfPolicyFromDangerouslyAllowPrivateNetwork'); return undefined; }
export function mergeSsrFPolicies() { _w('mergeSsrFPolicies'); return undefined; }
export function hasLegacyFlatAllowPrivateNetworkAlias() { _w('hasLegacyFlatAllowPrivateNetworkAlias'); return false; }
export function migrateLegacyFlatAllowPrivateNetworkAlias() { _w('migrateLegacyFlatAllowPrivateNetworkAlias'); return undefined; }
export function createLegacyPrivateNetworkDoctorContract() { _w('createLegacyPrivateNetworkDoctorContract'); return undefined; }
export function ssrfPolicyFromAllowPrivateNetwork() { _w('ssrfPolicyFromAllowPrivateNetwork'); return undefined; }
export function normalizeHostnameSuffixAllowlist() { _w('normalizeHostnameSuffixAllowlist'); return ""; }
export function isHttpsUrlAllowedByHostnameSuffixAllowlist() { _w('isHttpsUrlAllowedByHostnameSuffixAllowlist'); return false; }
export function buildHostnameAllowlistPolicyFromSuffixAllowlist() { _w('buildHostnameAllowlistPolicyFromSuffixAllowlist'); return undefined; }
export function isPrivateIpAddress() { _w('isPrivateIpAddress'); return false; }
