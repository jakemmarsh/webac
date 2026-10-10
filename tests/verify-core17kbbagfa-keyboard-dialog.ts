/**
 * CORE.17.k.b.b.a.g.f.a — the Keyboard Config dialog's list (layout
 * 0x21000009) as gmKeyboardUI builds it: every command behind the DAT
 * scrollbar, grouped under one header row per input map in ActionMap order,
 * the Mapping buttons labelled the retail way (CInputManager_WIN32::
 * GetNameFromKey @ 00687f40 — the language DAT's DIK-name overrides, else
 * the Windows key name, metas as their left key, joined with
 * ID_KeyDescDelimiter "+"), the MapInstructions capture dialog and the
 * overwrite prompt (UIOption_ActionKeyMap::KeyHitHandler @ 00489570 /
 * OpenOverwriteBindingDialog @ 00488bf0).
 *
 * Pure model + registry tests always run; the DAT-gated block pins the
 * string ids / geometry / ActionMap order against the real files; the
 * happy-dom block drives the shipped GameUI dialog.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { KeybindRegistry, codeToLabel } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ActionClass } from '../packages/renderer/src/input/KeybindActionClass.js';
import { ACT, DEFAULT_KEYBINDS, INPUT_MAP } from '../packages/renderer/src/input/KeybindDefaults.js';
import { KEYBIND_ACTIONS, KEYBIND_ACTION_ROWS } from '../packages/renderer/src/input/KeybindActions.generated.js';
import { RETAIL_SECTION_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.generated.js';
import {
  retailKeyLabel, keyDisplayName, DIK_DISPLAY_NAMES, DAT_KEY_NAME_OVERRIDES, CODE_TO_DIK,
  KEY_DESC_DELIMITER, KEY_DESC_DELIMITER_STRING_ID,
} from '../packages/renderer/src/input/KeyNames.js';
import { DIK_TO_CODE } from '../packages/renderer/src/input/DirectInputKeys.js';
import {
  buildKeyboardSections, buildKeyboardRows, fillDatParts, keyboardButtonLabel, keyboardButtonTooltip,
  keyboardMapInstructions, keyboardOverwritePrompt, keyboardInputMapHeader,
  KEYBOARD_DIALOG_STRINGS, KEYBOARD_DIALOG_STRING_FALLBACKS, KEYBOARD_INPUT_MAP_HEADERS,
} from '../packages/renderer/src/ui/KeyboardConfigModel.js';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const DECOMP = resolve(REPO, 'reference/client-eol/decomp/acclient-decompiled.c');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);
const hasDecomp = fs.existsSync(DECOMP);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const;

/* ── the retail key names ──────────────────────────────────────────── */

describe('KeyNames — GetNameFromKey @ 00687f40 over the Windows key names + the DAT overrides', () => {
  it('names the printable keys as their character and the navigation cluster spelled out', () => {
    expect(retailKeyLabel('KeyW')).toBe('W');
    expect(retailKeyLabel('Digit1')).toBe('1');
    expect(retailKeyLabel('Backquote')).toBe('`');
    expect(retailKeyLabel('Minus')).toBe('-');
    expect(retailKeyLabel('BracketLeft')).toBe('[');
    expect(retailKeyLabel('ArrowUp')).toBe('Up');
    expect(retailKeyLabel('PageUp')).toBe('Page Up');
    expect(retailKeyLabel('PageDown')).toBe('Page Down');
    expect(retailKeyLabel('Insert')).toBe('Insert');
    expect(retailKeyLabel('Delete')).toBe('Delete');
    expect(retailKeyLabel('Home')).toBe('Home');
    expect(retailKeyLabel('End')).toBe('End');
    expect(retailKeyLabel('Escape')).toBe('Esc');
    expect(retailKeyLabel('Backspace')).toBe('Backspace');
    expect(retailKeyLabel('Enter')).toBe('Enter');
    expect(retailKeyLabel('Space')).toBe('Space');
    expect(retailKeyLabel('CapsLock')).toBe('Caps Lock');
    expect(retailKeyLabel('F12')).toBe('F12');
  });

  it('names the numpad "Num <key>" (DIK_NUMPAD1 → "Num 1", DIK_SUBTRACT → "Num -", DIK_DECIMAL → "Num Del")', () => {
    expect(retailKeyLabel('Numpad1')).toBe('Num 1');
    expect(retailKeyLabel('NumpadSubtract')).toBe('Num -');
    expect(retailKeyLabel('NumpadAdd')).toBe('Num +');
    expect(retailKeyLabel('NumpadDecimal')).toBe('Num Del');
    expect(retailKeyLabel('NumpadEnter')).toBe('Num Enter');
    expect(retailKeyLabel('NumpadMultiply')).toBe('Num *');
    expect(retailKeyLabel('NumpadDivide')).toBe('Num /');
  });

  it('names the left metas per the language DAT (Left Ctrl / Left Alt / Windows) and Shift per DirectInput', () => {
    expect(retailKeyLabel('ShiftLeft')).toBe('Shift');
    expect(retailKeyLabel('ShiftRight')).toBe('Right Shift');
    expect(retailKeyLabel('ControlLeft')).toBe('Left Ctrl');
    expect(retailKeyLabel('ControlRight')).toBe('Right Ctrl');
    expect(retailKeyLabel('AltLeft')).toBe('Left Alt');
    expect(retailKeyLabel('AltRight')).toBe('Right Alt');
    expect(retailKeyLabel('MetaLeft')).toBe('Windows');
    for (const o of DAT_KEY_NAME_OVERRIDES) expect(DIK_DISPLAY_NAMES.get(o.dik)).toBe(o.name);
  });

  it('prefixes the metas in the bit walk order (Alt, Ctrl, Shift) as their left key, joined with "+"', () => {
    expect(retailKeyLabel('Alt+KeyA')).toBe('Left Alt+A');
    expect(retailKeyLabel('Shift+KeyA')).toBe('Shift+A');
    expect(retailKeyLabel('Ctrl+Shift+KeyM')).toBe('Left Ctrl+Shift+M');
    expect(retailKeyLabel('Ctrl+Alt+Shift+KeyW')).toBe('Left Alt+Left Ctrl+Shift+W');
    expect(retailKeyLabel('Alt+ArrowLeft')).toBe('Left Alt+Left');
    expect(retailKeyLabel('Ctrl+F1', ' + ')).toBe('Left Ctrl + F1');
    expect(KEY_DESC_DELIMITER).toBe('+');
  });

  it('yields "" for null / an unnamed key (GetNameFromKey\'s empty string → the button clears)', () => {
    expect(retailKeyLabel(null)).toBe('');
    expect(retailKeyLabel(undefined)).toBe('');
    expect(retailKeyLabel('NoSuchKey')).toBe('');
    expect(retailKeyLabel('Ctrl+NoSuchKey')).toBe('');
    expect(keyDisplayName('Unidentified')).toBe('');
  });

  it('names every DIK the browser can deliver (DIK_TO_CODE ⊆ DIK_DISPLAY_NAMES) and inverts the code table', () => {
    for (const [dik, code] of DIK_TO_CODE) {
      expect(DIK_DISPLAY_NAMES.get(dik), `DIK 0x${dik.toString(16)} (${code})`).toBeTruthy();
      expect(CODE_TO_DIK.get(code)).toBe(dik);
    }
  });

  it('codeToLabel is the retail label (one source for the dialog, the Options block and /help)', () => {
    expect(codeToLabel('PageUp')).toBe(retailKeyLabel('PageUp'));
    expect(codeToLabel('Alt+KeyD')).toBe('Left Alt+D');
    expect(codeToLabel(null)).toBe('');
  });
});

