// TaskCardItem — richer card rendered in the 2-column card view.
//
// v0.1.69 visual rebuild (driven by the mock in
// prd_0.1.69_task_center_visual_feedback.md v2):
//
//   Row 1  — [Category chip left]                       [Status chip + hover actions right]
//   Row 2  — [Title, 16px semibold, clamp-2]
//   Row 3  — [📁 workspace · mode-aware meta · time/rounds]
//   Row 4  — (optional) ActivityBar — latest statusHistory message,
//            rendered when the task is in running or blocked state so
//            users can see "what's happening right now" or "why it's
//            stuck" without opening the detail overlay.
//
// Left vertical stripe was removed — the status chip on the right + the
// category chip on the left already carry the "state" and "kind" axes;
// a third indicator in the form of a color stripe would triple-count
// the same signal. Legacy-cron identity collapses into the category
// chip as "心跳循环 · 遗留" / "周期 · 遗留" etc., so the grid no longer
// needs a separate "遗留" pill — see <TaskCategoryBadge legacy />.

import { useEffect, useState } from 'react';
import { Folder, MessageCircle } from 'lucide-react';

import { taskGetRunStats } from '@/api/taskCenter';
import type { Task, TaskExecutionMode, TaskRunStats } from '@/../shared/types/task';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { humanizeCron, relativeTime } from '@/utils/taskCenterUtils';
import { TaskCategoryBadge } from '../TaskCategoryBadge';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TaskItemActions, deriveTaskRowStatus } from './TaskItemActions';
import type { LegacyCronRow } from './types';

export interface TaskCardItemProps {
  task?: Task;
  legacy?: LegacyCronRow;
  highlighted?: boolean;
  busy?: boolean;
  onOpen: () => void;
  /** Menu "编辑" action — opens the detail overlay in edit mode. Not
   *  wired for legacy rows (their schedule lives in the old cron UI). */
  onEdit?: () => void;
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  onDelete?: () => void;
}

