/**
 * GAP.6 — outdoor water: classification, wading depth, impassable deep cells
 * (shared/physics/WaterMap.ts).
 *
 * ACE ground truth:
 *  - LandblockStruct.cs:62 SurfChar — terrain types 0x10–0x14 are water.
 *  - LandblockStruct.cs:145 CalcWater — cell EntirelyWater iff all 4 corner
 *    vertices water; PartiallyWater if any.
 *  - ObjCell.cs:473 get_water_depth — EntirelyWater → 0.89999998; partial →
 *    calc_water_depth (LandblockStruct.cs:655): nearest corner vertex of the
 *    24m cell (+9 when X%24 ≥ 12, +1 when Y%24 ≥ 12) → 0.44999999 water /
 *    0.1 dry.
 *  - LandCell.cs:55-59 / CLandCell::find_env_collisions @ 00532f20 — a land
 *    cell whose LANDBLOCK is EntirelyWater (get_block_water_type: every cell
 *    fully flooded, open sea) is Collided for players; a fully flooded cell
 *    of a river or lake is waded 0.9 m deep. AC1 has no swimming.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  WaterMap, LandWaterType, isWaterTerrainType,
  WATER_DEPTH_ENTIRELY, WATER_DEPTH_PARTIAL_WATER_VERTEX, WATER_DEPTH_PARTIAL_DRY_VERTEX,
} from '../packages/shared/src/physics/WaterMap.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const CELL_DAT = resolve(REPO, 'dat/client_cell_1.dat');

const GRASS = 0x1;   // Grassland
const WATER = 0x11;  // WaterStandingFresh

/** Build a 256-entry corner array with every cell = [sw, se, ne, nw]. */
function uniformBlock(sw: number, se: number, ne: number, nw: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) out.push(sw, se, ne, nw);
  return out;
}

describe('GAP.6 — isWaterTerrainType mirrors ACE SurfChar exactly', () => {
  it('exactly indices 16–20 are water (WaterRunning…WaterDeepSea)', () => {
    // ACE SurfChar table: 32 entries, 1s at 16..20 only.
    for (let t = 0; t < 32; t++) {
      expect(isWaterTerrainType(t), `terrain type ${t}`).toBe(t >= 16 && t <= 20);
    }
  });
});

describe('GAP.6 — WaterMap cell classification (ACE CalcCellWater)', () => {
  it('all 4 corners water → EntirelyWater', () => {
    const m = new WaterMap();
    m.setLandblock(1, 1, uniformBlock(WATER, WATER, WATER, WATER));
    expect(m.cellWaterTypeAt(1 * 192 + 12, 1 * 192 + 12)).toBe(LandWaterType.EntirelyWater);
  });

  it('some corners water → PartiallyWater', () => {
    const m = new WaterMap();
    m.setLandblock(1, 1, uniformBlock(WATER, GRASS, GRASS, GRASS));
    expect(m.cellWaterTypeAt(1 * 192 + 12, 1 * 192 + 12)).toBe(LandWaterType.PartiallyWater);
  });

  it('no water corners → NotWater; unloaded block → null', () => {
    const m = new WaterMap();
    m.setLandblock(1, 1, uniformBlock(GRASS, GRASS, GRASS, GRASS));
    expect(m.cellWaterTypeAt(1 * 192 + 12, 1 * 192 + 12)).toBe(LandWaterType.NotWater);
    expect(m.cellWaterTypeAt(50 * 192, 50 * 192)).toBe(null);
  });
});

