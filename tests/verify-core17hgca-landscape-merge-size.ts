/**
 * CORE.17.h.g.c.a — Landscape Texture Detail sets retail's TexMerge window,
 * not a texture downscale.
 *
 * Retail (acclient-decompiled.c, build ac1_sep13): Render::UpdateFromPreferences
 * @ 0054d850 → ImgTex::fLandTextureScale = level − 1 (0 → FULL_RES);
 * TexMerge::RestoreSurface @ 00504910 / MakeNewSurface @ 005049b0 build each
 * cell's texture at M = base_tex_size >> ImageShift[scale] (ImageShift
 * [0,1,2,4,8], floor min_tex_size 8), and ImgTex::TileCSI @ 0053e740 /
 * MergeTexture @ 0053e870 copy the 512-px terrain pixels into it 1:1 —
 * High 1024 = two tiles per cell, Medium 512 = one, Low / Very Low = the
 * top-left 256² / 64² corner once. MergeTexture rotates only the alpha map
 * and reads it nearest-neighbour.
 *
 * These tests drive the real TextureSamplerPrefs singleton through the real
 * TerrainRenderer material builders + OverlayMergePool and assert the
 * texels-per-cell each level produces, the crop / point-subsample images,
 * and the unrotated uv1 channel the overlay terrain/road textures sample.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  landscapeMergedSize, landscapeRepeatsPerCell, landscapeTerrainImageSize, cropRGBA, pointSubsampleRGBA,
  textureSamplerPrefs, EOL_REGION_BASE_TEX_SIZE, RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL, TEXTURE_DETAIL_VALUES,
} from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { OverlayMergePool, type PooledOverlayBucket } from '../packages/renderer/src/terrain/OverlayMergePool.js';
import type { LandblockMesh } from '../packages/renderer/src/terrain/LandblockMesh.js';
import type { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';
import type { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import type { TexMerge } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { DatDatabase, DatReader, SurfaceTexture, Texture } from '../packages/dat-parser/src/index.js';
import { openDat } from './_harness/dat.js';

const PORTAL_DAT = 'dat/client_portal.dat';
const LEVELS = [0, 1, 2, 3, 4];

/** A w×h RGBA image whose texel (x, y) encodes x and y. */
function coordImage(w: number, h: number): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x & 0xff; data[i + 1] = y & 0xff; data[i + 2] = (x >> 8) | ((y >> 8) << 4); data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** texel (x, y) of an RGBA image → [x, y] decoded from coordImage. */
function texelXY(img: { data: Uint8Array; width: number }, x: number, y: number): [number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i] | ((img.data[i + 2] & 0xf) << 8), img.data[i + 1] | ((img.data[i + 2] >> 4) << 8)];
}

/** A TextureManager stand-in that behaves like the real one for the terrain:
 *  512² colour textures registered as 'landscape' (one cached instance per
 *  GID) and 512² alpha maps from getRGBA. */
function stubTextureManager(): TextureManager {
  const cache = new Map<number, THREE.DataTexture>();
  return {
    getTexture: (gid: number) => {
      let tex = cache.get(gid);
      if (!tex) {
        const img = coordImage(512, 512);
        tex = new THREE.DataTexture(img.data, 512, 512, THREE.RGBAFormat);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        textureSamplerPrefs.register(tex, 'landscape', img);
        cache.set(gid, tex);
      }
      return tex;
    },
    // Alpha maps: a = x & 0xff, so a nearest subsample is recognisable.
    getRGBA: () => {
      const img = coordImage(512, 512);
      for (let i = 0; i < 512 * 512; i++) img.data[i * 4 + 3] = (i % 512) & 0xff;
      return img;
    },
  } as unknown as TextureManager;
}

function texMerge(): TexMerge {
  return {
    baseTexSize: EOL_REGION_BASE_TEX_SIZE,
    terrainDesc: [
      { terrainType: 1, terrainTex: { texGID: 0x05000101, texTiling: 2 } },
      { terrainType: 2, terrainTex: { texGID: 0x05000102, texTiling: 2 } },
      { terrainType: 0x20, terrainTex: { texGID: 0x05000120, texTiling: 2 } },
    ],
    cornerTerrainMaps: [{ tCode: 8, texGID: 0x05000200 }],
    sideTerrainMaps: [],
    roadMaps: [{ rCode: 8, roadTexGID: 0x05000300 }],
  } as unknown as TexMerge;
}

