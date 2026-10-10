/**
 * Pure presentation model for the Keyboard Config dialog (gmKeyboardUI, layout
 * 0x21000009). Kept DOM-free so the row/column derivation is unit-testable; the
 * GameUI renderer consumes these rows to build the list, and the live input
 * router shares the same KeybindRegistry.
 *
 * CORE.17.k.b.b.a.g.f.a — the list is what gmKeyboardUI::InitOptions @ 004dd8b0
 * builds: per tab (action class) one header row per input map (template
 * 0x1000002e, the map's ID_InputMap_* name — GetStringInfoFromInputMapID @
 * 004da980) followed by one UIOption_ActionKeyMap row (template 0x1000002f)
 * per (map, action) in ActionMap DAT order, its Mapping buttons labelled by
 * KeyNames.retailKeyLabel and its tooltips / prompts from string table
 * 0x23000004.
 */
import { getStringParts } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { KeybindRegistry } from '../input/KeybindRegistry.js';
import { codeToLabel } from '../input/KeybindRegistry.js';
import { ActionClass, KEYBIND_TAB_ORDER } from '../input/KeybindActionClass.js';
import { KEYBIND_ACTION_ROWS } from '../input/KeybindActions.generated.js';
import { RETAIL_SECTION_KEYBINDS } from '../input/KeybindDefaults.generated.js';

/**
 * NO-DEAD-ENDS (Jake 2026-10-04) — commands whose retail target is gone are
 * not listed: Open Help (0x7b, an external Keystone plugin), Show/Hide Abuse
 * Reporting Panel (0x10000003, ACE drops AbuseLogRequest) and Show/Hide
 * Urgent Assistance Panel (0x1000000b). Their keys simply do nothing.
 */
export const HIDDEN_DEAD_END_ACTIONS: ReadonlySet<number> = new Set([0x7b, 0x10000003, 0x1000000b]);

/** HIDDEN_DEAD_END_ACTIONS plus `eraHidden` (the commands of features a world's era lacks). */
export function keyboardHiddenActions(eraHidden: Iterable<number>): ReadonlySet<number> {
  return new Set([...HIDDEN_DEAD_END_ACTIONS, ...eraHidden]);
}

/** DAT string ids for the four list columns (options.md spec, layout 0x21000009). */
export const KEYBOARD_COLUMN_STRINGS = {
  command: 266175644,
  mapping1: 219267532,
  mapping2: 222413260,
  mapping3: 221364684,
} as const;

/** DAT string ids for the six action buttons. */
export const KEYBOARD_BUTTON_STRINGS = {
  loadFile: 115934318,
  saveAs: 76038318,
  defaults: 60641838,
  revert: 125812910,
  ok: 5624846,
  cancel: 140852158,
} as const;

/**
 * The dialog's own strings — table 0x23000004 (StringInfo table enum
 * 0x10000004), keyed by compute_str_hash of the retail token. The parts are
 * the text around each variable slot (fillDatParts).
 */
export const KEYBOARD_DIALOG_STRINGS = {
  /** ID_ActionKeyMap_ButtonLabel — ["", ""] around LABEL (UIOption_ActionKeyMap::Refresh @ 00487280). */
  buttonLabel: 244184204,
  /** ID_ActionKeyMap_TT_ExistingBinding — "('" VALUE "') Left-Click to change this binding. Right-click to remove it." */
  ttExistingBinding: 179335303,
  /** ID_ActionKeyMap_TT_NewBinding — "Left-Click to add a binding for this action." */
  ttNewBinding: 119631063,
  /** ID_ActionKeyMap_MapInstructions — the capture dialog text around ACTION (InitiateBinding @ 004899d0). */
  mapInstructions: 136793091,
  /** ID_ActionKeyMap_OverwriteExistingBinding — "'" KEY "' is currently bound to '" ACTION "'. Do you wish to erase that binding?" */
  overwriteExistingBinding: 124536679,
  /** ID_ActionKeyMap_OverwriteExistingBindings — "'" KEY "' conflicts with the following bindings:\n" LIST "\nDo you wish to erase those bindings?" */
  overwriteExistingBindings: 113538707,
  /** ID_ActionKeyMap_Binding — "'" KEY "' ('" ACTION "')" — one line of that list. */
  binding: 247670807,
  /** ID_ActionKeyMap_NonUserBindableBinding — "'" KEY "' is currently bound to a non user-bindable action. …" */
  nonUserBindableBinding: 140068887,
} as const;