/* ── the registry's conflict view ──────────────────────────────────── */

describe('KeybindRegistry.conflictsFor — FindConflictingInputMaps + FindConflictingControls', () => {
  it('lists the co-active commands holding the key, never the command itself or a never-co-active map', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    // X = Move Backward (Movement 0x4); the UI map is co-active with Movement.
    const c = r.conflictsFor(ACT.ShowHideInventoryPanel, 'KeyX');
    expect(c).toEqual([{ id: ACT.MoveBackward, slot: 0, code: 'KeyX' }]);
    // "1" is Spell Slot 1 in the magic map and Quickslot 1 in the quickslot map — never live together.
    expect(r.conflictsFor(ACT.SpellSlot1, 'Digit1').map((x) => x.id)).not.toContain(0x10000042);
    // A command's own key is not a conflict with itself; a free key has none.
    expect(r.conflictsFor(ACT.MoveBackward, 'KeyX')).toEqual([]);
    expect(r.conflictsFor(ACT.MoveBackward, 'F14')).toEqual([]);
    expect(r.conflictsFor(ACT.MoveBackward, '')).toEqual([]);
  });

  it('setMapping after the prompt still steals the key (SetBinding @ 00487b20 UnbindByKey over the conflicting maps)', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.conflictsFor(ACT.Autorun, 'KeyW').length).toBe(1);
    r.setMapping(ACT.Autorun, 1, 'KeyW');
    expect(r.getMappings(ACT.MoveForward)).toEqual([null, 'ArrowUp', null]);
    expect(r.getMappings(ACT.Autorun)).toEqual(['KeyQ', 'KeyW', null]);
  });
});

/* ── the list model ────────────────────────────────────────────────── */

