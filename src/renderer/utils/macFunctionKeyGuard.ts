// Global guard for the macOS WKWebView control-codepoint tofu leak.
//
// Several macOS keyboard paths leak unprintable codepoints into
// textarea / input values, rendered as tofu glyphs:
//
//   - **Arrow / page / home / end** at a boundary → C0 control
//     codepoints U+001C-U+001F (FS/GS/RS/US), the legacy ANSI mapping.
//     NSEvent.characters also carries these in U+F700-U+F74F
//     (NSFunctionKey naming) but WebKit's silent edit path inserts the
//     C0 form, not the NSFunctionKey one.
//
//   - **Cmd / Ctrl shortcuts that fail to bind a command** (e.g., Cmd+V
//     on an empty clipboard) → other C0 controls leak through the
//     `keyDown:` fallback. Cmd+V can leak U+0016 (SYN, Ctrl+V's ASCII
//     mapping) for example.
//
// Strategy: the ONLY printable-and-legitimate C0/C1 controls in normal
// text input are Tab (U+0009), LF (U+000A), and CR (U+000D). Everything
// else in the C0 (U+0000-U+001F), DEL (U+007F), and C1 (U+0080-U+009F)
// ranges is treated as a leak and stripped — along with the
// NSFunctionKey range U+F700-U+F74F. This catches every variant of
// the keyboard-shortcut tofu leak without needing to enumerate which
// codepoint each shortcut leaks.
//
// Defense layers (capture-phase, document-level):
//
//   1. `beforeinput` — preventDefault when WebKit routes the leak
//      through the standard edit pipeline. DOM is never mutated.
//
//   2. `input` — fallback for paths that fire `input` but skip
//      `beforeinput`. Rewrites the DOM value via the **native**
//      prototype setter (NOT `el.value =`, which goes through React's
//      intercepted setter and updates its valueTracker, suppressing
//      the legitimate `onChange`).
//
//   3. `keydown` — fallback for the WORST path on wry 0.54.4 +
//      WKWebView (objc2 migration regression): WebKit silently mutates
//      the textarea DOM value during keyDown handling without firing
//      either `beforeinput` or `input`. Layers 1 & 2 never see this
//      leak. We schedule scrubs across micro-task / rAF / setTimeout
//      boundaries; whichever runs after WebKit's silent mutation
//      catches it before paint.
//
// WebView2 (Win) and webkit2gtk (Linux) don't have the leak, so the
// codepoint check fast-paths out on every keystroke off macOS.
//
// See `specs/tech_docs/macos_arrow_key_leak_investigation.md` for the
// full investigation log including the C0-control-codepoint discovery.

let installed = false;

// Capture the original prototype setters once, before React patches
// the instance setter on tracked elements. Calling the prototype
// setter directly bypasses React's value tracker, which is what
// preserves the legitimate `onChange` for mixed-content cases.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;
const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value',
)?.set;

// Older scheduled scrubs become no-ops once 4 newer keydowns arrive,
// so a long key-repeat doesn't fan out into N×5 simultaneous retries.
let scrubGeneration = 0;

// Keys that AppKit can route through the function-key codepoint bands.
// We also scrub on any Cmd/Ctrl-modified key (covers Cmd+V on empty
// clipboard, Cmd+anything-not-bound, Ctrl+letter Emacs bindings) and
// on any key whose `event.key` itself contains a leak codepoint.
const FUNCTION_KEY_NAMES: ReadonlySet<string> = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'PageUp', 'PageDown', 'Home', 'End',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Insert',
]);

export function installMacFunctionKeyGuard(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('beforeinput', onBeforeInput, { capture: true });
  document.addEventListener('input', onInput, { capture: true });
  document.addEventListener('keydown', onKeyDown, { capture: true });
  // Cmd+V on empty clipboard (and other failed shortcuts) can leak via
  // the `paste` path without going through `beforeinput`. Schedule a
  // post-event scrub to catch those.
  document.addEventListener('paste', scheduleScrub, { capture: true });
}

function onBeforeInput(e: Event): void {
  const ie = e as InputEvent;
  if (ie.inputType !== 'insertText' && ie.inputType !== 'insertReplacementText') {
    return;
  }
  const data = ie.data;
  if (!data) return;
  if (containsLeakedFunctionKey(data)) {
    e.preventDefault();
  }
}

function onInput(e: Event): void {
  const target = e.target;
  if (target instanceof HTMLTextAreaElement) {
    flushIfLeaked(target, nativeTextareaValueSetter);
    return;
  }
  if (target instanceof HTMLInputElement) {
    if (!isTextInputType(target.type)) return;
    flushIfLeaked(target, nativeInputValueSetter);
  }
}

// We DO NOT preventDefault on keydown — caret movement, selection,
// scroll, and React's own keydown handlers must still see the event.
// We only schedule a post-event scrub.
function onKeyDown(e: KeyboardEvent): void {
  // Schedule a scrub when the keypress could plausibly leak:
  //   - canonical function-key names (arrows, page, home, end, F-keys)
  //   - `event.key` itself carries a leak codepoint
  //   - Cmd/Ctrl-modified key (failed shortcuts can leak control chars
  //     through the `keyDown:` fallback — Cmd+V on empty clipboard etc)
  if (
    !FUNCTION_KEY_NAMES.has(e.key)
    && !containsLeakedFunctionKey(e.key)
    && !e.metaKey
    && !e.ctrlKey
  ) {
    return;
  }
  scheduleScrub();
}

