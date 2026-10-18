/**
 * The item slots each of your packs has taken, as the server counts them (ACE Container.CountPackItems: the container's
 * own Inventory, packs left out; worn and wielded items are the player's EquippedObjects, in no pack at all). The agent
 * host's packs() (main.ts) answers with these for observe's "pack slots" line, the loot's full-pack warning and the
 * macro's Autostack / Autocram.
 *
 * Worn items stay in the client's inventory list beside the pack items (EquipmentSystem keeps a copy; the record keeps
 * the container it last had, 0 or the player), so a count of "container is the player or 0" took every worn piece for a
 * main-pack item: Bulwark's "main pack 91/102" was 72 pack items and his 19 worn ones, and after selling his stones it
 * read "108/102 FULL" with 89 in it (stream 2026-10-18 12:11:35 and 12:16:28Z).
 */
export interface PackCountItem { id: number; containerId: number }

export function packSlotCounts<T extends PackCountItem>(
  items: ReadonlyArray<T>,
  ctx: {
    playerGuid: number;
    /** Slot 0 is the main pack (the player); then the side packs, in pack-slot order. */
    sidePackGuids: ReadonlyArray<number>;
    /** Worn and wielded items (the paperdoll). */
    worn: ReadonlySet<number>;
    /** A pack (or a RequiresPackSlot item) sitting in a pack slot, not an item slot. */
    isPack: (item: T) => boolean;
    capacityOf: (slot: number, guid: number) => number;
  },
): Array<{ slot: number; guid: number; capacity: number; count: number }> {
  return ctx.sidePackGuids.flatMap((g, slot) => {
    const guid = slot === 0 ? ctx.playerGuid : g;
    if (!guid) return [];
    const count = items.filter((i) => {
      if (ctx.worn.has(i.id >>> 0)) return false;
      if (slot === 0) return (i.containerId === ctx.playerGuid || i.containerId === 0) && !ctx.isPack(i);
      return i.containerId === guid;
    }).length;
    return [{ slot, guid, capacity: ctx.capacityOf(slot, guid), count }];
  });
}
