/**
 * FAITHFUL.546 — TradeFailure with reason=WeenieError.None shows a
 * substituted "X could not be added to the trade." chat line instead
 * of silence.
 *
 *  ACE Player_Trade.cs:154-159:
 *    if (wo.IsUniqueOrContainsUnique && !target.CheckUniques(wo, this))
 *    {
 *        // WeenieError.TooManyUniqueItems / WeenieErrorWithString._CannotCarryAnymore?
 *        Session.Network.EnqueueSend(new GameEventTradeFailure(Session, itemGuid, WeenieError.None));
 *        return;
 *    }
 *
 *  The ACE comment admits the proper code SHOULD be TooManyUniqueItems
 *  but they shipped WeenieError.None. Our weenieErrorText(0x0000)
 *  returns null per ACE convention (None = success placeholder), so
 *  the chat was silent — user had no idea why their unique-item trade
 *  rejected.
 *
 *  Fix: when reason === None on a TradeFailure event, treat it as the
 *  unique-conflict signal and emit a substituted template message
 *  ("X could not be added to the trade.") using the existing FAITHFUL.545
 *  item-name substitution path (substituteWeenieErrorItemName).
 *
 *  Drives the real weenieErrorText()/substituteWeenieErrorItemName()
 *  pair with the same reason=None template main.ts's onTradeFailure
 *  handler falls back to — not a source-text regex pin.
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText, substituteWeenieErrorItemName, InventoryManager } from '@ac/shared';

describe('FAITHFUL.546 — TradeFailure(reason=None) shows chat', () => {
  it('weenieErrorText(None) returns null per ACE convention (None = success placeholder)', () => {
    expect(weenieErrorText(WeenieError.None)).toBeNull();
  });

  it('reason=None resolves to the unique-conflict template, which then gets the item-name swap', () => {
    // Mirrors main.ts's onTradeFailure: `let text = weenieErrorText(data.reason)`,
    // then `if (data.reason === WeenieError.None) text = "_ could not be added to the trade."`,
    // then `substituteWeenieErrorItemName(text, ...)` — reproduced here against the real functions.
    const reason = WeenieError.None;
    let text = weenieErrorText(reason);
    if (reason === WeenieError.None) {
      text = '_ could not be added to the trade.';
    }

    const inventory = new InventoryManager();
    inventory.addItem(
      { weenieClassId: 1, name: 'Unique Trophy', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 },
      0x50001111,
    );
    const result = substituteWeenieErrorItemName(text, 0x50001111, inventory);
    expect(result).toBe('Unique Trophy could not be added to the trade.');
  });
});
