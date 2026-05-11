// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/routing.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/routing.' + fn + '() not implemented in Bridge mode'); }
}

export function buildAgentSessionKey() { _w('buildAgentSessionKey'); return undefined; }
export function buildAgentMainSessionKey() { _w('buildAgentMainSessionKey'); return undefined; }
export function isAcpSessionKey() { _w('isAcpSessionKey'); return false; }
export function parseThreadSessionSuffix() { _w('parseThreadSessionSuffix'); return undefined; }
export function resolveAccountEntry() { _w('resolveAccountEntry'); return undefined; }
export function listBoundAccountIds() { _w('listBoundAccountIds'); return []; }
export function formatSetExplicitDefaultInstruction() { _w('formatSetExplicitDefaultInstruction'); return ""; }
export function buildOutboundBaseSessionKey() { _w('buildOutboundBaseSessionKey'); return undefined; }
export function normalizeMessageChannel() { _w('normalizeMessageChannel'); return ""; }