describe('buildKeyboardSections — InitOptions @ 004dd8b0: one header per input map, rows in ActionMap order', () => {
  it('the Movement tab is one section, "Movement", with the 14 movement commands in DAT order', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const s = buildKeyboardSections(r, ActionClass.Movement);
    expect(s.map((x) => x.map)).toEqual([INPUT_MAP.Movement]);
    expect(s[0].header).toBe('Movement');
    expect(s[0].headerStringId).toBe(36186499);
    expect(s[0].rows.length).toBe(14);
    expect(s[0].rows[0].name).toBe('Move Forward');
    expect(s[0].rows[1].name).toBe('Toggle Run/Walk');   // DAT order, not id order
    expect(s[0].rows[0].mappings).toEqual(['W', 'Up', '']);
    expect(s[0].rows[0].codes).toEqual(['KeyW', 'ArrowUp', null]);
    expect(s[0].rows.every((row) => row.editable)).toBe(true);
    expect(s[0].rows.find((row) => row.id === ACT.StrafeLeft)?.mappings).toEqual(['Z', 'Left Alt+A', 'Left Alt+Left']);
  });

  it('the Combat tab lists Combat, Melee Combat, Missile Combat and Magic Combat sections (32 rows)', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const s = buildKeyboardSections(r, ActionClass.Combat);
    expect(s.map((x) => x.header)).toEqual(['Combat', 'Melee Combat', 'Missile Combat', 'Magic Combat']);
    expect(s.map((x) => x.map)).toEqual([INPUT_MAP.CombatToggle, INPUT_MAP.Melee, INPUT_MAP.Missile, INPUT_MAP.Magic]);
    expect(s.reduce((n, x) => n + x.rows.length, 0)).toBe(32);
    expect(s[0].rows[0].name).toBe('Toggle Combat Mode');
    expect(s[0].rows[0].mappings[0]).toBe('`');
    expect(s[1].rows.map((row) => row.mappings[0])).toEqual(['Insert', 'Page Up', 'Delete', 'End', 'Page Down']);
    expect(s[3].rows[0].name).toBe('Cast Spell');
    expect(s[3].rows[0].mappings).toEqual(['End', '', '']);
  });

  it('the Camera tab shows the Camera section AND the read-only Alternate Camera Mode section from the DAT keys', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const s = buildKeyboardSections(r, ActionClass.Camera);
    expect(s.map((x) => x.header)).toEqual(['Camera', 'Alternate Camera Mode']);
    expect(s[0].rows.length).toBe(12);
    expect(s[0].rows.every((row) => row.editable)).toBe(true);
    expect(s[1].rows.length).toBe(10);
    expect(s[1].rows.every((row) => !row.editable)).toBe(true);
    const rot = s[1].rows.find((row) => row.name === 'Rotate Camera Left')!;
    expect(rot.codes).toEqual(['ArrowLeft', null, null]);
    expect(rot.mappings).toEqual(['Left', '', '']);
    expect(RETAIL_SECTION_KEYBINDS[INPUT_MAP.AltCamera][rot.id]).toEqual(['ArrowLeft']);
    // the same command under its own map keeps the registry's keys
    expect(s[0].rows.find((row) => row.id === rot.id)?.codes).toEqual(['Numpad4', null, null]);
  });

  it('the UI tab holds the 103 UI commands less the 3 hidden dead ends (HIDDEN_DEAD_END_ACTIONS) across its sections, with descriptions as tooltips', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const s = buildKeyboardSections(r, ActionClass.UI);
    const rows = s.flatMap((x) => x.rows);
    expect(rows.length).toBe(100);
    expect(new Set(rows.map((row) => row.id)).size).toBe(100);
    for (const id of [0x7b, 0x10000003, 0x1000000b]) expect(rows.some((row) => row.id === id)).toBe(false);
    expect(s.map((x) => x.header)).toEqual(['Chat', 'Toggle Chat Entry', 'Quickslots', 'Item Selection', 'UI']);
    expect(rows.find((row) => row.name === 'Show/Hide Inventory Panel')?.mappings[0]).toBe('F12');
    expect(rows.every((row) => typeof row.desc === 'string')).toBe(true);
    expect(rows.find((row) => row.name === 'Take Screenshot')?.desc).toMatch(/screenshot/i);
  });

  it('every (map, action) row of the generated table is a named user-bindable action, and every action is listed', () => {
    const named = new Set(KEYBIND_ACTIONS.map((a) => a.id));
    expect(KEYBIND_ACTION_ROWS.every((row) => named.has(row.id))).toBe(true);
    const listed = new Set(KEYBIND_ACTION_ROWS.map((row) => row.id));
    expect(KEYBIND_ACTIONS.every((a) => listed.has(a.id))).toBe(true);
    // the ten camera commands under the alternate map are the only duplicates
    expect(KEYBIND_ACTION_ROWS.length - named.size).toBe(10);
    expect(KEYBIND_ACTION_ROWS.filter((row) => row.map === INPUT_MAP.AltCamera).length).toBe(10);
    // every action has a description string
    expect(KEYBIND_ACTIONS.every((a) => a.desc.length > 0)).toBe(true);
  });

  it('a section for a map retail names is headed; the header table covers every map that carries rows', () => {
    for (const map of new Set(KEYBIND_ACTION_ROWS.map((row) => row.map))) {
      expect(keyboardInputMapHeader(map), `map 0x${map.toString(16)}`).not.toBeNull();
    }
    expect(keyboardInputMapHeader(0x1234)).toBeNull();
    expect(KEYBOARD_INPUT_MAP_HEADERS.find((h) => h.map === INPUT_MAP.Quickslots)?.label).toBe('Quickslots');
  });

  it('buildKeyboardRows (the flat per-class view) still lists one row per command with the retail labels', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const rows = buildKeyboardRows(r, ActionClass.Combat);
    expect(rows.length).toBe(32);
    expect(rows.find((x) => x.id === ACT.CastSpell)?.mappings).toEqual(['End', '', '']);
  });
});

/* ── the dialog strings ────────────────────────────────────────────── */

describe('the 0x23000004 dialog strings — filled the StringInfo way (parts around the variables)', () => {
  const F = KEYBOARD_DIALOG_STRING_FALLBACKS;
  const none = () => null;

  it('fillDatParts interleaves parts and values and never drops a value', () => {
    expect(fillDatParts(["'", "' is bound to '", "'."], ['X', 'Jump'], [])).toBe("'X' is bound to 'Jump'.");
    expect(fillDatParts(null, ['X'], ['<', '>'])).toBe('<X>');
    expect(fillDatParts(['only'], ['X'], [])).toBe('onlyX');
    expect(fillDatParts([], [], ['fallback'])).toBe('fallback');
  });

  it('ButtonLabel is the bare label; the tooltips are TT_ExistingBinding / TT_NewBinding', () => {
    expect(keyboardButtonLabel('Page Up', none)).toBe('Page Up');
    expect(keyboardButtonLabel('', none)).toBe('');
    expect(keyboardButtonTooltip('Page Up', none)).toBe("('Page Up') Left-Click to change this binding. Right-click to remove it.");
    expect(keyboardButtonTooltip('', none)).toBe('Left-Click to add a binding for this action.');
  });

  it('MapInstructions wraps the command name; the overwrite prompt has the single and the list form', () => {
    expect(keyboardMapInstructions('Jump', none)).toBe(`${F[KEYBOARD_DIALOG_STRINGS.mapInstructions][0]}Jump${F[KEYBOARD_DIALOG_STRINGS.mapInstructions][1]}`);
    expect(keyboardMapInstructions('Jump', none)).toContain('Press the ESC key to cancel.');
    expect(keyboardOverwritePrompt('X', [{ keyLabel: 'X', actionName: 'Move Backward' }], none))
      .toBe("'X' is currently bound to 'Move Backward'. Do you wish to erase that binding?");
    expect(keyboardOverwritePrompt('F1', [{ keyLabel: 'F1', actionName: 'Open Help' }, { keyLabel: 'F1', actionName: 'Jump' }], none))
      .toBe("'F1' conflicts with the following bindings:\n'F1' ('Open Help')\n'F1' ('Jump')\nDo you wish to erase those bindings?");
  });

  it('a DAT lookup wins over the English fallback', () => {
    const lookup = (id: number) => (id === KEYBOARD_DIALOG_STRINGS.ttNewBinding ? ['Klicken.'] : null);
    expect(keyboardButtonTooltip('', lookup)).toBe('Klicken.');
    expect(keyboardButtonTooltip('W', lookup)).toBe("('W') Left-Click to change this binding. Right-click to remove it.");
  });
});

