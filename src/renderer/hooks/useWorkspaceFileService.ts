// Workspace file service hook — Phase C of PRD 0.2.7.
//
// One stable callable surface that wraps the Rust `cmd_workspace_*` invokes.
// Both SimpleChatInput (launcher + chat-tab modes) and DirectoryPanel (Phase D
// follow-up) call into this so the rest of the renderer never reaches into
// `@tauri-apps/api/core` directly.
//
// Design constraints:
//   - Browser dev mode (isTauriEnvironment === false) gracefully throws at
//     call time. We DO NOT silently no-op — silent no-op would hide a bug
//     where the helper is wired up in a context that has no Tauri. The toast
//     in the caller turns this into a visible error.
//   - workspacePath is a hook param (not threaded through every call) so
//     callers can't accidentally mix paths within one input session.
//   - No React state lives in here; stable reference identity comes from
//     useCallback so consumers can put it in effect deps without churn.

import { useCallback, useMemo } from 'react';

import { isTauriEnvironment } from '@/utils/browserMock';

interface CopiedFile {
  sourcePath: string;
  targetPath: string;
  renamed: boolean;
}

// Phase D additions — DirectoryPanel calls these for tree / preview / CRUD.
// Shapes mirror the sidecar JSON these commands replace, so the React tree
// model and preview modal don't need parallel branches.

interface DirectoryTreeNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: DirectoryTreeNode[];
  loaded?: boolean;
}

interface DirectoryTreeResult {
  root: string;
  summary: { totalFiles: number; totalDirs: number };
  tree: DirectoryTreeNode;
  truncated: boolean;
}

interface ExpandDirectoryResult {
  children: DirectoryTreeNode[];
  loaded: boolean;
}

interface PreviewResult {
  content: string;
  name: string;
  size: number;
}

interface DownloadResult {
  name: string;
  mimeType: string;
  data: string;
}

interface CreatePathResult {
  success: boolean;
  path: string;
}

interface RenameResult {
  success: boolean;
  newPath: string;
}

interface MovedFile {
  oldPath: string;
  newPath: string;
}

interface MoveResult {
  success: boolean;
  movedFiles: MovedFile[];
  errors: string[];
}

interface GitBranchResult {
  branch: string | null;
}

interface ImportResult {
  success: boolean;
  files: string[];
}

interface CopyResult {
  success: boolean;
  copiedFiles: CopiedFile[];
}

interface ReadAsBase64Item {
  path: string;
  name: string;
  mimeType: string;
  data: string;
  error?: string | null;
}

interface ReadAsBase64Response {
  success: boolean;
  files: ReadAsBase64Item[];
}

interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

interface SlashCommand {
  name: string;
  description: string;
  source: 'builtin' | 'custom' | 'skill';
  scope?: 'user' | 'project';
  path?: string;
  folderName?: string;
  fileName?: string;
}

interface SlashCommandsResponse {
  success: boolean;
  commands: SlashCommand[];
  globalSkillFolderNames: string[];
}

// Phase D.5 — batch existence check for inline-code paths in AI output.
interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

interface CheckPathsResult {
  results: Record<string, PathInfo>;
}

// Phase D.5 — token-based watcher handle. The renderer holds `token` for the
// lifetime of the watch, then passes it to `watchStop`. `eventKey` is the
// suffix to subscribe to via Tauri `listen()`.
interface WatchHandle {
  token: string;
  eventKey: string;
}

interface DeleteResult {
  success: boolean;
  deleted: boolean;
}

interface GitignoreResult {
  success: boolean;
  added: boolean;
  reason: string;
}

