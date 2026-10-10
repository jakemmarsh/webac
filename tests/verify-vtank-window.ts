/**
 * AGENT.vtank-window — the VirindiTank-style automation window
 * (ui/automation/VTankWindow.ts) over a fake kit and source, then hosted by
 * the real GameUI: VTank's tabs and controls, its option names and units, its
 * Meta list and Edit Meta Rule, its Route tab, and live changes to the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  VT_OPTIONS, emptyRoutineDoc, importVTank, validateRoutineDoc, vtCanonicalName, vtFromVTank, vtOption, vtToVTank,
  type RoutineDoc, type RoutineProfile,
} from '../packages/shared/src/routines/index.js';
import type { RoutineStatus } from '../packages/renderer/src/agent/RoutineEngine.js';
import type { MenuItem } from '../packages/renderer/src/ui/automation/AutomationPanel.js';
import type { VTankDialogs, VTankKit, VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';

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
    slider: (value, _min, _max, _w, onChange) => { const i = document.createElement('input'); i.dataset.slider = String(value); i.addEventListener('change', () => onChange(Number(i.value))); return i; },
    textTab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    list: () => {},
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
  let status: RoutineStatus = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  const live: Record<string, string | number | boolean> = {};
  const saved: RoutineDoc[] = [];
  let selected: { name: string; kind: string } | null = null;
  let coords: string | null = '42.1N, 33.6E';
  const source: VTankSource = {
    load: async () => ({ ok: true, doc: structuredClone(doc) }),
    save: async (d) => { const issues = validateRoutineDoc(d); if (issues.length) return { ok: false, message: 'not saved', issues }; saved.push(structuredClone(d)); return { ok: true, doc: structuredClone(d) }; },
    status: () => status,
    stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null,
    run: (p) => { calls.push(`run ${p.name}`); status = { ...status, running: true, paused: false, profile: p.name, state: p.initialState, spent: [] }; return { ok: true, message: '' }; },
    pause: () => { calls.push('pause'); status = { ...status, paused: true }; return { ok: true, message: '' }; },
    resume: () => { calls.push('resume'); status = { ...status, paused: false }; return { ok: true, message: '' }; },
    stop: () => { calls.push('stop'); status = { ...status, running: false }; return { ok: true, message: '' }; },
    setModule: () => ({ ok: true, message: '' }),
    resetStats: () => {},
    step: () => ({ ok: true, message: '' }),
    history: () => [],
    report: () => {},
    character: () => 'Claude',
    coords: () => coords,
    items: () => [],
    spells: () => [],
    buffs: () => [],
    now: () => 1_700_000_000_000,
    setting: (n) => live[vtCanonicalName(n)],
    setSetting: (n, v) => { calls.push(`set ${n}=${String(v)}`); live[vtCanonicalName(n)] = v; },
    forceBuff: () => { calls.push('force buff'); return { ok: true, message: '' }; },
    mexec: (e) => { calls.push(`mexec ${e}`); return 'True'; },
    jump: (o) => { calls.push(`jump ${JSON.stringify(o)}`); return { ok: true, message: 'jumped' }; },
    fakeDeath: () => { calls.push('fake death'); return { ok: true, message: 'fake death' }; },
    reverseRoute: () => { calls.push('reverse'); return { ok: true, message: 'reversed' }; },
    setWaypoint: (i) => { calls.push(`waypoint ${i}`); status = { ...status, nav: { route: 'runback', point: i, done: false } }; return { ok: true, message: '' }; },
    cancelForceBuff: () => { calls.push('cancel force buff'); return { ok: true, message: '' }; },
    setState: (n) => { calls.push(`state ${n}`); status = { ...status, state: n }; return { ok: true, message: '' }; },
    update: (p) => { calls.push(`update ${p.name}`); return { ok: true, message: '' }; },
    selection: () => selected,
  };
  return { source, calls, saved, live, setStatus: (s: Partial<RoutineStatus>) => { status = { ...status, ...s }; }, select: (s: typeof selected) => { selected = s; }, setCoords: (c: string | null) => { coords = c; } };
}

const meta = (): RoutineProfile => ({
  name: 'Runback', modules: { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false },
  initialState: 'Default', macro: true, ruleFiring: 'once', loot: [], buffSets: [],
  routes: [{ name: 'runback', mode: 'once', points: ['42.1N, 33.6E', '42.2N, 33.7E'], stops: [{ at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] }] }],
  states: [
    { name: 'Default', rules: [{ label: 'Rule 1', when: [{ kind: 'died' }], do: [{ kind: 'set-state', state: 'dead' }] }] },
    { name: 'dead', rules: [
      { label: 'Rule 2', when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'runback' }] },
      { label: 'Rule 3', when: [{ kind: 'route-done' }], do: [{ kind: 'set-state', state: 'back' }] },
    ] },
    { name: 'back', rules: [{ label: 'Rule 4', when: [{ kind: 'always' }], do: [{ kind: 'set-setting', name: 'EnableCombat', value: true }, { kind: 'set-state', state: 'Default' }] }] },
  ],
  settings: { EnableCombat: true, EnableNav: true, AttackDistance: 20 },
});
const docWith = (...profiles: RoutineProfile[]): RoutineDoc => ({ ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles });
const texts = (root: Element) => Array.from(root.querySelectorAll('[data-text]')).map((e) => (e as HTMLElement).dataset.text);
const flush = () => new Promise((r) => setTimeout(r, 450));

async function open(doc = docWith(meta())) {
  const f = fakeSource(doc);
  const dialogs: { title: string; body: HTMLElement; redraw: () => void } [] = [];
  const host: VTankDialogs = {
    open: (title, _w, _h, draw) => { const body = document.createElement('div'); const d = { title, body, redraw: () => {} }; d.redraw = () => draw(body, d.redraw, () => { dialogs.splice(dialogs.indexOf(d), 1); }); dialogs.push(d); d.redraw(); },
    close: () => { dialogs.length = 0; },
  };
  const win = new W.VTankWindow(fakeKit(), f.source, host);
  const body = document.createElement('div');
  const redraw = () => win.render(body, 794, 189, redraw);
  await win.load(redraw);
  return { ...f, win, body, redraw, dialogs };
}

describe('VirindiTank options (vtankOptions.ts)', () => {
  it('names are case-insensitive with the wiki\'s misspellings as aliases; ranges convert from VTank\'s map units', () => {
    expect(vtOption('enablecombat')?.name).toBe('EnableCombat');
    expect(vtCanonicalName('SwitchWandToDebuff')).toBe('SwitchWandsToDebuff');
    expect(vtCanonicalName('SomePluginOption')).toBe('SomePluginOption');
    // Monster Range 20 yards is 0.0833333 in /vt opt; ours is 20 (metres).
    expect(vtFromVTank('AttackDistance', 0.0833333)).toBe(20);
    expect(vtToVTank('attackdistance', 20)).toBeCloseTo(0.0833333, 6);
    expect(vtFromVTank('EnableCombat', 'false')).toBe(false);
    expect(vtFromVTank('MinimumRingTargets', '3')).toBe(3);
    expect(vtOption('AttackDistance')?.default).toBe(5);
    expect(new Set(VT_OPTIONS.map((o) => o.name)).size).toBe(VT_OPTIONS.length);
  });

  it('an imported /vt opt set is ours: canonical name, metres', () => {
    const met = ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', '2',
      'i', '1', 'i', '2', 'i', '0', 's', '/vt opt set attackdistance 0.0833333', 's', 'Default',
      'i', '1', 'i', '2', 'i', '0', 's', '/vt opt set enablecombat false', 's', 'Default'].join('\r\n');
    const { value: p } = importVTank([{ name: 'x.met', text: met }], null, 'X');
    expect(p.states[0].rules.map((r) => r.do[0])).toEqual([
      { kind: 'set-setting', name: 'AttackDistance', value: 20 },
      { kind: 'set-setting', name: 'EnableCombat', value: false },
    ]);
  });
});

describe('the VirindiTank window', () => {
  it('VirindiTank\'s tabs in its order', async () => {
    const t = await open();
    expect(Array.from(t.body.querySelectorAll('[data-vtank-tab]')).map((e) => (e as HTMLElement).dataset.tab)).toEqual(['Options', 'Profiles', 'Vitals', 'Monsters', 'Items', 'Consumables', 'Buffs', 'Route', 'Meta']);
    expect((t.body.querySelector('[data-vtank-tab="options"]') as HTMLElement).dataset.selected).toBe('1');
  });

  it('Options: VTank\'s controls at its places, only those the engine acts on; a change saves and reaches the run', async () => {
    const t = await open();
    const names = Array.from(t.body.querySelectorAll('[data-vtank-option]')).map((e) => (e as HTMLElement).dataset.vtankOption);
    expect(names).toEqual(['AttackDistance', 'RingDistance', 'ApproachDistance', 'NavCloseStopRange', 'EnableBuffing', 'EnableCombat', 'EnableNav', 'EnableLooting', 'EnableMeta', 'AutoStack', 'AutoCram', 'UseDispelItems', 'CastDispelSelf', 'AutoFellowManagement', 'ManaChargesWhenOff', 'NavPriorityBoost', 'LootPriorityBoost', 'LootOnlyRareCorpses', 'IdlePeaceMode', 'IdleBuffTopoff', 'SummonPets', 'PetRangeMode', 'PetCustomRange', 'PetMonsterDensity']);
    expect(names.every((n) => vtOption(n!)?.engine)).toBe(true);
    // Values: the profile's, else VTank's default (Follow/Nav Min 2 yd).
    expect((t.body.querySelector('[data-vtank-option="AttackDistance"]') as HTMLInputElement).value).toBe('20');
    expect((t.body.querySelector('[data-vtank-option="NavCloseStopRange"]') as HTMLInputElement).value).toBe('2');
    expect((t.body.querySelector('[data-vtank-option="EnableLooting"]') as HTMLElement).dataset.on).toBe('0');
    (t.body.querySelector('[data-vtank-option="EnableLooting"] [data-check]') as HTMLElement).click();
    await flush();
    expect(t.saved.at(-1)!.profiles[0].settings).toMatchObject({ EnableLooting: true });
    // Running: the change goes to the macro at once.
    (t.body.querySelector('[data-vtank="run-macro"] [data-check]') as HTMLElement).click();
    expect(t.calls).toContain('run Runback');
    const range = t.body.querySelector('[data-vtank-option="AttackDistance"]') as HTMLInputElement;
    range.value = '30';
    range.dispatchEvent(new Event('input'));
    expect(t.calls).toContain('set AttackDistance=30');
    await flush();
    expect(t.saved.at(-1)!.profiles[0].settings!.AttackDistance).toBe(30);
  });

  it('Force Buff / Cancel Force Buff: only while the macro runs', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank="force-buff"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Turn Run Macro on to buff.');
    (t.body.querySelector('[data-vtank="run-macro"] [data-check]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="force-buff"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="cancel-force-buff"]') as HTMLElement).click();
    expect(t.calls).toEqual(['run Runback', 'force buff', 'cancel force buff']);
  });

  it('Run Macro starts the profile, then works as VTank\'s pause switch', async () => {
    const t = await open();
    const run = () => (t.body.querySelector('[data-vtank="run-macro"] [data-check]') as HTMLElement).click();
    run();
    run();
    run();
    expect(t.calls).toEqual(['run Runback', 'pause', 'resume']);
  });

  it('Advanced Options lists every option the engine acts on by VTank\'s name, grouped, and edits them', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank="advanced"] [data-check]') as HTMLElement).click();
    const rows = Array.from(t.body.querySelectorAll('[data-vtank-advanced]')).map((e) => (e as HTMLElement).dataset.vtankAdvanced);
    expect(rows).toEqual(VT_OPTIONS.filter((o) => o.engine).map((o) => o.name));
    (t.body.querySelector('[data-vtank-advanced="StopMacroOnDeath"] [data-check]') as HTMLElement).click();
    await flush();
    expect(t.saved.at(-1)!.profiles[0].settings!.StopMacroOnDeath).toBe(false);
    (t.body.querySelector('[data-vtank="advanced-close"]') as HTMLElement).click();
    expect(t.body.querySelector('[data-vtank-advanced]')).toBeNull();
  });

  it('Meta: every rule grouped by state (case-insensitive), as State | Condition | Action; fired rules in red', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="meta"]') as HTMLElement).click();
    const rows = Array.from(t.body.querySelectorAll('[data-vtank-rule]')).map((r) => texts(r));
    // Each column is one clipped line, never wrapped onto the next row.
    const cell = (t.body.querySelector('[data-vtank-rule] [data-text]') as HTMLElement).parentElement as HTMLElement;
    expect([cell.style.overflow, cell.style.whiteSpace]).toEqual(['hidden', 'nowrap']);
    expect(rows).toEqual([
      ['back', 'Always', 'All: Set VT Option: EnableCombat = true; Set Meta State: Default'],
      ['dead', 'Always', 'Load Embedded Navroute: runback'],
      ['dead', 'Navroute Empty', 'Set Meta State: back'],
      ['Default', 'Character Death', 'Set Meta State: dead'],
    ]);
    // Up / down only within a state.
    const dead0 = t.body.querySelector('[data-vtank-rule="dead#0"]') as HTMLElement;
    expect(dead0.querySelector('[data-vtank-rule-up]')).toBeNull();
    expect(dead0.querySelector('[data-vtank-rule-down]')).not.toBeNull();
    (dead0.querySelector('[data-vtank-rule-down]') as HTMLElement).click();
    expect(texts(t.body.querySelector('[data-vtank-rule="dead#0"]')!)).toEqual(['dead', 'Navroute Empty', 'Set Meta State: back']);
    // Running: Current State sets the state; a fired rule shows red.
    (t.body.querySelector('[data-vtank-tab="options"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="run-macro"] [data-check]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank-tab="meta"]') as HTMLElement).click();
    pick(t.body.querySelector('[data-vtank="current-state"]'), 'dead');
    expect(t.calls).toContain('state dead');
    t.setStatus({ spent: ['Default#0'] });
    t.redraw();
    const red = (t.body.querySelector('[data-vtank-rule="Default#0"] [data-text="Default"]') as HTMLElement);
    expect(red).not.toBeNull();
    expect(t.win).toBeDefined();
  });

  it('Create opens Edit Meta Rule; the condition and action menus are VTank\'s; values are VTank\'s (Pack Slots <= 4 is ours below 5)', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="meta"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="create-rule"]') as HTMLElement).click();
    expect(t.dialogs.map((d) => d.title)).toEqual(['Edit Meta Rule']);
    // A new rule is Never / None, as in VTank, and that saves (None is an empty action list).
    await flush();
    expect(t.win.message).toBe('');
    expect(t.saved.at(-1)!.profiles[0].states.find((s) => s.name === 'Default')!.rules.at(-1)!.do).toEqual([]);
    const dlg = () => t.dialogs[0].body;
    expect((dlg().querySelector('[data-vtank="rule-condition"]') as HTMLElement).dataset.field).toBe('Never');
    (dlg().querySelector('[data-vtank="rule-condition"]') as HTMLElement).click();
    expect(lastMenu!.items.map((i) => i.label).slice(0, 8)).toEqual(['Never', 'Always', 'Any', 'All', 'Chat Message', 'Pack Slots <=', 'Seconds in State >=', 'Navroute Empty']);
    pick(dlg().querySelector('[data-vtank="rule-condition"]'), 'Pack Slots <=');
    const slots = dlg().querySelector('[data-vtank-param="slots"]') as HTMLInputElement;
    expect(slots.value).toBe('0');
    slots.value = '4';
    slots.dispatchEvent(new Event('input'));
    const rule = t.win.profile()!.states.find((s) => s.name === 'Default')!.rules.at(-1)!;
    expect(rule.when).toEqual([{ kind: 'free-slots-below', slots: 5 }]);
    // Chat Command takes VTank's own commands.
    (dlg().querySelector('[data-vtank="rule-action"]') as HTMLElement).click();
    expect(lastMenu!.items.map((i) => i.label).slice(-6)).toEqual(['Clear Watchdog', 'Get VT Option', 'Set VT Option', 'Create View', 'Destroy View', 'Destroy All Views']);
    pick(dlg().querySelector('[data-vtank="rule-action"]'), 'Chat Command');
    const cmd = dlg().querySelector('[data-vtank-param="text"]') as HTMLInputElement;
    cmd.value = '/vt opt set enablecombat false';
    cmd.dispatchEvent(new Event('input'));
    expect(rule.do).toEqual([{ kind: 'set-setting', name: 'EnableCombat', value: false }]);
    // Any: a list of conditions with Add….
    pick(dlg().querySelector('[data-vtank="rule-condition"]'), 'Any');
    (dlg().querySelector('[data-vtank="add-condition"]') as HTMLElement).click();
    pick(dlg().querySelector('[data-vtank-sub-condition="0"] [data-field]'), 'Character Death');
    (dlg().querySelector('[data-vtank="add-condition"]') as HTMLElement).click();
    expect(rule.when).toEqual([{ kind: 'any', conditions: [{ kind: 'died' }, { kind: 'always' }] }]);
    await flush();
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
    (dlg().querySelector('[data-vtank="rule-close"]') as HTMLElement).click();
    expect(t.dialogs).toHaveLength(0);
  });

  it('Route: one VTank waypoint per point with its step; Add, Insert Above, Add Recall / Pause / Chat / Portal, arrows, type', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    const wps = () => Array.from(t.body.querySelectorAll('[data-vtank-waypoint]')).map((e) => texts(e)[0]);
    expect(wps()).toEqual(['1. Point 42.1N, 33.6E', '2. Recall: Lifestone Recall']);
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect(wps()).toHaveLength(3);
    pick(t.body.querySelector('[data-vtank="insert-mode"]'), 'Insert Above');
    (t.body.querySelector('[data-vtank-waypoint="0"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="add-pause"]') as HTMLElement).click();
    expect(wps()[0]).toBe('1. Pause 5 s');
    t.select({ name: 'Portal to Holtburg', kind: 'portal' });
    (t.body.querySelector('[data-vtank="add-portal"]') as HTMLElement).click();
    expect(wps()[0]).toBe('1. Use: Portal to Holtburg');
    (t.body.querySelector('[data-vtank="wp-down"]') as HTMLElement).click();
    expect(wps().slice(0, 2)).toEqual(['1. Pause 5 s', '2. Use: Portal to Holtburg']);
    (t.body.querySelector('[data-vtank="wp-remove"]') as HTMLElement).click();
    expect(wps()).toHaveLength(4);
    pick(t.body.querySelector('[data-vtank="route-mode"]'), 'Circular');
    await flush();
    const r = t.saved.at(-1)!.profiles[0].routes[0];
    expect(r.mode).toBe('circular');
    expect(r.points).toHaveLength(4);
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
    // No position yet: it says so instead of adding a point nowhere.
    t.setCoords(null);
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Your position is not known yet.');
  });

  it('Route: Add NPC Talk, the current-waypoint arrow, and Follow (Add sets the player to follow)', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    const wps = () => Array.from(t.body.querySelectorAll('[data-vtank-waypoint]')).map((e) => texts(e)[0]);
    t.select({ name: 'Sean the Speedy', kind: 'npc' });
    (t.body.querySelector('[data-vtank="add-npc-talk"]') as HTMLElement).click();
    expect(wps().at(-1)).toBe('3. NPC Talk: Sean the Speedy');
    (t.body.querySelector('[data-vtank-waypoint="1"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="wp-current"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Turn Run Macro on first.');
    (t.body.querySelector('[data-vtank-tab="options"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="run-macro"] [data-check]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank-waypoint="1"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="wp-current"]') as HTMLElement).click();
    expect(t.calls).toContain('waypoint 1');
    expect((t.body.querySelector('[data-vtank-waypoint="1"]') as HTMLElement).dataset.current).toBe('1');
    pick(t.body.querySelector('[data-vtank="route-mode"]'), 'Follow');
    t.select({ name: 'Leader', kind: 'player' });
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect((t.body.querySelector('[data-vtank-follow]') as HTMLElement).dataset.vtankFollow).toBe('Leader');
    await flush();
    expect(t.saved.at(-1)!.profiles[0].routes[0]).toMatchObject({ mode: 'follow', follow: 'Leader' });
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });

  it('Profiles: Macro Settings, CopyTo, the nav and loot profiles the macro starts with, Mine only', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="profiles"]') as HTMLElement).click();
    expect((t.body.querySelector('[data-vtank="macro-profile"]') as HTMLElement).dataset.field).toBe('Runback');
    pick(t.body.querySelector('[data-vtank="nav-profile"]'), 'runback');
    (t.body.querySelector('[data-vtank="mine-only"] [data-check]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="copy-profile"]') as HTMLElement).click();
    await flush();
    const d = t.saved.at(-1)!;
    expect(d.profiles.map((p) => p.name)).toEqual(['Runback', 'Runback 2']);
    expect(d.profiles[0].navRoute).toBe('runback');
    expect(d.characters).toEqual({ Claude: 'Runback' });
    expect((t.body.querySelector('[data-vtank="macro-profile"]') as HTMLElement).dataset.field).toBe('Runback 2');
  });

  it('an account with no profile gets a Default one on the first change, as VTank always has one', async () => {
    const t = await open(docWith());
    (t.body.querySelector('[data-vtank-option="EnableCombat"] [data-check]') as HTMLElement).click();
    await flush();
    expect(t.saved.at(-1)!.profiles.map((p) => [p.name, p.initialState, p.macro])).toEqual([['Default', 'Default', true]]);
  });
});

describe('VirindiTank\'s /vt commands', () => {
  it('start / stop, forcebuff, setmetastate, mexec, echo, jump, fakedeath, reverseroute', async () => {
    const t = await open();
    expect(await t.win.command('/vt start')).toEqual(['macro on']);
    expect(await t.win.command('/vt forcebuff')).toEqual(['']);
    expect(await t.win.command('/vt setmetastate dead')).toEqual(['']);
    expect(await t.win.command('/vt mexec getvar[x]==0')).toEqual(['True']);
    expect(await t.win.command('/vt echo hello there')).toEqual(['hello there']);
    await t.win.command('/vt jump 90 true 500');
    await t.win.command('/vt fakedeath');
    await t.win.command('/vt reverseroute');
    expect(await t.win.command('/vt stop')).toEqual(['macro off']);
    expect(t.calls).toEqual(['run Runback', 'force buff', 'state dead', 'mexec getvar[x]==0', 'jump {"heading":90,"walk":true,"holdMs":500}', 'fake death', 'reverse', 'pause']);
  });

  it('opt get / set in VTank\'s units (ranges ÷ 240), case-insensitive; setinall sets every profile', async () => {
    const t = await open(docWith(meta(), { ...meta(), name: 'Other' }));
    expect(await t.win.command('/vt opt get attackdistance')).toEqual([`AttackDistance = ${20 / 240}`]);
    expect(await t.win.command('/vt opt set AttackDistance 0.125')).toEqual(['AttackDistance = 0.125']);
    expect(t.saved.at(-1)!.profiles[0].settings!.AttackDistance).toBe(30);
    await t.win.command('/vt opt setinall enablelooting true');
    expect(t.saved.at(-1)!.profiles.map((p) => p.settings!.EnableLooting)).toEqual([true, true]);
    expect((await t.win.command('/vt opt get nosuchthing'))[0]).toBe('no option "nosuchthing"');
  });

  it('settings / nav / meta load and save, addnavpt; unknown commands say what exists', async () => {
    const t = await open(docWith(meta(), { ...meta(), name: 'Other', states: [{ name: 'Default', rules: [{ when: [{ kind: 'always' }], do: [{ kind: 'say', text: 'hi' }] }] }] }));
    expect(await t.win.command('/vt nav save loop2')).toEqual(['nav saved as "loop2"']);
    expect(await t.win.command('/vt nav load runback')).toEqual(['nav "runback" loaded']);
    expect(await t.win.command('/vt addnavpt 41.9N, 33.5E')).toEqual(['point 3 added to "runback"']);
    expect(await t.win.command('/vt meta load Other')).toEqual(['meta "Other" loaded']);
    expect(t.win.profile()!.states.map((s) => s.name)).toEqual(['Default']);
    expect(await t.win.command('/vt settings save Mine')).toEqual(['settings saved as "Mine"']);
    expect(await t.win.command('/vt settings load Runback')).toEqual(['settings "Runback" loaded']);
    expect((await t.win.command('/vt frobnicate'))[0]).toMatch(/^unknown command \/vt frobnicate/);
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });
});

describe('the VirindiTank window: Vitals, Monsters, Items, Consumables, Buffs', () => {
  const show = (t: Awaited<ReturnType<typeof open>>, tab: 'vitals' | 'monsters' | 'items' | 'consumables' | 'buffs') => { t.win.tab = tab; t.redraw(); };

  it('Vitals: the nine sliders in VTank\'s three groups with its defaults; a change saves', async () => {
    const t = await open();
    show(t, 'vitals');
    const sliders = Array.from(t.body.querySelectorAll('[data-vtank-option]')).map((e) => [(e as HTMLElement).dataset.vtankOption, (e as HTMLElement).dataset.slider]);
    expect(sliders).toEqual([
      ['Recharge-Norm-HitP', '75'], ['Recharge-Norm-Stam', '50'], ['Recharge-Norm-Mana', '50'],
      ['Recharge-NoTarg-HitP', '1'], ['Recharge-NoTarg-Stam', '1'], ['Recharge-NoTarg-Mana', '1'],
      ['Recharge-Helper-HitP', '20'], ['Recharge-Helper-Stam', '1'], ['Recharge-Helper-Mana', '1'],
    ]);
    expect(texts(t.body)).toContain('Heal at:');
    const heal = t.body.querySelector('[data-vtank-option="Recharge-Norm-HitP"]') as HTMLInputElement;
    heal.value = '60';
    heal.dispatchEvent(new Event('change'));
    await flush();
    expect(t.saved.at(-1)!.profiles[0].settings!['Recharge-Norm-HitP']).toBe(60);
    expect(texts(t.body)).toContain('60%');
  });

  it('Monsters: the <DEFAULT> row as VTank\'s (A and S on, P 1, Auto, None, <AUTO>, PAuto); switches, cycles, Add, Add Sel', async () => {
    const t = await open();
    show(t, 'monsters');
    expect(Array.from(t.body.querySelectorAll('[data-vtank-column]')).map((e) => (e as HTMLElement).dataset.vtankColumn)).toEqual(['F', 'B', 'G', 'I', 'Y', 'V', 'A', 'R', 'S', 'WC', 'FC', 'Cp', 'DC', 'Cs']);
    const row0 = () => t.body.querySelector('[data-vtank-monster="0"]') as HTMLElement;
    const on = () => Array.from(row0().querySelectorAll('[data-vtank-cell]')).filter((e) => (e.querySelector('[data-check]') ?? e as HTMLElement).getAttribute('data-check') === '1').map((e) => (e as HTMLElement).dataset.vtankCell);
    expect(on()).toEqual(['A', 'S']);
    // PetDmg isn't drawn until its element choice is built.
    expect(texts(row0())).toEqual(['<< DEFAULT >>', '1', 'Auto', 'None', '<AUTO>', '<AUTO>']);
    (row0().querySelector('[data-vtank-cell="I"]') as HTMLElement).click();
    (row0().querySelector('[data-vtank-cycle="priority"]') as HTMLElement).click();
    (row0().querySelector('[data-vtank-cycle="damage"]') as HTMLElement).click();
    expect(texts(row0())).toEqual(['<< DEFAULT >>', '2', 'Pierce', 'None', '<AUTO>', '<AUTO>']);
    const name = t.body.querySelector('[data-vtank="monster-name"]') as HTMLInputElement;
    name.value = 'Drudge Skulker';
    name.dispatchEvent(new Event('input'));
    (t.body.querySelector('[data-vtank="add-monster"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="add-selected-monster"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Select a monster first.');
    t.select({ name: 'Mite Snowman', kind: 'monster' });
    (t.body.querySelector('[data-vtank="add-selected-monster"]') as HTMLElement).click();
    await flush();
    const m = t.saved.at(-1)!.profiles[0].vtank!.monsters;
    expect(m.map((r) => r.name)).toEqual(['<DEFAULT>', 'Drudge Skulker', 'Mite Snowman']);
    expect(m[0]).toMatchObject({ priority: 2, damage: 0, on: ['A', 'S', 'I'] });
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
    // The default row can't be removed; the others can.
    expect(row0().querySelector('[data-vtank-remove]')).toBeNull();
    ((t.body.querySelector('[data-vtank-monster="1"] [data-vtank-remove]')) as HTMLElement).click();
    expect(t.win.profile()!.vtank!.monsters.map((r) => r.name)).toEqual(['<DEFAULT>', 'Mite Snowman']);
  });

  it('Items and Consumables add what you have selected in your pack; scarabs to exclude (no Add All Peas until pea splitting is built)', async () => {
    const t = await open();
    t.source.items = () => [{ name: 'Aqua Pea' }, { name: 'Healing Kit' }, { name: 'Ruby Pea' }];
    show(t, 'items');
    (t.body.querySelector('[data-vtank="add-item"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Select an item in your inventory first.');
    t.select({ name: 'Frost Wand', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-item"]') as HTMLElement).click();
    t.select({ name: 'Kite Shield', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-item-nobuffs"]') as HTMLElement).click();
    expect(texts(t.body)).toEqual(expect.arrayContaining(['Frost Wand', 'Kite Shield', '(no buffs)']));
    show(t, 'consumables');
    t.select({ name: 'Healing Kit', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-consumable"]') as HTMLElement).click();
    expect(t.body.querySelector('[data-vtank="add-peas"]')).toBeNull();
    t.select({ name: 'Copper Scarab', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-scarab"]') as HTMLElement).click();
    await flush();
    const v = t.saved.at(-1)!.profiles[0].vtank!;
    expect(v.items).toEqual([{ name: 'Frost Wand' }, { name: 'Kite Shield', noBuffs: true }]);
    expect(v.consumables).toEqual(['Healing Kit']);
    expect(v.excludedScarabs).toEqual(['Copper Scarab']);
    // The Monsters tab's Weapon cycles through the Items list.
    show(t, 'monsters');
    const wpn = t.body.querySelector('[data-vtank-monster="0"] [data-vtank-cycle="weapon"]') as HTMLElement;
    wpn.click();
    expect((t.body.querySelector('[data-vtank-monster="0"] [data-vtank-cycle="weapon"]') as HTMLElement).dataset.text).toBe('Frost Wand');
  });

  it('Buffs: Add… picks a spell you know for Extra Buff Spells or Blacklisted Buff Families', async () => {
    const t = await open();
    t.source.spells = () => [{ name: 'Leadership Mastery Self I', school: 'Creature Enchantment' }, { name: 'Armor Self I', school: 'Life Magic' }];
    show(t, 'buffs');
    pick(t.body.querySelector('[data-vtank="add-extra-buff"]'), 'Leadership Mastery Self I');
    pick(t.body.querySelector('[data-vtank="add-blacklisted-buff"]'), 'Armor Self I');
    await flush();
    expect(t.saved.at(-1)!.profiles[0].vtank).toMatchObject({ extraBuffs: ['Leadership Mastery Self I'], blacklistedBuffs: ['Armor Self I'] });
    ((t.body.querySelector('[data-vtank-list="extra-buffs"] [data-vtank-remove]')) as HTMLElement).click();
    expect(t.win.profile()!.vtank!.extraBuffs).toEqual([]);
  });
});

describe('GameUI hosts the VirindiTank window', () => {
  it('/automation opens it in its VVS frame over the world; Edit Meta Rule floats above it; the close box closes both', async () => {
    const ui = H.ui as unknown as { setAutomationSource(s: VTankSource | null): void; toggleAutomationWindow(): void; automationWindowOpen: boolean };
    const f = fakeSource(docWith(meta()));
    ui.setAutomationSource(f.source);
    ui.toggleAutomationWindow();
    expect(ui.automationWindowOpen).toBe(true);
    const win = H.container.querySelector('[data-vtank-window]') as HTMLElement;
    expect(win.textContent).toContain('Automation');
    await new Promise((r) => setTimeout(r, 0));
    expect(win.querySelector('[data-vtank="window"]')).not.toBeNull();
    (win.querySelector('[data-vtank-tab="meta"]') as HTMLElement).click();
    (win.querySelector('[data-vtank="create-rule"]') as HTMLElement).click();
    expect(H.container.querySelector('[data-vtank-dialog]')?.textContent).toContain('Edit Meta Rule');
    (win.querySelector('[data-vtank-close]') as HTMLElement).click();
    expect(ui.automationWindowOpen).toBe(false);
    expect(H.container.querySelector('[data-vtank-dialog]')).toBeNull();
    ui.setAutomationSource(null);
  });
});
