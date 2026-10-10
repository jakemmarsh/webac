import type * as THREE from 'three';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';
import { buildAppearanceOverrides, type AppearanceData } from './AppearanceOverrides.js';
import { setServerTranslucency } from './ObjectTranslucency.js';
import { PLACEMENT_RESTING } from './SetupModelGroup.js';

/**
 * RECON.wielded-item-objdesc — the mesh of an item held at a wielder's
 * holding location, built from the item's OWN wire descs.
 *
 * Retail parents the item's own CPhysicsObj: SmartBox::DoParentEvent
 * @ 00452290 looks the child up in CObjectMaint (the object its
 * CreateObject built — PhysicsDesc setup + scale, ObjDesc palettes /
 * texture maps / part swaps applied by UpdateVisualDesc) and calls
 * set_parent + SetPlacementFrame on it. ACE sends that CreateObject for
 * every wielded item: the player's own at login (Player_Networking.cs:246),
 * on pick-up, and to observers of an NPC (WorldObject_Networking.cs
 * SerializeCreateObject writes the Setup DID and the full ObjDesc).
 *
 * Pre-fix our player path took the setup from a gitignored world-DB export
 * keyed by weenie class (nothing attached without that file) and both paths
 * dropped the ObjDesc, so a dyed or tinkered weapon rendered in its base
 * colours and a scaled item at scale 1.
 */
export interface ItemVisualDesc extends AppearanceData {
  /** PhysicsDesc CSetup DID (0x02xxxxxx). */
  setupId: number;
  /** PhysicsDesc ObjScale (1 when not sent). */
  objScale: number;
  /** PhysicsDesc Translucency (0 / absent when not sent) — the item's own translucencyOriginal. */
  translucency?: number;
  /** PhysicsDesc PhysicsState: LightingOn lights a held torch. Our own
   *  items have no ServerObject to read it from. */
  physicsState?: number;
  /** PhysicsDesc PhysicsScriptTable (0 when not sent): a PlayScript on our
   *  own held item (a buff on the sword in hand) plays through it. */
  peTableId?: number;
  /**
   * PhysicsDesc AnimationFrame Placement (undefined when not sent): the
   * frame HandleCreateObject sets on the item's own CPhysicsObj before any
   * ParentEvent. ACE writes it for wielded items (Creature_Equipment.cs
   * GetPlacementLocation), so an item attached from its CreateObject alone
   * (login, a wielder streaming in) takes it, else Resting.
   */
  placement?: number;
}

/** The CreateObject slice an item's visual desc is read from. */
export interface ItemVisualSource extends Partial<AppearanceData> {
  setupId?: number;
  objScale?: number;
  translucency?: number;
  physicsState?: number;
  peTableId?: number;
  placement?: number;
}

/** The item's visual desc from its CreateObject, or undefined when it carried no setup. */
export function itemVisualDescOf(data: ItemVisualSource): ItemVisualDesc | undefined {
  if (!data.setupId) return undefined;
  return {
    setupId: data.setupId >>> 0,
    objScale: data.objScale || 1,
    translucency: data.translucency || 0,
    physicsState: data.physicsState ?? 0,
    peTableId: data.peTableId ?? 0,
    placement: data.placement,
    basePalette: data.basePalette ?? 0,
    subPalettes: data.subPalettes ?? [],
    textureChanges: data.textureChanges ?? [],
    animPartChanges: data.animPartChanges ?? [],
  };
}

/** A held item's placement: the ParentEvent's, else its CreateObject's, else Resting (InitObjectEnd). */
export function heldItemPlacement(parentEventPlacement: number | undefined, visual: Pick<ItemVisualDesc, 'placement'>): number {
  return parentEventPlacement ?? visual.placement ?? PLACEMENT_RESTING;
}

/** The SetupModelRenderer entry point this module drives. */
export interface WieldedMeshBuilder {
  createSetupMeshWithOverrides(
    setupId: number,
    placementKey?: number,
    partChanges?: Map<number, number>,
    perPartTextureOverrides?: Map<number, Map<number, number>>,
    paletteColors?: number[],
  ): THREE.Group | null;
}

