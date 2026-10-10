import type { InventoryManager } from '@ac/shared';

/**
 * BUG.deleted-item-stays-in-pack — a DeleteObject for an item the player
 * holds drops it from the inventory. ACE's ConsumeItem removal
 * (WorldObject.DeleteObject → Player.TryRemoveFromInventoryWithNetworking,
 * Player_Inventory.cs:217; used by @delete and expiring lifespan items) sends
 * PublicUpdateInstanceID(Container→0) + DeleteObject and no
 * InventoryRemoveObject. Retail's DeleteObject destroys the weenie
 * (SmartBox::HandleDeleteObject @ 00451ea0 → CObjectMaint::DeleteObject @
 * 005084d0), so the item leaves the pack with it. Returns true when the
 * item was in the inventory.
 */
export function dropDeletedOwnedItem(inventory: Pick<InventoryManager, 'getItem' | 'removeItem'>, guid: number): boolean {
  if (!inventory.getItem(guid)) return false;
  inventory.removeItem(guid);
  return true;
}
