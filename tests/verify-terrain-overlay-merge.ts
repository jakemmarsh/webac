/**
 * CORE.14.c + PERF.1: terrain road/blend overlay quads are merged across
 * landblocks by the OverlayMergePool — one Mesh per distinct (layer, base
 * texture, alpha map) key REGION-WIDE (per-landblock merging alone still cost
 * ~533 draw calls at Holtburg town headings).
 *
 * These tests drive the real TerrainRenderer bucket collectors + the real
 * OverlayMergePool and assert BEHAVIOR: merged geometry is exactly the
 * concatenation of the per-quad geometry (positions, UVs, indices, normals),
 * vertices are world-space, materials are shared across landblocks, the
 * transparent draw order always ascends with layer rank from ANY camera
 * position (BUG.road-flicker-running), unloading a block retires exactly its
 * quads, and disposal never touches the shared materials.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TerrainRenderer, OverlayQuadBucket } from '@ac/renderer/terrain/TerrainRenderer.js';
import { OverlayMergePool, PooledOverlayBucket } from '@ac/renderer/terrain/OverlayMergePool.js';
import type { LandblockMesh } from '@ac/renderer/terrain/LandblockMesh.js';
import type { TerrainManager } from '@ac/renderer/terrain/TerrainManager.js';
import type { TextureManager } from '@ac/renderer/models/TextureManager.js';
import type { TexMerge } from '@ac/dat-parser/file-types/RegionDesc.js';

/**
 * three's transparent draw order (r160 through r186) for these meshes: WebGLRenderLists
 * reversePainterSortStable compares renderOrder, then the projected depth of
 * the GEOMETRY bounding-sphere centre (WebGLRenderer.projectObject), far
 * first, then object id. BUG.road-flicker-running — the old pool relied on
 * the id tie-break, but each merged bucket's sphere centre differs, so the
 * depth key decided and flipped as the camera moved.
 */
function transparentDrawOrder(meshes: THREE.Mesh[], camera: THREE.Camera): THREE.Mesh[] {
  camera.updateMatrixWorld();
  const proj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const z = (m: THREE.Mesh) => {
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    return m.geometry.boundingSphere!.center.clone().applyMatrix4(m.matrixWorld).applyMatrix4(proj).z;
  };
  return [...meshes].sort((a, b) => (a.renderOrder - b.renderOrder) || (z(b) - z(a)) || (a.id - b.id));
}

/** Two cameras looking down on the pool from opposite sides. */
function cameras(): THREE.PerspectiveCamera[] {
  return [[-600, 200, -600], [1200, 200, 1200]].map(([x, y, zz]) => {
    const c = new THREE.PerspectiveCamera(60, 1, 1, 5000);
    c.position.set(x, y, zz);
    c.lookAt(300, 0, 300);
    return c;
  });
}

function makeRenderer(scene = new THREE.Scene()): TerrainRenderer {
  return new TerrainRenderer(
    scene,
    { clear: () => {}, getLoadedMeshes: () => new Map() } as unknown as TerrainManager,
  );
}

/** Stub TextureManager whose getTexture returns a fresh 1×1 RGBA DataTexture
 *  (and, CORE.17.h.g.c, whose getRGBA returns the full-res pixels the alpha
 *  maps are now built from). */
function makeStubTextureManager(): TextureManager {
  return {
    getTexture: (_gid: number) => {
      const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 128]), 1, 1, THREE.RGBAFormat);
      tex.needsUpdate = true;
      return tex;
    },
    getRGBA: (_gid: number) => ({ data: new Uint8Array([0, 0, 0, 128]), width: 1, height: 1 }),
  } as unknown as TextureManager;
}