function lbMesh(opts: { roadMasks?: Map<number, number>; cornerTypes?: Map<number, number[]> }): LandblockMesh {
  const positions = new Float32Array(81 * 3);
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 9; row++) {
      const i = (col * 9 + row) * 3;
      positions[i] = col * 24; positions[i + 2] = row * 24;
    }
  }
  const cellRoadMasks = new Array(64).fill(0);
  const cellCornerTerrainTypes = new Array(256).fill(1);
  for (const [c, m] of opts.roadMasks ?? []) cellRoadMasks[c] = m;
  for (const [c, t] of opts.cornerTypes ?? []) for (let k = 0; k < 4; k++) cellCornerTerrainTypes[c * 4 + k] = t[k];
  return {
    geometry: { positions }, cellRoadMasks, cellCornerTerrainTypes, cellCornerRoadBits: new Array(256).fill(0),
  } as unknown as LandblockMesh;
}

type Private = {
  terrainMaterials: Map<number, THREE.MeshLambertMaterial>;
  collectRoadOverlayBuckets(lb: LandblockMesh, id: number, x: number, z: number, b: Map<string, PooledOverlayBucket>): void;
  collectTerrainBlendBuckets(lb: LandblockMesh, id: number, x: number, z: number, b: Map<string, PooledOverlayBucket>): void;
};

/** A renderer with all three TexMerge builders run + one road and one blend cell pooled. */
function buildRenderer(): { tr: TerrainRenderer; ground: THREE.MeshLambertMaterial; road: THREE.MeshLambertMaterial; blend: THREE.MeshLambertMaterial; roadMesh: THREE.Mesh; blendMesh: THREE.Mesh } {
  const tr = new TerrainRenderer(new THREE.Scene(), { clear: () => {}, getLoadedMeshes: () => new Map() } as unknown as TerrainManager);
  const tm = stubTextureManager();
  const merge = texMerge();
  tr.buildTerrainMaterials(merge.terrainDesc, tm, merge.baseTexSize);
  tr.buildTerrainBlendOverlays(merge, tm);
  tr.buildRoadOverlays(merge, tm);
  const p = tr as unknown as Private;
  const buckets = new Map<string, PooledOverlayBucket>();
  p.collectRoadOverlayBuckets(lbMesh({ roadMasks: new Map([[3, 8]]) }), 0x1111ffff, 0, 0, buckets);
  p.collectTerrainBlendBuckets(lbMesh({ cornerTypes: new Map([[5, [1, 1, 1, 2]]]) }), 0x1111ffff, 0, 0, buckets);
  tr.overlayMergePool.addBlock(0x1111ffff, buckets);
  tr.overlayMergePool.flush();
  const roadMesh = tr.overlayMergePool.meshes.find((m) => m.name === 'roadmerge')!;
  const blendMesh = tr.overlayMergePool.meshes.find((m) => m.name === 'blendmerge')!;
  return {
    tr,
    ground: p.terrainMaterials.get(1)!,
    road: roadMesh.material as THREE.MeshLambertMaterial,
    blend: blendMesh.material as THREE.MeshLambertMaterial,
    roadMesh, blendMesh,
  };
}

/** Texels of a map across one 24 m cell, given how many cells its UV 0..1 spans. */
function texelsPerCell(map: THREE.Texture, uvCells: number): number {
  return (map.repeat.x / uvCells) * (map.image as { width: number }).width;
}

afterEach(() => {
  textureSamplerPrefs.set({ landscapeTextureDetail: RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL });
});

