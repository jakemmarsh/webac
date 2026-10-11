/**
 * BUG.updateobject-own-inventory-routed-to-world — shared subject routing
 * for ObjectCreate (0xF745) and ObjectUpdate (0xF7DB).
 *
 * Retail ground truth: SmartBox::HandleUpdateObject @ 00455580 is a
 * one-line tail call into HandleCreateObject(..., is_update=1) — the
 * update takes the IDENTICAL routing path as create (destroy the existing
 * CPhysicsObj, re-create from the wire descs). ACE mirrors the wire shape:
 * GameMessageUpdateObject serializes via SerializeCreateObject, and its
 * routine senders target items inside the recipient's own inventory
 * (Tailoring.cs:504,563; Aetheria.cs:241; RecipeManager.cs:397 for every
 * recipe that modifies a target — dyes, imbues, quest combines).
 *
 * Pre-fix, main.ts onObjectUpdate ignored ownership and world-routed every
 * subject into ServerObjectManager.createObject: a contained item (no
 * Position block on the wire) never refreshed playerState.inventory and
 * registered a phantom ServerObject whose mesh was scene-added at world
 * origin.
 */

import { ObjectDescriptionFlag } from '@ac/shared';
import { itemVisualDescOf, type ItemVisualDesc, type ItemVisualSource } from '../models/WieldedItemVisual.js';

/** The minimal slice of CreateObjectData the routing decision reads. */
export interface ObjectSubjectIds {
  guid: number;
  containerId: number;
  wielderId: number;
}

export type ObjectSubjectRoute =
  /** The local player's own CreateObject — handled by the connection-level path. */
  | 'self'
  /** Contained by / wielded by the local player, or inside a tracked side pack. */
  | 'own-inventory'
  /** Everything else — a world object for ServerObjectManager. */
  | 'world';

/**
 * Classify a 0xF745/0xF7DB subject. Mirrors the branch order of main.ts
 * onObjectCreate: self first, then player-direct containment/wield, then
 * side-pack containment, else world. (The open-external-container overlay
 * is a UI concern layered on the world route by the caller — retail keeps
 * those objects in CObjectMaint too.)
 */
export function routeObjectSubject(
  data: ObjectSubjectIds,
  aceCharGuid: number | null,
  sidePackGuids: readonly number[],
): ObjectSubjectRoute {
  if (aceCharGuid === null) return 'world';
  if (data.guid === aceCharGuid) return 'self';
  if (data.containerId === aceCharGuid || data.wielderId === aceCharGuid) return 'own-inventory';
  if (sidePackGuids.includes(data.containerId)) return 'own-inventory';
  return 'world';
}

/**
 * RELEASE.gdle-untested-surfaces — a ServerSaysContainId (0x0022) that
 * arrives before its item's CreateObject. Retail's 0x0022 dispatch (the
 * 0x22 case of the game-event switch, decomp ~339868) asks CObjectMaint for
 * the item; when the client does not know it yet it still finds the
 * container and calls ACCWeenieObject::ServerSaysContainID @ 0058be40,
 * which adds the item id to the container's own items (or containers) list
 * at its slot. The pack lists the item from then on, so the CreateObject
 * that follows needs no container field of its own.
 *
 * GDLE sends a vendor purchase, a quest reward and any other item spawned
 * into a pack in exactly that order (CContainerWeenie::SpawnInContainer:
 * InventoryMove, then MakeAware with the item not yet contained, carrying
 * a Position, then a PickupEvent and the Container PublicUpdateInstanceID).
 * Retail places that object and the PickupEvent lifts it out of the world
 * again, while the pack already lists it. Without this record the item was
 * routed to the world: the pyreals left and the purchase never appeared.
 * ACE always sends the CreateObject first, so it never takes this path.
 */
export class PendingContainIds {
  private readonly containerOf = new Map<number, number>();

  /** A ContainId named an item the client does not hold yet. */
  note(itemGuid: number, containerGuid: number): void {
    this.containerOf.set(itemGuid, containerGuid);
  }

  /** The item left before its CreateObject arrived (DeleteObject, or a ContainId elsewhere). */
  forget(itemGuid: number): void {
    this.containerOf.delete(itemGuid);
  }

  get size(): number {
    return this.containerOf.size;
  }

  /**
   * The CreateObject subject as retail sees it: a remembered container fills
   * in a wire record that names no container or wielder of its own (its
   * Position, if any, is the world placement the PickupEvent undoes).
   * Consumes the record either way.
   */
  resolve<T extends ObjectSubjectIds>(data: T): T {
    const container = this.containerOf.get(data.guid);
    if (container === undefined) return data;
    this.containerOf.delete(data.guid);
    if (data.containerId || data.wielderId) return data;
    return { ...data, containerId: container };
  }
}

