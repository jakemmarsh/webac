/**
 * FAITHFUL.416 → BUG.duplicate-local-sounds (2026-09-28) — UseDone and
 * InventoryServerSaveFailed route their text like WeenieError, and like it
 * play NO chime: no retail code path plays UI_GeneralError
 * (audio/RetailLocalSounds).
 *
 * CORE.17.k.c retired the TradeFailure member of this family: retail's
 * ClientTradeSystem::Handle_Trade__Recv_TradeFailure only removes the item
 * from the trade list (gmSecureTradeUI::RecvNotice_TradeFailure @ 004ca680 =
 * RemoveAddedItem) — no text, so no chime to match.
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, WeenieErrorWithString, weenieErrorText, formatWeenieErrorWithString, substituteWeenieErrorItemName, Sound } from '@ac/shared';
import { deliverWeenieError, ATTEMPT_FAILED_NAME_TEMPLATED } from '../packages/renderer/src/ui/WeenieErrorNotices.js';
import { isRetailClientLocalSound } from '../packages/renderer/src/audio/RetailLocalSounds.js';
import type { NoticeSurface } from '../packages/renderer/src/ui/ClientNotices.js';

function surface() {
  const spew: string[] = [];
  const chat: string[] = [];
  const ui: NoticeSurface = { displayErrorText: (t) => { spew.push(t); }, addSystemMessage: (t) => { chat.push(t); } };
  return { ui, spew, chat };
}

describe('onUseDone error text (FAITHFUL.416 → BUG.duplicate-local-sounds)', () => {
  it('the code\'s text reaches its sink; no chime is a retail local sound', () => {
    const { ui } = surface();
    const shown = deliverWeenieError(ui, WeenieError.YouArentTrainedInLockpicking, weenieErrorText(WeenieError.YouArentTrainedInLockpicking));
    expect(shown.sink).not.toBe('none');
    expect(deliverWeenieError(ui, WeenieError.None, null).sink).toBe('none');
    expect(isRetailClientLocalSound(Sound.UI_GeneralError)).toBe(false);
  });
});

describe('onInventoryServerSaveFailed error text (FAITHFUL.416 through the 0x00A0 dispatch)', () => {
  it('a code retail runs through HandleFailureEvent takes its sink', () => {
    const { ui, spew } = surface();
    const d = deliverWeenieError(ui, WeenieError.ActionCancelled, weenieErrorText(WeenieError.ActionCancelled));
    expect(spew).toEqual(['Action cancelled!']);
    expect(d.sink).toBe('spew');
  });

  it('the seven name-templated codes are ServerSaysAttemptFailed\'s own 0x1a line with the item name', () => {
    const inventory = { getAll: () => [{ id: 0x80001234, name: 'Fispur Ansel' }] };
    for (const code of ATTEMPT_FAILED_NAME_TEMPLATED) {
      if (code === 0x43e) continue; // ACE's summary is a full sentence; retail's own template carries the name
      const template = weenieErrorText(code) ?? formatWeenieErrorWithString(code, '_');
      const text = substituteWeenieErrorItemName(template, 0x80001234, inventory);
      expect(text, `0x${code.toString(16)}`).toContain('Fispur Ansel');
      expect(text).not.toContain('_');
    }
    expect(ATTEMPT_FAILED_NAME_TEMPLATED.has(WeenieErrorWithString._DoesntKnowWhatToDoWithThat)).toBe(true);
    expect(ATTEMPT_FAILED_NAME_TEMPLATED.has(WeenieError.AttunedItem)).toBe(false);
  });

  it('AttunedItem (Player_Inventory.cs:1391) has no retail arm — the "_ can\'t be dropped" summary never printed', () => {
    const { ui, spew, chat } = surface();
    const text = substituteWeenieErrorItemName(weenieErrorText(WeenieError.AttunedItem), 1, { getAll: () => [{ id: 1, name: 'Sword' }] });
    expect(text).toBe("Sword can't be dropped");
    const d = deliverWeenieError(ui, WeenieError.AttunedItem, text);
    expect(d.sink).toBe('none');
    expect(spew).toEqual([]);
    expect(chat).toEqual([]);
  });
});
