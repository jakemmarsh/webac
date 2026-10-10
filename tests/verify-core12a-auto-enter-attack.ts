/**
 * CORE.12.a — context-menu 'Attack' (and debug attack) auto-enter must
 * derive the combat mode from equipment, not hardcode Melee — and must
 * NOT send a melee attack event after entering Magic mode.
 *
 * Retail ground truth — decompiled EoL client:
 *   ClientCombatSystem::ToggleCombatMode @ 0056c8c0: from peace the toggle
 *     enters GetDefaultCombatMode(false) — the auto-enter mirrors it.
 *   ClientCombatSystem::ExecuteAttack @ 0056bb70: emits
 *     CM_Combat::Event_TargetedMeleeAttack ONLY in MELEE_COMBAT_MODE and
 *     Event_TargetedMissileAttack ONLY in MISSILE_COMBAT_MODE — there is
 *     no attack event in magic mode at all.
 *   ClientCombatSystem::OnAction @ 0056d890: attack-height/power inputs
 *     are dispatched to HandleCombatAction only when the mode field is
 *     2 (melee) or 4 (missile); in magic mode inputs go to
 *     HandleMagicAction. Retail cannot produce a melee swing from magic.
 * ACE server agrees: Player_Melee.cs:55 logs a CombatMode-mismatch warning
 * for a TargetedMeleeAttack arriving with CombatMode != Melee.
 *
 * Pre-fix, main.ts onContextMenuAction('attack') and acDebug.attack both
 * sent ChangeCombatMode(Melee) unconditionally when auto-entering combat,
 * then fired a TargetedMeleeAttack 1s later — so right-click → Attack with
 * a wand wielded forced melee mode (wrong bar, wrong stance) and swung.
 *
 * This suite drives the shipped shared planner both paths now call.
 */
import { describe, it, expect } from 'vitest';
import {
  getAutoEnterAttackPlan, getDefaultCombatMode,
  CombatMode, CombatUse, EquipMask,
} from '../packages/shared/src/index.js';

describe('CORE.12.a — getAutoEnterAttackPlan (context-menu Attack auto-enter)', () => {
  it('nothing wielded → enter Melee AND send the attack (unarmed swing)', () => {
    expect(getAutoEnterAttackPlan([])).toEqual({
      mode: CombatMode.Melee, sendAttack: true,
    });
  });

  it('sword in MeleeWeapon slot → enter Melee AND send the attack', () => {
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.MeleeWeapon, combatUse: CombatUse.Melee },
    ])).toEqual({ mode: CombatMode.Melee, sendAttack: true });
  });

  it('bow (CombatUse.Missile) → enter Missile AND send the attack', () => {
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.MissileWeapon, combatUse: CombatUse.Missile },
    ])).toEqual({ mode: CombatMode.Missile, sendAttack: true });
  });

  it('caster in the Held slot → enter Magic, send NO attack event', () => {
    // Retail ExecuteAttack has no magic-mode branch; ACE Player_Melee.cs:55
    // flags a melee swing in Magic mode as a CombatMode mismatch.
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.Held, combatUse: CombatUse.None },
    ])).toEqual({ mode: CombatMode.Magic, sendAttack: false });
  });

  it('two-handed weapon → Melee + attack (weapon-slot branch, non-missile)', () => {
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.TwoHanded, combatUse: CombatUse.TwoHanded },
    ])).toEqual({ mode: CombatMode.Melee, sendAttack: true });
  });

  it('mode always agrees with getDefaultCombatMode (the toggle rule)', () => {
    const loadouts: Array<Array<{ slot: number; combatUse?: number }>> = [
      [],
      [{ slot: EquipMask.Held, combatUse: CombatUse.None }],
      [{ slot: EquipMask.MissileWeapon, combatUse: CombatUse.Missile }],
      [{ slot: EquipMask.MeleeWeapon, combatUse: CombatUse.Melee }],
      [{ slot: EquipMask.Shield, combatUse: CombatUse.Shield }],
      [
        { slot: EquipMask.ChestArmor, combatUse: CombatUse.None },
        { slot: EquipMask.Held, combatUse: CombatUse.None },
      ],
    ];
    for (const equipped of loadouts) {
      expect(getAutoEnterAttackPlan(equipped).mode).toBe(getDefaultCombatMode(equipped));
    }
  });

  it('sendAttack is true exactly for the two modes retail has attack events for', () => {
    // Melee and Missile have Event_Targeted*Attack senders in ExecuteAttack;
    // Magic (and, unreachable from the planner, NonCombat) do not.
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.MeleeWeapon, combatUse: CombatUse.Melee },
    ]).sendAttack).toBe(true);
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.MissileWeapon, combatUse: CombatUse.Missile },
    ]).sendAttack).toBe(true);
    expect(getAutoEnterAttackPlan([
      { slot: EquipMask.Held, combatUse: CombatUse.None },
    ]).sendAttack).toBe(false);
  });
});
