/**
 * BUG.watersurface-plane-shows-through-sea-level-land — retail has no water
 * plane; water is the landscape mesh itself.
 *
 * The EoL client textures every landscape cell through LandSurf::SelectTerrain
 * @ 00503070 → TexMerge::MakeNewSurface @ 005049b0 (an opaque SH_TEXMERGE
 * custom surface built from the RegionDesc TMTerrainDesc textures), water
 * terrain types included. TERRAIN_SURF_CHAR (globals.tsv: 1 for indices
 * 16-20, the water types) is read only by physics — CLandBlockStruct::
 * CalcCellWater @ 00531550, calc_water_depth @ 005315f0, CLandCell::
 * find_terrain — never by the renderer; CRegionDesc::UnPack @ 004ff440 never
 * allocates its `water_info`. Our old WaterSurface (an invented 0x1a4a6a
 * MeshPhong sheet at y=0 with sine waves) poked through sea-level land at
 * Beach Fort and is gone.
 *
 * These tests drive the real TerrainRenderer over a real LandblockMesh.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import * as THREE from 'three';
import { TerrainRenderer } from '@ac/renderer/terrain/TerrainRenderer.js';
import { LandblockMesh } from '@ac/renderer/terrain/LandblockMesh.js';
import type { TerrainManager } from '@ac/renderer/terrain/TerrainManager.js';
import type { TextureManager } from '@ac/renderer/models/TextureManager.js';
import type { TMTerrainDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import { isWaterTerrainType } from '@ac/shared';
import { openDat } from './_harness/dat.js';

/** The decomp's TERRAIN_SURF_CHAR (reference/client-eol/symbols/globals.tsv, 0x7c9250). */
const TERRAIN_SURF_CHAR = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const WATER_DEEP_SEA = 0x14;
const GRASS = 0x01;
const LB_ID = 0x7f7fffff;

/** Stub TextureManager recording which GID each returned texture stands for. */
function makeTextureManager(): { tm: TextureManager; gidOf: Map<THREE.Texture, number> } {
  const gidOf = new Map<THREE.Texture, number>();
  const tm = {
    getTexture: (gid: number) => {
      // 512² like every EoL terrain texture (the per-cell repeat is M / 512, CORE.17.h.g.c.a).
      const px = new Uint8Array(512 * 512 * 4);
      for (let i = 0; i < px.length; i += 4) { px[i] = 10; px[i + 1] = 40; px[i + 2] = 90; px[i + 3] = 255; }
      const tex = new THREE.DataTexture(px, 512, 512, THREE.RGBAFormat);
      gidOf.set(tex, gid);
      return tex;
    },
  } as unknown as TextureManager;
  return { tm, gidOf };
}

/** A shore landblock: the western 4 vertex columns water (height byte 0), the rest grass — also at height 0 (sea-level land). */
function shoreLandblock(): LandblockMesh {
  const terrain: number[] = [];
  const heights: number[] = [];
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 9; row++) {
      terrain.push(((col < 4 ? WATER_DEEP_SEA : GRASS) << 2));
      heights.push(col < 6 ? 0 : 3);
    }
  }
  const landHeightTable = new Float32Array(256);
  for (let i = 0; i < 256; i++) landHeightTable[i] = i * 2;
  return new LandblockMesh({ heights, terrain, landHeightTable, landblockId: LB_ID });
}

function descs(entries: [number, number][]): TMTerrainDesc[] {
  return entries.map(([terrainType, texGID]) => ({ terrainType, terrainTex: { texGID, texTiling: 2 } })) as unknown as TMTerrainDesc[];
}

function renderShore(scene: THREE.Scene, gids: [number, number][]) {
  const lbMesh = shoreLandblock();
  const manager = {
    clear: () => {},
    update: () => ({ loaded: [LB_ID], unloaded: [] }),
    getMesh: () => lbMesh,
  } as unknown as TerrainManager;
  const { tm, gidOf } = makeTextureManager();
  const tr = new TerrainRenderer(scene, manager);
  tr.buildTerrainMaterials(descs(gids), tm);
  // The viewer stands on the block, so it draws at full resolution
  // (DECOMP.terrain-lod).
  tr.update(0x7f * 192 + 1, 0x7f * 192 + 1);
  return { tr, lbMesh, gidOf };
}

