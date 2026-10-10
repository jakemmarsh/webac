/**
 * FAITHFUL.553 — Extended .552's `_`-pass-through override to three
 * other WithString entries that ACE annotated with dev comments
 * instead of user-facing templates.
 *
 *  AugmentationSkillNotTrained (0x055A) — actively emitted from ACE
 *    AugmentationDevice.cs:181 + :191 with fully-constructed strings
 *    like "You are not able to purchase this augmentation because
 *    your {Attribute} is already at the maximum innate level!" passed
 *    as the value arg.
 *
 *  AttributeTransferFromTooLow (0x04DE) + AttributeTransferToTooHigh
 *  (0x04DF) — no active emit sites in ACE source as of 2026-05, but
 *  the same dev-comment template was wrong. Override is defensive.
 *
 *  All three: ACE <summary> is the same dev-comment "Sends
 *  {message}\n to the chat window. Unknown usage." pattern.
 */
import { describe, it, expect } from 'vitest';
import { formatWeenieErrorWithString, WeenieErrorWithString } from '@ac/shared';

describe('FAITHFUL.553 — additional dev-comment WithString overrides', () => {
  it('AugmentationSkillNotTrained passes the AugmentationDevice.cs:181 value through verbatim', () => {
    const value = 'You are not able to purchase this augmentation because your Strength is already at the maximum innate level!';
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AugmentationSkillNotTrained, value);
    expect(out).toBe(value);
  });

  it('AugmentationSkillNotTrained passes the AugmentationDevice.cs:191 value through verbatim', () => {
    const value = 'You are not able to purchase this augmentation because you are not trained in Light Weapons!';
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AugmentationSkillNotTrained, value);
    expect(out).toBe(value);
  });

  it('AttributeTransferFromTooLow override returns value verbatim (defensive)', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AttributeTransferFromTooLow, 'arbitrary value');
    expect(out).toBe('arbitrary value');
  });

  it('AttributeTransferToTooHigh override returns value verbatim (defensive)', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AttributeTransferToTooHigh, 'arbitrary value');
    expect(out).toBe('arbitrary value');
  });

  it('none of these emit the dev-comment "Sends ... Unknown usage" text', () => {
    for (const code of [
      WeenieErrorWithString.AugmentationSkillNotTrained,
      WeenieErrorWithString.AttributeTransferFromTooLow,
      WeenieErrorWithString.AttributeTransferToTooHigh,
    ]) {
      const out = formatWeenieErrorWithString(code, 'hello');
      expect(out).not.toMatch(/Unknown usage/);
      expect(out).not.toMatch(/\{message\}/);
    }
  });
});
