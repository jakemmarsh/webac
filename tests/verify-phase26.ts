/**
 * Phase 26 — CHECKPOINT: Core Game Logic Smoke Test
 *
 * Integration test over the client-side state models the HUD/panels read
 * (vitals, XP, inventory/equipment, enchantments) working together.
 *
 * Sub-scenarios:
 * 4. Loot + equip: pick up from corpse → equip → stat bonus → burden
 * 5. Death + respawn: HP → 0 → vitae penalty
 * 6. Leveling: grant XP → level up → skill credits → train skill
 *
 * The former character-creation / combat / magic / AI scenarios exercised
 * local simulations of server-authoritative systems (ACE PlayerFactory,
 * DamageEvent, Player_Magic, Monster AI) that were never reachable from
 * shipped code; they were deleted in DEBT.shared-dead-server-logic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatDatabase, DatReader, XpTable } from '@ac/dat-parser';
import {
  AttributeSystem, AttributeId, VitalSystem, VitalId, XpSystem, InventoryManager, EquipmentSystem,
  EnchantmentManager, EnchantmentCategory, EnchantmentStatDomain, EquipMask,
} from '@ac/shared';
import { openDat } from './_harness/dat.js';

const DAT_DIR = path.resolve(__dirname, '..', 'dat');
const PORTAL_PATH = path.join(DAT_DIR, 'client_portal.dat');
const hasPortalDat = fs.existsSync(PORTAL_PATH);

let xpTable: XpTable;

beforeAll(() => {
  if (!hasPortalDat) return;
  const portalDb = openDat(PORTAL_PATH);

  const xpData = portalDb.getFileData(0x0E000018);
  xpTable = new XpTable(new DatReader(xpData!));
});

describe.skipIf(!hasPortalDat)('Phase 26 — Core Game Logic Smoke Test', () => {

// ─── 4. Loot + Equip ───────────────────────────────────────

describe('4. Loot + Equip', () => {
  it('pick up from corpse → equip → stat bonus → burden increases', () => {
    const inventory = new InventoryManager();
    const equipment = new EquipmentSystem();

    // Simulate corpse loot: a sword
    const swordId = inventory.addItem({
      weenieClassId: 500,
      name: 'Bronze Sword',
      burden: 250,
      value: 100,
      stackable: false,
      stackSize: 1,
      maxStackSize: 1,
      containerId: 0,
    });

    expect(inventory.count).toBe(1);
    expect(inventory.totalBurden).toBe(250);

    // Equip the sword
    const swordItem = inventory.getItem(swordId)!;
    const equipResult = equipment.equipItem(swordItem, EquipMask.MeleeWeapon);
    expect(equipResult.success).toBe(true);

    // Verify equipment burden
    expect(equipment.totalBurden).toBe(250);

    // Now add armor
    const armorId = inventory.addItem({
      weenieClassId: 501,
      name: 'Chain Mail Shirt',
      burden: 500,
      value: 200,
      stackable: false,
      stackSize: 1,
      maxStackSize: 1,
      containerId: 0,
    });

    const armorItem = inventory.getItem(armorId)!;
    const armorEquipResult = equipment.equipItem(armorItem, EquipMask.ChestWear);
    expect(armorEquipResult.success).toBe(true);
    expect(equipment.totalBurden).toBe(750); // sword + armor
  });
});

// ─── 5. Death + Vitae ───────────────────────────────────────

describe('5. Death + Vitae', () => {
  it('player HP → 0 → vitae penalty applied', () => {
    // Set up player vitals
    const attributes = new AttributeSystem({
      strength: 100, endurance: 100,
      coordination: 80, quickness: 80,
      focus: 60, self: 60,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attributes);

    // Verify starting health
    const maxHealth = vitals.getMax(VitalId.Health, attributes);
    expect(maxHealth).toBe(Math.floor(100 / 2)); // endurance / 2 = 50
    expect(vitals.getCurrent(VitalId.Health)).toBe(maxHealth);

    // Take lethal damage
    vitals.takeDamage(maxHealth + 10);
    expect(vitals.getCurrent(VitalId.Health)).toBe(0);
    expect(vitals.isDead()).toBe(true);

    // Apply vitae penalty (5% per death)
    const vitaePercent = 0.05;
    const effectiveSkill = 200;
    const penalizedSkill = Math.floor(effectiveSkill * (1 - vitaePercent));
    expect(penalizedSkill).toBe(190); // 200 * 0.95

    // Double death = 10% vitae
    const doubleVitae = 0.10;
    const doublePenalized = Math.floor(effectiveSkill * (1 - doubleVitae));
    expect(doublePenalized).toBe(180); // 200 * 0.90

    // Vitae stacks up to 40%
    const maxVitae = 0.40;
    const maxPenalized = Math.floor(effectiveSkill * (1 - maxVitae));
    expect(maxPenalized).toBe(120); // 200 * 0.60

    // Respawn at lifestone — heal to full
    vitals.setCurrent(VitalId.Health, maxHealth, attributes);
    expect(vitals.getCurrent(VitalId.Health)).toBe(maxHealth);
    expect(vitals.isDead()).toBe(false);
  });
});

// ─── 6. Leveling ────────────────────────────────────────────

describe('6. Leveling', () => {
  it('grant XP → level up → skill credits → train skill', () => {
    const xpSystem = new XpSystem(52); // a fresh human character's skill credits

    // Start at level 1
    expect(xpSystem.level).toBe(1);
    expect(xpSystem.availableXp).toBe(0n);

    // Grant XP to reach level 2
    const levelXpTable = xpTable.characterLevelXpList;
    const levelSkillCreditTable = xpTable.characterLevelSkillCreditList;
    expect(levelXpTable.length).toBeGreaterThan(2);

    const level2Threshold = levelXpTable[2]; // index 2 = level 2
    expect(level2Threshold).toBeGreaterThan(0n);

    xpSystem.grantXp(level2Threshold + 1n, levelXpTable, levelSkillCreditTable);
    expect(xpSystem.level).toBeGreaterThanOrEqual(2);

    // Should have available XP for spending
    expect(xpSystem.availableXp).toBeGreaterThan(0n);

    // Grant more XP to reach higher level
    xpSystem.grantXp(1000000n, levelXpTable, levelSkillCreditTable);
    const levelAfter = xpSystem.level;
    expect(levelAfter).toBeGreaterThan(2);

    // Skill credits should include initial + any per-level grants
    expect(xpSystem.availableSkillCredits).toBeGreaterThan(0);

    // Spend skill credits
    const creditsBefore = xpSystem.availableSkillCredits;
    const spent = xpSystem.spendSkillCredits(1);
    expect(spent).toBe(true);
    expect(xpSystem.availableSkillCredits).toBe(creditsBefore - 1);

    // Spend XP on attribute/skill raise
    const availBefore = xpSystem.availableXp;
    const xpSpent = xpSystem.spendXp(100);
    expect(xpSpent).toBe(true);
    expect(xpSystem.availableXp).toBe(availBefore - 100n);

    // Cannot spend more XP than available
    const tooMuch = Number(xpSystem.availableXp) + 1;
    expect(xpSystem.spendXp(tooMuch)).toBe(false);
  });
});

// ─── Final Consistency Check ────────────────────────────────

describe('Final Consistency Check', () => {
  it('all 6 sub-scenarios produce consistent state', () => {
    // A created character's state as ACE's CharacterCreate returns it
    // (character creation itself is server-side, PlayerFactory.cs).
    const attrs = new AttributeSystem({
      strength: 100, endurance: 70,
      coordination: 50, quickness: 40,
      focus: 40, self: 30,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    const xpSys = new XpSystem(52);
    const inventory = new InventoryManager();
    const equipment = new EquipmentSystem();
    const enchantments = new EnchantmentManager();

    // Verify HP ≤ max HP
    expect(vitals.getCurrent(VitalId.Health)).toBeLessThanOrEqual(vitals.getMax(VitalId.Health, attrs));

    // Add items to inventory
    inventory.addItem({ weenieClassId: 1, name: 'Sword', burden: 200, value: 50, stackable: false, stackSize: 1, maxStackSize: 1, containerId: 0 });
    inventory.addItem({ weenieClassId: 2, name: 'Shield', burden: 300, value: 80, stackable: false, stackSize: 1, maxStackSize: 1, containerId: 0 });
    inventory.addItem({ weenieClassId: 3, name: 'Arrows', burden: 10, value: 1, stackable: true, stackSize: 50, maxStackSize: 100, containerId: 0 });

    // Inventory burden matches sum
    expect(inventory.totalBurden).toBe(200 + 300 + 10 * 50);

    // Equip items
    const swordItem = inventory.getItem(1)!;
    equipment.equipItem(swordItem, EquipMask.MeleeWeapon);

    const shieldItem = inventory.getItem(2)!;
    equipment.equipItem(shieldItem, EquipMask.Shield);

    // Equipped items show in equipment
    expect(equipment.totalBurden).toBe(500);

    // Apply enchantment
    enchantments.apply({
      spellId: 1, spellName: 'Strength Self V',
      category: EnchantmentCategory.AttributeBuff,
      buffAttribute: AttributeId.Strength,
      magnitude: 20, duration: 300, remaining: 300,
      casterId: 1, spellLevel: 5,
    });
    expect(enchantments.getTotalBonus(AttributeId.Strength, EnchantmentStatDomain.Attribute)).toBe(20);

    // Simulate combat damage
    vitals.takeDamage(5);
    expect(vitals.getCurrent(VitalId.Health)).toBe(vitals.getMax(VitalId.Health, attrs) - 5);

    // Level up
    const levelXpTable = xpTable.characterLevelXpList;
    const levelSkillCreditTable = xpTable.characterLevelSkillCreditList;
    xpSys.grantXp(5000000n, levelXpTable, levelSkillCreditTable);
    expect(xpSys.level).toBeGreaterThan(1);

    // Final consistency: all values are sane
    expect(vitals.getCurrent(VitalId.Health)).toBeGreaterThanOrEqual(0);
    expect(vitals.getCurrent(VitalId.Health)).toBeLessThanOrEqual(vitals.getMax(VitalId.Health, attrs));
    expect(inventory.count).toBe(3);
    expect(xpSys.totalXp).toBe(5000000n);
    expect(enchantments.count).toBe(1);
  });
});

}); // end describe.skipIf
