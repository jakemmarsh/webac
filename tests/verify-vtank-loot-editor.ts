/**
 * docs/vtank-parity-gaps.md §3.2 / §9.1 / §8.1 — VirindiTank Classic's loot editor in the VirindiTank
 * window (ui/automation/lootEditor.ts, its data @ac/shared routines/vtclassicEditor.ts): Profiles →
 * Looting → New and Show Editor, /vt loot new, the Loot Rules tab (rules, actions with Keep #,
 * requirements of every VTClassic type, Toggle this rule, reorder, clone, delete), the Salvage
 * Combination tab, and the .utl round trip. Driven through the real window over a fake kit and
 * source, then hosted by the real GameUI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  UTL_V0_LINES, VTC_REQ_MENU, VTC_REQ_TYPES, emptyRoutineDoc, exportUtl, exportVTank, lootRuleToUtl, parseUtl, parseUtlFile, utlToLoot, validateRoutineDoc,
  vtcAutoSort, vtcReqText, vtcReqType, vtcRuleNeedsId, vtcToggleRule,
  type LootRule, type RoutineDoc, type RoutineProfile, type UtlRule,
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
const downloads: Array<{ name: string; text: string }> = [];
const pasted: string[] = [];
/** The file the next File → Open / Import Ranges picks (the fake file picker). */
let nextFile: { name: string; text: string } | null = null;
const opened: string[] = [];
function fakeKit(paste = true): VTankKit {
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
    ...(paste ? { pasteChat: (text: string) => { pasted.push(text); } } : {}),
    openFile: (accept, onFile) => { opened.push(accept); if (nextFile) onFile(nextFile); },
  };
}
function pick(field: Element | null, label: string): void {
  if (!field) throw new Error('no field');
  (field as HTMLElement).click();
  const it = lastMenu!.items.find((i) => i.label === label || i.value === label);
  if (!it) throw new Error(`no "${label}" in ${lastMenu!.items.map((i) => i.label).join(', ')}`);
  lastMenu!.pick(it.value);
}
function type(input: Element | null, value: string): void {
  if (!input) throw new Error('no input');
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new Event('input'));
}
const click = (e: Element | null) => { if (!e) throw new Error('nothing to click'); (e as HTMLElement).click(); };

function fakeSource(doc: RoutineDoc) {
  const calls: string[] = [];
  const saved: RoutineDoc[] = [];
  let status: RoutineStatus = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  const ok = { ok: true, message: '' };
  const source: VTankSource = {
    load: async () => ({ ok: true, doc: structuredClone(doc) }),
    save: async (d) => { const issues = validateRoutineDoc(d); if (issues.length) return { ok: false, message: 'not saved', issues }; saved.push(structuredClone(d)); return { ok: true, doc: structuredClone(d) }; },
    status: () => status,
    stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null,
    run: (p) => { calls.push(`run ${p.name}`); status = { ...status, running: true, paused: false, profile: p.name, state: p.initialState, spent: [] }; return ok; },
    pause: () => ok, resume: () => ok, stop: () => ok, setModule: () => ok, resetStats: () => {}, step: () => ok,
    history: () => [], report: () => {}, character: () => 'Claude', coords: () => '42.1N, 33.6E', items: () => [], spells: () => [], buffs: () => [],
    now: () => 1_700_000_000_000,
    setting: () => undefined, setSetting: () => {}, forceBuff: () => ok, cancelForceBuff: () => ok, mexec: () => '', jump: () => ok, fakeDeath: () => ok,
    reverseRoute: () => ok, setNearestWaypoint: () => ok, setState: () => ok,
    update: (p) => { calls.push(`update ${p.name} ${JSON.stringify(p.lootSet ? p.lootSets?.[p.lootSet] : p.loot)}`); return ok; },
    selection: () => null,
  };
  return { source, calls, saved };
}

const base = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Hunt', modules: { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false },
  initialState: 'Default', macro: true, ruleFiring: 'once', loot: [], buffSets: [], routes: [], states: [{ name: 'Default', rules: [] }], settings: {},
  ...over,
});
const docWith = (...profiles: RoutineProfile[]): RoutineDoc => ({ ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles });
const flush = () => new Promise((r) => setTimeout(r, 450));

