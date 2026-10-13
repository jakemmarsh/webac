/**
 * AGENT.vtank-window — the VirindiTank-style automation window
 * (ui/automation/VTankWindow.ts) over a fake kit and source, then hosted by
 * the real GameUI: VTank's tabs and controls, its option names and units, its
 * Meta list and Edit Meta Rule, its Route tab, and live changes to the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  VT_DAMAGE, VT_OPTIONS, emptyRoutineDoc, importVTank, parseMet, parseNav, parseUtl, utlToLoot, validateRoutineDoc, vtCanonicalName, vtFromVTank, vtOption, vtToVTank,
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
/** The files the window handed the player (its exported VirindiTank files). */
const downloads: Array<{ name: string; text: string }> = [];
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
    download: (name, text) => { downloads.push({ name, text }); },
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
  let selected: { name: string; kind: string } | null = null;
  let coords: string | null = '42.1N, 33.6E';
  let reversed = false;
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
    report: (text: string) => { reports.push(text); },
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
    setAttackBar: (power) => { calls.push(`bar ${power}`); return Number.isNaN(power) ? { ok: false, message: 'Syntax: /vt setattackbar [0 to 1]' } : { ok: true, message: `Attack bar set to ${power}.` }; },
    fakeDeath: () => { calls.push('fake death'); return { ok: true, message: 'fake death' }; },
    reverseRoute: (on) => { calls.push(on === undefined ? 'reverse' : `reverse ${on}`); reversed = on ?? !reversed; return { ok: true, message: 'reversed' }; },
    routeReversed: () => reversed,
    // The fake's nearest point to you is point 2 (index 1).
    setNearestWaypoint: () => { calls.push('nearest waypoint'); status = { ...status, nav: { route: 'runback', point: 1, done: false } }; return { ok: true, message: '' }; },
    cancelForceBuff: () => { calls.push('cancel force buff'); return { ok: true, message: '' }; },
    setState: (n) => { calls.push(`state ${n}`); status = { ...status, state: n }; return { ok: true, message: '' }; },
    update: (p) => { calls.push(`update ${p.name}`); return { ok: true, message: '' }; },
    selection: () => selected,
    pasteChat: (text) => { pasted.push(text); return true; },
  };
  return { source, calls, reports, saved, live, pasted, setStatus: (s: Partial<RoutineStatus>) => { status = { ...status, ...s }; }, select: (s: typeof selected) => { selected = s; }, setCoords: (c: string | null) => { coords = c; } };
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
    expect(names).toEqual(['AttackDistance', 'RingDistance', 'ApproachDistance', 'NavCloseStopRange', 'EnableBuffing', 'EnableCombat', 'EnableNav', 'EnableLooting', 'EnableMeta', 'AutoStack', 'AutoCram', 'UseDispelItems', 'CastDispelSelf', 'ShowNavLines', 'AutoFellowManagement', 'ManaChargesWhenOff', 'NavPriorityBoost', 'LootPriorityBoost', 'LootOnlyRareCorpses', 'IdlePeaceMode', 'IdleBuffTopoff', 'SummonPets', 'PetRangeMode', 'PetCustomRange', 'PetMonsterDensity']);
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
    // The server-rules line prints once, on the first start (not on resume).
    expect(t.reports).toEqual([W.VT_SERVER_RULES_NOTE]);
  });

  it('Advanced Options lists every option the engine acts on by VTank\'s name, grouped, and edits them', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank="advanced"] [data-check]') as HTMLElement).click();
    const rows = Array.from(t.body.querySelectorAll('[data-vtank-advanced]')).map((e) => (e as HTMLElement).dataset.vtankAdvanced);
    expect(rows).toEqual(VT_OPTIONS.filter((o) => o.engine).map((o) => o.name));
    // Recharge boost, pea splitting and crafting (UseSpecialAmmo too, since 2026-10-11) are engine options, so they're listed.
    expect(rows).toEqual(expect.arrayContaining(['RechargeBoostTimeSeconds', 'RechargeBoostAmount', 'ClearLevelBoostFlagOnCast', 'SplitPeas', 'SpellCompMin-Critical', 'SpellCompMin-Normal', 'SpellCompMin-Idle', 'AutoCraftItems', 'IdleCraftCount_HealthKits', 'ArrowheadFletchDiffExcessThreshold', 'UseSpecialAmmo']));
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
    expect(lastMenu!.items.map((i) => i.label).slice(-12, -6)).toEqual(['Clear Watchdog', 'Get VT Option', 'Set VT Option', 'Create View', 'Destroy View', 'Destroy All Views']);
    // Then ours, which VTank never had (beyond VTank, Jake 2026-10-12; tests/verify-routine-beyond-vtank.ts).
    expect(lastMenu!.items.map((i) => i.label).slice(-6)).toEqual(['Pull Monster', 'Hold Position', 'Release Position', 'Loot Corpse', 'Recall Unless Attacked', 'Flee To']);
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

  it('Route: Add NPC Talk, the current-waypoint arrow (circular routes only, the nearest point), and Follow (Add sets the player or creature to follow)', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    const wps = () => Array.from(t.body.querySelectorAll('[data-vtank-waypoint]')).map((e) => texts(e)[0]);
    t.select({ name: 'Sean the Speedy', kind: 'npc' });
    (t.body.querySelector('[data-vtank="add-npc-talk"]') as HTMLElement).click();
    expect(wps().at(-1)).toBe('3. NPC Talk: Sean the Speedy');
    // A Once route: VTank's arrow works on circular routes only, so it isn't drawn.
    expect(t.body.querySelector('[data-vtank="wp-current"]')).toBeNull();
    pick(t.body.querySelector('[data-vtank="route-mode"]'), 'Circular');
    (t.body.querySelector('[data-vtank="wp-current"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Turn Run Macro on first.');
    (t.body.querySelector('[data-vtank-tab="options"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="run-macro"] [data-check]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    // No waypoint selected: the arrow picks the one nearest you, not the selection.
    (t.body.querySelector('[data-vtank="wp-current"]') as HTMLElement).click();
    expect(t.calls).toContain('nearest waypoint');
    expect((t.body.querySelector('[data-vtank-waypoint="1"]') as HTMLElement).dataset.current).toBe('1');
    pick(t.body.querySelector('[data-vtank="route-mode"]'), 'Follow');
    expect(t.body.querySelector('[data-vtank="wp-current"]')).toBeNull();
    // An item is no follow target; a player or a creature is (VTank follows the selection).
    t.select({ name: 'Pyreal', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Select the player or creature to follow first.');
    t.select({ name: 'Drudge Skulker', kind: 'monster' });
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect((t.body.querySelector('[data-vtank-follow]') as HTMLElement).dataset.vtankFollow).toBe('Drudge Skulker');
    t.select({ name: 'Leader', kind: 'player' });
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect((t.body.querySelector('[data-vtank-follow]') as HTMLElement).dataset.vtankFollow).toBe('Leader');
    await flush();
    expect(t.saved.at(-1)!.profiles[0].routes[0]).toMatchObject({ mode: 'follow', follow: 'Leader' });
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
    // The leader out of sight: the macro stands still and the line says so.
    t.setStatus({ follow: { target: 'Leader', inSight: false, trail: 0 } });
    (t.body.querySelector('[data-vtank-tab="options"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    const line = t.body.querySelector('[data-vtank-follow]') as HTMLElement;
    expect(line.dataset.lost).toBe('1');
    expect(line.dataset.text).toBe('Following: Leader (out of sight: standing still)');
  });

  it('Follow on an account with no profile yet: the new profile and its follow route save', async () => {
    const t = await open(docWith());
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    pick(t.body.querySelector('[data-vtank="route-mode"]'), 'Follow');
    t.select({ name: 'Leader Two', kind: 'player' });
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    await flush();
    expect(texts(t.body).join(' ')).not.toMatch(/not saved/);
    const doc = t.saved.at(-1)!;
    expect(validateRoutineDoc(doc)).toEqual([]);
    expect(doc.profiles[0].routes[0]).toMatchObject({ mode: 'follow', follow: 'Leader Two' });
    // The Route tab's route is the one Run Macro loads (VTank has one current nav profile).
    expect(doc.profiles[0].navRoute).toBe(doc.profiles[0].routes[0].name);
    // A store that refuses it (a bridge on an older build) is named, field and all.
    t.source.save = async () => ({ ok: false, message: 'not saved: the routine has problems', issues: [{ path: 'profiles[0].routes[0].mode', message: 'must be circular, linear or once' }] });
    t.select({ name: 'Leader Three', kind: 'player' });
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    await flush();
    expect(texts(t.body)).toContain('not saved: the routine has problems (profiles[0].routes[0].mode: must be circular, linear or once)');
  });

  it('Profiles: Macro Settings, CopyTo, the nav and loot profiles the macro starts with, Mine only', async () => {
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="profiles"]') as HTMLElement).click();
    expect((t.body.querySelector('[data-vtank="macro-profile"]') as HTMLElement).dataset.field).toBe('Runback');
    pick(t.body.querySelector('[data-vtank="nav-profile"]'), 'runback');
    (t.body.querySelector('[data-vtank="mine-only"] [data-check]') as HTMLElement).click();
    await flush();
    expect(t.saved.at(-1)!.characters).toEqual({ Claude: 'Runback' });
    // CopyTo pastes VTank's save command for the player to name (Mine only on: savechar); the command makes the copy.
    (t.body.querySelector('[data-vtank="copy-profile"]') as HTMLElement).click();
    expect(t.pasted).toEqual(['/vt settings savechar ']);
    expect(await t.win.command('/vt settings savechar Runback 2')).toEqual(['settings saved as "Runback 2"']);
    t.redraw();
    const d = t.saved.at(-1)!;
    expect(d.profiles.map((p) => p.name)).toEqual(['Runback', 'Runback 2']);
    expect(d.profiles[0].navRoute).toBe('runback');
    expect(d.characters).toEqual({ Claude: 'Runback 2' });
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

  it('setattackbar [0 to 1] sets the combat bar; anything else is the syntax line', async () => {
    const t = await open();
    expect(await t.win.command('/vt setattackbar 0.75')).toEqual(['Attack bar set to 0.75.']);
    expect(await t.win.command('/vt setattackbar high')).toEqual(['Syntax: /vt setattackbar [0 to 1]']);
    expect(t.calls).toEqual(['bar 0.75', 'bar NaN']);
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

  it('addnavcheckpoint adds a checkpoint, addnavjump a jump point (VTank\'s heading / shift / ms), both where you stand', async () => {
    const t = await open();
    t.setCoords('42.3N, 33.8E');
    expect(await t.win.command('/vt addnavcheckpoint')).toEqual(['checkpoint 3 added to "runback"']);
    expect(await t.win.command('/vt addnavjump 450 true 500')).toEqual(['jump 4 added to "runback"']);
    expect(await t.win.command('/vt addnavjump 90 false 250 forward')).toEqual(['jump 5 added to "runback"']);
    const r = t.saved.at(-1)!.profiles[0].routes[0];
    expect(r.points.slice(2)).toEqual(['42.3N, 33.8E', '42.3N, 33.8E', '42.3N, 33.8E']);
    expect(r.stops!.slice(1)).toEqual([
      { at: 2, do: [{ kind: 'checkpoint' }] },
      { at: 3, do: [{ kind: 'jump', heading: 90, holdMs: 500, walk: true }] },
      { at: 4, do: [{ kind: 'jump', heading: 90, holdMs: 250, forward: true }] },
    ]);
    expect(W.waypointText({ coords: '42.3N, 33.8E', step: [{ kind: 'checkpoint' }] })).toBe('Checkpoint 42.3N, 33.8E');
    expect(W.waypointText({ coords: '42.3N, 33.8E', step: [{ kind: 'jump', heading: 90, holdMs: 500, walk: true }] })).toBe('Jump 90° (walk) 500 ms');
    expect(W.waypointText({ coords: '42.3N, 33.8E', step: [{ kind: 'use-portal', id: 0x7a9b0012 }] })).toBe('Portal #7a9b0012');
    // Bad arguments say the syntax; a strafe jump isn't something our jump does.
    expect(await t.win.command('/vt addnavjump 90 maybe 500')).toEqual(['/vt addnavjump [heading] [shift: true or false] [milliseconds] [forward]']);
    expect(await t.win.command('/vt addnavjump 90 true 9000')).toEqual(['/vt addnavjump [heading] [shift: true or false] [milliseconds] [forward]']);
    expect(await t.win.command('/vt addnavjump 90 true 500 strafeleft')).toEqual(['a strafeleft jump isn\'t supported here (forward or in place)']);
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });

  it('reverseroute [true|false] sets the direction (none flips it); reverseroutequery reads it back', async () => {
    const t = await open();
    expect(await t.win.command('/vt reverseroutequery')).toEqual(['reverseroute is false']);
    await t.win.command('/vt reverseroute true');
    expect(await t.win.command('/vt reverseroutequery')).toEqual(['reverseroute is true']);
    await t.win.command('/vt reverseroute');
    expect(await t.win.command('/vt reverseroutequery')).toEqual(['reverseroute is false']);
    expect(await t.win.command('/vt reverseroute sideways')).toEqual(['/vt reverseroute [true|false]']);
    expect(t.calls).toEqual(['reverse true', 'reverse']);
  });
});

describe('VirindiTank files out (AGENT.vtank-export): the Profiles tab\'s CopyTo buttons and /vt … save <name>.<ext>', () => {
  const read = (name: string) => { const d = downloads.filter((x) => x.name === name).at(-1); if (!d) throw new Error(`no download ${name} (have ${downloads.map((x) => x.name).join(', ')})`); return d.text; };

  it('Meta CopyTo pastes /vt meta save; saved as name.met it hands over the profile\'s .met, which imports back to the same states', async () => {
    downloads.length = 0;
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="profiles"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="copy-meta"]') as HTMLElement).click();
    expect(t.pasted).toEqual(['/vt meta save ']);
    t.win.message = (await t.win.command('/vt meta save Runback.met')).slice(1).join(' ');
    t.redraw();
    expect(downloads.map((d) => d.name)).toEqual(['Runback.met']);
    const back = importVTank([{ name: 'Runback.met', text: read('Runback.met') }], null, 'Runback').value;
    expect(back.states).toEqual(meta().states);
    // The route the meta loads rides inside (Embed Nav); this one was recorded here, so it has no heights: said so.
    expect(back.routes.map((r) => [r.name, r.mode, r.points])).toEqual([['runback', 'once', ['42.100N, 33.600E', '42.200N, 33.700E']]]);
    expect(texts(t.body).join('\n')).toContain('Runback.met saved to your downloads; not carried over exactly (1):');
    expect(texts(t.body).join('\n')).toContain('route "runback": 2 point(s) have no recorded height; written at height 0');
  });

  it('nav CopyTo pastes /vt nav save: as name.nav the chosen route\'s .nav comes; with [None] it makes a new route (VTank\'s way); loot CopyTo the .utl', async () => {
    downloads.length = 0;
    const t = await open(docWith({ ...meta(), loot: [{ label: 'Pyreals', action: 'keep', match: { name: '^Pyreals?$' } }] }));
    (t.body.querySelector('[data-vtank-tab="profiles"]') as HTMLElement).click();
    pick(t.body.querySelector('[data-vtank="nav-profile"]'), 'runback');
    (t.body.querySelector('[data-vtank="copy-nav"]') as HTMLElement).click();
    expect(t.pasted).toEqual(['/vt nav save ']);
    await t.win.command('/vt nav save runback.nav');
    t.redraw();
    const nav = parseNav(read('runback.nav'));
    expect(nav.mode).toBe('once');
    expect(nav.nodes.map((n) => [n.type, n.extra])).toEqual([[0, []], [2, ['1635']]]);
    (t.body.querySelector('[data-vtank="copy-loot"]') as HTMLElement).click();
    expect(utlToLoot(parseUtl(read('Runback.utl'))).value).toEqual([{ label: 'Pyreals', action: 'keep', match: { name: '^Pyreals?$' } }]);
    pick(t.body.querySelector('[data-vtank="nav-profile"]'), '[None]');
    (t.body.querySelector('[data-vtank="copy-nav"]') as HTMLElement).click();
    await t.win.command('/vt nav save Route 1');
    await flush();
    expect(downloads.map((d) => d.name)).toEqual(['runback.nav', 'Runback.utl']);
    expect(t.saved.at(-1)!.profiles[0].navRoute).toBe('Route 1');
    expect(t.saved.at(-1)!.profiles[0].routes.map((r) => r.name)).toEqual(['runback', 'Route 1']);
  });

  it('/vt nav | meta | loot save <name> stores as before; with the extension it also hands over the file', async () => {
    downloads.length = 0;
    const t = await open(docWith({ ...meta(), loot: [{ label: 'Pyreals', action: 'keep', match: { name: '^Pyreals?$' } }] }));
    expect(await t.win.command('/vt nav save loop2')).toEqual(['nav saved as "loop2"']);
    expect(downloads).toEqual([]);
    const nav = await t.win.command('/vt nav save loop3.nav');
    expect(nav[0]).toBe('nav saved as "loop3"');
    expect(nav[1]).toMatch(/^loop3\.nav saved to your downloads/);
    expect(parseNav(read('loop3.nav')).nodes).toHaveLength(2);
    expect((await t.win.command('/vt meta save Hunt.met'))[0]).toBe('meta saved as "Hunt"');
    expect(parseMet(read('Hunt.met')).map((r) => r.state)).toEqual(['Default', 'dead', 'dead', 'back']);
    expect(await t.win.command('/vt loot save Keepers')).toEqual(['loot saved as "Keepers"']);
    expect((await t.win.command('/vt loot save Keepers.utl'))[1]).toBe('Keepers.utl saved to your downloads.');
    expect(downloads.map((d) => d.name)).toEqual(['loop3.nav', 'Hunt.met', 'Keepers.utl']);
    const d = t.saved.at(-1)!;
    expect(d.profiles[0].lootSet).toBe('Keepers');
    expect(d.profiles[0].lootSets?.Keepers).toEqual([{ label: 'Pyreals', action: 'keep', match: { name: '^Pyreals?$' } }]);
    expect(d.profiles.map((p) => p.name)).toEqual(['Runback', 'Hunt']);
    // The saved meta brings the routes its rules load (before 2026-10-11 it didn't, and the document stopped saving).
    expect(d.profiles[1].routes.map((r) => r.name)).toEqual(['runback', 'loop2', 'loop3']);
    expect(validateRoutineDoc(d)).toEqual([]);
    expect((await t.win.command('/vt loot frob'))[0]).toBe('/vt loot load <name> | new <name> | save <name>[.utl] (with .utl: also download the file)');
  });

  it('Add Portal/NPC and Add NPC Talk record the object\'s kind, so the exported point says portal or NPC', async () => {
    downloads.length = 0;
    const t = await open();
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    t.select({ name: 'Portal to Holtburg', kind: 'portal' });
    (t.body.querySelector('[data-vtank="add-portal"]') as HTMLElement).click();
    t.select({ name: 'Sean the Speedy', kind: 'npc' });
    (t.body.querySelector('[data-vtank="add-npc-talk"]') as HTMLElement).click();
    await t.win.command('/vt nav save errands.nav');
    expect(parseNav(read('errands.nav')).nodes.slice(2).map((n) => [n.type, n.extra[0], n.extra[1]])).toEqual([[6, 'Portal to Holtburg', '14'], [7, 'Sean the Speedy', '37']]);
  });

  it('edits keep an imported route\'s heights with their points', async () => {
    const t = await open(docWith({ ...meta(), routes: [{ name: 'runback', mode: 'once', points: ['42.100N, 33.600E', '42.200N, 33.700E'], z: [0.39, 0.4] }] }));
    (t.body.querySelector('[data-vtank-tab="route"]') as HTMLElement).click();
    pick(t.body.querySelector('[data-vtank="insert-mode"]'), 'Insert Above');
    (t.body.querySelector('[data-vtank-waypoint="1"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="add-point"]') as HTMLElement).click();
    expect(t.win.profile()!.routes[0].z).toEqual([0.39, null, 0.4]);
    (t.body.querySelector('[data-vtank="wp-remove"]') as HTMLElement).click();
    expect(t.win.profile()!.routes[0].z).toEqual([0.39, 0.4]);
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
    expect(texts(row0())).toEqual(['<< DEFAULT >>', '1', 'Auto', 'None', '<AUTO>', '<AUTO>', 'PAuto']);
    (row0().querySelector('[data-vtank-cell="I"]') as HTMLElement).click();
    (row0().querySelector('[data-vtank-cycle="priority"]') as HTMLElement).click();
    (row0().querySelector('[data-vtank-cycle="damage"]') as HTMLElement).click();
    (row0().querySelector('[data-vtank-cycle="petDamage"]') as HTMLElement).click();
    expect(texts(row0())).toEqual(['<< DEFAULT >>', '2', 'Pierce', 'None', '<AUTO>', '<AUTO>', 'Auto']);
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
    expect(m[0]).toMatchObject({ priority: 2, damage: 0, on: ['A', 'S', 'I'], petDamage: VT_DAMAGE.Auto });
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
    // The default row can't be removed; the others can.
    expect(row0().querySelector('[data-vtank-remove]')).toBeNull();
    ((t.body.querySelector('[data-vtank-monster="1"] [data-vtank-remove]')) as HTMLElement).click();
    expect(t.win.profile()!.vtank!.monsters.map((r) => r.name)).toEqual(['<DEFAULT>', 'Mite Snowman']);
  });

  it('Dmg type cycles through Harm, Drain Auto, Prismatic, Random and Fists; PetDmg through PAuto, Auto, None and the essence elements', async () => {
    const t = await open();
    show(t, 'monsters');
    const row0 = () => t.body.querySelector('[data-vtank-monster="0"]') as HTMLElement;
    const seen: string[] = [];
    for (let i = 0; i < 14; i++) { (row0().querySelector('[data-vtank-cycle="damage"]') as HTMLElement).click(); seen.push((row0().querySelector('[data-vtank-cycle="damage"]') as HTMLElement).dataset.text!); }
    expect(seen).toEqual(['Pierce', 'Bludgeon', 'Slash', 'Acid', 'Lightning', 'Cold', 'Fire', 'Void', 'Harm', 'Drain Auto', 'Prismatic', 'Random', 'Fists', 'Auto']);
    const pets: string[] = [];
    for (let i = 0; i < 7; i++) { (row0().querySelector('[data-vtank-cycle="petDamage"]') as HTMLElement).click(); pets.push((row0().querySelector('[data-vtank-cycle="petDamage"]') as HTMLElement).dataset.text!); }
    expect(pets).toEqual(['Auto', 'None', 'Acid', 'Lightning', 'Cold', 'Fire', 'PAuto']);
  });

  it('an era without Summoning / Void Magic / Tusker Fists (Dark Majesty, AC1999 skill tables) draws none of their controls', async () => {
    const t = await open();
    t.source.hasSkill = (n) => !/^(summoning|void magic)$/i.test(n);
    t.source.hasSpell = (id) => id !== 2934;
    t.redraw();
    const opts = Array.from(t.body.querySelectorAll('[data-vtank-option]')).map((e) => (e as HTMLElement).dataset.vtankOption);
    expect(opts).not.toContain('SummonPets');
    expect(opts.some((n) => /^Pet/.test(n!))).toBe(false);
    expect(opts).toContain('AttackDistance');
    (t.body.querySelector('[data-vtank="advanced"] [data-check]') as HTMLElement).click();
    const adv = Array.from(t.body.querySelectorAll('[data-vtank-advanced]')).map((e) => (e as HTMLElement).dataset.vtankAdvanced);
    expect(adv).toEqual(VT_OPTIONS.filter((o) => o.engine && !W.VT_PET_OPTIONS.has(o.name)).map((o) => o.name));
    (t.body.querySelector('[data-vtank="advanced-close"]') as HTMLElement).click();
    show(t, 'monsters');
    expect(Array.from(t.body.querySelectorAll('[data-vtank-column]')).map((e) => (e as HTMLElement).dataset.vtankColumn)).toEqual(['F', 'B', 'G', 'I', 'Y', 'V', 'A', 'R', 'S']);
    const row0 = () => t.body.querySelector('[data-vtank-monster="0"]') as HTMLElement;
    expect(row0().querySelector('[data-vtank-cycle="petDamage"]')).toBeNull();
    expect(row0().querySelector('[data-vtank-cell="Cp"]')).toBeNull();
    expect(texts(t.body)).not.toContain('PetDmg');
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) { (row0().querySelector('[data-vtank-cycle="damage"]') as HTMLElement).click(); seen.push((row0().querySelector('[data-vtank-cycle="damage"]') as HTMLElement).dataset.text!); }
    expect(seen).toEqual(['Pierce', 'Bludgeon', 'Slash', 'Acid', 'Lightning', 'Cold', 'Fire', 'Harm', 'Drain Auto', 'Prismatic', 'Random', 'Auto']);
    show(t, 'items');
    expect(texts(t.body)).toContain('Weapons / Wands / Shields');
    expect(texts(t.body)).not.toContain('Weapons / Wands / Shields / Pets');
    // End of retail (the table has both): everything is back.
    t.source.hasSkill = () => true;
    t.source.hasSpell = () => true;
    show(t, 'items');
    expect(texts(t.body)).toContain('Weapons / Wands / Shields / Pets');
    show(t, 'monsters');
    expect(texts(t.body)).toContain('PetDmg');
  });

  it('Items and Consumables add what you have selected in your pack; Add All Peas adds every pea carried; scarabs to exclude', async () => {
    const t = await open();
    t.source.items = () => [{ name: 'Aqua Pea' }, { name: 'Healing Kit' }, { name: 'Ruby Pea' }];
    show(t, 'items');
    (t.body.querySelector('[data-vtank="add-item"]') as HTMLElement).click();
    expect(texts(t.body)).toContain('Select an item in your inventory first.');
    t.select({ name: 'Frost Wand', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-item"]') as HTMLElement).click();
    t.select({ name: 'Kite Shield', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-item-nobuffs"]') as HTMLElement).click();
    expect(texts(t.body)).toEqual(expect.arrayContaining(['Frost Wand', 'Kite Shield  (no buffs)']));
    show(t, 'consumables');
    t.select({ name: 'Healing Kit', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-consumable"]') as HTMLElement).click();
    (t.body.querySelector('[data-vtank="add-peas"]') as HTMLElement).click();
    expect(texts(t.body)).toEqual(expect.arrayContaining(['Aqua Pea', 'Ruby Pea']));
    t.select({ name: 'Copper Scarab', kind: 'item' });
    (t.body.querySelector('[data-vtank="add-scarab"]') as HTMLElement).click();
    await flush();
    const v = t.saved.at(-1)!.profiles[0].vtank!;
    expect(v.items).toEqual([{ name: 'Frost Wand' }, { name: 'Kite Shield', noBuffs: true }]);
    expect(v.consumables).toEqual(['Healing Kit', 'Aqua Pea', 'Ruby Pea']);
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
    // The title is VVS's text (a canvas run, vvsText.ts).
    expect(win.querySelector('[data-ac-run-text="Automation"]')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(win.querySelector('[data-vtank="window"]')).not.toBeNull();
    (win.querySelector('[data-vtank-tab="meta"]') as HTMLElement).click();
    (win.querySelector('[data-vtank="create-rule"]') as HTMLElement).click();
    expect(H.container.querySelector('[data-vtank-dialog] [data-ac-run-text="Edit Meta Rule"]')).not.toBeNull();
    (win.querySelector('[data-vtank-close]') as HTMLElement).click();
    expect(ui.automationWindowOpen).toBe(false);
    expect(H.container.querySelector('[data-vtank-dialog]')).toBeNull();
    ui.setAutomationSource(null);
  });

  it('CopyTo hands the file over as a browser download, named as VTank names it, in Windows-1252', async () => {
    const ui = H.ui as unknown as { setAutomationSource(s: VTankSource | null): void; toggleAutomationWindow(): void; automationWindowOpen: boolean };
    const blobs: Blob[] = [];
    const clicked: string[] = [];
    const urlApi = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    const anchor = Object.getPrototypeOf(document.createElement('a')) as { click(): void };
    const saved = { create: urlApi.createObjectURL, revoke: urlApi.revokeObjectURL, click: anchor.click };
    urlApi.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:x'; };
    urlApi.revokeObjectURL = () => {};
    anchor.click = function (this: HTMLAnchorElement) { clicked.push(this.download); };
    try {
      ui.setAutomationSource(fakeSource(docWith({ ...meta(), loot: [{ label: 'Café', action: 'keep', match: { name: 'Café' } }] })).source);
      ui.toggleAutomationWindow();
      await new Promise((r) => setTimeout(r, 0));
      const win = H.container.querySelector('[data-vtank-window]') as HTMLElement;
      (win.querySelector('[data-vtank-tab="profiles"]') as HTMLElement).click();
      (win.querySelector('[data-vtank="copy-loot"]') as HTMLElement).click();
      expect(clicked).toEqual(['Runback.utl']);
      const bytes = new Uint8Array(await blobs[0].arrayBuffer());
      expect(Array.from(bytes)).toContain(0xe9); // é, one Windows-1252 byte
      expect(utlToLoot(parseUtl(Buffer.from(bytes).toString('latin1'))).value[0].label).toBe('Café');
      ui.toggleAutomationWindow();
      ui.setAutomationSource(null);
    } finally {
      urlApi.createObjectURL = saved.create;
      urlApi.revokeObjectURL = saved.revoke;
      anchor.click = saved.click;
    }
  });
});

describe('VirindiTank options that follow the era\'s data', () => {
  const table = (...descs: string[]) => ({ spells: new Map(descs.map((desc, i) => [i + 1, { desc }])) });
  const shownOptions = async (t: ReturnType<typeof table> | null) => {
    const o = await open();
    (o.source as { spellTable?: () => unknown }).spellTable = () => t;
    o.redraw();
    return { o, names: Array.from(o.body.querySelectorAll('[data-vtank-option]')).map((e) => (e as HTMLElement).dataset.vtankOption) };
  };

  it('Cast Dispel Self shows only when the era\'s SpellTable has a self dispel of negative Life Magic; Use Dispel Items when it has any such dispel', async () => {
    const eol = await shownOptions(table('Dispels 3-6 negative Life Magic enchantments of level 7 or lower from the caster.'));
    expect(eol.names).toEqual(expect.arrayContaining(['CastDispelSelf', 'UseDispelItems']));
    // Only an "other" dispel: no self one to cast, but an item could carry it.
    const otherOnly = await shownOptions(table('Dispels 3-6 negative Life Magic enchantments of level 7 or lower from the target.'));
    expect(otherOnly.names).toContain('UseDispelItems');
    expect(otherOnly.names).not.toContain('CastDispelSelf');
    // A table with no dispels (AC1999): neither control, nor in Advanced Options or /vt opt list.
    const none = await shownOptions(table('Improves the caster\'s Strength.'));
    expect(none.names).not.toContain('CastDispelSelf');
    expect(none.names).not.toContain('UseDispelItems');
    const list = (await none.o.win.command('/vt opt list')).join('\n');
    expect(list).not.toMatch(/CastDispelSelf|UseDispelItems/);
    expect(list).toMatch(/ManaChargesWhenOff/);
    // Not known yet (no table loaded): shown.
    expect((await shownOptions(null)).names).toEqual(expect.arrayContaining(['CastDispelSelf', 'UseDispelItems']));
  });

  const REPO = resolve(__dirname, '..');
  const EOL = resolve(REPO, 'dat/client_portal.dat');
  const DM = resolve(REPO, 'dat/sets/classic-dereth/client_portal.dat');
  const Y1999 = resolve(REPO, 'dat/sets/ac1999-retail/portal.dat');
  describe.skipIf(!existsSync(EOL) || !existsSync(DM) || !existsSync(Y1999))('on each era\'s own SpellTable 0x0E00000E', () => {
    let avail: Record<'eol' | 'dm' | 'y1999', { CastDispelSelf: boolean; UseDispelItems: boolean }>;
    beforeAll(async () => {
      const { DatReader } = await import('../packages/dat-parser/src/DatReader');
      const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable');
      const { transcodeSpellTable1999 } = await import('../packages/dat-parser/src/era1999/Tables1999');
      const { openDat } = await import('./_harness/dat.js');
      const { dispelOptionsAvailable } = await import('../packages/renderer/src/agent/macro/vtMacro.ts');
      const of = (path: string, y = false) => {
        let raw = openDat(path).getFileData(0x0e00000e)!;
        if (y) raw = transcodeSpellTable1999(raw);
        return dispelOptionsAvailable(new SpellTable(new DatReader(raw)) as never);
      };
      avail = { eol: of(EOL), dm: of(DM), y1999: of(Y1999, true) };
    });
    it('end of retail and Dark Majesty have Eradicate Life Magic Self (both shown); AC1999 has no dispel spells (both hidden)', () => {
      expect(avail.eol).toEqual({ CastDispelSelf: true, UseDispelItems: true });
      expect(avail.dm).toEqual({ CastDispelSelf: true, UseDispelItems: true });
      expect(avail.y1999).toEqual({ CastDispelSelf: false, UseDispelItems: false });
    });
  });
});

describe('the stand-by profile (M. Charges When Off with the macro off)', () => {
  it('is the profile the window selects for the character in the world, loaded on first ask; none before a character is in the world', async () => {
    const doc = docWith({ ...meta(), name: 'Other' }, { ...meta(), name: 'Mine' });
    doc.characters = { Claude: 'Mine' };
    const f = fakeSource(doc);
    let ch: string | null = null;
    f.source.character = () => ch;
    let loads = 0;
    const load = f.source.load;
    f.source.load = () => { loads++; return load(); };
    const win = new W.VTankWindow(fakeKit(), f.source, { open: () => {}, close: () => {} });
    expect(win.standbyProfile()).toBeNull();
    expect(loads).toBe(0);
    ch = 'Claude';
    expect(win.standbyProfile()).toBeNull();
    expect(win.standbyProfile()).toBeNull();
    await flush();
    expect(loads).toBe(1);
    expect(win.standbyProfile()?.name).toBe('Mine');
    // Its edits are the stand-by's at once (the same profile object the window edits).
    win.setValue('ManaChargesWhenOff', false, () => {});
    expect(win.standbyProfile()?.settings?.ManaChargesWhenOff).toBe(false);
    // Another character logs in: the document is loaded again for it.
    ch = 'Alt';
    expect(win.standbyProfile()).toBeNull();
    await flush();
    expect(loads).toBe(2);
    expect(win.standbyProfile()?.name).toBe('Other');
  });
});

describe('the window\'s looting controls and commands (docs/vtank-parity-gaps.md §3.7, §3.9)', () => {
  it('the Approach box sets the corpse approach range too (VTank\'s box writes both); /vt opt set sets only the one', async () => {
    const t = await open();
    t.setStatus({ running: true, profile: 'Runback' });
    const box = t.body.querySelector('[data-vtank-option="ApproachDistance"]') as HTMLInputElement;
    box.value = '30';
    box.dispatchEvent(new Event('input'));
    await flush();
    const s = t.saved.at(-1)!.profiles.find((p) => p.name === 'Runback')!.settings!;
    expect(s.ApproachDistance).toBe(30);
    expect(s['CorpseApproachRange-Max']).toBe(30);
    expect(t.calls).toEqual(expect.arrayContaining(['set ApproachDistance=30', 'set CorpseApproachRange-Max=30']));
    await t.win.command(`/vt opt set ApproachDistance ${10 / 240}`);
    const s2 = t.saved.at(-1)!.profiles.find((p) => p.name === 'Runback')!.settings!;
    expect(s2.ApproachDistance).toBe(10);
    expect(s2['CorpseApproachRange-Max']).toBe(30);
  });

  it('/vt testitem tests the selected item against the loaded loot profile; /vt propertydump dumps it', async () => {
    const p = meta();
    p.loot = [{ label: 'Own', action: 'keep', match: { name: 'Pyreal' } }];
    p.lootSets = { hunt: [{ label: 'Hunt', action: 'sell', match: { name: 'Sword' } }] };
    p.lootSet = 'hunt';
    const t = await open(docWith(p));
    let tested: unknown = null;
    t.source.testItem = async (rules) => { tested = rules; return ['TestItem: Sword => sell (rule: Hunt)']; };
    t.source.propertyDump = async () => ['Properties of Sword:', '  Int: Value(19)=80'];
    expect(await t.win.command('/vt testitem')).toEqual(['TestItem: Sword => sell (rule: Hunt)']);
    expect(tested).toEqual(p.lootSets.hunt);
    expect(await t.win.command('/vt propertydump')).toEqual(['Properties of Sword:', '  Int: Value(19)=80']);
    expect((await t.win.command('/vt nosuch'))[0]).toMatch(/testitem, propertydump, log\)$/);
  });
});
