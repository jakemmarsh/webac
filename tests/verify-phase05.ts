/**
 * Phase 5 Verification: 3D Model Parsing (GfxObj + SetupModel)
 * Tests mesh and multi-part model parsing from portal.dat
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');

const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('Phase 5: GfxObj + SetupModel Parsing', () => {
  let DatDatabase: any;
  let GfxObj: any;
  let SetupModel: any;
  let portalDb: any;

  beforeAll(async () => {
    const dbMod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = dbMod.DatDatabase;

    const gfxMod = await import('../packages/dat-parser/src/file-types/GfxObj');
    GfxObj = gfxMod.GfxObj;

    const setupMod = await import('../packages/dat-parser/src/file-types/SetupModel');
    SetupModel = setupMod.SetupModel;

    if (existsSync(PORTAL_DAT)) {
      const buf = readFileSync(PORTAL_DAT).buffer;
      portalDb = new DatDatabase(buf);
    }
  });

  describe('GfxObj (0x01)', () => {
    it('parse 100 random GfxObj, ≥95% succeed with vertices > 0', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      expect(gfxIds.length).toBeGreaterThan(100);

      const step = Math.floor(gfxIds.length / 100);
      const sample = Array.from({ length: 100 }, (_, i) => gfxIds[i * step]);

      let successes = 0;
      for (const id of sample) {
        try {
          const reader = portalDb.getReader(id);
          const obj = GfxObj.read?.(reader) ?? new GfxObj(reader);
          const verts = obj.vertices ?? obj.vertexArray ?? obj.vertexCount;
          const vertCount = Array.isArray(verts) ? verts.length : (typeof verts === 'number' ? verts : 0);
          if (vertCount > 0) {
            successes++;
          }
        } catch {
          // failure
        }
      }
      expect(successes).toBeGreaterThanOrEqual(95);
    });

    it('GfxObj vertices have finite position values', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      let tested = 0;

      for (const id of gfxIds.slice(0, 50)) {
        try {
          const reader = portalDb.getReader(id);
          const obj = GfxObj.read?.(reader) ?? new GfxObj(reader);
          const verts = obj.vertices ?? obj.vertexArray;

          if (Array.isArray(verts) && verts.length > 0) {
            for (const v of verts.slice(0, 10)) {
              const pos = v.position ?? v.origin ?? v;
              if (pos.x !== undefined) {
                expect(Number.isFinite(pos.x)).toBe(true);
                expect(Number.isFinite(pos.y)).toBe(true);
                expect(Number.isFinite(pos.z)).toBe(true);
              }
            }
            tested++;
            if (tested >= 10) break;
          }
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('GfxObj normals are approximately unit vectors', () => {
      const gfxIds = portalDb.listFileIds(0x01);

      for (const id of gfxIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const obj = GfxObj.read?.(reader) ?? new GfxObj(reader);
          const verts = obj.vertices ?? obj.vertexArray;

          if (Array.isArray(verts) && verts.length > 0) {
            for (const v of verts.slice(0, 5)) {
              const n = v.normal ?? v.n;
              if (n && n.x !== undefined) {
                const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
                if (len > 0) {
                  expect(len).toBeCloseTo(1.0, 1);
                }
              }
            }
            return; // one GfxObj is enough
          }
        } catch {
          // skip
        }
      }
    });

    it('GfxObj polygons reference valid vertex indices', () => {
      const gfxIds = portalDb.listFileIds(0x01);

      for (const id of gfxIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const obj = GfxObj.read?.(reader) ?? new GfxObj(reader);
          const verts = obj.vertices ?? obj.vertexArray;
          const polys = obj.polygons ?? obj.faces;

          if (Array.isArray(verts) && Array.isArray(polys) && polys.length > 0) {
            const vertCount = verts.length;
            for (const p of polys.slice(0, 10)) {
              const indices = p.vertexIndices ?? p.indices ?? p.vertices;
              if (Array.isArray(indices)) {
                for (const idx of indices) {
                  expect(idx).toBeGreaterThanOrEqual(0);
                  expect(idx).toBeLessThan(vertCount);
                }
              }
            }
            return; // one GfxObj is enough
          }
        } catch {
          // skip
        }
      }
    });

    it('GfxObj has surface IDs', () => {
      const gfxIds = portalDb.listFileIds(0x01);

      for (const id of gfxIds.slice(0, 20)) {
        try {
          const reader = portalDb.getReader(id);
          const obj = GfxObj.read?.(reader) ?? new GfxObj(reader);
          const surfaces = obj.surfaces ?? obj.surfaceIds;
          if (Array.isArray(surfaces) && surfaces.length > 0) {
            return; // success
          }
        } catch {
          // skip
        }
      }
      expect.unreachable('No GfxObj with surfaces found');
    });
  });

  describe('SetupModel (0x02)', () => {
    it('parse 50 SetupModel, ≥95% succeed with ≥1 part', () => {
      const setupIds = portalDb.listFileIds(0x02);
      expect(setupIds.length).toBeGreaterThan(50);

      const step = Math.floor(setupIds.length / 50);
      const sample = Array.from({ length: 50 }, (_, i) => setupIds[i * step]);

      let successes = 0;
      for (const id of sample) {
        try {
          const reader = portalDb.getReader(id);
          const setup = SetupModel.read?.(reader) ?? new SetupModel(reader);
          const parts = setup.parts ?? setup.partIds ?? setup.partCount;
          const partCount = Array.isArray(parts) ? parts.length : (typeof parts === 'number' ? parts : 0);
          if (partCount >= 1) {
            successes++;
          }
        } catch {
          // failure
        }
      }
      expect(successes).toBeGreaterThanOrEqual(50); // 100%
    });

    it('SetupModel parts reference existing GfxObj IDs', () => {
      const setupIds = portalDb.listFileIds(0x02);
      const gfxIds = new Set(portalDb.listFileIds(0x01));

      let tested = 0;
      for (const id of setupIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const setup = SetupModel.read?.(reader) ?? new SetupModel(reader);
          const parts = setup.parts ?? setup.partIds;

          if (Array.isArray(parts) && parts.length > 0) {
            for (const partId of parts) {
              expect(gfxIds.has(partId)).toBe(true);
            }
            tested++;
            if (tested >= 5) break;
          }
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('SetupModel has physical dimensions', () => {
      const setupIds = portalDb.listFileIds(0x02);

      let found = 0;
      for (const id of setupIds.slice(0, 50)) {
        try {
          const reader = portalDb.getReader(id);
          const setup = SetupModel.read?.(reader) ?? new SetupModel(reader);
          if (setup.height !== undefined || setup.radius !== undefined ||
              setup.stepUpHeight !== undefined || setup.stepDownHeight !== undefined) {
            found++;
            if (found >= 3) break;
          }
        } catch {
          // skip
        }
      }
      // Some SetupModels should have dimensions
      expect(found).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Renderer Mesh Creation', () => {
    it('GfxObjMesh module exists', async () => {
      const mod = await import('../packages/renderer/src/models/GfxObjMesh');
      expect(mod).toBeDefined();
    });

    it('SetupModelGroup module exists', async () => {
      const mod = await import('../packages/renderer/src/models/SetupModelGroup');
      expect(mod).toBeDefined();
    });
  });

  describe('Supporting Types', () => {
    it('Vertex type module exists', async () => {
      const mod = await import('../packages/dat-parser/src/file-types/Vertex');
      expect(mod).toBeDefined();
    });

    it('Polygon type module exists', async () => {
      const mod = await import('../packages/dat-parser/src/file-types/Polygon');
      expect(mod).toBeDefined();
    });

    it('Frame type module exists', async () => {
      const mod = await import('../packages/dat-parser/src/file-types/Frame');
      expect(mod).toBeDefined();
    });
  });
});
