// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/index.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/index.' + fn + '() not implemented in Bridge mode'); }
}

export function registerContextEngine() { _w('registerContextEngine'); return undefined; }
export function buildMemorySystemPromptAddition() { _w('buildMemorySystemPromptAddition'); return undefined; }
export function delegateCompactionToRuntime() { _w('delegateCompactionToRuntime'); return undefined; }
export function onDiagnosticEvent() { _w('onDiagnosticEvent'); return undefined; }
export function optionalStringEnum() { _w('optionalStringEnum'); return undefined; }
export function stringEnum() { _w('stringEnum'); return undefined; }
