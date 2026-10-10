/**
 * The WieldObject game event (0x0023): UIQueueManager's case 0x23 @ 339887 →
 * ACCWeenieObject::ServerSaysMoveItem @ 0058dbb0(obj, 0, 0, player, location, 1),
 * the call that moves the object onto the player AND clears the pending
 * inventory request for it (the trailing 1).
 *
 * BUG.wield-leaves-request-pending — our tracker was cleared only by the
 * ParentEvent (0xF749) that follows a HELD wield, so wearing armor, clothing
 * or jewelry (no ParentEvent) left the GetAndWieldItem pending for good and
 * refused every later inventory request with "You can only move or use one
 * item at a time".
 *
 * GAP.world-drag-drop.a — a ground object wielded straight off the landblock
 * (GetAndWieldItem on a 3D object; ACE sends no CreateObject for it) becomes
 * a carried item from its CreateObject record and leaves the 3D view, as the
 * pack pick-up does in ServerSaysContainID.
 *
 * Then the server-confirmed wield confirms the optimistic equip
 * (BUG.equip-unequip-optimistic-no-rollback) and dirties the inventory view.
 * No local chime (BUG.duplicate-local-sounds): ACE sends Sound.WieldObject on
 * the player itself (Player_Inventory.cs:306 / :1831, Creature_Equipment.cs:360).
 */

export interface ServerWieldObjectDeps<Entry, Item> {
  /** InventoryRequestTracker.respond. */
  respond(objectId: number): unknown;
  /** WorldObjectRecords.containIn: the carried entry for a known ground object (null otherwise). */
  containIn(guid: number, containerGuid: number): Entry | null;
  playerId: number | null;
  getItem(guid: number): Item | undefined;
  addItem(entry: Entry, guid: number): void;
  removeWorldObject(guid: number): void;
  equip(item: Item, location: number): void;
  /** PendingEquipmentActions.confirm: the optimistic equip no longer needs a rollback. */
  confirmEquip(itemId: number): void;
  markInventoryDirty(): void;
}

/** Apply a WieldObject; returns the wielded item, or null when the object is not known. */
export function applyServerWieldObject<Entry, Item>(
  deps: ServerWieldObjectDeps<Entry, Item>, itemGuid: number, location: number,
): Item | null {
  deps.respond(itemGuid);
  if (!deps.getItem(itemGuid) && deps.playerId !== null) {
    const picked = deps.containIn(itemGuid, deps.playerId);
    if (picked) {
      deps.removeWorldObject(itemGuid);
      deps.addItem(picked, itemGuid);
    }
  }
  const item = deps.getItem(itemGuid) ?? null;
  if (item) {
    deps.equip(item, location);
    deps.confirmEquip(itemGuid);
    deps.markInventoryDirty();
  }
  return item;
}
