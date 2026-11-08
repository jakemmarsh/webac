/**
 * BUG.vtank-nav-stands-still (Reddit, Oh_thats_fun, 2026-11-07, a new character on Coldeve, end of retail): "I'm in a
 * rats nest and tried to set a route to auto run and kill rats with but once I hit 'enable navigation' or 'enable
 * auto-navigation' the toon just stands there."
 *
 * Cause: a route recorded on the Route tab with Run Macro already on was never loaded into the run. The first Add makes
 * "Route 1" the profile's Auto-Navigation route, but RoutineEngine.update (the window's every edit) only refreshed a
 * route already loaded at Run Macro, so the run had none and navigation stood still, saying nothing. Same for a route
 * emptied before the start (done at once, never un-done when points came back) and for another route picked in the
 * Auto-Navigation dropdown while running.
 *
 * Driven through the real VirindiTank window (ui/automation/VTankWindow.ts) wired to the real AgentApi / RoutineEngine
 * the way main.ts wires them (the window's source = the engine), on the fake host and in the real A Rat Nest (0x01DD)
 * cells through the client's own collision (tests/_harness/dungeonWalk.ts).
 */
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { NAV_IDLE_MS, mapCoordsText } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { cellStandPoint, loadCellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { vtStatusText } from '../packages/renderer/src/ui/automation/vtActivity.ts';
import { AutomationReporter, type RoutineLifecycleEvent } from '../packages/renderer/src/telemetry/AutomationReporter.ts';
import { sanitizeClientAutomation } from '../services/ws-tcp-bridge/src/clientAutomation.ts';
import { emptyRoutineDoc, validateRoutineDoc, vtCanonicalName, type RoutineDoc } from '../packages/shared/src/routines/index.ts';
import type { MenuItem } from '../packages/renderer/src/ui/automation/AutomationPanel.ts';
import type { VTankDialogs, VTankKit, VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.ts';
import { FakeHost } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import { installDomGlobals, loadDomWindow, restoreDomGlobals } from './_harness/dom.ts';

const DOM_KEYS = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const;
const saved: Record<string, unknown> = {};
type WinModule = typeof import('../packages/renderer/src/ui/automation/VTankWindow.ts');
let W: WinModule;
beforeAll(async () => {
  installDomGlobals(await loadDomWindow(), DOM_KEYS, saved);
  W = await import('../packages/renderer/src/ui/automation/VTankWindow.ts');
});
afterAll(() => restoreDomGlobals(DOM_KEYS, saved));

let lastMenu: { items: MenuItem[]; pick: (v: string) => void } | null = null;
function kit(): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); return d; };
  const text = (t: string) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; };
  return {
    text, header: text,
    button: (label, onClick) => div({ button: label }, onClick),
    tab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    check: (on, onChange) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    field: (t, onClick) => { const f = div({ field: t }); f.addEventListener('click', () => onClick(f)); return f; },
    menu: (_a, items, onPick) => { lastMenu = { items, pick: onPick }; },
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (selected, onClick) => div({ selected: selected ? '1' : '0' }, onClick),
    box: () => document.createElement('div'),
    dot: (lit) => div({ dot: lit ? '1' : '0' }),
    separator: () => document.createElement('hr'),
    scroll: () => {},
    plate: () => document.createElement('div'),
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
    icon: (id, _s, onClick) => div({ icon: `0x${id.toString(16)}` }, onClick),
    flatButton: (label, onClick) => div({ button: label }, onClick),
    dropdown: (t, onClick) => { const f = div({ field: t }); f.addEventListener('click', () => onClick(f)); return f; },
    slider: (value, _min, _max, _w, onChange) => { const i = document.createElement('input'); i.dataset.slider = String(value); i.addEventListener('change', () => onChange(Number(i.value))); return i; },
    textTab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    list: () => {},
    download: () => {},
  };
}

