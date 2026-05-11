// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/system-event-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/system-event-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function enqueueSystemEvent() { _w('enqueueSystemEvent'); return undefined; }
export function peekSystemEventEntries() { _w('peekSystemEventEntries'); return undefined; }
export function resetSystemEventsForTest() { _w('resetSystemEventsForTest'); return undefined; }
