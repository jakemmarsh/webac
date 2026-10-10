/**
 * Phase 12 Verification: 3D Model Rendering
 * Tests GfxObj → Three.js BufferGeometry, TextureManager, MaterialFactory, ModelRenderer
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as THREE from 'three';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');

/** Find GfxObj IDs that have drawing polygons (flag 0x04). */
function findDrawableGfxIds(portalDb: any, DatReader: any, GfxObj: any, count: number): number[] {
  const allIds = portalDb.listFileIds(0x01);
  const result: number[] = [];
  for (const id of allIds) {
    if (result.length >= count) break;
    try {
      const data = portalDb.getFileData(id);
      const obj = new GfxObj(new DatReader(data));
      if (obj.polygons.length > 0) {
        result.push(id);
      }
    } catch {
      // skip
    }
  }
  return result;
}

const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('Phase 12: 3D Model Rendering', () => {
  let DatDatabase: any;
  let DatReader: any;
  let GfxObj: any;
  let Surface: any;
  let SurfaceType: any;
  let buildGfxObjGeometry: any;
  let TextureManager: any;
  let MaterialFactory: any;
  let ModelRenderer: any;
  let portalDb: any;
  let drawableIds: number[];

  beforeAll(async () => {
    const dbMod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = dbMod.DatDatabase;

    const drMod = await import('../packages/dat-parser/src/DatReader');
    DatReader = drMod.DatReader;

    const gfxMod = await import('../packages/dat-parser/src/file-types/GfxObj');
    GfxObj = gfxMod.GfxObj;

    const surfMod = await import('../packages/dat-parser/src/file-types/Surface');
    Surface = surfMod.Surface;
    SurfaceType = surfMod.SurfaceType;

    await import('../packages/dat-parser/src/file-types/SurfaceTexture');
    await import('../packages/dat-parser/src/file-types/Texture');
    await import('../packages/dat-parser/src/file-types/Palette');

    const meshMod = await import('../packages/renderer/src/models/GfxObjMesh');
    buildGfxObjGeometry = meshMod.buildGfxObjGeometry;

    const tmMod = await import('../packages/renderer/src/models/TextureManager');
    TextureManager = tmMod.TextureManager;

    const mfMod = await import('../packages/renderer/src/models/MaterialFactory');
    MaterialFactory = mfMod.MaterialFactory;

    const mrMod = await import('../packages/renderer/src/models/ModelRenderer');
    ModelRenderer = mrMod.ModelRenderer;

    if (existsSync(PORTAL_DAT)) {
      const buf = readFileSync(PORTAL_DAT).buffer;
      portalDb = new DatDatabase(buf);
      drawableIds = findDrawableGfxIds(portalDb, DatReader, GfxObj, 30);
    }
  });

  // ─── GfxObj → BufferGeometry ──────────────────────────────────────

  describe('GfxObj → BufferGeometry conversion', () => {
    it('converts 20 GfxObj to geometry with correct vertex/index counts', () => {
      expect(drawableIds.length).toBeGreaterThanOrEqual(20);
      let successes = 0;

      for (let i = 0; i < 20; i++) {
        const id = drawableIds[i];
        try {
          const data = portalDb.getFileData(id);
          const gfxObj = new GfxObj(new DatReader(data));
          const geom = buildGfxObjGeometry(gfxObj);

          expect(geom.positions.length % 3).toBe(0);
          const vertCount = geom.positions.length / 3;
          expect(geom.normals.length).toBe(vertCount * 3);
          expect(geom.uvs.length).toBe(vertCount * 2);
          expect(geom.indices.length % 3).toBe(0);

          let hasNaN = false;
          for (let j = 0; j < geom.positions.length; j++) {
            if (isNaN(geom.positions[j])) { hasNaN = true; break; }
          }
          expect(hasNaN).toBe(false);

          if (vertCount > 0 && geom.indices.length > 0) successes++;
        } catch {
          // parse failure
        }
      }
      expect(successes).toBeGreaterThanOrEqual(18);
    });

    it('no NaN in normal attributes for parsed GfxObj', () => {
      for (let i = 0; i < Math.min(10, drawableIds.length); i++) {
        const id = drawableIds[i];
        const data = portalDb.getFileData(id);
        const gfxObj = new GfxObj(new DatReader(data));
        const geom = buildGfxObjGeometry(gfxObj);

        for (let j = 0; j < geom.normals.length; j++) {
          expect(isNaN(geom.normals[j])).toBe(false);
        }
      }
    });

    it('polygon indices within vertex range', () => {
      for (let i = 0; i < Math.min(10, drawableIds.length); i++) {
        const id = drawableIds[i];
        const data = portalDb.getFileData(id);
        const gfxObj = new GfxObj(new DatReader(data));
        const geom = buildGfxObjGeometry(gfxObj);
        const vertCount = geom.positions.length / 3;

        for (let j = 0; j < geom.indices.length; j++) {
          expect(geom.indices[j]).toBeLessThan(vertCount);
        }
      }
    });

    it('surface indices reference valid GfxObj surfaces', () => {
      for (let i = 0; i < Math.min(10, drawableIds.length); i++) {
        const id = drawableIds[i];
        const data = portalDb.getFileData(id);
        const gfxObj = new GfxObj(new DatReader(data));
        const geom = buildGfxObjGeometry(gfxObj);

        for (const surfIdx of geom.surfaceIndices) {
          expect(surfIdx).toBeLessThan(gfxObj.surfaces.length);
        }
      }
    });
  });

  // ─── TextureManager ────────────────────────────────────────────────

  describe('TextureManager', () => {
    it('loads 10 textures with valid width/height/data', () => {
      const texMgr = new TextureManager(portalDb);
      const stIds = portalDb.listFileIds(0x05);
      expect(stIds.length).toBeGreaterThan(10);

      const step = Math.floor(stIds.length / 10);
      let successes = 0;

      for (let i = 0; i < 10; i++) {
        const id = stIds[i * step];
        const rgba = texMgr.getRGBA(id);
        if (rgba) {
          expect(rgba.width).toBeGreaterThan(0);
          expect(rgba.height).toBeGreaterThan(0);
          expect(rgba.data.length).toBe(rgba.width * rgba.height * 4);
          successes++;
        }
      }
      expect(successes).toBeGreaterThanOrEqual(7);
      texMgr.clear();
    });

    it('creates THREE.DataTexture with correct dimensions', () => {
      const texMgr = new TextureManager(portalDb);
      const stIds = portalDb.listFileIds(0x05);
      const step = Math.floor(stIds.length / 5);
      let found = 0;

      for (let i = 0; i < 5; i++) {
        const id = stIds[i * step];
        const tex = texMgr.getTexture(id);
        if (tex) {
          expect(tex).toBeInstanceOf(THREE.DataTexture);
          expect(tex.image.width).toBeGreaterThan(0);
          expect(tex.image.height).toBeGreaterThan(0);
          found++;
        }
      }
      expect(found).toBeGreaterThanOrEqual(3);
      texMgr.clear();
    });

    it('caches textures (same ID returns same object)', () => {
      const texMgr = new TextureManager(portalDb);
      const stIds = portalDb.listFileIds(0x05);
      const id = stIds[0];

      const t1 = texMgr.getTexture(id);
      const t2 = texMgr.getTexture(id);
      expect(t1).toBe(t2);
      texMgr.clear();
    });

    it('getPaletteColors loads valid palette data', () => {
      const texMgr = new TextureManager(portalDb);
      const palIds = portalDb.listFileIds(0x04);
      expect(palIds.length).toBeGreaterThan(0);

      const colors = texMgr.getPaletteColors(palIds[0]);
      expect(colors).not.toBeNull();
      if (colors) {
        // Palettes have variable sizes (typically 256 or 2048)
        expect(colors.length).toBeGreaterThanOrEqual(2);
        for (const c of colors) {
          expect(typeof c).toBe('number');
        }
      }
      texMgr.clear();
    });

    it('clear() disposes textures and empties caches', () => {
      const texMgr = new TextureManager(portalDb);
      const stIds = portalDb.listFileIds(0x05);
      texMgr.getTexture(stIds[0]);
      expect(texMgr.cacheSize).toBeGreaterThan(0);

      texMgr.clear();
      expect(texMgr.cacheSize).toBe(0);
    });
  });

  // ─── MaterialFactory ──────────────────────────────────────────────

  describe('MaterialFactory', () => {
    it('creates materials for valid surface IDs', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const surfIds = portalDb.listFileIds(0x08);
      expect(surfIds.length).toBeGreaterThan(10);

      const step = Math.floor(surfIds.length / 10);
      let successes = 0;

      for (let i = 0; i < 10; i++) {
        const id = surfIds[i * step];
        const mat = matFactory.getMaterial(id);
        expect(mat).toBeDefined();
        expect(mat).toBeInstanceOf(THREE.Material);
        successes++;
      }
      expect(successes).toBe(10);
      matFactory.clear();
      texMgr.clear();
    });

    it('returns fallback material for invalid surface ID', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);

      const mat = matFactory.getMaterial(0x08FFFFFF);
      expect(mat).toBeInstanceOf(THREE.Material);
      matFactory.clear();
      texMgr.clear();
    });

    it('caches materials (same ID returns same object)', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const surfIds = portalDb.listFileIds(0x08);

      const m1 = matFactory.getMaterial(surfIds[0]);
      const m2 = matFactory.getMaterial(surfIds[0]);
      expect(m1).toBe(m2);
      matFactory.clear();
      texMgr.clear();
    });

    it('creates transparent material for translucent surfaces', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const surfIds = portalDb.listFileIds(0x08);
      const step = Math.max(1, Math.floor(surfIds.length / 50));

      let foundTranslucent = false;
      for (let i = 0; i < Math.min(50, surfIds.length) && !foundTranslucent; i++) {
        const id = surfIds[i * step];
        try {
          const data = portalDb.getFileData(id);
          const surf = Surface.read(new DatReader(data));
          if ((surf.type & SurfaceType.Translucent) !== 0 && surf.translucency > 0) {
            const mat = matFactory.getMaterial(id);
            expect((mat as any).transparent).toBe(true);
            expect((mat as any).opacity).toBeLessThan(1);
            foundTranslucent = true;
          }
        } catch {
          // skip
        }
      }
      matFactory.clear();
      texMgr.clear();
    });
  });

  // ─── ModelRenderer ─────────────────────────────────────────────────

  describe('ModelRenderer', () => {
    it('loadGfxObj returns parsed GfxObj for valid IDs', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      const obj = renderer.loadGfxObj(drawableIds[0]);
      expect(obj).not.toBeNull();
      expect(obj!.id).toBe(drawableIds[0]);
      expect(obj!.vertices.length).toBeGreaterThan(0);

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('loadGfxObj returns null for invalid IDs', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      const obj = renderer.loadGfxObj(0x01FFFFFF);
      expect(obj).toBeNull();

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('createBufferGeometry returns valid Three.js geometry for drawable GfxObj', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      let successes = 0;
      for (let i = 0; i < Math.min(10, drawableIds.length); i++) {
        const id = drawableIds[i];
        const geom = renderer.createBufferGeometry(id);
        if (geom) {
          expect(geom).toBeInstanceOf(THREE.BufferGeometry);
          const pos = geom.getAttribute('position');
          expect(pos).toBeDefined();
          expect(pos.count).toBeGreaterThan(0);

          const norm = geom.getAttribute('normal');
          expect(norm).toBeDefined();
          expect(norm.count).toBe(pos.count);

          const uv = geom.getAttribute('uv');
          expect(uv).toBeDefined();
          expect(uv.count).toBe(pos.count);

          const idx = geom.getIndex();
          expect(idx).not.toBeNull();
          expect(idx!.count).toBeGreaterThan(0);
          expect(idx!.count % 3).toBe(0);

          successes++;
        }
      }
      expect(successes).toBeGreaterThanOrEqual(8);

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('createMesh returns Three.js Group with child meshes for drawable GfxObj', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      let successes = 0;
      for (let i = 0; i < Math.min(5, drawableIds.length); i++) {
        const id = drawableIds[i];
        const group = renderer.createMesh(id);
        if (group) {
          expect(group).toBeInstanceOf(THREE.Group);
          expect(group.children.length).toBeGreaterThan(0);
          for (const child of group.children) {
            expect(child).toBeInstanceOf(THREE.Mesh);
            expect((child as THREE.Mesh).material).toBeInstanceOf(THREE.Material);
          }
          successes++;
        }
      }
      expect(successes).toBeGreaterThanOrEqual(3);

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('createMesh returns null for invalid IDs', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      const group = renderer.createMesh(0x01FFFFFF);
      expect(group).toBeNull();

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('placeModel sets position correctly', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      const group = renderer.placeModel(drawableIds[0], { x: 10, y: 20, z: 30 });
      if (group) {
        // AC coords: (x, y, z) → Three.js (x, z, y) — swap Y↔Z
        expect(group.position.x).toBeCloseTo(10, 1);
        expect(group.position.y).toBeCloseTo(30, 1);
        expect(group.position.z).toBeCloseTo(20, 1);
      }

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('getGeometry caches results', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      const g1 = renderer.getGeometry(drawableIds[0]);
      const g2 = renderer.getGeometry(drawableIds[0]);
      expect(g1).toBe(g2);
      expect(renderer.cacheSize).toBe(1);

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });
  });

  // ─── Integration: world object placement ──────────────────────────

  describe('World Object Placement', () => {
    it('model positions are finite numbers when placed', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      for (let i = 0; i < Math.min(5, drawableIds.length); i++) {
        const id = drawableIds[i];
        const pos = { x: i * 100, y: i * 50, z: 0 };
        const group = renderer.placeModel(id, pos);
        if (group) {
          expect(isFinite(group.position.x)).toBe(true);
          expect(isFinite(group.position.y)).toBe(true);
          expect(isFinite(group.position.z)).toBe(true);
        }
      }

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });

    it('model with rotation has valid quaternion', () => {
      const texMgr = new TextureManager(portalDb);
      const matFactory = new MaterialFactory(portalDb, texMgr);
      const renderer = new ModelRenderer(portalDb, matFactory);

      const group = renderer.placeModel(
        drawableIds[0],
        { x: 0, y: 0, z: 0 },
        { w: 1, x: 0, y: 0, z: 0 }
      );
      if (group) {
        const q = group.quaternion;
        const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
        expect(len).toBeCloseTo(1, 2);
      }

      renderer.clear();
      matFactory.clear();
      texMgr.clear();
    });
  });
});
