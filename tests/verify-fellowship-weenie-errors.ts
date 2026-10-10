/**
 * FAITHFUL.556 — Text for fellowship WeenieErrors that ACE emits but
 * lacked text mappings (continuation of FAITHFUL.540's trade-error pattern).
 *
 *  ACE Player_Fellowship.cs:101 — emits FellowshipIgnoringRequests
 *    when player tries to recruit a target that has
 *    CharacterOption.FellowshipIgnoreRequests set.
 *
 *  ACE Entity/Fellowship.cs:147 — emits FellowshipDeclined when the
 *    target replies "no" to the recruit-confirmation dialog.
 *
 *  Pre-fix: ACE WeenieError.cs <summary> tags are empty for both
 *  entries (same pattern as the trade WeenieErrors in .540) →
 *  weenieErrorText(0x0417 / 0x04DB) returned null → chat silent → user
 *  had no idea why their recruit attempt fizzled.
 *
 *  Fix: MANUAL_OVERRIDES entries in tools/generate-weenie-errors.ts.
 */
import { describe, it, expect } from 'vitest';
import { weenieErrorText, WeenieError } from '@ac/shared';

describe('FAITHFUL.556 — fellowship WeenieErrors have text', () => {
  it('FellowshipIgnoringRequests shows "That person is ignoring fellowship requests."', () => {
    expect(weenieErrorText(WeenieError.FellowshipIgnoringRequests))
      .toBe('That person is ignoring fellowship requests.');
  });

  it('FellowshipDeclined shows "That person has declined your fellowship invitation."', () => {
    expect(weenieErrorText(WeenieError.FellowshipDeclined))
      .toBe('That person has declined your fellowship invitation.');
  });
});
