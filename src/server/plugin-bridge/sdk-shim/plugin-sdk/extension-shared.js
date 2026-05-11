// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/extension-shared.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/extension-shared.' + fn + '() not implemented in Bridge mode'); }
}

export async function runStoppablePassiveMonitor() { _w('runStoppablePassiveMonitor'); return undefined; }
export async function resolveAmbientNodeProxyAgent() { _w('resolveAmbientNodeProxyAgent'); return undefined; }
export function buildPassiveChannelStatusSummary() { _w('buildPassiveChannelStatusSummary'); return undefined; }
export function buildPassiveProbedChannelStatusSummary() { _w('buildPassiveProbedChannelStatusSummary'); return undefined; }
export function buildTrafficStatusSummary() { _w('buildTrafficStatusSummary'); return undefined; }
export function resolveLoggerBackedRuntime() { _w('resolveLoggerBackedRuntime'); return undefined; }
export function requireChannelOpenAllowFrom() { _w('requireChannelOpenAllowFrom'); return undefined; }
export function readStatusIssueFields() { _w('readStatusIssueFields'); return undefined; }
export function coerceStatusIssueAccountId() { _w('coerceStatusIssueAccountId'); return undefined; }
export function createDeferred() { _w('createDeferred'); return undefined; }
export function formatPluginConfigIssue() { _w('formatPluginConfigIssue'); return ""; }
export function normalizePluginConfigIssuePath() { _w('normalizePluginConfigIssuePath'); return ""; }
export function mapPluginConfigIssues() { _w('mapPluginConfigIssues'); return undefined; }
export function canResolveEnvSecretRefInReadOnlyPath() { _w('canResolveEnvSecretRefInReadOnlyPath'); return false; }
export function readPluginPackageVersion() { _w('readPluginPackageVersion'); return undefined; }
export function safeParseJsonWithSchema() { _w('safeParseJsonWithSchema'); return undefined; }
export function safeParseWithSchema() { _w('safeParseWithSchema'); return undefined; }
export function buildTimeoutAbortSignal() { _w('buildTimeoutAbortSignal'); return undefined; }
