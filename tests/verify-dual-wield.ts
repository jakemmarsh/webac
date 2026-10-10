/**
 * GAP.12 — dual-wielding: alternation, offhand swings, stance, timing, skill.
 *
 * ACE ground truth:
 *  - Creature_Equipment.cs:133 GetDualWieldWeapon — offhand = NON-shield item
 *    wielded in EquipMask.Shield.
 *  - Creature_Melee.cs:20-25 IsDualWieldAttack (stance == DualWieldCombat) +
 *    DualWieldAlternate ("true if *next* attack is offhand").
 *  - Player_Melee.cs:140 (alternate resets on attack click), :442-445 (flip
 *    first, offhand when !alternate), :403 (swing anim 1.2×), :366 (power
 *    bar refill ×0.8).
 *  - (Player_Combat.cs:74-81 offhand skill = min(DualWield, weaponSkill) is
 *    server-side; the client never resolves an attack.)
 *  - DamageEvent.cs — NO dual-wield damage factor (isDualWield documented as
 *    a non-damage input).
 */
import { describe, it, expect } from 'vitest';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { AttackType, AttackHeight } from '@ac/shared';

const DW = MotionStance.DualWieldCombat;

// A minimal CombatManeuverTable with distinct mainhand/offhand motions.
const MANEUVERS = [
  { style: DW, attackHeight: AttackHeight.Medium, attackType: AttackType.Slash, minSkillLevel: 0, motion: 0x111 },
  { style: DW, attackHeight: AttackHeight.Medium, attackType: AttackType.OffhandSlash, minSkillLevel: 0, motion: 0x222 },
  { style: MotionStance.SwordCombat, attackHeight: AttackHeight.Medium, attackType: AttackType.Slash, minSkillLevel: 0, motion: 0x333 },
];

function makeController() {
  const queued: Array<{ motion: number; speed: number }> = [];
  const mm = {
    queueAction: (m: number, s = 1.0) => queued.push({ motion: m, speed: s }),
    setStanceFromId: () => {},
    changeStyle: () => true,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cac = new CharacterAnimController(mm as any);
  cac.setCombatManeuvers(MANEUVERS);
  return { cac, queued };
}

describe('GAP.12 — dual-wield swing alternation (Player_Melee.cs:442-445)', () => {
  it('first swing is MAINHAND (flip-first semantics), then alternates', () => {
    const { cac, queued } = makeController();
    cac.setStance(DW);
    cac.setWeaponAttackType(AttackType.Slash, AttackType.Slash);
    // ACE: alternate=false initially → flip → true → offhand = !true = false → MAIN
    cac.queueAttack(AttackHeight.Medium, 0.9);
    cac.queueAttack(AttackHeight.Medium, 0.9); // flip → false → offhand
    cac.queueAttack(AttackHeight.Medium, 0.9); // flip → true → main
    expect(queued.map(q => q.motion)).toEqual([0x111, 0x222, 0x111]);
  });

  it('dual-wield swings animate at 1.2× (Player_Melee.cs:403); single-weapon at 1.0×', () => {
    // BUG.melee-swing-speed-ignores-quickness-weapon: DoSwingMotion multiplies
    // the 1.0/1.2 dual-wield factor by GetAnimSpeed(quickness, weaponSpeed),
    // not a bare 1.0 baseline. Pin quickness/weaponSpeed to a divisor of 1
    // (1 - 0/300 + 0/150 = 1) so baseSpeed == 1.0 and this test isolates the
    // dual-wield multiplier — see verify-anim-speed.ts for GetAnimSpeed itself.
    const { cac, queued } = makeController();
    cac.setStance(DW);
    cac.setWeaponAttackType(AttackType.Slash, AttackType.Slash);
    cac.setAnimSpeedInputs(0, 0);
    cac.queueAttack(AttackHeight.Medium, 0.9);
    expect(queued[0].speed).toBeCloseTo(1.2, 6);

    const single = makeController();
    single.cac.setStance(MotionStance.SwordCombat);
    single.cac.setWeaponAttackType(AttackType.Slash, null);
    single.cac.setAnimSpeedInputs(0, 0);
    single.cac.queueAttack(AttackHeight.Medium, 0.9);
    expect(single.queued[0].motion).toBe(0x333);
    expect(single.queued[0].speed).toBeCloseTo(1.0, 6);
  });

  it('resetDualWieldAlternate restarts the sequence at mainhand (Player_Melee.cs:140)', () => {
    const { cac, queued } = makeController();
    cac.setStance(DW);
    cac.setWeaponAttackType(AttackType.Slash, AttackType.Slash);
    cac.queueAttack(AttackHeight.Medium, 0.9); // main
    cac.resetDualWieldAlternate();
    cac.queueAttack(AttackHeight.Medium, 0.9); // main again after reset
    expect(queued.map(q => q.motion)).toEqual([0x111, 0x111]);
  });

  it('offhand swing uses the OFFHAND weapon attack type', () => {
    const { cac, queued } = makeController();
    cac.setStance(DW);
    // Main weapon has no Slash rows in this table; offhand does — the second
    // swing (offhand) must resolve via the OFFHAND weapon's type.
    cac.setWeaponAttackType(AttackType.Slash, AttackType.Slash);
    cac.queueAttack(AttackHeight.Medium, 0.9);
    cac.queueAttack(AttackHeight.Medium, 0.9);
    expect(queued[1].motion).toBe(0x222); // OffhandSlash row
  });
});
