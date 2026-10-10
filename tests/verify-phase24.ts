/**
 * Phase 24 — Magic System + Enchantment Manager
 *
 * Tests the spell/component tables from the DAT, scarab + player-formula
 * helpers the cast gestures use, and the client's EnchantmentManager
 * (stacking, duration, dispel). Casting itself (fizzle, resist, damage,
 * mana) is server-authoritative; that local simulation was deleted
 * (DEBT.shared-dead-server-logic).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatDatabase, DatReader, SpellTable } from '@ac/dat-parser';
import {
  EnchantmentManager, EnchantmentCategory, EnchantmentStatDomain, Scarab, isScarab,
  computeAccountHash, getPlayerFormula,
} from '@ac/shared';
import type { ActiveEnchantment } from '@ac/shared';
import { SpellComponentTable } from '@ac/dat-parser';

const DAT_DIR = path.resolve(__dirname, '..', 'dat');
const PORTAL_PATH = path.join(DAT_DIR, 'client_portal.dat');

const hasPortalDat = fs.existsSync(PORTAL_PATH);

let spellTable: SpellTable;

beforeAll(() => {
  if (!hasPortalDat) return;
  const portalBuf = fs.readFileSync(PORTAL_PATH);
  const portalDb = new DatDatabase(portalBuf.buffer as ArrayBuffer);
  const data = portalDb.getFileData(0x0E00000E);
  spellTable = new SpellTable(new DatReader(data!));
});

function makeEnchantment(overrides: Partial<ActiveEnchantment> = {}): ActiveEnchantment {
  return {
    spellId: 100,
    spellName: 'Strength Self V',
    category: EnchantmentCategory.AttributeBuff,
    buffAttribute: 1,
    magnitude: 15,
    duration: 300,
    remaining: 300,
    casterId: 1,
    spellLevel: 5,
    ...overrides,
  };
}

// ─── SpellTable from DAT ────────────────────────────────────

describe.skipIf(!hasPortalDat)('Phase 24 — Magic System', () => {

describe('SpellTable from DAT', () => {
  it('has ≥6000 spells', () => {
    expect(spellTable.spells.size).toBeGreaterThanOrEqual(6000);
  });

  it('known spells exist with correct school/mana', () => {
    // Check some known spell IDs exist
    let foundSpells = 0;
    for (const [, spell] of spellTable.spells) {
      if (spell.name && spell.name.length > 0) {
        foundSpells++;
      }
    }
    expect(foundSpells).toBeGreaterThan(1000);
  });
});

// ─── EnchantmentManager ─────────────────────────────────────

describe('EnchantmentManager', () => {
  it('applies enchantment', () => {
    const mgr = new EnchantmentManager();
    const ench = makeEnchantment();
    expect(mgr.apply(ench)).toBe(true);
    expect(mgr.count).toBe(1);
    expect(mgr.hasSpell(100)).toBe(true);
  });

  it('creature buff increases attribute', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ magnitude: 15, buffAttribute: 1 }));
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Attribute)).toBe(15);
  });

  it('Strength Self VI overwrites Strength Self V', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ spellId: 100, spellLevel: 5, magnitude: 15, spellName: 'Strength Self V' }));
    mgr.apply(makeEnchantment({ spellId: 200, spellLevel: 6, magnitude: 25, spellName: 'Strength Self VI' }));
    expect(mgr.count).toBe(1);
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Attribute)).toBe(25);
    expect(mgr.hasSpell(200)).toBe(true);
    expect(mgr.hasSpell(100)).toBe(false);
  });

  it('Strength Self V does NOT overwrite VI', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ spellId: 200, spellLevel: 6, magnitude: 25 }));
    const applied = mgr.apply(makeEnchantment({ spellId: 100, spellLevel: 5, magnitude: 15 }));
    expect(applied).toBe(false);
    expect(mgr.count).toBe(1);
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Attribute)).toBe(25); // still VI
  });

  it('same level refreshes duration', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ remaining: 100 }));
    mgr.apply(makeEnchantment({ remaining: 300 })); // same spell level, refreshes
    expect(mgr.count).toBe(1);
    const all = mgr.getAll();
    expect(all[0].remaining).toBe(300);
  });

  it('same level recast with shorter duration does NOT shorten remaining', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ duration: 300, remaining: 300 }));
    const applied = mgr.apply(makeEnchantment({ duration: 50 })); // shorter than the 300 remaining
    expect(applied).toBe(true); // cast still lands, just doesn't refresh
    expect(mgr.count).toBe(1);
    const all = mgr.getAll();
    expect(all[0].remaining).toBe(300); // unchanged, not shortened to 50
  });

  it('enchantment duration expires after correct seconds', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ duration: 10, remaining: 10 }));
    expect(mgr.count).toBe(1);

    // Tick 5 seconds
    mgr.tick(5);
    expect(mgr.count).toBe(1);

    // Tick 6 more seconds — should expire
    const results = mgr.tick(6);
    expect(mgr.count).toBe(0);
    expect(results.some(r => r.expired)).toBe(true);
  });

  it('dispel removes active enchantments', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ spellId: 1, spellLevel: 3, buffAttribute: 1 }));
    mgr.apply(makeEnchantment({ spellId: 2, spellLevel: 5, buffAttribute: 2 }));
    mgr.apply(makeEnchantment({ spellId: 3, spellLevel: 7, buffAttribute: 3 }));
    expect(mgr.count).toBe(3);

    const removed = mgr.dispel(5); // remove spells level ≤ 5
    expect(removed).toBe(2);
    expect(mgr.count).toBe(1);
    expect(mgr.hasSpell(3)).toBe(true); // level 7 survives
  });

  it('periodic regen heals every tick', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 500,
      duration: 60,
      remaining: 60,
      periodicRate: 1, // 1 tick per second
      periodicAmount: 5,
    }));

    // Tick 1 second — should produce regen tick
    const results = mgr.tick(1.0);
    const regenTicks = results.filter(r => !r.expired && r.amount > 0);
    expect(regenTicks.length).toBe(1);
    expect(regenTicks[0].amount).toBe(5);
  });

  it('item enchantment increases weapon damage', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 600,
      category: EnchantmentCategory.WeaponBuff,
      buffAttribute: 100, // weapon property
      magnitude: 10,
    }));
    expect(mgr.getTotalBonus(100, EnchantmentStatDomain.Weapon)).toBe(10);
  });

  it('same-domain buffs on the same key stack, cross-domain buffs do not', () => {
    const mgr = new EnchantmentManager();
    // Attribute buff on Strength (attrId 1)
    mgr.apply(makeEnchantment({
      spellId: 1, category: EnchantmentCategory.AttributeBuff,
      buffAttribute: 1, magnitude: 15, spellLevel: 5,
    }));
    // Skill buff that happens to reuse the same numeric key (skillId 1 = Axe)
    // — PropertyAttribute and SkillId both start at 1, so this is the exact
    // key-collision BUG.enchantment-stat-lookup-ignores-category describes.
    mgr.apply(makeEnchantment({
      spellId: 2, category: EnchantmentCategory.SkillBuff,
      buffAttribute: 1, magnitude: 10, spellLevel: 5,
    }));
    // Each domain query must see only its own category, not the other's.
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Attribute)).toBe(15);
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Skill)).toBe(10);
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Vital)).toBe(0);

    // getForAttribute must apply the same domain isolation.
    expect(mgr.getForAttribute(1, EnchantmentStatDomain.Attribute).map(e => e.spellId)).toEqual([1]);
    expect(mgr.getForAttribute(1, EnchantmentStatDomain.Skill).map(e => e.spellId)).toEqual([2]);
    expect(mgr.getForAttribute(1, EnchantmentStatDomain.Vital)).toEqual([]);
  });

  it('removeBySpellId works', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ spellId: 42, buffAttribute: 99 }));
    expect(mgr.hasSpell(42)).toBe(true);
    expect(mgr.removeBySpellId(42)).toBe(true);
    expect(mgr.hasSpell(42)).toBe(false);
    expect(mgr.count).toBe(0);
  });
});

// ─── Resistance Modifiers ───────────────────────────────────

describe('Resistance modifiers', () => {
  it('protection buff reduces resistance mod below 1.0', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 700,
      category: EnchantmentCategory.ResistanceBuff,
      buffAttribute: 4, // fire damage type
      magnitude: 0,
      multiplier: 0.8, // 20% fire protection
      spellLevel: 5,
    }));
    expect(mgr.getResistanceMod(4)).toBeCloseTo(0.8);
    expect(mgr.getProtectionResistanceMod(4)).toBeCloseTo(0.8);
    expect(mgr.getVulnerabilityResistanceMod(4)).toBeCloseTo(1.0);
  });

  it('vulnerability debuff increases resistance mod above 1.0', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 800,
      category: EnchantmentCategory.ResistanceDebuff,
      buffAttribute: 4,
      magnitude: 0,
      multiplier: 1.2, // 20% fire vulnerability
      spellLevel: 5,
    }));
    expect(mgr.getResistanceMod(4)).toBeCloseTo(1.2);
    expect(mgr.getVulnerabilityResistanceMod(4)).toBeCloseTo(1.2);
    expect(mgr.getProtectionResistanceMod(4)).toBeCloseTo(1.0);
  });

  it('protection + vulnerability stack multiplicatively', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 700, category: EnchantmentCategory.ResistanceBuff,
      buffAttribute: 4, magnitude: 0, multiplier: 0.8, spellLevel: 5,
    }));
    mgr.apply(makeEnchantment({
      spellId: 800, category: EnchantmentCategory.ResistanceDebuff,
      buffAttribute: 4, magnitude: 0, multiplier: 1.3, spellLevel: 5,
    }));
    expect(mgr.getResistanceMod(4)).toBeCloseTo(0.8 * 1.3);
  });

  it('different damage types are independent', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 700, category: EnchantmentCategory.ResistanceBuff,
      buffAttribute: 4, magnitude: 0, multiplier: 0.7, spellLevel: 5,
    }));
    expect(mgr.getResistanceMod(4)).toBeCloseTo(0.7);
    expect(mgr.getResistanceMod(5)).toBeCloseTo(1.0); // cold unaffected
  });
});

// ─── Vitae Interaction ──────────────────────────────────────

describe('Vitae interaction', () => {
  it('no vitae penalty: full stat value', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 100, buffAttribute: 1, magnitude: 15, spellLevel: 5,
    }));
    // base 100 + additive 15 = 115
    expect(mgr.computeEffectiveStat(100, 1, EnchantmentStatDomain.Attribute, 1.0)).toBe(115);
  });

  it('vitae reduces base but not additive bonuses', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 100, buffAttribute: 1, magnitude: 15, spellLevel: 5,
    }));
    // base 100 × 0.90 vitae = 90, + additive 15 = 105
    expect(mgr.computeEffectiveStat(100, 1, EnchantmentStatDomain.Attribute, 0.90)).toBe(105);
  });

  it('multiplicative enchantments are scaled by vitae', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 100, buffAttribute: 1, magnitude: 0,
      multiplier: 1.1, spellLevel: 5,
    }));
    // base 100 × 1.1 multiplier × 0.90 vitae = 99, + 0 additive = 99
    expect(mgr.computeEffectiveStat(100, 1, EnchantmentStatDomain.Attribute, 0.90)).toBe(99);
  });

  it('multiplicative + additive + vitae combine within one domain, not across domains', () => {
    const mgr = new EnchantmentManager();
    // Multiplicative buff: ×1.2 (Attribute domain)
    mgr.apply(makeEnchantment({
      spellId: 100, buffAttribute: 1, magnitude: 0,
      multiplier: 1.2, spellLevel: 5,
      category: EnchantmentCategory.AttributeBuff,
    }));
    // Additive buff: +20, same numeric key but Skill domain
    mgr.apply(makeEnchantment({
      spellId: 200, buffAttribute: 1, magnitude: 20,
      spellLevel: 5,
      category: EnchantmentCategory.SkillBuff,
    }));
    // Attribute-domain query sees only its own ×1.2: base 200 × 1.2 × 0.95 vitae = 228
    expect(mgr.computeEffectiveStat(200, 1, EnchantmentStatDomain.Attribute, 0.95)).toBe(228);
    // Skill-domain query sees only its own +20 additive (unaffected by vitae),
    // but the 0.95 vitae still scales the base: 200 × 0.95 = 190, + 20 = 210
    expect(mgr.computeEffectiveStat(200, 1, EnchantmentStatDomain.Skill, 0.95)).toBe(210);
  });
});

// ─── Remove Negative Enchantments ───────────────────────────

describe('Remove negative enchantments', () => {
  it('removes debuffs but keeps buffs', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 1, category: EnchantmentCategory.AttributeBuff,
      buffAttribute: 1, magnitude: 15, spellLevel: 5,
    }));
    mgr.apply(makeEnchantment({
      spellId: 2, category: EnchantmentCategory.AttributeDebuff,
      buffAttribute: 1, magnitude: -10, spellLevel: 5,
    }));
    mgr.apply(makeEnchantment({
      spellId: 3, category: EnchantmentCategory.ResistanceDebuff,
      buffAttribute: 4, magnitude: 0, multiplier: 1.2, spellLevel: 5,
    }));
    expect(mgr.count).toBe(3);

    const removed = mgr.removeNegativeEnchantments();
    expect(removed).toBe(2);
    expect(mgr.count).toBe(1);
    expect(mgr.hasSpell(1)).toBe(true);  // buff survives
    expect(mgr.hasSpell(2)).toBe(false); // debuff removed
    expect(mgr.hasSpell(3)).toBe(false); // debuff removed
  });
});

// ─── Additive and Multiplicative Helpers ────────────────────

describe('Additive and multiplicative helpers', () => {
  it('getAdditiveBonus only sums magnitude-based enchantments within the queried domain', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 1, buffAttribute: 1, magnitude: 10, spellLevel: 5,
      category: EnchantmentCategory.AttributeBuff,
    }));
    // Same buffAttribute key, but a different (Skill) domain — must not leak in.
    mgr.apply(makeEnchantment({
      spellId: 2, buffAttribute: 1, magnitude: 0, multiplier: 1.2, spellLevel: 5,
      category: EnchantmentCategory.SkillBuff,
    }));
    expect(mgr.getAdditiveBonus(1, EnchantmentStatDomain.Attribute)).toBe(10);
    expect(mgr.getAdditiveBonus(1, EnchantmentStatDomain.Skill)).toBe(0);
  });

  it('getMultiplierMod only multiplies multiplier-based enchantments within the queried domain', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({
      spellId: 1, buffAttribute: 1, magnitude: 10, spellLevel: 5,
      category: EnchantmentCategory.AttributeBuff,
    }));
    // Same buffAttribute key, but a different (Skill) domain — must not leak in.
    mgr.apply(makeEnchantment({
      spellId: 2, buffAttribute: 1, magnitude: 0, multiplier: 1.2, spellLevel: 5,
      category: EnchantmentCategory.SkillBuff,
    }));
    expect(mgr.getMultiplierMod(1, EnchantmentStatDomain.Skill)).toBeCloseTo(1.2);
    expect(mgr.getMultiplierMod(1, EnchantmentStatDomain.Attribute)).toBeCloseTo(1.0);
  });
});

// ─── SpellComponentTable from DAT ────────────────────────────

describe('SpellComponentTable from DAT', () => {
  let componentTable: SpellComponentTable;

  beforeAll(() => {
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new DatDatabase(portalBuf.buffer as ArrayBuffer);
    const data = portalDb.getFileData(0x0E00000F);
    componentTable = new SpellComponentTable(new DatReader(data!));
  });

  it('has ~163 components', () => {
    expect(componentTable.components.size).toBeGreaterThanOrEqual(160);
  });

  it('scarab components have type 1', () => {
    // Lead Scarab (ID 1) should be type 1
    const lead = componentTable.components.get(1);
    expect(lead).toBeDefined();
    expect(lead!.type).toBe(1);
  });

  it('components have names and icons', () => {
    let named = 0;
    for (const [, comp] of componentTable.components) {
      if (comp.name.length > 0 && comp.icon > 0) named++;
    }
    expect(named).toBeGreaterThan(100);
  });
});

// ─── Scarab Identification ──────────────────────────────────

describe('Scarab identification', () => {
  it('recognizes all 10 scarab IDs', () => {
    expect(isScarab(Scarab.Lead)).toBe(true);
    expect(isScarab(Scarab.Iron)).toBe(true);
    expect(isScarab(Scarab.Copper)).toBe(true);
    expect(isScarab(Scarab.Silver)).toBe(true);
    expect(isScarab(Scarab.Gold)).toBe(true);
    expect(isScarab(Scarab.Pyreal)).toBe(true);
    expect(isScarab(Scarab.Diamond)).toBe(true);
    expect(isScarab(Scarab.Platinum)).toBe(true);
    expect(isScarab(Scarab.Dark)).toBe(true);
    expect(isScarab(Scarab.Mana)).toBe(true);
  });

  it('rejects non-scarab IDs', () => {
    expect(isScarab(10)).toBe(false);
    expect(isScarab(63)).toBe(false);  // Red Taper
    expect(isScarab(188)).toBe(false);  // Prismatic Taper
  });
});

// ─── Account Name Hash ──────────────────────────────────────

describe('Account name hash', () => {
  it('empty string returns 0', () => {
    expect(computeAccountHash('')).toBe(0);
  });

  it('produces consistent hash for same name', () => {
    const h1 = computeAccountHash('testplayer');
    const h2 = computeAccountHash('testplayer');
    expect(h1).toBe(h2);
  });

  it('different names produce different hashes', () => {
    const h1 = computeAccountHash('alice');
    const h2 = computeAccountHash('bob');
    expect(h1).not.toBe(h2);
  });

  it('hash is unsigned (>= 0)', () => {
    expect(computeAccountHash('test')).toBeGreaterThanOrEqual(0);
    expect(computeAccountHash('Z')).toBeGreaterThanOrEqual(0);
  });
});

// ─── Player Formula Randomization ───────────────────────────

describe('Player formula randomization', () => {
  it('version 0 (unknown) returns copy of base formula', () => {
    const base = [1, 10, 20, 30, 40];
    const result = getPlayerFormula(base, 0, 'test');
    expect(result).toEqual(base);
    expect(result).not.toBe(base); // different reference
  });

  it('version 3 modifies taper slots (indices 3 and 6)', () => {
    // A full 8-component formula
    const base = [Scarab.Gold, 10, 20, 99, 40, 50, 99, 70];
    const result = getPlayerFormula(base, 3, 'testplayer');
    // Indices 3 and 6 should be replaced with taper IDs (63-74)
    expect(result[3]).toBeGreaterThanOrEqual(63);
    expect(result[3]).toBeLessThanOrEqual(74);
    expect(result[6]).toBeGreaterThanOrEqual(63);
    expect(result[6]).toBeLessThanOrEqual(74);
    // Other indices should be unchanged
    expect(result[0]).toBe(Scarab.Gold);
    expect(result[1]).toBe(10);
    expect(result[2]).toBe(20);
    expect(result[4]).toBe(40);
    expect(result[5]).toBe(50);
    expect(result[7]).toBe(70);
  });

  it('same account produces same randomized formula', () => {
    const base = [Scarab.Gold, 10, 20, 99, 40, 50, 99, 70];
    const r1 = getPlayerFormula(base, 3, 'player1');
    const r2 = getPlayerFormula(base, 3, 'player1');
    expect(r1).toEqual(r2);
  });

  it('different accounts produce different formulas', () => {
    const base = [Scarab.Gold, 10, 20, 99, 40, 50, 99, 70];
    const r1 = getPlayerFormula(base, 3, 'alice');
    const r2 = getPlayerFormula(base, 3, 'bob');
    // At least one taper slot should differ (extremely likely)
    const differ = r1[3] !== r2[3] || r1[6] !== r2[6];
    expect(differ).toBe(true);
  });
});

}); // end describe.skipIf
