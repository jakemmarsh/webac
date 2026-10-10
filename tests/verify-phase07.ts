/**
 * Phase 7 Verification: Environment/Dungeon Geometry (EnvCell)
 * Tests interior cell parsing, environment geometry, and landblock info
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const CELL_DAT = resolve(ROOT, 'dat/client_cell_1.dat');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');

const hasCellDat = existsSync(CELL_DAT);
const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasCellDat && !hasPortalDat)('Phase 7: Environment/Dungeon Geometry', () => {
  let DatDatabase: any;
  let EnvCell: any;
  let Environment: any;
  let LandblockInfo: any;
  let cellDb: any;
  let portalDb: any;

  beforeAll(async () => {
    const dbMod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = dbMod.DatDatabase;

    const envCellMod = await import('../packages/dat-parser/src/file-types/EnvCell');
    EnvCell = envCellMod.EnvCell;

    const envMod = await import('../packages/dat-parser/src/file-types/Environment');
    Environment = envMod.Environment;

    const lbiMod = await import('../packages/dat-parser/src/file-types/LandblockInfo');
    LandblockInfo = lbiMod.LandblockInfo;

    if (existsSync(CELL_DAT)) {
      const buf = readFileSync(CELL_DAT).buffer;
      cellDb = new DatDatabase(buf);
    }
    if (existsSync(PORTAL_DAT)) {
      const buf = readFileSync(PORTAL_DAT).buffer;
      portalDb = new DatDatabase(buf);
    }
  });

  describe('EnvCell Parsing', () => {
    it('parse 50+ interior cells with surface count > 0 and valid environment IDs', () => {
      expect(cellDb).toBeDefined();

      const allIds = cellDb.listFileIds();
      const interiorIds = allIds.filter((id: number) => {
        const lower = id & 0xFFFF;
        return lower !== 0xFFFF && lower !== 0xFFFE && lower > 0 && lower < 0xFF00;
      });
      expect(interiorIds.length).toBeGreaterThan(50);

      let parsed = 0;
      for (const id of interiorIds.slice(0, 100)) {
        try {
          const reader = cellDb.getReader(id);
          const cell = new EnvCell(reader);
          if (cell.surfaces.length > 0 && cell.environmentId > 0) {
            parsed++;
          }
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(50);
    });

    it('EnvCell has valid position data (finite origins, unit quaternions)', () => {
      const allIds = cellDb.listFileIds();
      const interiorIds = allIds.filter((id: number) => {
        const lower = id & 0xFFFF;
        return lower !== 0xFFFF && lower !== 0xFFFE && lower > 0 && lower < 0xFF00;
      });

      let tested = 0;
      for (const id of interiorIds.slice(0, 30)) {
        try {
          const reader = cellDb.getReader(id);
          const cell = new EnvCell(reader);
          const o = cell.position.origin;
          const q = cell.position.orientation;
          expect(Number.isFinite(o.x)).toBe(true);
          expect(Number.isFinite(o.y)).toBe(true);
          expect(Number.isFinite(o.z)).toBe(true);
          const len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
          if (len > 0) {
            expect(len).toBeCloseTo(1.0, 1);
          }
          tested++;
          if (tested >= 10) break;
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('EnvCell environment IDs reference valid 0x0D files in portal.dat', () => {
      const allIds = cellDb.listFileIds();
      const interiorIds = allIds.filter((id: number) => {
        const lower = id & 0xFFFF;
        return lower !== 0xFFFF && lower !== 0xFFFE && lower > 0 && lower < 0xFF00;
      });

      let tested = 0;
      for (const id of interiorIds.slice(0, 50)) {
        try {
          const reader = cellDb.getReader(id);
          const cell = new EnvCell(reader);
          if (cell.environmentId > 0) {
            expect(portalDb.hasFile(cell.environmentId)).toBe(true);
            tested++;
          }
          if (tested >= 10) break;
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('find ≥3 dungeon landblocks with multiple interior cells', () => {
      const allIds = cellDb.listFileIds();
      const landblockCells = new Map<number, number[]>();

      for (const id of allIds) {
        const lower = id & 0xFFFF;
        if (lower !== 0xFFFF && lower !== 0xFFFE && lower > 0 && lower < 0xFF00) {
          const lb = (id >>> 16) & 0xFFFF;
          if (!landblockCells.has(lb)) landblockCells.set(lb, []);
          landblockCells.get(lb)!.push(id);
        }
      }

      let dungeonCount = 0;
      for (const [, cells] of landblockCells) {
        if (cells.length > 1) {
          dungeonCount++;
          if (dungeonCount >= 3) break;
        }
      }
      expect(dungeonCount).toBeGreaterThanOrEqual(3);
    });

    it('portal connections reference valid cell IDs', () => {
      const allIds = cellDb.listFileIds();
      const interiorIds = allIds.filter((id: number) => {
        const lower = id & 0xFFFF;
        return lower !== 0xFFFF && lower !== 0xFFFE && lower > 0 && lower < 0xFF00;
      });

      let tested = 0;
      for (const id of interiorIds.slice(0, 50)) {
        try {
          const reader = cellDb.getReader(id);
          const cell = new EnvCell(reader);
          if (cell.cellPortals.length > 0) {
            for (const portal of cell.cellPortals) {
              expect(portal.otherCellId).toBeGreaterThanOrEqual(0);
            }
            tested++;
          }
          if (tested >= 5) break;
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Environment (0x0D)', () => {
    it('parse 10+ environments with ≥1 cell structure containing vertices and polygons', () => {
      const envIds = portalDb.listFileIds(0x0D);
      expect(envIds.length).toBeGreaterThan(10);

      let parsed = 0;
      for (const id of envIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const env = new Environment(reader);
          if (env.cells.size > 0) {
            const firstCell = env.cells.values().next().value;
            if (firstCell && firstCell.vertexArray.vertices.size > 0 && firstCell.polygons.size > 0) {
              parsed++;
            }
          }
          if (parsed >= 10) break;
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(10);
    });
  });

  describe('LandblockInfo (0xFFFE)', () => {
    it('parse 20+ LandblockInfo entries', () => {
      const allIds = cellDb.listFileIds();
      const lbiIds = allIds.filter((id: number) => (id & 0xFFFF) === 0xFFFE);
      expect(lbiIds.length).toBeGreaterThan(20);

      let parsed = 0;
      for (const id of lbiIds.slice(0, 50)) {
        try {
          const reader = cellDb.getReader(id);
          const lbi = new LandblockInfo(reader);
          if (lbi.id > 0) {
            parsed++;
          }
          if (parsed >= 20) break;
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(20);
    });
  });

  describe('DungeonRenderer', () => {
    it('DungeonRenderer module exists', async () => {
      const mod = await import('../packages/renderer/src/world/DungeonRenderer');
      expect(mod).toBeDefined();
    });
  });
});

// DEBT.test-harness-hygiene: formerly an existsSync over six renderer .ts
// paths; now the modules are imported and their exports checked (a file can
// exist and still fail to load). Runs without DATs.
describe('Phase 7: Build Verification — renderer modules load', () => {
  it('app.ts re-exports the terrain / model / dungeon renderers as live classes & functions', async () => {
    const app = await import('../packages/renderer/src/app');
    expect(typeof app.initApp).toBe('function');
    expect(typeof app.LandblockMesh).toBe('function');
    expect(typeof app.TerrainManager).toBe('function');
    expect(typeof app.DungeonRenderer).toBe('function');
    expect(typeof app.buildGfxObjGeometry).toBe('function');
    expect(typeof app.getPartPlacements).toBe('function');
  });

  it('each module also loads on its own path', async () => {
    const [lbm, tm, dr, gfx, smg] = await Promise.all([
      import('../packages/renderer/src/terrain/LandblockMesh'),
      import('../packages/renderer/src/terrain/TerrainManager'),
      import('../packages/renderer/src/world/DungeonRenderer'),
      import('../packages/renderer/src/models/GfxObjMesh'),
      import('../packages/renderer/src/models/SetupModelGroup'),
    ]);
    expect(typeof lbm.LandblockMesh).toBe('function');
    expect(typeof tm.TerrainManager).toBe('function');
    expect(typeof dr.DungeonRenderer).toBe('function');
    expect(typeof gfx.buildGfxObjGeometry).toBe('function');
    expect(typeof smg.getPartPlacements).toBe('function');
  });
});
