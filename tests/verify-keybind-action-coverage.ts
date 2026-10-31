/**
 * BUG.keybind-use-closest-corpse (webac#13) — "I set a hotkey for Use Closest
 * Unopened Corpse ("L") and it doesn't work."
 *
 * The Keyboard Config listed Use Closest / Next Unopened Corpse (ActionMap
 * 0x1000003e / 0x1000003f) and nothing handled them. Retail's
 * CPlayerSystem::OnAction @ 00561890 runs them as cases 0x13 / 0x14 (its
 * action → case byte table is the jumptable at 0x00562758): SelectNext over
 * unopened corpses, then ItemHolder::UseObject(selectedID) when a corpse is
 * selected. Select Closest / Next Unopened Corpse (0x10000121 / 22) are cases
 * 0x43 / 0x44 and only select (ours used them too).
 *
 * The bug class: a bindable command with no handler. The coverage block below
 * walks every command each era's Keyboard Config lists (from the shipped
 * dialog model and era rules) and every command each era's portal ActionMap
 * (0x26000000) names, and requires the shipped dispatcher to handle it, or a
 * held-movement key, or an entry on UNHANDLED_BINDABLE_ACTIONS with a reason.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatReader, ActionMap } from '@ac/dat-parser';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import {
  dispatchGameAction, UNHANDLED_BINDABLE_ACTIONS, optionToggleCode, isTellableSelection, channelReplyPartner,
  CHAT_COMMAND_PREFIX, type ActionHost,
} from '../packages/renderer/src/input/ActionDispatch.js';
import { corpseCommand, runCorpseCommand } from '../packages/renderer/src/input/CorpseCommands.js';
import { ACT, DEFAULT_KEYBINDS, MOVEMENT_CANONICAL } from '../packages/renderer/src/input/KeybindDefaults.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { KEYBIND_ACTIONS } from '../packages/renderer/src/input/KeybindActions.generated.js';
import { KEYBIND_TAB_ORDER } from '../packages/renderer/src/input/KeybindActionClass.js';
import { KEYBIND_DEFAULTS_1999, COMMAND_ACTIONS_1999 } from '../packages/renderer/src/input/KeyMap1999.js';
import { buildEmoteMotionMap } from '../packages/renderer/src/input/EmoteActionMap.js';
import { routeGameKeyDown } from '../packages/renderer/src/input/GameKeyDown.js';
import { buildKeyboardSections, keyboardHiddenActions, HIDDEN_DEAD_END_ACTIONS } from '../packages/renderer/src/ui/KeyboardConfigModel.js';
import {
  selectCycle, selectNextReference, SelectionType,
  type SelectNextCandidate, type SelectNextContext,
} from '../packages/renderer/src/controllers/SelectNext.js';
import {
  eraClientRules, unsupportedFeatures, hiddenBy, clientRuleHiddenActions, FEATURE_KEYBIND_ACTIONS, OPTION_KEYBIND_ACTIONS,
} from '../packages/renderer/src/era/EraFeatures.js';
import { ERA_PROFILES } from '../packages/renderer/src/era/EraProfiles.js';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';

const PLAYER = 0x50000001;
const BF_CORPSE = 0x2000;

/* ── the corpse commands, driven through the real key router ───────────── */

interface World {
  candidates: SelectNextCandidate[];
  selected: number;
  used: number[];
  host: ActionHost;
}

/** A world of objects around the player at the origin, outdoors (radar radius 75 m). */
function world(objects: Array<Partial<SelectNextCandidate> & { guid: number }>, selected = 0): World {
  const candidates = objects.map((o) => ({
    dx: 0, dy: 0, dz: 0, bitfield: BF_CORPSE, physicsState: 0, showableOnRadar: true, present: true, corpseOpened: false, ...o,
  }));
  const ctx: SelectNextContext = { playerGuid: PLAYER, outside: true, meleeOrMissile: false, isAttackable: () => false, isFellow: () => false };
  const w: World = { candidates, selected, used: [], host: null as unknown as ActionHost };
  const base: Partial<ActionHost> = {
    ui: {} as ActionHost['ui'],
    camera: {} as ActionHost['camera'],
    emoteMotion: () => undefined,
    // main.ts runSelectCycle: the real SelectNext walk, then SetSelectedObject.
    selectCycle: (type, cycle) => {
      const refObj = candidates.find((c) => c.guid === w.selected);
      const ref = selectNextReference(w.selected, PLAYER, refObj ? { dx: refObj.dx, dy: refObj.dy, dz: refObj.dz } : null);
      const g = selectCycle(candidates, ctx, ref, type, cycle);
      if (g) w.selected = g;
      return g;
    },
    selectedId: () => w.selected,
    isCorpse: (g) => ((candidates.find((c) => c.guid === g)?.bitfield ?? 0) & BF_CORPSE) !== 0,
    useObject: (g) => { w.used.push(g); },
  };
  // Anything else the dispatcher touches would be a wrong path for these commands.
  w.host = new Proxy(base, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      throw new Error(`corpse command touched host.${String(k)}`);
    },
  }) as ActionHost;
  return w;
}

