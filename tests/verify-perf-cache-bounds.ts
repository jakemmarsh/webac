/**
 * ASSESS: behavioral tests for the bounded renderer caches (fresh-eyes audit
 * 2026-06-10 §performance). Each test drives the REAL shipped class against a
 * stub DatDatabase serving hand-built DAT bytes, asserting:
 *   - caches actually cache (same instance back, single getFileData call)
 *   - caches are bounded (size never exceeds capacity)
 *   - evicted entries transparently re-load on next access
 *   - the new composite-palette texture cache dedupes by palette CONTENT
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { TextureManager, hashPaletteColors } from '@ac/renderer/models/TextureManager.js';
import { SetupModelRenderer } from '@ac/renderer/models/SetupModelRenderer.js';
import { ClothingRenderer } from '@ac/renderer/models/ClothingRenderer.js';
import { ModelRenderer } from '@ac/renderer/models/ModelRenderer.js';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';

// ── little-endian byte builder for fabricating DAT file payloads ──────────
class ByteWriter {
  private bytes: number[] = [];
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { return this.u8(v).u8(v >>> 8); }
  i16(v: number): this { return this.u16(v & 0xffff); }
  u32(v: number): this { return this.u16(v & 0xffff).u16(v >>> 16); }
  i32(v: number): this { return this.u32(v >>> 0); }
  f32(v: number): this {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    this.bytes.push(b[0], b[1], b[2], b[3]);
    return this;
  }
  vec3(x = 0, y = 0, z = 0): this { return this.f32(x).f32(y).f32(z); }
  toArrayBuffer(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }
}

/** Stub DatDatabase that serves per-id payloads and counts reads. */
function makeStubDb(payload: (id: number) => ArrayBuffer | null) {
  const calls: number[] = [];
  const db = {
    getFileData(id: number): ArrayBuffer | null {
      calls.push(id);
      return payload(id);
    },
    hasFile: (_id: number) => true,
  } as unknown as DatDatabase;
  return { db, calls };
}

// ── TextureManager.paletteCache ────────────────────────────────────────────

/** Palette file bytes: id u32, count i32, count × ARGB u32 (Palette.read format). */
function paletteBytes(id: number): ArrayBuffer {
  const w = new ByteWriter().u32(id).i32(4);
  for (let i = 0; i < 4; i++) w.u32((id + i) >>> 0);
  return w.toArrayBuffer();
}

describe('TextureManager.paletteCache — bounded LRU', () => {
  it('caches palette colors (one DAT read per id) and returns correct content', () => {
    const { db, calls } = makeStubDb(paletteBytes);
    const tm = new TextureManager(db);
    const a = tm.getPaletteColors(0x04000010);
    const b = tm.getPaletteColors(0x04000010);
    expect(a).toBe(b); // same cached array instance
    expect(a).toEqual([0x04000010, 0x04000011, 0x04000012, 0x04000013]);
    expect(calls.length).toBe(1);
  });

  it('never exceeds 512 entries and transparently re-parses evicted palettes', () => {
    const { db, calls } = makeStubDb(paletteBytes);
    const tm = new TextureManager(db);
    const N = 600;
    for (let i = 0; i < N; i++) tm.getPaletteColors(0x04000000 + i);
    expect(tm.stats.palettes).toBeLessThanOrEqual(512);
    expect(calls.length).toBe(N);

    // id 0 was the least recently used → evicted; re-access re-parses
    const colors = tm.getPaletteColors(0x04000000);
    expect(colors).toEqual([0x04000000, 0x04000001, 0x04000002, 0x04000003]);
    expect(calls.length).toBe(N + 1);

    // most recent id is still cached — no extra read
    tm.getPaletteColors(0x04000000 + N - 1);
    expect(calls.length).toBe(N + 1);
  });
});

// ── TextureManager composite-palette texture cache ─────────────────────────

