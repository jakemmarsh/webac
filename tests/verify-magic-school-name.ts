/**
 * magicSchoolName helper (FAITHFUL.288).
 *
 * Pre-fix `GameUI.ts` had two inline duplications of the canonical magic
 * school display names:
 *   1. line 4888 — `['None', 'War Magic', 'Life Magic', 'Item Enchantment',
 *      'Creature Enchantment', 'Void Magic']` (ordinal-indexed array)
 *   2. lines 5410-5415 — same 5 names paired with `MagicSchool.X` enum
 *      keys (enum-keyed object array, for the foci panel)
 *
 * Same anti-pattern that FAITHFUL.286 closed for spell-bar RGBA tints —
 * the names belong to the canonical `@ac/shared/magic/MagicSchoolColors`
 * sibling helpers (`magicSchoolColor`, `magicSchoolColorRGBA`, etc).
 * Promoting to a single `magicSchoolName(school)` helper eliminates the
 * silent-mismap risk if/when ACE adds a new MagicSchool enum entry.
 */
import { describe, it, expect } from 'vitest';
import { MagicSchool, magicSchoolName } from '@ac/shared';

describe('magicSchoolName — canonical retail labels (FAITHFUL.288)', () => {
  it('returns the 5 canonical retail school names', () => {
    expect(magicSchoolName(MagicSchool.WarMagic)).toBe('War Magic');
    expect(magicSchoolName(MagicSchool.LifeMagic)).toBe('Life Magic');
    expect(magicSchoolName(MagicSchool.ItemEnchantment)).toBe('Item Enchantment');
    expect(magicSchoolName(MagicSchool.CreatureEnchantment)).toBe('Creature Enchantment');
    expect(magicSchoolName(MagicSchool.VoidMagic)).toBe('Void Magic');
  });

  it('returns "None" for the None sentinel (0)', () => {
    expect(magicSchoolName(MagicSchool.None)).toBe('None');
    expect(magicSchoolName(0)).toBe('None');
  });

  it('returns "Unknown" for any future / out-of-range value', () => {
    expect(magicSchoolName(99)).toBe('Unknown');
    expect(magicSchoolName(-1)).toBe('Unknown');
    expect(magicSchoolName(6)).toBe('Unknown');  // first slot above Void
  });
});

// DEBT.test-harness-hygiene: the former "GameUI.ts wiring" source pins
// (no magicSchoolName import, no inline schoolNames array / foci literals)
// asserted code shape, not behaviour. Their behavioural content — the
// spell-bar tooltip carries no "School:" line; the shortcut tooltip is the
// spell name alone (CORE.17.k.b.b.a.g, SpellCastSubMenu::UpdateFromPlayerModule
// @ 004c6570) — is covered by the real renderSpellBarSlot in
// tests/verify-spell-tooltip-difficulty-duration.ts; the foci panel was
// era-refuted and deleted (VISUAL.139).
