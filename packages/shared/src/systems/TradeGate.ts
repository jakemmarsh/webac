/**
 * TradeGate — client-side mirror of ACE's trade-in-progress gate shared by
 * every UI path that can send GameActionAddToTrade (right-click "Add to
 * Trade" and drag-onto-trade-window).
 *
 * Player_Trade.cs:116-126 (HandleActionAddToTrade):
 *   if (TradeTransferInProgress) return;
 *   ...
 *   var target = PlayerManager.GetOnlinePlayer(TradePartner);
 *   if (target == null || itemGuid == 0) return;
 *
 * Both rejections are silent — no WeenieError, no chat text — so mirroring
 * this buys no new player-facing feedback. `TradePartner` is unset (0) until
 * a trade negotiation opens, which is exactly what the client's own
 * `tradeData.partnerGuid` tracks (set on RegisterTrade, cleared on
 * close/reset), so a non-zero `partnerGuid` is the client-observable
 * equivalent of a live `TradePartner`. `TradeTransferInProgress` has no
 * client-observable equivalent and is intentionally not part of this gate.
 */
export function canAddToTrade(partnerGuid: number): boolean {
  return partnerGuid !== 0;
}
