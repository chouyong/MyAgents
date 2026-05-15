// ShortcutRecorder — captures a keyboard shortcut combination from the user.
//
// PRD 0.2.16 §3.3 rules:
//   - Must include ≥ 1 modifier (Cmd/Ctrl/Alt/Shift)
//   - Must include ≥ 1 non-modifier main key
//   - Reject Shift+letter only (conflicts with normal text input)
//   - Esc cancels recording without applying
//
// Output is a Tauri-accelerator-syntax string like "CmdOrCtrl+Shift+M".
// Modifier canonicalization: Cmd on macOS → "CmdOrCtrl"; Ctrl on Win/Linux → "CmdOrCtrl".
// This means a user pressing the same physical shortcut on either platform
// produces the same accelerator string, matching DEFAULT_SUMMON_ACCELERATOR.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { formatAccelerator } from '@/utils/formatAccelerator';

export interface ShortcutRecorderProps {
  /** Current accelerator (e.g. "CmdOrCtrl+Shift+M") — controlled. */
  value: string;
  /** Called when the user successfully records a new accelerator. */
  onChange: (newAccelerator: string) => void;
  /** Optional: disable the recorder entirely. */
  disabled?: boolean;
  /** Optional: extra class for the button. */
  className?: string;
}

const MAIN_KEY_BLOCKLIST = new Set([
  'Meta', 'Control', 'Alt', 'Shift',
  'CapsLock', 'NumLock', 'ScrollLock',
  'Tab', // we steal Tab → confusing
  'ContextMenu',
  'Dead', // dead keys
]);

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform.toLowerCase().includes('mac');
}

/** Convert a KeyboardEvent into a Tauri accelerator string. Returns null
 *  if the combo isn't valid (no modifier, blocked main key, etc.). */
function eventToAccelerator(e: KeyboardEvent): { ok: true; accel: string } | { ok: false; reason: string } {
  const mods: string[] = [];
  // Canonical: Cmd on mac, Ctrl elsewhere → "CmdOrCtrl"
  if (isMac()) {
    if (e.metaKey) mods.push('CmdOrCtrl');
    if (e.ctrlKey) mods.push('Ctrl');
  } else {
    if (e.ctrlKey) mods.push('CmdOrCtrl');
    if (e.metaKey) mods.push('Super');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  // Resolve main key from `e.code` (layout-independent) when possible.
  // KeyboardEvent.code: "KeyA"-"KeyZ", "Digit0"-"Digit9", "Space", "Enter", "ArrowLeft"…
  let main = '';
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) {
    main = code.slice(3); // "KeyM" → "M"
  } else if (/^Digit\d$/.test(code)) {
    main = code.slice(5); // "Digit1" → "1"
  } else if (/^F\d{1,2}$/.test(code)) {
    main = code; // F1..F12
  } else {
    // Fall back to e.key for special keys
    const named: Record<string, string> = {
      Space: 'Space',
      Enter: 'Enter',
      Backspace: 'Backspace',
      Delete: 'Delete',
      ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
      Comma: 'Comma', Period: 'Period', Slash: 'Slash',
      Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote',
      BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
      Minus: 'Minus', Equal: 'Equal',
    };
    main = named[code] ?? '';
  }

  if (!main) return { ok: false, reason: '请选择一个普通按键' };
  if (MAIN_KEY_BLOCKLIST.has(main)) return { ok: false, reason: '该按键不能作为快捷键' };
  if (mods.length === 0) return { ok: false, reason: '请至少加一个修饰键（Cmd/Ctrl/Alt/Shift）' };

  // Reject Shift+letter only — Shift alone with a letter just types capital.
  const onlyShift = mods.length === 1 && mods[0] === 'Shift';
  const isLetter = /^[A-Z]$/.test(main);
  if (onlyShift && isLetter) {
    return { ok: false, reason: '仅 Shift+字母 与文字输入冲突，请加 Cmd/Ctrl/Alt' };
  }

  return { ok: true, accel: [...mods, main].join('+') };
}

const ShortcutRecorder = memo(function ShortcutRecorder({
  value,
  onChange,
  disabled = false,
  className,
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const startRecording = useCallback(() => {
    if (disabled) return;
    setRecording(true);
    setHint(null);
  }, [disabled]);

  const stopRecording = useCallback((message?: string) => {
    setRecording(false);
    setHint(message ?? null);
  }, []);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        stopRecording('已取消');
        return;
      }

      // Ignore pure modifier keypresses — wait for the user to add a main key.
      const isPureModifier =
        e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift';
      if (isPureModifier) return;

      const result = eventToAccelerator(e);
      if (!result.ok) {
        setHint(result.reason);
        return;
      }
      stopRecording();
      onChange(result.accel);
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [recording, onChange, stopRecording]);

  // Auto-blur when entering recording state so the button doesn't trap focus
  useEffect(() => {
    if (recording) {
      buttonRef.current?.blur();
    }
  }, [recording]);

  const display = recording ? '请按下快捷键…（Esc 取消）' : formatAccelerator(value);

  return (
    <div className={`flex flex-col items-end gap-1 ${className ?? ''}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={startRecording}
        disabled={disabled}
        className={`min-w-[140px] rounded-lg border px-3 py-1.5 text-sm font-mono transition-colors ${
          recording
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] animate-pulse'
            : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] hover:border-[var(--line-strong)]'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        title={recording ? '正在录制：请按下快捷键，或按 Esc 取消' : '点击修改快捷键'}
      >
        {display}
      </button>
      {hint && (
        <p className="text-xs text-[var(--ink-muted)]">{hint}</p>
      )}
    </div>
  );
});

export default ShortcutRecorder;
