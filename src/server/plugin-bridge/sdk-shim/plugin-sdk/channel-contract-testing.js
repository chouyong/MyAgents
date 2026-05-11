// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-contract-testing.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-contract-testing.' + fn + '() not implemented in Bridge mode'); }
}

export function expectChannelInboundContextContract() { _w('expectChannelInboundContextContract'); return undefined; }
export function primeChannelOutboundSendMock() { _w('primeChannelOutboundSendMock'); return undefined; }
export function buildDispatchInboundCaptureMock() { _w('buildDispatchInboundCaptureMock'); return undefined; }
export function installChannelOutboundPayloadContractSuite() { _w('installChannelOutboundPayloadContractSuite'); return undefined; }