/** The window's source over the real engine, as main.ts builds it (setAutomationSource). */
function engineSource(api: AgentApi, doc: RoutineDoc): VTankSource {
  let stored = structuredClone(doc);
  return {
    load: async () => ({ ok: true, doc: structuredClone(stored) }),
    save: async (d) => { const issues = validateRoutineDoc(d); if (issues.length) return { ok: false, message: 'not saved', issues }; stored = structuredClone(d); return { ok: true, doc: structuredClone(d) }; },
    status: () => api.routine.status(),
    stats: () => api.routine.statsNow(),
    current: () => api.routine.current(),
    run: (p) => api.routine.start(p, 'player'),
    pause: () => api.routine.pause(),
    resume: () => api.routine.resume(),
    stop: () => api.routine.stop('stopped', 'player'),
    setModule: (m, on) => api.routine.setModule(m, on),
    resetStats: () => {},
    step: () => api.routine.stepOnce(),
    history: () => api.routine.history(),
    report: () => {},
    character: () => api.characterName(),
    coords: () => { const me = api.self(); return me ? mapCoordsText(me.pos) : null; },
    height: () => api.self()?.pos.z ?? null,
    items: () => [],
    spells: () => [],
    buffs: () => [],
    now: () => 1_700_000_000_000,
    setting: (n) => api.routine.setting(vtCanonicalName(n)),
    setSetting: (n, v) => api.routine.setSetting(n, v),
    setState: (n) => api.routine.setState(n),
    forceBuff: () => api.routine.forceBuff(),
    cancelForceBuff: () => api.routine.cancelForceBuff(),
    setNearestWaypoint: () => api.routine.setNearestWaypoint(),
    update: (p) => api.routine.update(p),
    selection: () => null,
    mexec: () => '',
    jump: () => ({ ok: true, message: '' }),
    fakeDeath: () => api.routine.fakeDeath(),
    reverseRoute: (on) => api.routine.reverseRoute(on),
  };
}

const dialogs: VTankDialogs = { open: () => {}, close: () => {} };
const click = (root: Element, sel: string) => { const e = root.querySelector(sel) as HTMLElement | null; if (!e) throw new Error(`no ${sel}`); e.click(); };
const checkOf = (sel: string) => `${sel} [data-check]`;

async function openWindow(api: AgentApi, reports: string[] = []) {
  const doc: RoutineDoc = { ...emptyRoutineDoc('coldeve', 'newplayer'), profiles: [] };
  // The engine's player-facing lines, as main.ts prints them ([Automation] in chat).
  api.routine.onReport = (text) => { reports.push(text); };
  const win = new W.VTankWindow(kit(), engineSource(api, doc), dialogs);
  const body = document.createElement('div');
  const redraw = () => win.render(body, 794, 189, redraw);
  await win.load(redraw);
  const tab = (id: string) => { click(body, `[data-vtank-tab="${id}"]`); };
  /** The Options tab's Run Macro / Enable Navigation switches, the Route tab's Add. */
  const runMacro = () => { tab('options'); click(body, checkOf('[data-vtank="run-macro"]')); };
  const enableNav = () => { tab('options'); click(body, checkOf('[data-vtank-option="EnableNav"]')); };
  const add = () => { tab('route'); click(body, '[data-vtank="add-point"]'); };
  const status = () => { tab('options'); return (body.querySelector('[data-vtank="status"]') as HTMLElement).textContent ?? ''; };
  const message = () => (body.querySelector('[data-vtank="message"]') as HTMLElement | null)?.textContent ?? '';
  return { win, body, redraw, tab, runMacro, enableNav, add, status, message };
}