/** The slice of CreateObjectData that becomes a playerState inventory entry. */
export interface InventoryEntrySource extends ItemVisualSource {
  weenieClassId: number;
  name: string;
  pluralName?: string;
  value: number;
  burden: number;
  stackSize: number;
  maxStackSize: number;
  containerId: number;
  iconId: number;
  validLocations: number;
  itemType: number;
  uiEffects: number;
  usable: number;
  combatUse?: number;
  iconOverlayId?: number;
  iconUnderlayId?: number;
  cooldownId?: number;
  cooldownDuration?: number;
  structure?: number;
  maxStructure?: number;
  /** CORE.17.k.b.b.c.c.a.a.c.a.a.a — WeenieHeaderFlag.MaterialType (0 = not sent). */
  materialType?: number;
  /** WeenieHeaderFlag.Workmanship float (absent = not sent): a salvage bag's average workmanship. */
  workmanship?: number;
  targetType?: number;
  clothingPriority?: number;
  ammoType?: number;
  spellDid?: number;
  /** CORE.17.o.a — PublicWeenieDesc bitfield (ObjectDescriptionFlag). */
  objectDescFlags?: number;
  /** CORE.17.o.a — WeenieHeaderFlag.ItemsCapacity byte (0 = not sent). */
  itemsCapacity?: number;
  /** PublicWeenieDesc._hook_type (0 = not sent). */
  hookType?: number;
}

/**
 * Build the InventoryManager.addItem payload from CreateObject wire data.
 * Extracted verbatim from main.ts onObjectCreate so the create and update
 * paths share one mapping (addItem with the wire guid as forceId upserts —
 * an ObjectUpdate refreshes name/icon/appearance of the existing entry in
 * place, which is exactly the retail destroy-and-recreate semantic).
 */
export function buildInventoryEntry(data: InventoryEntrySource): {
  weenieClassId: number;
  name: string;
  pluralName: string | undefined;
  value: number;
  burden: number;
  stackSize: number;
  maxStackSize: number;
  stackable: boolean;
  containerId: number;
  iconDid: number;
  validLocations: number;
  itemType: number;
  uiEffects: number;
  usable: number;
  combatUse: number | undefined;
  iconOverlayDid: number | undefined;
  iconUnderlayDid: number | undefined;
  cooldownId: number | undefined;
  cooldownDuration: number | undefined;
  structure: number | undefined;
  maxStructure: number | undefined;
  targetType: number | undefined;
  clothingPriority: number | undefined;
  ammoType: number | undefined;
  spellDid: number | undefined;
  itemsCapacity: number | undefined;
  materialType: number | undefined;
  workmanship: number | undefined;
  hookType: number | undefined;
  objectDescFlags: number | undefined;
  visualDesc: ItemVisualDesc | undefined;
} {
  return {
    // RECON.wielded-item-objdesc — the held mesh's setup, scale and ObjDesc.
    visualDesc: itemVisualDescOf(data),
    // CORE.17.k.b.b.c.c.a.a.c.a.a.a — gmSalvageUI::IsItemSuitable @ 004cb040
    // reads pwd._material_type and the bitfield's Retained bit (0x01000000).
    materialType: data.materialType || undefined,
    // PublicWeenieDesc._workmanship: a salvage bag's average (VTank's CombineSalvage bands).
    workmanship: data.workmanship || undefined,
    // ItemHolder::CheckHookStatus @ 00586e90 — the mounts the item fits.
    hookType: data.hookType || undefined,
    objectDescFlags: data.objectDescFlags,
    // CORE.17.k.b.b.a.g.e — the item's built-in spell (WeenieHeaderFlag.Spell):
    // the spell bar's endowment icon reads it off the wielded caster.
    spellDid: data.spellDid || undefined,
    weenieClassId: data.weenieClassId,
    name: data.name,
    pluralName: data.pluralName || undefined,
    value: data.value,
    burden: data.burden,
    stackSize: data.stackSize || 1,
    maxStackSize: data.maxStackSize || 1,
    stackable: data.maxStackSize > 1,
    containerId: data.containerId,
    iconDid: data.iconId,
    validLocations: data.validLocations,
    itemType: data.itemType,
    uiEffects: data.uiEffects,
    usable: data.usable,
    combatUse: data.combatUse || undefined,
    iconOverlayDid: data.iconOverlayId || undefined,
    iconUnderlayDid: data.iconUnderlayId || undefined,
    // BUG.cooldown-id-duration-discarded — the icon decile meter's inputs.
    cooldownId: data.cooldownId || undefined,
    cooldownDuration: data.cooldownDuration || undefined,
    // BUG.structure-maxstructure-discarded — the icon uses-remaining bar's
    // inputs. structure keeps a real 0 (spent item, empty bar) as long as
    // maxStructure gates the meter on; maxStructure 0 -> undefined (no
    // meter), matching the iconOverlay/cooldown normalization.
    structure: data.maxStructure ? (data.structure ?? 0) : undefined,
    maxStructure: data.maxStructure || undefined,
    // BUG.weenie-targettype-discarded — the use-with-target compatibility
    // gate's input (0 = unrestricted -> undefined, matching ACE null).
    targetType: data.targetType || undefined,
    // BUG.clothingpriority-never-lands — WeenieHeaderFlag.Priority
    // (ClothingPriority CoverageMask). Kept as-is including a real 0:
    // the flag is present iff the property is non-null server-side, so
    // undefined here means "not sent", not "zero priority".
    clothingPriority: data.clothingPriority,
    // WeenieHeaderFlag.AmmoType — the appraisal's ammunition line.
    ammoType: data.ammoType,
    // CORE.17.o.a — the open pack's fixed grid size. Retail
    // ItemList_UpdateContainerListSize @ 004e39e0 takes the container's
    // pwd._itemsCapacity only when its bitfield carries Openable (0x1) or
    // it is the player; any other container resolves to 0. A non-openable
    // pack therefore stays undefined (visible-area padding), while an
    // openable one keeps its wire value — the unpack default 0 and the
    // signed -1 of a world-DB "-1" container (chest, corpse) included; the
    // grid treats a negative value as retail does (attribute -1 → padding).
    itemsCapacity: ((data.objectDescFlags ?? 0) & ObjectDescriptionFlag.Openable) !== 0
      ? (data.itemsCapacity ?? 0)
      : undefined,
  };
}