/* ── the DAT ground truth ──────────────────────────────────────────── */

describe.skipIf(!hasDats)('the language + portal DATs — the dialog strings, the layout, the ActionMap order', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dp: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lang: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let portal: any;
  const open = (p: string) => {
    const b = fs.readFileSync(p);
    return new dp.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 0);
  };
  beforeAll(async () => {
    dp = await import('../packages/dat-parser/src/index.js');
    lang = open(LANG_PATH);
    portal = open(PORTAL_PATH);
    for (const tid of lang.listFileIds(0x23)) {
      try { dp.registerStringTable(dp.parseStringTable(new dp.DatReader(lang.getFileData(tid)))); } catch { /* skip */ }
    }
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new dp.DatReader(portal.getFileData(0x39000001))));
  });

  it('the dialog string ids are compute_str_hash of their tokens and resolve to the English fallbacks', () => {
    const S = KEYBOARD_DIALOG_STRINGS;
    const tokens: Record<number, string> = {
      [S.buttonLabel]: 'ID_ActionKeyMap_ButtonLabel',
      [S.ttExistingBinding]: 'ID_ActionKeyMap_TT_ExistingBinding',
      [S.ttNewBinding]: 'ID_ActionKeyMap_TT_NewBinding',
      [S.mapInstructions]: 'ID_ActionKeyMap_MapInstructions',
      [S.overwriteExistingBinding]: 'ID_ActionKeyMap_OverwriteExistingBinding',
      [S.overwriteExistingBindings]: 'ID_ActionKeyMap_OverwriteExistingBindings',
      [S.binding]: 'ID_ActionKeyMap_Binding',
      [S.nonUserBindableBinding]: 'ID_ActionKeyMap_NonUserBindableBinding',
    };
    for (const [idStr, token] of Object.entries(tokens)) {
      const id = Number(idStr);
      expect(dp.acStringHash(token), token).toBe(id);
      expect(dp.getStringPartsFromTable(0x23000004, id), token).toEqual(KEYBOARD_DIALOG_STRING_FALLBACKS[id]);
    }
    expect(dp.acStringHash('ID_KeyDescDelimiter')).toBe(KEY_DESC_DELIMITER_STRING_ID);
    expect(dp.getStringFromTable(0x23000007, KEY_DESC_DELIMITER_STRING_ID)).toBe(KEY_DESC_DELIMITER);
  });

  it('the language DAT overrides exactly the four meta key names (the DIK-name hash lookup GetNameFromKey_Internal makes)', () => {
    for (const o of DAT_KEY_NAME_OVERRIDES) {
      expect(dp.acStringHash(o.dikName)).toBe(o.stringId);
      expect(dp.getString(o.stringId)).toBe(o.name);
    }
    // no other DIK the browser delivers has a string-table entry
    const names = new Map<number, string>([[0x1d, 'DIK_LCONTROL'], [0x38, 'DIK_LMENU'], [0xdb, 'DIK_LWIN'], [0xdc, 'DIK_RWIN']]);
    let others = 0;
    for (const dik of DIK_TO_CODE.keys()) {
      if (names.has(dik)) continue;
      // the registered name is DIK_<token>; every one in LoadSemantics @ 0068b820 hashes like this
      const token = `DIK_${DIK_DISPLAY_NAMES.get(dik)}`;
      if (dp.getString(dp.acStringHash(token)) !== null) others++;
    }
    expect(others).toBe(0);
  });

  it('the input-map header ids are the hashed ID_InputMap_* tokens in 0x23000005 with the recorded English', () => {
    for (const h of KEYBOARD_INPUT_MAP_HEADERS) {
      expect(dp.acStringHash(h.token), h.token).toBe(h.stringId);
      expect(dp.getStringFromTable(0x23000005, h.stringId), h.token).toBe(h.label);
    }
  });

  it('layout 0x21000009: the list template 0x100004a7 (headers 170/100 wide at 0/270/370/470, list 570x345 at y 18, scrollbar 16 wide at x 570, 40 px row templates with 100x32 buttons)', () => {
    const layout = dp.parseLayoutDesc(new dp.DatReader(lang.getFileData(0x21000009)));
    const find = (id: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walk = (el: any): any => { if (el.elementId === id) return el; for (const [, c] of el.children) { const f = walk(c); if (f) return f; } return null; };
      for (const [, e] of layout.elements) { const f = walk(e); if (f) return f; }
      return null;
    };
    const tpl = find(0x100004a7);
    expect([tpl.width, tpl.height]).toEqual([586, 363]);
    for (const [id, x, w] of [[0x10000021, 0, 170], [0x10000022, 270, 100], [0x10000023, 370, 100], [0x10000024, 470, 100]]) {
      const e = find(id);
      expect([e.x, e.y, e.width, e.height], `0x${id.toString(16)}`).toEqual([x, 0, w, 18]);
    }
    const list = find(0x10000025);
    expect([list.x, list.y, list.width, list.height, list.type]).toEqual([0, 18, 570, 345, 5]);
    const templates = list.properties.get(100).valueArray.map((s: any) => s.valueStruct.get(98).valueEnum);
    expect(templates).toEqual([0x1000002e, 0x1000002f]);
    expect(list.properties.get(114).valueEnum).toBe(0x10000026);
    const bar = find(0x10000026);
    expect([bar.x, bar.y, bar.width, bar.height]).toEqual([570, 18, 16, 345]);
    expect(bar.properties.get(130).valueBool).toBe(true);
    const header = find(0x1000002e);
    expect([header.width, header.height, header.properties.get(35).valueInt]).toEqual([570, 40, 5]);
    const row = find(0x1000002f);
    expect([row.width, row.height, row.properties.get(35).valueInt]).toEqual([570, 40, 10]);
    expect(row.properties.get(26).valueArray[0].valueDataFile).toBe(0x4000000a);
    for (let i = 0; i < 3; i++) {
      const b = find(0x10000030 + i);
      expect([b.x, b.y, b.width, b.height], `button ${i}`).toEqual([270 + 100 * i, 0, 100, 32]);
      expect(b.baseElement).toBe(0x100002cd);   // the 0x21000040 dialog button art
      expect([b.topEdge, b.bottomEdge], `button ${i} edges`).toEqual([3, 3]);
    }
    // LAYOUT.attach-time-center-anchors — once attached (SetParent →
    // UpdateForParentSizeChange) the T3/B3 buttons sit centred in the row.
    const attached = dp.resolveLayoutDesc(layout, (id: number) => dp.parseLayoutDesc(new dp.DatReader(lang.getFileData(id))));
    dp.applyAttachTimeAnchors(attached);
    const attachedRow = attached.elements.get(0x1000002f) ?? [...attached.elements.values()].find((e) => e.elementId === 0x1000002f);
    for (let i = 0; i < 3; i++) {
      const b = attachedRow.children.get(0x10000030 + i) ?? [...attachedRow.children.values()].find((c: { elementId: number }) => c.elementId === 0x10000030 + i);
      expect([b.x, b.y, b.width, b.height], `attached button ${i}`).toEqual([270 + 100 * i, 4, 100, 32]);
    }
    // the tabs' base 0x100004a6 carries neither media nor states OF ITS OWN —
    // CORE.17.k.b.b.c.a: it is a 0x2100004d:0x1000043a instance, so the
    // resolved tabs inherit the 0xb / 0xc states (tests/verify-core17kbbca-
    // tab-states.ts); the raw template is empty:
    const tabBase = find(0x100004a6);
    expect(tabBase.media.length).toBe(0);
    expect(tabBase.states.size).toBe(0);
    expect(tabBase.properties.size).toBe(0);
  });

  it('the generated (map, action) rows are the ActionMap walk: every input map in file order, every named class 1-7 action in it', () => {
    const am = dp.ActionMap.read(new dp.DatReader(portal.getFileData(0x26000000)));
    const expected: Array<{ map: number; id: number }> = [];
    for (const [map, vals] of am.inputMaps) {
      for (const [id, v] of vals) {
        const cls = v.userBindingData.actionClass;
        if (![1, 2, 3, 4, 5, 7].includes(cls)) continue;
        const name = dp.getString(v.userBindingData.actionNameHash);
        if (!name || name.startsWith('#')) continue;
        expected.push({ map, id });
      }
    }
    expect(KEYBIND_ACTION_ROWS).toEqual(expected);
    // and the descriptions are the ActionMap's UserBindingValue.descriptionHash strings
    const [firstMap] = [...am.inputMaps.entries()].filter(([, vals]) => vals.size > 0 && [...vals.values()][0].userBindingData.actionClass === 1);
    const [id, v] = [...firstMap[1].entries()][0];
    expect(KEYBIND_ACTIONS.find((a) => a.id === id)?.desc).toBe(dp.getString(v.userBindingData.descriptionHash));
  });
});

