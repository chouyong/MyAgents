// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/lmstudio.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/lmstudio.' + fn + '() not implemented in Bridge mode'); }
}

export const promptAndConfigureLmstudioInteractive = undefined;
export const configureLmstudioNonInteractive = undefined;
export const discoverLmstudioProvider = undefined;
export const prepareLmstudioDynamicModels = undefined;
export const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR = undefined;
export const LMSTUDIO_DEFAULT_BASE_URL = undefined;
export const LMSTUDIO_DEFAULT_EMBEDDING_MODEL = undefined;
export const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL = undefined;
export const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH = undefined;
export const LMSTUDIO_DEFAULT_MODEL_ID = undefined;
export const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = undefined;
export const LMSTUDIO_MODEL_PLACEHOLDER = undefined;
export const LMSTUDIO_PROVIDER_ID = undefined;
export const LMSTUDIO_PROVIDER_LABEL = undefined;
export function buildLmstudioAuthHeaders() { _w('buildLmstudioAuthHeaders'); return undefined; }
export function discoverLmstudioModels() { _w('discoverLmstudioModels'); return undefined; }
export function ensureLmstudioModelLoaded() { _w('ensureLmstudioModelLoaded'); return undefined; }
export function fetchLmstudioModels() { _w('fetchLmstudioModels'); return undefined; }
export function mapLmstudioWireEntry() { _w('mapLmstudioWireEntry'); return undefined; }
export function normalizeLmstudioProviderConfig() { _w('normalizeLmstudioProviderConfig'); return ""; }
export function resolveLoadedContextWindow() { _w('resolveLoadedContextWindow'); return undefined; }
export function resolveLmstudioConfiguredApiKey() { _w('resolveLmstudioConfiguredApiKey'); return undefined; }
export function resolveLmstudioInferenceBase() { _w('resolveLmstudioInferenceBase'); return undefined; }
export function resolveLmstudioProviderHeaders() { _w('resolveLmstudioProviderHeaders'); return undefined; }
export function resolveLmstudioReasoningCapability() { _w('resolveLmstudioReasoningCapability'); return undefined; }
export function resolveLmstudioRuntimeApiKey() { _w('resolveLmstudioRuntimeApiKey'); return undefined; }
export function resolveLmstudioServerBase() { _w('resolveLmstudioServerBase'); return undefined; }
