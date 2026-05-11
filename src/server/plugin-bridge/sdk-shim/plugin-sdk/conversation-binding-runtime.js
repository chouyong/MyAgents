// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/conversation-binding-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/conversation-binding-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function ensureConfiguredBindingRouteReady() { _w('ensureConfiguredBindingRouteReady'); return undefined; }
export function resolveConfiguredBindingRoute() { _w('resolveConfiguredBindingRoute'); return undefined; }
export function resolveRuntimeConversationBindingRoute() { _w('resolveRuntimeConversationBindingRoute'); return undefined; }
export function getSessionBindingService() { _w('getSessionBindingService'); return undefined; }
export function isPluginOwnedSessionBindingRecord() { _w('isPluginOwnedSessionBindingRecord'); return false; }
export function buildPairingReply() { _w('buildPairingReply'); return undefined; }
