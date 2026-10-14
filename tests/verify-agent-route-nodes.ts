/**
 * VirindiTank route points that wait for their result (docs/vtank-parity-gaps.md §4; routeNodes.ts):
 * recall / portal / NPC points, checkpoints, starting at the nearest point, NavFarStopRange,
 * UsePortalDistance, OpenDoors with Consumables lockpicks, /vt reverseroute [true|false], and the
 * .nav portal-by-id (type 1) and checkpoint (type 8) points through import and export. Each test
 * drives the real RoutineEngine on the agent API over the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, MAP_COORD_ORIGIN } from '../packages/renderer/src/agent/AgentApi.ts';
import {
  anchorPoint, CHECKPOINT_NUDGE_MS, chooseLockpick, doorLock, doorOnRoute, findStepObject, isRecall, nearestStart, NODE_TIMEOUT_MS, walksTo,
} from '../packages/renderer/src/agent/routeNodes.ts';
import { ALL_MODULES_OFF, emptyVtankData, exportNav, navToRoute, parseNav, validateRoutineDoc, emptyRoutineDoc, type Route, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import type { AgentItem, AgentObject } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

/** Map coordinates of a landblock-local point in HOLTBURG. */
function M(x: number, y: number): string {
  const gx = ((HOLTBURG >>> 24) & 0xff) * 192 + x;
  const gy = ((HOLTBURG >>> 16) & 0xff) * 192 + y;
  const ew = gx / 240 - MAP_COORD_ORIGIN; const ns = gy / 240 - MAP_COORD_ORIGIN;
  return `${Math.abs(ns).toFixed(4)}${ns >= 0 ? 'N' : 'S'}, ${Math.abs(ew).toFixed(4)}${ew >= 0 ? 'E' : 'W'}`;
}
const G = (x: number, y: number) => ({ x: ((HOLTBURG >>> 24) & 0xff) * 192 + x, y: ((HOLTBURG >>> 16) & 0xff) * 192 + y });

const navProfile = (route: Route, settings: Record<string, string | number | boolean> = {}, over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Nav', modules: { ...ALL_MODULES_OFF, navigation: true }, initialState: 'Go', loot: [], buffSets: [], routes: [route], navRoute: route.name,
  macro: true, settings: { EnableCombat: false, EnableNav: true, ...settings }, states: [{ name: 'Go', rules: [] }], ...over,
});

