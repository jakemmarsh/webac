/**
 * Phase 21 — Attribute/Skill/Vital System + XP + Leveling
 *
 * Tests primary attributes, skill base values, vital calculations,
 * XP tracking, leveling, and skill credit grants.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatDatabase, DatReader, SkillTable, XpTable, SecondaryAttributeTable } from '@ac/dat-parser';
import {
  AttributeSystem, AttributeId, VitalSystem, VitalId, REGEN_INTERVAL, RegenStance,
  getHealthRegenAttributeMod, getRegenStanceMod, getAugmentationRegenMod, SkillSystem,
  computeSkillBase, XpSystem, SkillAdvancementClass, roundHalfAwayFromZero,
} from '@ac/shared';
import { openDat } from './_harness/dat.js';

const DAT_DIR = path.resolve(__dirname, '..', 'dat');
const PORTAL_PATH = path.join(DAT_DIR, 'client_portal.dat');

const hasPortalDat = fs.existsSync(PORTAL_PATH);

let skillTable: SkillTable;
let xpTable: XpTable;
let secAttrTable: SecondaryAttributeTable;

beforeAll(() => {
  if (!hasPortalDat) return;
  const portalDb = openDat(PORTAL_PATH);

  const stData = portalDb.getFileData(0x0E000004);
  skillTable = new SkillTable(new DatReader(stData!));

  const xpData = portalDb.getFileData(0x0E000018);
  xpTable = new XpTable(new DatReader(xpData!));

  const saData = portalDb.getFileData(0x0E000003);
  secAttrTable = new SecondaryAttributeTable(new DatReader(saData!));
});

// ─── AttributeSystem ────────────────────────────────────────

describe.skipIf(!hasPortalDat)('Phase 21 — Attribute/Skill/Vital System', () => {

describe('AttributeSystem', () => {
  it('initializes with innate values', () => {
    const attrs = new AttributeSystem({
      strength: 60, endurance: 70, coordination: 50,
      quickness: 40, focus: 55, self: 55,
    });
    expect(attrs.getCurrent(AttributeId.Strength)).toBe(60);
    expect(attrs.getCurrent(AttributeId.Endurance)).toBe(70);
    expect(attrs.getCurrent(AttributeId.Coordination)).toBe(50);
    expect(attrs.getCurrent(AttributeId.Quickness)).toBe(40);
    expect(attrs.getCurrent(AttributeId.Focus)).toBe(55);
    expect(attrs.getCurrent(AttributeId.Self)).toBe(55);
  });

  it('getInnate returns creation value', () => {
    const attrs = new AttributeSystem({
      strength: 80, endurance: 70, coordination: 50,
      quickness: 40, focus: 55, self: 35,
    });
    expect(attrs.getInnate(AttributeId.Strength)).toBe(80);
    expect(attrs.getRaises(AttributeId.Strength)).toBe(0);
  });

  it('raiseAttribute increases total', () => {
    const attrs = new AttributeSystem({
      strength: 60, endurance: 60, coordination: 60,
      quickness: 60, focus: 60, self: 30,
    });
    // Use xpTable.attributeXpList for cost
    const costTable = xpTable.attributeXpList;
    expect(costTable.length).toBeGreaterThan(1);

    const cost = attrs.raiseAttribute(AttributeId.Strength, costTable, 999999999);
    expect(cost).toBeGreaterThan(0);
    expect(attrs.getCurrent(AttributeId.Strength)).toBe(61);
    expect(attrs.getRaises(AttributeId.Strength)).toBe(1);
  });

  it('raiseAttribute returns 0 when insufficient XP', () => {
    const attrs = new AttributeSystem({
      strength: 60, endurance: 60, coordination: 60,
      quickness: 60, focus: 60, self: 30,
    });
    const costTable = xpTable.attributeXpList;
    const cost = attrs.raiseAttribute(AttributeId.Strength, costTable, 0);
    expect(cost).toBe(0);
    expect(attrs.getCurrent(AttributeId.Strength)).toBe(60);
  });

  it('getAll returns all attribute values', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 20, coordination: 30,
      quickness: 40, focus: 50, self: 60,
    });
    const all = attrs.getAll();
    expect(all.strength).toBe(10);
    expect(all.endurance).toBe(20);
    expect(all.coordination).toBe(30);
    expect(all.quickness).toBe(40);
    expect(all.focus).toBe(50);
    expect(all.self).toBe(60);
  });

  it('getNextRaiseCost returns correct cost', () => {
    const attrs = new AttributeSystem({
      strength: 60, endurance: 60, coordination: 60,
      quickness: 60, focus: 60, self: 30,
    });
    const costTable = xpTable.attributeXpList;
    const cost = attrs.getNextRaiseCost(AttributeId.Strength, costTable);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
});

// ─── VitalSystem ────────────────────────────────────────────

describe('VitalSystem', () => {
  it('computes health = round(endurance / 2) [ACE half-away-from-zero]', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    expect(vitals.getBase(VitalId.Health, attrs)).toBe(40); // 80/2
  });

  it('rounds odd-endurance health UP, not down (ACE AttributeFormula .Round AwayFromZero)', () => {
    // End 101 -> 50.5 -> 51 (ACE), NOT 50 (the prior Math.floor bug).
    for (const [end, expected] of [[101, 51], [103, 52], [77, 39], [99, 50]] as const) {
      const attrs = new AttributeSystem({
        strength: 10, endurance: end, coordination: 10,
        quickness: 10, focus: 10, self: 10,
      });
      expect(new VitalSystem().getBase(VitalId.Health, attrs)).toBe(expected);
    }
  });

  it('computes stamina = endurance', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 70, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    expect(vitals.getBase(VitalId.Stamina, attrs)).toBe(70);
  });

  it('computes mana = self', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 10,
      quickness: 10, focus: 10, self: 90,
    });
    const vitals = new VitalSystem();
    expect(vitals.getBase(VitalId.Mana, attrs)).toBe(90);
  });

  it('health for multiple endurance values', () => {
    for (const end of [10, 50, 77, 100, 200]) {
      const attrs = new AttributeSystem({
        strength: 10, endurance: end, coordination: 10,
        quickness: 10, focus: 10, self: 10,
      });
      const vitals = new VitalSystem();
      expect(vitals.getBase(VitalId.Health, attrs)).toBe(roundHalfAwayFromZero(end / 2));
    }
  });

  it('initToMax sets current = max', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 60,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    expect(vitals.getCurrent(VitalId.Health)).toBe(40);
    expect(vitals.getCurrent(VitalId.Stamina)).toBe(80);
    expect(vitals.getCurrent(VitalId.Mana)).toBe(60);
  });

  it('takeDamage reduces health', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    expect(vitals.getCurrent(VitalId.Health)).toBe(40);

    const dmg = vitals.takeDamage(15);
    expect(dmg).toBe(15);
    expect(vitals.getCurrent(VitalId.Health)).toBe(25);
  });

  it('takeDamage clamps at 0', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 20, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    const dmg = vitals.takeDamage(999);
    expect(dmg).toBe(10); // max was 10
    expect(vitals.getCurrent(VitalId.Health)).toBe(0);
    expect(vitals.isDead()).toBe(true);
  });

  it('useMana returns false when insufficient', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 10,
      quickness: 10, focus: 10, self: 20,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    expect(vitals.useMana(10)).toBe(true);
    expect(vitals.getCurrent(VitalId.Mana)).toBe(10);
    expect(vitals.useMana(15)).toBe(false); // only 10 left
    expect(vitals.getCurrent(VitalId.Mana)).toBe(10); // unchanged
  });

  it('useStamina works correctly', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 50, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    expect(vitals.useStamina(20)).toBe(true);
    expect(vitals.getCurrent(VitalId.Stamina)).toBe(30);
  });

  it('useStamina never refuses — clamps to 0 on insufficient stamina instead of rejecting (ACE Player.cs jump/combat stamina checks are dead/absent; UpdateVital clamps via Math.Clamp rather than blocking the action)', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    expect(vitals.getCurrent(VitalId.Stamina)).toBe(10);
    expect(vitals.useStamina(999)).toBe(true); // never returns false
    expect(vitals.getCurrent(VitalId.Stamina)).toBe(0); // clamped, not left unchanged
  });

  it('regeneration restores vitals over time', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 100, coordination: 10,
      quickness: 10, focus: 10, self: 100,
    });
    const vitals = withUnitRates(new VitalSystem());
    vitals.initToMax(attrs);

    // Damage health and use mana
    vitals.takeDamage(10);
    vitals.useMana(10);
    expect(vitals.getCurrent(VitalId.Health)).toBe(40); // max 50, took 10
    expect(vitals.getCurrent(VitalId.Mana)).toBe(90);   // max 100, used 10

    // Simulate regen for 1 tick (REGEN_INTERVAL seconds)
    vitals.regenTick(REGEN_INTERVAL, attrs);
    expect(vitals.getCurrent(VitalId.Health)).toBe(41); // +1 per tick
    expect(vitals.getCurrent(VitalId.Mana)).toBe(91);   // +1 per tick
  });

  it('regen does not exceed max', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 20, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    vitals.initToMax(attrs);
    // At max, regen should not increase
    vitals.regenTick(REGEN_INTERVAL, attrs);
    expect(vitals.getCurrent(VitalId.Health)).toBe(10);
    expect(vitals.getCurrent(VitalId.Stamina)).toBe(20);
    expect(vitals.getCurrent(VitalId.Mana)).toBe(10);
  });

  it('raiseVital increases max', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    const costTable = xpTable.vitalXpList;
    const cost = vitals.raiseVital(VitalId.Health, costTable, 999999999);
    expect(cost).toBeGreaterThan(0);
    // Max should increase by 1 from the raise
    expect(vitals.getMax(VitalId.Health, attrs)).toBe(41); // 40 base + 1 raise
  });
});

// ─── Vital Regen (ACE formulas) ─────────────────────────────

/**
 * STATS.regen-prediction-diverges — getRegenPerTick reads the vital's live
 * RegenRate (VitalSystem.getRegenRate: server value, else the player weenie's
 * 0.3 / 3 / 1). The stance / partial-tick / augmentation math below was
 * written against unit rates, so these tests pin explicit server rates
 * (health 1, stamina 2, mana 1) — the same numbers the old hardcoded table
 * held — and assert the modifiers on top of them.
 */
