// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/skills-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/skills-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function bumpSkillsSnapshotVersion() { _w('bumpSkillsSnapshotVersion'); return undefined; }
export function getSkillsSnapshotVersion() { _w('getSkillsSnapshotVersion'); return undefined; }
export function registerSkillsChangeListener() { _w('registerSkillsChangeListener'); return undefined; }
export function shouldRefreshSnapshotForVersion() { _w('shouldRefreshSnapshotForVersion'); return false; }
