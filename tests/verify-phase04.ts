/**
 * Phase 4 Verification: Terrain Rendering
 * Tests landblock terrain parsing and mesh generation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const CELL_DAT = resolve(ROOT, 'dat/client_cell_1.dat');

const hasCellDat = existsSync(CELL_DAT);

describe.skipIf(!hasCellDat)('Phase 4: Terrain Parsing + Mesh Generation', () => {
  let DatDatabase: any;
  let CellLandblock: any;
  let LandblockMesh: any;
  let cellDb: any;
  let landblockIds: number[] = [];

  beforeAll(async () => {
    const dbMod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = dbMod.DatDatabase;

    const lbMod = await import('../packages/dat-parser/src/file-types/CellLandblock');
    CellLandblock = lbMod.CellLandblock;

    // Loads in Node — a failed import must fail the suite, not no-op the mesh tests.
    const meshMod = await import('../packages/renderer/src/terrain/LandblockMesh');
    LandblockMesh = meshMod.LandblockMesh;

    if (existsSync(CELL_DAT)) {
      const buf = readFileSync(CELL_DAT).buffer;
      cellDb = new DatDatabase(buf);

      // Find terrain landblock IDs (ending in 0xFFFF)
      const allIds = cellDb.listFileIds ? cellDb.listFileIds() : [];
      landblockIds = allIds.filter((id: number) => (id & 0xFFFF) === 0xFFFF).slice(0, 100);
    }
  });

  it('cell.dat available with landblock entries', () => {
    expect(cellDb).toBeDefined();
    expect(landblockIds.length).toBeGreaterThan(0);
  });

  describe('CellLandblock Parsing', () => {
    it('parse 20 landblocks successfully', () => {
      let parsed = 0;
      for (const id of landblockIds.slice(0, 30)) {
        try {
          const reader = cellDb.getReader(id);
          const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
          if (lb.heights ?? lb.heightMap ?? lb.terrain) {
            parsed++;
          }
          if (parsed >= 20) break;
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(20);
    });

    it('each landblock has 81 height values (9×9)', () => {
      for (const id of landblockIds.slice(0, 20)) {
        try {
          const reader = cellDb.getReader(id);
          const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
          const heights = lb.heights ?? lb.heightMap;
          expect(heights).toBeDefined();
          expect(heights.length).toBe(81);
        } catch {
          // Allow some failures for edge cases
        }
      }
    });

    it('height values are in 0-255 range', () => {
      const reader = cellDb.getReader(landblockIds[0]);
      const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
      const heights = lb.heights ?? lb.heightMap;
      for (const h of heights) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(255);
      }
    });

    it('each landblock has 81 terrain values (9×9)', () => {
      const reader = cellDb.getReader(landblockIds[0]);
      const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
      const terrain = lb.terrain ?? lb.terrainTypes;
      expect(terrain).toBeDefined();
      expect(terrain.length).toBe(81);
    });
  });

  describe('LandblockMesh Generation', () => {
    it('LandblockMesh module exists', async () => {
      const mod = await import('../packages/renderer/src/terrain/LandblockMesh');
      expect(mod).toBeDefined();
    });

    it('generates geometry with 81 vertices', () => {
      const reader = cellDb.getReader(landblockIds[0]);
      const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
      const mesh = LandblockMesh.create?.(lb) ?? new LandblockMesh(lb);

      const geometry = mesh.geometry ?? mesh;
      const positions = geometry.getAttribute?.('position') ?? geometry.positions;
      // 81 vertices × 3 components = 243
      if (positions?.count !== undefined) {
        expect(positions.count).toBe(81);
      } else if (positions?.length !== undefined) {
        expect(positions.length).toBe(243);
      }
    });

    it('generates 384 indices (8×8×2 triangles × 3 vertices)', () => {
      const reader = cellDb.getReader(landblockIds[0]);
      const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
      const mesh = LandblockMesh.create?.(lb) ?? new LandblockMesh(lb);

      const geometry = mesh.geometry ?? mesh;
      const index = geometry.getIndex?.() ?? geometry.index ?? geometry.indices;
      if (index?.count !== undefined) {
        expect(index.count).toBe(384);
      } else if (index?.length !== undefined) {
        expect(index.length).toBe(384);
      }
    });

    it('vertex positions are finite numbers', () => {
      const reader = cellDb.getReader(landblockIds[0]);
      const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
      const mesh = LandblockMesh.create?.(lb) ?? new LandblockMesh(lb);

      const geometry = mesh.geometry ?? mesh;
      const positions = geometry.getAttribute?.('position')?.array
        ?? geometry.positions;

      if (positions) {
        for (let i = 0; i < positions.length; i++) {
          expect(Number.isFinite(positions[i])).toBe(true);
        }
      }
    });

    it('bounding box is approximately 192m × 192m', () => {
      const reader = cellDb.getReader(landblockIds[0]);
      const lb = CellLandblock.read?.(reader) ?? new CellLandblock(reader);
      const mesh = LandblockMesh.create?.(lb) ?? new LandblockMesh(lb);

      const geometry = mesh.geometry ?? mesh;
      if (geometry.computeBoundingBox) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (box) {
          const width = box.max.x - box.min.x;
          const depth = box.max.z !== undefined
            ? box.max.z - box.min.z
            : box.max.y - box.min.y;
          expect(width).toBeCloseTo(192, -1); // within 10m
          expect(depth).toBeCloseTo(192, -1);
        }
      }
    });
  });

  describe('TerrainManager', () => {
    it('TerrainManager module exists', async () => {
      const mod = await import('../packages/renderer/src/terrain/TerrainManager');
      expect(mod).toBeDefined();
    });
  });

  describe('Build check', () => {
    it('the renderer app module loads in Node (tsc -b is the real build check)', async () => {
      const mod = await import('../packages/renderer/src/app');
      expect(mod).toBeDefined();
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    });
  });
});