function withUnitRates(vitals: VitalSystem): VitalSystem {
  vitals.setRegenRate(VitalId.Health, 1);
  vitals.setRegenRate(VitalId.Stamina, 2);
  vitals.setRegenRate(VitalId.Mana, 1);
  return vitals;
}

describe('Health regen attribute modifier (ACE Creature_Vitals.cs)', () => {
  it('returns 1.0 when Str + 2*End <= 200', () => {
    // Str=10, End=10 → 10 + 20 = 30 ≤ 200
    expect(getHealthRegenAttributeMod(10, 10)).toBe(1.0);
    // Str=100, End=50 → 100 + 100 = 200 ≤ 200
    expect(getHealthRegenAttributeMod(100, 50)).toBe(1.0);
  });

  it('scales linearly above 200', () => {
    // Str=100, End=100 → 100 + 200 = 300, mod = 1.0 + 100/600 ≈ 1.1667
    const mod = getHealthRegenAttributeMod(100, 100);
    expect(mod).toBeCloseTo(1.1667, 3);
  });

  it('caps at 2.1', () => {
    // Str=290, End=290 → 290 + 580 = 870, mod = 1.0 + 670/600 = 2.1167 → capped to 2.1
    expect(getHealthRegenAttributeMod(290, 290)).toBe(2.1);
  });

  it('exact boundary: Str+2*End = 201 gives just above 1.0', () => {
    // Str=1, End=100 → 1 + 200 = 201, mod = 1.0 + 1/600 ≈ 1.00167
    const mod = getHealthRegenAttributeMod(1, 100);
    expect(mod).toBeCloseTo(1.00167, 4);
  });
});

