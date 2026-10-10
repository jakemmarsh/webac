/**
 * D3DPolyRender::ConstructMesh @ 0059dfa0 (decomp :400325), the mesh build
 * every GfxObj and env cell goes through:
 *
 *  - RENDER.sidestype2-negative-face-missing — a SidesType 2 polygon also
 *    gets a copy in its neg_surface batch: neg_uv_indices, normals passed
 *    as -1, the SAME winding (only SidesType 1's copy is reversed).
 *  - RENDER.physics-only-polys-drawn — only the drawing polygons are built
 *    (CGfxObj::InitLoad @ 005346b0 → ConstructMesh @ 0059ea90).
 *  - RENDER.sampler-clamp — a surface batch with no stippled polygon is
 *    sampled TEXADDRESS_CLAMP (isStippledOrAlphaedMask bit 0 → SetSurface
 *    @ 0059c4d0's wrap argument); TextureManager hands those batches a
 *    ClampToEdge twin of the texture.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { buildGfxObjGeometry, clampedSurfaceBatches } from '../packages/renderer/src/models/GfxObjMesh.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { ModelRenderer } from '../packages/renderer/src/models/ModelRenderer.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Surface } from '../packages/dat-parser/src/file-types/Surface.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

interface Poly { vertexIndices: number[]; posUVIndices: number[]; negUVIndices: number[]; posSurface: number; negSurface: number; sidesType: number; stippling: number }

/** One triangle (vertices 0-2, each with UV sets 0 and 1) as a synthetic GfxObj. */
function gfx(polys: Poly[], physicsOnly = false): GfxObj {
  const vertices = new Map<number, unknown>();
  [[0, 0], [1, 0], [0, 1]].forEach(([x, y], i) => vertices.set(i, {
    origin: { x, y, z: 0 }, normal: { x: 0, y: 0, z: 1 },
    uvs: [{ u: 0.1 * i, v: 0.2 }, { u: 0.5 + 0.1 * i, v: 0.7 }],
  }));
  return {
    surfaces: [0x08000001, 0x08000002],
    vertexArray: { vertices },
    polygons: physicsOnly ? [] : polys,
    polygonMap: new Map(),
    physicsPolygons: new Map(polys.map((p, i) => [i, p])),
    drawingBSP: null,
  } as unknown as GfxObj;
}

const tri = (over: Partial<Poly> = {}): Poly => ({
  vertexIndices: [0, 1, 2], posUVIndices: [0, 0, 0], negUVIndices: [], posSurface: 0, negSurface: 0, sidesType: 0, stippling: 0, ...over,
});

describe('SidesType 2 negative copy', () => {
  it('adds a neg_surface triangle with the same winding, negated normals and the neg UVs', () => {
    const g = buildGfxObjGeometry(gfx([tri({ sidesType: 2, posSurface: 0, negSurface: 1, negUVIndices: [1, 1, 1] })]));
    expect(g.surfaceIndices).toEqual([0, 1]);
    expect(g.doubleSided).toEqual([false, false]);
    const [a0, a1, a2, b0, b1, b2] = g.indices;
    // same winding: the copy visits the same positions in the same order
    const pos = (i: number) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
    expect([pos(b0), pos(b1), pos(b2)]).toEqual([pos(a0), pos(a1), pos(a2)]);
    // normals passed as -1 (AC +Z → three +Y; the copy is −Y)
    expect(g.normals[a0 * 3 + 1]).toBe(1);
    expect(g.normals[b0 * 3 + 1]).toBe(-1);
    // neg_uv_indices pick UV set 1
    expect(g.uvs[b1 * 2]).toBeCloseTo(0.5 + 0.1 * 2, 6); // fan (0, 2, 1): second index is vertex 2
    expect(g.uvs[a1 * 2]).toBeCloseTo(0.2, 6);
  });

  it('a polygon with no neg UV indices uses UV set 0; SidesType 0 / 1 get no copy', () => {
    const g = buildGfxObjGeometry(gfx([tri({ sidesType: 2, negSurface: 1, negUVIndices: [] })]));
    expect(g.surfaceIndices).toEqual([0, 1]);
    expect(g.uvs[g.indices[4] * 2]).toBeCloseTo(0.2, 6);
    expect(buildGfxObjGeometry(gfx([tri({ sidesType: 0 })])).surfaceIndices).toEqual([0]);
    expect(buildGfxObjGeometry(gfx([tri({ sidesType: 1 })])).doubleSided).toEqual([true]);
  });
});

describe('SidesType 2 copies across batches draw in surface-index order (zfuncVal = DEPTHTEST_LESS)', () => {
  it('flags batch order only when the copy lands in another batch', () => {
    expect(buildGfxObjGeometry(gfx([tri({ sidesType: 2, posSurface: 1, negSurface: 0 })])).batchOrdered).toBe(true);
    expect(buildGfxObjGeometry(gfx([tri({ sidesType: 2, posSurface: 0, negSurface: 0 })])).batchOrdered).toBe(false);
    expect(buildGfxObjGeometry(gfx([tri()])).batchOrdered).toBe(false);
  });
  it('in one batch the front face is emitted first, so under LESS it wins', () => {
    const g = buildGfxObjGeometry(gfx([tri({ sidesType: 2, negUVIndices: [1, 1, 1] })]));
    expect(g.normals[g.indices[0] * 3 + 1]).toBe(1); // first triangle drawn: the front
    expect(g.normals[g.indices[3] * 3 + 1]).toBe(-1);
  });
});

