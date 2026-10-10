/**
 * OpenTradeGate — client-side mirror of ACE's trade-partner-resolution gate
 * for GameActionOpenTradeNegotiations (the right-click "Trade" context-menu
 * action that opens the trade panel).
 *
 * Player_Trade.cs:30-39 (HandleActionOpenTradeNegotiations):
 *   public void HandleActionOpenTradeNegotiations(uint tradePartnerGuid, bool initiator = false)
 *   {
 *       if (IsOlthoiPlayer) { ...SendSystemChat...; return; }
 *       var tradePartner = PlayerManager.GetOnlinePlayer(tradePartnerGuid);
 *       if (tradePartner == null) return;
 *       ...
 *   }
 *
 * Every other early-return later in this method sends a GameMessageSystemChat
 * or GameEventWeenieError the player sees as text (Olthoi restriction, ignore-
 * requests, already-trading, non-combat-mode, max-distance). Only the null-
 * partner branch is silent — no error, no state change, the trade panel just
 * never opens. Mirroring this buys no new player-facing feedback; the value
 * is avoiding a doomed round-trip for a target guid that went stale between
 * capture and dispatch: the right-click context menu captures the partner's
 * guid at menu-open time and fires whenever the player later clicks "Trade",
 * and the menu can be left open indefinitely while the partner logs off,
 * zones, or otherwise stops being tracked in the meantime.
 */
export function canOpenTrade(targetExists: boolean): boolean {
  return targetExists;
}

/**
 * VISUAL.item-right-click-examine — how retail STARTS a trade: by using
 * another player. ItemHolder::DetermineUseResult @ 00588460 returns 5 for
 * an object that is not useable and is a player other than us, and
 * CPlayerSystem::UsingItem @ 00562f70 then calls
 * ClientTradeSystem::AttemptToOpenTradeNegotiations @ 0056dee0: in peace
 * mode it sends Event_OpenTradeNegotiations, otherwise it posts "You need
 * to be in peace mode to trade." (DisplayStringInfo 0x1a). (The invented
 * world right-click "Trade" entry was the only way in before.)
 */
export function isTradeUse(target: { guid: number; objectDescFlags: number; usable?: number }, selfGuid: number | null): boolean {
  const PLAYER = 0x00000008; // ObjectDescriptionFlag.Player
  // ItemUses::IsUseable @ 004fccc0 is `~bits & 1`: useable unless the
  // ACE Usable.No bit (0x1) is set — ACE sends players Usable.No.
  const useable = ((target.usable ?? 0) & 1) === 0;
  return (target.objectDescFlags & PLAYER) !== 0 && target.guid !== selfGuid && !useable;
}

export const PEACE_MODE_TO_TRADE_TEXT = 'You need to be in peace mode to trade.';

/** AttemptToOpenTradeNegotiations: open (send) in peace mode, else the refusal text. */
export function attemptToOpenTradeNegotiations(inPeaceMode: boolean, partnerGuid: number): { send: boolean; message?: string } {
  if (!inPeaceMode) return { send: false, message: PEACE_MODE_TO_TRADE_TEXT };
  return { send: partnerGuid !== 0 };
}
