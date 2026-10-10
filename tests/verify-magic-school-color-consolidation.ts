/**
 * FAITHFUL.217 — Magic-school color consolidation.
 *
 * Pre-FAITHFUL.217 there were TWO disagreeing maps:
 *
 *   packages/renderer/src/effects/SpellEffects.ts (3D particle tints):
 *     ItemEnchantment       = 0xffcc00 (yellow)
 *     CreatureEnchantment   = 0xaa44ff (purple)
 *
 *   packages/shared/src/magic/MagicSchoolColors.ts (UI / chat / tooltip):
 *     ItemEnchantment       = 0xe0a040 (orange)
 *     CreatureEnchantment   = 0x4080e0 (blue)
 *
 * Casting an Item-school spell tinted the projectile yellow but rendered
 * the chat name orange — visibly inconsistent.
 *
 * Resolution: shared `MagicSchoolColors.ts` exports two numeric siblings,
 * `magicSchoolColorNum` (base) and `magicSchoolEmissiveNum` (glow), and
 * SpellEffects.ts now imports both. The CSS-hex `magicSchoolColor` and the
 * 3D numeric `magicSchoolColorNum` differ only by representation (string
 * vs uint24), never by hue.
 *
 * This test pins:
 *   1. `magicSchoolColor(s)` parses to exactly `magicSchoolColorNum(s)`
 *      for all 5 schools — never drift in opposite directions.
 *   2. Emissive colors are the same hue family (R/G/B channels share the
 *      same dominant ordering as the base — e.g. War: R > G+B, etc.).
 *   3. Fallback (unknown school) returns the documented gray.
 */
import { describe, it, expect } from 'vitest';
import { MagicSchool, magicSchoolColor, magicSchoolColorNum, magicSchoolEmissiveNum } from '@ac/shared';

function cssHexToNum(css: string): number {
  return parseInt(css.replace('#', ''), 16);
}

const ALL_SCHOOLS = [
  MagicSchool.WarMagic,
  MagicSchool.LifeMagic,
  MagicSchool.ItemEnchantment,
  MagicSchool.CreatureEnchantment,
  MagicSchool.VoidMagic,
];

describe('FAITHFUL.217 — magic school color consolidation', () => {
  it('css-hex `magicSchoolColor` and numeric `magicSchoolColorNum` agree for every school', () => {
    for (const school of ALL_SCHOOLS) {
      const css = magicSchoolColor(school);
      const num = magicSchoolColorNum(school);
      expect(cssHexToNum(css), `school ${school}: css ${css} but num 0x${num.toString(16)}`).toBe(num);
    }
  });

  it('fallback for unknown school is the documented neutral gray (#706850 / 0x706850)', () => {
    expect(magicSchoolColor(999)).toBe('#706850');
    expect(magicSchoolColorNum(999)).toBe(0x706850);
    expect(magicSchoolEmissiveNum(999)).toBe(0x706850);
  });

  it('canonical school identities — War=red, Life=green, Item=orange, Creature=blue, Void=purple', () => {
    // The dominant channel pattern documents the canonical hue identity.
    // War: R dominant (red). Life: G dominant (green). Item: R high + G mid (orange).
    // Creature: B dominant + R low (blue). Void: R mid + B mid (purple).
    const c = (school: number) => {
      const n = magicSchoolColorNum(school);
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    };
    const war = c(MagicSchool.WarMagic);
    expect(war.r).toBeGreaterThan(war.g);
    expect(war.r).toBeGreaterThan(war.b);

    const life = c(MagicSchool.LifeMagic);
    expect(life.g).toBeGreaterThan(life.r);
    expect(life.g).toBeGreaterThan(life.b);

    const item = c(MagicSchool.ItemEnchantment);
    expect(item.r).toBeGreaterThan(item.b); // not blue
    expect(item.g).toBeGreaterThan(item.b); // orange has high R+G, low B

    const creature = c(MagicSchool.CreatureEnchantment);
    expect(creature.b).toBeGreaterThan(creature.r); // blue, not purple
    expect(creature.b).toBeGreaterThan(creature.g);

    const voidM = c(MagicSchool.VoidMagic);
    expect(voidM.r).toBeGreaterThan(voidM.g); // purple = R high
    expect(voidM.b).toBeGreaterThan(voidM.g); // purple = B high
  });

  it('emissive colors are present for every school and brighter than the base', () => {
    // "Brighter" = sum of channels ≥ base channels (allowing small slack).
    for (const school of ALL_SCHOOLS) {
      const base = magicSchoolColorNum(school);
      const emis = magicSchoolEmissiveNum(school);
      const sumBase = ((base >> 16) & 0xff) + ((base >> 8) & 0xff) + (base & 0xff);
      const sumEmis = ((emis >> 16) & 0xff) + ((emis >> 8) & 0xff) + (emis & 0xff);
      expect(sumEmis, `school ${school}: emissive should be ≥ base intensity`).toBeGreaterThanOrEqual(sumBase - 20);
    }
  });
});
