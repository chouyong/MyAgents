// TaskDetailOverlay — modal covering Task Center with full details of one Task.
// PRD §7.3. Uses the shared OverlayBackdrop + closeLayer Cmd+W integration.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Bell,
  Bot,
  CheckCircle,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { DropdownMenu, type DropdownMenuItem, type DropdownMenuSection } from '@/components/ui/DropdownMenu';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import {
  taskArchive,
  taskDelete,
  taskGet,
  taskGetRunStats,
  taskRerun,
  taskRun,
  taskUpdateStatus,
} from '@/api/taskCenter';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import type { Task, TaskRunStats } from '@/../shared/types/task';
import { TaskStatusBadge } from './TaskStatusBadge';
import { DispatchOriginBadge } from './DispatchOriginBadge';
import { StatusHistoryList } from './StatusHistoryList';
import { TaskSessionsList } from './TaskSessionsList';
import { SummaryCard } from './SummaryCard';
import { TaskDocBlock } from './TaskDocBlock';
import { TaskEditPanel, type FocusDoc } from './TaskEditPanel';
import { extractErrorMessage } from './errors';

/** Esc-to-close for the overlay's preview mode. The edit panel handles its
 *  own Esc (with dirty-guard) via PanelChrome.usePanelKeys, so this wires
 *  itself off when `editing` is true to avoid two handlers firing on the
 *  same keypress. */
function useOverlayEsc(active: boolean, onEsc: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onEsc();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, onEsc]);
}

const OVERLAY_Z = 200;

interface Props {
  task: Task;
  /** When true, the overlay opens directly in edit mode — used by the
   *  card/row "编辑" menu item. */
  startEditing?: boolean;
  onClose: () => void;
  onChanged?: (next: Task | null) => void;
}

