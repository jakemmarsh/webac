/**
 * BUG.sold-item-lingers-in-local-inventory — a ContainId into a container
 * outside the player's hierarchy (ACE sell path: Player_Commerce.cs:202 sends
 * ServerSaysContainId(item, vendor) with no InventoryRemoveObject) must take
 * the object out of the local inventory, as retail
 * ACCWeenieObject::ServerSaysMoveItem @ 0058dbb0 does for any container.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipMask } from '@ac/shared';
import type { InventoryItem } from '@ac/shared';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import {
  containInLeavesPlayer,
  removeItemLeavingPlayer,
  type ContainInContext,
} from '../packages/renderer/src/player/containInLeavesPlayer.js';

const PLAYER = 0x50000001;
const PACK = 0x80000100;
const LOOSE_PACK = 0x80000101; // carried, not yet in sidePackGuids
const CHEST = 0x7a9b4001;
const VENDOR = 0x7a9b4021;

function item(id: number, containerId: number, extra: Partial<InventoryItem> = {}): Omit<InventoryItem, 'id'> {
  return {
    weenieClassId: 1, name: `item ${id.toString(16)}`, value: 10, burden: 5,
    stackSize: 1, maxStackSize: 1, stackable: false, containerId, ...extra,
  } as Omit<InventoryItem, 'id'>;
}

describe('BUG.sold-item-lingers-in-local-inventory', () => {
  let ps: PlayerState;
  let ctx: ContainInContext;

  beforeEach(() => {
    ps = new PlayerState();
    ps.inventory.addItem(item(PACK, PLAYER, { itemType: 0x200 }), PACK);
    ps.inventory.addItem(item(LOOSE_PACK, PLAYER, { itemType: 0x200 }), LOOSE_PACK);
    ctx = {
      playerGuid: PLAYER,
      sidePackGuids: [PLAYER, PACK],
      openContainerGuid: CHEST,
      isCarried: (g) => ps.inventory.getItem(g) !== undefined,
    };
  });

  it('a vendor (or any off-player container) takes the item out of our hierarchy', () => {
    expect(containInLeavesPlayer(VENDOR, ctx)).toBe(true);
  });

  it('moves into the player, a side pack, a carried pack, or the open chest stay with the existing branches', () => {
    expect(containInLeavesPlayer(PLAYER, ctx)).toBe(false);
    expect(containInLeavesPlayer(PACK, ctx)).toBe(false);
    expect(containInLeavesPlayer(LOOSE_PACK, ctx)).toBe(false);
    expect(containInLeavesPlayer(CHEST, ctx)).toBe(false);
    expect(containInLeavesPlayer(0, ctx)).toBe(false);
  });

  it('with no chest open, the vendor still counts as off-player', () => {
    expect(containInLeavesPlayer(VENDOR, { ...ctx, openContainerGuid: 0 })).toBe(true);
  });

  it('a sold item leaves playerState.inventory (the 5-Apple repro)', () => {
    const APPLES = 0x80000398;
    ps.inventory.addItem(item(APPLES, PLAYER, { stackable: true, stackSize: 5, maxStackSize: 100 }), APPLES);
    const removed = removeItemLeavingPlayer(ps, APPLES);
    expect(removed.map(r => r.id)).toEqual([APPLES]);
    expect(removed[0].stackSize).toBe(5);
    expect(ps.inventory.getItem(APPLES)).toBeUndefined();
    expect(ps.inventory.getAll().some(i => i.id === APPLES)).toBe(false);
  });

  it('a sold wielded item is also unequipped (ServerSaysMoveItem clears the player wield location)', () => {
    const SWORD = 0x80000400;
    ps.inventory.addItem(item(SWORD, PLAYER, { validLocations: EquipMask.MeleeWeapon }), SWORD);
    ps.equipment.equipItem(ps.inventory.getItem(SWORD)!, EquipMask.MeleeWeapon);
    expect(ps.equipment.isEquipped(SWORD)).toBe(true);
    removeItemLeavingPlayer(ps, SWORD);
    expect(ps.equipment.isEquipped(SWORD)).toBe(false);
    expect(ps.inventory.getItem(SWORD)).toBeUndefined();
  });

  it('a pack leaving takes its contents with it', () => {
    const INNER = 0x80000500;
    ps.inventory.addItem(item(INNER, PACK), INNER);
    const removed = removeItemLeavingPlayer(ps, PACK);
    expect(removed.map(r => r.id)).toEqual([PACK, INNER]);
    expect(ps.inventory.getItem(INNER)).toBeUndefined();
  });

  it('a give (InventoryRemoveObject already removed it) is a no-op — no double handling', () => {
    const GIFT = 0x80000600;
    ps.inventory.addItem(item(GIFT, PLAYER), GIFT);
    ps.inventory.removeItem(GIFT); // onInventoryRemove (Player_Inventory.cs:225)
    expect(removeItemLeavingPlayer(ps, GIFT)).toEqual([]);
  });
});

/**
 * AGENT.play-reports-2026-10-10 (item 1) — a worn item dropped on the ground:
 * ACE HandleActionDropItem dequips it and sends InventoryPutObjIn3D
 * (ServerSaysMoveItem @ 0058dbb0 clears the player's wield location), which
 * main.ts's onInventoryPutIn3D now applies through removeItemLeavingPlayer.
 * It used to only remove the inventory record, so the paperdoll and the agent's
 * inventory kept the dropped pair as worn.
 */
describe('a worn item dropped to the ground leaves the equipment too', () => {
  it('removeItemLeavingPlayer takes a worn item off the paperdoll and out of the pack', () => {
    const ps = new PlayerState();
    const LEGS = 0x80007ab2;
    ps.inventory.addItem(item(LEGS, PLAYER), LEGS);
    ps.equipment.equipItem(ps.inventory.getItem(LEGS)!, (EquipMask.UpperLegArmor | EquipMask.LowerLegArmor) as EquipMask);
    expect(removeItemLeavingPlayer(ps, LEGS).map((r) => r.id)).toEqual([LEGS]);
    expect(ps.equipment.isEquipped(LEGS)).toBe(false);
    expect(ps.inventory.getItem(LEGS)).toBeUndefined();
  });
});
