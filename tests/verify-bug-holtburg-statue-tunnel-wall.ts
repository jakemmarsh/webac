/**
 * BUG.holtburg-statue-tunnel-wall — the tunnel under Holtburg's Nullified
 * Statue of a Drudge (landblock 0xA9B4, building 0x01002A1B at (65.21,
 * 156.63, 66); the Pedestal Weak Spot door #0x7A9B4044 opens it). Live
 * 2026-10-10: two agent players were stopped at local (66.8, 156.7, z 66.0)
 * in cell 0xA9B40177, 12 m short of the Mannikin Foundry Portal
 * (#0x7A9B404A, cell 0xA9B40176 at (78.97, 157.0, z 60.8)).
 *
 * The geometry (cell DAT, Environment 0x0D00052A): cell 0x177 is a 2.8 m
 * wide ramp (physics poly 0, normal z 0.81 — walkable) running down from
 * z 66.21 at x 62.3 (its outside portal) to z 60.8 at x 69.7, roofed by the
 * portal into the wedge 0x178 (whose sloped top falls from z 71.9 to 65.35);
 * 0x176 is the room at z 60.8 with the portal. All three are SeenOutside.
 * The town's terrain is z 66 over the whole tunnel. Nothing in the world DB
 * blocks it (the portal is portallowstatuedungeonnorestrict).
 *
 * Our bug: the outdoor ground rule let a BSP floor win only within 0.5 m
 * below the terrain, so past x ≈ 63 the body walked level on the terrain
 * over the ramp until 0x178's sloped top met its head at x 66.83. Retail
 * tests the terrain only for the land cells in the body's cell array, and a
 * body in an EnvCell gets them only while a sphere is within its radius of
 * an outside portal's plane (CEnvCell::find_transit_cells @ 0052c820 →
 * CLandCell::add_all_outside_cells; ACE EnvCell.cs:311-371), so in 0x177 the
 * ramp is the only ground. Fix: outdoorGroundY's cell rule, and the
 * terrain's slope / water / cliff rules skip a body on such a floor.
 *
 * Behavioral: the shipped outdoorGroundY + stepPlayerMovement + the floor
 * follow (traceGroundAlongPath over getBodyFloorHeight, as main.ts runs it)
 * in the real A9B4 collision world with its interiors, plus synthetic cases
 * that run on CI.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { LandWaterType } from '@ac/shared';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { DAT_PATHS } from './_harness/dat.js';

describe('outdoorGroundY — an interior cell\'s floor under the terrain is the ground', () => {
  const src = (floor: number | null, cell: number | undefined): OutdoorGroundSources => ({
    terrainHeight: () => 66,
    floorHeight: () => floor,
    ...(cell === undefined ? {} : { cellAt: () => cell }),
  });

  it('a floor 3 m under the terrain, the body in a cell there: the floor', () => {
    expect(outdoorGroundY(src(63, 0xa9b40177), 0, 0, 66)).toBe(63);
  });

  it('the same floor with the body in no cell (a foundation under the grass): the terrain', () => {
    expect(outdoorGroundY(src(63, 0), 0, 0, 66)).toBe(66);
    expect(outdoorGroundY(src(63, undefined), 0, 0, 66)).toBe(66);
  });

  it('a floor over the terrain, or none, is unchanged', () => {
    expect(outdoorGroundY(src(67, 0xa9b40177), 0, 0, 66)).toBe(67);
    expect(outdoorGroundY(src(65.8, 0), 0, 0, 66)).toBe(66);
    expect(outdoorGroundY(src(null, 0xa9b40177), 0, 0, 66)).toBe(66);
  });

  it('the cell is asked for the body standing on the candidate floor', () => {
    const asked: number[] = [];
    outdoorGroundY({ terrainHeight: () => 66, floorHeight: () => 62.5, cellAt: (_x, _z, f) => { asked.push(f); return 1; } }, 0, 0, 66);
    expect(asked).toEqual([62.5]);
  });
});

describe('stepPlayerMovement — the terrain\'s rules skip a body on a cell floor under it', () => {
  /** Rising, unwalkable, flooded terrain over a level tunnel floor at z 60 (or none). */
  function services(tunnelFloor: boolean, water = LandWaterType.NotWater): MovementServices {
    const collider = { getAdjustedMovement: (_p: unknown, dx: number, dz: number): [number, number] => [dx, dz], playerRadius: 0.48, lastStepUp: 0 };
    return {
      dungeonCollision: null, outdoorCollision: collider,
      terrain: {
        isWalkable: () => false,
        getHeightAt: (x) => 66 + x,
        getTriangleNormalAt: () => ({ x: -0.7071, y: 0.7071, z: 0 }),
      },
      water: { cellWaterTypeAt: () => water },
      creatureObstacles: null, defaultPlayerRadius: 0.48, edgeSlide: true, stepDownHeight: 0.6,
      groundAt: (x) => (tunnelFloor ? 60 : 66 + x),
    };
  }
  const state = (floorY: number) => ({ x: 0, z: 0, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 });

  it('up an unwalkable slope: refused on the terrain, walked in the tunnel under it', () => {
    expect(stepPlayerMovement(state(66), 0.1, 0, 1 / 30, services(false)).x).toBe(0);
    expect(stepPlayerMovement(state(60), 0.1, 0, 1 / 30, services(true)).x).toBeCloseTo(0.1, 9);
  });

  it('into an EntirelyWater land cell: refused on the terrain, walked in the tunnel under it', () => {
    expect(stepPlayerMovement(state(66), 0, 0.1, 1 / 30, services(false, LandWaterType.EntirelyWater)).z).toBe(0);
    expect(stepPlayerMovement(state(60), 0, 0.1, 1 / 30, services(true, LandWaterType.EntirelyWater)).z).toBeCloseTo(0.1, 9);
  });
});

