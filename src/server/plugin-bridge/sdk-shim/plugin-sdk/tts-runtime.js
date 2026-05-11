// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/tts-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/tts-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export const _test = undefined;
export const buildTtsSystemPromptHint = undefined;
export const getLastTtsAttempt = undefined;
export const getResolvedSpeechProviderConfig = undefined;
export const getTtsMaxLength = undefined;
export const getTtsPersona = undefined;
export const getTtsProvider = undefined;
export const isSummarizationEnabled = undefined;
export const isTtsEnabled = undefined;
export const isTtsProviderConfigured = undefined;
export const listSpeechVoices = undefined;
export const listTtsPersonas = undefined;
export const maybeApplyTtsToPayload = undefined;
export const resolveExplicitTtsOverrides = undefined;
export const resolveTtsAutoMode = undefined;
export const resolveTtsConfig = undefined;
export const resolveTtsPrefsPath = undefined;
export const resolveTtsProviderOrder = undefined;
export const setLastTtsAttempt = undefined;
export const setSummarizationEnabled = undefined;
export const setTtsAutoMode = undefined;
export const setTtsEnabled = undefined;
export const setTtsMaxLength = undefined;
export const setTtsPersona = undefined;
export const setTtsProvider = undefined;
export const synthesizeSpeech = undefined;
export const textToSpeech = undefined;
export const textToSpeechTelephony = undefined;
export const TtsAutoSchema = undefined;
export const TtsConfigSchema = undefined;
export const TtsModeSchema = undefined;
export const TtsProviderSchema = undefined;