/** Press `code` through routeGameKeyDown with `registry`, dispatching into `w`. */
function press(code: string, registry: KeybindRegistry, w: World) {
  return routeGameKeyDown({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false }, {
    textFocused: () => false,
    automationHotkey: () => false,
    syncMaps: () => {},
    resolve: (c) => registry.resolveOrBare(c),
    dispatch: (id) => dispatchGameAction(id, w.host),
  });
}

describe('Use Closest Unopened Corpse bound to L (webac#13)', () => {
  const registry = new KeybindRegistry(DEFAULT_KEYBINDS);
  beforeAll(() => {
    // The reporter's binding, made as the Keyboard Config makes it (L leaves Select Previous Monster).
    registry.setMapping(ACT.UseClosestUnopenedCorpse, 0, 'KeyL');
  });

  it('L resolves to the command, and the press opens the closest unopened corpse', () => {
    expect(registry.resolveOrBare('KeyL')).toBe(0x1000003e);
    const w = world([
      { guid: 0x80000003, dx: 30 },
      { guid: 0x80000001, dx: 4, corpseOpened: true }, // already looted: skipped
      { guid: 0x80000002, dx: 12 },
      { guid: 0x80000004, dx: 2, bitfield: 0x10 }, // a live monster, not a corpse
    ]);
    expect(press('KeyL', registry, w)).toBe('dispatched');
    expect(w.selected).toBe(0x80000002);
    expect(w.used).toEqual([0x80000002]);
  });

  it('no unopened corpse in radar range: nothing selected, nothing used, no refusal line (retail prints none), key consumed', () => {
    const w = world([{ guid: 0x80000005, dx: 80 } /* past the 75 m outdoor radius */, { guid: 0x80000006, dx: 3, corpseOpened: true }]);
    expect(press('KeyL', registry, w)).toBe('dispatched');
    expect(w.selected).toBe(0);
    expect(w.used).toEqual([]);
  });

  it('nothing found keeps the selection, and a corpse already selected is used again (case 0x13 uses whatever corpse is selected)', () => {
    const w = world([{ guid: 0x80000007, dx: 5, corpseOpened: true }], 0x80000007);
    press('KeyL', registry, w);
    expect(w.selected).toBe(0x80000007);
    expect(w.used).toEqual([0x80000007]);
    // a selected monster is never used
    const m = world([{ guid: 0x80000008, dx: 5, bitfield: 0x10 }], 0x80000008);
    press('KeyL', registry, m);
    expect(m.used).toEqual([]);
  });

  it('Use Next Unopened Corpse (case 0x14) walks outward from the selection and wraps to the nearest', () => {
    const objs = [{ guid: 0x80000011, dx: 5 }, { guid: 0x80000012, dx: 10 }, { guid: 0x80000013, dx: 20 }];
    const w = world(objs, 0x80000011);
    expect(dispatchGameAction(ACT.UseNextUnopenedCorpse, w.host)).toBe(true);
    expect(w.used).toEqual([0x80000012]);
    dispatchGameAction(ACT.UseNextUnopenedCorpse, w.host);
    dispatchGameAction(ACT.UseNextUnopenedCorpse, w.host);
    expect(w.used).toEqual([0x80000012, 0x80000013, 0x80000011]);
  });

  it('Select Closest / Next Unopened Corpse (cases 0x43 / 0x44) only select: no use is sent', () => {
    const w = world([{ guid: 0x80000021, dx: 5 }, { guid: 0x80000022, dx: 9 }]);
    expect(dispatchGameAction(ACT.SelectClosestUnopenedCorpse, w.host)).toBe(true);
    expect(w.selected).toBe(0x80000021);
    expect(dispatchGameAction(ACT.SelectNextUnopenedCorpse, w.host)).toBe(true);
    expect(w.selected).toBe(0x80000022);
    expect(w.used).toEqual([]);
  });

  it('corpseCommand maps exactly the four ActionMap ids; runCorpseCommand selects through SELECTION_TYPE_UNOPENED_CORPSE', () => {
    expect(corpseCommand(0x1000003e)).toEqual({ use: true, cycle: 'closest' });
    expect(corpseCommand(0x1000003f)).toEqual({ use: true, cycle: 'next' });
    expect(corpseCommand(0x10000121)).toEqual({ use: false, cycle: 'closest' });
    expect(corpseCommand(0x10000122)).toEqual({ use: false, cycle: 'next' });
    expect(corpseCommand(0x10000035)).toBeNull();
    const types: SelectionType[] = [];
    runCorpseCommand({ use: false, cycle: 'closest' }, { selectCycle: (t) => { types.push(t); return 0; }, selectedId: () => 0, isCorpse: () => true, useObject: () => {} });
    expect(types).toEqual([SelectionType.UnopenedCorpse]);
  });

  it('the names the DAT gives these ids are the ones the Keyboard Config shows', () => {
    const name = (id: number) => KEYBIND_ACTIONS.find((a) => a.id === id)?.name;
    expect(name(0x1000003e)).toBe('Use Closest Unopened Corpse');
    expect(name(0x1000003f)).toBe('Use Next Unopened Corpse');
    expect(name(0x10000121)).toBe('Select Closest Unopened Corpse');
    expect(name(0x10000122)).toBe('Select Next Unopened Corpse');
  });
});

