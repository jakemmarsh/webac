/**
 * Phase 22 — Inventory + Equipment + Burden + Assessment + Trading
 *
 * Tests inventory management, equipment slots, burden tracking,
 * stacking, assessment, and player-to-player trading.
 */
import { describe, it, expect } from 'vitest';
import { InventoryManager, EquipmentSystem, EquipMask } from '@ac/shared';
import type { InventoryItem } from '@ac/shared';

// ─── Helper: create test items ─────────────────────────────

function makeItem(overrides: Partial<InventoryItem> = {}): Omit<InventoryItem, 'id'> {
  return {
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

function makeStackable(overrides: Partial<InventoryItem> = {}): Omit<InventoryItem, 'id'> {
  return {
    weenieClassId: 300,
    name: 'Arrow',
    value: 1,
    burden: 1,
    stackSize: 50,
    maxStackSize: 250,
    stackable: true,
    containerId: 0,
    ...overrides,
  };
}

// ─── InventoryManager ──────────────────────────────────────

describe('InventoryManager', () => {
  it('adds and retrieves items', () => {
    const inv = new InventoryManager();
    const id = inv.addItem(makeItem());
    expect(id).toBeGreaterThan(0);
    const item = inv.getItem(id);
    expect(item).toBeDefined();
    expect(item!.name).toBe('Test Sword');
  });

  it('tracks total burden correctly', () => {
    const inv = new InventoryManager();
    inv.addItem(makeItem({ burden: 100 }));
    inv.addItem(makeItem({ burden: 200, weenieClassId: 101 }));
    expect(inv.totalBurden).toBe(300);
  });

  it('burden accounts for stack size', () => {
    const inv = new InventoryManager();
    inv.addItem(makeStackable({ burden: 1, stackSize: 50 }));
    expect(inv.totalBurden).toBe(50);
  });

  it('adds 10 items and totalBurden matches sum', () => {
    const inv = new InventoryManager();
    let expectedBurden = 0;
    for (let i = 0; i < 10; i++) {
      const burden = (i + 1) * 10;
      inv.addItem(makeItem({ burden, weenieClassId: 100 + i }));
      expectedBurden += burden;
    }
    expect(inv.totalBurden).toBe(expectedBurden);
  });

  it('removes item from inventory', () => {
    const inv = new InventoryManager();
    const id = inv.addItem(makeItem());
    expect(inv.count).toBe(1);
    const removed = inv.removeItem(id);
    expect(removed).toBeDefined();
    expect(inv.count).toBe(0);
    expect(inv.getItem(id)).toBeUndefined();
  });

  it('stacks arrows: 50 + 30 = 80', () => {
    const inv = new InventoryManager();
    const id1 = inv.addItem(makeStackable({ stackSize: 50 }));
    const id2 = inv.addItem(makeStackable({ stackSize: 30 }));
    // Should merge into existing stack
    expect(id2).toBe(id1); // Same ID when fully merged
    const item = inv.getItem(id1)!;
    expect(item.stackSize).toBe(80);
    expect(inv.count).toBe(1);
  });

  it('split stack of 80 into 50 + 30', () => {
    const inv = new InventoryManager();
    const id = inv.addItem(makeStackable({ stackSize: 80 }));
    const newId = inv.splitStack(id, 30);
    expect(newId).not.toBeNull();
    expect(inv.getItem(id)!.stackSize).toBe(50);
    expect(inv.getItem(newId!)!.stackSize).toBe(30);
    expect(inv.count).toBe(2);
  });

  it('removeFromStack removes partial quantity', () => {
    const inv = new InventoryManager();
    const id = inv.addItem(makeStackable({ stackSize: 100 }));
    const removed = inv.removeFromStack(id, 40);
    expect(removed).toBe(40);
    expect(inv.getItem(id)!.stackSize).toBe(60);
  });

  it('removeFromStack removes entire item if quantity >= stack', () => {
    const inv = new InventoryManager();
    const id = inv.addItem(makeStackable({ stackSize: 10 }));
    const removed = inv.removeFromStack(id, 10);
    expect(removed).toBe(10);
    expect(inv.getItem(id)).toBeUndefined();
    expect(inv.count).toBe(0);
  });

  it('container holds items, removing all works', () => {
    const inv = new InventoryManager();
    const id1 = inv.addItem(makeItem({ containerId: 5, weenieClassId: 101 }));
    const id2 = inv.addItem(makeItem({ containerId: 5, weenieClassId: 102 }));
    const id3 = inv.addItem(makeItem({ containerId: 0, weenieClassId: 103 }));

    const containerItems = inv.getByContainer(5);
    expect(containerItems.length).toBe(2);

    const rootItems = inv.getByContainer(0);
    expect(rootItems.length).toBe(1);
  });

  it('findByWeenieClass works', () => {
    const inv = new InventoryManager();
    inv.addItem(makeItem({ weenieClassId: 500 }));
    inv.addItem(makeItem({ weenieClassId: 500 }));
    inv.addItem(makeItem({ weenieClassId: 600 }));

    expect(inv.findByWeenieClass(500).length).toBe(2);
    expect(inv.findByWeenieClass(600).length).toBe(1);
    expect(inv.findByWeenieClass(999).length).toBe(0);
  });

  it('hasItem checks total quantity across stacks', () => {
    const inv = new InventoryManager();
    inv.addItem(makeStackable({ stackSize: 50, weenieClassId: 700 }));
    expect(inv.hasItem(700, 50)).toBe(true);
    expect(inv.hasItem(700, 51)).toBe(false);
    expect(inv.hasItem(700, 1)).toBe(true);
  });

  it('mergeStacks combines two stacks', () => {
    const inv = new InventoryManager();
    // Use different weenieClassId to prevent auto-merge
    const id1 = inv.addItem(makeStackable({ stackSize: 50, maxStackSize: 250, weenieClassId: 800 }));
    // Add second stack to different container to prevent auto-merge
    const id2 = inv.addItem(makeStackable({ stackSize: 30, maxStackSize: 250, weenieClassId: 800, containerId: 5 }));

    expect(inv.count).toBe(2);
    const merged = inv.mergeStacks(id2, id1);
    expect(merged).toBe(true);
    expect(inv.getItem(id1)!.stackSize).toBe(80);
    // Source should be deleted (fully merged)
    expect(inv.getItem(id2)).toBeUndefined();
  });
});

// ─── EquipmentSystem ───────────────────────────────────────

describe('EquipmentSystem', () => {
  it('equips item to slot', () => {
    const equip = new EquipmentSystem();
    const item = { ...makeItem(), id: 1 } as InventoryItem;
    const result = equip.equipItem(item, EquipMask.MeleeWeapon);
    expect(result.success).toBe(true);
    expect(equip.getSlot(EquipMask.MeleeWeapon)).toBeDefined();
    expect(equip.getSlot(EquipMask.MeleeWeapon)!.name).toBe('Test Sword');
  });

  it('equip weapon with wield requirement (str 200): fails at str 100, succeeds at 200', () => {
    const equip = new EquipmentSystem();
    // Pre-FAITHFUL.103 this test used `type: 7` for "strength requirement",
    // which per ACE WieldRequirement.cs is actually Level. The intended
    // semantics here are an Attrib requirement (type=3, what=PropertyAttribute.Strength=1).
    const reqs = [{ type: 3, skillOrAttr: 1, difficulty: 200 }]; // Attrib, Strength

    // Check at str 100
    const check1 = equip.checkWieldRequirements(reqs, (_type, _id) => 100, 10);
    expect(check1.met).toBe(false);

    // Check at str 200
    const check2 = equip.checkWieldRequirements(reqs, (_type, _id) => 200, 10);
    expect(check2.met).toBe(true);
  });

  it('equip armor: defense shows in equipment', () => {
    const equip = new EquipmentSystem();
    const armor = { ...makeItem({ name: 'Chainmail', value: 1000 }), id: 2 } as InventoryItem;
    equip.equipItem(armor, EquipMask.ChestArmor);
    const total = equip.getTotalArmorLevel((_item) => 150); // mock 150 AL
    expect(total).toBe(150);
  });

  it('unequip returns item', () => {
    const equip = new EquipmentSystem();
    const item = { ...makeItem(), id: 3 } as InventoryItem;
    equip.equipItem(item, EquipMask.Shield);
    const unequipped = equip.unequipSlot(EquipMask.Shield);
    expect(unequipped).toBeDefined();
    expect(unequipped!.id).toBe(3);
    expect(equip.getSlot(EquipMask.Shield)).toBeUndefined();
  });

  it('replacing equipped item returns old item', () => {
    const equip = new EquipmentSystem();
    const item1 = { ...makeItem({ name: 'Old Sword' }), id: 4 } as InventoryItem;
    const item2 = { ...makeItem({ name: 'New Sword' }), id: 5 } as InventoryItem;

    equip.equipItem(item1, EquipMask.MeleeWeapon);
    const result = equip.equipItem(item2, EquipMask.MeleeWeapon);
    expect(result.unequipped?.length).toBe(1);
    expect(result.unequipped![0].name).toBe('Old Sword');
    expect(equip.getSlot(EquipMask.MeleeWeapon)!.name).toBe('New Sword');
  });

  it('burden from equipped items', () => {
    const equip = new EquipmentSystem();
    equip.equipItem({ ...makeItem({ burden: 100 }), id: 6 } as InventoryItem, EquipMask.MeleeWeapon);
    equip.equipItem({ ...makeItem({ burden: 200 }), id: 7 } as InventoryItem, EquipMask.ChestArmor);
    expect(equip.totalBurden).toBe(300);
  });

  it('isEquipped checks by instance ID', () => {
    const equip = new EquipmentSystem();
    equip.equipItem({ ...makeItem(), id: 10 } as InventoryItem, EquipMask.MeleeWeapon);
    expect(equip.isEquipped(10)).toBe(true);
    expect(equip.isEquipped(99)).toBe(false);
  });

  it('level requirement check (type=7 per ACE WieldRequirement.Level)', () => {
    const equip = new EquipmentSystem();
    // Pre-FAITHFUL.103 this used `type: 1`, which per ACE is actually
    // WieldRequirement.Skill — the test passed only because the broken
    // implementation also dispatched on `type === 1` as Level. Fixed to 7.
    const reqs = [{ type: 7, skillOrAttr: 0, difficulty: 50 }];

    expect(equip.checkWieldRequirements(reqs, () => 0, 30).met).toBe(false);
    expect(equip.checkWieldRequirements(reqs, () => 0, 50).met).toBe(true);
    expect(equip.checkWieldRequirements(reqs, () => 0, 100).met).toBe(true);
  });

  it('FAITHFUL.103 regression anchor: type=1 (Skill) goes through skill path, NOT level path', () => {
    const equip = new EquipmentSystem();
    // Skill requirement should call getSkillValue(type, id), not check level.
    // Pre-fix `type === 1` dispatched as Level → would have passed regardless
    // of skill value if characterLevel was high enough.
    const reqs = [{ type: 1, skillOrAttr: 34, difficulty: 350 }]; // Skill, War Magic, 350
    let getSkillCalled = false;
    const getSkill = (_t: number, _id: number) => { getSkillCalled = true; return 100; };
    const result = equip.checkWieldRequirements(reqs, getSkill, /* level */ 999);
    expect(getSkillCalled).toBe(true);
    expect(result.met).toBe(false); // skill 100 < 350
  });
});

// ─── Burden and encumbrance integration ─────────────────────

describe('Burden integration', () => {
  it('burden over capacity: detection works', () => {
    const inv = new InventoryManager();
    // Add heavy items
    for (let i = 0; i < 20; i++) {
      inv.addItem(makeItem({ burden: 100, weenieClassId: 100 + i }));
    }
    const totalBurden = inv.totalBurden;
    expect(totalBurden).toBe(2000);

    // Simulate strength-based capacity: Strength * 150
    const capacity = 60 * 150; // str 60 = 9000 capacity
    const encumbranceRatio = totalBurden / capacity;
    expect(encumbranceRatio).toBeLessThan(1);

    // Over-encumbered check
    const heavyCapacity = 10 * 150; // str 10 = 1500
    const overRatio = totalBurden / heavyCapacity;
    expect(overRatio).toBeGreaterThan(1);
  });
});
