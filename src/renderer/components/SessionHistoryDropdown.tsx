import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { BarChart2, Clock, Download, Star, Trash2 } from 'lucide-react';

import { deleteSession, getSessionDetails, getSessions, updateSession, type SessionMetadata } from '@/api/sessionClient';
import { deactivateSession } from '@/api/tauriClient';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { getWorkspaceCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { formatTokens } from '@/utils/formatTokens';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import type { SessionTag } from '@/hooks/useTaskCenterData';

import ConfirmDialog from './ConfirmDialog';
import SessionStatsModal from './SessionStatsModal';
import SessionTagBadge from './SessionTagBadge';
import Tip from './Tip';
import { useToast } from './Toast';
import { Popover } from './ui/Popover';

interface SessionHistoryDropdownProps {
    agentDir: string;
    currentSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    /** Called when the current session is deleted - should reset to "new conversation" state */
    onDeleteCurrentSession: () => void;
    isOpen: boolean;
    onClose: () => void;
    /** Trigger button ref — anchors the dropdown via the Popover primitive. */
    triggerRef: React.RefObject<HTMLElement | null>;
}

// Track fetch state: null = not fetched, empty array = fetched but empty
type FetchState = SessionMetadata[] | null;
type CronTaskFetchState = CronTask[] | null;

export default function SessionHistoryDropdown({
    agentDir,
    currentSessionId,
    onSelectSession,
    onDeleteCurrentSession,
    isOpen,
    onClose,
    triggerRef,
}: SessionHistoryDropdownProps) {
    const toast = useToast();
    const [sessions, setSessions] = useState<FetchState>(null);
    const [cronTasks, setCronTasks] = useState<CronTaskFetchState>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    // Track pending delete to show confirmation UI
    // Pending delete carries the session title so the confirm dialog can show
    // a recognizable label even after the row scrolls out / the user blurs.
    // Keeping `id` separate from `title` (vs. just `id`) lets us survive the
    // window where `setSessions` mutates the list mid-confirm.
    const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
    // Track delete error for user feedback
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const onCloseRef = useRef(onClose);
    const statsSessionRef = useRef(statsSession);

    // Agent statuses for active session tagging
    const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>({});
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>([]);

    // Compute session tags map (same logic as useTaskCenterData)
    const sessionTagsMap = useMemo(() => {
        const map = new Map<string, SessionTag[]>();
        if (!sessions) return map;

        // Build IM session map from agent channel statuses
        const imSessionPlatformMap = new Map<string, string>();
        for (const agentStatus of Object.values(agentStatuses)) {
            for (const channel of agentStatus.channels) {
                if (channel.status !== 'online' && channel.status !== 'connecting') continue;
                for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                    imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
                }
            }
        }

        // Build running cron task session set (use internalSessionId when available)
        const cronSessionIds = new Set(
            (cronTasks ?? []).filter(t => t.status === 'running').map(t => t.internalSessionId || t.sessionId)
        );

        // Build background session set
        const bgSessionIds = new Set(backgroundSessionIds);

        // Assign tags to each session
        for (const session of sessions) {
            const tags: SessionTag[] = [];
            const imPlatform = imSessionPlatformMap.get(session.id);
            if (imPlatform) tags.push({ type: 'im', platform: imPlatform });
            if (cronSessionIds.has(session.id)) tags.push({ type: 'cron' });
            if (bgSessionIds.has(session.id)) tags.push({ type: 'background' });
            if (tags.length > 0) map.set(session.id, tags);
        }

        return map;
    }, [sessions, cronTasks, backgroundSessionIds, agentStatuses]);

    // Sorted sessions: tagged first, then by lastActiveAt descending within each group
    const sortedSessions = useMemo(() => {
        if (!sessions) return [];
        return [...sessions].sort((a, b) => {
            const aHasTag = sessionTagsMap.has(a.id);
            const bHasTag = sessionTagsMap.has(b.id);
            if (aHasTag !== bHasTag) return aHasTag ? -1 : 1;
            return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
        });
    }, [sessions, sessionTagsMap]);

    // Keep refs updated via effect (not during render)
    useEffect(() => {
        onCloseRef.current = onClose;
        statsSessionRef.current = statsSession;
    }, [onClose, statsSession]);

    // Load sessions and cron tasks when opened
    useEffect(() => {
        if (!isOpen || !agentDir) return;

        let cancelled = false;

        (async () => {
            // Load sessions, cron tasks, agent statuses, and background sessions in parallel
            const agentStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => ({} as AgentStatusMap))
                : Promise.resolve({} as AgentStatusMap);

            const [sessionsResult, cronTasksResult, agentStatusResult, bgSessionsResult] = await Promise.allSettled([
                getSessions(agentDir),
                getWorkspaceCronTasks(agentDir),
                agentStatusPromise,
                getBackgroundSessions().catch(() => [] as string[]),
            ]);

            if (cancelled) return;

            // Always set sessions if available (primary data)
            if (sessionsResult.status === 'fulfilled') {
                setSessions(sessionsResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load sessions:', sessionsResult.reason);
                setSessions([]); // Show empty state rather than loading forever
            }

            // Cron tasks are optional enhancement - don't block on failure
            if (cronTasksResult.status === 'fulfilled') {
                setCronTasks(cronTasksResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load cron tasks:', cronTasksResult.reason);
                setCronTasks([]); // Fall back to no cron task indicators
            }

            // Agent statuses
            if (agentStatusResult.status === 'fulfilled') {
                setAgentStatuses(agentStatusResult.value);
            }

            // Background sessions
            if (bgSessionsResult.status === 'fulfilled') {
                setBackgroundSessionIds(bgSessionsResult.value);
            }
        })();

        return () => {
            cancelled = true;
            // Reset state when closing or agentDir changes
            setSessions(null);
            setCronTasks(null);
            setAgentStatuses({});
            setBackgroundSessionIds([]);
            setStatsSession(null);
            setPendingDelete(null);
            setDeleteError(null);
        };
    }, [isOpen, agentDir]);

    // Refetch when session title changes (auto-generated or user rename)
    useEffect(() => {
        if (!isOpen || !agentDir) return;
        const handler = () => {
            getSessions(agentDir).then(data => setSessions(data)).catch(() => {});
        };
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
    }, [isOpen, agentDir]);

    // Real-time tag updates: listen for cron/IM/agent status changes while dropdown is open
    useEffect(() => {
        if (!isOpen || !isTauriEnvironment()) return;
        const ac = new AbortController();

        // Cron task start/stop → refresh cron tasks (affects delete protection)
        const refreshCron = () => {
            getWorkspaceCronTasks(agentDir)
                .then(tasks => { if (!ac.signal.aborted) setCronTasks(tasks); })
                .catch(() => {});
        };
        void listenWithCleanup('cron:task-started', refreshCron, ac.signal);
        void listenWithCleanup('cron:task-stopped', refreshCron, ac.signal);

        // Agent status changes → refresh statuses
        const refreshStatuses = () => {
            import('@tauri-apps/api/core').then(({ invoke }) => {
                invoke<AgentStatusMap>('cmd_all_agents_status')
                    .then(s => { if (!ac.signal.aborted) setAgentStatuses(s); })
                    .catch(() => {});
            }).catch(() => {});
        };
        void listenWithCleanup('agent:status-changed', refreshStatuses, ac.signal);

        // Background completion → refresh background sessions
        void listenWithCleanup('session:background-complete', () => {
            getBackgroundSessions()
                .then(ids => { if (!ac.signal.aborted) setBackgroundSessionIds(ids); })
                .catch(() => {});
        }, ac.signal);

        return () => ac.abort();
    }, [isOpen, agentDir]);

    // Outside-click + Escape dismissal are owned by the Popover primitive.
    // The `handlePopoverClose` wrapper below blocks close propagation while
    // the stats modal is open — otherwise clicks inside the modal would
    // close the dropdown behind it.
    const handlePopoverClose = useCallback(() => {
        if (statsSessionRef.current) return;
        onClose();
    }, [onClose]);

    const handleDeleteClick = (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        e.preventDefault();
        setDeleteError(null); // Clear any previous error
        // Show centered ConfirmDialog (matches launcher RecentTasks UX). The
        // previous inline ✓ / ✗ overlay was buggy: its wrapper div carried both
        // `pointer-events-none` (the always-on hover-mask base) and
        // `pointer-events-auto` (the pending-delete override), and Tailwind's
        // CSS-source ordering made `none` win regardless of class-string
        // order, so the "确认" button rendered visible but was unclickable.
        // Routing through ConfirmDialog (modal portal, no parent
        // `pointer-events-none`) sidesteps the class-collision and lines this
        // surface up with the launcher's session-delete confirm.
        setPendingDelete({ id: session.id, title: session.title || '此对话' });
    };

    const handleConfirmDelete = async () => {
        if (!pendingDelete) return;
        const sessionId = pendingDelete.id;
        const isDeletingCurrentSession = sessionId === currentSessionId;
        setPendingDelete(null);
        setDeleteError(null);

        try {
            const success = await deleteSession(sessionId);
            if (success) {
                // Clean up Rust layer session activation state
                // This prevents stale entries in session_activations HashMap
                await deactivateSession(sessionId);

                setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);

                // If we deleted the current session, trigger "new conversation" behavior
                // Don't close the dropdown - keep it open so user can continue browsing history
                if (isDeletingCurrentSession) {
                    onDeleteCurrentSession(); // Reset to new conversation state
                }
            } else {
                setDeleteError('删除失败，请重试');
                console.error(`[SessionHistoryDropdown] Failed to delete session ${sessionId}`);
            }
        } catch (error) {
            setDeleteError('删除失败，请重试');
            console.error(`[SessionHistoryDropdown] Error deleting session ${sessionId}:`, error);
        }
    };

    const handleCancelDelete = () => {
        setPendingDelete(null);
    };

    const handleShowStats = (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: session.title });
    };

    // Per-session in-flight guard — rapid double-click on the same star
    // would otherwise fire two PATCHes whose responses can arrive out of
    // order, leaving the optimistic UI and the disk disagreeing on the
    // final state (Codex round-4).
    const favoriteInFlightRef = useRef<Set<string>>(new Set());

    const handleToggleFavorite = useCallback(async (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        if (favoriteInFlightRef.current.has(session.id)) return;
        favoriteInFlightRef.current.add(session.id);
        const next = !session.favorite;
        // Optimistic update: flip the in-memory copy first so the star icon
        // reacts instantly. On failure we revert + toast — better than an
        // awaitable click that "feels broken" on slow disk writes.
        setSessions(prev => prev?.map(s => s.id === session.id ? { ...s, favorite: next } : s) ?? prev);
        try {
            const result = await updateSession(session.id, { favorite: next });
            if (!result) {
                // updateSession returns null on caught error; revert + toast
                // (no synthetic throw — it just gets caught by the same
                // handler below for no UX gain, per Codex review).
                setSessions(prev => prev?.map(s => s.id === session.id ? { ...s, favorite: !next } : s) ?? prev);
                toast.error('收藏失败，请重试');
            }
        } catch (err) {
            console.error('[SessionHistoryDropdown] Toggle favorite failed:', err);
            setSessions(prev => prev?.map(s => s.id === session.id ? { ...s, favorite: !next } : s) ?? prev);
            toast.error('收藏失败，请重试');
        } finally {
            favoriteInFlightRef.current.delete(session.id);
        }
    }, [toast]);

    // Export session as .md file
    const [exportingId, setExportingId] = useState<string | null>(null);

    /** Extract text content from assistant message (stored as JSON array of content blocks) */
    const extractAssistantText = (content: string): string => {
        try {
            const blocks = JSON.parse(content);
            if (!Array.isArray(blocks)) return content;
            return blocks
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { text: string }) => b.text)
                .join('\n\n');
        } catch {
            // Plain string content (user messages or legacy format)
            return content;
        }
    };

    const handleExport = useCallback(async (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setExportingId(session.id);
        try {
            const data = await getSessionDetails(session.id);
            if (!data || data.messages.length === 0) {
                toast.error('该对话暂无内容可导出');
                return;
            }

            // Format timestamp: YYYY-MM-DD HH:mm:ss
            const fmtTs = (iso: string) => {
                const d = new Date(iso);
                const pad2 = (n: number) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
            };

            const lines: string[] = [];
            // Header
            const now = new Date();
            const pad2 = (n: number) => String(n).padStart(2, '0');
            const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
            lines.push(`<!-- Exported from MyAgents · ${dateStr} -->`);
            lines.push(`<!-- Session: ${data.title} -->`);
            lines.push('');

            for (const msg of data.messages) {
                const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
                const ts = fmtTs(msg.timestamp);
                lines.push(`[ ${roleLabel} | ${ts} ]`);
                lines.push('');
                const text = msg.role === 'assistant'
                    ? extractAssistantText(msg.content)
                    : msg.content;
                lines.push(text);
                lines.push('');
                lines.push('---');
                lines.push('');
            }

            const markdown = lines.join('\n');

            // File name: {date}_{title}.md — sanitize title for filename
            const safeTitle = data.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);
            const fileName = `${dateStr}_${safeTitle}.md`;

            // Trigger download via Blob URL (same pattern as UnifiedLogsPanel)
            const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);

            // Show global toast with full download path
            try {
                const { downloadDir, join: joinPath } = await import('@tauri-apps/api/path');
                const dlDir = await downloadDir();
                const fullPath = await joinPath(dlDir, fileName);
                toast.success(`已导出：${fullPath}`);
            } catch {
                // Fallback if Tauri path API unavailable (browser dev mode)
                toast.success(`已导出到下载目录：${fileName}`);
            }
        } catch {
            toast.error('导出失败，请重试');
        } finally {
            setExportingId(null);
        }
    }, [toast]);

    const formatTime = (isoString: string) => {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } else if (diffDays === 1) {
            return '昨天';
        } else if (diffDays < 7) {
            return `${diffDays}天前`;
        } else {
            return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        }
    };

    // Derive loading state: open but sessions not yet fetched
    const isLoading = sessions === null;

    return (
        <>
            <Popover
                open={isOpen}
                onClose={handlePopoverClose}
                anchorRef={triggerRef}
                placement="bottom-end"
                zIndex={50}
                className="w-96 bg-[var(--paper)] shadow-lg"
            >
                {/* Header */}
                <div className="border-b border-[var(--line)] px-4 py-2">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">历史记录</h3>
                </div>

                {/* Delete error toast */}
                {deleteError && (
                    <div className="border-b border-[var(--error)]/20 bg-[var(--error)]/10 px-4 py-2 text-xs text-[var(--error)]">
                        {deleteError}
                    </div>
                )}

                {/* Session list */}
                <div className="max-h-80 overflow-y-auto">
                    {isLoading ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            加载中...
                        </div>
                    ) : sessions.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            暂无历史记录
                        </div>
                    ) : (
                        sortedSessions.map((session) => {
                            const isCurrent = session.id === currentSessionId;
                            const tags = sessionTagsMap.get(session.id) ?? [];
                            const stats = session.stats;
                            const hasStats = stats && (stats.messageCount > 0 || stats.totalInputTokens > 0);
                            const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0);

                            const cronProtected = tags.some(t => t.type === 'cron');
                            return (
                                <div
                                    key={session.id}
                                    className={`group relative cursor-pointer transition-colors ${isCurrent
                                        ? 'bg-[var(--accent)]/10'
                                        : 'hover:bg-[var(--hover-bg)]'
                                        }`}
                                    onClick={() => {
                                        if (!isCurrent) {
                                            onSelectSession(session.id);
                                            onClose();
                                        }
                                    }}
                                >
                                    {/* Row body — content extends to right edge in default state.
                                     *  Action buttons live in the absolute overlay below so they
                                     *  don't reserve layout space when not hovered (用户反馈：
                                     *  默认背景的 item 信息应该一致延伸到右边线). */}
                                    <div className="flex items-start gap-3 px-4 py-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                {isCurrent && (
                                                    <span className="flex-shrink-0 rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                                                        当前
                                                    </span>
                                                )}
                                                {tags.map((tag, i) => (
                                                    <SessionTagBadge key={i} tag={tag} />
                                                ))}
                                                <span className={`truncate text-sm ${isCurrent ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                                    {session.title}
                                                </span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                                                <span className="flex items-center gap-1">
                                                    <Clock className="h-3 w-3" />
                                                    {formatTime(session.lastActiveAt)}
                                                </span>
                                                {hasStats && (
                                                    <>
                                                        <span>·</span>
                                                        <span>{stats.messageCount} 条消息</span>
                                                        <span>·</span>
                                                        <span>{formatTokens(totalTokens)} tokens</span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Hover overlay — gradient mask + action buttons. Confirm-delete
                                     *  is now a centered modal (ConfirmDialog at the bottom of this
                                     *  component), so the overlay only handles the per-row action
                                     *  toolbar. The previous inline ✓/✗ branch was bug-prone — its
                                     *  wrapper carried both `pointer-events-none` (the always-on
                                     *  base) and `pointer-events-auto` (the pending-delete override),
                                     *  and Tailwind's CSS-source ordering let `none` win, leaving
                                     *  the "确认" button visible-but-unclickable. */}
                                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                                        <div className="h-full w-10 bg-gradient-to-r from-transparent to-[var(--paper-inset)]" />
                                        <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                                            <Tip label={session.favorite ? '取消收藏' : '收藏'} position="bottom">
                                                <button
                                                    aria-label={session.favorite ? '取消收藏' : '收藏'}
                                                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)] ${
                                                        session.favorite
                                                            ? 'text-[var(--accent)]'
                                                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                                    }`}
                                                    onClick={(e) => { void handleToggleFavorite(e, session); }}
                                                >
                                                    <Star className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />
                                                </button>
                                            </Tip>
                                            <Tip label="导出对话内容为 md 文件" position="bottom">
                                                <button
                                                    aria-label="导出"
                                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                                    onClick={(e) => { void handleExport(e, session); }}
                                                    disabled={exportingId === session.id}
                                                >
                                                    <Download className="h-3.5 w-3.5" />
                                                </button>
                                            </Tip>
                                            <Tip label="查看统计" position="bottom">
                                                <button
                                                    aria-label="查看统计"
                                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                                    onClick={(e) => handleShowStats(e, session)}
                                                >
                                                    <BarChart2 className="h-3.5 w-3.5" />
                                                </button>
                                            </Tip>
                                            {cronProtected ? (
                                                <Tip label="请先停止循环任务后再删除" position="bottom">
                                                    <button
                                                        aria-label="删除（请先停止循环任务）"
                                                        className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-md text-[var(--ink-muted)] opacity-40"
                                                        disabled
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </Tip>
                                            ) : (
                                                <Tip label="删除" position="bottom">
                                                    <button
                                                        aria-label="删除"
                                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                                        onClick={(e) => handleDeleteClick(e, session)}
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </Tip>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </Popover>

            {/* ConfirmDialog self-portals to document.body, so no outer
             *  createPortal wrapper is needed — the dialog already escapes
             *  any ancestor stacking context to beat FloatingPortal z-50. */}
            {pendingDelete && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定要删除「${pendingDelete.title}」吗？此操作不可撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={handleCancelDelete}
                />
            )}

            {/* Stats Modal — portal to document root to escape stacking context */}
            {statsSession && createPortal(
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />,
                document.body,
            )}
        </>
    );
}
