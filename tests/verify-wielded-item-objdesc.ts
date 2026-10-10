/**
 * RECON.wielded-item-objdesc — a held item's mesh is built from the item's
 * OWN CreateObject: PhysicsDesc setup + ObjScale and the ObjDesc palettes,
 * texture maps and part swaps (retail parents the item's own CPhysicsObj,
 * SmartBox::DoParentEvent @ 00452290). Pre-fix the player path took the
 * setup from a gitignored weenie-class export (nothing attached without
 * it) and both paths dropped the ObjDesc.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { InventoryManager } from '@ac/shared';
import {
  buildInventoryEntry,
  WorldObjectRecords,
  type InventoryEntrySource,
} from '../packages/renderer/src/network/objectSubjectRouting';
import {
  attachHeldChild,
  buildWieldedItemMesh,
  heldCopiesUnder,
  itemVisualDescOf,
  heldItemPlacement,
  WIELDED_PLACEMENT_KEY,
  type WieldedMeshBuilder,
} from '../packages/renderer/src/models/WieldedItemVisual';
import { TRANSLUCENCY_ORIGINAL_KEY } from '../packages/renderer/src/models/ObjectTranslucency';

const SWORD_SETUP = 0x02000181;

function swordCreateObject(over: Partial<InventoryEntrySource> = {}): InventoryEntrySource {
  return {
    weenieClassId: 30,
    name: 'Dyed Sword',
    value: 100,
    burden: 50,
    stackSize: 1,
    maxStackSize: 1,
    containerId: 0x50000001,
    iconId: 0x06001234,
    validLocations: 0x00100000,
    itemType: 0x1,
    uiEffects: 0,
    usable: 1,
    setupId: SWORD_SETUP,
    objScale: 1.25,
    basePalette: 0x0400007e,
    subPalettes: [{ paletteId: 0x04001000, offset: 8, length: 8 }],
    textureChanges: [{ partIndex: 0, oldTexture: 0x05000100, newTexture: 0x05000200 }],
    animPartChanges: [{ partIndex: 1, partId: 0x01000500 }],
    ...over,
  };
}

/** Records every createSetupMeshWithOverrides call and returns a real Group. */
function recordingBuilder(result: 'group' | 'null' = 'group') {
  const calls: Parameters<WieldedMeshBuilder['createSetupMeshWithOverrides']>[] = [];
  const builder: WieldedMeshBuilder = {
    createSetupMeshWithOverrides: (...args) => {
      calls.push(args);
      return result === 'group' ? new THREE.Group() : null;
    },
  };
  return { builder, calls };
}

const palettes = new Map<number, number[]>([
  [0x0400007e, Array.from({ length: 32 }, (_, i) => i)],
  [0x04001000, Array.from({ length: 32 }, (_, i) => 1000 + i)],
]);
const loadPalette = (id: number) => palettes.get(id) ?? null;

describe('the item\'s CreateObject visual desc reaches its inventory entry', () => {
  it('buildInventoryEntry keeps setup, scale and ObjDesc', () => {
    const entry = buildInventoryEntry(swordCreateObject());
    expect(entry.visualDesc).toEqual({
      setupId: SWORD_SETUP,
      objScale: 1.25,
      translucency: 0, physicsState: 0, peTableId: 0,
      basePalette: 0x0400007e,
      subPalettes: [{ paletteId: 0x04001000, offset: 8, length: 8 }],
      textureChanges: [{ partIndex: 0, oldTexture: 0x05000100, newTexture: 0x05000200 }],
      animPartChanges: [{ partIndex: 1, partId: 0x01000500 }],
    });
  });

  it('no setup on the wire → no visual desc; no ObjScale → scale 1', () => {
    expect(buildInventoryEntry(swordCreateObject({ setupId: 0 })).visualDesc).toBeUndefined();
    expect(itemVisualDescOf({ setupId: SWORD_SETUP })).toEqual({
      setupId: SWORD_SETUP, objScale: 1, translucency: 0, physicsState: 0, peTableId: 0, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    });
  });

  it('InventoryManager.addItem stores it (the own-inventory CreateObject route)', () => {
    const inv = new InventoryManager();
    inv.addItem(buildInventoryEntry(swordCreateObject()), 0x80000010);
    expect(inv.getItem(0x80000010)?.visualDesc?.setupId).toBe(SWORD_SETUP);
  });

  it('a ground object picked up keeps it (WorldObjectRecords.containIn — no fresh CreateObject)', () => {
    const records = new WorldObjectRecords();
    records.remember(0x80000020, { ...swordCreateObject({ containerId: 0 }), objectDescFlags: 0 });
    const carried = records.containIn(0x80000020, 0x50000001);
    expect(carried?.visualDesc?.setupId).toBe(SWORD_SETUP);
    expect(carried?.visualDesc?.textureChanges).toHaveLength(1);
  });
});

