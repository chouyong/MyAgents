// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./plugin-entry.auto.js";
// === END AUTO-AUGMENT ===

// OpenClaw plugin-sdk/plugin-entry shim for MyAgents Plugin Bridge
// Provides definePluginEntry() and type stubs for 3.22+ plugins.

/**
 * Normalize a plugin entry definition.
 * In real OpenClaw this validates and wraps the plugin; our shim just passes through.
 */
export function definePluginEntry(entry) {
  return {
    id: entry.id || 'unknown',
    name: entry.name || entry.id || 'Unknown',
    description: entry.description || '',
    kind: entry.kind || 'channel',
    configSchema: typeof entry.configSchema === 'function'
      ? entry.configSchema()
      : (entry.configSchema || { type: 'object', properties: {} }),
    register: entry.register,
  };
}