describe('Regen stance modifiers (ACE Player_Vitals.cs)', () => {
  it('combat and running = 0.5x', () => {
    expect(getRegenStanceMod(RegenStance.Combat)).toBe(0.5);
    expect(getRegenStanceMod(RegenStance.Running)).toBe(0.5);
  });

  it('standing = 1.0x', () => {
    expect(getRegenStanceMod(RegenStance.Standing)).toBe(1.0);
  });

  it('crouching = 2.0x, sitting = 2.5x, sleeping = 3.0x', () => {
    expect(getRegenStanceMod(RegenStance.Crouching)).toBe(2.0);
    expect(getRegenStanceMod(RegenStance.Sitting)).toBe(2.5);
    expect(getRegenStanceMod(RegenStance.Sleeping)).toBe(3.0);
  });
});

describe('Augmentation regen modifier', () => {
  it('0 augs = 1.0x, 1 aug = 2.0x, 2 augs = 3.0x', () => {
    expect(getAugmentationRegenMod(0)).toBe(1.0);
    expect(getAugmentationRegenMod(1)).toBe(2.0);
    expect(getAugmentationRegenMod(2)).toBe(3.0);
  });

  it('caps at 2 augmentations', () => {
    expect(getAugmentationRegenMod(5)).toBe(3.0);
  });
});