describe('GAP.6 — the landblock\'s water type (ACE CalcWater; the gate get_block_water_type reads)', () => {
  it('every cell fully flooded → EntirelyWater (open sea); one dry vertex anywhere → PartiallyWater', () => {
    const m = new WaterMap();
    m.setLandblock(1, 1, uniformBlock(WATER, WATER, WATER, WATER));
    expect(m.blockWaterTypeAt(1 * 192 + 5, 1 * 192 + 180)).toBe(LandWaterType.EntirelyWater);
    const shore = uniformBlock(WATER, WATER, WATER, WATER);
    shore[63 * 4 + 2] = GRASS; // the NE corner of the last cell
    m.setLandblock(2, 1, shore);
    expect(m.cellWaterTypeAt(2 * 192 + 12, 1 * 192 + 12)).toBe(LandWaterType.EntirelyWater);
    expect(m.blockWaterTypeAt(2 * 192 + 12, 1 * 192 + 12)).toBe(LandWaterType.PartiallyWater);
  });

  it('no water → NotWater; unloaded → null; removed → null', () => {
    const m = new WaterMap();
    m.setLandblock(3, 3, uniformBlock(GRASS, GRASS, GRASS, GRASS));
    expect(m.blockWaterTypeAt(3 * 192 + 1, 3 * 192 + 1)).toBe(LandWaterType.NotWater);
    expect(m.blockWaterTypeAt(9 * 192, 9 * 192)).toBe(null);
    m.removeLandblock(3, 3);
    expect(m.blockWaterTypeAt(3 * 192 + 1, 3 * 192 + 1)).toBe(null);
  });
});

describe('GAP.6 — wading depth (ACE get_water_depth + calc_water_depth)', () => {
  it('EntirelyWater → 0.89999998; NotWater/unloaded → 0', () => {
    const m = new WaterMap();
    m.setLandblock(1, 1, uniformBlock(WATER, WATER, WATER, WATER));
    m.setLandblock(2, 1, uniformBlock(GRASS, GRASS, GRASS, GRASS));
    expect(m.waterDepthAt(1 * 192 + 12, 1 * 192 + 12)).toBeCloseTo(WATER_DEPTH_ENTIRELY, 7);
    expect(m.waterDepthAt(2 * 192 + 12, 1 * 192 + 12)).toBe(0);
    expect(m.waterDepthAt(90 * 192, 90 * 192)).toBe(0);
  });

  it('partial cell: nearest-corner quadrant selection matches ACE +9/+1 vertex indexing', () => {
    // Only the SE corner is water. ACE picks base(SW) / +9(SE, east half) /
    // +1(NW, north half) / +10(NE, both) — so ONLY the east-south quadrant
    // (X%24>=12, Y%24<12) resolves the water vertex → 0.45; the other three
    // quadrants resolve dry vertices → 0.1.
    const m = new WaterMap();
    m.setLandblock(0, 0, uniformBlock(GRASS, WATER, GRASS, GRASS));
    const d = (lx: number, lz: number) => m.waterDepthAt(lx, lz);
    expect(d(18, 6)).toBeCloseTo(WATER_DEPTH_PARTIAL_WATER_VERTEX, 7);  // east-south → SE
    expect(d(6, 6)).toBeCloseTo(WATER_DEPTH_PARTIAL_DRY_VERTEX, 7);    // west-south → SW
    expect(d(6, 18)).toBeCloseTo(WATER_DEPTH_PARTIAL_DRY_VERTEX, 7);   // west-north → NW
    expect(d(18, 18)).toBeCloseTo(WATER_DEPTH_PARTIAL_DRY_VERTEX, 7);  // east-north → NE
  });

  it('each corner slot drives exactly its own quadrant', () => {
    const cases: Array<[number[], [number, number]]> = [
      [[WATER, GRASS, GRASS, GRASS], [6, 6]],    // SW → west-south
      [[GRASS, WATER, GRASS, GRASS], [18, 6]],   // SE → east-south
      [[GRASS, GRASS, WATER, GRASS], [18, 18]],  // NE → east-north
      [[GRASS, GRASS, GRASS, WATER], [6, 18]],   // NW → west-north
    ];
    for (const [corners, [lx, lz]] of cases) {
      const m = new WaterMap();
      m.setLandblock(0, 0, uniformBlock(corners[0], corners[1], corners[2], corners[3]));
      expect(m.waterDepthAt(lx, lz), `corners=${corners} probe=(${lx},${lz})`)
        .toBeCloseTo(WATER_DEPTH_PARTIAL_WATER_VERTEX, 7);
      // and the diagonally opposite quadrant must be dry
      expect(m.waterDepthAt(24 - lx, 24 - lz)).toBeCloseTo(WATER_DEPTH_PARTIAL_DRY_VERTEX, 7);
    }
  });
});