/* ── every bindable command has a handler (the bug class) ──────────────── */

/**
 * A host that records every call. Lookups return what main.ts's would for a
 * world with a selected object: the real emote table, a selection, true for
 * the commands that report consumption.
 */
function recordingHost(): { host: ActionHost; calls: string[] } {
  const calls: string[] = [];
  const emotes = buildEmoteMotionMap();
  const recorder = (prefix: string) => new Proxy({}, {
    get: (_t, k) => (..._args: unknown[]) => { calls.push(prefix + String(k)); return true; },
  });
  const ui = recorder('ui.');
  const camera = recorder('camera.');
  const host = new Proxy({} as ActionHost, {
    get(_t, k) {
      if (k === 'ui') return ui;
      if (k === 'camera') return camera;
      if (k === 'emoteMotion') return (id: number) => emotes.get(id);
      if (k === 'selectedId') return () => 0x80000001;
      if (k === 'isCorpse') return () => true;
      return (..._args: unknown[]) => { calls.push(String(k)); return k === 'selectCycle' ? 0x80000001 : true; };
    },
  });
  return { host, calls };
}

/** The verdict for one bindable command. */
function coverage(id: number): 'movement' | 'handled' | 'exception' | 'MISSING' {
  if (MOVEMENT_CANONICAL[id] !== undefined) return 'movement';
  if (UNHANDLED_BINDABLE_ACTIONS[id] !== undefined) return 'exception';
  const { host, calls } = recordingHost();
  const consumed = dispatchGameAction(id, host);
  return consumed && calls.length > 0 ? 'handled' : 'MISSING';
}

const label = (id: number) => `0x${id.toString(16)} ${KEYBIND_ACTIONS.find((a) => a.id === id)?.name ?? ''}`;

/** Each era's Keyboard Config, as GameUI builds it (FEATURE_KEYBIND_ACTIONS + the era's client rules). */
const ERAS: Array<[string, Parameters<typeof eraClientRules>[0]]> = [
  ['end of retail', null],
  ...Object.values(ERA_PROFILES).filter((p) => p.id !== 'eor').map((p) => [p.id, p] as [string, typeof p]),
];

function dialogIds(profile: Parameters<typeof eraClientRules>[0], registry: KeybindRegistry): number[] {
  const rules = eraClientRules(profile);
  const hidden = keyboardHiddenActions(new Set([
    ...hiddenBy(FEATURE_KEYBIND_ACTIONS, unsupportedFeatures(profile)),
    ...clientRuleHiddenActions(rules),
  ]));
  const ids: number[] = [];
  for (const tab of KEYBIND_TAB_ORDER) {
    for (const s of buildKeyboardSections(registry, tab.cls, undefined, hidden)) for (const r of s.rows) ids.push(r.id);
  }
  return [...new Set(ids)];
}

