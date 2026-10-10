/**
 * ASSESS: TerrainRenderer's road/terrain alpha-texture caches were unbounded
 * Maps of THREE.DataTextures (fresh-eyes audit 2026-06-10 §performance).
 * They are now 128-entry LRU backstops that dispose on evict. RegionDesc's
 * TexMerge only defines a few dozen alpha maps, so in practice the cap is
 * never hit — these tests verify both regimes against the real class:
 * normal population stays fully cached; pathological population stays
 * bounded and disposes the evicted GPU textures.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TerrainRenderer } from '@ac/renderer/terrain/TerrainRenderer.js';
import type { TerrainManager } from '@ac/renderer/terrain/TerrainManager.js';
import type { TextureManager } from '@ac/renderer/models/TextureManager.js';
import type { TexMerge, RoadAlphaMap, TerrainAlphaMap } from '@ac/dat-parser/file-types/RegionDesc.js';

function makeRenderer(): TerrainRenderer {
  return new TerrainRenderer(new THREE.Scene(), {} as unknown as TerrainManager);
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

function makeTexMerge(roadGids: number[], terrainGids: number[]): TexMerge {
  return {
    baseTexSize: 512,
    terrainDesc: [],
    landtexList: [],
    cornerTerrainMaps: terrainGids.map((gid) => ({
      tCode: 8,
      tex: { texGID: gid, texTiling: 1 },
      texGID: gid,
    })) as unknown as TerrainAlphaMap[],
    sideTerrainMaps: [],
    roadMaps: roadGids.map((gid) => ({
      rCode: 8,
      roadTexGID: gid,
    })) as unknown as RoadAlphaMap[],
  } as unknown as TexMerge;
}

type PrivateCaches = {
  roadAlphaTextures: { size: number; has(k: number): boolean };
  terrainAlphaTextures: { size: number; has(k: number): boolean };
};

describe('TerrainRenderer alpha-texture caches — bounded LRU backstop', () => {
  it('a realistic RegionDesc population (dozens of maps) is fully retained', () => {
    const tr = makeRenderer();
    const roadGids = Array.from({ length: 32 }, (_, i) => 0x06005000 + i);
    const terrainGids = Array.from({ length: 40 }, (_, i) => 0x06006000 + i);
    tr.buildRoadOverlays(makeTexMerge(roadGids, []), makeStubTextureManager());
    tr.buildTerrainBlendOverlays(makeTexMerge([], terrainGids), makeStubTextureManager());

    const caches = tr as unknown as PrivateCaches;
    expect(caches.roadAlphaTextures.size).toBe(32);
    expect(caches.terrainAlphaTextures.size).toBe(40);
    for (const gid of roadGids) expect(caches.roadAlphaTextures.has(gid)).toBe(true);
    for (const gid of terrainGids) expect(caches.terrainAlphaTextures.has(gid)).toBe(true);
  });

  it('road alpha cache never exceeds 128 entries and disposes evicted textures', () => {
    const tr = makeRenderer();
    let disposed = 0;
    const origDispose = THREE.DataTexture.prototype.dispose;
    THREE.DataTexture.prototype.dispose = function (this: THREE.DataTexture) {
      disposed++;
      return origDispose.call(this);
    };
    try {
      const gids = Array.from({ length: 150 }, (_, i) => 0x06005000 + i);
      tr.buildRoadOverlays(makeTexMerge(gids, []), makeStubTextureManager());
      const caches = tr as unknown as PrivateCaches;
      expect(caches.roadAlphaTextures.size).toBeLessThanOrEqual(128);
      // 150 inserted, 128 retained → 22 evicted-and-disposed
      expect(disposed).toBe(150 - 128);
      // the oldest gids were evicted; the newest survive
      expect(caches.roadAlphaTextures.has(0x06005000)).toBe(false);
      expect(caches.roadAlphaTextures.has(0x06005000 + 149)).toBe(true);
    } finally {
      THREE.DataTexture.prototype.dispose = origDispose;
    }
  });

  it('terrain alpha cache never exceeds 128 entries and disposes evicted textures', () => {
    const tr = makeRenderer();
    let disposed = 0;
    const origDispose = THREE.DataTexture.prototype.dispose;
    THREE.DataTexture.prototype.dispose = function (this: THREE.DataTexture) {
      disposed++;
      return origDispose.call(this);
    };
    try {
      const gids = Array.from({ length: 140 }, (_, i) => 0x06006000 + i);
      tr.buildTerrainBlendOverlays(makeTexMerge([], gids), makeStubTextureManager());
      const caches = tr as unknown as PrivateCaches;
      expect(caches.terrainAlphaTextures.size).toBeLessThanOrEqual(128);
      expect(disposed).toBe(140 - 128);
    } finally {
      THREE.DataTexture.prototype.dispose = origDispose;
    }
  });
});