/** The English parts of the strings above, for a DAT-less boot / unit tests. */
export const KEYBOARD_DIALOG_STRING_FALLBACKS: Record<number, string[]> = {
  [KEYBOARD_DIALOG_STRINGS.buttonLabel]: ['', ''],
  [KEYBOARD_DIALOG_STRINGS.ttExistingBinding]: ["('", "') Left-Click to change this binding. Right-click to remove it."],
  [KEYBOARD_DIALOG_STRINGS.ttNewBinding]: ['Left-Click to add a binding for this action.'],
  [KEYBOARD_DIALOG_STRINGS.mapInstructions]: [
    "The next key you press or mouse button that you click will be mapped to the '",
    "' action.  You may combine keys with SHIFT, CTRL or ALT to create new mappings.  Remapping joystick input or mouse buttons zero(0) or one(1) is not supported.\n\nPress the ESC key to cancel.",
  ],
  [KEYBOARD_DIALOG_STRINGS.overwriteExistingBinding]: ["'", "' is currently bound to '", "'. Do you wish to erase that binding?"],
  [KEYBOARD_DIALOG_STRINGS.overwriteExistingBindings]: ["'", "' conflicts with the following bindings:\n", '\nDo you wish to erase those bindings?'],
  [KEYBOARD_DIALOG_STRINGS.binding]: ["'", "' ('", "')"],
  [KEYBOARD_DIALOG_STRINGS.nonUserBindableBinding]: ["'", "' is currently bound to a non user-bindable action. Please select a different binding."],
};

/**
 * The header row per input map: gmKeyboardUI::GetStringInfoFromInputMapID
 * @ 004da980 — ID_InputMap_* tokens hashed (Tokenize = compute_str_hash) into
 * table 0x23000005. `label` is the resolved EoL English text.
 */
export const KEYBOARD_INPUT_MAP_HEADERS: ReadonlyArray<{ map: number; token: string; stringId: number; label: string }> = [
  { map: 0x4, token: 'ID_InputMap_MovementCommands', stringId: 36186499, label: 'Movement' },
  { map: 0x5, token: 'ID_InputMap_CameraControls', stringId: 18817299, label: 'Camera' },
  { map: 0x6, token: 'ID_InputMap_CameraAlternateControls', stringId: 141775635, label: 'Alternate Camera Mode' },
  { map: 0x9, token: 'ID_InputMap_DialogBoxes', stringId: 78950259, label: 'Dialog Boxes' },
  { map: 0xb, token: 'ID_InputMap_DebugConsole', stringId: 184387461, label: 'Debug Console' },
  { map: 0xc, token: 'ID_InputMap_ProfilerUI', stringId: 83209145, label: 'Profiler UI' },
  { map: 0xd, token: 'ID_InputMap_UIDebugger', stringId: 59527954, label: 'UI Debugger' },
  { map: 0xe, token: 'ID_InputMap_DebugCommands', stringId: 265117203, label: 'Debug Commands' },
  { map: 0x10000002, token: 'ID_InputMap_Combat', stringId: 9912468, label: 'Combat' },
  { map: 0x10000003, token: 'ID_InputMap_MeleeCombat', stringId: 144223668, label: 'Melee Combat' },
  { map: 0x10000004, token: 'ID_InputMap_MissileCombat', stringId: 179906484, label: 'Missile Combat' },
  { map: 0x10000005, token: 'ID_InputMap_MagicCombat', stringId: 110654196, label: 'Magic Combat' },
  { map: 0x10000006, token: 'ID_InputMap_Emotes', stringId: 11604691, label: 'Emotes' },
  { map: 0x10000007, token: 'ID_InputMap_ItemSelectionCommands', stringId: 55285107, label: 'Item Selection' },
  { map: 0x10000008, token: 'ID_InputMap_CharacterOptionCommands', stringId: 88948147, label: 'Character Settings' },
  { map: 0x10000009, token: 'ID_InputMap_UICommands', stringId: 238357059, label: 'UI' },
  { map: 0x1000000a, token: 'ID_InputMap_ChatCommands', stringId: 114201635, label: 'Chat' },
  { map: 0x1000000c, token: 'ID_InputMap_QuickslotCommands', stringId: 132097139, label: 'Quickslots' },
  { map: 0x1000000d, token: 'ID_InputMap_ToggleChatEntry', stringId: 48872985, label: 'Toggle Chat Entry' },
];

/** The header entry for an input map, or null for a map retail names nothing (no header text). */
export function keyboardInputMapHeader(map: number): { stringId: number; label: string } | null {
  const h = KEYBOARD_INPUT_MAP_HEADERS.find((x) => x.map === map);
  return h ? { stringId: h.stringId, label: h.label } : null;
}

export interface KeyboardRow {
  id: number;
  name: string;
  /** Three display labels (''=unbound) for Mapping 1/2/3. */
  mappings: [string, string, string];
}

