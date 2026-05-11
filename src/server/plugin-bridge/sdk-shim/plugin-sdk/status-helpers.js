// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./status-helpers.auto.js";
// === END AUTO-AUGMENT ===

// Hand-written shim for openclaw/plugin-sdk/status-helpers.
//
// The auto-generated stub returned `undefined` from `createComputedAccountStatusAdapter`,
// which crashed plugins that build their channel object's `base.status` at
// module-load time (yuanbao 2.13.x — issue #180).
//
// Source-of-truth: openclaw/src/plugin-sdk/status-helpers.ts. The adapter
// returned here is consumed by OpenClaw's runtime to surface account-level
// status snapshots for diagnostics. In Bridge mode MyAgents drives most
// status state from the Rust IM layer rather than reading these snapshots,
// so the per-snapshot side effects are minimal — but the SHAPE of the returned
// adapter object matters for plugins (and for any future Bridge code that
// reads it). We mirror upstream's shape and per-field defaults.
//
// Other helpers (probe/webhook/dependent-credential summaries) are not
// consumed by any shipped plugin today; they remain `undefined` until needed.

export function createDefaultChannelRuntimeState(accountId, extra) {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    ...(extra ?? {}),
  };
}

function _buildRuntimeAccountStatusSnapshot(params, extra) {
  const { runtime, probe } = params;
  return {
    running: runtime?.running ?? false,
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    probe,
    ...(extra ?? {}),
  };
}

export function buildRuntimeAccountStatusSnapshot(params, extra) {
  return _buildRuntimeAccountStatusSnapshot(params, extra);
}

export function buildBaseAccountStatusSnapshot(params, extra) {
  const { account, runtime, probe } = params;
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    ..._buildRuntimeAccountStatusSnapshot({ runtime, probe }),
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
    ...(extra ?? {}),
  };
}

export function buildComputedAccountStatusSnapshot(params, extra) {
  const { accountId, name, enabled, configured, runtime, probe } = params;
  return buildBaseAccountStatusSnapshot(
    { account: { accountId, name, enabled, configured }, runtime, probe },
    extra,
  );
}

export function buildBaseChannelStatusSummary(snapshot, extra) {
  return {
    configured: snapshot.configured ?? false,
    ...(extra ?? {}),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

export function buildProbeChannelStatusSummary(snapshot, extra) {
  return {
    ...buildBaseChannelStatusSummary(snapshot, extra),
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
}

export function buildWebhookChannelStatusSummary(snapshot, extra) {
  return buildBaseChannelStatusSummary(snapshot, {
    mode: snapshot.mode ?? 'webhook',
    ...(extra ?? {}),
  });
}

function _buildAdapterBase(options) {
  return {
    defaultRuntime: options.defaultRuntime,
    buildChannelSummary: options.buildChannelSummary,
    probeAccount: options.probeAccount,
    formatCapabilitiesProbe: options.formatCapabilitiesProbe,
    auditAccount: options.auditAccount,
    buildCapabilitiesDiagnostics: options.buildCapabilitiesDiagnostics,
    logSelfId: options.logSelfId,
    resolveAccountState: options.resolveAccountState,
    collectStatusIssues: options.collectStatusIssues,
  };
}

export function createComputedAccountStatusAdapter(options) {
  return {
    ..._buildAdapterBase(options),
    buildAccountSnapshot: (params) => {
      const { extra, ...snapshot } = options.resolveAccountSnapshot(params);
      return buildComputedAccountStatusSnapshot(
        { ...snapshot, runtime: params.runtime, probe: params.probe },
        extra,
      );
    },
  };
}

export function createAsyncComputedAccountStatusAdapter(options) {
  return {
    ..._buildAdapterBase(options),
    buildAccountSnapshot: async (params) => {
      const { extra, ...snapshot } = await options.resolveAccountSnapshot(params);
      return buildComputedAccountStatusSnapshot(
        { ...snapshot, runtime: params.runtime, probe: params.probe },
        extra,
      );
    },
  };
}

// Permissive helpers that are safe no-ops for Bridge mode — none of the shipped
// plugins consume these results today, but exporting them as `undefined` would
// make a `import {x} from '...'` crash at load time, so we provide trivial
// implementations that return empty results.
export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function appendMatchMetadata(_target, _metadata) {
  return undefined;
}

export function asString(value) {
  return value == null ? undefined : String(value);
}

export function collectIssuesForEnabledAccounts() {
  return [];
}

export function formatMatchMetadata(_metadata) {
  return '';
}

export function resolveEnabledConfiguredAccountId() {
  return undefined;
}

export function buildTokenChannelStatusSummary(snapshot, extra) {
  return buildBaseChannelStatusSummary(snapshot, extra);
}

export function createDependentCredentialStatusIssueCollector(_options) {
  return () => [];
}

export function collectStatusIssuesFromLastError() {
  return [];
}