/** Fake LandblockMesh: 9×9 grid with deterministic bumpy heights. */
function makeLbMesh(opts: {
  roadMasks?: Map<number, number>;
  cornerTypes?: Map<number, [number, number, number, number]>;
}): LandblockMesh {
  const positions = new Float32Array(81 * 3);
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 9; row++) {
      const i = (col * 9 + row) * 3;
      positions[i] = col * 24;
      positions[i + 1] = ((col * 7 + row * 13) % 5) * 2; // bumpy, deterministic
      positions[i + 2] = row * 24;
    }
  }
  const cellRoadMasks = new Array(64).fill(0);
  const cellCornerTerrainTypes = new Array(256).fill(1);
  const cellCornerRoadBits = new Array(256).fill(0);
  for (const [cellIdx, mask] of opts.roadMasks ?? []) cellRoadMasks[cellIdx] = mask;
  for (const [cellIdx, types] of opts.cornerTypes ?? []) {
    for (let c = 0; c < 4; c++) cellCornerTerrainTypes[cellIdx * 4 + c] = types[c];
  }
  return {
    geometry: { positions },
    cellRoadMasks,
    cellCornerTerrainTypes,
    cellCornerRoadBits,
  } as unknown as LandblockMesh;
}

function roadTexMerge(roadGid: number, rCode: number): TexMerge {
  return {
    baseTexSize: 512,
    terrainDesc: [
      { terrainType: 0x20, terrainTex: { texGID: 0x06000100, texTiling: 1 } },
    ],
    landtexList: [],
    cornerTerrainMaps: [],
    sideTerrainMaps: [],
    roadMaps: [{ rCode, roadTexGID: roadGid }],
  } as unknown as TexMerge;
}

function blendTexMerge(alphaGid: number, terrainTypes: number[]): TexMerge {
  return {
    baseTexSize: 512,
    terrainDesc: terrainTypes.map((tt, i) => ({
      terrainType: tt,
      terrainTex: { texGID: 0x06000200 + i, texTiling: 2 },
    })),
    landtexList: [],
    cornerTerrainMaps: [{ tCode: 8, texGID: alphaGid }],
    sideTerrainMaps: [],
    roadMaps: [],
  } as unknown as TexMerge;
}

type PrivateApi = {
  collectRoadOverlayBuckets(
    lbMesh: LandblockMesh, fileId: number, worldX: number, worldZ: number,
    buckets: Map<string, PooledOverlayBucket>,
  ): void;
  collectTerrainBlendBuckets(
    lbMesh: LandblockMesh, fileId: number, worldX: number, worldZ: number,
    buckets: Map<string, PooledOverlayBucket>,
  ): void;
};

/** Collect a landblock's buckets and feed them into the renderer's pool. */
function addRoadBlock(tr: TerrainRenderer, lb: LandblockMesh, fileId: number, wx: number, wz: number): void {
  const buckets = new Map<string, PooledOverlayBucket>();
  (tr as unknown as PrivateApi).collectRoadOverlayBuckets(lb, fileId, wx, wz, buckets);
  tr.overlayMergePool.addBlock(fileId, buckets);
  tr.overlayMergePool.flush();
}
function addBlendBlock(tr: TerrainRenderer, lb: LandblockMesh, fileId: number, wx: number, wz: number): void {
  const buckets = new Map<string, PooledOverlayBucket>();
  (tr as unknown as PrivateApi).collectTerrainBlendBuckets(lb, fileId, wx, wz, buckets);
  tr.overlayMergePool.addBlock(fileId, buckets);
  tr.overlayMergePool.flush();
}

