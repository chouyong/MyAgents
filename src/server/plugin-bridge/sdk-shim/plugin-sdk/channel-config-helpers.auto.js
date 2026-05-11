// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-config-helpers.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-config-helpers.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveChannelConfigWrites() { _w('resolveChannelConfigWrites'); return undefined; }
export function authorizeConfigWrite() { _w('authorizeConfigWrite'); return undefined; }
export function canBypassConfigWritePolicy() { _w('canBypassConfigWritePolicy'); return false; }
export function formatConfigWriteDeniedMessage() { _w('formatConfigWriteDeniedMessage'); return ""; }
export function formatTrimmedAllowFromEntries() { _w('formatTrimmedAllowFromEntries'); return ""; }
export function resolveOptionalConfigString() { _w('resolveOptionalConfigString'); return undefined; }
export function adaptScopedAccountAccessor() { _w('adaptScopedAccountAccessor'); return undefined; }
export function createScopedAccountConfigAccessors() { _w('createScopedAccountConfigAccessors'); return undefined; }
export function createScopedChannelConfigBase() { _w('createScopedChannelConfigBase'); return undefined; }
export function createScopedChannelConfigAdapter() { _w('createScopedChannelConfigAdapter'); return undefined; }
export function createTopLevelChannelConfigBase() { _w('createTopLevelChannelConfigBase'); return undefined; }
export function createTopLevelChannelConfigAdapter() { _w('createTopLevelChannelConfigAdapter'); return undefined; }
export function createHybridChannelConfigBase() { _w('createHybridChannelConfigBase'); return undefined; }
export function createHybridChannelConfigAdapter() { _w('createHybridChannelConfigAdapter'); return undefined; }
