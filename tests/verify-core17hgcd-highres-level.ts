/**
 * CORE.17.h.g.c.d — client_highres.dat is the Very High texture level.
 *
 * Retail anchors (reference/client-eol/decomp/acclient-decompiled.c):
 *   RenderTexture::DropUnwantedLevels @ 0044c390 — keeps every level of a
 *   SurfaceTexture at EnvironmentTextureDetail 0 only while
 *   RenderTexture::ShouldDropHighDetail @ 0044b830 finds the HiFi DAT
 *   (DBCache id 0x69466948 = "HiFi", client_highres.dat) mounted; otherwise
 *   level 0 falls through to the level-1 case and min(level, n−1) top
 *   entries are dropped.
 *   RenderTexture::ConstructTexture @ 0044ba70 — the D3D texture is sized at
 *   the FIRST retained level with one mip per retained level: index 0 is the
 *   highest-detail (highres) level, the last index the portal level.
 *   RenderTexture::GetSubDataIDs @ 0044c6c0 — index 0 of a multi-level list
 *   is an optional (qualifier 4) sub-DID.
 *   ACE DatManager.ITERATION_HIRES = 497; ACViewer TextureCache resolves a
 *   0x06 id from portal.dat first, then HighResDat.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  HIFI_DAT_ID, VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL, retainedSurfaceTextureLevels,
  TextureSamplerPrefs, textureSamplerPrefs, type RgbaImage,
} from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { DetailTexturing } from '../packages/renderer/src/models/DetailTexturing.js';
import { DatDatabase, DatReader } from '../packages/dat-parser/src/index.js';
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture, SurfacePixelFormat } from '../packages/dat-parser/src/file-types/Texture.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { openDat } from './_harness/dat.js';

const PORTAL_DAT = 'dat/client_portal.dat';
const HIGHRES_DAT = 'dat/client_highres.dat';

// ── synthetic DAT files ────────────────────────────────────────────────────

/** A 0x05 SurfaceTexture file: id, int32, uint8, int32 count, uint32 ids. */
function surfaceTextureBytes(id: number, levels: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(4 + 4 + 1 + 4 + levels.length * 4);
  const v = new DataView(buf);
  let o = 0;
  v.setUint32(o, id, true); o += 4;
  v.setInt32(o, 0, true); o += 4;
  v.setUint8(o, 2); o += 1;
  v.setInt32(o, levels.length, true); o += 4;
  for (const l of levels) { v.setUint32(o, l, true); o += 4; }
  return buf;
}

/** A 0x06 Texture file in A8R8G8B8 filled with one colour. */
function textureBytes(id: number, width: number, height: number, argb: number): ArrayBuffer {
  const len = width * height * 4;
  const buf = new ArrayBuffer(24 + len);
  const v = new DataView(buf);
  v.setUint32(0, id, true);
  v.setInt32(4, 0, true);
  v.setInt32(8, width, true);
  v.setInt32(12, height, true);
  v.setUint32(16, SurfacePixelFormat.PFID_A8R8G8B8, true);
  v.setInt32(20, len, true);
  for (let i = 0; i < width * height; i++) v.setUint32(24 + i * 4, argb, true);
  return buf;
}

/** The minimal DatDatabase surface the TextureManager touches. */
function fakeDb(files: Map<number, ArrayBuffer>): DatDatabase {
  return {
    getFileData: (id: number) => files.get(id >>> 0) ?? null,
    hasFile: (id: number) => files.has(id >>> 0),
  } as unknown as DatDatabase;
}

const ST_TWO_LEVEL = 0x05000001;   // level 0 lives in client_highres.dat
const ST_SINGLE = 0x05000002;      // one level only
const ST_PORTAL_L0 = 0x05000003;   // level 0 lives in portal.dat itself (the ~740 cases)
const ST_ORPHAN_L0 = 0x05000004;   // level 0 exists nowhere (defensive)
const TEX_HI = 0x0600000a;
const TEX_PORTAL = 0x0600000b;
const TEX_SINGLE = 0x0600000c;
const TEX_PORTAL_L0 = 0x0600000d;
const TEX_ORPHAN = 0x0600000e;