describe('TextureManager.getTextureWithPalette — content-hash cache', () => {
  function makeTM() {
    const { db } = makeStubDb(() => null);
    const tm = new TextureManager(db);
    let decodes = 0;
    // Monkey-patch the decode layer so we exercise the real caching logic in
    // getTextureWithPalette without fabricating SurfaceTexture+Texture chains.
    (tm as unknown as { getRGBAWithPalette: unknown }).getRGBAWithPalette = () => {
      decodes++;
      return { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
    };
    return { tm, decodes: () => decodes };
  }

  it('returns the SAME texture for equal palette content (different array instances)', () => {
    const { tm, decodes } = makeTM();
    const t1 = tm.getTextureWithPalette(0x05000001, [1, 2, 3, 4]);
    const t2 = tm.getTextureWithPalette(0x05000001, [1, 2, 3, 4].slice());
    expect(t1).not.toBeNull();
    expect(t2).toBe(t1);
    expect(decodes()).toBe(1);
  });

  it('different palette content / surface id / clipmap flag get distinct textures', () => {
    const { tm } = makeTM();
    const base = tm.getTextureWithPalette(0x05000001, [1, 2, 3, 4]);
    expect(tm.getTextureWithPalette(0x05000001, [1, 2, 3, 5])).not.toBe(base);
    expect(tm.getTextureWithPalette(0x05000002, [1, 2, 3, 4])).not.toBe(base);
    expect(tm.getTextureWithPalette(0x05000001, [1, 2, 3, 4], true)).not.toBe(base);
  });

  it('is bounded at 1024 entries; eviction only forgets, sweep() disposes what nothing live uses (PERF.browser-memory-crash)', () => {
    const { tm } = makeTM();
    const first = tm.getTextureWithPalette(0x05000001, [0])!;
    let firstDisposed = false;
    first.addEventListener('dispose', () => { firstDisposed = true; });

    for (let i = 1; i <= 1024; i++) {
      tm.getTextureWithPalette(0x05000001, [i]);
    }
    expect(tm.stats.paletteTextures).toBeLessThanOrEqual(1024);
    // Evicted, but a live character may still draw it: not disposed by eviction.
    expect(firstDisposed).toBe(false);
    expect(tm.ownedCount).toBe(1025);

    // the most recent entry survived
    const again = tm.getTextureWithPalette(0x05000001, [1024]);
    expect(tm.stats.paletteTextures).toBeLessThanOrEqual(1024);
    expect(again).not.toBeNull();

    // sweep with `first` still live keeps it; once nothing uses it, it is disposed.
    expect(tm.sweep(new Set([first, again!]))).toBe(1023);
    expect(firstDisposed).toBe(false);
    expect(tm.sweep(new Set([again!]))).toBe(1);
    expect(firstDisposed).toBe(true);
    expect(tm.ownedCount).toBe(1);
  });

  it('clear() disposes cached composite-palette textures', () => {
    const { tm } = makeTM();
    const tex = tm.getTextureWithPalette(0x05000001, [7, 8])!;
    let disposed = false;
    tex.addEventListener('dispose', () => { disposed = true; });
    tm.clear();
    expect(disposed).toBe(true);
    expect(tm.stats.paletteTextures).toBe(0);
  });
});

describe('hashPaletteColors', () => {
  it('is stable for equal content and discriminates differing content', () => {
    expect(hashPaletteColors([1, 2, 3])).toBe(hashPaletteColors([1, 2, 3]));
    expect(hashPaletteColors([1, 2, 3])).not.toBe(hashPaletteColors([1, 2, 4]));
    expect(hashPaletteColors([1, 2, 3])).not.toBe(hashPaletteColors([1, 2]));
    expect(hashPaletteColors([])).toBe(hashPaletteColors([]));
    // order matters
    expect(hashPaletteColors([1, 2])).not.toBe(hashPaletteColors([2, 1]));
  });
});

// ── SetupModelRenderer.setupCache ──────────────────────────────────────────

/** Minimal SetupModel bytes: flags 0, 0 parts, all dict/list counts 0. */
function setupModelBytes(id: number): ArrayBuffer {
  return new ByteWriter()
    .u32(id).u32(0)        // id, flags
    .u32(0)                // numParts
    .i32(0).i32(0).i32(0)  // holdingLocations, connectionPoints, placementFrames
    .u32(0).u32(0)         // cylSpheres, spheres
    .f32(1).f32(1).f32(0.5).f32(0.5)   // height, radius, stepUp, stepDown
    .vec3().f32(1)         // sortingSphere
    .vec3().f32(1)         // selectionSphere
    .i32(0)                // lights
    .u32(0).u32(0).u32(0).u32(0).u32(0) // default anim/script/motion/sound/scriptTable
    .toArrayBuffer();
}

describe('SetupModelRenderer.setupCache — bounded LRU', () => {
  it('caches parsed SetupModels and is bounded at 2048', () => {
    const { db, calls } = makeStubDb(setupModelBytes);
    const renderer = new SetupModelRenderer(db, {} as unknown as ModelRenderer);

    const a = renderer.loadSetupModel(0x02000001);
    const b = renderer.loadSetupModel(0x02000001);
    expect(a).toBe(b);
    expect(a!.id).toBe(0x02000001);
    expect(calls.length).toBe(1);

    for (let i = 0; i < 2100; i++) renderer.loadSetupModel(0x02000100 + i);
    expect(renderer.cacheSize).toBeLessThanOrEqual(2048);

    // 0x02000001 was evicted — re-loading parses again and still works
    const before = calls.length;
    const c = renderer.loadSetupModel(0x02000001);
    expect(c!.id).toBe(0x02000001);
    expect(calls.length).toBe(before + 1);
  });
});

// ── ClothingRenderer.clothingCache ─────────────────────────────────────────

/** Minimal ClothingTable bytes: both PackedHashTables empty. */
function clothingTableBytes(id: number): ArrayBuffer {
  return new ByteWriter()
    .u32(id)
    .u16(0).u16(0)  // base effects: count, buckets
    .u16(0).u16(0)  // sub-pal effects: count, buckets
    .toArrayBuffer();
}

describe('ClothingRenderer.clothingCache — bounded LRU', () => {
  it('caches parsed ClothingTables and is bounded at 1024', () => {
    const { db, calls } = makeStubDb(clothingTableBytes);
    const cr = new ClothingRenderer(
      db,
      {} as unknown as SetupModelRenderer,
      {} as unknown as ModelRenderer,
      {} as unknown as MaterialFactory,
    );

    const a = cr.loadClothingTable(0x10000001);
    expect(cr.loadClothingTable(0x10000001)).toBe(a);
    expect(calls.length).toBe(1);

    for (let i = 0; i < 1100; i++) cr.loadClothingTable(0x10000100 + i);
    expect(cr.cacheSize).toBeLessThanOrEqual(1024);

    // evicted id re-parses transparently
    const before = calls.length;
    expect(cr.loadClothingTable(0x10000001)!.id).toBe(0x10000001);
    expect(calls.length).toBe(before + 1);
  });
});

// ── ModelRenderer.geometryCache ────────────────────────────────────────────

/**
 * Minimal renderable GfxObj: 1 surface, 3 vertices, 1 drawing triangle,
 * drawing BSP = single LEAF. Flags = HasDrawing (0x2).
 */
function gfxObjBytes(id: number): ArrayBuffer {
  const w = new ByteWriter()
    .u32(id).u32(0x2)      // id, flags = HasDrawing
    .u8(1)                 // surfaces: CompressedUInt32 count = 1
    .u32(0x08000001)       // surface id
    .i32(1).u32(3);        // vertexArray: vertexType, numVertices
  // 3 vertices: key u16, numUVs u16=1, origin, normal, uv
  for (let i = 0; i < 3; i++) {
    w.u16(i).u16(1).vec3(i, 0, 0).vec3(0, 0, 1).f32(0).f32(0);
  }
  w.vec3();                // sortCenter (no physics block: flag 0x1 unset)
  // drawing polygons: CompressedUInt32 count = 1, key u16, polygon
  w.u8(1).u16(0);
  w.u8(3).u8(0)            // numPts=3, stippling=None
    .i32(1)                // sidesType = CullMode.None
    .i16(0).i16(0);        // posSurface idx 0, negSurface
  w.i16(0).i16(1).i16(2);  // vertex indices
  w.u8(0).u8(0).u8(0);     // posUVIndices
  // drawing BSP: single LEAF node ("LEAF" stored byte-reversed) + leafIndex
  w.u8('F'.charCodeAt(0)).u8('A'.charCodeAt(0)).u8('E'.charCodeAt(0)).u8('L'.charCodeAt(0));
  w.i32(0);
  return w.toArrayBuffer();
}

function makeModelRenderer() {
  const { db, calls } = makeStubDb(gfxObjBytes);
  // Real MaterialFactory over a null-db (falls back to flat material) — same
  // stub pattern as tests/verify-material-alpha-thresholds.ts.
  const matDb = makeStubDb(() => null).db;
  const stubTextureManager = {
    getTexture: () => null,
    getTextureWithPalette: () => null,
  } as unknown as TextureManager;
  const factory = new MaterialFactory(matDb, stubTextureManager);
  return { mr: new ModelRenderer(db, factory), calls };
}

describe('ModelRenderer.geometryCache — bounded LRU', () => {
  it('createMesh reuses cached geometry arrays across calls', () => {
    const { mr, calls } = makeModelRenderer();
    const m1 = mr.createMesh(0x01000001);
    const callsAfterFirst = calls.length; // loadGfxObj + getGeometry-miss
    const m2 = mr.createMesh(0x01000001);
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
    expect(mr.cacheSize).toBe(1);
    // second createMesh only re-reads the GfxObj for its surface list — the
    // geometry build is served from cache
    expect(calls.length).toBe(callsAfterFirst + 1);

    // both meshes share the SAME cached position array (zero-copy reuse)
    const g1 = (m1!.children[0] as THREE.Mesh).geometry;
    const g2 = (m2!.children[0] as THREE.Mesh).geometry;
    expect(g1.getAttribute('position').array).toBe(g2.getAttribute('position').array);
    expect(g1.getIndex()!.count).toBe(3); // one triangle
  });

  it('getGeometry caches per id and is bounded at 4096', () => {
    const { mr } = makeModelRenderer();
    const a = mr.getGeometry(0x01000001);
    expect(mr.getGeometry(0x01000001)).toBe(a);

    for (let i = 0; i < 4200; i++) mr.getGeometry(0x01000100 + i);
    expect(mr.cacheSize).toBeLessThanOrEqual(4096);

    // evicted id rebuilds transparently with identical content
    const rebuilt = mr.getGeometry(0x01000001);
    expect(rebuilt).not.toBe(a);
    expect(rebuilt!.positions).toEqual(a!.positions);
    expect(rebuilt!.indices).toEqual(a!.indices);
  });
});