function scheduleScrub(): void {
  const gen = ++scrubGeneration;
  const run = () => {
    if (gen + 4 < scrubGeneration) return;
    scrubAllInputs();
  };
  // 5 attempts at different timing boundaries. WebKit's silent DOM
  // mutation has been observed at all of: next microtask, before paint
  // (rAF), after macrotasks (setTimeout 0), and on slow JS threads up
  // to ~120 ms later.
  queueMicrotask(run);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
  }
  setTimeout(run, 0);
  setTimeout(run, 32);
  setTimeout(run, 120);
}

function scrubAllInputs(): void {
  const nodes = document.querySelectorAll('textarea, input');
  for (const el of Array.from(nodes)) {
    if (el instanceof HTMLTextAreaElement) {
      scrubElement(el, nativeTextareaValueSetter);
    } else if (el instanceof HTMLInputElement && isTextInputType(el.type)) {
      scrubElement(el, nativeInputValueSetter);
    }
  }
  const active = pierceShadow(document.activeElement);
  if (active instanceof HTMLElement && active.isContentEditable) {
    scrubContentEditable(active);
  }
}

function scrubElement(
  el: HTMLInputElement | HTMLTextAreaElement,
  setter: ((this: HTMLInputElement | HTMLTextAreaElement, v: string) => void) | undefined,
): void {
  const dirty = el.value;
  if (!containsLeakedFunctionKey(dirty)) return;
  const clean = stripLeakedFunctionKeys(dirty);
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const direction = el.selectionDirection || 'none';
  if (setter) setter.call(el, clean);
  else el.value = clean;
  if (start !== null && end !== null) {
    const ns = clampSelection(start, dirty, clean);
    const ne = clampSelection(end, dirty, clean);
    try { el.setSelectionRange(ns, ne, direction); }
    catch { /* selection restore is best-effort */ }
  }
}

function scrubContentEditable(root: HTMLElement): void {
  const selection = window.getSelection?.();
  let removed = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = String(node.nodeValue ?? '');
    if (containsLeakedFunctionKey(value)) {
      const clean = stripLeakedFunctionKeys(value);
      node.nodeValue = clean;
      removed += value.length - clean.length;
    }
    node = walker.nextNode();
  }
  if (removed > 0 && selection) {
    // Caret may now point past the end of a shortened text node — reset
    // to the end of the contentEditable to keep things sane.
    try {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch { /* ignore */ }
  }
}

function pierceShadow(node: Element | null): Element | null {
  let cursor: Element | null = node;
  while (cursor && cursor.shadowRoot && cursor.shadowRoot.activeElement) {
    cursor = cursor.shadowRoot.activeElement;
  }
  return cursor;
}

function flushIfLeaked(
  el: HTMLInputElement | HTMLTextAreaElement,
  setter: ((this: HTMLInputElement | HTMLTextAreaElement, v: string) => void) | undefined,
): void {
  const dirty = el.value;
  if (!containsLeakedFunctionKey(dirty)) return;
  const clean = stripLeakedFunctionKeys(dirty);
  // Save selection BEFORE writing — writing the value collapses
  // the selection on most engines.
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (setter) setter.call(el, clean);
  else el.value = clean;
  if (start !== null && end !== null) {
    const ns = clampSelection(start, dirty, clean);
    const ne = clampSelection(end, dirty, clean);
    el.setSelectionRange(ns, ne);
  }
}

function clampSelection(pos: number, dirty: string, clean: string): number {
  let removed = 0;
  const limit = Math.min(pos, dirty.length);
  for (let i = 0; i < limit; i++) {
    if (isLeakedFunctionKeyCodepoint(dirty.charCodeAt(i))) removed++;
  }
  return Math.max(0, Math.min(pos - removed, clean.length));
}

function isLeakedFunctionKeyCodepoint(cp: number): boolean {
  // NSFunctionKey range (Cocoa).
  if (cp >= 0xf700 && cp <= 0xf74f) return true;
  // The only legitimate C0 controls in normal text input.
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  // C0 controls (U+0000-U+001F) — leak vectors include U+001C-U+001F
  // for arrows, U+0016 SYN for Cmd+V on empty clipboard, etc.
  if (cp <= 0x1f) return true;
  // DEL (U+007F) and C1 controls (U+0080-U+009F) — none of these are
  // legitimate user input; treat as leak.
  if (cp >= 0x7f && cp <= 0x9f) return true;
  return false;
}

function containsLeakedFunctionKey(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (isLeakedFunctionKeyCodepoint(s.charCodeAt(i))) return true;
  }
  return false;
}

function stripLeakedFunctionKeys(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (isLeakedFunctionKeyCodepoint(s.charCodeAt(i))) continue;
    out += s[i];
  }
  return out;
}

const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'url', 'tel', 'email', 'password',
]);

function isTextInputType(t: string): boolean {
  return TEXT_INPUT_TYPES.has(t.toLowerCase());
}
