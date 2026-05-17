/**
 * GlobalPluginsPanel — Settings page section for Claude Plugin management.
 *
 * PRD 0.2.17. Responsibilities:
 *   - List installed plugins with enabled/disabled toggle
 *   - Install from URL / GitHub shorthand / file:// local path
 *   - View per-plugin detail (manifest + component inventory)
 *   - Uninstall (with confirmation)
 *
 * Refresh strategy:
 *   - Settings is rendered OUTSIDE TabProvider (App.tsx routes settings
 *     before TabProvider mounts), so the per-Tab SSE bridge cannot deliver
 *     events here. Every user action therefore calls loadList() directly
 *     to refresh state — correct under all conditions including zero Chat
 *     tabs open and CLI-driven changes (handled by manual refresh).
 *   - The `myagents:plugins-changed` CustomEvent is still subscribed as a
 *     best-effort signal: if a Chat tab IS open and bridges the SSE event,
 *     we pick up that signal too. Belt and suspenders.
 *
 * Network calls go through the global API helpers (apiGetJson / apiPostJson),
 * not the Tab-scoped ones — plugin config is global, not per-Tab.
 */

import {
  Plus,
  Loader2,
  AlertTriangle,
  Trash2,
  FolderOpen,
  ChevronLeft,
  Puzzle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type {
  PluginListItem,
  PluginInstallProgressEvent,
  PluginComponentInventory,
  PluginManifest,
} from '../../shared/types/plugin';

type ViewState =
  | { type: 'list' }
  | { type: 'detail'; id: string };

interface ListResponse {
  success: boolean;
  plugins?: PluginListItem[];
  error?: string;
}

interface DetailResponse {
  success: boolean;
  plugin?: PluginListItem;
  error?: string;
}

interface InstallResponse {
  success: boolean;
  entry?: PluginListItem;
  installId?: string;
  error?: string;
}

interface ActionResponse {
  success: boolean;
  error?: string;
}

export default function GlobalPluginsPanel({
  onDetailChange,
}: {
  onDetailChange?: (inDetail: boolean) => void;
}) {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [viewState, setViewState] = useState<ViewState>({ type: 'list' });
  const onDetailChangeRef = useRef(onDetailChange);
  useEffect(() => { onDetailChangeRef.current = onDetailChange; }, [onDetailChange]);
  useEffect(() => {
    onDetailChangeRef.current?.(viewState.type !== 'list');
  }, [viewState.type]);

  const [loading, setLoading] = useState(true);
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [detail, setDetail] = useState<PluginListItem | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ----- list load --------------------------------------------------------
  const loadList = useCallback(async () => {
    try {
      const resp = await apiGetJson<ListResponse>('/api/cc-plugin/list');
      if (!isMountedRef.current) return;
      if (resp.success && Array.isArray(resp.plugins)) {
        setPlugins(resp.plugins);
      } else if (!resp.success) {
        toastRef.current.error(resp.error || '加载插件列表失败');
      }
    } catch (err) {
      console.error('[GlobalPluginsPanel] loadList failed:', err);
      if (isMountedRef.current) toastRef.current.error('加载插件列表失败');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Refresh on plugins:changed
  useEffect(() => {
    const onChanged = () => { loadList(); };
    window.addEventListener('myagents:plugins-changed', onChanged);
    return () => window.removeEventListener('myagents:plugins-changed', onChanged);
  }, [loadList]);

  // ----- detail load -------------------------------------------------------
  useEffect(() => {
    if (viewState.type !== 'detail') {
      setDetail(null);
      return;
    }
    const id = viewState.id;
    (async () => {
      try {
        const resp = await apiGetJson<DetailResponse>(
          `/api/cc-plugin/detail?id=${encodeURIComponent(id)}`,
        );
        if (!isMountedRef.current) return;
        if (resp.success && resp.plugin) {
          setDetail(resp.plugin);
        } else {
          toastRef.current.error(resp.error || '加载插件详情失败');
          setViewState({ type: 'list' });
        }
      } catch (err) {
        console.error('[GlobalPluginsPanel] loadDetail failed:', err);
        if (isMountedRef.current) toastRef.current.error('加载插件详情失败');
      }
    })();
  }, [viewState]);

  // ----- actions -----------------------------------------------------------
  const toggleEnabled = useCallback(async (item: PluginListItem) => {
    // Optimistic update so the switch responds immediately.
    setPlugins(prev =>
      prev.map(p => (p.id === item.id ? { ...p, enabled: !item.enabled } : p)),
    );
    try {
      const resp = await apiPostJson<ActionResponse>('/api/cc-plugin/toggle', {
        id: item.id,
        enabled: !item.enabled,
      });
      if (!resp.success) {
        toastRef.current.error(resp.error || '切换失败');
        loadList(); // resync — optimistic state was wrong
        return;
      }
      toastRef.current.success(
        item.enabled
          ? `已隐藏 ${item.name}（各工作区不再可选）`
          : `已显示 ${item.name}（可在 Agent / Chat 工具菜单里勾选启用）`,
      );
    } catch (err) {
      console.error('[GlobalPluginsPanel] toggle failed:', err);
      toastRef.current.error('切换失败');
      loadList();
    }
  }, [loadList]);

  const [confirmRemove, setConfirmRemove] = useState<PluginListItem | null>(null);
  const handleUninstall = useCallback(async () => {
    if (!confirmRemove) return;
    const item = confirmRemove;
    setConfirmRemove(null);
    try {
      const resp = await apiPostJson<ActionResponse & { removed?: PluginListItem; warning?: string }>(
        '/api/cc-plugin/uninstall',
        { id: item.id },
      );
      if (!resp.success) {
        toastRef.current.error(resp.error || '卸载失败');
        return;
      }
      if (resp.warning) {
        // Surface cleanup-failure warnings to the user (Fix #14: previously
        // swallowed → permanent TARGET_EXISTS on next install). Toast type
        // 'warning' isn't in the current Toast surface; use success+message.
        toastRef.current.success(`已卸载 ${item.name}（⚠ ${resp.warning}）`);
      } else {
        toastRef.current.success(`已卸载 ${item.name}`);
      }
      if (viewState.type === 'detail' && viewState.id === item.id) {
        setViewState({ type: 'list' });
      }
      // Settings is outside TabProvider — SSE bridge can't reach us.
      // Refresh directly so the uninstalled plugin disappears from the list.
      loadList();
    } catch (err) {
      console.error('[GlobalPluginsPanel] uninstall failed:', err);
      toastRef.current.error('卸载失败');
    }
  }, [confirmRemove, viewState, loadList]);

  // ----- install dialog ----------------------------------------------------
  const [showInstall, setShowInstall] = useState(false);

  // ----- render ------------------------------------------------------------
  if (viewState.type === 'detail' && detail) {
    return (
      <PluginDetailView
        plugin={detail}
        onBack={() => setViewState({ type: 'list' })}
        onToggle={() => toggleEnabled(detail)}
        onUninstall={() => setConfirmRemove(detail)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header — Skills-page parity: icon + title + count chip on left, "+ 安装" on right.
       *  Explanatory blurb sits under header as a secondary line; the two ⓘ hints fold
       *  into a single info row so the page weight matches SkillsCommandsList §300-313. */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-[var(--accent-warm)]" />
          <h3 className="text-base font-semibold text-[var(--ink)]">插件 Plugins</h3>
          <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
            {plugins.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowInstall(true)}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        >
          <Plus className="h-4 w-4" />
          安装插件
        </button>
      </div>

      <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
        MyAgents 支持 Claude Plugins 插件协议，每个插件内可能包含 skills + sub agents + hooks + MCP。
        右侧「安装插件」按钮，支持通过 Github 链接或本地文件夹来安装插件。
        插件开关决定插件「<b className="text-[var(--ink-secondary)]">在各工作区是否可见</b>」；如果要实际启用，请去 Agent 设置或 Chat 输入框 ➜ 工具菜单里勾选启用。
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-[var(--ink-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="ml-2 text-sm">加载中…</span>
        </div>
      ) : plugins.length === 0 ? (
        <div className="rounded-xl bg-[var(--paper-elevated)] py-16 text-center">
          <Puzzle className="mx-auto h-10 w-10 text-[var(--ink-subtle)]" />
          <p className="mt-3 text-[14px] font-medium text-[var(--ink)]">还没有插件</p>
          <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
            点右上角「安装插件」从 GitHub 或本地路径添加。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {plugins.map(item => (
            <PluginCard
              key={item.id}
              item={item}
              onOpen={() => setViewState({ type: 'detail', id: item.id })}
              onToggle={() => toggleEnabled(item)}
            />
          ))}
        </div>
      )}

      {showInstall && (
        <PluginInstallDialog
          onClose={() => setShowInstall(false)}
          onInstalled={() => {
            setShowInstall(false);
            // Settings is outside TabProvider — SSE bridge can't reach us.
            // Refresh directly so the new plugin shows up immediately.
            loadList();
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={`卸载 ${confirmRemove.name}?`}
          message="将删除插件目录并从启用列表移除。数据目录（${CLAUDE_PLUGIN_DATA}）默认保留。"
          confirmText="卸载"
          confirmVariant="danger"
          onConfirm={handleUninstall}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Plugin Card
// ============================================================================

function PluginCard({
  item,
  onOpen,
  onToggle,
}: {
  item: PluginListItem;
  onOpen: () => void;
  onToggle: () => void;
}) {
  // Card spec mirrors SkillCard (SkillsCommandsList.tsx:487-540) exactly so
  // Plugins / Skills / Agents share the same compact card identity in the
  // Settings page. Only deviation: decorative icon is Puzzle (vs Sparkles)
  // and there's a version chip slot alongside the author chip.
  const isBad = item.status !== 'ok';
  const isHidden = !item.enabled && !isBad;
  return (
    <div
      className={`group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 transition-shadow hover:shadow-sm ${
        isHidden ? 'opacity-55' : ''
      } ${isBad ? 'ring-1 ring-amber-400/40' : ''}`}
      onClick={onOpen}
    >
      <div className="flex items-center gap-2">
        {isBad && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
        <h4 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--ink)]">
          {item.name}
        </h4>
        <Puzzle className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
        {item.version && (
          <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[10px] font-medium tracking-[0.04em] text-[var(--ink-muted)]">
            v{item.version}
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={item.enabled}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          disabled={isBad}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            item.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
          } ${isBad ? 'cursor-not-allowed opacity-50' : ''}`}
          title={item.enabled ? '隐藏（不在工作区里出现）' : '显示（可被工作区选择）'}
        >
          <span
            className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${
              item.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      {/* Description — min-h reserves 2-line height like SkillCard so grid rows align. */}
      <p className="line-clamp-2 min-h-[2.6em] text-[13px] leading-relaxed text-[var(--ink-muted)]">
        {item.description || '暂无描述'}
      </p>
      {item.warning && (
        <p className="text-[12px] text-amber-600 dark:text-amber-500">
          ⚠ {item.warning}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Detail View
// ============================================================================

function PluginDetailView({
  plugin,
  onBack,
  onToggle,
  onUninstall,
}: {
  plugin: PluginListItem;
  onBack: () => void;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const components = plugin.components;
  const openInFinder = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // `fullPath` (camelCase) + nullable `workspace` per
      // src-tauri/src/workspace_files/system_open.rs::cmd_open_path_external.
      // Previously passed `{ path }` which silently no-op'd (Rust never
      // saw the param). See useWorkspaceFileService.ts:497 for the
      // canonical call shape.
      await invoke('cmd_open_path_external', {
        fullPath: plugin.installPath,
        workspace: null,
      });
    } catch (err) {
      console.warn('[GlobalPluginsPanel] open in finder failed:', err);
    }
  }, [plugin.installPath]);

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
      >
        <ChevronLeft className="h-4 w-4" />
        返回列表
      </button>

      {/* Title block — matches Skills detail header weight */}
      <div>
        <div className="flex items-baseline gap-3">
          <h2 className="text-[22px] font-semibold text-[var(--ink)]">{plugin.name}</h2>
          {plugin.version && (
            <span className="text-[14px] text-[var(--ink-muted)]">v{plugin.version}</span>
          )}
        </div>
        {plugin.description && (
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-secondary)]">
            {plugin.description}
          </p>
        )}
      </div>

      {/* Action buttons — DESIGN.md §6.1: pill-shaped (rounded-full) using
       *  button tokens. Toggle uses secondary, open-dir is ghost, uninstall
       *  uses danger semantic (var(--error)) per §6.1 危险按钮 spec. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onToggle}
          disabled={plugin.status !== 'ok'}
          className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
        >
          {plugin.enabled ? '隐藏（不再各工作区可见）' : '显示（可被工作区选择）'}
        </button>
        <button
          type="button"
          onClick={openInFinder}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          打开目录
        </button>
        <button
          type="button"
          onClick={onUninstall}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--error-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--error)] transition-colors hover:brightness-95"
        >
          <Trash2 className="h-3.5 w-3.5" />
          卸载
        </button>
      </div>

      {/* Metadata card — bordered "主卡片" (DESIGN.md §6.2): paper-elevated
       *  + 1px line border + p-5. Compact (no-border) cards are reserved
       *  for clickable list items; static content blocks like these need
       *  the border to visually contain themselves. */}
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          元数据
        </h3>
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-[13px]">
            <MetaRow label="作者" value={plugin.author} />
            <MetaRow label="License" value={plugin.license} />
            <MetaRow label="主页" value={plugin.homepage} link />
            <MetaRow label="仓库" value={plugin.repository} link />
            <MetaRow label="来源" value={plugin.sourceUrl} />
            <MetaRow label="安装路径" value={plugin.installPath} mono />
            <MetaRow label="安装时间" value={new Date(plugin.installedAt).toLocaleString()} />
          </dl>
        </div>
      </section>

      {components && (
        <section>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
            组件清单
          </h3>
          <ComponentInventoryGrid inv={components} />
        </section>
      )}
    </div>
  );
}

/** http(s)-only allow-list mirroring server-side `isSafeWebUrl`. Defense in
 *  depth — server already drops dangerous schemes from the manifest, but
 *  legacy AppConfig entries written before this fix could still contain
 *  attacker-controlled values. */
function isSafeWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function MetaRow({
  label,
  value,
  link,
  mono,
}: {
  label: string;
  value?: string;
  link?: boolean;
  mono?: boolean;
}) {
  if (!value) return null;
  const renderAsLink = link && isSafeWebUrl(value);
  return (
    <>
      <dt className="text-[var(--ink-muted)]">{label}</dt>
      <dd className={`break-all text-[var(--ink)] ${mono ? 'font-mono text-[12px]' : ''}`}>
        {renderAsLink ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent-warm)] hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </>
  );
}

function ComponentInventoryGrid({ inv }: { inv: PluginComponentInventory }) {
  const blocks: Array<[string, string[] | number | boolean]> = [
    ['Skills', inv.skills],
    ['Commands', inv.commands],
    ['Agents', inv.agents],
    ['MCP servers', inv.mcpServers],
    ['LSP servers', inv.lspServers],
    ['Monitors', inv.monitors],
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {blocks.map(([label, value]) => (
        <ComponentBlock key={label} label={label} value={value} />
      ))}
      <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-muted)]">Hooks</div>
        <div className="mt-1.5 text-[14px] text-[var(--ink)]">
          {inv.hooks > 0 ? `${inv.hooks} 个事件处理器` : <span className="text-[var(--ink-muted)]">— 无</span>}
        </div>
      </div>
      <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-muted)]">Bin</div>
        <div className="mt-1.5 text-[14px] text-[var(--ink)]">
          {inv.hasBin ? '✓ 有可执行文件' : <span className="text-[var(--ink-muted)]">— 无</span>}
        </div>
      </div>
    </div>
  );
}

function ComponentBlock({
  label,
  value,
}: {
  label: string;
  value: string[] | number | boolean;
}) {
  const items = Array.isArray(value) ? value : [];
  const count = items.length;
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--ink-muted)]">{label}</div>
      <div className="mt-1.5 text-[14px] text-[var(--ink)]">
        {count === 0 ? <span className="text-[var(--ink-muted)]">— 无</span> : `${count} 个`}
      </div>
      {count > 0 && (
        <div className="mt-1 line-clamp-2 text-[12px] text-[var(--ink-muted)]">
          {items.join(', ')}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Install Dialog — three views (input → optional picker → installing)
// ============================================================================

type InstallPhase = PluginInstallProgressEvent['phase'];

interface PluginCandidate {
  rootPath: string;
  manifest?: PluginManifest;
  manifestError?: string;
}

/** Server-side analysis shape returned by /api/cc-plugin/inspect. Kept in
 *  sync with installer.PluginAnalysis (backend). Carrying it in renderer
 *  lets us switch UI mode in a single round-trip. */
type InspectAnalysis =
  | { mode: 'plugin'; manifest: PluginManifest; rootPath: string }
  | { mode: 'marketplace'; marketplaceName?: string; pluginNames: string[] }
  | { mode: 'multi-plugin'; candidates: PluginCandidate[] }
  | { mode: 'no-plugin' };

interface InspectResponse {
  success: boolean;
  sourceUrl?: string;
  analysis?: InspectAnalysis;
  error?: string;
}

interface BatchResult {
  rootPath: string;
  name: string;
  ok: boolean;
  error?: string;
}

type DialogView =
  | { kind: 'input' }
  | {
      kind: 'selecting';
      sourceUrl: string;
      candidates: PluginCandidate[];
      selected: Set<string>;
    }
  | {
      kind: 'installing';
      sourceUrl: string;
      queue: PluginCandidate[];
      cursor: number;
      currentName: string;
      results: BatchResult[];
    };

function PluginInstallDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [view, setView] = useState<DialogView>({ kind: 'input' });
  const [sourceUrl, setSourceUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const installIdRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<InstallPhase | null>(null);
  const [phaseMsg, setPhaseMsg] = useState('');

  const isInstalling = view.kind === 'installing';
  // Cmd+W close — suppressed while inspecting OR mid-batch so the user
  // can't accidentally background work. z-index 300 matches the createPortal
  // modal tier (z global because we portal to document.body).
  useCloseLayer(() => {
    if (submitting || isInstalling) return false;
    onClose();
    return true;
  }, 300);

  // SSE progress for single-plugin path (multi-plugin batch shows aggregate progress)
  useEffect(() => {
    const onProgress = (evt: Event) => {
      const detail = (evt as CustomEvent<PluginInstallProgressEvent>).detail;
      if (!detail || !installIdRef.current || detail.installId !== installIdRef.current) {
        return;
      }
      setPhase(detail.phase);
      setPhaseMsg(detail.message || detail.error || '');
    };
    window.addEventListener('myagents:plugin-install-progress', onProgress);
    return () => window.removeEventListener('myagents:plugin-install-progress', onProgress);
  }, []);

  // ───── Step 1: inspect ──────────────────────────────────────────────────
  // User submits URL → backend resolves+fetches+analyses without writing.
  // Branch on returned analysis:
  //   single plugin    → directly install (familiar flow)
  //   multi-plugin     → switch to picker view (default all selected)
  //   marketplace      → not supported in v0.2.17 (留 v0.2.18)
  //   no-plugin        → friendly error
  const handleSubmit = useCallback(async () => {
    const url = sourceUrl.trim();
    if (!url) {
      toastRef.current.error('请填写来源地址');
      return;
    }
    setSubmitting(true);
    setPhase(null);
    try {
      const resp = await apiPostJson<InspectResponse>('/api/cc-plugin/inspect', {
        sourceUrl: url,
      });
      if (!resp.success || !resp.analysis) {
        toastRef.current.error(resp.error || '探测失败');
        setSubmitting(false);
        return;
      }
      const a = resp.analysis;
      if (a.mode === 'plugin') {
        // Single plugin — install directly (preserves the simple happy path).
        await installSingle(url);
        return;
      }
      if (a.mode === 'multi-plugin') {
        setSubmitting(false);
        setView({
          kind: 'selecting',
          sourceUrl: url,
          candidates: a.candidates,
          // Default all selected — matches "marketplace style" intent.
          // Candidates with manifestError are auto-excluded so the user
          // doesn't blow up the batch with known-bad entries.
          selected: new Set(
            a.candidates.filter(c => c.manifest && !c.manifestError).map(c => c.rootPath),
          ),
        });
        return;
      }
      if (a.mode === 'marketplace') {
        toastRef.current.error('Marketplace 仓库（.claude-plugin/marketplace.json）暂未支持，v0.2.18 加');
        setSubmitting(false);
        return;
      }
      // no-plugin
      toastRef.current.error('未在该来源找到任何 Claude 插件');
      setSubmitting(false);
    } catch (err) {
      console.error('[PluginInstallDialog] inspect failed:', err);
      toastRef.current.error(err instanceof Error ? err.message : '探测失败');
      setSubmitting(false);
    }
  // installSingle is stable (defined below with same useCallback deps)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  // ───── Single-plugin install (direct from input view) ───────────────────
  const installSingle = useCallback(async (url: string) => {
    setPhase('fetching');
    const installId = crypto.randomUUID();
    installIdRef.current = installId;
    try {
      const resp = await apiPostJson<InstallResponse>('/api/cc-plugin/install', {
        sourceUrl: url,
        installId,
      });
      if (!resp.success) {
        toastRef.current.error(resp.error || '安装失败');
        setSubmitting(false);
        setPhase('failed');
        return;
      }
      toastRef.current.success(`已安装 ${resp.entry?.name ?? ''}`);
      onInstalled();
    } catch (err) {
      console.error('[PluginInstallDialog] install failed:', err);
      toastRef.current.error(err instanceof Error ? err.message : '安装失败');
      setSubmitting(false);
      setPhase('failed');
    }
  }, [onInstalled]);

  // ───── Step 2: batch install of selected candidates ─────────────────────
  // Sequential (not parallel) — concurrent same-host installs would burn
  // GitHub rate limits and the disk write race protection in installPlugin
  // assumes serial calls per name. Each candidate gets a fresh /install
  // with a distinct subPath so it lands at ~/.myagents/plugins/<name>/.
  const startBatch = useCallback(async (chosen: PluginCandidate[]) => {
    if (chosen.length === 0) {
      toastRef.current.error('请至少选择一个插件');
      return;
    }
    const url = view.kind === 'selecting' ? view.sourceUrl : '';
    setView({
      kind: 'installing',
      sourceUrl: url,
      queue: chosen,
      cursor: 0,
      currentName: chosen[0]?.manifest?.name ?? chosen[0]?.rootPath ?? '',
      results: [],
    });

    const results: BatchResult[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const cand = chosen[i];
      const name = cand.manifest?.name ?? cand.rootPath;
      setView(prev => prev.kind === 'installing'
        ? { ...prev, cursor: i, currentName: name, results: [...results] }
        : prev);
      try {
        const resp = await apiPostJson<InstallResponse>('/api/cc-plugin/install', {
          sourceUrl: url,
          subPath: cand.rootPath,
          installId: crypto.randomUUID(),
        });
        results.push({
          rootPath: cand.rootPath,
          name,
          ok: !!resp.success,
          error: resp.success ? undefined : resp.error,
        });
      } catch (err) {
        results.push({
          rootPath: cand.rootPath,
          name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Final summary toast — keep dialog open so user can review per-item
    // status before closing (especially if some failed).
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    setView(prev => prev.kind === 'installing'
      ? { ...prev, cursor: prev.queue.length, currentName: '', results }
      : prev);
    if (failed === 0) {
      toastRef.current.success(`已安装 ${ok} 个插件`);
    } else {
      toastRef.current.error(`安装完成：${ok} 个成功，${failed} 个失败`);
    }
    onInstalled();
  }, [view, onInstalled]);

  // ───── Render ──────────────────────────────────────────────────────────
  return createPortal(
    <OverlayBackdrop
      onClose={submitting || isInstalling ? undefined : onClose}
      className="z-[300] px-4"
    >
      <div className="glass-panel w-full max-w-2xl">
        {view.kind === 'input' && (
          <InputView
            sourceUrl={sourceUrl}
            setSourceUrl={setSourceUrl}
            submitting={submitting}
            phase={phase}
            phaseMsg={phaseMsg}
            onClose={onClose}
            onSubmit={handleSubmit}
          />
        )}
        {view.kind === 'selecting' && (
          <SelectingView
            sourceUrl={view.sourceUrl}
            candidates={view.candidates}
            selected={view.selected}
            onToggle={(rootPath) => {
              const next = new Set(view.selected);
              if (next.has(rootPath)) next.delete(rootPath);
              else next.add(rootPath);
              setView({ ...view, selected: next });
            }}
            onSelectAll={() => {
              const all = new Set(
                view.candidates.filter(c => c.manifest && !c.manifestError).map(c => c.rootPath),
              );
              setView({ ...view, selected: all });
            }}
            onSelectNone={() => setView({ ...view, selected: new Set() })}
            onBack={() => setView({ kind: 'input' })}
            onConfirm={() => {
              const chosen = view.candidates.filter(c => view.selected.has(c.rootPath));
              void startBatch(chosen);
            }}
          />
        )}
        {view.kind === 'installing' && (
          <InstallingView
            queue={view.queue}
            cursor={view.cursor}
            currentName={view.currentName}
            results={view.results}
            // Final state: cursor === queue.length means all done.
            done={view.cursor >= view.queue.length}
            onClose={onClose}
          />
        )}
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}

// ─── input view ──────────────────────────────────────────────────────────
function InputView({
  sourceUrl,
  setSourceUrl,
  submitting,
  phase,
  phaseMsg,
  onClose,
  onSubmit,
}: {
  sourceUrl: string;
  setSourceUrl: (v: string) => void;
  submitting: boolean;
  phase: InstallPhase | null;
  phaseMsg: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <div className="border-b border-[var(--line)] px-5 py-4">
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">安装插件</h2>
        <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
          支持：GitHub 仓库（<code className="text-[11px]">owner/repo</code>、<code className="text-[11px]">github.com/...</code> 或完整 URL）、直链 <code className="text-[11px]">.zip</code>、本地文件夹绝对路径（如 <code className="text-[11px]">/Users/me/dev/plugin</code> 或 <code className="text-[11px]">C:\dev\plugin</code>）
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        <label className="block">
          <span className="text-[12px] text-[var(--ink-muted)]">来源地址</span>
          <input
            type="text"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            disabled={submitting}
            placeholder="anthropics/example-plugin · github.com/... · /Users/me/plugin · C:\dev\plugin"
            className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[13px] text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 disabled:opacity-60"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting && sourceUrl.trim()) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        </label>

        <div className="rounded-lg border border-[var(--warning,#d97706)]/40 bg-[var(--warning,#d97706)]/10 px-3 py-2 text-[11px] text-[var(--warning,#d97706)]">
          <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom" />
          插件以你的用户权限运行任意代码 / 启动 MCP 进程 / 触发 hook 脚本。仅安装可信来源。
        </div>

        {phase && (
          <div className="rounded-lg border border-[var(--line)] px-3 py-2 text-[12px]">
            <div className="flex items-center gap-2">
              {phase !== 'done' && phase !== 'failed' && <Loader2 className="h-3 w-3 animate-spin" />}
              <span className="font-medium text-[var(--ink)]">{phaseLabel(phase)}</span>
            </div>
            {phaseMsg && <div className="mt-1 break-all text-[var(--ink-muted)]">{phaseMsg}</div>}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[12px] font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !sourceUrl.trim()}
          className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
        >
          {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
          开始安装
        </button>
      </div>
    </>
  );
}

// ─── selecting view ──────────────────────────────────────────────────────
function SelectingView({
  sourceUrl,
  candidates,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  onBack,
  onConfirm,
}: {
  sourceUrl: string;
  candidates: PluginCandidate[];
  selected: Set<string>;
  onToggle: (rootPath: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const installable = candidates.filter(c => c.manifest && !c.manifestError);
  const badCount = candidates.length - installable.length;
  return (
    <>
      <div className="border-b border-[var(--line)] px-5 py-4">
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">选择要安装的插件</h2>
        <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
          来源：<span className="break-all">{sourceUrl}</span>
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
          检测到 <b className="text-[var(--ink)]">{candidates.length}</b> 个插件
          {badCount > 0 && `（其中 ${badCount} 个 manifest 无效，已跳过）`}
          ，默认全选。
        </p>
      </div>

      <div className="max-h-[50vh] overflow-y-auto px-5 py-3">
        <ul className="space-y-1.5">
          {candidates.map((cand) => {
            const isSelected = selected.has(cand.rootPath);
            const isBad = !cand.manifest || !!cand.manifestError;
            const name = cand.manifest?.name ?? cand.rootPath;
            return (
              <li
                key={cand.rootPath}
                className={`rounded-lg border px-3 py-2 ${
                  isBad
                    ? 'border-amber-400/40 bg-amber-500/5'
                    : isSelected
                      ? 'border-[var(--accent)]/60 bg-[var(--accent)]/5'
                      : 'border-[var(--line)]'
                }`}
              >
                <label className={`flex items-start gap-3 ${isBad ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isBad}
                    onChange={() => onToggle(cand.rootPath)}
                    className="mt-0.5 h-4 w-4 rounded border-[var(--line)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[14px] font-medium text-[var(--ink)]">
                        {name}
                      </span>
                      {cand.manifest?.version && (
                        <span className="shrink-0 text-[11px] text-[var(--ink-muted)]">
                          v{cand.manifest.version}
                        </span>
                      )}
                    </div>
                    {cand.manifest?.description && (
                      <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                        {cand.manifest.description}
                      </p>
                    )}
                    {cand.manifestError && (
                      <p className="mt-0.5 text-[12px] text-amber-700 dark:text-amber-500">
                        ⚠ {cand.manifestError}
                      </p>
                    )}
                    {cand.rootPath && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--ink-muted)]">
                        {cand.rootPath}
                      </p>
                    )}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={installable.length === 0}
            className="rounded-full px-3 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            全选
          </button>
          <button
            type="button"
            onClick={onSelectNone}
            className="rounded-full px-3 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            全不选
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[12px] font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
          >
            返回
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={selected.size === 0}
            className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
          >
            安装 {selected.size} 个插件
          </button>
        </div>
      </div>
    </>
  );
}

// ─── installing view ─────────────────────────────────────────────────────
function InstallingView({
  queue,
  cursor,
  currentName,
  results,
  done,
  onClose,
}: {
  queue: PluginCandidate[];
  cursor: number;
  currentName: string;
  results: BatchResult[];
  done: boolean;
  onClose: () => void;
}) {
  const total = queue.length;
  const completed = done ? total : cursor;
  const okCount = results.filter(r => r.ok).length;
  const failedCount = results.filter(r => !r.ok).length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <>
      <div className="border-b border-[var(--line)] px-5 py-4">
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">
          {done ? '安装完成' : '正在批量安装'}
        </h2>
        <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
          {done
            ? `共 ${total} 个：成功 ${okCount}${failedCount > 0 ? `，失败 ${failedCount}` : ''}`
            : `第 ${Math.min(completed + 1, total)} / ${total} 个 · ${currentName}`}
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        {/* Progress bar — Tailwind-only, no third-party dep */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--line)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>

        <ul className="max-h-[40vh] space-y-1 overflow-y-auto text-[12px]">
          {queue.map((cand, i) => {
            const result = results.find(r => r.rootPath === cand.rootPath);
            const name = cand.manifest?.name ?? cand.rootPath;
            // States: pending (no result, not current) / in-flight (current) / ok / failed
            let icon: React.ReactNode;
            let textColor = 'text-[var(--ink-muted)]';
            if (result) {
              if (result.ok) {
                icon = <span className="text-[var(--success,#16a34a)]">✓</span>;
                textColor = 'text-[var(--ink)]';
              } else {
                icon = <span className="text-[var(--error)]">✗</span>;
                textColor = 'text-[var(--error)]';
              }
            } else if (!done && i === cursor) {
              icon = <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />;
              textColor = 'text-[var(--ink)]';
            } else {
              icon = <span className="text-[var(--ink-muted)]">·</span>;
            }
            return (
              <li key={cand.rootPath} className={`flex items-start gap-2 ${textColor}`}>
                <span className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center">
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{name}</div>
                  {result?.error && (
                    <div className="truncate text-[11px] text-[var(--error)] opacity-80">
                      {result.error}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={!done}
          className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
        >
          {!done && <Loader2 className="h-3 w-3 animate-spin" />}
          {done ? '完成' : '安装中…'}
        </button>
      </div>
    </>
  );
}

function phaseLabel(phase: InstallPhase): string {
  switch (phase) {
    case 'fetching': return '抓取中…';
    case 'extracting': return '解压中…';
    case 'validating': return '校验中…';
    case 'writing': return '写入磁盘…';
    case 'done': return '✓ 安装完成';
    case 'failed': return '✗ 安装失败';
    default: return phase;
  }
}
