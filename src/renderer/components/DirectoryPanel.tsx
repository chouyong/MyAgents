import {
  AtSign,
  ChevronUp,
  Eye,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  NotebookPen,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Upload,
  ExternalLink,
  TerminalSquare,
  Search,
  Globe,
  PanelRightClose,
  X,
} from "lucide-react";
import Tip from "@/components/Tip";
import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";

import { useTabApi } from "@/context/TabContext";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import type {
  DirectoryTreeNode,
  DirectoryTree,
} from "../../shared/dir-types";
import { isImageFile, isPreviewable } from "../../shared/fileTypes";
import type { CapabilityInitialSelect } from "../../shared/skillsTypes";
import { getFileIcon } from "@/utils/fileIcons";

import { useImagePreview } from "@/context/ImagePreviewContext";
import { useToast } from "@/components/Toast";
import { type Provider } from "@/config/types";
import { isDebugMode } from "@/utils/debug";
import { listenWithCleanup } from "@/utils/tauriListen";
import { shortenPathForDisplay } from "@/utils/pathDetection";

import ConfirmDialog from "./ConfirmDialog";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { searchWorkspaceFiles, refreshWorkspaceFileIndex, type FileSearchHit } from "@/api/searchClient";
import FileSearchResults from "./search/FileSearchResults";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);
  return debouncedValue;
}
import RenameDialog from "./RenameDialog";
import AgentCapabilitiesPanel from "./AgentCapabilitiesPanel";
import WorkspaceIcon from "./launcher/WorkspaceIcon";
import { useWorkspaceTreeModel } from "./workspace-tree/useWorkspaceTreeModel";
import { WorkspaceTreeViewport } from "./workspace-tree/WorkspaceTreeViewport";
import type { VisibleTreeRow } from "./workspace-tree/treeTypes";

// Lazy load FilePreviewModal - it includes heavy SyntaxHighlighter
const FilePreviewModal = lazy(() => import("./FilePreviewModal"));

/** Imperative handle for DirectoryPanel */
export interface DirectoryPanelHandle {
  /** Handle file drop from Tauri (takes absolute file paths) */
  handleFileDrop: (paths: string[]) => Promise<void>;
  /** Refresh the directory tree */
  refresh: () => void;
}

interface DirectoryPanelProps {
  agentDir: string;
  /** Workspace icon ID (Phosphor) from project config */
  projectIcon?: string;
  /** Custom display name from project config */
  projectDisplayName?: string;
  provider?: Provider | null;
  providers?: Provider[];
  onProviderChange?: (providerId: string, targetModel?: string) => void;
  /** Called when user clicks collapse button (only in wide mode) */
  onCollapse?: () => void;
  /** Called when user clicks "项目设置" button */
  onOpenConfig?: () => void;
  /** External trigger to refresh (incremented when file-modifying tools complete) */
  refreshTrigger?: number;
  /** Trigger full refresh (file tree + capabilities) — called from context menu */
  onRefreshAll?: () => void;
  /** Whether Tauri drag is active over this panel */
  isTauriDragActive?: boolean;
  /** Called when user clicks "引用" to insert @path reference into chat input */
  onInsertReference?: (paths: string[]) => void;
  /** FilePreviewModal「引用文件」: append `@<path> ` to chat input. Forwarded to the
   *  inline FilePreviewModal mounted by this panel (only used when `onFilePreviewExternal`
   *  is not set — split-view path renders its own modal in Chat.tsx). */
  onQuoteFile?: (path: string) => void;
  /** FilePreviewModal selection-quote: append `@<path>#L<start>[-L<end>] ` to chat input. */
  onQuoteSelection?: (path: string, startLine: number, endLine: number) => void;
  /** Enabled sub-agent definitions (from Chat.tsx) */
  enabledAgents?: Record<
    string,
    {
      description: string;
      prompt?: string;
      model?: string;
      scope?: "user" | "project";
      folderName?: string;
    }
  >;
  enabledSkills?: Array<{
    name: string;
    description: string;
    scope?: "user" | "project";
    folderName?: string;
  }>;
  enabledCommands?: Array<{
    name: string;
    description: string;
    scope?: "user" | "project";
    fileName?: string;
  }>;
  /** Set of global skill folderNames (for hiding "sync to global" on already-global skills) */
  globalSkillFolderNames?: Set<string>;
  /** Insert /command into chat input */
  onInsertSlashCommand?: (command: string) => void;
  /** Open settings panel (skills tab); when invoked from "设置" on a specific item,
   *  the receiving panel uses `initialSelect` to open that item's detail directly. */
  onOpenSettings?: (initialSelect?: CapabilityInitialSelect) => void;
  /** Copy a project skill to global skills */
  onSyncSkillToGlobal?: (folderName: string) => void;
  /** When provided, file clicks route to this callback instead of opening the modal.
   *  Used by split-view mode (experimentalSplitView) to open files in a side panel.
   *
   *  `options.initialEditMode` is set by 「新建笔记」 so the freshly-created
   *  empty `note-…md` opens directly in the editable Monaco view instead of
   *  the rendered-preview empty-state. */
  onFilePreviewExternal?: (
    file: {
      name: string;
      content: string;
      size: number;
      path: string;
    },
    options?: { initialEditMode?: boolean },
  ) => void;
  /** Open embedded terminal in split panel */
  onOpenTerminal?: () => void;
  /** Whether an embedded terminal is currently alive (for indicator display) */
  terminalAlive?: boolean;
  /** Open embedded browser in split panel (creates a blank page if not yet open) */
  onOpenBrowser?: () => void;
}

type FilePreview = {
  name: string;
  content: string;
  size: number;
  path: string;
  /** When set, FilePreviewModal opens in markdown edit mode directly.
   *  Wired by 「新建笔记」 so a fresh empty `note-…md` skips the rendered-
   *  preview empty-state and lands the cursor in Monaco. */
  initialEditMode?: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
  node: DirectoryTreeNode | null; // null means root directory
  isMultiSelect?: boolean; // true when multiple nodes are selected
} | null;

type DialogState = {
  type: "rename" | "delete" | "new-file" | "new-folder" | "delete-multi";
  node: DirectoryTreeNode | null; // null means root directory for new-file/new-folder
  nodes?: DirectoryTreeNode[]; // for delete-multi
} | null;

function getFolderName(path: string): string {
  if (!path) return "Workspace";
  // Normalize path separators (support both / and \) and trim trailing slashes
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "Workspace";
}

