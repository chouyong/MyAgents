// ThoughtInput — compact freeform note input for Thought mode.
// Writes through to ~/.myagents/thoughts/ via `cmd_thought_create`.
//
// flomo-style inline tag editor: `#word ` as you type → `#word` renders
// highlighted inline; typing `#` (or clicking the # toolbar button) opens
// a tag picker filtered by the partial tag; Enter / Tab / click picks.
//
// Implementation: a transparent <textarea> layered on top of a mirror
// <div> that renders the same text with `#tag` runs coloured via
// `splitWithTagHighlights` (the shared parser with Rust + ThoughtCard, so
// highlight ≡ server-extracted `thought.tags[]`).

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown, ChevronUp, Hash, PenLine } from 'lucide-react';
import { thoughtCreate } from '@/api/taskCenter';
import { track } from '@/analytics';
import Tip from '@/components/Tip';
import { Popover } from '@/components/ui/Popover';
import {
  findActiveTagContext,
  isBoundaryChar,
  splitWithTagHighlights,
  tagBodyEndOffset,
} from '@/utils/parseThoughtTags';
import type { Thought } from '@/../shared/types/thought';

export interface ThoughtInputHandle {
  /** Programmatically focus the textarea. Mirrors SimpleChatInputHandle so
   *  parents (e.g. Launcher BrandSection) can drive focus on mode switches
   *  without relying on the `autoFocus` prop-flip heuristic. */
  focus: () => void;
}

// Visual variants. The `compact` variant is the Task Center thought stream
// card (14px text, tighter padding, no shadow). The `launcher` variant
// mirrors SimpleChatInput's launcher-mode card exactly — 16px text,
// `rounded-2xl`, `shadow-md`, `px-4` padding — so that when BrandSection
// toggles 任务 ↔ 想法 the user sees the same input frame, just with a
// different inner behaviour. Without this, the two inputs look visibly
// different (font size, radius, shadow) and the page feels like it swaps
// controls instead of changing modes.
type ThoughtInputVariant = 'compact' | 'launcher';

const VARIANTS: Record<ThoughtInputVariant, {
  pxPerLine: number;
  /** Extra px added on top of `pxPerLine * minLines` when the padding
   *  lives on the textarea/overlay-inner itself (compact). Set to 0
   *  when the padding lives on an outer wrapper (launcher) — then
   *  `minHeight` is pure content so it matches SimpleChatInput's own
   *  `LINE_HEIGHT * effectiveMinLines` formula byte-for-byte. */
  verticalPaddingPx: number;
  textareaClass: string;
  cardClass: string;
  /** Tailwind class for the outer card's focus state. Empty string in
   *  `launcher` because SimpleChatInput's card doesn't change border
   *  on focus — adding it would surface as a "mystery grey outline"
   *  the user doesn't see on the chat input. */
  focusClass: string;
  /** Padding on the *outer* content wrapper (one level inside the
   *  card, outside the textarea). Non-empty for launcher so the
   *  textarea can have `minHeight = pxPerLine * minLines` exactly
   *  (no padding bundled into its box), matching SimpleChatInput. */
  outerPaddingClass: string;
  /** Padding on the textarea + overlay-inner themselves. Non-empty
   *  for compact (all padding lives here, outer wrapper is a no-op). */
  innerPaddingClass: string;
  toolbarPaddingClass: string;
  toolbarButtonPaddingClass: string;
}> = {
  compact: {
    pxPerLine: 22,           // 14px × 1.6 line-height ≈ 22.4
    verticalPaddingPx: 12,
    textareaClass: 'text-[14px] leading-relaxed',
    cardClass: 'rounded-[var(--radius-lg)]',
    focusClass: 'focus-within:border-[var(--line-strong)]',
    outerPaddingClass: '',
    innerPaddingClass: 'px-3 pt-3',
    toolbarPaddingClass: 'px-2 pb-2 pt-1',
    toolbarButtonPaddingClass: 'p-1.5',
  },
  launcher: {
    // Every metric here is pinned to SimpleChatInput's launcher card so
    // the 任务 ↔ 想法 toggle is a pure content swap, no visual wobble.
    pxPerLine: 26,           // matches LINE_HEIGHT = 26 (text-base × leading-relaxed 1.625)
    verticalPaddingPx: 0,
    textareaClass: 'text-base leading-relaxed',
    cardClass: 'rounded-2xl shadow-md',
    focusClass: '',
    outerPaddingClass: 'px-4 pt-3',
    innerPaddingClass: '',
    toolbarPaddingClass: 'px-3 pb-2 pt-1',
    toolbarButtonPaddingClass: 'p-2',
  },
};

