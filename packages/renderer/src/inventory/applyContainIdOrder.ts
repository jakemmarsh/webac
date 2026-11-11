/**
 * BUG.ac1999-inventory-placement-order — where an InventoryPutObjInContainer (0x22, every era:
 * Inventory1999 passes the AC1999 server's InventoryMove through unchanged) puts the item in its
 * container's order.
 *
 * Retail moves the object out of the list it was in and INSERTS it at the event's slot, shifting
 * the items after it: EoL ACCWeenieObject::ServerSaysMoveItem @ 0058dbb0 → RemoveContent, then
 * AddContent @ 0058cce0 (or ServerSaysContainID @ 0058be40 for an object not created yet) →
 * IDList::AddAtNum @ 005add20; the 1999 ACCWeenieObject_ServerSaysMoveItem @ 0x004e2120 →
 * ACCWeenieObject_AddContent @ 0x004e26d0 clamps the slot to the count and inserts the same way.
 * A ContainerType other than 0 (a pack or a foci) indexes the container's containers list, not
 * its items list.
 */
import type { InventoryManager } from '@ac/shared';

export interface ContainIdEvent {
  itemGuid: number;
  containerGuid: number;
  /** The slot (PlacementPosition) in the container's list. */
  slot: number;
  /** The event's ContainerType (ACE: NonContainer 0 / Container 1 / Foci 2; AC1999: RequiresPackSlot 0 / 1). */
  itemType: number;
}

/** Apply the event to the inventory's order. True when the slot is in the containers list. */
export function applyContainIdOrder(inventory: InventoryManager, e: ContainIdEvent): boolean {
  const packs = e.itemType !== 0;
  inventory.setSlotForItem(e.itemGuid, e.slot, e.containerGuid, packs);
  return packs;
}

/** The parts of a CreateObject that decide where a carried object is listed. */
export interface ContainedCreate {
  guid: number;
  containerId: number;
  wielderId?: number;
  /** PublicWeenieDesc._bitfield (ObjectDescriptionFlag). */
  objectDescFlags?: number;
  itemsCapacity?: number;
  containersCapacity?: number;
}

/** ObjectDescriptionFlag.RequiresPackSlot: AddContent's containers-list test. */
const BF_REQUIRES_PACKSLOT = 0x800000;

/**
 * webac#29 — a create that names a container lists the object there the way retail's
 * ACCObjectMaint::SetWeenieDesc @ 00557a20 (1999: 0x004df510) does: its place in that container's
 * list when it is already in it, else slot 0 (first). The list is the containers list when the
 * object has container capacity or needs a pack slot (AddContent @ 0058cce0's test; 1999
 * ACCWeenieObject_HasContainerCapacity). A wielded object (no container) is left alone.
 *
 * This is how a player-to-player give, an NPC's give emote and a trade reach the receiver on the
 * AC1999 server and GDLE: FinishGiveItem / SimulateGiveObject send the receiver only the item's
 * contained 0xF745 (the 0x22 goes to the giver), and OnReceiveInventoryItem inserts it at m_Items
 * slot 0. ACE follows its create with a ServerSaysContainId that then sets the slot itself.
 *
 * Returns whether the order changed and which list it is in.
 */
export function applyContainOnCreate(inventory: InventoryManager, d: ContainedCreate): { changed: boolean; packs: boolean } {
  if (!d.containerId || d.wielderId) return { changed: false, packs: false };
  const packs = ((d.objectDescFlags ?? 0) & BF_REQUIRES_PACKSLOT) !== 0
    || (d.itemsCapacity ?? 0) !== 0 || (d.containersCapacity ?? 0) !== 0;
  return { changed: inventory.containOnCreate(d.guid, d.containerId, packs), packs };
}
