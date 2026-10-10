/**
 * AGENT.automation-panel — the Automation panel and its editor (ui/
 * automation/AutomationPanel.ts) over a fake kit and source, then mounted by
 * the real GameUI in the panels window (stub layout renderer, no DATs): what
 * the player sees and what each control does to the run and the document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { EXAMPLE_HUNT_PROFILE, emptyRoutineDoc, validateRoutineDoc, type RoutineDoc, type RoutineProfile } from '../packages/shared/src/routines/index.js';
import type { RoutineStats, RoutineStatus } from '../packages/renderer/src/agent/RoutineEngine.js';
import type { AutomationKit, AutomationSource, ModuleKey, RoutineEditor } from '../packages/renderer/src/ui/automation/AutomationPanel.js';

type PanelModule = typeof import('../packages/renderer/src/ui/automation/AutomationPanel.js');
let H: GameUIFixture;
let M: PanelModule;
beforeAll(async () => {
  H = await mountGameUI();
  M = await import('../packages/renderer/src/ui/automation/AutomationPanel.js');
});
afterAll(() => H.teardown());

/** Plain DOM stand-ins for the retail parts, with the hooks a test needs. A menu records itself so a test can pick from it. */
let lastMenu: { items: Array<{ label: string; value: string; group?: string }>; pick: (v: string) => void; opts?: { search?: boolean; groups?: string[] } } | null = null;
function fakeKit(): AutomationKit {
  return {
    text: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    button: (label, onClick) => { const b = document.createElement('div'); b.dataset.button = label; b.textContent = label; b.addEventListener('click', onClick); return b; },
    tab: (label, on, onClick) => { const b = document.createElement('div'); b.dataset.tab = label; b.dataset.selected = on ? '1' : '0'; b.addEventListener('click', onClick); return b; },
    check: (on, onChange) => { const r = document.createElement('div'); r.dataset.check = on ? '1' : '0'; r.addEventListener('click', () => onChange(!on)); return r; },
    field: (text, onClick) => { const f = document.createElement('div'); f.dataset.field = text; f.addEventListener('click', () => onClick(f)); return f; },
    menu: (_a, items, onPick, opts) => { lastMenu = { items, pick: onPick, opts }; },
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (selected, onClick) => { const r = document.createElement('div'); r.dataset.selected = selected ? '1' : '0'; if (onClick) r.addEventListener('click', onClick); return r; },
    box: () => document.createElement('div'),
    header: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    dot: (lit) => { const d = document.createElement('div'); d.dataset.dot = lit ? '1' : '0'; return d; },
    separator: () => document.createElement('hr'),
    scroll: () => {},
    plate: (w, h) => { const d = document.createElement('div'); d.style.width = `${w}px`; d.style.height = `${h}px`; return d; },
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
  };
}
/** Open the menu behind a field and pick `value` (by value or label). */
function pickFrom(field: HTMLElement | null, value: string): void {
  if (!field) throw new Error('no field');
  field.click();
  const m = lastMenu!;
  const it = m.items.find((i) => i.value === value || i.label === value);
  if (!it) throw new Error(`no menu item ${value} in ${m.items.map((i) => i.label).join(', ')}`);
  m.pick(it.value);
}

