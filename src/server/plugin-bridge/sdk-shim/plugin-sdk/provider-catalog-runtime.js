// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-catalog-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-catalog-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function augmentModelCatalogWithProviderPlugins() { _w('augmentModelCatalogWithProviderPlugins'); return undefined; }
export function resetProviderRuntimeHookCacheForTest() { _w('resetProviderRuntimeHookCacheForTest'); return undefined; }
export function resolveCatalogHookProviderPluginIds() { _w('resolveCatalogHookProviderPluginIds'); return undefined; }
export function resolveOwningPluginIdsForProvider() { _w('resolveOwningPluginIdsForProvider'); return undefined; }
export function isPluginProvidersLoadInFlight() { _w('isPluginProvidersLoadInFlight'); return false; }
export function resolvePluginProviders() { _w('resolvePluginProviders'); return undefined; }