/** Build the command rows for one tab (action class), in generated order. */
export function buildKeyboardRows(
  registry: KeybindRegistry, cls: ActionClass, hidden: ReadonlySet<number> = HIDDEN_DEAD_END_ACTIONS,
): KeyboardRow[] {
  return registry.actionsForClass(cls).filter((a) => !hidden.has(a.id)).map((a) => {
    const m = registry.getMappings(a.id);
    return {
      id: a.id,
      name: a.name,
      mappings: [codeToLabel(m[0]), codeToLabel(m[1]), codeToLabel(m[2])] as [string, string, string],
    };
  });
}

/** One UIOption_ActionKeyMap row of the dialog list. */
export interface KeyboardSectionRow extends KeyboardRow {
  /** The input map this row lists the action under. */
  map: number;
  /** The ActionMap description — the row's tooltip (UIOption_ActionKeyMap::Init's StringInfo). */
  desc: string;
  /** The canonical codes behind `mappings` (null = empty button). */
  codes: [string | null, string | null, string | null];
  /**
   * Whether the row's keys live in the registry (the action's own map). A
   * row under a map the client never registers (the alternate-camera map 0x6)
   * shows its DAT keys read-only.
   */
  editable: boolean;
}

/** One input-map group of a tab: the header row + its command rows. */
export interface KeyboardSection {
  map: number;
  /** The header text's DAT string id (table 0x23000005), or null when retail names none. */
  headerStringId: number | null;
  /** The resolved header text (EoL English fallback). */
  header: string;
  rows: KeyboardSectionRow[];
}

const pad3 = (codes: ReadonlyArray<string | null | undefined>): [string | null, string | null, string | null] =>
  [codes[0] ?? null, codes[1] ?? null, codes[2] ?? null];

/**
 * The tab's list as retail builds it: the (map, action) rows of this action
 * class in ActionMap order, grouped under one section per input map in order
 * of first appearance (InitOptions' HashList<class, HashList<map, actions>>).
 * `hidden` drops commands (HIDDEN_DEAD_END_ACTIONS, plus a world era's
 * missing features: keyboardHiddenActions).
 */
export function buildKeyboardSections(
  registry: KeybindRegistry, cls: ActionClass,
  sectionKeys: Record<number, Record<number, string[]>> = RETAIL_SECTION_KEYBINDS,
  hidden: ReadonlySet<number> = HIDDEN_DEAD_END_ACTIONS,
): KeyboardSection[] {
  const sections: KeyboardSection[] = [];
  const byMap = new Map<number, KeyboardSection>();
  for (const { map, id } of KEYBIND_ACTION_ROWS) {
    const a = registry.action(id);
    if (!a || a.cls !== cls || hidden.has(id)) continue;
    let section = byMap.get(map);
    if (!section) {
      const h = keyboardInputMapHeader(map);
      section = { map, headerStringId: h?.stringId ?? null, header: h?.label ?? '', rows: [] };
      byMap.set(map, section);
      sections.push(section);
    }
    const editable = registry.inputMapOf(id) === map || registry.inputMapOf(id) === null;
    const codes = editable ? pad3(registry.getMappings(id)) : pad3(sectionKeys[map]?.[id] ?? []);
    section.rows.push({
      id, name: a.name, desc: a.desc ?? '', map, editable, codes,
      mappings: [codeToLabel(codes[0]), codeToLabel(codes[1]), codeToLabel(codes[2])],
    });
  }
  return sections;
}

/** Interleave a DAT string's parts with its variable values: parts[0] v[0] parts[1] v[1] … */
export function fillDatParts(parts: ReadonlyArray<string> | null | undefined, vars: ReadonlyArray<string>, fallback: ReadonlyArray<string>): string {
  const p = parts && parts.length ? parts : fallback;
  let out = '';
  for (let i = 0; i < p.length; i++) {
    out += p[i];
    if (i < vars.length && i < p.length - 1) out += vars[i];
  }
  // A DAT string with fewer parts than variables (or a one-part fallback) still gets every value.
  for (let i = Math.max(0, p.length - 1); i < vars.length; i++) out += vars[i];
  return out;
}

/** The parts of one dialog string from the language DAT, else the English fallback. */
export function keyboardDialogParts(id: number, lookup: (id: number) => string[] | null = getStringParts): string[] {
  return lookup(id) ?? KEYBOARD_DIALOG_STRING_FALLBACKS[id] ?? [];
}

/** ID_ActionKeyMap_ButtonLabel filled with the mapping's label (Refresh @ 00487280). */
export function keyboardButtonLabel(label: string, lookup?: (id: number) => string[] | null): string {
  const id = KEYBOARD_DIALOG_STRINGS.buttonLabel;
  return fillDatParts(keyboardDialogParts(id, lookup), [label], KEYBOARD_DIALOG_STRING_FALLBACKS[id]);
}