const haveDat = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
const RAMP = 0xa9b40177;
const PORTAL_ROOM = 0xa9b40176;

describe.skipIf(!haveDat)('the Holtburg drudge statue\'s tunnel (A9B4 0x177 ramp → 0x176 portal room)', () => {
  let services: MovementServices;
  let dc: DungeonCollision;
  let OX = 0;
  let OY = 0;
  let seenOutside: (cellId: number) => boolean;

  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.js');
    const { openDat } = await import('./_harness/dat.js');
    const { DatReader, EnvCell } = await import('@ac/dat-parser');
    OX = A9B4.OX;
    OY = A9B4.OY;
    const base = (await buildA9b4World({ interiors: true }))({ slidingNormal: null });
    dc = base.outdoorCollision as DungeonCollision;
    // main.ts's services.groundAt (outdoorGroundSources, with the cell rule).
    services = { ...base, groundAt: (x, z, fromY) => outdoorGroundY(sources(false), x, z, fromY) };
    const cellDb = openDat(DAT_PATHS.cell);
    seenOutside = (id) => (new EnvCell(new DatReader(cellDb.getFileData(id)!)).flags & 1) !== 0;
  }, 120_000);

  /** main.ts's playerGroundSources; `terrainRuleOnly` drops the cell rule (the pre-fix ground). */
  function sources(terrainRuleOnly: boolean, body = false): OutdoorGroundSources {
    return {
      terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
      floorHeight: body
        ? (a, b, y) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight)
        : (a, b, y) => dc.getFloorHeight(a, b, y),
      ...(terrainRuleOnly ? {} : { cellAt: (a: number, b: number, f: number) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight) }),
    };
  }

  /** `n` keyed 1/30 s substeps east (0.1 m each) from local (x0, y0) with the floor at f0, followed as main.ts follows it. */
  function walkEast(x0: number, y0: number, f0: number, n: number, terrainRuleOnly = false) {
    let x = OX + x0;
    let z = OY + y0;
    let floorY = f0;
    let minFloor = f0;
    services.slide!.slidingNormal = null;
    const src = sources(terrainRuleOnly, true);
    const svc = terrainRuleOnly ? { ...services, groundAt: (a: number, b: number, y: number) => outdoorGroundY(sources(true), a, b, y) } : services;
    for (let i = 0; i < n; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, 0.1, 0, 1 / 30, svc);
      const g = traceGroundAlongPath((a, b, y) => outdoorGroundY(src, a, b, y), x, z, r.x, r.z,
        floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
      minFloor = Math.min(minFloor, floorY);
    }
    return { x: x - OX, y: z - OY, floorY, minFloor, cell: dc.findCellContaining(x, z, floorY + dc.lowerSphereHeight) };
  }

  it('the tunnel cells are SeenOutside surface cells under terrain at z 66, the ramp walkable down to the portal room', () => {
    for (const id of [0xa9b40176, 0xa9b40177, 0xa9b40178]) expect(seenOutside(id), id.toString(16)).toBe(true);
    for (const lx of [62, 66.8, 70, 79]) expect(services.terrain.getHeightAt(OX + lx, OY + 156.7)).toBeCloseTo(66, 3);
    expect(dc.findCellContaining(OX + 66.8, OY + 156.7, 63.4)).toBe(RAMP);
    expect(dc.findCellContaining(OX + 78.97, OY + 157, 61.3)).toBe(PORTAL_ROOM);
    // The ramp under the live stop is 3.1 m below the terrain the body stood on.
    expect(dc.getBodyFloorHeight(OX + 66.8, OY + 156.7, 66, 0.6)).toBeCloseTo(62.92, 2);
  });

  it('pre-fix ground (terrain rule only): the body walks level on the terrain over the ramp and stops at x 66.83', () => {
    const s = walkEast(61, 156.7, 66, 120, true);
    expect(s.x).toBeCloseTo(66.83, 1);
    expect(s.minFloor).toBeGreaterThan(65.99);
  });

  it('walking east from the statue\'s doorway follows the ramp down into the portal room', () => {
    const s = walkEast(61, 156.7, 66, 190);
    expect(s.x).toBeGreaterThan(79.5);
    expect(s.cell).toBe(PORTAL_ROOM);
    expect(s.floorY).toBeCloseTo(60.8, 2);
    // Halfway down the ramp the feet are on it, 2.5 m under the terrain.
    const mid = walkEast(61, 156.7, 66, 55);
    expect(mid.cell).toBe(RAMP);
    expect(mid.floorY).toBeLessThan(63.6);
    expect(mid.floorY).toBeGreaterThan(62.9);
  });

  it('from the live stop (feet on the terrain at z 66), the ground is the ramp and the walk goes on', () => {
    expect(outdoorGroundY(sources(false, true), OX + 66.8, OY + 156.7, 66)).toBeCloseTo(62.92, 2);
    const s = walkEast(66.8, 156.7, 66, 130);
    expect(s.cell).toBe(PORTAL_ROOM);
    expect(s.x).toBeGreaterThan(79);
  });
});