describe('VitalSystem regen with stance', () => {
  // Use Str=10, End=80 → Str + 2*End = 170 ≤ 200, so health attributeMod = 1.0
  it('sitting stance doubles+ health/stamina regen but NOT mana', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 80,
    });
    const vitals = withUnitRates(new VitalSystem());
    vitals.initToMax(attrs);
    vitals.takeDamage(20);
    vitals.useStamina(20);
    vitals.useMana(20);

    // Sitting: health/stamina get 2.5x, mana gets 1.0x (unchanged)
    const healthRegen = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Sitting);
    const staminaRegen = vitals.getRegenPerTick(VitalId.Stamina, attrs, RegenStance.Sitting);
    const manaRegen = vitals.getRegenPerTick(VitalId.Mana, attrs, RegenStance.Sitting);

    // Base rates: health=1, stamina=2, mana=1; attributeMod=1.0 (Str+2*End=170 ≤ 200)
    // Sitting: health=1*2.5=2.5, stamina=2*2.5=5.0, mana=1*1.0=1.0 (no stance mod)
    expect(healthRegen).toBe(2.5);
    expect(staminaRegen).toBe(5.0);
    expect(manaRegen).toBe(1.0); // Mana NOT affected by stance
  });

  it('health regen attribute mod counts XP-raised Str/End (ACE reads .Base = innate+ranks)', () => {
    // ACE Creature_Vitals.cs:186 reads Strength.Base + Endurance.Base (StartingValue + Ranks),
    // so raising Str/End with XP must speed up health regen. The prior getInnate() dropped raises.
    const attrs = new AttributeSystem({
      strength: 100, endurance: 100, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = new VitalSystem();
    // Innate Str+2*End = 100 + 200 = 300 -> mod = 1 + (300-200)/600 = 1.1667.
    const before = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Standing);
    // Raise both by 50 (as XP ranks). Now Str+2*End = 150 + 300 = 450 -> mod = 1 + 250/600 = 1.4167.
    attrs.setRaises(AttributeId.Strength, 50);
    attrs.setRaises(AttributeId.Endurance, 50);
    const after = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Standing);
    expect(after).toBeGreaterThan(before);
    expect(after / before).toBeCloseTo(1.4167 / 1.1667, 3);
  });

  it('combat stance halves health/stamina regen but NOT mana', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 80,
    });
    const vitals = withUnitRates(new VitalSystem());

    const healthRegen = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Combat);
    const staminaRegen = vitals.getRegenPerTick(VitalId.Stamina, attrs, RegenStance.Combat);
    const manaRegen = vitals.getRegenPerTick(VitalId.Mana, attrs, RegenStance.Combat);

    // Combat: health=1*0.5=0.5, stamina=2*0.5=1.0, mana=1*1.0=1.0
    expect(healthRegen).toBe(0.5);
    expect(staminaRegen).toBe(1.0);
    expect(manaRegen).toBe(1.0);
  });

  it('partial tick accumulation carries fractional amounts', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 80,
    });
    const vitals = withUnitRates(new VitalSystem());
    vitals.initToMax(attrs);
    vitals.takeDamage(20);

    // Combat stance: health regen = 0.5 per tick (attributeMod=1.0)
    // After 1 tick: partialRegen = 0.5, no integer regen yet
    vitals.regenTick(REGEN_INTERVAL, attrs, RegenStance.Combat);
    expect(vitals.getCurrent(VitalId.Health)).toBe(20); // no change (0.5 < 1)

    // After 2nd tick: accumulated 1.0, should regen 1 HP
    vitals.regenTick(REGEN_INTERVAL, attrs, RegenStance.Combat);
    expect(vitals.getCurrent(VitalId.Health)).toBe(21); // +1 from 2 ticks of 0.5
  });

  it('augmentation multiplies regen while sleeping (Creature_Vitals.cs:129-131)', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 80,
    });
    const vitals = withUnitRates(new VitalSystem());

    // Sleeping + 1 augmentation: health = 1 * 1.0(attrMod) * 3.0(stance) * 2.0(aug) = 6.0
    const regen = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Sleeping, 1.0, 1);
    expect(regen).toBe(6.0);

    // Sleeping + 2 augmentations: health = 1 * 1.0 * 3.0 * 3.0 = 9.0
    const regen2 = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Sleeping, 1.0, 2);
    expect(regen2).toBe(9.0);
  });

  it('augmentation applies in every stance, not only Sleeping (STATS.regen-prediction-diverges)', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 80, coordination: 10,
      quickness: 10, focus: 10, self: 80,
    });
    const vitals = withUnitRates(new VitalSystem());

    // ACE Creature_Vitals.cs:129-131 has NO stance test:
    //   `if (this is Player player && player.AugmentationFasterRegen > 0)
    //        augMod += player.AugmentationFasterRegen;`
    // (the earlier "Sleeping only" premise quoted a gate that ACE lacks).
    // 2 augs => augMod 3.0 on top of the stance mod.
    const standing = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Standing, 1.0, 2);
    expect(standing).toBe(3.0);

    const sitting = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Sitting, 1.0, 2);
    expect(sitting).toBe(7.5);

    const combat = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Combat, 1.0, 2);
    expect(combat).toBe(1.5);
  });

  it('high Str+End increases health regen via attribute modifier', () => {
    // Str=200, End=200 → Str + 2*End = 600, mod = 1.0 + 400/600 ≈ 1.6667
    const attrs = new AttributeSystem({
      strength: 200, endurance: 200, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    const vitals = withUnitRates(new VitalSystem());

    const healthRegen = vitals.getRegenPerTick(VitalId.Health, attrs, RegenStance.Standing);
    expect(healthRegen).toBeCloseTo(1.6667, 3);

    // Stamina should NOT be affected by attribute modifier
    const staminaRegen = vitals.getRegenPerTick(VitalId.Stamina, attrs, RegenStance.Standing);
    expect(staminaRegen).toBe(2.0); // base rate only
  });
});