describe('OverlayQuadBucket merge — geometry equivalence', () => {
  const mat = new THREE.MeshBasicMaterial();

  function bucketOf(
    cx: number, cz: number, h: [number, number, number, number],
    rotation: number, split: boolean,
  ): PooledOverlayBucket {
    const b: PooledOverlayBucket = {
      verts: [], uvs: [], indices: [], quadCount: 0, material: mat, layer: 0, rank: 0, name: 'blendmerge',
    };
    TerrainRenderer.appendOverlayQuad(b, cx, cz, 24, h[0], h[1], h[2], h[3], rotation, split);
    return b;
  }

  it('two merged quads reproduce the two individual quads bit-for-bit (positions, UVs, indices, normals)', () => {
    const qA: [number, number, number, number] = [1, 3, 5, 2];
    const qB: [number, number, number, number] = [4, 0, 2, 6];
    const merged: PooledOverlayBucket = {
      verts: [], uvs: [], indices: [], quadCount: 0, material: mat, layer: 0, rank: 0, name: 'blendmerge',
    };
    TerrainRenderer.appendOverlayQuad(merged, 0, 0, 24, ...qA, 1, true);
    TerrainRenderer.appendOverlayQuad(merged, 48, 24, 24, ...qB, 3, false);
    const geom = OverlayMergePool.buildMergedGeometry([merged]);

    const a = OverlayMergePool.buildMergedGeometry([bucketOf(0, 0, qA, 1, true)]);
    const b = OverlayMergePool.buildMergedGeometry([bucketOf(48, 24, qB, 3, false)]);

    const pos = geom.getAttribute('position');
    expect(pos.count).toBe(8);
    const posA = a.getAttribute('position');
    const posB = b.getAttribute('position');
    for (let i = 0; i < 12; i++) {
      expect(pos.array[i]).toBe(posA.array[i]);
      expect(pos.array[12 + i]).toBe(posB.array[i]);
    }

    const uv = geom.getAttribute('uv');
    const uvA = a.getAttribute('uv');
    const uvB = b.getAttribute('uv');
    for (let i = 0; i < 8; i++) {
      expect(uv.array[i]).toBe(uvA.array[i]);
      expect(uv.array[8 + i]).toBe(uvB.array[i]);
    }

    // Second quad's indices are the first quad's pattern offset by 4
    const idx = geom.getIndex()!;
    expect(Array.from(idx.array.slice(0, 6))).toEqual(Array.from(a.getIndex()!.array));
    expect(Array.from(idx.array.slice(6))).toEqual(
      Array.from(b.getIndex()!.array).map((v) => v + 4),
    );

    // Quads share no vertices, so merged computeVertexNormals must equal
    // the per-quad normals exactly — no cross-quad smoothing.
    const n = geom.getAttribute('normal');
    const nA = a.getAttribute('normal');
    const nB = b.getAttribute('normal');
    for (let i = 0; i < 12; i++) {
      expect(n.array[i]).toBe(nA.array[i]);
      expect(n.array[12 + i]).toBe(nB.array[i]);
    }
  });

  it('cross-BLOCK merge concatenates per-block buckets with offset indices, bit-identical attributes', () => {
    const blockA = bucketOf(0, 0, [1, 3, 5, 2], 1, true);
    const blockB = bucketOf(192, 0, [4, 0, 2, 6], 3, false);
    const geom = OverlayMergePool.buildMergedGeometry([blockA, blockB]);
    const a = OverlayMergePool.buildMergedGeometry([blockA]);
    const b = OverlayMergePool.buildMergedGeometry([blockB]);
    expect(geom.getAttribute('position').count).toBe(8);
    for (let i = 0; i < 12; i++) {
      expect(geom.getAttribute('position').array[i]).toBe(a.getAttribute('position').array[i]);
      expect(geom.getAttribute('position').array[12 + i]).toBe(b.getAttribute('position').array[i]);
      expect(geom.getAttribute('normal').array[i]).toBe(a.getAttribute('normal').array[i]);
      expect(geom.getAttribute('normal').array[12 + i]).toBe(b.getAttribute('normal').array[i]);
    }
    expect(Array.from(geom.getIndex()!.array.slice(6))).toEqual(
      Array.from(b.getIndex()!.array).map((v) => v + 4),
    );
  });

  it('UV rotation is baked per quad, so rotated quads can share one bucket', () => {
    const merged: PooledOverlayBucket = {
      verts: [], uvs: [], indices: [], quadCount: 0, material: mat, layer: 0, rank: 0, name: 'blendmerge',
    };
    TerrainRenderer.appendOverlayQuad(merged, 0, 0, 24, 0, 0, 0, 0, 0, true);
    TerrainRenderer.appendOverlayQuad(merged, 24, 0, 24, 0, 0, 0, 0, 2, true);
    const uv = OverlayMergePool.buildMergedGeometry([merged]).getAttribute('uv');
    // land_uvs (row 0 = north): Rot0 SW=(0,1); Rot180 SW=(1,0)
    expect([uv.array[0], uv.array[1]]).toEqual([0, 1]);
    expect([uv.array[8], uv.array[9]]).toEqual([1, 0]);
  });
});