async function open(doc = docWith(base()), paste = true) {
  const f = fakeSource(doc);
  const dialogs: Array<{ title: string; body: HTMLElement; redraw: () => void }> = [];
  const host: VTankDialogs = {
    open: (title, _w, _h, draw) => { dialogs.length = 0; const body = document.createElement('div'); const d = { title, body, redraw: () => {} }; d.redraw = () => draw(body, d.redraw, () => { dialogs.splice(dialogs.indexOf(d), 1); }); dialogs.push(d); d.redraw(); },
    close: () => { dialogs.length = 0; },
  };
  const win = new W.VTankWindow(fakeKit(paste), f.source, host);
  const body = document.createElement('div');
  const redraw = () => win.render(body, 794, 189, redraw);
  await win.load(redraw);
  click(body.querySelector('[data-vtank-tab="profiles"]'));
  const dlg = () => { if (!dialogs[0]) throw new Error('no dialog open'); return dialogs[0].body; };
  const q = (sel: string) => dlg().querySelector(sel);
  const rowTexts = (key: string) => Array.from(dlg().querySelectorAll(`[data-vtank-loot-list="${key}"] [data-text]`)).map((e) => (e as HTMLElement).dataset.text);
  return { ...f, win, body, redraw, dialogs, dlg, q, rowTexts };
}

describe('VTClassic\'s requirement types (vtclassicEditor.ts)', () => {
  it('every type LootRuleCreator makes, under its FriendlyName; a new one has the lines its Read() takes', () => {
    expect(VTC_REQ_TYPES.map((t) => t.type).sort((a, b) => a - b)).toEqual(Object.keys(UTL_V0_LINES).map(Number).sort((a, b) => a - b));
    for (const t of VTC_REQ_TYPES) expect(t.make()).toHaveLength(UTL_V0_LINES[t.type]);
    // The Requirement Type dropdown: Enable/Disable, then the rest by name (Form1.SetCurrentReq's SortedList).
    expect(VTC_REQ_MENU.slice(0, 4).map((t) => t.name)).toEqual(['Enable/Disable', 'Armor Type Similar Color', 'Base Skill Range', 'Buffed Double Value Key >=']);
    expect(VTC_REQ_MENU).toHaveLength(VTC_REQ_TYPES.length);
  });

  it('the list shows each requirement as VTClassic\'s DisplayString does', () => {
    expect(vtcReqText({ type: 3, lines: ['10000', '19'] })).toBe('Value >= 10000');
    expect(vtcReqText({ type: 12, lines: ['60', '131'] })).toBe('Material == 60 (Gold)');
    expect(vtcReqText({ type: 1, lines: ['^Pyreal', '1'] })).toBe('Name matches: ^Pyreal');
    expect(vtcReqText({ type: 5, lines: ['1.15', '29'] })).toBe('MeleeDefenseBonus >= 1.15');
    expect(vtcReqText({ type: 9, lines: ['Legendary', 'Minor', '2'] })).toBe('SpellMatch: Legendary, but not Minor [2 times]');
    expect(vtcReqText({ type: 11, lines: ['16', '218103831'] })).toBe('Flags has flags 16 (0x10)');
    expect(vtcReqText({ type: 7, lines: ['31'] })).toBe('ObjectClass = WandStaffOrb');
    expect(vtcReqText({ type: 1004, lines: ['34', '200', '999'] })).toBe('Base WarMagic [200-999]');
    expect(vtcReqText({ type: 9999, lines: ['true'] })).toBe('This rule is currently disabled');
    expect(vtcReqText({ type: 4242, lines: [] })).toBe('UNSUPPORTED REQUIREMENT');
    // Dark red (needs the item examined): GameInfo.IsIDProperty.
    expect(vtcReqType(3)!.needsId(['1', '19'])).toBe(false);
    expect(vtcReqType(3)!.needsId(['1', '105'])).toBe(true);
    expect(vtcRuleNeedsId({ name: '', action: 1, reqs: [] })).toBe(true);
  });

  it('fields read and write the lines as VTClassic\'s UI_* do: hex colours, parse failures to 0, bad regexes escaped', () => {
    const c = vtcReqType(16)!;
    expect(c.values[1]!.get(['255', '0', '16', '10', '0.1', '3'])).toBe('FF0010');
    expect(c.values[1]!.set(c.make(), '00ff80').slice(0, 3)).toEqual(['0', '255', '128']);
    expect(vtcReqType(3)!.values[1]!.set(['5', '19'], 'abc')).toEqual(['0', '19']);
    expect(vtcReqType(0)!.values[1]!.set([''], 'Epic (')).toEqual(['Epic \\(']);
    expect(vtcReqType(9999)!.actsOn!.set(['true'], 1)).toEqual(['false']);
    expect(vtcReqType(17)!.values[2]!.set(['0', '0'], '1F2')).toEqual(['0', '498']);
  });

  it('Toggle this rule and Auto-Sort Rules as VTClassic\'s editor does them', () => {
    const r: UtlRule = { name: 'x', action: 1, reqs: [{ type: 9999, lines: ['false'] }, { type: 3, lines: ['1', '19'] }] };
    const off = vtcToggleRule(r);
    expect(off.reqs).toEqual([{ type: 3, lines: ['1', '19'] }, { type: 9999, lines: ['true'] }]);
    expect(vtcToggleRule(off).reqs).toEqual([{ type: 3, lines: ['1', '19'] }]);
    const sorted = vtcAutoSort([
      { name: 'b sell', action: 3, reqs: [] }, { name: 'z keep id', action: 1, reqs: [{ type: 3, lines: ['1', '105'] }] },
      { name: 'y keep#', action: 10, reqs: [{ type: 1, lines: ['x', '1'] }] }, { name: 'a salvage', action: 2, reqs: [] },
    ]);
    expect(sorted.map((x) => x.name)).toEqual(['y keep#', 'z keep id', 'a salvage', 'b sell']);
  });
});

