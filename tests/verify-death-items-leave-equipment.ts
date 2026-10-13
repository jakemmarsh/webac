/**
 * BUG.death-items-stay-equipped (prod, Coldeve, 2026-10-12) — after a death
 * moved a worn Amuli Coat + Leggings to the corpse, the client still had them
 * on the equipment list: the paperdoll figure lost them (ObjDescEvent), but
 * their slots still selected "Amuli Coat", the agent snapshot listed them
 * worn, and wearing a Leather Jerkin tried to dequip the coat (ACE: "Source
 * item not found!"; ours: "The Amuli Coat can't be put in the container").
 *
 * ACE's sequence (Player_Death.cs:548/565 → Player_Inventory.cs):
 *  - pack item, TryRemoveFromInventoryWithNetworking(ToCorpseOnDeath):
 *    PublicUpdateInstanceID(Container→0) + InventoryRemoveObject (0x0024).
 *  - worn item, TryDequipObjectWithNetworking(ToCorpseOnDeath):
 *    PublicUpdateInstanceID(Wielder→0), PublicUpdatePropertyInt
 *    (CurrentWieldedLocation→0), PickupEvent, Sound, DeleteObject — and no
 *    InventoryRemoveObject. Our DeleteObject dropped the inventory record
 *    only; the EquipmentSystem keeps its own COPY.
 *
 * These drive the real wire bytes through ServerMessageHandler, the real
 * object-blob gate, and the shipped release helpers, wired as main.ts wires
 * them, against a real PlayerState.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipMask, OptimisticEquipmentTracker } from '@ac/shared';
import type { InventoryItem } from '@ac/shared';
import { GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { gateObjectHandlers, createObjectBlobGate } from '../packages/renderer/src/world/ObjectBlobGate.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { releaseOwnedItem, dropDeletedOwnedItem } from '../packages/renderer/src/player/deletedOwnedItem.js';
import { clearWieldOnContainIn } from '../packages/renderer/src/player/containInLeavesPlayer.js';

const PLAYER = 0x50000001;
const COAT = 0x80000a01;
const LEGGINGS = 0x80000a02;
const BOW = 0x80000a03;
const CHARGE = 0x80000a04; // Massive Mana Charge in the main pack
const SIDE_PACK = 0x80000a05;
const IN_SIDE_PACK = 0x80000a06;
const KEPT = 0x80000a07;
const ARROWS = 0x80000a08;

const PROP_IID_CONTAINER = 2;
const PROP_IID_WIELDER = 3;
const PROP_INT_CURRENT_WIELDED_LOCATION = 10;

function bytes(...parts: Array<[number, 1 | 2 | 4]>): Uint8Array {
  const out: number[] = [];
  for (const [v, n] of parts) for (let i = 0; i < n; i++) out.push((v >>> (8 * i)) & 0xff);
  return new Uint8Array(out);
}
const direct = (opcode: GameMessageOpcode, payload: Uint8Array) => ({ type: 'direct', opcode, payload }) as never;
const instanceIdUpdate = (guid: number, key: number, value: number) =>
  direct(GameMessageOpcode.PublicUpdateInstanceId, bytes([1, 1], [guid, 4], [key, 4], [value, 4]));
const intUpdate = (guid: number, key: number, value: number) =>
  direct(GameMessageOpcode.PublicUpdatePropertyInt, bytes([1, 1], [guid, 4], [key, 4], [value, 4]));
const pickupEvent = (guid: number) => direct(GameMessageOpcode.PickupEvent, bytes([guid, 4], [1, 2], [2, 2]));
const deleteObject = (guid: number) => direct(GameMessageOpcode.ObjectDelete, bytes([guid, 4], [1, 2]));
const inventoryRemove = (guid: number) => direct(GameMessageOpcode.InventoryRemoveObject, bytes([guid, 4]));

function item(name: string, containerId: number, extra: Partial<InventoryItem> = {}): Omit<InventoryItem, 'id'> {
  return {
    weenieClassId: 1, name, value: 10, burden: 5, stackSize: 1, maxStackSize: 1, stackable: false, containerId, ...extra,
  } as Omit<InventoryItem, 'id'>;
}

describe('BUG.death-items-stay-equipped', () => {
  let ps: PlayerState;
  let sidePackGuids: number[];
  let pending: OptimisticEquipmentTracker;
  let handler: ServerMessageHandler;
  let leftPlayer: number[];

  const wear = (guid: number, name: string, slot: EquipMask, extra: Partial<InventoryItem> = {}) => {
    ps.inventory.addItem(item(name, PLAYER, extra), guid);
    ps.equipment.equipItem(ps.inventory.getItem(guid)!, slot, false);
  };

  beforeEach(() => {
    ps = new PlayerState();
    sidePackGuids = [PLAYER, SIDE_PACK];
    pending = new OptimisticEquipmentTracker();
    leftPlayer = [];
    wear(COAT, 'Amuli Coat', EquipMask.ChestArmor);
    wear(LEGGINGS, 'Amuli Leggings', EquipMask.UpperLegArmor);
    wear(BOW, 'Acid Bow', EquipMask.MissileWeapon);
    ps.inventory.addItem(item('Massive Mana Charge', PLAYER), CHARGE);
    ps.inventory.addItem(item('Sack', PLAYER, { itemType: 0x200 }), SIDE_PACK);
    ps.inventory.addItem(item('Gem', SIDE_PACK), IN_SIDE_PACK);
    ps.inventory.addItem(item('Leather Jerkin', PLAYER), KEPT);

    // main.ts's wiring: releaseFromPlayer for DeleteObject and InventoryRemoveObject,
    // behind the object-blob gate (own items have no world record).
    const queued = new Map<number, Array<() => void>>();
    const gate = createObjectBlobGate({
      queue: {
        queue: (g, replay) => { queued.set(g, [...(queued.get(g) ?? []), replay]); },
        has: (g) => queued.has(g),
      },
      worldInstance: () => null,
      knownWithoutWorldRecord: (g) => g === PLAYER || !!ps.inventory.getItem(g) || ps.equipment.isEquipped(g),
      isNewer: (a, b) => a > b,
      now: () => 0,
    });
    const release = (guid: number) => {
      for (const r of releaseOwnedItem({ playerState: ps, sidePackGuids, forgetPendingEquip: (id) => pending.confirm(id) }, guid)) {
        leftPlayer.push(r.id);
      }
    };
    handler = new ServerMessageHandler();
    handler.setHandlers(gateObjectHandlers({
      onObjectDelete: (d) => release(d.guid),
      onInventoryRemove: (d) => release(d.itemGuid),
      onPublicUpdatePropertyInstanceID: () => {},
      onPublicUpdatePropertyInt: () => {},
      onPickupEvent: () => {},
    }, gate));
  });

  const deathDequip = (guid: number) => {
    handler.handleMessage(instanceIdUpdate(guid, PROP_IID_WIELDER, 0));
    handler.handleMessage(intUpdate(guid, PROP_INT_CURRENT_WIELDED_LOCATION, 0));
    handler.handleMessage(pickupEvent(guid));
    handler.handleMessage(deleteObject(guid));
  };

  it('a worn item moved to the corpse leaves the equipment as well as the inventory', () => {
    deathDequip(COAT);
    deathDequip(LEGGINGS);
    deathDequip(BOW);
    for (const g of [COAT, LEGGINGS, BOW]) {
      expect(ps.equipment.isEquipped(g)).toBe(false);
      expect(ps.inventory.getItem(g)).toBeUndefined();
    }
    expect(ps.equipment.getSlot(EquipMask.ChestArmor)).toBeUndefined();
    expect(ps.equipment.getAll()).toHaveLength(0);
    expect(leftPlayer).toEqual([COAT, LEGGINGS, BOW]);
  });

  it('a pack item moved to the corpse leaves on Container→0 + InventoryRemoveObject', () => {
    handler.handleMessage(instanceIdUpdate(CHARGE, PROP_IID_CONTAINER, 0));
    handler.handleMessage(inventoryRemove(CHARGE));
    expect(ps.inventory.getItem(CHARGE)).toBeUndefined();
    expect(ps.inventory.getItem(KEPT)?.name).toBe('Leather Jerkin');
    expect(ps.equipment.getAll().map((e) => e.id).sort()).toEqual([COAT, LEGGINGS, BOW].sort());
  });

  it('a pending optimistic unequip of a removed item cannot put it back on', () => {
    // The Leather Jerkin wear dequipped the coat optimistically; the server
    // then refuses (the coat is on the corpse). The rollback must not re-wear it.
    const coat = ps.equipment.unequipItem(COAT)!;
    pending.recordUnequip(COAT, EquipMask.ChestArmor, coat);
    ps.equipment.equipItem(coat, EquipMask.ChestArmor, false); // still listed (the stale state pre-fix)
    deathDequip(COAT);
    expect(pending.rollback(COAT, ps.equipment)).toBe(false);
    expect(ps.equipment.isEquipped(COAT)).toBe(false);
  });

  it('a deleted side pack takes its contents and leaves sidePackGuids', () => {
    handler.handleMessage(deleteObject(SIDE_PACK));
    expect(ps.inventory.getItem(SIDE_PACK)).toBeUndefined();
    expect(ps.inventory.getItem(IN_SIDE_PACK)).toBeUndefined();
    expect(sidePackGuids).toEqual([PLAYER]);
    expect(leftPlayer).toEqual([SIDE_PACK, IN_SIDE_PACK]);
  });

  it('a merge that consumes an equipped stack (InventoryRemoveObject for the worn source) unequips it', () => {
    // Player_Inventory.cs:3096-3103: InventoryRemoveObject(sourceStack), then DequipToPack.
    wear(ARROWS, 'Arrows', EquipMask.MissileAmmo, { stackSize: 20, maxStackSize: 250, stackable: true });
    handler.handleMessage(inventoryRemove(ARROWS));
    expect(ps.equipment.getSlot(EquipMask.MissileAmmo)).toBeUndefined();
    expect(ps.inventory.getItem(ARROWS)).toBeUndefined();
  });

  it('the last arrow fired from the ammo slot (ConsumeItem dequip → DeleteObject) empties the slot', () => {
    wear(ARROWS, 'Arrows', EquipMask.MissileAmmo);
    deathDequip(ARROWS); // same dequip messages, Player_Missile.cs:341
    expect(ps.equipment.getSlot(EquipMask.MissileAmmo)).toBeUndefined();
  });

  it('a world object\'s DeleteObject touches nothing we own', () => {
    handler.handleMessage(deleteObject(0x7a9b4001));
    expect(leftPlayer).toEqual([]);
    expect(ps.equipment.getAll()).toHaveLength(3);
    expect(ps.inventory.getAll()).toHaveLength(7);
    expect(dropDeletedOwnedItem(ps, 0x7a9b4001)).toBe(false);
  });

  it('a worn item contained into a side pack or an open chest leaves the equipment (ServerSaysMoveItem)', () => {
    expect(clearWieldOnContainIn(ps.equipment, pending, COAT)).toBe(true);
    expect(ps.equipment.isEquipped(COAT)).toBe(false);
    expect(clearWieldOnContainIn(ps.equipment, pending, KEPT)).toBe(false);
    // A confirmed contain-in clears the optimistic record too.
    const bow = ps.equipment.unequipItem(BOW)!;
    pending.recordUnequip(BOW, EquipMask.MissileWeapon, bow);
    clearWieldOnContainIn(ps.equipment, pending, BOW);
    expect(pending.hasPending(BOW)).toBe(false);
  });
});
