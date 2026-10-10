/**
 * MovementType — used with various movement-related messages.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/MovementType.cs
 *
 * Per ACE: "0 & 6-9 are used with F74C movement". For 0 (Invalid) the
 * payload carries the full InterpretedMotionState; for 6/7 the creature
 * is walking to a target; for 8/9 it's turning in place.
 */
export enum MovementType {
  Invalid                = 0x0,
  RawCommand             = 0x1,
  InterpretedCommand     = 0x2,
  StopRawCommand         = 0x3,
  StopInterpretedCommand = 0x4,
  StopCompletely         = 0x5,
  MoveToObject           = 0x6,
  MoveToPosition         = 0x7,
  TurnToObject           = 0x8,
  TurnToHeading          = 0x9,
}
