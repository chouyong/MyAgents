import React, { useCallback, useMemo } from 'react';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import {
    closestCenter,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { normalizeProviderOrder, type Provider } from '@/config/types';

interface ProviderEnableOrderDialogProps {
    providers: Provider[];
    providerOrderDraft: string[];
    disabledProviderDraft: string[];
    onProviderOrderDraftChange: React.Dispatch<React.SetStateAction<string[]>>;
    onDisabledProviderDraftChange: React.Dispatch<React.SetStateAction<string[]>>;
    onClose: () => void;
    onSave: () => void;
}

interface ProviderOrderRowProps {
    provider: Provider;
    index: number;
    isLast: boolean;
    enabled: boolean;
    onMove: (providerId: string, direction: -1 | 1) => void;
    onToggle: (providerId: string, enabled: boolean) => void;
}

function ProviderOrderRow({ provider, index, isLast, enabled, onMove, onToggle }: ProviderOrderRowProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: provider.id });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-3 transition-shadow ${isDragging ? 'relative z-10 shadow-lg ring-1 ring-[var(--focus-border)]' : ''} ${enabled ? '' : 'opacity-60'}`}
        >
            <button
                type="button"
                {...attributes}
                {...listeners}
                className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] active:cursor-grabbing"
                title="拖拽排序"
                aria-label={`拖拽排序 ${provider.name}`}
            >
                <GripVertical className="h-4 w-4" />
            </button>
            <div className="flex w-16 shrink-0 items-center gap-1">
                <button
                    type="button"
                    onClick={() => onMove(provider.id, -1)}
                    disabled={index === 0}
                    className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-35"
                    title="上移"
                >
                    <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() => onMove(provider.id, 1)}
                    disabled={isLast}
                    className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-35"
                    title="下移"
                >
                    <ArrowDown className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-[var(--ink)]">{provider.name}</p>
                    <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                        {provider.cloudProvider}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                        {provider.type === 'subscription' ? '订阅' : 'API'}
                    </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                    {provider.models.length > 0
                        ? provider.models.map(model => model.modelName || model.model).join(', ')
                        : '暂无模型'}
                </p>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => onToggle(provider.id, !enabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}
                title={enabled ? '已启用' : '已禁用'}
            >
                <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
        </div>
    );
}

export default function ProviderEnableOrderDialog({
    providers,
    providerOrderDraft,
    disabledProviderDraft,
    onProviderOrderDraftChange,
    onDisabledProviderDraftChange,
    onClose,
    onSave,
}: ProviderEnableOrderDialogProps) {
    const providerRows = useMemo(() => {
        const byId = new Map(providers.map(provider => [provider.id, provider] as const));
        return normalizeProviderOrder(providers.map(provider => provider.id), providerOrderDraft)
            .map(id => byId.get(id))
            .filter((provider): provider is Provider => Boolean(provider));
    }, [providers, providerOrderDraft]);

    const disabledSet = useMemo(
        () => new Set(disabledProviderDraft),
        [disabledProviderDraft],
    );
    const enabledCount = providerRows.length - disabledSet.size;
    const allEnabled = providerRows.length > 0 && disabledSet.size === 0;

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 6 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    const moveProvider = useCallback((providerId: string, direction: -1 | 1) => {
        onProviderOrderDraftChange((current) => {
            const normalized = normalizeProviderOrder(providers.map(provider => provider.id), current);
            const index = normalized.indexOf(providerId);
            const nextIndex = index + direction;
            if (index < 0 || nextIndex < 0 || nextIndex >= normalized.length) return normalized;
            const next = [...normalized];
            [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
            return next;
        });
    }, [providers, onProviderOrderDraftChange]);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        onProviderOrderDraftChange((current) => {
            const normalized = normalizeProviderOrder(providers.map(provider => provider.id), current);
            const oldIndex = normalized.indexOf(String(active.id));
            const newIndex = normalized.indexOf(String(over.id));
            if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return normalized;
            return arrayMove(normalized, oldIndex, newIndex);
        });
    }, [providers, onProviderOrderDraftChange]);

    const toggleProviderEnabled = useCallback((providerId: string, enabled: boolean) => {
        onDisabledProviderDraftChange((current) => {
            if (enabled) return current.filter(id => id !== providerId);
            return current.includes(providerId) ? current : [...current, providerId];
        });
    }, [onDisabledProviderDraftChange]);

    const toggleAllProvidersEnabled = useCallback(() => {
        onDisabledProviderDraftChange(allEnabled
            ? providers.map(provider => provider.id)
            : []);
    }, [providers, allEnabled, onDisabledProviderDraftChange]);

    return (
        <OverlayBackdrop className="z-50 overflow-y-auto py-8">
            <div className="mx-4 flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
                <div className="flex-shrink-0 px-6 pb-4 pt-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-lg font-semibold text-[var(--ink)]">启用和排序</h3>
                            <p className="mt-1 text-sm text-[var(--ink-muted)]">
                                控制可被对话、任务和聊天机器人使用的供应商，以及它们在模型选择器中的顺序。
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                            aria-label="关闭"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
                    <div className="mb-3 flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
                        <div>
                            <p className="text-sm font-medium text-[var(--ink)]">
                                已启用 {Math.max(0, enabledCount)} / {providerRows.length}
                            </p>
                            <p className="text-xs text-[var(--ink-muted)]">
                                禁用的供应商会从设置列表和模型选择器隐藏；重新启用会保留已有配置。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={toggleAllProvidersEnabled}
                            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                        >
                            {allEnabled ? '取消全选' : '全选'}
                        </button>
                    </div>
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={providerRows.map(provider => provider.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <div className="space-y-2">
                                {providerRows.map((provider, index) => (
                                    <ProviderOrderRow
                                        key={provider.id}
                                        provider={provider}
                                        index={index}
                                        isLast={index === providerRows.length - 1}
                                        enabled={!disabledSet.has(provider.id)}
                                        onMove={moveProvider}
                                        onToggle={toggleProviderEnabled}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </div>

                <div className="flex flex-shrink-0 justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
                    <button
                        onClick={onClose}
                        className="rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                    >
                        取消
                    </button>
                    <button
                        onClick={onSave}
                        className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        保存
                    </button>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
