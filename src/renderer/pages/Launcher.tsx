/**
 * Launcher - Main entry page for MyAgents
 * Two-column layout: Brand section (left 60%) + Workspaces (right 40%)
 * Responsive: stacks vertically below 768px
 */

import { FolderPlus, LayoutTemplate, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import { track } from '@/analytics';
import { type ImageAttachment } from '@/components/SimpleChatInput';
import { useToast } from '@/components/Toast';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import PathInputDialog from '@/components/PathInputDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import TaskCenterOverlay from '@/components/TaskCenterOverlay';
import { AddWorkspaceMenu, BrandSection, RecentTasks, TemplateLibraryDialog, WorkspaceCard, WorkspaceEditDialog } from '@/components/launcher';
import WorkspaceConfigPanel from '@/components/WorkspaceConfigPanel';
import { useConfig } from '@/hooks/useConfig';
import { useTaskCenterData } from '@/hooks/useTaskCenterData';
import { type Project, type PermissionMode, type McpServerDefinition } from '@/config/types';
import { CUSTOM_EVENTS } from '../../shared/constants';
import {
    getAllMcpServers,
    getEnabledMcpServerIds,
    resolveProvider,
    pairBuiltinSelection,
} from '@/config/configService';
import { patchAgentConfig, getAgentById } from '@/config/services/agentConfigService';
import { persistInputOptionChange } from '@/api/persistInputOption';
import { createCronTask, startCronTask, startCronScheduler } from '@/api/cronTaskClient';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode, RuntimeDetections } from '../../shared/types/runtime';
import { CC_MODELS, CC_PERMISSION_MODES, CODEX_PERMISSION_MODES, GEMINI_PERMISSION_MODES } from '../../shared/types/runtime';
import { apiGetJson } from '@/api/apiFetch';
import { isBrowserDevMode, pickFolderForDialog } from '@/utils/browserMock';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import type { SessionMetadata } from '@/api/sessionClient';
import type { InitialMessage } from '@/types/tab';

interface LauncherProps {
    onLaunchProject: (project: Project, sessionId?: string, initialMessage?: InitialMessage) => void;
    isStarting?: boolean;
    startError?: string | null;
    isActive?: boolean;
}

