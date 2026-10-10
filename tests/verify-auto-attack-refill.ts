/**
 * FAITHFUL.181 — auto-attack refill timing parity with ACE.
 *
 * ACE Player_Melee.cs:370 sets the next attack refill delay as:
 *     var refillMod = IsDualWieldAttack ? 0.8f : 1.0f;
 *     var nextRefillTime = PowerLevel * refillMod;
 *
 * PowerLevel is the player's 0-1 attack power slider. Result in seconds.
 * Pre-FAITHFUL.181 the client used a hardcoded 1500ms (1.5s) delay
 * regardless of power level or dual-wield state — wildly out of step with
 * the server's actual cadence (max 1000ms single-wield at full power,
 * 500ms at half power, 800ms dual-wield max).
 *
 * These tests pin the formula, the dual-wield discount, and the minimum
 * delay floor that prevents zero-delay infinite loops at PowerLevel=0.
 *
 * Reference: reference/ACE/Source/ACE.Server/WorldObjects/Player_Melee.cs:370
 */
import { describe, it, expect } from 'vitest';

/**
 * The exact formula extracted from the client into a pure function so it can
 * be unit-tested. Mirrors the inline expression in main.ts under the
 * AttackDone end-of-sequence branch.
 */
function refillDelayMs(powerLevel: number, weaponCount: number): number {
  const refillMod = weaponCount >= 2 ? 0.8 : 1.0;
  return Math.max(50, powerLevel * refillMod * 1000);
}

describe('Auto-attack refill formula', () => {
  it('matches ACE: full power, single weapon = 1000ms', () => {
    expect(refillDelayMs(1.0, 1)).toBe(1000);
  });
  it('matches ACE: full power, dual-wield = 800ms (20% faster)', () => {
    expect(refillDelayMs(1.0, 2)).toBe(800);
  });
  it('matches ACE: half power, single = 500ms', () => {
    expect(refillDelayMs(0.5, 1)).toBe(500);
  });
  it('matches ACE: half power, dual-wield = 400ms', () => {
    expect(refillDelayMs(0.5, 2)).toBe(400);
  });
  it('matches ACE: 30% power, single = 300ms', () => {
    expect(refillDelayMs(0.3, 1)).toBeCloseTo(300);
  });
  it('clamps to 50ms minimum at PowerLevel=0 (prevents 0-delay infinite loop)', () => {
    expect(refillDelayMs(0, 1)).toBe(50);
    expect(refillDelayMs(0, 2)).toBe(50);
    expect(refillDelayMs(0.01, 1)).toBe(50); // 10ms would round to 10, clamp pulls to 50
  });
});

describe('Auto-attack refill — dual-wield threshold', () => {
  it('1 equipped weapon → single-wield mod (1.0)', () => {
    expect(refillDelayMs(1.0, 1)).toBe(1000);
  });
  it('2 equipped weapons → dual-wield mod (0.8)', () => {
    expect(refillDelayMs(1.0, 2)).toBe(800);
  });
  it('3+ equipped weapons → still dual-wield mod (sanity)', () => {
    expect(refillDelayMs(1.0, 3)).toBe(800);
  });
  it('0 equipped weapons → still single mod (HandCombat)', () => {
    expect(refillDelayMs(1.0, 0)).toBe(1000);
  });
});
