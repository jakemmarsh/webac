/**
 * FAITHFUL.213 — ClipMap surface alpha-test rendering.
 *
 * In AC, Surface.type & SurfaceType.Base1ClipMap (0x04) marks a surface
 * as alpha-tested (foliage, decals). The convention is:
 *
 *   1. The Surface flag identifies "this material needs alpha-testing"
 *      (NOT the SurfaceType.Alpha 0x100 flag — that's a separate path
 *      for non-palette alpha-blended textures).
 *
 *   2. For palette-indexed textures (PFID_P8 / PFID_INDEX16), palette
 *      indices 0-7 are reserved as "punch-through" — the renderer
 *      must convert them to fully-transparent RGBA(0,0,0,0).
 *
 *   3. The shader runs alpha-test (discard pixel if alpha < threshold)
 *      to mask out those transparent pixels.
 *
 * Before FAITHFUL.213 the client only enabled alpha-test for the Alpha
 * flag, and never zeroed palette[0..7]. Tree foliage surfaces (all
 * Base1ClipMap with no Alpha flag) rendered as opaque dark polygons
 * instead of leafy alpha-tested billboards.
 *
 * Reference:
 *   reference/ACViewer/ACViewer/Render/GfxObjInstance_Shared.cs:46
 *     `AlphaSurfaceTypes = Base1ClipMap | Translucent | Alpha | Additive`
 *   reference/ACViewer/ACViewer/Render/TextureCache.cs:356
 *     `if (isClipMap && color < 8) r = g = b = a = 0;`
 */
import { describe, it, expect } from 'vitest';
import { Texture, SurfacePixelFormat } from '@ac/dat-parser/file-types/Texture.js';
import { SurfaceType } from '@ac/dat-parser/file-types/Surface.js';

describe('FAITHFUL.213 — ClipMap alpha-test rendering', () => {
  describe('Texture.toRGBAWithPalette isClipMap flag', () => {
    it('PFID_P8 palette index < 8 → RGBA(0,0,0,0) when isClipMap=true', () => {
      const tex = new Texture();
      tex.width = 4;
      tex.height = 1;
      tex.format = SurfacePixelFormat.PFID_P8;
      tex.length = 4;
      // Pixel palette indices: 0, 7, 8, 100
      tex.sourceData = new Uint8Array([0, 7, 8, 100]);

      // A palette where every entry is fully-opaque solid red (0xFFFF0000)
      const palette = new Array(256).fill(0xff_ff_00_00);

      const rgba = tex.toRGBAWithPalette(palette, /* isClipMap */ true);
      expect(rgba.width).toBe(4);
      expect(rgba.height).toBe(1);

      // Pixel 0 (idx 0) — transparent
      expect([...rgba.data.slice(0, 4)]).toEqual([0, 0, 0, 0]);
      // Pixel 1 (idx 7) — transparent (still < 8)
      expect([...rgba.data.slice(4, 8)]).toEqual([0, 0, 0, 0]);
      // Pixel 2 (idx 8) — solid red (255, 0, 0, 255)
      expect([...rgba.data.slice(8, 12)]).toEqual([255, 0, 0, 255]);
      // Pixel 3 (idx 100) — solid red (255, 0, 0, 255)
      expect([...rgba.data.slice(12, 16)]).toEqual([255, 0, 0, 255]);
    });

    it('PFID_P8 palette index < 8 → kept as palette color when isClipMap=false', () => {
      const tex = new Texture();
      tex.width = 1;
      tex.height = 1;
      tex.format = SurfacePixelFormat.PFID_P8;
      tex.length = 1;
      tex.sourceData = new Uint8Array([0]);

      const palette = [0xff_aa_bb_cc, ...new Array(255).fill(0)];

      const rgba = tex.toRGBAWithPalette(palette, /* isClipMap */ false);
      // Pixel 0 keeps the palette color (0xFFAABBCC = RGBA 0xAA 0xBB 0xCC 0xFF).
      expect([...rgba.data.slice(0, 4)]).toEqual([0xaa, 0xbb, 0xcc, 0xff]);
    });

    it('PFID_INDEX16 obeys the same isClipMap < 8 rule', () => {
      const tex = new Texture();
      tex.width = 3;
      tex.height = 1;
      tex.format = SurfacePixelFormat.PFID_INDEX16;
      tex.length = 6;
      // 3 little-endian int16 values: 0, 7, 200
      tex.sourceData = new Uint8Array([0, 0, 7, 0, 200, 0]);

      const palette = new Array(256).fill(0xff_44_55_66);

      const rgba = tex.toRGBAWithPalette(palette, /* isClipMap */ true);
      expect([...rgba.data.slice(0, 4)]).toEqual([0, 0, 0, 0]);   // idx 0 — transparent
      expect([...rgba.data.slice(4, 8)]).toEqual([0, 0, 0, 0]);   // idx 7 — transparent
      expect([...rgba.data.slice(8, 12)]).toEqual([0x44, 0x55, 0x66, 0xff]); // idx 200 — keeps color
    });
  });

  describe('SurfaceType.Base1ClipMap matches ACE C#', () => {
    it('Base1ClipMap is exactly 0x04 per ACE SurfaceType.cs', () => {
      expect(SurfaceType.Base1ClipMap).toBe(0x04);
    });

    it('Alpha is 0x100 per ACE (separate from ClipMap path)', () => {
      expect(SurfaceType.Alpha).toBe(0x100);
    });

    it('ACViewer-equivalent AlphaSurfaceTypes mask = ClipMap | Translucent | Alpha | Additive', () => {
      // reference/ACViewer/Render/GfxObjInstance_Shared.cs:46
      const expected = SurfaceType.Base1ClipMap
        | SurfaceType.Translucent
        | SurfaceType.Alpha
        | SurfaceType.Additive;
      expect(expected).toBe(0x04 | 0x10 | 0x100 | 0x10000);
    });
  });
});
