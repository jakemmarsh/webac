/**
 * EndTradeReason — reason code carried on the CloseTrade GameEvent (0x0150).
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/EndTradeReason.cs
 *
 *   Normal        = 0x01   — both sides accepted, trade completed
 *   EnteredCombat = 0x02   — server force-closed because someone began combat
 *   Canceled      = 0x51   — one side hit cancel (or the trade timed out)
 *
 * Wire format: uint32 on the GameEventCloseTrade payload.
 *
 * The retail client ignores the reason for its text: Handle_Trade__Recv_CloseTrade
 * @ 0056de30 always posts "The trade has been cancelled." (0x1a) — see
 * renderer ui/ServerMessageText.ts tradeClosedLine (DECOMP.trade-closed-notice).
 */
export enum EndTradeReason {
  Normal        = 0x01,
  EnteredCombat = 0x02,
  Canceled      = 0x51,
}
