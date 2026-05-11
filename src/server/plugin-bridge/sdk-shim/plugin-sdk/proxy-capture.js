// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/proxy-capture.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/proxy-capture.' + fn + '() not implemented in Bridge mode'); }
}

export function createDebugProxyWebSocketAgent() { _w('createDebugProxyWebSocketAgent'); return undefined; }
export function resolveDebugProxySettings() { _w('resolveDebugProxySettings'); return undefined; }
export function resolveEffectiveDebugProxyUrl() { _w('resolveEffectiveDebugProxyUrl'); return undefined; }
export function acquireDebugProxyCaptureStore() { _w('acquireDebugProxyCaptureStore'); return undefined; }
export function DebugProxyCaptureStore() { _w('DebugProxyCaptureStore'); return undefined; }
export function closeDebugProxyCaptureStore() { _w('closeDebugProxyCaptureStore'); return undefined; }
export function getDebugProxyCaptureStore() { _w('getDebugProxyCaptureStore'); return undefined; }
export function captureHttpExchange() { _w('captureHttpExchange'); return undefined; }
export function captureWsEvent() { _w('captureWsEvent'); return undefined; }
export function finalizeDebugProxyCapture() { _w('finalizeDebugProxyCapture'); return undefined; }
export function initializeDebugProxyCapture() { _w('initializeDebugProxyCapture'); return undefined; }
export function isDebugProxyGlobalFetchPatchInstalled() { _w('isDebugProxyGlobalFetchPatchInstalled'); return false; }
