/**
 * magicSchoolColorRGBA helper (FAITHFUL.286).
 *
 * Pre-fix `GameUI.ts` had an inline `Record<number, string>` map for the
 * spell-bar slot tint with 5 entries:
 *   War: 'rgba(204,68,68,0.6)'      // canonical War is #e04040 = (224,64,64)
 *   Life: 'rgba(68,204,68,0.6)'      // canonical Life is #40c040 = (64,192,64)
 *   ItemEnchant: 'rgba(204,204,68,0.6)' // canonical Item is #e0a040 = (224,160,64) — DIFFERENT HUE
 *   CreatureEnchant: 'rgba(204,136,255,0.6)' // canonical Creature is #4080e0 = (64,128,224) — VERY DIFFERENT (blue vs purple)
 *   Void: 'rgba(136,68,204,0.6)'     // canonical Void is #a040e0 = (160,64,224)
 *
 * Item Enchantment was yellow-green-ish (204,204,68) vs the canonical
 * orange (224,160,64). Creature Enchantment was purple (204,136,255) vs
 * the canonical blue (64,128,224). Two of five schools were rendering
 * different colors in the spell bar than in chat/tooltips/projectiles.
 *
 * Promotes the conversion to `magicSchoolColorRGBA(school, alpha)` in
 * `@ac/shared/magic/MagicSchoolColors.ts` so all sites pick the same
 * canonical RGB triples — same pattern as the existing
 * `magicSchoolColorNum` / `magicSchoolEmissiveNum` siblings.
  *
 * DEBT.test-harness-hygiene: the GameUI wiring pins are behavioural — the real
 * spell-bar slot and spellbook-row renderers tint icon-less spells.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MagicSchool, magicSchoolColor, magicSchoolColorRGBA } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';


describe('magicSchoolColorRGBA — RGB triples match canonical hex (FAITHFUL.286)', () => {
  it('War: rgba(224,64,64,a) — matches #e04040', () => {
    expect(magicSchoolColorRGBA(MagicSchool.WarMagic, 0.6)).toBe('rgba(224,64,64,0.6)');
    expect(magicSchoolColor(MagicSchool.WarMagic)).toBe('#e04040');
  });

  it('Life: rgba(64,192,64,a) — matches #40c040', () => {
    expect(magicSchoolColorRGBA(MagicSchool.LifeMagic, 0.6)).toBe('rgba(64,192,64,0.6)');
    expect(magicSchoolColor(MagicSchool.LifeMagic)).toBe('#40c040');
  });

  it('Item Enchantment: rgba(224,160,64,a) — matches #e0a040 (orange, not yellow-green)', () => {
    expect(magicSchoolColorRGBA(MagicSchool.ItemEnchantment, 0.6)).toBe('rgba(224,160,64,0.6)');
    expect(magicSchoolColor(MagicSchool.ItemEnchantment)).toBe('#e0a040');
  });

  it('Creature Enchantment: rgba(64,128,224,a) — matches #4080e0 (BLUE, not purple as pre-fix had)', () => {
    expect(magicSchoolColorRGBA(MagicSchool.CreatureEnchantment, 0.6)).toBe('rgba(64,128,224,0.6)');
    expect(magicSchoolColor(MagicSchool.CreatureEnchantment)).toBe('#4080e0');
  });

  it('Void: rgba(160,64,224,a) — matches #a040e0', () => {
    expect(magicSchoolColorRGBA(MagicSchool.VoidMagic, 0.6)).toBe('rgba(160,64,224,0.6)');
    expect(magicSchoolColor(MagicSchool.VoidMagic)).toBe('#a040e0');
  });

  it('honors caller-supplied alpha', () => {
    expect(magicSchoolColorRGBA(MagicSchool.WarMagic, 0.3)).toBe('rgba(224,64,64,0.3)');
    expect(magicSchoolColorRGBA(MagicSchool.WarMagic, 1.0)).toBe('rgba(224,64,64,1)');
    expect(magicSchoolColorRGBA(MagicSchool.WarMagic, 0)).toBe('rgba(224,64,64,0)');
  });

  it('falls back to the SCHOOL_FALLBACK_NUM RGB for unknown schools', () => {
    // SCHOOL_FALLBACK_NUM = 0x706850 = (112,104,80)
    expect(magicSchoolColorRGBA(0, 0.5)).toBe('rgba(112,104,80,0.5)');
    expect(magicSchoolColorRGBA(99, 0.5)).toBe('rgba(112,104,80,0.5)');
  });
});

describe('GameUI wiring (FAITHFUL.286, behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H.teardown());

  // An icon-less spell per school; the slot/cell background is the only
  // place the school colour shows.
  const SCHOOLS = [
    MagicSchool.WarMagic, MagicSchool.LifeMagic, MagicSchool.ItemEnchantment,
    MagicSchool.CreatureEnchantment, MagicSchool.VoidMagic,
  ];
  // happy-dom normalises rgba() whitespace; compare on the digits.
  const norm = (css: string) => css.replace(/\s+/g, '');

  it.each(SCHOOLS)('spell-bar slot of an icon-less school-%s spell is tinted magicSchoolColorRGBA(school, 0.6)', (school) => {
    const tab = H.ui.activeSpellBarTab;
    H.ui.spellBarSlots[tab] = [{ id: 1, name: 'Test', school, iconId: 0 }];
    const slot = H.win.document.createElement('div') as HTMLElement;
    H.ui.renderSpellBarSlot(slot, 0);
    const expected = magicSchoolColorRGBA(school, 0.6);
    expect(norm(slot.style.background)).toContain(norm(expected));
  });

  it('the pre-fix inline shades (wrong War red, yellow-green Item, purple Creature) are never produced', () => {
    const tab = H.ui.activeSpellBarTab;
    for (const school of SCHOOLS) {
      H.ui.spellBarSlots[tab] = [{ id: 1, name: 'Test', school, iconId: 0 }];
      const slot = H.win.document.createElement('div') as HTMLElement;
      H.ui.renderSpellBarSlot(slot, 0);
      const bg = norm(slot.style.background);
      for (const old of ['rgba(204,68,68,0.6)', 'rgba(204,204,68,0.6)', 'rgba(204,136,255,0.6)']) expect(bg).not.toContain(old);
    }
  });
});
