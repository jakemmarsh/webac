/**
 * BUG.paperdoll-held-items — the paperdoll figure showed the wielded shield
 * and weapon, because it cloned the live player model with its held copies.
 * Retail's doll is a fresh object (gmPaperDollUI::RedressCreature @ 004a3bc0:
 * makeObject from the Setup + the player's ObjDesc) with no children, and
 * its click map (GetPaperDollItemUnderMouse @ 004a4920) has body regions only.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { attachHeldChild, heldCopiesUnder, stripHeldCopies } from '../packages/renderer/src/models/WieldedItemVisual.js';

function holder(): { root: THREE.Group; parts: THREE.Object3D[] } {
  const root = new THREE.Group();
  const parts: THREE.Object3D[] = [];
  for (let i = 0; i < 17; i++) {
    const p = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    p.name = `part_${i}`;
    root.add(p);
    parts.push(p);
  }
  return { root, parts };
}

describe('paperdoll figure drops held items', () => {
  it('a clone of the player loses its weapon and shield, and keeps every body part', () => {
    const { root, parts } = holder();
    attachHeldChild(root, parts[16], new THREE.Group(), 1, 0x80000101); // RightHand: sword
    attachHeldChild(root, parts[12], new THREE.Group(), 3, 0x80000102); // Shield
    expect(heldCopiesUnder(root)).toHaveLength(2);

    const doll = root.clone(true);
    const removed = stripHeldCopies(doll);

    expect(removed.map(o => o.userData.wieldedGuid).sort()).toEqual([0x80000101, 0x80000102]);
    expect(heldCopiesUnder(doll)).toHaveLength(0);
    expect(doll.children.map(c => c.name)).toEqual(parts.map(p => p.name));
    // the live avatar still holds both
    expect(heldCopiesUnder(root)).toHaveLength(2);
  });

  it('a figure holding nothing is unchanged', () => {
    const { root } = holder();
    expect(stripHeldCopies(root)).toEqual([]);
    expect(root.children).toHaveLength(17);
  });
});
