// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-catalog-shared.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-catalog-shared.' + fn + '() not implemented in Bridge mode'); }
}

export function buildManifestModelProviderConfig() { _w('buildManifestModelProviderConfig'); return undefined; }
export function readConfiguredProviderCatalogEntries() { _w('readConfiguredProviderCatalogEntries'); return undefined; }
export function supportsNativeStreamingUsageCompat() { _w('supportsNativeStreamingUsageCompat'); return false; }
export function applyProviderNativeStreamingUsageCompat() { _w('applyProviderNativeStreamingUsageCompat'); return undefined; }
export function buildPairedProviderApiKeyCatalog() { _w('buildPairedProviderApiKeyCatalog'); return undefined; }
export function buildSingleProviderApiKeyCatalog() { _w('buildSingleProviderApiKeyCatalog'); return undefined; }
export function findCatalogTemplate() { _w('findCatalogTemplate'); return undefined; }
