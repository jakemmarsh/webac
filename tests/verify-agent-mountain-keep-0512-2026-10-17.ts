/**
 * Mountain Keep (dungeon landblock 0x01D2) and Holtburg, the stream players' segment 04:11–05:12Z on 2026-10-17, end of
 * retail local ACE, build d75b5396 (reports stream/reports/{mage-2026-10-17T05-12-37-377Z,soldier-2026-10-17T05-12-35-168Z}-seg1.md;
 * transcripts stream/sessions/{mage,soldier}-2026-10-17-seg1.jsonl; page traces mage.log / soldier.log):
 *   1. "walls all round": Arcanist's walks from 0x01D20192 / 01C0 / 01D3 / 01D4 to the Holtburg portal (#701d2027 in
 *      0x01D201F7), 0x01F6, 0x010C and the Surface portal by the way in (#701d206d, 0x01D202F4) searched for minutes and
 *      ended stuck (04:24–04:45Z). On the cell DAT those −6 halls (under the 0 m walkways 0x01D201D0 / 01CB) are joined to
 *      the Holtburg portal's side only one way: from there by the 7.1 m leap (0x02A6 → 0x029D) and a 6 m drop off the
 *      walkway, and from the way in (0x01D202F7) by drops. Every opening overhead out of them is 6 m above the floor. Their
 *      way out is up: the doorways climb to 0x01D203A5 (z 36), where the world's other Surface portal (#701D2099) stands.
 *      Bulwark's walk_to 0x01D20192 from the Holtburg side: the leap is the only way; his jump across came down on the far
 *      lip, he slid into the pit and the walk searched until "went round in circles" (04:22:56–04:23:32Z).
 *   2. walk_to "54.7N, 32.9E" (3.2 m from the Mountain Keep portal's centre, its disk 2.7 m) arrived "1.7 m away" inside
 *      the portal's reach and went through it (05:07:38Z, WeenieError ITeleported), splitting the fellowship.
 *   3. use #701d2020: the walk to it opened it (its door detour), then the use's own Use followed; the reply named
 *      "Door #701d201c 15 m NW swung open" (a Dread Mu-miyah walking into it: ACE Door.OnCollideObject) and a second use
 *      was needed (04:36:08–04:36:23Z).
 * World: ACE-World-16PY 01D2.sql (doors 0x701D2020 / 201C, weenies 5624 / 5625, Setups 0x0200024F / 0x02000281,
 * PhysicsState 8; portals 0x701D2027 Holtburg, 0x701D206D and 0x701D2099 Surface), A8C3.sql (Mountain Keep portal
 * 0x7A8C3000, weenie 1364, Setup 0x020005D3: part radius 1.92 m).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi, parseMapCoords } from '../packages/renderer/src/agent/AgentApi.ts';
import { cellStandPoint, loadCellGraph, routeCutOff, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.ts';

/** A run of 11 m/s and a look every 300 ms (a slow frame), as the stream's windows ran. */
class FastHost extends FakeHost {
  physics(dtMs: number): void {
    if (!this.keys.has('KeyW')) return;
    const speed = this.keys.has('ShiftLeft') ? 3.12 : 11;
    const step = (speed * dtMs) / 1000;
    this.me.x += -Math.sin(this.me.yaw) * step;
    this.me.y += -Math.cos(this.me.yaw) * step;
  }
}

