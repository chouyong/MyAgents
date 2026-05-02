/**
 * FilePreviewModal - File preview and edit modal for workspace files
 *
 * Auto-save model (Typora/Obsidian-style): all editable files persist in the background
 * with a 1s debounce. No manual Save/Cancel buttons.
 * - **Code files**: writable Monaco directly.
 * - **Markdown files**: header `<MdViewSegment>` toggles between rendered preview and a
 *   writable Monaco editor. Both share the same auto-saved `editContent`, so the toggle
 *   is purely a view switch.
 *
 * Edit capability comes from two sources (either is sufficient):
 * 1. `workspacePath` prop — Rust workspace_files via `useWorkspaceFileService`
 * 2. Explicit `onSave`/`onRevealFile` props — when caller provides save logic directly
 *    (e.g. Settings panels editing `~/.myagents/agents/...`)
 */
import { AtSign, Check, Edit2, Expand, Eye, FileText, FolderOpen, Loader2, X } from 'lucide-react';
import Tip from './Tip';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { getMonacoLanguage, isMarkdownFile } from '@/utils/languageUtils';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { retainFocusOnMouseDown } from '@/utils/focusRetention';

import Markdown from './Markdown';
import { useToast } from './Toast';
import OverlayBackdrop from '@/components/OverlayBackdrop';

// Lazy load Monaco Editor: the ~3MB bundle is only loaded when user first opens a file
const MonacoEditor = lazy(() => import('./MonacoEditor'));

// No-op change handler for read-only Monaco (stable reference avoids re-renders)
const noop = () => {};

// Static loading spinner (module-level to avoid allocation per render)
const monacoLoading = (
    <div className="flex h-full items-center justify-center bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
    </div>
);

// Auto-save debounce delay (ms)
const AUTO_SAVE_DELAY = 1000;


interface FilePreviewModalProps {
    /** File name to display */
    name: string;
    /** File content */
    content: string;
    /** File size in bytes */
    size: number;
    /** Relative path from agent directory (for saving) */
    path: string;
    /** Whether content is loading */
    isLoading?: boolean;
    /** Error message to display */
    error?: string | null;
    /** Callback when modal is closed */
    onClose: () => void;
    /** Callback after file is saved successfully */
    onSaved?: () => void;
    /** External save handler — enables editing even without Tab context */
    onSave?: (content: string) => Promise<void>;
    /** External reveal-in-finder handler — enables "Open in Finder" without Tab context */
    onRevealFile?: () => Promise<void>;
    /** Absolute workspace root path — Phase D.5: required for rendered
     *  markdown to load relative-path images via `useWorkspaceFileService`.
     *  When omitted, embedded images in markdown won't load (the modal's
     *  text/code preview still works fine). */
    workspacePath?: string | null;
    /** Notify parent that the file was renamed. Parent MUST update the
     *  `name`/`path` it passes back so subsequent saves target the new
     *  location (e.g., split-view's `splitFile` state). */
    onRenamed?: (newPath: string, newName: string) => void;
    /** When `true`, markdown opens directly in the editable Monaco view
     *  instead of the rendered preview. Used by 「新建笔记」 flow so a fresh
     *  empty `note-…md` is immediately editable without an extra click. */
    initialEditMode?: boolean;
    /** When true, render inline (no portal/backdrop) for use in split-view panel */
    embedded?: boolean;
    /** Callback to open the fullscreen modal from embedded mode.
     *  Receives the current editor content so fullscreen opens with up-to-date text. */
    onFullscreen?: (currentContent?: string) => void;
    /** Switch to browser preview (only for HTML files with an active browser panel) */
    onSwitchToBrowser?: () => void;
    /** Initial line to scroll to */
    initialLineNumber?: number;
    /** When provided, renders a「引用文件」icon button in the toolbar that injects
     *  `@<path>` into the chat input and closes the modal. Omit on non-chat surfaces
     *  (settings panels, agent admin pages) — the button hides automatically. */
    onQuoteFile?: (path: string) => void;
    /** When provided, the Monaco editor (used for code files & markdown edit mode)
     *  shows a floating「引用」menu on selection that injects `@<path>#L<start>[-L<end>]`
     *  into the chat input. Markdown preview mode (rendered HTML) intentionally does
     *  NOT surface this — line-mapping back to source is unreliable. */
    onQuoteSelection?: (path: string, startLine: number, endLine: number, text: string) => void;
}

