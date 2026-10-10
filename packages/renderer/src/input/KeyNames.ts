/**
 * CORE.17.k.b.b.a.g.f.a — the retail display name of a key binding, as the
 * Keyboard Config dialog's Mapping buttons show it.
 *
 * UIOption_ActionKeyMap::Refresh @ 00487280 labels each button with
 * ID_ActionKeyMap_ButtonLabel (0x23000004 #244184204 — the bare LABEL
 * variable) filled from CInputManager_WIN32::GetNameFromKey(QualifiedControl)
 * @ 00687f40:
 *
 *   1. every meta-mode bit set, walked from bit 0 upward (so 0x10000000 Win,
 *      then 0x20000000 Alt, 0x40000000 Ctrl, 0x80000000 Shift), becomes the
 *      name of CMasterInputMap::KeyFromMetaMode(bit) @ 0068d890 — the FIRST
 *      meta key in the map's list carrying that bit: DIK_LSHIFT, DIK_LCONTROL,
 *      DIK_LMENU, DIK_LWIN (gmDefaultMap lists LShift, LCtrl, RCtrl, LAlt,
 *      RAlt, LWin, RWin);
 *   2. the key itself (GetNameFromKey_Internal @ 00687800): the string-table
 *      entry keyed by compute_str_hash(ControlSpecification::GetDIKName) —
 *      the DIK_* identifier ControlNameMapper::LoadSemantics @ 0068b820
 *      registers — when the language DAT has one, else the DirectInput device
 *      object name (IDirectInputDevice8::GetObjectInfo, the Windows keyboard
 *      layout's GetKeyNameText string for the scan code);
 *   3. the parts joined with ID_KeyDescDelimiter (0x23000007 #95382770 "+").
 *
 * The EoL language DAT overrides exactly four names: DIK_LCONTROL "Left Ctrl"
 * and DIK_LMENU "Left Alt" (table 0x2300000a), DIK_LWIN / DIK_RWIN "Windows"
 * (0x2300000b) — DirectInput itself reports the left keys as plain "Ctrl" /
 * "Alt" / "Left Windows". Every other name below is the Windows US layout's
 * key name (kbdus KeyNames / KeyNamesExt) that DirectInput hands back: the
 * printable keys are their uppercase character, the navigation cluster its
 * spelled-out name ("Page Up", "Insert"), the numpad "Num <key>".
 */
import { DIK_TO_CODE } from './DirectInputKeys.js';

/** DIK_* scan code → the name the retail dialog draws (see the header). */
export const DIK_DISPLAY_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
  [0x01, 'Esc'],
  [0x02, '1'], [0x03, '2'], [0x04, '3'], [0x05, '4'], [0x06, '5'],
  [0x07, '6'], [0x08, '7'], [0x09, '8'], [0x0a, '9'], [0x0b, '0'],
  [0x0c, '-'], [0x0d, '='], [0x0e, 'Backspace'], [0x0f, 'Tab'],
  [0x10, 'Q'], [0x11, 'W'], [0x12, 'E'], [0x13, 'R'], [0x14, 'T'], [0x15, 'Y'],
  [0x16, 'U'], [0x17, 'I'], [0x18, 'O'], [0x19, 'P'],
  [0x1a, '['], [0x1b, ']'], [0x1c, 'Enter'], [0x1d, 'Left Ctrl'],
  [0x1e, 'A'], [0x1f, 'S'], [0x20, 'D'], [0x21, 'F'], [0x22, 'G'], [0x23, 'H'],
  [0x24, 'J'], [0x25, 'K'], [0x26, 'L'],
  [0x27, ';'], [0x28, "'"], [0x29, '`'], [0x2a, 'Shift'], [0x2b, '\\'],
  [0x2c, 'Z'], [0x2d, 'X'], [0x2e, 'C'], [0x2f, 'V'], [0x30, 'B'], [0x31, 'N'], [0x32, 'M'],
  [0x33, ','], [0x34, '.'], [0x35, '/'], [0x36, 'Right Shift'],
  [0x37, 'Num *'], [0x38, 'Left Alt'], [0x39, 'Space'], [0x3a, 'Caps Lock'],
  [0x3b, 'F1'], [0x3c, 'F2'], [0x3d, 'F3'], [0x3e, 'F4'], [0x3f, 'F5'], [0x40, 'F6'],
  [0x41, 'F7'], [0x42, 'F8'], [0x43, 'F9'], [0x44, 'F10'],
  [0x45, 'Pause'], [0x46, 'Scroll Lock'],
  [0x47, 'Num 7'], [0x48, 'Num 8'], [0x49, 'Num 9'], [0x4a, 'Num -'],
  [0x4b, 'Num 4'], [0x4c, 'Num 5'], [0x4d, 'Num 6'], [0x4e, 'Num +'],
  [0x4f, 'Num 1'], [0x50, 'Num 2'], [0x51, 'Num 3'], [0x52, 'Num 0'], [0x53, 'Num Del'],
  [0x56, '\\'],
  [0x57, 'F11'], [0x58, 'F12'],
  [0x64, 'F13'], [0x65, 'F14'], [0x66, 'F15'],
  [0x8d, 'Num ='],
  [0x9c, 'Num Enter'], [0x9d, 'Right Ctrl'],
  [0xb3, 'Num ,'], [0xb5, 'Num /'], [0xb8, 'Right Alt'],
  [0xc5, 'Num Lock'],
  [0xc7, 'Home'], [0xc8, 'Up'], [0xc9, 'Page Up'], [0xcb, 'Left'], [0xcd, 'Right'],
  [0xcf, 'End'], [0xd0, 'Down'], [0xd1, 'Page Down'], [0xd2, 'Insert'], [0xd3, 'Delete'],
  [0xdb, 'Windows'], [0xdc, 'Windows'], [0xdd, 'Application'],
]);