/** A Mapping button's tooltip: TT_ExistingBinding around the label, or TT_NewBinding for an empty button. */
export function keyboardButtonTooltip(label: string, lookup?: (id: number) => string[] | null): string {
  const id = label ? KEYBOARD_DIALOG_STRINGS.ttExistingBinding : KEYBOARD_DIALOG_STRINGS.ttNewBinding;
  return fillDatParts(keyboardDialogParts(id, lookup), label ? [label] : [], KEYBOARD_DIALOG_STRING_FALLBACKS[id]);
}

/** The capture dialog's text (InitiateBinding @ 004899d0: MapInstructions around the command name). */
export function keyboardMapInstructions(actionName: string, lookup?: (id: number) => string[] | null): string {
  const id = KEYBOARD_DIALOG_STRINGS.mapInstructions;
  return fillDatParts(keyboardDialogParts(id, lookup), [actionName], KEYBOARD_DIALOG_STRING_FALLBACKS[id]);
}

/**
 * The overwrite prompt (OpenOverwriteBindingDialog @ 00488bf0): one conflict →
 * OverwriteExistingBinding(KEY, ACTION); several → OverwriteExistingBindings
 * (KEY, one ID_ActionKeyMap_Binding(KEY, ACTION) line per conflict).
 */
export function keyboardOverwritePrompt(
  keyLabel: string, conflicts: ReadonlyArray<{ keyLabel: string; actionName: string }>,
  lookup?: (id: number) => string[] | null,
): string {
  const S = KEYBOARD_DIALOG_STRINGS;
  if (conflicts.length === 1) {
    return fillDatParts(keyboardDialogParts(S.overwriteExistingBinding, lookup), [keyLabel, conflicts[0].actionName], KEYBOARD_DIALOG_STRING_FALLBACKS[S.overwriteExistingBinding]);
  }
  const lines = conflicts
    .map((c) => fillDatParts(keyboardDialogParts(S.binding, lookup), [c.keyLabel, c.actionName], KEYBOARD_DIALOG_STRING_FALLBACKS[S.binding]))
    .join('\n');
  return fillDatParts(keyboardDialogParts(S.overwriteExistingBindings, lookup), [keyLabel, lines], KEYBOARD_DIALOG_STRING_FALLBACKS[S.overwriteExistingBindings]);
}

/**
 * The Options panel's "Key Bindings" reference block (FAITHFUL.434): a fixed
 * set of commands with their CURRENT Mapping 1 label, so the list can never
 * drift from the live registry again (CORE.17.k.b.b.a.g.f — the previous
 * hand-written list carried our invented I / B / M / P / O / Q / Tab keys).
 */
export const OPTIONS_KEYBIND_ROWS: ReadonlyArray<{ label: string; id: number }> = [
  { label: 'Move Forward', id: 0x29 }, { label: 'Move Backward', id: 0x2a }, { label: 'Stop Moving', id: 0x2b },
  { label: 'Turn Left', id: 0x2f }, { label: 'Turn Right', id: 0x2e },
  { label: 'Strafe Left', id: 0x2d }, { label: 'Strafe Right', id: 0x2c },
  { label: 'Jump', id: 0x31 }, { label: 'Autorun', id: 0x30 }, { label: 'Toggle Run/Walk', id: 0x32 },
  { label: 'Toggle Combat Mode', id: 0x1000005a },
  { label: 'Cast Spell', id: 0x10000060 },
  { label: 'Examine Selected', id: 0x1000002b }, { label: 'Use Selected', id: 0x10000025 },
  { label: 'Select Last Attacker', id: 0x10000038 },
  { label: 'Inventory', id: 0x10000019 }, { label: 'Attributes', id: 0x10000014 }, { label: 'Skills', id: 0x10000015 },
  { label: 'Spellbook', id: 0x10000011 }, { label: 'Allegiance', id: 0x1000000e }, { label: 'Fellowship', id: 0x1000000f },
  { label: 'World / Map', id: 0x10000016 }, { label: 'Options', id: 0x1000001a }, { label: 'Help', id: 0x7b },
  { label: 'Begin Chat', id: 0x10000023 },
];

export function optionsKeyBindingRows(registry: KeybindRegistry): Array<[string, string]> {
  return OPTIONS_KEYBIND_ROWS.map(({ label, id }) => [label, codeToLabel(registry.getMappings(id)[0]) || '—']);
}

/** The six tabs, in layout-strip order, with their string ids and command counts. */
export function keyboardTabs(
  registry: KeybindRegistry, hidden: ReadonlySet<number> = HIDDEN_DEAD_END_ACTIONS,
): { cls: ActionClass; label: string; stringId: number; count: number }[] {
  return KEYBIND_TAB_ORDER.map((t) => ({
    ...t,
    count: registry.actionsForClass(t.cls).filter((a) => !hidden.has(a.id)).length,
  }));
}