// Files above this threshold use plaintext mode (skip tokenization) to prevent UI freeze
const LARGE_FILE_TOKENIZATION_THRESHOLD = 100 * 1024; // 100KB

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Auto-save status indicator — same treatment as the existing code-file editor.
 *  Silent on idle; surfaces saving/saved/error only when relevant. */
function AutoSaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
    if (status === 'idle') {
        return null;
    }
    if (status === 'saving') {
        return (
            <span className="flex items-center gap-1 text-[11px] text-[var(--ink-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                保存中
            </span>
        );
    }
    if (status === 'saved') {
        return (
            <span className="flex items-center gap-1 text-[11px] text-[var(--success)]">
                <Check className="h-3 w-3" />
                已保存
            </span>
        );
    }
    return (
        <span className="flex items-center gap-1 text-[11px] text-[var(--error)]">
            <X className="h-3 w-3" />
            保存失败
        </span>
    );
}

/** Inline filename editor for the toolbar's filename slot. Stays unmounted
 *  in the static state so consumers can keep the surrounding flex/grid
 *  layout simple (one slot, two render modes). Width auto-fits the draft
 *  via a `size`-style trick on the input — using `field-sizing: content`
 *  via inline style would be cleaner but isn't supported on all WebViews;
 *  inline `style.width = ch` keeps the input snug across platforms. */
function FilenameSlot({
    name,
    canRename,
    isEditing,
    draft,
    onDraftChange,
    onCommit,
    onCancel,
    onStartEdit,
    busy,
    className,
}: {
    name: string;
    canRename: boolean;
    isEditing: boolean;
    draft: string;
    onDraftChange: (v: string) => void;
    onCommit: (next: string) => void;
    onCancel: () => void;
    onStartEdit: () => void;
    busy: boolean;
    className: string;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            // Select the stem (everything before the last dot) so the user can
            // retype the name without extension first — Mac Finder behavior.
            const dot = draft.lastIndexOf('.');
            inputRef.current.setSelectionRange(0, dot > 0 ? dot : draft.length);
        }
        // Only run on transition into editing state; subsequent typing should
        // not re-select. Empty deps array would lint, but exhaustive-deps wants
        // `draft` — that's fine, the first render in edit mode is when this
        // matters and `draft` only changes on user input afterward.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEditing]);
    if (!isEditing) {
        return (
            <span
                className={`truncate ${className} ${canRename ? 'cursor-text' : ''}`}
                onDoubleClick={canRename ? onStartEdit : undefined}
                title={canRename ? '双击重命名' : undefined}
            >
                {name}
            </span>
        );
    }
    return (
        <input
            ref={inputRef}
            type="text"
            value={draft}
            disabled={busy}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    onCommit(draft);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancel();
                }
            }}
            onBlur={() => {
                // Blur commits — matches Mac Finder. Escape (which cancels)
                // dispatches before blur, so a cancelled edit reaches the
                // cancel branch first and resets state; the subsequent blur
                // sees `isEditing` already false and is a no-op via the
                // outer ternary.
                onCommit(draft);
            }}
            // Stop propagation so the editor input doesn't trigger overlay
            // close-on-click-outside or grid-layout focus shifts.
            onClick={(e) => e.stopPropagation()}
            className={`min-w-0 flex-1 rounded-sm border border-[var(--accent)] bg-[var(--paper)] px-1 py-0 outline-none ${className}`}
            style={{ width: `${Math.max(draft.length + 1, 6)}ch` }}
        />
    );
}

/** "预览 / 编辑" segmented control — header thumb-style toggle, mirrors task-center/ModeSegment.tsx
 *  visual treatment so markdown view-mode switching reads as one affordance. */
