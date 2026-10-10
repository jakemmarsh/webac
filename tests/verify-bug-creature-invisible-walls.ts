/**
 * BUG.creature-invisible-walls — "I ran into invisible walls near my corpse /
 * that mob". Two causes, both fixed:
 *  1. TransparentHook values are TRANSLUCENCY (TransparentHook::Execute
 *     @ 00526c30 → CPhysicsObj::SetTranslucency2): the spawn's Create script
 *     (0x33000232, 1 → 0 over 1 s) fades IN. Read as opacity it faded every
 *     spawned creature OUT to invisible while it kept blocking
 *     (verify-physics-script-player.ts covers the tween).
 *  2. What blocks us is ACE FindObjCollisions (PhysicsObj.cs:381-455):
 *     ethereal objects and non-PK players don't; the shape is the Setup's
 *     cylspheres/spheres × scale, not the bounding Radius; a creature created
 *     already dead doesn't.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { ObjectDescriptionFlag, PhysicsState } from '@ac/shared';
import { DatDatabase, DatReader, SetupModel } from '@ac/dat-parser';
import { creatureBlockRadius, blocksLocalPlayer } from '../packages/renderer/src/world/CreatureCollision.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

const P = ObjectDescriptionFlag.Player, PK = ObjectDescriptionFlag.PlayerKiller, PKL = ObjectDescriptionFlag.PkLiteStatus;

describe('blocksLocalPlayer (FindObjCollisions exemption + ethereal)', () => {
  it('a creature blocks; an ethereal one does not', () => {
    expect(blocksLocalPlayer({ physicsState: 0x408, objectDescFlags: 0x10 }, P)).toBe(true);
    expect(blocksLocalPlayer({ physicsState: 0x408 | PhysicsState.Ethereal, objectDescFlags: 0x10 }, P)).toBe(false);
  });
  it('players walk through each other unless both PK or both PK-Lite', () => {
    expect(blocksLocalPlayer({ physicsState: 0x400408, objectDescFlags: P }, P)).toBe(false);
    expect(blocksLocalPlayer({ physicsState: 0, objectDescFlags: P | PK }, P)).toBe(false);
    expect(blocksLocalPlayer({ physicsState: 0, objectDescFlags: P | PK }, P | PK)).toBe(true);
    expect(blocksLocalPlayer({ physicsState: 0, objectDescFlags: P | PKL }, P | PKL)).toBe(true);
    expect(blocksLocalPlayer({ physicsState: 0, objectDescFlags: P | PKL }, P | PK)).toBe(false);
  });
});

describe('creatureBlockRadius', () => {
  it('widest cylsphere, else widest sphere, × scale; nothing → walk-through', () => {
    expect(creatureBlockRadius({ cylSpheres: [{ radius: 0.3 }, { radius: 0.5 }], spheres: [{ radius: 2 }] }, 2)).toBeCloseTo(1.0);
    expect(creatureBlockRadius({ cylSpheres: [], spheres: [{ radius: 0.436 }] }, 1)).toBeCloseTo(0.436);
    expect(creatureBlockRadius({ cylSpheres: [], spheres: [] }, 1)).toBe(0);
    expect(creatureBlockRadius(null, 1)).toBe(0);
  });
});

describe('ServerObjectManager.getBlockersNear', () => {
  const setup = { radius: 0.62, height: 1.53, cylSpheres: [], spheres: [{ radius: 0.436 }, { radius: 0.436 }] };
  function som() {
    const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => setup };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
    m.setPlayerGuid(0x50000001);
    return m;
  }
  const data = (guid: number, over: Record<string, unknown> = {}) => ({
    guid, name: 'x', weenieClassId: 1, itemType: 0x10, position: { landblock: 0xA9B40017, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 }, setupId: 0x020007dd, motionTableId: 0, iconId: 0,
    physicsState: 0x408, objectDescFlags: 0x10, radarColor: 0, radarBehavior: 0, basePalette: 0, subPalettes: [],
    textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0,
    velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
    iconOverlayId: 0, iconUnderlayId: 0, ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  it('a drudge blocks with its sphere radius (melee still uses the Setup radius)', () => {
    const m = som();
    m.createObject(data(0x50000001, { objectDescFlags: P }));
    const d = m.createObject(data(0x80000001))!;
    expect(d.collisionRadius).toBeCloseTo(0.62);
    const b = m.getBlockersNear(d.worldX, d.worldZ, 100);
    expect(b).toHaveLength(1);
    expect(b[0].collisionRadius).toBeCloseTo(0.436);
  });
  it('scaled creatures block wider; other non-PK players and ethereal creatures not at all', () => {
    const m = som();
    m.createObject(data(0x50000001, { objectDescFlags: P }));
    const d = m.createObject(data(0x80000002, { objScale: 2 }))!;
    m.createObject(data(0x50000009, { objectDescFlags: P, physicsState: 0x400408 }));
    m.createObject(data(0x80000003, { physicsState: 0x408 | PhysicsState.Ethereal }));
    const b = m.getBlockersNear(d.worldX, d.worldZ, 100);
    expect(b.map((x) => +x.collisionRadius.toFixed(3))).toEqual([0.872]);
  });
});

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
describe.skipIf(!existsSync(PORTAL))('EoL Setups: blocking radius < bounding radius', () => {
  let db: DatDatabase;
  beforeAll(() => { const b = readFileSync(PORTAL); db = new DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); });
  it('drudge 0x020007DD blocks at 0.436 m, not its 0.617 m Setup radius', () => {
    const s = new SetupModel(new DatReader(db.getFileData(0x020007dd)!));
    expect(s.radius).toBeCloseTo(0.617, 3);
    expect(creatureBlockRadius(s, 1)).toBeCloseTo(0.436, 3);
  });
});