describe('route points (pure)', () => {
  const r: Route = {
    name: 'R', mode: 'circular', points: [M(80, 60), M(80, 22), M(80, 21), M(80, 40)],
    stops: [{ at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] }, { at: 2, do: [{ kind: 'checkpoint' }] }, { at: 3, do: [{ kind: 'use-portal', id: 0x7a9b0012 }] }],
  };
  it('walks to plain points and checkpoints only; starts only at those and portal-by-id points', () => {
    expect([0, 1, 2, 3].map((i) => walksTo(r, i))).toEqual([true, false, true, false]);
    expect([0, 1, 2, 3].map((i) => anchorPoint(r, i))).toEqual([true, false, true, true]);
  });
  it('starts a circular or linear route at the nearest point you could be at (height counted); a once route at its head', () => {
    const me = { ...G(80, 20), z: 94 };
    // The recall point (index 1) is nearer but is no place to be.
    expect(nearestStart(r, me)).toBe(2);
    expect(nearestStart({ ...r, mode: 'linear' }, me)).toBe(2);
    expect(nearestStart({ ...r, mode: 'once' }, me)).toBe(0);
    // A point right below you on a lower floor is not where you stand.
    const floors: Route = { name: 'F', mode: 'circular', points: [M(80, 20), M(80, 30)], z: [60 / 240, 94 / 240] };
    expect(nearestStart(floors, me)).toBe(1);
  });
  it('a cast step is a recall when it names one of VTank\'s recall spells (by name or id)', () => {
    expect(isRecall('Lifestone Recall')).toBe(true);
    expect(isRecall('1635')).toBe(true);
    expect(isRecall('portal recall')).toBe(true);
    expect(isRecall('Flame Bolt I')).toBe(false);
  });
  it('a door is on the way within a metre of the line to the point, ahead of you and short of it', () => {
    const me = { x: 0, y: 0 }, goal = { x: 0, y: 10 };
    expect(doorOnRoute({ x: 0.5, y: 5, dz: 0 }, me, goal)).toBe(true);
    expect(doorOnRoute({ x: 1.5, y: 5, dz: 0 }, me, goal)).toBe(false);
    expect(doorOnRoute({ x: 0, y: -2, dz: 0 }, me, goal)).toBe(false);
    expect(doorOnRoute({ x: 0, y: 12, dz: 0 }, me, goal)).toBe(false);
    expect(doorOnRoute({ x: 0, y: 5, dz: 3 }, me, goal)).toBe(false);
    expect(doorOnRoute({ x: 0, y: 5, dz: 3 }, me, { ...goal, dz: 6 })).toBe(true);
  });
  it('a door\'s lock comes from its appraisal (ACE: Locked, ResistLockpick); the lockpick from Consumables, gated on skill', () => {
    expect(doorLock(null)).toEqual({ locked: false });
    expect(doorLock({ bool: { 3: false } })).toEqual({ locked: false });
    expect(doorLock({ bool: { 3: true }, int: { 173: 120 } })).toEqual({ locked: true, difficulty: 120 });
    const items: AgentItem[] = [
      { guid: 1, name: 'Plain Lockpick', where: 'main pack', objectDescFlags: 0x20000 },
      { guid: 2, name: 'Intricate Lockpick', where: 'main pack', objectDescFlags: 0x20000 },
      { guid: 3, name: 'Unlisted Lockpick', where: 'main pack', objectDescFlags: 0x20000 },
    ];
    const data = (g: number) => (g === 2 ? { int: { 88: 30 } } : null);
    const listed = ['Plain Lockpick', 'intricate lockpick'];
    expect(chooseLockpick(items, listed, 150, 120, -50, data)).toEqual({ item: items[1] });
    // 60 < 120 − 50: too hard for you.
    expect(chooseLockpick(items, listed, 60, 120, -50, data)).toEqual({ why: 'Lockpick 60 is under its difficulty 120 − 50' });
    expect(chooseLockpick(items, [], 150, 120, -50, data)).toEqual({ why: 'no lockpick on the Consumables tab in your pack' });
    expect(chooseLockpick(items, listed, null, 120, -50, data)).toEqual({ why: 'you have no Lockpick skill' });
  });
  it('a step\'s object: its recorded id (same name), else the same-named one nearest where it was recorded; a portal id falls back to the portal at the point', () => {
    const me = G(80, 20);
    const o = (guid: number, name: string, kind: AgentObject['kind'], dist: number, bearing: number): AgentObject => ({ guid, name, kind, dist, bearing, relBearing: 0, dz: 0 });
    const near = [o(10, 'Portal to Town', 'portal', 10, 0), o(11, 'Portal to Town', 'portal', 10, 180), o(12, 'Gate', 'portal', 30, 90)];
    // Recorded standing south of you (map units of global (80, 10)).
    const south = G(80, 10);
    const at: [number, number, number] = [south.x / 240 - MAP_COORD_ORIGIN, south.y / 240 - MAP_COORD_ORIGIN, 0.4];
    expect(findStepObject({ kind: 'use-object', name: 'Portal to Town', vt: { objectClass: 14, at } }, near, me, null)?.guid).toBe(11);
    expect(findStepObject({ kind: 'use-object', name: 'portal to town', vt: { id: 10 } }, near, me, null)?.guid).toBe(10);
    expect(findStepObject({ kind: 'use-object', name: 'Nowhere' }, near, me, null)).toBeNull();
    expect(findStepObject({ kind: 'use-portal', id: 12 }, near, me, null)?.guid).toBe(12);
    // Another server's id: the portal within 10 m of the point.
    expect(findStepObject({ kind: 'use-portal', id: 0xdead }, near, me, M(110, 20))?.guid).toBe(12);
    expect(findStepObject({ kind: 'use-portal', id: 0xdead }, near, me, M(150, 150))).toBeNull();
  });
});

