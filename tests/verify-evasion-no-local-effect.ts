/**
 * An evade plays no local effect (BUG.invented-portal-burst-and-spell-effects):
 * ACE sends no script for it and the retail client adds none.
 *
 * (This file used to also pin FAITHFUL.337's defender floating "-N" spawn
 * position; BUG.floating-damage-numbers-invented removed floating combat
 * text entirely — see tests/verify-no-floating-combat-text.ts.)
 */
import { describe, it, expect } from 'vitest';

describe('Evasion plays no local effect (BUG.invented-portal-burst-and-spell-effects)', () => {
  it('the SpellEffects sparkle API is gone', async () => {
    const { SpellEffects } = await import('../packages/renderer/src/effects/SpellEffects.js');
    expect((SpellEffects.prototype as unknown as Record<string, unknown>).createResistSparkle).toBeUndefined();
  });
});