describe('CORE.17.h.g.c.a — the TexMerge window per Landscape Texture Detail level', () => {
  it('M = base_tex_size >> ImageShift[level − 1]: Very High 1024, High 1024, Medium 512, Low 256, Very Low 64', () => {
    expect([...TEXTURE_DETAIL_VALUES].sort().map((l) => landscapeMergedSize(l))).toEqual([1024, 1024, 512, 256, 64]);
    expect(landscapeMergedSize(RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL)).toBe(512);
    // RestoreSurface floors the window at ImgTex::min_tex_size (8).
    expect(landscapeMergedSize(4, 64)).toBe(8);
    expect(landscapeMergedSize(3, 64)).toBe(16);
  });

  it('the 512-px terrain texture is copied 1:1: two repeats per cell at M 1024, one at 512, the top-left corner below that', () => {
    expect(LEVELS.map((l) => landscapeRepeatsPerCell(landscapeMergedSize(l), 512))).toEqual([2, 2, 1, 1, 1]);
    expect(LEVELS.map((l) => landscapeTerrainImageSize(landscapeMergedSize(l), 512))).toEqual([512, 512, 512, 256, 64]);
  });

  it('cropRGBA keeps the top-left window; pointSubsampleRGBA takes the first texel of each block; both return the source when nothing changes', () => {
    const src = coordImage(512, 512);
    const crop = cropRGBA(src, 64, 64);
    expect([crop.width, crop.height]).toEqual([64, 64]);
    expect(texelXY(crop, 0, 0)).toEqual([0, 0]);
    expect(texelXY(crop, 63, 17)).toEqual([63, 17]);
    const sub = pointSubsampleRGBA(src, 256, 256);
    expect([sub.width, sub.height]).toEqual([256, 256]);
    expect(texelXY(sub, 1, 0)).toEqual([2, 0]);
    expect(texelXY(sub, 255, 100)).toEqual([510, 200]);
    expect(cropRGBA(src, 512, 512)).toBe(src);
    expect(pointSubsampleRGBA(src, 1024, 1024)).toBe(src);
  });
});

