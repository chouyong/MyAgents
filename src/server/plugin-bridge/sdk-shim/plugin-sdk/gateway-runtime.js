// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/gateway-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/gateway-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function addGatewayClientOptions() { _w('addGatewayClientOptions'); return undefined; }
export function callGatewayFromCli() { _w('callGatewayFromCli'); return undefined; }
export function isLoopbackHost() { _w('isLoopbackHost'); return false; }
export function isNodeCommandAllowed() { _w('isNodeCommandAllowed'); return false; }
export function resolveNodeCommandAllowlist() { _w('resolveNodeCommandAllowlist'); return undefined; }
export function respondUnavailableOnNodeInvokeError() { _w('respondUnavailableOnNodeInvokeError'); return undefined; }
export function safeParseJson() { _w('safeParseJson'); return undefined; }
export function ensureGatewayStartupAuth() { _w('ensureGatewayStartupAuth'); return undefined; }
export function resolveGatewayAuth() { _w('resolveGatewayAuth'); return undefined; }
export function rawDataToString() { _w('rawDataToString'); return undefined; }
export function GatewayClient() { _w('GatewayClient'); return undefined; }
export function createOperatorApprovalsGatewayClient() { _w('createOperatorApprovalsGatewayClient'); return undefined; }
export function withOperatorApprovalsGatewayClient() { _w('withOperatorApprovalsGatewayClient'); return undefined; }
export function ErrorCodes() { _w('ErrorCodes'); return undefined; }
export function errorShape() { _w('errorShape'); return undefined; }
export function createConnectedChannelStatusPatch() { _w('createConnectedChannelStatusPatch'); return undefined; }
export function createTransportActivityStatusPatch() { _w('createTransportActivityStatusPatch'); return undefined; }
