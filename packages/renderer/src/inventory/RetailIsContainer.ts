/**
 * BUG.foci-in-main-pack — the one test for "this object goes in a pack slot, not an item slot".
 *
 * Retail ACCWeenieObject::IsContainer @ 004a4530 is `(pwd._bitfield & BF_REQUIRES_PACKSLOT 0x800000)
 * || pwd._itemsCapacity || pwd._containersCapacity`. AddContent @ 0058cce0 puts an object that passes
 * it in its container's containers list (the side-pack column of the inventory) and every other
 * object in the items list (the grid). The ITEM_TYPE is not read: a Foci (wcid 15268-15271, 43173:
 * WeenieType Generic, ItemType Misc, no capacities) is a pack-slot object only through
 * RequiresBackpackSlot, which ACE sends as ObjectDescriptionFlag.RequiresPackSlot
 * (WorldObject_Networking.cs UpdateObjectDescriptionFlags) and counts against the side-pack slots
 * (Container.cs); GDLE / the AC1999 server set BF_REQUIRES_PACKSLOT the same way
 * (PublicWeenieDesc.cpp). Every era reads this one bit.
 *
 * Pre-fix the pack column admitted only ItemType.Container, so a focus sat in the main grid and
 * the grid's own drag code (which already used this test) refused it: "Cannot place container in
 * item list" (player report, end of retail ACE).
 */
import { ItemType, ObjectDescriptionFlag } from '@ac/shared';

/** ObjectDescriptionFlag.RequiresPackSlot (BF_REQUIRES_PACKSLOT). */
export const BF_REQUIRES_PACK_SLOT = ObjectDescriptionFlag.RequiresPackSlot;

/** What IsContainer reads of an object (a CreateObject record, an inventory entry). */
export interface RetailContainerFacts {
  /** PublicWeenieDesc._bitfield (ObjectDescriptionFlag). */
  objectDescFlags?: number;
  itemsCapacity?: number;
  containersCapacity?: number;
  /**
   * ITEM_TYPE, read only as a stand-in for a capacity the record no longer carries: an inventory
   * entry keeps `itemsCapacity` only when the pack is Openable (buildInventoryEntry), so a locked
   * pack's raw capacity is gone and its TYPE_CONTAINER bit answers for it. Leave it out where the
   * raw capacities are known (a server record).
   */
  itemType?: number;
}

/** ACCWeenieObject::IsContainer @ 004a4530: RequiresPackSlot, or an item / container capacity. */
export function isRetailContainer(o: RetailContainerFacts): boolean {
  return ((o.objectDescFlags ?? 0) & BF_REQUIRES_PACK_SLOT) !== 0
    || (o.itemsCapacity ?? 0) !== 0
    || (o.containersCapacity ?? 0) !== 0
    || ((o.itemType ?? 0) & ItemType.Container) !== 0;
}

/**
 * UIElement_ItemList::ItemList_UpdateContainerListSize @ 004e39e0 for one of our side-pack-column
 * objects opened in the grid: a container that is not Openable (bitfield & 1 clear) and is not the
 * player lists 0 fixed cells (UpdateFixedSlots trims the list to none) — a focus opens to an empty
 * list; an Openable one lists its `_itemsCapacity` (a negative one pads, -1). Returns -1 when the
 * record says neither (no bitfield, no capacity): the visible area is padded.
 */
export function sideContainerFixedSlots(o: { objectDescFlags?: number; itemsCapacity?: number }): number {
  if (o.objectDescFlags !== undefined && (o.objectDescFlags & ObjectDescriptionFlag.Openable) === 0) return 0;
  return o.itemsCapacity ?? -1;
}

/**
 * Whether a carried object joins the inventory's side-pack column (main.ts sidePackGuids): it is
 * directly in the player (not wielded, not inside a side pack) and passes IsContainer — AddContent
 * @ 0058cce0 lists it in the player's containers list. A CreateObject and a ServerSaysContainID
 * pick-up both decide here.
 */
export function joinsSidePackColumn(o: RetailContainerFacts & { containerId?: number; wielderId?: number }, playerGuid: number | null): boolean {
  if (playerGuid === null || !playerGuid) return false;
  if ((o.containerId ?? 0) !== playerGuid || (o.wielderId ?? 0) !== 0) return false;
  return isRetailContainer(o);
}