describe('CORE.17.h.g.c.a — the real terrain materials draw M texels per cell at every level', () => {
  it('ground, blend-overlay and road textures all show M texels per 24 m cell; the default Medium draws the texture once per cell', () => {
    const { ground, road, blend } = buildRenderer();
    const perLevel = LEVELS.map((l) => {
      textureSamplerPrefs.set({ landscapeTextureDetail: l });
      return [texelsPerCell(ground.map!, 8), texelsPerCell(blend.map!, 1), texelsPerCell(road.map!, 1)];
    });
    expect(perLevel).toEqual([
      [1024, 1024, 1024], [1024, 1024, 1024], [512, 512, 512], [256, 256, 256], [64, 64, 64],
    ]);
    textureSamplerPrefs.set({ landscapeTextureDetail: RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL });
    // Medium: the whole 512² texture once per cell — the landblock mesh's UV
    // spans 8 cells, the overlay quads' one.
    expect(ground.map!.repeat.toArray()).toEqual([8, 8]);
    expect(blend.map!.repeat.toArray()).toEqual([1, 1]);
    expect(road.map!.repeat.toArray()).toEqual([1, 1]); // was the shared texture's 16 per cell
    expect((ground.map!.image as { width: number }).width).toBe(512);
    // High: two tiles per cell (TerrainTex.texTiling 2 at M 1024).
    textureSamplerPrefs.set({ landscapeTextureDetail: 1 });
    expect(ground.map!.repeat.toArray()).toEqual([16, 16]);
    expect(blend.map!.repeat.toArray()).toEqual([2, 2]);
  });

  it('below Medium the terrain textures are the unfiltered top-left window, the alpha maps nearest-subsampled; Medium restores the full-res arrays', () => {
    const { tr, ground, blend, road } = buildRenderer();
    const full = textureSamplerPrefs.fullResOf(ground.map!)!;
    textureSamplerPrefs.set({ landscapeTextureDetail: 3 }); // Low: M 256
    const img = ground.map!.image as { data: Uint8Array; width: number; height: number };
    expect([img.width, img.height]).toEqual([256, 256]);
    expect(texelXY(img, 255, 255)).toEqual([255, 255]); // copied, not averaged
    // The overlay clone keeps sharing the ground texture's GPU Source.
    // (the blend cell's overlay is terrain type 2).
    expect(blend.map!.source).toBe((tr as unknown as Private).terrainMaterials.get(2)!.map!.source);
    expect((blend.map!.image as { width: number }).width).toBe(256);
    const alpha = blend.alphaMap!.image as { data: Uint8Array; width: number; height: number };
    expect([alpha.width, alpha.height]).toEqual([256, 256]);
    expect((road.alphaMap!.image as { width: number }).width).toBe(256);
    // Alpha maps are built inverted into R (255 − a, a = source x): texel x
    // of the 256-px map is source texel 2x — never an average of 2x, 2x + 1.
    expect(alpha.data[1 * 4]).toBe(255 - 2);
    expect(alpha.data[200 * 4]).toBe(255 - (400 & 0xff));
    expect(alpha.data[(37 * 256 + 5) * 4]).toBe(255 - 10);

    textureSamplerPrefs.set({ landscapeTextureDetail: 4 }); // Very Low: M 64
    expect((ground.map!.image as { width: number }).width).toBe(64);
    expect(ground.map!.repeat.toArray()).toEqual([8, 8]); // the 64² corner once per cell

    textureSamplerPrefs.set({ landscapeTextureDetail: 2 });
    expect((ground.map!.image as { data: Uint8Array }).data).toBe(full.data);
    expect((blend.alphaMap!.image as { width: number }).width).toBe(512);
  });

  it('overlay terrain/road textures sample the unrotated uv1 channel; only the alpha map (uv) carries the rotation', () => {
    const { road, blend, roadMesh, blendMesh } = buildRenderer();
    expect(road.map!.channel).toBe(1);
    expect(blend.map!.channel).toBe(1);
    expect(road.alphaMap!.channel).toBe(0);
    expect(blend.alphaMap!.channel).toBe(0);
    for (const mesh of [roadMesh, blendMesh]) {
      const uv1 = mesh.geometry.getAttribute('uv1');
      expect(uv1.count).toBe(mesh.geometry.getAttribute('uv').count);
      expect(Array.from(uv1.array as Float32Array).slice(0, 8)).toEqual([0, 1, 1, 1, 0, 0, 1, 0]); // land_uvs at ROT_0: row 0 = north
    }
    // A rotated quad keeps rotated alpha UVs and unrotated uv1.
    const b: PooledOverlayBucket = { verts: [], uvs: [], indices: [], quadCount: 0, material: blend, layer: 0, rank: 0, name: 'blendmerge' };
    TerrainRenderer.appendOverlayQuad(b, 0, 0, 24, 0, 0, 0, 0, 2, true);
    const geom = OverlayMergePool.buildMergedGeometry([b]);
    expect(Array.from(geom.getAttribute('uv').array as Float32Array).slice(0, 2)).toEqual([1, 0]); // land_uvs[SW_Corner[ROT_180]]
    expect(Array.from(geom.getAttribute('uv1').array as Float32Array).slice(0, 2)).toEqual([0, 1]);
  });
});

describe.skipIf(!existsSync(PORTAL_DAT))('CORE.17.h.g.c.a — EoL RegionDesc 0x13000000 TexMerge', () => {
  let region: RegionDesc;
  let db: DatDatabase;
  beforeAll(() => {
    db = openDat(PORTAL_DAT);
    region = new RegionDesc(new DatReader(db.getFileData(0x13000000)!));
  });

  it('base_tex_size 1024 over single-level 512² terrain textures: High\'s window is exactly texTiling (2) tiles, Medium\'s exactly one', () => {
    const merge = region.terrainInfo.landSurfaces.texMerge!;
    expect(merge.baseTexSize).toBe(1024);
    for (const d of merge.terrainDesc) {
      const st = SurfaceTexture.read(new DatReader(db.getFileData(d.terrainTex.texGID)!));
      expect(st.textures.length).toBe(1);
      const tex = Texture.read(new DatReader(db.getFileData(st.textures[0])!));
      expect([tex.width, tex.height]).toEqual([512, 512]);
      expect(landscapeRepeatsPerCell(landscapeMergedSize(1, merge.baseTexSize), tex.width)).toBe(d.terrainTex.texTiling);
      expect(landscapeRepeatsPerCell(landscapeMergedSize(2, merge.baseTexSize), tex.width)).toBe(1);
    }
  });
});
