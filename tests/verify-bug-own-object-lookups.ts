/**
 * Our own character, pack items and worn items have no ServerObject, so a
 * lookup that only asks the ServerObjectManager misses them. Each case here
 * is one such site, driven through the shipped code.
 */
import { describe, it, expect } from 'vitest';
import { InventoryManager, EquipmentSystem, EquipMask, PropertyInt, PropertyDataId } from '../packages/shared/src/index.js';
import { selectNext, selectNextReference, SelectionType, type SelectNextCandidate } from '../packages/renderer/src/controllers/SelectNext.js';
import { itemVisualDescOf } from '../packages/renderer/src/models/WieldedItemVisual.js';

const LIGHTING_ON = 0x800;

function stone(inv: InventoryManager): number {
  return inv.addItem({
    weenieClassId: 1, name: 'Mana Stone', value: 0, burden: 0, stackSize: 1, maxStackSize: 1,
    stackable: false, containerId: 0, uiEffects: 0,
  }, 0x80000010);
}

describe('PublicUpdateProperty on our own items (no ServerObject)', () => {
  it('UiEffects lands on a pack item (ManaStone.SetUiEffect)', () => {
    const inv = new InventoryManager();
    const id = stone(inv);
    expect(inv.applyPublicPropertyInt(id, PropertyInt.UiEffects, 1)).toBe(true);
    expect(inv.getItem(id)?.uiEffects).toBe(1);
  });
  it('Icon / IconOverlay / IconUnderlay land on a pack item (CorePlating)', () => {
    const inv = new InventoryManager();
    const id = stone(inv);
    expect(inv.applyPublicPropertyDataId(id, PropertyDataId.IconOverlay, 0x06006c09)).toBe(true);
    expect(inv.applyPublicPropertyDataId(id, PropertyDataId.IconUnderlay, 0x06006c0a)).toBe(true);
    expect(inv.applyPublicPropertyDataId(id, PropertyDataId.Icon, 0x06001234)).toBe(true);
    const item = inv.getItem(id)!;
    expect([item.iconOverlayDid, item.iconUnderlayDid, item.iconDid]).toEqual([0x06006c09, 0x06006c0a, 0x06001234]);
    expect(inv.applyPublicPropertyDataId(id, PropertyDataId.Setup, 0x02000001)).toBe(false);
    expect(inv.applyPublicPropertyDataId(0x80009999, PropertyDataId.Icon, 1)).toBe(false);
  });
  it('the worn copy follows the inventory record', () => {
    const inv = new InventoryManager();
    const eq = new EquipmentSystem();
    const id = stone(inv);
    eq.equipItem(inv.getItem(id)!, EquipMask.HandWear);
    inv.applyPublicPropertyInt(id, PropertyInt.UiEffects, 1);
    inv.applyPublicPropertyDataId(id, PropertyDataId.IconOverlay, 0x06006c09);
    expect(eq.syncFrom(inv.getItem(id)!)).toBe(true);
    const worn = eq.getAll().find(e => e.id === id)!;
    expect(worn.uiEffects).toBe(1);
    expect(worn.iconOverlayDid).toBe(0x06006c09);
  });
});

describe('a held torch carries its own PhysicsState', () => {
  it('itemVisualDescOf keeps LightingOn from the CreateObject', () => {
    expect(itemVisualDescOf({ setupId: 0x02000a1b, physicsState: LIGHTING_ON })?.physicsState).toBe(LIGHTING_ON);
    expect(itemVisualDescOf({ setupId: 0x02000a1b })?.physicsState).toBe(0);
  });
});

describe('Select Next / Previous with ourselves selected (SelectNext @ 0055f9a0)', () => {
  const ME = 0x50000001;
  const cand = (guid: number, d: number): SelectNextCandidate => ({
    guid, dx: d, dy: 0, dz: 0, bitfield: 0, physicsState: 0, showableOnRadar: true, present: true, radarEnum: 0, wielderId: 0,
  });
  const cands = [cand(0x80000001, 5), cand(0x80000002, 20)];
  const ctx = { playerGuid: ME, outside: true, meleeOrMissile: false, isAttackable: () => false, isFellow: () => false };

  it('a self reference sits at offset 0, not "no reference"', () => {
    expect(selectNextReference(ME, ME, null).offset).toEqual({ dx: 0, dy: 0, dz: 0 });
    expect(selectNextReference(0x80000003, ME, null).offset).toBeNull();
    expect(selectNextReference(0, 0, null).offset).toBeNull();
  });
  it('from yourself: inward finds nothing nearer than 0, outward the closest (the old null path gave closest / farthest)', () => {
    const ref = selectNextReference(ME, ME, null);
    expect(selectNext(cands, ctx, ref, true, false, SelectionType.CompassItem)).toBe(0);
    expect(selectNext(cands, ctx, ref, false, false, SelectionType.CompassItem)).toBe(0x80000001);
    const old = { guid: ME, offset: null };
    expect(selectNext(cands, ctx, old, true, false, SelectionType.CompassItem)).toBe(0x80000001);
    expect(selectNext(cands, ctx, old, false, false, SelectionType.CompassItem)).toBe(0x80000002);
  });
});