describe('water terrain is drawn as the landscape mesh, not a sea-level plane', () => {
  it('water terrain types are exactly TERRAIN_SURF_CHAR\'s WATER entries (16-20)', () => {
    for (let t = 0; t < 32; t++) expect(isWaterTerrainType(t)).toBe(TERRAIN_SURF_CHAR[t] === 1);
  });

  it('a shore landblock adds only its landscape mesh: no water plane, nothing translucent', () => {
    const scene = new THREE.Scene();
    renderShore(scene, [[GRASS, 0x05000001], [WATER_DEEP_SEA, 0x0500106b]]);
    expect(scene.children).toHaveLength(1);
    expect(scene.getObjectByName('water_surface')).toBeUndefined();
    const mesh = scene.children[0] as THREE.Mesh;
    const mats = mesh.material as THREE.Material[];
    for (const m of mats) {
      expect(m.transparent).toBe(false);
      expect(m.depthWrite).toBe(true);
      expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    }
  });

  it('the water cells draw with the water type\'s own TMTerrainDesc texture, at the terrain height', () => {
    const scene = new THREE.Scene();
    const { lbMesh, gidOf } = renderShore(scene, [[GRASS, 0x05000001], [WATER_DEEP_SEA, 0x0500106b]]);
    const mesh = scene.children[0] as THREE.Mesh;
    const mats = mesh.material as THREE.MeshLambertMaterial[];
    const geom = mesh.geometry;
    const index = geom.getIndex()!.array;
    const pos = geom.getAttribute('position');
    // Every cell's triangles land in the group whose material carries that cell's terrain texture.
    const seenWater = new Set<number>();
    for (const g of geom.groups) {
      const gid = gidOf.get(mats[g.materialIndex!].map!);
      for (let i = g.start; i < g.start + g.count; i++) {
        const v = index[i];
        const x = pos.getX(v);
        if (gid === 0x0500106b) {
          seenWater.add(v);
          // water cells span vertex columns 0..4 (the SW corner decides the cell type)
          expect(x).toBeLessThanOrEqual(4 * 24);
          expect(pos.getY(v)).toBe(0); // the terrain vertex height itself, no displacement
        }
      }
    }
    expect(seenWater.size).toBe(5 * 9); // columns 0-4 × 9 rows
    expect(lbMesh.cellTerrainTypes.filter(isWaterTerrainType)).toHaveLength(32);
  });

  it('the water texture tiles per cell like every terrain texture and does not scroll', () => {
    const scene = new THREE.Scene();
    const { gidOf } = renderShore(scene, [[WATER_DEEP_SEA, 0x0500106b]]);
    const mesh = scene.children[0] as THREE.Mesh;
    const map = (mesh.material as THREE.MeshLambertMaterial[])[0].map!;
    expect(gidOf.get(map)).toBe(0x0500106b);
    // CORE.17.h.g.c.a — at the retail default Medium (TexMerge window 512)
    // the 512-px texture is drawn once per cell: the landblock UV spans 8.
    expect(map.repeat.x).toBe(8);
    expect(map.repeat.y).toBe(8);
    expect(map.offset.x).toBe(0);
    expect(map.offset.y).toBe(0);
  });

  it('the invented WaterSurface module no longer exists', async () => {
    const path = '../packages/renderer/src/effects/' + 'WaterSurface.js';
    await expect(import(/* @vite-ignore */ path)).rejects.toThrow();
  });
});

// ── DAT-backed: the real region gives every water type its own texture ──
const PORTAL_DAT = 'dat/client_portal.dat';

describe.skipIf(!existsSync(PORTAL_DAT))('real RegionDesc 0x13000000 water terrain textures', () => {
  let terrainDesc: TMTerrainDesc[];
  let hasFile: (id: number) => boolean;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const db = openDat(PORTAL_DAT);
    const rd = new RegionDesc(new DatReader(db.getFileData(0x13000000)!));
    terrainDesc = rd.terrainInfo.landSurfaces.texMerge!.terrainDesc;
    hasFile = (id) => db.getFileData(id) != null;
  });

  it('types 16-20 each have a TMTerrainDesc whose SurfaceTexture exists in the portal DAT', () => {
    for (let t = 0x10; t <= 0x14; t++) {
      const d = terrainDesc.find(x => x.terrainType === t);
      expect(d, `terrain type ${t}`).toBeDefined();
      expect(d!.terrainTex.texGID >>> 24).toBe(0x05);
      expect(hasFile(d!.terrainTex.texGID)).toBe(true);
    }
  });

  it('buildTerrainMaterials over the real list binds each water type to its DAT texture, opaque', () => {
    const scene = new THREE.Scene();
    const { tm, gidOf } = makeTextureManager();
    const tr = new TerrainRenderer(scene, { clear: () => {} } as unknown as TerrainManager);
    tr.buildTerrainMaterials(terrainDesc, tm);
    const mats = (tr as unknown as { terrainMaterials: Map<number, THREE.MeshLambertMaterial> }).terrainMaterials;
    for (let t = 0x10; t <= 0x14; t++) {
      const m = mats.get(t)!;
      expect(m.transparent).toBe(false);
      expect(gidOf.get(m.map!)).toBe(terrainDesc.find(x => x.terrainType === t)!.terrainTex.texGID);
    }
    expect(scene.children).toHaveLength(0);
  });
});
