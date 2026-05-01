// Shared "user changed an option in the input toolbar" persistence policy.
//
// Both the chat-tab input and the launcher input write to the same trio
// (session snapshot / project / agent) when the user toggles provider, model,
// permission mode, or MCP. Until v0.2.7 each surface had its own copy of the
// patch logic; the two copies had drifted (Chat ignored runtimeConfig for
// permission mode, Launcher correctly branched on runtime). This module
// captures the dual-write policy in one place so future changes only happen
// in one file.
//
// Two contracts:
//
// 1. Pure-data: callers tell us "what fields changed, on which workspace,
//    with which session" — we figure out where on disk to write. No React
//    state ownership, no implicit hooks. Easy to test, easy to reason about.
//
// 2. Side-effect locality: the only side-effect this function performs is
//    disk writes via injected callbacks (`patchProject`, `patchSnapshot`,
//    `patchAgentConfig`) and an optional sidecar `/api/mcp/set` call. UI state
//    updates (setSelectedModel etc.) are caller responsibility — keeping them
//    out keeps this function pure across both Chat (with a session) and
//    Launcher (without).

import type { PermissionMode, Project, McpServerDefinition } from '@/config/types';
import type { AgentConfig } from '@/../shared/types/agent';
import type { RuntimeConfig } from '@/../shared/types/runtime';

/** What the user just changed in the toolbar. All fields optional. */
export interface InputOptionFields {
  /** Selected provider id. Builtin runtime only. */
  providerId?: string | null;
  /** Selected model when on the builtin runtime — paired with providerId. */
  builtinModel?: string | null;
  /** Selected model when on an external runtime (Codex/CC/Gemini). */
  runtimeModel?: string | null;
  /** Permission mode — split between `agent.permissionMode` (builtin) and
   *  `agent.runtimeConfig.permissionMode` (external) at the storage layer. */
  permissionMode?: PermissionMode;
  /** MCP server ids enabled at the workspace level. */
  mcpEnabledServers?: string[];
}

export interface PersistInputOptionParams {
  /** Workspace (Project) id. Required — both Chat and Launcher always have one. */
  workspaceId: string;
  /** Agent id; null when the workspace has no Basic Agent yet. */
  agentId?: string | null;

  /** Whether the active runtime is non-builtin (Codex/CC/Gemini). Used to
   *  branch where permission mode and runtime model live on disk. */
  isExternalRuntime: boolean;
  /** Existing runtimeConfig to merge into when writing
   *  `runtimeConfig.permissionMode` / `.model`. Avoids stomping unrelated keys. */
  currentRuntimeConfig?: RuntimeConfig;

  fields: InputOptionFields;

  /** Disk writers — injected so the helper has zero direct module imports
   *  and can be unit-tested with mocks. */
  patchProject: (
    projectId: string,
    updates: Partial<Omit<Project, 'id'>>,
  ) => Promise<unknown>;
  patchAgentConfig: (
    agentId: string,
    patch: Partial<Omit<AgentConfig, 'id'>>,
  ) => Promise<unknown>;

  /** Session snapshot writer — chat-tab only (owned sessions). Omit for
   *  launcher (no session yet) or unlocked sessions (no snapshot). */
  patchSnapshot?: (patch: SessionSnapshotPatch) => Promise<unknown>;

  /** Live sidecar push for MCP — chat-tab only (launcher has no Sidecar to
   *  push to; the new sidecar created during handoff picks up the disk write). */
  pushMcpToSidecar?: (effectiveServers: McpServerDefinition[]) => Promise<unknown>;
  /** Helpers for resolving effective MCP set for the sidecar push. Required
   *  iff `pushMcpToSidecar` and `fields.mcpEnabledServers` are both set. */
  getAllMcpServers?: () => Promise<McpServerDefinition[]>;
  getGlobalMcpEnabled?: () => Promise<string[]>;
}

/** Subset of the session snapshot fields we touch. Defined here (not imported
 *  from session types) to keep this helper free of session schema deps. */
export interface SessionSnapshotPatch {
  providerId?: string | null;
  model?: string | null;
  permissionMode?: PermissionMode;
  mcpEnabledServers?: string[];
}

/**
 * Apply the input-option change to disk + (optionally) sidecar.
 *
 * Layered:
 * 1. Build the project patch + agent patch + snapshot patch from `fields`,
 *    branching permission/model on `isExternalRuntime`.
 * 2. Fire all writes; failures are surfaced as a result for the caller to
 *    decide UX (toast etc.) — we do NOT throw.
 * 3. If MCP changed and a sidecar push is configured, send /api/mcp/set with
 *    the resolved effective server list.
 */
