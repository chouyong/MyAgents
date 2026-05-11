// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/native-command-registry.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/native-command-registry.' + fn + '() not implemented in Bridge mode'); }
}

export function buildCommandTextFromArgs() { _w('buildCommandTextFromArgs'); return undefined; }
export function findCommandByNativeName() { _w('findCommandByNativeName'); return undefined; }
export function formatCommandArgMenuTitle() { _w('formatCommandArgMenuTitle'); return ""; }
export function listChatCommands() { _w('listChatCommands'); return []; }
export function listNativeCommandSpecs() { _w('listNativeCommandSpecs'); return []; }
export function listNativeCommandSpecsForConfig() { _w('listNativeCommandSpecsForConfig'); return []; }
export function parseCommandArgs() { _w('parseCommandArgs'); return undefined; }
export function resolveCommandArgChoices() { _w('resolveCommandArgChoices'); return undefined; }
export function resolveCommandArgMenu() { _w('resolveCommandArgMenu'); return undefined; }
export function serializeCommandArgs() { _w('serializeCommandArgs'); return ""; }