function portalFiles(): Map<number, ArrayBuffer> {
  return new Map<number, ArrayBuffer>([
    [ST_TWO_LEVEL, surfaceTextureBytes(ST_TWO_LEVEL, [TEX_HI, TEX_PORTAL])],
    [ST_SINGLE, surfaceTextureBytes(ST_SINGLE, [TEX_SINGLE])],
    [ST_PORTAL_L0, surfaceTextureBytes(ST_PORTAL_L0, [TEX_PORTAL_L0, TEX_PORTAL])],
    [ST_ORPHAN_L0, surfaceTextureBytes(ST_ORPHAN_L0, [TEX_ORPHAN, TEX_PORTAL])],
    [TEX_PORTAL, textureBytes(TEX_PORTAL, 8, 8, 0xff102030)],
    [TEX_SINGLE, textureBytes(TEX_SINGLE, 8, 8, 0xff405060)],
    [TEX_PORTAL_L0, textureBytes(TEX_PORTAL_L0, 16, 16, 0xff708090)],
  ]);
}

function highResFiles(): Map<number, ArrayBuffer> {
  return new Map<number, ArrayBuffer>([
    [TEX_HI, textureBytes(TEX_HI, 16, 16, 0xffa0b0c0)],
  ]);
}

function rgba(width: number, height: number, fill = 0x80): RgbaImage {
  return { data: new Uint8Array(width * height * 4).fill(fill), width, height };
}

