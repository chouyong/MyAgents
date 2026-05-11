/**
 * Frontend helper for resolving ToolAttachment refPath to an absolute URL.
 *
 * PRD 0.2.15 §4.8 — replaces ad-hoc `readLocalFileAsBlobUrl(savedPath, ...)`
 * usage that mis-fits the new endpoint shape and bypasses attachment-aware
 * permission checks.
 *
 * The endpoint `/api/attachment/tool/<sid>/<tid>/<file>` returns CORS-allowed
 * bytes for both browser dev and Tauri WebKit. <img src=…> directly fetches
 * the URL — CSP `img-src` already permits http(s).
 */

import { useEffect, useState } from 'react';
import { getSessionPort } from '@/api/tauriClient';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { ToolAttachment } from '../../shared/types/tool-attachment';

/**
 * Resolve a refPath to a fetchable URL for the current session.
 *
 * - Tauri: lookup sidecar port via getSessionPort → http://127.0.0.1:PORT/refPath
 * - Browser dev: relative refPath (vite proxy handles it)
 *
 * Returns null while resolving (caller shows a loading skeleton).
 */
export async function resolveToolAttachmentUrl(
  attachment: ToolAttachment,
  sessionId: string | null,
): Promise<string | null> {
  // Placeholder still pending — caller renders skeleton.
  if (attachment.pendingId && !attachment.refPath) return null;
  // Error sentinel.
  if (attachment.refPath.startsWith('error://')) return attachment.refPath;

  if (!isTauriEnvironment()) {
    // Browser dev: vite proxies /api/* to the sidecar by default; refPath is
    // already in /api/attachment/tool/... form.
    return attachment.refPath;
  }

  if (!sessionId) return null;
  const port = await getSessionPort(sessionId);
  if (port === null) return null;
  return `http://127.0.0.1:${port}${attachment.refPath}`;
}

/**
 * React hook variant: resolves an attachment URL for use in <img src=…>.
 * Returns:
 *   - { state: 'loading' } while port lookup is in flight
 *   - { state: 'ready', url } when resolved
 *   - { state: 'pending' } when the attachment is a placeholder (async save in flight)
 *   - { state: 'error', reason } when refPath is an error sentinel
 */
export type AttachmentUrlState =
  | { state: 'loading' }
  | { state: 'ready'; url: string }
  | { state: 'pending' }
  | { state: 'error'; reason: string };

function computeSyncState(attachment: ToolAttachment): AttachmentUrlState | null {
  if (attachment.pendingId && !attachment.refPath) return { state: 'pending' };
  if (attachment.refPath.startsWith('error://')) {
    return { state: 'error', reason: attachment.refPath.slice('error://'.length) };
  }
  return null;
}

interface ResolverEntry {
  refPath: string;
  sessionId: string | null;
  url: string | null;
}

export function useAttachmentUrl(
  attachment: ToolAttachment,
  sessionId: string | null,
): AttachmentUrlState {
  const syncState = computeSyncState(attachment);

  // Derived-state-from-props pattern (React docs): reset resolvedUrl during
  // render when the input attachment changes — avoids the
  // react-hooks/set-state-in-effect lint hit for "manually re-syncing state".
  const [entry, setEntry] = useState<ResolverEntry>({ refPath: attachment.refPath, sessionId, url: null });
  if (entry.refPath !== attachment.refPath || entry.sessionId !== sessionId) {
    setEntry({ refPath: attachment.refPath, sessionId, url: null });
  }

  useEffect(() => {
    if (syncState !== null) return;
    let cancelled = false;
    void resolveToolAttachmentUrl(attachment, sessionId).then(url => {
      if (cancelled) return;
      setEntry(prev =>
        prev.refPath === attachment.refPath && prev.sessionId === sessionId
          ? { ...prev, url }
          : prev,
      );
    });
    return () => { cancelled = true; };
  }, [attachment, sessionId, syncState]);

  if (syncState !== null) return syncState;
  if (entry.refPath !== attachment.refPath || entry.url === null) {
    return { state: 'loading' };
  }
  return { state: 'ready', url: entry.url };
}
