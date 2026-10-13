import type { InventoryItem } from '@ac/shared';
import type { PlayerState } from './PlayerState.js';
import { removeItemLeavingPlayer } from './containInLeavesPlayer.js';

/**
 * BUG.deleted-item-stays-in-pack — a DeleteObject for an item the player
 * holds drops it from the inventory. ACE's ConsumeItem removal
 * (WorldObject.DeleteObject → Player.TryRemoveFromInventoryWithNetworking,
 * Player_Inventory.cs:217; used by @delete and expiring lifespan items) sends
 * PublicUpdateInstanceID(Container→0) + DeleteObject and no
 * InventoryRemoveObject. Retail's DeleteObject destroys the weenie
 * (SmartBox::HandleDeleteObject @ 00451ea0 → CObjectMaint::DeleteObject @
 * 005084d0), so the item leaves the pack with it.
 *
 * BUG.death-items-stay-equipped — the same holds for a WORN item.
 * TryDequipObjectWithNetworking (Player_Inventory.cs:396-421) answers a
 * ToCorpseOnDeath / TradeItem / ConsumeItem dequip with Wielder→0,
 * CurrentWieldedLocation→0, PickupEvent, Sound and then DeleteObject — no
 * InventoryRemoveObject, no ServerSaysContainId. Pre-fix the delete dropped
 * the inventory record only, so the EquipmentSystem copy (equipItem stores a
 * COPY) kept the coat a death moved to the corpse: the paperdoll figure lost
 * it (ObjDescEvent) but its slot still selected "Amuli Coat", the agent
 * snapshot listed it worn, and the next wear tried to dequip it ("Source item
 * not found!" from ACE, then our "The Amuli Coat can't be put in the
 * container"). The same delete ends a last arrow fired from the ammo slot
 * (Player_Missile.cs:341), a worn item decaying (WorldObject_Decay.cs:155)
 * and a worn item traded away (Player_Trade.cs:239).
 *
 * Returns true when the item was carried or worn.
 */
export function dropDeletedOwnedItem(playerState: Pick<PlayerState, 'inventory' | 'equipment'>, guid: number): boolean {
  return releaseOwnedItem({ playerState }, guid).length > 0;
}

export interface OwnedItemReleaseContext {
  playerState: Pick<PlayerState, 'inventory' | 'equipment'>;
  /** sidePackGuids ([0] = main pack): a released side pack leaves it (mutated in place). */
  sidePackGuids?: number[];
  /** Drop any optimistic equip/unequip pending for a released item, so a later failure can't put it back on. */
  forgetPendingEquip?(itemId: number): void;
}

/**
 * Take an object the server says is no longer the player's (DeleteObject,
 * InventoryRemoveObject) out of the local inventory AND equipment, with a
 * pack's contents (they go with it: ACCWeenieObject::
 * AddContentsToDestructionQueue @ 0058c9a0). Returns the released records,
 * the object first; empty when we neither carried nor wore it.
 */
export function releaseOwnedItem(ctx: OwnedItemReleaseContext, guid: number): InventoryItem[] {
  const { playerState } = ctx;
  let released: InventoryItem[] = removeItemLeavingPlayer(playerState, guid);
  if (released.length === 0) {
    // Worn with no inventory record (an equipment copy only): still release it.
    const worn = playerState.equipment.unequipItem(guid);
    if (worn) released = [worn];
  }
  for (const r of released) {
    ctx.forgetPendingEquip?.(r.id);
    if (ctx.sidePackGuids) {
      const at = ctx.sidePackGuids.indexOf(r.id);
      if (at > 0) ctx.sidePackGuids.splice(at, 1);
    }
  }
  return released;
}
