/**
 * BUG.jump-through-ceiling — a high jump rose through the room's ceiling, flew over its wall and came down outside
 * every cell, where the floor search finds nothing and the body hung at its take-off height (z 0 over open air).
 *
 * Live evidence: Mountain Keep (landblock 0x01D2), end-of-retail local ACE, 2026-10-17 02:25–02:39Z, Claude Bulwark
 * (soldier.log): a drop planned from the corridor 0x01D202A2 at (86.6, −46.1, z 0) facing west "landed off the plan at
 * (75.8, −46.2, z 0.0)" — 10 m west of the corridor's west wall, in no cell — and every walk from there "landed" at
 * z 0 again: 9 of the session's 16 off-plan landings. The corridor is 3 m tall; the character's jump (Jump 400+,
 * about 4.9 m up) carried the head sphere through the ceiling because the airborne step moved the body spheres only
 * sideways at the feet height (OutdoorMovement airborne branch) and the only overhead check, headroomClamp, looks for a
 * storey's FLOOR above the head, which a plain ceiling is not. Above z 3 the corridor's walls end, so the sideways
 * step went over them. Retail sweeps every body sphere along the whole offset, vertical included
 * (CPhysicsObj::UpdateObjectInternal @ 005156b0 → CTransition::find_valid_position; ACE Physics/Animation/
 * Transition.cs FindTransitionalPosition), so the head hits the ceiling and the jump stops rising
 * (handle_all_collisions).
 *
 * Why offline differed: the agent's harness (tests/_harness/dungeonNav.ts) and the planner find the floor under a
 * point with getFloorHeight(…, Infinity) — any floor anywhere below — so the same flight "landed" on the closed room
 * 0x01D201F7 / the hall under 0x01D20293 at −6. The live frame's ground is interiorGroundY: a floor within 5 m, else
 * (only inside a registered cell) the nearest below, else the floor the body stood on (no geometry yet / a doorway
 * seam) — so outside every cell the body kept z 0.
 *
 * The live-frame driver below runs the shipped pieces in main.ts's frame order: stepPlayerMovement (the collided
 * airborne step), interiorGroundY (getBodyFloorHeight + findCellContaining, as main.ts passes them), losesContact (the
 * walk-off), advanceAirborneFrame (the airborne vertical step main.ts calls).
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { getJumpVelocity, sphereIntersectsAnyPoly, type CollisionBSPNode } from '@ac/shared';
import { advanceAirborneFrame, airborneReferenceY, ceilingStop, losesContact } from '../packages/renderer/src/world/fallPhysics.ts';
import { floorSearchFromY, interiorGroundY } from '../packages/renderer/src/world/outdoorGround.ts';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.ts';
import { simulateFlight } from '../packages/renderer/src/agent/jumpPlan.ts';
import type { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { DAT_PATHS } from './_harness/dat.ts';
import { dungeonNav, type DungeonNav } from './_harness/dungeonNav.ts';

const G = -9.8; // main.ts GRAVITY (ACE PhysicsGlobals.Gravity)

describe('BUG.jump-through-ceiling — advanceAirborneFrame (the frame loop\'s airborne vertical step)', () => {
  const steps = [1 / 60];
  it('a rise that meets a ceiling stops under it with no upward speed', () => {
    const f = advanceAirborneFrame(0, 1.14, 3, steps, 0, G, { riseLimit: (from, to) => (to > 1.15 ? Math.max(from, 1.15) : null), height: 1.835 });
    expect(f.ceilingHit).toBe(true);
    expect(f.offsetY).toBeCloseTo(1.15, 6);
    expect(f.velocityY).toBe(0);
    expect(f.landed).toBe(false);
  });

  it('open air above: the arc is advanceAirborne\'s, untouched', () => {
    const f = advanceAirborneFrame(0, 1.1, 3, steps, 0, G, { riseLimit: () => null, height: 1.835 });
    expect(f.ceilingHit).toBe(false);
    expect(f.velocityY).toBeCloseTo(3 + G / 60, 6);
    expect(f.offsetY).toBeGreaterThan(1.1);
  });

  it('a falling body is never asked about ceilings', () => {
    let asked = 0;
    const f = advanceAirborneFrame(0, 2, -1, steps, 0, G, { riseLimit: () => { asked++; return 0; }, height: 1.835 });
    expect(asked).toBe(0);
    expect(f.ceilingHit).toBe(false);
  });

  it('the floor of a storey above still stops the rise (headroomClamp), as before', () => {
    const f = advanceAirborneFrame(0, 2, 3, steps, 0, G, { floorAtHead: () => 3.5, height: 1.835 });
    expect(f.ceilingHit).toBe(true);
    expect(f.offsetY).toBeCloseTo(3.5 - 1.835, 6);
    expect(f.velocityY).toBe(0);
  });

  it('ceilingStop: only a rise asks', () => {
    expect(ceilingStop(1, 1, () => 0)).toBeNull();
    expect(ceilingStop(1, 0.5, () => 0)).toBeNull();
    expect(ceilingStop(1, 2, () => 1.4)).toBe(1.4);
    expect(ceilingStop(1, 2, null)).toBeNull();
  });
});

describe('BUG.jump-through-ceiling — sphereIntersectsAnyPoly\'s graze tolerance', () => {
  // One face: a wall whose normal is a hair off horizontal (as a rotated cell's frame rounds it), at x = 1.
  const wall = (nz: number): CollisionBSPNode => {
    const n = { x: -Math.sqrt(1 - nz * nz), y: 0, z: nz };
    return {
      type: 'LEAF',
      polygons: [{
        vertices: [{ x: 1, y: -5, z: -5 }, { x: 1, y: 5, z: -5 }, { x: 1, y: 5, z: 5 }, { x: 1, y: -5, z: 5 }],
        plane: { normal: n, distance: -n.x * 1 },
      }],
    } as unknown as CollisionBSPNode;
  };
  const sphere = { center: { x: 0.55, y: 0, z: 0 }, radius: 0.48 };
  it('default 0: any approach counts (pos_hits_sphere, unchanged)', () => {
    expect(sphereIntersectsAnyPoly(wall(-1e-9), sphere, { x: 0, y: 0, z: 0.05 })).not.toBeNull();
  });
  it('with approachEps a rise grazing the wall is no hit', () => {
    expect(sphereIntersectsAnyPoly(wall(-1e-9), sphere, { x: 0, y: 0, z: 0.05 }, 0.005)).toBeNull();
  });
});

const DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

interface Run { x: number; y: number; z: number; cell: number; maxX: number; minX: number; peak: number; frames: number; landed: boolean }

/**
 * main.ts's frame loop for the player's body over a landblock's collision (landblock-local metres in and out, AC
 * axes: y north): standing at `at`, either jumping (`jump`: launch velocity, m/s) or walking (`walk`: m/s) until it
 * has landed and stood a moment, or `seconds` pass. `ceilings: false` runs it as the client did before the fix. The
 * movement services keep one sliding normal across frames, as main.ts's movementServices.slide does.
 */