describe('only drawing polygons are built', () => {
  it('a GfxObj with physics polygons but no drawing polygons builds no triangles', () => {
    expect(buildGfxObjGeometry(gfx([tri()], true)).indices.length).toBe(0);
  });
});

describe('texture addressing per batch', () => {
  it('a batch clamps unless one of its polygons is stippled (pos_surface only)', () => {
    const clamped = clampedSurfaceBatches([
      { posSurface: 0, stippling: 0 }, { posSurface: 0, stippling: 1 },
      { posSurface: 1, stippling: 0 }, { posSurface: 2, stippling: 4 }, { posSurface: 3, stippling: 0x80 },
    ]);
    expect([0, 1, 2, 3].map(clamped)).toEqual([false, true, false, true]);
    const g = buildGfxObjGeometry(gfx([tri({ posSurface: 0, stippling: 1 }), tri({ posSurface: 1 })]));
    expect(g.clampUV).toEqual([false, true]);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('EoL GfxObjs (DAT)', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });
  const load = (id: number) => new GfxObj(new DatReader(portal.getFileData(id)!));

  it('0x010016D3 draws its four SidesType 2 polygons twice; 0x0100326E\'s copy lands in surface 2', () => {
    const a = load(0x010016d3);
    const sides2 = a.polygons.filter(p => p.sidesType === 2);
    expect(sides2.length).toBe(4);
    const triangles = a.polygons.reduce((n, p) => n + p.vertexIndices.length - 2, 0);
    const extra = sides2.reduce((n, p) => n + p.vertexIndices.length - 2, 0);
    expect(buildGfxObjGeometry(a).surfaceIndices.length).toBe(triangles + extra);
    const b = load(0x0100326e);
    const p = b.polygons.find(q => q.sidesType === 2)!;
    expect([p.posSurface, p.negSurface]).toEqual([1, 2]);
    expect(buildGfxObjGeometry(b).surfaceIndices).toContain(2);
  });

  it('0x010008AA / 0x0100326E: sub-meshes draw in surface-index order, the lower batch winning the shared face', () => {
    const models = new ModelRenderer(portal, new MaterialFactory(portal, new TextureManager(portal)));
    const orderOf = (id: number) => {
      const out = new Map<number, number>();
      for (const c of models.createMesh(id)!.children) out.set(c.userData.surfaceId as number, c.renderOrder);
      return out;
    };
    // 0x010008AA: front on surface index 1 (0x08000CEE), copy on index 0 (0x08000102) → the copy wins
    const a = orderOf(0x010008aa);
    expect(a.get(0x08000102)!).toBeLessThan(a.get(0x08000cee)!);
    // 0x0100326E: front on index 1 (0x080003EE), copy on index 2 (0x080003EF) → the front wins
    const b = orderOf(0x0100326e);
    expect(b.get(0x080003ee)!).toBeLessThan(b.get(0x080003ef)!);
    // an ordinary GfxObj keeps renderOrder 0 on its opaque sub-meshes
    for (const c of models.createMesh(0x01000ee1)!.children) expect(c.renderOrder).toBe(0);
  });

  it('a stippled (tiling) batch wraps and every clamped batch keeps its UVs inside [0, 1]', () => {
    for (const id of [0x010014c3, 0x01002286, 0x010016d3, 0x01000ee1]) {
      const o = load(id);
      const g = buildGfxObjGeometry(o);
      for (let t = 0; t < g.clampUV.length; t++) {
        if (!g.clampUV[t]) continue;
        for (let k = 0; k < 3; k++) {
          const v = g.indices[t * 3 + k];
          expect(g.uvs[v * 2]).toBeGreaterThanOrEqual(-0.01);
          expect(g.uvs[v * 2]).toBeLessThanOrEqual(1.01);
          expect(g.uvs[v * 2 + 1]).toBeGreaterThanOrEqual(-0.01);
          expect(g.uvs[v * 2 + 1]).toBeLessThanOrEqual(1.01);
        }
      }
    }
    // the pyramid's 64 stone-wall polygons tile: stippled, so they wrap
    const pyramid = buildGfxObjGeometry(load(0x010014c3));
    expect(pyramid.surfaceIndices.some((s, t) => s === 2 && !pyramid.clampUV[t])).toBe(true);
  });

  it('TextureManager hands a clamped batch a ClampToEdge twin and tags palettized textures', () => {
    const tm = new TextureManager(portal);
    const surf = Surface.read(new DatReader(portal.getFileData(0x08000233)!)); // pyramid stone wall
    const wrap = tm.getTexture(surf.origTextureId, surf.origPaletteId || undefined)!;
    const clamp = tm.getTexture(surf.origTextureId, surf.origPaletteId || undefined, false, 'environment', true)!;
    expect(wrap.wrapS).toBe(THREE.RepeatWrapping);
    expect(clamp.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(clamp.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(clamp).not.toBe(wrap);
    expect(tm.getTexture(surf.origTextureId, surf.origPaletteId || undefined, false, 'environment', true)).toBe(clamp);
    expect(typeof clamp.userData.acPaletted).toBe('boolean');
    expect(clamp.userData.acPaletted).toBe(wrap.userData.acPaletted);
  });
});
