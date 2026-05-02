/**
 * FileActionContext — provides inline-code path checking and context menu actions.
 *
 * Used by markdown InlineCode to detect real file/folder paths in AI output
 * and offer quick actions (preview, reference, open-in-finder).
 *
 * Only provided inside Chat; Settings / other pages get null from useFileAction().
 */
import { AtSign, ExternalLink, Eye, FolderOpen } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import ContextMenu from '@/components/ContextMenu';
import type { ContextMenuItem } from '@/components/ContextMenu';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { isImageFile, isPreviewable } from '../../shared/fileTypes';

// Lazy load FilePreviewModal (heavy: includes SyntaxHighlighter + Monaco)
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));

// ---------- Types ----------

interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

export interface FileActionContextValue {
  /** Synchronous cache lookup. Returns cached result or null (pending / not yet requested). */
  checkPath: (path: string) => PathInfo | null;
  /** Incremented each time the cache is updated, so consumers can re-render. */
  cacheVersion: number;
  /** Open the context menu for a resolved path. */
  openFileMenu: (x: number, y: number, path: string, pathType: 'file' | 'dir') => void;
}

interface FileActionProviderProps {
  children: ReactNode;
  /** Workspace path for resolving relative paths (Phase D.5: was previously
   *  inferred from sidecar's `currentAgentDir`; now passed explicitly so the
   *  Provider doesn't depend on a sidecar). */
  workspacePath: string | null;
  /** Callback to insert @-reference into the chat input. */
  onInsertReference?: (paths: string[]) => void;
  /** When this value changes, the path cache is cleared (e.g. toolCompleteCount). */
  refreshTrigger?: number;
  /** When provided, "预览" routes to this callback (split-view) instead of fullscreen modal. */
  onFilePreviewExternal?: (file: { name: string; content: string; size: number; path: string }) => void;
  /** Append `@<path> ` to chat input — wired to FilePreviewModal's「引用文件」button.
   *  Distinct from `onInsertReference` (cursor-insert, no trailing space) — the toolbar
   *  button always appends to end with trailing space, matching the「丢进对话框继续聊」 UX. */
  onQuoteFile?: (path: string) => void;
  /** Append `@<path>#L<start>[-L<end>] ` to chat input — wired to FilePreviewModal's
   *  Monaco selection-quote affordance. */
  onQuoteSelection?: (path: string, startLine: number, endLine: number) => void;
}

// ---------- Context ----------

const FileActionContext = createContext<FileActionContextValue | null>(null);

export function useFileAction(): FileActionContextValue | null {
  return useContext(FileActionContext);
}

// ---------- Provider ----------

const BATCH_DELAY_MS = 50;

