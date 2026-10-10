/**
 * FAITHFUL.516 — /help `/friends add` line cites max 50 (matches ACE
 *  WeenieError.MaxFriendsExceeded text).
 *
 *  ACE `WeenieError.cs:1193-1195` defines:
 *    MaxFriendsExceeded = 0x0561,
 *    text: "You may only have a maximum of 50 friends at once. If you
 *           wish to add more friends, you must first remove some."
 *  (retail-anchored in our `WeenieErrorText.ts:585`).
 *
 *  Pre-fix `/help` advertised "(max 20)" — a user who hit 20 added
 *  friends would see the server's "max 50" error message contradicting
 *  the local help text we showed them. Align with the server-truth
 *  value.
 *
 *  The invented /help list is gone (retail @help prints RetailHelpTexts);
 *  retail DoFriendsAdd's own 50-friend cap (weenie error 0x561) is driven in
 *  verify-retail-commands-allegiance-social.ts.
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText } from '@ac/shared';

describe('FAITHFUL.516 — WeenieError.MaxFriendsExceeded says 50', () => {
  it('canonical retail text mentions "maximum of 50"', () => {
    const txt = weenieErrorText(WeenieError.MaxFriendsExceeded);
    expect(txt).toMatch(/maximum of 50 friends/);
  });
});
