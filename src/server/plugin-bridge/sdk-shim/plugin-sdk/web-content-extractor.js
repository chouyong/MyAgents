// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/web-content-extractor.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/web-content-extractor.' + fn + '() not implemented in Bridge mode'); }
}

export function extractBasicHtmlContent() { _w('extractBasicHtmlContent'); return undefined; }
export function htmlToMarkdown() { _w('htmlToMarkdown'); return undefined; }
export function markdownToText() { _w('markdownToText'); return undefined; }
export function normalizeWhitespace() { _w('normalizeWhitespace'); return ""; }
export function sanitizeHtml() { _w('sanitizeHtml'); return ""; }
export function stripInvisibleUnicode() { _w('stripInvisibleUnicode'); return ""; }
