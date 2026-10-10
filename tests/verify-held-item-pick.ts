/**
 * BUG.held-item-unpickable — clicking another player's wielded weapon
 * selected the player: the held item's drawn copy hangs on its holder's part
 * (`wielded_<loc>`, WieldedItemVisual.attachHeldChild), so the recursive
 * raycast of the holder's mesh credited the hit to the holder.
 *
 * Retail: the held item is its own CPhysicsObj with its own parts, and the
 * select test (CPhysicsPart::Draw @ 0050d7a0) records the drawn part's own
 * physobj id — a ray on the sword finds the sword (and the player's own
 * sword, in third person, finds that sword rather than the player).
 *
 * Real THREE meshes and raycaster; the real ServerObjectManager pick.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ObjectDescriptionFlag } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { attachHeldChild, heldCopiesUnder, heldCopyGuidAt, itemVisualDescOf, rescaleHeldCopiesForHolder, stripHeldCopies } from '../packages/renderer/src/models/WieldedItemVisual.js';
import { LIGHT_HIGH, setObjectLighting, type LightingCopies } from '../packages/renderer/src/world/SelectionLighting.js';
import { inheritPartTranslucency, PART_UNDRAWN_KEY } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { selfHitUnderRay } from '../packages/renderer/src/world/PickOcclusion.js';

const HOLDER = 0x50000001;
const SWORD = 0x80000010;
const DART = 0x80000011;

function makeSOM(): ServerObjectManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
}

function createData(guid: number, extra: Partial<CreateObjectData> = {}): CreateObjectData {
  return {
    guid, name: `obj${guid.toString(16)}`, weenieClassId: 1, itemType: 0x1,
    position: { landblock: 0x00000001, x: 0, y: 0, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 }, setupId: 0x02000001, motionTableId: 0, iconId: 0,
    physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, useRadius: 0.6,
    velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0,
    objScale: 1.0, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1.0,
    iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    ...extra,
  } as unknown as CreateObjectData;
}

const box = (z: number): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  m.position.set(0, 0, z);
  return m;
};

/** A holder (body box at z=0) whose part_0 holds `items` copies at z=2 (nearer the camera). */
function holderModel(items: number[]): THREE.Group {
  const root = new THREE.Group();
  const part = new THREE.Group(); part.name = 'part_0';
  part.add(box(0));
  root.add(part);
  let parent: THREE.Object3D = part;
  for (const guid of items) {
    const copy = new THREE.Group();
    copy.add(box(parent === part ? 2 : 0));
    attachHeldChild(root, parent, copy, 1, guid);
    parent = copy; // the next item rides on this one (the dart on the atlatl)
  }
  return root;
}

