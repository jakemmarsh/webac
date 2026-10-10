/**
 * FAITHFUL.464 — sendChangeCombatMode cancels in-progress melee
 *  swing chain when switching AWAY from Melee.
 *
 *  Pre-fix `meleeApproachTarget + meleeAttackPending` stayed set when
 *  the player changed mode (e.g. Melee → Magic mid-fight). The
 *  AttackDone chain logic at main.ts:~6409 only gated on
 *  `combatController.isInCombat`, which is true for ALL non-NonCombat
 *  modes (Magic/Missile/Melee). So after a successful spell-cast
 *  triggered by mode-switch, the next AttackDone refill cycle would
 *  fire a TargetedMeleeAttack from Magic stance. ACE rejects with
 *  WeenieError.YouMustBeInCombatMode (the chain dies anyway), but
 *  the rejection produces a visible "you cannot attack" toast to
 *  the player.
 *
 *  Killing the melee chain at mode-switch keeps the next combat
 *  session's state clean.
 *
 *  BUG.combat-attack-charge-build.b retired the client refill re-send
 *  (and its timer): the server repeats the swing, so resetMeleeChain()
 *  only clears the chain's target. The main.ts source-text pins this
 *  file carried were converted to the helper's behavioral tests.
 */
import { describe, it, expect } from 'vitest';
import { CombatMode } from '@ac/shared';
import { shouldClearMeleeChainOnModeChange, resetMeleeChain } from '../packages/renderer/src/controllers/CombatController.js';

describe('shouldClearMeleeChainOnModeChange (FAITHFUL.464)', () => {
  it('clears the melee chain when switching to Magic', () => {
    expect(shouldClearMeleeChainOnModeChange(CombatMode.Magic)).toBe(true);
  });

  it('clears the melee chain when switching to Missile', () => {
    expect(shouldClearMeleeChainOnModeChange(CombatMode.Missile)).toBe(true);
  });

  it('clears the melee chain when switching to NonCombat', () => {
    expect(shouldClearMeleeChainOnModeChange(CombatMode.NonCombat)).toBe(true);
  });

  it('does NOT clear the melee chain when switching to (or staying in) Melee', () => {
    expect(shouldClearMeleeChainOnModeChange(CombatMode.Melee)).toBe(false);
  });
});

describe('resetMeleeChain (BUG.combat-attack-charge-build.b)', () => {
  it('returns the cleared chain target', () => {
    expect(resetMeleeChain()).toBeNull();
  });
});
