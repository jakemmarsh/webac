/**
 * Stream reports, 2026-10-19 15:49–15:50Z (segment 14:48–15:50Z, build 3640310fe): Claude Arcanist (mage, follows
 * Bulwark with his routine) and Claude Bulwark (soldier) in Sand Shallow, then Mountain Keep (0x01D2), on the local
 * end-of-retail ACE server. Transcripts stream/sessions/{mage,soldier}-2026-10-19-seg1.jsonl; page traces mage.log /
 * soldier.log; feed.jsonl. The causes, each read from those logs:
 *  1. Arcanist's `use target="Mountain Keep"` (15:31:18Z) answered "that is outside this dungeon … No walk gets there":
 *     his routine's Follow had used the portal after Bulwark 35 s before, but the entry named no portal (the server's walk
 *     took him in from farther than PORTAL_STEP_M of its middle), so the "it already took you" check found none.
 *  2. "Arcanist fights" stood silent 50 s (15:33:04–15:33:57Z) with a Dread Mu-miyah 4 m off running at him behind a wall:
 *     UseProjectileAwareness left it for every pass (no line of fire) and the macro planned nothing, said nothing, moved
 *     nowhere, until Bulwark fetched it through a door. No hold was involved: the holds after his hand actions lasted 7 s
 *     and 15 s. Arcanist's hand bolt at 15:34:10Z was refused for the same wall.
 *  3. Bulwark's `use target=0x701d2027` (the Holtburg portal 13 m off, 6 m up, from 0x01D20201) gave up at 45 s ("walking
 *     … took longer than 45 s"): the use's walk had a fixed 45 s whatever the way; walk_to's budget follows the way.
 *  4. `attack far=true` at a Dread 6 m up was refused for "a one-way 6.0 m drop … landing 6 m down from your floor": on the
 *     cell DAT that is the only way (0x01D201FE at −6 to the fountain room 0x01D202A6 at 0: down a 6 m drop to −12, then
 *     the ramps up, ~111 m; no way without the drop). The refusal now says so; a run-up or stay_with walk takes a way with
 *     no drop when one exists.
 *  5. "Claude Bulwark stamina 60% < 60% (Recharge-Helper-Stam)": 59.6% rounded up to the mark.
 * Each drives the shipped AgentApi / RoutineEngine / VtMacro / rechargePlan on the fake host; the route facts read the
 * real cell DAT, the routine's spells the real spell table (both DAT-gated).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { pctBelowText } from '../packages/renderer/src/agent/format.ts';
import { buildRechargeFamilies, planRecharge } from '../packages/renderer/src/agent/macro/rechargePlan.ts';
import { getClientRunRate, SkillId } from '@ac/shared';
import { BEYOND_MACRO_DEFAULTS } from '../packages/renderer/src/agent/beyondVtank.ts';
import { cellStandPoint, findRoute, loadCellGraph, slantFoot, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const ARC = 0x500000a3, BUL = 0x500000a4;
const MK = 0x7a8c3000;
const KEEP_CELL = 0x01d202f7;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
  return out;
}
type Pt = { x: number; y: number; z: number; drop?: number; landing?: number };
/** The host's doorway route, by the fall it may take (maxDrop): the fake's own ignores it. */
const setRoute = (host: FakeHost, fn: (to: Pt, maxDrop: number | undefined) => Pt[] | null): void => {
  (host as unknown as { route: (fc: number, f: unknown, tc: number, to: Pt, opts?: { maxDrop?: number }) => Pt[] | null }).route = (_fc, _f, _tc, to, opts) => fn(to, opts?.maxDrop);
};
const fellowship = (host: FakeHost, guid: number, name: string): void => {
  host.fellows = () => [{ guid, name, health: { cur: 200, max: 206 }, stamina: { cur: 290, max: 307 }, mana: { cur: 150, max: 150 } }];
};

