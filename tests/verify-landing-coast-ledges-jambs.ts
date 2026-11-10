/**
 * BUG.remote-running-jump-snapback, the sweep — the landing coast
 * (player/LandingCoast.ts) against ledges and doorway jambs, in the real cells.
 *
 * Retail moves a body's velocity in the same transition as its animation
 * offset (CPhysicsObj::UpdatePositionInternal @ 00512c30 → UpdateObjectInternal
 * @ 005156b0 → transition), so the coast meets the world exactly as a walk
 * does:
 *  - at a dungeon ledge an EdgeSlide body (every player: ACE, and the AC1999
 *    server's walkable state 0x400C08, send PhysicsState EdgeSlide) is held by
 *    CTransition::edge_slide / SPHEREPATH::precipice_slide @ 0050cc80, as a
 *    walk is (verify-bug-jump-through-ceiling.ts: "walking off it is refused");
 *  - a body without EdgeSlide coasts over the ledge, loses contact
 *    (losesContact: the walk-off, BUG.ledge-step-off-hangs-in-air's path) and
 *    falls to the floor below instead of hanging at the ledge;
 *  - into a doorway jamb the transition collides and handle_all_collisions
 *    @ 00514780 bounces the velocity off the collision normal (elasticity
 *    0.05): head-on it stops at the jamb, leaning it slides along it and out.
 *
 * Behavioural, over the DAT cells: Mountain Keep's pit ledge (0x01D202A6 →
 * the air cell 0x01D202A7) and the Holtburg bowyer's front doorway (A9B4
 * 0x121 → 0x125), driven through the shipped stepPlayerMovement,
 * interiorGroundY / outdoorGroundY, losesContact and advanceAirborneFrame in
 * main.ts's frame order.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { advanceAirborneFrame, airborneReferenceY, losesContact } from '../packages/renderer/src/world/fallPhysics.ts';
import { floorSearchFromY, interiorGroundY, outdoorGroundY, traceGroundAlongPath } from '../packages/renderer/src/world/outdoorGround.ts';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.ts';
import { landingGroundVelocity, type GroundVelocity } from '../packages/renderer/src/player/LandingCoast.ts';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { DAT_PATHS } from './_harness/dat.ts';
import { dungeonNav, type DungeonNav } from './_harness/dungeonNav.ts';

const DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
const G = -9.8;
const RUN = 6.54; // the retail capture's run (run rate 1.635 × run_anim_speed 4)

interface CoastRun { x: number; y: number; z: number; cell: number; fell: boolean; landed: boolean; minY: number; endVelocity: GroundVelocity | null }

describe.skipIf(!DATS)('the landing coast at Mountain Keep\'s pit ledge (0x01D202A6 → the air cell 0x01D202A7; needs DAT files)', () => {
  const LB = 0x01d20000;
  const BX = 0x01 * 192, BY = 0xd2 * 192;
  const C = (c: number) => (LB | c) >>> 0;
  let nav: DungeonNav;
  let col: DungeonCollision;
  beforeAll(async () => {
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 450 });
    col = nav.col;
  }, 120_000);

  /**
   * main.ts's frame for a grounded body carrying `coast` (a landing's velocity, renderer x / z = AC x / y here) and
   * walking at `walk` m/s: stepPlayerMovement, interiorGroundY, losesContact, then the airborne vertical step.
   */
  function coastFrom(at: { x: number; y: number }, opts: { coast?: GroundVelocity; walk?: { vx: number; vy: number }; edgeSlide: boolean; seconds?: number }): CoastRun {
    const dt = 1 / 60;
    const stepDown = nav.stepDown;
    const sv = {
      dungeonCollision: col, outdoorCollision: col,
      terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true },
      water: { blockWaterTypeAt: () => null }, creatureObstacles: null, defaultPlayerRadius: col.playerRadius,
      edgeSlide: opts.edgeSlide, stepDownHeight: stepDown, slide: { slidingNormal: null },
      dungeonGroundAt: (x: number, z: number, fromY: number) => col.getFloorHeight(x, z, fromY, Infinity),
    } as unknown as MovementServices;
    let cell = col.findCellContaining(BX + at.x, BY + at.y, col.lowerSphereHeight);
    const ground = {
      floorHeight: (x: number, z: number, fromY: number, maxDrop?: number) => col.getBodyFloorHeight(x, z, fromY, stepDown, maxDrop),
      cellAt: (x: number, z: number, footY: number) => col.findCellContaining(x, z, footY + col.lowerSphereHeight, cell),
    };
    let x = BX + at.x, z = BY + at.y;
    let last = 0;
    let prevGrounded: number | null = 0;
    let air = false, base = 0, off = 0, vy = 0, vx = 0, vz = 0, fell = false, landed = false, minY = at.y;
    let gv: GroundVelocity | null = opts.coast ?? null;
    const n = Math.round((opts.seconds ?? 3) / dt);
    for (let f = 0; f < n; f++) {
      const px = x, pz = z;
      const st = stepPlayerMovement(
        { x, z, floorY: airborneReferenceY(air, base, off, last), inDungeon: true, airborne: air, jumpVelocityX: vx, jumpVelocityZ: vz, slideVelocity: null, groundVelocity: air ? null : gv },
        air || !opts.walk ? 0 : opts.walk.vx * dt, air || !opts.walk ? 0 : opts.walk.vy * dt, dt, sv,
      );
      x = st.x; z = st.z;
      if (st.groundVelocity !== undefined) gv = st.groundVelocity;
      const g = interiorGroundY(ground, px, pz, x, z,
        floorSearchFromY(null, airborneReferenceY(air, base, off, last), col.lastStepUp ?? 0), col.transitionSphereRadius, last);
      last = g;
      if (!air && losesContact(prevGrounded, g, stepDown)) {
        // main.ts's walk-off: the frame's motion becomes the fall's, and the coast is over.
        air = true; fell = true; base = prevGrounded as number; off = 0; vy = 0; vx = (x - px) / dt; vz = (z - pz) / dt; gv = null;
      }
      prevGrounded = air ? null : g;
      if (air) {
        const r = advanceAirborneFrame(base, off, vy, [dt], g, G, { riseLimit: (a, b) => col.riseLimit(x, z, a, b), height: col.playerHeight });
        off = r.offsetY; vy = r.velocityY;
        if (r.landed) { air = false; landed = true; off = 0; gv = landingGroundVelocity(vx, vz); vx = 0; vz = 0; prevGrounded = g; }
      }
      minY = Math.min(minY, z - BY);
      const feet = air ? base + off : g;
      const c = col.findCellContaining(x, z, feet + col.lowerSphereHeight, cell);
      if (c) cell = c;
    }
    const feet = air ? base + off : last;
    return { x: x - BX, y: z - BY, z: feet, cell: col.findCellContaining(x, z, feet + col.lowerSphereHeight) >>> 0, fell, landed, minY, endVelocity: gv };
  }

  const START = { x: 90, y: -64.5 };

  it('the spot is on the ledge (0x01D202A6) with the pit south of it', () => {
    expect(col.findCellContaining(BX + START.x, BY + START.y, 0.48) >>> 0).toBe(C(0x2a6));
  });

  it('EdgeSlide: a landing\'s coast south at the run\'s 6.54 m/s is held at the ledge, as a walk is — no fall, its centre over the pit\'s air cell', () => {
    const coast = coastFrom(START, { coast: { x: 0, z: -RUN }, edgeSlide: true });
    const walk = coastFrom(START, { walk: { vx: 0, vy: -RUN }, edgeSlide: true, seconds: 1 });
    for (const r of [coast, walk]) {
      expect(r.fell).toBe(false);
      expect(r.z).toBeCloseTo(0, 3);
      // Re-pinned 2026-11-09 (BUG.edge-slide-check-walkable-overhang). Was: still in 0x01D202A6. Retail's centre
      // stands up to r / 2 (0.24 m) past the ledge (check_walkable @ 0050aff0 at check_walkables @ 0050c3e0's half
      // radius), and the body's cell is the one holding its centre (CObjCell::find_cell_list @ 0052b4e0's check
      // cell): here the pit's air cell 0x01D202A7. (Not checked in the retail client at this spot; the walkway run
      // there reported the cell holding its overhanging centre, 0x01D20293.)
      expect(r.cell).toBe(C(0x2a7));
    }
    // Both stop at the same edge (the coast's transition is the walk's).
    expect(Math.abs(coast.minY - walk.minY)).toBeLessThan(0.15);
    // The ledge stopped the coast: nothing is left carrying it south.
    expect(coast.endVelocity === null || coast.endVelocity.z >= -0.25).toBe(true);
  });

  it('without EdgeSlide: the coast carries the body over the ledge, loses contact and falls to the floor below (it never hangs at the ledge)', () => {
    const r = coastFrom(START, { coast: { x: 0, z: -RUN }, edgeSlide: false, seconds: 4 });
    expect(r.fell).toBe(true);
    expect(r.landed).toBe(true);
    expect(r.z).toBeLessThan(-5.5); // a storey down at least
    const floor = col.getFloorHeight(BX + r.x, BY + r.y, r.z + 0.05, 0.2);
    expect(floor).not.toBeNull();
    expect(r.z).toBeCloseTo(floor!, 1);
    expect(r.cell).not.toBe(0);
  });

  it('a coast too slow to reach the ledge stops short of it (friction), EdgeSlide or not', () => {
    // 1 m/s coasts 1 / ln 20 ≈ 0.33 m: well short of an edge more than that away.
    const edge = coastFrom(START, { walk: { vx: 0, vy: -RUN }, edgeSlide: true, seconds: 1 }).minY;
    const from = { x: START.x, y: edge + 1.0 };
    for (const edgeSlide of [true, false]) {
      const r = coastFrom(from, { coast: { x: 0, z: -1 }, edgeSlide });
      expect(r.fell).toBe(false);
      expect(r.y).toBeGreaterThan(edge + 0.6);
      expect(r.endVelocity).toBeNull();
    }
  });
});

