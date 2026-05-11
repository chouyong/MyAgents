/**
 * ToolImageAttachment — single image attachment renderer.
 *
 * PRD 0.2.15 §4.8 — owns the rendering of an `image` ToolAttachment, including:
 *   - placeholder loading skeleton (sidecar async save in flight)
 *   - error display (saveToolAttachment failed)
 *   - tap-to-zoom modal preview
 *   - caption (revisedPrompt etc., capped 4KB at the source)
 *
 * The URL is resolved via useAttachmentUrl, which knows how to pick the right
 * sidecar port for the current session.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';

import { useTabStateOptional } from '@/context/TabContext';
import { useAttachmentUrl } from '@/utils/toolAttachment';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachment: ToolAttachment;
}

export default function ToolImageAttachment({ attachment }: Props) {
  const tab = useTabStateOptional();
  const sessionId = tab?.sessionId ?? null;
  const urlState = useAttachmentUrl(attachment, sessionId);
  const [zoomed, setZoomed] = useState(false);

  if (urlState.state === 'pending') {
    return (
      <div className="flex h-32 w-full items-center justify-center rounded border border-dashed border-[var(--paper-line)] bg-[var(--paper-inset)]/40 text-sm text-[var(--ink-muted)]">
        <span className="animate-pulse">生成中…</span>
      </div>
    );
  }
  if (urlState.state === 'loading') {
    return (
      <div className="flex h-32 w-full items-center justify-center rounded border border-dashed border-[var(--paper-line)] bg-[var(--paper-inset)]/40 text-sm text-[var(--ink-muted)]">
        <span className="animate-pulse">加载中…</span>
      </div>
    );
  }
  if (urlState.state === 'error') {
    return (
      <div className="flex h-20 w-full items-center justify-center rounded border border-rose-300/50 bg-rose-50/30 px-3 text-xs text-rose-600 dark:bg-rose-900/10 dark:text-rose-300">
        <span>⚠️ Image failed to render: {urlState.reason}</span>
      </div>
    );
  }

  // Ready
  return (
    <>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="group block max-w-sm overflow-hidden rounded-md border border-[var(--paper-line)] bg-[var(--paper-inset)]/30 transition-transform hover:scale-[1.01]"
        >
          <img
            src={urlState.url}
            alt={attachment.caption || 'Generated image'}
            loading="lazy"
            className="block max-h-80 w-auto object-contain"
          />
        </button>
        {attachment.caption ? (
          <div className="line-clamp-2 max-w-sm text-xs text-[var(--ink-muted)]">{attachment.caption}</div>
        ) : null}
      </div>
      {zoomed
        ? createPortal(
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6"
              onClick={() => setZoomed(false)}
            >
              <img
                src={urlState.url}
                alt={attachment.caption || 'Generated image'}
                className="max-h-full max-w-full"
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
