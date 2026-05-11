// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/test-env.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/test-env.' + fn + '() not implemented in Bridge mode'); }
}

export function createAuthCaptureJsonFetch() { _w('createAuthCaptureJsonFetch'); return undefined; }
export function createRequestCaptureJsonFetch() { _w('createRequestCaptureJsonFetch'); return undefined; }
export function installPinnedHostnameTestHooks() { _w('installPinnedHostnameTestHooks'); return undefined; }
export function createSingleUserPromptMessage() { _w('createSingleUserPromptMessage'); return undefined; }
export function extractNonEmptyAssistantText() { _w('extractNonEmptyAssistantText'); return undefined; }
export function isLiveProfileKeyModeEnabled() { _w('isLiveProfileKeyModeEnabled'); return false; }
export function isLiveTestEnabled() { _w('isLiveTestEnabled'); return false; }
export function collectProviderApiKeys() { _w('collectProviderApiKeys'); return []; }
export function isModelNotFoundErrorMessage() { _w('isModelNotFoundErrorMessage'); return false; }
export function isAuthErrorMessage() { _w('isAuthErrorMessage'); return false; }
export function isBillingErrorMessage() { _w('isBillingErrorMessage'); return false; }
export function isOverloadedErrorMessage() { _w('isOverloadedErrorMessage'); return false; }
export function isServerErrorMessage() { _w('isServerErrorMessage'); return false; }
export function isTimeoutErrorMessage() { _w('isTimeoutErrorMessage'); return false; }
export function maybeLoadShellEnvForGenerationProviders() { _w('maybeLoadShellEnvForGenerationProviders'); return undefined; }
export function isTruthyEnvValue() { _w('isTruthyEnvValue'); return false; }
export function getShellEnvAppliedKeys() { _w('getShellEnvAppliedKeys'); return undefined; }
export function encodePngRgba() { _w('encodePngRgba'); return ""; }
export function fillPixel() { _w('fillPixel'); return undefined; }
export function parseCsvFilter() { _w('parseCsvFilter'); return undefined; }
export function parseProviderModelMap() { _w('parseProviderModelMap'); return undefined; }
export function redactLiveApiKey() { _w('redactLiveApiKey'); return undefined; }
export const DEFAULT_LIVE_MUSIC_MODELS = undefined;
export function resolveConfiguredLiveMusicModels() { _w('resolveConfiguredLiveMusicModels'); return undefined; }
export function resolveLiveMusicAuthStore() { _w('resolveLiveMusicAuthStore'); return undefined; }
export function canRunBufferBackedImageToVideoLiveLane() { _w('canRunBufferBackedImageToVideoLiveLane'); return false; }
export function canRunBufferBackedVideoToVideoLiveLane() { _w('canRunBufferBackedVideoToVideoLiveLane'); return false; }
export const DEFAULT_LIVE_VIDEO_MODELS = undefined;
export function resolveConfiguredLiveVideoModels() { _w('resolveConfiguredLiveVideoModels'); return undefined; }
export function resolveLiveVideoAuthStore() { _w('resolveLiveVideoAuthStore'); return undefined; }
export function resolveLiveVideoResolution() { _w('resolveLiveVideoResolution'); return undefined; }
export function normalizeVideoGenerationDuration() { _w('normalizeVideoGenerationDuration'); return ""; }
export function parseVideoGenerationModelRef() { _w('parseVideoGenerationModelRef'); return undefined; }
export function jsonResponse() { _w('jsonResponse'); return undefined; }
export function requestBodyText() { _w('requestBodyText'); return undefined; }
export function requestUrl() { _w('requestUrl'); return undefined; }
export function mockPinnedHostnameResolution() { _w('mockPinnedHostnameResolution'); return undefined; }
export function createWindowsCmdShimFixture() { _w('createWindowsCmdShimFixture'); return undefined; }
export function createProviderUsageFetch() { _w('createProviderUsageFetch'); return undefined; }
export function makeResponse() { _w('makeResponse'); return undefined; }
export function withStateDirEnv() { _w('withStateDirEnv'); return undefined; }
export function captureEnv() { _w('captureEnv'); return undefined; }
export function withEnv() { _w('withEnv'); return undefined; }
export function withEnvAsync() { _w('withEnvAsync'); return undefined; }
export function withFetchPreconnect() { _w('withFetchPreconnect'); return undefined; }
export function createMockServerResponse() { _w('createMockServerResponse'); return undefined; }
export function createTempHomeEnv() { _w('createTempHomeEnv'); return undefined; }
export function withTempDir() { _w('withTempDir'); return undefined; }
export function useFrozenTime() { _w('useFrozenTime'); return undefined; }
export function useRealTime() { _w('useRealTime'); return undefined; }
export function withServer() { _w('withServer'); return undefined; }
export function createMockIncomingRequest() { _w('createMockIncomingRequest'); return undefined; }
export function withTempHome() { _w('withTempHome'); return undefined; }