const DirectoryPanel = memo(
  forwardRef<DirectoryPanelHandle, DirectoryPanelProps>(function DirectoryPanel(
    {
      agentDir,
      projectIcon,
      projectDisplayName,
      provider: _provider,
      providers: _providers = [],
      onProviderChange: _onProviderChange,
      onCollapse,
      onOpenConfig,
      refreshTrigger,
      onRefreshAll,
      isTauriDragActive = false,
      onInsertReference,
      onQuoteFile,
      onQuoteSelection,
      enabledAgents,
      enabledSkills,
      enabledCommands,
      globalSkillFolderNames,
      onInsertSlashCommand,
      onOpenSettings,
      onSyncSkillToGlobal,
      onFilePreviewExternal,
      onOpenTerminal,
      terminalAlive,
      onOpenBrowser,
    },
    ref,
  ) {
    const [directoryInfo, setDirectoryInfo] = useState<DirectoryTree | null>(
      null,
    );
    const [error, setError] = useState<string | null>(null);
    // Multi-selection support
    const [selectedNodes, setSelectedNodes] = useState<DirectoryTreeNode[]>([]);
    const lastClickedPathRef = useRef<string | null>(null); // Anchor for shift-select
    const [isUploading, setIsUploading] = useState(false);
    const [preview, setPreview] = useState<FilePreview | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    // Monotonic counter for "latest preview request wins". Every async preview
    // path (text preview, image preview, search-result preview) bumps this on
    // entry and re-checks before committing state — old in-flight requests are
    // dropped silently so a slow file's response can't overwrite the fresh
    // click's result, double-fire toasts, or strand `isPreviewLoading=true`.
    // React `useState` is unsuitable as a concurrency lock because state
    // updates are async; two rapid clicks both pass a `if (isPreviewLoading)`
    // gate that closure-captured the pre-update value. `useRef` is the
    // sync-visible alternative the project's React-stability rules call for.
    const previewReqIdRef = useRef(0);
    const treeContainerRef = useRef<HTMLDivElement>(null);
    const importInputRef = useRef<HTMLInputElement>(null);

    // Context menu and dialog states
    const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
    const [dialog, setDialog] = useState<DialogState>(null);
    const [importTargetDir, setImportTargetDir] = useState<string>("");

    // External drag-drop state
    const [isExternalDrop, setIsExternalDrop] = useState(false);
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
    const dragCounterRef = useRef(0);

    // Internal drag-drop state (@dnd-kit pointer-events based)
    const [activeDragItem, setActiveDragItem] = useState<{
      paths: string[];
      name: string;
      icon: React.ElementType;
    } | null>(null);
    const [internalDropTarget, setInternalDropTarget] = useState<string | null>(
      null,
    );
    const internalDropTargetRef = useRef<string | null>(null);
    const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const treeScrollTopRef = useRef(0);

    const ROW_HEIGHT = 26;

    // Git branch state
    const [gitBranch, setGitBranch] = useState<string | null>(null);

    // Lazy loading state - track directories currently being loaded
    // Use ref to store actual data, state only for triggering UI updates
    const loadingDirsRef = useRef<Set<string>>(new Set());
    const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

    // Search state
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<FileSearchHit[]>([]);
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
    const searchInputRef = useRef<HTMLInputElement>(null);

    const debouncedSearchQuery = useDebounce(searchQuery, 300);

    // Image preview context
    const { openPreview } = useImagePreview();

    // When entering search mode, incrementally refresh the Tantivy file index
    // against the current filesystem. `refreshWorkspaceFileIndex` walks metadata
    // only and re-indexes just the files whose mtime/size changed — cheap on a
    // warm cache, full-build on cold. This picks up any files the AI / user
    // created since the last session without paying the 20s full-reindex cost.
    useEffect(() => {
      if (isSearchMode) {
        refreshWorkspaceFileIndex(agentDir).catch(() => {});
      }
    }, [isSearchMode, agentDir]);

    // Trigger search
    useEffect(() => {
      if (!isSearchMode) return;
      if (debouncedSearchQuery.trim() === "") {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }
      let isMounted = true;
      const runSearch = async () => {
        setIsSearching(true);
        try {
          const result = await searchWorkspaceFiles(debouncedSearchQuery, agentDir);
          if (isMounted) {
            setSearchResults(result.hits);
            setExpandedFiles(new Set(result.hits.map(h => h.path)));
          }
        } catch (err) {
          console.error("File search failed:", err);
        } finally {
          if (isMounted) setIsSearching(false);
        }
      };
      runSearch();
      return () => { isMounted = false; };
    }, [debouncedSearchQuery, agentDir, isSearchMode]);

    // Toast for notifications
    const toast = useToast();

    // Get Tab-scoped API functions and tabId
    // PRD 0.2.7 Phase D: useTabApi() return value is no longer destructured —
    // file IO has migrated entirely to `useWorkspaceFileService`. The TabApi
    // hook still wraps React subscription state, so keeping the call
    // ensures the component re-renders when Tab context changes (active /
    // inactive). If a future refactor proves the call has no observable
    // side effects, it can be dropped.
    useTabApi();
    // PRD 0.2.7 Phase D: workspace file IO migrated from sidecar HTTP to Rust
    // invoke. The hook is identical to the one SimpleChatInput uses, just with
    // the additional Phase D operations (dirTree, dirExpand, readPreview, etc.).
    const fileService = useWorkspaceFileService(agentDir ?? null);

    // Narrow mode collapse state (for responsive layout)
    const [isNarrowMode, setIsNarrowMode] = useState(false);

    // ── Vertical drag: tree / capabilities ratio ──
    // Default 0.6 = tree 60%, capabilities 40%. Resets on tab close (local state).
    const [capRatio, setCapRatio] = useState(0.4);
    const capRatioRef = useRef(0.4);
    capRatioRef.current = capRatio;
    const isDraggingCapRef = useRef(false);
    const capDragMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
    const capDragUpRef = useRef<(() => void) | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(true); // Default collapsed in narrow mode
    const panelRef = useRef<HTMLDivElement>(null);

    // Detect narrow mode (when panel becomes full width, i.e. stacked layout)
    useEffect(() => {
      const checkNarrowMode = () => {
        // Check if we're in stacked/narrow layout by checking window width
        // Use CSS custom property --breakpoint-mobile (768px) for consistency
        const breakpoint = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--breakpoint-mobile",
          ) || "768",
          10,
        );
        const narrow = window.innerWidth < breakpoint;
        setIsNarrowMode(narrow);
        if (!narrow) {
          setIsCollapsed(false); // Always show in wide mode
        } else {
          setIsCollapsed(true); // Default collapsed in narrow mode
        }
      };

      checkNarrowMode();
      window.addEventListener("resize", checkNarrowMode);
      return () => window.removeEventListener("resize", checkNarrowMode);
    }, []);

    const folderName = getFolderName(agentDir);

    // Track previous item count to only log when changed
    const prevItemCountRef = useRef(-1);

    // Raw refresh — fetches full directory tree from backend.
    // Not debounced; used for initial load and explicit user actions (manual refresh button).
    //
    // MUST NOT invalidate the file search index here. This runs on every file
    // watcher event (AI tool completion, Monaco save, external edits), so
    // invalidating would thrash the Tantivy index and force a full rebuild of
    // ~1000+ files on every keystroke in the search box while the agent is
    // actively writing files. The search index is invalidated in a dedicated
    // effect that fires ONLY when search mode is entered, so each search
    // session gets a fresh index exactly once.
    const rawRefresh = useCallback(() => {
      setError(null);
      fileService.dirTree()
        .then((data) => {
          const newCount = data.tree?.children?.length || 0;
          if (newCount !== prevItemCountRef.current) {
            console.log(
              `[DirectoryPanel] Directory tree refreshed: ${newCount} items`,
            );
            prevItemCountRef.current = newCount;
          }
          setDirectoryInfo(data);
        })
        .catch((err) => {
          // PRD 0.2.7 Phase D: switching from sidecar HTTP to Rust invoke
          // means we no longer have to wait for sidecar readiness before
          // refreshing — Rust commands are always live. A failure here is
          // genuine (workspace deleted, permission denied, etc).
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load directory info",
          );
          console.error("[DirectoryPanel] Failed to refresh:", err);
        });
    }, [fileService]);

    // Debounced refresh — coalesces rapid triggers (file watcher + tool completion
    // can fire within 500ms of each other) into a single API call.
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refresh = useCallback(() => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        rawRefresh();
      }, 300);
    }, [rawRefresh]);

    // Cleanup debounce timer on unmount
    useEffect(() => {
      return () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      };
    }, []);

    // Stable ref for refresh to avoid timer recreation
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;

    // Helper to update a specific node in the tree
    const updateNodeInTree = useCallback(
      (
        nodes: DirectoryTreeNode[],
        targetPath: string,
        updater: (node: DirectoryTreeNode) => DirectoryTreeNode,
      ): DirectoryTreeNode[] => {
        return nodes.map((node) => {
          if (node.path === targetPath) {
            return updater(node);
          }
          if (node.children && node.type === "dir") {
            return {
              ...node,
              children: updateNodeInTree(node.children, targetPath, updater),
            };
          }
          return node;
        });
      },
      [],
    );

    // Expand a directory that hasn't been fully loaded
    const expandDir = useCallback(
      async (dirPath: string) => {
        // Use ref to check loading status (stable reference, avoids dependency issues)
        if (loadingDirsRef.current.has(dirPath)) return; // Already loading

        // Update both ref and state
        loadingDirsRef.current.add(dirPath);
        setLoadingDirs(new Set(loadingDirsRef.current));

        try {
          const result = await fileService.dirExpand({ path: dirPath });

          setDirectoryInfo((prev: DirectoryTree | null) => {
            if (!prev) return prev;
            const updatedChildren = updateNodeInTree(
              prev.tree.children ?? [],
              dirPath,
              (node) => ({
                ...node,
                children: result.children,
                loaded: result.loaded,
              }),
            );
            return {
              ...prev,
              tree: {
                ...prev.tree,
                children: updatedChildren,
              },
            };
          });
        } catch (err) {
          console.error("[DirectoryPanel] Failed to expand directory:", err);
        } finally {
          // Update both ref and state
          loadingDirsRef.current.delete(dirPath);
          setLoadingDirs(new Set(loadingDirsRef.current));
        }
      },
      [fileService, updateNodeInTree],
    );

    useEffect(() => {
      rawRefresh(); // Initial load — no debounce needed
      // Clear old branch first to avoid flash, then fetch new
      setGitBranch(null);
      fileService.gitBranch()
        .then((data) => setGitBranch(data.branch))
        .catch(() => setGitBranch(null));
    }, [agentDir, fileService, rawRefresh]);

    // Respond to external refresh trigger (parent-driven, e.g. tool completion
    // fast-path). Uses debounced refresh to coalesce rapid triggers.
    useEffect(() => {
      if (refreshTrigger && refreshTrigger > 0) {
        refresh();
      }
    }, [refreshTrigger, refresh]);

    // PRD 0.2.7 Phase D: Tauri-side workspace fs watcher.
    //
    // Pre-PRD-0.2.7 the sidecar emitted SSE `agent:files-changed` from a Node
    // chokidar watcher and DirectoryPanel listened via the SSE proxy. Phase D
    // moves the watch to Rust (notify-debouncer-full) so the panel works
    // without a sidecar; the event hops Tauri-side via `app.emit` and the
    // renderer subscribes through `@tauri-apps/api/event::listen`.
    //
    // Lifecycle: start the watch on mount (or when agentDir changes), stop on
    // unmount. The Rust side ref-counts, so multiple panels on the same
    // workspace share one OS watch.
    useEffect(() => {
      if (!fileService.isAvailable) return;
      const ac = new AbortController();
      let token: string | null = null;

      (async () => {
        try {
          // Phase D.5 — single round-trip returns the token (held for stop)
          // and the eventKey (used for the listen subscription).
          const handle = await fileService.watchStart();
          if (ac.signal.aborted) {
            // Race: unmount fired during the await — release immediately.
            await fileService.watchStop({ token: handle.token }).catch(() => {});
            return;
          }
          token = handle.token;
          await listenWithCleanup(`workspace:files-changed:${handle.eventKey}`, () => {
            // Coarse signal — refresh re-fetches the whole tree (debounced).
            refreshRef.current();
          }, ac.signal);
        } catch (err) {
          console.warn("[DirectoryPanel] watch start failed:", err);
        }
      })();

      return () => {
        ac.abort();
        if (token) {
          fileService.watchStop({ token }).catch(() => {});
        }
      };
    }, [fileService]);

    // Safety-net polling: catch anything the file watcher might miss.
    // With the watcher active, this is a fallback — 120s is sufficient.
    useEffect(() => {
      const interval = setInterval(() => refreshRef.current(), 120_000);
      return () => clearInterval(interval);
    }, []);

    // Vertical divider drag handler (tree ↔ capabilities)
    const handleCapDividerMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingCapRef.current = true;
      const startY = e.clientY;
      const startRatio = capRatioRef.current;
      const containerHeight = (
        e.currentTarget.parentElement as HTMLElement
      ).getBoundingClientRect().height;
      if (containerHeight <= 0) return; // Guard against zero-height container (collapsed/hidden)

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDraggingCapRef.current) return;
        const dy = ev.clientY - startY;
        // dy > 0 = mouse moves down = capabilities shrinks
        const newRatio = Math.max(
          0.15,
          Math.min(0.65, startRatio - dy / containerHeight),
        );
        setCapRatio(newRatio);
      };
      const onMouseUp = () => {
        isDraggingCapRef.current = false;
        capDragMoveRef.current = null;
        capDragUpRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      capDragMoveRef.current = onMouseMove;
      capDragUpRef.current = onMouseUp;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    }, []); // stable — uses refs

    // Cleanup cap drag listeners on unmount (match Chat.tsx pattern: reset body styles too)
    useEffect(() => {
      return () => {
        if (capDragMoveRef.current)
          document.removeEventListener("mousemove", capDragMoveRef.current);
        if (capDragUpRef.current)
          document.removeEventListener("mouseup", capDragUpRef.current);
        isDraggingCapRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }, []);

    const treeData = useMemo(() => {
      return directoryInfo?.tree.children ?? [];
    }, [directoryInfo]);
    const selectedPaths = useMemo(
      () => selectedNodes.map((node) => node.path),
      [selectedNodes],
    );
    const {
      closePath,
      getRangeSelection,
      getStickyAncestors,
      nodeMetaByPath,
      openPath,
      togglePath,
      visibleRows,
    } = useWorkspaceTreeModel({
      loadingPaths: loadingDirs,
      rootChildren: treeData,
      selectedPaths,
    });

    // Pending-selection paths — used by 「新建笔记」 to keep the synthetic
    // newly-created file selected through the brief window between
    // `setSelectedNodes` and the watcher-driven tree refresh that surfaces
    // the file in `nodeMetaByPath`. Without this guard, the reconciliation
    // below would prune the synthetic node before the refresh resolves
    // (Codex round-4 caught). Pending paths auto-evict after 5 s — if the
    // file truly never materialises (deleted externally mid-creation), we
    // fall back to the normal filter behaviour.
    const pendingSelectionPathsRef = useRef<Set<string>>(new Set());
    const markPendingSelection = useCallback((path: string) => {
      pendingSelectionPathsRef.current.add(path);
      setTimeout(() => pendingSelectionPathsRef.current.delete(path), 5000);
    }, []);

    useEffect(() => {
      setSelectedNodes((prev) => {
        const pending = pendingSelectionPathsRef.current;
        const next = prev.filter((node) =>
          nodeMetaByPath.has(node.path) || pending.has(node.path),
        );
        // Once a pending path materialises in nodeMetaByPath, drop it from
        // pending — the real node has taken over.
        for (const p of Array.from(pending)) {
          if (nodeMetaByPath.has(p)) pending.delete(p);
        }
        return next.length === prev.length ? prev : next;
      });
      if (
        lastClickedPathRef.current &&
        !nodeMetaByPath.has(lastClickedPathRef.current)
      ) {
        lastClickedPathRef.current = null;
      }
    }, [nodeMetaByPath]);

    const handlePreview = async (node: DirectoryTreeNode) => {
      if (node.type !== "file") return;

      const myReq = ++previewReqIdRef.current;
      setIsPreviewLoading(true);

      try {
        const payload = await fileService.readPreview({ path: node.path });
        if (myReq !== previewReqIdRef.current) return; // superseded by newer click
        const fileData = { ...payload, path: node.path };
        if (onFilePreviewExternal) {
          onFilePreviewExternal(fileData);
        } else {
          setPreview(fileData);
          setPreviewError(null);
        }
      } catch (err) {
        if (myReq !== previewReqIdRef.current) return; // superseded; don't toast/commit stale error
        if (onFilePreviewExternal) {
          toast.error("文件预览失败");
        } else {
          setPreview(null);
          setPreviewError(
            err instanceof Error ? err.message : "Failed to preview file.",
          );
        }
      } finally {
        // Only the latest request controls the loading indicator. Stale
        // finalizers (a slow earlier request finishing after a newer one) skip
        // the setter so the UI keeps reflecting the fresh in-flight request.
        if (myReq === previewReqIdRef.current) setIsPreviewLoading(false);
      }
    };

    const handleSearchItemClick = async (path: string, initialLineNumber?: number) => {
      const myReq = ++previewReqIdRef.current;
      setIsPreviewLoading(true);
      try {
        const payload = await fileService.readPreview({ path });
        if (myReq !== previewReqIdRef.current) return; // superseded
        const fileData = { ...payload, path, initialLineNumber };
        if (onFilePreviewExternal) {
          onFilePreviewExternal(fileData);
        } else {
          setPreview(fileData);
          setPreviewError(null);
        }
      } catch (err) {
        if (myReq !== previewReqIdRef.current) return; // superseded
        if (onFilePreviewExternal) {
          toast.error("文件预览失败");
        } else {
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : "Failed to preview file.");
        }
      } finally {
        if (myReq === previewReqIdRef.current) setIsPreviewLoading(false);
      }
    };

    const handleImagePreview = async (node: DirectoryTreeNode) => {
      if (node.type !== "file") return;
      const myReq = ++previewReqIdRef.current;
      try {
        // PRD 0.2.7 Phase D: pre-migration this fetched the sidecar's
        // /agent/download via Rust proxy, then converted the response Blob
        // to a data URL. Rust now returns base64 directly so we skip the
        // FileReader trip — `data:<mime>;base64,<body>` is the same thing
        // FileReader.readAsDataURL would have produced.
        const result = await fileService.downloadFile({ path: node.path });
        if (myReq !== previewReqIdRef.current) return; // superseded
        const dataUrl = `data:${result.mimeType};base64,${result.data}`;
        openPreview(dataUrl, node.name);
      } catch (err) {
        if (myReq !== previewReqIdRef.current) return; // superseded
        console.error("[DirectoryPanel] Failed to load image:", err);
        toast.error("图片加载失败");
      }
    };

    // Pre-PRD-0.2.7: a hidden <input type="file" multiple> fed File objects
    // here, which we wrapped in FormData and POSTed to /agent/import (cap
    // 500MB, streamed to disk by the sidecar). Tauri's IPC isn't built for
    // 500MB base64 payloads — encoding inflates ~33% AND we need to fit the
    // whole payload in renderer memory + IPC channel before Rust touches the
    // disk. Cross-review caught: the migration removed the 500MB cap without
    // adding a renderer-side equivalent, so picking a 4GB video would lock
    // up the renderer building the base64 string. We enforce a per-batch
    // size cap on the renderer side as a guardrail. Files needing larger
    // upload are expected to come through the path-based drag-drop flow
    // (handleTauriFileDrop → copyPaths) which has no IPC payload concern.
    const handleImport = async (files: FileList | null) => {
      if (!files || files.length === 0 || isUploading) return;
      const MAX_BATCH_BYTES = 100 * 1024 * 1024; // 100MB renderer cap
      const totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > MAX_BATCH_BYTES) {
        setError(
          `批量上传不能超过 ${MAX_BATCH_BYTES / 1024 / 1024} MB（当前 ${Math.round(totalBytes / 1024 / 1024)} MB）。大文件请直接拖拽到目录。`,
        );
        return;
      }
      setIsUploading(true);
      try {
        const base64Files = await Promise.all(
          Array.from(files).map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          })),
        );
        const result = await fileService.importBase64Files({
          files: base64Files,
          targetDir: importTargetDir || undefined,
        });
        if (!result.success) throw new Error("Import failed");
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      } finally {
        setIsUploading(false);
        setImportTargetDir("");
      }
    };

    // Helper function to convert File to base64
    const fileToBase64 = useCallback((file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix (e.g., "data:application/pdf;base64,")
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }, []);

    // External file drag-drop (browser File objects → no path → base64 path).
    const handleExternalFileDrop = useCallback(
      async (files: File[], targetDir: string = "") => {
        if (files.length === 0 || isUploading) {
          return;
        }
        setIsUploading(true);
        try {
          const base64Files = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              content: await fileToBase64(file),
            })),
          );
          const result = await fileService.importBase64Files({
            files: base64Files,
            targetDir: targetDir || undefined,
          });
          if (!result.success) throw new Error("Import failed");
          refresh();
        } catch (err) {
          console.error("[DirectoryPanel] File upload error:", err);
          setError(err instanceof Error ? err.message : "Import failed");
        } finally {
          setIsUploading(false);
        }
      },
      [isUploading, refresh, fileService, fileToBase64],
    );

    // Tauri drag-drop (real OS paths → cp directly, no base64).
    const handleTauriFileDrop = useCallback(
      async (paths: string[], targetDir: string = "") => {
        if (paths.length === 0 || isUploading) {
          return;
        }
        setIsUploading(true);
        try {
          const result = await fileService.copyPaths({
            sourcePaths: paths,
            targetDir,
            autoRename: true,
          });
          if (!result.success) throw new Error("Copy failed");
          if (isDebugMode()) {
            console.log(
              "[DirectoryPanel] Tauri drop copied files:",
              result.copiedFiles,
            );
          }
          refresh();
        } catch (err) {
          console.error("[DirectoryPanel] Tauri file drop error:", err);
          setError(err instanceof Error ? err.message : "Copy failed");
        } finally {
          setIsUploading(false);
        }
      },
      [isUploading, refresh, fileService],
    );

    // Expose imperative handle for parent to call
    useImperativeHandle(
      ref,
      () => ({
        handleFileDrop: async (paths: string[]) => {
          // Determine target directory based on selection (use first selected item)
          let targetDir = "";
          const firstSelected = selectedNodes[0];
          if (firstSelected) {
            if (firstSelected.type === "dir") {
              targetDir = firstSelected.path;
            } else {
              // For files, use parent directory
              const parts = firstSelected.path.split("/");
              parts.pop();
              targetDir = parts.join("/");
            }
          }
          await handleTauriFileDrop(paths, targetDir);
        },
        refresh,
      }),
      [selectedNodes, handleTauriFileDrop, refresh],
    );

    // Check if a drag event contains external files
    const isExternalFileDrag = useCallback((e: React.DragEvent): boolean => {
      const types = e.dataTransfer?.types ?? [];
      return types.includes("Files");
    }, []);

    // Tree container drag handlers
    const handleTreeDragEnter = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!isExternalFileDrag(e)) {
          return;
        }

        dragCounterRef.current++;
        if (dragCounterRef.current === 1) {
          setIsExternalDrop(true);
        }
      },
      [isExternalFileDrag],
    );

    const handleTreeDragOver = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!isExternalFileDrag(e)) return;

        e.dataTransfer.dropEffect = "copy";
      },
      [isExternalFileDrag],
    );

    const handleTreeDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      dragCounterRef.current--;
      if (dragCounterRef.current === 0) {
        setIsExternalDrop(false);
        setDropTargetPath(null);
      }
    }, []);

    const handleTreeDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        dragCounterRef.current = 0;
        setIsExternalDrop(false);

        const targetPath = dropTargetPath ?? "";
        setDropTargetPath(null);

        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) {
          if (isDebugMode()) {
            console.log(
              "[DirectoryPanel] Dropped",
              files.length,
              "files to:",
              targetPath || "root",
            );
          }
          void handleExternalFileDrop(files, targetPath);
        }
      },
      [dropTargetPath, handleExternalFileDrop],
    );

    // Row-level drag handlers for directory highlighting
    const handleRowDragEnter = useCallback(
      (e: React.DragEvent, nodePath: string, isDir: boolean) => {
        e.stopPropagation();
        if (!isExternalFileDrag(e)) return;

        // Only highlight directories
        if (isDir) {
          setDropTargetPath(nodePath);
        }
      },
      [isExternalFileDrag],
    );

    const handleRowDragLeave = useCallback((e: React.DragEvent) => {
      e.stopPropagation();
      // Don't clear dropTargetPath here - let tree level handler or drop handler do it
    }, []);

    // Move handler (used by both internal DnD and context menu).
    // Cross-review caught: pre-fix this ignored `result.errors`, so partial
    // failures (3 of 5 files moved, 2 errored due to permission / collision
    // exhaustion) silently dropped on the floor — user saw 2 files vanish
    // with no feedback. Surface partial failures via toast so the user knows
    // why some moves didn't happen.
    const handleMove = useCallback(
      async (sourcePaths: string[], targetDir: string) => {
        try {
          const result = await fileService.movePaths({ sourcePaths, targetDir });
          if (result.errors && result.errors.length > 0) {
            const moved = result.movedFiles?.length ?? 0;
            toast.warning(
              `已移动 ${moved} 项；${result.errors.length} 项失败：${result.errors[0]}`,
            );
          }
          refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Move failed");
        }
      },
      [fileService, refresh, toast],
    );

    // --- Internal DnD via @dnd-kit (pointer-events based, reliable in Tauri WebView) ---
    const updateDropTarget = useCallback((val: string | null) => {
      internalDropTargetRef.current = val;
      setInternalDropTarget(val);
    }, []);

    const clearAutoExpandTimer = useCallback(() => {
      if (autoExpandTimerRef.current !== null) {
        clearTimeout(autoExpandTimerRef.current);
        autoExpandTimerRef.current = null;
      }
    }, []);

    // Lookup map for hit-testing during drag
    const nodeByPath = useMemo(() => {
      const map = new Map<string, DirectoryTreeNode>();
      for (const [path, meta] of nodeMetaByPath) {
        map.set(path, meta.data);
      }
      return map;
    }, [nodeMetaByPath]);

    const dndSensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    );

    const handleDndDragStart = useCallback(
      (event: DragStartEvent) => {
        const data = event.active.data.current as DirectoryTreeNode | undefined;
        if (!data) return;
        // Multi-select: if dragged item is selected and there are multiple selections, drag all
        const paths =
          selectedNodes.some((n) => n.path === data.path) &&
          selectedNodes.length > 1
            ? selectedNodes.map((n) => n.path)
            : [data.path];
        const icon = data.type === "dir" ? Folder : getFileIcon(data.name);
        setActiveDragItem({ paths, name: data.name, icon });
      },
      [selectedNodes],
    );

    const handleDndDragOver = useCallback(
      (event: DragOverEvent) => {
        const overId = event.over?.id as string | undefined;
        if (!overId) {
          // Over empty space — target root
          if (internalDropTargetRef.current !== "") {
            updateDropTarget("");
            clearAutoExpandTimer();
          }
          return;
        }
        // Drop targets have id = "drop:{path}"
        const targetPath = overId.startsWith("drop:") ? overId.slice(5) : null;
        if (targetPath === null) return;

        if (internalDropTargetRef.current !== targetPath) {
          updateDropTarget(targetPath);
          clearAutoExpandTimer();
          // Auto-expand closed folder after 600ms hover
          const nodeData = nodeByPath.get(targetPath);
          autoExpandTimerRef.current = setTimeout(() => {
            if (nodeData?.loaded === false) {
              void expandDir(targetPath);
            }
            openPath(targetPath);
          }, 600);
        }
      },
      [updateDropTarget, clearAutoExpandTimer, nodeByPath, expandDir, openPath],
    );

    const handleDndDragEnd = useCallback(
      (_event: DragEndEvent) => {
        const dragItem = activeDragItem;
        const targetPath = internalDropTargetRef.current;
        // Clean up state first
        setActiveDragItem(null);
        updateDropTarget(null);
        clearAutoExpandTimer();

        if (!dragItem || targetPath === null) return;
        const sourcePaths = dragItem.paths;
        // Don't drop on itself or into descendant
        if (sourcePaths.includes(targetPath)) return;
        if (
          targetPath &&
          sourcePaths.some((p) => targetPath.startsWith(p + "/"))
        )
          return;
        void handleMove(sourcePaths, targetPath);
      },
      [activeDragItem, handleMove, updateDropTarget, clearAutoExpandTimer],
    );

    const handleDndDragCancel = useCallback(() => {
      setActiveDragItem(null);
      updateDropTarget(null);
      clearAutoExpandTimer();
    }, [updateDropTarget, clearAutoExpandTimer]);

    // Clean up auto-expand timer on unmount
    useEffect(() => clearAutoExpandTimer, [clearAutoExpandTimer]);

    // Keyboard paste handler (Cmd/Ctrl+V)
    useEffect(() => {
      const handlePaste = async (e: ClipboardEvent) => {
        // Check if DirectoryPanel is focused or its children
        if (
          !panelRef.current?.contains(document.activeElement) &&
          document.activeElement !== panelRef.current
        ) {
          return;
        }

        // Check if it's a text input/textarea - don't intercept paste there
        const activeElement = document.activeElement as HTMLElement;
        if (
          activeElement.tagName === "INPUT" ||
          activeElement.tagName === "TEXTAREA"
        ) {
          return;
        }

        const items = e.clipboardData?.items;
        if (!items) {
          return;
        }

        const files: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) {
              files.push(file);
            }
          }
        }

        if (files.length === 0) {
          return;
        }

        e.preventDefault();

        // Determine target directory based on selection (use first selected item)
        let targetDir = "";
        const firstSelected = selectedNodes[0];
        if (firstSelected) {
          if (firstSelected.type === "dir") {
            targetDir = firstSelected.path;
          } else {
            // For files, use parent directory
            const parts = firstSelected.path.split("/");
            parts.pop();
            targetDir = parts.join("/");
          }
        }

        if (isDebugMode()) {
          console.log(
            "[DirectoryPanel] Pasting",
            files.length,
            "files to:",
            targetDir || "root",
          );
        }
        await handleExternalFileDrop(files, targetDir);
      };

      document.addEventListener("paste", handlePaste);
      return () => document.removeEventListener("paste", handlePaste);
    }, [selectedNodes, handleExternalFileDrop]);

    const handleOpenInFinder = async (path: string) => {
      try {
        await fileService.openInFinder({ path });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open");
      }
    };

    const handleOpenWithDefault = async (path: string) => {
      try {
        await fileService.openWithDefault({ path });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to open");
      }
    };

    const handleRename = async (oldPath: string, newName: string) => {
      try {
        await fileService.rename({ oldPath, newName });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Rename failed");
      }
    };

    const handleDelete = async (path: string) => {
      try {
        await fileService.deleteFile({ path });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      }
    };

    const handleNewFile = async (parentDir: string, name: string) => {
      try {
        await fileService.newFile({ parentDir, name });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Create failed");
      }
    };

    /** 「新建笔记」: pick the next free `note-YYYYMMDDHHMM[-N].md` slot in
     *  `parentDir`, create it empty, then open the preview directly in
     *  edit mode (Obsidian-like quick-capture flow). Local time — the
     *  user expects "now" to be wall-clock now, not UTC.
     *
     *  Collision handling: probe up to 30 candidates via `checkPaths`
     *  (single batched invoke), pick the first free one. The cap is
     *  arbitrary but well above any plausible "I created 30 notes in one
     *  minute" workflow; treats overflow as an error toast rather than
     *  silently dropping the click. */
    const handleNewNote = async (parentDir: string) => {
      if (!fileService.isAvailable) return;
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `${pad(now.getHours())}${pad(now.getMinutes())}`;
      const baseStem = `note-${stamp}`;
      const candidates = [
        `${baseStem}.md`,
        ...Array.from({ length: 29 }, (_, i) => `${baseStem}-${i + 2}.md`),
      ];
      const probePaths = candidates.map((n) =>
        parentDir ? `${parentDir}/${n}` : n,
      );
      try {
        const probe = await fileService.checkPaths({ paths: probePaths });
        // Race-resilient creation: walk candidates in order, skip those
        // already known occupied, and on `newFile` "already exists" race
        // (another caller took the slot between probe and create — Codex
        // round-4 caught) fall through to the next candidate. In the
        // common case this is exactly one `newFile` call.
        let createdPath: string | null = null;
        let filename: string | null = null;
        for (let i = 0; i < candidates.length; i++) {
          if (probe.results[probePaths[i]]?.exists) continue;
          const candidate = candidates[i];
          try {
            const created = await fileService.newFile({
              parentDir,
              name: candidate,
            });
            createdPath = created.path;
            filename = candidate;
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/already exists/i.test(msg)) continue; // race — try next
            throw e;
          }
        }
        if (!createdPath || !filename) {
          setError("当前分钟内已有过多笔记，请稍后再试");
          return;
        }

        // Watcher refresh will surface the new file; we also kick a manual
        // refresh so the highlight + selection are immediate.
        refresh();

        // Synthesize a tree-node so selectedNodes highlights the new file
        // even before the watcher-driven re-fetch resolves. The pending
        // selection mark protects this node from the reconciliation
        // useEffect, which would otherwise filter it out (it isn't yet
        // in `nodeMetaByPath`).
        const newNode: DirectoryTreeNode = {
          id: createdPath,
          name: filename,
          path: createdPath,
          type: "file",
        };
        markPendingSelection(createdPath);
        setSelectedNodes([newNode]);

        // Open preview in edit mode. Split-view (Chat) routes via the
        // external callback; otherwise open the inline modal.
        const previewFile = {
          name: filename,
          content: "",
          size: 0,
          path: createdPath,
        };
        if (onFilePreviewExternal) {
          onFilePreviewExternal(previewFile, { initialEditMode: true });
        } else {
          setPreview({ ...previewFile, initialEditMode: true });
          setPreviewError(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Create failed");
      }
    };

    const handleNewFolder = async (parentDir: string, name: string) => {
      try {
        await fileService.newFolder({ parentDir, name });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Create failed");
      }
    };

    const handleContextMenu = (
      e: React.MouseEvent,
      node: DirectoryTreeNode | null,
    ) => {
      e.preventDefault();
      e.stopPropagation();

      // If right-clicking on empty area, clear selection and show root menu
      if (!node) {
        setSelectedNodes([]);
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          node: null,
          isMultiSelect: false,
        });
        return;
      }

      // If the clicked node is already in selection and we have multiple selections,
      // show multi-select menu
      const isAlreadySelected = selectedNodes.some((n) => n.path === node.path);
      if (isAlreadySelected && selectedNodes.length > 1) {
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          node,
          isMultiSelect: true,
        });
      } else {
        // Single selection - select only this node
        setSelectedNodes([node]);
        lastClickedPathRef.current = node.path;
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          node,
          isMultiSelect: false,
        });
      }
    };

    const handleTreeContainerContextMenu = (e: React.MouseEvent) => {
      // Only trigger if clicking on empty area (not on a tree item)
      const target = e.target as HTMLElement;
      if (!target.closest("[data-tree-row]")) {
        handleContextMenu(e, null);
      }
    };

    // Get unique parent directories for multi-select "open in finder"
    const getUniqueParentDirs = (nodes: DirectoryTreeNode[]): string[] => {
      const parentDirs = new Set<string>();
      for (const node of nodes) {
        if (node.type === "dir") {
          parentDirs.add(node.path);
        } else {
          const parts = node.path.split("/");
          parts.pop();
          parentDirs.add(parts.join("/") || ".");
        }
      }
      return Array.from(parentDirs);
    };

    // Handle multi-select delete
    const handleDeleteMultiple = async (nodes: DirectoryTreeNode[]) => {
      try {
        // Filter out nodes whose parent is also selected (avoid deleting already-deleted paths)
        const nodePaths = new Set(nodes.map((n) => n.path));
        const filteredNodes = nodes.filter((node) => {
          // Check if any other selected node is a parent of this node
          const parts = node.path.split("/");
          for (let i = 1; i < parts.length; i++) {
            const parentPath = parts.slice(0, i).join("/");
            if (nodePaths.has(parentPath)) {
              return false; // Skip this node, its parent will be deleted
            }
          }
          return true;
        });

        for (const node of filteredNodes) {
          await fileService.deleteFile({ path: node.path });
        }
        setSelectedNodes([]);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      }
    };

    const getContextMenuItems = (
      node: DirectoryTreeNode | null,
      isMultiSelect?: boolean,
    ): ContextMenuItem[] => {
      // Multi-select menu
      if (isMultiSelect && selectedNodes.length > 1) {
        const uniqueParentDirs = getUniqueParentDirs(selectedNodes);
        return [
          {
            label: `打开所在文件夹 (${uniqueParentDirs.length})`,
            icon: <FolderOpen className="h-4 w-4" />,
            onClick: () => {
              for (const dir of uniqueParentDirs) {
                void handleOpenInFinder(dir);
              }
            },
          },
          {
            label: `引用 (${selectedNodes.length})`,
            icon: <AtSign className="h-4 w-4" />,
            onClick: () => {
              onInsertReference?.(selectedNodes.map((n) => n.path));
            },
          },
          {
            label: `删除 (${selectedNodes.length})`,
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onClick: () =>
              setDialog({
                type: "delete-multi",
                node: null,
                nodes: selectedNodes,
              }),
          },
        ];
      }

      // Root directory menu (empty area)
      if (!node) {
        return [
          {
            label: "新建笔记",
            icon: <NotebookPen className="h-4 w-4" />,
            onClick: () => void handleNewNote(""),
          },
          {
            label: "导入文件",
            icon: <Upload className="h-4 w-4" />,
            onClick: () => {
              setImportTargetDir("");
              importInputRef.current?.click();
            },
          },
          {
            label: "新建文件",
            icon: <FilePlus className="h-4 w-4" />,
            onClick: () => setDialog({ type: "new-file", node: null }),
          },
          {
            label: "新建文件夹",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => setDialog({ type: "new-folder", node: null }),
          },
          {
            label: "刷新",
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: () => {
              refresh();
              onRefreshAll?.();
            },
          },
        ];
      }

      const isDir = node.type === "dir";
      const canPreview =
        !isDir && (isPreviewable(node.name) || isImageFile(node.name));

      if (isDir) {
        return [
          {
            label: "新建笔记",
            icon: <NotebookPen className="h-4 w-4" />,
            onClick: () => void handleNewNote(node.path),
          },
          {
            label: "新建文件",
            icon: <FilePlus className="h-4 w-4" />,
            onClick: () => setDialog({ type: "new-file", node }),
          },
          {
            label: "新建文件夹",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => setDialog({ type: "new-folder", node }),
          },
          {
            label: "导入文件",
            icon: <Upload className="h-4 w-4" />,
            onClick: () => {
              setImportTargetDir(node.path);
              importInputRef.current?.click();
            },
          },
          {
            label: "打开所在文件夹",
            icon: <FolderOpen className="h-4 w-4" />,
            onClick: () => handleOpenInFinder(node.path),
          },
          {
            label: "引用",
            icon: <AtSign className="h-4 w-4" />,
            onClick: () => onInsertReference?.([node.path]),
          },
          {
            label: "重命名",
            icon: <Pencil className="h-4 w-4" />,
            onClick: () => setDialog({ type: "rename", node }),
          },
          {
            label: "删除",
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onClick: () => setDialog({ type: "delete", node }),
          },
          { separator: true },
          {
            label: "刷新",
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: () => {
              refresh();
              onRefreshAll?.();
            },
          },
        ];
      } else {
        return [
          {
            label: "预览",
            icon: <Eye className="h-4 w-4" />,
            disabled: !canPreview,
            onClick: () => {
              if (isImageFile(node.name)) {
                void handleImagePreview(node);
              } else if (isPreviewable(node.name)) {
                void handlePreview(node);
              }
            },
          },
          {
            label: "引用",
            icon: <AtSign className="h-4 w-4" />,
            onClick: () => onInsertReference?.([node.path]),
          },
          {
            label: "打开",
            icon: <ExternalLink className="h-4 w-4" />,
            onClick: () => handleOpenWithDefault(node.path),
          },
          {
            label: "打开所在文件夹",
            icon: <FolderOpen className="h-4 w-4" />,
            onClick: () => handleOpenInFinder(node.path),
          },
          {
            label: "重命名",
            icon: <Pencil className="h-4 w-4" />,
            onClick: () => setDialog({ type: "rename", node }),
          },
          {
            label: "删除",
            icon: <Trash2 className="h-4 w-4" />,
            danger: true,
            onClick: () => setDialog({ type: "delete", node }),
          },
        ];
      }
    };

    // Get parent directory path for new file/folder creation
    const getParentDirForCreate = (node: DirectoryTreeNode | null): string => {
      if (!node) return ""; // root directory
      if (node.type === "dir") return node.path;
      // For files, get parent directory
      const parts = node.path.split("/");
      parts.pop();
      return parts.join("/");
    };

    return (
      <div
        ref={panelRef}
        tabIndex={0}
        className={`flex flex-col bg-[var(--paper-elevated)] outline-none overscroll-none ${
          isNarrowMode && isCollapsed ? "h-12" : "h-full"
        }`}
      >
        {/* Title bar - aligned with left panel header */}
        <div
          className={`flex h-12 flex-shrink-0 items-center justify-between px-4 select-none ${
            isNarrowMode ? "cursor-pointer hover:bg-[var(--hover-bg)]" : ""
          }`}
          onClick={
            isNarrowMode ? () => setIsCollapsed(!isCollapsed) : undefined
          }
        >
          <div className="flex items-center gap-2">
            {/* Collapse toggle button - in wide mode, calls onCollapse */}
            {!isNarrowMode && onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                title="收起工作区"
              >
                <PanelRightClose className="h-4 w-4" />
              </button>
            )}
            <span className="text-base font-semibold text-[var(--ink)]">
              工作区
            </span>
            {/* Search toggle button */}
            <Tip label={isSearchMode ? "关闭搜索" : "文件搜索"} position="bottom">
              <button
                  type="button"
                  onClick={(e) => {
                      e.stopPropagation();
                      setIsSearchMode(!isSearchMode);
                      if (!isSearchMode) {
                          setTimeout(() => searchInputRef.current?.focus(), 50);
                      } else {
                          setSearchQuery('');
                      }
                  }}
                  className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                      isSearchMode
                          ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-warm-hover)]"
                          : "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  }`}
              >
                  <Search className="h-4 w-4" />
              </button>
            </Tip>
            {/* Terminal button */}
            {onOpenTerminal && (
              <Tip
                label={terminalAlive ? "显示终端" : "打开终端"}
                position="bottom"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTerminal();
                  }}
                  className={`relative flex h-6 w-6 items-center justify-center rounded transition-colors ${
                    terminalAlive
                      ? "text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
                      : "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  }`}
                >
                  <TerminalSquare className="h-4 w-4" />
                  {/* Alive indicator dot */}
                  {terminalAlive && (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                  )}
                </button>
              </Tip>
            )}
            {/* Browser button */}
            {onOpenBrowser && (
              <Tip label="浏览器" position="bottom">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenBrowser();
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <Globe className="h-4 w-4" />
                </button>
              </Tip>
            )}
          </div>
          {/* Right side buttons */}
          <div className="flex items-center gap-1">
            {onOpenConfig && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenConfig();
                }}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="打开 Agent 设置"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Agent 设置
              </button>
            )}
            {/* Collapse toggle button - only in narrow mode, positioned at far right */}
            {isNarrowMode && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsCollapsed(!isCollapsed);
                }}
                className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                title={isCollapsed ? "展开工作区" : "折叠工作区"}
              >
                <ChevronUp
                  className={`h-4 w-4 transition-transform ${isCollapsed ? "rotate-180" : ""}`}
                />
              </button>
            )}
          </div>
        </div>

        {/* Collapsible content - hidden in narrow mode when collapsed */}
        {!(isNarrowMode && isCollapsed) && (
          <>
            {/* Inset divider: header → folder info */}
            <div className="mx-4 border-b border-[var(--line-subtle)]" />

            {/* Folder header OR Search Input */}
            {isSearchMode ? (
              <div className="flex h-[52px] items-center gap-2 px-4 py-2 border-b border-[var(--line-subtle)] flex-shrink-0">
                  <div className="relative flex-1 flex items-center">
                      <Search className="absolute left-2.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
                      <input
                          ref={searchInputRef}
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="搜索文件及内容..."
                          className="h-7 w-full rounded-md border border-[var(--line)] bg-transparent pl-8 pr-8 text-[12px] text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none transition-colors focus:border-[var(--accent)]"
                          onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                  setIsSearchMode(false);
                                  setSearchQuery('');
                              }
                          }}
                      />
                      <button
                          onClick={() => {
                              setIsSearchMode(false);
                              setSearchQuery('');
                          }}
                          title="退出搜索"
                          className="absolute right-2 flex items-center text-[var(--ink-muted)]/50 transition-colors hover:text-[var(--ink)]"
                      >
                          <X className="h-3.5 w-3.5" />
                      </button>
                  </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 pb-2 pt-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center">
                  <WorkspaceIcon icon={projectIcon} size={28} />
                </span>
                <div className="min-w-0 flex-1">
                  {/* First row: name, git branch, stats */}
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-[var(--ink)]">
                      {projectDisplayName || folderName}
                    </span>
                    {gitBranch && (
                      <span className="flex items-center gap-0.5 rounded-md bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                        <GitBranch className="h-3 w-3" />
                        {gitBranch}
                      </span>
                    )}
                    {directoryInfo && (
                      <span className="ml-auto flex-shrink-0 text-[11px] text-[var(--ink-muted)]">
                        {directoryInfo.summary.totalFiles} 文件 ·{" "}
                        {directoryInfo.summary.totalDirs} 文件夹
                      </span>
                    )}
                  </div>
                  {/* Second row: path */}
                  <div className="mt-0.5 truncate text-[11px] text-[var(--ink-muted)]">
                    {shortenPathForDisplay(agentDir)}
                  </div>
                </div>
                {/* Hidden file input for import functionality */}
                <input
                  ref={importInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => handleImport(event.target.files)}
                  disabled={isUploading}
                />
              </div>
            )}

            {/* Tree + Capabilities container (60/40 split) */}
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Tree container */}
              <div
                ref={treeContainerRef}
                className={`relative min-h-0 flex-1 overflow-hidden overscroll-none ${isExternalDrop || isTauriDragActive ? "ring-2 ring-inset ring-[var(--accent)]/30" : ""}`}
                onContextMenu={handleTreeContainerContextMenu}
                onDragEnter={handleTreeDragEnter}
                onDragOver={handleTreeDragOver}
                onDragLeave={handleTreeDragLeave}
                onDrop={handleTreeDrop}
                onClick={(e) => {
                  // Clear selection when clicking empty area in tree container
                  const target = e.target as HTMLElement;
                  const isTreeRow = target.closest("[data-tree-row]");
                  if (!isTreeRow) {
                    setSelectedNodes([]);
                    lastClickedPathRef.current = null;
                  }
                }}
                data-tree-root
              >
                {isSearchMode ? (
                  <FileSearchResults
                    results={searchResults}
                    isLoading={isSearching}
                    query={debouncedSearchQuery}
                    expandedFiles={expandedFiles}
                    onToggleFile={(path) => {
                      setExpandedFiles((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      });
                    }}
                    onFileClick={(path) => handleSearchItemClick(path)}
                    onMatchClick={(path, line) => handleSearchItemClick(path, line)}
                    onContextMenu={(e, path) => {
                      const findInTree = (nodes: DirectoryTreeNode[], p: string): DirectoryTreeNode | null => {
                        for (const n of nodes) {
                           if (n.path === p) return n;
                           if (n.children && n.type === "dir") {
                               const res = findInTree(n.children, p);
                               if (res) return res;
                           }
                        }
                        return null;
                      };
                      const n = findInTree(directoryInfo?.tree.children || [], path);
                      if (n) handleContextMenu(e, n);
                    }}
                  />
                ) : (
                  <>
                    {error && (
                      <div className="px-4 py-3 text-xs text-[var(--error)]">
                        {error}
                      </div>
                    )}
                    {!error && !directoryInfo && (
                      <div className="px-4 py-3 text-xs text-[var(--ink-muted)]">
                        Loading...
                      </div>
                    )}
                    {directoryInfo && (
                      <DndContext
                    sensors={dndSensors}
                    onDragStart={handleDndDragStart}
                    onDragOver={handleDndDragOver}
                    onDragEnd={handleDndDragEnd}
                    onDragCancel={handleDndDragCancel}
                  >
                    <WorkspaceTreeViewport
                      rows={visibleRows}
                      rowHeight={ROW_HEIGHT}
                      dropTargetPath={isExternalDrop ? dropTargetPath : null}
                      internalDropTarget={internalDropTarget}
                      activeDragPaths={activeDragItem?.paths ?? []}
                      initialScrollTop={treeScrollTopRef.current}
                      getStickyAncestors={getStickyAncestors}
                      onCloseAncestorPath={closePath}
                      onScrollTopChange={(scrollTop) => {
                        treeScrollTopRef.current = scrollTop;
                      }}
                      onRowClick={(
                        row: VisibleTreeRow,
                        e: React.MouseEvent,
                      ) => {
                        const data = row.data;
                        const executeFilePreview = async () => {
                          setSelectedNodes([data]);
                          lastClickedPathRef.current = data.path;

                          if (isImageFile(data.name)) {
                            // Image branch — same latest-wins pattern as
                            // handleImagePreview. We don't delegate to it
                            // because this branch also drives
                            // `isPreviewLoading` (for the inline modal's
                            // loading indicator), which `handleImagePreview`
                            // doesn't touch.
                            const myReq = ++previewReqIdRef.current;
                            setIsPreviewLoading(true);
                            try {
                              // PRD 0.2.7 Phase D: same migration as
                              // handleImagePreview — Rust returns base64
                              // already, no FileReader round-trip needed.
                              const result = await fileService.downloadFile({
                                path: data.path,
                              });
                              if (myReq !== previewReqIdRef.current) return;
                              const dataUrl = `data:${result.mimeType};base64,${result.data}`;
                              openPreview(dataUrl, data.name);
                            } catch (err) {
                              if (myReq !== previewReqIdRef.current) return;
                              console.error(
                                "[DirectoryPanel] Failed to load image:",
                                err,
                              );
                              toast.error("图片加载失败");
                            } finally {
                              if (myReq === previewReqIdRef.current) {
                                setIsPreviewLoading(false);
                              }
                            }
                          } else if (isPreviewable(data.name)) {
                            void handlePreview(data);
                          } else {
                            toast.info(
                              "暂不支持预览此文件类型，可右键菜单打开",
                            );
                          }
                        };

                        const isMeta = e.metaKey || e.ctrlKey;
                        const isShift = e.shiftKey;

                        if (isMeta) {
                          setSelectedNodes((prev) =>
                            prev.some((node) => node.path === data.path)
                              ? prev.filter((node) => node.path !== data.path)
                              : [...prev, data],
                          );
                          lastClickedPathRef.current = data.path;
                        } else if (isShift && lastClickedPathRef.current) {
                          const rangePaths = getRangeSelection(
                            lastClickedPathRef.current,
                            data.path,
                          );
                          const rangeNodes = rangePaths
                            .map((path) => nodeByPath.get(path))
                            .filter(
                              (node): node is DirectoryTreeNode => !!node,
                            );
                          setSelectedNodes(rangeNodes);
                        } else if (row.isDir) {
                          setSelectedNodes([data]);
                          lastClickedPathRef.current = data.path;
                        } else {
                          void executeFilePreview();
                        }

                        if (row.isDir) {
                          if (!row.isOpen && data.loaded === false) {
                            void expandDir(data.path);
                          }
                          togglePath(data.path);
                        }
                      }}
                      onRowContextMenu={(
                        row: VisibleTreeRow,
                        e: React.MouseEvent,
                      ) => {
                        handleContextMenu(e, row.data);
                      }}
                      onRowDragEnter={(
                        e: React.DragEvent,
                        row: VisibleTreeRow,
                      ) => {
                        handleRowDragEnter(e, row.path, row.isDir);
                      }}
                      onRowDragLeave={(e: React.DragEvent) => {
                        handleRowDragLeave(e);
                      }}
                    />
                    {/* Drag overlay — floating preview that follows cursor */}
                    <DragOverlay dropAnimation={null}>
                      {activeDragItem && (
                        <div className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-[13px] shadow-lg">
                          <activeDragItem.icon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]" />
                          <span className="font-medium text-[var(--ink)]">
                            {activeDragItem.name}
                          </span>
                          {activeDragItem.paths.length > 1 && (
                            <span className="text-xs text-[var(--ink-muted)]">
                              +{activeDragItem.paths.length - 1}
                            </span>
                          )}
                        </div>
                      )}
                    </DragOverlay>
                      </DndContext>
                    )}
                  </>
                )}
              </div>

              {/* Vertical drag divider — tree ↔ capabilities
                Outer div: invisible hit area (py-1.5 = 12px), cursor hint
                Inner div: thin visual line, hover changes color via group */}
              <div
                className="group/cap-divider mx-4 cursor-row-resize py-1.5"
                onMouseDown={handleCapDividerMouseDown}
              >
                <div className="border-b border-[var(--line-subtle)] transition-colors group-hover/cap-divider:border-[var(--accent)]/40" />
              </div>

              {/* Agent Capabilities Panel */}
              <AgentCapabilitiesPanel
                enabledAgents={enabledAgents}
                enabledSkills={enabledSkills}
                enabledCommands={enabledCommands}
                globalSkillFolderNames={globalSkillFolderNames}
                onInsertSlashCommand={onInsertSlashCommand}
                onOpenSettings={onOpenSettings}
                onSyncSkillToGlobal={onSyncSkillToGlobal}
                onRefresh={() => {
                  refresh();
                  onRefreshAll?.();
                }}
                heightRatio={capRatio}
              />
            </div>
          </>
        )}

        {/* Context Menu */}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={getContextMenuItems(
              contextMenu.node,
              contextMenu.isMultiSelect,
            )}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* Rename Dialog */}
        {dialog?.type === "rename" && dialog.node && (
          <RenameDialog
            currentName={dialog.node.name}
            itemType={dialog.node.type === "dir" ? "folder" : "file"}
            onRename={(newName) => {
              void handleRename(dialog.node!.path, newName);
              setDialog(null);
            }}
            onCancel={() => setDialog(null)}
          />
        )}

        {/* New File Dialog */}
        {dialog?.type === "new-file" && (
          <RenameDialog
            currentName=""
            itemType="file"
            onRename={(name) => {
              void handleNewFile(getParentDirForCreate(dialog.node), name);
              setDialog(null);
            }}
            onCancel={() => setDialog(null)}
          />
        )}

        {/* New Folder Dialog */}
        {dialog?.type === "new-folder" && (
          <RenameDialog
            currentName=""
            itemType="folder"
            onRename={(name) => {
              void handleNewFolder(getParentDirForCreate(dialog.node), name);
              setDialog(null);
            }}
            onCancel={() => setDialog(null)}
          />
        )}

        {/* Delete Confirm Dialog */}
        {dialog?.type === "delete" && dialog.node && (
          <ConfirmDialog
            title={`删除${dialog.node.type === "dir" ? "文件夹" : "文件"}`}
            message={`确定要删除 "${dialog.node.name}" 吗？此操作无法撤销。`}
            confirmLabel="删除"
            cancelLabel="取消"
            danger
            onConfirm={() => {
              void handleDelete(dialog.node!.path);
              setDialog(null);
            }}
            onCancel={() => setDialog(null)}
          />
        )}

        {/* Multi-Delete Confirm Dialog */}
        {dialog?.type === "delete-multi" &&
          dialog.nodes &&
          dialog.nodes.length > 0 && (
            <ConfirmDialog
              title={`删除 ${dialog.nodes.length} 个项目`}
              message={`确定要删除选中的 ${dialog.nodes.length} 个文件/文件夹吗？此操作无法撤销。`}
              confirmLabel="全部删除"
              cancelLabel="取消"
              danger
              onConfirm={() => {
                void handleDeleteMultiple(dialog.nodes!);
                setDialog(null);
              }}
              onCancel={() => setDialog(null)}
            />
          )}

        {/* Preview modal - lazy loaded. Skip when split-view handles previews externally. */}
        {!onFilePreviewExternal &&
          (preview || previewError || isPreviewLoading) && (
            <Suspense fallback={null}>
              <FilePreviewModal
                name={preview?.name ?? "Preview"}
                content={preview?.content ?? ""}
                size={preview?.size ?? 0}
                path={preview?.path ?? ""}
                isLoading={isPreviewLoading}
                error={previewError}
                // Phase D.5: thread the absolute workspace root so rendered
                // markdown previews can load relative-path images.
                workspacePath={agentDir}
                initialEditMode={preview?.initialEditMode}
                onClose={() => {
                  setPreview(null);
                  setPreviewError(null);
                }}
                onSaved={refresh}
                onRenamed={(newPath, newName) => {
                  // Update the preview state so subsequent saves target the
                  // new path. The fs watcher triggers a tree refresh on its
                  // own (rename → delete-old + create-new event pair).
                  setPreview((prev) =>
                    prev ? { ...prev, path: newPath, name: newName, initialEditMode: undefined } : prev,
                  );
                  refresh();
                }}
                // Phase D.5: route reveal through fileService rather than the
                // modal falling back to sidecar `/agent/open-in-finder`.
                onRevealFile={async () => {
                  const p = preview?.path;
                  if (!p) return;
                  await fileService.openInFinder({ path: p });
                }}
                onQuoteFile={onQuoteFile}
                onQuoteSelection={onQuoteSelection}
              />
            </Suspense>
          )}
      </div>
    );
  }),
);

export default DirectoryPanel;
