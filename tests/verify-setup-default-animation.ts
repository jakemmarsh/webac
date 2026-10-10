/**
 * BUG.setup-default-animation-never-played — CPartArray::InitDefaults
 * @ 00518980 (from SetSetupID, every object) loops a Setup's
 * default_anim_id (frames 0..-1 at 30 fps) when the object has no motion
 * table. Ours animated only through a motion table, so frost / lightning /
 * force bolts, whirling blades, house signs and flags stood still.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import type { CreateObjectData } from '@ac/network';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);
/** The frost bolt's DefaultAnimation (45 frames). */
const FROST_BOLT_ANIM = 0x03000623;

function data(guid: number, over: Partial<CreateObjectData> = {}): CreateObjectData {
  return {
    guid, name: 'Sign', weenieClassId: 1, itemType: 0x80,
    position: { landblock: 0xA9B40017, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 },
    setupId: 0x02000999, motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, useRadius: 0.6,
    velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
    iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 5],
    ...over,
  } as CreateObjectData;
}

describe.skipIf(!hasDat)('Setup DefaultAnimation loops on an object with no motion table', () => {
  let db: DatDatabase;
  let anim: Animation;
  beforeAll(() => {
    db = openDat('dat/client_portal.dat');
    anim = new Animation(new DatReader(db.getFileData(FROST_BOLT_ANIM)!));
  });

  function makeSOM(defaultAnimation: number, defaultMotionTable = 0) {
    const setup = { defaultAnimation, defaultMotionTable, lights: undefined };
    const som = new ServerObjectManager({ loadSetupModel: () => setup } as never, {} as never, { add: () => {}, remove: () => {} } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => {
      const g = new THREE.Group();
      for (let i = 0; i < anim.numParts; i++) { const p = new THREE.Group(); p.name = `part_${i}`; g.add(p); }
      return g;
    };
    som.setPortalDb(db);
    return som;
  }

  it('plays at 30 fps from frame 0, looping, and poses the parts', () => {
    const som = makeSOM(FROST_BOLT_ANIM);
    const o = som.createObject(data(0x7301))!;
    expect(som.defaultAnimationFrame(0x7301)).toBe(0);
    som.updateAnimations(10 / 30);
    expect(som.defaultAnimationFrame(0x7301)).toBeCloseTo(10, 5);
    const f = anim.partFrames[10].frames[0];
    const p0 = o.mesh!.children[0];
    expect(p0.position.x).toBeCloseTo(f.origin.x, 5);
    expect(p0.position.y).toBeCloseTo(f.origin.z, 5);
    // past the last frame it wraps
    som.updateAnimations((anim.numFrames - 10 + 2) / 30);
    expect(som.defaultAnimationFrame(0x7301)!).toBeLessThan(5);
  });

  it('stands still while the object is out of the world', () => {
    const som = makeSOM(FROST_BOLT_ANIM);
    som.createObject(data(0x7302, { position: null }));
    som.updateAnimations(5 / 30);
    expect(som.defaultAnimationFrame(0x7302)).toBe(0);
  });

  it('a Setup with no DefaultAnimation gets no loop', () => {
    const som = makeSOM(0);
    som.createObject(data(0x7303));
    expect(som.defaultAnimationFrame(0x7303)).toBeNull();
  });
});
