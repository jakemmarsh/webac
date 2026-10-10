/**
 * FellowUpdateType — payload-shape selector on FellowshipUpdateFellow
 * (0x0156) GameEvent.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/FellowUpdateType.cs
 *
 *   Undef  = 0    — invalid / placeholder
 *   Full   = 1    — full FellowData (level + max/cur health/stam/mana + name)
 *   Stats  = 2    — stats-only refresh
 *   Vitals = 3    — vitals-only refresh (current health/stam/mana)
 *
 * Wire format: uint32 trailing the FellowshipUpdateFellow payload.
 */
export enum FellowUpdateType {
  Undef  = 0,
  Full   = 1,
  Stats  = 2,
  Vitals = 3,
}