describe('every command the Keyboard Config lets a player bind does something', () => {
  for (const [name, profile] of ERAS) {
    it(`${name}: every listed command is handled, a held movement key, or a justified exception`, () => {
      const keymap = eraClientRules(profile).keymap;
      const registry = new KeybindRegistry(keymap === 'ac1999' ? { ...KEYBIND_DEFAULTS_1999 } : DEFAULT_KEYBINDS);
      const ids = dialogIds(profile, registry);
      expect(ids.length).toBeGreaterThan(200);
      const missing = ids.filter((id) => coverage(id) === 'MISSING').map(label);
      expect(missing).toEqual([]);
    });
  }

  it('the exceptions are few, each has a reason naming its task, and none is hidden instead (No Dead-End UI is for gone targets)', () => {
    const ids = Object.keys(UNHANDLED_BINDABLE_ACTIONS).map(Number).sort((a, b) => a - b);
    expect(ids).toEqual([0x55]); // Take Screenshot
    for (const id of ids) {
      expect(UNHANDLED_BINDABLE_ACTIONS[id]).toMatch(/task [A-Z]+\.[a-z0-9.-]+/);
      expect(HIDDEN_DEAD_END_ACTIONS.has(id)).toBe(false);
    }
    // Gone targets, hidden: Display Plugin Manager (KeyStone::OpenPluginManager) and Show/Hide
    // Compass (SendNotice_UpdateRadarVisibility reaches only the empty stub at 0x00508950).
    expect(HIDDEN_DEAD_END_ACTIONS.has(0x7c)).toBe(true);
    expect(HIDDEN_DEAD_END_ACTIONS.has(0x1000001e)).toBe(true);
  });

  it('1999\'s Default.map binds only handled commands (AutosortSelected = Place Selected Object in Inventory now works)', () => {
    const ids = [...new Set(Object.values(COMMAND_ACTIONS_1999).flat())];
    const missing = ids.filter((id) => coverage(id) === 'MISSING').map(label);
    expect(missing).toEqual([]);
    expect(COMMAND_ACTIONS_1999.AutosortSelected).toEqual([0x1000002c]);
    expect(coverage(0x1000002c)).toBe('handled');
  });

  it('every Character Settings command toggles its own PlayerOption (OnAction cases 0x17-0x4a)', () => {
    for (const [id, opt] of Object.entries(OPTION_KEYBIND_ACTIONS)) {
      const code = optionToggleCode(Number(id));
      expect(code, opt).toBeTypeOf('number');
      const { host, calls } = recordingHost();
      dispatchGameAction(Number(id), host);
      expect(calls).toEqual(['ui.togglePlayerOption']);
    }
    expect(optionToggleCode(0x10000071)).toBe(0x00); // Automatically Repeat Attacks → AutoRepeatAttack
    expect(optionToggleCode(0x1000013e)).toBe(0x13); // Side By Side Vitals
    expect(optionToggleCode(0x1000003e)).toBeUndefined();
  });

  it('the commands route to retail\'s owners', () => {
    const route = (id: number) => { const { host, calls } = recordingHost(); const r = dispatchGameAction(id, host); return { r, calls }; };
    expect(route(ACT.PlaceSelectedInInventory).calls).toEqual(['placeSelectedInBackpack']);
    expect(route(ACT.PlaceSelectedInMainPack).calls).toEqual(['placeSelectedInBackpack']);
    expect(route(ACT.Reply).calls).toEqual(['replyKey']);
    expect(route(ACT.MonarchReply).calls).toEqual(['replyKey']);
    expect(route(ACT.PatronReply).calls).toEqual(['replyKey']);
    expect(route(ACT.StartCommand).calls).toEqual(['startCommand']);
    expect(route(ACT.TellToSelected).calls).toEqual(['tellToSelected']);
    expect(route(ACT.ToggleMouselook).calls).toEqual(['mouseLookDown']);
    expect(route(ACT.SpellSlot12).calls).toEqual(['ui.castFromSpellBar']);
    expect(route(ACT.ShowHideFriendsPage).calls).toEqual(['ui.toggleSocialPage']);
    expect(route(ACT.ShowHideCharacterTitlesPage).calls).toEqual(['ui.toggleCharPage']);
    expect(route(ACT.ShowHideHousePage).calls).toEqual(['ui.toggleWorldPage']);
    expect(route(ACT.ShowHideSpellManagementPanel).calls).toEqual(['ui.toggleMagicPanel']);
    expect(route(ACT.ShowHideCharacterSettingsPage).calls).toEqual(['ui.toggleOptionsPage']);
    expect(route(ACT.ShowHideQuestJournalPage).calls).toEqual(['ui.toggleContractPage']);
    expect(route(ACT.ShowHideQuestDetailPanel).calls).toEqual(['ui.toggleContractPanel']);
    expect(route(0x12345678).r).toBe(false);
  });
});