export function FileActionProvider({ children, workspacePath, onInsertReference, refreshTrigger, onFilePreviewExternal, onQuoteFile, onQuoteSelection }: FileActionProviderProps) {
  const fileService = useWorkspaceFileService(workspacePath);
  const { openPreview: openImagePreview } = useImagePreview();

  // Stabilise callbacks via refs
  const onInsertReferenceRef = useRef(onInsertReference);
  onInsertReferenceRef.current = onInsertReference;

  const onFilePreviewExternalRef = useRef(onFilePreviewExternal);
  onFilePreviewExternalRef.current = onFilePreviewExternal;

  // Stabilise fileService so async closures see the latest service without
  // re-binding callbacks. Mirrors the React-stability rules pattern used
  // elsewhere (toastRef, apiPostRef in legacy code).
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;

  // Guard against setState after unmount
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ---------- Path cache ----------
  const pathCacheRef = useRef<Map<string, PathInfo>>(new Map());
  const pendingPathsRef = useRef<Set<string>>(new Set());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  // Clear cache when refreshTrigger changes
  useEffect(() => {
    pathCacheRef.current.clear();
    pendingPathsRef.current.clear();
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    setCacheVersion(v => v + 1);
  }, [refreshTrigger]);

  // Clean up batch timer on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, []);

  // Flush pending paths to the backend (Rust workspace_files::check_paths
  // since Phase D.5 — used to be sidecar `/agent/check-paths`).
  const flushPendingPaths = useCallback(() => {
    const paths = Array.from(pendingPathsRef.current);
    pendingPathsRef.current.clear();
    batchTimerRef.current = null;

    if (paths.length === 0) return;
    if (!fileServiceRef.current.isAvailable) return;

    void (async () => {
      try {
        const resp = await fileServiceRef.current.checkPaths({ paths });
        if (!isMountedRef.current) return;
        if (resp?.results) {
          for (const [p, info] of Object.entries(resp.results)) {
            pathCacheRef.current.set(p, info);
          }
          setCacheVersion(v => v + 1);
        }
      } catch {
        // Silently ignore — paths will stay un-cached and remain as plain <code>
      }
    })();
  }, []);

  const checkPath = useCallback((path: string): PathInfo | null => {
    const cached = pathCacheRef.current.get(path);
    if (cached) return cached;

    // Already queued
    if (pendingPathsRef.current.has(path)) return null;

    // Enqueue
    pendingPathsRef.current.add(path);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushPendingPaths, BATCH_DELAY_MS);
    }
    return null;
  }, [flushPendingPaths]);

  // ---------- Context menu ----------
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    path: string;
    pathType: 'file' | 'dir';
  } | null>(null);

  const openFileMenu = useCallback((x: number, y: number, path: string, pathType: 'file' | 'dir') => {
    setMenuState({ x, y, path, pathType });
  }, []);

  const closeMenu = useCallback(() => setMenuState(null), []);

  // ---------- Preview state ----------
  const [previewFile, setPreviewFile] = useState<{
    name: string;
    content: string;
    size: number;
    path: string;
    isLoading: boolean;
    error: string | null;
  } | null>(null);

  const handlePreview = useCallback((path: string) => {
    const fileName = path.split('/').pop() ?? path;
    const svc = fileServiceRef.current;
    if (!svc.isAvailable) return;

    if (isImageFile(fileName)) {
      void (async () => {
        let handle: { blobUrl: string; revoke: () => void } | null = null;
        try {
          handle = await svc.readFileAsBlobUrl({ path });
          if (!isMountedRef.current) {
            handle.revoke();
            return;
          }
          // Convert blob URL → data URL for the image preview overlay.
          // The preview component caches the data URL, so we can release
          // the blob URL immediately afterwards.
          const resp = await fetch(handle.blobUrl);
          const blob = await resp.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });
          if (!isMountedRef.current) return;
          openImagePreview(dataUrl, fileName);
        } catch (err) {
          console.error('[FileAction] Failed to load image:', err);
        } finally {
          if (handle) handle.revoke();
        }
      })();
      return;
    }

    if (!isPreviewable(fileName)) return;

    // Route to split-view if external handler provided
    if (onFilePreviewExternalRef.current) {
      void (async () => {
        try {
          const resp = await svc.readPreview({ path });
          if (!isMountedRef.current) return;
          onFilePreviewExternalRef.current?.({ name: resp.name, content: resp.content, size: resp.size, path });
        } catch { /* split-view fetch errors handled by DirectoryPanel toast */ }
      })();
      return;
    }

    // Fallback: show fullscreen modal immediately in loading state
    setPreviewFile({ name: fileName, content: '', size: 0, path, isLoading: true, error: null });

    void (async () => {
      try {
        const resp = await svc.readPreview({ path });
        if (!isMountedRef.current) return;
        setPreviewFile(prev => prev ? { ...prev, content: resp.content, size: resp.size, name: resp.name, isLoading: false } : null);
      } catch (err) {
        if (!isMountedRef.current) return;
        setPreviewFile(prev => prev ? { ...prev, isLoading: false, error: err instanceof Error ? err.message : 'Failed to load file' } : null);
      }
    })();
  }, [openImagePreview]);

  const handleReference = useCallback((path: string) => {
    onInsertReferenceRef.current?.([path]);
  }, []);

  const handleOpenWithDefault = useCallback((path: string) => {
    void fileServiceRef.current.openWithDefault({ path }).catch(() => {});
  }, []);

  const handleOpenInFinder = useCallback((path: string) => {
    void fileServiceRef.current.openInFinder({ path }).catch(() => {});
  }, []);

  // Build menu items
  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menuState) return [];
    const { path, pathType } = menuState;
    const fileName = path.split('/').pop() ?? path;
    const items: ContextMenuItem[] = [];

    if (pathType === 'file') {
      const canPreview = isPreviewable(fileName) || isImageFile(fileName);
      items.push({
        label: '预览',
        icon: <Eye className="h-4 w-4" />,
        disabled: !canPreview,
        onClick: () => handlePreview(path),
      });
    }

    items.push({
      label: '引用',
      icon: <AtSign className="h-4 w-4" />,
      onClick: () => handleReference(path),
    });

    items.push({
      label: '打开',
      icon: <ExternalLink className="h-4 w-4" />,
      onClick: () => handleOpenWithDefault(path),
    });

    items.push({
      label: '打开所在文件夹',
      icon: <FolderOpen className="h-4 w-4" />,
      onClick: () => handleOpenInFinder(path),
    });

    return items;
  }, [menuState, handlePreview, handleReference, handleOpenWithDefault, handleOpenInFinder]);

  // ---------- Context value ----------
  const contextValue = useMemo<FileActionContextValue>(() => ({
    checkPath,
    cacheVersion,
    openFileMenu,
  }), [checkPath, cacheVersion, openFileMenu]);

  return (
    <FileActionContext.Provider value={contextValue}>
      {children}

      {/* Context menu */}
      {menuState && (
        <ContextMenu
          x={menuState.x}
          y={menuState.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}

      {/* File preview modal (lazy loaded) */}
      {previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={previewFile.name}
            content={previewFile.content}
            size={previewFile.size}
            path={previewFile.path}
            isLoading={previewFile.isLoading}
            error={previewFile.error}
            // Phase D.5: thread the absolute workspace root so rendered
            // markdown can load relative-path images via fileService.
            // Without this, MarkdownImage's hook gets `null` and silently
            // skips the fetch (preview text/code still works).
            workspacePath={workspacePath}
            onClose={() => setPreviewFile(null)}
            onRenamed={(newPath, newName) => {
              // Update local preview state so subsequent saves target the new
              // location. The fs watcher refreshes the directory tree.
              setPreviewFile((prev) =>
                prev ? { ...prev, path: newPath, name: newName } : prev,
              );
            }}
            // Phase D.5: route reveal-in-finder through fileService rather
            // than letting the modal fall back to sidecar `/agent/open-in-finder`.
            onRevealFile={async () => {
              const p = previewFile.path;
              await fileServiceRef.current.openInFinder({ path: p });
            }}
            onQuoteFile={onQuoteFile}
            onQuoteSelection={onQuoteSelection}
          />
        </Suspense>
      )}
    </FileActionContext.Provider>
  );
}
