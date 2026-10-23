/**
 * The 1999 client's default key bindings (SWEEP1999.input, CM-1 / CHAR-4 / CHAR-9).
 *
 * The 1999 client.exe has no KeyMap in its DATs. InputMapper::InputMapper @ 0x0059fe70 loads the
 * keymap file the registry names and falls back to "Default.map" ("Could not load keymap file %s.
 * Default keymap will be used instead."), a text file that ships with the 1999 install
 * (`AsheronsCall/Default.map`, Turbine's, not in the repo). Its rows are
 * `InputType Input Chording Command CommandType AnalogType`, with Input a Windows virtual-key code
 * (the mapper's tables are 0x100 entries, VK-indexed). DEFAULT_MAP_1999_ROWS is that file's 76 rows
 * decoded (every row is keyboard, unchorded, CommandType 0, AnalogType 0), in file order;
 * tests/verify-keymap-1999.ts checks it against a local install when one is present.
 *
 * Keys the 1999 client handles outside the map (PanelUI 0x004f4120 @ 0x004f4120: digits 1-9 use
 * the shortcut tray, or in magic mode without Ctrl select spell slot N and cast it; 0 creates a
 * shortcut; Enter / Tab / Esc; Shift+Esc logs off) are HARDCODED_1999_KEYS. The mode-dependent
 * meaning of the power and attack keys (PanelUI_HandleCommand @ 0x4f5700) is in
 * COMMAND_ACTIONS_1999: in magic mode the three attack keys cast (SpellCastSubPanel_Cast) and
 * Increase / Decrease Power step the spell selection (Increment / DecrementSelection); in missile
 * mode the power keys step the same sixths bar as in melee.
 */
import { BROWSER_UX_BINDINGS } from './KeybindDefaults.js';
import { SPELL_RESEARCH_PAGE_ACTION } from './KeybindClientActions.js';

/** Default.map, decoded: [Windows VK, command name], file order. */
export const DEFAULT_MAP_1999_ROWS: ReadonlyArray<readonly [number, string]> = Object.freeze([
  [8, 'ClosestCompassItem'], [32, 'Jump'], [33, 'IncreasePowerSetting'], [34, 'HighAttack'],
  [35, 'MediumAttack'], [36, 'LastAttacker'], [37, 'TurnLeft'], [38, 'WalkForward'],
  [39, 'TurnRight'], [40, 'WalkBackwards'], [43, 'MapView'], [45, 'DecreasePowerSetting'],
  [46, 'LowAttack'], [65, 'TurnLeft'], [66, 'Sleeping'], [67, 'SideStepRight'],
  [68, 'TurnRight'], [69, 'ExamineSelected'], [70, 'AutosortSelected'], [71, 'Sitting'],
  [72, 'Crouch'], [73, 'Laugh'], [74, 'Wave'], [75, 'PointState'],
  [76, 'PreviousMonster'], [77, 'NextFellow'], [78, 'PreviousFellow'], [79, 'Cheer'],
  [80, 'PreviousSelection'], [81, 'AutoRun'], [82, 'UseSelected'], [83, 'Ready'],
  [84, 'SplitSelected'], [85, 'Cry'], [86, 'DropSelected'], [87, 'WalkForward'],
  [88, 'WalkBackwards'], [89, 'Ready'], [90, 'SideStepLeft'], [96, 'ResetView'],
  [98, 'CameraLower'], [100, 'CameraLeftRotate'], [101, 'FloorView'], [102, 'CameraRightRotate'],
  [104, 'CameraRaise'], [106, 'CaptureScreenshotToFile'], [107, 'CameraFarther'], [109, 'CameraCloser'],
  [110, 'FirstPersonView'], [111, 'ShiftView'], [113, 'ShiftView'], [114, 'AllegiancePanel'],
  [115, 'FellowshipPanel'], [116, 'SpellbookPanel'], [117, 'SpellComponentsPanel'], [118, 'SpellResearchPanel'],
  [119, 'AttributesPanel'], [120, 'SkillsPanel'], [121, 'MapPanel'], [122, 'OptionsPanel'],
  [123, 'InventoryPanel'], [160, 'HoldRun'], [161, 'HoldRun'], [164, 'HoldSidestep'],
  [165, 'HoldSidestep'], [186, 'NextMonster'], [187, 'NextCompassItem'], [188, 'PreviousPlayer'],
  [189, 'PreviousCompassItem'], [190, 'NextPlayer'], [191, 'ClosestPlayer'], [192, 'ToggleCombat'],
  [219, 'PreviousItem'], [220, 'ClosestItem'], [221, 'NextItem'], [222, 'ClosestMonster'],
] as const);