export interface WorkspaceFileService {
  /** Import base64-encoded files into `<workspace>/<targetDir>/`. */
  importBase64Files(args: {
    files: { name: string; content: string }[];
    targetDir?: string;
  }): Promise<ImportResult>;
  /** Copy absolute paths (drag-drop / file picker) into `<workspace>/<targetDir>/`. */
  copyPaths(args: {
    sourcePaths: string[];
    targetDir: string;
    autoRename?: boolean;
  }): Promise<CopyResult>;
  /** Read absolute image paths and return base64 (for Tauri image drops). */
  readPathsAsBase64(args: { paths: string[] }): Promise<ReadAsBase64Response>;
  /** Append a pattern to `<workspace>/.gitignore` if not already present. */
  addGitignore(args: { pattern: string }): Promise<GitignoreResult>;
  /** Fuzzy file-name search for the @ mention picker. */
  searchFiles(args: { query: string }): Promise<FileSearchResult[]>;
  /** Delete a workspace-relative path (file / dir / broken symlink). */
  deleteFile(args: { path: string }): Promise<DeleteResult>;
  /** List slash-command picker entries — global + project skills + builtins. */
  listSlashCommands(): Promise<SlashCommandsResponse>;
  // ─── Phase D: DirectoryPanel ops ───
  /** Initial directory tree walk (depth + entry capped on the Rust side). */
  dirTree(): Promise<DirectoryTreeResult>;
  /** Lazy-expand a single directory marked `loaded:false` in the tree. */
  dirExpand(args: { path: string }): Promise<ExpandDirectoryResult>;
  /** Read a previewable text file for the preview modal (≤512KB). */
  readPreview(args: { path: string }): Promise<PreviewResult>;
  /** Read a binary file (image, etc.) as base64 for blob reconstruction. */
  downloadFile(args: { path: string }): Promise<DownloadResult>;
  newFile(args: { parentDir: string; name: string }): Promise<CreatePathResult>;
  newFolder(args: { parentDir: string; name: string }): Promise<CreatePathResult>;
  rename(args: { oldPath: string; newName: string }): Promise<RenameResult>;
  movePaths(args: { sourcePaths: string[]; targetDir: string }): Promise<MoveResult>;
  openInFinder(args: { path: string }): Promise<void>;
  openWithDefault(args: { path: string }): Promise<void>;
  /** Reveal an absolute path (NOT workspace-relative) in the OS file manager.
   *  Used by Skill/Command detail panels for `~/.myagents/skills/...`. The
   *  Rust side validates the path canonicalizes to under home_dir or tmp. */
  openPathExternal(args: { fullPath: string }): Promise<void>;
  /** Batch existence check — input order is preserved in the returned map. */
  checkPaths(args: { paths: string[] }): Promise<CheckPathsResult>;
  /** Read a workspace file as a Blob URL (for `<img src=...>` in AI markdown
   *  / inline-code preview). Returns `{ blobUrl, mimeType, name, revoke }`.
   *  Caller MUST call `revoke()` on cleanup to free the object URL. */
  readFileAsBlobUrl(args: { path: string }): Promise<BlobUrlHandle>;
  gitBranch(): Promise<GitBranchResult>;
  /** Start the per-workspace fs watcher (ref-counted process-wide). Returns
   *  `{ token, eventKey }`: the renderer holds `token` for the lifetime of the
   *  watch and passes it to `watchStop`; `eventKey` is the suffix to subscribe
   *  to via Tauri `listen('workspace:files-changed:<eventKey>', ...)`. */
  watchStart(): Promise<WatchHandle>;
  /** Release a watch handle issued by `watchStart`. Bad/stale tokens are a
   *  no-op (matches the "stop is best-effort" contract on the Rust side). */
  watchStop(args: { token: string }): Promise<void>;
  /** Whether the current environment supports these calls. False in browser dev mode. */
  isAvailable: boolean;
  /** The workspace path bound to this service. Useful for debug toasts. */
  workspacePath: string | null;
}

interface BlobUrlHandle {
  blobUrl: string;
  mimeType: string;
  name: string;
  /** Releases the object URL. Calling more than once is safe. */
  revoke: () => void;
}