/**
 * GAP.world-drag-drop — retail ServerSaysMoveItem @ 0058dbb0 (the 0x0022
 * ServerSaysContainID) moves the EXISTING ACCWeenieObject into the named
 * container; a ground object picked up (the 3D drag, a double-click, the
 * drop on yourself) never gets a fresh CreateObject from ACE —
 * DoHandleActionPutItemInContainer sends only PublicUpdateInstanceID
 * (Container) + ServerSaysContainId. So the client keeps each movable world
 * object's CreateObject record (not a creature, not Stuck — nothing else can
 * be picked up) and builds the carried item from it when the server contains
 * it in one of the player's packs.
 */
export class WorldObjectRecords {
  private readonly records = new Map<number, InventoryEntrySource>();

  /** Keep the record of a world object that could be picked up. */
  remember(guid: number, data: InventoryEntrySource & { objectDescFlags?: number }): void {
    const movable = (data.itemType & 0x10) === 0 && ((data.objectDescFlags ?? 0) & 0x4) === 0;
    if (movable) this.records.set(guid >>> 0, data);
    else this.records.delete(guid >>> 0);
  }

  forget(guid: number): void {
    this.records.delete(guid >>> 0);
  }

  has(guid: number): boolean {
    return this.records.has(guid >>> 0);
  }

  /** The kept CreateObject record (null when not known) — UseObject reads its PublicWeenieDesc. */
  sourceOf(guid: number): InventoryEntrySource | null {
    return this.records.get(guid >>> 0) ?? null;
  }

  /** GAP.world-drag-drop.a — the PublicWeenieDesc valid locations of a known ground object (null when not known). */
  validLocationsOf(guid: number): number | null {
    const data = this.records.get(guid >>> 0);
    return data ? data.validLocations >>> 0 : null;
  }

  /** GAP.world-drag-drop.a.a — the known ground object's PublicWeenieDesc as an inventory entry, without spending the record (null when not known). */
  entryOf(guid: number): ReturnType<typeof buildInventoryEntry> | null {
    const data = this.records.get(guid >>> 0);
    return data ? buildInventoryEntry(data) : null;
  }

  /** ServerSaysMoveItem into `containerGuid`: the carried entry (and the record is spent), or null for an object not known in 3D. */
  containIn(guid: number, containerGuid: number): ReturnType<typeof buildInventoryEntry> | null {
    const data = this.records.get(guid >>> 0);
    if (!data) return null;
    this.records.delete(guid >>> 0);
    return buildInventoryEntry({ ...data, containerId: containerGuid >>> 0 });
  }
}
