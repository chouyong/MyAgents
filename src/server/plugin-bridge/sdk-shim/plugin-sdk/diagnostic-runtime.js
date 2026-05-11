// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/diagnostic-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/diagnostic-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function isDiagnosticFlagEnabled() { _w('isDiagnosticFlagEnabled'); return false; }
export function emitDiagnosticEvent() { _w('emitDiagnosticEvent'); return undefined; }
export function emitTrustedDiagnosticEvent() { _w('emitTrustedDiagnosticEvent'); return undefined; }
export function isDiagnosticsEnabled() { _w('isDiagnosticsEnabled'); return false; }
export function onInternalDiagnosticEvent() { _w('onInternalDiagnosticEvent'); return undefined; }
export function onDiagnosticEvent() { _w('onDiagnosticEvent'); return undefined; }
export function resetDiagnosticEventsForTest() { _w('resetDiagnosticEventsForTest'); return undefined; }
export function createChildDiagnosticTraceContext() { _w('createChildDiagnosticTraceContext'); return undefined; }
export function createDiagnosticTraceContext() { _w('createDiagnosticTraceContext'); return undefined; }
export function formatDiagnosticTraceparent() { _w('formatDiagnosticTraceparent'); return ""; }
export function isValidDiagnosticSpanId() { _w('isValidDiagnosticSpanId'); return false; }
export function isValidDiagnosticTraceFlags() { _w('isValidDiagnosticTraceFlags'); return false; }
export function isValidDiagnosticTraceId() { _w('isValidDiagnosticTraceId'); return false; }
export function parseDiagnosticTraceparent() { _w('parseDiagnosticTraceparent'); return undefined; }
