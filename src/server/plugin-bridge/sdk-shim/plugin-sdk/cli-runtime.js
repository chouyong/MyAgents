// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/cli-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/cli-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function inheritOptionFromParent() { _w('inheritOptionFromParent'); return undefined; }
export function runCommandWithRuntime() { _w('runCommandWithRuntime'); return undefined; }
export function formatHelpExamples() { _w('formatHelpExamples'); return ""; }
export function registerCommandGroups() { _w('registerCommandGroups'); return undefined; }
export function resolveCliArgvInvocation() { _w('resolveCliArgvInvocation'); return undefined; }
export function shouldEagerRegisterSubcommands() { _w('shouldEagerRegisterSubcommands'); return false; }
export function note() { _w('note'); return undefined; }
export function stylePromptTitle() { _w('stylePromptTitle'); return undefined; }
export function theme() { _w('theme'); return undefined; }
export function formatCliCommand() { _w('formatCliCommand'); return ""; }
export function parseDurationMs() { _w('parseDurationMs'); return undefined; }
export function waitForever() { _w('waitForever'); return undefined; }
export function readVersionFromPackageJsonForModuleUrl() { _w('readVersionFromPackageJsonForModuleUrl'); return undefined; }
export function readVersionFromBuildInfoForModuleUrl() { _w('readVersionFromBuildInfoForModuleUrl'); return undefined; }
export function resolveVersionFromModuleUrl() { _w('resolveVersionFromModuleUrl'); return undefined; }
export function resolveBinaryVersion() { _w('resolveBinaryVersion'); return undefined; }
export function resolveUsableRuntimeVersion() { _w('resolveUsableRuntimeVersion'); return undefined; }
export function resolveRuntimeServiceVersion() { _w('resolveRuntimeServiceVersion'); return undefined; }
export function resolveCompatibilityHostVersion() { _w('resolveCompatibilityHostVersion'); return undefined; }
export const RUNTIME_SERVICE_VERSION_FALLBACK = undefined;
export const VERSION = undefined;