/**
 * Build the held item's mesh: its setup at its own Placement (the
 * ParentEvent's placement, SetPlacementFrame), with its ObjDesc applied
 * exactly as any other object's (buildAppearanceOverrides), at its own
 * scale. Null when the setup does not build.
 */
/** userData flag: this wielded mesh was built while a streamed DAT file was missing. */
export const WIELDED_BUILT_WITH_MISS_KEY = 'acWieldedBuiltWithMiss';
/** userData: the Placement the wielded mesh was built with (for a re-attach: streamed files, an ObjDesc). */
export const WIELDED_PLACEMENT_KEY = 'acWieldedPlacement';

/** Wielded meshes under `root` built across a streamed miss, with what a re-attach needs. */
export function wieldedMeshesBuiltWithMiss(root: THREE.Object3D): Array<{ wieldedGuid: number; wielderGuid?: number; parentLocation: number; placement: number }> {
  const out: Array<{ wieldedGuid: number; wielderGuid?: number; parentLocation: number; placement: number }> = [];
  root.traverse((o) => {
    if (!o.userData[WIELDED_BUILT_WITH_MISS_KEY]) return;
    const loc = /^wielded_(\d+)$/.exec(o.name);
    const guid = o.userData.wieldedGuid as number | undefined;
    if (!loc || !guid) return;
    out.push({ wieldedGuid: guid, wielderGuid: o.userData.wielderGuid as number | undefined, parentLocation: Number(loc[1]), placement: (o.userData[WIELDED_PLACEMENT_KEY] as number) ?? PLACEMENT_RESTING });
  });
  return out;
}

export function buildWieldedItemMesh(
  builder: WieldedMeshBuilder,
  visual: ItemVisualDesc,
  placement: number | undefined,
  loadPaletteColors: (paletteId: number) => number[] | null | undefined,
): THREE.Group | null {
  // The ParentEvent's placement wins (SmartBox::DoParentEvent @ 00452290
  // SetPlacementFrame); without one, the CreateObject's, else Resting.
  placement = heldItemPlacement(placement, visual);
  const missEpoch = datMissEpoch();
  const ov = buildAppearanceOverrides(visual, loadPaletteColors);
  const mesh = builder.createSetupMeshWithOverrides(
    visual.setupId, placement, ov.partChanges, ov.perPartTextureOverrides, ov.paletteColors,
  );
  if (mesh && visual.objScale !== 1) mesh.scale.setScalar(visual.objScale);
  // BUG.held-item-own-state — the held item is its own CPhysicsObj
  // (DoParentEvent → set_parent): it draws at its own translucency
  // (set_description's translucencyOriginal), e.g. a Crystal Caul orb at 0.5.
  const translucency = visual.translucency ?? 0;
  if (mesh && translucency > 0) setServerTranslucency(mesh, translucency);
  if (mesh) mesh.userData[WIELDED_PLACEMENT_KEY] = placement;
  // RELEASE.streaming-regression-gate — built while a streamed file was not
  // resident: the wielder re-attaches it when the files land (main.ts
  // reattachStreamedWieldedItems), with the same Placement.
  if (mesh && !noDatMissSince(missEpoch)) mesh.userData[WIELDED_BUILT_WITH_MISS_KEY] = true;
  return mesh;
}

/**
 * Hang a held item's mesh on its holder's part as `wielded_<ParentLocation>`
 * (stamped with the item guid). `CPhysicsObj::set_parent` takes the object
 * off its previous holder and `CHILDLIST::add_child @ 0051b270` APPENDS it —
 * several children can share a holding location — so only an earlier copy
 * of the SAME item is replaced, anywhere under `root`. Keying by location
 * made the atlatl dart's ParentEvent (RightHand, as the atlatl) delete the
 * atlatl's mesh. Returns the copies removed (the caller frees their lights).
 */
