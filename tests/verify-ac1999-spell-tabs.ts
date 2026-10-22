/**
 * BUG.ac1999-spell-tabs (webac#5, "[AC1999] Client has multiple spellcasting
 * tabs") — the 1999 client.exe has ONE spell bar and no tabs, and a nine-slot
 * 1-9 shortcut tray. Our shared end-of-retail spell bar showed eight tabs in
 * 1999 and the toolbar eighteen quick slots: spells parked on tabs 2-8 (and
 * items in slots 10-18) worked for the session, an advantage the 1999 CD
 * never had, and none of it reached the server.
 *
 * Ground truth:
 *  - 1999 client.exe (Oct 1999, 4.35752; capstone): CM_Character_Event_
 *    AddToSpellbar @ 0x53e2d0 writes 0x1E3 (`mov ecx, 0x1e3` @ 0x53e349),
 *    spellID, index, and nothing else; RemoveFromSpellbar @ 0x53e3b0 only
 *    spellID. Its command names have CastSpell and UseShortcut 1-9, no spell
 *    tab commands. ShortCutManager::AddShortCut @ 0x586f00 refuses an index
 *    past 8 (reference/ac1999 kb PlayerModule, 0x1E3-AddToSpellbar).
 *  - AC1999 server (reference/ac1999/Server/Source/ClientEvents.cpp
 *    ADD_TO_SPELLBAR / REMOVE_FROM_SPELLBAR): spellBar is hard-set to 0; its
 *    PlayerDescription packs only favorite_spells_[0] (ObjectMsgs.cpp
 *    [1999-SPELLBAR]).
 *  - End of retail keeps 8 tabs (gmSpellcastingUI, RecvNotice_PlayerDesc-
 *    Received @ 004c69a0 loops 8) and 18 slots; the Dark Majesty local DATs
 *    (customdm 1.60, infiltration 1.9) carry the same eight tab elements in
 *    0x21000010 and run the end-of-retail acclient.exe.
 *
 * Drives the real modules: EraFeatures, SpellShortcutBar, GameActions,
 * ItemShortcutRestorer, GameUI (happy-dom) and, with the DATs, the real
 * LayoutRenderer spell bar + toolbar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules, clientRuleHiddenActions, SPELL_TAB_ACTIONS } from '../packages/renderer/src/era/EraFeatures.js';
import { nextSpellBarTab, prevSpellBarTab, restoreSpellBars, SPELL_BAR_TAB_IDS } from '../packages/renderer/src/ui/SpellShortcutBar.js';
import { GameActions, type SendGameAction } from '../packages/renderer/src/network/GameActions.js';
import { PingLatencyTracker } from '../packages/renderer/src/network/PingLatencyTracker.js';
import { ItemShortcutRestorer, quickslotCommand, SHORTCUT_NO_FREE_SLOTS_TEXT } from '../packages/renderer/src/network/itemShortcutRestore.js';
import { ACT } from '../packages/renderer/src/input/KeybindDefaults.js';
import { GameActionType } from '../packages/network/src/index.js';

const AC1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile('eor'));
const CLASSIC_IDS = ['classicace-customdm', 'classicace-infiltration', 'classic-dereth'];

describe('era rules: the spell bar\'s tabs and the toolbar\'s quick slots', () => {
  it('1999: one bar, nine slots; end of retail and every classic era: eight tabs, eighteen slots', () => {
    expect([AC1999.spellBarTabs, AC1999.shortcutSlots]).toEqual([1, 9]);
    expect([EOR.spellBarTabs, EOR.shortcutSlots]).toEqual([8, 18]);
    for (const id of CLASSIC_IDS) {
      const r = eraClientRules(eraProfile(id));
      expect([r.spellBarTabs, r.shortcutSlots], id).toEqual([8, 18]);
    }
    expect(EOR.spellBarTabs).toBe(SPELL_BAR_TAB_IDS.length);
  });

  it('Keyboard Config: 1999 lists no spell-tab commands and no Quickslot / Select Quickslot 10-18; end of retail hides none', () => {
    const hidden = clientRuleHiddenActions(AC1999);
    for (const id of [ACT.PreviousSpellTab, ACT.NextSpellTab, ACT.FirstSpellTab, ACT.LastSpellTab]) expect(hidden.has(id)).toBe(true);
    expect([...SPELL_TAB_ACTIONS].sort()).toEqual([ACT.PreviousSpellTab, ACT.NextSpellTab, ACT.FirstSpellTab, ACT.LastSpellTab].sort());
    const quick = [...hidden].filter((id) => quickslotCommand(id));
    // Quickslot 10-18 + Select Quickslot 10-18
    expect(quick.length).toBe(18);
    for (const id of quick) expect(quickslotCommand(id)!.slot).toBeGreaterThanOrEqual(9);
    // Quickslot 1-9 stay (the 1999 UseShortcut 1-9)
    for (let s = 0; s < 9; s++) {
      expect(hidden.has(0x10000042 + s)).toBe(false);
      expect(hidden.has(0x1000004e + s)).toBe(false);
    }
    expect(clientRuleHiddenActions(EOR).size).toBe(0);
  });
});

describe('SpellShortcutBar: tab walks and the login restore follow the era\'s tab count', () => {
  it('a one-tab bar: Next / Prev stay on tab 0; eight tabs wrap as before', () => {
    expect(nextSpellBarTab(0, 1)).toBe(0);
    expect(prevSpellBarTab(0, 1)).toBe(0);
    expect(nextSpellBarTab(7)).toBe(0);
    expect(prevSpellBarTab(0)).toBe(7);
    expect(nextSpellBarTab(3, 8)).toBe(4);
  });

  it('1999: favourites on tabs past the first are hidden, never pruned (no RemoveSpellFavorite for a tab 1999 lacks)', () => {
    const bars = [[10, 11], [20], [30, 99], [], [], [], [], [40]];
    const known = (id: number) => id !== 99;
    const r1999 = restoreSpellBars(bars, known, (id) => ({ id }), AC1999.spellBarTabs);
    expect(r1999.slots[0].filter(Boolean).map((s) => s!.id)).toEqual([10, 11]);
    for (let t = 1; t < 8; t++) expect(r1999.slots[t].filter(Boolean)).toEqual([]);
    expect(r1999.removed).toEqual([]);
    expect(r1999.restored).toBe(2);
    // end of retail: all eight tabs, the unknown spell pruned
    const reor = restoreSpellBars(bars, known, (id) => ({ id }), EOR.spellBarTabs);
    expect(reor.slots[2].filter(Boolean).map((s) => s!.id)).toEqual([30]);
    expect(reor.slots[7].filter(Boolean).map((s) => s!.id)).toEqual([40]);
    expect(reor.removed).toEqual([{ spellId: 99, tab: 2 }]);
    expect(restoreSpellBars(bars, known, (id) => ({ id }))).toEqual(reor);
  });
});

describe('GameActions: no favourite for a tab the era lacks is sent', () => {
  function harness(tabs?: number) {
    const sent: Array<{ type: GameActionType; payload: Uint8Array }> = [];
    const send: SendGameAction = (type, payload) => { sent.push({ type, payload }); return true; };
    const actions = new GameActions(() => send, new PingLatencyTracker(() => 1000));
    if (tabs !== undefined) actions.spellBarTabs = tabs;
    return { sent, actions };
  }
  it('1999: tab 0 is sent, tabs 1-7 (and nonsense) are not', () => {
    const h = harness(AC1999.spellBarTabs);
    h.actions.addSpellFavorite(27, 0, 0);
    h.actions.removeSpellFavorite(27, 0);
    for (const bar of [1, 2, 7, 8, -1, 1.5]) {
      h.actions.addSpellFavorite(27, 0, bar);
      h.actions.removeSpellFavorite(27, bar);
    }
    expect(h.sent.map((s) => s.type)).toEqual([GameActionType.AddSpellFavorite, GameActionType.RemoveSpellFavorite]);
  });
  it('end of retail (the default): every one of the eight tabs is sent', () => {
    const h = harness();
    for (let bar = 0; bar < 8; bar++) h.actions.addSpellFavorite(27, 0, bar);
    h.actions.addSpellFavorite(27, 0, 8);
    expect(h.sent.length).toBe(8);
  });
});

describe('ItemShortcutRestorer: the 1999 tray is nine slots', () => {
  function bar(count?: number) {
    const sent: string[] = [];
    const icons = new Map<number, number | undefined>();
    const r = new ItemShortcutRestorer((i, d) => icons.set(i, d), { add: (i, o) => sent.push(`add ${i} ${o}`), remove: (i) => sent.push(`remove ${i}`) });
    if (count !== undefined) r.setSlotCount(count);
    return { r, sent, icons };
  }
  const owned = (id: number) => ({ owned: true, item: { iconDid: 0x06000000 + id, name: `item ${id}` } });

  it('Create Shortcut fills slots 0-8, then "There are no free shortcut slots"; nothing past 8 is sent', () => {
    const { r, sent } = bar(AC1999.shortcutSlots);
    for (let i = 1; i <= 9; i++) expect(r.createShortcutToItem(i, -1, owned(i), false, false)).toBeNull();
    expect(r.createShortcutToItem(10, -1, owned(10), false, false)).toBe(SHORTCUT_NO_FREE_SLOTS_TEXT);
    expect(sent.filter((s) => s.startsWith('add')).map((s) => Number(s.split(' ')[1]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.slotCountInUse).toBe(9);
  });

  it('Quickslot 10-18 find nothing; a restore entry past 8 is ignored; a drop past 8 lands in the tray', () => {
    const { r, sent } = bar(9);
    r.restoreFromDescription([{ index: 3, objectId: 33 }, { index: 12, objectId: 44 }], (id) => ({ iconDid: id, name: `i${id}` }));
    expect(r.objectAt(3)).toBe(33);
    expect(r.objectAt(12)).toBe(0);
    expect(r.slotOf(44)).toBe(-1);
    r.addShortcut(55, 15, owned(55).item, true);
    expect(r.slotOf(55)).toBeLessThan(9);
    expect(sent).toEqual([`add ${r.slotOf(55)} 55`]);
  });

  it('end of retail keeps eighteen', () => {
    const { r } = bar();
    for (let i = 1; i <= 18; i++) expect(r.createShortcutToItem(i, -1, owned(i), false, false)).toBeNull();
    expect(r.objectAt(17)).toBe(18);
    expect(r.createShortcutToItem(19, -1, owned(19), false, false)).toBe(SHORTCUT_NO_FREE_SLOTS_TEXT);
  });

  it('setSlotCount(9) empties a slot past the tray locally without telling the server', () => {
    const { r, sent, icons } = bar();
    r.addShortcut(77, 12, owned(77).item, false);
    r.setSlotCount(9);
    expect(r.objectAt(12)).toBe(0);
    expect(r.slotOf(77)).toBe(-1);
    expect(icons.get(12)).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

/* ── GameUI (happy-dom, no DATs) ────────────────────────────────────── */

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const spell = (id: number, name = `S${id}`) => ({ id, name, school: 1, level: 1, power: 10, manaCost: 10, difficulty: 10, duration: 1800, components: [1], targetType: 0, iconId: 0x06001000 + id, desc: '' });
const page = (...ids: number[]) => { const p: Array<ReturnType<typeof spell> | null> = ids.map((id) => spell(id)); while (p.length < 9) p.push(null); return p; };