describe('a rule in the editor and back (lootRuleToUtl / utlToLoot)', () => {
  it('every requirement this engine tests survives editor → document → .utl → import', () => {
    const u: UtlRule = { name: 'Everything', action: 10, keepCount: 5, reqs: [
      { type: 7, lines: ['2'] }, { type: 0, lines: ['Legendary'] }, { type: 9, lines: ['Epic', 'Minor', '2'] }, { type: 1, lines: ['^Gold', '1'] },
      { type: 1, lines: ['Tusker', '16'] }, { type: 2, lines: ['500', '5'] }, { type: 3, lines: ['10000', '19'] }, { type: 12, lines: ['60', '131'] },
      { type: 13, lines: ['0', '33'] }, { type: 11, lines: ['1', '179'] }, { type: 4, lines: ['1.5', '167772174'] }, { type: 5, lines: ['1.15', '29'] },
      { type: 8, lines: ['3'] }, { type: 10, lines: ['20'] }, { type: 14, lines: ['255', '0', '0', '10', '0.1'] }, { type: 16, lines: ['0', '0', '255', '12', '0.2', '4'] },
      { type: 15, lines: ['0', '255', '0', '10', '0.1', 'Amuli Coat (Chest)'] }, { type: 17, lines: ['2', '498'] }, { type: 1000, lines: ['300', '34'] },
      { type: 1001, lines: ['5'] }, { type: 1002, lines: ['50'] }, { type: 1003, lines: ['200'] }, { type: 1004, lines: ['34', '100', '400'] }, { type: 2007, lines: ['10'] },
    ] };
    const rule = utlToLoot([u]).value[0];
    expect(rule.match.unsupported).toBeUndefined();
    // Both spell requirements must hold (before 2026-10-11 the import kept only the last).
    expect(rule.match.spells).toEqual({ match: 'Legendary', count: 1 });
    expect(rule.match.moreSpells).toEqual([{ match: 'Epic', notMatch: 'Minor', count: 2 }]);
    expect(validateRoutineDoc(docWith(base({ loot: [rule] })))).toEqual([]);
    const back = lootRuleToUtl(rule);
    expect(back.cant).toEqual([]);
    expect(utlToLoot([back.rule]).value[0]).toEqual(rule);
    const file = exportUtl('All', [rule]);
    expect(file.problems).toEqual([]);
    expect(utlToLoot(parseUtl(file.text)).value).toEqual([rule]);
  });

  it('requirements the engine can\'t test stay editable and go back out as written; a disabled rule carries Enable/Disable', () => {
    const u: UtlRule = { name: 'Buffed', action: 2, reqs: [{ type: 2000, lines: ['40'] }, { type: 6, lines: ['1.3'] }, { type: 9999, lines: ['true'] }] };
    const rule = utlToLoot([u]).value[0];
    expect(rule.disabled).toBe(true);
    expect(rule.vtc?.reqs).toEqual([{ type: 2000, lines: ['40'] }, { type: 6, lines: ['1.3'] }]);
    expect(lootRuleToUtl(rule).rule).toEqual({ name: 'Buffed', action: 2, reqs: [{ type: 2000, lines: ['40'] }, { type: 6, lines: ['1.3'] }, { type: 9999, lines: ['true'] }] });
  });

  it('a docked-panel rule VTClassic can\'t hold says what', () => {
    const r: LootRule = { label: 'Both', action: 'keep', match: { types: ['Armor', 'Jewelry'], appraisal: 'Epic' } };
    expect(lootRuleToUtl(r).cant).toEqual(['appraisal text /Epic/ (VTClassic tests properties, not the appraisal text)', 'any of 2 item types (VTClassic\'s ObjectClass is one class)']);
  });
});

