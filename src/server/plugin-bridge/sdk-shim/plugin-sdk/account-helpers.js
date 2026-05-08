// Hand-written shim for openclaw/plugin-sdk/account-helpers.
//
// The auto-generated stub returned `undefined` for `createAccountListHelpers`,
// which crashed any plugin that destructured the result (e.g.
// openclaw-plugin-yuanbao: `const { listAccountIds } = createAccountListHelpers("yuanbao")`
// — issue #171). These helpers are pure config-shape transforms, so we mirror
// the real openclaw implementation rather than ship a no-op proxy.
//
// Source-of-truth: openclaw/src/channels/plugins/account-helpers.ts +
// account-action-gate.ts. Keep behavior in sync if those change.

import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from './account-id.js';

function normalizeOptionalAccountId(id) {
  if (id === undefined || id === null) return undefined;
  return normalizeAccountId(id);
}

function resolveAccountEntry(accounts, accountId) {
  if (!accounts || typeof accounts !== 'object') return undefined;
  if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
  const lower = String(accountId ?? '').toLowerCase();
  const matchKey = Object.keys(accounts).find((key) => String(key).toLowerCase() === lower);
  return matchKey ? accounts[matchKey] : undefined;
}

function resolveNormalizedAccountEntry(accounts, accountId, normalize) {
  if (!accounts || typeof accounts !== 'object') return undefined;
  if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
  const target = normalize(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalize(key) === target);
  return matchKey ? accounts[matchKey] : undefined;
}

// Internal helpers — not part of the openclaw/plugin-sdk/account-helpers
// public surface, kept private to mirror the real re-export.
function listCombinedAccountIds(params) {
  const ids = new Set();
  for (const id of params.configuredAccountIds ?? []) if (id) ids.add(id);
  for (const id of params.additionalAccountIds ?? []) if (id) ids.add(id);
  if (params.implicitAccountId) ids.add(params.implicitAccountId);
  if (ids.size === 0 && params.fallbackAccountIdWhenEmpty) {
    return [params.fallbackAccountIdWhenEmpty];
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function resolveListedDefaultAccountId(params) {
  const preferred = params.configuredDefaultAccountId;
  const normalize = params.normalizeListedAccountId ?? normalizeAccountId;
  if (
    preferred &&
    (params.allowUnlistedDefaultAccount ||
      params.accountIds.some((id) => normalize(id) === preferred))
  ) {
    return preferred;
  }
  if (params.accountIds.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  if (params.ambiguousFallbackAccountId && params.accountIds.length > 1) {
    return params.ambiguousFallbackAccountId;
  }
  return params.accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

export function createAccountListHelpers(channelKey, options) {
  function listConfiguredAccountIds(cfg) {
    const channel = cfg?.channels?.[channelKey];
    const accounts = channel?.accounts;
    if (!accounts || typeof accounts !== 'object') return [];
    const ids = Object.keys(accounts).filter(Boolean);
    const normalize = options?.normalizeAccountId;
    if (!normalize) return ids;
    return [...new Set(ids.map((id) => normalize(id)).filter(Boolean))];
  }

  function listAccountIds(cfg) {
    return listCombinedAccountIds({
      configuredAccountIds: listConfiguredAccountIds(cfg),
      fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
    });
  }

  function resolveConfiguredDefaultAccountId(cfg) {
    const channel = cfg?.channels?.[channelKey];
    const preferred = normalizeOptionalAccountId(
      typeof channel?.defaultAccount === 'string' ? channel.defaultAccount : undefined,
    );
    if (!preferred) return undefined;
    if (options?.allowUnlistedDefaultAccount) return preferred;
    const ids = listAccountIds(cfg);
    if (ids.some((id) => normalizeAccountId(id) === preferred)) return preferred;
    return undefined;
  }

  function resolveDefaultAccountId(cfg) {
    return resolveListedDefaultAccountId({
      accountIds: listAccountIds(cfg),
      configuredDefaultAccountId: resolveConfiguredDefaultAccountId(cfg),
      allowUnlistedDefaultAccount: options?.allowUnlistedDefaultAccount,
    });
  }

  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}

export function mergeAccountConfig(params) {
  const omitKeys = new Set(['accounts', ...(params.omitKeys ?? [])]);
  const base = Object.fromEntries(
    Object.entries(params.channelConfig ?? {}).filter(([key]) => !omitKeys.has(key)),
  );
  const merged = { ...base, ...params.accountConfig };
  for (const key of params.nestedObjectKeys ?? []) {
    const baseValue = base[key];
    const accountValue = params.accountConfig?.[key];
    if (
      typeof baseValue === 'object' && baseValue != null && !Array.isArray(baseValue) &&
      typeof accountValue === 'object' && accountValue != null && !Array.isArray(accountValue)
    ) {
      merged[key] = { ...baseValue, ...accountValue };
    }
  }
  return merged;
}

export function resolveMergedAccountConfig(params) {
  const accountConfig = params.normalizeAccountId
    ? resolveNormalizedAccountEntry(params.accounts, params.accountId, params.normalizeAccountId)
    : resolveAccountEntry(params.accounts, params.accountId);
  return mergeAccountConfig({
    channelConfig: params.channelConfig,
    accountConfig,
    omitKeys: params.omitKeys,
    nestedObjectKeys: params.nestedObjectKeys,
  });
}

export function describeAccountSnapshot(params) {
  const name = typeof params.account.name === 'string' ? params.account.name.trim() : undefined;
  return {
    accountId: params.account.accountId ?? DEFAULT_ACCOUNT_ID,
    name: name || undefined,
    enabled: params.account.enabled !== false,
    configured: params.configured,
    ...params.extra,
  };
}

export function describeWebhookAccountSnapshot(params) {
  return describeAccountSnapshot({
    account: params.account,
    configured: params.configured,
    extra: { mode: params.mode ?? 'webhook', ...params.extra },
  });
}

export function createAccountActionGate(params) {
  return (key, defaultValue = true) => {
    const accountValue = params?.accountActions?.[key];
    if (accountValue !== undefined) return accountValue;
    const baseValue = params?.baseActions?.[key];
    if (baseValue !== undefined) return baseValue;
    return defaultValue;
  };
}