export function useWorkspaceFileService(workspacePath: string | null): WorkspaceFileService {
  const tauri = isTauriEnvironment();

  const invokeIfTauri = useCallback(async <T,>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    if (!tauri) {
      throw new Error(
        '工作区文件操作仅在桌面应用中可用。当前为浏览器开发模式。'
      );
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }, [tauri]);

  const requireWorkspace = useCallback(() => {
    if (!workspacePath) {
      throw new Error('请先选择工作区');
    }
    return workspacePath;
  }, [workspacePath]);

  const importBase64Files: WorkspaceFileService['importBase64Files'] = useCallback(
    async ({ files, targetDir }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<ImportResult>('cmd_workspace_import_files_b64', {
        workspace: ws,
        files,
        targetDir,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const copyPaths: WorkspaceFileService['copyPaths'] = useCallback(
    async ({ sourcePaths, targetDir, autoRename }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CopyResult>('cmd_workspace_copy_paths', {
        workspace: ws,
        sourcePaths,
        targetDir,
        autoRename,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readPathsAsBase64: WorkspaceFileService['readPathsAsBase64'] = useCallback(
    async ({ paths }) => {
      // Doesn't need a workspace — paths are absolute.
      return invokeIfTauri<ReadAsBase64Response>('cmd_workspace_read_files_b64', { paths });
    },
    [invokeIfTauri],
  );

  const addGitignore: WorkspaceFileService['addGitignore'] = useCallback(
    async ({ pattern }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<GitignoreResult>('cmd_workspace_add_gitignore', {
        workspace: ws,
        pattern,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const searchFiles: WorkspaceFileService['searchFiles'] = useCallback(
    async ({ query }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<FileSearchResult[]>('cmd_workspace_search_files_fuzzy', {
        workspace: ws,
        query,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const deleteFile: WorkspaceFileService['deleteFile'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<DeleteResult>('cmd_workspace_delete', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const listSlashCommands: WorkspaceFileService['listSlashCommands'] = useCallback(
    async () => {
      const ws = requireWorkspace();
      return invokeIfTauri<SlashCommandsResponse>('cmd_list_slash_commands', {
        workspace: ws,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const dirTree: WorkspaceFileService['dirTree'] = useCallback(async () => {
    const ws = requireWorkspace();
    return invokeIfTauri<DirectoryTreeResult>('cmd_workspace_dir_tree', { workspace: ws });
  }, [requireWorkspace, invokeIfTauri]);

  const dirExpand: WorkspaceFileService['dirExpand'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<ExpandDirectoryResult>('cmd_workspace_dir_expand', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readPreview: WorkspaceFileService['readPreview'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<PreviewResult>('cmd_workspace_read_preview', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const downloadFile: WorkspaceFileService['downloadFile'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<DownloadResult>('cmd_workspace_download_file', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const newFile: WorkspaceFileService['newFile'] = useCallback(
    async ({ parentDir, name }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CreatePathResult>('cmd_workspace_new_file', {
        workspace: ws,
        parentDir,
        name,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const newFolder: WorkspaceFileService['newFolder'] = useCallback(
    async ({ parentDir, name }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CreatePathResult>('cmd_workspace_new_folder', {
        workspace: ws,
        parentDir,
        name,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const rename: WorkspaceFileService['rename'] = useCallback(
    async ({ oldPath, newName }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<RenameResult>('cmd_workspace_rename', {
        workspace: ws,
        oldPath,
        newName,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const movePaths: WorkspaceFileService['movePaths'] = useCallback(
    async ({ sourcePaths, targetDir }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<MoveResult>('cmd_workspace_move', {
        workspace: ws,
        sourcePaths,
        targetDir,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const openInFinder: WorkspaceFileService['openInFinder'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      await invokeIfTauri<void>('cmd_workspace_open_in_finder', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const openWithDefault: WorkspaceFileService['openWithDefault'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      await invokeIfTauri<void>('cmd_workspace_open_with_default', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const openPathExternal: WorkspaceFileService['openPathExternal'] = useCallback(
    async ({ fullPath }) => {
      // No workspace required — this command takes an absolute path.
      await invokeIfTauri<void>('cmd_open_path_external', { fullPath });
    },
    [invokeIfTauri],
  );

  const checkPaths: WorkspaceFileService['checkPaths'] = useCallback(
    async ({ paths }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CheckPathsResult>('cmd_workspace_check_paths', {
        workspace: ws,
        paths,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readFileAsBlobUrl: WorkspaceFileService['readFileAsBlobUrl'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      const result = await invokeIfTauri<DownloadResult>('cmd_workspace_download_file', {
        workspace: ws,
        path,
      });
      // Decode base64 → Uint8Array → Blob → object URL. The Rust side caps
      // payload at 25MB so this can't blow up the renderer heap. The decoded
      // intermediate buffer is freed once the Blob takes ownership.
      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      let revoked = false;
      const revoke = () => {
        if (revoked) return;
        revoked = true;
        URL.revokeObjectURL(blobUrl);
      };
      return { blobUrl, mimeType: result.mimeType, name: result.name, revoke };
    },
    [requireWorkspace, invokeIfTauri],
  );

  const gitBranch: WorkspaceFileService['gitBranch'] = useCallback(async () => {
    const ws = requireWorkspace();
    return invokeIfTauri<GitBranchResult>('cmd_workspace_git_branch', { workspace: ws });
  }, [requireWorkspace, invokeIfTauri]);

  const watchStart: WorkspaceFileService['watchStart'] = useCallback(async () => {
    const ws = requireWorkspace();
    return invokeIfTauri<WatchHandle>('cmd_workspace_watch_start', { workspace: ws });
  }, [requireWorkspace, invokeIfTauri]);

  const watchStop: WorkspaceFileService['watchStop'] = useCallback(
    async ({ token }) => {
      // No workspace required — token is the registry key on the Rust side.
      await invokeIfTauri<void>('cmd_workspace_watch_stop', { token });
    },
    [invokeIfTauri],
  );

  // Wrap the returned object in useMemo so consumers that put `fileService`
  // in `useCallback` deps (e.g. SimpleChatInput's processDroppedFiles,
  // searchFiles, fetchCommands — ~10 sites) don't rebuild on every keystroke.
  // Pre-PRD-0.2.7 the legacy `apiPost`/`apiGet` came from a stable Tab context;
  // this useMemo restores that render-loop stability.
  const isAvailable = tauri && workspacePath != null;
  return useMemo(
    () => ({
      importBase64Files,
      copyPaths,
      readPathsAsBase64,
      addGitignore,
      searchFiles,
      deleteFile,
      listSlashCommands,
      // Phase D
      dirTree,
      dirExpand,
      readPreview,
      downloadFile,
      newFile,
      newFolder,
      rename,
      movePaths,
      openInFinder,
      openWithDefault,
      openPathExternal,
      checkPaths,
      readFileAsBlobUrl,
      gitBranch,
      watchStart,
      watchStop,
      isAvailable,
      workspacePath,
    }),
    [
      importBase64Files,
      copyPaths,
      readPathsAsBase64,
      addGitignore,
      searchFiles,
      deleteFile,
      listSlashCommands,
      dirTree,
      dirExpand,
      readPreview,
      downloadFile,
      newFile,
      newFolder,
      rename,
      movePaths,
      openInFinder,
      openWithDefault,
      openPathExternal,
      checkPaths,
      readFileAsBlobUrl,
      gitBranch,
      watchStart,
      watchStop,
      isAvailable,
      workspacePath,
    ],
  );
}
