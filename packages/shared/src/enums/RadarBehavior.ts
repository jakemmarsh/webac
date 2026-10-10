/**
 * RadarBehavior — controls how a WorldObject is rendered on the player's
 * radar HUD. Wire value is a uint8 in the WeenieHeader block of the
 * CreateObject message (parsed in `MessageSerializer.parseObjectDesc` when
 * the `WeenieHeaderFlag.RadarBehavior` bit is set).
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/RadarBehavior.cs
 *
 *   Undefined     = 0   — no radar visibility hint set (treated as visible)
 *   ShowNever     = 1   — hide from radar entirely
 *   ShowMovement  = 2   — show only when moving
 *   ShowAttacking = 3   — show only when in combat
 *   ShowAlways    = 4   — always show
 *
 * Usage: the renderer's radar-dot loop culls objects whose value is
 * ShowNever. (ShowMovement / ShowAttacking are not yet conditional on
 * movement or combat state in this client; they are treated as visible.)
 */
export enum RadarBehavior {
  Undefined     = 0,
  ShowNever     = 1,
  ShowMovement  = 2,
  ShowAttacking = 3,
  ShowAlways    = 4,
}
