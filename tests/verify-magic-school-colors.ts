/**
 * MagicSchoolColors — pure unit test for the canonical school color helper.
 *
 * Pinning the values is what stops a casual refactor from accidentally
 * changing the spellbook / tooltip / enchantment color identity. Same
 * pattern as `verify-chat-colors.ts`.
 */
import { describe, it, expect } from 'vitest';
import { MagicSchool, magicSchoolColor } from '@ac/shared';

describe('magicSchoolColor', () => {
  it('matches the original-AC school identities', () => {
    expect(magicSchoolColor(MagicSchool.WarMagic)).toBe('#e04040');             // red
    expect(magicSchoolColor(MagicSchool.LifeMagic)).toBe('#40c040');            // green
    expect(magicSchoolColor(MagicSchool.ItemEnchantment)).toBe('#e0a040');      // orange
    expect(magicSchoolColor(MagicSchool.CreatureEnchantment)).toBe('#4080e0');  // blue
    expect(magicSchoolColor(MagicSchool.VoidMagic)).toBe('#a040e0');            // purple
  });

  it('returns the neutral fallback for None / unknown values', () => {
    expect(magicSchoolColor(MagicSchool.None)).toBe('#706850');
    expect(magicSchoolColor(99)).toBe('#706850');
    expect(magicSchoolColor(-1)).toBe('#706850');
  });

  it('exposes the ACE-canonical enum values (anchored to MagicSchool.cs)', () => {
    expect(MagicSchool.None).toBe(0);
    expect(MagicSchool.WarMagic).toBe(1);
    expect(MagicSchool.LifeMagic).toBe(2);
    expect(MagicSchool.ItemEnchantment).toBe(3);
    expect(MagicSchool.CreatureEnchantment).toBe(4);
    expect(MagicSchool.VoidMagic).toBe(5);
  });
});