describe('2. walk_to a point at a portal stops outside its edge and says so (never through it unasked)', () => {
  const PORTAL = 0x7a8c3000;
  /** Where the body touches the portal: its sphere (1.357 m, Setup 0x020005D3) and the body's (0.48 m). */
  const TOUCH_M = 1.357 + 0.48;
  /** Its disk: the part radius 1.92 m and the walk's 0.8 m clearance. */
  const DISK_M = 1.92 + 0.8;
  let host: FastHost;
  let api: AgentApi;
  let goal: { x: number; y: number };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FastHost();
    api = new AgentApi(host);
    host.wall = () => false;
    host.objectReach = (g) => (g === PORTAL ? 1.92 : 0);
    // Holtburg's landblock 0xA9B4; the point walked to, in its frame.
    const g = parseMapCoords('42.1N, 33.6E')!;
    goal = { x: g.x - 0xa9 * 192, y: g.y - 0xb4 * 192 };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const drive = (ms: number, px: number, py: number): number => {
    let closest = Infinity;
    for (let t = 0; t < ms; t += 300) {
      host.t += 300; vi.advanceTimersByTime(300); host.physics(300); api.tick();
      closest = Math.min(closest, Math.hypot(host.me.x - px, host.me.y - py));
    }
    return closest;
  };

  it('a map point 3.2 m from the portal\'s centre (Arcanist\'s "54.7N, 32.9E"): arrives outside its disk, naming it', async () => {
    // The portal 2.6 m W and 1.8 m S of the point; the body comes up from the south-west, the way past the portal.
    const px = goal.x - 2.6, py = goal.y - 1.8;
    host.add({ guid: PORTAL, name: 'Mountain Keep', itemType: 0x10000, objectDescFlags: 0x40000, x: px, y: py, z: 94 });
    host.me.x = goal.x - 4; host.me.y = goal.y - 40;
    const p = api.walkTo('42.1N, 33.6E');
    const closest = drive(30_000, px, py);
    const r = await p;
    expect(r.message).toMatch(/^arrived \([\d.]+ m from [^)]+\); that point is 3\.2 m from Mountain Keep #7a8c3000, a portal, so the walk stopped outside its edge \([\d.]+ m from it\): stepping into a portal takes you through it\. ac_use it to go through/);
    expect(closest).toBeGreaterThan(DISK_M);
    expect(closest).toBeGreaterThan(TOUCH_M);
  });

  it('a point on the portal itself: stops at its edge on your side, not "the only way on passes through" holds', async () => {
    host.add({ guid: PORTAL, name: 'Mountain Keep', itemType: 0x10000, objectDescFlags: 0x40000, x: goal.x, y: goal.y, z: 94 });
    host.me.x = goal.x + 1; host.me.y = goal.y - 30;
    const p = api.walkTo('42.1N, 33.6E');
    const closest = drive(30_000, goal.x, goal.y);
    const r = await p;
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/that point is 0\.0 m from Mountain Keep #7a8c3000, a portal, so the walk stopped outside its edge/);
    expect(closest).toBeGreaterThan(DISK_M);
    expect(host.me.y).toBeLessThan(goal.y); // on the side it came from
  });

  it('a point well clear of any portal: arrives as before, no note', async () => {
    host.add({ guid: PORTAL, name: 'Mountain Keep', itemType: 0x10000, objectDescFlags: 0x40000, x: goal.x - 12, y: goal.y, z: 94 });
    host.me.x = goal.x; host.me.y = goal.y - 30;
    const p = api.walkTo('42.1N, 33.6E');
    drive(20_000, goal.x - 12, goal.y);
    const r = await p;
    expect(r.message).toMatch(/^arrived \([\d.]+ m from [^)]+\)$/);
    expect(Math.hypot(host.me.x - goal.x, host.me.y - goal.y)).toBeLessThan(2.5);
  });

  it('the portal itself as the walk\'s target keeps its old stop (within its reach and clearance), and ac_use still goes in', async () => {
    host.add({ guid: PORTAL, name: 'Mountain Keep', itemType: 0x10000, objectDescFlags: 0x40000, x: goal.x, y: goal.y, z: 94 });
    host.me.x = goal.x; host.me.y = goal.y - 30;
    const p = api.walkTo('Mountain Keep');
    drive(20_000, goal.x, goal.y);
    const r = await p;
    expect(r.message).toMatch(/^arrived/);
    expect(r.message).not.toMatch(/a portal, so the walk stopped outside its edge/);
  });
});

