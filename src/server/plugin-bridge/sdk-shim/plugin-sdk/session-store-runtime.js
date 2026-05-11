// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/session-store-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/session-store-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function loadSessionStore() { _w('loadSessionStore'); return undefined; }
export function resolveSessionStoreEntry() { _w('resolveSessionStoreEntry'); return undefined; }
export function resolveStorePath() { _w('resolveStorePath'); return undefined; }
export function resolveSessionKey() { _w('resolveSessionKey'); return undefined; }
export function resolveGroupSessionKey() { _w('resolveGroupSessionKey'); return undefined; }
export function canonicalizeMainSessionAlias() { _w('canonicalizeMainSessionAlias'); return undefined; }
export function clearSessionStoreCacheForTest() { _w('clearSessionStoreCacheForTest'); return undefined; }
export function readSessionUpdatedAt() { _w('readSessionUpdatedAt'); return undefined; }
export function recordSessionMetaFromInbound() { _w('recordSessionMetaFromInbound'); return undefined; }
export function saveSessionStore() { _w('saveSessionStore'); return undefined; }
export function updateLastRoute() { _w('updateLastRoute'); return undefined; }
export function updateSessionStore() { _w('updateSessionStore'); return undefined; }
export function evaluateSessionFreshness() { _w('evaluateSessionFreshness'); return undefined; }
export function resolveChannelResetConfig() { _w('resolveChannelResetConfig'); return undefined; }
export function resolveSessionResetPolicy() { _w('resolveSessionResetPolicy'); return undefined; }
export function resolveSessionResetType() { _w('resolveSessionResetType'); return undefined; }
export function resolveThreadFlag() { _w('resolveThreadFlag'); return undefined; }