/** The SOM with a holder whose model holds `items`, and records for `known`. */
function world(items: number[], known: number[], flags: Record<number, number> = {}): ServerObjectManager {
  const som = makeSOM();
  const models = new Map<number, THREE.Group>([[HOLDER, holderModel(items)]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = (d: CreateObjectData) => models.get(d.guid) ?? new THREE.Group();
  som.createObject(createData(HOLDER));
  for (const guid of known) {
    // Parented: its own mesh enters no cell; the drawn copy is on the holder.
    som.createObject(createData(guid, { wielderId: HOLDER, parentLocation: 1, physicsParentId: HOLDER, objectDescFlags: flags[guid] ?? 0 } as Partial<CreateObjectData>));
  }
  for (const o of som.getAllObjects().values()) o.mesh?.updateMatrixWorld(true);
  return som;
}

const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
const rayBodyOnly = new THREE.Raycaster(new THREE.Vector3(0, 0, -10), new THREE.Vector3(0, 0, 1));

describe('BUG.held-item-unpickable — a ray on a held copy finds the held item', () => {
  it("another player's wielded sword is found, not the player", () => {
    const som = world([SWORD], [SWORD]);
    const pick = som.pickAtScreenPos(ray);
    expect(pick?.obj.guid).toBe(SWORD);
    expect(pick?.distance).toBeCloseTo(7.5);
    expect(som.getObjectAtScreenPos(ray)?.guid).toBe(SWORD);
  });

  it('a ray on the body still finds the holder', () => {
    const som = world([SWORD], [SWORD]);
    // From behind: the body box (z=0) is the first part hit.
    expect(som.getObjectAtScreenPos(rayBodyOnly)?.guid).toBe(HOLDER);
  });

  it('the innermost held item wins (the dart on the atlatl)', () => {
    const som = world([SWORD, DART], [SWORD, DART]);
    // The dart's box sits inside the sword copy at the same spot: the ray
    // hits the sword's box first (it is listed first in traversal); a hit
    // on the dart's own geometry resolves to the dart.
    const root = som.getObject(HOLDER)!.mesh!;
    const dartBox = root.getObjectByProperty('name', 'wielded_1')!.children
      .find(c => c.name === 'wielded_1')!.children[0];
    expect(heldCopyGuidAt(dartBox, root)).toBe(DART);
  });

  it('an unknown held item falls back to its holder', () => {
    const som = world([SWORD], []);
    expect(som.getObjectAtScreenPos(ray)?.guid).toBe(HOLDER);
  });

  it('a UI-hidden held item is nothing found (004e5ad0), not its holder', () => {
    const som = world([SWORD], [SWORD], { [SWORD]: ObjectDescriptionFlag.UiHidden });
    expect(som.pickAtScreenPos(ray)).toBeNull();
  });
});

describe('heldCopyGuidAt', () => {
  it("is 0 for the holder's own parts and stops at the root", () => {
    const root = holderModel([SWORD]);
    const body = root.getObjectByName('part_0')!.children[0];
    expect(heldCopyGuidAt(body, root)).toBe(0);
    expect(heldCopyGuidAt(root, root)).toBe(0);
    expect(heldCopyGuidAt(null, root)).toBe(0);
  });
});

describe("the player's own held copy", () => {
  it('selfHitUnderRay returns the hit on the held copy, which resolves to the item', () => {
    const model = holderModel([SWORD]);
    model.updateMatrixWorld(true);
    const hit = selfHitUnderRay(ray, model, undefined);
    expect(hit).not.toBeNull();
    expect(heldCopyGuidAt(hit!.object, model)).toBe(SWORD);
  });

  it('a nearer object beats the player; the pick distance is the comparison', () => {
    const model = holderModel([SWORD]);
    model.updateMatrixWorld(true);
    expect(selfHitUnderRay(ray, model, 5)).toBeNull();
    expect(selfHitUnderRay(ray, model, 9)).not.toBeNull();
    model.visible = false;
    expect(selfHitUnderRay(ray, model, undefined)).toBeNull();
  });
});

// ── The same bug class, swept: what reads a held item reads its drawn copy,
// and what acts on a holder leaves its held items alone. ──

const meshesOf = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) out.push(o); });
  return out;
};

describe('selection lighting — CPartArray::SetLightingInternal touches the object’s own parts', () => {
  it('lighting a holder leaves its held copy’s materials alone', () => {
    const root = holderModel([SWORD]);
    const [body, sword] = [root.getObjectByName('part_0')!.children[0] as THREE.Mesh, meshesOf(heldCopiesUnder(root, SWORD)[0])[0]];
    const swordMat = sword.material;
    const copies: LightingCopies = new Map();
    setObjectLighting(root, LIGHT_HIGH, copies);
    expect(copies.has(body)).toBe(true);
    expect(copies.has(sword)).toBe(false);
    expect(sword.material).toBe(swordMat);
  });

  it('selecting a held sword lights its drawn copy, not its own hidden mesh', () => {
    const som = world([SWORD], [SWORD]);
    const copy = heldCopiesUnder(som.getObject(HOLDER)!.mesh!, SWORD)[0];
    expect(som.drawnRoot(som.getObject(SWORD)!)).toBe(copy);
    expect(som.setLighting(SWORD, LIGHT_HIGH)).toBe(true);
    const sword = meshesOf(copy)[0];
    expect(som.getObject(SWORD)!.lightingCopies!.has(sword)).toBe(true);
    // The holder's body is not lit by the sword's selection.
    expect(som.getObject(HOLDER)!.lightingCopies).toBeUndefined();
    expect(som.restoreLighting(SWORD)).toBe(true);
  });

  it('drawnRoot is the object’s own mesh when nothing holds it, null when its holder draws no copy', () => {
    const som = world([], [SWORD]);
    expect(som.drawnRoot(som.getObject(HOLDER)!)).toBe(som.getObject(HOLDER)!.mesh);
    expect(som.drawnRoot(som.getObject(SWORD)!)).toBeNull();
  });
});

