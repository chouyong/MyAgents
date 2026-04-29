// NotificationConfigEditor — single source of truth for "task notification"
// UI. Used by both DispatchTaskDialog (create) and TaskEditPanel (edit) so
// the lifecycle "create → edit" stays pixel-aligned (PRD §7.3 / §8.2 / §12).
//
// Channel options come from the shared `useDeliveryChannels(workspacePath)`
// hook which already groups channels by workspace and ranks the current
// workspace first — keeping this component aligned with cron's
// CronTaskSettingsModal / CronTaskDetailPanel as well.
//
// `events` and `botThread` remain on the payload but are not user-editable
// at this UI layer (PRD v0.1.69 trim — defaulted to the standard set so
// first-time users don't drown in switches). If they need to be exposed
// again, do it here without touching backend contracts.

import { useDeliveryChannels } from '@/hooks/useDeliveryChannels';
import CustomSelect from '@/components/CustomSelect';
import type { NotificationConfig } from '@/../shared/types/task';
import { Toggle } from './editors/PanelChrome';

const DEFAULT_EVENTS: NonNullable<NotificationConfig['events']> = [
  'done',
  'blocked',
  'endCondition',
];

interface Props {
  value?: NotificationConfig;
  onChange: (next: NotificationConfig) => void;
  /** Workspace this notification config belongs to. Lets the channel
   *  picker rank the workspace's own channels above others, matching
   *  the cron-task picker behaviour. */
  workspacePath?: string;
}

export function NotificationConfigEditor({ value, onChange, workspacePath }: Props) {
  const { options, hasChannels } = useDeliveryChannels(workspacePath);

  const current: NotificationConfig = {
    desktop: value?.desktop ?? true,
    botChannelId: value?.botChannelId,
    botThread: value?.botThread,
    events: value?.events ?? DEFAULT_EVENTS,
  };

  const patch = (p: Partial<NotificationConfig>) => onChange({ ...current, ...p });

  return (
    <div className="space-y-3">
      {/* Desktop toggle row — bordered card, mirrors the dispatch-flow
          "settings switch" aesthetic. */}
      <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
        <div className="min-w-0 pr-3">
          <div className="text-sm text-[var(--ink)]">桌面通知</div>
          <div className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
            任务状态变化时弹出系统通知
          </div>
        </div>
        <Toggle
          checked={current.desktop}
          onChange={(v) => patch({ desktop: v })}
          ariaLabel="桌面通知开关"
        />
      </div>

      {/* IM channel — only render the picker when channels exist; otherwise
          a quiet hint so the user knows where to wire one up. */}
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">
          投递到 IM Bot
          <span className="ml-1 text-[12px] font-normal text-[var(--ink-muted)]/80">
            （可选）
          </span>
        </label>
        {hasChannels ? (
          <CustomSelect
            value={current.botChannelId ?? ''}
            options={options}
            onChange={(v) => patch({ botChannelId: v || undefined })}
            placeholder="桌面通知（默认）"
            size="md"
          />
        ) : (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
            该工作区还没有可用的 IM 频道。仅发送桌面通知。
          </div>
        )}
      </div>
    </div>
  );
}

export default NotificationConfigEditor;