/**
 * Single source of truth for every CSS class that decides where a glyph
 * lands. The mirror `<div>` and the user-facing `<textarea>` MUST have
 * identical wrap geometry — if any of these tokens drift between the
 * two layers (e.g. someone adds `tracking-tight` to the textarea but
 * forgets the mirror), text wraps at a different character and the
 * textarea's caret floats into "mystery whitespace" after the last
 * visible mirror glyph (regression scenario from cross-review M9).
 *
 * Pulled out into a function so both call sites pass the same `theme`
 * + `showExpandToggle` and end up with byte-equivalent output.
 */
function MIRROR_TEXTAREA_SHARED_CLASS(
  theme: (typeof VARIANTS)[ThoughtInputVariant],
  showExpandToggle: boolean,
): string {
  return `${theme.innerPaddingClass} ${theme.textareaClass}${showExpandToggle ? ' pr-10' : ''}`;
}

/**
 * Inline styles whose presence (or absence) likewise affects wrap
 * geometry. Both layers spread this object so the textarea can
 * additionally pin `WebkitTextFillColor: 'transparent'` and its
 * own min/maxHeight without forking the shared keys.
 */
const MIRROR_TEXTAREA_SHARED_STYLE = {
  fontFamily: 'inherit',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
} as const;

interface Props {
  onCreated?: (t: Thought) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Existing tags sorted by frequency. Populates the `#` autocomplete menu.
   * Parent (ThoughtPanel / BrandSection) aggregates this via
   * `useThoughtTagCandidates`; we accept it as a prop so there's one
   * source of truth.
   *
   * **`count === 0` is a sentinel**, not a bug: entries with zero
   * frequency are "known good tag options that no thought has used yet"
   * (most commonly Agent workspace names). Keep them visible — filtering
   * them out would hide brand-new workspaces from the picker and defeat
   * the whole point of the discovery merge.
   */
  existingTags?: Array<[string, number]>;
  /**
   * Initial minimum row count for the textarea. Defaults to 2 (compact
   * Task Center list). Launcher 想法 mode passes 3 to match SimpleChatInput's
   * `LAUNCHER_MIN_LINES`, so the two inputs occupy the same vertical
   * footprint and mode switches don't reflow the page.
   */
  minLines?: number;
  /**
   * Maximum row count the textarea can auto-grow to before internal
   * scroll kicks in. Defaults to 8 for the compact Task Center stream.
   *
   * Launcher 想法 mode **MUST** pass `maxLines === minLines` (3) so the
   * textarea height is frozen at the starting value. SimpleChatInput's
   * launcher variant is hard-capped at `MAX_LINES_COLLAPSED = 3`; if
   * ThoughtInput were allowed to auto-grow past that, any thought
   * draft crossing 3 lines would make the 想法 card taller than the
   * 对话 card and — because both inputs stay mounted via `hidden` and
   * the textarea's `style.height` survives across mode switches —
   * toggling modes would visibly jump the MyAgents title / slogan
   * (reported after 0.1.70). Layout-freezing the ceiling is the
   * structural guarantee; the user can still scroll longer drafts
   * internally via the textarea's own `overflow-y-auto`.
   */
  maxLines?: number;
  /**
   * Visual variant — `compact` for the Task Center thought stream (default),
   * `launcher` for Launcher 想法 mode where the input must visually match
   * the Chat input (same radius / shadow / text size / padding).
   */
  variant?: ThoughtInputVariant;
  /**
   * Controlled expand/collapse state — when supplied, renders a
   * `ChevronUp`/`ChevronDown` toggle pinned to the textarea's top-right
   * (matching SimpleChatInput's launcher-variant affordance). Launcher
   * lifts the expand state to its parent so this input and the Chat
   * input share it: expanding in one mode persists into the other.
   * Omit entirely for Task Center and other surfaces that don't want
   * the expand affordance.
   */
  isExpanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
}