// ─── SkillSystem ────────────────────────────────────────────

describe('SkillSystem', () => {
  it('tracks advancement classes from creation', () => {
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(6, SkillAdvancementClass.Trained);   // MeleeDefense
    skills.set(34, SkillAdvancementClass.Specialized); // WarMagic
    skills.set(22, SkillAdvancementClass.Untrained); // Jump

    const system = new SkillSystem(skills);
    expect(system.getAdvancementClass(6)).toBe(SkillAdvancementClass.Trained);
    expect(system.getAdvancementClass(34)).toBe(SkillAdvancementClass.Specialized);
    expect(system.getAdvancementClass(22)).toBe(SkillAdvancementClass.Untrained);
  });

  it('computes skill base from attribute formula', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 80,
      quickness: 60, focus: 10, self: 10,
    });
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(6, SkillAdvancementClass.Trained); // MeleeDefense

    const system = new SkillSystem(skills);
    const meleeDefSkill = skillTable.skills.get(6);
    expect(meleeDefSkill).toBeDefined();

    const base = system.getBase(6, skillTable.skills, attrs);
    // MeleeDefense formula = (Coord + Quickness) / 3
    // = (80 + 60) / 3 = 46.67 -> 47 (ACE round-half-away-from-zero, not floor)
    const expectedBase = computeSkillBase(meleeDefSkill!.formula, attrs);
    expect(base).toBe(expectedBase);
    expect(base).toBeGreaterThan(0);
  });

  it('total = base + raises', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 80,
      quickness: 60, focus: 10, self: 10,
    });
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(6, SkillAdvancementClass.Trained);
    const system = new SkillSystem(skills);

    const base = system.getBase(6, skillTable.skills, attrs);
    expect(system.getTotal(6, skillTable.skills, attrs)).toBe(base);

    // Raise the skill
    const cost = system.raiseSkill(6, xpTable.trainedSkillXpList, xpTable.specializedSkillXpList, 999999999);
    expect(cost).toBeGreaterThan(0);
    expect(system.getTotal(6, skillTable.skills, attrs)).toBe(base + 1);
  });

  it('cannot raise untrained skill', () => {
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(22, SkillAdvancementClass.Untrained);
    const system = new SkillSystem(skills);

    const cost = system.raiseSkill(22, xpTable.trainedSkillXpList, xpTable.specializedSkillXpList, 999999999);
    expect(cost).toBe(0);
  });

  it('trainSkill upgrades from untrained', () => {
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(22, SkillAdvancementClass.Untrained);
    const system = new SkillSystem(skills);

    expect(system.isTrained(22)).toBe(false);
    expect(system.trainSkill(22)).toBe(true);
    expect(system.isTrained(22)).toBe(true);
    expect(system.getAdvancementClass(22)).toBe(SkillAdvancementClass.Trained);
  });

  it('specializeSkill upgrades from trained', () => {
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(6, SkillAdvancementClass.Trained);
    const system = new SkillSystem(skills);

    expect(system.isSpecialized(6)).toBe(false);
    expect(system.specializeSkill(6)).toBe(true);
    expect(system.isSpecialized(6)).toBe(true);
  });

  it('cannot specialize untrained skill', () => {
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(22, SkillAdvancementClass.Untrained);
    const system = new SkillSystem(skills);

    expect(system.specializeSkill(22)).toBe(false);
  });

  it('attribute raise increases dependent skill bases', () => {
    const attrs = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 50,
      quickness: 50, focus: 10, self: 10,
    });
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(6, SkillAdvancementClass.Trained);
    const system = new SkillSystem(skills);

    const baseBefore = system.getBase(6, skillTable.skills, attrs);

    // Raise coordination (contributes to melee defense)
    attrs.raiseAttribute(AttributeId.Coordination, xpTable.attributeXpList, 999999999);
    const baseAfter = system.getBase(6, skillTable.skills, attrs);

    // Skill base may or may not increase by exactly 1 depending on formula divisor
    // But total should be >= before
    expect(baseAfter).toBeGreaterThanOrEqual(baseBefore);
  });

  it('getNextRaiseCost works for trained vs specialized', () => {
    const skills = new Map<number, SkillAdvancementClass>();
    skills.set(6, SkillAdvancementClass.Trained);
    skills.set(34, SkillAdvancementClass.Specialized);
    const system = new SkillSystem(skills);

    const trainedCost = system.getNextRaiseCost(6, xpTable.trainedSkillXpList, xpTable.specializedSkillXpList);
    const specCost = system.getNextRaiseCost(34, xpTable.trainedSkillXpList, xpTable.specializedSkillXpList);

    expect(trainedCost).not.toBeNull();
    expect(specCost).not.toBeNull();
    expect(trainedCost!).toBeGreaterThan(0);
    expect(specCost!).toBeGreaterThan(0);
  });
});