describe('1. a use or walk of the portal you came through says so (was "outside this dungeon … No walk gets there")', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.cellSealed = (c) => (c & 0xffff) >= 0x100;
    host.me.name = 'Claude Arcanist'; host.me.guid = ARC;
    // Mountain Keep's portal on the landscape, 6 m off: the server's walk takes you in from its use radius.
    host.add({ guid: MK, name: 'Mountain Keep', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 26, z: 94 });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** The routine's Follow uses the portal after Bulwark: the server puts you in portal space from where you stand, 6 m off, and places you in the Keep on the same tick. */
  const goThrough = async (why?: string): Promise<void> => {
    let into = -1;
    const each = (): void => {
      if (into < 0 && host.sent.includes(`use ${MK.toString(16)}`)) {
        into = host.t;
        host.screenName = 'portal-space';
        host.me.cell = KEEP_CELL; host.me.x = 50; host.me.y = -70; host.me.z = 0;
      }
      if (into >= 0 && host.t - into >= 3000) host.screenName = 'world';
    };
    const r = await settle(api, host, api.use(MK, why ? { why } : {}), 20_000, each);
    expect(r?.ok, r?.message).toBe(true);
    // The arrival (portal space ends 3 s in).
    for (let i = 0; i < 50 && host.screenName !== 'world'; i++) { each(); run(api, host, 100); }
    run(api, host, 200);
  };
  const followThrough = (): Promise<void> => goThrough("following Claude Bulwark (your routine's Follow)");

  it('the entry names the portal the use was taking, though you stood 6 m from its middle', async () => {
    await followThrough();
    expect(api.eventsSince(0).find((e) => e.type === 'portal' && e.text === 'entered portal space')?.guid).toBe(MK);
  });

  it('use of it 35 s later: "you came through Mountain Keep 3x s ago, following Claude Bulwark …; you\'re inside now"', async () => {
    await followThrough();
    run(api, host, 30_000);
    const r = await settle(api, host, api.use('Mountain Keep'), 20_000);
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/^used Mountain Keep: you came through Mountain Keep 3\d s ago, following Claude Bulwark \(your routine's Follow\); you're inside now \(cell 0x01D202F7\), and Mountain Keep is back where you were\. Nothing to walk to: you are through$/);
    expect(r?.message).not.toMatch(/outside this dungeon/);
    expect(host.sent.filter((x) => x.startsWith('use')).length).toBe(1);
  });

  it('long after (10 min), still inside: said the same way, in minutes', async () => {
    await followThrough();
    run(api, host, 600_000, { physics: false });
    const r = await settle(api, host, api.use(MK), 20_000);
    expect(r?.message).toMatch(/^used Mountain Keep: you came through Mountain Keep 10 min ago, following Claude Bulwark/);
  });

  it('walk_to it from inside: not a walk, and says why', async () => {
    await followThrough();
    const r = await settle(api, host, api.walkTo('Mountain Keep'), 5000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^walking to Mountain Keep: you came through Mountain Keep \d+ s ago, following Claude Bulwark \(your routine's Follow\); you're inside now \(cell 0x01D202F7\), and Mountain Keep is back where you were\. No walk goes back to it from here/);
  });

  it('your own use: no "following" said; another portal in another place is still "outside this dungeon"', async () => {
    host.add({ guid: 0x7a8c3001, name: 'Portal to Holtburg', itemType: 0x10000, objectDescFlags: 0x40000, x: 60, y: 26, z: 94 });
    await goThrough();
    const r = await settle(api, host, api.use(MK), 20_000);
    expect(r?.message).toMatch(/^used Mountain Keep: you came through Mountain Keep \d+ s ago; you're inside now/);
    const other = await settle(api, host, api.use(0x7a8c3001), 20_000);
    expect(other?.ok).toBe(false);
    expect(other?.message).toMatch(/outside this dungeon/);
  });

  it('back out on the landscape (another landblock than the trip\'s): the old trip no longer answers', async () => {
    await followThrough();
    host.me.cell = 0xa9b40019; host.me.x = 70; host.me.y = 20; host.me.z = 94;
    run(api, host, 500);
    const r = await settle(api, host, api.walkTo('Mountain Keep'), 20_000);
    expect(r?.message ?? '').not.toMatch(/you came through/);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('2. SeekLineOfFire: a caster routine with no line to what is on it moves for one, or says why it waits', () => {
  type Table = { spells: Map<number, { name: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  let host: FakeHost;
  let api: AgentApi;
  const DREAD = 0x80010603;
  // A wall north of x = 82: from x ≤ 82 the bolt line to the Dread at (84, 24) is blocked.
  let open = (): boolean => host.me.x > 82;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', guid: ARC, combatMode: 'magic' };
    const bolt = id('Flame Bolt I');
    host.spells = () => { const s = table.spells.get(bolt)!; return [{ id: bolt, name: s.name, school: 'War', level: 1, category: s.category, power: s.power, duration: 0 }]; };
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 34, name: 'War Magic', training: 'trained', base: 150, buffed: 150 }];
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 84, y: 24, z: 94 });
    open = () => host.me.x > 82;
    host.lineOfFire = (g) => (g === DREAD ? { dist: Math.hypot(84 - host.me.x, 24 - host.me.y), blockedAt: open() ? null : 1.2, blocker: 'a wall' } : null);
    host.lineOfFireOpenSpot = (g) => (g === DREAD && !open() ? { dx: 3, dy: 0, dist: 3 } : null);
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const step = async (ms: number, each?: () => void): Promise<void> => {
    for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
  };
  const vt = (settings: Record<string, string | number | boolean> = {}): RoutineProfile => ({
    name: 'Arcanist fights', modules: { ...ALL_MODULES_OFF, combat: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once',
    settings: { AttackDistance: 30, ...settings }, vtank: emptyVtankData(),
  });
  const hits = (): (() => void) => { let n = 0; return () => { if (++n % 10 === 0) api.pushChat('Dread Mu-miyah hits you for 3 points of bludgeoning damage!', 0x15); }; };
  const bolts = (): string[] => host.sent.filter((x) => x.startsWith('cast '));

  it('the Dread on you behind a wall: the routine steps 3 m E for a line, then bolts it (was: stood silent 50 s)', async () => {
    const h = hits();
    api.pushChat('Dread Mu-miyah hits you for 3 points of bludgeoning damage!', 0x15);
    api.routine.start(vt());
    await step(12_000, h);
    const log = api.routine.history().join('\n');
    expect(log, log).toMatch(/combat: no line of fire to Dread Mu-miyah #80010603 \(\d+ m, hitting you\): stepping 3 m east of you for one \(SeekLineOfFire\)/);
    expect(host.me.x).toBeGreaterThan(82);
    expect(bolts(), log).toContain(`cast ${id('Flame Bolt I')} ${DREAD.toString(16)}`);
  });

  it('no open spot within 3 m and no fellow with a line: the log says why it waits, once, and nothing is cast', async () => {
    host.lineOfFireOpenSpot = () => null;
    const h = hits();
    api.pushChat('Dread Mu-miyah hits you for 3 points of bludgeoning damage!', 0x15);
    api.routine.start(vt());
    await step(10_000, h);
    const log = api.routine.history().join('\n');
    expect(log, log).toMatch(/combat: no line of fire to Dread Mu-miyah #80010603 \(\d+ m, hitting you\): a wall or object stands between, and no spot within 3 m of you, nor beside a fellow in view, has an open line: waiting for it to come round the wall \(or for a fellow to bring it\)/);
    expect(log.match(/no line of fire to Dread/g)).toHaveLength(1);
    expect(bolts()).toEqual([]);
    expect(host.me.x).toBeCloseTo(80, 0);
  });

  it('beside the fellow whose place has a line: walks to them', async () => {
    host.lineOfFireOpenSpot = () => null;
    fellowship(host, BUL, 'Claude Bulwark');
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 86, y: 20, z: 94 });
    host.lineOfFireFrom = (g, from) => (g === DREAD && from === BUL ? { dist: 4, blockedAt: null } : null);
    open = () => host.me.x > 83;
    const h = hits();
    api.pushChat('Dread Mu-miyah hits you for 3 points of bludgeoning damage!', 0x15);
    api.routine.start(vt());
    await step(12_000, h);
    const log = api.routine.history().join('\n');
    expect(log, log).toMatch(/stepping beside Claude Bulwark \(6 m E of you\) for one \(SeekLineOfFire\)/);
    expect(bolts(), log).toContain(`cast ${id('Flame Bolt I')} ${DREAD.toString(16)}`);
  });

  it('SeekLineOfFire off is VTank\'s way: no step, no note', async () => {
    const h = hits();
    api.pushChat('Dread Mu-miyah hits you for 3 points of bludgeoning damage!', 0x15);
    api.routine.start(vt({ SeekLineOfFire: false }));
    await step(8000, h);
    expect(api.routine.history().join('\n')).not.toMatch(/no line of fire/);
    expect(host.me.x).toBeCloseTo(80, 0);
  });

  it('a monster in range neither on you nor coming at you: nothing sought (a pull is the player\'s)', async () => {
    api.routine.start(vt());
    await step(6000);
    expect(api.routine.history().join('\n')).not.toMatch(/no line of fire/);
  });

  it('is on by default beside the other beyond-VTank settings', () => {
    expect(BEYOND_MACRO_DEFAULTS.SeekLineOfFire).toBe(true);
  });
});

describe('3. a use\'s walk gets walk_to\'s time for a long way (was a fixed 45 s)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const NPC = 0x701d2027;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.cell = 0xa9b40105; host.cellSealed = () => true;
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('walk_to\'s budget for the way: none past the use\'s own 45 s up to 45 m, then distance ÷ 3 + 30 s', () => {
    expect(AgentApi.useWalkBudgetMs(30)).toBe(0);
    expect(AgentApi.useWalkBudgetMs(45)).toBe(0);
    expect(AgentApi.useWalkBudgetMs(120)).toBe(70_000);
    expect(AgentApi.useWalkBudgetMs(Infinity)).toBe(0);
    expect(AgentApi.useWalkBudgetMs(5000)).toBe(AgentApi.WALK_MAX_MS);
  });

  it('13 m off by a 267 m doorway way (~70 s of walking): the walk gets there and the use goes', async () => {
    host.add({ guid: NPC, name: 'Holtburg Healer', itemType: 0x10, cell: 0xa9b40107, x: 80, y: 33, z: 94 });
    host.routeTo = [{ x: 150, y: 20, z: 94 }, { x: 150, y: 90, z: 94 }, { x: 80, y: 90, z: 94 }];
    const r = await settle(api, host, api.use(NPC), 180_000);
    expect(r, 'no answer').not.toBeNull();
    expect(r!.message).not.toMatch(/took longer than 45 s/);
    expect(host.t).toBeGreaterThan(AgentApi.USE_APPROACH_MS);
    expect(host.sent).toContain(`use ${NPC.toString(16)}`);
  });
});

describe('4. a run-up up a storey by a one-way drop: the only way, said so; a way without a drop is taken', () => {
  let host: FakeHost;
  let api: AgentApi;
  const MU = 0x80001cda;
  const LB = 0x01d20000;
  const DROP_ROUTE: Pt[] = [{ x: 85, y: 20, z: 0 }, { x: 90, y: 20, z: 0, drop: 6, landing: -6 }, { x: 95, y: 30, z: -6 }, { x: 90, y: 40, z: 6 }];
  const FLAT_ROUTE: Pt[] = [{ x: 70, y: 30, z: 0 }, { x: 70, y: 40, z: 3 }, { x: 85, y: 40, z: 6 }];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.cellSealed = (c) => (c & 0xffff) >= 0x100;
    host.me.cell = (LB | 0x1fe) >>> 0; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.me.health = { current: 206, max: 206 }; host.me.combatMode = 'melee'; host.me.name = 'Claude Bulwark'; host.me.guid = BUL;
    // Floors to stand on (the jump hooks): the planner then routes falls your health takes, as in the Keep.
    host.floors = () => [-12, -6, 0, 6];
    fellowship(host, ARC, 'Claude Arcanist');
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 80, y: 25, z: 0 });
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, level: 60, cell: (LB | 0x2a6) >>> 0, x: 90, y: 40, z: 6 });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the only way drops below your floor first: refused, saying it is the only way and that it goes down first', () => {
    setRoute(host, (to, m) => (m === 0 ? null : [...DROP_ROUTE, to]));
    const r = api.attack(MU, { far: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^the run-up to Dread Mu-miyah #80001cda \(6 m up from you\) has a one-way 6\.0 m drop on the way, landing 6 m down from your floor \(the only doorway way there, about \d+ m: it goes down first, then up by stairs or ramps; no stair, ramp or doorway reaches it from here without the drop\), leaving Claude Arcanist \(5 m from you\) on this floor, so no attack was started/);
  });

  it('a longer way with no drop exists: no refusal, and the run-up walks that way (the fellow stays with you)', async () => {
    const asked: Array<number | undefined> = [];
    setRoute(host, (to, m) => { asked.push(m); return m === 0 ? [...FLAT_ROUTE, to] : [...DROP_ROUTE, to]; });
    const r = api.attack(MU, { far: true });
    expect(r.ok, r.message).toBe(true);
    expect(asked).toContain(0);
    // Its walk heads up the drop-free way (west, then north), never east to the drop's edge at x 90.
    let maxX = host.me.x;
    for (let t = 0; t < 4000; t += 100) { run(api, host, 100); maxX = Math.max(maxX, host.me.x); await Promise.resolve(); }
    expect(maxX).toBeLessThan(84);
  });

  it('a walk_to with no fellow to keep (no stay_with, no run-up) still takes the shortest way, drop and all', () => {
    const asked: Array<number | undefined> = [];
    setRoute(host, (to, m) => { asked.push(m); return [...DROP_ROUTE, to]; });
    void api.walkTo(MU, { within: 2 });
    run(api, host, 300);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain(0);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell))('4b. on the cell DAT: Mountain Keep 0x01D201FE (−6) to the fountain room 0x01D202A6 (0) has no way without the drop', () => {
  let g: CellGraph;
  const C = (n: number): number => (0x01d20000 | n) >>> 0;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0x01d20000); });

  it('the way up goes down a 6 m drop to −12 first, then up the ramps; with no drop allowed, none', () => {
    const from = { x: 79.5, y: -79.1, z: cellStandPoint(g, C(0x1fe))!.z };
    expect(from.z).toBeCloseTo(-6, 0);
    const to = cellStandPoint(g, C(0x2a6))!;
    expect(to.z).toBeCloseTo(0, 0);
    const r = findRoute(g, C(0x1fe), from, C(0x2a6), to, [], { maxDrop: 12 })!;
    expect(r).not.toBeNull();
    expect(r.filter((p) => p.drop !== undefined).map((p) => Math.round(p.drop!))).toEqual([6]);
    expect(Math.min(...r.map((p) => p.feet ?? p.z))).toBeLessThan(-10);
    expect(findRoute(g, C(0x1fe), from, C(0x2a6), to, [], { maxDrop: 0 })).toBeNull();
  });
});