describe('the reply / tell helpers (ChatInterface::OnAction @ 004f5690)', () => {
  it('Tell to Selected tells only a player id (0x50000000 < id < 0x70000000)', () => {
    expect(isTellableSelection(0x50000001)).toBe(true);
    expect(isTellableSelection(0x6fffffff)).toBe(true);
    expect(isTellableSelection(0x50000000)).toBe(false);
    expect(isTellableSelection(0x80000001)).toBe(false);
    expect(isTellableSelection(0)).toBe(false);
  });

  it('a Monarch (0x4000) / Patron (0x2000) channel line from someone names the reply partner; our own echo does not', () => {
    expect(channelReplyPartner(0x4000, 'Asheron')).toBe('monarch');
    expect(channelReplyPartner(0x2000, 'Bael')).toBe('patron');
    expect(channelReplyPartner(0x4000, '')).toBeNull();
    expect(channelReplyPartner(0x800, 'Fellow')).toBeNull();
  });

  it('Start Command opens the entry with ID_CmdPrefix "/"', () => {
    expect(CHAT_COMMAND_PREFIX).toBe('/');
  });
});

/* ── GameUI's page toggles + the option toggle (prototype on a fake) ───── */

describe('GameUI page toggles (DoVisibilityToggleAction semantics)', () => {
  it('toggleContractPage: closed → opens on the page; on it → hides; on another → switches', () => {
    const calls: string[] = [];
    const ui = {
      contractVisible: false, contractTab: 'contracts',
      eraSupports: () => true,
      toggleContractPanel() { calls.push('panel'); ui.contractVisible = !ui.contractVisible; },
      renderContractPanel() { calls.push('render'); },
    };
    const t = (tab: 'contracts' | 'journal' | 'page_list') => GameUI.prototype.toggleContractPage.call(ui as unknown as GameUI, tab);
    t('journal');
    expect([ui.contractVisible, ui.contractTab]).toEqual([true, 'journal']);
    t('page_list');
    expect([ui.contractVisible, ui.contractTab]).toEqual([true, 'page_list']);
    expect(calls).toEqual(['panel', 'render']);
    t('page_list');
    expect(ui.contractVisible).toBe(false);
    // an era without contracts (AC1999) has no pages to show
    const none = { ...ui, contractVisible: false, eraSupports: () => false, toggleContractPanel: () => { throw new Error('opened'); } };
    GameUI.prototype.toggleContractPage.call(none as unknown as GameUI, 'journal');
  });

  it('toggleWorldPage: the House page opens the World panel on it; a world without housing has none', () => {
    const calls: string[] = [];
    const ui = {
      mapPanelVisible: false, worldPanelTab: 'map', eraUnsupported: new Set<string>(),
      toggleMapPanel() { calls.push('panel'); ui.mapPanelVisible = !ui.mapPanelVisible; },
      openWorldPanelTab(tab: string) { calls.push(`tab:${tab}`); ui.worldPanelTab = tab; },
    };
    const t = (tab: 'map' | 'house') => GameUI.prototype.toggleWorldPage.call(ui as unknown as GameUI, tab);
    t('house');
    expect([ui.mapPanelVisible, ui.worldPanelTab]).toEqual([true, 'house']);
    t('map');
    expect(ui.worldPanelTab).toBe('map');
    t('map');
    expect(ui.mapPanelVisible).toBe(false);
    expect(calls).toEqual(['panel', 'tab:map', 'panel']);
    const noHousing = { ...ui, eraUnsupported: new Set(['housing']), toggleMapPanel: () => { throw new Error('opened'); } };
    GameUI.prototype.toggleWorldPage.call(noHousing as unknown as GameUI, 'house');
  });

  it('toggleOptionsPage: the Character Settings / Configuration pages', () => {
    const calls: string[] = [];
    const ui = {
      optionsPanelVisible: false, optionsTab: 'gameplay', optionsSettings: {} as Record<string, unknown>,
      saveOptionsSettings() {}, renderOptionsPanel() { calls.push('render'); },
      setPanelsWindowPanel(_p: unknown, show: boolean) { calls.push(show ? 'show' : 'hide'); ui.optionsPanelVisible = show; },
    };
    const t = (tab: 'gameplay' | 'character' | 'chat' | 'config') => GameUI.prototype.toggleOptionsPage.call(ui as unknown as GameUI, tab);
    t('character');
    t('config');
    t('config');
    expect(calls).toEqual(['show', 'render', 'hide']);
    expect(ui.optionsSettings.optionsTab).toBe('config');
  });
});

