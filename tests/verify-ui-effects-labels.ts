/**
 * FAITHFUL.79 — uiEffectsLabels() exercises the UiEffects bitmask decoder
 * (Magical/Poisoned/Fire/Frost/etc.) used by inventory tooltips.
 *
 * Verifies:
 *   - empty mask → empty array
 *   - single bits → matching labels
 *   - multi-bit composites → ordered list in ACE bit-order
 *   - reserved Undef bit → ignored
 */
import { describe, it, expect } from 'vitest';
import { UiEffects, uiEffectsLabels } from '../packages/shared/src/ace-enums.js';

describe('uiEffectsLabels — UiEffects bitmask decoder', () => {
  it('empty mask returns empty array', () => {
    expect(uiEffectsLabels(0)).toEqual([]);
    expect(uiEffectsLabels(UiEffects.Undef)).toEqual([]);
  });

  it('single Magical bit → "Magical" label', () => {
    expect(uiEffectsLabels(UiEffects.Magical)).toEqual(['Magical']);
  });

  it('single Poisoned bit → "Poisoned" label', () => {
    expect(uiEffectsLabels(UiEffects.Poisoned)).toEqual(['Poisoned']);
  });

  it('elemental flags surface their AC-display name', () => {
    expect(uiEffectsLabels(UiEffects.Fire)).toEqual(['Fire']);
    expect(uiEffectsLabels(UiEffects.Frost)).toEqual(['Frost']);
    expect(uiEffectsLabels(UiEffects.Lightning)).toEqual(['Lightning']);
    expect(uiEffectsLabels(UiEffects.Acid)).toEqual(['Acid']);
    expect(uiEffectsLabels(UiEffects.Nether)).toEqual(['Nether']);
  });

  it('vital-boost flags surface their multi-word name', () => {
    expect(uiEffectsLabels(UiEffects.BoostHealth)).toEqual(['Boost Health']);
    expect(uiEffectsLabels(UiEffects.BoostMana)).toEqual(['Boost Mana']);
    expect(uiEffectsLabels(UiEffects.BoostStamina)).toEqual(['Boost Stamina']);
  });

  it('multi-bit composite returns labels in ACE bit-order', () => {
    const magicalFire = UiEffects.Magical | UiEffects.Fire;
    expect(uiEffectsLabels(magicalFire)).toEqual(['Magical', 'Fire']);

    const everyElement = UiEffects.Fire | UiEffects.Lightning | UiEffects.Frost | UiEffects.Acid | UiEffects.Nether;
    expect(uiEffectsLabels(everyElement)).toEqual(['Fire', 'Lightning', 'Frost', 'Acid', 'Nether']);
  });

  it('full mask (all 13 flag bits) surfaces every label', () => {
    const full = 0x1FFF; // every meaningful bit in UiEffects
    expect(uiEffectsLabels(full)).toEqual([
      'Magical', 'Poisoned',
      'Boost Health', 'Boost Mana', 'Boost Stamina',
      'Fire', 'Lightning', 'Frost', 'Acid',
      'Bludgeoning', 'Slashing', 'Piercing', 'Nether',
    ]);
  });
});
