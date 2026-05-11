// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/string-coerce-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/string-coerce-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function hasNonEmptyString() { _w('hasNonEmptyString'); return false; }
export function localeLowercasePreservingWhitespace() { _w('localeLowercasePreservingWhitespace'); return undefined; }
export function lowercasePreservingWhitespace() { _w('lowercasePreservingWhitespace'); return undefined; }
export function normalizeLowercaseStringOrEmpty() { _w('normalizeLowercaseStringOrEmpty'); return ""; }
export function normalizeNullableString() { _w('normalizeNullableString'); return ""; }
export function normalizeOptionalLowercaseString() { _w('normalizeOptionalLowercaseString'); return ""; }
export function normalizeOptionalString() { _w('normalizeOptionalString'); return ""; }
export function normalizeOptionalStringifiedId() { _w('normalizeOptionalStringifiedId'); return ""; }
export function normalizeStringifiedOptionalString() { _w('normalizeStringifiedOptionalString'); return ""; }
export function readStringValue() { _w('readStringValue'); return undefined; }
export function isRecord() { _w('isRecord'); return false; }
