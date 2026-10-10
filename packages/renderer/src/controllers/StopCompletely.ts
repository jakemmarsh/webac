/**
 * BUG.cast-while-moving-keeps-moving — retail's CommandInterpreter stop
 * (EoL acclient.exe), the step that makes a cast or an attack stand the
 * player still.
 *
 * CommandInterpreter::MaybeStopCompletely @ 006b3b90 (cmdinterp vtable
 * +0xc0) does nothing while the server controls the player
 * (controlled_by_server: LoseControlToServer @ 006b3170, e.g. a server
 * MoveTo); otherwise it calls StopCompletely @ 006b3b50 (vtable +0xbc):
 *
 *  1. ClearAllCommands @ 006b31a0 (+0x28): the Substate, Turn and Sidestep
 *     CommandLists empty. A movement key still held moves nothing until it
 *     is pressed again.
 *  2. SetAutoRun(0, 0) @ 006b4850 (+0xcc): autorun off.
 *  3. CPhysicsObj::StopCompletely(player, 1) @ 00510180 → MovementManager
 *     → CMotionInterp::StopCompletely @ 00527e40: the raw and interpreted
 *     states go to Ready (forward Ready at 1.0, no sidestep, no turn). The
 *     sequence plays its stop link, so a runner still coasts it.
 *  4. SendMovementEvent @ 006b4680 (+0x4c): a MoveToState with that
 *     stopped state, at once.
 *
 * Callers of MaybeStopCompletely: ClientMagicSystem::CastSpell @ 00568040
 * and FreeHandsAndCastSpell @ 00566ef0 call it right before
 * CM_Magic::Event_Cast(Un)TargetedSpell, and ClientCombatSystem::
 * StartAttackRequest @ 0056c040 calls it when an attack request starts.
 * The retail A/B capture (docs/movement-ab.md, cast-run / cast-strafe /
 * cast-run-strafe) shows it on the wire: the stopped MoveToState goes out
 * with the cast, the player coasts the stop link and stays put while the
 * keys are held, and the key-ups send nothing.
 */

export interface StopCompletelyDeps {
  /** CommandInterpreter::controlled_by_server — a server MoveTo drives the player. */
  controlledByServer(): boolean;
  /** ClearAllCommands + SetAutoRun(0, 0). */
  clearAllCommands(): void;
  /** CPhysicsObj::StopCompletely: the motion state goes to Ready. */
  stopPhysics(): void;
  /** SendMovementEvent: the MoveToState with the stopped state. */
  sendMovementEvent(): void;
}

/** CommandInterpreter::StopCompletely @ 006b3b50. */
export function stopCompletely(d: StopCompletelyDeps): void {
  d.clearAllCommands();
  d.stopPhysics();
  d.sendMovementEvent();
}

/**
 * CommandInterpreter::MaybeStopCompletely @ 006b3b90. Returns true when it
 * stopped the player.
 */
export function maybeStopCompletely(d: StopCompletelyDeps): boolean {
  if (d.controlledByServer()) return false;
  stopCompletely(d);
  return true;
}