describe('the loot editor in the VirindiTank window (Profiles → Looting)', () => {
  it('New pastes "/vt loot new " for the player to name (VTank CHG .172); /vt loot new makes the blank profile, loads it and opens its editor', async () => {
    pasted.length = 0;
    const t = await open();
    click(t.body.querySelector('[data-vtank="loot-new"]'));
    expect(pasted).toEqual(['/vt loot new ']);
    expect(await t.win.command('/vt loot new Keepers.utl')).toEqual(['Created blank profile Keepers.utl.']);
    expect(t.dialogs.map((d) => d.title)).toEqual(['Virindi Tank Loot Editor - Keepers.utl']);
    const d = t.saved.at(-1)!.profiles[0];
    expect(d.lootSet).toBe('Keepers');
    expect(d.lootSets).toEqual({ Keepers: [] });
    expect(await t.win.command('/vt loot new Keepers')).toEqual(['loot profile "Keepers" already exists (/vt loot load Keepers)']);
    expect(await t.win.command('/vt loot new')).toEqual(['/vt loot new <name>[.utl]']);
    t.redraw();
    expect((t.body.querySelector('[data-vtank="loot-show-editor"]') as HTMLElement).dataset.on).toBe('1');
    expect((t.body.querySelector('[data-vtank="loot-profile"]') as HTMLElement).dataset.field).toBe('Keepers');
  });

  it('without a chat box New makes "Loot 1" at once and opens it', async () => {
    const t = await open(docWith(base()), false);
    click(t.body.querySelector('[data-vtank="loot-new"]'));
    expect(t.dialogs.map((d) => d.title)).toEqual(['Virindi Tank Loot Editor - Loot 1.utl']);
    expect(t.win.profile()!.lootSet).toBe('Loot 1');
  });

  it('builds a rule: name, action with Keep #, requirements of several types, reorder, clone, delete, toggle; each change saves and reaches the run', async () => {
    const t = await open(docWith(base({ lootSets: { Main: [{ label: 'Pyreals', action: 'keep', match: { name: '^Pyreals?$' } }] }, lootSet: 'Main' })));
    // The macro runs: each change reaches it at once.
    t.win.runMacro(true, t.redraw);
    // Show Editor opens the Looting profile (Main).
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    expect(t.dialogs[0].title).toBe('Virindi Tank Loot Editor - Main.utl');
    expect(t.rowTexts('rules')).toEqual(['Pyreals']);
    click(t.q('[data-vtank="loot-rule-new"]'));
    expect(t.rowTexts('rules')).toEqual(['Pyreals', 'New Rule']);
    type(t.q('[data-vtank="loot-rule-name"]'), 'Big gems');
    expect(t.rowTexts('rules')).toEqual(['Pyreals', 'Big gems']);
    pick(t.q('[data-vtank="loot-action"]'), 'Keep #');
    type(t.q('[data-vtank="loot-keep-count"]'), '25');
    // ObjectClass = Gem.
    click(t.q('[data-vtank="loot-req-new"]'));
    expect(t.rowTexts('reqs')).toEqual(['SpellNameMatch: ']);
    pick(t.q('[data-vtank="loot-req-type"]'), 'ObjectClass');
    pick(t.q('[data-vtank="loot-acts-on"]'), 'Gem');
    // Value >= 10000: Long Value Key >=, Acts on Value, Long Value 10000.
    click(t.q('[data-vtank="loot-req-new"]'));
    pick(t.q('[data-vtank="loot-req-type"]'), 'Long Value Key >=');
    pick(t.q('[data-vtank="loot-acts-on"]'), 'Value');
    type(t.q('[data-vtank="loot-value-1"]'), '10000');
    // A colour: One Similar Color, hex, with the sample shown.
    click(t.q('[data-vtank="loot-req-new"]'));
    pick(t.q('[data-vtank="loot-req-type"]'), 'One Similar Color');
    type(t.q('[data-vtank="loot-value-1"]'), 'FF0000');
    expect((t.q('[data-vtank="loot-colour"]') as HTMLElement).dataset.rgb).toBe('255,0,0');
    // A buffed requirement this engine can't test: kept, editable.
    click(t.q('[data-vtank="loot-req-new"]'));
    pick(t.q('[data-vtank="loot-req-type"]'), 'Calced Buffed Median Damage >=');
    type(t.q('[data-vtank="loot-value-1"]'), '35');
    expect(t.rowTexts('reqs')).toEqual(['ObjectClass = Gem', 'Value >= 10000', 'Any Color Color [A=255, R=255, G=0, B=0]: 10, 0.1', 'Buffed Median Damage >= 35']);
    await flush();
    let rule = t.saved.at(-1)!.profiles[0].lootSets!.Main[1];
    expect(rule).toEqual({
      label: 'Big gems', action: 'keep-up-to', count: 25,
      match: { types: ['Gem'], valueAtLeast: 10000, colours: [{ rgb: [255, 0, 0], maxHue: 10, maxSV: 0.1 }], unsupported: 'buffed median damage (35)' },
      vtc: { reqs: [{ type: 2000, lines: ['35'] }] },
    });
    expect(t.calls.some((c) => c.startsWith('update Hunt') && c.includes('Big gems'))).toBe(true);
    // Delete the buffed one (select it, Delete), Clone the colour, then Toggle this rule.
    click(t.q('[data-vtank-loot-req="3"]'));
    click(t.q('[data-vtank="loot-req-delete"]'));
    click(t.q('[data-vtank-loot-req="2"]'));
    click(t.q('[data-vtank="loot-req-clone"]'));
    expect(t.rowTexts('reqs')).toHaveLength(4);
    click(t.q('[data-vtank="loot-toggle"]'));
    expect(t.rowTexts('reqs').at(-1)).toBe('This rule is currently disabled');
    expect((t.q('[data-vtank-loot-rule="1"]') as HTMLElement).dataset.off).toBe('1');
    await flush();
    rule = t.saved.at(-1)!.profiles[0].lootSets!.Main[1];
    expect(rule.disabled).toBe(true);
    expect(rule.match.unsupported).toBeUndefined();
    expect(rule.match.colours).toHaveLength(2);
    // Enable it again through its Enable/Disable requirement's Status.
    click(t.q('[data-vtank-loot-req="4"]'));
    pick(t.q('[data-vtank="loot-acts-on"]'), 'Enabled');
    expect(t.rowTexts('reqs').at(-1)).toBe('This rule is active');
    // Reorder: Move Up puts it first (rules are checked in order); Clone; Delete.
    click(t.q('[data-vtank="loot-rule-up"]'));
    expect(t.rowTexts('rules')).toEqual(['Big gems', 'Pyreals']);
    click(t.q('[data-vtank="loot-rule-clone"]'));
    expect(t.rowTexts('rules')).toEqual(['Big gems', 'Pyreals', 'Big gems']);
    click(t.q('[data-vtank="loot-rule-delete"]'));
    click(t.q('[data-vtank-loot-rule="1"]'));
    click(t.q('[data-vtank="loot-rule-down"]'));
    expect(t.rowTexts('rules')).toEqual(['Big gems', 'Pyreals']);
    await flush();
    const set = t.saved.at(-1)!.profiles[0].lootSets!.Main;
    expect(set.map((r) => [r.label, r.disabled ?? false])).toEqual([['Big gems', false], ['Pyreals', false]]);
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
    // File → Save As: the .utl, which imports back to the same rules.
    downloads.length = 0;
    pick(t.q('[data-vtank-loot-menu="file"]'), 'Save As');
    expect(downloads.map((x) => x.name)).toEqual(['Main.utl']);
    expect(utlToLoot(parseUtl(downloads[0].text)).value).toEqual(set);
    // Show Editor off closes it.
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    expect(t.dialogs).toHaveLength(0);
  });

  it('[This profile]: the profile\'s own rules; Edit → Copy / Paste Rule, Rule → Auto-Sort, the search box and the Info lookups', async () => {
    const t = await open(docWith(base({ loot: [
      { label: 'Sell trash', action: 'sell', match: { valueAtMost: 100 } },
      { label: 'Keep scrolls', action: 'keep', match: { types: ['Misc'] } },
    ] })));
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    expect(t.dialogs[0].title).toBe('Virindi Tank Loot Editor - Hunt.utl');
    type(t.q('[data-vtank="loot-search"]'), 'scroll');
    expect((t.q('[data-vtank-loot-rule="1"]') as HTMLElement).dataset.selected).toBe('1');
    pick(t.q('[data-vtank-loot-menu="edit"]'), 'Copy Rule');
    pick(t.q('[data-vtank-loot-menu="edit"]'), 'Paste Rule');
    expect(t.rowTexts('rules')).toEqual(['Sell trash', 'Keep scrolls', 'Keep scrolls']);
    pick(t.q('[data-vtank-loot-menu="rule"]'), 'Auto-Sort Rules');
    expect(t.rowTexts('rules')).toEqual(['Keep scrolls', 'Keep scrolls', 'Sell trash']);
    pick(t.q('[data-vtank="loot-info-material"]'), 'Gold');
    expect((t.q('[data-vtank="loot-info-material-id"]') as HTMLElement).textContent).toBe('60');
    await flush();
    expect(t.saved.at(-1)!.profiles[0].loot.map((r) => r.label)).toEqual(['Keep scrolls', 'Keep scrolls', 'Sell trash']);
  });

  it('Rule menu forms: Add/Update Salvage Rules, Update Workmanship Requirements, Add Packslot Requirements (VTClassic\'s macros)', async () => {
    const t = await open(docWith(base({ lootSets: { Main: [{ label: 'S: Brass', action: 'salvage', match: { name: 'old' } }, { label: 'Keep gear', action: 'keep', match: { props: [{ kind: 'int', key: 105, op: 'le', value: 6 }] } }] }, lootSet: 'Main' })));
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    pick(t.q('[data-vtank-loot-menu="rule"]'), 'Add/Update Salvage Rules');
    expect(t.q('[data-vtank="loot-form-group"]')!.getAttribute('data-field')).toBe('Armor Imbues');
    pick(t.q('[data-vtank="loot-form-group"]'), 'Brass/Granite/Iron/Mahog');
    // "Add rules": the three missing materials; the existing S: Brass is left as it was.
    click(t.q('[data-vtank="loot-form-add"]'));
    expect(t.rowTexts('rules')).toEqual(['S: Brass', 'Keep gear', 'S: Granite', 'S: Iron', 'S: Mahogany']);
    let set = t.win.profile()!.lootSets!.Main;
    expect(set[0].match).toEqual({ name: 'old' });
    expect(set[2]).toEqual({ label: 'S: Granite', action: 'salvage', match: { props: [{ kind: 'int', key: 131, op: 'le', value: 67 }, { kind: 'int', key: 131, op: 'ge', value: 67 }, { kind: 'int', key: 105, op: 'ge', value: 10 }] } });
    // "Add/Update rules" rewrites S: Brass too.
    pick(t.q('[data-vtank-loot-menu="rule"]'), 'Add/Update Salvage Rules');
    pick(t.q('[data-vtank="loot-form-group"]'), 'Brass/Granite/Iron/Mahog');
    click(t.q('[data-vtank="loot-form-update"]'));
    set = t.win.profile()!.lootSets!.Main;
    expect(set[0].match.props?.[0]).toEqual({ kind: 'int', key: 131, op: 'le', value: 57 });
    expect(set).toHaveLength(5);
    // Update Workmanship Requirements by +2 for Salvage: SalvageWorkmanship >= 10 stays at most 10; by -3: 7.
    pick(t.q('[data-vtank-loot-menu="rule"]'), 'Update Workmanship Requirements');
    pick(t.q('[data-vtank="loot-form-action"]'), 'Salvage');
    t.win.loot.form = { kind: 'work', action: 2, by: -3 };
    t.dialogs[0].redraw();
    click(t.q('[data-vtank="loot-form-update"]'));
    expect(t.win.profile()!.lootSets!.Main[2].match.props?.[2]).toEqual({ kind: 'int', key: 105, op: 'ge', value: 7 });
    // Add Packslot Requirements: Free Main Pack Slots >= 3 on every Keep rule that lacks one.
    pick(t.q('[data-vtank-loot-menu="rule"]'), 'Add Packslot Requirements');
    type(t.q('[data-vtank="loot-form-slots"]'), '3');
    click(t.q('[data-vtank="loot-form-add"]'));
    set = t.win.profile()!.lootSets!.Main;
    expect(set[1].match.freeSlotsAtLeast).toBe(3);
    expect(set[0].match.freeSlotsAtLeast).toBeUndefined();
    await flush();
    expect(validateRoutineDoc(t.saved.at(-1)!)).toEqual([]);
  });

  it('File → Open loads a .utl from disk as the loot profile of its name, with its salvage bands; Combine → Export / Import Ranges', async () => {
    downloads.length = 0;
    opened.length = 0;
    const t = await open(docWith(base()));
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    const src = exportUtl('Trade', [{ label: 'Pyreals', action: 'keep', match: { name: '^Pyreal' } }, { label: 'Buffed', action: 'keep', match: { unsupported: 'x' }, vtc: { reqs: [{ type: 2000, lines: ['40'] }] } }],
      { blocks: [{ type: 'SalvageCombine', body: '1\r\n1-5, 6-10\r\n1\r\n60\r\n1-10\r\n' }] }).text;
    nextFile = { name: 'C:\\VirindiTank\\Trade.utl', text: src };
    pick(t.q('[data-vtank-loot-menu="file"]'), 'Open');
    nextFile = null;
    expect(opened).toEqual(['.utl']);
    expect(t.dialogs[0].title).toBe('Virindi Tank Loot Editor - Trade.utl');
    expect(t.rowTexts('rules')).toEqual(['Pyreals', 'Buffed']);
    expect((t.q('[data-vtank="loot-message"]') as HTMLElement).textContent).toBe("Loaded Trade.utl: 2 rules; 1 with requirements this client can't test yet (kept).");
    expect(t.win.profile()!.salvageCombineSets?.Trade).toEqual({ default: '1-5, 6-10', materials: { 60: '1-10' } });
    pick(t.q('[data-vtank-loot-menu="combine"]'), 'Export Ranges');
    expect(downloads.at(-1)).toEqual({ name: 'Trade.ucr', text: '1\r\n1-5, 6-10\r\n1\r\n60\r\n1-10\r\n' });
    nextFile = { name: 'wide.ucr', text: '1\n1-10\n0\n' };
    pick(t.q('[data-vtank-loot-menu="combine"]'), 'Import Ranges');
    nextFile = null;
    expect(t.win.profile()!.salvageCombineSets?.Trade).toEqual({ default: '1-10', materials: {} });
    expect(t.rowTexts('combine')).toEqual([]);
  });

  it('a rule VTClassic can\'t hold is shown with why, and only toggled', async () => {
    const t = await open(docWith(base({ loot: [{ label: 'Either', action: 'keep', match: { types: ['Armor', 'Jewelry'] } }] })));
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    click(t.q('[data-vtank-loot-rule="0"]'));
    expect(t.q('[data-vtank="loot-rule-name"]')).toBeNull();
    expect(Array.from(t.dlg().querySelectorAll('[data-text]')).some((e) => /can't hold any of 2 item types/.test((e as HTMLElement).dataset.text!))).toBe(true);
    click(t.q('[data-vtank="loot-toggle"]'));
    expect(t.win.profile()!.loot[0]).toEqual({ label: 'Either', action: 'keep', match: { types: ['Armor', 'Jewelry'] }, disabled: true });
  });

  it('Salvage Combination: the loot set\'s bands from VTClassic\'s defaults; New, Material, Combine Range, value mode, Delete; written to the .utl', async () => {
    const t = await open(docWith(base({ lootSets: { Main: [] }, lootSet: 'Main' })));
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    click(t.q('[data-vtank-loot-tab="salvage"]'));
    expect((t.q('[data-vtank="combine-default"]') as HTMLInputElement).value).toBe('1-6, 7-8, 9, 10');
    expect(t.rowTexts('combine')).toHaveLength(25);
    expect(t.rowTexts('combine')[0]).toBe('Agate: 1-10');
    type(t.q('[data-vtank="combine-default"]'), '1-5, 6-8, 9, 10');
    click(t.q('[data-vtank="combine-new"]'));
    // The first material without its own bands, by name: Alabaster (66).
    expect(t.rowTexts('combine').at(-1)).toBe('Alabaster: 1-5, 6-8, 9, 10');
    pick(t.q('[data-vtank="combine-material"]'), 'Gold');
    type(t.q('[data-vtank="combine-range"]'), '1-8, 9-10');
    click(t.q('[data-vtank="combine-value-mode"] [data-check]'));
    expect(t.rowTexts('combine')).toContain('Gold: 1-8, 9-10, Val >= 390000');
    type(t.q('[data-vtank="combine-value"]'), '200000');
    await flush();
    const sc = t.saved.at(-1)!.profiles[0].salvageCombineSets!.Main;
    expect(sc.default).toBe('1-5, 6-8, 9, 10');
    expect(sc.materials!['60']).toBe('1-8, 9-10');
    expect(sc.valueModes).toEqual({ 60: 200000 });
    const f = exportVTank(t.win.profile()!, 'utl', 'Main')!;
    expect(parseUtlFile(f.text).salvageCombine).toEqual(sc);
    click(t.q('[data-vtank-combine="60"]'));
    click(t.q('[data-vtank="combine-delete"]'));
    expect(t.win.profile()!.salvageCombineSets!.Main.materials!['60']).toBeUndefined();
    expect(t.win.profile()!.salvageCombineSets!.Main.valueModes).toBeUndefined();
  });

  it('Edit Meta Rule takes the dialog\'s place: the Show Editor box follows', async () => {
    const t = await open();
    click(t.body.querySelector('[data-vtank="loot-show-editor"] [data-check]'));
    expect(t.win.loot.open).toBe(true);
    t.win.editRule('Default', 0, t.redraw);
    expect(t.win.loot.open).toBe(false);
  });
});

describe('GameUI hosts the loot editor', () => {
  it('New fills the chat box with "/vt loot new "; the editor floats in its VVS frame with VTClassic\'s title', async () => {
    const ui = H.ui as unknown as { setAutomationSource(s: VTankSource | null): void; toggleAutomationWindow(): void; vtankModel: { command(l: string): Promise<string[]> } };
    ui.setAutomationSource(fakeSource(docWith(base())).source);
    ui.toggleAutomationWindow();
    await new Promise((r) => setTimeout(r, 0));
    const win = H.container.querySelector('[data-vtank-window]') as HTMLElement;
    click(win.querySelector('[data-vtank-tab="profiles"]'));
    // The chat entry (built from the DAT layout in the game; this fixture has no DATs, so one stands in by its id).
    const real = document.getElementById('chat-input') as HTMLInputElement | null;
    const chat = real ?? Object.assign(document.body.appendChild(document.createElement('input')), { id: 'chat-input' });
    click(win.querySelector('[data-vtank="loot-new"]'));
    expect(chat.value).toBe('/vt loot new ');
    expect(document.activeElement).toBe(chat);
    if (!real) chat.remove();
    expect(await ui.vtankModel.command('/vt loot new Salvage')).toEqual(['Created blank profile Salvage.utl.']);
    const dlg = H.container.querySelector('[data-vtank-dialog]') as HTMLElement;
    expect(dlg.textContent).toContain('Virindi Tank Loot Editor - Salvage.utl');
    expect(dlg.querySelector('[data-vtank="loot-editor"]')).not.toBeNull();
    click(dlg.querySelector('[data-vtank="loot-rule-new"]'));
    expect(dlg.querySelector('[data-vtank-loot-rule="0"]')).not.toBeNull();
    // The dialog's own close box unticks Show Editor.
    const model = ui.vtankModel as unknown as { loot: { open: boolean } };
    expect(model.loot.open).toBe(true);
    click(dlg.querySelector('[data-vtank-close]'));
    expect(H.container.querySelector('[data-vtank-dialog]')).toBeNull();
    expect(model.loot.open).toBe(false);
    expect((win.querySelector('[data-vtank="loot-show-editor"]') as HTMLElement).dataset.on).toBe('0');
    ui.toggleAutomationWindow();
    ui.setAutomationSource(null);
  });
});

describe('the engine runs what the editor makes', () => {
  it('every spell requirement of a rule must hold (moreSpells)', async () => {
    const { lootRuleFor } = await import('../packages/renderer/src/agent/RoutineEngine.js');
    const [rule] = utlToLoot([{ name: 'Leg + Epic', action: 1, reqs: [{ type: 0, lines: ['Legendary'] }, { type: 9, lines: ['Epic', 'Minor', '2'] }] }]).value;
    const item = (spells: string[]) => ({ name: 'Sword', props: { spells } });
    expect(lootRuleFor([rule], item(['Legendary Strength', 'Epic Focus', 'Epic Willpower']))).toBe(rule);
    // Only the first used to count: a Legendary item with one Epic spell matched.
    expect(lootRuleFor([rule], item(['Legendary Strength', 'Epic Focus']))).toBeNull();
    expect(lootRuleFor([rule], item(['Epic Focus', 'Epic Willpower']))).toBeNull();
  });

  it('an edit while the macro runs keeps the loaded loot set, with the edit; a new Looting profile loads that one', async () => {
    const { AgentApi } = await import('../packages/renderer/src/agent/AgentApi.js');
    const { FakeHost } = await import('./_harness/agentFake.js');
    const api = new AgentApi(new FakeHost());
    const p = base({ loot: [{ label: 'own', action: 'keep', match: { name: 'A' } }], lootSets: { Main: [{ label: 'main', action: 'keep', match: { name: 'B' } }], Other: [] }, lootSet: 'Main' });
    expect(api.routine.start(structuredClone(p)).ok).toBe(true);
    expect(api.routine.current()!.loot.map((r) => r.label)).toEqual(['main']);
    p.lootSets!.Main.push({ label: 'edited', action: 'sell', match: { name: 'C' } });
    api.routine.update(structuredClone(p));
    // Before 2026-10-11 an update put the profile's own rules ("own") in the loaded set's place.
    expect(api.routine.current()!.loot.map((r) => r.label)).toEqual(['main', 'edited']);
    api.routine.update({ ...structuredClone(p), lootSet: 'Other' });
    expect(api.routine.current()!.loot).toEqual([]);
    api.routine.update({ ...structuredClone(p), lootSet: undefined });
    expect(api.routine.current()!.loot.map((r) => r.label)).toEqual(['own']);
    api.routine.stop();
  });
});