function dataTexture(img: RgbaImage): THREE.DataTexture {
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

const dims = (tex: THREE.Texture) => [(tex.image as RgbaImage).width, (tex.image as RgbaImage).height];
const px0 = (tex: THREE.Texture) => (tex.image as unknown as RgbaImage).data[0];

describe('CORE.17.h.g.c.d — RenderTexture::DropUnwantedLevels + the HiFi DAT id', () => {
  it('HiFi_String_As_Int is the little-endian "HiFi" and Very High is choice 0', () => {
    expect(HIFI_DAT_ID).toBe(Buffer.from('HiFi', 'ascii').readUInt32LE(0));
    expect(HIFI_DAT_ID).toBe(0x69466948);
    expect(VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL).toBe(0);
  });

  it('a single-level list is never touched', () => {
    for (const level of [0, 1, 2, 3, 4]) {
      expect(retainedSurfaceTextureLevels(['p'], level, true)).toEqual(['p']);
      expect(retainedSurfaceTextureLevels(['p'], level, false)).toEqual(['p']);
    }
    expect(retainedSurfaceTextureLevels([], 0, true)).toEqual([]);
  });

  it('two levels: Very High keeps the highres level only with the DAT mounted; every other choice keeps the portal level', () => {
    const levels = ['hi', 'portal'];
    expect(retainedSurfaceTextureLevels(levels, 0, true)).toEqual(['hi', 'portal']);
    expect(retainedSurfaceTextureLevels(levels, 0, false)).toEqual(['portal']);   // falls through to case 1
    for (const level of [1, 2, 3, 4]) {
      expect(retainedSurfaceTextureLevels(levels, level, true)).toEqual(['portal']);
      expect(retainedSurfaceTextureLevels(levels, level, false)).toEqual(['portal']);
    }
  });

  it('n levels: min(level, n − 1) entries dropped from the top; an unregistered choice drops nothing', () => {
    const levels = ['a', 'b', 'c', 'd'];
    expect(retainedSurfaceTextureLevels(levels, 1, false)).toEqual(['b', 'c', 'd']);
    expect(retainedSurfaceTextureLevels(levels, 2, false)).toEqual(['c', 'd']);
    expect(retainedSurfaceTextureLevels(levels, 3, false)).toEqual(['d']);
    expect(retainedSurfaceTextureLevels(levels, 4, false)).toEqual(['d']);
    expect(retainedSurfaceTextureLevels(levels, 0, true)).toEqual(['a', 'b', 'c', 'd']);
    expect(retainedSurfaceTextureLevels(levels, 0, false)).toEqual(['b', 'c', 'd']);
    expect(retainedSurfaceTextureLevels(levels, 7, false)).toEqual(['a', 'b', 'c', 'd']);
    expect(retainedSurfaceTextureLevels(levels, 2, false)).not.toBe(levels);
  });
});

describe('CORE.17.h.g.c.d — the prefs registry swaps the highres level in and out', () => {
  it('environment textures draw the highres level only at Very High with the DAT mounted', () => {
    const prefs = new TextureSamplerPrefs({ value: 0 });
    const portal = rgba(64, 64, 0x10);
    const hi = rgba(128, 128, 0x20);
    let loads = 0;
    const tex = dataTexture(portal);
    prefs.register(tex, 'environment', portal, { hiRes: () => { loads++; return hi; } });
    expect(prefs.hasHighResLevel(tex)).toBe(true);
    expect(prefs.isAtHighRes(tex)).toBe(false);
    expect(dims(tex)).toEqual([64, 64]);
    expect(loads).toBe(0);

    // Very High without the DAT = High (retail without the HiFi DAT).
    prefs.set({ environmentTextureDetail: 0 });
    expect(prefs.usesHighResLevel('environment')).toBe(false);
    expect(dims(tex)).toEqual([64, 64]);
    expect(prefs.isAtHighRes(tex)).toBe(false);
    expect(loads).toBe(0);

    // Mounting the DAT re-applies every registered texture.
    const before = tex.source;
    expect(prefs.setHighResMounted(true)).toBe(true);
    expect(prefs.setHighResMounted(true)).toBe(false);
    expect(prefs.highResMounted).toBe(true);
    expect(prefs.usesHighResLevel('environment')).toBe(true);
    expect(dims(tex)).toEqual([128, 128]);
    expect(tex.source).not.toBe(before);
    expect(px0(tex)).toBe(0x20);
    expect(prefs.isAtHighRes(tex)).toBe(true);
    expect(loads).toBe(1);
    expect(prefs.census().environment).toMatchObject({ count: 1, withHiRes: 1, atHiRes: 1 });

    // High → the portal level again; back to Very High → the memoised highres image (no second decode).
    prefs.set({ environmentTextureDetail: 1 });
    expect(dims(tex)).toEqual([64, 64]);
    expect(px0(tex)).toBe(0x10);
    expect(prefs.isAtHighRes(tex)).toBe(false);
    prefs.set({ environmentTextureDetail: 0 });
    expect(dims(tex)).toEqual([128, 128]);
    expect(loads).toBe(1);

    // Low with the DAT mounted: the portal level at shift 2 (DropUnwantedLevels drops the highres level).
    prefs.set({ environmentTextureDetail: 3 });
    expect(dims(tex)).toEqual([16, 16]);
    expect(prefs.isAtHighRes(tex)).toBe(false);

    // Unmounting under Very High falls back to the portal level.
    prefs.set({ environmentTextureDetail: 0 });
    expect(dims(tex)).toEqual([128, 128]);
    prefs.setHighResMounted(false);
    expect(dims(tex)).toEqual([64, 64]);
    expect(prefs.isAtHighRes(tex)).toBe(false);
  });

  it('landscape textures, textures without a highres level, and a source that has none keep the portal level', () => {
    const prefs = new TextureSamplerPrefs({ value: 0 });
    prefs.setHighResMounted(true);
    prefs.set({ environmentTextureDetail: 0, landscapeTextureDetail: 2 });
    const land = dataTexture(rgba(64, 64));
    let landLoads = 0;
    prefs.register(land, 'landscape', undefined, { hiRes: () => { landLoads++; return rgba(128, 128); } });
    expect(prefs.usesHighResLevel('landscape')).toBe(false);
    expect(dims(land)).toEqual([64, 64]);
    expect(landLoads).toBe(0);
    expect(prefs.isAtHighRes(land)).toBe(false);

    const plain = dataTexture(rgba(32, 32));
    prefs.register(plain, 'environment');
    expect(prefs.hasHighResLevel(plain)).toBe(false);
    expect(dims(plain)).toEqual([32, 32]);

    let orphanLoads = 0;
    const orphan = dataTexture(rgba(32, 32));
    prefs.register(orphan, 'environment', undefined, { hiRes: () => { orphanLoads++; return null; } });
    expect(dims(orphan)).toEqual([32, 32]);
    expect(prefs.isAtHighRes(orphan)).toBe(false);
    expect(orphanLoads).toBe(1);
    // The null result is memoised too.
    prefs.set({ environmentTextureDetail: 1 });
    prefs.set({ environmentTextureDetail: 0 });
    expect(orphanLoads).toBe(1);
    expect(prefs.census().environment).toMatchObject({ count: 2, withHiRes: 1, atHiRes: 0 });
    expect(prefs.census().landscape).toMatchObject({ count: 1, withHiRes: 1, atHiRes: 0 });
  });

  it('a texture built from the highres level registers as already at that level and drops to the portal level on High', () => {
    const prefs = new TextureSamplerPrefs({ value: 0 });
    prefs.setHighResMounted(true);
    prefs.set({ environmentTextureDetail: 0 });
    const portal = rgba(64, 64, 0x10);
    const hi = rgba(128, 128, 0x20);
    let loads = 0;
    const tex = dataTexture(hi);
    const source = tex.source;
    prefs.register(tex, 'environment', portal, { hiRes: () => { loads++; return hi; }, builtFromHiRes: true });
    expect(prefs.isAtHighRes(tex)).toBe(true);
    expect(tex.source).toBe(source);     // nothing re-imaged
    expect(loads).toBe(0);
    expect(prefs.fullResOf(tex)).toBe(portal);
    prefs.set({ environmentTextureDetail: 1 });
    expect(dims(tex)).toEqual([64, 64]);
    expect(px0(tex)).toBe(0x10);
    prefs.set({ environmentTextureDetail: 0 });
    expect(dims(tex)).toEqual([128, 128]);
    expect(loads).toBe(0);               // the constructed image was memoised
    prefs.set({ environmentTextureDetail: 2 });
    expect(dims(tex)).toEqual([32, 32]);
  });

  it('a highres level whose dimensions equal the portal level still re-images on the swap', () => {
    const prefs = new TextureSamplerPrefs({ value: 0 });
    const portal = rgba(64, 64, 0x10);
    const hi = rgba(64, 64, 0x20);
    const tex = dataTexture(portal);
    prefs.register(tex, 'environment', portal, { hiRes: () => hi });
    prefs.setHighResMounted(true);
    prefs.set({ environmentTextureDetail: 0 });
    expect(px0(tex)).toBe(0x20);
    expect(prefs.isAtHighRes(tex)).toBe(true);
    prefs.set({ environmentTextureDetail: 1 });
    expect(px0(tex)).toBe(0x10);
  });
});

describe('CORE.17.h.g.c.d — TextureManager resolves level 0 from portal.dat, then client_highres.dat', () => {
  const shared = textureSamplerPrefs;
  afterEach(() => {
    shared.set({ textureFiltering: 1, landscapeTextureDetail: 2, environmentTextureDetail: 1 });
    shared.setHighResMounted(false);
  });

  it('level lists, level ids and RGBA per level', () => {
    const tm = new TextureManager(fakeDb(portalFiles()));
    expect(tm.getSurfaceTextureLevels(ST_TWO_LEVEL)).toEqual([TEX_HI, TEX_PORTAL]);
    expect(tm.getSurfaceTextureLevels(ST_SINGLE)).toEqual([TEX_SINGLE]);
    expect(tm.getSurfaceTextureLevels(0x05009999)).toBeNull();
    // Portal level = the last entry; the highres level needs the file somewhere.
    expect(tm.resolveLevelTextureId(ST_TWO_LEVEL, 'portal')).toBe(TEX_PORTAL);
    expect(tm.resolveLevelTextureId(ST_TWO_LEVEL, 'hires')).toBeNull();      // no highres DAT mounted
    expect(tm.resolveLevelTextureId(ST_SINGLE, 'hires')).toBeNull();         // single level: nothing above the portal level
    expect(tm.resolveLevelTextureId(ST_PORTAL_L0, 'hires')).toBe(TEX_PORTAL_L0); // level 0 in portal.dat itself
    expect(tm.resolveLevelTextureId(ST_ORPHAN_L0, 'hires')).toBeNull();
    expect(tm.hasHighResLevel(ST_TWO_LEVEL)).toBe(false);
    expect(tm.getRGBA(ST_TWO_LEVEL)!.width).toBe(8);
    expect(tm.getHighResRGBA(ST_TWO_LEVEL)).toBeNull();
    expect(tm.getHighResRGBA(ST_PORTAL_L0)!.width).toBe(16);
    expect(tm.stats.highResMounted).toBe(false);

    tm.setHighResDb(fakeDb(highResFiles()));
    expect(tm.stats.highResMounted).toBe(true);
    expect(tm.hasHighResLevel(ST_TWO_LEVEL)).toBe(true);
    expect(tm.resolveLevelTextureId(ST_TWO_LEVEL, 'hires')).toBe(TEX_HI);
    const hi = tm.getHighResRGBA(ST_TWO_LEVEL)!;
    expect([hi.width, hi.height]).toEqual([16, 16]);
    expect([hi.data[0], hi.data[1], hi.data[2], hi.data[3]]).toEqual([0xa0, 0xb0, 0xc0, 0xff]);
    // The portal level is untouched by the mount, and the two are separate cache entries.
    const portal = tm.getRGBA(ST_TWO_LEVEL)!;
    expect([portal.width, portal.data[0]]).toEqual([8, 0x10]);
    expect(tm.getHighResRGBA(ST_TWO_LEVEL)).toBe(hi);
    // A raw 0x06 id that only exists in client_highres.dat resolves through the chain too.
    expect(tm.getDirectRGBA(TEX_HI)!.width).toBe(16);
    expect(tm.getDirectRGBA(TEX_ORPHAN)).toBeNull();
  });

  it('getTexture hands the registry a lazy highres source; Very High draws it once the DAT is mounted', () => {
    const tm = new TextureManager(fakeDb(portalFiles()));
    const two = tm.getTexture(ST_TWO_LEVEL)!;
    const single = tm.getTexture(ST_SINGLE)!;
    const inPortal = tm.getTexture(ST_PORTAL_L0)!;
    expect(shared.hasHighResLevel(two)).toBe(true);
    expect(shared.hasHighResLevel(single)).toBe(false);
    expect(shared.hasHighResLevel(inPortal)).toBe(true);
    expect(dims(two)).toEqual([8, 8]);

    shared.set({ environmentTextureDetail: 0 });
    expect(dims(two)).toEqual([8, 8]);            // unmounted: Very High == High
    expect(dims(inPortal)).toEqual([8, 8]);       // the portal-resident level 0 waits for the mount too (ShouldDropHighDetail)

    tm.setHighResDb(fakeDb(highResFiles()));
    shared.setHighResMounted(true);
    expect(dims(two)).toEqual([16, 16]);
    expect(shared.isAtHighRes(two)).toBe(true);
    expect(dims(inPortal)).toEqual([16, 16]);
    expect(shared.isAtHighRes(inPortal)).toBe(true);
    expect(dims(single)).toEqual([8, 8]);
    expect(shared.isAtHighRes(single)).toBe(false);

    // A texture first built while Very High is active starts at the highres level.
    const late = tm.getTexture(ST_TWO_LEVEL, undefined, true)!;   // the clipmap variant is a separate entry
    expect(late).not.toBe(two);
    expect(dims(late)).toEqual([16, 16]);
    expect(shared.isAtHighRes(late)).toBe(true);
    // Landscape-kind requests never take the highres level.
    const land = tm.getTexture(ST_TWO_LEVEL, undefined, false, 'landscape')!;
    expect(dims(land)).toEqual([8, 8]);
    expect(shared.isAtHighRes(land)).toBe(false);

    shared.set({ environmentTextureDetail: 1 });
    expect(dims(two)).toEqual([8, 8]);
    expect(dims(late)).toEqual([8, 8]);
    expect(dims(inPortal)).toEqual([8, 8]);
    tm.clear();
    expect(shared.isRegistered(two)).toBe(false);
  });

  it('composite-palette textures and detail-pass textures follow the same level rule', () => {
    const files = portalFiles();
    const tm = new TextureManager(fakeDb(files), 2048, 4096, fakeDb(highResFiles()));
    expect(tm.stats.highResMounted).toBe(true);
    // A8R8G8B8 sources ignore the palette, so the level is all that differs.
    const palette = new Array(256).fill(0xffffffff) as number[];
    const pal = tm.getTextureWithPalette(ST_TWO_LEVEL, palette)!;
    expect(dims(pal)).toEqual([8, 8]);
    expect(shared.hasHighResLevel(pal)).toBe(true);
    shared.setHighResMounted(true);
    shared.set({ environmentTextureDetail: 0 });
    expect(dims(pal)).toEqual([16, 16]);
    expect(tm.getRGBAWithPalette(ST_TWO_LEVEL, palette, false, 'hires')!.width).toBe(16);
    expect(tm.getRGBAWithPalette(ST_SINGLE, palette, false, 'hires')).toBeNull();

    const detail = DetailTexturing.createDetailTexture(tm.getRGBA(ST_TWO_LEVEL), () => tm.getHighResRGBA(ST_TWO_LEVEL))!;
    expect(dims(detail)).toEqual([16, 16]);
    expect(shared.isAtHighRes(detail)).toBe(true);
    shared.set({ environmentTextureDetail: 1 });
    expect(dims(detail)).toEqual([8, 8]);
    const plainDetail = DetailTexturing.createDetailTexture(tm.getRGBA(ST_SINGLE))!;
    expect(shared.hasHighResLevel(plainDetail)).toBe(false);
  });
});

describe.skipIf(!existsSync(PORTAL_DAT) || !existsSync(HIGHRES_DAT))('CORE.17.h.g.c.d — the EoL client_highres.dat against portal.dat', () => {
  let portal: DatDatabase;
  let highres: DatDatabase;
  let header: Buffer;
  beforeAll(() => {
    portal = openDat(PORTAL_DAT);
    const raw = readFileSync(HIGHRES_DAT);
    header = Buffer.from(raw.subarray(0x140, 0x140 + 0x50));
    highres = new DatDatabase(raw.buffer as ArrayBuffer);
  });
  afterEach(() => {
    textureSamplerPrefs.set({ textureFiltering: 1, landscapeTextureDetail: 2, environmentTextureDetail: 1 });
    textureSamplerPrefs.setHighResMounted(false);
  });

  it('is the EoL HiFi DAT: portal-style header, iteration 497 (ACE ITERATION_HIRES), 0x06 textures only', () => {
    expect(header.readUInt32LE(0)).toBe(0x5442);
    expect(header.readUInt32LE(4)).toBe(1024);
    expect(header.readUInt32LE(12)).toBe(1);       // DataSet: "client_portal.dat and client_highres.dat both have this value" (ACE DatDatabaseType.cs)
    expect(highres.totalIterations).toBe(497);
    const ids = highres.listFileIds();
    const textures = ids.filter((id) => (id >>> 24) === 0x06);
    expect(textures.length).toBe(2294);
    expect(ids.length - textures.length).toBe(1);   // + the iteration file
    expect(highres.hasFile(0xffff0001)).toBe(true);
    for (const id of textures) expect(portal.hasFile(id)).toBe(false);
  });

  it('every two-level SurfaceTexture has its level 0 in portal.dat or client_highres.dat, never both, never neither', () => {
    let single = 0, two = 0, inPortal = 0, inHighRes = 0;
    for (const id of portal.listFileIds(0x05)) {
      const st = SurfaceTexture.read(new DatReader(portal.getFileData(id)!));
      expect(st.textures.length).toBeGreaterThan(0);
      expect(st.textures.length).toBeLessThanOrEqual(2);
      if (st.textures.length === 1) { single++; continue; }
      two++;
      const p = portal.hasFile(st.textures[0]);
      const h = highres.hasFile(st.textures[0]);
      expect(p !== h).toBe(true);
      if (p) inPortal++; else inHighRes++;
      expect(portal.hasFile(st.textures[1])).toBe(true);
    }
    expect({ single, two, inPortal, inHighRes }).toEqual({ single: 4197, two: 3024, inPortal: 740, inHighRes: 2284 });
  });

  it('0x0500000c: the highres level is 256×256 over the 128×128 portal level, drawn only at Very High with the DAT mounted', () => {
    const tm = new TextureManager(portal);
    const st = SurfaceTexture.read(new DatReader(portal.getFileData(0x0500000c)!));
    expect(st.textures.map((x) => x.toString(16))).toEqual(['6003b9d', '6003b9e']);
    expect(tm.getHighResRGBA(0x0500000c)).toBeNull();
    const tex = tm.getTexture(0x0500000c)!;
    expect(dims(tex)).toEqual([128, 128]);
    textureSamplerPrefs.set({ environmentTextureDetail: 0 });
    expect(dims(tex)).toEqual([128, 128]);

    tm.setHighResDb(highres);
    const t0 = Texture.read(new DatReader(highres.getFileData(st.textures[0])!));
    expect([t0.width, t0.height]).toEqual([256, 256]);
    const hi = tm.getHighResRGBA(0x0500000c)!;
    expect([hi.width, hi.height]).toEqual([256, 256]);
    textureSamplerPrefs.setHighResMounted(true);
    expect(dims(tex)).toEqual([256, 256]);
    expect(textureSamplerPrefs.isAtHighRes(tex)).toBe(true);
    // The two levels are the same picture at two densities: 2×2 box-filtering
    // the highres level lands within a few shades of the portal texel.
    const lo = tm.getRGBA(0x0500000c)!;
    let err = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      for (let c = 0; c < 3; c++) {
        const s = (hi.data[((2 * y) * 256 + 2 * x) * 4 + c] + hi.data[((2 * y) * 256 + 2 * x + 1) * 4 + c]
          + hi.data[((2 * y + 1) * 256 + 2 * x) * 4 + c] + hi.data[((2 * y + 1) * 256 + 2 * x + 1) * 4 + c]) / 4;
        err += Math.abs(s - lo.data[(y * 128 + x) * 4 + c]);
      }
    }
    expect(err / (128 * 128 * 3)).toBeLessThan(24);
    textureSamplerPrefs.set({ environmentTextureDetail: 1 });
    expect(dims(tex)).toEqual([128, 128]);
  });

  it('the EoL region\'s terrain textures are single-level (no highres landscape level to draw); the road/blend alpha maps have a same-size one', () => {
    const region = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    const merge = region.terrainInfo.landSurfaces.texMerge!;
    for (const d of merge.terrainDesc) {
      const st = SurfaceTexture.read(new DatReader(portal.getFileData(d.terrainTex.texGID)!));
      expect(st.textures.length).toBe(1);
    }
    const alphaIds = [...merge.roadMaps.map((m) => m.roadTexGID), ...merge.cornerTerrainMaps.map((m) => m.texGID), ...merge.sideTerrainMaps.map((m) => m.texGID)];
    expect(alphaIds.length).toBeGreaterThan(0);
    for (const id of alphaIds) {
      const st = SurfaceTexture.read(new DatReader(portal.getFileData(id)!));
      if (st.textures.length < 2) continue;
      const hi = Texture.read(new DatReader((portal.getFileData(st.textures[0]) ?? highres.getFileData(st.textures[0]))!));
      const lo = Texture.read(new DatReader(portal.getFileData(st.textures[1])!));
      expect([hi.width, hi.height]).toEqual([lo.width, lo.height]);
    }
  });
});
