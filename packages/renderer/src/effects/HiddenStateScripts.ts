import { PhysicsState, PlayScript } from '@ac/shared';

/**
 * BUG.invented-portal-burst-and-spell-effects — the teleport / login
 * "pink bubble" effect is the object's own PhysicsScriptTable, not a
 * client-invented burst.
 *
 * `CPhysicsObj::set_state` @ 00514dd0 calls `set_hidden(state & 0x4000)` on
 * every edge of PhysicsState Hidden, and `CPhysicsObj::set_hidden` @ 00514c60
 * plays `PhysicsScriptTable::GetScript(Hidden (0x76), 1.0)` when the bit
 * sets and `GetScript(UnHide (0x75), 1.0)` when it clears (the decomp's
 * float literals 1.65353e-43 / 1.63952e-43 are the enum values 118 / 117).
 * The human table 0x34000004 maps them to 0x33000331 (0x3200028C on 13 body
 * parts + 0x3200028B at the root, translucency 1) and 0x3300032F
 * (StopParticle on all 14, fade in over 0.75 s); the server's own Hide
 * script (ACE Player_Location.cs:713, DoPreTeleportHide before a recall /
 * portal spell) is 0x33000332 — the same emitters fading out over 0.75 s.
 *
 * ACE creates a player Hidden (Player.cs:134) and clears it in
 * OnTeleportComplete (Player_Location.cs:759); DoTeleportPhysicsStateChanges
 * (:724) sets it for every teleport. Each change is a SetState broadcast
 * (the player included), and a CreateObject's state is applied against the
 * constructor default 0x00400C08 (no Hidden), so an object that arrives
 * Hidden plays Hidden too.
 */
export const PHYSICS_STATE_CTOR_DEFAULT = 0x00400c08;

/** The PlayScript `set_hidden` plays for a state change, or null when Hidden did not change. */
export function hiddenEdgeScript(prevState: number, nextState: number): PlayScript.Hidden | PlayScript.UnHide | null {
  const was = (prevState & PhysicsState.Hidden) !== 0;
  const is = (nextState & PhysicsState.Hidden) !== 0;
  if (was === is) return null;
  return is ? PlayScript.Hidden : PlayScript.UnHide;
}
