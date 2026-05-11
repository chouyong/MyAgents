// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-policy.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-policy.' + fn + '() not implemented in Bridge mode'); }
}

export function normalizeAllowFromList() { _w('normalizeAllowFromList'); return ""; }
export function coerceNativeSetting() { _w('coerceNativeSetting'); return undefined; }
export function createDangerousNameMatchingMutableAllowlistWarningCollector() { _w('createDangerousNameMatchingMutableAllowlistWarningCollector'); return undefined; }
export function resolveChannelGroupPolicy() { _w('resolveChannelGroupPolicy'); return undefined; }
export function resolveDmGroupAccessWithCommandGate() { _w('resolveDmGroupAccessWithCommandGate'); return undefined; }
export function evaluateGroupRouteAccessForPolicy() { _w('evaluateGroupRouteAccessForPolicy'); return undefined; }
export function evaluateSenderGroupAccessForPolicy() { _w('evaluateSenderGroupAccessForPolicy'); return undefined; }
export function resolveSenderScopedGroupPolicy() { _w('resolveSenderScopedGroupPolicy'); return undefined; }
