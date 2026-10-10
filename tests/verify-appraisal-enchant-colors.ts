/**
 * SWEEP.5 — item appraisal enchantment-highlight coloring.
 *
 * The Identify response carries paired highlight/color u16 bitfields for armor
 * (flag 0x0200), weapon (0x0800) and resist (0x0400) enchantments. They were
 * parsed but never used — buffed/debuffed weapon and armor stats rendered with
 * no tint (only the CreatureProfile attribute rows were colored). This drives
 * the shipped pure bit logic + the ACE ArmorMask/WeaponMask bit constants the
 * appraisal panel now applies.
 *
 * Convention (ACE Network/Enum/{ArmorMask,WeaponMask}.cs): highlight bit set =
 * stat modified; color bit set = buff (green) else debuff (red).
 */
import { describe, it, expect } from 'vitest';
import {
  enchantmentValueState, ARMOR_MASK, WEAPON_MASK, RESIST_MASK,
} from '@ac/renderer/ui/appraisalColors.js';

describe('enchantmentValueState (buff/debuff/none)', () => {
  it('returns null when the stat is not highlighted (no enchantment)', () => {
    expect(enchantmentValueState(0, 0, ARMOR_MASK.Fire)).toBeNull();
    // color bit set but highlight clear → still not modified
    expect(enchantmentValueState(0, ARMOR_MASK.Fire, ARMOR_MASK.Fire)).toBeNull();
  });
  it('returns "buff" when highlighted AND color bit set', () => {
    expect(enchantmentValueState(ARMOR_MASK.Fire, ARMOR_MASK.Fire, ARMOR_MASK.Fire)).toBe('buff');
  });
  it('returns "debuff" when highlighted but color bit clear', () => {
    expect(enchantmentValueState(ARMOR_MASK.Cold, 0, ARMOR_MASK.Cold)).toBe('debuff');
  });
  it('isolates each stat by its own bit (a Fire buff does not tint Cold)', () => {
    const hl = ARMOR_MASK.Fire, col = ARMOR_MASK.Fire;
    expect(enchantmentValueState(hl, col, ARMOR_MASK.Fire)).toBe('buff');
    expect(enchantmentValueState(hl, col, ARMOR_MASK.Cold)).toBeNull();
  });
});

describe('mask bit constants match ACE', () => {
  it('ArmorMask: Slash=0x2,Pierce=0x4,Bludgeon=0x8,Cold=0x10,Fire=0x20,Acid=0x40,Lightning=0x80', () => {
    expect(ARMOR_MASK).toEqual({
      Slashing: 0x2, Piercing: 0x4, Bludgeoning: 0x8, Cold: 0x10,
      Fire: 0x20, Acid: 0x40, Lightning: 0x80,
    });
    // Nether intentionally absent — it has no ArmorMask bit, so it is never tinted.
    expect((ARMOR_MASK as Record<string, number>)['Nether']).toBeUndefined();
  });
  it('WeaponMask: AttackSkill=0x1,Speed=0x4,Damage=0x8,DamageVariance=0x10,DamageMod=0x20', () => {
    expect(WEAPON_MASK.AttackSkill).toBe(0x1);
    expect(WEAPON_MASK.Speed).toBe(0x4);
    expect(WEAPON_MASK.Damage).toBe(0x8);
    expect(WEAPON_MASK.DamageVariance).toBe(0x10);
    expect(WEAPON_MASK.DamageMod).toBe(0x20);
  });
  // BUG.appraisal-resist-enchantment-color-dropped — ACE ResistMask.cs bits
  // for the two caster-implement bonus rows (FAITHFUL.305).
  it('ResistMask: ManaConversionMod=0x1000, ElementalDamageMod=0x2000', () => {
    expect(RESIST_MASK).toEqual({ ManaConversionMod: 0x1000, ElementalDamageMod: 0x2000 });
  });
});
