// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/plugin-test-contracts.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/plugin-test-contracts.' + fn + '() not implemented in Bridge mode'); }
}

export function assertNoImportTimeSideEffects() { _w('assertNoImportTimeSideEffects'); return undefined; }
export function createPluginRegistryFixture() { _w('createPluginRegistryFixture'); return undefined; }
export function registerProviders() { _w('registerProviders'); return undefined; }
export function registerTestPlugin() { _w('registerTestPlugin'); return undefined; }
export function registerVirtualTestPlugin() { _w('registerVirtualTestPlugin'); return undefined; }
export function requireProvider() { _w('requireProvider'); return undefined; }
export function uniqueSortedStrings() { _w('uniqueSortedStrings'); return undefined; }
export function runDirectImportSmoke() { _w('runDirectImportSmoke'); return undefined; }
export function loadRuntimeApiExportTypesViaJiti() { _w('loadRuntimeApiExportTypesViaJiti'); return undefined; }
export function describePackageManifestContract() { _w('describePackageManifestContract'); return undefined; }
export function pluginRegistrationContractCases() { _w('pluginRegistrationContractCases'); return undefined; }
export function describePluginRegistrationContract() { _w('describePluginRegistrationContract'); return undefined; }
export const GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = undefined;
export const BUNDLED_RUNTIME_SIDECAR_BASENAMES = undefined;
export function getPublicArtifactBasename() { _w('getPublicArtifactBasename'); return undefined; }
export function loadBundledPluginPublicSurface() { _w('loadBundledPluginPublicSurface'); return undefined; }
export function loadBundledPluginPublicSurfaceSync() { _w('loadBundledPluginPublicSurfaceSync'); return undefined; }
export function resolveWorkspacePackagePublicModuleUrl() { _w('resolveWorkspacePackagePublicModuleUrl'); return undefined; }
