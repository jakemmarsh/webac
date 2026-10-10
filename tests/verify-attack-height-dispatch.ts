/**
 * FAITHFUL.107 — Pin tests for `CharacterAnimController.queueAttack`.
 *
 * History: Pre-fix `queueAttack(height: number)` accepted a private 0/1/2
 * encoding (0=high, 1=med, 2=low) that didn't match the ACE AttackHeight
 * enum (per AttackHeight.cs: High=1, Medium=2, Low=3). Every caller in
 * main.ts had to convert via:
 *   `const animHeight = attackHeight === 1 ? 0 : attackHeight === 3 ? 2 : 1;`
 *
 * Switched to accept AttackHeight directly. This file:
 *   1. Audits the source of `queueAttack` to confirm symbolic AttackHeight
 *      cases (not bare 0/1/2 numeric labels).
 *   2. Audits main.ts to confirm the wire-value → animator conversion is
 *      no longer present (regression anchor).
 *   3. Pins the ACE AttackHeight enum values.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttackHeight } from '../packages/shared/src/index.js';

const REPO = resolve(__dirname, '..');
const CAC_PATH = resolve(REPO, 'packages/renderer/src/animation/CharacterAnimController.ts');
const MAIN_PATH = resolve(REPO, 'packages/renderer/src/main.ts');

describe('FAITHFUL.107: queueAttack uses ACE AttackHeight values', () => {
  it('ACE AttackHeight: High=1, Medium=2, Low=3', () => {
    expect(AttackHeight.High).toBe(1);
    expect(AttackHeight.Medium).toBe(2);
    expect(AttackHeight.Low).toBe(3);
  });

  it('queueAttack accepts AttackHeight (behavioral — GAP.9 converted the signature pin)', async () => {
    // Drive the REAL controller with a stub MotionManager and assert the
    // ACE wire values (1/2/3) select height-correct motions with no CMT
    // loaded (the legacy fallback mapping): High→SlashHigh, Med→SlashMed,
    // Low→SlashLow in a weapon stance.
    const { CharacterAnimController } = await import('../packages/renderer/src/animation/CharacterAnimController.js');
    const { MotionCommand, MotionStance } = await import('../packages/renderer/src/animation/MotionCommands.js');
    const queued: number[] = [];
    const mm = { queueAction: (m: number) => queued.push(m), setStanceFromId: () => {}, changeStyle: () => true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cac = new CharacterAnimController(mm as any);
    cac.setStance(MotionStance.SwordCombat);
    cac.queueAttack(AttackHeight.High);
    cac.queueAttack(AttackHeight.Medium);
    cac.queueAttack(AttackHeight.Low);
    expect(queued).toEqual([MotionCommand.SlashHigh, MotionCommand.SlashMed, MotionCommand.SlashLow]);
  });

  it('queueAttack switch uses symbolic AttackHeight.High / .Medium / .Low cases', () => {
    const src = readFileSync(CAC_PATH, 'utf8');
    expect(src).toMatch(/case\s+AttackHeight\.High:/);
    expect(src).toMatch(/case\s+AttackHeight\.Low:/);
    expect(src).toMatch(/case\s+AttackHeight\.Medium:/);
    // No bare `case 0:` or `case 2:` numeric labels remain.
    expect(src).not.toMatch(/case\s+0:\s+attackMotion/);
    expect(src).not.toMatch(/case\s+2:\s+attackMotion/);
  });

  it('main.ts no longer has the 1/2/3 → 0/1/2 conversion (regression anchor)', () => {
    const src = readFileSync(MAIN_PATH, 'utf8');
    // The exact pre-fix line was:
    //   const animHeight = attackHeight === 1 ? 0 : attackHeight === 3 ? 2 : 1;
    expect(src).not.toMatch(/animHeight\s*=\s*attackHeight\s*===\s*1\s*\?\s*0/);
  });

  it('main.ts sendMeleeAttack maps UI string → AttackHeight symbolic values', () => {
    const src = readFileSync(MAIN_PATH, 'utf8');
    expect(src).toMatch(/high:\s*AttackHeight\.High/);
    expect(src).toMatch(/medium:\s*AttackHeight\.Medium/);
    expect(src).toMatch(/low:\s*AttackHeight\.Low/);
  });
});
