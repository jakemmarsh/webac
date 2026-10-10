/**
 * BUG.equip-unequip-optimistic-no-rollback — equip/unequip rollback on
 * GameEventInventoryServerSaveFailed.
 *
 * The paperdoll drag/double-click/context-menu equip and unequip paths in
 * main.ts mutate EquipmentSystem optimistically, ahead of the server's
 * confirmation. ACE rejects wield/unequip in several real cases
 * (CheckWieldRequirements failure, weapon collision, conflicting slot,
 * IsBusy, Stuck, over-burden, corpse target, TradeItemBeingTraded,
 * AttunedItem, pet-device target — Player_Inventory.cs's
 * DoHandleActionGetAndWieldItem / HandleActionPutItemInContainer_Verify)
 * by sending GameEventInventoryServerSaveFailed(itemGuid) with no
 * corrective wield/put event, so the optimistic mutation was never undone.
 *
 * Fix: OptimisticEquipmentTracker (@ac/shared) records what each
 * optimistic equip/unequip changed, keyed by the item's own guid (matching
 * the itemGuid ACE echoes on both confirmation and rejection); a rejection
 * reverts it via rollback(), and a confirmation discards the record via
 * confirm(). These tests drive the tracker + EquipmentSystem directly
 * (the real shipped classes), not main.ts's closures.
 */
import { describe, it, expect } from 'vitest';
import { EquipmentSystem, OptimisticEquipmentTracker, EquipMask } from '@ac/shared';
import type { InventoryItem } from '@ac/shared';

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 1,
    weenieClassId: 100,
    name: 'Test Sword',
    value: 500,
    burden: 200,
    stackSize: 1,
    maxStackSize: 1,
    stackable: false,
    containerId: 0,
    ...overrides,
  };
}

describe('OptimisticEquipmentTracker', () => {
  it('rollback of a rejected equip into an empty slot un-equips the item', () => {
    const equip = new EquipmentSystem();
    const tracker = new OptimisticEquipmentTracker();
    const sword = makeItem({ id: 1 });

    // Optimistic equip (as onDropToSlot does before the server replies).
    equip.equipItem(sword, EquipMask.MeleeWeapon);
    tracker.recordEquip(sword.id, EquipMask.MeleeWeapon, undefined);
    expect(equip.getSlot(EquipMask.MeleeWeapon)?.id).toBe(1);

    // Server rejects (e.g. CheckWieldRequirements failure).
    const reverted = tracker.rollback(sword.id, equip);
    expect(reverted).toBe(true);
    expect(equip.getSlot(EquipMask.MeleeWeapon)).toBeUndefined();
    expect(equip.isEquipped(sword.id)).toBe(false);
  });

  it('rollback of a rejected equip that displaced an existing item restores the displaced item', () => {
    const equip = new EquipmentSystem();
    const tracker = new OptimisticEquipmentTracker();
    const oldSword = makeItem({ id: 1, name: 'Old Sword' });
    const newSword = makeItem({ id: 2, name: 'New Sword' });
    equip.equipItem(oldSword, EquipMask.MeleeWeapon);

    // Optimistic equip of newSword into the same slot evicts oldSword —
    // record what got displaced before overwriting the slot.
    const evicted = equip.getSlot(EquipMask.MeleeWeapon);
    equip.equipItem(newSword, EquipMask.MeleeWeapon);
    tracker.recordEquip(newSword.id, EquipMask.MeleeWeapon, evicted);
    expect(equip.getSlot(EquipMask.MeleeWeapon)?.name).toBe('New Sword');

    // Server rejects the wield of newSword.
    const reverted = tracker.rollback(newSword.id, equip);
    expect(reverted).toBe(true);
    expect(equip.getSlot(EquipMask.MeleeWeapon)?.name).toBe('Old Sword');
    expect(equip.isEquipped(newSword.id)).toBe(false);
  });

  it('rollback of a rejected unequip re-equips the item to its old slot', () => {
    const equip = new EquipmentSystem();
    const tracker = new OptimisticEquipmentTracker();
    const shield = makeItem({ id: 3, name: 'Shield' });
    equip.equipItem(shield, EquipMask.Shield);

    // Optimistic unequip (as runPlacement does for a worn item put into a pack, before the server replies).
    const equipped = equip.getSlot(EquipMask.Shield)!;
    equip.unequipSlot(EquipMask.Shield);
    tracker.recordUnequip(equipped.id, EquipMask.Shield, equipped);
    expect(equip.getSlot(EquipMask.Shield)).toBeUndefined();

    // Server rejects the unequip (e.g. AttunedItem).
    const reverted = tracker.rollback(shield.id, equip);
    expect(reverted).toBe(true);
    expect(equip.getSlot(EquipMask.Shield)?.id).toBe(3);
  });

  it('confirm() discards the pending record so a later unrelated failure for the same itemGuid does not roll back', () => {
    const equip = new EquipmentSystem();
    const tracker = new OptimisticEquipmentTracker();
    const sword = makeItem({ id: 1 });

    equip.equipItem(sword, EquipMask.MeleeWeapon);
    tracker.recordEquip(sword.id, EquipMask.MeleeWeapon, undefined);

    // Server confirms the wield (GameEventWieldObject).
    tracker.confirm(sword.id);
    expect(tracker.hasPending(sword.id)).toBe(false);

    // A later, unrelated InventoryServerSaveFailed for the same item
    // (e.g. a subsequent failed drop) must not undo the confirmed equip.
    const reverted = tracker.rollback(sword.id, equip);
    expect(reverted).toBe(false);
    expect(equip.getSlot(EquipMask.MeleeWeapon)?.id).toBe(1);
  });

  it('rollback() is a no-op when no optimistic action is pending for that itemGuid', () => {
    const equip = new EquipmentSystem();
    const tracker = new OptimisticEquipmentTracker();
    expect(tracker.rollback(999, equip)).toBe(false);
  });
});