describe('road overlays pool across landblocks', () => {
  it('full-road cells from TWO landblocks become ONE opaque mesh with world-space verts', () => {
    const scene = new THREE.Scene();
    const tr = makeRenderer(scene);
    tr.buildRoadOverlays(roadTexMerge(0x06005000, 8), makeStubTextureManager());
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[0, 0xf], [9, 0xf]]) }), 0x1111ffff, 0, 0);
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[0, 0xf]]) }), 0x1211ffff, 192, 0);

    const meshes = tr.overlayMergePool.meshes;
    expect(meshes.length).toBe(1);
    const mesh = meshes[0];
    expect(mesh.name).toBe('roadmerge');
    expect(mesh.geometry.getAttribute('position').count).toBe(12); // 3 quads × 4
    // First block's cell 0 SW corner at (0,·,0); second block's at (192,·,0):
    // world-space vertices, identity mesh transform.
    const pos = mesh.geometry.getAttribute('position').array as Float32Array;
    expect(pos[0]).toBe(0);
    expect(pos[8 * 3]).toBe(192);
    expect(mesh.position.length()).toBe(0);
    expect(mesh.frustumCulled).toBe(false);
    const m = mesh.material as THREE.MeshLambertMaterial;
    expect(m.transparent).toBe(false);
    expect(m.polygonOffsetFactor).toBe(-1);
  });

  it('alpha-road cells sharing one alpha map merge into one transparent mesh', () => {
    const tr = makeRenderer();
    tr.buildRoadOverlays(roadTexMerge(0x06005000, 8), makeStubTextureManager());
    // mask 8 → rCodes [8, 0] → matches the rCode-8 map at rotation 0
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[3, 8], [12, 8]]) }), 0x1111ffff, 0, 0);
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[40, 8]]) }), 0x2222ffff, 192, 192);
    const meshes = tr.overlayMergePool.meshes;
    expect(meshes.length).toBe(1);
    expect(meshes[0].geometry.getAttribute('position').count).toBe(12);
    const m = meshes[0].material as THREE.MeshLambertMaterial;
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.alphaMap).toBeTruthy();
    expect(m.userData.sharedOverlayMaterial).toBe(true);
  });

  it('removing one landblock retires exactly its quads; removing the last removes the mesh', () => {
    const scene = new THREE.Scene();
    const tr = makeRenderer(scene);
    tr.buildRoadOverlays(roadTexMerge(0x06005000, 8), makeStubTextureManager());
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[0, 0xf], [9, 0xf]]) }), 0x1111ffff, 0, 0);
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[0, 0xf]]) }), 0x1211ffff, 192, 0);
    const pool = tr.overlayMergePool;
    expect(pool.meshes[0].geometry.getAttribute('position').count).toBe(12);

    pool.removeBlock(0x1111ffff);
    pool.flush();
    expect(pool.meshes.length).toBe(1);
    const pos = pool.meshes[0].geometry.getAttribute('position');
    expect(pos.count).toBe(4); // only the second block's quad remains
    expect(pos.array[0]).toBe(192);

    let disposed = 0;
    pool.meshes[0].geometry.addEventListener('dispose', () => disposed++);
    pool.removeBlock(0x1211ffff);
    pool.flush();
    expect(pool.meshes.length).toBe(0);
    expect(scene.children.length).toBe(0);
    expect(disposed).toBe(1);
  });
});