/**
 * Windows VK → KeyboardEvent.code (US layout). VK 43 (VK_EXECUTE, Default.map's MapView key) is
 * absent: no PC keyboard has it, so 1999's Map View had no reachable default key.
 */
export const VK_TO_CODE: Readonly<Record<number, string>> = Object.freeze({
  8: 'Backspace', 32: 'Space', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert', 46: 'Delete',
  ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => [65 + i, `Key${String.fromCharCode(65 + i)}`])),
  96: 'Numpad0', 97: 'Numpad1', 98: 'Numpad2', 99: 'Numpad3', 100: 'Numpad4', 101: 'Numpad5',
  102: 'Numpad6', 103: 'Numpad7', 104: 'Numpad8', 105: 'Numpad9', 106: 'NumpadMultiply',
  107: 'NumpadAdd', 109: 'NumpadSubtract', 110: 'NumpadDecimal', 111: 'NumpadDivide',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [112 + i, `F${i + 1}`])),
  160: 'ShiftLeft', 161: 'ShiftRight', 164: 'AltLeft', 165: 'AltRight',
  186: 'Semicolon', 187: 'Equal', 188: 'Comma', 189: 'Minus', 190: 'Period', 191: 'Slash',
  192: 'Backquote', 219: 'BracketLeft', 220: 'Backslash', 221: 'BracketRight', 222: 'Quote',
});

/** The ActionMap commands that stand in for 1999's HoldSidestep: Alt held turns the turn keys into sidesteps. */
const HOLD_SIDESTEP_CHORDS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  0x2c: ['Alt+KeyD', 'Alt+ArrowRight'], // Strafe Right
  0x2d: ['Alt+KeyA', 'Alt+ArrowLeft'], // Strafe Left
});

/**
 * Each 1999 command → the ActionMap commands (KeybindActions.generated.ts) its key is bound to.
 * A key is bound in every input map that gives it a meaning: the attack and power keys in the
 * melee, missile and magic maps. HoldSidestep is HOLD_SIDESTEP_CHORDS. "Ready" on S is Stop Moving
 * (0x2b, "Enter the standing Ready state."), the command whose effect 1999's Ready-while-moving
 * had; on Y it is the Ready emote action, as in end of retail.
 */
export const COMMAND_ACTIONS_1999: Readonly<Record<string, readonly number[]>> = Object.freeze({
  ClosestCompassItem: [0x1000002f], Jump: [0x31],
  // HandleCommand 0x90000c9 / 0x90000c8: melee and missile step the bar (0x0058b300 / 0058b390),
  // magic steps the spell selection (SpellCastSubPanel_Increment / DecrementSelection).
  IncreasePowerSetting: [0x1000005c, 0x100000f0, 0x10000062], // Increase Power / Accuracy, Next Spell
  DecreasePowerSetting: [0x1000005b, 0x100000ef, 0x10000061], // Decrease Power / Accuracy, Previous Spell
  // HandleCommand 0xd0000b2-b4: melee / missile attack at that height, magic casts.
  HighAttack: [0x1000005f, 0x100000f3, 0x10000060],
  MediumAttack: [0x1000005e, 0x100000f2, 0x10000060],
  LowAttack: [0x1000005d, 0x100000f1, 0x10000060],
  LastAttacker: [0x10000038], TurnLeft: [0x2f], WalkForward: [0x29], TurnRight: [0x2e], WalkBackwards: [0x2a],
  MapView: [0x3c], Sleeping: [0x10000097], SideStepRight: [0x2c], SideStepLeft: [0x2d],
  ExamineSelected: [0x1000002b], AutosortSelected: [0x1000002c], Sitting: [0x10000096], Crouch: [0x10000095],
  Laugh: [0x100000b2], Wave: [0x100000e5], PointState: [0x100000be], Cheer: [0x100000a2], Cry: [0x100000a7],
  PreviousMonster: [0x10000036], NextMonster: [0x10000037], ClosestMonster: [0x10000035],
  NextFellow: [0x1000003d], PreviousFellow: [0x1000003c], PreviousSelection: [0x1000002e],
  Ready: [0x10000094], AutoRun: [0x30], UseSelected: [0x10000025], SplitSelected: [0x1000002d], DropSelected: [0x10000041],
  ResetView: [0x39], CameraLower: [0x38], CameraRaise: [0x37], CameraLeftRotate: [0x35], CameraRightRotate: [0x36],
  FloorView: [0x3b], CaptureScreenshotToFile: [0x55], CameraFarther: [0x34], CameraCloser: [0x33],
  FirstPersonView: [0x3a], ShiftView: [0x3e],
  AllegiancePanel: [0x1000000e], FellowshipPanel: [0x1000000f], SpellbookPanel: [0x10000011],
  SpellComponentsPanel: [0x10000012], SpellResearchPanel: [SPELL_RESEARCH_PAGE_ACTION],
  AttributesPanel: [0x10000014], SkillsPanel: [0x10000015], MapPanel: [0x10000016],
  OptionsPanel: [0x1000001a], InventoryPanel: [0x10000019],
  HoldRun: [0x32], HoldSidestep: [],
  NextCompassItem: [0x10000031], PreviousCompassItem: [0x10000030],
  PreviousPlayer: [0x1000003a], NextPlayer: [0x1000003b], ClosestPlayer: [0x10000039],
  ToggleCombat: [0x1000005a], PreviousItem: [0x10000033], ClosestItem: [0x10000032], NextItem: [0x10000034],
});