describe('GameUI.togglePlayerOption — PlayerModule::Set<Option>(!<Option>)', () => {
  function fake(settings: Record<string, boolean>) {
    const sent: Array<[number, boolean]> = [];
    const painted: string[] = [];
    const ui = {
      optionsSettings: { ...settings },
      optionsPanelVisible: false, socialPanelVisible: false,
      saveOptionsSettings() {},
      callbacks: { onCharacterOptionToggle: (code: number, on: boolean) => { sent.push([code, on]); } },
      characterSettingApplyHook: (key: string) => (key === 'sideBySideVitals' ? () => painted.push('vitals') : undefined),
      optionGemPainters: new Map([['repeatAttacks', new Set([() => painted.push('gem')])]]),
      renderOptionsPanel() {}, renderSocialPanel() {},
    };
    return { ui, sent, painted };
  }

  it('flips the option, persists it, sends the CharacterOption and repaints its checkbox', () => {
    const { ui, sent, painted } = fake({ repeatAttacks: true });
    expect(GameUI.prototype.togglePlayerOption.call(ui as unknown as GameUI, 0x00)).toBe(true);
    expect(ui.optionsSettings.repeatAttacks).toBe(false);
    expect(sent).toEqual([[0x00, false]]);
    expect(painted).toEqual(['gem']);
    GameUI.prototype.togglePlayerOption.call(ui as unknown as GameUI, 0x00);
    expect(sent).toEqual([[0x00, false], [0x00, true]]);
  });

  it('runs the option row\'s live hook (Side By Side Vitals relays the vitals)', () => {
    const { ui, sent, painted } = fake({ sideBySideVitals: false });
    GameUI.prototype.togglePlayerOption.call(ui as unknown as GameUI, 0x13);
    expect(sent).toEqual([[0x13, true]]);
    expect(painted).toEqual(['vitals']);
  });

  it('every Character Settings command reaches an option GameUI knows', () => {
    const known = new Set(Object.values(GameUI.OPTIONS_TO_CHARACTER_OPTION));
    for (const id of Object.keys(OPTION_KEYBIND_ACTIONS).map(Number)) {
      expect(known.has(optionToggleCode(id)!), label(id)).toBe(true);
    }
  });
});

/* ── each era's DAT ActionMap names only commands we know ─────────────── */

const ERA_PORTALS: Array<[string, string]> = ([
  ['end of retail', DAT_PATHS.portal] as [string, string],
  ...Object.keys(ERA_PROFILES).map((id): [string, string] => [id, resolve(__dirname, '..', 'dat/sets', id, 'client_portal.dat')]),
]).filter(([, p]) => existsSync(p));

describe.skipIf(ERA_PORTALS.length === 0)('the portal ActionMap 0x26000000 of each era', () => {
  const maps: Array<[string, ActionMap]> = [];
  beforeAll(() => {
    for (const [name, path] of ERA_PORTALS) {
      const data = openDat(path).getFileData(0x26000000);
      if (data) maps.push([name, ActionMap.read(new DatReader(data))]);
    }
  });

  it('every user-bindable command it names (classes 1-5, 7) is in the Keyboard Config list, and each is handled or excepted', () => {
    expect(maps.length).toBeGreaterThan(0);
    const known = new Set(KEYBIND_ACTIONS.map((a) => a.id));
    for (const [name, am] of maps) {
      const ids = new Set<number>();
      for (const values of am.inputMaps.values()) {
        for (const [id, v] of values) if ([1, 2, 3, 4, 5, 7].includes(v.userBindingData.actionClass)) ids.add(id >>> 0);
      }
      expect(ids.size, name).toBeGreaterThan(200);
      const unknown = [...ids].filter((id) => !known.has(id)).map((id) => `0x${id.toString(16)}`);
      expect(unknown, name).toEqual([]);
      const missing = [...ids].filter((id) => !HIDDEN_DEAD_END_ACTIONS.has(id) && coverage(id) === 'MISSING').map(label);
      expect(missing, name).toEqual([]);
    }
  });
});