describe('a live holder ObjScale keeps its held items’ own size (UpdateChild frames carry no scale)', () => {
  it('rescaling the holder leaves the copy’s world scale and holding point unchanged', () => {
    const som = world([SWORD], [SWORD]);
    const root = som.getObject(HOLDER)!.mesh!;
    const copy = heldCopiesUnder(root, SWORD)[0];
    copy.position.set(0.3, 0.2, 0.1);
    root.updateMatrixWorld(true);
    const before = copy.getWorldPosition(new THREE.Vector3()).sub(root.position);
    som.setObjectScale(HOLDER, 2);
    root.updateMatrixWorld(true);
    expect(copy.getWorldScale(new THREE.Vector3()).y).toBeCloseTo(1);
    const after = copy.getWorldPosition(new THREE.Vector3()).sub(root.position);
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
  });

  it('only the outermost copy is rescaled (the dart rides on the atlatl)', () => {
    const root = holderModel([SWORD, DART]);
    const dart = heldCopiesUnder(root, DART)[0];
    rescaleHeldCopiesForHolder(root, 2);
    expect(heldCopiesUnder(root, SWORD)[0].scale.x).toBeCloseTo(0.5);
    expect(dart.scale.x).toBeCloseTo(1);
  });
});

describe('inheritPartTranslucency — an undrawn held copy does not hide the holder’s new part', () => {
  it('a held copy flagged undrawn on a sibling part is not the holder’s own undrawn part', () => {
    const root = holderModel([SWORD]);
    for (const m of meshesOf(heldCopiesUnder(root, SWORD)[0])) m.userData[PART_UNDRAWN_KEY] = true;
    const part = new THREE.Group(); const built = box(0);
    inheritPartTranslucency(part, built, [root.getObjectByName('part_0')!]);
    expect(built.visible).toBe(true);
    // The holder's own undrawn part still carries over.
    (root.getObjectByName('part_0')!.children[0] as THREE.Mesh).userData[PART_UNDRAWN_KEY] = true;
    const built2 = box(0);
    inheritPartTranslucency(part, built2, [root.getObjectByName('part_0')!]);
    expect(built2.visible).toBe(false);
  });
});

describe('stripHeldCopies — the examine figure is a part-array copy (MorphToExistingObject @ 0050fab0)', () => {
  it('a clone of a holder loses its held copies, keeps its own parts', () => {
    const clone = holderModel([SWORD]).clone(true);
    stripHeldCopies(clone);
    expect(heldCopiesUnder(clone)).toHaveLength(0);
    expect(clone.getObjectByName('part_0')!.children).toHaveLength(1);
  });
});

describe('itemVisualDescOf — our own held item keeps its PhysicsScriptTable', () => {
  it('carries peTableId so a PlayScript on the sword in hand resolves', () => {
    expect(itemVisualDescOf({ setupId: 0x02000123, peTableId: 0x34000010 })?.peTableId).toBe(0x34000010);
    expect(itemVisualDescOf({ setupId: 0x02000123 })?.peTableId).toBe(0);
  });
});
