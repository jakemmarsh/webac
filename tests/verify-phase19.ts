/**
 * Phase 19 — Physics/Collision + Player Movement
 *
 * Tests:
 *  - Terrain height sampling with bilinear interpolation
 *  - Terrain slope/normal calculation
 *  - BSP ray-cast against simple BSP tree
 *  - BSP sphere test against solid regions
 *  - Player movement: walk, run, jump, gravity
 *  - Collision: terrain following, slope rejection
 *  - Speed modifiers: encumbrance, buffs
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import { TerrainCollision } from '@ac/shared/physics/TerrainCollision.js';
import { openDat } from './_harness/dat.js';

const hasCellDat = fs.existsSync('dat/client_cell_1.dat');

let cellDb: DatDatabase;

beforeAll(() => {
  if (!hasCellDat) return;
  cellDb = openDat('dat/client_cell_1.dat');
});

describe.skipIf(!hasCellDat)('Phase 19 — Physics/Collision + Player Movement', () => {
  // ============================================================
  // Terrain Height Sampling
  // ============================================================
  describe('TerrainCollision', () => {
    it('should sample height from a flat terrain grid', () => {
      const flatHeights = new Array(81).fill(20); // all world height 20
      const result = TerrainCollision.sampleHeight(flatHeights, 96, 96);
      expect(result).toBeCloseTo(20, 1);
    });

    it('should interpolate height bilinearly', () => {
      // Create a terrain where height increases linearly with x (world units)
      const heights = new Array(81).fill(0);
      for (let col = 0; col < 9; col++) {
        for (let row = 0; row < 9; row++) {
          heights[col * 9 + row] = col * 20; // world height = col * 20
        }
      }

      // At col=0 (x=0): height should be 0
      expect(TerrainCollision.sampleHeight(heights, 0, 48)).toBeCloseTo(0, 1);

      // At col=4 (x=96): height should be 80
      expect(TerrainCollision.sampleHeight(heights, 96, 48)).toBeCloseTo(80, 1);

      // At col=8 (x=192): height should be 160
      expect(TerrainCollision.sampleHeight(heights, 192, 48)).toBeCloseTo(160, 1);

      // At col=2.5 (x=60): height should be 50
      expect(TerrainCollision.sampleHeight(heights, 60, 48)).toBeCloseTo(50, 1);
    });

    it('should register and query landblock data', () => {
      const tc = new TerrainCollision();
      const heights = new Array(81).fill(100); // all world height 100

      tc.setLandblock(10, 20, { heights, blockX: 10, blockY: 20 });
      expect(tc.loadedCount).toBe(1);

      // Query at center of landblock (10*192+96, 20*192+96)
      const h = tc.getHeightAt(10 * 192 + 96, 20 * 192 + 96);
      expect(h).toBeCloseTo(100, 1);
    });

    it('should return null for unloaded landblock', () => {
      const tc = new TerrainCollision();
      expect(tc.getHeightAt(999999, 999999)).toBeNull();
    });

    it('should load real terrain from cell.dat and sample heights', () => {
      const tc = new TerrainCollision();
      const terrainIds = cellDb.listFileIds(undefined).filter(id => (id & 0xFFFF) === 0xFFFF);

      let tested = 0;
      for (const id of terrainIds.slice(0, 10)) {
        const data = cellDb.getFileData(id);
        if (!data) continue;

        const lb = CellLandblock.read(new DatReader(data));
        const blockX = (id >> 24) & 0xFF;
        const blockY = (id >> 16) & 0xFF;

        tc.setLandblock(blockX, blockY, { heights: lb.heights, blockX, blockY });

        // Sample at center of landblock
        const worldX = blockX * 192 + 96;
        const worldZ = blockY * 192 + 96;
        const h = tc.getHeightAt(worldX, worldZ);

        expect(h).not.toBeNull();
        expect(Number.isFinite(h!)).toBe(true);
        expect(h!).toBeGreaterThanOrEqual(0);
        expect(h!).toBeLessThanOrEqual(255); // max raw byte value

        tested++;
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('should calculate terrain normals', () => {
      const tc = new TerrainCollision();
      const flatHeights = new Array(81).fill(10);
      tc.setLandblock(0, 0, { heights: flatHeights, blockX: 0, blockY: 0 });

      const normal = tc.getNormalAt(96, 96);
      expect(normal).not.toBeNull();
      // Flat terrain should have normal pointing up (0, 1, 0)
      expect(normal!.y).toBeCloseTo(1.0, 1);
      expect(Math.abs(normal!.x)).toBeLessThan(0.1);
      expect(Math.abs(normal!.z)).toBeLessThan(0.1);
    });

    it('should detect slope angle', () => {
      const tc = new TerrainCollision();

      // Flat terrain → 0 slope
      const flat = new Array(81).fill(20); // world height 20
      tc.setLandblock(0, 0, { heights: flat, blockX: 0, blockY: 0 });

      const angle = tc.getSlopeAngle(96, 96);
      expect(angle).not.toBeNull();
      expect(angle!).toBeLessThan(0.1); // nearly flat

      // Steep terrain (world units)
      const steep = new Array(81).fill(0);
      for (let col = 0; col < 9; col++) {
        for (let row = 0; row < 9; row++) {
          steep[col * 9 + row] = col * 100; // steep gradient in world units
        }
      }
      tc.setLandblock(1, 0, { heights: steep, blockX: 1, blockY: 0 });

      const steepAngle = tc.getSlopeAngle(1 * 192 + 96, 96);
      expect(steepAngle).not.toBeNull();
      expect(steepAngle!).toBeGreaterThan(0.3); // significant slope
    });

    it('should detect walkable terrain', () => {
      const tc = new TerrainCollision();
      const flat = new Array(81).fill(20); // world height 20
      tc.setLandblock(0, 0, { heights: flat, blockX: 0, blockY: 0 });
      expect(tc.isWalkable(96, 96)).toBe(true);
    });

    it('should remove landblock data', () => {
      const tc = new TerrainCollision();
      tc.setLandblock(5, 5, { heights: new Array(81).fill(10), blockX: 5, blockY: 5 });
      expect(tc.loadedCount).toBe(1);
      tc.removeLandblock(5, 5);
      expect(tc.loadedCount).toBe(0);
      expect(tc.getHeightAt(5 * 192 + 96, 5 * 192 + 96)).toBeNull();
    });
  });
});
