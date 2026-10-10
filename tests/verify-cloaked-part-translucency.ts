/**
 * CPhysicsPart::SetTranslucency @ 0050e670 opens with
 * `physobj == NULL || (physobj->state & 0x100000) == 0`: a Cloaked
 * (PhysicsState 0x100000) object's parts ignore every translucency change —
 * server Translucency, a PhysicsScript fade, a TransparentPart hook — while
 * CPhysicsObj::SetTranslucencyInternal still records the object's value.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import {
  setPartTranslucency, setObjectTranslucency, PHYSICS_STATE_KEY, TRANSLUCENCY_KEY,
} from '../packages/renderer/src/models/ObjectTranslucency.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

function figure(): { root: THREE.Group; part: THREE.Group; mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial } {
  const root = new THREE.Group();
  const part = new THREE.Group(); part.name = 'part_0';
  const mat = new THREE.MeshLambertMaterial({ opacity: 1, transparent: false });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  part.add(mesh);
  root.add(part);
  return { root, part, mesh, mat };
}
const matOf = (m: THREE.Mesh) => m.material as THREE.Material;

describe('Cloaked objects keep their parts as they are (CPhysicsPart::SetTranslucency guard)', () => {
  it('a Cloaked object: no fade, no no-draw — but the object value is recorded', () => {
    const { root, mesh } = figure();
    root.userData[PHYSICS_STATE_KEY] = PhysicsState.Cloaked;
    expect(setObjectTranslucency(root, 0.5)).toBe(0.5);
    expect(root.userData[TRANSLUCENCY_KEY]).toBe(0.5);
    expect(matOf(mesh).opacity).toBe(1);
    setObjectTranslucency(root, 1);
    expect(mesh.visible).toBe(true);
  });
  it('a single part of a Cloaked object (TransparentPart hook) is left alone too', () => {
    const { root, part, mesh } = figure();
    root.userData[PHYSICS_STATE_KEY] = PhysicsState.Cloaked | PhysicsState.Hidden;
    setPartTranslucency(part, 1);
    expect(mesh.visible).toBe(true);
  });
  it('any other state (or none recorded) fades as before', () => {
    const { root, mesh } = figure();
    root.userData[PHYSICS_STATE_KEY] = PhysicsState.Hidden | PhysicsState.Gravity;
    setObjectTranslucency(root, 0.5);
    expect(matOf(mesh).opacity).toBeCloseTo(0.5, 6);
    const b = figure();
    setObjectTranslucency(b.root, 1);
    expect(b.mesh.visible).toBe(false);
  });
  it('a part fades again once the object is uncloaked', () => {
    const { root, mesh } = figure();
    root.userData[PHYSICS_STATE_KEY] = PhysicsState.Cloaked;
    setObjectTranslucency(root, 1);
    expect(mesh.visible).toBe(true);
    root.userData[PHYSICS_STATE_KEY] = 0;
    setObjectTranslucency(root, 1);
    expect(mesh.visible).toBe(false);
  });
});

describe('ServerObjectManager keeps the root\'s PhysicsState current', () => {
  function makeObject(physicsState: number, translucency: number) {
    const scene = new THREE.Scene();
    const smr = { createSetupMeshWithOverrides: () => figure().root, loadSetupModel: () => ({ lights: new Map() }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene);
    const obj = som.createObject({
      guid: 0x80000003, name: 'Admin', weenieClassId: 1, itemType: 0, setupId: 0x02000001,
      position: { landblock: 0x01030105, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
      motionTableId: 0, iconId: 0, physicsState, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
      wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
      maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
      velocityZ: 0, soundTableId: 0, objScale: 1, translucency, defaultScript: 0,
      defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)!;
    const mesh = obj.mesh!.getObjectByName('part_0')!.children[0] as THREE.Mesh;
    return { som, obj, mesh };
  }
  it('created Cloaked with a server Translucency: the parts draw as authored', () => {
    const { obj, mesh } = makeObject(PhysicsState.Cloaked, 0.5);
    expect(obj.mesh!.userData[PHYSICS_STATE_KEY]).toBe(PhysicsState.Cloaked);
    expect(matOf(mesh).opacity).toBe(1);
  });
  it('a SetState to Cloaked stops a later fade; clearing it lets the next fade through', () => {
    const { som, obj, mesh } = makeObject(0, 0);
    som.setPhysicsState(obj.guid, PhysicsState.Cloaked);
    expect(obj.mesh!.userData[PHYSICS_STATE_KEY]).toBe(PhysicsState.Cloaked);
    setObjectTranslucency(obj.mesh!, 0.75);
    expect(matOf(mesh).opacity).toBe(1);
    som.setPhysicsState(obj.guid, 0);
    setObjectTranslucency(obj.mesh!, 0.75);
    expect(matOf(mesh).opacity).toBeCloseTo(0.25, 6);
  });
});