export function TaskCardItem(props: TaskCardItemProps) {
  const { task, legacy, highlighted, busy, onOpen, onEdit, onRun, onStop, onRerun, onDelete } = props;
  const isLegacy = !!legacy && !task;
  const status = deriveTaskRowStatus(task ?? null, legacy?.status === 'running');
  const name = task?.name ?? legacy?.name ?? '—';
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  const category = task ? task.executionMode : inferLegacyCategory(legacy);

  // Loop + recurring tasks surface "第 N 轮" / "已执行 N 次" — both pull
  // from CronTask.execution_count. RunStats is a per-card fetch because
  // the count lives on the linked CronTask, not on the Task row itself.
  // One Tauri round-trip per card; negligible for dashboards < 50 cards
  // and localises the read (no panel-level Map to keep in sync).
  const [runStats, setRunStats] = useState<TaskRunStats | null>(null);
  const shouldFetchStats =
    !!task && (task.executionMode === 'loop' || task.executionMode === 'recurring');
  useEffect(() => {
    if (!shouldFetchStats || !task?.id) return;
    let cancelled = false;
    void taskGetRunStats(task.id)
      .then((s) => {
        if (!cancelled) setRunStats(s);
      })
      .catch(() => {
        /* silent — "第 N 轮" just doesn't render, card still works */
      });
    return () => {
      cancelled = true;
    };
  }, [shouldFetchStats, task?.id]);

  // Activity bar content — quote the latest statusHistory message IFF
  // it's user-meaningful. Whitelist:
  //   - `cli`   — agent-submitted via `myagents task update-status` (real
  //               progress / blocker reason)
  //   - `ui`    — user wrote it via the detail overlay (own note)
  //   - `crash` — boot recovery ("上次被重启中断"); worth surfacing so
  //               the user knows why the task landed in blocked without
  //               their doing
  // Creation entries (`from == null`) are skipped even when source is
  // `ui` — the auto-generated "created (direct)" row isn't something a
  // user needs to see on every new card. `system`/`scheduler`/`rerun`/
  // `migration`/`watchdog`/`endCondition` are all audit-only: useful
  // in the detail overlay's timeline, but noise on the card.
  const latestHistory = task?.statusHistory?.at(-1);
  const activityMessage: string | null = (() => {
    if (!latestHistory) return null;
    if (latestHistory.from === null) return null;
    const src = latestHistory.source;
    if (src !== 'cli' && src !== 'ui' && src !== 'crash') return null;
    const msg = latestHistory.message?.trim();
    return msg && msg.length > 0 ? msg : null;
  })();

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative flex w-full flex-col gap-2.5 rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] p-4 text-left transition-shadow hover:shadow-sm ${
        highlighted ? 'ring-1 ring-[var(--accent-warm)] shadow-xs' : ''
      }`}
    >
      {/* Row 1 — chips on the left, "…" pinned to the far right via
          `ml-auto` on the menu wrapper. `ml-auto` beats `justify-between`
          for this layout because it keeps working when the chip cluster
          ever grows a third element or when the row gets wrapped in
          another flex context during a refactor. */}
      <div className="flex w-full items-center gap-1.5">
        <TaskStatusBadge status={status} />
        <TaskCategoryBadge mode={category} legacy={isLegacy} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ViewSessionButton task={task} />
          <TaskItemActions
            variant={isLegacy ? 'legacy' : 'task'}
            status={status}
            busy={busy}
            onRun={onRun}
            onStop={onStop}
            onRerun={onRerun}
            onOpenDetail={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </div>

      {/* Row 2 — title. 14px / weight 500 per the reference mock — the
          earlier text-base/semibold read too heavy next to the card's
          tiny meta row. Slight negative letter-spacing tightens the
          CJK rhythm so the title doesn't feel "plumped" at weight 500. */}
      <div
        className="line-clamp-2 text-sm font-medium leading-snug text-[var(--ink)]"
        style={{ letterSpacing: '-0.005em' }}
      >
        {name}
      </div>

      {/* Row 3 — meta: folder + workspace + · + mode-aware schedule/round + · + time */}
      <MetaRow
        task={task}
        legacy={legacy}
        category={category}
        executionCount={runStats?.executionCount ?? 0}
        updatedAt={updatedAt}
      />

      {/* Row 4 — optional activity bar. Rendered only when there's a
          user-meaningful message (see `activityMessage` derivation up
          top). One visual treatment for all variants — this is a
          "quote" of the last human/agent note, not a status colour. */}
      {activityMessage && <ActivityBar message={activityMessage} />}
    </button>
  );
}

/**
 * Meta row — one `·`-separated line describing *how this task runs*.
 * Content varies per category:
 *
 *   once       workspace · 一次性 · <updatedAt-relative>
 *   loop       workspace · 心跳循环 · 第 N 轮
 *   scheduled  workspace · <formatted dispatch time>
 *   recurring  workspace · <interval or cron> [· 已执行 N 次]
 *
 * Legacy cron rows fall into whichever category their schedule kind maps
 * to; we don't have full schedule-detail access here, so we degrade to a
 * plain relative-time tail.
 */
function MetaRow({
  task,
  legacy,
  category,
  executionCount,
  updatedAt,
}: {
  task?: Task;
  legacy?: LegacyCronRow;
  category: TaskExecutionMode;
  executionCount: number;
  updatedAt: number;
}) {
  const workspace = workspaceName(task, legacy);
  const parts: string[] = [];
  // User-executor tasks render as "自己做" since they're the user's own
  // todo items rather than AI-dispatched work. Agent is the default and
  // stays implicit.
  if (task?.executor === 'user') parts.push('自己做');

  switch (category) {
    case 'once':
      parts.push('一次性');
      if (updatedAt) parts.push(relativeTime(updatedAt));
      break;
    case 'loop':
      parts.push('心跳循环');
      if (executionCount > 0) parts.push(`第 ${executionCount} 轮`);
      else if (updatedAt) parts.push(relativeTime(updatedAt));
      break;
    case 'scheduled': {
      const when = task?.dispatchAt ?? task?.endConditions?.deadline;
      if (when) parts.push(formatAbsolute(when));
      else if (updatedAt) parts.push(relativeTime(updatedAt));
      break;
    }
    case 'recurring': {
      const sched = formatRecurring(task);
      if (sched) parts.push(sched);
      if (executionCount > 0) parts.push(`已执行 ${executionCount} 次`);
      break;
    }
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
      <Folder className="h-3 w-3 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{workspace}</span>
      {parts.map((p, i) => (
        <span key={i} className="contents">
          <MetaSep />
          <span className={i === parts.length - 1 ? 'truncate' : undefined}>{p}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Inline activity bar — one uniform "quote" treatment for every kind
 * of message we surface (agent progress, agent blocker reason, user
 * note, crash-recovery). Left hairline + paper tint is the same
 * vocabulary the detail overlay uses for the "来自想法" source quote,
 * so the two surfaces read as related. Status colour is carried by the
 * status badge above; this bar doesn't re-encode it.
 *
 * Single-line clamp keeps every card the same height regardless of how
 * verbose the latest message is — the full text is available on hover
 * tooltip and inside the detail overlay's status timeline.
 */
function ActivityBar({ message }: { message: string }) {
  // Softer wash than solid `--paper-inset`. Single-element truncate
  // (rather than flex + inner span) — wrapping the text in a flex row
  // would make the inner span a flex item with `min-width: auto`, and
  // the long Chinese run would push the outer card past its width.
  // `block` + `truncate` directly on the bordered container avoids that
  // entire class of overflow bug.
  return (
    <div
      className="block w-full min-w-0 truncate rounded-r-[var(--radius-sm)] border-l-2 border-[var(--line)] px-2.5 py-1 text-[12px] leading-snug text-[var(--ink-muted)]"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--paper-inset) 35%, var(--paper-elevated))',
      }}
      title={message}
    >
      {message}
    </div>
  );
}

function MetaSep() {
  return (
    <span className="text-[var(--ink-muted)]/50" aria-hidden>
      ·
    </span>
  );
}

/** Best guess at the "kind" of a legacy cron from its schedule shape. */
function inferLegacyCategory(legacy?: LegacyCronRow): TaskExecutionMode {
  if (!legacy) return 'once';
  const sched = (legacy.raw as { schedule?: { kind?: string } }).schedule;
  const kind = sched?.kind;
  if (kind === 'loop') return 'loop';
  if (kind === 'at') return 'scheduled';
  // "every" / "cron" / undefined → recurring is the safe default for
  // legacy rows that don't have a resolvable schedule shape.
  return 'recurring';
}

function workspaceName(task?: Task, legacy?: LegacyCronRow): string {
  const raw = task?.workspacePath ?? legacy?.workspacePath ?? '';
  if (!raw) return '—';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

function formatAbsolute(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  // Tomorrow check — diff of 1 day, sensitive to DST transitions is fine
  // for a display string.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    return `明天 ${hh}:${mm}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