export async function persistInputOptionChange(
  params: PersistInputOptionParams,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const projectPatch = buildProjectPatch(params);
  const snapshotPatch = buildSnapshotPatch(params);
  const agentPatch = buildAgentPatch(params);

  // Order: snapshot first (matches the existing dual-write order in
  // Chat.tsx::persistTabConfigChange) so a snapshot failure surfaces before
  // we update the live config.
  if (params.patchSnapshot && Object.keys(snapshotPatch).length > 0) {
    try {
      await params.patchSnapshot(snapshotPatch);
    } catch (e) {
      errors.push(`session snapshot: ${describe(e)}`);
    }
  }

  if (Object.keys(projectPatch).length > 0) {
    try {
      await params.patchProject(params.workspaceId, projectPatch);
    } catch (e) {
      errors.push(`project: ${describe(e)}`);
    }
  }

  if (params.agentId && Object.keys(agentPatch).length > 0) {
    try {
      await params.patchAgentConfig(params.agentId, agentPatch);
    } catch (e) {
      errors.push(`agent: ${describe(e)}`);
    }
  }

  // Sidecar push is optional and only runs when the caller wired all three
  // helpers (push + resolve all + resolve enabled). Launcher passes none of
  // the three and skips this branch entirely.
  if (
    params.pushMcpToSidecar &&
    params.getAllMcpServers &&
    params.getGlobalMcpEnabled &&
    params.fields.mcpEnabledServers !== undefined
  ) {
    try {
      const allServers = await params.getAllMcpServers();
      const globalEnabled = await params.getGlobalMcpEnabled();
      const effective = allServers.filter(
        s =>
          globalEnabled.includes(s.id) &&
          params.fields.mcpEnabledServers!.includes(s.id),
      );
      await params.pushMcpToSidecar(effective);
    } catch (e) {
      errors.push(`sidecar mcp push: ${describe(e)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── builders ────────────────────────────────────────────────────────────

function buildProjectPatch(
  params: PersistInputOptionParams,
): Partial<Omit<Project, 'id'>> {
  const patch: Partial<Omit<Project, 'id'>> = {};
  const { fields, isExternalRuntime } = params;

  if (fields.providerId !== undefined) {
    patch.providerId = fields.providerId ?? undefined;
  }
  // builtinModel goes to project.model — that's the project-level "default
  // model" used by future sessions. runtimeModel does NOT go to the project
  // because the project doesn't track a per-runtime model; that field lives
  // on the agent.runtimeConfig.
  if (fields.builtinModel !== undefined) {
    patch.model = fields.builtinModel ?? null;
  }
  if (fields.permissionMode !== undefined && !isExternalRuntime) {
    patch.permissionMode = fields.permissionMode;
  }
  if (fields.mcpEnabledServers !== undefined) {
    patch.mcpEnabledServers = fields.mcpEnabledServers;
  }
  return patch;
}

function buildSnapshotPatch(params: PersistInputOptionParams): SessionSnapshotPatch {
  const patch: SessionSnapshotPatch = {};
  const { fields, isExternalRuntime } = params;

  if (fields.providerId !== undefined) patch.providerId = fields.providerId;
  // Snapshot.model is the session's "current model" regardless of runtime —
  // pre-PRD-0.2.7 Chat persisted to it via the unified `model` field. Now
  // that callers split by runtime, we have to write whichever one applies
  // for the current runtime; otherwise external-runtime model changes (e.g.
  // `handleRuntimeModelChange`) silently bypass the snapshot and consumers
  // reading `snapshot.model` (sidecar restore, IM bot bridge) see stale
  // builtin values.
  if (isExternalRuntime) {
    if (fields.runtimeModel !== undefined) patch.model = fields.runtimeModel;
  } else if (fields.builtinModel !== undefined) {
    patch.model = fields.builtinModel;
  }
  if (fields.permissionMode !== undefined && !isExternalRuntime) {
    patch.permissionMode = fields.permissionMode;
  }
  if (fields.mcpEnabledServers !== undefined) {
    patch.mcpEnabledServers = fields.mcpEnabledServers;
  }
  return patch;
}

function buildAgentPatch(
  params: PersistInputOptionParams,
): Partial<Omit<AgentConfig, 'id'>> {
  const patch: Partial<Omit<AgentConfig, 'id'>> = {};
  const { fields, isExternalRuntime, currentRuntimeConfig } = params;

  if (fields.providerId !== undefined) {
    patch.providerId = fields.providerId ?? undefined;
  }
  if (fields.mcpEnabledServers !== undefined) {
    patch.mcpEnabledServers = fields.mcpEnabledServers;
  }

  // Permission mode + model split by runtime. The historical Chat.tsx bug
  // was writing every permission mode change to `agent.permissionMode` even
  // when the runtime was external (Codex/CC/Gemini), where the canonical
  // location is `agent.runtimeConfig.permissionMode`. Launcher already had
  // the correct branch — this helper is the unified version.
  if (isExternalRuntime) {
    const next: Partial<RuntimeConfig> = { ...(currentRuntimeConfig ?? {}) };
    let runtimeConfigDirty = false;
    if (fields.permissionMode !== undefined) {
      next.permissionMode = fields.permissionMode;
      runtimeConfigDirty = true;
    }
    if (fields.runtimeModel !== undefined) {
      next.model = fields.runtimeModel ?? undefined;
      runtimeConfigDirty = true;
    }
    if (runtimeConfigDirty) {
      patch.runtimeConfig = next as RuntimeConfig;
    }
  } else {
    if (fields.permissionMode !== undefined) {
      patch.permissionMode = fields.permissionMode;
    }
    if (fields.builtinModel !== undefined) {
      patch.model = fields.builtinModel ?? undefined;
    }
  }

  return patch;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
