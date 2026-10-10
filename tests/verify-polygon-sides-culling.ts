/**
 * VISUAL.lifestone-crystal-opacity — retail back-face culls every object
 * polygon except SidesType 1 (CullMode.None):
 *  - D3DPolyRender::RenderMeshSubset @ 0059ca10 sets CULLMODE_CW unless
 *    override_cull_state (never written in the EoL client);
 *  - the mesh build (decomp ≈ :400477 / :400720) gives a SidesType 1 polygon
 *    a second, reversed copy with negated normals (copyVert sign -1) — what
 *    THREE.DoubleSide's back-face lighting does; SidesType 2's negative batch
 *    keeps the front winding.
 * We drew every object face double-sided, so the lifestone crystal
 * (GfxObj 0x01000CFA: 58 SidesType-0 polygons on translucency-0.25 surface
 * 0x080011DE) stacked its back faces behind its front ones and read nearly
 * opaque where retail's shows the town through it (retail-ab yaraq).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { buildGfxObjGeometry } from '../packages/renderer/src/models/GfxObjMesh.js';
import { ModelRenderer } from '../packages/renderer/src/models/ModelRenderer.js';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { Surface } from '@ac/dat-parser/file-types/Surface.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { doubleSidedCopies } from '../packages/renderer/src/effects/PortalSpaceRenderer.js';
import { EnvCellRenderer } from '../packages/renderer/src/world/EnvCellRenderer.js';
import { applyRetailLighting } from '../packages/renderer/src/models/RetailLighting.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

function quadGfxObj(sides: number[]): never {
  const vertices = new Map<number, unknown>();
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  corners.forEach(([x, y], i) => vertices.set(i, { origin: { x, y, z: 0 }, normal: { x: 0, y: 0, z: 1 }, uvs: [{ u: x, v: y }] }));
  return {
    surfaces: [0x08000001],
    vertexArray: { vertices },
    polygons: sides.map((sidesType) => ({ vertexIndices: [0, 1, 2, 3], posUVIndices: [0, 0, 0, 0], negUVIndices: [], posSurface: 0, negSurface: 0, sidesType, stippling: 0 })),
    physicsPolygons: new Map(),
  } as never;
}

function factory(): MaterialFactory {
  const tex = { image: { width: 1, height: 1 }, needsUpdate: true } as unknown as THREE.DataTexture;
  const tm = { getTexture: () => tex, getTextureWithPalette: () => tex } as unknown as ConstructorParameters<typeof MaterialFactory>[1];
  const db = { getFileData: () => null } as unknown as ConstructorParameters<typeof MaterialFactory>[0];
  const f = new MaterialFactory(db, tm);
  const s = new Surface();
  s.type = 0x12; s.origTextureId = 0x05002b92; s.translucency = 0.25; s.luminosity = 0.75; s.diffuse = 1;
  // @ts-expect-error reach the private loader with a synthetic surface
  f.loadSurface = () => s;
  return f;
}

describe('per-polygon sidedness', () => {
  it('geometry tags each triangle double-sided only for SidesType 1', () => {
    const g = buildGfxObjGeometry(quadGfxObj([0, 1, 2]));
    // three quads → six fan triangles, plus the SidesType 2 quad's negative
    // copy (ConstructMesh @ 0059dfa0: same winding, culled like the front)
    expect(g.doubleSided).toEqual([false, false, true, true, false, false, false, false]);
  });

  it('ModelRenderer: single-sided triangles get a FrontSide material, SidesType 1 ones a DoubleSide one', () => {
    const mr = new ModelRenderer({ getFileData: () => null } as never, factory());
    mr.loadGfxObj = () => quadGfxObj([0, 1]);
    const group = mr.createMesh(0x01000001)!;
    const sides = group.children.map((m) => ((m as THREE.Mesh).material as THREE.Material).side).sort();
    expect(sides).toEqual([THREE.FrontSide, THREE.DoubleSide].sort());
    const front = group.children.find((m) => ((m as THREE.Mesh).material as THREE.Material).side === THREE.FrontSide) as THREE.Mesh;
    expect(front.geometry.index!.count).toBe(6);
  });

  it('the front-side variant is cached apart from the double-sided one', () => {
    const f = factory();
    expect(f.getMaterial(0x080011de, undefined, undefined, undefined, true).side).toBe(THREE.FrontSide);
    expect(f.getMaterial(0x080011de).side).toBe(THREE.DoubleSide);
    expect(f.getMaterial(0x080011de, undefined, undefined, undefined, true)).not.toBe(f.getMaterial(0x080011de));
  });

  it('env-cell geometry culls the same way (DrawEnvCell → DrawMesh → RenderMeshSubset), on its per-cell material clones', () => {
    const shared = applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0x808080, side: THREE.DoubleSide }), 'object');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderer = new EnvCellRenderer({} as any, {} as any, { getMaterial: () => shared, getSurface: () => null } as any);
    const v = (x: number, y: number) => ({ origin: { x, y, z: 0 }, normal: { x: 0, y: 0, z: 1 }, uvs: [{ u: x, v: y }] });
    const cellStruct = {
      vertexArray: { vertices: new Map([[0, v(0, 0)], [1, v(1, 0)], [2, v(1, 1)], [3, v(0, 1)]]) },
      polygons: new Map([
        [0, { stippling: 0, sidesType: 0, vertexIndices: [0, 1, 2, 3], posUVIndices: [0, 0, 0, 0], posSurface: 0 }],
        [1, { stippling: 0, sidesType: 1, vertexIndices: [0, 2, 3], posUVIndices: [0, 0, 0], posSurface: 0 }],
      ]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group = renderer.buildCellGeometry(cellStruct as any, [0x08000001]);
    const sides = group.children.map((m) => ((m as THREE.Mesh).material as THREE.Material).side).sort();
    expect(sides).toEqual([THREE.FrontSide, THREE.DoubleSide].sort());
    expect(shared.side).toBe(THREE.DoubleSide); // the shared material is untouched
    // camera collision over the cell keeps the culled side on the material
    const dc = new DungeonCollision();
    dc.setDungeonGroup(group);
    expect(group.children.map((m) => ((m as THREE.Mesh).material as THREE.Material).side).sort()).toEqual(sides);
  });

  it('portal space: the tunnel (camera inside, outward SidesType 0 faces) draws from double-sided copies; the shared materials stay culled', () => {
    const shared = applyRetailLighting(new THREE.MeshLambertMaterial({ side: THREE.FrontSide }), 'object');
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shared);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shared);
    root.add(a, b);
    const copies = doubleSidedCopies(root);
    expect(copies).toHaveLength(1); // one copy per shared material
    expect((a.material as THREE.Material).side).toBe(THREE.DoubleSide);
    expect(a.material).toBe(b.material);
    expect(a.material).not.toBe(shared);
    expect(shared.side).toBe(THREE.FrontSide);
    // the retail-lighting shader patch carries over
    expect((a.material as THREE.Material).onBeforeCompile).toBe(shared.onBeforeCompile);
  });

  it('outdoor collision rays still hit both faces without writing DoubleSide into the shared materials', () => {
    const mat = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat); // faces +Z
    const dc = new DungeonCollision();
    dc.setMeshes([wall]);
    expect(mat.side).toBe(THREE.FrontSide);
    // a ray from behind the wall (−Z side looking +Z) meets its back face
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDc = dc as any;
    anyDc.raycaster.set(new THREE.Vector3(0.5, 1.2, -2), new THREE.Vector3(0, 0, 1));
    anyDc.raycaster.far = 10;
    expect(anyDc.intersectRenderMeshes()).toHaveLength(1);
    expect(mat.side).toBe(THREE.FrontSide);
  });
});

const hasDats = existsSync(DAT_PATHS.portal);
describe.skipIf(!hasDats)('the lifestone crystal (GfxObj 0x01000CFA)', () => {
  it('is all single-sided, so it draws with the back-face-culled translucent material', () => {
    const portal = openDat(DAT_PATHS.portal);
    const mr = new ModelRenderer(portal as never, factory());
    const group = mr.createMesh(0x01000cfa)!;
    expect(group.children).toHaveLength(1);
    const m = (group.children[0] as THREE.Mesh).material as THREE.Material;
    expect(m.side).toBe(THREE.FrontSide);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBeCloseTo(0.75);
  });
});
