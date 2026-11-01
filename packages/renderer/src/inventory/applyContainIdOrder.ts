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
