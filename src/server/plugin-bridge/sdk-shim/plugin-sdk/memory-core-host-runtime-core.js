// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-core-host-runtime-core.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-core-host-runtime-core.' + fn + '() not implemented in Bridge mode'); }
}

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = undefined;
export function asToolParamsRecord() { _w('asToolParamsRecord'); return undefined; }
export function jsonResult() { _w('jsonResult'); return undefined; }
export function readNumberParam() { _w('readNumberParam'); return undefined; }
export function readStringParam() { _w('readStringParam'); return undefined; }
export function resolveCronStyleNow() { _w('resolveCronStyleNow'); return undefined; }
export function resolveDefaultAgentId() { _w('resolveDefaultAgentId'); return undefined; }
export function resolveSessionAgentId() { _w('resolveSessionAgentId'); return undefined; }
export function resolveMemorySearchConfig() { _w('resolveMemorySearchConfig'); return undefined; }
export function parseNonNegativeByteSize() { _w('parseNonNegativeByteSize'); return undefined; }
export function getRuntimeConfig() { _w('getRuntimeConfig'); return undefined; }
export function loadConfig() { _w('loadConfig'); return undefined; }
export function resolveStateDir() { _w('resolveStateDir'); return undefined; }
export function resolveSessionTranscriptsDirForAgent() { _w('resolveSessionTranscriptsDirForAgent'); return undefined; }
export function emptyPluginConfigSchema() { _w('emptyPluginConfigSchema'); return undefined; }
export function buildActiveMemoryPromptSection() { _w('buildActiveMemoryPromptSection'); return undefined; }
export function clearMemoryPluginState() { _w('clearMemoryPluginState'); return undefined; }
export function getMemoryCapabilityRegistration() { _w('getMemoryCapabilityRegistration'); return undefined; }
export function listActiveMemoryPublicArtifacts() { _w('listActiveMemoryPublicArtifacts'); return []; }
export function listMemoryCorpusSupplements() { _w('listMemoryCorpusSupplements'); return []; }
export function registerMemoryCapability() { _w('registerMemoryCapability'); return undefined; }
export function registerMemoryCorpusSupplement() { _w('registerMemoryCorpusSupplement'); return undefined; }
export function parseAgentSessionKey() { _w('parseAgentSessionKey'); return undefined; }
export const SILENT_REPLY_TOKEN = undefined;