describe.skipIf(!hasDecomp)('decompiled client pins — the functions the port follows', () => {
  let src = '';
  beforeAll(() => { src = fs.readFileSync(DECOMP, 'utf8'); });
  const fn = (name: string) => src.indexOf(`// ===== ${name} =====`);
  it('names the row / label / capture / prompt functions', () => {
    for (const name of [
      'UIOption_ActionKeyMap::Refresh @ 00487280', 'UIOption_ActionKeyMap::InitiateBinding @ 004899d0',
      'UIOption_ActionKeyMap::KeyHitHandler @ 00489570', 'UIOption_ActionKeyMap::SetBinding @ 00487b20',
      'UIOption_ActionKeyMap::EraseBinding @ 00487780', 'UIOption_ActionKeyMap::OpenOverwriteBindingDialog @ 00488bf0',
      'UIOption_ActionKeyMap::ListenToElementMessage @ 00489a80', 'gmKeyboardUI::InitOptions @ 004dd8b0',
      'gmKeyboardUI::GetStringInfoFromInputMapID @ 004da980', 'CInputManager_WIN32::GetNameFromKey @ 00687f40',
      'CInputManager_WIN32::GetNameFromKey_Internal @ 00687800', 'CMasterInputMap::KeyFromMetaMode @ 0068d890',
      'UIElement_GroupBox::OnSetAttribute @ 0046aca0',
    ]) expect(fn(name), name).toBeGreaterThan(-1);
  });
  it('Refresh builds ID_ActionKeyMap_ButtonLabel with LABEL and the TT_ExistingBinding / TT_NewBinding tooltips; InitiateBinding the MapInstructions text', () => {
    const refresh = src.slice(fn('UIOption_ActionKeyMap::Refresh @ 00487280'), fn('UIOption_ActionKeyMap::Refresh @ 00487280') + 12000);
    expect(refresh).toContain('ID_ActionKeyMap_ButtonLabel,0x10000004');
    expect(refresh).toContain('AddVariable_String((StringInfo *)&SStack_90,LABEL,');
    expect(refresh).toContain('ID_ActionKeyMap_TT_ExistingBinding,0x10000004');
    expect(refresh).toContain('ID_ActionKeyMap_TT_NewBinding,0x10000004');
    const init = src.slice(fn('UIOption_ActionKeyMap::InitiateBinding @ 004899d0'), fn('UIOption_ActionKeyMap::InitiateBinding @ 004899d0') + 3000);
    expect(init).toContain('compute_str_hash("ID_ActionKeyMap_MapInstructions")');
    expect(init).toContain('OpenMapWarnDialog(this,');
  });
  it('the input-map headers come from the ID_InputMap_* tokens; the group box selects with SetState(6)', () => {
    const g = src.slice(fn('gmKeyboardUI::GetStringInfoFromInputMapID @ 004da980'), fn('gmKeyboardUI::GetStringInfoFromInputMapID @ 004da980') + 4000);
    for (const h of KEYBOARD_INPUT_MAP_HEADERS) expect(g).toContain(`"${h.token}"`);
    const gb = src.slice(fn('UIElement_GroupBox::OnSetAttribute @ 0046aca0'), fn('UIElement_GroupBox::OnSetAttribute @ 0046aca0') + 1500);
    expect(gb).toContain('(**(code **)(pUVar2->_padding_ + 0x9c))(6);');
  });
});