function fakeSource(doc: RoutineDoc) {
  const calls: string[] = [];
  let status: RoutineStatus = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  let running: RoutineProfile | null = null;
  const stats: RoutineStats = { startedAt: 0, xpGained: 9000, kills: 12, deaths: 0, kept: 5, left: 9, sold: 2, rebuffs: 1, stateTime: { Hunt: 9000, Recover: 1000 } };
  const saved: RoutineDoc[] = [];
  const reports: string[] = [];
  const source: AutomationSource = {
    load: async () => ({ ok: true, doc: structuredClone(doc) }),
    save: async (d) => { const issues = validateRoutineDoc(d); if (issues.length) return { ok: false, message: 'not saved', issues }; saved.push(structuredClone(d)); return { ok: true, doc: structuredClone(d) }; },
    status: () => status,
    stats: () => stats,
    current: () => running,
    run: (p) => { calls.push(`run ${p.name}`); running = structuredClone(p); status = { ...status, running: true, profile: p.name, state: p.initialState }; return { ok: true, message: 'running' }; },
    pause: () => { calls.push('pause'); status = { ...status, paused: true }; return { ok: true, message: 'paused' }; },
    resume: () => { calls.push('resume'); status = { ...status, paused: false }; return { ok: true, message: 'resumed' }; },
    stop: () => { calls.push('stop'); running = null; status = { ...status, running: false, paused: false }; return { ok: true, message: 'stopped' }; },
    setModule: (m: ModuleKey, on: boolean) => { calls.push(`module ${m} ${on}`); if (running) running.modules[m] = on; return { ok: true, message: '' }; },
    resetStats: () => { calls.push('reset'); },
    report: (t) => reports.push(t),
    character: () => 'Claude',
    coords: () => '42.1N, 33.6E',
    step: () => { calls.push('step'); return { ok: true, message: 'stepping' }; },
    history: () => ['00:00:01 started', '00:00:05 attack-nearest: killed Drudge'],
    items: () => [{ name: 'Leather Cap', type: 'Armor', value: 900 }, { name: 'Pyreals', type: 'Money', value: 25 }, { name: 'Old Rag', type: 'Clothing', value: 5 }],
    spells: () => [{ name: 'Strength Self I', school: 'Creature Enchantment' }],
    buffs: () => [{ name: 'Strength Self I', remaining: 300 }],
    now: () => 3_600_000,
  };
  return { source, calls, saved, reports };
}

const docWith = (...profiles: RoutineProfile[]): RoutineDoc => ({ ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles });
const click = (root: HTMLElement, sel: string) => { const e = root.querySelector(sel) as HTMLElement | null; if (!e) throw new Error(`no ${sel}`); e.click(); };
const texts = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-text]')).map((e) => (e as HTMLElement).dataset.text);

describe('the Automation panel (mock board 1)', () => {
  async function open(doc = docWith(structuredClone(EXAMPLE_HUNT_PROFILE))) {
    const f = fakeSource(doc);
    let editor: RoutineEditor | null = null;
    const panel = new M.AutomationPanel(fakeKit(), f.source, (e) => { editor = e; });
    const body = document.createElement('div');
    const redraw = () => panel.render(body, 284, 337, redraw);
    await panel.load(redraw);
    return { ...f, panel, body, redraw, editor: () => editor };
  }

  it('a Profile dropdown, a status box, Run → Pause / Stop / Edit…', async () => {
    const t = await open(docWith(structuredClone(EXAMPLE_HUNT_PROFILE), { ...structuredClone(EXAMPLE_HUNT_PROFILE), name: 'Other' }));
    expect((t.body.querySelector('[data-automation="profile"]') as HTMLElement).dataset.field).toBe(EXAMPLE_HUNT_PROFILE.name);
    pickFrom(t.body.querySelector('[data-automation="profile"]'), 'Other');
    expect((t.body.querySelector('[data-automation="profile"]') as HTMLElement).dataset.field).toBe('Other');
    expect(texts(t.body.querySelector('[data-automation="status"]') as HTMLElement)).toEqual(['Stopped', 'Starts in Hunt']);
    click(t.body, '[data-automation="run"]');
    expect(t.calls).toEqual(['run Other']);
    expect(texts(t.body)).toContain('Running: Hunt');
    expect((t.body.querySelector('[data-automation="status"] [data-dot]') as HTMLElement).dataset.dot).toBe('1');
    click(t.body, '[data-automation="pause"]');
    expect(texts(t.body)).toContain('Nothing will act until you resume');
    click(t.body, '[data-automation="resume"]');
    click(t.body, '[data-automation="stop"]');
    expect(t.calls).toEqual(['run Other', 'pause', 'resume', 'stop']);
    click(t.body, '[data-automation="edit"]');
    expect(t.editor()).not.toBeNull();
  });

  it('module rows: switch, name, summary, › to that module\'s settings; no Service row (not built)', async () => {
    const t = await open();
    expect(Array.from(t.body.querySelectorAll('[data-automation-module]')).map((r) => (r as HTMLElement).dataset.automationModule)).toEqual(['buffs', 'vitals', 'combat', 'looting', 'navigation', 'inventory']);
    const combat = () => t.body.querySelector('[data-automation-module="combat"]') as HTMLElement;
    expect(texts(combat())).toEqual(['Combat', 'Fight Drudge within 40 m']);
    click(combat(), '[data-module-switch]');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.saved[0].profiles[0].modules.combat).toBe(false);
    click(t.body, '[data-automation="run"]');
    click(combat(), '[data-module-switch]');
    expect(t.calls).toContain('module combat true');
    expect(t.saved).toHaveLength(1); // a running switch is this run only
    click(t.body, '[data-module-settings="looting"]');
    expect(t.editor()).not.toBeNull();
  });

  it('the Stats tab: this session, rows, Reset, Report to chat', async () => {
    const t = await open();
    click(t.body, '[data-automation-tab="stats"]');
    expect(texts(t.body)).toContain('This session · 1:00:00');
    const rows = Object.fromEntries(Array.from(t.body.querySelectorAll('[data-automation-stat]')).map((r) => [(r as HTMLElement).dataset.automationStat, texts(r as HTMLElement)[1]]));
    expect(rows).toMatchObject({ 'XP per hour': '9,000', Kills: '12', Loot: '5 kept · 9 left · 2 sold', 'Time in each state': 'Hunt 90% · Recover 10%' });
    click(t.body, '[data-automation="report-stats"]');
    expect(t.reports).toContain('Kills: 12');
    click(t.body, '[data-automation="reset-stats"]');
    expect(t.calls).toContain('reset');
  });

  it('an account with no routines says how to make one', async () => {
    const t = await open(docWith());
    expect(texts(t.body)).toContain('No routines yet: Edit… makes one.');
  });
});

