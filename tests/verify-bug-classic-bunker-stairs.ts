/**
 * BUG.bunker-sealed-at-ground, Dark Majesty era — the classic town "bunkers".
 * Classic Dereth's Holtburg and Yaraq have small portal huts (building
 * GfxObj 0x010011C0, Environment 0x0D0003F4) that end of retail removed: a
 * hut at ground level, a stairwell, and a room about 6 m under the landscape
 * holding a town portal (Portal to Rithwic, Shoushi, Cragstone, …). The
 * 2026-10-18 Reddit report ("none of the 'bunker' portals are appearing (at
 * least in yaraq or holtburg) … once you go down into a bunker, you can't get
 * back out, it seals you in at ground level … it forces you into 1st
 * person") came from a Seedsow (classic-dereth-1-0) session.
 *
 * This bunker: landblock 0xA9B4, building at (108, 84, z 80). Cells (all
 * SeenOutside): 0x189 the doorway (outside portal, y 87–88), 0x188 the hut
 * (z 80), 0x186 the top landing, 0x187 the stairwell under the hut floor,
 * 0x185 the portal room (floor z 73.7, y 61–79). The terrain is z 80–85
 * over the whole stairwell and room.
 *
 * The walks are the shipped stepPlayerMovement + the floor follow as main.ts
 * runs them, in the block's real collision world on the classic DATs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';

const CLASSIC = {
  portal: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat'),
  cell: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat'),
};
const haveDat = existsSync(CLASSIC.portal) && existsSync(CLASSIC.cell);
const ROOM = 0xa9b40185;
const STAIRS = 0xa9b40187;
const HUT = 0xa9b40188;

describe.skipIf(!haveDat)('the classic Holtburg portal bunker at (108, 84) (A9B4 0x185–0x189)', () => {
  let services: MovementServices;
  let dc: DungeonCollision;
  const OX = 0xa9 * 192;
  const OY = 0xb4 * 192;

  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
    const base = (await buildLandblockWorld(0xa9, 0xb4, { interiors: true, dats: CLASSIC }))({ slidingNormal: null });
    dc = base.outdoorCollision as DungeonCollision;
    services = { ...base, groundAt: (x, z, fromY) => outdoorGroundY(sources(false), x, z, fromY) };
  }, 120_000);

  /** main.ts's playerGroundSources (`body`: the body's floor search, as the floor follow runs it). */
  function sources(body: boolean): OutdoorGroundSources {
    return {
      terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
      floorHeight: body
        ? (a, b, y) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight)
        : (a, b, y) => dc.getFloorHeight(a, b, y),
      cellAt: (a: number, b: number, f: number) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight),
    };
  }

  /** `n` keyed 1/30 s substeps of (dx, dy) m from local (x0, y0) with the floor at f0, followed as main.ts follows it. */
  function walk(x0: number, y0: number, f0: number, n: number, dx: number, dy: number) {
    let x = OX + x0;
    let z = OY + y0;
    let floorY = f0;
    let minFloor = f0;
    services.slide!.slidingNormal = null;
    const src = sources(true);
    for (let i = 0; i < n; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, dx, dy, 1 / 30, services);
      const g = traceGroundAlongPath((a, b, y) => outdoorGroundY(src, a, b, y), x, z, r.x, r.z,
        floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
      minFloor = Math.min(minFloor, floorY);
    }
    return { x: x - OX, y: z - OY, floorY, minFloor, cell: dc.findCellContaining(x, z, floorY + dc.lowerSphereHeight) };
  }

  it('the room and stairwell lie under the terrain, the hut on it', () => {
    for (const ly of [64, 72, 78, 82]) expect(services.terrain.getHeightAt(OX + 108, OY + ly)).toBeGreaterThan(79.5);
    expect(dc.findCellContaining(OX + 108, OY + 72, 74.2)).toBe(ROOM);
    expect(dc.findCellContaining(OX + 108, OY + 83, 80.5)).toBe(HUT);
  });

  it('walking south from the hut goes down the stairs into the portal room', () => {
    const s = walk(108, 86, 80, 130, 0, -0.1);
    expect(s.cell).toBe(ROOM);
    expect(s.floorY).toBeCloseTo(73.7, 1);
    expect(s.y).toBeLessThan(74);
    // Partway down, the feet are on the stairs under the hut floor.
    const mid = walk(108, 86, 80, 45, 0, -0.1);
    expect(mid.cell).toBe(STAIRS);
    expect(mid.floorY).toBeLessThan(79);
  });

  it('walking north from the portal room climbs the stairs and leaves by the hut door', () => {
    const s = walk(108, 72, 73.7, 220, 0, 0.1);
    expect(s.y).toBeGreaterThan(88);
    expect(s.floorY).toBeGreaterThan(79.5);
  });
});
