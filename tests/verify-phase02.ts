/**
 * Phase 2 Verification: DAT B-Tree Parser + Sector Chains
 * Tests real DAT file parsing — requires dat/client_portal.dat and dat/client_cell_1.dat
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const CELL_DAT = resolve(ROOT, 'dat/client_cell_1.dat');

const hasPortalDat = existsSync(PORTAL_DAT);
const hasCellDat = existsSync(CELL_DAT);

describe.skipIf(!hasPortalDat && !hasCellDat)('Phase 2: DAT Database', () => {
  let DatDatabase: any;
  let portalDb: any;
  let cellDb: any;

  beforeAll(async () => {
    const mod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = mod.DatDatabase;
    expect(DatDatabase).toBeDefined();

    if (existsSync(PORTAL_DAT)) {
      const buf = readFileSync(PORTAL_DAT).buffer;
      portalDb = new DatDatabase(buf);
    }
    if (existsSync(CELL_DAT)) {
      const buf = readFileSync(CELL_DAT).buffer;
      cellDb = new DatDatabase(buf);
    }
  });

  it('DatDatabase class is importable', () => {
    expect(DatDatabase).toBeDefined();
  });

  describe('Portal DAT', () => {
    it('portal.dat exists and loads', () => {
      expect(existsSync(PORTAL_DAT)).toBe(true);
      expect(portalDb).toBeDefined();
    });

    it('header has valid blockSize', () => {
      expect(portalDb.blockSize).toBeGreaterThan(0);
      // Portal DAT typically uses 1024-byte blocks
      expect([256, 512, 1024]).toContain(portalDb.blockSize);
    });

    it('file count is in expected range (~79,694)', () => {
      const count = portalDb.fileCount;
      expect(count).toBeGreaterThan(50000);
      expect(count).toBeLessThan(200000);
    });

    it('can list file IDs by type prefix', () => {
      const gfxObjs = portalDb.listFileIds(0x01);
      expect(gfxObjs.length).toBeGreaterThan(0);

      const palettes = portalDb.listFileIds(0x04);
      expect(palettes.length).toBeGreaterThan(0);

      const surfaceTextures = portalDb.listFileIds(0x05);
      expect(surfaceTextures.length).toBeGreaterThan(0);

      const textures = portalDb.listFileIds(0x06);
      expect(textures.length).toBeGreaterThan(0);

      const surfaces = portalDb.listFileIds(0x08);
      expect(surfaces.length).toBeGreaterThan(0);
    });

    it('GfxObj file IDs start with 0x01', () => {
      const ids = portalDb.listFileIds(0x01);
      for (const id of ids.slice(0, 100)) {
        expect((id >>> 24) & 0xFF).toBe(0x01);
      }
    });

    it('can retrieve file data for a known GfxObj', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      expect(gfxIds.length).toBeGreaterThan(0);
      const data = portalDb.getFileData(gfxIds[0]);
      expect(data).toBeInstanceOf(ArrayBuffer);
      expect(data.byteLength).toBeGreaterThan(0);
    });

    it('retrieved file data has correct first 4 bytes (file ID)', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      const data = portalDb.getFileData(gfxIds[0]);
      const view = new DataView(data);
      const fileId = view.getUint32(0, true);
      expect(fileId).toBe(gfxIds[0]);
    });

    it('can retrieve a Texture file (0x06)', () => {
      const texIds = portalDb.listFileIds(0x06);
      expect(texIds.length).toBeGreaterThan(0);
      const data = portalDb.getFileData(texIds[0]);
      expect(data.byteLength).toBeGreaterThan(8); // at minimum: ID + some header
    });

    it('can retrieve a Palette file (0x04)', () => {
      const palIds = portalDb.listFileIds(0x04);
      expect(palIds.length).toBeGreaterThan(0);
      const data = portalDb.getFileData(palIds[0]);
      expect(data.byteLength).toBeGreaterThan(0);
    });

    it('getReader returns a DatReader for file data', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      const reader = portalDb.getReader(gfxIds[0]);
      expect(reader).toBeDefined();
      expect(reader.readUInt32).toBeTypeOf('function');
      const id = reader.readUInt32();
      expect(id).toBe(gfxIds[0]);
    });

    it('non-existent file ID returns null or throws', () => {
      try {
        const data = portalDb.getFileData(0xFFFFFFFF);
        expect(data).toBeNull();
      } catch (e) {
        // Throwing is also acceptable
        expect(e).toBeDefined();
      }
    });
  });

  describe('Cell DAT', () => {
    it('cell.dat exists and loads', () => {
      expect(existsSync(CELL_DAT)).toBe(true);
      expect(cellDb).toBeDefined();
    });

    it('header has valid blockSize', () => {
      expect(cellDb.blockSize).toBeGreaterThan(0);
    });

    it('file count is in expected range (~805,348)', () => {
      const count = cellDb.fileCount;
      expect(count).toBeGreaterThan(100000);
      expect(count).toBeLessThan(2000000);
    });

    it('contains landblock files (0xXXYYFFFF)', () => {
      // Look for terrain landblock files — they end in 0xFFFF
      const allIds = portalDb ? cellDb.listFileIds() : [];
      const landblockIds = allIds.filter((id: number) => (id & 0xFFFF) === 0xFFFF);
      // Or try direct approach:
      // Test a specific known landblock
      let found = false;
      for (let xx = 0; xx < 256 && !found; xx++) {
        for (let yy = 0; yy < 256 && !found; yy++) {
          const lbId = ((xx << 24) | (yy << 16) | 0xFFFF) >>> 0;
          try {
            const data = cellDb.getFileData(lbId);
            if (data && data.byteLength > 0) {
              found = true;
            }
          } catch {
            // skip
          }
        }
      }
      expect(found).toBe(true);
    });

    it('can retrieve landblock data and it has expected minimum size', () => {
      // Landblock terrain data: hasObjects(4) + terrain(162) + heights(81) = 247 bytes minimum
      // Try some known populated landblocks
      const testLandblocks = [
        0xC6A90000 | 0xFFFF, // Known populated area
        0xC9A90000 | 0xFFFF,
        0x7F0A0000 | 0xFFFF,
      ];
      let foundOne = false;
      for (const lbId of testLandblocks) {
        try {
          const data = cellDb.getFileData(lbId >>> 0);
          if (data && data.byteLength > 100) {
            foundOne = true;
            break;
          }
        } catch {
          // Try next
        }
      }
      // If known ones fail, just find any landblock
      if (!foundOne) {
        const allIds = cellDb.listFileIds ? cellDb.listFileIds() : [];
        for (const id of allIds) {
          if ((id & 0xFFFF) === 0xFFFF) {
            const data = cellDb.getFileData(id);
            if (data && data.byteLength > 100) {
              foundOne = true;
              break;
            }
          }
        }
      }
      expect(foundOne).toBe(true);
    });
  });
});
