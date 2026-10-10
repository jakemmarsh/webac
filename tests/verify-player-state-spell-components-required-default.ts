/**
 * SWEEP1006B.magic-casting.missing-components-pre-check-default
 * (supersedes BUG.spell-components-required-default-inverted).
 *
 * Retail ClientMagicSystem::AreSpellComponentsRequired @ 00567b90 reads
 * PlayerDesc bool 0x44 through CBaseQualities::InqBool @ 0058fe70, which
 * leaves its `false` default when the key is absent, so a missing bool 68
 * skips CastSpell's local component check. ACE stores the bool inverted
 * (Player_Properties.cs:286-290: `?? true`, never stores true), so on ACE
 * the login PlayerDescription never carries 68=true: the retail client
 * sends the cast and shows ACE's WeenieError 0x0400 text on a miss.
 *
 * Retail replaces PlayerDesc on every login, so a value from an earlier
 * login (e.g. `@requirecomps on` broadcast 68=true for character A) must
 * not survive into a login whose PlayerDescription lacks the bool.
 */
import { describe, it, expect } from 'vitest';
import { PropertyBool, spellComponentsSatisfied } from '@ac/shared';
import { PlayerState } from '../packages/renderer/src/player/PlayerState';

const FORMULA = [1, 2, 3, 4, 5]; // component ids
const COMP_TO_WCID = new Map([[1, 691], [2, 692], [3, 693], [4, 694], [5, 695]]);
const ownsNothing = (): boolean => false;

describe('SWEEP1006B — SpellComponentsRequired follows retail InqBool (absent = false)', () => {
  it('defaults to false before any PlayerDescription', () => {
    expect(new PlayerState().spellComponentsRequired).toBe(false);
  });

  it('a PlayerDescription without bool 68 leaves the local pre-check off: the cast goes out even with no components', () => {
    const p = new PlayerState();
    p.seedSpellComponentsRequired(new Map<number, boolean>().get(PropertyBool.SpellComponentsRequired));
    expect(p.spellComponentsRequired).toBe(false);
    expect(spellComponentsSatisfied(p.spellComponentsRequired, FORMULA, COMP_TO_WCID, ownsNothing)).toBe(true);
  });

  it('an explicit 68=true turns the local pre-check on (retail refuses with its own text)', () => {
    const p = new PlayerState();
    p.seedSpellComponentsRequired(true);
    expect(p.spellComponentsRequired).toBe(true);
    expect(spellComponentsSatisfied(p.spellComponentsRequired, FORMULA, COMP_TO_WCID, ownsNothing)).toBe(false);
  });

  it('68=true from one login does not leak into a relogin whose PlayerDescription lacks it', () => {
    const p = new PlayerState();
    p.seedSpellComponentsRequired(true);
    p.applyServerBool(PropertyBool.SpellComponentsRequired, true); // @requirecomps on, mid-session
    expect(p.spellComponentsRequired).toBe(true);
    p.seedSpellComponentsRequired(undefined); // next character's PlayerDescription
    expect(p.spellComponentsRequired).toBe(false);
  });

  it('live PropertyBool updates still flip it both ways', () => {
    const p = new PlayerState();
    p.applyServerBool(PropertyBool.SpellComponentsRequired, true);
    expect(p.spellComponentsRequired).toBe(true);
    p.applyServerBool(PropertyBool.SpellComponentsRequired, false);
    expect(p.spellComponentsRequired).toBe(false);
  });
});
