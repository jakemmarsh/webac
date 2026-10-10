/**
 * BUG.sold-item-lingers-in-local-inventory — 0x0022 ServerSaysContainID
 * (GameEventItemServerSaysContainId) into a container OUTSIDE the player's
 * hierarchy.
 *
 * Retail ACCWeenieObject::ServerSaysMoveItem @ 0058dbb0 moves the object
 * for ANY container: RemoveContent from its old container (so it leaves our
 * pack), AddContent to the new one, and clears the player wield location when
 * the old wielder was the player. ACE relies on that for the sell path:
 * Player_Commerce.cs:201-203 sends ServerSaysContainId(item, vendor) after
 * TryRemoveFromInventoryWithNetworking(SellItem) / TryDequipObjectWithNetworking
 * (SellItem), and Player_Inventory.cs:222-226 sends NO InventoryRemoveObject
 * for SellItem. GiveItem (Player_Inventory.cs:3359) does send
 * InventoryRemoveObject first, so its ContainId(item, target) finds nothing
 * left to remove here — removal is idempotent.
 */
import type { InventoryItem } from '@ac/shared';
import type { PlayerState } from './PlayerState.js';

export interface ContainInContext {
  /** The player's guid (the main pack). */
  playerGuid: number;
  /** sidePackGuids — [0] = main pack, [1..] = side packs. */
  sidePackGuids: readonly number[];
  /** The open external container (GAP.20's chest branch owns stores into it); 0 = none. */
  openContainerGuid: number;
  /** Whether a guid is an object we carry (a pack not yet in sidePackGuids still counts). */
  isCarried(guid: number): boolean;
}

/**
 * True when a ContainId into `containerGuid` takes the object out of the
 * player's container hierarchy — not the player, not one of our packs, and
 * not the open external container (whose store path stashes + shows the item
 * in the container panel). Container 0 is not a contain-in.
 */
export function containInLeavesPlayer(containerGuid: number, ctx: ContainInContext): boolean {
  if (containerGuid === 0) return false;
  if (containerGuid === ctx.playerGuid) return false;
  if (ctx.sidePackGuids.includes(containerGuid)) return false;
  if (ctx.openContainerGuid !== 0 && containerGuid === ctx.openContainerGuid) return false;
  if (ctx.isCarried(containerGuid)) return false;
  return true;
}

/**
 * Drop an object (and, for a pack, everything inside it — the contents move
 * with the pack) from the local inventory + equipment. Returns the removed
 * records, the object first; empty when we did not carry it.
 */
export function removeItemLeavingPlayer(
  playerState: Pick<PlayerState, 'inventory' | 'equipment'>,
  itemGuid: number,
): InventoryItem[] {
  const item = playerState.inventory.getItem(itemGuid);
  if (!item) return [];
  const removed: InventoryItem[] = [item];
  for (const inner of playerState.inventory.getAll()) {
    if (inner.id !== itemGuid && inner.containerId === itemGuid) removed.push(inner);
  }
  for (const r of removed) {
    // ServerSaysMoveItem @ 0058dbb0: the old wielder was the player →
    // SetPlayerWieldLocation(this, 0) (a sold wielded item).
    playerState.equipment.unequipItem(r.id);
    playerState.inventory.removeItem(r.id);
  }
  return removed;
}