function MdViewSegment({
    value,
    onChange,
    compact = false,
}: {
    value: 'preview' | 'edit';
    onChange: (mode: 'preview' | 'edit') => void;
    compact?: boolean;
}) {
    const baseBtn = compact
        ? 'inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition-all duration-150'
        : 'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1 text-[12px] font-medium transition-all duration-150';
    const activeBtn = 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs';
    const inactiveBtn = 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]';
    const iconCls = compact ? 'h-3 w-3' : 'h-3 w-3';
    return (
        <div className="inline-flex gap-0.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-[3px]">
            <button
                type="button"
                onClick={() => onChange('preview')}
                onMouseDown={retainFocusOnMouseDown}
                aria-pressed={value === 'preview'}
                className={`${baseBtn} ${value === 'preview' ? activeBtn : inactiveBtn}`}
            >
                <Eye className={iconCls} strokeWidth={1.75} />
                预览
            </button>
            <button
                type="button"
                onClick={() => onChange('edit')}
                onMouseDown={retainFocusOnMouseDown}
                aria-pressed={value === 'edit'}
                className={`${baseBtn} ${value === 'edit' ? activeBtn : inactiveBtn}`}
            >
                <Edit2 className={iconCls} strokeWidth={1.75} />
                编辑
            </button>
        </div>
    );
}

