/**
 * RECON.transition-stepup-stepdown-port.a — the player in contact with a
 * plane it cannot stand on (a steep terrain face): retail slides it down the
 * plane under gravity instead of letting it walk.
 *
 * Retail / ACE, in order:
 *  - CPhysicsObj::SetPositionInternal (ACE PhysicsObj.cs:1171-1256): a
 *    contact plane whose Normal.Z < FloorZ clears OnWalkable
 *    (set_on_walkable(false)); losing OnWalkable from walkable ground runs
 *    MovementManager::LeaveGround (CMotionInterp::LeaveGround: the velocity
 *    becomes get_leave_ground_velocity, the forward motion becomes Falling).
 *  - calc_acceleration (PhysicsObj.cs:2073): Contact without OnWalkable is
 *    gravity, (0, 0, -9.8); calc_friction (PhysicsObj.cs:2120) returns at
 *    once off a walkable, so nothing slows the slide.
 *  - UpdatePhysicsInternal (PhysicsObj.cs:1834): movement =
 *    Acceleration * ½q² + Velocity * q, then Velocity += Acceleration * q,
 *    with |Velocity| clamped to MaxVelocity (50).
 *  - UpdatePositionInternal (PhysicsObj.cs:1863-1875): off a walkable the
 *    animation's offset is multiplied by 0 — the held movement keys move
 *    nothing (turning still turns).
 *  - CTransition::adjust_offset (ACE Transition.cs:34): with a valid contact
 *    plane an offset into it (offset · N <= 0) loses its normal component —
 *    the fall becomes a slide along the plane — and one away from it is
 *    snapped onto it.
 *  - handle_all_collisions (PhysicsObj.cs:2656): a collision normal bounces
 *    the velocity, v += N * -((v · N) * (Elasticity + 1)) (player Elasticity
 *    = DefaultElasticity 0.05).
 *  - The slide ends on a walkable plane: set_on_walkable(true) →
 *    MovementManager::HitGround.
 *  - Stuck: CTransition::validate_transition (ACE Transition.cs:980-1057)
 *    counts the transitions of a gravity object that end where they started
 *    (FramesStationaryFall); the third substitutes a level contact plane
 *    (Normal = +Z), so the object stands (OnWalkable → HitGround), and the
 *    StationaryStuck flag keeps that until a transition moves it again. A
 *    stationary transition also stops the velocity (ObjectInfo.StopVelocity).
 *
 * Retail decomp agrees: CPhysicsObj::UpdatePositionInternal @ 00512c30
 * multiplies the part-array offset by 0 when (transient_state & 2) — OnWalkable
 * — is clear; set_on_walkable @ 00511310; calc_acceleration @ 00510950;
 * UpdatePhysicsInternal clamps to max_velocity (50) and zeroes under
 * small_velocity (0.25).
 *
 * Axes here are three.js (Y up): AC (x, y, z) = three (x, z, y).
 *
 * Deviation, documented: UpdatePhysicsInternal zeroes a velocity under
 * SmallVelocity (0.25 m/s) before moving. Retail's physics quantum is never
 * under MIN_QUANTUM (1/30 s), so one gravity quantum from rest already
 * reaches 9.8 / 30 = 0.33 m/s and the rule never stops a slide. Our substeps
 * follow the render frame (PhysicsQuantum.ts), and at 60 fps one gravity
 * quantum (0.16 m/s) would be zeroed every frame — a slide that never
 * starts. The slide therefore integrates without that rule.
 */

/** PhysicsGlobals.Gravity, m/s² (AC −Z = three −Y). */
export const SLIDE_GRAVITY = -9.8;
/** PhysicsGlobals.MaxVelocity, m/s. */
export const MAX_VELOCITY = 50;
/** PhysicsGlobals.DefaultElasticity — CPhysicsObj's elasticity unless the weenie sets one. */
export const DEFAULT_ELASTICITY = 0.05;
/** FramesStationaryFall reaches 3 (StationaryStuck) on the third stationary transition. */
export const STATIONARY_STUCK_FRAMES = 3;

