// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-inbound.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-inbound.' + fn + '() not implemented in Bridge mode'); }
}

export function createInboundDebouncer() { _w('createInboundDebouncer'); return undefined; }
export function resolveInboundDebounceMs() { _w('resolveInboundDebounceMs'); return undefined; }
export function createDirectDmPreCryptoGuardPolicy() { _w('createDirectDmPreCryptoGuardPolicy'); return undefined; }
export function dispatchInboundDirectDmWithRuntime() { _w('dispatchInboundDirectDmWithRuntime'); return undefined; }
export function formatInboundEnvelope() { _w('formatInboundEnvelope'); return ""; }
export function formatInboundFromLabel() { _w('formatInboundFromLabel'); return ""; }
export function resolveEnvelopeFormatOptions() { _w('resolveEnvelopeFormatOptions'); return undefined; }
export function buildMentionRegexes() { _w('buildMentionRegexes'); return undefined; }
export function matchesMentionPatterns() { _w('matchesMentionPatterns'); return undefined; }
export function matchesMentionWithExplicit() { _w('matchesMentionWithExplicit'); return undefined; }
export function normalizeMentionText() { _w('normalizeMentionText'); return ""; }
export function createChannelInboundDebouncer() { _w('createChannelInboundDebouncer'); return undefined; }
export function shouldDebounceTextInbound() { _w('shouldDebounceTextInbound'); return false; }
export function implicitMentionKindWhen() { _w('implicitMentionKindWhen'); return undefined; }
export function resolveInboundMentionDecision() { _w('resolveInboundMentionDecision'); return undefined; }
export function resolveMentionGating() { _w('resolveMentionGating'); return undefined; }
export function resolveMentionGatingWithBypass() { _w('resolveMentionGatingWithBypass'); return undefined; }
export function formatLocationText() { _w('formatLocationText'); return ""; }
export function toLocationContext() { _w('toLocationContext'); return undefined; }
export function logInboundDrop() { _w('logInboundDrop'); return undefined; }
export function resolveInboundSessionEnvelopeContext() { _w('resolveInboundSessionEnvelopeContext'); return undefined; }
export function mergeInboundPathRoots() { _w('mergeInboundPathRoots'); return undefined; }
