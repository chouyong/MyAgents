// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/lmstudio-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/lmstudio-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export const LMSTUDIO_DEFAULT_BASE_URL = undefined;
export const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL = undefined;
export const LMSTUDIO_DEFAULT_EMBEDDING_MODEL = undefined;
export const LMSTUDIO_PROVIDER_LABEL = undefined;
export const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR = undefined;
export const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = undefined;
export const LMSTUDIO_MODEL_PLACEHOLDER = undefined;
export const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH = undefined;
export const LMSTUDIO_DEFAULT_MODEL_ID = undefined;
export const LMSTUDIO_PROVIDER_ID = undefined;
export const resolveLmstudioReasoningCapability = undefined;
export const resolveLoadedContextWindow = undefined;
export const resolveLmstudioServerBase = undefined;
export const resolveLmstudioInferenceBase = undefined;
export const normalizeLmstudioProviderConfig = undefined;
export const fetchLmstudioModels = undefined;
export const mapLmstudioWireEntry = undefined;
export const discoverLmstudioModels = undefined;
export const ensureLmstudioModelLoaded = undefined;
export const buildLmstudioAuthHeaders = undefined;
export const resolveLmstudioConfiguredApiKey = undefined;
export const resolveLmstudioProviderHeaders = undefined;
export const resolveLmstudioRequestContext = undefined;
export const resolveLmstudioRuntimeApiKey = undefined;
