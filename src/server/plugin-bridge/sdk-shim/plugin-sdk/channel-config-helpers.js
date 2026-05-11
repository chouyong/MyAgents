// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./channel-config-helpers.auto.js";
// === END AUTO-AUGMENT ===

// Hand-written shim for openclaw/plugin-sdk/channel-config-helpers.
//
// The auto-generated stub returned `undefined` for `createScopedDmSecurityResolver`,
// which crashed plugins that build their channel object's `security.resolveDmPolicy`
// at module-load time (yuanbao 2.13.x — issue #180).
//
// Source-of-truth: openclaw/src/plugin-sdk/channel-config-helpers.ts (factory)
// + openclaw/src/channels/plugins/helpers.ts::buildAccountScopedDmSecurityPolicy
// (implementation). Bridge mode forces `dmPolicy: 'open'` at the runtime layer
// (see compat-runtime.ts:213) and lets the Rust IM layer do access control,
// so the policy object this returns is mostly informational — but its shape
// must match upstream so plugins that introspect it don't break.
//
// Other helpers in this module (resolveChannelConfigWrites, the createScoped*
// adapters, etc.) are not consumed by any shipped plugin today; they remain
// `undefined` until a plugin needs them. Add the impl from upstream when that
// happens.

import { DEFAULT_ACCOUNT_ID } from './account-id.js';

function _resolveFieldName(suffix, fallbackField) {
  if (suffix == null || suffix === '') return fallbackField;
  return /^[A-Za-z0-9_-]+$/.test(suffix) ? suffix : null;
}

function _matchesAnyField(config, fields) {
  return fields.some((field) => field != null && config?.[field] !== undefined);
}

export function buildAccountScopedDmSecurityPolicy(params) {
  const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? DEFAULT_ACCOUNT_ID;
  const channelConfig = params.cfg?.channels?.[params.channelKey];
  const rootBasePath = `channels.${params.channelKey}.`;
  const accountBasePath = `channels.${params.channelKey}.accounts.${resolvedAccountId}.`;
  const defaultBasePath = `channels.${params.channelKey}.accounts.${DEFAULT_ACCOUNT_ID}.`;
  const accountConfig = channelConfig?.accounts?.[resolvedAccountId];
  const defaultAccountConfig =
    params.inheritSharedDefaultsFromDefaultAccount && resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? channelConfig?.accounts?.[DEFAULT_ACCOUNT_ID]
      : undefined;

  const simplePolicyField = _resolveFieldName(params.policyPathSuffix, 'dmPolicy');
  const simpleAllowFromField = _resolveFieldName(params.allowFromPathSuffix, 'allowFrom');
  const fields = [simplePolicyField, simpleAllowFromField];
  const basePath =
    simplePolicyField || simpleAllowFromField
      ? _matchesAnyField(accountConfig, fields)
        ? accountBasePath
        : _matchesAnyField(defaultAccountConfig, fields)
          ? defaultBasePath
          : _matchesAnyField(channelConfig, fields)
            ? rootBasePath
            : accountConfig
              ? accountBasePath
              : rootBasePath
      : accountConfig
        ? accountBasePath
        : rootBasePath;

  const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ''}`;
  const policyPath =
    params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : undefined;

  return {
    policy: params.policy ?? params.defaultPolicy ?? 'pairing',
    allowFrom: params.allowFrom ?? [],
    policyPath,
    allowFromPath,
    approveHint:
      params.approveHint ??
      `Approve via: openclaw pairing approve ${params.approveChannelId ?? params.channelKey} <code>`,
    normalizeEntry: params.normalizeEntry,
  };
}

export function createScopedDmSecurityResolver(params) {
  return ({ cfg, accountId, account }) =>
    buildAccountScopedDmSecurityPolicy({
      cfg,
      channelKey: params.channelKey,
      accountId,
      fallbackAccountId:
        params.resolveFallbackAccountId?.(account) ?? account?.accountId,
      policy: params.resolvePolicy?.(account),
      allowFrom: params.resolveAllowFrom?.(account) ?? [],
      defaultPolicy: params.defaultPolicy,
      allowFromPathSuffix: params.allowFromPathSuffix,
      policyPathSuffix: params.policyPathSuffix,
      approveChannelId: params.approveChannelId,
      approveHint: params.approveHint,
      normalizeEntry: params.normalizeEntry,
      inheritSharedDefaultsFromDefaultAccount: params.inheritSharedDefaultsFromDefaultAccount,
    });
}

// Re-exported for plugins that already import them from this module path
// (matches upstream barrel surface).
export { mapAllowFromEntries } from './compat.js';

// Surfaces upstream exports — kept as undefined until a plugin consumes them.
