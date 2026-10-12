/**
 * AGENT.play-reports-2026-10-12 — the river east of Holtburg (landblocks 0xABB3–0xADB4), where Claude Arcanist and
 * Claude Bulwark spent most of a session stuck: walks stalled at z 27.55 (the terrain's 28.00 less a 0.45 m wade)
 * in cells 0xACB30034, 0xACB30025, 0xADB30002 …, every search "none after 437 … 1582 points", and ac_map drew
 * perfect 24 m rectangles of '#'. Cause: the client stopped a player at every fully flooded CELL, while retail
 * (CLandCell::find_env_collisions @ 00532f20, ACE LandCell.cs, the 1999 server's LandCell.cpp) stops one only on a
 * cell whose LANDBLOCK is all water (get_block_water_type). A partly flooded cell walled in by flooded ones was a
 * 24 × 24 m cage.
 *
 * Built from the DATs as main.ts builds it (terrain heights through the LandHeightTable, the WaterMap from the
 * terrain mesh's cell corners) and walked with the client's own movement step (stepPlayerMovement), the agent's
 * probe as main.ts's navProbe. DAT-dependent: skipped where the DATs aren't.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { LandWaterType, TerrainCollision, WaterMap } from '../packages/shared/src/index.ts';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.ts';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { planPath, floorPlan, type NavProbe } from '../packages/renderer/src/agent/navPlanner.ts';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const STEP_DOWN = 0.6;

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('the river east of Holtburg is waded (2026-10-12)', () => {
  let terrain: TerrainCollision;
  let water: WaterMap;
  const services = (gate: 'block' | 'cell'): MovementServices => ({
    dungeonCollision: null, outdoorCollision: new DungeonCollision(), terrain,
    // 'cell': the old gate (a fully flooded cell stops you), for the before/after.
    water: { blockWaterTypeAt: (x, z) => (gate === 'block' ? water.blockWaterTypeAt(x, z) : water.cellWaterTypeAt(x, z)) },
    creatureObstacles: null, defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS, edgeSlide: true, stepDownHeight: STEP_DOWN,
    slide: { slidingNormal: null }, groundAt: (x, z) => terrain.getHeightAt(x, z),
  });
  // main.ts navProbe (outdoors: agent global metres = the render world's x / z).
  const probeOf = (sv: MovementServices): NavProbe => (from, to) => {
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.15));
    let x = from.x, z = from.y, floorY = from.z;
    for (let i = 1; i <= n; i++) {
      const tx = from.x + ((to.x - from.x) * i) / n, tz = from.y + ((to.y - from.y) * i) / n;
      const step = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, tx - x, tz - z, 1 / 30, sv);
      const ground = sv.groundAt!(step.x, step.z, floorY + 0.6);
      if (ground === null || floorY - ground > STEP_DOWN + 0.05) break;
      const moved = Math.hypot(step.x - x, step.z - z);
      x = step.x; z = step.z; floorY = ground;
      if (moved < 0.01) break;
    }
    return { x, y: z, z: floorY };
  };

  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock } = await import('@ac/dat-parser');
    const { LandblockMesh } = await import('../packages/renderer/src/terrain/LandblockMesh.js');
    const portalDb = openDat(DAT_PATHS.portal), cellDb = openDat(DAT_PATHS.cell);
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table: number[] = (region as any).landDefs?.landHeightTable ?? (region as any).landHeightTable;
    terrain = new TerrainCollision();
    water = new WaterMap();
    for (let bx = 0xaa; bx <= 0xae; bx++) for (let by = 0xb2; by <= 0xb5; by++) {
      const lb = CellLandblock.read(new DatReader(cellDb.getFileData(((bx << 24) | (by << 16) | 0xffff) >>> 0)!));
      terrain.setLandblock(bx, by, { heights: lb.heights.map((h: number) => table[h]), blockX: bx, blockY: by });
      water.setLandblock(bx, by, new LandblockMesh({ heights: lb.heights, terrain: lb.terrain }).cellCornerTerrainTypes);
    }
  });

  // Arcanist's stall 1 of the Evensong walk: "(33191.9, 34440.1, z 27.55) cell 0xacb30034".
  const STALL = { x: 33191.9, y: 34440.1 };

  it('the stall point is a wade (terrain 28.00, 0.45 m deep) in a partly flooded cell of a block with dry land', () => {
    expect(terrain.getHeightAt(STALL.x, STALL.y)).toBeCloseTo(28, 1);
    expect(water.waterDepthAt(STALL.x, STALL.y)).toBeCloseTo(0.45, 2);
    expect(water.blockWaterTypeAt(STALL.x, STALL.y)).toBe(LandWaterType.PartiallyWater);
  });

  it('with the old per-cell gate no way NE across the water is found; with retail\'s block gate it is', () => {
    const start = { ...STALL, z: terrain.getHeightAt(STALL.x, STALL.y)! };
    // Toward the Stone of Evensong (42.5N 36.6E ≈ (33252, 34668)): 60 m of the way, NE across the water.
    const goal = { x: STALL.x + 40, y: STALL.y + 45 };
    expect(water.cellWaterTypeAt(goal.x, goal.y)).toBe(LandWaterType.EntirelyWater);
    expect(planPath(probeOf(services('cell')), start, goal, { spacing: 1, margin: 35, maxNodes: 6000 }).status).toBe('none');
    expect(planPath(probeOf(services('block')), start, goal, { spacing: 1, margin: 35, maxNodes: 6000 }).status).toBe('found');
  });

  it('ac_map round the stall: the flooded cells were 24 m rectangles of #; now the whole flat river is floor', () => {
    const start = { ...STALL, z: terrain.getHeightAt(STALL.x, STALL.y)! };
    const cell = floorPlan(probeOf(services('cell')), start, [], { radius: 30 });
    const block = floorPlan(probeOf(services('block')), start, [], { radius: 30 });
    // Live, 2026-10-12: "a 48×24 # block NE of 41.7N 36.1E". The rows north of the stall were # east of x+1 m (the
    // cell edge at local x 168), every one of them.
    expect(cell.lines.slice(0, 24).every((row) => /^\.+#+$/.test(row) || /^#+$/.test(row))).toBe(true);
    expect(cell.reached).toBeLessThan(61 * 61 * 0.75);
    expect(block.reached).toBe(61 * 61);
  });
});
