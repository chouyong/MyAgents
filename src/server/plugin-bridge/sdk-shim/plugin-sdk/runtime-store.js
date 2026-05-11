// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./runtime-store.auto.js";
// === END AUTO-AUGMENT ===

// Hand-written shim — openclaw/plugin-sdk/runtime-store
// Implements createPluginRuntimeStore() for Bridge mode.
// The store is a simple mutable slot — plugins use it to hold their runtime instance.

/**
 * Create a mutable runtime slot with strict access.
 * @param {string} errorMessage - Error message when getRuntime() is called before setRuntime()
 */
function createPluginRuntimeStore(errorMessage) {
  let runtime = null;

  return {
    setRuntime(next) {
      runtime = next;
    },
    clearRuntime() {
      runtime = null;
    },
    tryGetRuntime() {
      return runtime;
    },
    getRuntime() {
      if (!runtime) {
        throw new Error(errorMessage);
      }
      return runtime;
    },
  };
}

export {
  createPluginRuntimeStore,
};