describe.skipIf(!DATS)('the landing coast into the Holtburg bowyer\'s doorway jamb (A9B4 0x121 → 0x125 → outside; needs DAT files)', () => {
  const DOOR = 0x7a9b400c;
  let services: MovementServices;
  let dc: DungeonCollision;
  let OX = 0, OY = 0;
  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.js');
    OX = A9B4.OX; OY = A9B4.OY;
    services = (await buildA9b4World({ interiors: true }))({ slidingNormal: null }, (g) => (g === DOOR ? 0x1000c : undefined));
    dc = services.outdoorCollision as DungeonCollision;
  }, 120_000);

  function groundAt(x: number, z: number, fromY: number): number | null {
    return outdoorGroundY({
      terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
      floorHeight: (a, b, y) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight),
    }, x, z, fromY);
  }

  /** A coast from local (x0, y0) with no input, 1/30 s substeps (AC y north = renderer +z here). */
  function coast(x0: number, y0: number, v: GroundVelocity, seconds = 1.5) {
    let x = OX + x0, z = OY + y0, floorY = 66;
    let gv: GroundVelocity | null = v;
    let maxY = y0;
    services.slide!.slidingNormal = null;
    const velocities: GroundVelocity[] = [];
    for (let i = 0; i < seconds * 30 && gv; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, groundVelocity: gv }, 0, 0, 1 / 30, services);
      const g = traceGroundAlongPath(groundAt, x, z, r.x, r.z, floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x; z = r.z;
      if (g !== null) floorY = g;
      gv = r.groundVelocity ?? null;
      if (gv) velocities.push(gv);
      maxY = Math.max(maxY, z - OY);
    }
    return { x: x - OX, y: z - OY, maxY, velocities, cell: dc.findCellContaining(x, z, floorY + DungeonCollision.LOWER_SPHERE_HEIGHT) };
  }

  it('head-on at x 103.8 (the feet sphere meets the west jamb\'s edge): the coast stops at the jamb and bounces back off it', () => {
    const r = coast(103.8, 140.2, { x: 0, z: 4 });
    expect(r.cell).toBe(0xa9b40121); // still in the room
    expect(r.maxY).toBeLessThan(140.45); // never through the jamb
    // handle_all_collisions: the velocity into the wall turned into 5 % of itself away from it.
    expect(r.velocities.some((v) => v.z < 0 && v.z > -0.25)).toBe(true);
  });

  it('through the opening (x 104.15) the coast carries on into the vestibule, as a walk does', () => {
    const r = coast(104.15, 140.2, { x: 0, z: 4 });
    expect(r.maxY).toBeGreaterThan(140.9);
  });

  it('a degree of lean: the jamb takes the coast\'s push (unlike a walk, which keeps pushing and slides out) — it slides a little along the jamb and stops', () => {
    // A walk is new offset every frame, so it slides along the jamb and out (verify-bowyer-doorway-jamb.ts). The
    // coast is one velocity: the first contact's collision normal (the slide sets it) bounces its into-wall part to
    // 5 % backwards and only the ~0.14 m/s along the jamb is left, which friction stops within centimetres.
    const a = (2 * Math.PI) / 180;
    const r = coast(103.8, 140.2, { x: 4 * Math.sin(a), z: 4 * Math.cos(a) });
    expect(r.maxY).toBeLessThan(140.9);
    expect(r.x).toBeGreaterThan(103.8); // slid east along the jamb
    expect(r.x).toBeLessThan(103.95);
    expect(r.velocities.some((v) => v.z < 0)).toBe(true);
  });
});
