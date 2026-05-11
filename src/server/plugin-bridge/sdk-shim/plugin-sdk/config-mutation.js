// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/config-mutation.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/config-mutation.' + fn + '() not implemented in Bridge mode'); }
}

export function logConfigUpdated() { _w('logConfigUpdated'); return undefined; }
export function readConfigFileSnapshotForWrite() { _w('readConfigFileSnapshotForWrite'); return undefined; }
export function mutateConfigFile() { _w('mutateConfigFile'); return undefined; }
export function replaceConfigFile() { _w('replaceConfigFile'); return undefined; }
export function updateConfig() { _w('updateConfig'); return undefined; }