export function TaskDetailOverlay({
  task: initial,
  startEditing = false,
  onClose,
  onChanged,
}: Props) {
  const [task, setTask] = useState<Task>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(startEditing);
  // When edit mode opens via an inline "编辑" button on a specific doc
  // (task.md / verify.md) or on the notification section, the edit
  // panel needs to scroll/focus to that target. `null` = top of panel.
  const [focusDoc, setFocusDoc] = useState<FocusDoc | null>(null);
  const [runStats, setRunStats] = useState<TaskRunStats | null>(null);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Bumped on every external task change so child blocks (TaskDocBlock) can
  // reload their document contents without us having to lift the content up.
  const [reloadToken, setReloadToken] = useState(0);

  const toast = useToast();
  const { projects } = useConfig();
  const agentId = useMemo(() => {
    const p = projects.find((x) => x.path === task.workspacePath);
    return p?.agentId ?? null;
  }, [projects, task.workspacePath]);

  // Guard every async setState call so a late-returning sync / refetch
  // can't hit an already-unmounted overlay. The toast / onChanged callback
  // paths are fine (they're called by the parent or the toast portal),
  // but local setBusy / setSyncing / setTask need protection.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  // Esc closes the overlay in preview mode. In edit mode, TaskEditPanel
  // owns Esc so it can run its dirty-guard before unwinding to preview;
  // we deactivate the overlay-level Esc to keep them from competing.
  useOverlayEsc(!editing, onClose);

  // Load run stats alongside the fresh task — re-fired on reloadToken so
  // external transitions (scheduler tick) re-aggregate executionCount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stats = await taskGetRunStats(task.id);
        if (!cancelled) setRunStats(stats);
      } catch {
        /* silent — stats are best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, reloadToken]);

  // Sync per-task execution overrides back to the owning Agent's default
  // config. Mirrors CronTaskDetailPanel.handleSyncToAgent, but scoped to
  // `task.model` / `task.permissionMode` rather than a session snapshot
  // (Task Center does not carry a session-level snapshot).
  //
  // Button is hidden when there's nothing meaningful to sync: auto is the
  // Agent default, so `permissionMode === 'auto'` with no model override
  // produces a no-op patch that only confuses the user.
  const hasMeaningfulOverride =
    !!task.model ||
    (!!task.permissionMode && task.permissionMode !== 'auto');
  const canSyncToAgent = !!agentId && hasMeaningfulOverride;
  const isDangerousSync = task.permissionMode === 'fullAgency';

  const doSyncToAgent = useCallback(async () => {
    if (!agentId) return;
    setSyncing(true);
    try {
      const patch: { model?: string; permissionMode?: string } = {};
      if (task.model) patch.model = task.model;
      if (task.permissionMode) patch.permissionMode = task.permissionMode;
      await patchAgentConfig(agentId, patch);
      if (!isMountedRef.current) return;
      toast.success('已同步到 Agent');
      setShowSyncConfirm(false);
    } catch (e) {
      if (!isMountedRef.current) return;
      toast.error(`同步失败:${extractErrorMessage(e)}`);
    } finally {
      if (isMountedRef.current) setSyncing(false);
    }
  }, [agentId, task.model, task.permissionMode, toast]);

  // Refetch on mount so we show the latest statusHistory (in case UI was out of sync).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await taskGet(task.id);
        if (cancelled || !isMountedRef.current) return;
        if (fresh) setTask(fresh);
      } catch {
        /* silent — use `initial` */
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- we only want this on mount
  }, []);

  // Live-update on external transitions (CLI / scheduler / other window).
  // Listen to both `task:status-changed` (state transitions) and
  // `task:session-appended` (new runs linked to this task) — the latter is
  // critical for the "任务执行" section to show runs that fire while the
  // overlay is open.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const reloadIfMatches = async (taskId: string | undefined) => {
      if (cancelled || !isMountedRef.current) return;
      if (taskId !== task.id) return;
      try {
        const fresh = await taskGet(task.id);
        if (cancelled || !isMountedRef.current) return;
        if (fresh) {
          setTask(fresh);
          setReloadToken((n) => n + 1);
        }
      } catch {
        /* silent */
      }
    };
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      for (const evt of ['task:status-changed', 'task:session-appended']) {
        const unlisten = await listen<{ taskId?: string }>(evt, (e) => {
          void reloadIfMatches(e.payload?.taskId);
        });
        if (cancelled) {
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const off of unlisteners) off();
    };
  }, [task.id]);

  const runStatus = useCallback(
    async (next: Task['status']) => {
      setBusy(true);
      setErr(null);
      try {
        const updated = await taskUpdateStatus({ id: task.id, status: next });
        if (!isMountedRef.current) return;
        setTask(updated);
        onChanged?.(updated);
      } catch (e) {
        if (!isMountedRef.current) return;
        setErr(extractErrorMessage(e));
      } finally {
        if (isMountedRef.current) setBusy(false);
      }
    },
    [task.id, onChanged],
  );

  const dispatchRun = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskRun(task.id);
      // The Rust endpoint transitions us to `running` via update_status; our
      // SSE listener upstairs handles the refresh, but also refetch here so
      // the overlay updates instantly.
      const fresh = await taskGet(task.id);
      if (fresh) {
        setTask(fresh);
        onChanged?.(fresh);
      }
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const dispatchRerun = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskRerun(task.id);
      const fresh = await taskGet(task.id);
      if (fresh) {
        setTask(fresh);
        onChanged?.(fresh);
      }
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const doArchive = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const updated = await taskArchive(task.id);
      setTask(updated);
      onChanged?.(updated);
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  // OverflowMenu's 删除 entry opens a <ConfirmDialog> (matching the
  // sync-to-agent flow); `doDelete` is the confirmed path. Replaces the
  // prior `window.confirm` which rendered as an OS-native modal that
  // bypassed the overlay's Cmd+W closeLayer stack and ignored the
  // app's design tokens.
  const doDelete = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskDelete(task.id);
      setShowDeleteConfirm(false);
      onChanged?.(null);
      onClose();
    } catch (e) {
      setErr(extractErrorMessage(e));
      setBusy(false);
    }
  }, [task.id, onChanged, onClose]);

  const locked = task.status === 'running' || task.status === 'verifying';

  const enterEdit = useCallback(
    (target: FocusDoc | null = null) => {
      if (locked) return;
      setErr(null);
      setFocusDoc(target);
      setEditing(true);
    },
    [locked],
  );

  const onEditSaved = useCallback(
    (next: Task) => {
      setTask(next);
      onChanged?.(next);
      setEditing(false);
      setFocusDoc(null);
      // Docs don't move here, but bump so dependent blocks re-render cleanly.
      setReloadToken((n) => n + 1);
    },
    [onChanged],
  );

  const onEditCancel = useCallback(() => {
    setEditing(false);
    setFocusDoc(null);
  }, []);

  return (
    <>
      {showSyncConfirm && (
        <ConfirmDialog
          title={isDangerousSync ? '⚠️ 同步到 Agent(含完全自治)' : '同步到 Agent'}
          message={
            isDangerousSync
              ? '此任务使用【完全自治 (fullAgency)】权限 — 同步后该 Agent 未来所有新会话都将默认跳过权限确认，可直接执行删改文件等破坏性操作。确认要把这个宽松权限设为 Agent 默认吗？'
              : '将该任务的模型 / 权限覆盖写回所属 Agent 的默认配置。这会影响之后新开的会话。确定继续?'
          }
          confirmText={isDangerousSync ? '仍然同步' : '同步'}
          cancelText="取消"
          confirmVariant={isDangerousSync ? 'danger' : undefined}
          loading={syncing}
          onConfirm={() => void doSyncToAgent()}
          onCancel={() => setShowSyncConfirm(false)}
        />
      )}
      {showDeleteConfirm && (
        <ConfirmDialog
          title="删除任务"
          message={`确定删除任务「${task.name}」？此操作不可撤销。`}
          confirmText="删除"
          cancelText="取消"
          confirmVariant="danger"
          loading={busy}
          onConfirm={() => void doDelete()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
      <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[min(780px,92vw)] flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header — 18px semibold title (PanelChrome hierarchy: panel
            title is one notch above the 14px section h3s in the body
            so the user can tell "this is the panel of task X" from
            "this is the section about X" at a glance). When entering
            edit mode the header title takes a "编辑：" prefix so the
            mode change is visible without a separate banner. */}
        <div className="flex items-start gap-3 border-b border-[var(--line)] px-6 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {editing ? (
                <span className="rounded-[var(--radius-sm)] bg-[var(--accent)]/10 px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                  编辑中
                </span>
              ) : (
                <>
                  <TaskStatusBadge status={task.status} />
                  {/* DispatchOriginBadge: v0.1.69 review — hide the
                      default "直接派发" which applies to 99% of tasks.
                      Only render when origin adds information
                      (ai-aligned). */}
                  {task.dispatchOrigin === 'ai-aligned' && (
                    <DispatchOriginBadge origin={task.dispatchOrigin} />
                  )}
                </>
              )}
              <h2 className="min-w-0 truncate text-[18px] font-semibold leading-snug text-[var(--ink)]">
                {task.name}
              </h2>
            </div>
            {task.description && !editing && (
              <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                {task.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="关闭 (Esc / Cmd+W)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Action bar — slim v0.1.69 design:
              • primary lifecycle button (one of: 立即执行/中止/重新派发)
              • 编辑
              • ⋯ overflow menu (standardises all secondary actions,
                including 删除 which used to sit as its own danger button)
            Hidden in edit mode — the edit panel has its own footer.
            `py-1.5` (was `py-3`) tightens the row; ActionBtn itself
            already has `py-1.5` so the overall row height is just
            buttonHeight + 12px breathing room. */}
        {!editing && (
          <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-6 py-1.5">
            {task.status === 'todo' && (
              <ActionBtn
                icon={<Play className="h-3.5 w-3.5" />}
                label="立即执行"
                disabled={busy}
                onClick={dispatchRun}
              />
            )}
            {(task.status === 'running' || task.status === 'verifying') && (
              <ActionBtn
                icon={<Square className="h-3.5 w-3.5" />}
                label="中止"
                variant="danger"
                disabled={busy}
                onClick={() => runStatus('stopped')}
              />
            )}
            {(task.status === 'blocked' ||
              task.status === 'stopped' ||
              task.status === 'done' ||
              task.status === 'archived') && (
              <ActionBtn
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                label="重新派发"
                disabled={busy}
                onClick={dispatchRerun}
                title="reset → todo → run (PRD §10.2.2)"
              />
            )}
            <ActionBtn
              icon={<Pencil className="h-3.5 w-3.5" />}
              label="编辑"
              disabled={busy || locked}
              onClick={() => enterEdit(null)}
              title={locked ? '任务运行 / 验证中，不可编辑（PRD §9.4）' : undefined}
            />
            <div className="flex-1" />
            <OverflowMenu
              status={task.status}
              busy={busy}
              syncing={syncing}
              canSyncToAgent={canSyncToAgent}
              onMarkDone={() => runStatus('done')}
              onArchive={doArchive}
              onSyncToAgent={() => setShowSyncConfirm(true)}
              onDelete={() => setShowDeleteConfirm(true)}
            />
          </div>
        )}

        {err && (
          <div className="border-b border-[var(--error)]/30 bg-[var(--error-bg)] px-6 py-2 text-[12px] text-[var(--error)]">
            {err}
          </div>
        )}

        {/* Body: scrollable. In edit mode TaskEditPanel renders its own
            footer below; we let the panel hug the entire body so the
            footer sticks to the modal bottom rather than floating mid-card. */}
        <div className={editing ? 'flex flex-1 min-h-0 flex-col' : 'flex-1 overflow-y-auto px-6 py-5'}>
          {editing ? (
            <TaskEditPanel
              task={task}
              focusDoc={focusDoc}
              onSaved={onEditSaved}
              onCancel={onEditCancel}
              onError={setErr}
            />
          ) : (
            <>
              {/* 任务概览 — schedule headline + workspace/agent + run
                  stats + tags + end conditions, with low-frequency
                  fields behind "展开更多详情". Replaces the prior
                  ~14-row <Meta> dl + conditional <RunStatsSection>. */}
              <SummaryCard task={task} stats={runStats} />

              {/* 任务执行 — promoted to the second block (right after meta)
                  per v0.1.69 UX feedback. Users opening a task detail are
                  most often trying to "see what happened in the last run"
                  before they ever care about task.md / verify.md contents. */}
              <TaskSessionsList task={task} onBeforeOpen={onClose} />

              {/* task.md / verify.md / progress.md — read-only previews.
                  The overlay's top-level "编辑" button is the single
                  edit entry; per-block edit affordances were removed
                  (v0.1.69 preview polish — one edit entry, not four). */}
              <TaskDocBlock
                task={task}
                doc="task"
                title="task.md · 执行 Prompt"
                emptyHint="还没有内容。点击上方「编辑」进入编辑页写入这个任务的执行提示词。"
                reloadKey={reloadToken}
                onError={setErr}
              />

              <TaskDocBlock
                task={task}
                doc="verify"
                title="verify.md · 验收标准"
                emptyHint="还没有验收标准。点击上方「编辑」写一份;AI 在 verifying 阶段会用它自检。"
                reloadKey={reloadToken}
                onError={setErr}
              />

              <TaskDocBlock
                task={task}
                doc="progress"
                title="progress.md · 执行日志"
                emptyHint=""
                hideWhenEmpty
                reloadKey={reloadToken}
                onError={setErr}
              />

              <hr className="my-4 border-[var(--line-subtle)]" />

              <StatusHistoryList task={task} defaultCollapsed />

              <hr className="my-4 border-[var(--line-subtle)]" />

              <NotificationSummary task={task} />
            </>
          )}
        </div>
      </div>
    </OverlayBackdrop>
    </>
  );
}

/** OverflowMenu — "⋯" button with all secondary actions (标记完成,
 *  归档, 同步到 Agent, 删除). Wraps the shared `DropdownMenu` primitive
 *  with task-specific section layout: secondary actions first, delete
 *  separated in its own danger group. */
function OverflowMenu({
  status,
  busy,
  syncing,
  canSyncToAgent,
  onMarkDone,
  onArchive,
  onSyncToAgent,
  onDelete,
}: {
  status: Task['status'];
  busy: boolean;
  syncing: boolean;
  canSyncToAgent: boolean;
  onMarkDone: () => void;
  onArchive: () => void;
  onSyncToAgent: () => void;
  onDelete: () => void;
}) {
  const canMarkDone = status === 'verifying';
  const canArchive = status === 'done';

  const secondary: DropdownMenuItem[] = [];
  if (canMarkDone) {
    secondary.push({
      icon: <CheckCircle className="h-3.5 w-3.5" />,
      label: '标记完成',
      onClick: onMarkDone,
    });
  }
  if (canArchive) {
    secondary.push({
      icon: <Archive className="h-3.5 w-3.5" />,
      label: '归档',
      onClick: onArchive,
    });
  }
  if (canSyncToAgent) {
    secondary.push({
      icon: <Bot className="h-3.5 w-3.5" />,
      label: syncing ? '同步中…' : '同步到 Agent',
      title: '把该任务的模型 / 权限覆盖写回所属 Agent 的默认配置',
      onClick: onSyncToAgent,
      disabled: syncing,
    });
  }

  const sections: DropdownMenuSection[] = [
    { items: secondary },
    {
      items: [
        {
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: '删除',
          onClick: onDelete,
          danger: true,
        },
      ],
    },
  ];

  return (
    <DropdownMenu
      sections={sections}
      size="md"
      disabled={busy}
      minWidth={160}
      zIndex={OVERLAY_Z + 1}
    />
  );
}

/** NotificationSummary — read-only one-liner ("桌面 ✓ · 飞书·公司群").
 *  v0.1.69 preview polish: no inline edit button — the overlay's
 *  top-level "编辑" is the only edit entry across the whole preview. */
function NotificationSummary({ task }: { task: Task }) {
  const { statuses } = useAgentStatuses();
  const cfg = task.notification;
  const desktop = cfg?.desktop !== false;
  const botChannelId = cfg?.botChannelId ?? null;
  const channelLabel = useMemo(() => {
    if (!botChannelId) return null;
    for (const agent of Object.values(statuses)) {
      for (const ch of agent.channels) {
        if (ch.channelId === botChannelId) {
          return `${agent.agentName} · ${ch.name ?? ch.channelType}`;
        }
      }
    }
    return `未知频道 (${botChannelId})`;
  }, [botChannelId, statuses]);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[14px] font-semibold text-[var(--ink)]">
        <Bell className="h-3.5 w-3.5" />
        通知
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className={desktop ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}>
          桌面通知 {desktop ? '✓ 开启' : '✗ 关闭'}
        </span>
        {channelLabel ? (
          <span className="text-[var(--ink)]">IM Bot: {channelLabel}</span>
        ) : (
          <span className="text-[var(--ink-muted)]/70">不发送到 Bot</span>
        )}
      </div>
    </div>
  );
}

interface ActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: 'default' | 'danger';
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  title,
  variant,
}: ActionBtnProps) {
  // Disabled state uses `ink-subtle` (a lighter fade) + explicit hover
  // overrides so CSS `:hover` doesn't still tint the button orange/red —
  // prior `disabled:opacity-50` alone kept the ink-muted tone close enough
  // to the active state that users read it as clickable (PRD §9.4 "锁定
  // 态视觉" feedback; without the override the hover background still
  // flashed on mouse-over).
  const base =
    'flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:text-[var(--ink-subtle)] disabled:hover:bg-transparent';
  const variantCls =
    variant === 'danger'
      ? 'text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:hover:text-[var(--ink-subtle)]'
      : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:hover:text-[var(--ink-subtle)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variantCls}`}
    >
      {icon}
      {label}
    </button>
  );
}

export default TaskDetailOverlay;