describe('GameUI: the shared spell bar in a 1999 world has one tab', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any; let GameUI: any;
  beforeAll(async () => {
    domWindow = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    GameUI = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS as never, saved); });

  function freshUI(tabs?: number) {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new GameUI(container);
    const adds: Array<[number, number, number]> = [];
    const removes: Array<[number, number]> = [];
    ui.setSpellCallbacks({
      onAddSpellFavorite: (s: number, i: number, b: number) => adds.push([s, i, b]),
      onRemoveSpellFavorite: (s: number, b: number) => removes.push([s, b]),
    });
    if (tabs !== undefined) ui.setSpellBarTabCount(tabs);
    return { ui, adds, removes };
  }

  it('a persisted end-of-retail tab (3) falls back to the first tab, and the stored choice is kept for end of retail', () => {
    domWindow.localStorage.clear();
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ activeSpellBarTab: 3 }));
    const { ui } = freshUI(AC1999.spellBarTabs);
    expect(ui.spellBarTabs).toBe(1);
    expect(ui.openSpellBarTabIndex).toBe(0);
    expect(JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1')).activeSpellBarTab).toBe(3);
    // the same storage in an end-of-retail world still opens tab 3
    const eor = freshUI();
    expect(eor.ui.openSpellBarTabIndex).toBe(3);
  });

  it('the Spell Tab keys go nowhere on the one-tab bar (and persist nothing)', () => {
    domWindow.localStorage.clear();
    const { ui } = freshUI(1);
    for (const dir of ['next', 'prev', 'first', 'last'] as const) {
      ui.switchSpellBarTab(dir);
      expect(ui.openSpellBarTabIndex).toBe(0);
    }
    expect(domWindow.localStorage.getItem('ac_options_settings_v1')).toBeNull();
  });

  it('stored favourites on tabs 2-8 are hidden in 1999: only the first tab\'s list shows', () => {
    domWindow.localStorage.clear();
    const { ui } = freshUI(1);
    const known = [spell(10), spell(20), spell(30)];
    ui.setSpellData(known, [page(10), page(20), page(30), page(), page(), page(), page(), page(20)]);
    expect(ui.spellBarTabSpellIds(0)).toEqual([10]);
    for (let t = 1; t < 8; t++) {
      expect(ui.spellBarTabSpellIds(t)).toEqual([]);
      expect(ui.spellBarSlots[t].filter(Boolean)).toEqual([]);
    }
    // the same lists in end of retail all show
    const eor = freshUI();
    eor.ui.setSpellData(known, [page(10), page(20), page(30), page(), page(), page(), page(), page(20)]);
    expect([0, 1, 2, 7].map((t) => eor.ui.spellBarTabSpellIds(t))).toEqual([[10], [20], [30], [20]]);
  });

  it('1999: a drop on a tab past the first adds nothing and sends nothing; the bar itself sends tab 0', () => {
    domWindow.localStorage.clear();
    const { ui, adds, removes } = freshUI(1);
    ui.setSpellData([spell(10), spell(20)], [page(), page(), page(), page(), page(), page(), page(), page()]);
    for (let t = 1; t < 8; t++) ui.dropSpellOnBar(spell(20), -1, t);
    expect(adds).toEqual([]);
    expect(ui.spellBarTabSpellIds(1)).toEqual([]);
    ui.assignSpellToBar(0, 0);
    ui.dropSpellOnBar(spell(20), -1);
    expect(adds.map(([sp, , b]) => [sp, b])).toEqual([[10, 0], [20, 0]]);
    expect(ui.spellBarTabSpellIds(0)).toEqual([10, 20]);
    ui.removeSpellFromBar(10);
    expect(removes).toEqual([[10, 0]]);
    // and the server-bound tab is 0 for every add and removal
    expect([...adds.map((a) => a[2]), ...removes.map((r) => r[1])].every((b) => b === 0)).toBe(true);
  });

  it('end of retail is unchanged: a drop on tab 3\'s label appends there and sends tab 3', () => {
    domWindow.localStorage.clear();
    const { ui, adds } = freshUI();
    ui.setSpellData([spell(10)], [page(), page(), page(), page(), page(), page(), page(), page()]);
    ui.dropSpellOnBar(spell(10), -1, 3);
    expect(adds.map(([sp, , b]) => [sp, b])).toEqual([[10, 3]]);
    expect(ui.spellBarTabSpellIds(3)).toEqual([10]);
    ui.switchSpellBarTab('last');
    expect(ui.openSpellBarTabIndex).toBe(7);
  });
});

