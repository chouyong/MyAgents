/**
 * BrowserPanel — Embedded browser preview panel for the split view.
 *
 * Renders a navigation toolbar + a placeholder container. The actual
 * web content is rendered by a native Tauri child Webview positioned
 * over the placeholder using absolute coordinates (OS-level overlay).
 *
 * The toolbar always includes a close button (×), so the separate
 * single-view header in Chat.tsx is not needed — one row handles
 * both navigation and panel control.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronLeft, ChevronRight, Code2, RotateCw, ExternalLink, Loader2, Globe, X } from 'lucide-react';
import { openExternal } from '@/utils/openExternal';
import { useBrowserOverlayGuard } from '@/hooks/useBrowserOverlayGuard';
import { useToast } from '@/components/Toast';
import Tip from '@/components/Tip';

interface BrowserPanelProps {
  tabId: string;
  url: string | null;
  /** Whether this panel should be visible (includes isActive + splitActiveView + splitPanelVisible) */
  isVisible: boolean;
  isDraggingSplit: boolean;
  browserAlive: boolean;
  /** When previewing a local file, stores its metadata for editor toggle */
  sourceFile?: { name: string; content: string; size: number; path: string } | null;
  onBrowserCreated: () => void;
  onCreateFailed: () => void;
  onClose: () => void;
  /** Switch to code editor view (only available when sourceFile is set) */
  onSwitchToEditor?: () => void;
  /**
   * Notify parent when the visible URL changes (Rust emits `browser:url-changed`
   * after navigation / page-load). Lets the parent keep its own UI bits — like
   * the split-view tab label — in sync with what the user actually sees.
   */
  onUrlChange?: (url: string) => void;
}

const URL_PLACEHOLDER = '输入网址或搜索…';

