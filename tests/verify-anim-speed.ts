/**
 * BUG.melee-swing-speed-ignores-quickness-weapon — melee swing animation
 * speed as a function of Quickness + equipped weapon Speed
 * (shared/combat/AnimSpeed.ts, port of Creature_Combat.cs:510 GetAnimSpeed),
 * and CharacterAnimController.queueAttack applying it instead of a bare
 * 1.0/1.2 literal (Player_Melee.cs:402-404 DoSwingMotion).
 */
import { describe, it, expect } from 'vitest';
import { getAnimSpeed, MIN_ATTACK_SPEED, MAX_ATTACK_SPEED, DEFAULT_WEAPON_SPEED, AttackHeight } from '@ac/shared';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';

describe('BUG.melee-swing-speed-ignores-quickness-weapon — getAnimSpeed (Creature_Combat.cs:510)', () => {
  it('quickness 100 / unarmed default weapon speed 40 → divisor 1 - 1/3 + 40/150 ≈ 0.9333 → speed ≈ 1.0714', () => {
    const divisor = 1.0 - 100 / 300 + 40 / 150;
    expect(getAnimSpeed(100, 40)).toBeCloseTo(1.0 / divisor, 6);
  });

  it('higher Quickness speeds up the swing (lower divisor → higher animSpeed)', () => {
    expect(getAnimSpeed(300, 40)).toBeGreaterThan(getAnimSpeed(100, 40));
  });

  it('a faster weapon (lower WeaponTime) speeds up the swing', () => {
    expect(getAnimSpeed(100, 0)).toBeGreaterThan(getAnimSpeed(100, 40));
  });

  it('a slower weapon (higher WeaponTime) slows the swing', () => {
    expect(getAnimSpeed(100, 100)).toBeLessThan(getAnimSpeed(100, 40));
  });

  it('clamps to MIN_ATTACK_SPEED (0.5) for very slow combinations', () => {
    expect(getAnimSpeed(0, 300)).toBe(MIN_ATTACK_SPEED);
  });

  it('clamps to MAX_ATTACK_SPEED (2.0) for very fast combinations', () => {
    expect(getAnimSpeed(300, 0)).toBe(MAX_ATTACK_SPEED);
  });

  it('returns MAX_ATTACK_SPEED when the divisor goes non-positive (Creature_Combat.cs:516-517)', () => {
    // divisor = 1 - 400/300 + 0/150 = -0.333... <= 0
    expect(getAnimSpeed(400, 0)).toBe(MAX_ATTACK_SPEED);
  });

  it('DEFAULT_WEAPON_SPEED matches WorldObject_Weapon.cs:265 defaultSpeed (unarmed)', () => {
    expect(DEFAULT_WEAPON_SPEED).toBe(40);
  });
});

describe('BUG.melee-swing-speed-ignores-quickness-weapon — CharacterAnimController.queueAttack applies GetAnimSpeed', () => {
  it('passes getAnimSpeed(quickness, weaponSpeed) to queueAction instead of a bare 1.0 (fallback path, no CMT loaded)', () => {
    const mm = new MotionManager({} as DatDatabase);
    const calls: Array<{ motion: number; speed?: number }> = [];
    mm.queueAction = (motion: number, speed?: number) => { calls.push({ motion, speed }); };

    const controller = new CharacterAnimController(mm);
    controller.setStance(MotionStance.SwordCombat);
    controller.setAnimSpeedInputs(300, 0); // → MAX_ATTACK_SPEED (2.0), not the old hardcoded 1.0
    controller.queueAttack(AttackHeight.Medium);

    expect(calls.length).toBe(1);
    expect(calls[0].speed).toBe(MAX_ATTACK_SPEED);
  });

  it('defaults to the unarmed weapon speed when setAnimSpeedInputs has not been called', () => {
    const mm = new MotionManager({} as DatDatabase);
    const calls: Array<{ motion: number; speed?: number }> = [];
    mm.queueAction = (motion: number, speed?: number) => { calls.push({ motion, speed }); };

    const controller = new CharacterAnimController(mm);
    controller.setStance(MotionStance.SwordCombat);
    controller.queueAttack(AttackHeight.Medium);

    const divisor = 1.0 - 0 / 300 + DEFAULT_WEAPON_SPEED / 150;
    expect(calls[0].speed).toBeCloseTo(1.0 / divisor, 6);
  });
});