/* ── the real spell bar + toolbar over the EoL DATs ─────────────────── */

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

describe.skipIf(!hasDats)('the real LayoutRenderer spell bar and toolbar per era', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any; let make: (tabs: number, slots: number) => any;
  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    const { parseMasterProperty, setMasterPropertyTypes, parseStringTable, registerStringTable } = await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d]) registerStringTable(parseStringTable(langDb.getReader(id)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const { CombatMode } = await import('../packages/shared/src/index.js');
    make = (tabs, slots) => {
      domWindow.localStorage.clear();
      const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
      layoutRenderer.getTextureDataURLWithAlpha = () => null;
      domWindow.document.body.innerHTML = '';
      const container = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(container);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ui: any = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
      ui.setSpellBarTabCount(tabs);
      ui.setItemShortcutSlotCount(slots);
      ui.showGame();
      ui.hudState.combatMode = CombatMode.Magic;
      ui.renderSpellBarPanel();
      return ui;
    };
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS as never, saved); });

  const shownTabs = (ui: { spellBarHandle: { elements: Map<number, HTMLElement> } }) =>
    SPELL_BAR_TAB_IDS.filter((id) => { const el = ui.spellBarHandle.elements.get(id); return el && el.style.display !== 'none'; });

  it('1999: no tab strip at all, one page of cells, one toolbar row that the window can\'t grow past', () => {
    const ui = make(AC1999.spellBarTabs, AC1999.shortcutSlots);
    expect(shownTabs(ui)).toEqual([]);
    expect(ui.spellBarPanelEl.querySelectorAll('[data-spell-slot^="1-"]').length).toBe(0);
    expect(ui.spellBarPanelEl.querySelectorAll('[data-spell-slot^="0-"]').length).toBeGreaterThan(0);
    expect(ui.itemShortcutSlots.length).toBe(9);
    expect(ui.toolbarMaxHeight()).toBe(100);
    ui.refreshSpellBarPanel();
    expect(shownTabs(ui)).toEqual([]);
  });

  it('end of retail: all eight tabs, both toolbar rows (window up to 132)', () => {
    const ui = make(EOR.spellBarTabs, EOR.shortcutSlots);
    expect(shownTabs(ui)).toEqual([...SPELL_BAR_TAB_IDS]);
    expect(ui.spellBarPanelEl.querySelectorAll('[data-spell-slot^="7-"]').length).toBeGreaterThan(0);
    expect(ui.itemShortcutSlots.length).toBe(18);
    expect(ui.toolbarMaxHeight()).toBe(132);
  });
});