/** The four names the language DAT overrides (compute_str_hash(DIK name) → 0x2300000a / 0x2300000b). */
export const DAT_KEY_NAME_OVERRIDES: ReadonlyArray<{ dik: number; dikName: string; stringId: number; name: string }> = [
  { dik: 0x1d, dikName: 'DIK_LCONTROL', stringId: 80577340, name: 'Left Ctrl' },
  { dik: 0x38, dikName: 'DIK_LMENU', stringId: 21058261, name: 'Left Alt' },
  { dik: 0xdb, dikName: 'DIK_LWIN', stringId: 236199774, name: 'Windows' },
  { dik: 0xdc, dikName: 'DIK_RWIN', stringId: 236224350, name: 'Windows' },
];

/** ID_KeyDescDelimiter — 0x23000007 #95382770 "+" — between the meta names and the key. */
export const KEY_DESC_DELIMITER_STRING_ID = 95382770;
export const KEY_DESC_DELIMITER = '+';

/** KeyboardEvent.code → DIK_* (the inverse of DIK_TO_CODE). */
export const CODE_TO_DIK: ReadonlyMap<string, number> = new Map(
  [...DIK_TO_CODE].map(([dik, code]) => [code, dik] as [string, number]),
);

/**
 * The meta prefixes a KeybindRegistry code can carry, in GetNameFromKey's
 * walk order (the meta bits from bit 0 upward: Alt 0x20000000 before Ctrl
 * 0x40000000 before Shift 0x80000000), each named as KeyFromMetaMode's first
 * key with that bit (the left one).
 */
const META_NAMES: ReadonlyArray<{ prefix: string; dik: number }> = [
  { prefix: 'Alt', dik: 0x38 },
  { prefix: 'Ctrl', dik: 0x1d },
  { prefix: 'Shift', dik: 0x2a },
];

/**
 * CORE.18.b.a.a.a.a.a.b.a — the mouse wheel's two sub-controls (0x80101 /
 * 0x80201, bound by the mouse-turning defaults). No string-table entry is
 * keyed by the DIMOFS_Z name, so GetNameFromKey_Internal takes DirectInput's
 * object name for the mouse Z axis ("Wheel") and — the sub-control byte being
 * sci_PositiveAxis (1) / sci_NegativeAxis (2) — formats it through
 * ID_KeyNameWithSubControl (0x23000007 #74869020 "<KEY> <SUBCONTROL>") with
 * ID_sci_PositiveAxis "Up" (#152672291) / ID_sci_NegativeAxis "Down"
 * (#254070819).
 */
export const MOUSE_CONTROL_NAMES: ReadonlyMap<string, string> = new Map([
  ['MouseWheelUp', 'Wheel Up'],
  ['MouseWheelDown', 'Wheel Down'],
  // RECON.keyboard-dialog — DIMOFS_BUTTON0-7: no string-table entry is keyed
  // by a DIMOFS_BUTTON name either (0x2300000a / 0x2300000b carry only the
  // four keyboard overrides), so the label is DirectInput's object name for
  // the system mouse button, "Button <n>" (n = the DirectInput index:
  // 0 left, 1 right, 2 middle).
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => [`MouseButton${n}`, `Button ${n}`] as [string, string]),
]);

/** The retail name of one KeyboardEvent.code (no meta), '' when unknown. */
export function keyDisplayName(code: string): string {
  const mouse = MOUSE_CONTROL_NAMES.get(code);
  if (mouse !== undefined) return mouse;
  const dik = CODE_TO_DIK.get(code);
  if (dik !== undefined) return DIK_DISPLAY_NAMES.get(dik) ?? '';
  return '';
}

/**
 * The retail Mapping-button label for a registry code ("Ctrl+Alt+Shift+KeyW"
 * → "Left Alt+Left Ctrl+Shift+W"; a bare "ShiftLeft" → "Shift"; null → '').
 * A code whose key has no name yields '' the way GetNameFromKey returns the
 * empty string for a key DirectInput cannot name (the button then clears).
 */
export function retailKeyLabel(code: string | null | undefined, delimiter: string = KEY_DESC_DELIMITER): string {
  if (!code) return '';
  const parts = code.split('+');
  const base = parts.pop()!;
  const mods = new Set(parts);
  const key = keyDisplayName(base);
  if (!key) return '';
  const names: string[] = [];
  for (const m of META_NAMES) if (mods.has(m.prefix)) names.push(DIK_DISPLAY_NAMES.get(m.dik)!);
  names.push(key);
  return names.join(delimiter);
}