// ─── XpSystem ───────────────────────────────────────────────

describe('XpSystem', () => {
  it('starts at level 1 with 0 XP', () => {
    const xp = new XpSystem(52);
    expect(xp.level).toBe(1);
    expect(xp.totalXp).toBe(0n);
    expect(xp.availableXp).toBe(0n);
    expect(xp.totalSkillCredits).toBe(52);
    expect(xp.availableSkillCredits).toBe(52);
  });

  it('grantXp increases total and available', () => {
    const xp = new XpSystem(52);
    xp.grantXp(1000n, xpTable.characterLevelXpList, xpTable.characterLevelSkillCreditList);
    expect(xp.totalXp).toBe(1000n);
    expect(xp.availableXp).toBe(1000n);
  });

  it('levels up when XP threshold reached', () => {
    const xp = new XpSystem(52);
    // Grant enough XP to reach level 10
    const level10Xp = xpTable.characterLevelXpList[10];
    expect(level10Xp).toBeDefined();

    const newLevels = xp.grantXp(level10Xp, xpTable.characterLevelXpList, xpTable.characterLevelSkillCreditList);
    expect(xp.level).toBeGreaterThanOrEqual(10);
    expect(newLevels.length).toBeGreaterThan(0);
    expect(newLevels).toContain(10);
  });

  it('grants skill credits on level up', () => {
    const xp = new XpSystem(52);
    const startCredits = xp.totalSkillCredits;

    // Level up several levels — should grant additional credits
    const level20Xp = xpTable.characterLevelXpList[20];
    xp.grantXp(level20Xp, xpTable.characterLevelXpList, xpTable.characterLevelSkillCreditList);

    // Check that some credits were earned (not all levels grant credits, but some should)
    expect(xp.totalSkillCredits).toBeGreaterThanOrEqual(startCredits);
  });

  it('spendXp reduces available', () => {
    const xp = new XpSystem(52);
    xp.grantXp(10000n, xpTable.characterLevelXpList, xpTable.characterLevelSkillCreditList);
    expect(xp.spendXp(5000)).toBe(true);
    expect(xp.availableXp).toBe(5000n);
    expect(xp.totalXp).toBe(10000n); // total unchanged
  });

  it('spendXp rejects if insufficient', () => {
    const xp = new XpSystem(52);
    xp.grantXp(100n, xpTable.characterLevelXpList, xpTable.characterLevelSkillCreditList);
    expect(xp.spendXp(200)).toBe(false);
    expect(xp.availableXp).toBe(100n); // unchanged
  });

  it('spendSkillCredits works', () => {
    const xp = new XpSystem(52);
    expect(xp.spendSkillCredits(10)).toBe(true);
    expect(xp.availableSkillCredits).toBe(42);
    expect(xp.spendSkillCredits(50)).toBe(false); // only 42 left
  });

  it('progress to next level calculation', () => {
    const xp = new XpSystem(52);
    // At level 1, 0 XP — progress should be 0 or close to it
    const progress = xp.getProgressToNextLevel(xpTable.characterLevelXpList);
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThanOrEqual(1);
  });

  it('xpToNextLevel returns correct value', () => {
    const xp = new XpSystem(52);
    const needed = xp.xpToNextLevel(xpTable.characterLevelXpList);
    expect(needed).toBeGreaterThan(0n);
  });

  it('XP table: level 1 = 0, levels increase monotonically', () => {
    expect(xpTable.characterLevelXpList[1]).toBe(0n);
    for (let i = 2; i < xpTable.characterLevelXpList.length; i++) {
      expect(xpTable.characterLevelXpList[i]).toBeGreaterThanOrEqual(
        xpTable.characterLevelXpList[i - 1],
      );
    }
  });

  it('multiple level-ups from single large XP grant', () => {
    const xp = new XpSystem(52);
    const level50Xp = xpTable.characterLevelXpList[50];
    const newLevels = xp.grantXp(level50Xp, xpTable.characterLevelXpList, xpTable.characterLevelSkillCreditList);
    expect(xp.level).toBeGreaterThanOrEqual(50);
    // Should have leveled up from 1 to 50+ = many levels
    expect(newLevels.length).toBeGreaterThanOrEqual(49);
  });
});