/* ── the shipped dialog through happy-dom ──────────────────────────── */

describe('GameUI — the dialog list scrolls, labels, captures and prompts', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let registry: KeybindRegistry;
  let confirmations: Array<{ text: string; respond: (b: boolean) => void }> = [];
  const ROW_H = 40;

  /** A stand-in LayoutRenderer handle: the six tab buttons + six content areas + the bottom buttons. */
  const fakeHandle = () => {
    const mk = (): HTMLElement => { const e = domWindow.document.createElement('div') as HTMLElement; e.style.position = 'relative'; return e; };
    const root = mk();
    domWindow.document.body.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const ids = [0x1000049c, 0x1000049d, 0x1000049e, 0x1000049f, 0x100004a0, 0x100004a1, 0x100004a2, 0x100004a3, 0x1000020e, 0x10000211, 0x100004a4, 0x100004a5,
      0x10000027, 0x10000029, 0x1000002a, 0x1000002b, 0x1000002c, 0x1000002d, 0x100004a6, 0x100004a7, 0x1000002e, 0x1000002f];
    for (const id of ids) { const e = mk(); elements.set(id, e); root.appendChild(e); }
    const clicks = new Map<number, () => void>();
    return {
      root, elements, clicks,
      onClick: (id: number, fn: () => void) => { clicks.set(id, fn); },
      setVisible: (id: number, v: boolean) => { const e = elements.get(id); if (e) e.style.display = v ? '' : 'none'; },
      setState: () => {}, setText: () => {},
      close: () => { root.remove(); },
    };
  };

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') { (g as any).requestAnimationFrame = () => 0; (g as any).cancelAnimationFrame = () => {}; }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.playUISound = () => {};
    ui.getTexURL = () => null;
    ui.texBgStyle = () => ({});
    registry = new KeybindRegistry(DEFAULT_KEYBINDS);
    ui.keybindRegistry = registry;
    ui.showConfirmationDialog = (text: string, respond: (b: boolean) => void) => { confirmations.push({ text, respond }); };
    // the LayoutRenderer is absent in the DOM harness: stand in for renderPanel;
    // render() finds no layout (the DialogFactory dialogs take their fallback plate)
    ui.layoutRenderer = { renderPanel: () => fakeHandle(), getResolvedLayout: () => null, render: () => null };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const open = (cls: ActionClass): HTMLElement => {
    if (ui.keyboardConfigVisible) ui.closeKeyboardConfigPanel(false);
    confirmations = [];
    ui.keyboardConfigTab = cls;
    ui.toggleKeyboardConfigPanel();
    return ui.keyboardListViewport as HTMLElement;
  };
  const rows = (vp: HTMLElement) => Array.from(vp.querySelectorAll('[data-keybind-row]')) as HTMLElement[];
  const button = (vp: HTMLElement, name: string, slot: number): HTMLElement =>
    rows(vp).find((r) => r.dataset.keybindRow === name)!.querySelector(`[data-keybind-slot="${slot}"]`) as HTMLElement;
  const press = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, key = code): void => {
    const ev = new domWindow.KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...mods });
    domWindow.document.dispatchEvent(ev);
  };

  it('the UI tab lists its 100 shown commands in a 345 px viewport whose paper is the stacked 40 px rows plus the headers', () => {
    const vp = open(ActionClass.UI);
    expect(vp.dataset.keybindList).toBe('10000025');
    expect(vp.style.height).toBe('345px');
    expect(rows(vp).length).toBe(100);
    const headers = Array.from(vp.querySelectorAll('[data-keybind-section]')) as HTMLElement[];
    expect(headers.length).toBe(5);
    const sheet = vp.firstElementChild as HTMLElement;
    expect(sheet.style.height).toBe(`${(100 + 5) * ROW_H}px`);
    // every row sits at a 40 px pitch, the buttons at x 270 / 370 / 470
    const last = rows(vp)[99];
    expect(last.style.top).toBe(`${(100 + 5 - 1) * ROW_H}px`);
    expect(last.style.height).toBe(`${ROW_H}px`);
    expect((button(vp, 'Take Screenshot', 0)).style.left).toBe('270px');
    expect((button(vp, 'Take Screenshot', 2)).style.left).toBe('470px');
    expect((button(vp, 'Take Screenshot', 0)).style.width).toBe('100px');
    // T3/B3 centre the 32-tall button in the 40-tall row (SetParent's
    // UpdateForParentSizeChange): y 4, not the DAT's authored 0.
    expect((button(vp, 'Take Screenshot', 1)).style.top).toBe('4px');
    // the scrollbar column sits at (570,18) 16x345 like 0x10000026
    const bar = ui.keyboardConfigHandle.elements.get(0x100004a3).querySelector('[data-keybind-scrollbar]') as HTMLElement;
    expect([bar.style.left, bar.style.top, bar.style.width, bar.style.height]).toEqual(['570px', '18px', '16px', '345px']);
  });

  it('the wheel scrolls the viewport by a row; the Combat tab reaches Spell Slot 12 (32 rows)', () => {
    const vp = open(ActionClass.Combat);
    expect(rows(vp).length).toBe(32);
    expect(rows(vp)[31].dataset.keybindRow).toBe('Spell Slot 12');
    Object.defineProperty(vp, 'scrollHeight', { value: (32 + 4) * ROW_H, configurable: true });
    Object.defineProperty(vp, 'clientHeight', { value: 345, configurable: true });
    const wheel = new domWindow.Event('wheel', { bubbles: true, cancelable: true }) as Event & { deltaY: number };
    Object.defineProperty(wheel, 'deltaY', { value: 100 });
    vp.dispatchEvent(wheel);
    expect(vp.scrollTop).toBe(ROW_H);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it('the Mapping buttons read the retail labels and carry the retail tooltips', () => {
    const vp = open(ActionClass.Combat);
    const cast = button(vp, 'Cast Spell', 0);
    expect(cast.dataset.keybindLabel).toBe('End');
    expect(cast.dataset.keybindCode).toBe('End');
    expect(cast.dataset.acTooltipText).toBe("('End') Left-Click to change this binding. Right-click to remove it.");
    const empty = button(vp, 'Cast Spell', 1);
    expect(empty.dataset.keybindLabel).toBe('');
    expect(empty.dataset.acTooltipText).toBe('Left-Click to add a binding for this action.');
    expect(button(vp, 'Increase Power', 0).dataset.keybindLabel).toBe('Page Up');
    expect(button(vp, 'Toggle Combat Mode', 0).dataset.keybindLabel).toBe('`');
    const mv = open(ActionClass.Movement);
    expect(button(mv, 'Strafe Left', 1).dataset.keybindLabel).toBe('Left Alt+A');
    // the row tooltip is the ActionMap description
    expect(rows(mv)[0].dataset.acTooltipText).toBe('Step forward.');
    // the tabs are plain labels: no invented background / border
    const tab = ui.keyboardConfigHandle.elements.get(0x1000049c) as HTMLElement;
    expect(tab.style.background).toBe('');
    expect(tab.style.border).toBe('');
    expect(tab.dataset.keybindTabSelected).toBe('1');
  });

  it('a click opens the MapInstructions dialog naming the command; ESC closes it and binds nothing', () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Jump', 1).click();
    const dlg = domWindow.document.getElementById('ac-keyboard-map-dialog') as HTMLElement;
    expect(dlg).not.toBeNull();
    const text = dlg.querySelector('.ac-keyboard-map-dialog-text') as HTMLElement;
    expect(text.textContent ?? dlg.textContent).toContain("mapped to the 'Jump' action");
    expect(ui.keyboardCapture).toEqual({ id: ACT.Jump, slot: 1, name: 'Jump' });
    press('Escape', {}, 'Escape');
    expect(domWindow.document.getElementById('ac-keyboard-map-dialog')).toBeNull();
    expect(ui.keyboardCapture).toBeNull();
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', null, null]);
  });

  it('a free key binds at once into the clicked slot; a bare modifier press waits for the real key', () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Jump', 1).click();
    press('ShiftLeft', { shiftKey: true }, 'Shift');
    expect(ui.keyboardCapture).not.toBeNull();
    press('KeyJ', { shiftKey: true }, 'J');
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', 'Shift+KeyJ', null]);
    expect(domWindow.document.getElementById('ac-keyboard-map-dialog')).toBeNull();
    expect(confirmations.length).toBe(0);
    expect(button(ui.keyboardListViewport, 'Jump', 1).dataset.keybindLabel).toBe('Shift+J');
    registry.setMapping(ACT.Jump, 1, null);
  });

  it('a key another co-active command holds raises the OverwriteExistingBinding prompt: Yes steals it, No leaves both', () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Autorun', 1).click();
    press('KeyW', {}, 'w');
    expect(confirmations.length).toBe(1);
    expect(confirmations[0].text).toBe("'W' is currently bound to 'Move Forward'. Do you wish to erase that binding?");
    expect(registry.getMappings(ACT.Autorun)).toEqual(['KeyQ', null, null]);
    confirmations[0].respond(false);
    expect(registry.getMappings(ACT.MoveForward)).toEqual(['KeyW', 'ArrowUp', null]);
    expect(registry.getMappings(ACT.Autorun)).toEqual(['KeyQ', null, null]);
    button(ui.keyboardListViewport, 'Autorun', 1).click();
    press('KeyW', {}, 'w');
    confirmations[1].respond(true);
    expect(registry.getMappings(ACT.MoveForward)).toEqual([null, 'ArrowUp', null]);
    expect(registry.getMappings(ACT.Autorun)).toEqual(['KeyQ', 'KeyW', null]);
    expect(button(ui.keyboardListViewport, 'Move Forward', 0).dataset.keybindLabel).toBe('');
    registry.resetToDefaults();
  });

  it('a key the row already lists is a no-op; a right-click erases a bound button without a prompt', () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Move Forward', 2).click();
    press('KeyW', {}, 'w');
    expect(confirmations.length).toBe(0);
    expect(registry.getMappings(ACT.MoveForward)).toEqual(['KeyW', 'ArrowUp', null]);
    const up = button(ui.keyboardListViewport, 'Move Forward', 1);
    up.dispatchEvent(new domWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(registry.getMappings(ACT.MoveForward)).toEqual(['KeyW', null, null]);
    // an empty button's right-click does nothing
    button(ui.keyboardListViewport, 'Move Forward', 2).dispatchEvent(new domWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(registry.getMappings(ACT.MoveForward)).toEqual(['KeyW', null, null]);
    registry.resetToDefaults();
  });

  it('the Alternate Camera Mode rows show the DAT keys read-only (no capture on click)', () => {
    const vp = open(ActionClass.Camera);
    const alt = rows(vp).filter((r) => r.dataset.keybindReadonly === '1');
    expect(alt.length).toBe(10);
    const rot = alt.find((r) => r.dataset.keybindRow === 'Rotate Camera Left')!;
    expect((rot.querySelector('[data-keybind-slot="0"]') as HTMLElement).dataset.keybindLabel).toBe('Left');
    (rot.querySelector('[data-keybind-slot="0"]') as HTMLElement).click();
    expect(ui.keyboardCapture).toBeNull();
    expect(domWindow.document.getElementById('ac-keyboard-map-dialog')).toBeNull();
    ui.closeKeyboardConfigPanel(false);
  });

  /* RECON.keyboard-dialog — KeyHitHandler @ 00489570 takes the mouse too. */
  const mouse = (type: string, b: number, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, target?: HTMLElement): MouseEvent => {
    const ev = new domWindow.MouseEvent(type, { button: b, bubbles: true, cancelable: true, ...mods });
    (target ?? domWindow.document.body).dispatchEvent(ev);
    return ev;
  };

  it('Toggle Mouselook shows the DAT DefaultMap middle button as "Button 2"', () => {
    const vp = open(ActionClass.Camera);
    const look = button(vp, 'Toggle Mouselook', 0);
    expect(look.dataset.keybindCode).toBe('MouseButton2');
    expect(look.dataset.keybindLabel).toBe('Button 2');
    expect(look.dataset.acTooltipText).toBe("('Button 2') Left-Click to change this binding. Right-click to remove it.");
    ui.closeKeyboardConfigPanel(false);
  });

  it('a bare left click does not bind (the dialog stays up); a right click binds Button 1 and its context menu cannot erase it', async () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Jump', 1).click();
    mouse('mousedown', 0);
    expect(ui.keyboardCapture).not.toBeNull();
    expect(domWindow.document.getElementById('ac-keyboard-map-dialog')).not.toBeNull();
    const down = mouse('mousedown', 2);
    expect(down.defaultPrevented).toBe(true);
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', 'MouseButton1', null]);
    expect(domWindow.document.getElementById('ac-keyboard-map-dialog')).toBeNull();
    // the press's release + context menu land on the (re-rendered) Mapping button: swallowed
    const target = button(ui.keyboardListViewport, 'Jump', 1);
    expect(target.dataset.keybindLabel).toBe('Button 1');
    mouse('mouseup', 2, {}, target);
    const menu = mouse('contextmenu', 2, {}, target);
    expect(menu.defaultPrevented).toBe(true);
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', 'MouseButton1', null]);
    await new Promise((r) => setTimeout(r, 0));
    // after the swallowed press, a right-click erases as before
    mouse('contextmenu', 2, {}, button(ui.keyboardListViewport, 'Jump', 1));
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', null, null]);
    registry.resetToDefaults();
  });

  it('a meta-qualified left click binds ("Left Ctrl+Button 0"); a wheel notch binds its sub-control', async () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Jump', 2).click();
    mouse('mousedown', 0, { ctrlKey: true });
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', null, 'Ctrl+MouseButton0']);
    expect(button(ui.keyboardListViewport, 'Jump', 2).dataset.keybindLabel).toBe('Left Ctrl+Button 0');
    mouse('mouseup', 0);
    // the bound press's click is swallowed until one task after its release
    button(ui.keyboardListViewport, 'Jump', 1).click();
    expect(ui.keyboardCapture).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    button(ui.keyboardListViewport, 'Jump', 1).click();
    expect(ui.keyboardCapture).not.toBeNull();
    const wheel = new domWindow.Event('wheel', { bubbles: true, cancelable: true }) as Event & { deltaY: number };
    Object.defineProperty(wheel, 'deltaY', { value: 100 });
    domWindow.document.body.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    // Wheel Down already zooms out (the browser-UX binding): the overwrite prompt names it
    expect(confirmations.map((c) => c.text)).toEqual(["'Wheel Down' is currently bound to 'Zoom Camera Out'. Do you wish to erase that binding?"]);
    confirmations[0].respond(true);
    expect(registry.getMappings(ACT.ZoomCameraOut)).not.toContain('MouseWheelDown');
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', 'MouseWheelDown', 'Ctrl+MouseButton0']);
    expect(button(ui.keyboardListViewport, 'Jump', 1).dataset.keybindLabel).toBe('Wheel Down');
    registry.resetToDefaults();
  });

  it('the middle button is held by Toggle Mouselook: binding it elsewhere raises the overwrite prompt', () => {
    const vp = open(ActionClass.Camera);
    button(vp, 'Zoom Camera In', 2).click();
    mouse('mousedown', 1);
    expect(confirmations.length).toBe(1);
    expect(confirmations[0].text).toBe("'Button 2' is currently bound to 'Toggle Mouselook'. Do you wish to erase that binding?");
    confirmations[0].respond(true);
    expect(registry.getMappings(ACT.ToggleMouselook)).toEqual([null, null, null]);
    expect(registry.getMappings(ACT.ZoomCameraIn)[2]).toBe('MouseButton2');
    mouse('mouseup', 1);
    registry.resetToDefaults();
    ui.closeKeyboardConfigPanel(false);
  });

  it('closing the capture removes the mouse listeners: a later click binds nothing', () => {
    const vp = open(ActionClass.Movement);
    button(vp, 'Jump', 1).click();
    press('Escape', {}, 'Escape');
    mouse('mousedown', 2);
    mouse('mouseup', 2);
    expect(registry.getMappings(ACT.Jump)).toEqual(['Space', null, null]);
    ui.closeKeyboardConfigPanel(false);
  });
});
