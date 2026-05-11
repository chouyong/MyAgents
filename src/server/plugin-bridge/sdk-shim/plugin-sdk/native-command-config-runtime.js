// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/native-command-config-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/native-command-config-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function isNativeCommandsExplicitlyDisabled() { _w('isNativeCommandsExplicitlyDisabled'); return false; }
export function resolveNativeCommandsEnabled() { _w('resolveNativeCommandsEnabled'); return undefined; }
export function resolveNativeSkillsEnabled() { _w('resolveNativeSkillsEnabled'); return undefined; }
