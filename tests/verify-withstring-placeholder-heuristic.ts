/**
 * FAITHFUL.555 — Generator placeholder-restoration heuristic now also
 * catches the single-space-before-punctuation pattern.
 *
 *  ACE strips `_` from <summary> text but leaves surrounding whitespace.
 *  Common patterns the original heuristic missed:
 *    "is now: ."         (was "is now: _.")
 *    "snooping on ."     (was "snooping on _.")
 *    "banned from 's"    (was "banned from _'s")
 *    "by ."              (was "by _.")
 *
 *  All 16+ affected templates use single-space-then-punctuation which
 *  the 2+-space rule didn't catch. New rule: `(?<=\S) ([.!?,'"])` →
 *  ` _$1` — keeps the space before the placeholder so the substitution
 *  produces "by Name." not "byName.".
 */
import { describe, it, expect } from 'vitest';
import { formatWeenieErrorWithString, WeenieErrorWithString } from '@ac/shared';

describe('FAITHFUL.555 — single-space-before-punctuation placeholder restored', () => {
  it('YourAllegianceIsNow_ formats with name + period correctly', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YourAllegianceIsNow_, 'Bael\'Zharon');
    expect(out).toBe("Your allegiance is now: Bael'Zharon.");
  });

  it('YouAreInvalidTargetForSpellOf_ formats with name + period', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YouAreInvalidTargetForSpellOf_, 'Olthoi Spitter');
    expect(out).toBe('You are an invalid target for the spell of Olthoi Spitter.');
  });

  it('YouAreNowSnoopingOn_ formats with name + period', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YouAreNowSnoopingOn_, 'TestPartner');
    expect(out).toBe('You are now snooping on TestPartner.');
  });

  it('YouAreBannedFromAllegiance handles apostrophe-s possessive', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YouAreBannedFromAllegiance, 'Mockingbird');
    expect(out).toBe("You are banned from Mockingbird's allegiance!");
  });

  it('templates with 2+ spaces (existing behavior) still work', () => {
    // YouFailToAffect_TheyAreNotPK = 0x0052 has two `_` placeholders
    // (from the 2+-space rule). Both get filled with the same value.
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YouFailToAffect_TheyAreNotPK, 'Bob');
    expect(out).toBe('You fail to affect Bob because Bob is not a player killer!');
  });

  it('space is preserved before the substituted name (not "byName" but "by Name")', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YouRestoreAllegianceChatPrivilegesTo_, 'Friend');
    expect(out).toBe('You have restored allegiance chat privileges to Friend.');
    expect(out).not.toMatch(/toFriend/); // no missing space bug
  });
});
