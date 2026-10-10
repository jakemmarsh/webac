/**
 * FAITHFUL.67 expansion — pin EnchantmentTypeFlags + EquipMask bit positions
 * verbatim from ACE source. Both had stale/partial coverage that masked the
 * server-emitted state on weapon enchantments and clothing items.
 *
 * Anchored to:
 *   reference/ACE/Source/ACE.Entity/Enum/EnchantmentTypeFlags.cs
 *   reference/ACE/Source/ACE.Entity/Enum/EquipMask.cs
 */
import { describe, it, expect } from 'vitest';
import { EnchantmentTypeFlags } from '@ac/network';
import { EquipMask } from '@ac/shared';

describe('EnchantmentTypeFlags (per ACE source)', () => {
  it('stat-type group: Attribute..BodyArmorValue (low 8 bits)', () => {
    expect(EnchantmentTypeFlags.Undef).toBe(0x0000000);
    expect(EnchantmentTypeFlags.Attribute).toBe(0x0000001);
    expect(EnchantmentTypeFlags.SecondAtt).toBe(0x0000002);
    expect(EnchantmentTypeFlags.Int).toBe(0x0000004);
    expect(EnchantmentTypeFlags.Float).toBe(0x0000008);
    expect(EnchantmentTypeFlags.Skill).toBe(0x0000010);
    expect(EnchantmentTypeFlags.BodyDamageValue).toBe(0x0000020);
    expect(EnchantmentTypeFlags.BodyDamageVariance).toBe(0x0000040);
    expect(EnchantmentTypeFlags.BodyArmorValue).toBe(0x0000080);
  });

  it('StatTypes mask covers the low 8 bits exactly', () => {
    expect(EnchantmentTypeFlags.StatTypes).toBe(0x00000FF);
    // StatTypes = OR of all 8 stat-type flags
    const expected = EnchantmentTypeFlags.Attribute
      | EnchantmentTypeFlags.SecondAtt
      | EnchantmentTypeFlags.Int
      | EnchantmentTypeFlags.Float
      | EnchantmentTypeFlags.Skill
      | EnchantmentTypeFlags.BodyDamageValue
      | EnchantmentTypeFlags.BodyDamageVariance
      | EnchantmentTypeFlags.BodyArmorValue;
    expect(expected).toBe(EnchantmentTypeFlags.StatTypes);
  });

  it('cardinality + stack-direction flags', () => {
    expect(EnchantmentTypeFlags.SingleStat).toBe(0x0001000);
    expect(EnchantmentTypeFlags.MultipleStat).toBe(0x0002000);
    expect(EnchantmentTypeFlags.Multiplicative).toBe(0x0004000);
    expect(EnchantmentTypeFlags.Additive).toBe(0x0008000);
  });

  it('skill-group + degrade variants', () => {
    expect(EnchantmentTypeFlags.AttackSkills).toBe(0x0010000);
    expect(EnchantmentTypeFlags.DefenseSkills).toBe(0x0020000);
    expect(EnchantmentTypeFlags.Multiplicative_Degrade).toBe(0x0100000);
    expect(EnchantmentTypeFlags.Additive_Degrade).toBe(0x0200000);
  });

  it('special: Vitae / Cooldown / Beneficial high bits', () => {
    expect(EnchantmentTypeFlags.Vitae).toBe(0x0800000);
    expect(EnchantmentTypeFlags.Cooldown).toBe(0x1000000);
    expect(EnchantmentTypeFlags.Beneficial).toBe(0x2000000);
  });
});

describe('EquipMask (per ACE source)', () => {
  it('low-bit clothing slots 0x01..0x100', () => {
    expect(EquipMask.HeadWear).toBe(0x00000001);
    expect(EquipMask.ChestWear).toBe(0x00000002);
    expect(EquipMask.AbdomenWear).toBe(0x00000004);
    expect(EquipMask.FootWear).toBe(0x00000100);
  });

  it('weapon + armor slots', () => {
    expect(EquipMask.MeleeWeapon).toBe(0x00100000);
    expect(EquipMask.Shield).toBe(0x00200000);
    expect(EquipMask.MissileWeapon).toBe(0x00400000);
    expect(EquipMask.MissileAmmo).toBe(0x00800000);
    expect(EquipMask.Held).toBe(0x01000000);
    expect(EquipMask.TwoHanded).toBe(0x02000000);
  });

  it('sigil + trinket slots', () => {
    expect(EquipMask.TrinketOne).toBe(0x04000000);
    expect(EquipMask.Cloak).toBe(0x08000000);
    expect(EquipMask.SigilOne).toBe(0x10000000);
    expect(EquipMask.SigilTwo).toBe(0x20000000);
    expect(EquipMask.SigilThree).toBe(0x40000000);
  });

  it('FAITHFUL.67 composite masks (previously missing)', () => {
    // Clothing = 0x80000000 | HeadWear | ChestWear | AbdomenWear |
    //            UpperArmWear | LowerArmWear | HandWear |
    //            UpperLegWear | LowerLegWear | FootWear
    //         = 0x80000000 | (0x01|0x02|0x04|0x08|0x10|0x20|0x40|0x80|0x100)
    //         = 0x80000000 | 0x1FF = 0x800001FF
    expect(EquipMask.Clothing).toBe(0x800001FF);
    expect(EquipMask.All).toBe(0x7FFFFFFF);
    expect(EquipMask.CanGoInReadySlot).toBe(0x7FFFFFFF);
  });

  it('Clothing composite contains all clothing-slot bits', () => {
    const slotBits = EquipMask.HeadWear | EquipMask.ChestWear | EquipMask.AbdomenWear
      | EquipMask.UpperArmWear | EquipMask.LowerArmWear | EquipMask.HandWear
      | EquipMask.UpperLegWear | EquipMask.LowerLegWear | EquipMask.FootWear;
    expect((EquipMask.Clothing & slotBits)).toBe(slotBits);
    // Plus the 0x80000000 marker bit (sign-bit in JS — compare as unsigned).
    expect(((EquipMask.Clothing & 0x80000000) >>> 0)).toBe(0x80000000);
  });
});
