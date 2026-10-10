/**
 * ActionClass — the six retail keyboard-config categories.
 *
 * These values are the `actionClass` field of every binding in the portal.dat
 * ActionMap (0x26000000); the retail gmKeyboardUI groups its command list into
 * one tab per class. Verified by dumping the ActionMap and resolving each
 * action-name hash via StringTable 0x23000005 (see tools/gen-keybind-actions.mjs):
 * class 1 = Movement, 2 = Camera, 3 = UI, 4 = Combat, 5 = Emotes,
 * 7 = CharacterSettings. (Class 0 / 6 entries are unnamed reserved slots and
 * are excluded from the command list.)
 *
 * The dialog tab order (Movement / Camera / Combat / UI / CharacterSettings /
 * Emotes) is the layout-0x21000009 tab-strip order, NOT numeric class order —
 * see KEYBIND_TAB_ORDER.
 */
export enum ActionClass {
  Movement = 1,
  Camera = 2,
  UI = 3,
  Combat = 4,
  Emotes = 5,
  CharacterSettings = 7,
}

/**
 * Tab display order + labels, matching the six 97x25 tabs in layout
 * 0x21000009 (options.md spec): Movement / Camera / Combat / UI /
 * CharacterSettings / Emotes. Labels come straight from the DAT strings the
 * spec records.
 */
export const KEYBIND_TAB_ORDER: { cls: ActionClass; label: string; stringId: number }[] = [
  { cls: ActionClass.Movement, label: 'Movement', stringId: 87231042 },
  { cls: ActionClass.Camera, label: 'Camera', stringId: 257877474 },
  { cls: ActionClass.Combat, label: 'Combat', stringId: 253627074 },
  { cls: ActionClass.UI, label: 'UI', stringId: 117380834 },
  { cls: ActionClass.CharacterSettings, label: 'CharacterSettings', stringId: 58086274 },
  { cls: ActionClass.Emotes, label: 'Emotes', stringId: 171574434 },
];
