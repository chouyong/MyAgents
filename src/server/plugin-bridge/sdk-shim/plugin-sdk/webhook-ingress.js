// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/webhook-ingress.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/webhook-ingress.' + fn + '() not implemented in Bridge mode'); }
}

export function createBoundedCounter() { _w('createBoundedCounter'); return undefined; }
export function createFixedWindowRateLimiter() { _w('createFixedWindowRateLimiter'); return undefined; }
export function createWebhookAnomalyTracker() { _w('createWebhookAnomalyTracker'); return undefined; }
export const WEBHOOK_ANOMALY_COUNTER_DEFAULTS = undefined;
export const WEBHOOK_ANOMALY_STATUS_CODES = undefined;
export const WEBHOOK_RATE_LIMIT_DEFAULTS = undefined;
export function applyBasicWebhookRequestGuards() { _w('applyBasicWebhookRequestGuards'); return undefined; }
export function beginWebhookRequestPipelineOrReject() { _w('beginWebhookRequestPipelineOrReject'); return undefined; }
export function createWebhookInFlightLimiter() { _w('createWebhookInFlightLimiter'); return undefined; }
export function isJsonContentType() { _w('isJsonContentType'); return false; }
export function isRequestBodyLimitError() { _w('isRequestBodyLimitError'); return false; }
export function readRequestBodyWithLimit() { _w('readRequestBodyWithLimit'); return undefined; }
export function readJsonWebhookBodyOrReject() { _w('readJsonWebhookBodyOrReject'); return undefined; }
export function readWebhookBodyOrReject() { _w('readWebhookBodyOrReject'); return undefined; }
export function requestBodyErrorToText() { _w('requestBodyErrorToText'); return undefined; }
export const WEBHOOK_BODY_READ_DEFAULTS = undefined;
export const WEBHOOK_IN_FLIGHT_DEFAULTS = undefined;
export function registerPluginHttpRoute() { _w('registerPluginHttpRoute'); return undefined; }
export function registerWebhookTarget() { _w('registerWebhookTarget'); return undefined; }
export function registerWebhookTargetWithPluginRoute() { _w('registerWebhookTargetWithPluginRoute'); return undefined; }
export function resolveSingleWebhookTarget() { _w('resolveSingleWebhookTarget'); return undefined; }
export function resolveSingleWebhookTargetAsync() { _w('resolveSingleWebhookTargetAsync'); return undefined; }
export function resolveWebhookTargetWithAuthOrReject() { _w('resolveWebhookTargetWithAuthOrReject'); return undefined; }
export function resolveWebhookTargetWithAuthOrRejectSync() { _w('resolveWebhookTargetWithAuthOrRejectSync'); return undefined; }
export function resolveWebhookTargets() { _w('resolveWebhookTargets'); return undefined; }
export function withResolvedWebhookRequestPipeline() { _w('withResolvedWebhookRequestPipeline'); return undefined; }
export function normalizeWebhookPath() { _w('normalizeWebhookPath'); return ""; }
export function resolveWebhookPath() { _w('resolveWebhookPath'); return undefined; }
export function resolveRequestClientIp() { _w('resolveRequestClientIp'); return undefined; }
export function createAuthRateLimiter() { _w('createAuthRateLimiter'); return undefined; }
export function rawDataToString() { _w('rawDataToString'); return undefined; }
export function normalizePluginHttpPath() { _w('normalizePluginHttpPath'); return ""; }
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = undefined;
