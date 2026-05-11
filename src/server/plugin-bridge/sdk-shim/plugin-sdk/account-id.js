// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./account-id.auto.js";
// === END AUTO-AUGMENT ===

// OpenClaw plugin-sdk/account-id shim for MyAgents Plugin Bridge

export const DEFAULT_ACCOUNT_ID = 'default';

export function normalizeAccountId(id) {
  if (!id || id === 'default') return DEFAULT_ACCOUNT_ID;
  return String(id).trim().toLowerCase();
}

export function normalizeOptionalAccountId(id) {
  if (id === undefined || id === null) return undefined;
  return normalizeAccountId(id);
}