describe('blend overlays pool with layer order preserved', () => {
  it('same-overlay cells from two landblocks merge into one mesh with the tiled base texture', () => {
    const tr = makeRenderer();
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2]), makeStubTextureManager());
    // corners [A,A,A,B] → exactly one overlay layer of type B
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[0, [1, 1, 1, 2]]]) }), 0x1111ffff, 0, 0);
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[20, [1, 1, 1, 2]]]) }), 0x2222ffff, 384, 0);
    const meshes = tr.overlayMergePool.meshes;
    expect(meshes.length).toBe(1);
    expect(meshes[0].name).toBe('blendmerge');
    expect(meshes[0].geometry.getAttribute('position').count).toBe(8); // 2 quads
    const m = meshes[0].material as THREE.MeshLambertMaterial;
    expect(m.transparent).toBe(true);
    expect(m.polygonOffsetFactor).toBe(-2);
    // CORE.17.h.g.c.a — the shared per-cell clone shows the merge window's
    // worth of texels per cell (base_tex_size 512 >> 1 at Medium = 256 over
    // this 1-px stub = 256 repeats), sampled through the unrotated uv1.
    expect(m.map!.repeat.x * (m.map!.image as { width: number }).width).toBe(256);
    expect(m.map!.channel).toBe(1);
    expect(m.alphaMap!.channel).toBe(0);
  });

  it('a two-layer cell draws layer 0 BEFORE layer 1 from every camera (intra-cell stacking order)', () => {
    const tr = makeRenderer();
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2, 3]), makeStubTextureManager());
    // corners [A,A,B,C] → overlay layer 0 = type B, layer 1 = type C
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[10, [1, 1, 2, 3]]]) }), 0x1234ffff, 0, 0);
    const meshes = tr.overlayMergePool.meshes;
    expect(meshes.length).toBe(2);
    const [camA, camB] = cameras();
    const sorted = transparentDrawOrder(meshes, camA);
    expect(transparentDrawOrder(meshes, camB)).toEqual(sorted);
    const m0 = sorted[0].material as THREE.MeshLambertMaterial;
    const m1 = sorted[1].material as THREE.MeshLambertMaterial;
    // layer 0 (type 2) uses the type-2 base texture, layer 1 (type 3) the
    // type-3 one — distinct clones, layer 0 drawn first.
    expect(m0.map).not.toBe(m1.map);
    expect(m0).not.toBe(m1);
    expect(m0.userData.sharedOverlayMaterial).toBe(true);
    expect(m1.userData.sharedOverlayMaterial).toBe(true);
  });

  it('a LATE-ARRIVING lower-layer key still draws before the higher layer', () => {
    const tr = makeRenderer();
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2, 3]), makeStubTextureManager());
    const pool = tr.overlayMergePool;
    // Block 1 contributes ONLY a two-layer cell's buckets — but feed the
    // pool the layer-1 bucket first via a block that has only layer 1…
    const twoLayer = new Map<string, PooledOverlayBucket>();
    (tr as unknown as PrivateApi).collectTerrainBlendBuckets(
      makeLbMesh({ cornerTypes: new Map([[10, [1, 1, 2, 3]]]) }), 0x1111ffff, 0, 0, twoLayer);
    const layer1Only = new Map([...twoLayer].filter(([k]) => k.startsWith('b|1|')));
    expect(layer1Only.size).toBe(1);
    pool.addBlock(0x1111ffff, layer1Only);
    pool.flush();
    // …then a second block arrives whose bucket is layer 0.
    const layer0Only = new Map([...twoLayer].filter(([k]) => k.startsWith('b|0|')));
    expect(layer0Only.size).toBe(1);
    pool.addBlock(0x2222ffff, layer0Only);
    pool.flush();

    const meshes = pool.meshes;
    expect(meshes.length).toBe(2);
    // The layer-0 (rank-0) mesh draws first even though its key arrived
    // second (and so has the higher THREE id).
    const layer0Mat = layer0Only.values().next().value!.material;
    for (const cam of cameras()) expect(transparentDrawOrder(meshes, cam)[0].material).toBe(layer0Mat);
  });

  it('roadmerge meshes always draw AFTER blendmerge meshes (blend-under-road stacking)', () => {
    const tr = makeRenderer();
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2]), makeStubTextureManager());
    tr.buildRoadOverlays(roadTexMerge(0x06005000, 8), makeStubTextureManager());
    // Roads arrive first from block 1, blends later from block 2 — draw
    // order must still be blend before road.
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[3, 8]]) }), 0x1111ffff, 0, 0);
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[0, [1, 1, 1, 2]]]) }), 0x2222ffff, 192, 0);
    for (const cam of cameras()) {
      expect(transparentDrawOrder(tr.overlayMergePool.meshes, cam).map(m => m.name)).toEqual(['blendmerge', 'roadmerge']);
    }
  });

  it('BUG.road-flicker-running — roads stay over the blends as the camera moves between blocks whose bucket centres sit on opposite sides', () => {
    const tr = makeRenderer();
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2]), makeStubTextureManager());
    tr.buildRoadOverlays(roadTexMerge(0x06005000, 8), makeStubTextureManager());
    // Blend quads only in the SW block, road quads only in the NE block: the
    // merged buckets' bounding-sphere centres are ~270 m apart, so a
    // depth-keyed sort puts whichever is farther from the camera first.
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[0, [1, 1, 1, 2]]]) }), 0x1111ffff, 0, 0);
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[63, 8]]) }), 0x2222ffff, 192, 192);
    const meshes = tr.overlayMergePool.meshes;
    const [nearBlend, nearRoad] = [[-300, 150, -300], [700, 150, 700]].map(([x, y, z]) => {
      const c = new THREE.PerspectiveCamera(60, 1, 1, 5000);
      c.position.set(x, y, z);
      c.lookAt(200, 0, 200);
      return c;
    });
    for (const cam of [nearBlend, nearRoad]) {
      expect(transparentDrawOrder(meshes, cam).map(m => m.name)).toEqual(['blendmerge', 'roadmerge']);
    }
    // Every pool mesh sorts ahead of ordinary transparent objects (0) and
    // after the before-sky objects (renderOrder ≤ -40).
    for (const m of meshes) {
      expect(m.renderOrder).toBeLessThan(0);
      expect(m.renderOrder).toBeGreaterThan(-40);
    }
  });

  it('blend materials are shared across landblocks; renderer clear() disposes them once and empties the pool', () => {
    const scene = new THREE.Scene();
    const tr = makeRenderer(scene);
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2]), makeStubTextureManager());
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[0, [1, 1, 1, 2]]]) }), 0x1111ffff, 0, 0);
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[7, [1, 1, 1, 2]]]) }), 0x2222ffff, 192, 0);
    expect(tr.overlayMergePool.meshes.length).toBe(1); // shared material ⇒ one pooled mesh
    const mat = tr.overlayMergePool.meshes[0].material as THREE.Material;

    let disposed = 0;
    mat.addEventListener('dispose', () => disposed++);
    tr.clear();
    expect(disposed).toBe(1);
    expect(tr.overlayMergePool.meshes.length).toBe(0);
    expect(scene.children.length).toBe(0);
    // cache is empty afterwards — a later build would create a fresh material
    type Caches = { mergedBlendMaterials: Map<string, THREE.Material>; tiledBlendTextures: Map<number, THREE.Texture> };
    expect((tr as unknown as Caches).mergedBlendMaterials.size).toBe(0);
    expect((tr as unknown as Caches).tiledBlendTextures.size).toBe(0);
  });

  it('setLandscapeVisible hides existing pool meshes AND meshes flushed while hidden are created hidden', () => {
    const tr = makeRenderer();
    tr.buildTerrainBlendOverlays(blendTexMerge(0x06006000, [1, 2]), makeStubTextureManager());
    addBlendBlock(tr, makeLbMesh({ cornerTypes: new Map([[0, [1, 1, 1, 2]]]) }), 0x1111ffff, 0, 0);
    expect(tr.overlayMergePool.meshes[0].visible).toBe(true);
    tr.setLandscapeVisible(false);
    expect(tr.overlayMergePool.meshes[0].visible).toBe(false);
    // A block streamed in while sealed-interior-hidden must not flash in.
    addRoadBlock(tr, makeLbMesh({ roadMasks: new Map([[0, 0xf]]) }), 0x2222ffff, 192, 0);
    for (const m of tr.overlayMergePool.meshes) expect(m.visible).toBe(false);
    tr.setLandscapeVisible(true);
    for (const m of tr.overlayMergePool.meshes) expect(m.visible).toBe(true);
  });
});
