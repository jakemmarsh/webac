/**
 * VISUAL.stray-chest-name-label — the player's own model blocks the 3D find:
 * an object behind it is not under the mouse (no hover tooltip naming a chest
 * the player stands in front of). Real THREE meshes and raycaster.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { occluderIsNearer, findsSelf } from '../packages/renderer/src/world/PickOcclusion.js';
import { applyPlayerModelLighting, type LightingCopies } from '../packages/renderer/src/world/SelectionLighting.js';

const box = (z: number): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  m.position.set(0, 0, z);
  m.updateMatrixWorld(true);
  return m;
};
const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));

describe('occluderIsNearer', () => {
  it('the player in front of the chest occludes it; behind it does not', () => {
    expect(occluderIsNearer(ray, box(2), box(-2))).toBe(true);
    expect(occluderIsNearer(ray, box(-4), box(-2))).toBe(false);
  });
  it('an invisible or missing player, or a ray that misses the player, never occludes', () => {
    const hidden = box(2); hidden.visible = false;
    expect(occluderIsNearer(ray, hidden, box(-2))).toBe(false);
    expect(occluderIsNearer(ray, null, box(-2))).toBe(false);
    const aside = box(2); aside.position.x = 5; aside.updateMatrixWorld(true);
    expect(occluderIsNearer(ray, aside, box(-2))).toBe(false);
  });
});

describe('findsSelf — SWEEP1006B.player-input.player-own-body-can-t', () => {
  it('the player model is found when it is nearer than the nearest object, or when no object is hit', () => {
    expect(findsSelf(ray, box(2), box(-2))).toBe(true);
    expect(findsSelf(ray, box(2), null)).toBe(true);
    const aside = box(-2); aside.position.x = 5; aside.updateMatrixWorld(true);
    expect(findsSelf(ray, box(2), aside)).toBe(true); // the object's mesh is not on the ray
  });
  it('an object in front of the player wins; a ray past the player finds no self', () => {
    expect(findsSelf(ray, box(-4), box(-2))).toBe(false);
    const aside = box(2); aside.position.x = 5; aside.updateMatrixWorld(true);
    expect(findsSelf(ray, aside, null)).toBe(false);
  });
  it('first person (model not drawn) never finds the player', () => {
    const hidden = box(2); hidden.visible = false;
    expect(findsSelf(ray, hidden, null)).toBe(false);
    expect(findsSelf(ray, null, box(-2))).toBe(false);
  });
});

describe('applyPlayerModelLighting — the found player blinks like any object', () => {
  it('lights the model with copies and restores the originals', () => {
    const model = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    model.add(mesh);
    const copies: LightingCopies = new Map();
    applyPlayerModelLighting(model, 'high', copies);
    expect(mesh.material).not.toBe(mat);
    expect(copies.size).toBe(1);
    applyPlayerModelLighting(model, 'restore', copies);
    expect(mesh.material).toBe(mat);
    expect(copies.size).toBe(0);
  });
});
