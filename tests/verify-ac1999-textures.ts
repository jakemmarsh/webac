/**
 * AC1999 texture translation (era1999/Textures1999.ts): the 1999 portal.dat's
 * 0x05 (the image itself), 0x06 (headerless RGB) and 0x08 (Surface with a
 * leading id) are re-encoded into the end-of-retail formats our parsers read,
 * and decode through TextureManager unchanged. The pixel values below were
 * checked by eye on decoded PNGs (grass/sand/water terrain, a framed painting,
 * glow particles, inventory icons, a 400x300 splash screen).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatFileSource } from '../packages/dat-parser/src/RangedDat.js';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.js';
import {
  SYNTHETIC_TEXTURE_PREFIX,
  syntheticTextureId,
  synthesizeTexture1999,
  transcodeSurface1999,
  transcodeSurfaceTexture1999,
  transcodeTexture1999,
} from '../packages/dat-parser/src/era1999/Textures1999.js';
import { Surface } from '../packages/dat-parser/src/file-types/Surface.js';
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { SurfacePixelFormat, Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { openDat } from './_harness/dat.js';

/** A 1999 0x05 record. */
function st1999(id: number, format: number, w: number, h: number, pixels: number[], paletteId?: number): ArrayBuffer {
  const wr = new DatWriter().writeUInt32(id).writeUInt32(format).writeUInt32(w).writeUInt32(h).writeBytes(new Uint8Array(pixels));
  if (paletteId !== undefined) wr.writeUInt32(paletteId);
  return wr.toArrayBuffer();
}

function readAll<T>(buf: ArrayBuffer, read: (r: DatReader) => T): T {
  const r = new DatReader(buf);
  const v = read(r);
  expect(r.remaining).toBe(0);
  return v;
}

