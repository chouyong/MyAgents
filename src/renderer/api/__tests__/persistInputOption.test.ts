import { describe, expect, it, vi } from 'vitest';

import { persistInputOptionChange } from '../persistInputOption';

function makeMocks() {
  return {
    patchProject: vi.fn().mockResolvedValue(undefined),
    patchAgentConfig: vi.fn().mockResolvedValue(undefined),
    patchSnapshot: vi.fn().mockResolvedValue(undefined),
    pushMcpToSidecar: vi.fn().mockResolvedValue(undefined),
    getAllMcpServers: vi.fn().mockResolvedValue([]),
    getGlobalMcpEnabled: vi.fn().mockResolvedValue([]),
  };
}

describe('persistInputOptionChange — disk write fanout', () => {
  it('writes provider+builtinModel to project, agent, and snapshot when builtin', async () => {
    const m = makeMocks();
    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'deepseek', builtinModel: 'deepseek-chat' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(res.ok).toBe(true);
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('writes builtin permission to agent.permissionMode (NOT runtimeConfig)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { permissionMode: 'plan' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      permissionMode: 'plan',
    });
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      permissionMode: 'plan',
    });
  });

  it('writes external permission to agent.runtimeConfig (NOT permissionMode)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      currentRuntimeConfig: { customSetting: 'preserve' } as never,
      fields: { permissionMode: 'plan' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
    });

    // Project does NOT get permissionMode for external runtimes.
    expect(m.patchProject).not.toHaveBeenCalled();
    // Agent gets it nested in runtimeConfig, with existing keys preserved.
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeConfig: {
        customSetting: 'preserve',
        permissionMode: 'plan',
      },
    });
  });

  it('writes runtimeModel to agent.runtimeConfig.model when external', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { runtimeModel: 'sonnet' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
    });
    // Project doesn't track runtimeModel — only the agent does.
    expect(m.patchProject).not.toHaveBeenCalled();
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeConfig: { model: 'sonnet' },
    });
  });

  it('writes runtimeModel to session snapshot when external (cross-review fix)', async () => {
    // Regression check: the helper used to skip snapshot.model for external
    // runtimes entirely, dropping `handleRuntimeModelChange`'s update on the
    // floor. Cross-review (CC perspective) caught this; the fix routes
    // runtimeModel into snapshot.model when isExternalRuntime is true.
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { runtimeModel: 'sonnet' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ model: 'sonnet' });
  });

  it('does NOT write builtinModel to snapshot when on external runtime', async () => {
    // Symmetric guard: a stale builtinModel sneaking through (e.g. caller
    // passes both fields by accident) must not pollute snapshot.model.
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { builtinModel: 'deepseek-chat', runtimeModel: 'sonnet' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ model: 'sonnet' });
  });

  it('writes mcpEnabledServers to project + agent + snapshot', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { mcpEnabledServers: ['playwright', 'im-cron'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      mcpEnabledServers: ['playwright', 'im-cron'],
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      mcpEnabledServers: ['playwright', 'im-cron'],
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      mcpEnabledServers: ['playwright', 'im-cron'],
    });
  });

  it('skips snapshot write when patchSnapshot is omitted (launcher mode)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'p1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      // no patchSnapshot
    });
    // patchSnapshot was never wired, so calling it counts as 0.
    expect(m.patchSnapshot).not.toHaveBeenCalled();
  });

  it('skips agent write when agentId is null', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: null,
      isExternalRuntime: false,
      fields: { providerId: 'p1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
    });
    expect(m.patchProject).toHaveBeenCalled();
    expect(m.patchAgentConfig).not.toHaveBeenCalled();
  });

  it('returns ok=false with error string when a writer throws', async () => {
    const m = makeMocks();
    m.patchProject.mockRejectedValueOnce(new Error('disk full'));
    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'p1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('disk full');
    // Other writers still run — failure isolated.
    expect(m.patchAgentConfig).toHaveBeenCalled();
  });

  it('pushes resolved MCP set to sidecar when wired', async () => {
    const m = makeMocks();
    m.getAllMcpServers.mockResolvedValueOnce([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]);
    m.getGlobalMcpEnabled.mockResolvedValueOnce(['a', 'b']);

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { mcpEnabledServers: ['a', 'c'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      pushMcpToSidecar: m.pushMcpToSidecar,
      getAllMcpServers: m.getAllMcpServers,
      getGlobalMcpEnabled: m.getGlobalMcpEnabled,
    });
    // Only 'a' is in BOTH workspace-enabled (a,c) AND global-enabled (a,b).
    expect(m.pushMcpToSidecar).toHaveBeenCalledWith([{ id: 'a', name: 'A' }]);
  });

  it('does NOT push to sidecar in launcher mode (no pushMcpToSidecar wired)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { mcpEnabledServers: ['a'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      // no sidecar push trio
    });
    expect(m.pushMcpToSidecar).not.toHaveBeenCalled();
  });
});