describe('the routine editor (mock board 2)', () => {
  async function editor(doc = docWith(structuredClone(EXAMPLE_HUNT_PROFILE)), tab?: 'routine' | 'combat' | 'buffs' | 'loot' | 'routes') {
    const f = fakeSource(doc);
    const savedDocs: RoutineDoc[] = [];
    const ed = new M.RoutineEditor(fakeKit(), f.source, structuredClone(doc), doc.profiles[0]?.name ?? null, (d) => savedDocs.push(d), tab);
    const body = document.createElement('div');
    const redraw = () => ed.render(body, 960, 560, redraw, () => {}, () => {}, () => {});
    redraw();
    return { ...f, ed, body, redraw, savedDocs };
  }

  it('a States column (counts, where it starts) and the state\'s rules as When … Do … sentences', async () => {
    const t = await editor();
    expect(Array.from(t.body.querySelectorAll('[data-automation-state]')).map((r) => texts(r as HTMLElement))).toEqual(EXAMPLE_HUNT_PROFILE.states.map((s) => [s.name, String(s.rules.length)]));
    expect(texts(t.body)).toContain('Starts in Hunt. The lit dot is the state running now.');
    // The name takes the row's spare width through a wrapper; the bitmap text itself is never stretched.
    const hunt = t.body.querySelector('[data-automation-state="Hunt"] [data-text="Hunt"]') as HTMLElement;
    expect(hunt.style.flexGrow).toBe('');
    expect((hunt.parentElement as HTMLElement).style.flexGrow).toBe('1');
    const rule0 = t.body.querySelector('[data-automation-rule="0"]') as HTMLElement;
    expect(texts(rule0)).toEqual(['1', 'When', '%', 'Do']);
    expect((rule0.querySelector('[data-automation-field="op"]') as HTMLElement).dataset.field).toBe('below');
    expect((rule0.querySelector('[data-automation-condition-kind]') as HTMLElement).dataset.field).toBe('Health');
    expect((rule0.querySelector('[data-automation-field="percent"]') as HTMLInputElement).value).toBe('40');
    expect((rule0.querySelector('[data-automation-action-kind]') as HTMLElement).dataset.field).toBe('Go to state');
    expect((rule0.querySelector('[data-automation-field="state"]') as HTMLElement).dataset.field).toBe('Recover');
  });

  it('conditions come from a categorized, searchable picker; a new rule edited in place saves', async () => {
    const t = await editor();
    click(t.body, '[data-automation="add-rule"]');
    const n = t.ed.doc.profiles[0].states[0].rules.length - 1;
    const rule = () => t.body.querySelector(`[data-automation-rule="${n}"]`) as HTMLElement;
    (rule().querySelector('[data-automation-condition-kind]') as HTMLElement).click();
    expect(lastMenu!.opts).toMatchObject({ search: true, groups: M.CONDITION_GROUPS });
    expect(lastMenu!.items.filter((i) => i.group === 'Inventory').map((i) => i.label)).toEqual(['Free pack slots', 'Item count', 'Burden', 'Vendor window open', 'No vendor window']);
    lastMenu!.pick('xp');
    const xp = rule().querySelector('[data-automation-field="xp"]') as HTMLInputElement;
    xp.value = '2000'; xp.dispatchEvent(new Event('input'));
    pickFrom(rule().querySelector('[data-automation-action-kind]'), 'train');
    const plan = rule().querySelector('[data-automation-field="plan"]') as HTMLInputElement;
    plan.value = 'Heavy Weapons 120, Endurance 80'; plan.dispatchEvent(new Event('input'));
    // ⋯ → add a condition (and): Health below.
    pickFrom(rule().querySelector('[data-rule-menu]'), 'add-cond');
    pickFrom(rule().querySelectorAll('[data-automation-condition-kind]')[1] as HTMLElement, 'vital-health');
    pickFrom(rule().querySelector('[data-automation-field="op"]'), 'vital-above');
    expect(await t.ed.save(t.redraw)).toBe(true);
    const r = t.saved[0].profiles[0].states[0].rules[n];
    expect(r.when).toEqual([{ kind: 'unassigned-xp-above', xp: 2000 }, { kind: 'vital-above', vital: 'health', percent: 50 }]);
    expect(r.do).toEqual([{ kind: 'train', plan: [{ stat: 'Heavy Weapons', upTo: 120 }, { stat: 'Endurance', upTo: 80 }] }]);
    expect(texts(t.body)).toContain('Saved to your account');
  });

  it('the ⋯ menu moves, duplicates, switches off and deletes rules', async () => {
    const t = await editor();
    const rules = () => t.ed.doc.profiles[0].states[0].rules;
    const first = rules()[0].label;
    expect((t.body.querySelector('[data-rule-menu="0"]') as HTMLElement).dataset.button).toBe('...'); // the AC font has no "⋯"
    pickFrom(t.body.querySelector('[data-rule-menu="0"]'), 'down');
    expect(rules()[1].label).toBe(first);
    pickFrom(t.body.querySelector('[data-rule-menu="1"]'), 'toggle');
    expect(rules()[1].disabled).toBe(true);
    expect((t.body.querySelector('[data-rule-on="1"]') as HTMLElement).dataset.check).toBe('0');
    const before = rules().length;
    pickFrom(t.body.querySelector('[data-rule-menu="1"]'), 'dup');
    pickFrom(t.body.querySelector('[data-rule-menu="1"]'), 'delete');
    expect(rules()).toHaveLength(before);
  });

  it('an invalid document is not saved and every problem is listed with its path', async () => {
    const t = await editor();
    t.ed.doc.profiles[0].states[0].rules[0].when = [{ kind: 'vital-below', vital: 'health', percent: 400 }];
    expect(await t.ed.save(t.redraw)).toBe(false);
    expect(t.saved).toHaveLength(0);
    expect(texts(t.body)).toContain('profiles[0].states[0].rules[0].when[0]: vital-below: percent must be 0..100');
  });

  it('renaming a state follows it everywhere it is named', async () => {
    const t = await editor();
    const p = t.ed.doc.profiles[0];
    click(t.body, '[data-automation-state="Recover"]');
    click(t.body, '[data-automation="rename-state"]');
    const name = t.body.querySelector('[data-automation="state-name"]') as HTMLInputElement;
    expect(name.value).toBe('Recover');
    name.value = 'Heal up'; name.dispatchEvent(new Event('input'));
    expect(p.states.map((s) => s.name)).toContain('Heal up');
    expect(p.states[0].rules[0].do).toEqual([{ kind: 'set-state', state: 'Heal up' }]);
  });

  it('the live strip shows the run; History and Step one rule', async () => {
    const t = await editor();
    t.source.run(EXAMPLE_HUNT_PROFILE);
    t.source.pause();
    t.redraw();
    const live = t.body.querySelector('[data-automation="live"]') as HTMLElement;
    expect(texts(live)).toEqual(expect.arrayContaining(['Paused', 'In Hunt']));
    click(live, '[data-automation="step"]');
    expect(t.calls).toContain('step');
    click(t.body, '[data-automation="history"]');
    expect(texts(t.body.querySelector('[data-automation="history-list"]') as HTMLElement)).toEqual(['00:00:01 started', '00:00:05 attack-nearest: killed Drudge']);
  });

  it('Loot: ordered rules with badges, requirements as subject / operator / value, Try it on what you carry', async () => {
    const t = await editor(undefined, 'loot');
    expect(Array.from(t.body.querySelectorAll('[data-automation-loot]')).map((r) => texts(r as HTMLElement).slice(1, 3))).toEqual([
      ['Keep', 'Money'], ['Keep', 'Gems'], ['Keep 5', 'Healing kits'], ['Sell', 'Valuable junk'], ['Leave', 'Everything else'],
    ]);
    click(t.body, '[data-automation-loot="3"]');
    // Choosing a rule to look at is not an edit (Save stays clean).
    expect(t.ed.dirty).toBe(false);
    expect(texts(t.body.querySelector('[data-requirement="valueAtLeast"]') as HTMLElement)).toEqual(['Value', 'at least']);
    pickFrom(t.body.querySelector('[data-automation="try-it"]'), 'Leather Cap');
    expect((t.body.querySelector('[data-automation="try-result"]') as HTMLElement).dataset.text).toBe('Leather Cap → Sell, matched rule 4');
    pickFrom(t.body.querySelector('[data-automation="try-it"]'), 'Pyreals');
    expect((t.body.querySelector('[data-automation="try-result"]') as HTMLElement).dataset.text).toBe('Pyreals → Keep, matched rule 1');
    // A burden limit the cap's pack entry can't show (no burden known) stops the rule: it falls through to Leave.
    pickFrom(t.body.querySelector('[data-automation="add-requirement"]'), 'burdenAtMost');
    expect(t.ed.doc.profiles[0].loot[3].match).toEqual({ valueAtLeast: 50, burdenAtMost: 0 });
    pickFrom(t.body.querySelector('[data-automation="try-it"]'), 'Leather Cap');
    expect((t.body.querySelector('[data-automation="try-result"]') as HTMLElement).dataset.text).toBe('Leather Cap → Leave, matched rule 5');
  });

  it('Buffs from your spellbook with time left; Routes with "Add where I stand"; new profiles', async () => {
    const t = await editor(docWith());
    pickFrom(t.body.querySelector('[data-automation="editor-profile"]'), 'new');
    expect(t.ed.doc.profiles.map((p) => p.name)).toEqual(['New routine 1']);
    click(t.body, '[data-automation-editor-tab="buffs"]');
    click(t.body, '[data-automation="add-buffset"]');
    pickFrom(t.body.querySelector('[data-automation="add-spell"]'), 'Strength Self I');
    expect(texts(t.body.querySelector('[data-spell="0"]') as HTMLElement)).toContain('5 m 0 s');
    click(t.body, '[data-automation-editor-tab="routes"]');
    click(t.body, '[data-automation="add-route"]');
    click(t.body, '[data-automation="add-point"]');
    const p = t.ed.doc.profiles[0];
    expect(p.buffSets[0].spells).toEqual([{ spell: 'Strength Self I' }]);
    expect(p.routes[0]).toEqual({ name: 'Route 1', mode: 'circular', points: ['42.1N, 33.6E'] });
  });

  it('Combat: the macro and its settings (fight range, loot, route, buff set)', async () => {
    const t = await editor(undefined, 'combat');
    const p = t.ed.doc.profiles[0];
    click(t.body, '[data-automation="macro"]');
    expect(p.macro).toBe(true);
    click(t.body, '[data-setting="EnableLooting"]');
    expect(p.settings?.EnableLooting).toBe(false);
    const range = t.body.querySelector('[data-setting="AttackDistance"]') as HTMLInputElement;
    range.value = '35'; range.dispatchEvent(new Event('input'));
    expect(p.settings?.AttackDistance).toBe(35);
    click(t.body, '[data-setting="EnableBuffing"]');
    pickFrom(t.body.querySelector('[data-setting="BuffSet"]'), 'Basics');
    expect(p.settings).toMatchObject({ EnableBuffing: true, BuffSet: 'Basics' });
  });

  it('an Any / All condition reads as "any of ( … or … )" and each branch edits in place', async () => {
    const prof = structuredClone(EXAMPLE_HUNT_PROFILE);
    prof.states[0].rules = [{ label: 'R', when: [{ kind: 'any', conditions: [{ kind: 'died' }, { kind: 'free-slots-below', slots: 5 }] }], do: [{ kind: 'stop' }] }];
    const t = await editor(docWith(prof));
    const rule0 = t.body.querySelector('[data-automation-rule="0"]') as HTMLElement;
    expect(texts(rule0)).toEqual(['1', 'When', 'any of (', 'or', 'below', ')', 'Do']);
    const slots = rule0.querySelector('[data-automation-field="slots"]') as HTMLInputElement;
    slots.value = '8';
    slots.dispatchEvent(new Event('input'));
    expect(t.ed.doc.profiles[0].states[0].rules[0].when).toEqual([{ kind: 'any', conditions: [{ kind: 'died' }, { kind: 'free-slots-below', slots: 8 }] }]);
  });

  it('VirindiTank\'s conditions and actions are in the pickers', async () => {
    const t = await editor();
    (t.body.querySelector('[data-automation-condition-kind]') as HTMLElement).click();
    expect(lastMenu!.items.map((i) => i.value)).toEqual(expect.arrayContaining(['died', 'portal-out', 'landblock', 'route-done', 'mon-count', 'expr', 'vendor-open']));
    (t.body.querySelector('[data-automation-action-kind]') as HTMLElement).click();
    expect(lastMenu!.items.map((i) => i.value)).toEqual(expect.arrayContaining(['call', 'return', 'load-route', 'setting', 'watchdog', 'expr']));
  });

  it('Import from VirindiTank brings files into the profile and says what didn\'t carry over', async () => {
    const t = await editor();
    const nav = ['uTank2 NAV 1.2', '1', '2', '0', '33.6', '42.1', '0.39', '0', '2', '33.7', '42.0', '0.39', '0', '1635', ''].join('\r\n');
    t.ed.importFiles([{ name: 'loop.nav', text: nav }], t.redraw);
    expect(t.ed.doc.profiles[0].routes.map((r) => r.name)).toContain('loop');
    expect(texts(t.body)).toContain('Imported loop.nav: everything carried over. Save to keep it.');
    expect(t.ed.doc.profiles[0].routes.find((r) => r.name === 'loop')?.stops).toEqual([{ at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] }]);
    expect(t.ed.dirty).toBe(true);
  });
});

