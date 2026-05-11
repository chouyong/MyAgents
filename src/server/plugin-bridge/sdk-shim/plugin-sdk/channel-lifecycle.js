// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-lifecycle.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-lifecycle.' + fn + '() not implemented in Bridge mode'); }
}

export function createRunStateMachine() { _w('createRunStateMachine'); return undefined; }
export function createArmableStallWatchdog() { _w('createArmableStallWatchdog'); return undefined; }
export async function runPassiveAccountLifecycle() { _w('runPassiveAccountLifecycle'); return undefined; }
export async function keepHttpServerTaskAlive() { _w('keepHttpServerTaskAlive'); return undefined; }
export function createAccountStatusSink() { _w('createAccountStatusSink'); return undefined; }
export function waitUntilAbort() { _w('waitUntilAbort'); return undefined; }
export async function deliverFinalizableDraftPreview() { _w('deliverFinalizableDraftPreview'); return undefined; }
export async function takeMessageIdAfterStop() { _w('takeMessageIdAfterStop'); return undefined; }
export async function clearFinalizableDraftMessage() { _w('clearFinalizableDraftMessage'); return undefined; }
export function createFinalizableDraftStreamControls() { _w('createFinalizableDraftStreamControls'); return undefined; }
export function createFinalizableDraftStreamControlsForState() { _w('createFinalizableDraftStreamControlsForState'); return undefined; }
export function createFinalizableDraftLifecycle() { _w('createFinalizableDraftLifecycle'); return undefined; }
export function createDraftStreamLoop() { _w('createDraftStreamLoop'); return undefined; }
