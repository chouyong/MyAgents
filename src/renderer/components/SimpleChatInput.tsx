import { AlertCircle, ChevronUp, Loader, Paperclip, Plus, Send, Square, X, FileText, AtSign, Wrench, Timer, Settings2, Unlock } from 'lucide-react';
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';

import Tip from '@/components/Tip';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { ModalityBadges } from '@/components/ModalityBadges';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { type SessionState } from '@/context/TabContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { type PermissionMode, PERMISSION_MODES, type Provider, type ProviderVerifyStatus, getModelDisplayName } from '@/config/types';
import SlashCommandMenu, { type SlashCommand, filterAndSortCommands } from './SlashCommandMenu';
import QueuedMessagesPanel from './QueuedMessageBubble';
import CronTaskStatusBar from './cron/CronTaskStatusBar';
import CronTaskOverlay from './cron/CronTaskOverlay';
import { useUndoStack } from '@/hooks/useUndoStack';
import { isImageFile, isImageMimeType, ALLOWED_IMAGE_MIME_TYPES } from '../../shared/fileTypes';
import type { QueuedMessageInfo } from '@/types/queue';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { isDebugMode } from '@/utils/debug';
import { renameIfBareClipboardImage } from '@/utils/clipboardImage';
import { isProviderAvailable } from '@/config/configService';
import { modelSupportsModality } from '@/config/services/providerService';
import RuntimeSelector from '@/components/RuntimeSelector';
import { Popover } from '@/components/ui/Popover';
import type { RuntimeType, RuntimeDetections } from '../../shared/types/runtime';
import { thoughtList, taskCenterAvailable } from '@/api/taskCenter';
import type { Thought } from '@/../shared/types/thought';
import {
  findHighlightRanges,
  renderTextWithHighlights,
} from '@/utils/highlightSearchMatches';

// ===== Module-level pure helpers (extracted from render body) =====

/** Check if a provider has a warning (key set but verification failed) */
function isProviderWarning(
  p: Provider,
  apiKeys: Record<string, string>,
  verifyStatus: Record<string, ProviderVerifyStatus>,
): boolean {
  if (p.type === 'subscription') return false;
  return !!apiKeys[p.id] && verifyStatus[p.id]?.status === 'invalid';
}

/**
 * Resolve the human-friendly label for the current model — display name from
 * the provider's model list if known, else the raw ID, else a generic
 * fallback. Used by modality toasts so the message names the actual model
 * the user picked.
 */
function getCurrentModelLabel(
  provider: Provider | null | undefined,
  modelId: string | undefined,
): string {
  if (!modelId) return '当前模型';
  return provider ? getModelDisplayName(provider, modelId) : modelId;
}


/**
 * Bug #123 guardrail — detect pathological content duplication that almost
 * certainly came from a third-party IME / voice-input glitch on macOS WebView
 * (WeChat 输入法 has been observed writing recognized speech into the
 * controlled textarea dozens of times, producing 77K-char messages on a
 * single Enter). We can't fix the IME / WebKit composition behavior itself,
 * so the input layer adds a confirm step before such content goes out.
 *
 * Two complementary checks (returns the repeat count when either flags):
 *
 *   A. Delimiter-split segment frequency. Split on whitespace + Chinese/English
 *      punctuation, take segments of length >= 10, flag when the top segment
 *      repeats >= 5 times AND covers >= 50% of total length. Catches the
 *      common voice-recognition case where punctuation is interleaved between
 *      duplicates.
 *
 *   B. Prefix-repetition fallback for delimiter-free runs. Voice recognition
 *      sometimes produces continuous CJK text without inserted punctuation;
 *      then check A finds segments.length <= 1 and misses. Sample candidate
 *      block lengths (50/100/200 chars), count occurrences of the leading
 *      block, and flag with the same coverage threshold.
 *
 * Tuned so normal repetition ("yes yes yes" — segments too short, prefix
 * doesn't repeat) and ordinary long pastes (no single dominant segment or
 * prefix block) do NOT trigger.
 */
