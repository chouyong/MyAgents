// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/realtime-transcription.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/realtime-transcription.' + fn + '() not implemented in Bridge mode'); }
}

export function canonicalizeRealtimeTranscriptionProviderId() { _w('canonicalizeRealtimeTranscriptionProviderId'); return undefined; }
export function getRealtimeTranscriptionProvider() { _w('getRealtimeTranscriptionProvider'); return undefined; }
export function listRealtimeTranscriptionProviders() { _w('listRealtimeTranscriptionProviders'); return []; }
export function normalizeRealtimeTranscriptionProviderId() { _w('normalizeRealtimeTranscriptionProviderId'); return ""; }
export function createRealtimeTranscriptionWebSocketSession() { _w('createRealtimeTranscriptionWebSocketSession'); return undefined; }
