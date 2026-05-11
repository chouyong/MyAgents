// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function createNonExitingRuntime() { _w('createNonExitingRuntime'); return undefined; }
export function defaultRuntime() { _w('defaultRuntime'); return undefined; }
export function resolveCommandSecretRefsViaGateway() { _w('resolveCommandSecretRefsViaGateway'); return undefined; }
export function getChannelsCommandSecretTargetIds() { _w('getChannelsCommandSecretTargetIds'); return undefined; }
export function createLoggerBackedRuntime() { _w('createLoggerBackedRuntime'); return undefined; }
export function resolveRuntimeEnv() { _w('resolveRuntimeEnv'); return undefined; }
export function resolveRuntimeEnvWithUnavailableExit() { _w('resolveRuntimeEnvWithUnavailableExit'); return undefined; }
export function danger() { _w('danger'); return undefined; }
export function info() { _w('info'); return undefined; }
export function isVerbose() { _w('isVerbose'); return false; }
export function isYes() { _w('isYes'); return false; }
export function logVerbose() { _w('logVerbose'); return undefined; }
export function logVerboseConsole() { _w('logVerboseConsole'); return undefined; }
export function setVerbose() { _w('setVerbose'); return undefined; }
export function setYes() { _w('setYes'); return undefined; }
export function shouldLogVerbose() { _w('shouldLogVerbose'); return false; }
export function success() { _w('success'); return undefined; }
export function warn() { _w('warn'); return undefined; }
export function waitForAbortSignal() { _w('waitForAbortSignal'); return undefined; }
export function createBackupArchive() { _w('createBackupArchive'); return undefined; }
export function detectPluginInstallPathIssue() { _w('detectPluginInstallPathIssue'); return undefined; }
export function formatPluginInstallPathIssue() { _w('formatPluginInstallPathIssue'); return ""; }
export function collectProviderDangerousNameMatchingScopes() { _w('collectProviderDangerousNameMatchingScopes'); return []; }
export function registerUncaughtExceptionHandler() { _w('registerUncaughtExceptionHandler'); return undefined; }
export function registerUnhandledRejectionHandler() { _w('registerUnhandledRejectionHandler'); return undefined; }
export function removePluginFromConfig() { _w('removePluginFromConfig'); return undefined; }
export function enableConsoleCapture() { _w('enableConsoleCapture'); return undefined; }
export function getConsoleSettings() { _w('getConsoleSettings'); return undefined; }
export function getResolvedConsoleSettings() { _w('getResolvedConsoleSettings'); return undefined; }
export function routeLogsToStderr() { _w('routeLogsToStderr'); return undefined; }
export function setConsoleSubsystemFilter() { _w('setConsoleSubsystemFilter'); return undefined; }
export function setConsoleConfigLoaderForTests() { _w('setConsoleConfigLoaderForTests'); return undefined; }
export function setConsoleTimestampPrefix() { _w('setConsoleTimestampPrefix'); return undefined; }
export function shouldLogSubsystemToConsole() { _w('shouldLogSubsystemToConsole'); return false; }
export const ALLOWED_LOG_LEVELS = undefined;
export function levelToMinLevel() { _w('levelToMinLevel'); return undefined; }
export function normalizeLogLevel() { _w('normalizeLogLevel'); return ""; }
export const DEFAULT_LOG_DIR = undefined;
export const DEFAULT_LOG_FILE = undefined;
export function getChildLogger() { _w('getChildLogger'); return undefined; }
export function getLogger() { _w('getLogger'); return undefined; }
export function getResolvedLoggerSettings() { _w('getResolvedLoggerSettings'); return undefined; }
export function isFileLogLevelEnabled() { _w('isFileLogLevelEnabled'); return false; }
export function resetLogger() { _w('resetLogger'); return undefined; }
export function setLoggerOverride() { _w('setLoggerOverride'); return undefined; }
export function toPinoLikeLogger() { _w('toPinoLikeLogger'); return undefined; }
export function createSubsystemLogger() { _w('createSubsystemLogger'); return undefined; }
export function createSubsystemRuntime() { _w('createSubsystemRuntime'); return undefined; }
export function runtimeForLogger() { _w('runtimeForLogger'); return undefined; }
export function stripRedundantSubsystemPrefixForConsole() { _w('stripRedundantSubsystemPrefixForConsole'); return ""; }
