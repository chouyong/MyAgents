// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/media-generation-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/media-generation-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function recordCapabilityCandidateFailure() { _w('recordCapabilityCandidateFailure'); return undefined; }
export function hasMediaNormalizationEntry() { _w('hasMediaNormalizationEntry'); return false; }
export function resolveCapabilityModelCandidates() { _w('resolveCapabilityModelCandidates'); return undefined; }
export function deriveAspectRatioFromSize() { _w('deriveAspectRatioFromSize'); return undefined; }
export function resolveClosestAspectRatio() { _w('resolveClosestAspectRatio'); return undefined; }
export function resolveClosestSize() { _w('resolveClosestSize'); return undefined; }
export function resolveClosestResolution() { _w('resolveClosestResolution'); return undefined; }
export function normalizeDurationToClosestMax() { _w('normalizeDurationToClosestMax'); return ""; }
export function buildMediaGenerationNormalizationMetadata() { _w('buildMediaGenerationNormalizationMetadata'); return undefined; }
export function throwCapabilityGenerationFailure() { _w('throwCapabilityGenerationFailure'); return undefined; }
export function buildNoCapabilityModelConfiguredMessage() { _w('buildNoCapabilityModelConfiguredMessage'); return undefined; }
