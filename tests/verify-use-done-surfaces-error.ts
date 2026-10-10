/**
 * FAITHFUL.386 — a UseDone WeenieError is surfaced to the player (converted
 * from a main.ts source pin to a behavioural test, CORE.17.k.c).
 *
 * Retail: ClientUISystem::Handle_Item__UseDone runs a NON-ZERO code through
 * ClientCommunicationSystem::HandleFailureEvent @ 00571990 — the same
 * per-code sink switch as a 0x028A WeenieError. None (success) prints
 * nothing; ActionCancelled (0x36) IS an arm ("Action cancelled!" on the spew
 * box — ACE ManaStone.cs:98 sends UseDone(ActionCancelled)).
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText } from '@ac/shared';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices.js';
import type { NoticeSurface } from '../packages/renderer/src/ui/ClientNotices.js';

function surface() {
  const spew: string[] = [];
  const chat: string[] = [];
  const ui: NoticeSurface = { displayErrorText: (t) => { spew.push(t); }, addSystemMessage: (t) => { chat.push(t); } };
  return { ui, spew, chat };
}

describe('onUseDone surfaces the WeenieError (FAITHFUL.386 through CORE.17.k.c)', () => {
  it('None (success) is silent', () => {
    const { ui, spew, chat } = surface();
    expect(deliverWeenieError(ui, WeenieError.None, weenieErrorText(WeenieError.None)).sink).toBe('none');
    expect(spew).toEqual([]);
    expect(chat).toEqual([]);
  });

  it('the lockpicking refusals (Lock.cs:129,147,172) are spew-box rows (:360331 / :360325)', () => {
    const { ui, spew, chat } = surface();
    deliverWeenieError(ui, WeenieError.YouArentTrainedInLockpicking, weenieErrorText(WeenieError.YouArentTrainedInLockpicking));
    deliverWeenieError(ui, WeenieError.YouCannotLockOrUnlockThat, weenieErrorText(WeenieError.YouCannotLockOrUnlockThat));
    expect(spew).toEqual(["You aren't trained in lockpicking!", "You can't lock or unlock that!"]);
    expect(chat).toEqual([]);
  });

  it('ActionCancelled (ManaStone.cs:98) is the retail "Action cancelled!" spew row', () => {
    const { ui, spew, chat } = surface();
    expect(deliverWeenieError(ui, WeenieError.ActionCancelled, weenieErrorText(WeenieError.ActionCancelled)).sink).toBe('spew');
    expect(spew).toEqual(['Action cancelled!']);
    expect(chat).toEqual([]);
  });

  it('a mana-stone refusal the retail switch has no arm for prints nothing', () => {
    const { ui, spew, chat } = surface();
    // YouDoNotOwnThatItem is 0x4be "You do not own that item!\n" → chat; a
    // code with no arm (e.g. SkillTooLow) is silent.
    deliverWeenieError(ui, WeenieError.YouDoNotOwnThatItem, weenieErrorText(WeenieError.YouDoNotOwnThatItem));
    deliverWeenieError(ui, WeenieError.SkillTooLow, weenieErrorText(WeenieError.SkillTooLow));
    expect(chat).toEqual(['You do not own that item!']);
    expect(spew).toEqual([]);
  });
});