describe('VirindiTank navigation from the window, on the fake host', () => {
  let host: FakeHost;
  let api: AgentApi;
  let events: RoutineLifecycleEvent[];
  const tick = async (ms: number) => { for (let t = 0; t < ms; t += 100) { host.t += 100; vi.advanceTimersByTime(100); host.physics(100); api.tick(); await Promise.resolve(); await Promise.resolve(); } };
  const moved = (from: { x: number; y: number }) => Math.hypot(host.me.x - from.x, host.me.y - from.y);
  const at = (x: number, y: number) => { host.me.x = x; host.me.y = y; };
  const navIdle = () => events.filter((e) => e.type === 'nav_idle');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    events = [];
    api.routine.onLifecycle = (e) => { events.push(e); };
  });
  afterEach(() => { api.routine.stop(); api.stopMoving(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the report: Run Macro on first, waypoints added on the Route tab, then Enable Navigation: the route is walked (stood still before)', async () => {
    const w = await openWindow(api);
    w.runMacro();
    expect(api.routine.status().running).toBe(true);
    // The player walks the loop pressing Add at each spot (the first Add makes "Route 1", the profile's route).
    for (const [x, y] of [[80, 20], [100, 20], [100, 40]]) { at(x, y); w.add(); }
    at(80, 40);
    w.enableNav();
    expect(api.routine.setting('EnableNav')).toBe(true);
    expect(api.routine.status().nav).toMatchObject({ route: 'Route 1', done: false });
    const from = { x: host.me.x, y: host.me.y };
    await tick(8000);
    expect(moved(from), api.routine.history().join('\n')).toBeGreaterThan(5);
    expect(api.routine.history().join('\n')).toMatch(/route "Route 1" point \d: arrived/);
    expect(navIdle()).toEqual([]);
  });

  it('the other order (points, Enable Navigation, then Run Macro) walks as before', async () => {
    const w = await openWindow(api);
    for (const [x, y] of [[80, 20], [100, 20]]) { at(x, y); w.add(); }
    w.enableNav();
    // Navigation switched on with the macro off: the window says what it still needs.
    expect(w.message()).toMatch(/Turn Run Macro on/);
    w.runMacro();
    const from = { x: host.me.x, y: host.me.y };
    await tick(8000);
    expect(moved(from)).toBeGreaterThan(5);
  });

  it('a route emptied before the start (Clear nav profile!) and recorded again while running is walked once it has points', async () => {
    const w = await openWindow(api);
    at(80, 20); w.add();
    w.tab('profiles'); click(w.body, '[data-vtank="clear-nav"]');
    w.enableNav();
    w.runMacro();
    await tick(1000);
    expect(api.routine.status().navWait).toMatchObject({ reason: 'empty_route' });
    expect(w.status()).toBe('Macro: Nav: "Route 1" has no points');
    for (const [x, y] of [[80, 20], [100, 20], [100, 40]]) { at(x, y); w.add(); }
    const from = { x: host.me.x, y: host.me.y };
    await tick(8000);
    expect(moved(from), api.routine.history().join('\n')).toBeGreaterThan(5);
    expect(api.routine.status().navWait).toBeUndefined();
  });

  it('navigation on with no route: the status line, one chat line and one nav_idle report say so (it stood silently before)', async () => {
    const reports: string[] = [];
    const w = await openWindow(api, reports);
    w.runMacro();
    w.enableNav();
    expect(w.message()).toMatch(/No route loaded: Add waypoints on the Route tab/);
    await tick(1000);
    expect(api.routine.status().navWait).toMatchObject({ reason: 'no_route' });
    expect(w.status()).toBe('Macro: Nav: no route loaded');
    await tick(NAV_IDLE_MS + 1000);
    expect(reports.filter((r) => /no route is loaded/.test(r))).toHaveLength(1);
    expect(navIdle()).toEqual([{ type: 'nav_idle', reason: 'no_route', indoors: false, points: 0 }]);
    // Once per reason per run.
    await tick(NAV_IDLE_MS * 2);
    expect(navIdle()).toHaveLength(1);
    expect(reports.filter((r) => /no route is loaded/.test(r))).toHaveLength(1);
  });

  it('another route picked under Auto-Navigation while running is loaded at once, as VTank\'s dropdown does; [None] unloads it', async () => {
    const w = await openWindow(api);
    at(80, 20); w.add(); at(80, 22); w.add();
    w.enableNav();
    w.runMacro();
    // A second route on the profile (an import, say), then picked in the dropdown.
    const p = w.win.profile()!;
    const here = api.self()!.pos;
    p.routes.push({ name: 'Nest loop', mode: 'circular', points: [mapCoordsText(here), mapCoordsText({ x: here.x + 20, y: here.y })] });
    w.tab('profiles');
    click(w.body, '[data-vtank="nav-profile"]');
    lastMenu!.pick('Nest loop');
    expect(api.routine.status().nav).toMatchObject({ route: 'Nest loop' });
    click(w.body, '[data-vtank="nav-profile"]');
    lastMenu!.pick('');
    expect(api.routine.status().nav).toBeUndefined();
    await tick(1000);
    expect(api.routine.status().navWait).toMatchObject({ reason: 'no_route' });
  });

  it('points no walk reaches: said once, the status says so, and nav_idle names no_path', async () => {
    const reports: string[] = [];
    const w = await openWindow(api, reports);
    for (const [x, y] of [[80, 20], [100, 20], [100, 40]]) { at(x, y); w.add(); }
    at(80, 40);
    // Every walk to a point is refused where it stands (no way on foot, say).
    api.walkTo = async (t) => ({ ok: false, message: `walking to ${String(t)}: no way on foot to there from here` });
    w.enableNav();
    w.runMacro();
    await tick(NAV_IDLE_MS + 2000);
    expect(api.routine.status().navWait).toMatchObject({ reason: 'no_path' });
    expect(w.status()).toMatch(/^Macro: Nav: can't reach point \d/);
    expect(reports.filter((r) => /^Navigation: no walk reaches the points of "Route 1" \(point \d: walking to .*no way on foot/.test(r))).toHaveLength(1);
    expect(navIdle()).toEqual([{ type: 'nav_idle', reason: 'no_path', indoors: false, points: 3 }]);
  });

  it('a walk that stops short but moved (a monster interrupting) is not counted toward no_path', async () => {
    const w = await openWindow(api);
    for (const [x, y] of [[80, 20], [100, 20], [100, 40]]) { at(x, y); w.add(); }
    at(80, 40);
    api.walkTo = async () => { host.me.x += 3; return { ok: false, message: 'stopped: something attacked you' }; };
    w.enableNav();
    w.runMacro();
    await tick(6000);
    expect(api.routine.status().navWait).toBeUndefined();
  });

  it('fighting in one place is reported (fighting) but not said in chat: the macro is at work', async () => {
    const reports: string[] = [];
    const w = await openWindow(api, reports);
    at(80, 20); w.add(); at(100, 20); w.add();
    w.enableNav();
    w.runMacro();
    // The macro picks a fight every step and stands there (a planner step that doesn't move the body).
    const engine = api.routine as unknown as { macroStep: (p: unknown) => void; acting: string | null; busy: boolean };
    engine.macroStep = function (this: typeof engine) { this.acting = 'combat: attacking Brown Rat'; this.busy = true; setTimeout(() => { this.busy = false; this.acting = null; }, 300); };
    await tick(NAV_IDLE_MS + 2000);
    expect(navIdle()).toEqual([{ type: 'nav_idle', reason: 'fighting', indoors: false, points: 2 }]);
    expect(reports.filter((r) => /fighting/.test(r))).toEqual([]);
  });

  it('the sweep, combat: a monster within Monster Range that the macro plans no attack on is said once (it stood silently)', async () => {
    const reports: string[] = [];
    const w = await openWindow(api, reports);
    w.runMacro();
    expect(api.routine.setting('EnableCombat')).toBe(true);
    // A Brown Rat 3 m off; this host has no spell table and the profile no weapon, so no attack is planned.
    host.add({ guid: 0x80000101, name: 'Brown Rat', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: host.me.x, y: host.me.y + 3, z: host.me.z, level: 1 });
    await tick(NAV_IDLE_MS + 2000);
    expect(reports.filter((r) => /^Combat: Brown Rat is within Monster Range, but the macro has nothing it can attack with/.test(r))).toHaveLength(1);
    await tick(NAV_IDLE_MS + 2000);
    expect(reports.filter((r) => /^Combat: /.test(r))).toHaveLength(1);
  });

  it('points recorded on the Route tab carry your height (VTank\'s Z): the storey a dungeon walk takes', async () => {
    const w = await openWindow(api);
    host.me.z = -6;
    w.add();
    expect(w.win.profile()!.routes[0].z).toEqual([-6 / 240]);
  });
});

describe('the status line and the nav_idle report', () => {
  it('vtStatusText shows why navigation waits when nothing else is being done', () => {
    const st = { running: true, paused: false, profile: 'Default', state: 'Default', acting: null, last: [], navWait: { reason: 'no_route' as const, short: 'Nav: no route loaded', text: '' } };
    expect(vtStatusText(st, true)).toBe('Macro: Nav: no route loaded');
    expect(vtStatusText({ ...st, acting: 'combat: attacking Brown Rat' }, true)).toBe('Macro: combat: attacking Brown Rat');
    expect(vtStatusText({ ...st, navWait: undefined }, true)).toBe('Macro: Running.');
  });

  it('the reporter sends nav_idle (closed reason, no names) during a run, capped per page; the bridge keeps it', () => {
    const sent: string[] = [];
    const rep = new AutomationReporter({ endpoint: 'http://bridge/client-preworld', build: 'b1', trace: 'a'.repeat(16), era: () => 'eor', server: () => 'Coldeve', now: () => 0, send: (_u, body) => { sent.push(body); return true; } });
    rep.routine({ type: 'nav_idle', reason: 'no_route', indoors: true, points: 0 });
    expect(sent).toEqual([]); // no run going
    rep.routine({ type: 'start', profile: { name: 'Bob\'s secret', macro: true, modules: {} as never, initialState: 'D', states: [], loot: [], buffSets: [], routes: [] }, driver: 'player' });
    sent.length = 0;
    rep.routine({ type: 'nav_idle', reason: 'no_path', indoors: true, points: 7 });
    rep.routine({ type: 'nav_idle', reason: 'bogus' as never, indoors: true, points: 7 });
    expect(sent).toHaveLength(1);
    const ev = JSON.parse(sent[0]);
    expect(ev).toMatchObject({ outcome: 'nav_idle', kind: 'macro', driver: 'player', reason: 'no_path', indoors: true, points: 7, era: 'eor', server: 'Coldeve' });
    expect(sent[0]).not.toMatch(/Bob/);
    for (let i = 0; i < 20; i++) rep.routine({ type: 'nav_idle', reason: 'other', indoors: false, points: 1 });
    expect(sent.length).toBe(6);
    expect(sanitizeClientAutomation(ev)).toMatchObject({ outcome: 'nav_idle', kind: 'macro', driver: 'player', reason: 'no_path', indoors: true, points: 7 });
    expect(sanitizeClientAutomation({ ...ev, reason: 'Bob stuck', points: -1, indoors: 'yes' })).toMatchObject({ reason: null, points: null, indoors: null });
  });
});

/**
 * The real A Rat Nest (landblock 0x01DD, the newbie dungeon off Holtburg): a loop recorded room to room with the window's
 * Add, Run Macro on first and Enable Navigation after, walked through the client's own collision and the cell DAT's
 * doorway route.
 */
const RAT_NEST = 0x01dd0000;
describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('the real A Rat Nest (0x01DD): a route recorded in the window is walked', () => {
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(RAT_NEST, { statics: true });
  }, 180_000);

  it('Run Macro, Add in two rooms of the lower floor, Enable Navigation: the character runs the loop', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { DungeonHost } = await import('./_harness/dungeonWalk.ts');
    const dats = { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) };
    const host = new DungeonHost(nav, dats, RAT_NEST, { rooms: true });
    const api = new AgentApi(host);
    try {
      const g = loadCellGraph(dats.cell, dats.portal, RAT_NEST);
      // The lower floor's rooms the red rats are in (verify-cell-path: 0x01DD011C → 0x01DD0116 stays down at z −6).
      const rooms = [0x01dd011c, 0x01dd0116].map((c) => ({ cell: c >>> 0, ...cellStandPoint(g, c >>> 0)! }));
      expect(rooms.every((r) => Number.isFinite(r.x))).toBe(true);
      const stand = (r: (typeof rooms)[number]) => { Object.assign(host.me, { cell: r.cell, x: r.x, y: r.y, z: r.z }); };
      const w = await openWindow(api);
      w.runMacro();
      for (const r of rooms) { stand(r); w.add(); }
      stand(rooms[0]);
      w.enableNav();
      const route = w.win.profile()!.routes[0];
      expect(route.points).toHaveLength(2);
      expect(route.z).toHaveLength(2);
      let reached = false;
      for (let t = 0; t < 90_000 && !reached; t += 100) {
        host.t += 100; vi.advanceTimersByTime(100); host.physics(100); api.tick();
        await Promise.resolve(); await Promise.resolve();
        if (Math.hypot(host.me.x - rooms[1].x, host.me.y - rooms[1].y) < 3 && Math.abs(host.me.z - rooms[1].z) < 2) reached = true;
      }
      const log = api.routine.history().join('\n');
      expect(reached, `${log}\n${host.traces.slice(-20).join('\n')}`).toBe(true);
      expect(api.routine.status().navWait).toBeUndefined();
    } finally {
      api.routine.stop(); api.stopMoving(); host.dispose();
      vi.useRealTimers(); vi.restoreAllMocks();
    }
  }, 240_000);
});