export interface Vec3 { x: number; y: number; z: number }

/** handle_all_collisions' bounce of `v` off the plane normal `n` (both three.js axes). */
export function bounceVelocity(v: Vec3, n: Vec3, elasticity = DEFAULT_ELASTICITY): Vec3 {
  const angle = v.x * n.x + v.y * n.y + v.z * n.z;
  if (angle >= 0) return { ...v };
  const k = -(angle * (elasticity + 1));
  return { x: v.x + n.x * k, y: v.y + n.y * k, z: v.z + n.z * k };
}

/**
 * One physics quantum of a body in contact with the unwalkable plane `n`:
 * UpdatePhysicsInternal's movement and velocity, then adjust_offset's
 * contact-plane projection of the movement. Returns the offset to move
 * (its horizontal part goes through the collision world; the feet follow the
 * terrain) and the new velocity.
 */
export function slideStep(velocity: Vec3, n: Vec3, dt: number): { offset: Vec3; velocity: Vec3 } {
  let v = velocity;
  const mag2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (mag2 > MAX_VELOCITY * MAX_VELOCITY) {
    const s = MAX_VELOCITY / Math.sqrt(mag2);
    v = { x: v.x * s, y: v.y * s, z: v.z * s };
  }
  const o = {
    x: v.x * dt,
    y: v.y * dt + SLIDE_GRAVITY * 0.5 * dt * dt,
    z: v.z * dt,
  };
  const into = o.x * n.x + o.y * n.y + o.z * n.z;
  let offset: Vec3;
  if (into <= 0) {
    offset = { x: o.x - n.x * into, y: o.y - n.y * into, z: o.z - n.z * into };
  } else {
    // Plane::snap_to_plane: keep the horizontal offset, put it on the plane.
    offset = { x: o.x, y: n.y !== 0 ? -(n.x * o.x + n.z * o.z) / n.y : 0, z: o.z };
  }
  return { offset, velocity: { x: v.x, y: v.y + SLIDE_GRAVITY * dt, z: v.z } };
}

/** The player's contact-without-walkable state between frames. */
export interface SlopeContactState {
  /** CPhysicsObj::m_velocityVector while sliding (three.js axes); null = on a walkable. */
  velocity: Vec3 | null;
  /** COLLISIONINFO::frames_stationary_fall, counted over the slide's substeps. */
  stationaryFrames: number;
  /** TransientState StationaryStuck: standing on the level plane validate_transition substituted. */
  stuck: boolean;
}

export function initialSlopeContact(): SlopeContactState {
  return { velocity: null, stationaryFrames: 0, stuck: false };
}

/**
 * The end of a frame for a grounded (in-contact) player: SetPositionInternal's
 * OnWalkable decision. `unwalkable` = the contact plane is a terrain face with
 * Normal.Z < FloorZ; `moved` = the frame's transitions moved the player;
 * `leaveGroundVelocity` = get_leave_ground_velocity (read only on entry).
 * `event` is the MovementManager call the change makes: 'leave'
 * (LeaveGround — walkable lost) or 'hit' (HitGround — walkable regained).
 */
export function resolveSlopeContact(
  state: SlopeContactState,
  unwalkable: boolean,
  moved: boolean,
  leaveGroundVelocity: () => Vec3,
): { state: SlopeContactState; event: 'leave' | 'hit' | null } {
  if (!unwalkable) {
    return { state: initialSlopeContact(), event: state.velocity ? 'hit' : null };
  }
  if (state.velocity) {
    if (state.stationaryFrames >= STATIONARY_STUCK_FRAMES) {
      // The third stationary transition stands the body on a level plane.
      return { state: { velocity: null, stationaryFrames: 0, stuck: true }, event: 'hit' };
    }
    return { state, event: null };
  }
  // On a walkable (or stuck on the substituted level plane) until a
  // transition moves the body onto the steep face.
  if (state.stuck && !moved) return { state, event: null };
  return { state: { velocity: leaveGroundVelocity(), stationaryFrames: 0, stuck: false }, event: 'leave' };
}
