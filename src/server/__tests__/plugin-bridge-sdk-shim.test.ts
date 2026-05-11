/**
 * Plugin Bridge SDK shim regression suite.
 *
 * Guards against the recurring "openclaw/plugin-sdk/X does not provide an
 * export named Y" bug class (#171 → #180 → #187 — three plugin-load failures
 * in a row, each caused by the handwritten SDK shim drifting behind upstream
 * openclaw's published export surface).
 *
 * The structural fix in scripts/generate-sdk-shims.ts emits a sibling
 * `<name>.auto.js` for every handwritten module that has an upstream
 * counterpart, and injects `export * from "./<name>.auto.js"` into the
 * handwritten file. Auto stubs catch names the handwritten file does not
 * own; ESM `export *` is silently shadowed by direct local exports, so
 * handwritten implementations stay authoritative.
 *
 * These tests pin that behavior. If anyone re-tightens _handwritten.json
 * back to skip-only behavior — or strips the auto-augment line — the
 * specific name from each closed issue regresses and this suite fails.
 */

import { describe, expect, it } from 'vitest';

const SHIM_BASE = '../plugin-bridge/sdk-shim/plugin-sdk';

describe('plugin-bridge SDK shim — drift-stub augmentation', () => {
  it('exports listChatCommandsForConfig as a function (issue #187)', async () => {
    const mod = await import(`${SHIM_BASE}/command-auth.js`);
    expect(typeof mod.listChatCommandsForConfig).toBe('function');
    expect(mod.listChatCommandsForConfig({})).toEqual([]);
  });

  it('exports defineBundledChannelEntry as a real function (issue #180)', async () => {
    const mod = await import(`${SHIM_BASE}/channel-entry-contract.js`);
    expect(typeof mod.defineBundledChannelEntry).toBe('function');
  });

  it('exports createAccountListHelpers as a real function (issue #171)', async () => {
    const mod = await import(`${SHIM_BASE}/account-helpers.js`);
    expect(typeof mod.createAccountListHelpers).toBe('function');
  });

  it('handwritten implementation wins over auto-stub for the same name', async () => {
    // resolveControlCommandGate is hand-implemented in command-auth.js with
    // a meaningful return shape. The auto sibling also has a stub for it
    // (because it appears in upstream openclaw too). ESM `export *` must
    // resolve to the handwritten one.
    const mod = await import(`${SHIM_BASE}/command-auth.js`);
    const result = mod.resolveControlCommandGate({});
    expect(result).toMatchObject({ commandAuthorized: true, shouldBlock: false });
  });

  it('compat barrel resolves names without star-vs-star ambiguity', async () => {
    // compat.js does `export * from "./index.js"` AND now also
    // `export * from "./compat.auto.js"`. Without the chain-walking fix
    // in extractHandwrittenExports, both wildcard re-exports could
    // resolve the same name (e.g. emptyPluginConfigSchema is in both
    // upstream index.ts and upstream compat.ts), which makes ESM
    // ResolveExport return "ambiguous" and Node throws SyntaxError on
    // any *named* import (caught by Codex review during this fix).
    // Tests must use named imports to actually trigger ResolveExport.
    const mod = await import(`${SHIM_BASE}/compat.js`);
    expect(typeof mod.emptyPluginConfigSchema).toBe('function');
    // Sanity: ensure the handwritten index.js implementation wins over
    // any auto stub — the real schema has a `type: 'object'` shape.
    const schema = mod.emptyPluginConfigSchema();
    expect(schema).toMatchObject({ type: 'object' });
  });

  it('auto-stub for an absent name returns a safe default instead of throwing', async () => {
    // listNativeCommandSpecsForConfig is also a Config-suffix verb function;
    // pre-fix the extractExports heuristic emitted `export const X = undefined`
    // which crashed yuanbao at call time. Now it must be a function returning [].
    const mod = await import(`${SHIM_BASE}/command-auth.js`);
    expect(typeof mod.listNativeCommandSpecsForConfig).toBe('function');
    expect(mod.listNativeCommandSpecsForConfig({})).toEqual([]);
  });
});
