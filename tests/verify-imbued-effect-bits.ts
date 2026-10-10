/**
 * FAITHFUL.67 — ImbuedEffectType bit-flag positions per ACE source.
 *
 * Source of truth: reference/ACE/Source/ACE.Entity/Enum/ImbuedEffectType.cs
 *
 * Critical wire-format bug fixed: hand-port had IgnoreSomeMagicProjectileDamage
 * at 0x8000 (a single byte higher than NetherRending). ACE has it at
 * 0x20000000 — there's a NON-CONTIGUOUS gap between the rending bits
 * (0x0001–0x4000) and the high-bit flags (0x20000000–0x80000000). The
 * hand-port also entirely omitted AlwaysCritical (0x40000000) and
 * IgnoreAllArmor (0x80000000).
 *
 * These flags ride in PropertyInt.ImbuedEffect=179 on every weapon — any
 * weapon with AlwaysCritical or IgnoreAllArmor was being misidentified.
 */
import { describe, it, expect } from 'vitest';
import { ImbuedEffectType } from '@ac/shared';

describe('ImbuedEffectType (per ACE source)', () => {
  it('low-bit rending flags 0x0001–0x4000', () => {
    expect(ImbuedEffectType.Undef).toBe(0x0);
    expect(ImbuedEffectType.CriticalStrike).toBe(0x0001);
    expect(ImbuedEffectType.CripplingBlow).toBe(0x0002);
    expect(ImbuedEffectType.ArmorRending).toBe(0x0004);
    expect(ImbuedEffectType.SlashRending).toBe(0x0008);
    expect(ImbuedEffectType.PierceRending).toBe(0x0010);
    expect(ImbuedEffectType.BludgeonRending).toBe(0x0020);
    expect(ImbuedEffectType.AcidRending).toBe(0x0040);
    expect(ImbuedEffectType.ColdRending).toBe(0x0080);
    expect(ImbuedEffectType.ElectricRending).toBe(0x0100);
    expect(ImbuedEffectType.FireRending).toBe(0x0200);
    expect(ImbuedEffectType.MeleeDefense).toBe(0x0400);
    expect(ImbuedEffectType.MissileDefense).toBe(0x0800);
    expect(ImbuedEffectType.MagicDefense).toBe(0x1000);
    expect(ImbuedEffectType.Spellbook).toBe(0x2000);
    expect(ImbuedEffectType.NetherRending).toBe(0x4000);
  });

  it('high-bit flags at non-contiguous positions per ACE', () => {
    // Hand-port previously had IgnoreSomeMagicProjectileDamage at 0x8000 (the
    // next bit after NetherRending) — wrong. ACE has these at 0x20000000+.
    expect(ImbuedEffectType.IgnoreSomeMagicProjectileDamage).toBe(0x20000000);
    expect(ImbuedEffectType.AlwaysCritical).toBe(0x40000000);
    expect(ImbuedEffectType.IgnoreAllArmor).toBe(0x80000000);
  });

  it('bit between 0x8000 and 0x20000000 is unused', () => {
    // The 14 bits 0x8000..0x10000000 are reserved (no enum entry). Confirm by
    // checking no enum value falls in that range.
    const values = Object.values(ImbuedEffectType).filter((v) => typeof v === 'number') as number[];
    const reservedRange = values.filter((v) => v >= 0x8000 && v < 0x20000000);
    expect(reservedRange).toEqual([]);
  });

  it('flags compose correctly (AlwaysCritical | CriticalStrike)', () => {
    // A retail item with these two flags would have ImbuedEffect = 0x40000001.
    // Pre-fix, the OR would have been 0x40008001 because IgnoreSomeMagic was
    // at the wrong bit, causing misidentification on items with the high
    // flag.
    const composed = ImbuedEffectType.AlwaysCritical | ImbuedEffectType.CriticalStrike;
    expect(composed).toBe(0x40000001);
    expect((composed & ImbuedEffectType.AlwaysCritical) !== 0).toBe(true);
    expect((composed & ImbuedEffectType.CriticalStrike) !== 0).toBe(true);
    expect((composed & ImbuedEffectType.IgnoreSomeMagicProjectileDamage) !== 0).toBe(false);
  });
});