describe('panel helpers', () => {
  it('summaries, plans and the HUD strip', () => {
    expect(M.moduleSummary(EXAMPLE_HUNT_PROFILE, 'vitals')).toBe('health under 40%');
    expect(M.moduleSummary(EXAMPLE_HUNT_PROFILE, 'navigation')).toBe('Lifestone loop (circular, 3 points)');
    expect(M.parsePlan('Strength 100,  War Magic 150')).toEqual([{ stat: 'Strength', upTo: 100 }, { stat: 'War Magic', upTo: 150 }]);
    expect(M.planText([{ stat: 'Strength', upTo: 100 }])).toBe('Strength 100');
    expect(['/automation', '@automation', ' /Automation ', '/automation panel'].every(M.isAutomationCommand)).toBe(true);
    expect(['/automation now', '/auto', 'automation'].some(M.isAutomationCommand)).toBe(false);
    const st: RoutineStats = { startedAt: 0, xpGained: 118_400, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} };
    expect(M.hudStripText({ running: true, paused: false, profile: 'x', state: 'Hunt', acting: null, last: [] }, st, 3_600_000))
      .toEqual({ state: 'Running · Hunt', sub: '118k XP/h · 1:00:00', color: 'good' });
    expect(M.hudStripText({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }, st, 0)).toBeNull();
  });

  it('imported loot requirements read as sentences with ACE property and skill names', () => {
    expect(M.lootExtraLines({
      props: [{ kind: 'int', key: 28, op: 'ge', value: 200 }, { kind: 'did', key: 8, op: 'eq', value: 5 }, { kind: 'float', key: 9999, op: 'le', value: 1 }],
      spells: { match: '^Major', notMatch: 'Ward', count: 2 },
      characterSkills: [{ skill: 34, atLeast: 100 }, { skill: 6, baseMin: 10, baseMax: 300 }],
      palettes: [{ slot: 1, palette: 0x04000bef }],
      colours: [{ rgb: [255, 195, 46], maxHue: 10, maxSV: 0.1, slots: [1, 2], group: 'Amuli Coat (Collar/Shoulder)' }, { rgb: [0, 0, 0], maxHue: 10, maxSV: 0.1 }],
    }).map((l) => l.text)).toEqual([
      'Armor Level at least 200', 'Icon is 0x5', 'float property 9999 at most 1', 'Colour near FFC32E on Amuli Coat (Collar/Shoulder)', 'Colour near 000000', 'Colour slot 1 is palette 0xBEF',
      '2+ spells matching /^Major/ but not /Ward/',
      'Your War Magic at least 100', 'Your Melee Defense base 10–300',
    ]);
  });
});