export default function FilePreviewModal({
    name,
    content,
    size,
    path,
    isLoading = false,
    error = null,
    onClose,
    onSaved,
    onSave,
    onRevealFile,
    workspacePath = null,
    onRenamed,
    initialEditMode = false,
    embedded = false,
    onFullscreen,
    onSwitchToBrowser,
    initialLineNumber,
    onQuoteFile,
    onQuoteSelection,
}: FilePreviewModalProps) {
    // Cmd+W dismissal: only register for fullscreen mode (z-[210]).
    // Embedded mode (split-panel) has no z-index overlay and is handled separately.
    // Routes through `handleCloseRef` (latest-ref pattern) so Cmd+W respects the same
    // `flushAndClose` autosave drain that the X button uses — without this, edits made
    // after the last debounce fire would be silently lost on Cmd+W.
    const handleCloseRef = useRef<() => void>(onClose);
    useCloseLayer(() => { if (embedded) return false; handleCloseRef.current(); return true; }, 210);

    // Mounted guard for async autosave callbacks. Project convention requires this on any
    // setState that runs after `await`; without it, an in-flight save resolving after
    // unmount produces React "set state on unmounted component" warnings and may shadow
    // the next mount's state.
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const fileService = useWorkspaceFileService(workspacePath);

    // Phase E (PRD 0.2.7): the legacy `apiPost('/agent/save-file')` fallback
    // is removed — workspace edits go through Rust workspace_files
    // exclusively. Edit is enabled when `workspacePath` is provided
    // (fileService.saveFile path) OR an explicit `onSave` prop overrides
    // (Settings panels editing `~/.myagents/agents/...`).
    const canEdit = !!(workspacePath || onSave);
    // Reveal: only when caller provides `onRevealFile`. Phase D.5 red-line:
    // workspace file ops must go through Rust workspace_files (the caller
    // wraps `fileService.openInFinder`), not sidecar HTTP. Removing the
    // sidecar `apiPost('/agent/open-in-finder')` fallback hides the button
    // for callers that haven't been migrated rather than silently violating
    // the red-line.
    const canReveal = !!onRevealFile;

    const isMarkdown = useMemo(() => isMarkdownFile(name), [name]);
    const monacoLanguage = useMemo(() => getMonacoLanguage(name), [name]);

    // Auto-save mode covers any editable file (markdown or code) — Typora/Obsidian-style.
    const isDirectEdit = canEdit;

    // ─── State ───────────────────────────────────────────────────────────────
    // Markdown view-mode toggle (preview vs writable Monaco). Default to preview so opening
    // a `.md` file shows the rendered version first; user toggles to edit. The
    // 「新建笔记」 flow opts in to `initialEditMode` so a brand-new empty note
    // opens directly in the editor without an extra click.
    const [mdViewMode, setMdViewMode] = useState<'preview' | 'edit'>(initialEditMode ? 'edit' : 'preview');
    const [editContent, setEditContent] = useState(content);
    const [savedContent, setSavedContent] = useState(content); // Last saved baseline (for diff/dirty)

    // Auto-save state (for any direct-edit file)
    const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isSavingRef = useRef(false); // guard against concurrent saves
    const inFlightPromiseRef = useRef<Promise<void> | null>(null); // track in-flight save for close coordination
    const savedIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sync content when prop changes (e.g., when file is reloaded externally OR when the
    // viewer switches to a different file in-place). MUST depend on `path`/`name` too:
    // without those, switching from `a.md` to `b.md` whose disk content happens to match
    // the cached `editContent` would let a still-pending debounce write `a.md` edits into
    // `b.md`'s path (pathRef updates synchronously below). Adding `path`/`name` to deps
    // forces the timer-clear + state-reset on file switch even when content is identical.
    useEffect(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        setEditContent(content);
        setSavedContent(content);
    }, [content, path, name]);

    // Large files: force plaintext to skip tokenization
    const effectiveMonacoLanguage = useMemo(() => {
        if (size > LARGE_FILE_TOKENIZATION_THRESHOLD) return 'plaintext';
        return monacoLanguage;
    }, [size, monacoLanguage]);

    // ─── Save logic (shared by auto-save and manual save) ────────────────────
    // Stable refs for save dependencies to avoid re-creating callbacks
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const fileServiceRef = useRef(fileService);
    fileServiceRef.current = fileService;
    const pathRef = useRef(path);
    pathRef.current = path;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    /** Core save function — saves the given content string. Phase E (PRD 0.2.7):
     *  workspace-relative paths go through `fileService.saveFile` (Rust
     *  `cmd_workspace_save_file`); explicit `onSave` prop still takes
     *  precedence for non-workspace surfaces (Settings panels editing
     *  `~/.myagents/...` files via direct fs writes). */
    const executeSave = useCallback(async (contentToSave: string) => {
        if (onSaveRef.current) {
            await onSaveRef.current(contentToSave);
        } else if (fileServiceRef.current.isAvailable) {
            await fileServiceRef.current.saveFile({
                path: pathRef.current,
                content: contentToSave,
            });
        }
    }, []); // stable — all deps via refs

    // We need ref-accessible versions for async save callbacks
    const editContentRef = useRef(editContent);
    editContentRef.current = editContent;
    const savedContentRef = useRef(savedContent);
    savedContentRef.current = savedContent;

    // ─── Inline rename ────────────────────────────────────────────────────────
    // State + draft handling is set up here so the toolbar render path can
    // reference it before the auto-save callbacks are defined. The async
    // commit handler (which depends on `handleManualFlush`) lives further
    // down — `handleRenameCommit` is the forward-declared ref filled in
    // below; the toolbar reads it via `handleRenameCommitRef.current`.
    const canRename = !!workspacePath;
    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(name);
    const [renameInFlight, setRenameInFlight] = useState(false);
    useEffect(() => {
        if (!isEditingName) setNameDraft(name);
    }, [name, isEditingName]);
    const onRenamedRef = useRef(onRenamed);
    onRenamedRef.current = onRenamed;
    const handleRenameCommitRef = useRef<(next: string) => void>(() => {});
    const handleRenameCommit = useCallback((next: string) => {
        handleRenameCommitRef.current(next);
    }, []);
    const handleRenameCancel = useCallback(() => {
        setIsEditingName(false);
        setNameDraft(name);
    }, [name]);
    const handleStartRename = useCallback(() => {
        if (!canRename) return;
        setNameDraft(name);
        setIsEditingName(true);
    }, [canRename, name]);

    // ─── Auto-save for direct-edit code files ─────────────────────────────────

    /** Persist the given content to disk, update status indicator, and call onSaved.
     *  Includes retry-after-busy: if a save is already in-flight, reschedules after it finishes. */
    const doAutoSave = useCallback((contentToSave: string) => {
        if (isSavingRef.current) {
            // Already saving — reschedule so this edit isn't lost
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = setTimeout(() => {
                void doAutoSave(editContentRef.current);
            }, AUTO_SAVE_DELAY);
            return;
        }
        isSavingRef.current = true;
        setAutoSaveStatus('saving');
        const savePromise = (async () => {
            try {
                await executeSave(contentToSave);
                // Always update the ref (drives `flushAndClose`'s dirty check); only touch
                // React state if still mounted to avoid setState-after-unmount warnings.
                savedContentRef.current = contentToSave;
                if (isMountedRef.current) {
                    setSavedContent(contentToSave);
                    setAutoSaveStatus('saved');
                    if (savedIndicatorTimerRef.current) clearTimeout(savedIndicatorTimerRef.current);
                    savedIndicatorTimerRef.current = setTimeout(() => {
                        if (isMountedRef.current) setAutoSaveStatus('idle');
                    }, 2000);
                }
                onSavedRef.current?.();
                // After save completes, check if content changed during the save (user kept typing)
                if (isMountedRef.current && editContentRef.current !== contentToSave) {
                    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                    debounceTimerRef.current = setTimeout(() => {
                        void doAutoSave(editContentRef.current);
                    }, AUTO_SAVE_DELAY);
                }
            } catch {
                if (isMountedRef.current) setAutoSaveStatus('error');
            } finally {
                isSavingRef.current = false;
                inFlightPromiseRef.current = null;
            }
        })();
        inFlightPromiseRef.current = savePromise;
        void savePromise;
    }, [executeSave]);

    const handleDirectEditChange = useCallback((newValue: string) => {
        setEditContent(newValue);

        // Clear previous debounce
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            void doAutoSave(newValue);
        }, AUTO_SAVE_DELAY);
    }, [doAutoSave]);

    const flushAndClose = useCallback(async () => {
        // Cancel pending debounce
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        // Wait for any in-flight save to finish before checking dirty state
        if (inFlightPromiseRef.current) {
            try { await inFlightPromiseRef.current; } catch { /* ignore — error already handled */ }
        }
        // If there are STILL unsaved direct-edit changes after in-flight completed, save now
        if (isDirectEdit && editContentRef.current !== savedContentRef.current) {
            const toSave = editContentRef.current;
            try {
                await executeSave(toSave);
                // Update the dirty baseline so the unmount-cleanup effect below does NOT
                // fire a second redundant save against the same content. Setting the ref
                // (not React state) is sufficient because the component is about to unmount.
                savedContentRef.current = toSave;
                onSavedRef.current?.();
            } catch {
                // Save failed on close — don't block the close
                toastRef.current.error('关闭时自动保存失败');
            }
        }
        onClose();
    }, [isDirectEdit, executeSave, onClose]);

    /** Cmd+S handler for direct-edit mode — flush debounce and save immediately */
    const handleManualFlush = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        if (editContentRef.current === savedContentRef.current) return; // nothing to save
        void doAutoSave(editContentRef.current);
    }, [doAutoSave]);

    // Wire the actual rename commit logic now that `handleManualFlush` is
    // defined. The toolbar reaches this through the ref-bouncer above so its
    // closure doesn't capture the early-binding `handleManualFlush` undefined.
    //
    // Rename uses fileService.rename → Rust `cmd_workspace_rename` (validates
    // Windows reserved names, path traversal, collision; rejects with error
    // string). Available only when `workspacePath` is set — Settings panels
    // editing `~/.myagents/agents/...` (which use the `onSave` prop) keep
    // the filename as a static span.
    useEffect(() => {
        handleRenameCommitRef.current = async (next: string) => {
            const trimmed = next.trim();
            if (!trimmed || trimmed === name) {
                setIsEditingName(false);
                setNameDraft(name);
                return;
            }
            if (!canRename || !workspacePath) {
                setIsEditingName(false);
                return;
            }
            // Flush any pending autosave first — otherwise the in-flight save
            // would write to the OLD path, then rename would move it, leaving
            // the user's last keystrokes on the wrong file. `handleManualFlush`
            // kicks the save (no return value); `inFlightPromiseRef` lets us
            // await its completion before triggering rename.
            setRenameInFlight(true);
            try {
                if (isDirectEdit && editContentRef.current !== savedContentRef.current) {
                    handleManualFlush();
                }
                if (inFlightPromiseRef.current) {
                    try { await inFlightPromiseRef.current; } catch { /* save errors already toast */ }
                }
                const { newPath } = await fileServiceRef.current.rename({
                    oldPath: pathRef.current,
                    newName: trimmed,
                });
                if (!isMountedRef.current) return;
                // Optimistic: update local ref so any in-flight save targets
                // the new path even before the parent's prop re-flows.
                pathRef.current = newPath;
                onRenamedRef.current?.(newPath, trimmed);
                setIsEditingName(false);
                setNameDraft(trimmed);
            } catch (err) {
                // Surface the Rust error string verbatim — it already reads
                // "Target name already exists" / "Name contains invalid
                // characters" / etc. Keep the editor open so the user can
                // correct without losing the draft.
                if (isMountedRef.current) {
                    toastRef.current.error(err instanceof Error ? err.message : '重命名失败');
                }
            } finally {
                if (isMountedRef.current) setRenameInFlight(false);
            }
        };
    }, [name, canRename, workspacePath, isDirectEdit, handleManualFlush]);

    // Cleanup on unmount: clear timers and fire best-effort save if dirty
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            if (savedIndicatorTimerRef.current) clearTimeout(savedIndicatorTimerRef.current);
            // Best-effort flush: if there are unsaved edits, fire a save (async, not awaited)
            if (editContentRef.current !== savedContentRef.current) {
                void executeSave(editContentRef.current).catch(() => {});
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + stable executeSave; cleanup must only run on unmount
    }, []);

    // ─── Close handler ────────────────────────────────────────────────────────
    const handleClose = useCallback(() => {
        if (isDirectEdit) {
            // Auto-save mode: flush pending save and close (no unsaved-confirm — saves are realtime).
            void flushAndClose();
        } else {
            onClose();
        }
    }, [isDirectEdit, flushAndClose, onClose]);

    // Keep the ref pointed at the latest handleClose so the Cmd+W layer (registered above
    // at module-top, before handleClose existed) routes through the autosave-aware path.
    handleCloseRef.current = handleClose;


    // ─── Quote handlers ──────────────────────────────────────────────────────
    // Stable refs for quote callbacks: the Monaco selection listener registers once and
    // reads via ref so callback identity changes upstream don't tear down the listener.
    const onQuoteFileRef = useRef(onQuoteFile);
    onQuoteFileRef.current = onQuoteFile;
    const onQuoteSelectionRef = useRef(onQuoteSelection);
    onQuoteSelectionRef.current = onQuoteSelection;

    /** Toolbar「引用文件」: kick off any pending edit to disk, **await** the in-flight save
     *  before appending `@<path>` to chat input + closing — without the await the user could
     *  immediately hit ⏎ on the chat input while the file is still being written, causing the
     *  model to read pre-edit content. Mounted-guard after await: handleClose may have run
     *  via a different path (Cmd+W) during the save. */
    const handleQuoteFileClick = useCallback(async () => {
        if (!onQuoteFileRef.current) return;
        if (isDirectEdit && editContentRef.current !== savedContentRef.current) {
            // Kicks off save (no return value); awaits via inFlightPromiseRef below.
            handleManualFlush();
        }
        if (inFlightPromiseRef.current) {
            try { await inFlightPromiseRef.current; } catch { /* save errors already toast */ }
        }
        if (!isMountedRef.current) return;
        onQuoteFileRef.current(pathRef.current);
        // Close after quoting. handleClose handles autosave-aware close path; with the
        // save now flushed, its dirty-check is a no-op (no duplicate save).
        handleCloseRef.current();
    }, [isDirectEdit, handleManualFlush]);

    /** Monaco-side selection quote: forwards line range + text to caller. The toolbar
     *  「引用文件」 path also closes the modal, but selection-quote intentionally does
     *  NOT — users typically quote multiple ranges in succession when reading code. */
    const handleMonacoQuote = useCallback((sel: { text: string; startLine: number; endLine: number }) => {
        onQuoteSelectionRef.current?.(pathRef.current, sel.startLine, sel.endLine, sel.text);
    }, []);

    // Only pass the Monaco quote callback when the parent opted in — keeps the floating
    // menu off non-chat surfaces (settings, etc.) for free.
    const monacoQuote = onQuoteSelection ? handleMonacoQuote : undefined;

    const handleOpenInFinder = useCallback(async () => {
        if (!canReveal || !onRevealFile) return;
        try {
            await onRevealFile();
        } catch {
            toastRef.current.error('无法打开目录');
        }
    }, [canReveal, onRevealFile]);

    // Markdown is in "edit" mode when user toggled the segment AND the file is editable.
    // Read-only markdown stays in preview regardless of toggle (the toggle is hidden anyway).
    const isMdEditView = isMarkdown && canEdit && mdViewMode === 'edit';

    // ─── Render content ───────────────────────────────────────────────────────
    const renderPreviewContent = () => {
        if (isLoading) {
            return monacoLoading;
        }

        if (error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--error)]">
                    <X className="h-8 w-8" />
                    <span className="text-sm">{error}</span>
                </div>
            );
        }

        // Markdown: writable Monaco when toggle = 编辑
        if (isMdEditView) {
            return (
                <Suspense fallback={monacoLoading}>
                    <div className="h-full bg-[var(--paper-elevated)]">
                        <MonacoEditor
                            value={editContent}
                            onChange={handleDirectEditChange}
                            language={effectiveMonacoLanguage}
                            onSave={handleManualFlush}
                            initialLineNumber={initialLineNumber}
                            onQuote={monacoQuote}
                        />
                    </div>
                </Suspense>
            );
        }

        // Markdown: rendered preview (toggle = 预览, OR read-only file)
        if (isMarkdown) {
            // Drive preview from in-memory editContent (latest typing) so flipping back from
            // edit mode reflects what the user just typed even if the autosave debounce
            // hasn't fired yet.
            const previewSource = editContent;
            if (!previewSource.trim()) {
                return (
                    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                        <FileText className="h-10 w-10 opacity-20" />
                        <p className="text-sm">文档内容为空</p>
                        {canEdit && (
                            <button type="button" onClick={() => setMdViewMode('edit')}
                                className="text-sm text-[var(--accent)] hover:underline">
                                切换到编辑
                            </button>
                        )}
                    </div>
                );
            }
            return (
                <div className="h-full overflow-auto overscroll-contain p-6 bg-[var(--paper-elevated)]">
                    <div className="prose prose-stone mx-auto max-w-3xl dark:prose-invert">
                        <Markdown raw preserveNewlines basePath={path ? path.substring(0, path.lastIndexOf('/')) : undefined} workspacePath={workspacePath}>{previewSource}</Markdown>
                    </div>
                </div>
            );
        }

        // Code files: direct writable Monaco with auto-save (or read-only if no edit capability)
        return (
            <Suspense fallback={monacoLoading}>
                <div className="h-full bg-[var(--paper-elevated)]">
                    <MonacoEditor
                        value={isDirectEdit ? editContent : savedContent}
                        onChange={isDirectEdit ? handleDirectEditChange : noop}
                        language={effectiveMonacoLanguage}
                        readOnly={!isDirectEdit}
                        onSave={isDirectEdit ? handleManualFlush : undefined}
                        initialLineNumber={initialLineNumber}
                        onQuote={monacoQuote}
                    />
                </div>
            </Suspense>
        );
    };

    const showMdSegment = isMarkdown && canEdit;

    // ─── Embedded mode ────────────────────────────────────────────────────────
    if (embedded) {
        // 3-col grid keeps the markdown view-mode toggle visually centered while letting
        // the file-info column truncate on narrow widths. When the toggle is absent
        // (non-md or read-only md), the middle column collapses to 0.
        return (
            <div className="flex h-full flex-col overflow-hidden">
                <div className="relative z-10 grid flex-shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-4 py-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-[var(--paper-elevated)] after:to-transparent">
                    {/* Left: file info */}
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-muted)]">
                            <FileText className="h-3.5 w-3.5 text-[var(--accent)]" />
                        </div>
                        <FilenameSlot
                            name={name}
                            canRename={canRename}
                            isEditing={isEditingName}
                            draft={nameDraft}
                            onDraftChange={setNameDraft}
                            onCommit={handleRenameCommit}
                            onCancel={handleRenameCancel}
                            onStartEdit={handleStartRename}
                            busy={renameInFlight}
                            className="text-[13px] font-medium text-[var(--ink)]"
                        />
                        <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                        {isDirectEdit && <AutoSaveIndicator status={autoSaveStatus} />}
                    </div>

                    {/* Middle: markdown view-mode toggle (centered) */}
                    <div className="flex items-center justify-center">
                        {showMdSegment && (
                            <MdViewSegment value={mdViewMode} onChange={setMdViewMode} compact />
                        )}
                    </div>

                    {/* Right: actions */}
                    <div className="flex flex-shrink-0 items-center justify-end gap-2">
                        {/* Quote whole file into chat input — first slot (most-frequent action).
                            `retainFocusOnMouseDown` so the click doesn't steal focus from the
                            chat input on macOS WebKit (matches sibling preview/edit toggle). */}
                        {onQuoteFile && (
                            <Tip label="引用文件" position="bottom">
                                <button type="button"
                                    onClick={handleQuoteFileClick}
                                    onMouseDown={retainFocusOnMouseDown}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <AtSign className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}

                        {/* Switch to browser preview — only for HTML files with an active browser */}
                        {onSwitchToBrowser && (
                            <Tip label="网页预览" position="bottom">
                                <button type="button" onClick={() => {
                                    if (isDirectEdit) handleManualFlush();
                                    onSwitchToBrowser();
                                }}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <Eye className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}

                        {onFullscreen && (
                            <Tip label="全屏预览" position="bottom">
                                <button type="button" onClick={() => {
                                    if (isDirectEdit) {
                                        handleManualFlush();
                                        onFullscreen(editContentRef.current);
                                    } else {
                                        onFullscreen();
                                    }
                                }}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <Expand className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}

                        <Tip label="关闭" position="bottom">
                            <button type="button" onClick={handleClose}
                                className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                    </div>
                </div>
                {/* Content */}
                <div className="flex-1 overflow-hidden">
                    {renderPreviewContent()}
                </div>
            </div>
        );
    }

    // ─── Fullscreen mode (portal) ─────────────────────────────────────────────
    return createPortal(
        <OverlayBackdrop onClose={handleClose} className="z-[210]" style={{ padding: '3vh 3vw' }}>
            {/* Modal content */}
            <div
                className="glass-panel flex h-full w-full max-w-7xl flex-col overflow-hidden"
                onWheel={(e) => e.stopPropagation()}
            >
                {/* Header — 3-col grid keeps the markdown view-mode toggle visually centered */}
                <div className="grid flex-shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-[var(--line)] px-5 py-4 bg-[var(--paper-elevated)]">
                    {/* Left: file info */}
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-muted)]">
                            <FileText className="h-4 w-4 text-[var(--accent)]" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-3">
                                <FilenameSlot
                                    name={name}
                                    canRename={canRename}
                                    isEditing={isEditingName}
                                    draft={nameDraft}
                                    onDraftChange={setNameDraft}
                                    onCommit={handleRenameCommit}
                                    onCancel={handleRenameCancel}
                                    onStartEdit={handleStartRename}
                                    busy={renameInFlight}
                                    className="text-[13px] font-semibold text-[var(--ink)]"
                                />
                                <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                                {isDirectEdit && <AutoSaveIndicator status={autoSaveStatus} />}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="max-w-[400px] truncate text-[11px] text-[var(--ink-muted)]" title={path}>
                                    {shortenPathForDisplay(path)}
                                </span>
                                {canReveal && (
                                    <button
                                        type="button"
                                        onClick={handleOpenInFinder}
                                        className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                        title="打开所在文件夹"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Middle: markdown view-mode toggle (centered) */}
                    <div className="flex items-center justify-center">
                        {showMdSegment && (
                            <MdViewSegment value={mdViewMode} onChange={setMdViewMode} />
                        )}
                    </div>

                    {/* Right: actions */}
                    <div className="flex flex-shrink-0 items-center justify-end gap-1.5">
                        {onQuoteFile && (
                            <Tip label="引用文件" position="bottom">
                                <button type="button"
                                    onClick={handleQuoteFileClick}
                                    onMouseDown={retainFocusOnMouseDown}
                                    className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <AtSign className="h-4 w-4" />
                                </button>
                            </Tip>
                        )}
                        <button
                            type="button"
                            onClick={handleClose}
                            className="inline-flex items-center justify-center rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                        >
                            关闭
                        </button>
                    </div>
                </div>

                {/* Content area */}
                <div className="flex-1 overflow-hidden">
                    {renderPreviewContent()}
                </div>
            </div>
        </OverlayBackdrop>,
        document.body
    );
}
