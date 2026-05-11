// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/command-auth-native.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/command-auth-native.' + fn + '() not implemented in Bridge mode'); }
}

export function buildCommandTextFromArgs() { _w('buildCommandTextFromArgs'); return undefined; }
export function findCommandByNativeName() { _w('findCommandByNativeName'); return undefined; }
export function formatCommandArgMenuTitle() { _w('formatCommandArgMenuTitle'); return ""; }
export function listNativeCommandSpecs() { _w('listNativeCommandSpecs'); return []; }
export function listNativeCommandSpecsForConfig() { _w('listNativeCommandSpecsForConfig'); return []; }
export function parseCommandArgs() { _w('parseCommandArgs'); return undefined; }
export function resolveCommandArgMenu() { _w('resolveCommandArgMenu'); return undefined; }
export function resolveCommandAuthorizedFromAuthorizers() { _w('resolveCommandAuthorizedFromAuthorizers'); return undefined; }
export function resolveControlCommandGate() { _w('resolveControlCommandGate'); return undefined; }
export function resolveNativeCommandSessionTargets() { _w('resolveNativeCommandSessionTargets'); return undefined; }
export function resolveCommandAuthorization() { _w('resolveCommandAuthorization'); return undefined; }
export function resolveStoredModelOverride() { _w('resolveStoredModelOverride'); return undefined; }