// ─── SecondaryAttributeTable from DAT ───────────────────────

describe('SecondaryAttributeTable from DAT', () => {
  it('has health/stamina/mana formulas', () => {
    expect(secAttrTable.maxHealth).toBeDefined();
    expect(secAttrTable.maxStamina).toBeDefined();
    expect(secAttrTable.maxMana).toBeDefined();
  });

  it('health formula references endurance', () => {
    // attr1 or attr2 should be 2 (Endurance)
    const hf = secAttrTable.maxHealth;
    expect(hf.attr1 === 2 || hf.attr2 === 2).toBe(true);
  });

  it('mana formula references self', () => {
    const mf = secAttrTable.maxMana;
    expect(mf.attr1 === 6 || mf.attr2 === 6).toBe(true);
  });
});

}); // end describe.skipIf

// Always-run (no DAT needed): synthetic level XP table.
describe('FORMULA.16: grantXp clamps total/available at the max-level XP ceiling', () => {
  // 3 "levels": ceiling = last entry = 1000n.
  const levelXp = [0n, 100n, 1000n];
  const credits = [0, 1, 1];

  it('caps total XP at the ceiling and adds nothing once at/above it', () => {
    const xp = new XpSystem(52);
    xp.grantXp(999_999n, levelXp, credits); // far past the 1000 ceiling
    expect(xp.totalXp).toBe(1000n);
    expect(xp.availableXp).toBe(1000n);
    // Already at the ceiling: a further grant adds nothing.
    xp.grantXp(500n, levelXp, credits);
    expect(xp.totalXp).toBe(1000n);
    expect(xp.availableXp).toBe(1000n);
  });

  it('a partial grant that would overshoot only adds the remainder to the ceiling', () => {
    const xp = new XpSystem(52);
    xp.grantXp(900n, levelXp, credits); // 100 short of the 1000 ceiling
    xp.grantXp(500n, levelXp, credits); // only 100 of this should land
    expect(xp.totalXp).toBe(1000n);
    expect(xp.availableXp).toBe(1000n);
  });
});