export default function BrowserPanel({
  tabId,
  url,
  isVisible,
  isDraggingSplit,
  browserAlive,
  sourceFile,
  onBrowserCreated,
  onCreateFailed,
  onClose,
  onSwitchToEditor,
  onUrlChange,
}: BrowserPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const creatingRef = useRef(false);

  // Toast accessed via ref so the create effect doesn't list it as a dep
  // (project convention — see CLAUDE.md react_stability_rules). Ref is
  // updated in a post-commit effect rather than during render to satisfy
  // react-hooks/refs.
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  // onUrlChange via ref — same reason as toastRef. Lets the url-changed
  // listener effect stay stable across parent re-renders.
  const onUrlChangeRef = useRef(onUrlChange);
  useEffect(() => { onUrlChangeRef.current = onUrlChange; }, [onUrlChange]);

  // Mount-tracking ref to gate post-resolve setState in async chains, guarding
  // the close→reopen race where an unmounted instance's create promise still
  // resolves and would otherwise mutate parent state for the new instance's
  // tabId. Must be declared BEFORE any effect that depends on it.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Whether this webview has ever navigated to a real (non-blank) URL. Once
  // true, subsequent visits to about:blank (e.g. via browser back-button) are
  // shown by the native webview rather than overridden by our React empty
  // state — letting the user see the actual history page instead of the
  // "new tab" UI on every back-press.
  const [hasNavigated, setHasNavigated] = useState(false);

  // ── Editable URL bar state ──
  const [urlEditing, setUrlEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Overlay detection
  const overlayDetected = useBrowserOverlayGuard(browserAlive);

  // Track the last URL we told the webview to load
  const lastRequestedUrlRef = useRef<string | null>(null);

  // ── Create or navigate webview when url prop changes ──
  useEffect(() => {
    if (!url) return;
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    if (!browserAlive && !creatingRef.current) {
      creatingRef.current = true;
      lastRequestedUrlRef.current = url;
      const rect = el.getBoundingClientRect();

      invoke('cmd_browser_create', {
        tabId, url,
        x: rect.x, y: rect.y,
        width: rect.width, height: rect.height,
      })
        .then(() => {
          // Cross-instance race: this resolution may belong to an unmounted
          // BrowserPanel whose `tabId` has been reused by a fresh instance
          // (close → reopen). Calling cmd_browser_close here would kill the
          // new instance's webview. The unmount-cleanup effect already handles
          // teardown for unmounted instances; bail without touching state.
          if (!isMountedRef.current) return;
          if (cancelled) {
            // Same instance, but deps changed mid-create (e.g. url updated).
            // Sync browserAlive=true so the navigate branch on the next effect
            // run can target the new URL via cmd_browser_navigate.
            onBrowserCreated();
            return;
          }
          onBrowserCreated();
        })
        .catch((err) => {
          if (!isMountedRef.current) return;
          console.error('[browser] Create failed:', err);
          if (!cancelled) {
            const msg = typeof err === 'string' ? err : (err?.message ?? String(err));
            toastRef.current.error(`无法打开内嵌浏览器：${msg}`);
            onCreateFailed();
          }
        })
        .finally(() => { creatingRef.current = false; });
    } else if (browserAlive && url !== lastRequestedUrlRef.current) {
      lastRequestedUrlRef.current = url;
      invoke('cmd_browser_navigate', { tabId, url }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [url, browserAlive, tabId, onBrowserCreated, onCreateFailed]);

  // ── Listen for URL/loading events from Rust ──
  useEffect(() => {
    if (!browserAlive) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      const u1 = await listen<string>(`browser:url-changed:${tabId}`, (event) => {
        if (cancelled) return;
        const next = event.payload;
        setCurrentUrl(next);
        // Latch hasNavigated on first real (non-blank) URL — lets the React
        // empty state release control over the panel for the rest of this
        // webview's lifetime.
        if (next && next !== 'about:blank') {
          setHasNavigated((prev) => (prev ? prev : true));
        }
        onUrlChangeRef.current?.(next);
      });
      if (cancelled) { u1(); return; }
      unlisteners.push(u1);

      const u2 = await listen<boolean>(`browser:loading:${tabId}`, (event) => {
        if (!cancelled) setIsLoading(event.payload);
      });
      if (cancelled) { u2(); return; }
      unlisteners.push(u2);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [browserAlive, tabId]);

  // ── ResizeObserver ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !browserAlive) return;

    const syncBounds = () => {
      const rect = el.getBoundingClientRect();
      invoke('cmd_browser_resize', {
        tabId, x: rect.x, y: rect.y,
        width: rect.width, height: rect.height,
      }).catch(() => {});
    };

    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);
    window.addEventListener('resize', syncBounds);
    syncBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [browserAlive, tabId]);

  // Blank-state detection.
  //
  // Anchored to the `url` prop (the URL the parent asked us to load) and a
  // one-way `hasNavigated` latch — NOT to the moving `currentUrl`. This means:
  //   - Toolbar-opened browser (parent passes 'about:blank') → blank state
  //     until the user types a URL and navigates away.
  //   - User opens a chat link (parent passes 'https://…') → never blank.
  //   - User navigates from blank → site → presses Back to about:blank →
  //     hasNavigated stays true, so the native webview keeps control instead
  //     of our React empty state hijacking the back button.
  //
  // Avoiding `currentUrl` here also sidesteps the race where create resolves
  // a frame before the first `browser:url-changed` event arrives (an empty
  // `currentUrl` would otherwise hide the just-alive webview).
  const isBlankPage = url === 'about:blank' && !hasNavigated;

  // ── Consolidated show/hide ──
  useEffect(() => {
    if (!browserAlive) return;
    const shouldShow = isVisible && !isDraggingSplit && !overlayDetected && !isBlankPage;
    if (shouldShow) {
      invoke('cmd_browser_show', { tabId }).catch(() => {});
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        invoke('cmd_browser_resize', {
          tabId, x: rect.x, y: rect.y,
          width: rect.width, height: rect.height,
        }).catch(() => {});
      }
    } else {
      invoke('cmd_browser_hide', { tabId }).catch(() => {});
    }
  }, [isVisible, isDraggingSplit, overlayDetected, browserAlive, isBlankPage, tabId]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    const tid = tabId;
    return () => { invoke('cmd_browser_close', { tabId: tid }).catch(() => {}); };
  }, [tabId]);

  // ── Navigation handlers ──
  const handleGoBack = useCallback(() => {
    invoke('cmd_browser_go_back', { tabId }).catch(() => {});
  }, [tabId]);

  const handleGoForward = useCallback(() => {
    invoke('cmd_browser_go_forward', { tabId }).catch(() => {});
  }, [tabId]);

  const handleReload = useCallback(() => {
    invoke('cmd_browser_reload', { tabId }).catch(() => {});
  }, [tabId]);

  const handleOpenExternal = useCallback(() => {
    // For local file previews, open the file path (not file:// URL) so Tauri
    // shell.open() launches the system default app (same as right-click → Open).
    if (sourceFile?.path) {
      // sourceFile.path is relative — reconstruct absolute path from the file:// URL
      const fileUrl = currentUrl || url || '';
      if (fileUrl.startsWith('file://')) {
        try { openExternal(decodeURIComponent(new URL(fileUrl).pathname)); return; } catch { /* fall through */ }
      }
    }
    if (currentUrl) openExternal(currentUrl);
  }, [currentUrl, url, sourceFile]);

  // ── URL bar editing ──
  const handleUrlClick = useCallback(() => {
    // On blank state, start with empty draft so user can type immediately.
    setUrlDraft(isBlankPage ? '' : currentUrl);
    setUrlEditing(true);
    // Focus will happen after render via autoFocus
  }, [currentUrl, isBlankPage]);

  const handleUrlSubmit = useCallback(() => {
    setUrlEditing(false);
    let trimmed = urlDraft.trim();
    if (!trimmed) return;
    // Add https:// only when the input has no scheme at all. Detecting any
    // RFC-3986 scheme prefix (not just http/https) preserves `about:blank`,
    // `file://`, `data:`, etc. unchanged. Tauri's on_navigation already blocks
    // dangerous schemes (e.g. `javascript:`), so we don't sanitize here.
    if (!/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }
    if (trimmed !== currentUrl) {
      invoke('cmd_browser_navigate', { tabId, url: trimmed }).catch(() => {});
      lastRequestedUrlRef.current = trimmed;
    }
  }, [urlDraft, currentUrl, tabId]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlSubmit();
    } else if (e.key === 'Escape') {
      setUrlEditing(false);
    }
  }, [handleUrlSubmit]);

  // Extract display hostname (suppressed for blank state so we don't show "about:blank" text)
  const displayUrl = currentUrl && !isBlankPage
    ? (() => { try { return new URL(currentUrl).hostname || currentUrl; } catch { return currentUrl; } })()
    : '';

  // No `transition-colors` — let global `button { transition-property: ...transform... }` handle it,
  // so the unified active:scale(0.98) animates smoothly instead of snapping.
  const navBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';

  return (
    <div className="flex h-full flex-col">
      {/* Navigation toolbar — always includes close button (single row for all states) */}
      <div className="relative flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper)] px-2">
        <Tip label="后退" position="bottom">
          <button type="button" className={navBtn} onClick={handleGoBack}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label="前进" position="bottom">
          <button type="button" className={navBtn} onClick={handleGoForward}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label={isLoading ? '停止' : '刷新'} position="bottom">
          <button type="button" className={navBtn} onClick={handleReload}>
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
          </button>
        </Tip>

        {/* Editable URL bar */}
        {urlEditing ? (
          <input
            ref={urlInputRef}
            autoFocus
            placeholder={URL_PLACEHOLDER}
            className="ml-1.5 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-0.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)]"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onBlur={() => setUrlEditing(false)}
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            onClick={handleUrlClick}
            className="ml-1.5 min-w-0 flex-1 cursor-text truncate rounded-[var(--radius-sm)] px-2 py-0.5 text-left text-[12px] transition-colors hover:bg-[var(--paper-inset)]"
            title={isBlankPage ? URL_PLACEHOLDER : currentUrl}
          >
            {isBlankPage ? (
              <span className="text-[var(--ink-faint)]">{URL_PLACEHOLDER}</span>
            ) : (
              <span className="text-[var(--ink-muted)]">{currentUrl}</span>
            )}
          </button>
        )}

        {/* Edit Source — only for local file previews */}
        {sourceFile && onSwitchToEditor && (
          <Tip label="编辑源码" position="bottom" align="end">
            <button type="button" className={navBtn} onClick={onSwitchToEditor}>
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </Tip>
        )}

        <Tip label="在浏览器中打开" position="bottom" align="end">
          <button
            type="button"
            className={navBtn}
            onClick={handleOpenExternal}
            disabled={!currentUrl || isBlankPage}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Close button — always present */}
        <Tip label="关闭浏览器" position="bottom" align="end">
          <button type="button" className={navBtn} onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Loading progress indicator */}
        {isLoading && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
            <div className="animate-indeterminate h-full w-1/3 bg-[var(--accent-warm)]" />
          </div>
        )}
      </div>

      {/* Placeholder container — native Webview overlays this area */}
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-[var(--paper)]">
        {!browserAlive && !isBlankPage && (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-6 w-6" />
              <span className="text-[12px]">{url ? '加载中...' : ''}</span>
            </div>
          </div>
        )}

        {/* Blank state — shown when about:blank or alive-but-no-url. Click anywhere to focus URL bar. */}
        {isBlankPage && (
          <button
            type="button"
            onClick={handleUrlClick}
            className="group absolute inset-0 flex cursor-text select-none flex-col items-center justify-center bg-[var(--paper)] text-left outline-none"
          >
            {/* Soft radial wash for warmth */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 38%, var(--accent-warm-subtle) 0%, transparent 60%)',
              }}
            />
            <div className="relative flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md">
                <Globe
                  className="h-7 w-7 text-[var(--accent-warm)]"
                  strokeWidth={1.5}
                />
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <div className="text-[15px] font-medium tracking-tight text-[var(--ink)]">
                  新标签页
                </div>
                <div className="text-[12px] text-[var(--ink-muted)]">
                  在上方地址栏输入网址或粘贴链接
                </div>
              </div>
            </div>
          </button>
        )}

        {isDraggingSplit && browserAlive && !isBlankPage && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-md">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-5 w-5" />
              <span className="text-[12px]">{displayUrl}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
