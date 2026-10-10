/**
 * FAITHFUL.463 — onPlayerTeleport also clears melee approach + auto-
 *  attack state.
 *
 *  FAITHFUL.461 cleared the 4-tuple selection state (currentTargetGuid +
 *  combatController.target + hudState.target) on
 *  PlayerTeleport, matching FAITHFUL.459-460. But the death cleanup
 *  blocks also clear two more auto-attack-related state vars:
 *    - combatController.autoAttack = false
 *    - meleeApproachTarget = null
 *
 *  Without these, a teleport mid-combat would leave autoAttack=true
 *  with target=null — a dead-state that breaks the next combat
 *  session's chain.
 *
 *  clearAutoAttackChain() in CombatController.ts holds the extracted
 *  clear logic; this test drives it directly instead of regex-matching
 *  main.ts source text (BUG.combat-attack-charge-build.b dropped the
 *  onPlayerTeleport source-text pins along with meleeAttackPending).
 */
import { describe, it, expect } from 'vitest';
import { CombatController, clearAutoAttackChain } from '../packages/renderer/src/controllers/CombatController.js';


describe('clearAutoAttackChain (FAITHFUL.463)', () => {
  it('turns off combatController.autoAttack', () => {
    const cc = new CombatController();
    cc.autoAttack = true;
    clearAutoAttackChain(cc);
    expect(cc.autoAttack).toBe(false);
  });

  it('returns the cleared chain target (meleeApproachTarget: null)', () => {
    const cc = new CombatController();
    expect(clearAutoAttackChain(cc)).toBeNull();
  });

  it('leaves autoAttack off if it was already off', () => {
    const cc = new CombatController();
    clearAutoAttackChain(cc);
    expect(cc.autoAttack).toBe(false);
  });
});