describe.skipIf(!existsSync(CELL_DAT))('GAP.6 — DAT integration: the lake northwest of Holtburg (0xA8B6)', () => {
  it('classifies the real lake exactly as the raw terrain scan does (10 fully / 42 partially flooded cells)', async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader');
    const { CellLandblock } = await import('../packages/dat-parser/src/file-types/CellLandblock');
    const { LandblockMesh } = await import('../packages/renderer/src/terrain/LandblockMesh.js');
    const db = openDat(CELL_DAT);

    const classify = (bx: number, by: number) => {
      const data = db.getFileData(((bx << 24) | (by << 16) | 0xffff) >>> 0);
      expect(data).toBeTruthy();
      const lb = CellLandblock.read(new DatReader(data!));
      // Through the REAL production path: mesh corner extraction → WaterMap.
      const mesh = new LandblockMesh({ heights: lb.heights, terrain: lb.terrain });
      const m = new WaterMap();
      m.setLandblock(bx, by, mesh.cellCornerTerrainTypes);
      let full = 0, partial = 0, none = 0;
      for (let col = 0; col < 8; col++) {
        for (let row = 0; row < 8; row++) {
          const t = m.cellWaterTypeAt(bx * 192 + col * 24 + 12, by * 192 + row * 24 + 12);
          if (t === LandWaterType.EntirelyWater) full++;
          else if (t === LandWaterType.PartiallyWater) partial++;
          else none++;
        }
      }
      return { full, partial, none };
    };

    // The lake block — counts independently derived from a raw-terrain scan.
    expect(classify(0xa8, 0xb6)).toEqual({ full: 10, partial: 42, none: 12 });
    // Holtburg's own block is bone dry — discriminating negative.
    expect(classify(0xa9, 0xb4)).toEqual({ full: 0, partial: 0, none: 64 });
  });
});

describe.skipIf(!existsSync(CELL_DAT))('GAP.6 — DAT: the river east of Holtburg is waded, open water stops you', () => {
  const blockType = async (bx: number, by: number): Promise<{ block: LandWaterType | null; flooded: number }> => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader');
    const { CellLandblock } = await import('../packages/dat-parser/src/file-types/CellLandblock');
    const { LandblockMesh } = await import('../packages/renderer/src/terrain/LandblockMesh.js');
    const db = openDat(CELL_DAT);
    const lb = CellLandblock.read(new DatReader(db.getFileData(((bx << 24) | (by << 16) | 0xffff) >>> 0)!));
    const m = new WaterMap();
    m.setLandblock(bx, by, new LandblockMesh({ heights: lb.heights, terrain: lb.terrain }).cellCornerTerrainTypes);
    let flooded = 0;
    for (let col = 0; col < 8; col++) for (let row = 0; row < 8; row++) {
      if (m.cellWaterTypeAt(bx * 192 + col * 24 + 12, by * 192 + row * 24 + 12) === LandWaterType.EntirelyWater) flooded++;
    }
    return { block: m.blockWaterTypeAt(bx * 192 + 96, by * 192 + 96), flooded };
  };

  it('0xACB3 / 0xADB3 / 0xABB4 / 0xACB4 hold fully flooded cells but dry land too: PartiallyWater blocks (2026-10-12: the old per-cell gate walled two players into single 24 m cells there)', async () => {
    for (const [bx, by] of [[0xac, 0xb3], [0xad, 0xb3], [0xab, 0xb4], [0xac, 0xb4]]) {
      const t = await blockType(bx, by);
      expect(t.flooded, `0x${bx.toString(16)}${by.toString(16)} flooded cells`).toBeGreaterThan(10);
      expect(t.block, `0x${bx.toString(16)}${by.toString(16)}`).toBe(LandWaterType.PartiallyWater);
    }
  });

  it('0xB0B0 is all water: an EntirelyWater block, the only water a player cannot wade', async () => {
    expect((await blockType(0xb0, 0xb0)).block).toBe(LandWaterType.EntirelyWater);
  });
});
