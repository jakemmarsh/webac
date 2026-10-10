/**
 * ACE-faithful rounding helpers (packages/shared/src/util/round.ts).
 *
 * Ground truth:
 *  - roundHalfAwayFromZero mirrors ACE's `.Round()` extension
 *    (ACE.Common/Extensions/FloatExtensions.cs:9 — Math.Round(n,0,AwayFromZero)).
 *  - roundHalfToEven mirrors C#'s default Math.Round (MidpointRounding.ToEven).
 *
 * Behavioral: imports and exercises the real shipped functions.
 */
import { describe, it, expect } from 'vitest';
import { roundHalfAwayFromZero, roundHalfToEven } from '../packages/shared/src/util/round.js';

describe('roundHalfAwayFromZero (ACE .Round())', () => {
  it('rounds .5 away from zero', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(3.5)).toBe(4);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
  });
  it('rounds non-midpoints normally', () => {
    expect(roundHalfAwayFromZero(1.4)).toBe(1);
    expect(roundHalfAwayFromZero(1.6)).toBe(2);
    expect(roundHalfAwayFromZero(50)).toBe(50);
  });
  it('matches ACE MaxHealth = Round(Endurance/2) for odd Endurance', () => {
    // Endurance 101 -> 50.5 -> 51 (ACE rounds up); plain floor would give 50.
    expect(roundHalfAwayFromZero(101 / 2)).toBe(51);
    expect(roundHalfAwayFromZero(103 / 2)).toBe(52);
    expect(roundHalfAwayFromZero(100 / 2)).toBe(50); // even stays
  });
});

describe('roundHalfToEven (C# default Math.Round)', () => {
  it('rounds .5 to nearest even', () => {
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(3.5)).toBe(4);
    expect(roundHalfToEven(0.5)).toBe(0);
    expect(roundHalfToEven(1.5)).toBe(2);
    expect(roundHalfToEven(-2.5)).toBe(-2);
    expect(roundHalfToEven(-1.5)).toBe(-2);
  });
  it('rounds non-midpoints normally', () => {
    expect(roundHalfToEven(2.4)).toBe(2);
    expect(roundHalfToEven(2.6)).toBe(3);
    expect(roundHalfToEven(-2.6)).toBe(-3);
  });
});
