/**
 * Movement fixes from the stream players' segment 05:13–06:14Z on 2026-10-17 (end-of-retail local ACE, Mountain Keep
 * 0x01D2 and the portal at Holtburg A8C3; build d75b5396; reports stream/reports/{mage-2026-10-17T06-13-53-251Z,
 * soldier-2026-10-17T06-14-09-425Z}-seg2.md; transcripts stream/sessions/{mage,soldier}-2026-10-17-seg2.jsonl; page traces
 * mage.log / soldier.log):
 *   1. walk_to "Mountain Keep" (the portal): the search's jump onto its platform landed 1.2 m from its centre and took
 *      Bulwark through it; the answer called it a portal "this walk was not sent to" (05:28:36–40Z).
 *   2. attack #80002cff (3 m NE, a floor apart): the server's approach ran Bulwark through the Surface portal (05:49:14Z).
 *   3. A stay_with walk and attack run-ups dropped Bulwark a floor below Arcanist (06:02:37Z, 06:12:57Z).
 *   4. walk_to Arcanist "arrived (1.9 m away)" as she ran past down a spiral ramp; 19 m off on the next observe (06:03:36Z).
 *   5. walk_to 0x01D20101 from the east halls went upstairs: the only doorway way (checked on the cell DAT below).
 *   6. After Bulwark took the Surface portal, Arcanist's follow said "last seen 32352 m E of you" (05:49Z).
 *   7. A repeat cast ended a running follow without saying so (05:26Z).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { cellStandPoint, findRoute, loadCellGraph, routeCutOff, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { flightCrossesDisk } from '../packages/renderer/src/agent/navPlanner.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const UPPER = 0xa9b40150, LOWER = 0xa9b40151;
const ARC = 0x50000002;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}
const fellowship = (host: FakeHost, guid = ARC, name = 'Claude Arcanist'): void => {
  host.fellows = () => [{ guid, name, health: { cur: 160, max: 166 }, stamina: { cur: 200, max: 214 }, mana: { cur: 300, max: 306 } }];
};
const portal = (host: FakeHost, guid: number, name: string, x: number, y: number, z: number, cell = host.me.cell) =>
  host.add({ guid, name, itemType: 0x10000, objectDescFlags: 0x40000, cell, x, y, z });
const events = (api: AgentApi): string[] => api.eventsSince(0).map((e) => `${e.type}: ${(e as { text?: string }).text ?? ''}`);

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = new FakeHost();
  api = new AgentApi(host);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. a walk to a portal: no jump lands in it, and going through the walk\'s own portal is said as that', () => {
  const MK = 0x7a8c3000;

  it('flightCrossesDisk: a landing inside a disk, a flight over one, and one clear of it or a floor away', () => {
    const disk = [{ x: 0, y: 0, z: 0, r: 2 }];
    expect(flightCrossesDisk({ x: 0, y: -5, z: 0 }, { x: 0, y: -1, z: 0 }, disk)).toBe(true);
    expect(flightCrossesDisk({ x: 0, y: -5, z: 0 }, { x: 0, y: 5, z: 0 }, disk)).toBe(true);
    expect(flightCrossesDisk({ x: 3, y: -5, z: 0 }, { x: 3, y: 5, z: 0 }, disk)).toBe(false);
    expect(flightCrossesDisk({ x: 0, y: -5, z: 10 }, { x: 0, y: -1, z: 10 }, disk)).toBe(false);
  });

  it('a jump across a gap whose straight landing is in a portal\'s disk: every landing is outside it (was 1.2 m from its centre)', async () => {
    host.jumpSkill = 300;
    host.me.health = { current: 175, max: 175 };
    // A 3.5 m pit (floor 88) across y 30–33.5; the portal just past its far lip, a little east of the straight way.
    host.floors = (_x, y) => (y < 30 || y > 33.5 ? [94] : [88]);
    host.me.cell = 0xa9b40150; host.me.x = 80; host.me.y = 22; host.me.z = 94;
    host.objectReach = (g) => (g === MK ? 1 : 0);
    portal(host, MK, 'Mountain Keep', 80.8, 35.2, 94, 0xa9b40151);
    host.add({ guid: 0x80000077, name: 'Chest', itemType: 0x200, cell: 0xa9b40151, x: 80, y: 42, z: 94 });
    const r = await settle(api, host, api.walkTo(0x80000077), 60_000);
    expect(host.landings.length, r?.message).toBeGreaterThan(0);
    for (const l of host.landings) expect(Math.hypot(l.x - 80.8, l.y - 35.2), JSON.stringify(l)).toBeGreaterThan(1.8);
    expect(r?.message).toMatch(/^arrived/);
  });

  it('teleported by the walk\'s own portal target: "went through Mountain Keep, the portal this walk went to", ok', async () => {
    host.wall = () => false;
    host.objectReach = (g) => (g === MK ? 1.92 : 0);
    portal(host, MK, 'Mountain Keep', 80, 40, 94);
    host.me.x = 80; host.me.y = 20;
    const p = api.walkTo('Mountain Keep');
    const r = await settle(api, host, p, 30_000, () => {
      // The server's teleport the moment the body is within its reach (here a little early: 5 m off).
      if (host.me.cell !== 0x01d202f7 && Math.hypot(host.me.x - 80, host.me.y - 40) < 5) { host.me.cell = 0x01d202f7; host.me.x = 60; host.me.y = -30; host.me.z = 0; }
    });
    expect(r?.ok, r?.message).toBe(true);
    expect(r?.message).toMatch(/^went through Mountain Keep #7a8c3000, the portal this walk went to \(a walk stops at a portal's edge; the walk came within its reach\): you're now in an interior \(cell 0x1d202f7\)/);
    expect(r?.message).not.toMatch(/not sent to/);
  });

  it('another portal on the way is still the fault it was', async () => {
    host.wall = () => false;
    host.objectReach = () => 1;
    portal(host, 0x7a8c3001, 'Surface', 80, 30, 94);
    host.add({ guid: 0x80000077, name: 'Chest', itemType: 0x200, x: 80, y: 60, z: 94 });
    host.me.x = 80; host.me.y = 20;
    const r = await settle(api, host, api.walkTo(0x80000077), 30_000, () => {
      if (host.me.cell !== 0x01d202f7 && Math.hypot(host.me.x - 80, host.me.y - 30) < 1.45) { host.me.cell = 0x01d202f7; host.me.x = 60; host.me.y = -30; host.me.z = 0; }
    });
    // The walk keeps out of it, so the body never got there (no teleport): it arrived round it.
    expect(r?.message).toMatch(/^arrived/);
    expect(host.me.cell).toBe(0xa9b40019);
  });
});

describe('2. a melee attack with a portal on the straight line to the target', () => {
  const DREAD = 0x80002cff, SURF = 0x701d206d;
  beforeEach(() => {
    host.wall = () => false;
    host.objectReach = (g) => (g === SURF ? 1 : 0);
    host.me.x = 80; host.me.y = 20;
    host.me.combatMode = 'melee';
  });

  it('runs up round the portal, never into its disk, then attacks (was: the server\'s approach ran Bulwark through it)', async () => {
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28, z: 94, level: 60 });
    portal(host, SURF, 'Surface', 80, 24, 94);
    const r = api.attack(DREAD);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^running up to Dread Mu-miyah \(#80002cff\): 8 m N, round Surface #701d206d \(4 m N: a portal on the straight line, which the server's own approach would run you through\), then attacking/);
    let closest = Infinity;
    for (let t = 0; t < 20_000 && !host.sent.some((x) => x.startsWith('attack')); t += 100) {
      run(api, host, 100); await Promise.resolve();
      closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 24));
    }
    expect(host.sent.some((x) => x.startsWith('attack')), events(api).join('\n')).toBe(true);
    expect(closest).toBeGreaterThan(1.7);
  });

  it('a target that moves behind a portal mid-fight: the attack stops, naming it (no request the server walks through)', async () => {
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22, z: 94, level: 60 });
    expect(api.attack(DREAD).ok).toBe(true);
    run(api, host, 300);
    expect(host.sent.filter((x) => x.startsWith('attack'))).toHaveLength(1);
    Object.assign(host.objs.get(DREAD)!, { y: 32 });
    portal(host, SURF, 'Surface', 80, 26, 94);
    host.pending = false;
    run(api, host, 2000);
    expect(host.sent.filter((x) => x.startsWith('attack'))).toHaveLength(1);
    expect(events(api).some((e) => /^target-lost: Dread Mu-miyah #80002cff: not attacking Dread Mu-miyah #80002cff from here: Surface #701d206d \(6 m N\) is on the straight line to it, and the server's walk to a melee target runs that line, through the portal/.test(e)), events(api).join('\n')).toBe(true);
  });

  it('no portal near the line: attacks at once as before', () => {
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28, z: 94, level: 60 });
    portal(host, SURF, 'Surface', 86, 24, 94);
    const r = api.attack(DREAD);
    expect(r.message).toMatch(/^attacking Dread Mu-miyah/);
  });
});

describe('3. one-way drops off the floor a fellow stands on', () => {
  // The upper floor (z 100) over x 60–80; the floor below (94) everywhere.
  const world = (x: number, y: number): number[] => {
    if (x < 50 || x > 110 || y < 0 || y > 40) return [];
    return x >= 60 && x <= 80 ? [94, 100] : [94];
  };
  beforeEach(() => {
    host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    host.floors = world;
    host.me.health = { current: 200, max: 200 };
    host.me.combatMode = 'melee';
    fellowship(host);
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 70, y: 21, z: 100 });
  });

  it('stay_with: at the edge with the fellow on your floor, the walk stops and says so (was: down at once, the pair split)', async () => {
    host.add({ guid: 0x7f000003, name: 'Fountain', cell: UPPER, x: 92, y: 20, z: 94 });
    const r = await settle(api, host, api.walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist' }), 40_000, () => {
      const a = host.objs.get(ARC)!; a.x = host.me.x; a.y = host.me.y + 1; a.z = host.me.z;
    });
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped [\d.]+ m short at the edge of a 6\.0 m drop: the way on drops to the floor below \(one way: the way back up may be long, or none\), and Claude Arcanist is on this floor \(1 m [NSEW]+ of you\), so stay_with doesn't go down without them\. Tell them \(ac_say text="\/f dropping 6\.0 m here, come down after me"\), then walk to Fountain again with drop=true/);
    expect(host.launches).toHaveLength(0);
    expect(host.me.z).toBeCloseTo(100, 1);
  });

  it('stay_with with the fellow already down there: goes down to them', async () => {
    Object.assign(host.objs.get(ARC)!, { cell: LOWER, x: 86, y: 20, z: 94 });
    host.add({ guid: 0x7f000003, name: 'Fountain', cell: UPPER, x: 92, y: 20, z: 94 });
    const r = await settle(api, host, api.walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist' }), 40_000);
    expect(r?.ok, r?.message).toBe(true);
    expect(host.me.z).toBeCloseTo(94, 1);
  });

  it('attack far=true down a doorway route\'s drop: refused, how far it drops and who stays up; drop=true goes', () => {
    const MU = 0x80003d7d;
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: LOWER, x: 90, y: 20, z: 94, level: 60 });
    host.routeTo = [{ x: 80.5, y: 20, z: 100, drop: 6, landing: 94 } as { x: number; y: number; z: number }];
    const r = api.attack(MU, { far: true });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('the run-up to Dread Mu-miyah #80003d7d drops 6.0 m to the floor below (one way), leaving Claude Arcanist (1 m from you) on this floor, so no attack was started. Let it come to you, tell them you\'re dropping and go together, or ac_attack target=#80003d7d far=true drop=true to go anyway');
    expect(host.sent.filter((x) => x.startsWith('attack'))).toEqual([]);
    expect(api.attack(MU, { far: true, drop: true }).ok).toBe(true);
  });

  it('attack far=true whose run-up search finds a ledge drop: it stops at the edge, says it in target-lost, never drops', async () => {
    const MU = 0x80003d7d;
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 90, y: 20, z: 94, level: 60 });
    expect(api.attack(MU, { far: true }).ok).toBe(true);
    for (let t = 0; t < 30_000 && !events(api).some((e) => e.startsWith('target-lost')); t += 100) { run(api, host, 100); await Promise.resolve(); }
    expect(host.launches).toHaveLength(0);
    expect(host.me.z).toBeCloseTo(100, 1);
    expect(events(api).find((e) => e.startsWith('target-lost'))).toMatch(/^target-lost: Dread Mu-miyah #80003d7d: no attack: stopped [\d.]+ m short at the edge of a 6\.0 m drop: the way on drops to the floor below \(one way\), leaving Claude Arcanist \(\d+ m from you\) on this floor\. Let it come to you, tell them you're dropping and go together, or ac_attack target=#80003d7d far=true drop=true to go anyway$/);
  });

  it('a target 3 m below whose doorway way drops: refused without far=true (was: "another floor" in the answer, and the run-up went)', () => {
    const MU = 0x80003d7d;
    host.me.z = 100;
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: LOWER, x: 76, y: 14, z: 97, level: 60 });
    host.routeTo = [{ x: 80.5, y: 20, z: 100, drop: 3, landing: 97 } as { x: number; y: number; z: number }];
    const r = api.attack(MU);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Dread Mu-miyah #80003d7d is on a floor below \(3 m down, 8 m SE\) \(the way there is about \d+ m by the doorways, down a drop\): running up to it leaves Claude Arcanist \(1 m from you\) behind on this floor/);
  });

  it('a target 3 m below in the same room (no doorway way): attacked as before', () => {
    const MU = 0x80003d7d;
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 72, y: 22, z: 97, level: 60 });
    expect(api.attack(MU).ok).toBe(true);
  });
});

describe('4. arriving at a fellow: not while they run past you', () => {
  beforeEach(() => {
    host.wall = () => false;
    host.me.x = 50; host.me.y = 20;
    fellowship(host);
  });

  it('a fellow running by within reach is not "arrived"; the walk arrives once she has stopped, beside her', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 50.5, y: 26, z: 94 });
    let stoppedAt = 0;
    const r = await settle(api, host, api.walkTo('Claude Arcanist'), 30_000, () => {
      const a = host.objs.get(ARC)!;
      // Running south at 11 m/s past you, then on 20 m and standing there.
      if (a.y > -10) { a.y -= 1.1; a.heardAt = host.t; } else if (!stoppedAt) stoppedAt = host.t;
    });
    expect(r?.ok, r?.message).toBe(true);
    expect(stoppedAt, r?.message).toBeGreaterThan(0);
    const a = host.objs.get(ARC)!;
    expect(Math.hypot(host.me.x - a.x, host.me.y - a.y)).toBeLessThan(3);
  });

  it('a fellow standing beside you: arrived at once as before', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 50, y: 21, z: 94 });
    const r = await settle(api, host, api.walkTo('Claude Arcanist'), 5_000);
    expect(r?.message).toMatch(/^arrived/);
    expect(host.t).toBeLessThan(2000);
  });
});

describe('5. a doorway way that climbs above both ends is said in the answer', () => {
  it('walk_to a room on your floor whose only way goes up and back down: "climbs about 14 m above both ends"', async () => {
    host.wall = () => false;
    host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = -12;
    host.routeTo = [{ x: 85, y: 20, z: 2 }, { x: 90, y: 20, z: 2 }, { x: 95, y: 20, z: -12 }];
    // A goal with no floor plan: the walk ends short (the fake can't climb), and the answer says why the way goes up.
    host.add({ guid: 0x80000077, name: 'Chest', itemType: 0x200, cell: LOWER, x: 100, y: 20, z: -12 });
    const r = await settle(api, host, api.walkTo(0x80000077, { timeoutMs: 10_000 }), 120_000);
    expect(r?.message).toMatch(/the only doorway way there climbs about 14 m above both ends and comes back down: no doorway, stair or ramp on your floor joins your room to it, so a walk there goes up first/);
  });

  it('a level doorway way: no such note', async () => {
    host.wall = () => false;
    host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = -12;
    host.routeTo = [{ x: 85, y: 20, z: -12 }];
    host.add({ guid: 0x80000077, name: 'Chest', itemType: 0x200, cell: LOWER, x: 90, y: 20, z: -12 });
    const r = await settle(api, host, api.walkTo(0x80000077), 30_000);
    expect(r?.message).not.toMatch(/climbs about/);
  });
});

describe('6. a fellow who went through a portal out of your dungeon', () => {
  const BUL = 0x500000a4;
  beforeEach(() => {
    host.cellSealed = (c) => ((c >>> 16) & 0xffff) === 0x01d2;
    host.wall = () => false;
    host.me.cell = 0x01d201a7; host.me.x = 60; host.me.y = -30; host.me.z = 0;
    fellowship(host, BUL, 'Claude Bulwark');
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0x01d201a7, x: 62, y: -30, z: 0 });
  });

  it('follow: "went through a portal or recalled … outside this dungeon (at 45.1N, 32.3E)", not "last seen 32352 m E"', async () => {
    const p = api.follow('Claude Bulwark', { durationMs: 60_000 });
    run(api, host, 1000);
    // ACE places him at the portal's destination (A7B7 0037), which the client then lets go.
    Object.assign(host.objs.get(BUL)!, { cell: 0xa7b70037, x: 160, y: 140, z: 30, lost: true });
    const r = await settle(api, host, p, 30_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped following: Claude Bulwark went through a portal or recalled: the client now places them outside this dungeon \(at [\d.]+[NS], [\d.]+[EW]\)/);
    expect(r?.message).not.toMatch(/\d{4,} m/);
  });
});

describe('7. a repeat cast that replaces a follow says so', () => {
  it('the cast\'s summary names the follow it ended and how to go on', async () => {
    host.wall = () => false;
    fellowship(host, 0x500000a4, 'Claude Bulwark');
    host.add({ guid: 0x500000a4, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 85, y: 20, z: 94 });
    host.add({ guid: 0x80003d71, name: 'Gold Phyntos Wasp', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40, z: 94, level: 30 });
    void api.follow('Claude Bulwark', { durationMs: 60_000 });
    run(api, host, 500);
    const p = api.cast('Flame Bolt I', 0x80003d71, { repeat: true, maxCasts: 1 });
    host.dying.add(0x80003d71);
    const r = await settle(api, host, p, 20_000);
    expect(r?.message).toMatch(/\n {2}your follow of Claude Bulwark stopped when this began \(one task at a time, and you stand still to cast\): ac_follow target="Claude Bulwark" to follow on/);
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
describe.skipIf(!haveDat)('5. the real Mountain Keep: 0x01D20101 from the east halls', () => {
  const LB = 0x01d20000;
  const C = (n: number): number => (LB | n) >>> 0;
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB); });

  it('both at −12, but the only doorway way climbs to +2 and comes back down a 6 m drop: not cut off, and up is the way', () => {
    for (const f of [0x10c, 0x107, 0x10b, 0x11f]) {
      const from = cellStandPoint(g, C(f))!, to = cellStandPoint(g, C(0x101))!;
      expect(from.z).toBeCloseTo(-12, 0);
      expect(to.z).toBeCloseTo(-12, 0);
      const r = findRoute(g, C(f), from, C(0x101), to, [], { maxDrop: 12 })!;
      expect(r).not.toBeNull();
      expect(Math.max(...r.map((p) => p.z))).toBeGreaterThan(0);
      expect(r.some((p) => p.drop !== undefined)).toBe(true);
      expect(routeCutOff(g, C(f), from, C(0x101), to, { maxDrop: 12, jumpAcross: 7.5 })).toBeNull();
    }
  });
});
