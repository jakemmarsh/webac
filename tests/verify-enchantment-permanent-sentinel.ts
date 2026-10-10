/**
 * BUG.enchantment-permanent-sentinel-mishandled — ACE marks an equip-cast
 * (item) enchantment's Duration with the sentinel -1.0 ("active until the
 * item is dequipped", EnchantmentManager.BuildEntry) and:
 *  - substitutes double.PositiveInfinity for -1 before any duration
 *    comparison (AddEnchantmentResult.cs:96,101), and
 *  - skips Duration < 0 entries entirely in the expiry heartbeat
 *    (PropertiesEnchantmentRegistryExtensions.cs:254, `Duration >= 0 &&`).
 *
 * Our EnchantmentManager previously treated -1 as a real countdown value:
 * tick() expired a permanent enchantment on its very first frame, and a
 * finite same-level recast overwrote a permanent enchantment's remaining
 * time. All behavioral over the shipped EnchantmentManager (building
 * enchantments from spells is ACE's job — the client only mirrors the
 * registry the server ships).
 */
import { describe, it, expect } from 'vitest';
import {
  EnchantmentManager, EnchantmentCategory, EnchantmentStatDomain, PERMANENT_ENCHANTMENT_DURATION,
} from '@ac/shared';
import type { ActiveEnchantment } from '@ac/shared';

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

function makePermanent(overrides: Partial<ActiveEnchantment> = {}): ActiveEnchantment {
  return makeEnchantment({
    spellId: 4291,
    spellName: 'Aura of Defense (equip)',
    duration: PERMANENT_ENCHANTMENT_DURATION,
    remaining: PERMANENT_ENCHANTMENT_DURATION,
    ...overrides,
  });
}

describe('ACE -1 permanent-enchantment sentinel', () => {
  it('sentinel constant matches ACE BuildEntry (entry.Duration = -1.0)', () => {
    expect(PERMANENT_ENCHANTMENT_DURATION).toBe(-1);
  });

  it('permanent enchantment survives many ticks (never expires on its own)', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makePermanent());
    // ACE heartbeat: only Duration >= 0 entries expire. 1000 × 5s frames.
    for (let i = 0; i < 1000; i++) {
      const ticks = mgr.tick(5);
      expect(ticks.filter(t => t.expired)).toHaveLength(0);
    }
    expect(mgr.count).toBe(1);
    expect(mgr.getAll()[0].remaining).toBe(PERMANENT_ENCHANTMENT_DURATION);
  });

  it('tick() does not decrement a permanent enchantment (raw sentinel stays stored)', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makePermanent());
    mgr.tick(123.456);
    expect(mgr.getAll()[0].remaining).toBe(-1);
    expect(mgr.getAll()[0].duration).toBe(-1);
  });

  it('finite same-level recast does NOT overwrite a permanent enchantment', () => {
    // ACE AddEnchantmentResult: entryDuration = entry.Duration == -1
    // ? PositiveInfinity : entry.Duration — a finite spellDuration can
    // never surpass it.
    const mgr = new EnchantmentManager();
    mgr.apply(makePermanent());
    const applied = mgr.apply(makeEnchantment({
      spellId: 4291, duration: 1800, remaining: 1800,
    }));
    expect(applied).toBe(true); // cast lands, just doesn't refresh
    expect(mgr.count).toBe(1);
    expect(mgr.getAll()[0].remaining).toBe(PERMANENT_ENCHANTMENT_DURATION);
  });

  it('permanent recast surpasses an existing finite enchantment of the same level', () => {
    // ACE: spellDuration = equip ? PositiveInfinity : spell.Duration —
    // Infinity > any finite remaining, so the entry refreshes; the stored
    // value is the raw sentinel, never Infinity.
    const mgr = new EnchantmentManager();
    mgr.apply(makeEnchantment({ duration: 300, remaining: 120 }));
    mgr.apply(makeEnchantment({
      duration: PERMANENT_ENCHANTMENT_DURATION,
      remaining: PERMANENT_ENCHANTMENT_DURATION,
    }));
    expect(mgr.count).toBe(1);
    expect(mgr.getAll()[0].remaining).toBe(PERMANENT_ENCHANTMENT_DURATION);
    expect(Number.isFinite(mgr.getAll()[0].remaining)).toBe(true);
  });

  it('permanent enchantment still contributes its stat bonus while never expiring', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makePermanent({ magnitude: 20, buffAttribute: 1 }));
    mgr.tick(3600);
    expect(mgr.getTotalBonus(1, EnchantmentStatDomain.Attribute)).toBe(20);
  });

  it('permanent enchantment with periodic effect keeps ticking it', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makePermanent({
      category: EnchantmentCategory.VitalRegen,
      periodicRate: 1, periodicAmount: 5,
    }));
    const ticks = mgr.tick(1.0);
    expect(ticks.filter(t => !t.expired && t.amount === 5)).toHaveLength(1);
    expect(mgr.count).toBe(1);
  });

  it('finite enchantments still count down and expire normally alongside a permanent one', () => {
    const mgr = new EnchantmentManager();
    mgr.apply(makePermanent());
    mgr.apply(makeEnchantment({
      spellId: 200, category: EnchantmentCategory.SkillBuff,
      buffAttribute: 6, duration: 10, remaining: 10,
    }));
    const ticks = mgr.tick(11);
    expect(ticks.filter(t => t.expired)).toHaveLength(1);
    expect(ticks[0].enchantment.spellId).toBe(200);
    expect(mgr.count).toBe(1); // permanent survives
    expect(mgr.getAll()[0].spellId).toBe(4291);
  });
});