describe('GameUI hosts the panel', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubRenderer(win: any) {
    return {
      renderPanel: (layoutId: number, parent: HTMLElement, opts: { x?: number; y?: number; subtreeElementId?: number; closeButtonId?: number }) => {
        const wrapper = win.document.createElement('div');
        parent.appendChild(wrapper);
        const root = win.document.createElement('div');
        root.dataset.layout = layoutId.toString(16);
        root.dataset.subtree = (opts.subtreeElementId ?? 0).toString(16);
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100000fc, 0x100000fd, 0x100000fe, 0x100001c2, 0x100001c3]) { const e = win.document.createElement('div'); root.appendChild(e); elements.set(id, e); }
        elements.get(0x100001c3)!.style.width = '284px';
        elements.get(0x100001c3)!.style.height = '337px';
        return { root, elements, setText: (id: number, t: string) => { elements.get(id)!.textContent = t; }, close: () => wrapper.remove() };
      },
    };
  }

  it('/automation\'s toggle opens it in the panels window with the Vitae shell; the HUD strip follows a run', async () => {
    const ui = H.ui as unknown as {
      layoutRenderer: unknown; setAutomationSource(s: AutomationSource | null): void; toggleAutomationPanel(): void; automationAvailable: boolean;
      updateAutomationStrip(): void;
    };
    expect(ui.automationAvailable).toBe(false);
    ui.layoutRenderer = stubRenderer(H.win);
    const f = fakeSource(docWith(structuredClone(EXAMPLE_HUNT_PROFILE)));
    ui.setAutomationSource(f.source);
    expect(ui.automationAvailable).toBe(true);
    ui.toggleAutomationPanel();
    const root = H.container.querySelector('[data-layout="21000020"]') as HTMLElement;
    expect(root.dataset.subtree).toBe('100001c1');
    expect(root.textContent).toContain('Automation');
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('[data-automation="panel"]')).not.toBeNull();
    expect(H.container.querySelector('[data-automation-strip]')).toBeNull();
    f.source.run(EXAMPLE_HUNT_PROFILE);
    ui.updateAutomationStrip();
    expect((H.container.querySelector('[data-automation-strip]') as HTMLElement).dataset.state).toBe('Running · Hunt');
    // The once-a-second tick redraws only when what the panel shows changed.
    const tick = (H.ui as unknown as { tickAutomation(): void }).tickAutomation.bind(H.ui);
    const body = () => H.container.querySelector('[data-automation="panel"]');
    tick();
    const first = body();
    tick();
    expect(body()).toBe(first);
    f.source.pause();
    tick();
    expect(body()).not.toBe(first);
    ui.toggleAutomationPanel();
    expect(H.container.querySelector('[data-layout="21000020"]')).toBeNull();
    ui.setAutomationSource(null);
    expect(H.container.querySelector('[data-automation-strip]')).toBeNull();
  });
});
