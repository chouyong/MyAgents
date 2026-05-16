// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-mention-gating.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-mention-gating.' + fn + '() not implemented in Bridge mode'); }
}

export function implicitMentionKindWhen() { _w('implicitMentionKindWhen'); return undefined; }
export function resolveInboundMentionDecision() { _w('resolveInboundMentionDecision'); return undefined; }
export function resolveMentionGating() { _w('resolveMentionGating'); return undefined; }
export function resolveMentionGatingWithBypass() { _w('resolveMentionGatingWithBypass'); return undefined; }
export const CURRENT_MESSAGE_MARKER = undefined;
export function buildMentionRegexes() { _w('buildMentionRegexes'); return undefined; }
export function normalizeMentionText() { _w('normalizeMentionText'); return ""; }
