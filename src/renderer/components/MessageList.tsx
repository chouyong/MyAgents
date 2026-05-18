import { Loader2 } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';

import Message from '@/components/Message';
import { PermissionPrompt, type PermissionRequest } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt, type AskUserQuestionRequest } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { Message as MessageType } from '@/types/chat';
import type { SessionState } from '@/context/TabContext';

function formatElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟${seconds}秒`;
  if (minutes > 0) return `${minutes}分钟${seconds}秒`;
  return `${seconds}秒`;
}

interface MessageListProps {
  historyMessages: MessageType[];
  streamingMessage: MessageType | null;
  isLoading: boolean;
  isSessionLoading?: boolean;
  sessionId?: string | null;
  /**
   * Whether this Tab is currently visible. When `false`, the host wraps this
   * subtree in `content-visibility: hidden`, which lets WebKit defer/skip
   * descendant layout. Virtuoso's ResizeObserver can then fire with zero or
   * stale geometry and erroneously emit `atBottomStateChange(false)` —
   * corrupting the follow-state machine. We use this flag to (a) ignore
   * those bogus measurements and (b) re-pin scroll to bottom on re-activation
   * if we were following before the tab went hidden.
   */
  isActive?: boolean;
  // Pagination: Virtuoso maintains the visible scroll position across
  // prepended items by the absolute index of data[0]. Default 0 = no pagination.
  firstItemIndex?: number;
  /** Fires when Virtuoso reaches the top — time to load an older page. */
  onLoadOlder?: () => void;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  followEnabledRef: React.MutableRefObject<boolean | 'force'>;
  /** Drives the session-switch scroll pin — goes through the hook so grace/degrade state stays consistent. */
  scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  handleAtBottomChange: (atBottom: boolean) => void;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  pendingExitPlanMode?: ExitPlanModeRequest | null;
  onExitPlanModeApprove?: () => void;
  onExitPlanModeReject?: (feedback?: string) => void;
  systemStatus?: string | null;
  isStreaming?: boolean;
  /**
   * (issue #174) Pulled in so the loading footer can swap the random
   * "苦思冥想中…" thinking line for an explicit "AI 启动中…" hint while the
   * SDK subprocess is alive but system_init hasn't arrived. Without this
   * the user can't tell whether the long wait is startup or actual work.
   */
  sessionState?: SessionState;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
}

const STREAMING_MESSAGES = [
  '苦思冥想中…', '深思熟虑中…', '灵光一闪中…', '绞尽脑汁中…', '思绪飞速运转中…',
  '小脑袋瓜转啊转…', '神经元疯狂放电中…', '灵感小火花碰撞中…', '正在努力组织语言…',
  '在知识海洋里捞答案…', '正在翻阅宇宙图书馆…', '答案正在酝酿中…', '灵感咖啡冲泡中…',
  '递归思考中，请勿打扰…', '正在遍历可能性…', '加载智慧模块中…',
  '容我想想…', '稍等，马上就好…', '别急，好饭不怕晚…', '正在认真对待你的问题…',
];
const SYSTEM_STATUS_MESSAGES: Record<string, string> = {
  compacting: '会话内容过长，智能总结中…',
  rewinding: '正在时间回溯中，请稍等…',
};

/** Resolve dynamic system status keys (e.g., api_retry:2:5 → human-readable) */
function resolveSystemStatus(status: string): string {
  if (SYSTEM_STATUS_MESSAGES[status]) return SYSTEM_STATUS_MESSAGES[status];
  // API retry: "api_retry:{attempt}:{maxAttempts}"
  if (status.startsWith('api_retry:')) {
    const parts = status.split(':');
    const attempt = parts[1] || '1';
    const max = parts[2] || '?';
    return `API 请求重试中（第 ${attempt}/${max} 次）…`;
  }
  return status;
}
function getRandomStreamingMessage(): string {
  return STREAMING_MESSAGES[Math.floor(Math.random() * STREAMING_MESSAGES.length)];
}

const StatusTimer = memo(function StatusTimer({ message }: { message: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);
  useEffect(() => {
    startTimeRef.current = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{message}{elapsedSeconds > 0 && ` (${formatElapsedTime(elapsedSeconds)})`}</span>
    </div>
  );
});

function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false;
  return message.content.some(
    block => (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.name === 'ExitPlanMode'
  );
}

// ── Virtuoso Footer — memo'd component that reads dynamic values from refs ──
// Must NOT be recreated on every render (inline arrow in `components` causes Virtuoso
// to remount the footer, resetting StatusTimer and forcing extra remeasurement).
const VirtuosoFooter = memo(function VirtuosoFooter({
  pendingPermission, onPermissionDecision,
  pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel,
  showStatus, statusMessage,
}: {
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  showStatus: boolean;
  statusMessage: string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-3">
      {pendingPermission && onPermissionDecision && (
        <div className="py-2">
          <PermissionPrompt request={pendingPermission} onDecision={(_id, d) => onPermissionDecision(d)} />
        </div>
      )}
      {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
        <div className="py-2">
          <AskUserQuestionPrompt request={pendingAskUserQuestion} onSubmit={onAskUserQuestionSubmit} onCancel={onAskUserQuestionCancel} />
        </div>
      )}
      {showStatus && <StatusTimer message={statusMessage} />}
      {/* Footer spacer: 既给 floating input 让位（~128px），也给 AgentStatusPanel
          展开态（最多 ~240px）预留 clearance，避免完全遮住末条消息。 */}
      <div style={{ height: 360 }} aria-hidden="true" />
    </div>
  );
});

// ── No custom Scroller/List components ──
// Tested: custom Scroller (py-3 padding) and List (mx-auto max-w-3xl) break Virtuoso's
// internal height tracking — scrollHeight diverges from totalListHeight by 12,000+ px,
// causing phantom repeated content. Styling is applied inside itemContent instead.

const MessageList = memo(function MessageList({
  historyMessages,
  streamingMessage,
  isLoading,
  isSessionLoading,
  sessionId,
  isActive = true,
  firstItemIndex,
  onLoadOlder,
  virtuosoRef,
  onScrollerRef,
  followEnabledRef,
  scrollToBottom,
  handleAtBottomChange,
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  pendingExitPlanMode,
  onExitPlanModeApprove,
  onExitPlanModeReject,
  systemStatus,
  isStreaming,
  sessionState,
  onRewind,
  onRetry,
  onFork,
}: MessageListProps) {
  const allMessages = useMemo(() =>
    streamingMessage ? [...historyMessages, streamingMessage] : historyMessages,
    [historyMessages, streamingMessage]
  );

  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyMessages.length]
  );

  // ExitPlanMode
  const exitPlanModeAnchorId = useMemo(() => {
    if (!pendingExitPlanMode) return null;
    if (streamingMessage && hasExitPlanModeTool(streamingMessage)) return streamingMessage.id;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      if (hasExitPlanModeTool(historyMessages[i])) return historyMessages[i].id;
    }
    return null;
  }, [pendingExitPlanMode, streamingMessage, historyMessages]);
  const exitPlanModeSlot = useMemo(() => {
    if (!pendingExitPlanMode || !onExitPlanModeApprove || !onExitPlanModeReject) return undefined;
    return (
      <div className="py-2">
        <ExitPlanModePrompt key={pendingExitPlanMode.requestId} request={pendingExitPlanMode} onApprove={onExitPlanModeApprove} onReject={onExitPlanModeReject} />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  const showStatus = isLoading || !!systemStatus;
  // (issue #174) During 'starting' the SDK subprocess is alive but hasn't
  // sent system_init — the random "苦思冥想中…" line would falsely imply the
  // model is already thinking. Surface a startup-specific hint instead.
  // systemStatus (e.g. compacting / api_retry) still wins because it carries
  // a more specific signal that overrides both starting and the generic
  // thinking line.
  const statusMessage = systemStatus
    ? resolveSystemStatus(systemStatus)
    : sessionState === 'starting'
      ? 'AI 启动中…（首次启动可能较慢）'
      : streamingStatusMessage;

  // Fade-in
  const wasSessionLoadingRef = useRef(false);
  const [fadeIn, setFadeIn] = useState(false);
  useEffect(() => {
    if (isSessionLoading) { wasSessionLoadingRef.current = true; setFadeIn(false); }
    else if (wasSessionLoadingRef.current) { wasSessionLoadingRef.current = false; setFadeIn(true); }
  }, [isSessionLoading]);

  // Scroll to bottom after session load / switch. Runs synchronously before
  // the next paint so there's no visible top→bottom jump when the new session's
  // data prop arrives — critical now that Virtuoso stays mounted across switches
  // (see the note below about removing `key={sessionId}`). Routes through the hook's
  // scrollToBottom('auto') so the force/grace/auto-degrade state machine stays in one
  // place — writing `followEnabledRef.current = 'force'` inline would leak force into
  // subsequent content changes without the safety timer.
  const lastScrolledSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!sessionId || sessionId === lastScrolledSessionRef.current) return;
    if (allMessages.length === 0) return;
    lastScrolledSessionRef.current = sessionId;
    scrollToBottom('auto');
  }, [sessionId, allMessages.length, scrollToBottom]);

  // Tab inactive ↔ active follow-state preservation.
  //
  // While inactive, the host wraps us in `content-visibility: hidden`. WebKit
  // skips descendant layout, so Virtuoso's ResizeObserver and internal bottom-
  // detection math can fire with zero/stale geometry. The `guardedAtBottomChange`
  // below catches the common case (atBottom callback fired while !isActive), but
  // there are timing windows around the inactive↔active transition itself where a
  // queued callback can race with the React re-render and slip through with the
  // wrong closure. Once `followEnabledRef` flips to `false`, the previous "skip
  // recovery if not following" guard would silently drop us out of follow mode
  // permanently for this stream — exactly the user-reported bug.
  //
  // Pit-of-success fix: snapshot the live follow state at the precise moment the
  // tab goes inactive (when measurements are still trustworthy and the user's
  // intent is unambiguous), then on re-activation restore the snapshot and re-pin
  // to bottom if the snapshot says we were following. This makes recovery
  // independent of whatever happens to `followEnabledRef` during the hidden
  // window — even if a stale observer flips it, the snapshot is authoritative.
  // 'force' is normalized to `true` because force is a transient programmatic
  // state; restoring it would re-enter `force` with no scrollToBottom call to
  // back it up, defeating the auto-degrade timer.
  const inactiveSnapshotRef = useRef<boolean | 'force' | null>(null);
  useLayoutEffect(() => {
    if (!isActive) {
      if (inactiveSnapshotRef.current === null) {
        const cur = followEnabledRef.current;
        inactiveSnapshotRef.current = cur === 'force' ? true : cur;
      }
      return;
    }
    const snap = inactiveSnapshotRef.current;
    if (snap === null) return; // initial mount or no inactive transition recorded
    inactiveSnapshotRef.current = null;
    // Restore from snapshot regardless of branch — both directions need to overwrite
    // whatever the live ref currently says. If `snap === false` we restore `false`
    // explicitly: a stale atBottom(true) callback during the hidden window could
    // have flipped the live ref to `true`, which would silently re-engage follow
    // mode against the user's actual intent (they had scrolled up before leaving).
    followEnabledRef.current = snap;
    // User had scrolled up before switching away — respect that, leave scroll alone.
    if (snap === false) return;
    // User was at bottom before switching away. Re-pin to actual scroll bottom.
    // scrollToBottom() flips the ref to 'force' + arms grace/auto-degrade timer.
    if (allMessages.length > 0) {
      scrollToBottom('auto');
    }
  }, [isActive, allMessages.length, scrollToBottom, followEnabledRef]);

  // Gate Virtuoso's atBottomStateChange while the tab is hidden.
  // content-visibility: hidden lets WebKit deliver ResizeObserver callbacks
  // with zero/stale dimensions, which would otherwise be interpreted as
  // "user scrolled away" and flip followEnabledRef.current to false — losing
  // bottom-pinning permanently for this stream.
  const guardedAtBottomChange = useCallback((atBottom: boolean) => {
    if (!isActive) return;
    handleAtBottomChange(atBottom);
  }, [isActive, handleAtBottomChange]);

  // ── Auto-scroll during streaming — throttled to ~20fps (48ms) ──
  // followOutput only fires on count change. During streaming the last message keeps
  // growing taller. autoscrollToBottom() handles this (scrolls only if already at bottom).
  //
  // Without throttling, autoscrollToBottom() fires on every SSE chunk (~60fps via RAF).
  // Combined with Virtuoso's internal ResizeObserver + scroll correction loop, this causes
  // visible position jitter in footer elements. Throttling to 20fps reduces the correction
  // frequency while keeping scroll tracking visually smooth.
  const scrollRafRef = useRef(0);
  const lastScrollTimeRef = useRef(0);
  const trailingScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!streamingMessage || !followEnabledRef.current) return;
    // Skip while hidden — autoscrollToBottom() against a content-visibility:
    // hidden scroller can compute against stale geometry. The re-pin layout
    // effect above restores position on re-activation.
    if (!isActive) return;

    const THROTTLE_MS = 48; // ~20fps
    const now = performance.now();
    const elapsed = now - lastScrollTimeRef.current;

    // Cancel any pending leading-edge RAF
    cancelAnimationFrame(scrollRafRef.current);

    if (elapsed >= THROTTLE_MS) {
      // Leading edge: enough time passed, scroll now
      lastScrollTimeRef.current = now;
      if (trailingScrollRef.current) { clearTimeout(trailingScrollRef.current); trailingScrollRef.current = null; }
      scrollRafRef.current = requestAnimationFrame(() => {
        virtuosoRef.current?.autoscrollToBottom();
      });
    } else if (!trailingScrollRef.current) {
      // Trailing edge: schedule scroll after remaining throttle window
      trailingScrollRef.current = setTimeout(() => {
        trailingScrollRef.current = null;
        lastScrollTimeRef.current = performance.now();
        scrollRafRef.current = requestAnimationFrame(() => {
          virtuosoRef.current?.autoscrollToBottom();
        });
      }, THROTTLE_MS - elapsed);
    }

    return () => {
      cancelAnimationFrame(scrollRafRef.current);
      if (trailingScrollRef.current) { clearTimeout(trailingScrollRef.current); trailingScrollRef.current = null; }
    };
  }, [streamingMessage, isActive, followEnabledRef, virtuosoRef]);

  // ── Refs for stable callbacks — avoid recreating itemContent/Footer on every render ──
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;
  const onRewindRef = useRef(onRewind);
  onRewindRef.current = onRewind;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;

  const handleFollowOutput = useMemo(
    () => (isAtBottom: boolean) => {
      const mode = followEnabledRef.current;
      if (!mode) return false;
      if (mode === 'force') return 'smooth' as const;
      return isAtBottom ? 'smooth' as const : false;
    },
    [followEnabledRef]
  );

  // ── Stable itemContent — reads ALL dynamic values from refs, never recreated ──
  // eslint-disable-next-line react/display-name
  const renderItem = useMemo(() => (index: number, message: MessageType) => {
    const sm = streamingMessageRef.current;
    const isStreamingMsg = !!sm && message === sm;
    // `flow-root` (not `overflow-hidden`) establishes a BFC so child Markdown
    // margins don't leak past the wrapper — that's what e6de7173 originally
    // wanted. `overflow-hidden` did the same job but added a hard clip side
    // effect: when Virtuoso's height estimate (`defaultItemHeight=480`) was
    // far from actual short-item height (~80px), the post-mount measurement
    // correction shifted scroll anchors enough that short user bubbles got
    // visually clipped instead of merely positioned slightly off — they
    // disappeared while neighbouring items merged. flow-root keeps the
    // measurement fix without the clipping.
    return (
      <div
        className="mx-auto max-w-3xl px-3 py-1 flow-root"
        data-chat-search-scope=""
        data-message-id={message.id}
      >
        <Message
          message={message}
          isLoading={isStreamingMsg && isLoadingRef.current}
          onRewind={onRewindRef.current}
          onRetry={onRetryRef.current}
          onFork={onForkRef.current}
          exitPlanModeSlot={message.id === exitPlanModeAnchorIdRef.current ? exitPlanModeSlotRef.current : undefined}
        />
      </div>
    );
  }, []);

  // ── Stable computeItemKey ──
  const computeItemKey = useMemo(() => (_i: number, m: MessageType) => m.id, []);

  // ── Stable Footer wrapper — useMemo keeps component identity stable for Virtuoso ──
  const FooterComponent = useMemo(() => {
    return function Footer() {
      return (
        <VirtuosoFooter
          pendingPermission={pendingPermission}
          onPermissionDecision={onPermissionDecision}
          pendingAskUserQuestion={pendingAskUserQuestion}
          onAskUserQuestionSubmit={onAskUserQuestionSubmit}
          onAskUserQuestionCancel={onAskUserQuestionCancel}
          showStatus={showStatus}
          statusMessage={statusMessage}
        />
      );
    };
  }, [pendingPermission, onPermissionDecision, pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel, showStatus, statusMessage]);

  // ── Stable components object ──
  const components = useMemo(() => ({ Footer: FooterComponent }), [FooterComponent]);

  return (
    <div
      className="relative flex-1"
      data-streaming={isStreaming || undefined}
      style={fadeIn ? { animation: 'message-list-fade-in 600ms ease-out both' } : undefined}
      onAnimationEnd={() => setFadeIn(false)}
    >
      {isSessionLoading && allMessages.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ paddingBottom: 140 }}>
          <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>加载对话记录…</span>
          </div>
        </div>
      )}

      {/*
        Virtuoso stays mounted across session switches. Previously `key={sessionId}`
        forced a full remount, which dropped every cached item height, rebuilt
        every ResizeObserver, and kicked off a measure→reflow→remeasure storm on
        large sessions — the single biggest contributor to "click a notification,
        come back, UI frozen for 3-5s". Now session changes are a pure data swap:
        `computeItemKey={m.id}` ensures Virtuoso reconciles items by identity,
        and the useLayoutEffect above lands the scroll on the last item in a
        single pre-paint call. Heights are recomputed lazily as items come into
        view, not up front.

        defaultItemHeight=480 is an empirical average across tool-use / text /
        thinking blocks; too low (200) causes Virtuoso to over-render initially,
        too high leaves holes at the bottom. 480 stays close to long-content
        reality but does produce sizeable post-mount corrections on short user
        bubbles (~80–150px). The previous wrapper used `overflow-hidden`, which
        amplified those corrections into hard clips — short bubbles vanished
        while neighbours merged. The wrapper is now `flow-root` (above), so any
        residual correction shows up as a small scroll bounce rather than a
        disappearing message. If the bounce becomes noticeable, lowering this
        estimate is the next lever to pull.
      */}
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={onScrollerRef}
        data={allMessages}
        computeItemKey={computeItemKey}
        firstItemIndex={firstItemIndex}
        startReached={onLoadOlder}
        followOutput={handleFollowOutput}
        atBottomStateChange={guardedAtBottomChange}
        atBottomThreshold={50}
        defaultItemHeight={480}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        className="h-full"
        style={{ overscrollBehavior: 'none' }}
        components={components}
        itemContent={renderItem}
      />
    </div>
  );
});

export default MessageList;
