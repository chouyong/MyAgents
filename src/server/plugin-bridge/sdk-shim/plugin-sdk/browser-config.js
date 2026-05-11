// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/browser-config.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/browser-config.' + fn + '() not implemented in Bridge mode'); }
}

export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = undefined;
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = undefined;
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = undefined;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = undefined;
export const DEFAULT_OPENCLAW_BROWSER_COLOR = undefined;
export const DEFAULT_OPENCLAW_BROWSER_ENABLED = undefined;
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = undefined;
export const DEFAULT_UPLOAD_DIR = undefined;
export function resolveBrowserConfig() { _w('resolveBrowserConfig'); return undefined; }
export function resolveProfile() { _w('resolveProfile'); return undefined; }
export function parseBrowserHttpUrl() { _w('parseBrowserHttpUrl'); return undefined; }
export function redactCdpUrl() { _w('redactCdpUrl'); return undefined; }
export function ensureBrowserControlAuth() { _w('ensureBrowserControlAuth'); return undefined; }
export function resolveBrowserControlAuth() { _w('resolveBrowserControlAuth'); return undefined; }
