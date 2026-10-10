/**
 * BUG.inventory-put-slot-itemtype-unused — every server-side contain-in
 * event (pickup, vendor buy, trade completion, corpse loot, server-side
 * reshuffle — not just the client's own optimistic drag-drop) carries the
 * item's authoritative PlacementPosition via
 * `GameEventItemServerSaysContainId` per
 * `reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventItemServerSaysContainId.cs:10-13`.
 * Pre-fix, `onInventoryPut` (main.ts) logged `data.slot` but never fed it
 * into `InventoryManager`, so any item landing in a container via a path
 * other than a local drag rendered at Map-insertion order until the next
 * full PlayerDescription-driven relog.
 *
 * The fix: `InventoryManager.setSlotForItem(guid, slot)` upserts a single
 * guid→index entry into `_placementOrder` (unlike `setPlacementOrder`,
 * which replaces the whole order), called from `onInventoryPut` for every
 * live server-confirmed move.
 */
import { describe, it, expect } from 'vitest';
import { InventoryManager } from '@ac/shared';

function makeItem(name: string) {
  return {
    weenieClassId: 1, name, value: 0, burden: 0,
    stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
  };
}

describe('BUG.inventory-put-slot-itemtype-unused — InventoryManager.setSlotForItem', () => {
  it('places a fresh pickup (no prior placement entry) at its server-assigned slot instead of Map-insertion order', () => {
    const inv = new InventoryManager();
    // No setPlacementOrder call — this is the pre-fix state: with no
    // placement info at all, getAll() falls back to Map-insertion order.
    const aId = inv.addItem(makeItem('A'), 901);
    const bId = inv.addItem(makeItem('B'), 902);
    const cId = inv.addItem(makeItem('C'), 903);
    const dId = inv.addItem(makeItem('D'), 904);
    expect(inv.getAll().map(i => i.name)).toEqual(['A', 'B', 'C', 'D']);

    // A live InventoryPutObjInContainer confirms C's authoritative slot 0
    // (e.g. a vendor purchase or corpse-loot pickup, not a local drag).
    // Only C's slot is echoed on the wire — A, B, D are untouched, exactly
    // as ACE's GameEventItemServerSaysContainId is sent per-item, not as a
    // full-inventory resync (Player_Inventory.cs:1358-1360).
    inv.setSlotForItem(cId, 0);
    // C now has an explicit slot and sorts first; A, B, D (no explicit
    // slot) keep their relative Map-insertion order after it.
    expect(inv.getAll().map(i => i.name)).toEqual(['C', 'A', 'B', 'D']);
    expect([aId, bId, dId].every(id => inv.getItem(id) !== undefined)).toBe(true);
  });

  it('does not replace the whole placement order — earlier explicit slots survive a later single-item update', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem(makeItem('A'), 1001);
    const bId = inv.addItem(makeItem('B'), 1002);
    const cId = inv.addItem(makeItem('C'), 1003);
    // Server-supplied login order: C, A, B
    inv.setPlacementOrder([cId, aId, bId]);
    expect(inv.getAll().map(i => i.name)).toEqual(['C', 'A', 'B']);

    // A live move confirms a NEW item D lands at slot 3 (appended after
    // the existing three) — C, A, B's earlier login-restored slots must
    // be untouched by this single-item upsert (unlike setPlacementOrder,
    // which would wipe them).
    const dId = inv.addItem(makeItem('D'), 1004);
    inv.setSlotForItem(dId, 3);
    expect(inv.getAll().map(i => i.name)).toEqual(['C', 'A', 'B', 'D']);
  });

  it('is idempotent and does not throw for repeated updates to the same guid', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem(makeItem('A'), 1101);
    expect(() => {
      inv.setSlotForItem(aId, 5);
      inv.setSlotForItem(aId, 2);
      inv.setSlotForItem(aId, 0);
    }).not.toThrow();
    expect(inv.getAll().map(i => i.name)).toEqual(['A']);
  });
});
