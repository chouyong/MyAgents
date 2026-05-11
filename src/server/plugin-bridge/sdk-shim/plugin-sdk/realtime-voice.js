// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/realtime-voice.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/realtime-voice.' + fn + '() not implemented in Bridge mode'); }
}

export const REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ = undefined;
export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ = undefined;
export function buildRealtimeVoiceAgentConsultChatMessage() { _w('buildRealtimeVoiceAgentConsultChatMessage'); return undefined; }
export function buildRealtimeVoiceAgentConsultPrompt() { _w('buildRealtimeVoiceAgentConsultPrompt'); return undefined; }
export function buildRealtimeVoiceAgentConsultWorkingResponse() { _w('buildRealtimeVoiceAgentConsultWorkingResponse'); return undefined; }
export function collectRealtimeVoiceAgentConsultVisibleText() { _w('collectRealtimeVoiceAgentConsultVisibleText'); return []; }
export function isRealtimeVoiceAgentConsultToolPolicy() { _w('isRealtimeVoiceAgentConsultToolPolicy'); return false; }
export function parseRealtimeVoiceAgentConsultArgs() { _w('parseRealtimeVoiceAgentConsultArgs'); return undefined; }
export const REALTIME_VOICE_AGENT_CONSULT_TOOL = undefined;
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = undefined;
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES = undefined;
export function resolveRealtimeVoiceAgentConsultToolPolicy() { _w('resolveRealtimeVoiceAgentConsultToolPolicy'); return undefined; }
export function resolveRealtimeVoiceAgentConsultTools() { _w('resolveRealtimeVoiceAgentConsultTools'); return undefined; }
export function resolveRealtimeVoiceAgentConsultToolsAllow() { _w('resolveRealtimeVoiceAgentConsultToolsAllow'); return undefined; }
export function consultRealtimeVoiceAgent() { _w('consultRealtimeVoiceAgent'); return undefined; }
export function canonicalizeRealtimeVoiceProviderId() { _w('canonicalizeRealtimeVoiceProviderId'); return undefined; }
export function getRealtimeVoiceProvider() { _w('getRealtimeVoiceProvider'); return undefined; }
export function listRealtimeVoiceProviders() { _w('listRealtimeVoiceProviders'); return []; }
export function normalizeRealtimeVoiceProviderId() { _w('normalizeRealtimeVoiceProviderId'); return ""; }
export function resolveConfiguredRealtimeVoiceProvider() { _w('resolveConfiguredRealtimeVoiceProvider'); return undefined; }
export function createRealtimeVoiceBridgeSession() { _w('createRealtimeVoiceBridgeSession'); return undefined; }
export function convertPcmToMulaw8k() { _w('convertPcmToMulaw8k'); return undefined; }
export function mulawToPcm() { _w('mulawToPcm'); return undefined; }
export function pcmToMulaw() { _w('pcmToMulaw'); return undefined; }
export function resamplePcm() { _w('resamplePcm'); return undefined; }
export function resamplePcmTo8k() { _w('resamplePcmTo8k'); return undefined; }