function detectExcessiveRepetition(text: string): number {
  if (text.length < 1000) return 0;

  // Check A — delimiter-split segment frequency.
  const segments = text
    .split(/[\s。！？；;.!?，,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
  if (segments.length >= 5) {
    const counts = new Map<string, number>();
    for (const s of segments) counts.set(s, (counts.get(s) ?? 0) + 1);
    let topCount = 0;
    let topLength = 0;
    for (const [seg, c] of counts) {
      if (c > topCount) {
        topCount = c;
        topLength = seg.length;
      }
    }
    const coverage = (topLength * topCount) / text.length;
    if (topCount >= 5 && coverage >= 0.5) return topCount;
  }

  // Check B — prefix-repetition fallback (delimiter-free duplication).
  for (const blockLen of [50, 100, 200]) {
    if (text.length < blockLen * 5) continue;
    const block = text.slice(0, blockLen);
    let count = 0;
    let pos = 0;
    while (true) {
      const next = text.indexOf(block, pos);
      if (next === -1) break;
      count++;
      pos = next + blockLen;
    }
    if (count >= 5 && count * blockLen >= text.length * 0.5) return count;
  }

  return 0;
}

// Image attachment type
export interface ImageAttachment {
  id: string;
  file: File;
  preview: string; // data URL for preview
}

interface SimpleChatInputProps {
  /** Optional external value for controlled scenarios (e.g., restoring draft) */
  value?: string;
  /** Optional callback when value changes - not recommended for performance reasons */
  onChange?: (value: string) => void;
  /** Called when user sends message. Text is managed internally for performance.
   *  Return false to indicate rejection (input will NOT be cleared). */
  onSend: (text: string, images?: ImageAttachment[], permissionMode?: PermissionMode) => boolean | void | Promise<boolean | void>;
  /**
   * Whether this input belongs to the currently active tab. Reserved for
   * features that want to ignore keystrokes on background tabs.
   */
  active?: boolean;
  onStop?: () => void; // Called when stop button is clicked
  isLoading: boolean;
  /** Workspace path that anchors workspace_files invokes — file upload, @ mention,
   *  / slash command listing. Required for those features to work in launcher
   *  mode (chat-tab passes this in via the agentDir prop, launcher via the
   *  selected workspace). When null/undefined the input still renders but those
   *  features error toast if the user tries them. (PRD 0.2.7) */
  workspacePath?: string | null;
  /** Session state for stop button UI ('stopping' shows disabled spinner) */
  sessionState?: SessionState;
  /** System status (e.g., 'compacting') - when set, shows disabled send button instead of stop */
  systemStatus?: string | null;
  agentDir?: string; // For @file search
  // Provider/Model selection
  provider?: Provider | null; // Current provider for model selection
  providers?: Provider[]; // All available providers for switching
  onProviderChange?: (providerId: string, targetModel?: string) => void; // Called when provider is changed (with optional model to set atomically)
  selectedModel?: string; // Current selected model ID
  onModelChange?: (modelId: string) => void; // Called when model is changed
  /**
   * v0.1.69: true when session exists but has no snapshot (legacy pre-v0.1.69 session).
   * Renders an "unlocked" indicator next to the model button so the user knows changes
   * to the agent defaults will affect this session (live-follow vs snapshot-frozen).
   */
  sessionUnlocked?: boolean;
  // Permission modes
  permissionMode?: PermissionMode; // Current permission mode from parent
  onPermissionModeChange?: (mode: PermissionMode) => void;
  apiKeys?: Record<string, string>; // API keys for providers
  providerVerifyStatus?: Record<string, ProviderVerifyStatus>; // Persisted verification status
  /** External ref for focus control (used for Tab switching) */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  // MCP workspace toggle
  workspaceMcpEnabled?: string[];  // IDs of MCPs enabled for this workspace
  globalMcpEnabled?: string[];     // IDs of globally enabled MCPs
  mcpServers?: Array<{ id: string; name: string; description?: string }>; // All available MCP servers
  onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
  // PRD 0.2.17 — Claude Plugins. Same two-layer model as MCP:
  //   globallyVisiblePlugins = AppConfig.enabledPlugins (Settings 开关 ON)
  //   workspaceEnabledPlugins = subset actually enabled for this Agent/session
  globallyVisiblePlugins?: Array<{
    id: string;
    name: string;
    description?: string;
    /** MCP server names that this plugin contributes (auto-loaded by SDK
     *  when plugin is enabled). Shown as a subtitle so the user knows what
     *  tools are coming along for the ride. */
    mcpServerNames?: string[];
  }>;
  workspaceEnabledPlugins?: string[];
  onWorkspacePluginToggle?: (pluginId: string, enabled: boolean) => void;
  /** Callback to refresh providers data when opening model menu */
  onRefreshProviders?: () => void;
  /** Callback to open Agent settings (WorkspaceConfigPanel) */
  onOpenAgentSettings?: () => void;
  /** Callback to refresh workspace after files are added */
  onWorkspaceRefresh?: () => void;
  // Cron task props
  /** Whether cron mode is currently enabled (before task starts) */
  cronModeEnabled?: boolean;
  /** Cron task config (for status bar display) */
  cronConfig?: {
    intervalMinutes: number;
    schedule?: import('@/types/cronTask').CronSchedule;
  } | null;
  /** Active cron task (for overlay display) */
  cronTask?: {
    status: 'running' | 'paused' | 'stopped' | 'completed';
    intervalMinutes: number;
    schedule?: import('@/types/cronTask').CronSchedule;
    executionCount: number;
    lastExecutedAt?: string;
    endConditions?: {
      maxExecutions?: number;
    };
  } | null;
  /** Callback when cron button is clicked */
  onCronButtonClick?: () => void;
  /** Callback when cron settings button is clicked (from status bar or overlay) */
  onCronSettings?: () => void;
  /** Callback when cron is cancelled (from status bar X button) */
  onCronCancel?: () => void;
  /** Callback when cron task is stopped */
  onCronStop?: () => void;
  /** Callback when input text changes (for cron prompt tracking) */
  onInputChange?: (text: string) => void;
  /** Display mode: 'chat' (default) or 'launcher' (hides @/slash/cron features) */
  mode?: 'chat' | 'launcher';
  /** Optional ReactNode rendered at the start of the toolbar (e.g., workspace selector in launcher) */
  toolbarPrefix?: React.ReactNode;
  // Agent Runtime (v0.1.59)
  runtime?: RuntimeType;
  runtimeDetections?: RuntimeDetections;
  onRuntimeChange?: (runtime: RuntimeType) => void;
  runtimeModels?: import('../../shared/types/runtime').RuntimeModelInfo[];
  runtimePermissionModes?: import('../../shared/types/runtime').RuntimePermissionMode[];
  // Queued messages props
  queuedMessages?: QueuedMessageInfo[];
  onCancelQueued?: (queueId: string) => void;
  onForceExecuteQueued?: (queueId: string) => void;
}

// Used when the slash command service is unavailable (browser dev mode) or
// returns empty. Mirrors the Rust BUILTIN_SLASH_COMMANDS table at
// `src-tauri/src/workspace_files/slash.rs`.
const BUILTIN_FALLBACK_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
  { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
  { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
  { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
  { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
  { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
  { name: 'review', description: '对代码进行审查', source: 'builtin' },
  { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
];

const LINE_HEIGHT = 26; // px per line (text-base 16px * leading-relaxed 1.625 = 26px)
// Auto-grow ceiling. Past this row count the textarea scrolls internally;
// before it, the resize effect below tracks scrollHeight on every keystroke.
const MAX_LINES = 9;
// Launcher shows the input as the page's primary affordance — an extra row
// (3 vs 2) reduces visual compression and signals "there's room to write a
// full thought", matching the spacious Launcher layout. Chat tabs keep the
// 2-row default to preserve screen real estate for the message stream.
const LAUNCHER_MIN_LINES = 3;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// Methods exposed to parent via ref
export interface SimpleChatInputHandle {
  /** Process dropped files - copies to myagents_files and inserts @references */
  processDroppedFiles: (files: File[]) => Promise<void>;
  /** Process dropped file paths from Tauri - copies to myagents_files and inserts @references */
  processDroppedFilePaths?: (paths: string[]) => Promise<void>;
  /** Insert @references at cursor position or end of input */
  insertReferences: (paths: string[]) => void;
  /** Append a single reference token (e.g. `@path` or `@path#L7-L10`) to the END of input
   *  with auto-padded leading space and a guaranteed trailing space. Cursor lands at end,
   *  textarea scrolls to show the appended token. Used by file preview "引用文件" /
   *  selection-quote — distinct from `insertReferences` which inserts at cursor without
   *  trailing space. */
  appendReferenceToken: (token: string) => void;
  /** Insert a /slash-command at cursor position or end of input */
  insertSlashCommand: (command: string) => void;
  /** Set the input value directly (used for restoring content after cron stop) */
  setValue: (value: string) => void;
  /** Set image attachments directly (used for restoring queued message images on cancel) */
  setImages: (images: ImageAttachment[]) => void;
  /** Programmatically focus the textarea. Used by the Launcher's mode
   *  switcher so the caret lands in the input the moment the user
   *  clicks 任务 / 想法 — no second click required. */
  focus: () => void;
  /** Strip `@myagents_files/...` references from the textarea and clear the
   *  `images[]` attachments. Used by the launcher when the user switches
   *  workspaces — the references and physical files belonged to the
   *  previous workspace and would either be dead links (best case) or, if a
   *  same-named file existed in the new workspace, point to the wrong file.
   *  Returns the count of stripped references so the caller can decide
   *  whether to surface a toast (PRD 0.2.7 D3). */
  clearWorkspaceBoundDraft: () => { strippedReferences: number; clearedImages: number };
}

// File search result type
interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

const SimpleChatInput = memo(forwardRef<SimpleChatInputHandle, SimpleChatInputProps>(function SimpleChatInput({
  value: externalValue,
  onChange: _externalOnChange,
  onSend,
  onStop,
  isLoading,
  sessionState,
  systemStatus,
  agentDir: _agentDir,
  provider,
  providers = [],
  onProviderChange,
  selectedModel,
  onModelChange,
  sessionUnlocked = false,
  permissionMode = 'auto',
  onPermissionModeChange,
  apiKeys = {},
  providerVerifyStatus = {},
  inputRef,
  workspaceMcpEnabled = [],
  globalMcpEnabled = [],
  globallyVisiblePlugins = [],
  workspaceEnabledPlugins = [],
  onWorkspacePluginToggle,
  mcpServers = [],
  onWorkspaceMcpToggle,
  onRefreshProviders,
  onOpenAgentSettings,
  onWorkspaceRefresh,
  cronModeEnabled = false,
  cronConfig,
  cronTask,
  onCronButtonClick,
  onCronSettings,
  onCronCancel,
  onCronStop,
  onInputChange,
  mode = 'chat',
  toolbarPrefix,
  // Whether this input belongs to the currently active tab. Used to gate document-level
  // listeners (Shift+Tab permission-mode cycle below) so background tabs don't also fire.
  active = true,
  runtime = 'builtin',
  runtimeDetections,
  onRuntimeChange,
  runtimeModels,
  runtimePermissionModes,
  queuedMessages = [],
  onCancelQueued,
  onForceExecuteQueued,
  workspacePath = null,
}, ref) {
  const isLauncherMode = mode === 'launcher';
  // Launcher-vs-Chat minimum row count, referenced by both the auto-resize
  // effect and the textarea `rows` / min/max style props. Keep as a single
  // derived constant so a later tweak (e.g. bump to 4) propagates everywhere
  // without the three-site scan the prior duplicated ternary required.
  const effectiveMinLines = isLauncherMode ? LAUNCHER_MIN_LINES : 2;
  const isExternalRuntime = runtime !== 'builtin';

  // Compute display modes and model name based on runtime
  const displayPermissionModes = isExternalRuntime && runtimePermissionModes
    ? runtimePermissionModes.map(m => ({ value: m.value as PermissionMode, label: m.label, icon: m.icon, description: m.description, sdkValue: m.value }))
    : PERMISSION_MODES;
  const currentModeDisplay = displayPermissionModes.find(m => m.value === permissionMode)
    ?? displayPermissionModes[0];

  // PERFORMANCE FIX: Use internal state to avoid parent re-renders on every keystroke
  // This prevents MessageList from re-rendering when typing in long conversations
  const [inputValue, setInputValue] = useState(externalValue ?? '');

  // Sync with external value when it changes (e.g., after send clears input)
  // NOTE: Intentionally only depend on externalValue - we only want to sync when
  // external value changes, not when internal inputValue changes (would cause loop)
  useEffect(() => {
    if (externalValue !== undefined && externalValue !== inputValue) {
      setInputValue(externalValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue]);

  // Notify parent of input value changes (for cron prompt tracking)
  useEffect(() => {
    onInputChange?.(inputValue);
  }, [inputValue, onInputChange]);

  // Ref for current provider availability — used in handleKeyDown without adding deps
  const isCurrentProviderAvailable = provider ? isProviderAvailable(provider, apiKeys, providerVerifyStatus) : false;
  // External runtimes (Claude Code / Codex) authenticate via their own CLI — no MyAgents provider required.
  const canSendMessage = isExternalRuntime || isCurrentProviderAvailable;
  const canSendMessageRef = useRef(canSendMessage);
  canSendMessageRef.current = canSendMessage;

  // PRD 0.2.7: input no longer touches sidecar HTTP directly — workspace file
  // IO and slash command listing all go through `useWorkspaceFileService`
  // (Rust invokes), and option-change persistence goes through
  // `persistInputOptionChange` at the parent (Chat / Launcher) level. The
  // tab API context import is therefore intentionally unused now; kept as a
  // stub here for future analytics / sidecar pings if they materialize.

  // PRD 0.2.7: workspace file IO is now Rust-side, not sidecar HTTP. The
  // hook is identical for launcher and chat-tab — both pass workspacePath in.
  // Where chat-tab previously relied on `apiPost` / `apiGet` to reach the
  // session sidecar's `/api/files/*` and `/agent/search-files`, we now invoke
  // `cmd_workspace_*` directly. Pre-PRD-0.2.7 the launcher's missing tab API
  // was the source of "API 未就绪" toast — gone now because the hook works
  // off `workspacePath` only and doesn't care if a Sidecar is running.
  const fileService = useWorkspaceFileService(workspacePath);

  const toast = useToast();
  // Stabilize toast reference to avoid unnecessary effect re-runs
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const { openPreview } = useImagePreview();
  // Use external ref if provided, otherwise use internal ref
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Anchor refs for Popover-based dropdowns. The textarea wrapper anchors
  // the @file and /slash menus (both sit at the bottom of the textarea
  // area); the four toolbar menus anchor to their own trigger buttons.
  const textareaWrapperRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const toolBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // Image attachments - moved up for processDroppedFiles to use
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // Undo stack for file reference insertions
  const undoStack = useUndoStack({ maxSize: 20 });

  // Ref for latest inputValue (for stable insertReferences callback)
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  // Plus menu
  const [showPlusMenu, setShowPlusMenu] = useState(false);


  // Mode and Model dropdown menus
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);

  // Derive current model ID from prop or provider default — no hardcoded fallback
  const currentModelId = selectedModel ?? provider?.primaryModel;
  // Get display name for current model (runtime-aware)
  const currentModelName = isExternalRuntime
    ? (runtimeModels?.find(m => m.value === selectedModel)?.displayName
      ?? runtimeModels?.find(m => m.isDefault)?.displayName
      ?? '默认')
    : (currentModelId
      ? (provider ? getModelDisplayName(provider, currentModelId) : currentModelId)
      : '选择模型');

  // @file search
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileSearchResults, setFileSearchResults] = useState<FileSearchResult[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [atPosition, setAtPosition] = useState<number | null>(null);
  const [isFileSearching, setIsFileSearching] = useState(false); // Track if actively searching

  // @ picker tab — files vs. thoughts. Persisted only for the lifetime of
  // this SimpleChatInput instance (per-tab) so re-opening @ in the same
  // chat session lands the user back in the picker they last used. PRD 0.2.4
  // §需求 3 (3c).
  const [mentionTab, setMentionTab] = useState<'file' | 'thought'>('file');
  // Thought results for the @ picker. `null` = no fetch yet; an empty array
  // is a real state ("0 results"). Soft cap of 50 — see §需求 3 (3d).
  const [thoughtResults, setThoughtResults] = useState<Thought[]>([]);
  const [isThoughtSearching, setIsThoughtSearching] = useState(false);
  const THOUGHT_SOFT_CAP = 50;
  const THOUGHT_RECENT_LIMIT = 5;

  // /slash command search
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashSearchQuery, setSlashSearchQuery] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [slashPosition, setSlashPosition] = useState<number | null>(null);

  // Compute filtered slash commands once per render (used in both handleKeyDown and JSX)
  const filteredSlashCommands = useMemo(
    () => filterAndSortCommands(slashCommands, slashSearchQuery),
    [slashCommands, slashSearchQuery]
  );

  // Guard against double-fire of handleSend (e.g. rapid Enter + click)
  const sendingRef = useRef(false);

  // Bug #123: track IME composition so the auto-resize effect can skip
  // textarea.style.height writes during composition. Style recalculation
  // during composition is the historical WebKit trigger (Bug 46868 class)
  // for "IME candidate text leaks into committed value" — observed on
  // macOS Tauri WebView with WeChat IME voice input duplicating recognized
  // text dozens of times. Resize once after compositionend via resizeBump.
  const isComposingRef = useRef(false);
  const [resizeBump, setResizeBump] = useState(0);

  // Bug #123: pending excessive-repetition confirmation. When non-null, a
  // ConfirmDialog is shown with the repeat count; the user can cancel
  // (input is preserved for editing) or confirm (send proceeds, bypassing
  // the repetition guard once).
  const [repetitionWarning, setRepetitionWarning] = useState<{
    text: string;
    images: ImageAttachment[];
    count: number;
  } | null>(null);

  // Close all dropdown menus (plus, mode, model, provider)
  const closeAllMenus = useCallback(() => {
    setShowPlusMenu(false);
    setShowModeMenu(false);
    setShowModelMenu(false);
    setShowToolMenu(false);
  }, []);

  // Close all menus when clicking outside (toolbar buttons use stopPropagation to prevent this)
  useEffect(() => {
    const handleClickOutside = () => {
      closeAllMenus();
      setShowSlashMenu(false);
      setSlashPosition(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [closeAllMenus]);

  useEffect(() => {
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, []);

  // Auto-resize textarea based on content. Grows from `effectiveMinLines`
  // up to `MAX_LINES`; past the ceiling the textarea scrolls internally.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Bug #123: don't touch textarea.style during IME composition. Style
    // recalculation while the IME holds marked text is the historical
    // WebKit trigger for candidate-text duplication (macOS WebView +
    // WeChat IME voice input). The post-compositionend handler will run
    // resize once after commit.
    if (isComposingRef.current) return;

    // Skip when the textarea is in a `display:none` subtree (Launcher hides
    // the inactive 对话/想法 mode this way). `scrollHeight` reads as 0 there
    // and would clamp `style.height` to `minHeight`, then no later effect
    // would re-fire on reveal — so the user would see the wrong height
    // until the next keystroke. Leaving the previously-correct height
    // untouched preserves it across the hidden interval.
    if (textarea.offsetParent === null) return;

    const minHeight = LINE_HEIGHT * effectiveMinLines;
    const maxHeight = LINE_HEIGHT * MAX_LINES;
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.max(minHeight, Math.min(scrollHeight, maxHeight))}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [inputValue, resizeBump]);

  // IME composition handlers (Bug #123). Set the ref BEFORE the auto-resize
  // effect can run for the in-progress composition, and bump `resizeBump`
  // after commit so the textarea catches up to its final size even if the
  // IME doesn't emit a follow-up input event.
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    setResizeBump((b) => b + 1);
  }, []);

  // Fetch slash commands function (extracted for reuse).
  // PRD 0.2.7: routed through fileService.listSlashCommands (Rust scan +
  // frontmatter parse), not the sidecar /api/commands. Launcher gets the
  // exact same menu as chat-tab — no more "ah, the launcher has no apiGet"
  // empty-menu bug.
  const fetchCommands = useCallback(async () => {
    if (!fileService.isAvailable) {
      // Fall back to builtins so the menu isn't empty in browser dev mode.
      setSlashCommands(BUILTIN_FALLBACK_SLASH_COMMANDS);
      return;
    }
    try {
      const response = await fileService.listSlashCommands();
      if (response.success && response.commands.length > 0) {
        setSlashCommands(response.commands);
      } else {
        console.warn('[slash-commands] Rust returned empty, using builtin fallback');
        setSlashCommands(BUILTIN_FALLBACK_SLASH_COMMANDS);
      }
    } catch (err) {
      console.error('Failed to fetch slash commands, using fallback:', err);
      setSlashCommands(BUILTIN_FALLBACK_SLASH_COMMANDS);
    }
  }, [fileService]);

  // Fetch slash commands on mount or when workspacePath changes (so launcher
  // workspace switching reloads project-level skills).
  useEffect(() => {
    fetchCommands();
  }, [workspacePath, fetchCommands]);

  // Listen for skill copy events to refresh commands list
  useEffect(() => {
    const handleSkillCopied = () => {
      // Delay slightly to ensure file system is updated
      setTimeout(() => {
        fetchCommands();
      }, 100);
    };
    window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
  }, [fetchCommands]);

  // Handle user-level skill selection
  // No-op: user-level skills/commands are synced as symlinks into project .claude/
  // by syncProjectUserConfig() at session startup. No per-invocation copy needed.
  const handleSkillSelect = useCallback((_cmd: SlashCommand) => {}, []);

  // Validate and add image (resize is handled server-side in enqueueUserMessage)
  const addImage = useCallback((file: File) => {
    if (images.length >= MAX_IMAGES) {
      toastRef.current.warning(`最多只能上传 ${MAX_IMAGES} 张图片`);
      return;
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
      toastRef.current.warning('不支持的图片格式，请使用 PNG/JPG/GIF/WebP');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toastRef.current.warning('图片大小不能超过 5MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setImages((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        preview: dataUrl,
      }]);
    };
    reader.readAsDataURL(file);
  }, [images.length]);

  // Remove image
  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // Helper function to convert File to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  // Process dropped files - copies to myagents_files and inserts @references
  const processDroppedFiles = useCallback(async (files: File[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFiles called with', files.length, 'files:', files.map(f => f.name));
    }

    // Separate images and non-images
    const imageFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of files) {
      if (isImageFile(file.name) || isImageMimeType(file.type)) {
        imageFiles.push(file);
      } else {
        otherFiles.push(file);
      }
    }

    // Modality fallback at the input boundary (PRD prd_0.2.3_image_modality_file_fallback.md).
    // When the model lacks image support, we re-route the image files into
    // the regular non-image upload path: write to <agentDir>/myagents_files/
    // and insert `@<path>` references into the input. The sidecar's
    // `enqueueUserMessage` does the same thing as a backstop (covers IM Bot
    // and any race where the model is changed between paste and send), but
    // doing it here too makes the UX honest — what the user sees in the
    // input is exactly what gets sent.
    //
    // External runtimes (Claude Code CLI / Codex / Gemini CLI) are exempt:
    // they have no `inputModalities` metadata and treat all models as
    // multimodal-capable. Forcing fallback there would be a false negative
    // for runtimes whose models DO accept images (Gemini 2.5 / 3).
    const fallbackImagesToFiles =
      imageFiles.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image');

    // Capture the user-intended file count BEFORE merging fallback images
    // into otherFiles. The downstream success toast ("已添加 N 个文件到工作区")
    // should only count files the user actually meant to drop in — fallback
    // images already get their own info toast and double-toasting feels noisy.
    const userIntendedFileCount = otherFiles.length;

    if (fallbackImagesToFiles) {
      toastRef.current.info(
        '当前模型不支持图片输入，已转为文件存入工作区供模型读取',
      );
      // Bare clipboard names ("image.png" / "") get a timestamped name so
      // pasted screenshots don't collide on disk into image_1.png, image_2.png.
      for (const img of imageFiles) {
        otherFiles.push(renameIfBareClipboardImage(img));
      }
      imageFiles.length = 0;
    }

    // Handle image files with the original addImage logic (no API needed)
    for (const file of imageFiles) {
      addImage(file);
    }

    // Handle non-image files - upload to myagents_files and insert @references.
    // PRD 0.2.7: invokes Rust `cmd_workspace_import_files_b64`, no longer the
    // sidecar HTTP route. Launcher and chat-tab share this exact path.
    if (otherFiles.length > 0) {
      if (!fileService.isAvailable) {
        console.error('[SimpleChatInput] workspace file service unavailable');
        toastRef.current.error(
          workspacePath
            ? '无法上传文件：当前为浏览器开发模式，请使用桌面应用'
            : '无法上传文件：请先选择工作区',
        );
        return;
      }
      try {
        // Convert files to base64 for JSON IPC.
        const base64Files = await Promise.all(
          otherFiles.map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          }))
        );

        const result = await fileService.importBase64Files({
          files: base64Files,
          targetDir: 'myagents_files',
        });

        if (!result.success || !result.files || result.files.length === 0) {
          throw new Error('上传失败');
        }

        // Add .gitignore rule for myagents_files folder
        try {
          await fileService.addGitignore({ pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently
        }

        // Insert @references into input
        const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
        const references = result.files.map(path => `@${path}`).join(' ');

        const before = inputValue.slice(0, cursorPos);
        const after = inputValue.slice(cursorPos);
        const insertedText = references + ' ';
        const newValue = before + insertedText + after;

        setInputValue(newValue);

        // Generate batch ID for this operation (all files in one drop share same batch)
        const batchId = undoStack.generateBatchId();

        // Push to undo stack for each file with same batchId
        for (const filePath of result.files) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${filePath} `,
            insertPosition: cursorPos,
            copiedFilePath: filePath,
          });
        }

        // Suppress the generic "已添加 N 个文件" success toast when the entire
        // batch came from fallback — the info toast above already explains
        // what happened and to the user a literal screenshot paste is not
        // an intentional "add file to workspace" action.
        if (userIntendedFileCount > 0) {
          toastRef.current.success(`已添加 ${userIntendedFileCount} 个文件到工作区`);
        }

        // Refresh workspace to show new files
        onWorkspaceRefresh?.();
      } catch (err) {
        console.error('[SimpleChatInput] File upload error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件上传失败');
      }
    }
  }, [fileService, workspacePath, addImage, inputValue, textareaRef, undoStack, fileToBase64, onWorkspaceRefresh, provider, currentModelId, isExternalRuntime]);

  // Process file paths from Tauri drag-drop (uses cmd_workspace_copy_paths via fileService).
  const processDroppedFilePaths = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFilePaths called with', paths.length, 'paths:', paths);
    }

    if (!fileService.isAvailable) {
      console.error('[SimpleChatInput] workspace file service unavailable for path drop');
      toastRef.current.error(
        workspacePath
          ? '无法处理文件：当前为浏览器开发模式，请使用桌面应用'
          : '无法处理文件：请先选择工作区',
      );
      return;
    }

    // Separate images and non-images based on extension
    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    for (const path of paths) {
      // Support both / and \ path separators
      const filename = path.split(/[\\/]/).pop() || path;
      if (isImageFile(filename)) {
        imagePaths.push(path);
      } else {
        otherPaths.push(path);
      }
    }

    // Modality fallback at input boundary (mirrors processDroppedFiles —
    // see the comment there for the full rationale and PRD reference). For
    // Tauri-style absolute path drops we re-route the image paths into
    // /api/files/copy alongside the non-image paths; original filenames are
    // already real, so no rename is needed.
    const fallbackImagesToFiles =
      imagePaths.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image');

    // See processDroppedFiles for the rationale: count only files the user
    // actively dropped before merging fallback images, so the success toast
    // doesn't double up with the fallback info toast.
    const userIntendedPathCount = otherPaths.length;

    if (fallbackImagesToFiles) {
      toastRef.current.info(
        '当前模型不支持图片输入，已转为文件存入工作区供模型读取',
      );
      otherPaths.push(...imagePaths);
      imagePaths.length = 0;
    }

    // Handle image files — read absolute paths via Rust and add as image attachments.
    // PRD 0.2.7: routed through fileService.readPathsAsBase64 (no Sidecar dependency).
    if (imagePaths.length > 0) {
      try {
        const readResult = await fileService.readPathsAsBase64({ paths: imagePaths });
        if (readResult.success && readResult.files) {
          for (const fileData of readResult.files) {
            if (fileData.data && !fileData.error) {
              // Create a File object from base64 data
              const byteString = atob(fileData.data);
              const ab = new ArrayBuffer(byteString.length);
              const ia = new Uint8Array(ab);
              for (let i = 0; i < byteString.length; i++) {
                ia[i] = byteString.charCodeAt(i);
              }
              const blob = new Blob([ab], { type: fileData.mimeType });
              const file = new File([blob], fileData.name, { type: fileData.mimeType });
              addImage(file);
            }
          }
        }
      } catch (err) {
        // If image reading fails, fall back to treating them as regular files
        if (isDebugMode()) {
          console.warn('[SimpleChatInput] Failed to read images, treating as regular files:', err);
        }
        otherPaths.push(...imagePaths);
        imagePaths.length = 0;
      }
    }

    // Handle non-image files - copy to myagents_files and insert @references.
    // PRD 0.2.7: cmd_workspace_copy_paths via fileService.
    if (otherPaths.length > 0) {
      try {
        const result = await fileService.copyPaths({
          sourcePaths: otherPaths,
          targetDir: 'myagents_files',
          autoRename: true,
        });

        if (!result.success) {
          throw new Error('复制失败');
        }

        // Handle partial success - some files may have been copied
        const successfulCopies = result.copiedFiles || [];
        if (successfulCopies.length === 0) {
          throw new Error('没有文件被成功复制');
        }

        // Add .gitignore rule for myagents_files folder
        try {
          await fileService.addGitignore({ pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently
        }

        // Insert @references into input
        const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
        const references = successfulCopies.map(f => `@${f.targetPath}`).join(' ');

        const before = inputValue.slice(0, cursorPos);
        const after = inputValue.slice(cursorPos);
        const insertedText = references + ' ';
        const newValue = before + insertedText + after;

        setInputValue(newValue);

        // Generate batch ID for this operation
        const batchId = undoStack.generateBatchId();

        // Push to undo stack for each file with same batchId
        for (const file of successfulCopies) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${file.targetPath} `,
            insertPosition: cursorPos,
            copiedFilePath: file.targetPath,
          });
        }

        // Show appropriate message — but only count user-intended paths.
        // Fallback images already got their own info toast above; layering
        // a generic "已添加 N 个文件" on top would be redundant.
        if (userIntendedPathCount > 0) {
          if (successfulCopies.length < otherPaths.length) {
            toastRef.current.warning(`已添加 ${successfulCopies.length}/${otherPaths.length} 个文件到工作区`);
          } else {
            toastRef.current.success(`已添加 ${userIntendedPathCount} 个文件到工作区`);
          }
        }

        // Refresh workspace to show new files
        onWorkspaceRefresh?.();
      } catch (err) {
        console.error('[SimpleChatInput] Tauri file copy error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件复制失败');
      }
    }
  }, [fileService, workspacePath, addImage, inputValue, textareaRef, undoStack, onWorkspaceRefresh, provider, currentModelId, isExternalRuntime]);

  // Insert @references at cursor position or end of input
  // Uses inputValueRef for stable callback (avoids rebuilding on every input change)
  const insertReferences = useCallback((paths: string[]) => {
    if (paths.length === 0) return;

    const currentInput = inputValueRef.current;

    // Build reference string with @paths separated by spaces
    const references = paths.map(p => `@${p}`).join(' ');

    // Get cursor position (or end if no focus)
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);

    // Add space before if needed (not at start, not after space/newline)
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    // Add space after if needed (not at end, not before space/newline)
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);

    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${references}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);

    // Focus textarea and set cursor after the inserted references
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + references.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef]);

  // Append a reference token to the END of input with leading-space padding and
  // guaranteed trailing space. Used by file-preview 「引用文件」/ 「引用」 selection.
  // Distinct from `insertReferences` (insert at cursor, no trailing space) — appending
  // and trailing-space matter for the file-preview UX where the user always wants a
  // ready-to-type position right after the token.
  const appendReferenceToken = useCallback((token: string) => {
    if (!token) return;
    const currentInput = inputValueRef.current;
    const needsSpaceBefore = currentInput.length > 0 && !/\s$/.test(currentInput);
    const newValue = `${currentInput}${needsSpaceBefore ? ' ' : ''}${token} `;
    setInputValue(newValue);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(newValue.length, newValue.length);
      ta.scrollTop = ta.scrollHeight;
    }, 0);
  }, [textareaRef]);

  // Insert /slash-command at cursor position or end of input
  const insertSlashCommand = useCallback((command: string) => {
    if (!command.trim()) return;
    const currentInput = inputValueRef.current;
    const slashCmd = `/${command}`;
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);
    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${slashCmd}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + slashCmd.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef]);

  // Set input value directly (for restoring content after cron stop)
  const setValue = useCallback((value: string) => {
    setInputValue(value);
    // Also focus the textarea
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    processDroppedFiles,
    processDroppedFilePaths,
    insertReferences,
    appendReferenceToken,
    insertSlashCommand,
    setValue,
    setImages,
    focus: () => textareaRef.current?.focus(),
    clearWorkspaceBoundDraft: () => {
      // Match `@<path>` tokens that target the workspace-managed `myagents_files/`
      // upload directory. Plain typed `@something` (not workspace-tied) survives.
      // Trailing whitespace after the token is also consumed (`\s*`) so a
      // sequence like "@myagents_files/foo.pdf  " collapses fully — the
      // earlier `\s?` left a stray space behind in the multi-space case.
      const current = inputValueRef.current;
      const pattern = /@myagents_files\/[^\s]+\s*/g;
      const stripped = current.replace(pattern, '');
      const strippedCount = (current.match(pattern) ?? []).length;
      if (strippedCount > 0) {
        setInputValue(stripped);
      }
      const clearedImages = images.length;
      if (clearedImages > 0) {
        setImages([]);
      }
      return { strippedReferences: strippedCount, clearedImages };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }), [processDroppedFiles, processDroppedFilePaths, insertReferences, appendReferenceToken, insertSlashCommand, setValue, images.length]);

  // Handle file input change
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      void processDroppedFiles(Array.from(files));
    }
    // Reset input so same file can be selected again
    e.target.value = '';
    setShowPlusMenu(false);
  }, [processDroppedFiles]);

  // Handle paste for images and files
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      if (isDebugMode()) {
        console.log('[SimpleChatInput] Processing', files.length, 'pasted files');
      }
      e.preventDefault();
      // Use processDroppedFiles to handle all file types
      void processDroppedFiles(files);
    }
  }, [processDroppedFiles]);

  // @file search logic — PRD 0.2.7: routed via fileService.searchFiles
  // (cmd_workspace_search_files_fuzzy). Works identically in launcher and chat
  // tab as long as `workspacePath` is bound.
  const searchFiles = useCallback(async (query: string) => {
    if (query.length < 1 || !fileService.isAvailable) {
      setFileSearchResults([]);
      setIsFileSearching(false);
      return;
    }

    setIsFileSearching(true);
    try {
      const results = await fileService.searchFiles({ query });
      setFileSearchResults(results.slice(0, 10)); // Limit to 10 results
      setSelectedFileIndex(0);
    } catch (err) {
      console.error('File search error:', err);
      setFileSearchResults([]);
    } finally {
      setIsFileSearching(false);
    }
  }, [fileService]);

  // Debounced file search
  useEffect(() => {
    if (!showFileSearch) return;
    if (mentionTab !== 'file') return;

    // Set searching state immediately when query changes (to avoid flash of 'not found')
    if (fileSearchQuery.length > 0) {
      setIsFileSearching(true);
    }

    const timer = setTimeout(() => {
      searchFiles(fileSearchQuery);
    }, 150);

    return () => clearTimeout(timer);
  }, [fileSearchQuery, showFileSearch, searchFiles, mentionTab]);

  // Debounced thought search. Mirrors the file path: empty query → most
  // recent N (PRD 5 default), otherwise full-text via `thoughtList({query})`
  // capped at the soft limit. Reuses the same `fileSearchQuery` state so
  // typing inside the picker drives both tabs without a separate buffer.
  useEffect(() => {
    if (!showFileSearch) return;
    if (mentionTab !== 'thought') return;
    if (!taskCenterAvailable()) {
      setThoughtResults([]);
      return;
    }
    setIsThoughtSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      // `#` picker is a passive surface — archived thoughts are
      // intentionally excluded (v0.2.16). Explicitly tag `archived: 'active'`
      // even though the backend default already hides them, so intent is
      // visible at the call site.
      const filter = fileSearchQuery.length === 0
        ? { limit: THOUGHT_RECENT_LIMIT, archived: 'active' as const }
        : { query: fileSearchQuery, limit: THOUGHT_SOFT_CAP, archived: 'active' as const };
      thoughtList(filter)
        .then((rows) => {
          if (cancelled) return;
          setThoughtResults(rows);
          setSelectedFileIndex(0);
        })
        .catch((err) => {
          console.error('[SimpleChatInput] thought search failed', err);
          if (!cancelled) setThoughtResults([]);
        })
        .finally(() => {
          if (!cancelled) setIsThoughtSearching(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fileSearchQuery, showFileSearch, mentionTab]);

  // Handle text input change (detect @ and / and backspace)
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;

    // Track current state locally to avoid stale closure issues
    let currentShowFileSearch = showFileSearch;
    let currentAtPosition = atPosition;
    let currentShowSlashMenu = showSlashMenu;
    let currentSlashPosition = slashPosition;

    // Detect new @ or / character (only when adding).
    // PRD 0.2.7: previously gated by `!isLauncherMode` because launcher had no
    // sidecar HTTP, so `@`/`/` would silently do nothing. Now both pickers run
    // off the workspace_files Rust commands and work in either mode.
    if (newValue.length > inputValue.length) {
      const addedChar = newValue[cursorPos - 1];
      if (addedChar === '@') {
        currentShowFileSearch = true;
        currentAtPosition = cursorPos - 1;
        setShowFileSearch(true);
        setAtPosition(cursorPos - 1);
        setFileSearchQuery('');
        setFileSearchResults([]);
        // Close slash menu if open
        currentShowSlashMenu = false;
        currentSlashPosition = null;
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else if (addedChar === '/') {
        currentShowSlashMenu = true;
        currentSlashPosition = cursorPos - 1;
        setShowSlashMenu(true);
        setSlashPosition(cursorPos - 1);
        setSlashSearchQuery('');
        setSelectedSlashIndex(0);
        // Close file search if open
        currentShowFileSearch = false;
        currentAtPosition = null;
        setShowFileSearch(false);
        setAtPosition(null);
      }
    }

    // Update file search query if @ is active (handles both add and delete)
    if (currentShowFileSearch && currentAtPosition !== null) {
      // Check if @ was deleted
      if (currentAtPosition >= newValue.length || newValue[currentAtPosition] !== '@') {
        setShowFileSearch(false);
        setAtPosition(null);
      } else {
        const textAfterAt = newValue.slice(currentAtPosition + 1, cursorPos);
        // If there's a space or newline after @, close search
        if (textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
          setShowFileSearch(false);
          setAtPosition(null);
        } else {
          setFileSearchQuery(textAfterAt);
        }
      }
    }

    // Update slash search query if / is active (handles both add and delete)
    if (currentShowSlashMenu && currentSlashPosition !== null) {
      // Check if / was deleted
      if (currentSlashPosition >= newValue.length || newValue[currentSlashPosition] !== '/') {
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else {
        const textAfterSlash = newValue.slice(currentSlashPosition + 1, cursorPos);
        // If there's a space or newline after /, close menu
        if (textAfterSlash.includes(' ') || textAfterSlash.includes('\n')) {
          setShowSlashMenu(false);
          setSlashPosition(null);
        } else {
          setSlashSearchQuery(textAfterSlash);
          setSelectedSlashIndex(0);
        }
      }
    }

    setInputValue(newValue);
  }, [inputValue, showFileSearch, atPosition, showSlashMenu, slashPosition]);

  // Cycle permission mode — runtime-aware:
  // Builtin: auto → plan → fullAgency → auto
  // External: cycle through runtimePermissionModes (CC or Codex specific modes)
  const cyclePermissionMode = useCallback(() => {
    const modeOrder: string[] = runtimePermissionModes?.length
      ? runtimePermissionModes.map(m => m.value)
      : ['auto', 'plan', 'fullAgency'];
    const currentIndex = modeOrder.indexOf(permissionMode);
    // If current mode not in list (e.g., mode from a different runtime), start from first
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % modeOrder.length;
    const nextMode = modeOrder[nextIndex] as PermissionMode;

    // Show warning toast for dangerous modes (runtime-agnostic string check)
    const dangerousModes = new Set(['fullAgency', 'bypassPermissions', 'no-restrictions']);
    if (dangerousModes.has(nextMode)) {
      toastRef.current.warning('自主行动已启用：Agent 可能做出不可挽回的操作，请谨慎使用', 5000);
    }
    onPermissionModeChange?.(nextMode);
  }, [permissionMode, onPermissionModeChange, runtimePermissionModes]);

  // Global Shift+Tab handler with capture phase to prevent default Tab behavior.
  // Gated by `active` so pressing Shift+Tab doesn't cycle permission-mode on every
  // mounted tab simultaneously (document-level listener otherwise fans out to all
  // N tabs, each calling its own cyclePermissionMode).
  useEffect(() => {
    if (!active) return;
    const handleShiftTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        cyclePermissionMode();
      }
    };
    // Use capture phase to intercept before default Tab behavior
    document.addEventListener('keydown', handleShiftTab, { capture: true });
    return () => document.removeEventListener('keydown', handleShiftTab, { capture: true });
  }, [active, cyclePermissionMode]);

  // Send message - defined before handleKeyDown to avoid circular dependency
  // Note: isLoading guard removed to allow queuing messages while AI is responding
  const bypassRepetitionRef = useRef(false);
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text && images.length === 0) return;

    // Prevent double-fire (rapid Enter + click, or concurrent async sends).
    // Must run BEFORE consuming `bypassRepetitionRef` so a confirm-during-
    // in-flight-send doesn't silently swallow the bypass and force the user
    // to re-confirm on retry.
    if (sendingRef.current) return;

    // Bug #123: gate dramatic IME-style content duplication behind a
    // ConfirmDialog. The textarea-side mitigation (skip resize during
    // composition) reduces the trigger but can't deterministically prevent
    // the WebKit/IME bug, so the input layer also catches the symptom
    // before a 77K-char message goes out.
    if (!bypassRepetitionRef.current) {
      const repeatCount = detectExcessiveRepetition(text);
      if (repeatCount > 0) {
        setRepetitionWarning({ text, images: [...images], count: repeatCount });
        return;
      }
    }
    bypassRepetitionRef.current = false;

    sendingRef.current = true;

    // Send-time modality reminder: paste-time toast may have scrolled past or
    // the user may have just switched the model AFTER pasting an image. Sidecar
    // is still the authoritative filter — this is just one final heads-up.
    // Skipped for external runtimes (filter only lives in builtin path).
    if (
      images.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image')
    ) {
      toastRef.current.warning(
        `${getCurrentModelLabel(provider, currentModelId)} 不支持图片，已自动过滤 ${images.length} 张图片，仅文本已送达`,
      );
    }

    try {
      // Delegate thought-mode persistence to the caller (Launcher
      // BrandSection owns `thoughtCreate` + refresh-key bump). The
      // boolean-return protocol (`return true` = saved, clear textarea)
      // lets the parent signal when to reset input state here.
      const result = onSend(text, images.length > 0 ? images : undefined);
      // If onSend returns a promise, await it; if sync, use directly
      const accepted = result instanceof Promise ? await result : result;
      // Only clear input if not explicitly rejected (false)
      if (accepted !== false) {
        setInputValue('');
        setImages([]);
      }
    } finally {
      sendingRef.current = false;
    }
  }, [onSend, images, inputValue, provider, currentModelId, isExternalRuntime]);

  // Handle keyboard navigation in file search and slash menu
  const handleKeyDown = useCallback(async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab to cycle permission mode
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      cyclePermissionMode();
      return;
    }

    // Cmd+Z (Mac) or Ctrl+Z (Windows) to undo file reference insertion
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
      const action = undoStack.peek();
      if (action?.type === 'file-reference') {
        event.preventDefault();

        // Pop all actions in the same batch (multi-file drop)
        const batchActions = undoStack.popBatch();
        if (batchActions.length === 0) return;

        // Remove all @references from input
        let newInputValue = inputValue;
        for (const a of batchActions) {
          if (newInputValue.includes(a.insertedText)) {
            newInputValue = newInputValue.replace(a.insertedText, '');
          }
        }
        setInputValue(newInputValue);

        // Delete all copied files (PRD 0.2.7: Rust cmd_workspace_delete).
        if (fileService.isAvailable) {
          let successCount = 0;
          let failCount = 0;

          for (const a of batchActions) {
            try {
              await fileService.deleteFile({ path: a.copiedFilePath });
              successCount++;
            } catch {
              failCount++;
            }
          }

          // Show appropriate message
          if (failCount === 0) {
            toastRef.current.success(`已撤销 ${successCount} 个文件的添加`);
          } else if (successCount > 0) {
            toastRef.current.warning(`已撤销 ${successCount} 个文件，${failCount} 个文件删除失败`);
          } else {
            toastRef.current.warning('已移除引用，但文件删除失败');
          }
        }
        return;
      }
      // If no file reference in undo stack, let browser handle default undo
    }

    // Slash menu navigation (filteredSlashCommands computed via useMemo at component level)
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Tab or Enter to select
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        // `stopPropagation` — when the slash menu consumes Tab for
        // autocomplete, prevent the event from reaching window-level
        // handlers (e.g. the Launcher `BrandSection`'s mode toggle).
        // Without this, Tab would both autocomplete AND toggle the
        // segment, a double-effect. React's `stopPropagation` also
        // stops the underlying native bubble, so the window listener
        // truly won't fire.
        event.stopPropagation();
        const selected = filteredSlashCommands[selectedSlashIndex];
        if (selected && slashPosition !== null) {
          // Trigger skill copy if user-level skill
          handleSkillSelect(selected);
          // Replace /query with /command
          const before = inputValue.slice(0, slashPosition);
          const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);
          setInputValue(`${before}/${selected.name} ${after}`);
          setShowSlashMenu(false);
          setSlashPosition(null);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowSlashMenu(false);
        setSlashPosition(null);
        return;
      }
    }

    // @ picker keyboard nav (file or thought tab) — owns ↑↓/Enter/Tab/Esc
    // and ←/→ switches between tabs.
    if (showFileSearch) {
      // ←/→ + Cmd/Ctrl switches tabs. Without a modifier we'd swallow the
      // user's caret navigation while editing the query (e.g. backing up
      // to fix a typo in `@partial`). PRD 0.2.4 §需求 3 (3b) — "仅当焦点
      // 在 picker 时" — interpreted here as "explicit modifier intent".
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        && (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        setMentionTab((t) => (t === 'file' ? 'thought' : 'file'));
        setSelectedFileIndex(0);
        return;
      }

      const activeResults = mentionTab === 'thought' ? thoughtResults : fileSearchResults;
      if (activeResults.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedFileIndex((i) => Math.min(i + 1, activeResults.length - 1));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedFileIndex((i) => Math.max(i - 1, 0));
          return;
        }
        // Tab or Enter to commit selection. File tab inserts `@<path> `;
        // thought tab inserts the full markdown body of the thought —
        // PRD 0.2.4 §需求 3 (3a) — replacing the `@<query>` trigger so the
        // `@` glyph itself is gone (thoughts don't carry a path-style
        // reference for the LLM to dereference).
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          if (atPosition === null) return;
          const selectionEnd =
            textareaRef.current?.selectionStart
            ?? atPosition + 1 + fileSearchQuery.length;
          const before = inputValue.slice(0, atPosition);
          const after = inputValue.slice(selectionEnd);
          if (mentionTab === 'file') {
            const selected = fileSearchResults[selectedFileIndex];
            if (selected) {
              setInputValue(`${before}@${selected.path} ${after}`);
            }
          } else {
            const thought = thoughtResults[selectedFileIndex];
            if (thought) {
              // Drop the leading `@` since thoughts are inserted as raw
              // content rather than as references the AI will dereference.
              setInputValue(`${before}${thought.content} ${after}`);
            }
          }
          setShowFileSearch(false);
          setAtPosition(null);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileSearch(false);
        setAtPosition(null);
        return;
      }
    }

    // Normal send - but NOT during IME composition (e.g., Chinese input)
    // Check both event.nativeEvent.isComposing (standard) and event.keyCode === 229 (legacy)
    //
    // Chat-mode keyboard contract: plain Enter sends, Shift+Enter inserts
    // a newline. (Thought mode has its own editor — ThoughtInput — with
    // Cmd/Ctrl+Enter commit and no pass-through through this component.)
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const isCmdEnter = event.metaKey || event.ctrlKey;
      const isPlainEnter = !event.shiftKey && !isCmdEnter;
      const shouldSend = isPlainEnter;
      if (shouldSend) {
        event.preventDefault();
        if ((inputValue.trim() || images.length > 0) && canSendMessageRef.current) {
          handleSend();
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [cyclePermissionMode, undoStack, fileService, showSlashMenu, filteredSlashCommands, slashSearchQuery, selectedSlashIndex, slashPosition, showFileSearch, fileSearchResults, selectedFileIndex, inputValue, atPosition, fileSearchQuery, images.length, handleSend, handleSkillSelect, mentionTab, thoughtResults]);

  // Handler for selecting a slash command from the menu
  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    if (slashPosition !== null) {
      handleSkillSelect(cmd);
      const before = inputValue.slice(0, slashPosition);
      const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);
      setInputValue(`${before}/${cmd.name} ${after}`);
      setShowSlashMenu(false);
      setSlashPosition(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is a stable ref
  }, [slashPosition, inputValue, slashSearchQuery, handleSkillSelect]);

  return (
    <>
    <div className={isLauncherMode
      ? 'relative flex w-full justify-center'
      : 'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4'
    }>
      {/* Gradient fade overlay (chat mode only) */}
      {!isLauncherMode && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-32"
          style={{
            background: 'linear-gradient(to bottom, transparent, var(--paper-elevated) 60%)'
          }}
        />
      )}

      {/* Input container */}
      <div className={isLauncherMode
        ? 'relative w-full'
        : 'pointer-events-auto relative w-full max-w-3xl'
      }>
        {/* Queued messages floating above the input */}
        {!isLauncherMode && (
          <QueuedMessagesPanel
            messages={queuedMessages}
            onCancel={(queueId) => onCancelQueued?.(queueId)}
            onForceExecute={(queueId) => onForceExecuteQueued?.(queueId)}
          />
        )}

        {/* Cron task status bar — shown when cron mode is enabled but the task
         *  hasn't started yet. PRD 0.2.7 D1: launcher SHOULD show this so the
         *  user sees their staged cron config; the actual cron creation happens
         *  after handoff to chat. Overlay (running status) stays gated below
         *  because launcher never reaches "running" — handoff fires first. */}
        {cronModeEnabled && !cronTask && cronConfig && (
          <CronTaskStatusBar
            intervalMinutes={cronConfig.intervalMinutes}
            schedule={cronConfig.schedule}
            onSettings={() => onCronSettings?.()}
            onCancel={() => onCronCancel?.()}
          />
        )}

        <div className={`relative border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md ${
          cronModeEnabled && !cronTask && cronConfig
            ? 'rounded-b-2xl rounded-t-none border-t-0'  // StatusBar visible: no top rounded, no top border
            : 'rounded-2xl'  // Normal: fully rounded
        }`}>
          {/* Cron task overlay - shows when task is running */}
          {!isLauncherMode && cronTask && cronTask.status === 'running' && (
            <CronTaskOverlay
              status={cronTask.status}
              intervalMinutes={cronTask.intervalMinutes}
              schedule={cronTask.schedule}
              executionCount={cronTask.executionCount}
              maxExecutions={cronTask.endConditions?.maxExecutions}
              nextExecutionTime={cronTask.lastExecutedAt
                ? new Date(new Date(cronTask.lastExecutedAt).getTime() + cronTask.intervalMinutes * 60000)
                : undefined}
              onStop={() => onCronStop?.()}
              onSettings={() => onCronSettings?.()}
            />
          )}
          {/* Clickable area for focus - covers input area but not toolbar */}
          <div
            className="cursor-text"
            onClick={(e) => {
              // Only focus if not clicking on a button or interactive element
              const target = e.target as HTMLElement;
              if (!target.closest('button') && !target.closest('input') && target.tagName !== 'TEXTAREA') {
                textareaRef.current?.focus();
              }
            }}
          >
          {/* Image attachments preview */}
          {images.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto">
              {images.map((img) => (
                <div key={img.id} className="relative group flex-shrink-0">
                  <img
                    src={img.preview}
                    alt="attachment"
                    className="h-16 w-16 rounded-lg object-cover border border-[var(--line)] cursor-pointer"
                    onDoubleClick={() => openPreview(img.preview, img.file.name)}
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[var(--error)] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title="删除图片"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea area */}
          <div ref={textareaWrapperRef} className="relative px-4 pt-3">
            <textarea
              ref={textareaRef}
              value={inputValue}
              // Bug #123: lock the textarea while the repetition-warning
              // dialog is open. Without this, an IME composition during the
              // dialog window could mutate inputValue between detection and
              // the user's confirm click — the dialog would describe content
              // that no longer matches what handleSend reads.
              readOnly={!!repetitionWarning}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              placeholder={
                isLauncherMode
                  ? '今天，想干点啥？'
                  : '输入消息，使用 @ 引用文件，/ 使用技能...'
              }
              rows={effectiveMinLines}
              className="block w-full resize-none bg-transparent text-base leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
              style={{
                minHeight: `${LINE_HEIGHT * effectiveMinLines}px`,
                maxHeight: `${LINE_HEIGHT * MAX_LINES}px`,
                overflowY: 'auto',
                // The auto-resize effect imperatively writes `style.height`
                // each keystroke; this transition smooths the visible
                // growth/shrink. List both `height` and `min-height` so
                // shrink animates symmetrically to grow (WebKit textareas
                // can drop the transition on shrink when only `height` is
                // listed).
                transitionProperty: 'height, min-height',
                transitionDuration: '220ms',
                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                willChange: 'height',
              }}
            />

            {/* @ picker — segmented tabs let the user switch between
                workspace files and thoughts. Keyboard is owned by the
                textarea (↑↓/Enter/Esc + ←/→ for tab switch), so we disable
                Popover's own Escape handler to avoid double-fire. PRD 0.2.4
                §需求 3. */}
            <Popover
              open={showFileSearch}
              onClose={() => setShowFileSearch(false)}
              anchorRef={textareaWrapperRef}
              placement="top-start"
              offset={8}
              closeOnEscape={false}
              className="w-96 max-h-80 flex flex-col"
            >
              {/* Tabs header */}
              <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line-subtle)] bg-[var(--paper)] p-1">
                <MentionTabButton
                  label="工作区文件"
                  active={mentionTab === 'file'}
                  onClick={() => {
                    setMentionTab('file');
                    setSelectedFileIndex(0);
                  }}
                />
                <MentionTabButton
                  label="想法"
                  active={mentionTab === 'thought'}
                  onClick={() => {
                    setMentionTab('thought');
                    setSelectedFileIndex(0);
                  }}
                />
                <span className="ml-auto pr-2 text-[10px] text-[var(--ink-muted)]/60">
                  ⌘/Ctrl + ←/→ 切换
                </span>
              </div>

              <div className="flex-1 overflow-auto">
                {mentionTab === 'file' ? (
                  fileSearchQuery.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                      输入文件名搜索...
                    </div>
                  ) : isFileSearching ? (
                    <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                      搜索中...
                    </div>
                  ) : fileSearchResults.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                      未找到文件
                    </div>
                  ) : (
                    fileSearchResults.map((file, idx) => (
                      <div
                        key={file.path}
                        className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm ${
                          idx === selectedFileIndex
                            ? 'bg-[var(--accent)]/10 text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                        }`}
                        onClick={() => {
                          if (atPosition !== null) {
                            const before = inputValue.slice(0, atPosition);
                            // `??` (not `||`) so a legitimate caret-at-start
                            // position (`selectionStart === 0`) doesn't get
                            // overwritten by the synthetic fallback.
                            const after = inputValue.slice(
                              textareaRef.current?.selectionStart
                              ?? atPosition + fileSearchQuery.length + 1,
                            );
                            setInputValue(`${before}@${file.path} ${after}`);
                            setShowFileSearch(false);
                            setAtPosition(null);
                          }
                        }}
                      >
                        <FileText className="h-4 w-4 flex-shrink-0" />
                        <span className="truncate">{file.path}</span>
                      </div>
                    ))
                  )
                ) : (
                  // Thought tab
                  isThoughtSearching ? (
                    <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                      搜索中...
                    </div>
                  ) : thoughtResults.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                      {fileSearchQuery.length === 0
                        ? '暂无想法，先在「任务中心」记录吧'
                        : (
                          <>
                            没有匹配 <span className="font-medium text-[var(--ink)]">{`"${fileSearchQuery}"`}</span> 的想法
                          </>
                        )}
                    </div>
                  ) : (
                    <>
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                        {fileSearchQuery.length === 0
                          ? `最近 ${Math.min(thoughtResults.length, THOUGHT_RECENT_LIMIT)} 条想法`
                          : `匹配 "${fileSearchQuery}" 的想法 · ${thoughtResults.length} 条`}
                      </div>
                      {thoughtResults.map((thought, idx) => (
                        <ThoughtPickerRow
                          key={thought.id}
                          thought={thought}
                          query={fileSearchQuery}
                          active={idx === selectedFileIndex}
                          onClick={() => {
                            if (atPosition === null) return;
                            const before = inputValue.slice(0, atPosition);
                            const after = inputValue.slice(
                              textareaRef.current?.selectionStart
                              ?? atPosition + fileSearchQuery.length + 1,
                            );
                            setInputValue(`${before}${thought.content} ${after}`);
                            setShowFileSearch(false);
                            setAtPosition(null);
                          }}
                        />
                      ))}
                      {fileSearchQuery.length > 0
                        && thoughtResults.length >= THOUGHT_SOFT_CAP && (
                          <div className="border-t border-[var(--line-subtle)] px-3 py-2 text-[11px] text-[var(--ink-muted)]/70">
                            已显示前 {THOUGHT_SOFT_CAP} 条匹配，请输入更精确的关键词
                          </div>
                        )}
                    </>
                  )
                )}
              </div>
            </Popover>

            {/* /slash command popup. Same ownership pattern — textarea owns
                the keyboard (↑↓/Enter/Tab/Esc); the primitive just positions
                the content above the input.
                PRD 0.2.7: previously `!isLauncherMode && showSlashMenu` so the
                launcher could never open the menu. Now we rely on `showSlashMenu`
                — the typing handler controls when it opens, and it opens in
                both launcher and chat modes (workspace_files Rust commands
                power both). */}
            <Popover
              open={showSlashMenu}
              onClose={() => setShowSlashMenu(false)}
              anchorRef={textareaWrapperRef}
              placement="top-start"
              offset={8}
              closeOnEscape={false}
            >
              <SlashCommandMenu
                commands={filteredSlashCommands}
                selectedIndex={selectedSlashIndex}
                isEmpty={slashSearchQuery.length > 0 && filteredSlashCommands.length === 0}
                onSelect={handleSlashSelect}
              />
            </Popover>
          </div>
          </div>

          {/* Toolbar row — container query: hides text labels when narrow.
              In thought mode (PRD §4.2) the left-side action strip collapses so
              the input reads as a pure note-taking box; the right-side send
              button remains so users can commit the thought with a click. */}
          <div className="toolbar-menus flex items-center px-3 pb-2 pt-1 flex-nowrap min-w-0" style={{ containerType: 'inline-size' }}>
            {/* Left side - action buttons (hidden in thought mode). Uses
                `ml-auto` on the right group instead of `justify-between` so
                the send button stays right-aligned even when the left strip
                is removed from the flex flow. */}
            <div className="flex items-center gap-1 min-w-0 flex-nowrap">
              {/* Optional prefix (e.g., workspace selector in launcher mode) */}
              {toolbarPrefix}

              {/* Plus menu */}
              <button
                ref={plusBtnRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Close other menus first
                  setShowModeMenu(false);
                  setShowModelMenu(false);
                  setShowToolMenu(false);
                  setShowPlusMenu(!showPlusMenu);
                }}
                className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                title="添加上下文"
              >
                <Plus className="h-4 w-4" />
              </button>
              <Popover
                open={showPlusMenu}
                onClose={() => setShowPlusMenu(false)}
                anchorRef={plusBtnRef}
                placement="top-start"
                className="w-48 py-1"
              >
                {/* PRD 0.2.7: previously gated by `!isLauncherMode`; both
                 *  launcher and chat-tab now route file ops through the
                 *  workspace_files Rust commands, so the launcher's plus menu
                 *  can offer 引用文件 / 使用技能 the same way. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Insert @ at cursor position and trigger file search
                    const textarea = textareaRef.current;
                    if (textarea) {
                      const cursorPos = textarea.selectionStart;
                      const before = inputValue.slice(0, cursorPos);
                      const after = inputValue.slice(cursorPos);
                      setInputValue(`${before}@${after}`);
                      setShowFileSearch(true);
                      setAtPosition(cursorPos);
                      setFileSearchQuery('');
                      textarea.focus();
                    }
                    setShowPlusMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <AtSign className="h-4 w-4" />
                  引用文件
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Insert / at cursor position and trigger slash menu
                    const textarea = textareaRef.current;
                    if (textarea) {
                      const cursorPos = textarea.selectionStart;
                      const before = inputValue.slice(0, cursorPos);
                      const after = inputValue.slice(cursorPos);
                      setInputValue(`${before}/${after}`);
                      setShowSlashMenu(true);
                      setSlashPosition(cursorPos);
                      setSlashSearchQuery('');
                      setSelectedSlashIndex(0);
                      textarea.focus();
                    }
                    setShowPlusMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center font-medium text-[var(--ink-muted)]">/</span>
                  使用技能
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <Paperclip className="h-4 w-4" />
                  上传文件
                </button>
              </Popover>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Runtime Selector (v0.1.59) */}
              {runtimeDetections && onRuntimeChange && !isLauncherMode && (
                <RuntimeSelector
                  value={runtime}
                  detections={runtimeDetections}
                  onChange={onRuntimeChange}
                  variant="toolbar"
                  onOpenSettings={onOpenAgentSettings}
                />
              )}

              {/* Mode Dropdown */}
              <button
                ref={modeBtnRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowModeMenu(!showModeMenu);
                  setShowModelMenu(false);
                  setShowPlusMenu(false);
                  setShowToolMenu(false);
                }}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="切换执行模式"
              >
                <span>{currentModeDisplay?.icon}</span>
                <span className="toolbar-label">{currentModeDisplay?.label}</span>
                <ChevronUp className="h-3 w-3" />
              </button>
              <Popover
                open={showModeMenu}
                onClose={() => setShowModeMenu(false)}
                anchorRef={modeBtnRef}
                placement="top-start"
                className="w-72 py-1"
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--line)]">
                  <span className="text-xs font-medium text-[var(--ink-muted)]">会话模式</span>
                  {onOpenAgentSettings && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModeMenu(false);
                        onOpenAgentSettings();
                      }}
                      className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-warm-hover)] transition-colors"
                    >
                      Agent 设置
                    </button>
                  )}
                </div>
                {displayPermissionModes.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (mode.value === 'fullAgency' || (mode.value as string) === 'bypassPermissions') {
                        toastRef.current.warning('自主行动已启用：Agent 可能做出不可挽回的操作，请谨慎使用', 5000);
                      }
                      onPermissionModeChange?.(mode.value);
                      setShowModeMenu(false);
                    }}
                    className={`flex w-full flex-col items-start px-3 py-2 text-left ${permissionMode === mode.value
                      ? 'bg-[var(--accent)]/10'
                      : 'hover:bg-[var(--hover-bg)]'
                      }`}
                  >
                    <span className={`text-sm font-medium flex items-center gap-1.5 ${permissionMode === mode.value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
                      }`}>
                      <span>{mode.icon}</span>
                      {mode.label}
                    </span>
                    <span className="text-xs text-[var(--ink-muted)] mt-0.5">{mode.description}</span>
                  </button>
                ))}
              </Popover>

              {/* Tool/MCP Dropdown - hidden for external runtimes (they use their own tools) */}
              {!isExternalRuntime && (
              <>
              {(() => {
                // Count only MCPs the user will actually see *and* that are live: present in the
                // catalogue (mcpServers), globally enabled, and workspace-enabled. Using the raw
                // `workspaceMcpEnabled.length` drifts from the popover contents when a workspace
                // still references IDs that were disabled globally or removed from the catalogue.
                const effectiveMcpCount = workspaceMcpEnabled.filter(
                  id => globalMcpEnabled.includes(id) && mcpServers.some(s => s.id === id)
                ).length;
                return (
              <button
                ref={toolBtnRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowToolMenu(!showToolMenu);
                  setShowModeMenu(false);
                  setShowModelMenu(false);
                  setShowPlusMenu(false);
                }}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="使用工具"
              >
                <Wrench className="h-3.5 w-3.5" />
                <span className="toolbar-label">工具</span>
                {effectiveMcpCount > 0 && (
                  <span className="text-[11px] text-[var(--ink-muted)]">
                    {effectiveMcpCount}
                  </span>
                )}
              </button>
                );
              })()}
              <Popover
                open={showToolMenu}
                onClose={() => setShowToolMenu(false)}
                anchorRef={toolBtnRef}
                placement="top-start"
                // max-h + overflow-y-auto so a workspace with 13+ enabled
                // plugins (anthropics/claude-for-legal etc.) doesn't blow
                // past the viewport top. 50vh shows ~6 full rows AND
                // half-clips the next one — the partial row is the
                // affordance that tells the user "scroll for more".
                className="w-64 max-h-[50vh] overflow-y-auto py-1"
              >
                    <div className="px-3 py-2 text-xs font-medium text-[var(--ink-muted)] border-b border-[var(--line)]">
                      工具 (在此对话中启用)
                    </div>
                    {globalMcpEnabled.length > 0 ? (
                      mcpServers
                        .filter(s => globalMcpEnabled.includes(s.id))
                        .map((server) => {
                          const isEnabled = workspaceMcpEnabled.includes(server.id);
                          return (
                            <div
                              key={server.id}
                              className="flex items-center justify-between px-3 py-2"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-[var(--ink)] truncate">
                                  {server.name}
                                </div>
                                {server.description && (
                                  <div className="text-xs text-[var(--ink-muted)] truncate">
                                    {server.description}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                title="设置"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowToolMenu(false);
                                  window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp', mcpServerId: server.id } }));
                                }}
                                className="ml-2 shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                              >
                                <Settings2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onWorkspaceMcpToggle?.(server.id, !isEnabled);
                                }}
                                className={`relative ml-2 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors hover:opacity-80 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                  }`}
                              >
                                <span
                                  className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                    }`}
                                />
                              </button>
                            </div>
                          );
                        })
                    ) : (
                      <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                        在
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowToolMenu(false);
                            // Dispatch custom event to open Settings with MCP section
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp' } }));
                          }}
                          className="mx-1 text-[var(--accent)] hover:underline"
                        >
                          设置页面
                        </button>
                        安装开启 MCP 工具，即可使用浏览器等更多功能
                      </div>
                    )}

                    {/* PRD 0.2.17 — Claude Plugins section. Mirrors the MCP
                     *  block above (same toggle UI, same per-workspace
                     *  semantics). Only globally-visible plugins appear here
                     *  (AppConfig.enabledPlugins gate done server-side via
                     *  the globallyVisiblePlugins prop). Toggling calls
                     *  onWorkspacePluginToggle which writes to the Agent +
                     *  pushes a session override to the sidecar. */}
                    {/* Plugin section header always renders (even when zero
                     *  plugins installed) so the feature is discoverable —
                     *  the empty-state hint doubles as onboarding pointing
                     *  to Settings → Plugins. Matches the MCP empty-state
                     *  pattern above for visual symmetry. */}
                    <div className="px-3 py-2 mt-1 text-xs font-medium text-[var(--ink-muted)] border-t border-[var(--line)] border-b border-[var(--line)] bg-[var(--paper-inset)]/40">
                      插件 Plugins
                    </div>
                    {globallyVisiblePlugins.length > 0 ? (
                      globallyVisiblePlugins.map((plugin) => {
                        const isEnabled = workspaceEnabledPlugins.includes(plugin.id);
                        return (
                          <div
                            key={plugin.id}
                            className="flex items-center justify-between px-3 py-2"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-[var(--ink)] truncate">
                                {plugin.name}
                              </div>
                              {plugin.description && (
                                <div className="text-xs text-[var(--ink-muted)] truncate">
                                  {plugin.description}
                                </div>
                              )}
                              {plugin.mcpServerNames && plugin.mcpServerNames.length > 0 && (
                                <div
                                  className="mt-0.5 text-[11px] text-[var(--ink-muted)] truncate"
                                  title={`启用此插件会自动加载这些 MCP server：${plugin.mcpServerNames.join(', ')}`}
                                >
                                  🔌 {plugin.mcpServerNames.length} 个 MCP：{plugin.mcpServerNames.join(', ')}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              title="管理插件"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowToolMenu(false);
                                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'plugins' } }));
                              }}
                              className="ml-2 shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onWorkspacePluginToggle?.(plugin.id, !isEnabled);
                              }}
                              className={`relative ml-2 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors hover:opacity-80 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                  }`}
                              />
                            </button>
                          </div>
                        );
                      })
                    ) : (
                      <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                        还没有插件。在
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowToolMenu(false);
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'plugins' } }));
                          }}
                          className="mx-1 text-[var(--accent)] hover:underline"
                        >
                          设置 → 插件
                        </button>
                        可以从 GitHub 或本地路径安装。
                      </div>
                    )}
              </Popover>
              </>
              )}

              {/* Heartbeat Loop Button — PRD 0.2.7 D1: launcher exposes this
               *  too. The handler stages cron config on launcher; actual
               *  cmd_create_cron_task runs after handoff to chat. */}
              {onCronButtonClick && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCronButtonClick();
                  }}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${
                    cronModeEnabled
                      ? 'bg-[var(--heartbeat-bg)] text-[var(--heartbeat)] hover:bg-[var(--heartbeat)]/20'
                      : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                  }`}
                  title={cronModeEnabled ? '定时已启用' : '定时'}
                >
                  <Timer className="h-3.5 w-3.5" />
                  <span className="toolbar-label">定时</span>
                </button>
              )}
            </div>

            {/* Right side - model selector + send/stop button */}
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {/* v0.1.69: Unlocked indicator for legacy pre-snapshot sessions */}
              {sessionUnlocked && (
                <span
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)]/60"
                  title="该 session 未锁定，跟随 agent 默认（修改 agent 会影响此会话）"
                >
                  <Unlock className="h-3 w-3" />
                </span>
              )}
              {/* Model Dropdown with Provider Selector */}
              <button
                ref={modelBtnRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const willOpen = !showModelMenu;
                  setShowModelMenu(willOpen);
                  setShowModeMenu(false);
                  setShowPlusMenu(false);
                  setShowToolMenu(false);
                  // Refresh providers data when opening menu
                  if (willOpen && onRefreshProviders) {
                    onRefreshProviders();
                  }
                }}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="切换模型"
              >
                <span className="max-w-[140px] truncate">{currentModelName}</span>
                <ChevronUp className="h-3 w-3 shrink-0" />
              </button>
              <Popover
                open={showModelMenu}
                onClose={() => setShowModelMenu(false)}
                anchorRef={modelBtnRef}
                placement="top-end"
                className="w-64 max-h-[300px] overflow-y-auto py-1"
              >
                {isExternalRuntime && runtimeModels ? (
                  <>
                    <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                      {runtime === 'claude-code' ? 'CLAUDE CODE' : runtime === 'gemini' ? 'GEMINI CLI' : runtime?.toUpperCase()} 模型
                    </div>
                    {runtimeModels.map(model => {
                      const isSelected = selectedModel === model.value || (!selectedModel && model.isDefault);
                      return (
                        <button
                          key={model.value}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onModelChange?.(model.value);
                            setShowModelMenu(false);
                          }}
                          className={`w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                            isSelected
                              ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                              : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                          }`}
                        >
                          {model.displayName}
                        </button>
                      );
                    })}
                  </>
                ) : (() => {
                  const availableProviders = (providers ?? []).filter(p => isProviderAvailable(p, apiKeys, providerVerifyStatus));
                  if (availableProviders.length === 0) {
                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowModelMenu(false);
                          window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                            detail: { section: 'providers' }
                          }));
                        }}
                        className="w-full px-3 py-2.5 text-left text-[13px] text-[var(--accent)] transition-colors hover:bg-[var(--hover-bg)]"
                      >
                        请先设置模型服务 →
                      </button>
                    );
                  }
                  return availableProviders.map((p, idx) => (
                    <div key={p.id}>
                      {idx > 0 && <div className="mx-2 my-1 border-t border-[var(--line)]" />}
                      <div className="group/provider relative flex items-center gap-1 px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                        {p.name}{p.type === 'subscription' ? ' (订阅)' : ''}
                        {isProviderWarning(p, apiKeys, providerVerifyStatus) && (
                          <Tip label="验证未通过，部分模型可能不可用" position="bottom">
                            <AlertCircle className="h-3 w-3 shrink-0 text-[var(--warning)]" />
                          </Tip>
                        )}
                      </div>
                      {p.models.map(model => {
                        const isSelected = provider?.id === p.id && currentModelId === model.model;
                        return (
                          <button
                            key={model.model}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (provider?.id !== p.id) {
                                onProviderChange?.(p.id, model.model);
                              } else {
                                onModelChange?.(model.model);
                              }
                              setShowModelMenu(false);
                            }}
                            className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                              isSelected
                                ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                                : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                            }`}
                          >
                            <span className="truncate">{model.modelName}</span>
                            <ModalityBadges modalities={model.inputModalities} className="ml-2" />
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()}
              </Popover>

              {/* Button states:
                  - genuinely-uninterruptible system task (compacting…) → disabled Send
                  - stop in progress → disabled spinner
                  - AI responding OR api_retry backoff → Stop (interruptible — abort
                    wakes the SDK from its retry sleep cleanly; user shouldn't be
                    forced to wait through up to 10 exponentially-spaced retries)
                  - idle → Send
                  api_retry is split out of the systemStatus branch deliberately:
                  the original "any systemStatus → not interruptible" lumped retry
                  in with compacting, but unlike compacting, retry has no in-flight
                  SDK state to corrupt. */}
              {systemStatus && !systemStatus.startsWith('api_retry:') ? (
                // System task running (e.g., compacting) - not interruptible
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]/60"
                  title="正在执行系统任务，请稍等"
                >
                  <Send className="h-4 w-4" />
                </button>
              ) : isLoading && sessionState === 'stopping' ? (
                // Stop in progress - waiting for confirmation
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]"
                  title="正在停止..."
                >
                  <Loader className="h-4 w-4 animate-spin" />
                </button>
              ) : isLoading || systemStatus?.startsWith('api_retry:') ? (
                // AI responding OR api_retry backoff - both can be stopped.
                // The `||` is double-coverage: in normal flow isLoading stays
                // true throughout the retry loop (no message-complete fires
                // until the turn ends), but if some future state machine path
                // flips isLoading false during retry, the systemStatus check
                // still keeps the stop button reachable.
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-lg bg-[var(--error)] p-2 text-white transition-colors hover:brightness-110"
                  title={systemStatus?.startsWith('api_retry:') ? '停止重试' : '停止'}
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSendMessage || (!inputValue.trim() && images.length === 0)}
                  className="rounded-lg bg-[var(--accent)] p-2 text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60"
                  title={!canSendMessage ? '请前往设置页面设置模型供应商' : '发送'}
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    {repetitionWarning && (
      <ConfirmDialog
        title="检测到内容存在大量重复"
        message={`同一段文字重复了约 ${repetitionWarning.count} 次（共 ${repetitionWarning.text.length.toLocaleString()} 字符）。常见于第三方输入法的语音识别异常。仍要发送吗？`}
        confirmText="仍要发送"
        cancelText="取消"
        confirmVariant="danger"
        // Bug #123: don't bind Enter to confirm — the user just pressed Enter
        // to trigger send, and a reflexive second Enter must not silently
        // confirm sending the duplicated payload. Click is required.
        disableEnterShortcut
        onConfirm={() => {
          setRepetitionWarning(null);
          bypassRepetitionRef.current = true;
          handleSend();
        }}
        onCancel={() => setRepetitionWarning(null)}
      />
    )}
    </>
  );
}));

export default SimpleChatInput;

// ─── @ picker helpers (PRD 0.2.4 §需求 3) ────────────────────────────

/**
 * Segmented-tab button used in the @ picker header. Pattern matches the
 * launcher's mode toggle (background pill + active inset paper) so the two
 * surfaces feel related rather than ad-hoc.
 */
function MentionTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
        active
          ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
          : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Thought picker row — at-least-2-line affordance. Layout (top-down):
 *   • meta line (relative time + 0–3 tags)
 *   • body preview (line-clamp 2)
 * Search-keyword highlights mirror the left-panel ThoughtCard semantics
 * so the picker reads as a smaller mirror of the same data.
 */
function ThoughtPickerRow({
  thought,
  query,
  active,
  onClick,
}: {
  thought: Thought;
  query: string;
  active: boolean;
  onClick: () => void;
}) {
  const ranges = query.trim().length > 0
    ? findHighlightRanges(thought.content, query)
    : [];
  const tags = (thought.tags ?? []).slice(0, 3);
  return (
    <div
      onClick={onClick}
      className={`cursor-pointer border-b border-[var(--line-subtle)] px-3 py-2 transition-colors ${
        active
          ? 'bg-[var(--accent)]/10'
          : 'hover:bg-[var(--hover-bg)]'
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--ink-muted)]">
        <span>{formatThoughtTime(thought.updatedAt)}</span>
        {tags.length > 0 && (
          <div className="flex items-center gap-1">
            {tags.map((t) => (
              <span
                key={t}
                className="rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] px-1.5 py-px text-[10px] text-[var(--accent-warm)]"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className="text-[13px] leading-snug text-[var(--ink-secondary)]"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: '34px',
        }}
      >
        {ranges.length > 0
          ? renderTextWithHighlights(thought.content, ranges)
          : thought.content}
      </div>
    </div>
  );
}

function formatThoughtTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}