describe('5. a vital under its mark never reads as at it ("60% < 60%")', () => {
  it('pctBelowText: whole when its rounding stays under, else to the tenth below', () => {
    expect(pctBelowText(59.6, 60)).toBe('59.6%');
    expect(pctBelowText(59.96, 60)).toBe('59.9%');
    expect(pctBelowText(41.2, 60)).toBe('41%');
    expect(pctBelowText(59.4, 60)).toBe('59%');
  });

  it('the Helper\'s line for a fellow at 59.7%: "59.7% < 60% (Recharge-Helper-HitP)", and the own-vital line likewise', () => {
    const TABLE = new Map([
      [6, { name: 'Heal Other', category: 79, school: 2, bitfield: 0x4, power: 100, desc: "Restores 20-45 points of the target's Health." }],
      [1, { name: 'Heal Self', category: 67, school: 2, bitfield: 0xc, power: 100, desc: "Restores 20-45 points of the caster's Health." }],
    ]);
    const fam = buildRechargeFamilies({ spells: TABLE } as never);
    const spells = [...TABLE].map(([id, t]) => ({ id, name: t.name, school: 'Life Magic', category: t.category, power: t.power, self: (t.bitfield & 8) !== 0, buff: false, duration: 0 }));
    const skills = [{ id: SkillId.LifeMagic, name: 'Life Magic', training: 'specialized' as const, base: 300, buffed: 300 }];
    const base = { stance: 'magic' as const, hasTarget: true, spells, skills, consumables: [], rechargeFamilies: fam };
    const full = { cur: 300, max: 300 };
    const helper = planRecharge({ ...base, vitals: { health: full, stamina: full, mana: full }, settings: { 'Recharge-Helper-HitP': 60 },
      fellows: [{ guid: BUL, name: 'Claude Bulwark', distance: 3, health: { cur: 179, max: 300 }, stamina: full, mana: full }] });
    expect(helper?.why).toMatch(/^Claude Bulwark health 59\.6% < 60% \(Recharge-Helper-HitP\)/);
    const own = planRecharge({ ...base, vitals: { health: { cur: 179, max: 300 }, stamina: full, mana: full }, settings: { 'Recharge-Norm-HitP': 60 } });
    expect(own?.why).toMatch(/^health 59\.6% < 60% \(Recharge-Norm-HitP\)/);
  });
});

