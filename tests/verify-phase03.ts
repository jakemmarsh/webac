/**
 * Phase 3 Verification: Texture + Palette Parsing
 * Tests texture, palette, surface parsing from portal.dat
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');

const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('Phase 3: Texture + Palette Parsing', () => {
  let DatDatabase: any;
  let portalDb: any;
  let Texture: any;
  let Palette: any;
  let SurfaceTexture: any;
  let Surface: any;

  beforeAll(async () => {
    const dbMod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = dbMod.DatDatabase;

    const texMod = await import('../packages/dat-parser/src/file-types/Texture');
    Texture = texMod.Texture;

    const palMod = await import('../packages/dat-parser/src/file-types/Palette');
    Palette = palMod.Palette;

    const stMod = await import('../packages/dat-parser/src/file-types/SurfaceTexture');
    SurfaceTexture = stMod.SurfaceTexture;

    const surfMod = await import('../packages/dat-parser/src/file-types/Surface');
    Surface = surfMod.Surface;

    if (existsSync(PORTAL_DAT)) {
      const buf = readFileSync(PORTAL_DAT).buffer;
      portalDb = new DatDatabase(buf);
    }
  });

  it('portal.dat is available', () => {
    expect(portalDb).toBeDefined();
  });

  describe('Textures (0x06)', () => {
    it('parse 50 random textures, ≥90% succeed with valid dimensions', () => {
      const texIds = portalDb.listFileIds(0x06);
      expect(texIds.length).toBeGreaterThan(50);

      // Sample 50 random textures
      const sample = [];
      const step = Math.floor(texIds.length / 50);
      for (let i = 0; i < 50; i++) {
        sample.push(texIds[i * step]);
      }

      let successes = 0;
      for (const id of sample) {
        try {
          const reader = portalDb.getReader(id);
          const tex = Texture.read(reader) ?? new Texture(reader);
          if (tex.width > 0 && tex.height > 0) {
            successes++;
          }
        } catch {
          // count as failure
        }
      }
      expect(successes).toBeGreaterThanOrEqual(45); // ≥90% of 50
    });

    it('toRGBA output has correct byte length (w * h * 4)', () => {
      const texIds = portalDb.listFileIds(0x06);
      let tested = 0;

      for (const id of texIds.slice(0, 100)) {
        try {
          const reader = portalDb.getReader(id);
          const tex = Texture.read?.(reader) ?? new Texture(reader);
          const rgba = tex.toRGBA?.() ?? tex.getRGBA?.();
          if (rgba && tex.width > 0 && tex.height > 0) {
            expect(rgba.data.length).toBe(tex.width * tex.height * 4);
            tested++;
            if (tested >= 10) break;
          }
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('RGBA values are in 0-255 range', () => {
      const texIds = portalDb.listFileIds(0x06);
      for (const id of texIds.slice(0, 20)) {
        try {
          const reader = portalDb.getReader(id);
          const tex = Texture.read?.(reader) ?? new Texture(reader);
          const rgba = tex.toRGBA?.() ?? tex.getRGBA?.();
          if (rgba) {
            for (let i = 0; i < Math.min(rgba.data.length, 400); i++) {
              expect(rgba.data[i]).toBeGreaterThanOrEqual(0);
              expect(rgba.data[i]).toBeLessThanOrEqual(255);
            }
            return; // one successful check is enough
          }
        } catch {
          // skip
        }
      }
    });
  });

  describe('Palettes (0x04)', () => {
    it('parse 10 palettes, each has 2048 color entries', () => {
      const palIds = portalDb.listFileIds(0x04);
      expect(palIds.length).toBeGreaterThan(10);

      let parsed = 0;
      for (const id of palIds.slice(0, 20)) {
        try {
          const reader = portalDb.getReader(id);
          const pal = Palette.read?.(reader) ?? new Palette(reader);
          const colors = pal.colors ?? pal.entries ?? pal.data;
          if (colors && colors.length === 2048) {
            parsed++;
          }
          if (parsed >= 10) break;
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(10);
    });
  });

  describe('SurfaceTextures (0x05)', () => {
    it('parse surface textures with texture ID references', () => {
      const stIds = portalDb.listFileIds(0x05);
      expect(stIds.length).toBeGreaterThan(0);

      let parsed = 0;
      for (const id of stIds.slice(0, 20)) {
        try {
          const reader = portalDb.getReader(id);
          const st = SurfaceTexture.read?.(reader) ?? new SurfaceTexture(reader);
          const texRefs = st.textures ?? st.textureIds ?? st.data;
          if (texRefs && texRefs.length > 0) {
            parsed++;
          }
          if (parsed >= 5) break;
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Surfaces (0x08)', () => {
    it('parse 10 surfaces with texture references', () => {
      const surfIds = portalDb.listFileIds(0x08);
      expect(surfIds.length).toBeGreaterThan(10);

      let parsed = 0;
      for (const id of surfIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const surf = Surface.read?.(reader) ?? new Surface(reader);
          // Surface should reference a texture or surface texture
          if (surf.origTextureId || surf.textureId || surf.surfaceTextureId || surf.colorValue !== undefined) {
            parsed++;
          }
          if (parsed >= 10) break;
        } catch {
          // skip
        }
      }
      expect(parsed).toBeGreaterThanOrEqual(10);
    });
  });

  describe('DXT Decompression', () => {
    it('DxtUtil module exists and exports decompression functions', async () => {
      const mod = await import('../packages/dat-parser/src/file-types/DxtUtil');
      const dxt = mod.DxtUtil;
      // Should have at least DXT1 and DXT5 decompression
      expect(typeof dxt.decompressDxt1).toBe('function');
      expect(typeof dxt.decompressDxt5).toBe('function');
    });
  });
});