export default function Launcher({ onLaunchProject, isStarting, startError: _startError, isActive }: LauncherProps) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const {
        config,
        projects,
        providers,
        isLoading,
        error: _error,
        addProject,
        removeProject,
        patchProject,
        touchProject,
        apiKeys,
        providerVerifyStatus,
        refreshProviderData,
        updateConfig,
    } = useConfig();

    // Filter out internal projects (e.g. ~/.myagents diagnostic workspace)
    const visibleProjects = useMemo(() => projects.filter(p => !p.internal), [projects]);

    // Poll agent statuses only when any project has proactive mode
    const hasAnyAgent = useMemo(() => visibleProjects.some(p => p.isAgent), [visibleProjects]);
    const { statuses: agentStatuses } = useAgentStatuses(hasAnyAgent);
    const taskCenterData = useTaskCenterData({ isActive });

    // Build agent lookup: project path → { agent config, runtime status }
    const agentLookup = useMemo(() => {
        const map = new Map<string, { agent: NonNullable<typeof config.agents>[number]; status?: (typeof agentStatuses)[string] }>();
        if (!config.agents) return map;
        for (const agent of config.agents) {
            const key = agent.workspacePath.replace(/\\/g, '/');
            map.set(key, { agent, status: agentStatuses[agent.id] });
        }
        return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config.agents is the actual dependency; full config would cause unnecessary recomputes
    }, [config.agents, agentStatuses]);

    const [_addError, setAddError] = useState<string | null>(null);
    const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(null);
    const [showLogs, setShowLogs] = useState(false);
    const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);
    const [showOverlay, setShowOverlay] = useState(false);
    const [showTemplateDialog, setShowTemplateDialog] = useState(false);
    const [editingProject, setEditingProject] = useState<Project | null>(null);
    // Agent overlay — opens WorkspaceConfigPanel for agent settings or upgrade
    const [agentOverlay, setAgentOverlay] = useState<{ workspacePath: string; initialTab: 'agent' } | null>(null);

    // ===== Launcher-specific state for BrandSection =====

    // Fallback chain: defaultWorkspacePath → mino project → first project → null
    const resolveDefaultWorkspace = useCallback((projs: Project[]): Project | null => {
        if (config.defaultWorkspacePath) {
            const def = projs.find(p => p.path === config.defaultWorkspacePath);
            if (def) return def;
        }
        // Fallback: find mino project by path suffix
        const mino = projs.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
        if (mino) return mino;
        return projs[0] ?? null;
    }, [config.defaultWorkspacePath]);

    const [selectedWorkspace, setSelectedWorkspace] = useState<Project | null>(() =>
        resolveDefaultWorkspace(visibleProjects)
    );

    // Sync selectedWorkspace when visible projects change (e.g., after first project is added,
    // or after patchProject updates a project's settings from Chat tab)
    useEffect(() => {
        setSelectedWorkspace(prev => {
            if (!prev) return resolveDefaultWorkspace(visibleProjects);
            // Always use the latest project data (not stale prev reference)
            // so that settings changed in Chat via patchProject are reflected
            const updated = visibleProjects.find(p => p.id === prev.id);
            return updated ?? resolveDefaultWorkspace(visibleProjects);
        });
    }, [visibleProjects, resolveDefaultWorkspace]);

    const [launcherPermissionMode, setLauncherPermissionMode] = useState<PermissionMode>(config.defaultPermissionMode);
    const [launcherProviderId, setLauncherProviderId] = useState<string | undefined>();
    const [launcherSelectedModel, setLauncherSelectedModel] = useState<string | undefined>();

    // Runtime state — adapts model/permission selectors when workspace uses external runtime
    const multiAgentRuntimeEnabled = !!config.multiAgentRuntime;

    // PRD 0.2.7 D6 / Phase F: Launcher exposes Runtime selector in the row
    // below the input. We detect once on mount, mirroring Chat.tsx's pattern.
    const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>({
        builtin: { installed: true },
        'claude-code': { installed: false },
        codex: { installed: false },
        gemini: { installed: false },
    });
    useEffect(() => {
        if (!multiAgentRuntimeEnabled) return;
        let cancelled = false;
        import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke<Record<string, { installed: boolean; version?: string; path?: string }>>('cmd_detect_runtimes')
                .then(d => { if (!cancelled) setRuntimeDetections(d as RuntimeDetections); })
                .catch(() => { /* non-fatal */ });
        });
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled]);

    // MCP state
    const [launcherMcpServers, setLauncherMcpServers] = useState<McpServerDefinition[]>([]);
    const [launcherGlobalMcpEnabled, setLauncherGlobalMcpEnabled] = useState<string[]>([]);
    const [launcherWorkspaceMcpEnabled, setLauncherWorkspaceMcpEnabled] = useState<string[]>([]);

    // Resolve AgentConfig for selected workspace (source of truth for AI settings)
    const selectedAgent = useMemo(() => {
        if (!selectedWorkspace?.agentId) return undefined;
        return getAgentById(config, selectedWorkspace.agentId);
    }, [selectedWorkspace?.agentId, config]);

    // Ref for runtimeConfig — avoids stale closure in rapid write-back handlers
    const runtimeConfigRef = useRef(selectedAgent?.runtimeConfig);
    runtimeConfigRef.current = selectedAgent?.runtimeConfig;

    // Runtime-aware model/permission lists — adapts input bar for external runtimes
    const launcherRuntime: RuntimeType = multiAgentRuntimeEnabled
        ? ((selectedAgent?.runtime as RuntimeType) || 'builtin') : 'builtin';
    const isExternalRuntime = launcherRuntime !== 'builtin';

    // Codex + Gemini models are dynamic (fetched from the CLI); CC models are static
    const [codexModels, setCodexModels] = useState<RuntimeModelInfo[]>([]);
    const [geminiModels, setGeminiModels] = useState<RuntimeModelInfo[]>([]);
    useEffect(() => {
        if (!multiAgentRuntimeEnabled || launcherRuntime !== 'codex') { setCodexModels([]); return; }
        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=codex')
            .then(res => { if (!cancelled && res?.models?.length) setCodexModels(res.models); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled, launcherRuntime]);
    useEffect(() => {
        if (!multiAgentRuntimeEnabled || launcherRuntime !== 'gemini') { setGeminiModels([]); return; }
        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=gemini')
            .then(res => { if (!cancelled && res?.models?.length) setGeminiModels(res.models); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled, launcherRuntime]);

    const launcherRuntimeModels: RuntimeModelInfo[] | undefined = launcherRuntime === 'claude-code' ? CC_MODELS
        : launcherRuntime === 'codex' ? codexModels
        : launcherRuntime === 'gemini' ? geminiModels : undefined;
    const launcherRuntimePermissionModes: RuntimePermissionMode[] | undefined = launcherRuntime === 'claude-code'
        ? CC_PERMISSION_MODES
        : launcherRuntime === 'codex' ? CODEX_PERMISSION_MODES
        : launcherRuntime === 'gemini' ? GEMINI_PERMISSION_MODES : undefined;

    // Derive provider for launcher — only select providers with valid credentials
    const launcherProvider = useMemo(() => {
        const id = launcherProviderId ?? selectedAgent?.providerId ?? selectedWorkspace?.providerId ?? config.defaultProviderId;
        return resolveProvider(id, providers, apiKeys, providerVerifyStatus);
    }, [launcherProviderId, selectedAgent, selectedWorkspace, config.defaultProviderId, providers, apiKeys, providerVerifyStatus]);

    // Load MCP servers when workspace changes
    useEffect(() => {
        const load = async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
                setLauncherWorkspaceMcpEnabled(selectedAgent?.mcpEnabledServers ?? selectedWorkspace?.mcpEnabledServers ?? []);
            } catch (err) {
                console.warn('[Launcher] Failed to load MCP servers:', err);
            }
        };
        void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedWorkspace?.id]);

    // Refresh MCP local state when tab becomes active (inactive → active transition).
    // Config/projects/providers/apiKeys are shared via ConfigProvider and auto-sync.
    // MCP servers are local state, so we reload them from disk on tab activation.
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;

        void (async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
            } catch (err) {
                console.warn('[Launcher] Failed to reload MCP servers on activation:', err);
            }
        })();
    }, [isActive]);

    // Handle workspace MCP toggle — delegates to the shared dual-write helper
    // (PRD 0.2.7) so launcher and chat-tab persist identical fields.
    const handleWorkspaceMcpToggle = useCallback((serverId: string, enabled: boolean) => {
        setLauncherWorkspaceMcpEnabled(prev => {
            const newEnabled = enabled ? [...prev, serverId] : prev.filter(id => id !== serverId);
            if (selectedWorkspace) {
                void persistInputOptionChange({
                    workspaceId: selectedWorkspace.id,
                    agentId: selectedWorkspace.agentId ?? null,
                    isExternalRuntime,
                    currentRuntimeConfig: runtimeConfigRef.current,
                    fields: { mcpEnabledServers: newEnabled },
                    patchProject,
                    patchAgentConfig,
                    // Launcher has no Sidecar — sidecar push happens after handoff.
                });
            }
            return newEnabled;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes, not on every property change
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    // Restore launcherLastUsed settings once config finishes loading from disk.
    // useState initializers run before async config load completes (config = DEFAULT_CONFIG
    // at that point), so we must sync saved values via effect after isLoading becomes false.
    const lastUsedAppliedRef = useRef(false);
    useEffect(() => {
        if (isLoading || lastUsedAppliedRef.current) return;
        lastUsedAppliedRef.current = true;
        const lastUsed = config.launcherLastUsed;
        if (!lastUsed) return;
        if (lastUsed.permissionMode) setLauncherPermissionMode(lastUsed.permissionMode);
        if (lastUsed.providerId) setLauncherProviderId(lastUsed.providerId);
        if (lastUsed.model) setLauncherSelectedModel(lastUsed.model);
        if (lastUsed.mcpEnabledServers) setLauncherWorkspaceMcpEnabled(lastUsed.mcpEnabledServers);
    }, [isLoading, config.launcherLastUsed]);

    // Extract runtimeConfig primitives for stable useEffect deps (avoid object reference)
    const agentRuntimeModel = (selectedAgent?.runtimeConfig as { model?: string } | undefined)?.model;
    const agentRuntimePermMode = (selectedAgent?.runtimeConfig as { permissionMode?: string } | undefined)?.permissionMode;

    // Sync launcher settings from selected workspace's per-project config.
    // Declared AFTER launcherLastUsed effect so project settings take priority on initial load.
    // Priority: project setting > global default (launcherLastUsed is global, not per-workspace)
    // Depends on individual fields (not just .id) so it re-runs when Chat's patchProject updates them.
    useEffect(() => {
        if (isLoading || !selectedWorkspace) return;
        // For external runtimes, model and permission come from runtimeConfig.
        // Branch on isExternalRuntime alone — empty runtimeConfig is valid (uses runtime defaults).
        if (isExternalRuntime) {
            setLauncherSelectedModel(agentRuntimeModel ?? undefined);
            setLauncherPermissionMode((agentRuntimePermMode as PermissionMode | undefined) ?? config.defaultPermissionMode);
        } else {
            setLauncherPermissionMode((selectedAgent?.permissionMode as PermissionMode | undefined) ?? selectedWorkspace.permissionMode ?? config.defaultPermissionMode);
            setLauncherSelectedModel(selectedAgent?.model ?? selectedWorkspace.model ?? undefined);
        }
        setLauncherProviderId(selectedAgent?.providerId ?? selectedWorkspace.providerId ?? undefined);
        setLauncherWorkspaceMcpEnabled(selectedAgent?.mcpEnabledServers ?? selectedWorkspace.mcpEnabledServers ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on specific agent/project fields, not object ref
    }, [isLoading, selectedWorkspace?.id, selectedAgent?.permissionMode, selectedAgent?.model, selectedAgent?.providerId, selectedAgent?.mcpEnabledServers, selectedAgent?.runtime, agentRuntimeModel, agentRuntimePermMode, selectedWorkspace?.permissionMode, selectedWorkspace?.model, selectedWorkspace?.providerId, selectedWorkspace?.mcpEnabledServers, config.defaultPermissionMode, multiAgentRuntimeEnabled, isExternalRuntime]);

    // Write-back handlers: persist Launcher setting changes to the selected project

    const handleLauncherPermissionModeChange = useCallback((mode: PermissionMode) => {
        setLauncherPermissionMode(mode);
        if (selectedWorkspace) {
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                fields: { permissionMode: mode },
                patchProject,
                patchAgentConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    const handleLauncherModelChange = useCallback((model: string | undefined) => {
        setLauncherSelectedModel(model);
        if (selectedWorkspace) {
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                fields: isExternalRuntime
                    ? { runtimeModel: model ?? null }
                    : { builtinModel: model ?? null },
                patchProject,
                patchAgentConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    // PRD 0.2.7 D6: Runtime change in launcher persists to Agent.runtime so the
    // next Chat session boots in the chosen runtime. No live sidecar to fork —
    // the next handoff creates a fresh sidecar with the persisted runtime.
    const handleLauncherRuntimeChange = useCallback(async (runtime: RuntimeType) => {
        if (!selectedWorkspace?.agentId) {
            toastRef.current.warning('该工作区未配置 Agent，无法切换 Runtime');
            return;
        }
        try {
            await patchAgentConfig(selectedWorkspace.agentId, { runtime });
        } catch (err) {
            console.error('[Launcher] runtime change failed:', err);
            toastRef.current.error('切换 Runtime 失败，请重试');
        }
    }, [selectedWorkspace?.agentId]);

    const handleLauncherProviderChange = useCallback((providerId: string | undefined, targetModel?: string) => {
        setLauncherProviderId(providerId);
        const newProvider = providerId ? providers.find(p => p.id === providerId) : undefined;
        const model = targetModel ?? newProvider?.primaryModel;
        if (model) {
            setLauncherSelectedModel(model);
        }
        if (selectedWorkspace) {
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                fields: {
                    providerId: providerId ?? undefined,
                    builtinModel: model ?? undefined,
                },
                patchProject,
                patchAgentConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes
    }, [selectedWorkspace?.id, patchProject, providers, isExternalRuntime]);

    // Navigate to Settings > Providers page
    const handleGoToSettings = useCallback(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
            detail: { section: 'providers' },
        }));
    }, []);

    // Promote a project to the global default workspace. Same code path as
    // Settings → 通用设置 → 默认工作区 (`updateConfig({ defaultWorkspacePath })`)
    // — keeps the WorkspaceSelector dropdown in sync with the existing config
    // surface so a change made here shows up in Settings on next open and
    // vice versa. Failure is non-fatal — toast a warning but keep the dropdown
    // usable; the user can retry.
    const handleSetDefault = useCallback(async (project: Project) => {
        try {
            await updateConfig({ defaultWorkspacePath: project.path });
        } catch (err) {
            console.error('[Launcher] failed to set default workspace:', err);
            toastRef.current.warning('设为默认失败，请重试');
        }
    }, [updateConfig]);

    // Handle send from BrandSection — `cron` is the launcher-staged cron config
    // (PRD 0.2.7 D1); when present, Chat's autoSend dispatches startCronTask
    // instead of sendMessage.
    const handleBrandSend = useCallback(async (
        text: string,
        images?: ImageAttachment[],
        cron?: import('@/types/tab').InitialMessageCron,
    ) => {
        if (!selectedWorkspace) {
            toastRef.current.error('请先选择工作区');
            return;
        }

        // PRD 0.2.3 + cross-review: split provider/model by runtime dimension. For builtin,
        // pairBuiltinSelection enforces model ∈ provider.models — closing the
        // "stale agent.model paired with first-available fallback provider" hole when the
        // primary provider's key was deleted between agent setup and send.
        const builtinSelection = (!isExternalRuntime && launcherProvider)
            ? pairBuiltinSelection(launcherProvider, launcherSelectedModel)
            : undefined;
        const runtimeModel = isExternalRuntime ? launcherSelectedModel : undefined;
        const initialMessage: InitialMessage = {
            text,
            images,
            permissionMode: launcherPermissionMode,
            mcpEnabledServers: launcherWorkspaceMcpEnabled.filter(id => launcherGlobalMcpEnabled.includes(id)),
            ...(builtinSelection ? { builtinSelection } : {}),
            ...(runtimeModel ? { runtimeModel } : {}),
            ...(cron ? { cron } : {}),
        };

        // Persist launcher settings for next app launch
        updateConfig({
            launcherLastUsed: {
                providerId: launcherProvider?.id,
                model: launcherSelectedModel,
                permissionMode: launcherPermissionMode,
                mcpEnabledServers: launcherWorkspaceMcpEnabled,
            },
        }).catch(err => console.warn('[Launcher] Failed to save launcherLastUsed:', err));

        setLaunchingProjectId(selectedWorkspace.id);
        touchProject(selectedWorkspace.id).catch(() => {});

        // Bug 1 fix — "新开对话" launcher cron should NOT pop a chat tab.
        // The modal's promise to the user: "创建独立定时任务，不占用当前对话".
        // Chat.tsx already has the in-chat equivalent (line ~2056: when
        // `executionTarget === 'new_task'` it creates a standalone task and
        // toasts "定时任务已创建" instead of dispatching as a chat message).
        // Mirror that behavior here so the launcher path honors the same
        // user-visible promise.
        //
        // Path:
        //   1. createCronTask with a freshly-minted standalone session id
        //      (matches `cron-standalone-<uuid>` convention from Chat.tsx)
        //   2. startCronTask (status=running) + startCronScheduler
        //   3. toast + clear loading; stay on launcher
        // Failure → fall through to the regular tab-launch path so the user
        // doesn't lose their input — same recovery contract Chat.tsx
        // autoSend uses.
        if (cron && cron.executionTarget === 'new_task') {
            try {
                const standaloneSessionId = `cron-standalone-${crypto.randomUUID()}`;
                // PRD 0.2.9 — Collapsed-writer path. Send `providerId` only
                // and let the sidecar live-resolve the env (apiKey, baseUrl,
                // authType, modelAliases, ...) on every tick. This avoids
                // duplicating credentials into ~/.myagents/cron_tasks.json
                // and makes API key rotation propagate without user action.
                //
                // External runtimes don't carry a providerId (they manage
                // their own provider via their CLI). When the runtime is
                // external, providerId is undefined → sidecar follows the
                // agent's runtime resolution.
                const launcherProviderId =
                    !isExternalRuntime && launcherProvider
                        ? launcherProvider.id
                        : undefined;
                const created = await createCronTask({
                    workspacePath: selectedWorkspace.path,
                    sessionId: standaloneSessionId,
                    prompt: text,
                    intervalMinutes: cron.intervalMinutes,
                    endConditions: cron.endConditions,
                    runMode: 'new_session',
                    notifyEnabled: cron.notifyEnabled,
                    schedule: cron.schedule,
                    delivery: cron.delivery,
                    name: cron.name,
                    permissionMode: launcherPermissionMode,
                    model: builtinSelection?.model ?? runtimeModel,
                    providerId: launcherProviderId,
                    // PRD 0.2.9 — When `providerId` is set the sidecar ignores
                    // intent (live-resolve takes precedence). We still send
                    // `subscription` for the no-providerId subscription case
                    // so legacy /cron/execute paths handle it correctly until
                    // all callers move to providerId-only.
                    providerIntent: launcherProviderId ? undefined : 'subscription',
                    runtime: launcherRuntime,
                    runtimeConfig: isExternalRuntime ? runtimeConfigRef.current : undefined,
                    // Snapshot the launcher's MCP selection so the cron task's
                    // own override branch fires at execute-sync time. The
                    // perf shortcut in /cron/execute-sync (preferring
                    // currentMcpServers shape) only helps the in-Chat handoff
                    // path where /api/mcp/set has run; standalone-cron from
                    // launcher has no Tab pre-warm, so first fire still
                    // self-resolves. Field is still recorded for parity with
                    // the Chat.tsx new_task path (Chat.tsx:2033).
                    mcpEnabledServers: launcherWorkspaceMcpEnabled,
                });
                await startCronTask(created.id);
                await startCronScheduler(created.id);
                track('launcher_cron_create_standalone', {
                    interval_minutes: cron.intervalMinutes,
                    schedule_kind: cron.schedule.kind,
                });
                toastRef.current.success('独立定时任务已创建，可在任务中心查看');
                setLaunchingProjectId(null);
                return;
            } catch (err) {
                console.error('[Launcher] Failed to create standalone cron task:', err);
                toastRef.current.error(`创建定时任务失败：${err instanceof Error ? err.message : String(err)}`);
                setLaunchingProjectId(null);
                return;
            }
        }

        onLaunchProject(selectedWorkspace, undefined, initialMessage);
    }, [selectedWorkspace, launcherProvider, launcherPermissionMode,
        launcherSelectedModel, launcherWorkspaceMcpEnabled, launcherGlobalMcpEnabled,
        isExternalRuntime, launcherRuntime,
        touchProject, onLaunchProject, updateConfig]);

    // Path input dialog state (for browser dev mode)
    const [pathDialogOpen, setPathDialogOpen] = useState(false);
    const [pendingFolderName, setPendingFolderName] = useState('');
    const [pendingDefaultPath, setPendingDefaultPath] = useState('');

    const handleLaunch = useCallback((project: Project, sessionId?: string) => {
        setLaunchingProjectId(project.id);
        // Update lastOpened timestamp (async, don't block launch)
        touchProject(project.id).catch((err) => {
            console.warn('[Launcher] Failed to update lastOpened:', err);
        });
        onLaunchProject(project, sessionId);
    }, [touchProject, onLaunchProject]);

    const handleOpenTask = useCallback((session: SessionMetadata, project: Project) => {
        handleLaunch(project, session.id);
    }, [handleLaunch]);

    const [overlayMode, setOverlayMode] = useState<'default' | 'search'>('default');
    const handleOpenOverlay = useCallback((mode: 'default' | 'search' = 'default') => { track('task_center_open', {}); setOverlayMode(mode); setShowOverlay(true); }, []);
    const handleCloseOverlay = useCallback(() => { setShowOverlay(false); setOverlayMode('default'); }, []);

    // Stable callback for overlay session open (avoids inline function in render)
    const handleOverlayOpenTask = useCallback((session: SessionMetadata, project: Project) => {
        handleOpenTask(session, project);
        handleCloseOverlay();
    }, [handleOpenTask, handleCloseOverlay]);

    const handleAddProject = async () => {
        setAddError(null);
        console.log('[Launcher] handleAddProject called');

        try {
            if (isBrowserDevMode()) {
                const folderInfo = await pickFolderForDialog();
                if (folderInfo) {
                    setPendingFolderName(folderInfo.folderName);
                    setPendingDefaultPath(folderInfo.defaultPath);
                    setPathDialogOpen(true);
                } else {
                    console.log('[Launcher] Folder picker cancelled');
                }
            } else {
                const selected = await open({
                    directory: true,
                    multiple: false,
                    title: '选择项目文件夹',
                });
                console.log('[Launcher] Dialog result:', selected);

                if (selected && typeof selected === 'string') {
                    console.log('[Launcher] Adding project:', selected);
                    const project = await addProject(selected);
                    console.log('[Launcher] Project added:', project);
                } else {
                    console.log('[Launcher] No folder selected or dialog cancelled');
                }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathConfirm = async (path: string) => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path confirmed:', path);

        try {
            const project = await addProject(path);
            console.log('[Launcher] Project added:', project);
            // Normalize path separators for cross-platform support
            const normalizedPath = path.replace(/\\/g, '/');
            const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
            if (parentDir) {
                localStorage.setItem('myagents:lastProjectDir', parentDir);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathCancel = () => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path dialog cancelled');
    };

    const handleRemoveProject = (project: Project) => {
        setProjectToRemove(project);
    };

    const confirmRemoveProject = async () => {
        if (projectToRemove) {
            await removeProject(projectToRemove.id);
            setProjectToRemove(null);
        }
    };

    const handleCreateFromTemplate = useCallback(async (path: string, icon?: string, displayName?: string) => {
        const project = await addProject(path);
        track('workspace_create', { source: icon ? 'template' : 'blank' });
        const updates: { icon?: string; displayName?: string } = {};
        if (icon) updates.icon = icon;
        if (displayName) updates.displayName = displayName;
        if (Object.keys(updates).length > 0) {
            try {
                await patchProject(project.id, updates);
            } catch (err) {
                console.warn('[Launcher] Failed to patch template metadata, workspace created without icon/name:', err);
            }
        }
    }, [addProject, patchProject]);

    const handleEditProject = useCallback(async (projectId: string, updates: { displayName?: string; icon?: string }) => {
        await patchProject(projectId, updates);
    }, [patchProject]);

    const handleOpenTemplateDialog = useCallback(() => setShowTemplateDialog(true), []);
    const handleCloseTemplateDialog = useCallback(() => setShowTemplateDialog(false), []);
    const handleCloseEditDialog = useCallback(() => setEditingProject(null), []);

    // Agent overlay handlers
    const handleAgentSettings = useCallback((project: Project) => {
        setAgentOverlay({ workspacePath: project.path, initialTab: 'agent' });
    }, []);
    const handleCloseAgentOverlay = useCallback(() => setAgentOverlay(null), []);

    // SystemPromptsPanel "智能生成" → close the overlay and launch the workspace into
    // a Chat tab with `/init` as the initial message. Reuses the same Launcher-wide
    // provider/model/permission selection that the brand-section send uses.
    const handleRequestInitFromAgentOverlay = useCallback(() => {
        if (!agentOverlay) return;
        const project = projects.find(p => p.path === agentOverlay.workspacePath);
        if (!project) return;
        const effectiveProvider = launcherProvider ?? providers[0];
        if (!effectiveProvider) {
            toastRef.current.error('没有可用的 Provider，请先在设置中配置');
            return;
        }
        setAgentOverlay(null);
        // PRD 0.2.3 + cross-review: same builtin/external split as handleBrandSend.
        const builtinSelection = !isExternalRuntime
            ? pairBuiltinSelection(effectiveProvider, launcherSelectedModel)
            : undefined;
        const runtimeModel = isExternalRuntime ? launcherSelectedModel : undefined;
        const initialMessage: InitialMessage = {
            text: '/init',
            permissionMode: launcherPermissionMode,
            ...(builtinSelection ? { builtinSelection } : {}),
            ...(runtimeModel ? { runtimeModel } : {}),
        };
        onLaunchProject(project, undefined, initialMessage);
    }, [agentOverlay, projects, launcherProvider, providers, launcherPermissionMode, launcherSelectedModel, isExternalRuntime, onLaunchProject]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
            {/* Path Input Dialog (browser dev mode) */}
            <PathInputDialog
                isOpen={pathDialogOpen}
                folderName={pendingFolderName}
                defaultPath={pendingDefaultPath}
                onConfirm={handlePathConfirm}
                onCancel={handlePathCancel}
            />

            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={[]}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
            />

            {/* Remove Workspace Confirm Dialog */}
            {projectToRemove && (
                <ConfirmDialog
                    title="移除工作区"
                    message={`确定要从列表中移除「${projectToRemove.name}」吗？此操作不会删除项目文件。`}
                    confirmText="移除"
                    cancelText="取消"
                    confirmVariant="danger"
                    onConfirm={confirmRemoveProject}
                    onCancel={() => setProjectToRemove(null)}
                />
            )}

            {/* Main Content: Two-column layout */}
            <main className="launcher-layout flex-1 overflow-hidden">
                {/* Left: Brand Section */}
                <section className="launcher-brand relative flex items-center justify-center overflow-hidden">
                    <BrandSection
                        projects={visibleProjects}
                        selectedProject={selectedWorkspace}
                        defaultWorkspacePath={config.defaultWorkspacePath}
                        onSelectWorkspace={setSelectedWorkspace}
                        onAddFolder={handleAddProject}
                        onSetDefaultWorkspace={handleSetDefault}
                        onSend={handleBrandSend}
                        isStarting={launchingProjectId === selectedWorkspace?.id && isStarting}
                        provider={launcherProvider}
                        providers={providers}
                        selectedModel={launcherSelectedModel}
                        onProviderChange={handleLauncherProviderChange}
                        onModelChange={handleLauncherModelChange}
                        permissionMode={launcherPermissionMode}
                        onPermissionModeChange={handleLauncherPermissionModeChange}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={launcherWorkspaceMcpEnabled}
                        globalMcpEnabled={launcherGlobalMcpEnabled}
                        mcpServers={launcherMcpServers}
                        onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
                        onRefreshProviders={refreshProviderData}
                        onGoToSettings={handleGoToSettings}
                        runtime={isExternalRuntime ? launcherRuntime : undefined}
                        runtimeModels={isExternalRuntime ? launcherRuntimeModels : undefined}
                        runtimePermissionModes={isExternalRuntime ? launcherRuntimePermissionModes : undefined}
                        /* PRD 0.2.7 Phase F: runtime selector lives below the input
                         * (LauncherInputContextRow) when the experimental gate is on. */
                        multiAgentRuntimeEnabled={multiAgentRuntimeEnabled}
                        runtimeDetections={runtimeDetections}
                        onRuntimeChange={handleLauncherRuntimeChange}
                        activeRuntime={launcherRuntime}
                    />
                </section>

                {/* Right: Workspaces Section */}
                <section className="launcher-workspaces flex flex-col overflow-hidden">
                    {/* Recent Tasks */}
                    <div className="flex-shrink-0 px-6 pt-6">
                        <RecentTasks
                            projects={visibleProjects}
                            onOpenTask={handleOpenTask}
                            onOpenOverlay={handleOpenOverlay}
                            taskCenterData={taskCenterData}
                        />
                    </div>

                    {/* Workspaces Header */}
                    <div className="mx-6 border-t border-[var(--line)]" />
                    <div className="flex flex-shrink-0 items-center justify-between px-6 py-4">
                        <h2 className="text-[13px] font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
                            Agent 工作区
                        </h2>
                        <div className="flex items-center gap-3">
                            {config.showDevTools && (
                                <button
                                    onClick={() => setShowLogs(true)}
                                    className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                    title="查看 Rust 日志"
                                >
                                    Logs
                                </button>
                            )}
                            {visibleProjects.length > 0 && (
                                <AddWorkspaceMenu
                                    onAddFolder={handleAddProject}
                                    onCreateFromTemplate={handleOpenTemplateDialog}
                                />
                            )}
                        </div>
                    </div>

                    {/* Workspaces List */}
                    <div className="flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
                        {isLoading ? (
                            <div className="flex flex-col items-center justify-center py-16">
                                <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]/50" />
                                <p className="mt-4 text-[13px] text-[var(--ink-muted)]/70">加载中...</p>
                            </div>
                        ) : visibleProjects.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <h3 className="mb-1.5 text-[14px] font-medium text-[var(--ink)]">
                                    还没有工作区
                                </h3>
                                <p className="mb-6 max-w-[220px] text-[13px] leading-relaxed text-[var(--ink-muted)]/60">
                                    添加本地项目文件夹，或从模板快速创建
                                </p>
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={handleAddProject}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-secondary-bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--button-secondary-text)] transition-all hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-sm"
                                    >
                                        <FolderPlus className="h-3.5 w-3.5" />
                                        添加文件夹
                                    </button>
                                    <button
                                        onClick={handleOpenTemplateDialog}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-all hover:bg-[var(--button-primary-bg-hover)] hover:shadow-sm"
                                    >
                                        <LayoutTemplate className="h-3.5 w-3.5" />
                                        从模板创建
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                {visibleProjects.map((project) => {
                                    const agentData = agentLookup.get(project.path.replace(/\\/g, '/'));
                                    return (
                                        <WorkspaceCard
                                            key={project.id}
                                            project={project}
                                            agent={agentData?.agent}
                                            agentStatus={agentData?.status}
                                            onLaunch={handleLaunch}
                                            onRemove={handleRemoveProject}
                                            onAgentSettings={handleAgentSettings}
                                            isLoading={launchingProjectId === project.id && isStarting}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>
            </main>

            {/* Task Center Overlay */}
            {showOverlay && (
                <TaskCenterOverlay
                    projects={visibleProjects}
                    onOpenTask={handleOverlayOpenTask}
                    onClose={handleCloseOverlay}
                    taskCenterData={taskCenterData}
                    initialMode={overlayMode}
                />
            )}

            {/* Template Library Dialog */}
            {showTemplateDialog && (
                <TemplateLibraryDialog
                    onCreateWorkspace={handleCreateFromTemplate}
                    onClose={handleCloseTemplateDialog}
                />
            )}

            {/* Workspace Edit Dialog */}
            {editingProject && (
                <WorkspaceEditDialog
                    key={editingProject.id}
                    project={editingProject}
                    onSave={handleEditProject}
                    onClose={handleCloseEditDialog}
                />
            )}

            {/* Agent Config Overlay */}
            {agentOverlay && (
                <WorkspaceConfigPanel
                    agentDir={agentOverlay.workspacePath}
                    onClose={handleCloseAgentOverlay}
                    initialTab={agentOverlay.initialTab}
                    onRequestInit={handleRequestInitFromAgentOverlay}
                />
            )}
        </div>
    );
}