export function attachHeldChild(
  root: THREE.Object3D, part: THREE.Object3D, itemMesh: THREE.Object3D,
  parentLocation: number, wieldedGuid: number,
): THREE.Object3D[] {
  const prior: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o !== itemMesh && o.name?.startsWith('wielded_') && o.userData?.wieldedGuid === wieldedGuid) prior.push(o);
  });
  for (const o of prior) o.parent?.remove(o);
  itemMesh.name = `wielded_${parentLocation}`;
  itemMesh.userData.wieldedGuid = wieldedGuid;
  part.add(itemMesh);
  cancelHolderScale(root, part, itemMesh);
  return prior;
}

/**
 * BUG.held-item-own-state — CPhysicsObj::UpdateChild @ 00512d50 places a
 * child at Frame::combine(holder part frame, holding frame): frames carry no
 * scale, so neither the holding offset nor the child is scaled by its
 * holder (ObjScale or the part's DefaultScale); the child keeps its own
 * scale. Ours hangs the copy under the scaled part node, so the chain's
 * scale is divided back out of the copy's local offset and scale.
 */
export function cancelHolderScale(root: THREE.Object3D, part: THREE.Object3D, itemMesh: THREE.Object3D): void {
  let sx = 1, sy = 1, sz = 1;
  for (let n: THREE.Object3D | null = part; n; n = n.parent) {
    sx *= n.scale.x; sy *= n.scale.y; sz *= n.scale.z;
    if (n === root) break;
  }
  if ((sx === 1 && sy === 1 && sz === 1) || !sx || !sy || !sz) return;
  itemMesh.position.set(itemMesh.position.x / sx, itemMesh.position.y / sy, itemMesh.position.z / sz);
  itemMesh.scale.set(itemMesh.scale.x / sx, itemMesh.scale.y / sy, itemMesh.scale.z / sz);
}

/**
 * The guid of the held item whose copy `hit` belongs to, below `root`
 * (innermost first: the dart on the atlatl), or 0 when `hit` is the
 * holder's own part. Retail's held item is its own CPhysicsObj: the select
 * test (CPhysicsPart::Draw @ 0050d7a0) records the drawn part's own physobj
 * id, so a ray on a held sword finds the sword, not its holder.
 */
export function heldCopyGuidAt(hit: THREE.Object3D | null | undefined, root: THREE.Object3D): number {
  for (let n = hit; n && n !== root; n = n.parent) {
    const guid = n.userData?.wieldedGuid;
    if (guid && n.name?.startsWith('wielded_')) return guid;
  }
  return 0;
}

/**
 * The holder's scale changed by `ratio` (new / old ObjScale): its held
 * copies keep their own size and holding offset (cancelHolderScale), so the
 * outermost copies are rescaled by 1 / ratio; nested ones ride on them.
 */
export function rescaleHeldCopiesForHolder(root: THREE.Object3D, ratio: number): void {
  if (!(ratio > 0) || ratio === 1) return;
  for (const o of heldCopiesUnder(root)) {
    if (heldCopyGuidAt(o.parent, root)) continue;
    o.position.divideScalar(ratio);
    o.scale.divideScalar(ratio);
  }
}

/** The held copies (`wielded_*` meshes) anywhere under `root`, optionally of one item. */
export function heldCopiesUnder(root: THREE.Object3D, wieldedGuid?: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o === root || !o.name?.startsWith('wielded_') || !o.userData?.wieldedGuid) return;
    if (wieldedGuid === undefined || o.userData.wieldedGuid === wieldedGuid) out.push(o);
  });
  return out;
}

/**
 * Take every held copy off `root` (a clone of a holder). Retail's paperdoll
 * figure is a fresh object (gmPaperDollUI::RedressCreature @ 004a3bc0:
 * CPhysicsObj::makeObject from the player's Setup, then
 * DoObjDescChangesFromDefault with the player's visual desc). It has no
 * children, so a wielded weapon, shield or torch never shows on it, and the
 * click map (GetPaperDollItemUnderMouse @ 004a4920) has body regions only.
 * Those items are picked from their slots. Returns the copies removed.
 */
export function stripHeldCopies(root: THREE.Object3D): THREE.Object3D[] {
  const held = heldCopiesUnder(root);
  for (const o of held) o.parent?.remove(o);
  return held;
}
