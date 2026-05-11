// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./channel-plugin-common.auto.js";
// === END AUTO-AUGMENT ===

// Hand-written shim for openclaw/plugin-sdk/channel-plugin-common.
//
// The auto-generated stub returned `undefined` for everything including
// `DEFAULT_ACCOUNT_ID`. Plugins that build their channel object at module-load
// time (yuanbao 2.13.x — issue #180) use `DEFAULT_ACCOUNT_ID` and the
// `*InConfigSection` mutators inside their config adapter and channel
// definition, so a `undefined` constant crashes the channel object before
// `api.registerChannel()` ever runs.
//
// Source-of-truth: openclaw/src/plugin-sdk/channel-plugin-common.ts (a barrel)
// and openclaw/src/channels/plugins/config-helpers.ts (the impls). Mutator
// behavior is faithfully ported — both functions return new immutable cfg
// trees, never mutate inputs, and follow the same DEFAULT_ACCOUNT_ID/top-level
// vs accounts.{id} branching.

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from './account-id.js';

import { DEFAULT_ACCOUNT_ID } from './account-id.js';

export const emptyPluginConfigSchema = { type: 'object', additionalProperties: true, properties: {} };
export const PAIRING_APPROVED_MESSAGE = 'pairing approved';

export function applyAccountNameToChannelSection(_params) {
  return undefined;
}

export function migrateBaseNameToDefaultAccount(_params) {
  return undefined;
}

export function formatPairingApproveHint(channelId) {
  // Bridge mode doesn't run the openclaw CLI — the literal string still helps
  // surface the channel id in any user-visible policy explanation.
  return `Approve via: openclaw pairing approve ${channelId} <code>`;
}

export function getChatChannelMeta(_id) {
  return undefined;
}

export function setAccountEnabledInConfigSection(params) {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg?.channels;
  const base = channels?.[params.sectionKey];
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg?.channels,
        [params.sectionKey]: {
          ...base,
          enabled: params.enabled,
        },
      },
    };
  }

  const baseAccounts = base?.accounts ?? {};
  const existing = baseAccounts[accountKey] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg?.channels,
      [params.sectionKey]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountKey]: {
            ...existing,
            enabled: params.enabled,
          },
        },
      },
    },
  };
}

export function deleteAccountFromConfigSection(params) {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg?.channels;
  const base = channels?.[params.sectionKey];
  if (!base) return params.cfg;

  const baseAccounts =
    base.accounts && typeof base.accounts === 'object' ? { ...base.accounts } : undefined;

  if (accountKey !== DEFAULT_ACCOUNT_ID) {
    const accounts = baseAccounts ? { ...baseAccounts } : {};
    delete accounts[accountKey];
    return {
      ...params.cfg,
      channels: {
        ...params.cfg?.channels,
        [params.sectionKey]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      },
    };
  }

  if (baseAccounts && Object.keys(baseAccounts).length > 0) {
    delete baseAccounts[accountKey];
    const baseRecord = { ...base };
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) baseRecord[field] = undefined;
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg?.channels,
        [params.sectionKey]: {
          ...baseRecord,
          accounts: Object.keys(baseAccounts).length ? baseAccounts : undefined,
        },
      },
    };
  }

  const nextChannels = { ...params.cfg?.channels };
  delete nextChannels[params.sectionKey];
  const nextCfg = { ...params.cfg };
  if (Object.keys(nextChannels).length > 0) {
    nextCfg.channels = nextChannels;
  } else {
    delete nextCfg.channels;
  }
  return nextCfg;
}
