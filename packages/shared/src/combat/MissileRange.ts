/**
 * MissileRange — GAP.10: ACE-exact max missile range.
 *
 * Port of Creature_Missile.cs:406 GetMaxMissileRange:
 *   missileRange = MaximumVelocity² × 0.1020408163265306
 *   maxRange     = min(missileRange, MissileRangeCap)
 * with MissileRangeCap = 85 yards / 1.094 m-per-yard ≈ 77.697m
 * (Creature_Missile.cs:402-404) and DefaultMaxVelocity = 20 when the
 * weapon has no PropertyFloat.MaximumVelocity(26).
 *
 * ACE enforces this server-side (Player_Missile.cs:172 TargetInRange →
 * WeenieError.MissileOutOfRange transient); the client mirrors the check
 * in the live send path so out-of-range attacks are rejected locally with
 * the same transient instead of a wasted round-trip.
 */

export const METERS_TO_YARDS = 1.094;               // Creature_Missile.cs:402
export const MISSILE_RANGE_CAP = 85.0 / METERS_TO_YARDS; // :403 ≈ 77.697m
export const DEFAULT_MAX_VELOCITY = 20.0;           // :404

export function getMaxMissileRange(maximumVelocity: number | null | undefined): number {
  const maxVelocity = maximumVelocity ?? DEFAULT_MAX_VELOCITY;
  const missileRange = Math.pow(maxVelocity, 2.0) * 0.1020408163265306;
  return Math.min(missileRange, MISSILE_RANGE_CAP);
}
