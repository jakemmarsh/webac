/**
 * RadarBehavior — controls how a WorldObject is rendered on the player's
 * radar HUD. Wire value is a uint8 in the WeenieHeader block of the
 * CreateObject message (parsed in `MessageSerializer.parseObjectDesc` when
 * the `WeenieHeaderFlag.RadarBehavior` bit is set).
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/RadarBehavior.cs
 *
 *   Undefined     = 0   — no hint: no blip (both clients' InqShowableOnRadar)
 *   ShowNever     = 1   — hide from radar entirely
 *   ShowMovement  = 2   — 1999: shown near, moving, turning, acting or in a combat stance
 *   ShowAttacking = 3   — 1999: shown near or in a combat stance
 *   ShowAlways    = 4   — always show
 *
 * Usage (renderer ui/RadarBlips.ts): the end-of-retail client
 * (ACCWeenieObject::InqShowableOnRadar @ 0058c250) shows 2, 3 and 4 alike;
 * the 1999 client.exe (@ 0x4e2f20) gates 2 and 3 on what the object is
 * doing (inqShowableOnRadar1999, BUG.webac11-radar-1999).
 */
export enum RadarBehavior {
  Undefined     = 0,
  ShowNever     = 1,
  ShowMovement  = 2,
  ShowAttacking = 3,
  ShowAlways    = 4,
}