export const ThoughtInput = forwardRef<ThoughtInputHandle, Props>(function ThoughtInput({
  onCreated,
  // Guide-style placeholder — tells new users both *what* to write and
  // *how* to tag it, so the empty state doesn't look like dead space.
  // §6.3 rules the placeholder color (--ink-muted) which is already
  // applied by the textarea className below.
  placeholder = '写下此刻的想法… 用 #标签 归类',
  autoFocus = false,
  existingTags = [],
  minLines = 2,
  maxLines = 8,
  variant = 'compact',
  isExpanded,
  onExpandedChange,
}, ref) {
  const showExpandToggle = isExpanded !== undefined && onExpandedChange !== undefined;
  const theme = VARIANTS[variant];
  // Layout invariant: effective max >= min. Caller-supplied maxLines
  // below minLines would produce a weird "negative growth room" state;
  // clamp up so the textarea always has at least its starting height.
  const effectiveMaxLines = Math.max(maxLines, minLines);
  const textareaMinHeightPx = theme.verticalPaddingPx + theme.pxPerLine * minLines;
  const textareaMaxHeightPx = theme.verticalPaddingPx + theme.pxPerLine * effectiveMaxLines;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tag autocomplete state.
  const [tagMenu, setTagMenu] = useState<{ anchor: number; query: string } | null>(null);
  const [tagIndex, setTagIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayInnerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Imperative focus — exposed through the forwarded ref so parents can
  // drive focus on mode/tab switches. Matches SimpleChatInputHandle.
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }), []);
  // Pending caret position — consumed by the useLayoutEffect below after
  // React commits the new value, so `setSelectionRange` runs against the
  // up-to-date DOM instead of racing with rAF.
  const pendingCaretRef = useRef<number | null>(null);

  const segments = useMemo(() => splitWithTagHighlights(value), [value]);

  // Substring (not prefix) match — flomo behaviour; typing "ag" finds
  // "myagents", "tags", etc. Capped at 8 rows.
  const filteredTags = useMemo(() => {
    if (!tagMenu) return [];
    const q = tagMenu.query.toLowerCase();
    const list = q
      ? existingTags.filter(([t]) => t.toLowerCase().includes(q))
      : existingTags;
    return list.slice(0, 8);
  }, [existingTags, tagMenu]);

  useEffect(() => {
    setTagIndex(0);
  }, [tagMenu?.query, tagMenu?.anchor]);

  // Programmatic focus when `autoFocus` flips true. The textarea's
  // `autoFocus` HTML attribute only fires on initial mount, but the
  // TaskCenter tab is a singleton — the user can leave and come back
  // without a remount. `autoFocus` effectively becomes a "focus intent"
  // signal now: each time the parent passes `true` (TaskCenter
  // re-activates) we reassert focus. Guarded by the prop value so
  // `false` transitions don't steal focus from other fields.
  useEffect(() => {
    if (!autoFocus) return;
    // Defer one frame so the focus lands after the tab's layout pass
    // and the textarea is actually part of the visible tree (the
    // hidden-tab branch uses `content-visibility: hidden`).
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);

  // The overlay wrapper is `overflow: hidden` (to clip past the textarea
  // bounds), so setting `scrollTop` on it would no-op. Instead we translate
  // the inner content upward by the textarea's scrollTop — produces the
  // same visual scroll without needing a scrollable overlay container.
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const inner = overlayInnerRef.current;
    if (!ta || !inner) return;
    inner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }, []);

  useLayoutEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  // Auto-grow the textarea with content. Floor = 2 rows (idle state stays
  // compact); ceiling = 8 rows (~2 idle + 6 extra, per product spec). Past
  // the ceiling the textarea scrolls internally and the mirror overlay
  // tracks via `syncScroll`. We measure `scrollHeight` which includes
  // padding but not border — clamp via CSS values instead of px math so
  // font-size changes stay in sync without recomputing constants here.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (isExpanded === true) {
      ta.style.height = `${textareaMaxHeightPx}px`;
      return;
    }
    // Reset to 0 before reading scrollHeight so a shrinking value also
    // triggers a recompute (otherwise the textarea is stuck at its tallest
    // historical height).
    ta.style.height = '0px';
    const next = Math.min(ta.scrollHeight, textareaMaxHeightPx);
    ta.style.height = `${Math.max(next, textareaMinHeightPx)}px`;
  }, [value, textareaMinHeightPx, textareaMaxHeightPx, isExpanded]);

  // Consume any pending caret position after React flushes `setValue` to
  // the DOM — safer than `requestAnimationFrame`, which can run before
  // the commit.
  useLayoutEffect(() => {
    const pos = pendingCaretRef.current;
    if (pos === null) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    pendingCaretRef.current = null;
  }, [value]);

  const recomputeTagMenu = useCallback((nextValue: string, cursor: number) => {
    setTagMenu(findActiveTagContext(nextValue, cursor));
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      recomputeTagMenu(next, e.target.selectionStart ?? next.length);
    },
    [recomputeTagMenu],
  );

  const handleSelect = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    recomputeTagMenu(ta.value, ta.selectionStart ?? ta.value.length);
  }, [recomputeTagMenu]);

  const insertTag = useCallback(
    (tag: string) => {
      if (!tagMenu) return;
      const { anchor } = tagMenu;
      // Replace the WHOLE tag body at the anchor — including any chars
      // after the caret that are still valid tag chars — so picking a
      // suggestion while the cursor is mid-word doesn't orphan the tail
      // (e.g. caret in `#abc|def` + pick `#abc` no longer leaves `def`).
      const bodyEnd = tagBodyEndOffset(value, anchor);
      const before = value.slice(0, anchor);
      const after = value.slice(bodyEnd);
      const insertion = `#${tag} `;
      const next = before + insertion + after;
      pendingCaretRef.current = before.length + insertion.length;
      setValue(next);
      setTagMenu(null);
    },
    [tagMenu, value],
  );

  const handleHashButton = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Replace any active selection — matches standard form-input
    // semantics when a new character is inserted.
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? start;
    const prev = start === 0 ? '' : value[start - 1];
    const needsSpace = start > 0 && start === end && !isBoundaryChar(prev);
    const insertion = needsSpace ? ' #' : '#';
    const next = value.slice(0, start) + insertion + value.slice(end);
    const newPos = start + insertion.length;
    pendingCaretRef.current = newPos;
    setValue(next);
    recomputeTagMenu(next, newPos);
  }, [recomputeTagMenu, value]);

  const handleSubmit = useCallback(async () => {
    const content = value.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = await thoughtCreate({ content });
      track('thought_create', {
        source: 'desktop',
        location: variant === 'launcher' ? 'launcher' : 'task_center',
      });
      setValue('');
      setTagMenu(null);
      onCreated?.(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [value, busy, onCreated, variant]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Skip all custom key handling during IME composition — otherwise
      // pressing Enter to commit a pinyin candidate would instead pick a
      // tag suggestion (or submit).
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      if (tagMenu && filteredTags.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setTagIndex((i) => Math.min(filteredTags.length - 1, i + 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setTagIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          insertTag(filteredTags[tagIndex][0]);
          return;
        }
      }
      if (tagMenu && e.key === 'Escape') {
        e.preventDefault();
        setTagMenu(null);
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [tagMenu, filteredTags, tagIndex, insertTag, handleSubmit],
  );

  const canSend = value.trim().length > 0 && !busy;

  return (
    <div className="w-full">
      <div
        ref={cardRef}
        className={`relative flex flex-col border border-[var(--line)] bg-[var(--paper-elevated)] transition-colors ${theme.focusClass} ${theme.cardClass}`}
      >
        {/* Mirror layer: same text as the textarea but with coloured `#tag`
            runs. Must match the textarea's font metrics so the highlighted
            spans sit under the same glyphs the user is typing.
            `pointer-events: none` keeps clicks reaching the textarea. */}
        <div className={`relative ${theme.outerPaddingClass}`}>
          {/* Overlay clip box — matches textarea bounds (absolute inset-0)
              and hides anything past its edges. The actual text lives in
              an inner `overlayInnerRef` div that gets `translateY(-scrollTop)`
              applied whenever the textarea scrolls, so highlighted spans
              track the real text when the thought is long. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden"
          >
            {/* `paddingWrapper` reproduces the outer's padding INSIDE the
                clip box so the inner text-rendering area exactly matches
                the textarea's bounding box. Without this layer the inner
                used the full clip-box width while the textarea used
                (clip-box - outer-padding); any additional textarea-only
                padding (notably `pr-10` for the expand-toggle in
                launcher mode) made the two layers wrap at different
                characters and the caret would float into "mystery"
                whitespace after the visible mirror text. */}
            <div className={theme.outerPaddingClass}>
              <div
                ref={overlayInnerRef}
                // `MIRROR_TEXTAREA_SHARED_CLASS` carries every Tailwind/
                // CSS-token decision that affects glyph layout — padding
                // inside the box, font size, line-height, conditional
                // `pr-10` for the expand toggle. The textarea below
                // applies the EXACT same class (plus its own appearance/
                // background overrides) so any future style change here
                // hits both layers in lockstep.
                className={`${MIRROR_TEXTAREA_SHARED_CLASS(theme, showExpandToggle)} text-[var(--ink)]`}
                style={{
                  ...MIRROR_TEXTAREA_SHARED_STYLE,
                  willChange: 'transform', // mirror translateY(-scrollTop) GPU hint
                }}
              >
                {segments.map((seg, i) =>
                  seg.type === 'tag' ? (
                    <span
                      key={i}
                      className="rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                    >
                      {seg.value}
                    </span>
                  ) : (
                    <span key={i}>{seg.value}</span>
                  ),
                )}
                {value.endsWith('\n') && '\u200b'}
              </div>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onSelect={handleSelect}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
            onScroll={syncScroll}
            placeholder={placeholder}
            // Height is driven by the `useLayoutEffect` above (2-row
            // minimum, 8-row max, internal scroll past that). We don't
            // set `rows={N}` here because it would re-inject a min-height
            // attribute that fights the JS sizer on first paint.
            disabled={busy}
            // NB: no HTML `autoFocus` attribute. The `autoFocus` prop
            // drives a `useEffect` above that calls `.focus()` via
            // `requestAnimationFrame` — that effect fires on every
            // `false → true` transition (tab re-activation), which the
            // mount-only HTML attribute cannot do. Keeping both would
            // just double-fire `.focus()` on first mount.
            // The textarea's own text is transparent (mirror layer above
            // renders the glyphs) — but `-webkit-text-fill-color`
            // overrides `::placeholder { color }` in WebKit, so without
            // the `placeholder:[-webkit-text-fill-color:...]` override
            // the placeholder inherits the transparent fill and is
            // invisible. That was the silent bug in the prior rev.
            // `block` is load-bearing: without it, the textarea is a
            // default inline-level replaced element and contributes a
            // baseline descender gap (~3–4px) to its parent's line box.
            // That's invisible when the textarea owns its line (Task
            // Center compact layout looked fine), but in the Launcher
            // variant where the textarea is supposed to be pixel-perfect
            // against SimpleChatInput's `block w-full` textarea, the
            // descender was the residual height difference Codex RCA
            // round 3 identified. `block` collapses the descender gap
            // so the card footprint is truly textarea.height + wrappers.
            //
            // `pr-10` when an expand toggle is rendered reserves the
            // click area so content can't overlap the toggle button
            // (matches SimpleChatInput's `pr-8` but one size larger to
            // accommodate the toggle's larger hit box).
            // Textarea-specific classes (block layout, transparency to let
            // the mirror layer show through, caret/placeholder colour) +
            // `MIRROR_TEXTAREA_SHARED_CLASS` so geometry stays pinned to
            // the mirror. Editing the geometry props here without also
            // updating the shared helper would re-create the wrap-mismatch
            // / caret-floating-on-mystery-whitespace bug.
            className={`block relative w-full resize-none overflow-y-auto bg-transparent text-transparent caret-[var(--ink)] placeholder:text-[var(--ink-muted)] placeholder:[-webkit-text-fill-color:var(--ink-muted)] focus:outline-none ${MIRROR_TEXTAREA_SHARED_CLASS(theme, showExpandToggle)}`}
            style={{
              ...MIRROR_TEXTAREA_SHARED_STYLE,
              WebkitTextFillColor: 'transparent',
              minHeight: `${textareaMinHeightPx}px`,
              maxHeight: `${textareaMaxHeightPx}px`,
              // Animate the expand/collapse toggle (launcher's "想法" mode
              // grows from 3 → 12 lines when the user hits the chevron).
              // Mirrors SimpleChatInput's pattern so both inputs feel like
              // the same affordance — explicit property list + `height` so
              // collapse animates symmetrically (WebKit textareas sometimes
              // drop the transition on shrink when only `max-height` is
              // listed). The `useLayoutEffect` above writes `style.height`
              // imperatively; the final declared value wins and the
              // transition runs from previous baseline → target.
              transitionProperty: 'min-height, max-height, height',
              transitionDuration: '220ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
              willChange: 'max-height',
            }}
          />
          {showExpandToggle && (
            // Absolute-positioned toggle in the textarea's top-right —
            // mirrors SimpleChatInput's expand button exactly
            // (`absolute right-2 top-1.5`, `p-2`, ChevronUp/ChevronDown).
            // Sharing position + icons makes the two inputs feel like
            // the same affordance swapped under the hood.
            <button
              type="button"
              onClick={() => onExpandedChange?.(!isExpanded)}
              className="absolute right-2 top-1.5 rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              title={isExpanded ? '收起' : '展开'}
            >
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </button>
          )}
        </div>

        {/* Tag autocomplete — Escape dismissal is owned by the textarea's
            onKeyDown (sets tagMenu=null explicitly), so we disable the
            Popover's own Escape handler to keep the two paths from
            double-firing. Outside-click close from the primitive is fine
            since textarea clicks are the anchor and don't count as outside. */}
        <Popover
          open={!!tagMenu && filteredTags.length > 0}
          onClose={() => setTagMenu(null)}
          anchorRef={cardRef}
          placement="bottom-start"
          closeOnEscape={false}
          className="w-56 py-1 shadow-md"
        >
          {tagMenu && (
            <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
              {tagMenu.query ? `匹配 #${tagMenu.query}` : '选择标签'}
            </div>
          )}
          {filteredTags.map(([tag, n], i) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(e) => {
                // Prevent textarea blur so the selection state survives.
                e.preventDefault();
                insertTag(tag);
              }}
              onMouseEnter={() => setTagIndex(i)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors ${
                i === tagIndex
                  ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                  : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
              }`}
            >
              <span>#{tag}</span>
              <span className="text-[10px] text-[var(--ink-muted)]/60">{n}</span>
            </button>
          ))}
        </Popover>

        <div className={`flex items-center justify-between ${theme.toolbarPaddingClass}`}>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleHashButton}
              disabled={busy}
              title="插入 # 标签"
              className={`rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-50 ${theme.toolbarButtonPaddingClass}`}
            >
              <Hash className="h-4 w-4" />
            </button>
          </div>
          <Tip label="记录想法" shortcut="⌘ + Enter" align="end">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSend}
              className={`rounded-lg bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60 ${theme.toolbarButtonPaddingClass}`}
            >
              <PenLine className="h-4 w-4" />
            </button>
          </Tip>
        </div>
      </div>
      {error && (
        <div className="mt-1.5 text-[11px] text-[var(--error)]">{error}</div>
      )}
    </div>
  );
});

export default ThoughtInput;
