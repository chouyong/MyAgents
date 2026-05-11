// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/session-visibility.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/session-visibility.' + fn + '() not implemented in Bridge mode'); }
}

export async function listSpawnedSessionKeys() { _w('listSpawnedSessionKeys'); return []; }
export async function createSessionVisibilityGuard() { _w('createSessionVisibilityGuard'); return undefined; }
export function resolveSessionToolsVisibility() { _w('resolveSessionToolsVisibility'); return undefined; }
export function resolveEffectiveSessionToolsVisibility() { _w('resolveEffectiveSessionToolsVisibility'); return undefined; }
export function resolveSandboxSessionToolsVisibility() { _w('resolveSandboxSessionToolsVisibility'); return undefined; }
export function createAgentToAgentPolicy() { _w('createAgentToAgentPolicy'); return undefined; }
export function createSessionVisibilityChecker() { _w('createSessionVisibilityChecker'); return undefined; }
export const sessionVisibilityGatewayTesting = undefined;
