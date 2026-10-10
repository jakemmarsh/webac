/**
 * FAITHFUL.550 / .551 → CORE.17.k.c.a — a vendor buy / sell the server
 * rejects prints NOTHING, as retail did.
 *
 *  ACE Player_Commerce.cs:48-49 (buy validation) and :155-160 (an empty sell
 *  list) ship:
 *    new GameEventInventoryServerSaveFailed(Session, Guid.Full)
 *  — the PLAYER's guid, errorType None (the default), no WeenieError, no
 *  TransientString. GameEventInventoryServerSaveFailed.cs:13's remark that the
 *  "client doesn't show this error mostly, and defaults to specific error
 *  messages, depending on the item name + action" is
 *  ACCWeenieObject::ServerSaysAttemptFailed @ 0058eae0: the retail client
 *  composes ONE 0x1a line from its pending inventory request (the verb + the
 *  object's name) and the code's suffix. A vendor transaction records
 *  IR_SHOP_EVENT on the VENDOR (CORE.17.k.c.a.a.b: gmVendorUI's four Buy / Sell
 *  send sites — the approach itself records nothing), a request kind with no
 *  verb, and code None has no suffix, so the line is empty — and
 *  HandleFailureEvent @ 00571990 has no arm for 0. The 0x00A0 resolves the
 *  pending vendor and clears the record (verify-core17kcaab-vendor-shop-event.ts).
 *  FAITHFUL.550/.551's "The vendor cannot complete that transaction…" chat
 *  heuristic had no retail counterpart; it is gone.
 *
 *  Converted from a main.ts source-grep pin to a behavioural test over the
 *  real modules (CLAUDE.md: tests must execute the shipped code).
 */
import { describe, it, expect } from 'vitest';
import { InventoryRequestTracker, InventoryRequest, WeenieError, weenieErrorText } from '@ac/shared';
import { handleAttemptFailed } from '../packages/renderer/src/inventory/InventoryRequests.js';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices.js';

const PLAYER = 0x50000001;
const player = (g: number) => (g === PLAYER ? { name: 'Sink Tester', stackSize: 0 } : undefined);

function surface() {
  const spew: string[] = [];
  const chat: Array<{ text: string; color?: string; type?: number }> = [];
  return {
    spew, chat,
    ui: {
      displayErrorText: (text: string) => { spew.push(text); },
      addSystemMessage: (text: string, color?: string, type?: number) => { chat.push({ text, color, type }); },
    },
  };
}

describe('CORE.17.k.c.a — a vendor buy / sell reject (the player\'s guid, code None) prints nothing', () => {
  it('nothing pending + code None: the attempt line is empty, no arm, no chime', () => {
    const { ui, spew, chat } = surface();
    const t = new InventoryRequestTracker();
    const attempt = handleAttemptFailed(t, PLAYER, WeenieError.None, player, ui.displayErrorText);
    expect(attempt).toEqual({ objectId: PLAYER, request: InventoryRequest.None, text: null, cleared: false });
    const delivery = deliverWeenieError(ui, WeenieError.None, weenieErrorText(WeenieError.None));
    expect(delivery.sink).toBe('none');
    expect(spew).toEqual([]);
    expect(chat).toEqual([]);
  });

  it('the old vendor text is not produced by any shipped path', () => {
    const { ui, spew, chat } = surface();
    const t = new InventoryRequestTracker();
    handleAttemptFailed(t, PLAYER, WeenieError.None, player, ui.displayErrorText);
    deliverWeenieError(ui, WeenieError.None, null);
    const all = [...spew, ...chat.map((c) => c.text)].join('\n');
    expect(all).not.toMatch(/vendor cannot complete|Check your coin/);
  });

  it('a vendor transaction\'s IR_SHOP_EVENT pending on the vendor has no verb either — still an empty line, and the reject clears it', () => {
    const { ui, spew } = surface();
    const t = new InventoryRequestTracker();
    t.record(0x70001234, InventoryRequest.ShopEvent);
    const attempt = handleAttemptFailed(t, PLAYER, WeenieError.None, (g) => (g === 0x70001234 ? { name: 'Aun Shopkeeper' } : player(g)), ui.displayErrorText);
    expect(attempt.objectId).toBe(0x70001234);
    expect(attempt.text).toBeNull();
    expect(attempt.cleared).toBe(true);
    expect(spew).toEqual([]);
  });
});