describe('route points in the engine', () => {
  let host: FakeHost;
  let api: AgentApi;
  const reports: string[] = [];
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); reports.length = 0; api.routine.onReport = (r) => reports.push(r); });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const log = () => api.routine.history().join('\n');
  /** A trip through portal space starting `after` ms from now and landing at (x, y) `trip` ms later. */
  const portalTrip = (after: number, trip: number, x: number, y: number) => {
    setTimeout(() => { host.screenName = 'portal-space'; }, after);
    setTimeout(() => { host.screenName = 'world'; host.me.x = x; host.me.y = y; }, after + trip);
  };

  it('a circular route starts at the point nearest you; a loaded one too; a once route at its head', async () => {
    api.routine.start(navProfile({ name: 'R', mode: 'circular', points: [M(80, 60), M(80, 40), M(80, 24), M(80, 50)] }, { EnableNav: false }));
    expect(api.routine.status().nav).toMatchObject({ route: 'R', point: 2 });
    api.routine.stop();
    api.routine.start(navProfile({ name: 'O', mode: 'once', points: [M(80, 60), M(80, 24)] }, { EnableNav: false }));
    expect(api.routine.status().nav).toMatchObject({ route: 'O', point: 0 });
    api.routine.stop();
    const p = navProfile({ name: 'L', mode: 'linear', points: [M(80, 60), M(80, 22)] }, { EnableNav: false }, {
      navRoute: undefined, ruleFiring: 'once', states: [{ name: 'Go', rules: [{ when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'L' }] }] }],
    });
    api.routine.start(p);
    await step(600);
    expect(api.routine.status().nav).toMatchObject({ route: 'L', point: 1 });
    expect(log()).toContain('load-route: loaded route "L" (2 points; starts at point 2, the nearest)');
  });

  it('a recall point is cast where you are (not walked to), recast after a fizzle, and waits for portal space and the arrival', async () => {
    host.spells = () => [{ id: 1635, name: 'Lifestone Recall', school: 'Item', level: 1 }];
    let casts = 0;
    host.cast = (id, t) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      if (++casts === 1) api.pushChat('Your spell fizzled.', 0x11);
      else { api.pushChat('You cast Lifestone Recall.', 0x11); portalTrip(2000, 4000, 20, 150); }
      return true;
    };
    // The recall point was recorded 150 m away: VTank casts where you are.
    api.routine.start(navProfile({ name: 'R', mode: 'once', points: [M(80, 24), M(160, 160), M(20, 152)], stops: [{ at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] }] }));
    await step(3000);
    expect(host.me.combatMode).toBe('magic');
    expect(host.sent.filter((x) => x === 'cast 1635 self')).toHaveLength(2);
    expect(Math.hypot(host.me.x - 80, host.me.y - 24)).toBeLessThan(3); // stood still for the cast
    await step(8000);
    expect(log()).toMatch(/route "R" point 2: cast: recalled \(Lifestone Recall, 2 casts; \d+ s in portal space\)/);
    await step(5000);
    expect(api.routine.status().nav).toMatchObject({ done: true });
  });

  it('a recall this character doesn\'t know (or the era lacks) is skipped and the route goes on', async () => {
    api.routine.start(navProfile({ name: 'R', mode: 'once', points: [M(80, 21), M(80, 21)], stops: [{ at: 0, do: [{ kind: 'cast', spell: 'Bur Recall', target: 'self' }] }] }));
    await step(3000);
    expect(log()).toMatch(/cast: you don't know a spell matching "Bur Recall".*: the recall point is skipped/);
    expect(host.sent.some((x) => x.startsWith('cast'))).toBe(false);
  });

  it('a portal point walks to UsePortalDistance, uses the portal until you go through, and tries again when you come out where you went in', async () => {
    const portal = 0x7a9b0012;
    host.add({ guid: portal, name: 'Portal to Town', objectDescFlags: 0x40000, x: 80, y: 32 });
    const walks: Array<{ target: number | string; within?: number }> = [];
    const walk = api.walkTo.bind(api);
    api.walkTo = (t, o = {}) => { walks.push({ target: t, within: o.within }); return walk(t, o); };
    let uses = 0;
    const use = host.use;
    host.use = (g) => {
      use(g);
      // The first trip lands next to the portal (a bounce): no trip. The second goes somewhere.
      if (g === portal) { uses++; if (uses === 1) portalTrip(500, 2000, 80, 30); else if (uses === 2) portalTrip(500, 3000, 10, 180); }
      return true;
    };
    api.routine.start(navProfile({ name: 'P', mode: 'once', points: [M(80, 21), M(10, 180)], stops: [{ at: 0, do: [{ kind: 'use-object', name: 'Portal to Town', vt: { objectClass: 14 } }] }] }, { UsePortalDistance: 6 }));
    await step(40_000);
    expect(walks.find((w) => w.target === portal)?.within).toBe(6);
    expect(uses).toBe(2);
    expect(log()).toMatch(/route "P" point 1: use-object: went through Portal to Town \(2 uses\); \d+ s in portal space/);
  });

  it('a Chat point\'s /ub use (no VTank record) is one use, as before', async () => {
    host.add({ guid: 0x7a9b0014, name: 'Lever', itemType: 0x80, x: 81, y: 22 });
    api.routine.start(navProfile({ name: 'U', mode: 'once', points: [M(80, 21), M(80, 21)], stops: [{ at: 0, do: [{ kind: 'use-object', name: 'Lever' }] }] }));
    await step(20_000);
    expect(host.sent.filter((x) => x === 'use 7a9b0014')).toHaveLength(1);
    expect(api.routine.status().nav).toMatchObject({ done: true });
  });

  it('a portal that never takes you gives up after 30 s outside portal space, and the route goes on', async () => {
    host.add({ guid: 0x7a9b0013, name: 'Dead Portal', objectDescFlags: 0x40000, x: 80, y: 22 });
    api.routine.start(navProfile({ name: 'P', mode: 'once', points: [M(80, 21), M(80, 21)], stops: [{ at: 0, do: [{ kind: 'use-object', name: 'Dead Portal', vt: { objectClass: 14 } }] }] }));
    await step(NODE_TIMEOUT_MS + 15_000);
    expect(log()).toMatch(/use-object: Dead Portal: no portal space in 30 s \(\d+ uses\); the route goes on/);
    expect(api.routine.status().nav).toMatchObject({ done: true });
  });

  it('a portal-by-id point (.nav type 1) uses that id, or on another server the portal at the point', async () => {
    host.add({ guid: 0x7a9b0099, name: 'Shimmering Portal', objectDescFlags: 0x40000, x: 82, y: 24 });
    let used = 0;
    const use = host.use;
    host.use = (g) => { use(g); if (g === 0x7a9b0099 && ++used === 1) portalTrip(500, 2000, 10, 180); return true; };
    // The recorded id is another server's.
    api.routine.start(navProfile({ name: 'P', mode: 'once', points: [M(82, 23), M(10, 180)], stops: [{ at: 0, do: [{ kind: 'use-portal', id: 0x7a9b0001 }] }] }));
    await step(20_000);
    expect(log()).toMatch(/route "P" point 1: use-portal: went through Shimmering Portal/);
  });

  it('an NPC point uses the NPC until it answers', async () => {
    const npc = 0x80007001;
    host.add({ guid: npc, name: 'Town Crier', itemType: 0x10, x: 81, y: 22 });
    let uses = 0;
    const use = host.use;
    host.use = (g) => { use(g); if (g === npc && ++uses === 2) api.pushChat('Town Crier tells you, "Well met!"', 0x03); return true; };
    api.routine.start(navProfile({ name: 'N', mode: 'once', points: [M(80, 21), M(80, 21)], stops: [{ at: 0, do: [{ kind: 'use-object', name: 'Town Crier', vt: { objectClass: 37 } }] }] }));
    await step(30_000);
    expect(uses).toBe(2);
    expect(log()).toContain('route "N" point 1: use-object: Town Crier answered (after 2 uses)');
  });

  it('a checkpoint holds the route until the server\'s own echo of you is there, inching forward after 15 s', async () => {
    let echo: { cell: number; x: number; y: number; z: number; at: number } | null = { cell: HOLTBURG, x: 80, y: 20, z: 94, at: 0 };
    host.serverSelfPosition = () => echo;
    const moves: string[] = [];
    const move = api.move.bind(api);
    api.move = (d, s) => { moves.push(`${d} ${s}`); return move(d, s); };
    api.routine.start(navProfile({ name: 'C', mode: 'once', points: [M(80, 30), M(80, 40)], stops: [{ at: 0, do: [{ kind: 'checkpoint' }] }] }));
    await step(CHECKPOINT_NUDGE_MS + 6000);
    expect(moves).toContain('forward 0.1');
    expect(log()).toMatch(/route "C" point 1: checkpoint: the server still has you \d+\.\d m off after 15 s; inched forward/);
    expect(api.routine.status().nav).toMatchObject({ point: 0 });
    expect(host.me.y).toBeLessThan(33);
    // The server catches up: the route goes on.
    echo = { cell: HOLTBURG, x: 80, y: 30, z: 94, at: host.t };
    await step(10_000);
    expect(log()).toMatch(/route "C" point 1: checkpoint: the server has you at the checkpoint/);
    expect(host.me.y).toBeGreaterThan(37);
    // A host that can't say where the server has you takes the client's word.
    echo = null;
  });

  it('NavFarStopRange: a point past it is not walked to (said once); within it the route walks', async () => {
    api.routine.start(navProfile({ name: 'F', mode: 'once', points: [M(80, 120)] }, { NavFarStopRange: 50 }));
    await step(4000);
    expect(host.me.y).toBe(20);
    expect(reports.filter((r) => /past NavFarStopRange \(50 m\); holding/.test(r))).toHaveLength(1);
    api.routine.setSetting('NavFarStopRange', 200);
    await step(30_000);
    expect(host.me.y).toBeGreaterThan(115);
  });

  it('OpenDoors: a closed door on the way is opened before the leg; off, it is left alone', async () => {
    const door = 0x7a9b0200;
    host.add({ guid: door, name: 'Door', objectDescFlags: 0x1000, x: 80, y: 30, physicsState: 0 });
    const use = host.use;
    host.use = (g) => { use(g); if (g === door) host.objs.get(door)!.physicsState = 0x4; return true; };
    api.routine.start(navProfile({ name: 'D', mode: 'once', points: [M(80, 40)] }));
    await step(8000);
    expect(host.sent).not.toContain(`use ${door.toString(16)}`);
    api.routine.stop();
    host.me.y = 20;
    api.routine.start(navProfile({ name: 'D', mode: 'once', points: [M(80, 40)] }, { OpenDoors: true }));
    await step(15_000);
    expect(host.sent).toContain(`use ${door.toString(16)}`);
    expect(log()).toContain('route "D" point 1: door: opened Door');
    expect(host.me.y).toBeGreaterThan(37);
  });

  it('OpenDoors: a door only a lever opens (ItemUseable No) is never used by hand', async () => {
    const door = 0x70145013;
    host.add({ guid: door, name: 'Door', objectDescFlags: 0x1000, x: 80, y: 30, physicsState: 0, useability: 0x1 });
    api.routine.start(navProfile({ name: 'D', mode: 'once', points: [M(80, 40)] }, { OpenDoors: true }));
    await step(15_000);
    expect(host.sent).not.toContain(`use ${door.toString(16)}`);
    expect(log()).not.toContain('door: Door');
  });

  it('OpenDoors: a locked door is picked with a Consumables lockpick when your skill is up to it; else it is skipped and said', async () => {
    const door = 0x7a9b0201;
    host.add({ guid: door, name: 'Vault Door', objectDescFlags: 0x1000, x: 80, y: 30, physicsState: 0 });
    host.appraisalDatas.set(door, { int: { 173: 120 }, float: {}, string: {}, bool: { 3: true }, did: {}, spells: [] });
    const pick = { guid: 0x50000301, name: 'Intricate Lockpick', where: 'main pack', objectDescFlags: 0x20000 } as const;
    host.inv.push(pick);
    let skill = 150;
    Object.assign(host, { skillList: () => [{ id: 23, name: 'Lockpick', training: 'trained', base: skill, buffed: skill }] });
    let unlocked = false;
    const useWith = host.useWithTarget;
    host.useWithTarget = (s, t) => { useWith(s, t); if (t === door && s === pick.guid) unlocked = true; return true; };
    const use = host.use;
    host.use = (g) => { use(g); if (g === door && unlocked) host.objs.get(door)!.physicsState = 0x4; return true; };
    const vtank = { ...emptyVtankData(), consumables: ['Intricate Lockpick'] };
    api.routine.start(navProfile({ name: 'D', mode: 'once', points: [M(80, 40)] }, { OpenDoors: true }, { vtank }));
    await step(15_000);
    expect(host.sent).toContain(`usewith ${pick.guid.toString(16)} ${door.toString(16)}`);
    expect(log()).toContain('door: picked with Intricate Lockpick and opened Vault Door');
    api.routine.stop();
    // Too hard for you (60 < 120 − 50): skipped, and the player is told.
    host.objs.get(door)!.physicsState = 0;
    unlocked = false;
    skill = 60;
    host.me.y = 20;
    host.sent.length = 0;
    api.routine.start(navProfile({ name: 'D', mode: 'once', points: [M(80, 40)] }, { OpenDoors: true }, { vtank }));
    await step(6000);
    expect(host.sent.some((x) => x.startsWith('usewith'))).toBe(false);
    expect(reports).toContain('locked door skipped: Vault Door (Lockpick 60 is under its difficulty 120 − 50)');
  });

  it('/vt reverseroute true|false sets the direction; reversed reads it; a new route walks forwards', () => {
    api.routine.start(navProfile({ name: 'R', mode: 'linear', points: [M(80, 22), M(80, 40), M(80, 60)] }, { EnableNav: false }));
    expect(api.routine.reverseRoute(true)).toMatchObject({ ok: true, message: 'route "R" reversed' });
    expect(api.routine.reversed).toBe(true);
    expect(api.routine.reverseRoute(true)).toMatchObject({ ok: true, message: 'route "R" already reversed' });
    expect(api.routine.reverseRoute(false).ok).toBe(true);
    expect(api.routine.reversed).toBe(false);
    api.routine.reverseRoute();
    expect(api.routine.reversed).toBe(true);
    api.routine.stop();
    api.routine.start(navProfile({ name: 'R', mode: 'linear', points: [M(80, 22), M(80, 40)] }, { EnableNav: false }));
    expect(api.routine.reversed).toBe(false);
  });
});

describe('.nav checkpoint (type 8) and portal-by-id (type 1) points', () => {
  const nav = ['uTank2 NAV 1.2', '2', '3',
    '0', '33.6', '42.1', '0.39', '0',
    '8', '33.61', '42.11', '0.39', '0',
    '1', '33.62', '42.12', '0.39', '0', '-2054553582', ''].join('\r\n');
  it('import as a checkpoint step and a use-portal step (the int32 id read unsigned), export back the same', () => {
    const { route, problems } = navToRoute('cp', parseNav(nav));
    expect(problems).toEqual([]);
    expect(route!.stops).toEqual([{ at: 1, do: [{ kind: 'checkpoint' }] }, { at: 2, do: [{ kind: 'use-portal', id: -2054553582 >>> 0 }] }]);
    const out = exportNav(route!);
    expect(parseNav(out.text).nodes.map((n) => [n.type, n.extra])).toEqual([[0, []], [8, []], [1, ['-2054553582']]]);
    expect(navToRoute('cp', parseNav(out.text)).route).toEqual(route);
    const doc = { ...emptyRoutineDoc('local-eor', 'acct'), profiles: [navProfile(route!)] };
    expect(validateRoutineDoc(doc)).toEqual([]);
  });
});
