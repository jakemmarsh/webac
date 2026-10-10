/**
 * AttackTargetGate — client-side mirror of ACE's target-resolution gate for
 * targeted melee/missile attacks. All three rejections below are silent on
 * the server: OnAttackDone() only ever sends GameEventAttackDone(ActionCancelled),
 * and per Player_Melee.cs's own comment on that method, "the werror for this
 * network message is not displayed to the client" — so there is nothing for
 * the client to show even if it mirrors the check. The value of mirroring it
 * is avoiding the doomed round-trip (and the local approach/pending state
 * staying stuck on a target that can never be attacked).
 *
 * Port of Player_Melee.cs:103-131 (HandleActionTargetedMeleeAttack):
 *   var target = CurrentLandblock?.GetObject(targetGuid);
 *   if (target == null) { OnAttackDone(); return; }
 *   var creatureTarget = target as Creature;
 *   if (creatureTarget == null) { OnAttackDone(); return; }
 *   ...
 *   if (!creatureTarget.IsAlive) { OnAttackDone(); return; }
 *
 * and Player_Missile.cs:97-103 (HandleActionTargetedMissileAttack), which
 * folds the null/not-Creature check into a single `as Creature` cast:
 *   var target = CurrentLandblock?.GetObject(targetGuid) as Creature;
 *   if (target == null || target.Teleporting) { OnAttackDone(); return; }
 *
 * `target.Teleporting` has no client-observable equivalent — the server
 * never broadcasts another creature's internal Teleporting flag to other
 * clients — so it's intentionally not part of this gate.
 */

/** Mirrors the target-exists/is-creature/is-alive portion of ACE's attack-target gate. */
export function canAttackTarget(targetExists: boolean, isCreature: boolean, isDying: boolean): boolean {
  if (!targetExists) return false;
  if (!isCreature) return false;
  if (isDying) return false;
  return true;
}
