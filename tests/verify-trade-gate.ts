/**
 * GAP.88 — Add-to-Trade client-side trade-in-progress gate.
 *
 * ACE ground truth (silent — no WeenieError, no chat text):
 *  - Player_Trade.cs:116-126 (HandleActionAddToTrade): if TradeTransferInProgress
 *    return; ...; var target = PlayerManager.GetOnlinePlayer(TradePartner);
 *    if (target == null || itemGuid == 0) return.
 *
 * `TradePartner` is unset (0) until a trade negotiation opens — the client's
 * own `tradeData.partnerGuid` mirrors exactly that (set on RegisterTrade,
 * cleared on close/reset). Both the drag-to-trade-window and right-click
 * "Add to Trade" call sites in main.ts previously duplicated the same
 * `if (!td.partnerGuid) return` guard inline; canAddToTrade replaces both
 * with one shared, tested helper (same shape as canAttackTarget/canUseTarget).
 */
import { describe, it, expect } from 'vitest';
import { canAddToTrade } from '../packages/shared/src/systems/TradeGate.js';

describe('GAP.88 — canAddToTrade mirrors Player_Trade.cs:116-126 silent TradePartner-resolves gate', () => {
  it('no trade in progress (partnerGuid 0) rejects the add', () => {
    expect(canAddToTrade(0)).toBe(false);
  });

  it('an open trade negotiation (non-zero partnerGuid) allows the add', () => {
    expect(canAddToTrade(0x50000123)).toBe(true);
  });
});