function liveFramesOver(nav: DungeonNav, landblock: number, at: { x: number; y: number; z: number }, opts: { jump?: { vx: number; vy: number; up: number }; walk?: { vx: number; vy: number }; seconds?: number; ceilings?: boolean }): Run {
  const col = nav.col;
  const BX = ((landblock >>> 24) & 0xff) * 192, BY = ((landblock >>> 16) & 0xff) * 192;
  const dt = 1 / 60;
  const stepDown = nav.stepDown;
  const sv = {
    dungeonCollision: col, outdoorCollision: col,
    terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true },
    water: { blockWaterTypeAt: () => null }, creatureObstacles: null, defaultPlayerRadius: col.playerRadius,
    edgeSlide: true, stepDownHeight: stepDown, slide: { slidingNormal: null },
    dungeonGroundAt: (x: number, z: number, fromY: number) => col.getFloorHeight(x, z, fromY, Infinity),
  } as unknown as MovementServices;
  let cell = col.findCellContaining(BX + at.x, BY + at.y, at.z + col.lowerSphereHeight);
  const ground = {
    floorHeight: (x: number, z: number, fromY: number, maxDrop?: number) => col.getBodyFloorHeight(x, z, fromY, stepDown, maxDrop),
    cellAt: (x: number, z: number, footY: number) => col.findCellContaining(x, z, footY + col.lowerSphereHeight, cell),
  };
  let x = BX + at.x, z = BY + at.y;
  let lastGround = at.z;
  let prevGrounded: number | null = at.z;
  let airborne = false, baseY = at.z, offY = 0, vy = 0, vx = 0, vz = 0;
  if (opts.jump) { airborne = true; baseY = at.z; vy = opts.jump.up; vx = opts.jump.vx; vz = opts.jump.vy; prevGrounded = null; }
  let maxX = -Infinity, minX = Infinity, peak = at.z, landedAt = -1, landed = false;
  const total = Math.round((opts.seconds ?? 6) / dt);
  let f = 0;
  for (; f < total; f++) {
    const px = x, pz = z;
    const step = stepPlayerMovement(
      { x, z, floorY: airborneReferenceY(airborne, baseY, offY, lastGround), inDungeon: true, airborne, jumpVelocityX: vx, jumpVelocityZ: vz, slideVelocity: null },
      airborne || !opts.walk ? 0 : opts.walk.vx * dt, airborne || !opts.walk ? 0 : opts.walk.vy * dt, dt, sv,
    );
    x = step.x; z = step.z;
    const groundY = interiorGroundY(ground, px, pz, x, z,
      floorSearchFromY(null, airborneReferenceY(airborne, baseY, offY, lastGround), col.lastStepUp ?? 0), col.transitionSphereRadius, lastGround);
    lastGround = groundY;
    if (!airborne && losesContact(prevGrounded, groundY, stepDown)) {
      airborne = true; baseY = prevGrounded as number; offY = 0; vy = 0; vx = (x - px) / dt; vz = (z - pz) / dt;
    }
    prevGrounded = airborne ? null : groundY;
    if (airborne) {
      const air = advanceAirborneFrame(baseY, offY, vy, [dt], groundY, G, {
        riseLimit: opts.ceilings === false ? null : (from, to) => col.riseLimit(x, z, from, to),
        floorAtHead: (headY) => col.getFloorHeight(x, z, headY, Infinity),
        height: col.playerHeight,
      });
      offY = air.offsetY; vy = air.velocityY;
      if (air.landed) { airborne = false; offY = 0; vx = 0; vz = 0; landed = true; landedAt = f; prevGrounded = groundY; }
    }
    const feet = airborne ? baseY + offY : groundY;
    peak = Math.max(peak, feet);
    maxX = Math.max(maxX, x - BX); minX = Math.min(minX, x - BX);
    const c = col.findCellContaining(x, z, feet + col.lowerSphereHeight, cell);
    if (c) cell = c;
    if (landed && !airborne && f - landedAt > 30) break;
  }
  const feet = airborne ? baseY + offY : lastGround;
  return { x: x - BX, y: z - BY, z: feet, cell: col.findCellContaining(x, z, feet + col.lowerSphereHeight) >>> 0, maxX, minX, peak, frames: f, landed };
}

