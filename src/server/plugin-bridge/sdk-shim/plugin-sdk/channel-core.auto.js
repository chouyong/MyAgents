// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-core.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-core.' + fn + '() not implemented in Bridge mode'); }
}

export function buildChannelConfigSchema() { _w('buildChannelConfigSchema'); return undefined; }
export function buildThreadAwareOutboundSessionRoute() { _w('buildThreadAwareOutboundSessionRoute'); return undefined; }
export function clearAccountEntryFields() { _w('clearAccountEntryFields'); return undefined; }
export function defineSetupPluginEntry() { _w('defineSetupPluginEntry'); return undefined; }
export function parseOptionalDelimitedEntries() { _w('parseOptionalDelimitedEntries'); return undefined; }
export function recoverCurrentThreadSessionId() { _w('recoverCurrentThreadSessionId'); return undefined; }
export function tryReadSecretFileSync() { _w('tryReadSecretFileSync'); return undefined; }