/** The "Ready" row on S: Stop Moving (see COMMAND_ACTIONS_1999). */
const READY_ON_S: Readonly<Record<number, number>> = Object.freeze({ 83: 0x2b });

/**
 * PanelUI 0x004f4120 @ 0x004f4120, the keys handled before the map: digits 1-9 use shortcut N
 * (with or without Ctrl; magic mode without Ctrl selects and casts spell slot N), 0 creates a
 * shortcut (0x80000a9), Enter begins chat (0x80000b5), Tab switches chat mode (0x80000b6),
 * Shift+Esc logs off (0x004cc5a0, "Logging off..."). Digit codes match end of retail's.
 */
export const HARDCODED_1999_KEYS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [0x10000042 + i, [`Digit${i + 1}`, `Ctrl+Digit${i + 1}`]])), // Quickslot 1-9
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [0x10000065 + i, [`Digit${i + 1}`]])), // Spell Slot 1-9 (magic map)
  0x1000010d: ['Digit0', 'Ctrl+Digit0'], // Create Shortcut
  0x10000023: ['Enter'], // Begin Chat Mode
  0x10000024: ['Tab'], // Enter/Exit Chat Mode
  0x10000026: ['Shift+Escape'], // End Character Session
});

/** Build actionId → codes (Mapping 1-3) from decoded Default.map rows. */
export function buildKeybindDefaults1999(rows: ReadonlyArray<readonly [number, string]> = DEFAULT_MAP_1999_ROWS): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  const add = (id: number, code: string): void => {
    const list = (out[id] ??= []);
    if (!list.includes(code) && list.length < 3) list.push(code);
  };
  for (const [vk, command] of rows) {
    const code = VK_TO_CODE[vk];
    if (!code) continue;
    const ids = READY_ON_S[vk] !== undefined && command === 'Ready' ? [READY_ON_S[vk]] : COMMAND_ACTIONS_1999[command] ?? [];
    for (const id of ids) add(id, code);
    if (command === 'HoldSidestep' && code === 'AltLeft') {
      for (const [id, chords] of Object.entries(HOLD_SIDESTEP_CHORDS)) for (const c of chords) add(Number(id), c);
    }
  }
  for (const [id, codes] of Object.entries(HARDCODED_1999_KEYS)) for (const c of codes) add(Number(id), c);
  // The browser-UX additions every era keeps (CLAUDE.md: wheel zoom over the world).
  for (const [id, codes] of Object.entries(BROWSER_UX_BINDINGS)) for (const c of codes) add(Number(id), c);
  return out;
}

/** The 1999 era's default bindings (Default.map + the hardcoded keys + the browser-UX wheel zoom). */
export const KEYBIND_DEFAULTS_1999: Readonly<Record<number, string[]>> = buildKeybindDefaults1999();
