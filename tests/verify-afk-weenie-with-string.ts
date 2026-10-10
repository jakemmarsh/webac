/**
 * FAITHFUL.552 — WeenieErrorWithString.AFK template uses `_` so the
 * server-provided "{Name} is away: {AfkMessage}" value passes through
 * verbatim.
 *
 *  ACE Player_Tell.cs:48 constructs the FULL user-facing message at
 *  the call site and ships it as the WithString value arg:
 *    new GameEventWeenieErrorWithString(
 *      session,
 *      WeenieErrorWithString.AFK,
 *      $"{targetPlayer.Name} is away: {AfkMessage}")
 *
 *  ACE WeenieErrorWithString.cs:497-499 has the `<summary>` text for
 *  AFK = 0x055E as a developer comment:
 *    /// Sends "{message}\n" to the chat window. Unknown usage
 *  — NOT the user-facing template. Our generator picked this up as
 *  the template, and the formatter `template.split('_').join(value)`
 *  returned the template unchanged (no `_` in it) → user saw the dev
 *  comment in chat instead of the AFK message.
 *
 *  Fix: manual override in the generator maps 0x055E → `_` so the
 *  value (which is already the complete sentence) flows through.
 */
import { describe, it, expect } from 'vitest';
import { formatWeenieErrorWithString, WeenieErrorWithString } from '@ac/shared';

describe('FAITHFUL.552 — AFK WithString passes value through verbatim', () => {
  it('AFK template renders the server-provided "Name is away: Msg" string verbatim', () => {
    const value = 'TestPartner is away: I am away from my keyboard.';
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AFK, value);
    expect(out).toBe(value);
  });

  it('does NOT contain the dev-comment placeholder text "{message}" or "Unknown usage"', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AFK, 'Bob is away: brb');
    expect(out).not.toMatch(/\{message\}/);
    expect(out).not.toMatch(/Unknown usage/);
  });

  it('still substitutes for multi-character values (preserve general formatter behavior)', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.AFK, 'X is away: Y');
    expect(out).toBe('X is away: Y');
  });
});
