/**
 * BUG.portal-1087-arrival-keys-dead (checked, retail: not a bug) — a probe
 * walked into portal 1087 ("Outside Accursed Halls Portal") on local ACE and
 * W / S did not move the character for ~25 s after the arrival.
 *
 * 1087's destination (ACE weenie_properties_position, type 2) is 0x3761000C
 * [37.31 80.17 40], heading 180° (facing south). Landblock 0x3761's statics
 * (LandblockInfo 0x3761FFFE) put a staircase, Setup 0x020003FB, at (36, 77.5, 40)
 * with an identity frame (its quaternion is w −1): it rises north, x 35.15–36.85,
 * its stringer's underside sloping from (y 78.25, z 40.7) to (y 81.75, z 43.5).
 * The arrival's body (spheres r 0.48 at 0.475 / 1.35) stands 0.46 m east of the
 * stair's side, so walking straight south its head sphere meets the stringer's
 * underside at y ≈ 79.3: retail's CPolygon::pos_hits_sphere hits there too
 * (the edge is 0.469 m from the sphere's centre, under its 0.48 radius, and the
 * move runs into the face), and sliding along a face whose horizontal normal
 * is straight north leaves nothing of a southward move. The other key was S,
 * which the retail KeyMap binds to Stop Moving (X backs up). Live
 * (tools/probe-portal-arrival-stuck.ts, 2026-11-03): X backs up 2.5 m, Z / C
 * strafe, and a 15° turn walks clear, as below.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { DAT_PATHS } from './_harness/dat.js';

const BX = 0x37;
const BY = 0x61;
const OX = BX * 192;
const OY = BY * 192;
/** Portal 1087's destination in landblock 0x3761 (ACE world DB). */
const ARRIVAL = { x: 37.31, y: 80.17, z: 40 };

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('portal 1087\'s arrival beside the 0x3761 staircase', () => {
  let dc: DungeonCollision;
  let services: MovementServices;
  let sources: OutdoorGroundSources;

  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    const base = (await buildLandblockWorld(BX, BY, { interiors: true }))({ slidingNormal: null });
    dc = base.outdoorCollision as DungeonCollision;
    sources = {
      terrainHeight: (a, b) => base.terrain.getHeightAt(a, b),
      floorHeight: (a, b, y, m, f) => dc.getBodyFloorHeight(a, b, y, base.stepDownHeight, m, f),
      cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight, 0),
      landReachable: (a, b, f) => dc.reachesLandCells(a, b, f),
    };
    services = { ...base, groundAt: (x, z, fromY) => outdoorGroundY(sources, x, z, fromY), landReachable: (x, z, f) => dc.reachesLandCells(x, z, f) };
  }, 120_000);

  /** `n` 1/30 s substeps of (dx, dy) m per step from block-local (x0, y0), as main.ts steps the player. */
  function walk(x0: number, y0: number, n: number, dx: number, dy: number) {
    let x = OX + x0;
    let z = OY + y0;
    let floorY = ARRIVAL.z;
    services.slide!.slidingNormal = null;
    for (let i = 0; i < n; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, dx, dy, 1 / 30, services);
      const g = traceGroundAlongPath((a, b, y) => outdoorGroundY(sources, a, b, y), x, z, r.x, r.z,
        floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
    }
    return { x: x - OX, y: z - OY, floorY };
  }

  it('the arrival is open ground at the terrain height (nothing overlaps the body there)', () => {
    expect(services.terrain.getHeightAt(OX + ARRIVAL.x, OY + ARRIVAL.y)).toBeCloseTo(40, 3);
    const s = walk(ARRIVAL.x, ARRIVAL.y, 1, 0, 0);
    expect(s.x).toBeCloseTo(ARRIVAL.x, 6);
    expect(s.y).toBeCloseTo(ARRIVAL.y, 6);
  });

  it('straight ahead (south) the head meets the stair\'s underside at y ≈ 79.3 and holds there', () => {
    const s = walk(ARRIVAL.x, ARRIVAL.y, 90, 0, -0.1);
    expect(s.y).toBeGreaterThan(79.1);
    expect(s.y).toBeLessThan(79.5);
    expect(s.x).toBeCloseTo(ARRIVAL.x, 3);
    expect(s.floorY).toBeCloseTo(40, 3);
  });

  it('from that stop, backing up (north) is free to the wall at y ≈ 81.75', () => {
    const stop = walk(ARRIVAL.x, ARRIVAL.y, 90, 0, -0.1);
    const back = walk(stop.x, stop.y, 60, 0, 0.1);
    expect(back.y).toBeGreaterThan(81.5);
    expect(back.y).toBeLessThan(82.2);
  });

  it('strafing either way is free, and a 15° turn east walks clear of the stair', () => {
    expect(walk(ARRIVAL.x, ARRIVAL.y, 30, 0.1, 0).x).toBeGreaterThan(ARRIVAL.x + 2.5);
    expect(walk(ARRIVAL.x, ARRIVAL.y, 30, -0.1, 0).x).toBeLessThan(ARRIVAL.x - 2.5);
    const a = (15 * Math.PI) / 180;
    const turned = walk(ARRIVAL.x, ARRIVAL.y, 120, 0.1 * Math.sin(a), -0.1 * Math.cos(a));
    expect(turned.y).toBeLessThan(72);
  });
});