// Translate a recurring task's schedule into a one-line Chinese readout
// for the card's meta row. Previously we punted on cron by showing the
// raw `0 11 * * *` expression — users shouldn't have to know cron syntax
// to read their own task list. This formatter covers the five shapes
// the chip picker emits (daily / weekdays / specific weekdays / weekly /
// monthly) plus interval mode; anything else (custom cron the user typed)
// falls back to the raw string so we stay honest rather than mis-translate.
/**
 * Hover-only chip that opens the task's most-recent SDK session in a new
 * Chat tab. Renders nothing when the task has no recorded sessions yet
 * (PRD 0.2.4 §需求 5: 「无数据不渲染」). The "most recent" is the last
 * id appended to `task.sessionIds` — `task.rs::append_session` appends
 * in execution order so the tail is authoritative.
 *
 * Visual vocabulary mirrors the thought-card hover actions ("AI 讨论"
 * etc.): icon + label chip with a dark-pill tooltip on hover. Shared by
 * both TaskCardItem and TaskListRow so the affordance is placed
 * identically (immediately left of the ⋯ overflow trigger).
 */
export function ViewSessionButton({ task }: { task?: Task }) {
  if (!task || task.sessionIds.length === 0) return null;
  const sessionId = task.sessionIds[task.sessionIds.length - 1];
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!task.workspacePath) return;
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
        detail: { sessionId, workspacePath: task.workspacePath },
      }),
    );
  };
  return (
    <div className="group/view-session relative opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        type="button"
        onClick={handleClick}
        aria-label="查看会话详情"
        className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-[12px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-cool)]"
      >
        <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
        会话详情
      </button>
      <span className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-[11px] text-[var(--button-primary-text)] opacity-0 shadow-lg transition-opacity group-hover/view-session:opacity-100">
        查看会话详情
      </span>
    </div>
  );
}

function formatRecurring(task?: Task): string | null {
  if (!task) return null;
  if (task.cronExpression) {
    return humanizeCron(task.cronExpression) ?? task.cronExpression;
  }
  if (task.intervalMinutes) {
    const m = task.intervalMinutes;
    if (m >= 1440 && m % 1440 === 0) return `每 ${m / 1440} 天`;
    if (m >= 60 && m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${m} 分钟`;
  }
  return null;
}

