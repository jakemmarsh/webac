/**
 * BUG.remote-running-jump-snapback — the velocity a body keeps on walkable
 * ground after a landing, and how friction takes it away.
 *
 * Retail never zeroes a body's velocity when it lands. `CPhysicsObj::
 * set_on_walkable @ 00511310` → `MovementManager::HitGround` →
 * `CMotionInterp::HitGround @ 00528ac0` only drops the link animations and
 * re-applies the current motion; `handle_all_collisions @ 00514780` reflects
 * the velocity off the ground's collision normal (the vertical part, with
 * elasticity 0.05), and from then on every physics quantum
 * (`UpdatePhysicsInternal @ 00510700`) runs `calc_friction @ 0050ee70` on the
 * walkable contact plane: v *= (1 − friction)^quantum with friction 0.95, and
 * a velocity under small_velocity (0.25 m/s) is zeroed. The animation's own
 * offset (the run cycle) is added on top in the same frame
 * (`UpdatePositionInternal @ 00512c30`). So a running jump carries on
 * ∫ v·0.05^t dt = v / ln 20 ≈ v / 3 metres past the landing (2.2 m for a
 * 6.54 m/s run), the same on the jumper's own client and on every observer's
 * copy (RemotePhysics, which ports the same functions).
 *
 * The retail A/B capture shows it: `sweep-jump-W-releaseair`
 * (tests/fixtures/movement-ab/retail-sweep-2026-10-08.json) lands at about
 * 8.8 m with the key already up and rests at 10.93 m — 2.1 m of coast.
 *
 * Our local player used to drop its horizontal jump velocity on landing, so
 * its reported positions ended v / ln 20 short of where every observer's
 * (retail-correct) copy coasted to: the copy then snapped back.
 *
 * Axes are the local movement's (three.js x / z, metres per second).
 */

/** `DEFAULT_FRICTION` (CPhysicsObj::friction). */
export const DEFAULT_FRICTION = 0.95;
/** `small_velocity` (m/s): a velocity this slow is zeroed. */
export const SMALL_VELOCITY = 0.25;
/** `F_EPSILON`. */
const F_EPSILON = 0.0002;

/** The horizontal velocity a grounded body still carries (three.js x / z, m/s). */
export interface GroundVelocity { x: number; z: number }

/**
 * The velocity left after the landing: HitGround keeps it, and the landing's
 * collision (handle_all_collisions) and calc_friction's plane projection take
 * out only the part into the ground. Null when nothing is left.
 */
export function landingGroundVelocity(vx: number, vz: number): GroundVelocity | null {
  if (!Number.isFinite(vx) || !Number.isFinite(vz)) return null;
  if (vx === 0 && vz === 0) return null;
  return { x: vx, z: vz };
}

/**
 * One physics quantum of `UpdatePhysicsInternal` for a body on a walkable
 * plane: calc_friction damps the velocity, a velocity whose magnitude (read
 * before the friction, as retail reads it) is under small_velocity becomes 0,
 * and the body moves velocity × quantum. Returns that offset and the velocity
 * for the next quantum (null = it has stopped).
 */
export function coastQuantum(v: GroundVelocity, quantum: number, friction = DEFAULT_FRICTION): { dx: number; dz: number; velocity: GroundVelocity | null } {
  const v2 = v.x * v.x + v.z * v.z;
  if (!(quantum > 0) || v2 <= 0) return { dx: 0, dz: 0, velocity: v2 > 0 ? v : null };
  if (v2 - SMALL_VELOCITY * SMALL_VELOCITY < F_EPSILON) return { dx: 0, dz: 0, velocity: null };
  const k = Math.pow(1 - friction, quantum);
  const nx = v.x * k, nz = v.z * k;
  return { dx: nx * quantum, dz: nz * quantum, velocity: { x: nx, z: nz } };
}

/**
 * handle_all_collisions' bounce off a wall the coast ran into (collision
 * normal, horizontal): v −= (1 + elasticity)(v · n) n when moving into it.
 */
export function bounceGroundVelocity(v: GroundVelocity, n: { x: number; z: number }, elasticity = 0.05): GroundVelocity | null {
  const dot = v.x * n.x + v.z * n.z;
  if (dot >= 0) return v;
  const k = -(1 + elasticity) * dot;
  const out = { x: v.x + n.x * k, z: v.z + n.z * k };
  return out.x === 0 && out.z === 0 ? null : out;
}

/** The distance a coast from speed `v` (m/s) covers until friction stops it, m (continuous: v / ln(1 / (1 − friction))). */
export function coastDistance(v: number, friction = DEFAULT_FRICTION): number {
  return v / Math.log(1 / (1 - friction));
}
