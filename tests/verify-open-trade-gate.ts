/**
 * GAP.88 — OpenTradeNegotiations client-side trade-partner-resolution gate.
 *
 * ACE ground truth (silent — no WeenieError, no chat text):
 *  - Player_Trade.cs:30-39 (HandleActionOpenTradeNegotiations):
 *    var tradePartner = PlayerManager.GetOnlinePlayer(tradePartnerGuid);
 *    if (tradePartner == null) return.
 *
 * Every other early-return later in this handler (Olthoi restriction,
 * ignore-requests, already-trading, non-combat-mode, max-distance) sends the
 * player visible feedback; only the null-partner branch is silent. The
 * right-click "Trade" context-menu option captures the partner's guid at
 * menu-open time and can stay open indefinitely, so the guid may stop
 * resolving (partner logs off, zones, or otherwise drops out of tracking)
 * before the player actually clicks it — canOpenTrade suppresses that doomed
 * round-trip the same way canUseTarget/canAttackTarget do for their actions.
 */
import { describe, it, expect } from 'vitest';
import { canOpenTrade } from '../packages/shared/src/systems/OpenTradeGate.js';

describe('GAP.88 — canOpenTrade mirrors Player_Trade.cs:38-39 silent GetOnlinePlayer-resolves gate', () => {
  it('a partner guid that no longer resolves to a tracked object rejects the open', () => {
    expect(canOpenTrade(false)).toBe(false);
  });

  it('a partner guid still resolving to a tracked object allows the open', () => {
    expect(canOpenTrade(true)).toBe(true);
  });
});
