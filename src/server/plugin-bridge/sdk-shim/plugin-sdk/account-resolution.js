// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/account-resolution.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/account-resolution.' + fn + '() not implemented in Bridge mode'); }
}

export function resolveAccountWithDefaultFallback() { _w('resolveAccountWithDefaultFallback'); return undefined; }
export function createAccountActionGate() { _w('createAccountActionGate'); return undefined; }
export function createAccountListHelpers() { _w('createAccountListHelpers'); return undefined; }
export function describeAccountSnapshot() { _w('describeAccountSnapshot'); return undefined; }
export function listCombinedAccountIds() { _w('listCombinedAccountIds'); return []; }
export function mergeAccountConfig() { _w('mergeAccountConfig'); return undefined; }
export function resolveListedDefaultAccountId() { _w('resolveListedDefaultAccountId'); return undefined; }
export function resolveMergedAccountConfig() { _w('resolveMergedAccountConfig'); return undefined; }
export function normalizeChatType() { _w('normalizeChatType'); return ""; }
export function resolveAccountEntry() { _w('resolveAccountEntry'); return undefined; }
export function resolveNormalizedAccountEntry() { _w('resolveNormalizedAccountEntry'); return undefined; }
export const DEFAULT_ACCOUNT_ID = undefined;
export function normalizeAccountId() { _w('normalizeAccountId'); return ""; }
export function normalizeOptionalAccountId() { _w('normalizeOptionalAccountId'); return ""; }
export function normalizeE164() { _w('normalizeE164'); return ""; }
export function pathExists() { _w('pathExists'); return undefined; }
export function resolveUserPath() { _w('resolveUserPath'); return undefined; }
export function listConfiguredAccountIds() { _w('listConfiguredAccountIds'); return []; }
