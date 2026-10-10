/**
 * ACE-faithful rounding helpers.
 *
 * C# and JavaScript disagree on .5 rounding, and ACE uses BOTH modes in
 * different places, so porting `Math.Round(...)` blindly to JS `Math.round`
 * (which is round-half-UP, i.e. toward +Infinity) is wrong twice over:
 *   - JS Math.round(-0.5) === 0 (up), C# Math.Round(-0.5) === 0 only under
 *     AwayFromZero; under the C# default (ToEven) it is 0 as well but
 *     Math.Round(2.5) === 2 (even) vs JS 3.
 *
 * ACE's `.Round()` extension (ACE.Common/Extensions/FloatExtensions.cs:9) is
 * `Math.Round(num, 0, MidpointRounding.AwayFromZero)`. Bare `Math.Round(x)`
 * in ACE C# is the framework default, `MidpointRounding.ToEven` (banker's).
 *
 * Use {@link roundHalfAwayFromZero} for the `.Round()` extension call sites
 * (AttributeFormula vitals, etc.) and {@link roundHalfToEven} for bare
 * `Math.Round` sites (damage, XP, fellowship splits).
 */

/**
 * Round half away from zero — matches ACE's `.Round()` extension
 * (`Math.Round(n, 0, MidpointRounding.AwayFromZero)`).
 *
 * 2.5 -> 3, -2.5 -> -3, 1.4 -> 1, 1.5 -> 2.
 */
export function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/**
 * Round half to even — matches C#'s default `Math.Round(n)`
 * (`MidpointRounding.ToEven`, "banker's rounding").
 *
 * 2.5 -> 2, 3.5 -> 4, -2.5 -> -2, 0.5 -> 0.
 */
export function roundHalfToEven(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 -> round to nearest even
  return floor % 2 === 0 ? floor : floor + 1;
}
