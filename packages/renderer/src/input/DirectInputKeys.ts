/**
 * DirectInput keyboard scan codes (DIK_*) → KeyboardEvent.code.
 *
 * The retail KeyMap DAT (0x14xxxxxx) addresses keyboard controls by the
 * DirectInput DIK_* scan code (ControlNameMapper::LoadSemantics @ 0068b820 in
 * reference/client-eol/decomp/acclient-decompiled.c registers the name → code
 * table: DIK_ESCAPE 1 … DIK_DELETE 0xd3). DIK codes are the PC/AT set-1 make
 * codes (0xe0-prefixed keys carry +0x80), which is also what
 * KeyboardEvent.code names, so the mapping is one-to-one on a US layout.
 *
 * Only the codes a browser can deliver are listed; the rest (DIK_SYSRQ,
 * multimedia and Japanese keys) resolve to null and are left unbound.
 */
export const DIK_TO_CODE: ReadonlyMap<number, string> = new Map<number, string>([
  [0x01, 'Escape'],
  [0x02, 'Digit1'], [0x03, 'Digit2'], [0x04, 'Digit3'], [0x05, 'Digit4'], [0x06, 'Digit5'],
  [0x07, 'Digit6'], [0x08, 'Digit7'], [0x09, 'Digit8'], [0x0a, 'Digit9'], [0x0b, 'Digit0'],
  [0x0c, 'Minus'], [0x0d, 'Equal'], [0x0e, 'Backspace'], [0x0f, 'Tab'],
  [0x10, 'KeyQ'], [0x11, 'KeyW'], [0x12, 'KeyE'], [0x13, 'KeyR'], [0x14, 'KeyT'], [0x15, 'KeyY'],
  [0x16, 'KeyU'], [0x17, 'KeyI'], [0x18, 'KeyO'], [0x19, 'KeyP'],
  [0x1a, 'BracketLeft'], [0x1b, 'BracketRight'], [0x1c, 'Enter'], [0x1d, 'ControlLeft'],
  [0x1e, 'KeyA'], [0x1f, 'KeyS'], [0x20, 'KeyD'], [0x21, 'KeyF'], [0x22, 'KeyG'], [0x23, 'KeyH'],
  [0x24, 'KeyJ'], [0x25, 'KeyK'], [0x26, 'KeyL'],
  [0x27, 'Semicolon'], [0x28, 'Quote'], [0x29, 'Backquote'], [0x2a, 'ShiftLeft'], [0x2b, 'Backslash'],
  [0x2c, 'KeyZ'], [0x2d, 'KeyX'], [0x2e, 'KeyC'], [0x2f, 'KeyV'], [0x30, 'KeyB'], [0x31, 'KeyN'], [0x32, 'KeyM'],
  [0x33, 'Comma'], [0x34, 'Period'], [0x35, 'Slash'], [0x36, 'ShiftRight'],
  [0x37, 'NumpadMultiply'], [0x38, 'AltLeft'], [0x39, 'Space'], [0x3a, 'CapsLock'],
  [0x3b, 'F1'], [0x3c, 'F2'], [0x3d, 'F3'], [0x3e, 'F4'], [0x3f, 'F5'], [0x40, 'F6'],
  [0x41, 'F7'], [0x42, 'F8'], [0x43, 'F9'], [0x44, 'F10'],
  [0x45, 'NumLock'], [0x46, 'ScrollLock'],
  [0x47, 'Numpad7'], [0x48, 'Numpad8'], [0x49, 'Numpad9'], [0x4a, 'NumpadSubtract'],
  [0x4b, 'Numpad4'], [0x4c, 'Numpad5'], [0x4d, 'Numpad6'], [0x4e, 'NumpadAdd'],
  [0x4f, 'Numpad1'], [0x50, 'Numpad2'], [0x51, 'Numpad3'], [0x52, 'Numpad0'], [0x53, 'NumpadDecimal'],
  [0x56, 'IntlBackslash'],
  [0x57, 'F11'], [0x58, 'F12'],
  [0x64, 'F13'], [0x65, 'F14'], [0x66, 'F15'],
  [0x8d, 'NumpadEqual'],
  [0x9c, 'NumpadEnter'], [0x9d, 'ControlRight'],
  [0xb3, 'NumpadComma'], [0xb5, 'NumpadDivide'], [0xb8, 'AltRight'],
  [0xc5, 'Pause'],
  [0xc7, 'Home'], [0xc8, 'ArrowUp'], [0xc9, 'PageUp'], [0xcb, 'ArrowLeft'], [0xcd, 'ArrowRight'],
  [0xcf, 'End'], [0xd0, 'ArrowDown'], [0xd1, 'PageDown'], [0xd2, 'Insert'], [0xd3, 'Delete'],
  [0xdb, 'MetaLeft'], [0xdc, 'MetaRight'], [0xdd, 'ContextMenu'],
]);

/** DIK_* code → KeyboardEvent.code, or null for a key the browser cannot deliver. */
export function dikToCode(dik: number): string | null {
  return DIK_TO_CODE.get(dik) ?? null;
}

/**
 * The gmDefaultMap / DefaultMap meta-key table (KeyMap.metaKeys): LShift →
 * 0x80000000, L/RControl → 0x40000000, L/RMenu → 0x20000000, L/RWin →
 * 0x10000000 (the engine map adds mouse buttons 3 / 4 at 0x08000000 /
 * 0x04000000). These are the bits a QualifiedControl.metaMode carries.
 */
export const META_SHIFT = 0x80000000;
export const META_CTRL = 0x40000000;
export const META_ALT = 0x20000000;
export const META_WIN = 0x10000000;

/**
 * Meta-mode bits → the KeybindRegistry code prefix ("Ctrl+", "Alt+", "Shift+"
 * in eventToCode's order). Returns null for a combination the browser cannot
 * deliver as a keydown (a mouse-button meta or the Win key, which
 * eventToCode folds into Ctrl).
 */
export function metaModeToPrefix(metaMode: number): string | null {
  const known = META_SHIFT | META_CTRL | META_ALT;
  if (((metaMode >>> 0) & ~known) >>> 0) return null;
  const parts: string[] = [];
  if (metaMode & META_CTRL) parts.push('Ctrl');
  if (metaMode & META_ALT) parts.push('Alt');
  if (metaMode & META_SHIFT) parts.push('Shift');
  return parts.length ? parts.join('+') + '+' : '';
}
