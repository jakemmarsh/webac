/**
 * The power / accuracy bar's key step (SWEEP1999.input CM-5; every era).
 *
 * End of retail: ClientCombatSystem::HandleCombatAction @ 0056d600, for Decrease / Increase Power
 * (0x1000005b / 5c) and Decrease / Increase Accuracy (0x100000ef / f0) alike:
 * `Clamp((ftol(level) ± 1) * 0.16666667, 0, 1)`, the float 1/6 (0x3e2aaaab). 1999: HandleCommand
 * 0x90000c9 / c8 in melee or missile mode → 0x0058b300 / 0058b390 (ui/m0348), which `ftol` the
 * bar to a step of 0-6, add or take one, clamp and set `step / 6`. Both snap a level between
 * steps to the step below before moving (a bar at 0.7 goes up to 5/6, down to 3/6).
 */

/** The float32 1/6 both clients multiply by (0x3e2aaaab). */
const SIXTH = Math.fround(1 / 6);

/** The level one key press moves `level` to: `dir` +1 = Increase, -1 = Decrease. */
export function stepPowerLevel(level: number, dir: 1 | -1): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  // ftol: truncate the level in sixths. A stored step (n * float 1/6) is a hair above n/6, so it
  // truncates to n; the epsilon keeps a double-precision n/6 from truncating to n - 1.
  const step = Math.trunc(clamped * 6 + 1e-6);
  return Math.max(0, Math.min(1, Math.fround((step + dir) * SIXTH)));
}
