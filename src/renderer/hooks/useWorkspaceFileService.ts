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
  /** Whether the current environment supports these calls. False in browser dev mode. */
  isAvailable: boolean;
  /** The workspace path bound to this service. Useful for debug toasts. */
  workspacePath: string | null;
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
      isAvailable,
      workspacePath,
    ],
  );
}
