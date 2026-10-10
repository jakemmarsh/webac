/**
 * RELEASE.dat-streaming — "rebuild on arrival" (docs/dat-streaming.md §3.1):
 * nothing built across a streamed-DAT miss may stay broken once the file
 * lands. Caches skip results built across a miss (DatMiss epoch), and a
 * server object whose build missed is rebuilt (ServerObjectManager.rebuildMesh).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DatDatabase, type DatResidentSource } from '../packages/dat-parser/src/DatDatabase.js';
import { datMissEpoch, noDatMissSince, noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import type { CreateObjectData } from '../packages/network/src/MessageSerializer.js';

/** A resident-source DAT whose files can be withheld (a streamed DAT before arrival). */
function streamedPortal(files: Map<number, Uint8Array>, withheld: Set<number>) {
  const src: DatResidentSource = {
    kind: 'resident',
    header: { blockSize: 1024, dataSet: 1, dataSubset: 0, masterMapId: 0 },
    get: (id) => {
      if (withheld.has(id)) { noteDatMiss(); return null; }
      const f = files.get(id);
      return f ? f.slice().buffer : null;
    },
    has: (id) => files.has(id),
    listIds: () => [...files.keys()],
    get count() { return files.size; },
    sizeOf: (id) => files.get(id)?.byteLength ?? -1,
  };
  return new DatDatabase(src);
}

/** Surface 0x08000001: Base1Image (type 0x2) over SurfaceTexture 0x05000001, no palette. */
function surfaceBytes(): Uint8Array {
  const b = new Uint8Array(4 + 4 + 4 + 4 * 3);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x2, true); // SurfaceType.Base1Image
  dv.setUint32(4, 0x05000001, true); // OrigTextureId
  dv.setUint32(8, 0, true); // OrigPaletteId
  dv.setFloat32(12, 0, true); dv.setFloat32(16, 0, true); dv.setFloat32(20, 1, true); // translucency, luminosity, diffuse
  return b;
}
/** SurfaceTexture 0x05000001 → Texture 0x06000001. */
function surfaceTextureBytes(): Uint8Array {
  const b = new Uint8Array(4 + 4 + 1 + 4 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x05000001, true); dv.setUint32(4, 0, true); b[8] = 0; dv.setUint32(9, 1, true); dv.setUint32(13, 0x06000001, true);
  return b;
}
/** Texture 0x06000001: 2×2 A8R8G8B8. */
function textureBytes(): Uint8Array {
  const b = new Uint8Array(24 + 16);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x06000001, true); dv.setUint32(4, 0, true); dv.setUint32(8, 2, true); dv.setUint32(12, 2, true);
  dv.setUint32(16, 21, true); dv.setUint32(20, 16, true);
  b.fill(0xff, 24);
  return b;
}

describe('DatMiss epoch', () => {
  it('moves only on a streamed miss', () => {
    const e = datMissEpoch();
    expect(noDatMissSince(e)).toBe(true);
    noteDatMiss();
    expect(noDatMissSince(e)).toBe(false);
  });
});

describe('MaterialFactory across a streamed-DAT miss', () => {
  it('a material built while its texture was not resident is not cached; the rebuild after arrival is textured and cached', () => {
    const files = new Map<number, Uint8Array>([[0x08000001, surfaceBytes()], [0x05000001, surfaceTextureBytes()], [0x06000001, textureBytes()]]);
    const withheld = new Set([0x06000001]);
    const portal = streamedPortal(files, withheld);
    const mf = new MaterialFactory(portal, new TextureManager(portal, 64, 64, null));
    const first = mf.getMaterial(0x08000001) as THREE.MeshLambertMaterial;
    expect(first.map ?? null).toBeNull();
    // Arrival.
    withheld.clear();
    const second = mf.getMaterial(0x08000001) as THREE.MeshLambertMaterial;
    expect(second).not.toBe(first);
    expect(second.map).toBeTruthy();
    expect(mf.getMaterial(0x08000001)).toBe(second); // now cached
  });

  it('with whole DATs (no miss) the first material is cached as before', () => {
    const files = new Map<number, Uint8Array>([[0x08000001, surfaceBytes()], [0x05000001, surfaceTextureBytes()], [0x06000001, textureBytes()]]);
    const portal = streamedPortal(files, new Set());
    const mf = new MaterialFactory(portal, new TextureManager(portal, 64, 64, null));
    expect(mf.getMaterial(0x08000001)).toBe(mf.getMaterial(0x08000001));
  });
});

describe('ServerObjectManager.rebuildMesh', () => {
  function data(overrides: Partial<CreateObjectData> = {}): CreateObjectData {
    return {
      guid: 0x80001234, name: 'Drudge', weenieClassId: 1, itemType: 0,
      position: { landblock: 0xA9B40102, x: 10, y: 20, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
      setupId: 0x02000123, motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0,
      currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
      uiEffects: 0, usable: 0, useRadius: 0.6, velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1,
      translucency: 0, defaultScript: 0, defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
      ...overrides,
    } as CreateObjectData;
  }

  it('an object whose Setup was not resident (no mesh) is re-created at its latest position once it is', () => {
    let resident = false;
    let builds = 0;
    const smr = { createSetupMeshWithOverrides: () => { builds++; return resident ? new THREE.Group() : null; }, loadSetupModel: () => null };
    const scene = new THREE.Scene();
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, scene);
    const d = data();
    som.createObject(d);
    expect(som.getObject(d.guid)?.mesh).toBeNull();
    resident = true;
    som.rebuildMesh(d.guid, d);
    const mesh = som.getObject(d.guid)?.mesh;
    expect(mesh).toBeTruthy();
    expect(scene.children).toContain(mesh);
    expect(builds).toBe(2);
  });

  it('a built mesh is redone through the ObjDesc path (same appearance, sequence kept)', () => {
    let builds = 0;
    const smr = { createSetupMeshWithOverrides: () => { builds++; return new THREE.Group(); }, loadSetupModel: () => null };
    const scene = new THREE.Scene();
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, scene);
    const d = data({ timestamps: [0, 0, 0, 0, 0, 0, 0, 0, 7] as never });
    som.createObject(d);
    const before = som.getObject(d.guid)!.mesh;
    const seq = som.getObject(d.guid)!.lastVisualDescSeq;
    som.rebuildMesh(d.guid, d);
    const after = som.getObject(d.guid)!.mesh;
    expect(builds).toBe(2);
    expect(after).not.toBe(before);
    expect(scene.children).toContain(after);
    expect(scene.children).not.toContain(before);
    expect(som.getObject(d.guid)!.lastVisualDescSeq).toBe(seq);
  });
});
