/**
 * FAITHFUL.425 → BUG.duplicate-local-sounds (2026-09-28) — a
 * WeenieErrorWithString prints through its sink and plays nothing.
 *
 * Retail: Handle_Communication__WeenieErrorWithString @ 0057cb90 widens the
 * value and runs the code through HandleFailureEvent @ 00571990 — the
 * template's arm decides the sink (most are type-0 chat lines, the PK
 * "fails to affect you" family is type 7, "_ is already at full health!" is
 * 0x1a spew). Nothing in that path plays a sound (audio/RetailLocalSounds).
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, WeenieErrorWithString, formatWeenieErrorWithString, Sound } from '@ac/shared';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices.js';
import { isRetailClientLocalSound } from '../packages/renderer/src/audio/RetailLocalSounds.js';
import type { NoticeSurface } from '../packages/renderer/src/ui/ClientNotices.js';

function surface() {
  const spew: string[] = [];
  const chat: Array<{ text: string; type?: number }> = [];
  const ui: NoticeSurface = { displayErrorText: (t) => { spew.push(t); }, addSystemMessage: (t, _c, ty) => { chat.push({ text: t, type: ty }); } };
  return { ui, spew, chat };
}

describe('onWeenieErrorWithString sink, no chime (FAITHFUL.425 → BUG.duplicate-local-sounds)', () => {
  it('"Bob is too busy to accept gifts right now." is a type-0 chat line', () => {
    const { ui, chat } = surface();
    const text = formatWeenieErrorWithString(WeenieErrorWithString._IsTooBusyToAcceptGifts, 'Bob');
    const d = deliverWeenieError(ui, WeenieErrorWithString._IsTooBusyToAcceptGifts, text);
    expect(chat).toEqual([{ text: 'Bob is too busy to accept gifts right now.', type: 0 }]);
    expect(d.sink).toBe('chat');
    expect(isRetailClientLocalSound(Sound.UI_GeneralError)).toBe(false);
  });

  it('"Bob is already at full health!" is a spew row', () => {
    const { ui, spew, chat } = surface();
    deliverWeenieError(ui, WeenieErrorWithString._IsAtFullHealth, formatWeenieErrorWithString(WeenieErrorWithString._IsAtFullHealth, 'Bob'));
    expect(spew).toEqual(['Bob is already at full health!']);
    expect(chat).toEqual([]);
  });

  it('the PK "fails to affect you" line is a type-7 chat line', () => {
    const { ui, chat } = surface();
    deliverWeenieError(ui, WeenieErrorWithString._FailsToAffectYou_YouAreNotPK, formatWeenieErrorWithString(WeenieErrorWithString._FailsToAffectYou_YouAreNotPK, 'Bob'));
    expect(chat).toEqual([{ text: 'Bob fails to affect you because you are not a player killer!', type: 7 }]);
  });

  it('None prints nothing', () => {
    const { ui, spew, chat } = surface();
    expect(deliverWeenieError(ui, WeenieError.None, 'x').sink).toBe('none');
    expect(spew).toEqual([]);
    expect(chat).toEqual([]);
  });
});
