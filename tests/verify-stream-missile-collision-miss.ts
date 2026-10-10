/**
 * STREAM.missile-collision-caches-miss — createServerObjectMissileSweep keeps
 * one collision per object, rebuilt only when the object moves. With DAT
 * streaming, the object's physics model can be null on the first sweep (its
 * GfxObj physics BSP not resident yet); that null was kept, so arrows and
 * bolts passed through a door or chest that never moves until it was
 * re-created. A model built across a streamed miss is no longer kept.
 */
import { describe, it, expect } from 'vitest';
import { createServerObjectMissileSweep, type ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';

const cylModel = (radius: number, height: number): ObjectPhysicsModel => ({
  parts: [], hasPhysicsBSP: false, cylSpheres: [{ origin: { x: 0, y: 0, z: 0 }, radius, height }], spheres: [],
  sortingSphere: { origin: { x: 0, y: 0, z: height / 2 }, radius: Math.max(radius, height / 2) },
});

const chest = {
  guid: 0x701f6011, setupId: 0x02000abc, worldX: 100, worldY: 0, worldZ: 50,
  mesh: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1 } },
};
// An arrow flying north through the chest (AC axes: x east, y north, z up).
const from = { x: 100, y: 40, z: 1 }, to = { x: 100, y: 60, z: 1 };

describe('server-object missile collision under streaming', () => {
  it('a physics model missed on the first sweep is built on the next one', () => {
    let resident = false;
    const physics = (): ObjectPhysicsModel | null => {
      if (!resident) { noteDatMiss(); return null; }
      return cylModel(0.6, 3);
    };
    const { sweep } = createServerObjectMissileSweep(physics);
    expect(sweep(chest, from, to, 0.05)).toBeNull(); // not resident: passes through this time
    resident = true;
    const hit = sweep(chest, from, to, 0.05);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeGreaterThan(0);
    expect(hit!.t).toBeLessThan(1);
  });

  it('a model built without a miss is kept (not rebuilt) while the object stays put', () => {
    let builds = 0;
    const { sweep } = createServerObjectMissileSweep(() => { builds++; return cylModel(0.6, 3); });
    sweep(chest, from, to, 0.05);
    sweep(chest, from, to, 0.05);
    expect(builds).toBe(1);
  });
});
