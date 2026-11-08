/**
 * BUG.planner-live-jump-gap — the agent's jump planner (agent/jumpPlan.ts simulateFlight) flew a jump with its own
 * model of the client's physics, and the live client moved on without it:
 *
 * - A landing keeps the jump's velocity and coasts (retail calc_friction, player/LandingCoast.ts, since 0cff3b710):
 *   v / ln 20 ≈ v / 3 m past the touchdown, about 2 m for a 6.5 m/s run. The planner stopped the body where it
 *   touched down, so every running jump came to rest 0.85–2.0 m past its plan (flat ground), and a walk's "landed
 *   off the plan" check (within 1.5 m of the plan) failed for every fast run.
 * - The live frame's ground is the body's (interiorGroundY over getBodyFloorHeight: any floor under its sphere, a
 *   cell-scoped search), the planner's the floor under a point anywhere below: over Mountain Keep's pit it planned
 *   three of the twenty jumps down to −12 where the live body lands on the −6 floor's edge.
 *
 * Now simulateFlight runs the frame loop's own order through the shipped functions (the collided airborne step, the
 * frame's ground — main.ts bodyGroundY, the function the frame loop calls — advanceAirborneFrame with the ceiling,
 * landingGroundVelocity and the coast through stepPlayerMovement's groundVelocity, losesContact), and returns where
 * the body comes to rest. tests/_harness/liveFrames.ts is main.ts's frame order over the real cells; the two agree.
 *
 * Measured over the real cells before the fix (run speeds 3, 4, 5, 6.5 m/s × charge 0.1–1.0, Jump 112): the
 * planned landing against the live body's resting place was 0.48–2.58 m off at Mountain Keep's 7.1 m corner leap
 * (0x01D202A6's south doorway over the pit 0x01D202A7) with 3 of 20 a whole storey off (z −12 planned, −6 live),
 * and 0.85–2.04 m off on flat ground. After: 0.00 m (both, every case).
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { getJumpVelocity } from '@ac/shared';
import { jumpOptions, simulateFlight, touchdownOnFloor, type JumpKit } from '../packages/renderer/src/agent/jumpPlan.ts';
import { coastDistance } from '../packages/renderer/src/player/LandingCoast.ts';
import { DAT_PATHS } from './_harness/dat.ts';
import { dungeonNav, type DungeonNav } from './_harness/dungeonNav.ts';
import { liveFramesOver, type LiveFrameOptions } from './_harness/liveFrames.ts';

const SPEEDS = [3, 4, 5, 6.5];
const POWERS = [0.1, 0.3, 0.5, 0.7, 1];

describe('simulateFlight without a host flight body (point hooks): the landing coasts', () => {
  // Flat ground at 0, no walls.
  const flat: JumpKit = {
    floor: () => 0,
    airStep: (from, dx, dy) => ({ x: from.x + dx, y: from.y + dy }),
    launch: () => ({ forward: 0, up: 0 }),
    chargeSeconds: 1,
  };
  it('a running jump comes to rest about v / ln 20 past its touchdown, and says when', () => {
    for (const v of SPEEDS) {
      const l = simulateFlight(flat, { x: 0, y: 0, z: 0 }, v, 0, getJumpVelocity(0, 112, 0.5))!;
      expect(l.touch.x).toBeCloseTo(v * l.t, 0);
      expect(l.x - l.touch.x).toBeGreaterThan(coastDistance(v) * 0.85); // less the last 0.25 m/s (small_velocity)
      expect(l.x - l.touch.x).toBeLessThan(coastDistance(v) * 1.05);
      expect(l.settle).toBeGreaterThan(l.t + 0.5);
      expect(l.z).toBe(0);
    }
  });
  it('a standing jump (no forward speed) rests where it touched down', () => {
    const l = simulateFlight(flat, { x: 0, y: 0, z: 0 }, 0, 0, 4)!;
    expect(l).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(l.settle).toBe(l.t);
  });
  it('the coast carries the body off a narrow landing: it falls to the floor below and lands again, the hardest landing billed', () => {
    // A 1.2 m wide shelf at 0 (x 2.5–3.7) over a floor at −4: the jump touches down on the shelf and coasts off it.
    const shelf: JumpKit = { ...flat, floor: (x, _y, z) => (x >= 2.5 && x <= 3.7 && z >= -0.05 ? 0 : z >= -4.05 ? -4 : null) };
    const l = simulateFlight(shelf, { x: 0, y: 0, z: 0 }, 5, 0, getJumpVelocity(0, 112, 0.1))!;
    expect(l.touch.z).toBe(0);
    expect(l.touch.x).toBeGreaterThan(2.5);
    expect(l.touch.x).toBeLessThan(3.7);
    expect(l.z).toBe(-4);
    expect(l.x).toBeGreaterThan(3.7);
    expect(l.vz).toBeLessThan(-8); // the fall off the shelf, not the hop's own landing (−2.6)
    // And jumpOptions never offers that shelf as a landing.
    const opts = jumpOptions({ ...shelf, launch: (p) => ({ forward: 5, up: getJumpVelocity(0, 112, p) }) }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0 }, { maxDamage: 100, max: 8 });
    expect(opts.every((o) => o.to.z === -4 || o.to.x <= 2.5)).toBe(true);
  });
});

const DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!DATS)('BUG.planner-live-jump-gap — the planner flies the live frame over the real cells (needs DAT files)', () => {
  const LB = 0x01d20000; // Mountain Keep
  const BX = 0x01 * 192, BY = 0xd2 * 192;
  // The 7.1 m corner leap of the doorway route (cellPath LEAP): from 0x01D202A6's south doorway (the body a radius
  // short of the lip, (90, −64.5)) south-west over the pit 0x01D202A7 to the far lip, its route point (83.94, −71.06).
  const LEAP_FROM = { x: 90, y: -64.5, z: 0 };
  const LEAP_DIR = (() => { const d = { x: 83.94 - 90, y: -71.06 + 64.5 }; const n = Math.hypot(d.x, d.y); return { x: d.x / n, y: d.y / n }; })();
  // Open level ground (the harness's flat floor, far from every cell).
  const FLAT_Z = -100;
  const FLAT_FROM = { x: 100, y: 150, z: FLAT_Z };
  const FLAT_DIR = { x: 1 / Math.hypot(1, 0.2), y: 0.2 / Math.hypot(1, 0.2) };
  let nav: DungeonNav;
  beforeAll(async () => { nav = await dungeonNav(LB, { statics: true, jumpSkill: 112, ground: FLAT_Z }); }, 120_000);

  const plan = (at: { x: number; y: number; z: number }, dir: { x: number; y: number }, v: number, up: number) =>
    simulateFlight(nav.kit, { x: BX + at.x, y: BY + at.y, z: at.z }, dir.x * v, dir.y * v, up);
  const live = (at: { x: number; y: number; z: number }, dir: { x: number; y: number }, v: number, up: number, extra: Partial<LiveFrameOptions> = {}) => {
    let touch: { x: number; y: number; z: number } | null = null;
    let air = false;
    const r = liveFramesOver(nav, LB, at, {
      jump: { vx: dir.x * v, vy: dir.y * v, up }, coast: true, ...(at.z === FLAT_Z ? { ground: FLAT_Z } : {}), seconds: 8, ...extra,
      onFrame: (f) => { if (!f.onGround) air = true; else if (air && !touch) touch = { x: f.x, y: f.y, z: f.z }; },
    });
    return { rest: r, touch: touch as { x: number; y: number; z: number } | null };
  };

  for (const [name, at, dir] of [['Mountain Keep\'s 7.1 m corner leap over the pit 0x01D202A7', LEAP_FROM, LEAP_DIR], ['a flat stretch', FLAT_FROM, FLAT_DIR]] as const) {
    it(`${name}: every running jump rests where the live frame's body does (within 5 cm, same floor), coast and all`, () => {
      let worstBefore = 0;
      for (const v of SPEEDS) for (const p of POWERS) {
        const up = getJumpVelocity(0, 112, p);
        const l = plan(at, dir, v, up);
        const r = live(at, dir, v, up);
        expect(l, `v ${v} power ${p}`).not.toBeNull();
        const tag = `v ${v} power ${p}: planned (${(l!.x - BX).toFixed(2)}, ${(l!.y - BY).toFixed(2)}, z ${l!.z.toFixed(2)}), live (${r.rest.x.toFixed(2)}, ${r.rest.y.toFixed(2)}, z ${r.rest.z.toFixed(2)})`;
        expect(r.rest.landed, tag).toBe(true);
        expect(Math.hypot(l!.x - BX - r.rest.x, l!.y - BY - r.rest.y), tag).toBeLessThan(0.05);
        expect(Math.abs(l!.z - r.rest.z), tag).toBeLessThan(0.05);
        // The touchdown too (where the planner used to stop the body).
        expect(Math.hypot(l!.touch.x - BX - r.touch!.x, l!.touch.y - BY - r.touch!.y), tag).toBeLessThan(0.05);
        worstBefore = Math.max(worstBefore, Math.hypot(l!.touch.x - BX - r.rest.x, l!.touch.y - BY - r.rest.y));
      }
      // What a plan that stopped at the touchdown was off by: the coast (2 m at 6.5 m/s).
      expect(worstBefore).toBeGreaterThan(1.9);
    });
  }

  it('over the pit the planner\'s floor is the live body\'s: a body touching the −6 floor\'s edge lands there, not on −12', () => {
    // v 3, power 0.1: the planner's point floor took it to −12; the body's sphere is on the −6 floor's edge.
    const up = getJumpVelocity(0, 112, 0.1);
    const l = plan(LEAP_FROM, LEAP_DIR, 3, up)!;
    expect(l.z).toBeCloseTo(-6, 1);
    expect(live(LEAP_FROM, LEAP_DIR, 3, up).rest.z).toBeCloseTo(-6, 1);
  });

  it('the leap\'s planned jumps (Jump 300, run 6.5 m/s): each comes to rest where the live body does, touching down clear of the far lip', () => {
    const kit: JumpKit = { ...nav.kit, launch: (p, walk) => ({ forward: walk ? 3.12 : 6.5, up: getJumpVelocity(0, 300, p) }) };
    const from = { x: BX + LEAP_FROM.x, y: BY + LEAP_FROM.y, z: 0 };
    const opts = jumpOptions(kit, from, LEAP_DIR, { maxDamage: 50, max: 6 });
    const across = opts.filter((o) => Math.abs(o.to.z) < 0.5);
    expect(across.length).toBeGreaterThan(0);
    for (const o of opts) {
      const l = kit.launch(o.power, o.walk);
      const r = live(LEAP_FROM, o.dir, l.forward, l.up);
      expect(Math.hypot(o.to.x - BX - r.rest.x, o.to.y - BY - r.rest.y)).toBeLessThan(0.05);
      expect(Math.abs(o.to.z - r.rest.z)).toBeLessThan(0.05);
      expect(o.settle!).toBeGreaterThanOrEqual(o.flight);
      expect(touchdownOnFloor(nav.kit, { touch: o.touch! })).toBe(true);
    }
  });

  it('a touchdown on the far lip\'s edge (the body\'s sphere on it, its middle over the pit) is no planned landing', () => {
    // v 6.5, power 0.7 touches down 0.1 m down the far lip's edge and coasts onto the floor beyond (live and planned).
    const up = getJumpVelocity(0, 112, 0.7);
    const l = plan(LEAP_FROM, LEAP_DIR, 6.5, up)!;
    expect(l.z).toBeCloseTo(0, 1);
    expect(l.touch.z).toBeLessThan(-0.05);
    expect(touchdownOnFloor(nav.kit, l)).toBe(false);
  });

  it('a planned flight leaves the collider\'s step-up and wall normal (the player\'s frame reads them) as they were', () => {
    const col = nav.col as unknown as { lastStepUp: number; collisionNormal: unknown; lastShellCell: number };
    col.lastStepUp = 0.123; col.collisionNormal = { x: 1, z: 0 }; col.lastShellCell = 0x01d20101;
    expect(plan(LEAP_FROM, LEAP_DIR, 6.5, getJumpVelocity(0, 112, 1))).not.toBeNull();
    expect(col.lastStepUp).toBe(0.123);
    expect(col.collisionNormal).toEqual({ x: 1, z: 0 });
    // (lastShellCell, a cell-search hint, is moved by the planner's floor and ceiling queries as by every nav hook.)
    col.lastStepUp = 0; col.collisionNormal = null; col.lastShellCell = 0;
  });

  it('at 30 and 144 frames a second the live body rests within 0.35 m of the planned 60 Hz flight, on the same floor', () => {
    let worst = 0;
    for (const dt of [1 / 30, 1 / 144]) for (const [at, dir] of [[FLAT_FROM, FLAT_DIR], [LEAP_FROM, LEAP_DIR]] as const) for (const v of [4, 6.5]) for (const p of [0.3, 1]) {
      const up = getJumpVelocity(0, 112, p);
      const l = plan(at, dir, v, up)!;
      const r = live(at, dir, v, up, { dt });
      // Only where neither lands on a lip's edge (a frame either side of an edge is a different floor).
      if (Math.abs(l.z - r.rest.z) > 0.5) continue;
      worst = Math.max(worst, Math.hypot(l.x - BX - r.rest.x, l.y - BY - r.rest.y));
    }
    expect(worst).toBeLessThan(0.35);
  });
});
