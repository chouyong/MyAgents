// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-http.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-http.' + fn + '() not implemented in Bridge mode'); }
}

export function assertOkOrThrowHttpError() { _w('assertOkOrThrowHttpError'); return undefined; }
export function assertOkOrThrowProviderError() { _w('assertOkOrThrowProviderError'); return undefined; }
export function createProviderHttpError() { _w('createProviderHttpError'); return undefined; }
export function extractProviderErrorDetail() { _w('extractProviderErrorDetail'); return undefined; }
export function extractProviderRequestId() { _w('extractProviderRequestId'); return undefined; }
export function formatProviderErrorPayload() { _w('formatProviderErrorPayload'); return ""; }
export function formatProviderHttpErrorMessage() { _w('formatProviderHttpErrorMessage'); return ""; }
export function readResponseTextLimited() { _w('readResponseTextLimited'); return undefined; }
export function truncateErrorDetail() { _w('truncateErrorDetail'); return undefined; }
export function buildAudioTranscriptionFormData() { _w('buildAudioTranscriptionFormData'); return undefined; }
export function createProviderOperationDeadline() { _w('createProviderOperationDeadline'); return undefined; }
export function fetchWithTimeout() { _w('fetchWithTimeout'); return undefined; }
export function fetchWithTimeoutGuarded() { _w('fetchWithTimeoutGuarded'); return undefined; }
export function normalizeBaseUrl() { _w('normalizeBaseUrl'); return ""; }
export function pollProviderOperationJson() { _w('pollProviderOperationJson'); return undefined; }
export function postJsonRequest() { _w('postJsonRequest'); return undefined; }
export function postMultipartRequest() { _w('postMultipartRequest'); return undefined; }
export function postTranscriptionRequest() { _w('postTranscriptionRequest'); return undefined; }
export function resolveProviderOperationTimeoutMs() { _w('resolveProviderOperationTimeoutMs'); return undefined; }
export function resolveProviderHttpRequestConfig() { _w('resolveProviderHttpRequestConfig'); return undefined; }
export function resolveAudioTranscriptionUploadFileName() { _w('resolveAudioTranscriptionUploadFileName'); return undefined; }
export function requireTranscriptionText() { _w('requireTranscriptionText'); return undefined; }
export function sanitizeConfiguredModelProviderRequest() { _w('sanitizeConfiguredModelProviderRequest'); return ""; }
export function waitProviderOperationPollInterval() { _w('waitProviderOperationPollInterval'); return undefined; }
export function resolveProviderEndpoint() { _w('resolveProviderEndpoint'); return undefined; }
export function resolveProviderRequestCapabilities() { _w('resolveProviderRequestCapabilities'); return undefined; }
export function resolveProviderRequestPolicy() { _w('resolveProviderRequestPolicy'); return undefined; }