describe('Textures1999 (synthetic records)', () => {
  it('maps a SurfaceTexture id onto the synthetic 0x07 Texture id', () => {
    expect(SYNTHETIC_TEXTURE_PREFIX).toBe(0x07);
    expect(syntheticTextureId(0x0500186e)).toBe(0x0700186e);
  });

  it('transcodes a 0x05 into a one-level EoL SurfaceTexture naming the synthetic id', () => {
    const raw = st1999(0x05000010, 2, 2, 1, [3, 4], 0x04000020);
    const st = readAll(transcodeSurfaceTexture1999(raw, 0x05000010), SurfaceTexture.read);
    expect(st.id).toBe(0x05000010);
    expect(st.textures).toEqual([0x07000010]);
  });

  it('synthesizes an INDEX8 image as PFID_P8 with its palette', () => {
    const raw = st1999(0x05000010, 2, 2, 1, [3, 4], 0x04000020);
    const asked: number[] = [];
    const tex = readAll(synthesizeTexture1999(0x07000010, (id) => (asked.push(id), raw))!, Texture.read);
    expect(asked).toEqual([0x05000010]);
    expect(tex.id).toBe(0x07000010);
    expect([tex.width, tex.height, tex.format, tex.defaultPaletteId]).toEqual([2, 1, SurfacePixelFormat.PFID_P8, 0x04000020]);
    const pal = new Array(256).fill(0);
    pal[3] = 0xff102030;
    pal[4] = 0xff405060;
    expect([...tex.toRGBAWithPalette(pal).data]).toEqual([0x10, 0x20, 0x30, 255, 0x40, 0x50, 0x60, 255]);
  });

  it('interleaves the planar COLOR_SEP image (R plane, G plane, B plane)', () => {
    const raw = st1999(0x05000011, 10, 2, 1, [10, 11, 20, 21, 30, 31]);
    const tex = readAll(synthesizeTexture1999(0x07000011, () => raw)!, Texture.read);
    expect(tex.format).toBe(SurfacePixelFormat.PFID_R8G8B8);
    expect([...tex.toRGBA().data]).toEqual([10, 20, 30, 255, 11, 21, 31, 255]);
  });

  it('keeps the bytes of ARGB4444, RGB565 and ALPHA_ONLY images', () => {
    const argb = readAll(synthesizeTexture1999(0x07000001, () => st1999(0x05000001, 4, 1, 1, [0x21, 0xf3]))!, Texture.read);
    expect(argb.format).toBe(SurfacePixelFormat.PFID_A4R4G4B4);
    expect([...argb.toRGBA().data]).toEqual([0x33, 0x22, 0x11, 0xff]);
    const rgb565 = readAll(synthesizeTexture1999(0x07000001, () => st1999(0x05000001, 7, 1, 1, [0x00, 0xf8]))!, Texture.read);
    expect(rgb565.format).toBe(SurfacePixelFormat.PFID_R5G6B5);
    expect([...rgb565.toRGBA().data]).toEqual([255, 0, 0, 255]);
    const a8 = readAll(synthesizeTexture1999(0x07000001, () => st1999(0x05000001, 11, 1, 1, [0x80]))!, Texture.read);
    expect(a8.format).toBe(SurfacePixelFormat.PFID_A8);
    expect([...a8.toRGBA().data]).toEqual([255, 255, 255, 0x80]);
  });

  it('returns null for non-synthetic ids and absent sources', () => {
    expect(synthesizeTexture1999(0x06000001, () => new ArrayBuffer(0))).toBeNull();
    expect(synthesizeTexture1999(0x07000001, () => null)).toBeNull();
  });

  it('rejects records that are not consumed exactly or use an unmeasured format', () => {
    const short = st1999(0x05000001, 2, 2, 2, [1, 2, 3], 0x04000001);
    expect(() => transcodeSurfaceTexture1999(short, 0x05000001)).toThrow(/needs 24 bytes, record has 23/);
    expect(() => synthesizeTexture1999(0x07000001, () => st1999(0x05000001, 5, 1, 1, [1, 2, 3, 4]))).toThrow(/format 5/);
    expect(() => transcodeSurfaceTexture1999(st1999(0x05000002, 11, 1, 1, [0]), 0x05000001)).toThrow(/carries id/);
  });

  it('transcodes a 0x06 (id, w, h, R,G,B) into an EoL R8G8B8 Texture', () => {
    const raw = new DatWriter().writeUInt32(0x06000066).writeUInt32(2).writeUInt32(1).writeBytes(new Uint8Array([1, 2, 3, 4, 5, 6])).toArrayBuffer();
    const tex = readAll(transcodeTexture1999(raw), Texture.read);
    expect([tex.id, tex.width, tex.height, tex.format]).toEqual([0x06000066, 2, 1, SurfacePixelFormat.PFID_R8G8B8]);
    expect([...tex.toRGBA().data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(() => transcodeTexture1999(raw.slice(0, 17))).toThrow(/needs 18 bytes/);
  });

  it('drops the Surface leading id, for image and solid-colour surfaces', () => {
    const img = new DatWriter().writeUInt32(0x08000004).writeUInt32(2).writeUInt32(0x05000003).writeUInt32(0x04000e8a)
      .writeFloat32(0).writeFloat32(0).writeFloat32(1).toArrayBuffer();
    const s = readAll(transcodeSurface1999(img), Surface.read);
    expect([s.type, s.origTextureId, s.origPaletteId, s.diffuse]).toEqual([2, 0x05000003, 0x04000e8a, 1]);
    const solid = new DatWriter().writeUInt32(0x08000005).writeUInt32(1).writeUInt32(0xff336699)
      .writeFloat32(0.5).writeFloat32(0).writeFloat32(1).toArrayBuffer();
    const c = readAll(transcodeSurface1999(solid), Surface.read);
    expect([c.type, c.colorValue >>> 0, c.translucency]).toEqual([1, 0xff336699, 0.5]);
    expect(() => transcodeSurface1999(solid.slice(0, 20))).toThrow(/needs 24 bytes/);
  });
});

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('Textures1999 over the 1999 retail portal.dat', () => {
  let db: DatDatabase;
  let tm: TextureManager;

  beforeAll(() => {
    db = openDat(PORTAL_1999);
    // The translation an overlay applies, as a plain DatFileSource (the cached
    // DatDatabase is shared with other tests, so no overlay is installed on it).
    const raw = (id: number) => db.getFileData(id);
    const source: DatFileSource = {
      getFileData(id) {
        switch (id >>> 24) {
          case 0x05: { const r = raw(id); return r && transcodeSurfaceTexture1999(r, id); }
          case 0x06: { const r = raw(id); return r && transcodeTexture1999(r); }
          case 0x07: return synthesizeTexture1999(id, raw);
          case 0x08: { const r = raw(id); return r && transcodeSurface1999(r); }
          default: return raw(id);
        }
      },
      hasFile(id) {
        return id >>> 24 === SYNTHETIC_TEXTURE_PREFIX ? db.hasFile((0x05000000 | (id & 0xffffff)) >>> 0) : db.hasFile(id);
      },
    };
    tm = new TextureManager(source);
  });

  it('every 0x05 transcodes, and both the SurfaceTexture and its synthetic Texture parse with 0 leftover', () => {
    const ids = db.listFileIds(0x05);
    expect(ids.length).toBe(1904);
    const formats = new Map<number, number>();
    for (const id of ids) {
      const st = readAll(transcodeSurfaceTexture1999(db.getFileData(id)!, id), SurfaceTexture.read);
      expect(st.textures).toEqual([syntheticTextureId(id)]);
      const tex = readAll(synthesizeTexture1999(syntheticTextureId(id), (i) => db.getFileData(i))!, Texture.read);
      formats.set(tex.format, (formats.get(tex.format) ?? 0) + 1);
      if (tex.defaultPaletteId !== null) expect(db.hasFile(tex.defaultPaletteId)).toBe(true);
    }
    expect(Object.fromEntries(formats)).toEqual({
      [SurfacePixelFormat.PFID_P8]: 1734,
      [SurfacePixelFormat.PFID_R5G6B5]: 86,
      [SurfacePixelFormat.PFID_A4R4G4B4]: 50,
      [SurfacePixelFormat.PFID_R8G8B8]: 26,
      [SurfacePixelFormat.PFID_A8]: 8,
    });
  });

  it('every 0x06 transcodes to an R8G8B8 Texture with 0 leftover', () => {
    const ids = db.listFileIds(0x06);
    expect(ids.length).toBe(3069);
    for (const id of ids) {
      const tex = readAll(transcodeTexture1999(db.getFileData(id)!), Texture.read);
      expect(tex.id).toBe(id);
      expect(tex.length).toBe(tex.width * tex.height * 3);
    }
  });

  it('every 0x08 transcodes to an EoL Surface with 0 leftover, naming a 0x05 that exists', () => {
    const ids = db.listFileIds(0x08);
    expect(ids.length).toBe(1599);
    let images = 0;
    for (const id of ids) {
      const s = readAll(transcodeSurface1999(db.getFileData(id)!), Surface.read);
      if (s.type & 0x6) {
        images++;
        expect(s.origTextureId >>> 24).toBe(0x05);
        expect(db.hasFile(s.origTextureId)).toBe(true);
      }
    }
    expect(images).toBe(1489);
  });

  const px = (r: { width: number; data: Uint8Array }, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];

  it('decodes 0x05 images through TextureManager.getRGBA (Surface -> SurfaceTexture -> synthetic Texture)', () => {
    // Surface 0x08000004 -> 0x05000003 (INDEX8 256x256, palette 0x04000E8A).
    const surf = Surface.read(new DatReader(source(0x08000004)));
    expect([surf.origTextureId, surf.origPaletteId]).toEqual([0x05000003, 0x04000e8a]);
    const indexed = tm.getRGBA(surf.origTextureId)!;
    expect([indexed.width, indexed.height]).toEqual([256, 256]);
    expect(px(indexed, 0, 0)).toEqual([128, 99, 82, 255]);
    expect(px(indexed, 128, 128)).toEqual([52, 49, 51, 255]);

    const grass = tm.getRGBA(0x05001456)!; // COLOR_SEP terrain
    expect([grass.width, grass.height]).toEqual([128, 128]);
    expect(px(grass, 0, 0)).toEqual([80, 108, 18, 255]);
    expect(px(grass, 64, 64)).toEqual([67, 93, 16, 255]);

    const glow = tm.getRGBA(0x05001230)!; // ARGB4444 particle
    expect(px(glow, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(glow, 32, 32)).toEqual([255, 255, 255, 255]);

    const spark = tm.getRGBA(0x05001717)!; // RGB565
    expect(px(spark, 32, 32)).toEqual([198, 130, 0, 255]);

    const mask = tm.getRGBA(0x05001371)!; // ALPHA_ONLY
    expect(px(mask, 0, 0)).toEqual([255, 255, 255, 0]);
    expect(px(mask, 32, 32)).toEqual([255, 255, 255, 255]);
  });

  it('decodes 0x06 icons and art through TextureManager.getIconRGBA', () => {
    const icon = tm.getIconRGBA(0x060012db)!;
    expect([icon.width, icon.height]).toEqual([32, 32]);
    expect(px(icon, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(icon, 16, 16)).toEqual([64, 57, 54, 255]);

    const splash = tm.getIconRGBA(0x06001a98)!;
    expect([splash.width, splash.height]).toEqual([400, 300]);
    expect(px(splash, 200, 150)).toEqual([42, 43, 46, 255]);
    expect(px(splash, 200, 20)).toEqual([193, 186, 209, 255]); // sky
  });

  function source(id: number): ArrayBuffer {
    return transcodeSurface1999(db.getFileData(id)!);
  }
});