describe('buildWieldedItemMesh applies the item\'s own desc', () => {
  it('without a ParentEvent placement: the CreateObject\'s Placement, else Resting (0x65) — never Default', () => {
    const { builder, calls } = recordingBuilder();
    // ACE writes the wielded item's Placement in its PhysicsDesc (RightHandCombat = 1 here).
    buildWieldedItemMesh(builder, itemVisualDescOf({ setupId: SWORD_SETUP, placement: 1 })!, undefined, loadPalette);
    // No Placement on the wire: the item keeps the Resting frame InitObjectEnd set.
    buildWieldedItemMesh(builder, itemVisualDescOf({ setupId: SWORD_SETUP })!, undefined, loadPalette);
    // A ParentEvent placement still wins over both.
    buildWieldedItemMesh(builder, itemVisualDescOf({ setupId: SWORD_SETUP, placement: 1 })!, 4, loadPalette);
    expect(calls.map(c => c[1])).toEqual([1, 0x65, 4]);
    expect(heldItemPlacement(undefined, {})).toBe(0x65);
  });

  it('builds its setup at the ParentEvent placement with part swaps, texture maps and the composite palette', () => {
    const { builder, calls } = recordingBuilder();
    const visual = itemVisualDescOf(swordCreateObject())!;
    const mesh = buildWieldedItemMesh(builder, visual, 3, loadPalette);
    expect(mesh).toBeInstanceOf(THREE.Group);
    expect(calls).toHaveLength(1);
    const [setupId, placement, partChanges, texOverrides, palette] = calls[0];
    expect(setupId).toBe(SWORD_SETUP);
    expect(placement).toBe(3);
    expect(partChanges?.get(1)).toBe(0x01000500);
    expect(texOverrides?.get(0)?.get(0x05000100)).toBe(0x05000200);
    // Palette::Modify index-for-index over [8, 16): base elsewhere.
    expect(palette?.slice(6, 18)).toEqual([6, 7, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 16, 17]);
  });

  it('applies the item\'s ObjScale to the held mesh', () => {
    const { builder } = recordingBuilder();
    const mesh = buildWieldedItemMesh(builder, itemVisualDescOf(swordCreateObject())!, 0, loadPalette)!;
    expect(mesh.scale.toArray()).toEqual([1.25, 1.25, 1.25]);
    const plain = buildWieldedItemMesh(builder, itemVisualDescOf(swordCreateObject({ objScale: 0 }))!, 0, loadPalette)!;
    expect(plain.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('an undyed item passes no overrides', () => {
    const { builder, calls } = recordingBuilder();
    buildWieldedItemMesh(builder, itemVisualDescOf({ setupId: SWORD_SETUP })!, 0, loadPalette);
    expect(calls[0].slice(2)).toEqual([undefined, undefined, undefined]);
  });

  it('a setup that does not build → null', () => {
    const { builder } = recordingBuilder('null');
    expect(buildWieldedItemMesh(builder, itemVisualDescOf(swordCreateObject())!, 0, loadPalette)).toBeNull();
  });
});

/**
 * BUG.held-item-own-state — a held item is its own CPhysicsObj in retail:
 * it keeps its own translucency and scale (CPhysicsObj::UpdateChild
 * @ 00512d50 combines the holder part's frame with the unscaled holding
 * frame), and its copy is found again for a refresh.
 */
describe('held item keeps its own state', () => {
  const partBuilder: WieldedMeshBuilder = {
    createSetupMeshWithOverrides: () => {
      const g = new THREE.Group();
      const part = new THREE.Group(); part.name = 'part_0';
      part.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ opacity: 1, transparent: false })));
      g.add(part);
      return g;
    },
  };

  it('draws at its own server translucency (a Crystal Caul orb at 0.5)', () => {
    const visual = itemVisualDescOf({ setupId: SWORD_SETUP, translucency: 0.5 })!;
    expect(visual.translucency).toBe(0.5);
    const mesh = buildWieldedItemMesh(partBuilder, visual, 0, () => null)!;
    const mat = ((mesh.children[0].children[0]) as THREE.Mesh).material as THREE.Material;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.5, 5);
    expect(mesh.userData[TRANSLUCENCY_ORIGINAL_KEY]).toBe(0.5);
  });

  it('an opaque item stays opaque and records its Placement for a re-attach', () => {
    const mesh = buildWieldedItemMesh(partBuilder, itemVisualDescOf({ setupId: SWORD_SETUP })!, 0x3c, () => null)!;
    const mat = ((mesh.children[0].children[0]) as THREE.Mesh).material as THREE.Material;
    expect(mat.transparent).toBe(false);
    expect(mesh.userData[WIELDED_PLACEMENT_KEY]).toBe(0x3c);
  });

  it('is not scaled by its holder: a 1.7x creature with a 2x part holds a 1.25x item at 1.25x, offset unscaled', () => {
    const root = new THREE.Group(); root.scale.setScalar(1.7);
    const part = new THREE.Group(); part.name = 'part_15'; part.scale.setScalar(2);
    root.add(part);
    const item = new THREE.Group(); item.scale.setScalar(1.25); item.position.set(0.1, 0.2, 0.3);
    attachHeldChild(root, part, item, 1, 0x81);
    root.updateMatrixWorld(true);
    const ws = item.getWorldScale(new THREE.Vector3());
    expect(ws.x).toBeCloseTo(1.25, 5);
    // the holding offset in world units equals the unscaled frame origin
    const origin = part.getWorldPosition(new THREE.Vector3());
    const at = item.getWorldPosition(new THREE.Vector3()).sub(origin);
    expect(at.x).toBeCloseTo(0.1, 5);
    expect(at.y).toBeCloseTo(0.2, 5);
    expect(at.z).toBeCloseTo(0.3, 5);
  });

  it('an unscaled holder leaves the item untouched; heldCopiesUnder finds copies by item', () => {
    const root = new THREE.Group();
    const part = new THREE.Group(); root.add(part);
    const a = new THREE.Group(); a.position.set(1, 2, 3);
    const b = new THREE.Group();
    attachHeldChild(root, part, a, 1, 0x81);
    attachHeldChild(root, part, b, 2, 0x82);
    expect(a.position.toArray()).toEqual([1, 2, 3]);
    expect(heldCopiesUnder(root)).toEqual([a, b]);
    expect(heldCopiesUnder(root, 0x82)).toEqual([b]);
  });
});
