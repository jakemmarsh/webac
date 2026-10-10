/**
 * GAP.7 — falling physics decisions (client side).
 *
 * ACE computes falling damage entirely server-side
 * (Player_Move.cs:247 HandleFallingDamage, fired from the physics
 * engine's environment collision — WeenieObject.cs:236), but its physics
 * only integrates a fall while the client reports NOT-in-contact
 * (Player.LastContact, set from the AutonomousPosition/MoveToState
 * contact byte). The client therefore has to genuinely fall: keep an
 * absolute feet height while airborne, and lose contact when the ground
 * drops out from underfoot.
 */

import { integrateAirborneStep } from '@ac/shared';

/**
 * The human player SetupModel (0x02000001) StepDownHeight from portal.dat.
 * ACE's transition system keeps an object in contact only when a walkable
 * is found within StepDownHeight below the sphere while moving
 * (Transition.cs:462 StepDown; ObjectInfo.cs:47 pulls the value from the
 * Setup). Ground further below than this in one movement step means
 * contact is lost — the player falls rather than snaps down.
 *
 * ACE computes this per-character as `Setup._dat.StepDownHeight * Scale.Z`
 * (PartArray.cs:240) — it genuinely differs by heritage (e.g. Olthoi
 * 0x02001a21 = 0.942, OlthoiAcid 0x02001a20 = 2.0). This human value is
 * only the fallback default for callers that haven't resolved the local
 * player's real SetupModel yet — see BUG.fall-detection-step-down-height-
 * hardcoded-human's fix in main.ts (playerStepDownHeight).
 */
export const PLAYER_STEP_DOWN_HEIGHT = 1.5;

/**
 * BUG.fall-detection-step-down-height-hardcoded-human — the real
 * per-character ground-contact threshold: `Setup.StepDownHeight * Scale.Z`
 * (ACE PartArray.cs:240 GetStepDownHeight), not the human-only
 * PLAYER_STEP_DOWN_HEIGHT constant. Falls back to the human default when
 * the caller hasn't resolved the player's real SetupModel yet (e.g. before
 * the first CreateObject arrives).
 */
export function resolvePlayerStepDownHeight(
  setup: { stepDownHeight: number } | null | undefined,
  scaleZ: number,
): number {
  return setup ? setup.stepDownHeight * scaleZ : PLAYER_STEP_DOWN_HEIGHT;
}

/**
 * TRUE when a grounded player moving onto `groundY` should transition to
 * falling. `prevFeetY` is the feet height of the last frame that had solid
 * ground under it (null right after teleports/corrections — no basis for a
 * delta), `groundY` the ground under the new position (null = not loaded).
 */
export function losesContact(
  prevFeetY: number | null,
  groundY: number | null,
  stepDownHeight: number = PLAYER_STEP_DOWN_HEIGHT,
): boolean {
  return prevFeetY !== null && groundY !== null && prevFeetY - groundY > stepDownHeight;
}

/**
 * TRUE when an airborne player has reached the ground: the absolute feet
 * height (launch base + integrated offset) is at or below the ground under
 * the current position. On flat ground (baseY === groundY) this reduces to
 * the classic offset <= 0; over a cliff edge the fall continues until the
 * feet reach the LOWER terrain.
 */
export function hasLanded(airborneBaseY: number, offsetY: number, groundY: number): boolean {
  return airborneBaseY + offsetY <= groundY;
}

/** Result of advancing an airborne player through one frame's physics chunks. */
export interface AirborneAdvance {
  /** Offset above airborneBaseY after the last simulated chunk (0 on landing). */
  offsetY: number;
  /** Vertical velocity after the last simulated chunk (0 on landing). */
  velocityY: number;
  /** Highest offset reached at any chunk boundary this frame. */
  peakY: number;
  /** Simulated time consumed (stops at the landing chunk). */
  airtime: number;
  /** TRUE when a chunk ended with the feet at or below the ground. */
  landed: boolean;
  /** Vertical velocity at the landing chunk's end (velocityY is 0 on landing); 0 when not landed. */
  impactVelocityY: number;
}

/**
 * BUG.flow-movement-outdoor-jump-height — step the airborne arc once per
 * physics chunk, checking for ground contact after each, as retail does:
 * CPhysicsObj::update_object splits a long frame into MAX_QUANTUM chunks
 * (retail 0.2 s; ACE's server 0.1 s) and runs UpdateObjectInternal —
 * integration AND the collision transition — on every one (ACE
 * PhysicsObj.cs:4175-4179). Integrating the
 * whole frame in one step and testing contact only at its end skipped the
 * apex whenever a frame ran long: a 0.79 s frame took a 0.35 m jump from
 * launch straight to below ground, so the character never left the grass.
 * `steps` is the frame's physicsQuantumSteps; `groundY` the ground under
 * the player's current position.
 */
export function advanceAirborne(
  airborneBaseY: number,
  offsetY: number,
  velocityY: number,
  steps: readonly number[],
  groundY: number,
  gravity: number,
): AirborneAdvance {
  let y = offsetY;
  let vy = velocityY;
  let peakY = y;
  let airtime = 0;
  for (const dt of steps) {
    ({ y, velocityY: vy } = integrateAirborneStep(y, vy, dt, gravity));
    airtime += dt;
    peakY = Math.max(peakY, y);
    if (hasLanded(airborneBaseY, y, groundY)) {
      return { offsetY: 0, velocityY: 0, peakY, airtime, landed: true, impactVelocityY: vy };
    }
  }
  return { offsetY: y, velocityY: vy, peakY, airtime, landed: false, impactVelocityY: 0 };
}

/**
 * AGENT.walk-drops-jumps — where an airborne body's collision and floor search
 * start: its feet, not the ground under it. Retail moves a jumping body's
 * spheres where the body is (every transition, airborne or not, starts from
 * the object's own position: CPhysicsObj::UpdateObjectInternal @ 005156b0), so
 * a jump clears the far side of a gap and the side of a platform once the
 * feet are above them. Placing the spheres on the floor below (the pit's
 * bottom) stopped every gap jump at the pit's far wall, and a floor search
 * from there never found the far ledge.
 */
export function airborneReferenceY(airborne: boolean, airborneBaseY: number, offsetY: number, groundY: number): number {
  return airborne ? airborneBaseY + offsetY : groundY;
}

/**
 * The head of a rising body meets the floor of the level above (the body has
 * no ceiling collision of its own in the airborne step): it stops rising
 * there and its feet stay a body height under that floor. `floorAtHead` is
 * the walkable found searching down from the head (feet + height); one more
 * than 1 m above the feet is a floor over the body, not one it stands on or a
 * ramp under it. Without this, searching the floor from the feet would land a
 * high jump on the floor above.
 */
export function headroomClamp(feetY: number, velocityY: number, floorAtHead: number | null, height: number): { feetY: number; velocityY: number; hit: boolean } {
  if (velocityY <= 0 || floorAtHead === null || floorAtHead <= feetY + 1) return { feetY, velocityY, hit: false };
  return { feetY: Math.min(feetY, floorAtHead - height), velocityY: 0, hit: true };
}
