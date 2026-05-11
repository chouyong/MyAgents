// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/setup.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/setup.' + fn + '() not implemented in Bridge mode'); }
}

export function WizardCancelledError() { _w('WizardCancelledError'); return undefined; }
export function moveSingleAccountChannelSectionToDefaultAccount() { _w('moveSingleAccountChannelSectionToDefaultAccount'); return undefined; }
export function createSetupInputPresenceValidator() { _w('createSetupInputPresenceValidator'); return undefined; }
export function createZodSetupInputValidator() { _w('createZodSetupInputValidator'); return undefined; }
export function promptAccountId() { _w('promptAccountId'); return undefined; }
export function promptChannelAccessConfig() { _w('promptChannelAccessConfig'); return undefined; }
