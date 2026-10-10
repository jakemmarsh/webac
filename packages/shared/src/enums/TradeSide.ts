/**
 * TradeSide — which side of the trade an item belongs to.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/TradeSide.cs
 *
 *   Self    = 0x1   — your offered item
 *   Partner = 0x2   — their offered item
 *
 * Wire format: uint32 on the AddToTrade GameEvent payload.
 */
export enum TradeSide {
  Self    = 0x1,
  Partner = 0x2,
}
