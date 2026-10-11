/**
 * The VirindiTank window's parity pass (docs/vtank-parity-gaps.md §9.2–§9.7,
 * §4.5): the Items tab's Hands column and object ids, the generated
 * [Default] / [By char] profile, CopyTo pasting VTank's save commands, the
 * remote, the status line / Action History / `/vt log`, the meta "?" help, and
 * Show Nav Lines (its option, what it draws, the scene object). Driven through
 * the real window, planners and scene module.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  VT_DAMAGE, VT_DEFAULT_MONSTER, emptyRoutineDoc, validateRoutineDoc, vtCanonicalName, vtItemIs, vtOption,
  type PlanItem, type RoutineDoc, type RoutineProfile, type VtMonsterRow,
} from '../packages/shared/src/routines/index.js';
import type { RoutineStatus } from '../packages/renderer/src/agent/RoutineEngine.js';
import type { MenuItem } from '../packages/renderer/src/ui/automation/AutomationPanel.js';
import type { VTankDialogs, VTankKit, VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';
import { buildCombatFamilies, isTwoHanded, planCombat, type CombatInput } from '../packages/renderer/src/agent/macro/combatPlan.js';
import { gatherLoadout, generateLoadout, type LoadoutInput, type LoadoutItem } from '../packages/renderer/src/agent/macro/defaultLoadout.js';
import { VT_LOG_TYPES, VtActivity, vtLogType, vtStatusText } from '../packages/renderer/src/ui/automation/vtActivity.js';
import { VT_ACTION_HELP, VT_CONDITION_HELP } from '../packages/renderer/src/ui/automation/metaHelp.js';
import { NAV_CURRENT_COLOR, NAV_LINE_COLOR, NavLinesOverlay, navLineSegments, routeNavPoints } from '../packages/renderer/src/scene/NavLines.js';
import { parseMapCoords } from '../packages/renderer/src/agent/AgentApi.js';

type WinModule = typeof import('../packages/renderer/src/ui/automation/VTankWindow.js');
let H: GameUIFixture;
let W: WinModule;
beforeAll(async () => {
  H = await mountGameUI();
  W = await import('../packages/renderer/src/ui/automation/VTankWindow.js');
});
afterAll(() => H.teardown());

let lastMenu: { items: MenuItem[]; pick: (v: string) => void } | null = null;
function fakeKit(): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); return d; };
  return {
    text: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    button: (label, onClick) => div({ button: label }, onClick),
    tab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    check: (on, onChange) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    field: (text, onClick) => { const f = div({ field: text }); f.addEventListener('click', () => onClick(f)); return f; },
    menu: (_a, items, onPick) => { lastMenu = { items, pick: onPick }; },
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (selected, onClick) => div({ selected: selected ? '1' : '0' }, onClick),
    box: () => document.createElement('div'),
    header: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    dot: (lit) => div({ dot: lit ? '1' : '0' }),
    separator: () => document.createElement('hr'),
    scroll: () => {},
    plate: (w, h) => { const d = document.createElement('div'); d.style.width = `${w}px`; d.style.height = `${h}px`; return d; },
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
    icon: (id, _s, onClick) => div({ icon: `0x${id.toString(16)}` }, onClick),
    flatButton: (label, onClick) => div({ button: label }, onClick),
    dropdown: (text, onClick) => { const f = div({ field: text }); f.addEventListener('click', () => onClick(f)); return f; },
    slider: (value) => { const i = document.createElement('input'); i.dataset.slider = String(value); return i; },
    textTab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    list: () => {},
    download: () => {},
  };
}
function pick(field: Element | null, label: string): void {
  if (!field) throw new Error('no field');
  (field as HTMLElement).click();
  const it = lastMenu!.items.find((i) => i.label === label || i.value === label);
  if (!it) throw new Error(`no "${label}" in ${lastMenu!.items.map((i) => i.label).join(', ')}`);
  lastMenu!.pick(it.value);
}

function fakeSource(doc: RoutineDoc) {
  const calls: string[] = [];
  const reports: string[] = [];
  const pasted: string[] = [];
  let status: RoutineStatus = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  const live: Record<string, string | number | boolean> = {};
  const saved: RoutineDoc[] = [];
  let selected: { name: string; kind: string; guid?: number } | null = null;
  let history: string[] = [];
  let loadout: LoadoutInput | null = null;
  let running: RoutineProfile | null = null;
  const source: VTankSource = {
    load: async () => ({ ok: true, doc: structuredClone(doc) }),
    save: async (d) => { const issues = validateRoutineDoc(d); if (issues.length) return { ok: false, message: 'not saved', issues }; saved.push(structuredClone(d)); return { ok: true, doc: structuredClone(d) }; },
    status: () => status,
    stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => running,
    run: (p) => { calls.push(`run ${p.name}`); running = p; status = { ...status, running: true, paused: false, profile: p.name, state: p.initialState, spent: [] }; return { ok: true, message: '' }; },
    pause: () => { calls.push('pause'); status = { ...status, paused: true }; return { ok: true, message: '' }; },
    resume: () => { calls.push('resume'); status = { ...status, paused: false }; return { ok: true, message: '' }; },
    stop: () => { calls.push('stop'); status = { ...status, running: false }; return { ok: true, message: '' }; },
    setModule: () => ({ ok: true, message: '' }),
    resetStats: () => {},
    step: () => ({ ok: true, message: '' }),
    history: () => history,
    report: (text: string) => { reports.push(text); },
    character: () => 'Claude',
    coords: () => '42.1N, 33.6E',
    items: () => [],
    spells: () => [],
    buffs: () => [],
    now: () => 1_700_000_000_000,
    setting: (n) => live[vtCanonicalName(n)],
    setSetting: (n, v) => { calls.push(`set ${n}=${String(v)}`); live[vtCanonicalName(n)] = v; },
    forceBuff: () => { calls.push('force buff'); return { ok: true, message: '' }; },
    cancelForceBuff: () => { calls.push('cancel force buff'); return { ok: true, message: '' }; },
    mexec: () => 'True',
    jump: () => ({ ok: true, message: '' }),
    fakeDeath: () => ({ ok: true, message: '' }),
    reverseRoute: () => ({ ok: true, message: '' }),
    setNearestWaypoint: () => ({ ok: true, message: '' }),
    setState: (n) => { status = { ...status, state: n }; return { ok: true, message: '' }; },
    update: (p) => { calls.push(`update ${p.name}`); running = p; return { ok: true, message: '' }; },
    selection: () => selected,
    pasteChat: (text) => { pasted.push(text); return true; },
    loadout: async () => { if (!loadout) throw new Error('no loadout'); return loadout; },
  };
  return {
    source, calls, reports, pasted, saved, live,
    setStatus: (s: Partial<RoutineStatus>) => { status = { ...status, ...s }; },
    select: (s: typeof selected) => { selected = s; },
    setHistory: (h: string[]) => { history = h; },
    setLoadout: (l: LoadoutInput) => { loadout = l; },
  };
}

const profile = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Hunt', modules: { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false },
  initialState: 'Default', macro: true, ruleFiring: 'once', loot: [], buffSets: [],
  routes: [{ name: 'loop', mode: 'circular', points: ['42.1N, 33.6E', '42.2N, 33.7E', '42.3N, 33.6E'], stops: [{ at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] }] }],
  states: [{ name: 'Default', rules: [] }],
  settings: {},
  ...over,
});
const docWith = (...profiles: RoutineProfile[]): RoutineDoc => ({ ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles });
const texts = (root: Element) => Array.from(root.querySelectorAll('[data-text]')).map((e) => (e as HTMLElement).dataset.text);
const flush = () => new Promise((r) => setTimeout(r, 450));
const q = (root: Element, sel: string) => { const e = root.querySelector(sel); if (!e) throw new Error(`no ${sel}`); return e as HTMLElement; };

async function open(doc = docWith(profile())) {
  const f = fakeSource(doc);
  const windows = new Map<string, { title: string; body: HTMLElement; redraw: () => void }>();
  const mainShown: boolean[] = [];
  const host: VTankDialogs = {
    open: () => {},
    close: () => {},
    window: (key, title, _w, _h, draw) => {
      const body = document.createElement('div');
      const d = { title, body, redraw: () => {} };
      d.redraw = () => draw(body, d.redraw, () => { windows.delete(key); });
      windows.set(key, d);
      d.redraw();
    },
    closeWindow: (key) => { windows.delete(key); },
    showMain: (on) => { mainShown.push(on); },
  };
  const win = new W.VTankWindow(fakeKit(), f.source, host);
  const body = document.createElement('div');
  const redraw = () => win.render(body, 794, 189, redraw);
  await win.load(redraw);
  const show = (tab: string) => q(body, `[data-vtank-tab="${tab}"]`).click();
  return { ...f, win, body, redraw, windows, mainShown, show };
}

describe('§9.2 the Items tab: Hands, a name click removes, two same-named weapons', () => {
  it('Hands cycles blank (Auto) → 1-Handed → 2-Handed → blank; a name click removes the row; (no buffs) follows the name', async () => {
    const t = await open();
    t.show('items');
    expect(texts(t.body)).toContain('Hands');
    t.select({ name: 'Greataxe', kind: 'item', guid: 0x50000001 });
    q(t.body, '[data-vtank="add-item"]').click();
    t.select({ name: 'Kite Shield', kind: 'item', guid: 0x50000002 });
    q(t.body, '[data-vtank="add-item-nobuffs"]').click();
    expect(texts(t.body)).toEqual(expect.arrayContaining(['Greataxe', 'Kite Shield  (no buffs)']));
    // VTank's lists have no delete buttons.
    expect(t.body.querySelector('[data-vtank-list="items"] [data-icon]')).toBeNull();
    const hands = () => q(t.body, '[data-vtank-hands="0"]');
    expect(hands().textContent).toBe('');
    hands().click();
    expect(hands().textContent).toBe('1-Handed');
    hands().click();
    expect(hands().textContent).toBe('2-Handed');
    expect(t.win.profile()!.vtank!.items[0]).toEqual({ name: 'Greataxe', id: 0x50000001, hands: 2 });
    hands().click();
    expect(hands().textContent).toBe('');
    expect(t.win.profile()!.vtank!.items[0].hands).toBeUndefined();
    q(t.body, '[data-vtank-row="items#1"] [data-vtank-remove]').click();
    await flush();
    expect(t.saved.at(-1)!.profiles[0].vtank!.items).toEqual([{ name: 'Greataxe', id: 0x50000001 }]);
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });

  it('two weapons of one name are two rows, kept by object id; the Monsters Weapon steps through each; removing one puts its rows back to <AUTO>', async () => {
    const t = await open();
    t.show('items');
    t.select({ name: 'Longsword', kind: 'item', guid: 0x50000010 });
    q(t.body, '[data-vtank="add-item"]').click();
    q(t.body, '[data-vtank="add-item"]').click(); // the same one again: no second row
    t.select({ name: 'Longsword', kind: 'item', guid: 0x50000011 });
    q(t.body, '[data-vtank="add-item"]').click();
    expect(t.win.profile()!.vtank!.items).toEqual([{ name: 'Longsword', id: 0x50000010 }, { name: 'Longsword', id: 0x50000011 }]);
    t.show('monsters');
    const weapon = () => q(t.body, '[data-vtank-monster="0"] [data-vtank-cycle="weapon"]');
    weapon().click();
    expect(t.win.profile()!.vtank!.monsters[0]).toMatchObject({ weapon: 'Longsword', weaponId: 0x50000010 });
    weapon().click();
    expect(t.win.profile()!.vtank!.monsters[0]).toMatchObject({ weapon: 'Longsword', weaponId: 0x50000011 });
    weapon().click();
    expect(t.win.profile()!.vtank!.monsters[0].weapon).toBeNull();
    expect(t.win.profile()!.vtank!.monsters[0].weaponId).toBeUndefined();
    weapon().click();
    weapon().click(); // the second Longsword
    t.show('items');
    q(t.body, '[data-vtank-row="items#1"] [data-vtank-remove]').click();
    expect(t.win.profile()!.vtank!.monsters[0].weapon).toBeNull();
    expect(t.win.profile()!.vtank!.monsters[0].weaponId).toBeUndefined();
    await flush();
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });

  it('vtItemIs: an entry with an id is that object only; one without matches by name (older profiles, imports)', () => {
    expect(vtItemIs({ name: 'Longsword', id: 7 }, { guid: 7, name: 'Longsword' })).toBe(true);
    expect(vtItemIs({ name: 'Longsword', id: 7 }, { guid: 8, name: 'Longsword' })).toBe(false);
    expect(vtItemIs({ name: 'Longsword' }, { guid: 8, name: 'longsword' })).toBe(true);
  });

  it('a document with a bad id or Hands is refused by name', () => {
    const p = profile({ vtank: { monsters: [{ ...structuredClone(VT_DEFAULT_MONSTER), weaponId: -1 }], items: [{ name: 'X', id: -3, hands: 3 as 1 }], consumables: [], excludedScarabs: [], extraBuffs: [], blacklistedBuffs: [] } });
    expect(validateRoutineDoc(docWith(p)).map((i) => i.path)).toEqual(['profiles[0].vtank.items[0].id', 'profiles[0].vtank.items[0].hands', 'profiles[0].vtank.monsters[0].weaponId']);
  });
});

describe('§9.2 the combat planner: same-named weapons by id, and Hands', () => {
  const FAM = buildCombatFamilies({ spells: new Map() });
  const fire: PlanItem = { guid: 11, name: 'Longsword', itemType: 0x1, ints: { 45: 0x10 } };
  const cold: PlanItem = { guid: 12, name: 'Longsword', itemType: 0x1, ints: { 45: 0x8 } };
  const shield: PlanItem = { guid: 13, name: 'Kite Shield', itemType: 0x2, fits: 'Shield' };
  const great: PlanItem = { guid: 14, name: 'Greataxe', itemType: 0x1, fits: 'MeleeWeapon+TwoHanded' };
  const row = (extra: Partial<VtMonsterRow>): VtMonsterRow => ({ ...structuredClone(VT_DEFAULT_MONSTER), on: ['A'], damage: VT_DAMAGE.Slash, ...extra });
  const input = (over: Partial<CombatInput>): CombatInput => ({
    monsters: [{ guid: 1, name: 'Drudge Skulker', dist: 3, relBearing: 0 }], rows: [row({})], spells: [], skills: [], items: [], itemNames: [],
    wielded: {}, stance: 'melee', settings: { AttackDistance: 30 }, castLog: [], now: 1000, selectedGuid: null, families: FAM, ...over,
  });

  it('the row\'s Weapon by id: the cold Longsword is wielded even while its fire twin is in hand', () => {
    const i = input({ rows: [row({ weapon: 'Longsword', weaponId: 12 })], items: [{ ...fire, equipped: true }, cold], wielded: { weapon: 'Longsword' } });
    expect(planCombat(i)).toMatchObject({ kind: 'equip', item: { guid: 12 } });
    // With the cold one in hand there is nothing to swap: the attack goes out.
    const j = input({ rows: [row({ weapon: 'Longsword', weaponId: 12 })], items: [fire, { ...cold, equipped: true }], wielded: { weapon: 'Longsword' } });
    expect(planCombat(j)).toMatchObject({ kind: 'attack', target: 1 });
  });

  it('a two-handed weapon (its TwoHanded slot, or Hands 2) takes no offhand; Hands 1 lets one in', () => {
    const base = { rows: [row({ weapon: 'Greataxe', offhand: 'Kite Shield' })], items: [{ ...great, equipped: true }, shield], wielded: { weapon: 'Greataxe' } };
    expect(planCombat(input(base))).toMatchObject({ kind: 'attack' });
    expect(planCombat(input({ ...base, hands: (it) => (it.guid === 14 ? 1 : undefined) }))).toMatchObject({ kind: 'equip', item: { name: 'Kite Shield' } });
    const one = { rows: [row({ weapon: 'Longsword', weaponId: 11, offhand: 'Kite Shield' })], items: [{ ...fire, equipped: true }, shield], wielded: { weapon: 'Longsword' } };
    expect(planCombat(input(one))).toMatchObject({ kind: 'equip', item: { name: 'Kite Shield' } });
    expect(planCombat(input({ ...one, hands: (it) => (it.guid === 11 ? 2 : undefined) }))).toMatchObject({ kind: 'attack' });
    expect(isTwoHanded({}, great)).toBe(true);
    expect(isTwoHanded({}, fire)).toBe(false);
  });
});

describe('§9.3 the generated [Default] / [By char] profile', () => {
  const skill = (id: number, name: string, training: 'untrained' | 'trained' | 'specialized' = 'trained') => ({ id, name, training, base: 100, buffed: 100 });
  const carried: LoadoutItem[] = [
    { guid: 1, name: 'Fire Longsword', itemType: 0x1, ints: { 48: 45 } }, // Light Weapons: trained
    { guid: 2, name: 'Heavy Axe', itemType: 0x1, ints: { 48: 44 } }, // Heavy Weapons: untrained
    { guid: 3, name: 'Yumi', itemType: 0x100, ints: { 48: 47 } }, // Missile Weapons: trained
    { guid: 4, name: 'Frost Wand', itemType: 0x8000 },
    { guid: 5, name: 'Healing Kit', itemType: 0x80, flags: 0x10000 },
    { guid: 6, name: 'Apple', itemType: 0x20, ints: { 89: 4 } },
    { guid: 7, name: 'Burning Coals', itemType: 0x20, ints: { 89: 2 } },
    { guid: 8, name: 'Moderate Mana Stone', itemType: 0x80000 },
    { guid: 9, name: 'Ash Gromnie Essence (50)', itemType: 0x80, ints: { 266: 1, 362: 1 } }, // Primalist: yours
    { guid: 10, name: 'Wasp Essence (50)', itemType: 0x80, ints: { 266: 2, 362: 2 } }, // Necromancer: not yours
    { guid: 11, name: 'Dagger', itemType: 0x1 }, // not examined
    { guid: 12, name: 'Ale', itemType: 0x20, ints: { 89: 0 } }, // restores no vital
  ];
  const skills = [skill(45, 'Light Weapons'), skill(44, 'Heavy Weapons', 'untrained'), skill(47, 'Missile Weapons', 'specialized'), skill(34, 'War Magic'), skill(54, 'Summoning')];

  it('weapons with their skill trained, casters (a school trained), pets of your mastery; kits, vital foods (not Burning Coals), mana stones', () => {
    const l = generateLoadout({ items: carried, skills, mastery: 1 });
    expect(l.items).toEqual([
      { name: 'Fire Longsword', id: 1 }, { name: 'Yumi', id: 3 }, { name: 'Frost Wand', id: 4 }, { name: 'Ash Gromnie Essence (50)', id: 9, noBuffs: true },
    ]);
    expect(l.consumables).toEqual(['Healing Kit', 'Apple', 'Moderate Mana Stone']);
    expect(l.unexamined).toEqual(['Dagger']);
  });

  it('an era without Summoning (Dark Majesty, 1999) or no school trained adds no pets / casters', () => {
    const l = generateLoadout({ items: carried, skills: [skill(45, 'Light Weapons')], mastery: 1 });
    expect(l.items.map((x) => x.name)).toEqual(['Fire Longsword']);
  });

  it('gatherLoadout examines weapons, foods and essences not yet examined (a few at a time), and waits for the answers', async () => {
    const answers = new Map<number, Record<number, number>>();
    const asked: number[] = [];
    const inv = [
      { guid: 1, name: 'Longsword', itemType: 0x1 }, { guid: 2, name: 'Apple', itemType: 0x20 }, { guid: 3, name: 'Wand', itemType: 0x8000 },
      { guid: 4, name: 'Ash Gromnie Essence', itemType: 0x80 }, { guid: 5, name: 'Pyreal', itemType: 0x40 },
    ];
    const got = await gatherLoadout({
      inventory: () => inv,
      examined: (g) => answers.get(g) ?? null,
      examine: (g) => { asked.push(g); answers.set(g, g === 1 ? { 48: 45 } : g === 2 ? { 89: 2 } : { 266: 1 }); },
      skills: () => [skill(45, 'Light Weapons')],
      mastery: () => 1,
      sleep: async () => {},
    }, 1000);
    expect(asked).toEqual([1, 2, 4]);
    expect(got.items.find((i) => i.guid === 1)?.ints).toEqual({ 48: 45 });
    expect(generateLoadout(got).items.map((i) => i.name)).toEqual(['Longsword']);
  });

  it('Macro Settings offers [Default] and [By char]; [Default] is made from what you carry each time; [By char] is this character\'s, Mine only on', async () => {
    const t = await open();
    t.setLoadout({ items: carried, skills, mastery: 1 });
    t.show('profiles');
    q(t.body, '[data-vtank="macro-profile"]').click();
    expect(lastMenu!.items.map((i) => i.label)).toEqual(['[Default]', '[By char]', 'Hunt']);
    pick(q(t.body, '[data-vtank="macro-profile"]'), '[Default]');
    await flush();
    expect(q(t.body, '[data-vtank="macro-profile"]').dataset.field).toBe('[Default]');
    const d = t.win.profile()!;
    expect(d.vtank!.items.map((x) => x.name)).toEqual(['Fire Longsword', 'Yumi', 'Frost Wand', 'Ash Gromnie Essence (50)']);
    expect(d.vtank!.consumables).toEqual(['Healing Kit', 'Apple', 'Moderate Mana Stone']);
    expect(t.reports).toContain('[Default]: not examined in time, so left out: Dagger.');
    pick(q(t.body, '[data-vtank="macro-profile"]'), '[By char]');
    await flush();
    expect(q(t.body, '[data-vtank="macro-profile"]').dataset.field).toBe('[By char]');
    const doc = t.saved.at(-1)!;
    expect(doc.profiles.map((p) => p.name)).toEqual(['Hunt', '[Default]', '[By char] Claude']);
    expect(doc.characters).toEqual({ Claude: '[By char] Claude' });
    expect(validateRoutineDoc(doc)).toEqual([]);
    // [By char] once made is kept (edits stay); choosing it again loads it as it is.
    t.win.profile()!.vtank!.consumables = ['Apple'];
    pick(q(t.body, '[data-vtank="macro-profile"]'), 'Hunt');
    pick(q(t.body, '[data-vtank="macro-profile"]'), '[By char]');
    await flush();
    expect(t.win.profile()!.vtank!.consumables).toEqual(['Apple']);
  });
});

describe('§9.4 CopyTo pastes VTank\'s save commands into the chat box', () => {
  it('Macro Settings: /vt settings save (Mine only: savechar); Auto-Navigation: /vt nav save; Meta: /vt meta save', async () => {
    const t = await open();
    t.show('profiles');
    q(t.body, '[data-vtank="copy-profile"]').click();
    q(t.body, '[data-vtank="mine-only"] [data-check]').click();
    q(t.body, '[data-vtank="copy-profile"]').click();
    q(t.body, '[data-vtank="copy-nav"]').click();
    q(t.body, '[data-vtank="copy-meta"]').click();
    expect(t.pasted).toEqual(['/vt settings save ', '/vt settings savechar ', '/vt nav save ', '/vt meta save ']);
  });

  it('with [None] loaded, the pasted /vt nav save makes a new empty route ("[None], CopyTo, name it"); with .nav the file comes too', async () => {
    const t = await open();
    t.show('profiles');
    pick(q(t.body, '[data-vtank="nav-profile"]'), '[None]');
    expect(await t.win.command('/vt nav save runback')).toEqual(['nav saved as "runback"']);
    expect(t.win.profile()!.routes.map((r) => [r.name, r.points.length])).toEqual([['loop', 3], ['runback', 0]]);
    expect(t.win.profile()!.navRoute).toBe('runback');
  });

  it('no chat box: says what to type', async () => {
    const t = await open();
    delete (t.source as Partial<VTankSource>).pasteChat;
    t.show('profiles');
    q(t.body, '[data-vtank="copy-nav"]').click();
    expect(texts(t.body)).toContain('Type /vt nav save <name> in chat.');
  });
});

describe('§9.5 the remote', () => {
  it('Options → Remote swaps the main window for the remote; its switches set the same options; F / CF; FC follows the selected player; M brings the main window back', async () => {
    const t = await open();
    q(t.body, '[data-vtank="remote"]').click();
    expect(t.mainShown).toEqual([false]);
    const r = t.windows.get('remote')!;
    expect(texts(r.body).slice(0, 8)).toEqual(['On', 'Meta', 'Buff', 'Combat', 'Navigate', 'Loot', 'Follow corners', 'Target lock']);
    expect(q(r.body, '[data-vtank-remote-switch="FollowAroundCorners"]').dataset.on).toBe('1'); // VTank's default
    q(r.body, '[data-vtank-remote-switch="TargetLock"] [data-check]').click();
    q(r.body, '[data-vtank-remote-switch="EnableNav"] [data-check]').click();
    expect(q(r.body, '[data-vtank-remote-switch="TargetLock"]').dataset.on).toBe('1');
    expect(t.win.profile()!.settings).toMatchObject({ TargetLock: true, EnableNav: true });
    q(r.body, '[data-vtank-remote-switch="RunMacro"] [data-check]').click();
    expect(t.calls).toContain('run Hunt');
    expect(q(r.body, '[data-vtank-remote-switch="RunMacro"]').dataset.on).toBe('1');
    q(r.body, '[data-vtank="remote-force-buff"]').click();
    q(r.body, '[data-vtank="remote-cancel-force-buff"]').click();
    expect(t.calls).toEqual(expect.arrayContaining(['force buff', 'cancel force buff']));
    q(r.body, '[data-vtank="remote-follow"]').click();
    expect(texts(r.body)).toContain('Select the player to follow first.');
    t.select({ name: 'Leader', kind: 'player' });
    q(r.body, '[data-vtank="remote-follow"]').click();
    const p = t.win.profile()!;
    expect(p.navRoute).toBe('[Follow]');
    expect(p.routes.find((x) => x.name === '[Follow]')).toEqual({ name: '[Follow]', mode: 'follow', follow: 'Leader', points: [] });
    expect(p.routes.map((x) => x.name)).toEqual(['loop', '[Follow]']);
    q(r.body, '[data-vtank="remote-main"]').click();
    expect(t.windows.has('remote')).toBe(false);
    expect(t.mainShown).toEqual([false, true]);
    await flush();
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });
});

describe('§9.6 the status line, the Action History and /vt log', () => {
  it('vtStatusText and vtLogType sort as VTank\'s types', () => {
    const st: RoutineStatus = { running: true, paused: false, profile: 'Hunt', state: 'Default', acting: 'buff: Strength Self VI', last: [] };
    expect(vtStatusText(st, true)).toBe('Macro: buff: Strength Self VI');
    expect(vtStatusText({ ...st, paused: true }, true)).toBe('Macro: Paused.');
    expect(vtStatusText({ ...st, acting: null }, true)).toBe('Macro: Running.');
    expect(vtStatusText(st, false)).toBe('Macro: Stopped.');
    expect(vtLogType('12:00:01 combat: V on Drudge Skulker: You cast Fire Vulnerability Other VI on Drudge Skulker')).toBe('DebuffChoice');
    expect(vtLogType('12:00:01 buff: Strength Self VI: You cast Strength Self VI')).toBe('SpellCast');
    expect(vtLogType('12:00:01 combat: bolt at Drudge Skulker: ok')).toBe('SpellCast');
    expect(vtLogType('12:00:01 salvage Iron Sword: done')).toBe('SalvageList');
    expect(vtLogType('12:00:01 loot Drudge corpse: took Pyreals')).toBe('Loot');
    expect(vtLogType('12:00:01 state set to dead')).toBe('RuleInfo');
    expect(vtLogType('12:00:01 something else')).toBe('Misc');
    expect(VT_LOG_TYPES).toEqual(['ActiveRule', 'SalvageList', 'SpellCast', 'RuleInfo', 'Timers', 'CastInfo', 'DebuffChoice', 'Loot', 'CharProps', 'Misc']);
  });

  it('the history writes a status once, takes the engine\'s new lines, keeps 1000; /vt log prints the logged types\' lines', () => {
    const a = new VtActivity(() => new Date(2026, 9, 11, 9, 5, 7));
    const out: string[] = [];
    const st: RoutineStatus = { running: true, paused: false, profile: 'Hunt', state: 'Default', acting: null, last: [] };
    a.observe(st, true, ['09:05:01 started "Hunt"'], (l) => out.push(l));
    a.observe(st, true, ['09:05:01 started "Hunt"'], (l) => out.push(l));
    expect(a.lines).toEqual(['[09:05:07] Macro: Running.', '[09:05:01] started "Hunt"']);
    expect(a.command([])).toEqual(['Not currently logging.', `Log types: ${VT_LOG_TYPES.join(' ')}`]);
    expect(a.command(['spellcast', 'on'])).toEqual(['Set SpellCast']);
    expect(a.command(['ActiveRule', 'ON'])).toEqual(['Set ActiveRule']);
    expect(a.command(['Frob', 'on'])[0]).toMatch(/^Unknown log type "Frob"/);
    expect(a.command(['SpellCast'])).toEqual(['Syntax: /vt log [type] [on/off]']);
    expect(a.command([])[0]).toBe('Log state: ActiveRule SpellCast');
    a.observe({ ...st, acting: 'buff: Strength Self VI' }, true, ['09:05:01 started "Hunt"', '09:05:06 buff: Strength Self VI: You cast Strength Self VI', '09:05:06 loot corpse: nothing'], (l) => out.push(l));
    expect(out).toEqual(['[VT log ActiveRule] buff: Strength Self VI', '[VT log SpellCast] buff: Strength Self VI: You cast Strength Self VI']);
    expect(a.command(['spellcast', 'off'])).toEqual(['Reset SpellCast']);
    for (let i = 0; i < 1100; i++) a.record(`status ${i}`);
    expect(a.lines).toHaveLength(1000);
    expect(a.lines.at(-1)).toBe('[09:05:07] status 1099');
    a.clear();
    expect(a.lines).toEqual([]);
  });

  it('the window: the Options tab\'s status line, History opens the Action History (Current, the list, Clear), /vt log answers', async () => {
    const t = await open();
    expect(q(t.body, '[data-vtank="status"]').textContent).toBe('Macro: Stopped.');
    q(t.body, '[data-vtank-option="EnableCombat"] [data-check]').click();
    q(t.body, '[data-vtank="run-macro"] [data-check]').click();
    t.setStatus({ acting: 'combat: default p1' });
    t.setHistory(['10:00:00 combat: default p1: attacking']);
    t.win.observe();
    t.redraw();
    expect(q(t.body, '[data-vtank="status"]').textContent).toBe('Macro: combat: default p1');
    q(t.body, '[data-vtank="history"]').click();
    const h = t.windows.get('history')!;
    expect(h.title).toBe('Action History');
    expect(q(h.body, '[data-vtank="history-current"]').textContent).toBe('Macro: combat: default p1');
    expect(texts(h.body)).toContain('[10:00:00] combat: default p1: attacking');
    q(h.body, '[data-vtank="history-clear"]').click();
    expect(texts(h.body).filter((x) => x?.startsWith('['))).toEqual([]);
    expect(await t.win.command('/vt log misc on')).toEqual(['Set Misc']);
    t.setHistory(['10:00:00 combat: default p1: attacking', '10:00:02 something odd']);
    t.win.observe();
    expect(t.reports).toContain('[VT log Misc] something odd');
  });

  it('GameUI watches the run on its tick with the old panel closed, and hosts the History and remote windows', async () => {
    const ui = H.ui as unknown as { setAutomationSource(s: VTankSource | null): void; toggleAutomationWindow(): void; automationWindowOpen: boolean; tickAutomation(): void };
    const f = fakeSource(docWith(profile()));
    ui.setAutomationSource(f.source);
    ui.toggleAutomationWindow();
    await new Promise((r) => setTimeout(r, 0));
    let win = H.container.querySelector('[data-vtank-window]') as HTMLElement;
    // The engine's lines are this profile's while it runs.
    f.setStatus({ running: true, profile: 'Hunt' });
    f.setHistory(['11:00:00 something happened']);
    ui.tickAutomation();
    q(win, '[data-vtank="history"]').click();
    const hist = H.container.querySelector('[data-vtank-aux="history"]') as HTMLElement;
    expect(hist.textContent).toContain('Action History');
    expect(hist.textContent).toContain('[11:00:00] something happened');
    q(win, '[data-vtank="remote"]').click();
    expect(ui.automationWindowOpen).toBe(false);
    const remote = H.container.querySelector('[data-vtank-aux="remote"]') as HTMLElement;
    expect(remote).not.toBeNull();
    q(remote, '[data-vtank="remote-main"]').click();
    expect(ui.automationWindowOpen).toBe(true);
    expect(H.container.querySelector('[data-vtank-aux="remote"]')).toBeNull();
    win = H.container.querySelector('[data-vtank-window]') as HTMLElement;
    expect(win).not.toBeNull();
    ui.setAutomationSource(null);
    expect(H.container.querySelector('[data-vtank-aux]')).toBeNull();
  });
});

describe('§9.7 the meta "?" help and the Show Nav Lines switch', () => {
  it('Edit Meta Rule\'s "?" buttons show VTank\'s own description of the chosen condition / action', async () => {
    const f = fakeSource(docWith(profile({ states: [{ name: 'Default', rules: [{ label: 'r', when: [{ kind: 'died' }], do: [{ kind: 'set-state', state: 'dead' }] }, ] }, { name: 'dead', rules: [] }] })));
    const dialogs: Array<{ body: HTMLElement; redraw: () => void }> = [];
    const win = new W.VTankWindow(fakeKit(), f.source, {
      open: (_t, _w, _h, draw) => { const body = document.createElement('div'); const d = { body, redraw: () => {} }; d.redraw = () => draw(body, d.redraw, () => {}); dialogs.push(d); d.redraw(); },
      close: () => {},
    });
    await win.load(() => {});
    win.editRule('Default', 0, () => {});
    const d = dialogs[0];
    expect(d.body.querySelector('[data-vtank="rule-help"]')).toBeNull();
    q(d.body, '[data-vtank="condition-help"]').click();
    expect(q(d.body, '[data-vtank="rule-help"]').textContent).toBe('Character Death: Act upon Character Death.');
    q(d.body, '[data-vtank="action-help"]').click();
    expect(q(d.body, '[data-vtank="rule-help"]').textContent).toBe('Set Meta State: Allows you to set/change Meta state after X Action has occurred.');
    q(d.body, '[data-vtank="action-help"]').click();
    expect(d.body.querySelector('[data-vtank="rule-help"]')).toBeNull();
  });

  it('every condition and action in the menus has its help line', () => {
    for (const c of W.VT_CONDITIONS) expect(VT_CONDITION_HELP[c.label], c.label).toBeTruthy();
    for (const a of W.VT_ACTIONS) expect(VT_ACTION_HELP[a.label], a.label).toBeTruthy();
  });

  it('Show Nav Lines: an engine option, off by default, on the Options tab under Cast Dispel Self; on, the window hands over the loaded route', async () => {
    expect(vtOption('shownavlines')).toMatchObject({ name: 'ShowNavLines', default: false, engine: true, label: 'Show Nav Lines' });
    const t = await open(docWith(profile({ navRoute: 'loop', settings: { NavCloseStopRange: 3 } })));
    expect(W.VT_OPTIONS_LAYOUT.find((l) => l.name === 'ShowNavLines')).toEqual({ name: 'ShowNavLines', kind: 'check', x: 228, y: 89 });
    expect(t.win.navLinesRoute()).toBeNull();
    q(t.body, '[data-vtank-option="ShowNavLines"] [data-check]').click();
    expect(t.win.navLinesRoute()).toMatchObject({ route: { name: 'loop' }, current: -1, radius: 3 });
    // Running, it is the route the macro walks and the point it walks to next.
    q(t.body, '[data-vtank="run-macro"] [data-check]').click();
    t.setStatus({ nav: { route: 'loop', point: 2, done: false } });
    expect(t.win.navLinesRoute()).toMatchObject({ route: { name: 'loop' }, current: 2 });
  });
});

describe('§4.5 Show Nav Lines in the world (scene/NavLines.ts)', () => {
  const pts = [{ x: 0, z: 0, y: 10 }, { x: 10, z: 0, y: 10, noLegOut: true }, { x: 10, z: 10, y: null }];
  const flat = () => 2;

  it('a 24-segment ring round each point, legs between them (none out of a recall / portal / jump point), circular closing back; the current point green', () => {
    const { positions, colors } = navLineSegments({ points: pts, circular: true, current: 2, radius: 3, outdoor: false }, flat);
    const segs = positions.length / 6;
    // 3 rings × 24, then legs 0→1 and 2→0 (none out of point 1).
    expect(segs).toBe(3 * 24 + 2);
    // The ring of point 0 sits 5 cm over its height, radius 3.
    expect(positions.slice(0, 3)).toEqual([3, 10.05, 0]);
    // Point 2 has no height: the ground's (2) plus the lift. (Ring 0, leg 0→1, ring 1, then ring 2 at segment 49.)
    const ring2 = positions.slice(49 * 6, 49 * 6 + 3);
    expect(ring2[1]).toBeCloseTo(2.05, 5);
    const rgb = (c: number) => [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255];
    expect(colors.slice(0, 3)).toEqual(rgb(NAV_LINE_COLOR));
    expect(colors.slice(49 * 6, 49 * 6 + 3)).toEqual(rgb(NAV_CURRENT_COLOR));
    expect(colors.slice(24 * 6, 24 * 6 + 3)).toEqual(rgb(NAV_LINE_COLOR)); // the leg
    const linear = navLineSegments({ points: pts, circular: false, current: -1, radius: 0, outdoor: false }, flat);
    expect(linear.positions.length / 6).toBe(3 * 24 + 1);
    // Outdoors a leg follows the ground in steps of at most 4 m.
    const out = navLineSegments({ points: [{ x: 0, z: 0, y: null }, { x: 20, z: 0, y: null }], circular: false, current: -1, radius: 1, outdoor: true }, flat);
    expect(out.positions.length / 6).toBe(2 * 24 + 5);
  });

  it('routeNavPoints: map coordinates to the world, VTank heights (×240), no leg out of a recall or a portal', () => {
    const route = { points: ['42.1N, 33.6E', '42.2N, 33.7E', '42.3N, 33.6E'], z: [0.1, null, 0.2], stops: [{ at: 1, do: [{ kind: 'cast' }] }, { at: 2, do: [{ kind: 'use-object', vt: { objectClass: 14 } }] }] };
    const p = routeNavPoints(route, parseMapCoords, (x, y) => ({ x: x - 100, z: y - 200 }));
    const g = parseMapCoords('42.1N, 33.6E')!;
    expect(p[0]).toEqual({ x: g.x - 100, z: g.y - 200, y: 24 });
    expect(p[1]).toMatchObject({ y: null, noLegOut: true });
    expect(p[2]).toMatchObject({ y: 48, noLegOut: true });
  });

  it('one line object: added when there is a route, rebuilt only when it changes, taken out with none', () => {
    const scene = new THREE.Scene();
    const o = new NavLinesOverlay(scene);
    o.update(null, flat);
    expect(scene.children).toHaveLength(0);
    const route = { points: pts, circular: true, current: 0, radius: 2, outdoor: false };
    o.update(route, flat);
    expect(scene.children).toEqual([o.object]);
    expect(o.rebuilt).toBe(true);
    expect((o.object.geometry.getAttribute('position') as THREE.BufferAttribute).count).toBe((3 * 24 + 2) * 2);
    o.update({ ...route, points: [...pts] }, flat);
    expect(o.rebuilt).toBe(false);
    o.update({ ...route, current: 1 }, flat);
    expect(o.rebuilt).toBe(true);
    o.update(null, flat);
    expect(scene.children).toHaveLength(0);
    o.dispose();
  });
});
