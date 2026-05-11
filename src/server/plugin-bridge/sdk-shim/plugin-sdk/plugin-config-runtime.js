// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/plugin-config-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/plugin-config-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function requireRuntimeConfig() { _w('requireRuntimeConfig'); return undefined; }
export function resolvePluginConfigObject() { _w('resolvePluginConfigObject'); return undefined; }
export function resolveLivePluginConfigObject() { _w('resolveLivePluginConfigObject'); return undefined; }
export function normalizePluginsConfig() { _w('normalizePluginsConfig'); return ""; }
export function resolveEffectiveEnableState() { _w('resolveEffectiveEnableState'); return undefined; }
