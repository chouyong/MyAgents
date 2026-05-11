/**
 * ToolAttachmentGallery — uniform renderer for all rich-media tool attachments.
 *
 * PRD 0.2.15 §4.8. Mounted by ToolUse.tsx after the specialized tool body so
 * any tool (Codex image_generation, MCP gemini-image, future Gemini/CC) that
 * emits ToolAttachment[] gets the same UI treatment with zero per-tool code.
 *
 * Kind dispatch is intentionally small; new kinds slot into the switch.
 */

import ToolImageAttachment from './ToolImageAttachment';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachments: ToolAttachment[];
}

export default function ToolAttachmentGallery({ attachments }: Props) {
  if (!attachments?.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((a, idx) => {
        const key = a.pendingId || a.refPath || `att-${idx}`;
        switch (a.kind) {
          case 'image':
            return <ToolImageAttachment key={key} attachment={a} />;
          // PRD 0.2.15 leaves audio/pdf/file as placeholders for v0.2.16+.
          // Until then they render as a minimal file card so the user still
          // sees that *something* was produced.
          default:
            return (
              <div
                key={key}
                className="rounded border border-[var(--paper-line)] bg-[var(--paper-inset)]/30 px-3 py-2 text-xs text-[var(--ink-secondary)]"
              >
                <div className="font-medium">{a.mimeType}</div>
                {a.caption ? <div className="mt-1 line-clamp-2 text-[var(--ink-muted)]">{a.caption}</div> : null}
              </div>
            );
        }
      })}
    </div>
  );
}
