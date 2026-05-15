// Format a Tauri accelerator string for display, per platform.
// PRD 0.2.16 §4.2.5.
//
// Input examples (Tauri accelerator syntax):
//   "CmdOrCtrl+Shift+M"
//   "Cmd+Option+Space"
//   "Ctrl+Alt+M"
//
// Output on macOS (uses symbols, no separators): "⌘⇧M"
// Output elsewhere (textual, "+" separated):     "Ctrl+Shift+M"

const MAC_SYMBOLS: Record<string, string> = {
  cmd: '⌘',
  command: '⌘',
  cmdorctrl: '⌘',
  commandorcontrol: '⌘',
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  opt: '⌥',
  shift: '⇧',
  meta: '⌘',
  super: '⌘',
  win: '⌘',
};

const TEXTUAL_LABELS: Record<string, string> = {
  cmd: 'Cmd',
  command: 'Cmd',
  cmdorctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  super: 'Super',
  win: 'Win',
};

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform.toLowerCase().includes('mac');
}

/** Map Tauri key tokens to nicer display strings (e.g. "ArrowLeft" → "←"). */
function displayMainKey(token: string, isMac: boolean): string {
  const t = token.toLowerCase();
  switch (t) {
    case 'space': return isMac ? '␣' : 'Space';
    case 'enter':
    case 'return': return isMac ? '↩' : 'Enter';
    case 'tab': return isMac ? '⇥' : 'Tab';
    case 'escape':
    case 'esc': return 'Esc';
    case 'backspace': return isMac ? '⌫' : 'Backspace';
    case 'delete':
    case 'del': return isMac ? '⌦' : 'Del';
    case 'arrowleft':
    case 'left': return isMac ? '←' : '←';
    case 'arrowright':
    case 'right': return isMac ? '→' : '→';
    case 'arrowup':
    case 'up': return '↑';
    case 'arrowdown':
    case 'down': return '↓';
    default: return token.toUpperCase();
  }
}

export function formatAccelerator(accelerator: string): string {
  const isMac = isMacPlatform();
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);

  // Sort modifiers in canonical order (mac: Ctrl Alt Shift Cmd; win: Ctrl Alt Shift Win)
  const macOrder = ['ctrl', 'alt', 'option', 'opt', 'shift', 'cmd', 'command', 'meta', 'super', 'win', 'cmdorctrl', 'commandorcontrol'];
  const winOrder = ['ctrl', 'control', 'cmdorctrl', 'commandorcontrol', 'meta', 'super', 'win', 'alt', 'option', 'opt', 'shift'];
  const order = isMac ? macOrder : winOrder;

  const modifiers: string[] = [];
  let main = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower in MAC_SYMBOLS) modifiers.push(lower);
    else main = part;
  }
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  if (isMac) {
    const modStr = modifiers.map((m) => MAC_SYMBOLS[m]).join('');
    return modStr + displayMainKey(main, true);
  }
  const modStr = modifiers.map((m) => TEXTUAL_LABELS[m]).join('+');
  const tail = displayMainKey(main, false);
  return modStr ? `${modStr}+${tail}` : tail;
}