describe('3. use a door: one Use per door, and another door swinging meanwhile is not this use\'s doing', () => {
  const A = 0x701d2020, B = 0x701d201c;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = 0x01d201c0; host.me.x = 61; host.me.y = -23; host.me.z = -6;
    host.add({ guid: A, name: 'Door', itemType: 128, objectDescFlags: 0x1000, cell: 0x01d2019b, x: 60, y: -25.25, z: -6, physicsState: 8 });
    host.add({ guid: B, name: 'Door', itemType: 128, objectDescFlags: 0x1000, cell: 0x01d20174, x: 45.25, y: -20, z: -6, physicsState: 8 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const settle = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
    let out: T | null = null; let done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return out;
  };

  it('the door used stays shut while a creature opens the other: said as "meanwhile (not by this use …)" and "itself did not swing"', async () => {
    // The server ignores this Use (ACE Door.ActOnUse returns while the door is busy swinging); a Dread walks into Door B.
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.objs.get(B)!.physicsState = 8 | 4; return true; };
    const r = await settle(api.use(A), 15_000);
    expect(r?.message).toMatch(/^used Door:/);
    expect(r?.message).toMatch(/Door #701d201c \d+ m [NSEW]+ swung open meanwhile \(not by this use: a Use swings only the door used; a creature walking into a shut door opens it\)/);
    expect(r?.message).toMatch(/Door itself did not swing: it is still closed/);
  });

  it('the door used opens: "is now open", and the other door\'s swing is still marked as not its doing', async () => {
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      const t = host.t;
      setTimeout(() => { host.objs.get(B)!.physicsState = 8 | 4; }, 50);
      setTimeout(() => { if (host.t >= t) host.objs.get(A)!.physicsState = 8 | 4; }, 1500);
      return true;
    };
    const r = await settle(api.use(A), 15_000);
    expect(r?.ok, r?.message).toBe(true);
    expect(r?.message).toMatch(/Door is now open/);
    expect(r?.message).toMatch(/swung open meanwhile \(not by this use/);
    expect(r?.message).not.toMatch(/itself did not swing/);
  });
});

describe('1. a leap of the doorway route that comes down short (Bulwark, 0x01D202A6 → 0x029D, 04:22:56Z): the walk ends naming it', () => {
  // Holtburg's frame (the fake's floors): a ledge (z 94) to y 30, a 3.5 m pit (floor 88), the far ledge from y 33.5 on.
  class LeapHost extends FakeHost {
    /** The planner's launch carries this much farther than the body's own (the gap between a plan and the live jump). */
    planBoost = 1;
    override get jumpLaunch(): FakeHost['jumpLaunch'] {
      const own = super.jumpLaunch;
      return own ? (p, w) => { const l = own(p, w); return { ...l, forward: l.forward * this.planBoost }; } : undefined;
    }
  }
  let host: LeapHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new LeapHost();
    api = new AgentApi(host);
    host.jumpSkill = 300;
    host.floors = (_x, y) => (y < 30 || y > 33.5 ? [94] : [88]);
    host.me.cell = 0xa9b40150; host.me.x = 80; host.me.y = 22; host.me.z = 94;
    host.me.health = { current: 175, max: 175 };
    host.add({ guid: 0x80000077, name: 'Chest', itemType: 0x200, cell: 0xa9b40151, x: 80, y: 42, z: 94 });
    // The doorway route: across the pit by a leap, its point 1.5 m past the far lip (cellPath LEAP_LAND_M).
    host.routeTo = [{ x: 80, y: 35, z: 94, leap: 3.5 } as { x: number; y: number; z: number }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const settle = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
    let out: T | null = null; let done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return out;
  };

  it('the jump falls into the gap: "your jump across it came down short", at once (was: searches until "round in circles")', async () => {
    host.planBoost = 1.6;
    const r = await settle(api.walkTo(0x80000077), 60_000);
    expect(host.launches.length).toBeGreaterThanOrEqual(1);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: the only doorway route there leaps a 3\.5 m gap over open air, and your jump across it came down short \((?:here|\d+ m [NSEW]+ of you), z [\d.]+\), so the leap the planner counted on doesn't carry for you here: you are \d m below the take-off, in the gap \(cell 0xA9B40150\)\. Meet on this side, or go round by the way out$/);
    expect(host.launches.length).toBe(1);
  });

  it('a leap that carries: on to the goal, no such note', async () => {
    const r = await settle(api.walkTo(0x80000077), 60_000);
    expect(r?.message).toMatch(/^arrived/);
    expect(host.me.z).toBe(94);
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x01d20000;
const C = (n: number): number => (LB | n) >>> 0;
const hex = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

describe.skipIf(!haveDat)('the real Mountain Keep (0x01D2): the −6 halls under the walkways', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB); });
  const FROM = [0x192, 0x1c0, 0x1d3, 0x1d4];
  const TO = [0x1f7, 0x1f6, 0x10c, 0x2f4];

  it('1. every failing pair: no doorway route, the openings overhead 6 m up, and the way between runs one way (drops in)', () => {
    for (const f of FROM) for (const t of TO) {
      const cut = routeCutOff(g, C(f), cellStandPoint(g, C(f))!, C(t), cellStandPoint(g, C(t))!, { maxDrop: 12, jumpAcross: 7.5 });
      expect(cut, `${hex(C(f))} → ${hex(C(t))}`).not.toBeNull();
      expect(cut!.climb!.height).toBeCloseTo(6, 0);
      // From the goal's side a walk does get here, by drops (and from the Holtburg portal's side the 7.1 m leap).
      expect(cut!.back, `${hex(C(t))} → ${hex(C(f))}`).not.toBeNull();
      expect(cut!.back!.drops.length).toBeGreaterThanOrEqual(1);
      if (t !== 0x2f4) expect(cut!.back!.leaps.map((w) => w.toFixed(1))).toEqual(['7.1']);
      // The way out of this part is up: the doorways climb to 0x01D203A5 (the other Surface portal's room).
      expect(cut!.top.cell).toBe(C(0x3a5));
      expect(cut!.reach.has(C(0x3a5))).toBe(true);
      expect(cut!.reach.has(C(t))).toBe(false);
    }
  });

  it('1. the way that works is not "cut off": the top Surface room from there, the halls from the way in and from the Holtburg side by the leap', () => {
    for (const f of FROM) expect(routeCutOff(g, C(f), cellStandPoint(g, C(f))!, C(0x3a5), cellStandPoint(g, C(0x3a5))!, { maxDrop: 12 })).toBeNull();
    expect(routeCutOff(g, C(0x2f7), cellStandPoint(g, C(0x2f7))!, C(0x192), cellStandPoint(g, C(0x192))!, { maxDrop: 12 })).toBeNull();
    expect(routeCutOff(g, C(0x11f), cellStandPoint(g, C(0x11f))!, C(0x192), cellStandPoint(g, C(0x192))!, { maxDrop: 12, jumpAcross: 7.5 })).toBeNull();
  });

  describe('walks through the real collision (DungeonHost)', () => {
    let nav: DungeonNav;
    beforeAll(async () => {
      const { dungeonNav } = await import('./_harness/dungeonNav.ts');
      // Arcanist: Jump 112, Run 180.
      nav = await dungeonNav(LB, { statics: true, jumpSkill: 112, runRate: getClientRunRate(0.5, 180) });
    }, 120_000);
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

    for (const [f, t] of [[0x192, 0x1f7], [0x1c0, 0x1f6], [0x1d3, 0x10c], [0x1d4, 0x2f4]] as const) {
      it(`1. walk_to ${hex(C(t))} from ${hex(C(f))}: ends at once saying no way leads there and which way the parts are joined (was minutes, "walls all round")`, async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 162, max: 162 };
        try {
          const r = await host.walkTarget(C(f), cellStandPoint(g, C(f))!, hex(C(t)), { maxMs: 120_000 });
          expect(r.ok).toBe(false);
          // Said short since 2026-10-18 (Bulwark: "long explanations" at Aerbax Laboratory's one-way drops).
          expect(r.message).toMatch(/^stopped [\d.]+ m short: no way on foot to there: this part is joined to it one way only \(from there .*drops? \([\d m,]+\) leads here, and nothing climbs back: the openings overhead are 6\+ m up, past your [\d.]+ m jump\); the doorways from here climb about 4\d m higher \(as far as cell 0x01D203A5\): a way out of this part may be up there\. Else recall/);
          expect(host.traces.some((l) => /walk stall|walk search/.test(l))).toBe(false);
          expect(host.t).toBeLessThan(2000);
        } finally { host.dispose(); }
      }, 120_000);
    }

    it('1. walk_to the Holtburg portal (#701d2027, remembered in 0x01D201F7) from 0x01D20192 names it on the other side, and the Surface portal at the top on yours', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(nav, dats(), LB, { rooms: true });
      host.me.health = { current: 162, max: 162 };
      host.add({ guid: 0x701d2027, name: 'Holtburg', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x1f7), x: 80.13, y: -57.476, z: -5.995 });
      try {
        let r = await host.walkTarget(C(0x192), cellStandPoint(g, C(0x192))!, 0x701d2027, { maxMs: 60_000 });
        expect(r.message).toMatch(/none of the portals you know here is on your side \(Holtburg #701d2027 is on the other\)/);
        host.add({ guid: 0x701d2099, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x3a5), x: 62.3608, y: -11.6727, z: 36 });
        r = await host.walkTarget(C(0x192), cellStandPoint(g, C(0x192))!, 0x701d2027, { maxMs: 60_000 });
        expect(r.message).toMatch(/portals on your side: Surface #701d2099 \(0x01D203A5\)/);
        expect(r.message).not.toMatch(/climb about/);
      } finally { host.dispose(); }
    }, 120_000);

  });

});