describe.skipIf(!DATS)('BUG.jump-through-ceiling — Mountain Keep (0x01D2), the live frame over the real cells (needs DAT files)', () => {
  const LB = 0x01d20000;
  const BX = 0x01 * 192, BY = 0xd2 * 192;
  const C = (c: number) => (LB | c) >>> 0;
  let nav: DungeonNav;
  let col: DungeonCollision;

  beforeAll(async () => {
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 450 });
    col = nav.col;
  }, 120_000);
  const liveFrames = (at: Parameters<typeof liveFramesOver>[2], opts: Parameters<typeof liveFramesOver>[3]) => liveFramesOver(nav, LB, at, opts);

  // The 02:25:02Z drop: from (86.6, −46.1, z 0) in the 3 m corridor 0x01D202A2, facing west, running, power 0.85.
  const TAKE_OFF = { x: 86.6, y: -46.1, z: 0 };
  // A heading a degree off due west, as a live turn lands it (an exactly axial push straight into the wall keeps the
  // sliding normal from the first contact for the whole flight: OutdoorMovement.sweepTransition's adjust_offset).
  const HEADING = (269 * Math.PI) / 180;
  const westJump = () => ({ vx: 6 * Math.sin(HEADING), vy: 6 * Math.cos(HEADING), up: getJumpVelocity(0, 450, 0.85) });

  it('the corridor really is 3 m tall with nothing over it, and no cell west of its wall at z 0 (the void the body hung in)', () => {
    expect(col.findCellContaining(BX + TAKE_OFF.x, BY + TAKE_OFF.y, 0.48) >>> 0).toBe(C(0x2a2));
    expect(col.findCellContaining(BX + TAKE_OFF.x, BY + TAKE_OFF.y, 3.5)).toBe(0);
    expect(col.findCellContaining(BX + 75.8, BY - 46.2, 0.48)).toBe(0);
    // The head sphere (1.35 + 0.48 over the feet) meets the 3 m ceiling with the feet at 1.15.
    expect(col.riseLimit(BX + TAKE_OFF.x, BY + TAKE_OFF.y, 0, 5)).toBeCloseTo(1.15, 1);
    // A wall beside the body is no ceiling: pressed against the corridor's west wall, the rise is still 1.15.
    expect(col.riseLimit(BX + 86.07, BY + TAKE_OFF.y, 0, 5)).toBeCloseTo(1.15, 1);
    // Under the corridor's up portal (to 0x01D202A3) the rise goes on into the room above.
    expect(col.riseLimit(BX + 88, BY - 50, 0, 5)).toBeGreaterThan(3);
  });

  it('before the fix (no ceiling): the jump leaves through the ceiling and the body hangs at its take-off height outside every cell, as live', () => {
    const r = liveFrames(TAKE_OFF, { jump: westJump(), ceilings: false });
    expect(r.peak).toBeGreaterThan(4); // the head 3 m over the corridor's ceiling
    expect(r.minX).toBeLessThan(84); // over the west wall
    expect(r.landed).toBe(true);
    expect(r.z).toBeCloseTo(0, 3); // "landed off the plan at (…, z 0.0)"
    expect(r.cell).toBe(0); // in no cell: over open air
  });

  it('with the ceiling: the head stops under it, the wall holds, and the body lands back on the corridor floor', () => {
    const r = liveFrames(TAKE_OFF, { jump: westJump() });
    expect(r.peak).toBeLessThan(1.2);
    expect(r.minX).toBeGreaterThan(85.4); // never past the corridor's west wall
    expect(r.landed).toBe(true);
    expect(r.z).toBeCloseTo(0, 2);
    expect(r.cell).toBe(C(0x2a2));
  });

  it('a gentle walking jump off the pit\'s ledge (0x01D202A6 → the air cell 0x01D202A7) falls to the floor below, not hanging at the ledge', () => {
    // (Walking off it is refused: an EdgeSlide body is held at a dungeon ledge, CTransition::edge_slide; it jumps off.)
    expect(col.findCellContaining(BX + 90, BY - 64.5, 0.48) >>> 0).toBe(C(0x2a6));
    const r = liveFrames({ x: 90, y: -64.5, z: 0 }, { jump: { vx: 0.05, vy: -3.12, up: getJumpVelocity(0, 450, 0.15) }, seconds: 5 });
    expect(r.landed).toBe(true);
    expect(r.z).toBeLessThan(-5.5); // down at least a storey
    const floor = col.getFloorHeight(BX + r.x, BY + r.y, r.z + 0.05, 0.2);
    expect(floor).not.toBeNull();
    expect(r.z).toBeCloseTo(floor!, 1); // standing on a real floor
    expect(r.cell).not.toBe(0);
  });

  it('a high jump off that ledge into the pit falls to the floor below too (the ceiling check never holds a falling body)', () => {
    const r = liveFrames({ x: 90, y: -62, z: 0 }, { jump: { vx: 0.1, vy: -8, up: getJumpVelocity(0, 450, 0.85) }, seconds: 5 });
    expect(r.landed).toBe(true);
    expect(r.z).toBeLessThan(-5.5);
    expect(r.cell).not.toBe(0);
  });

  /**
   * BUG.airborne-head-on-slide-sticks — the same jump exactly due west, the corridor wall's normal straight against it:
   * the first airborne step met the wall and left its normal as the sliding normal; every later step pushed straight
   * into it, adjust_offset projected the step to nothing and sweepTransition ended before inserting it, so the normal
   * was never tested again and outlived the wall's top (the body stayed at the wall for the whole flight). Retail's
   * airborne offset is 3-D (CTransition::adjust_offset @ 0050a370 removes only the part into the sliding normal), the
   * step is still inserted with SlidingNormalValid cleared (ACE Transition.cs FindTransitionalPosition), and a step
   * that hits nothing leaves no sliding normal. Shown with the ceiling left out, so the wall's top is reachable: the
   * AC1999 balcony's jumps due north at its fence (claude-ac1999-retail.log 2026-10-16 01:39–01:41Z, 26 "landed off
   * the plan" at their own take-off) were this shape; dungeonNav's harness makes a fresh sliding normal every step,
   * so the planner never saw it.
   */
  it('a jump straight at a wall goes on once above the wall\'s top (the sliding normal does not outlive the wall)', () => {
    const r = liveFrames(TAKE_OFF, { jump: { vx: -6, vy: 0, up: getJumpVelocity(0, 450, 0.85) }, ceilings: false });
    expect(r.minX).toBeLessThan(84); // over the wall once above it, as a degree off due west does
  });

  it('the planner flies the same jump with the ceiling: it lands back in the corridor, not on the −6 floor 14 m west', () => {
    const l = westJump();
    const from = { x: BX + TAKE_OFF.x, y: BY + TAKE_OFF.y, z: 0 };
    const withCeiling = simulateFlight(nav.kit, from, l.vx, l.vy, l.up)!;
    expect(withCeiling.x - BX).toBeGreaterThan(85.4);
    expect(withCeiling.z).toBeCloseTo(0, 2);
    // What it planned before (no ceiling in the kit): through the ceiling, over the wall, down to −6.
    const { ceiling: _drop, ...noCeiling } = nav.kit;
    const before = simulateFlight(noCeiling, from, l.vx, l.vy, l.up)!;
    expect(before.x - BX).toBeLessThan(80);
    expect(before.z).toBeLessThan(-5.5);
  });
});

