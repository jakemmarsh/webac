/**
 * BUG.own-objdescevent-dropped — the local player's own ObjDescEvent was
 * silently dropped: main.ts routed every ObjDescEvent to
 * ServerObjectManager.updateAppearance(), but the player's own CreateObject
 * returns early (main.ts onObjectCreate) so the own guid is never in the
 * SOM object map — updateAppearance() found nothing and equip/dequip
 * texture+palette swaps, barber results, and ShowYourHelm/ShowYourCloak
 * toggles never changed the player's in-world model until relog.
 *
 * ACE ground truth (the server DOES send these to self):
 *  - WorldObject_Networking.cs:1418 — EnqueueBroadcast(bool sendSelf = true,
 *    ...): `if (this is Player self) self.Session.Network.EnqueueSend(msgs)`.
 *  - Creature_Equipment.cs:365 (equip) / :438 (dequip) —
 *    EnqueueBroadcast(new GameMessageObjDescEvent(this)).
 *  - Player_Character.cs:581 — barber finish, same broadcast.
 *  - GameActionSetSingleCharacterOption.cs:27/31 — ShowYourCloak /
 *    ShowYourHelmOrHeadGear toggles, same broadcast.
 *
 * Retail client ground truth: SmartBox::HandleObjDescEvent @ 00453340
 * resolves ANY guid — the local player included — through
 * CObjectMaint::GetObjectA and applies UpdateVisualDesc gated on the
 * ObjectInstance timestamp (update_times[8]). Our player model lives
 * outside SOM, so the fix adds a dedicated own-appearance path:
 * buildAppearanceOverrides (shared with the initial player build) +
 * transplantPartChildren (in-place part swap preserving the live Group)
 * + AnimatedEntity.refreshParts (re-bind animation to the new parts).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildAppearanceOverrides,
  transplantPartChildren,
} from '../packages/renderer/src/models/AppearanceOverrides.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';

function makePart(name: string, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

describe('BUG.own-objdescevent-dropped — buildAppearanceOverrides', () => {
  it('returns all-undefined overrides for an empty appearance', () => {
    const ov = buildAppearanceOverrides(
      { basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [] },
      () => null,
    );
    expect(ov.partChanges).toBeUndefined();
    expect(ov.perPartTextureOverrides).toBeUndefined();
    expect(ov.paletteColors).toBeUndefined();
  });

  it('maps animPartChanges to part index → GfxObj id', () => {
    const ov = buildAppearanceOverrides(
      {
        basePalette: 0, subPalettes: [], textureChanges: [],
        animPartChanges: [
          { partIndex: 0, partId: 0x01000abc },
          { partIndex: 5, partId: 0x01000def },
        ],
      },
      () => null,
    );
    expect(ov.partChanges?.get(0)).toBe(0x01000abc);
    expect(ov.partChanges?.get(5)).toBe(0x01000def);
    expect(ov.partChanges?.size).toBe(2);
  });

  it('groups texture changes per part — a swap on part 2 does not leak to part 3', () => {
    const ov = buildAppearanceOverrides(
      {
        basePalette: 0, subPalettes: [], animPartChanges: [],
        textureChanges: [
          { partIndex: 2, oldTexture: 0x05001111, newTexture: 0x05002222 },
          { partIndex: 2, oldTexture: 0x05003333, newTexture: 0x05004444 },
          { partIndex: 3, oldTexture: 0x05001111, newTexture: 0x05009999 },
        ],
      },
      () => null,
    );
    expect(ov.perPartTextureOverrides?.get(2)?.get(0x05001111)).toBe(0x05002222);
    expect(ov.perPartTextureOverrides?.get(2)?.get(0x05003333)).toBe(0x05004444);
    expect(ov.perPartTextureOverrides?.get(3)?.get(0x05001111)).toBe(0x05009999);
    expect(ov.perPartTextureOverrides?.get(3)?.has(0x05003333)).toBe(false);
  });

  it('composites sub-palette ranges over the base palette at matching indices', () => {
    const palettes = new Map<number, number[]>([
      [0x04000001, [1, 1, 1, 1, 1, 1, 1, 1]],   // base
      [0x04000002, [9, 9, 9, 9, 9, 9, 9, 9]],   // override source
    ]);
    const ov = buildAppearanceOverrides(
      {
        basePalette: 0x04000001,
        subPalettes: [{ paletteId: 0x04000002, offset: 2, length: 3 }],
        textureChanges: [], animPartChanges: [],
      },
      (id) => palettes.get(id),
    );
    // Indices 2..4 replaced from the override palette's SAME indices.
    expect(ov.paletteColors).toEqual([1, 1, 9, 9, 9, 1, 1, 1]);
  });

  it('produces no composite when basePalette is 0 or base colors fail to load', () => {
    const ovNoBase = buildAppearanceOverrides(
      {
        basePalette: 0,
        subPalettes: [{ paletteId: 0x04000002, offset: 0, length: 2 }],
        textureChanges: [], animPartChanges: [],
      },
      () => [5, 5],
    );
    expect(ovNoBase.paletteColors).toBeUndefined();

    const ovLoadFail = buildAppearanceOverrides(
      {
        basePalette: 0x04000001,
        subPalettes: [{ paletteId: 0x04000002, offset: 0, length: 2 }],
        textureChanges: [], animPartChanges: [],
      },
      () => null,
    );
    expect(ovLoadFail.paletteColors).toBeUndefined();
  });
});

describe('BUG.own-objdescevent-dropped — transplantPartChildren', () => {
  it('swaps part_N children in place, keeping the Group identity and non-part children', () => {
    const group = new THREE.Group();
    group.name = 'player_Test';
    const oldP0 = makePart('part_0');
    const oldP1 = makePart('part_1');
    const other = new THREE.Object3D();
    other.name = 'selection_ring';
    group.add(oldP0, oldP1, other);

    const fresh = new THREE.Group();
    const newP0 = makePart('part_0', 7, 7, 7);
    const newP1 = makePart('part_1');
    fresh.add(newP0, newP1);

    transplantPartChildren(group, fresh);

    expect(group.children).toContain(newP0);
    expect(group.children).toContain(newP1);
    expect(group.children).not.toContain(oldP0);
    expect(group.children).not.toContain(oldP1);
    expect(group.children).toContain(other); // untouched
    expect(newP0.parent).toBe(group);
  });

  it('copies the old animated pose onto the replacement part (no one-frame pop)', () => {
    const group = new THREE.Group();
    const oldP0 = makePart('part_0', 1.5, 2.5, -3);
    oldP0.quaternion.set(0.5, 0.5, 0.5, 0.5);
    group.add(oldP0);

    const fresh = new THREE.Group();
    fresh.add(makePart('part_0', 0, 0, 0)); // placement-frame default

    transplantPartChildren(group, fresh);

    const np = group.getObjectByName('part_0')!;
    expect(np.position.toArray()).toEqual([1.5, 2.5, -3]);
    expect(np.quaternion.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('re-parents wielded_* attachments onto the new part with local transform intact', () => {
    const group = new THREE.Group();
    const oldHand = makePart('part_5');
    const wielded = new THREE.Group();
    wielded.name = 'wielded_1';
    wielded.position.set(0.1, 0.2, 0.3);
    wielded.userData.wieldedGuid = 0x80001234;
    oldHand.add(wielded);
    group.add(oldHand);

    const fresh = new THREE.Group();
    const newHand = makePart('part_5');
    fresh.add(newHand);

    transplantPartChildren(group, fresh);

    expect(wielded.parent).toBe(newHand);
    expect(wielded.position.toArray()).toEqual([0.1, 0.2, 0.3]);
    expect(wielded.userData.wieldedGuid).toBe(0x80001234);
    // And the wielded mesh was NOT disposed with the old part.
    expect(newHand.getObjectByName('wielded_1')).toBe(wielded);
  });

  it('disposes replaced part geometry/materials but never the rescued attachment', () => {
    const group = new THREE.Group();
    const oldP0 = makePart('part_0');
    let oldDisposed = false;
    oldP0.geometry.addEventListener('dispose', () => { oldDisposed = true; });

    const wielded = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    wielded.name = 'wielded_1';
    let wieldedDisposed = false;
    wielded.geometry.addEventListener('dispose', () => { wieldedDisposed = true; });
    oldP0.add(wielded);
    group.add(oldP0);

    const fresh = new THREE.Group();
    fresh.add(makePart('part_0'));
    transplantPartChildren(group, fresh);

    expect(oldDisposed).toBe(true);
    expect(wieldedDisposed).toBe(false);
  });

  it('removes stale parts absent from the new build and adds new-only parts', () => {
    const group = new THREE.Group();
    group.add(makePart('part_0'), makePart('part_2'));

    const fresh = new THREE.Group();
    fresh.add(makePart('part_0'), makePart('part_3'));

    transplantPartChildren(group, fresh);

    const names = group.children.map((c) => c.name).sort();
    expect(names).toEqual(['part_0', 'part_3']);
  });

  it('a part absent from a streamed rebuild keeps its held item until a later rebuild brings the part back (the item is rescued then)', () => {
    const group = new THREE.Group();
    const oldHand = makePart('part_15');
    const wand = new THREE.Group();
    wand.name = 'wielded_1';
    wand.userData.wieldedGuid = 0x900418fd;
    oldHand.add(wand);
    group.add(makePart('part_0'), oldHand);

    // The hand's GfxObj was not resident: the rebuild has no part_15.
    const partial = new THREE.Group();
    partial.add(makePart('part_0'));
    transplantPartChildren(group, partial);
    expect(group.children).toContain(oldHand);
    expect(wand.parent).toBe(oldHand);

    // Files landed: the next rebuild has the hand, and the wand moves onto it.
    const full = new THREE.Group();
    const newHand = makePart('part_15');
    full.add(makePart('part_0'), newHand);
    transplantPartChildren(group, full);
    expect(wand.parent).toBe(newHand);
    expect(group.children).not.toContain(oldHand);
    expect(group.children.filter((c) => c.name === 'part_15')).toEqual([newHand]);
  });
});

describe('BUG.own-objdescevent-dropped — AnimatedEntity part re-binding', () => {
  // A dummy DatDatabase is fine: MotionManager's constructor only stores it.
  const dummyDb = {} as never;

  function poseViaStubbedTransforms(entity: AnimatedEntity, frames: Array<{ origin: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } }>): void {
    // Drive the SHIPPED update() path with a stubbed transform source —
    // no motion table is loaded, so player transforms would be empty.
    (entity.motionManager as { getPartTransforms: () => unknown }).getPartTransforms = () => frames;
    entity.update(0.016);
  }

  const frame0 = { origin: { x: 42, y: 43, z: 44 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };

  it('refreshParts() re-binds animation to transplanted parts', () => {
    const group = new THREE.Group();
    group.add(makePart('part_0'));
    const entity = new AnimatedEntity(group, dummyDb);

    // Transplant: replace part_0 with a fresh mesh, as the own-ObjDescEvent
    // path does.
    const fresh = new THREE.Group();
    const newP0 = makePart('part_0');
    fresh.add(newP0);
    transplantPartChildren(group, fresh);
    entity.refreshParts();

    poseViaStubbedTransforms(entity, [frame0]);
    // AC Z-up → Three.js Y-up swap: (x, z, y)
    expect(newP0.position.toArray()).toEqual([42, 44, 43]);
  });

  it('a wielded item\'s nested part_0 never shadows the player\'s own part_0', () => {
    const group = new THREE.Group();
    const playerP0 = makePart('part_0');
    const playerP1 = makePart('part_1');
    group.add(playerP0, playerP1);

    // Wielded item attached under the player's part_1 — item setups carry
    // their own part_N-named children (SetupModelRenderer names every
    // setup's parts part_0, part_1, ...).
    const item = new THREE.Group();
    item.name = 'wielded_1';
    const itemP0 = makePart('part_0');
    item.add(itemP0);
    playerP1.add(item);

    const entity = new AnimatedEntity(group, dummyDb);
    entity.refreshParts(); // collected AFTER the attachment exists

    poseViaStubbedTransforms(entity, [frame0]);
    expect(playerP0.position.toArray()).toEqual([42, 44, 43]);
    expect(itemP0.position.toArray()).toEqual([0, 0, 0]); // untouched
  });
});