/**
 * 6. Tusker Habitat (0x5B47): "walk: no way into the doorway … (something stands in it)" ~60 times and "no doorway route …
 * (N door(s) that would not open left out)" in Bulwark's log. Read from the logs, those lines are from 2026-10-17 15:51Z
 * on (a build long before b76eafd05; run 76 on 2026-10-19 from 15:51Z is in Mountain Keep and has none). 0x5B47 has no doors
 * at all (ACE-World 6 LandBlockExtendedData 5B47.sql: Tusker Liberators, a generator, the Surface portal): the "doors"
 * left out were the doorways the walk had failed to enter, kept shut for the rest of the walk. The stalls sat at the
 * stacked doorways (0x0174 → 0x0169 under 0x016A, 0x0103 → 0x0101 under 0x0102): a 3.75 m opening whose upper cell's side
 * is a 0.75 m sliver, the two cells split by a sloped plane, which b76eafd05 reads as passable ("slanted"). Replayed
 * through the cell DAT's collision on b76eafd05, the doorways went in, but the walk 0x0174 → 0x012C stood "stuck … no way
 * up" in 0x0107: b76eafd05 also dropped every slanted split from routes, so the walk aimed straight from 0x0109's doorway
 * to 0x010D's across a corner ramp, climbed it and stalled over the sunken strip 0x0108. A split off that line is now kept,
 * aimed at its low edge on the floor (cellPath.slantFoot).
 */
describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('6. Tusker Habitat 0x5B47: the stacked doorways walk through (the 2026-10-17 stalls)', () => {
  const LB5 = 0x5b470000;
  const C5 = (n: number): number => (LB5 | n) >>> 0;
  let g5: CellGraph;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    g5 = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB5);
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB5, { statics: true, jumpSkill: 185, runRate: getClientRunRate(0.34, 253) });
  }, 120_000);

  it('the split under each sliver is a slanted, passable doorway, and the routes between the logged rooms exist', () => {
    expect(g5.doors.get(C5(0x169))!.find((x) => x.b === C5(0x16a))?.slanted).toBe(true);
    // The split 0x0107 / 0x0108 is aimed at where it meets the floor (its low edge), not its centroid up the slope, and is
    // kept in a route that turns there: the line from 0x0109's doorway (10, −65) to 0x010D's (15, −60) cut over a ramp.
    const split = g5.doors.get(C5(0x108))!.find((x) => x.b === C5(0x107))!;
    expect(split.slanted).toBe(true);
    expect(slantFoot(split)).toMatchObject({ x: expect.closeTo(10, 1), y: expect.closeTo(-60, 1), z: expect.closeTo(-12, 3) });
    const turn = findRoute(g5, C5(0x101), { x: 2, y: -70, z: -12 }, C5(0x12c), cellStandPoint(g5, C5(0x12c))!, [], { maxDrop: 12 })!;
    expect(turn.some((p) => Math.abs(p.x - 10) < 0.2 && Math.abs(p.y + 60) < 0.2 && Math.abs((p.feet ?? 0) + 12) < 0.01)).toBe(true);
    for (const [a, b] of [[0x174, 0x16a], [0x16a, 0x12c], [0x125, 0x14a], [0x175, 0x131]]) {
      expect(findRoute(g5, C5(a), cellStandPoint(g5, C5(a))!, C5(b), cellStandPoint(g5, C5(b))!, [], { maxDrop: 12 }), `${a.toString(16)} → ${b.toString(16)}`).not.toBeNull();
    }
  });

  const walks: Array<[string, number, number]> = [['0x0174 → 0x012C (through 0x016A and down the ramps)', 0x174, 0x12c], ['0x0125 → 0x014A', 0x125, 0x14a], ['0x0175 → 0x0131', 0x175, 0x131], ['0x0174 → 0x016A', 0x174, 0x16a]];
  for (const [label, from, to] of walks) {
    it(`a walk ${label} arrives without a doorway it can't get into`, async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB5, { rooms: true });
      host.me.health = { current: 206, max: 206 };
      try {
        const at = cellStandPoint(g5, C5(to))!;
        const r = await host.walk(C5(from), cellStandPoint(g5, C5(from))!, { cell: C5(to), ...at, name: 'Claude Arcanist', itemType: 0x10 }, { within: 2, maxMs: 120_000 });
        expect(r.ok, `${r.message}\n${host.traces.join('\n')}`).toBe(true);
        expect(host.traces.filter((l) => /something stands in it|left out: door/.test(l)), host.traces.join('\n')).toEqual([]);
      } finally { host.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 180_000);
  }
});
