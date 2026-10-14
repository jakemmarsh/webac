/**
 * MissileRange — GAP.10: ACE-exact max missile range.
 *
 * Port of Creature_Missile.cs:406 GetMaxMissileRange:
 *   missileRange = MaximumVelocity² × 0.1020408163265306
 *   maxRange     = min(missileRange, MissileRangeCap)
 * with MissileRangeCap = 85 yards / 1.094 m-per-yard ≈ 77.697m
 * (Creature_Missile.cs:402-404) and DefaultMaxVelocity = 20 when the
 * weapon has no PropertyFloat.MaximumVelocity(26).
 *
 * ACE enforces this server-side (Player_Missile.cs:172 TargetInRange →
 * WeenieError.MissileOutOfRange transient); the client mirrors the check
 * in the live send path so out-of-range attacks are rejected locally with
 * the same transient instead of a wasted round-trip.
 */

export const METERS_TO_YARDS = 1.094;               // Creature_Missile.cs:402
export const MISSILE_RANGE_CAP = 85.0 / METERS_TO_YARDS; // :403 ≈ 77.697m
export const DEFAULT_MAX_VELOCITY = 20.0;           // :404

export function getMaxMissileRange(maximumVelocity: number | null | undefined): number {
  const maxVelocity = maximumVelocity ?? DEFAULT_MAX_VELOCITY;
  const missileRange = Math.pow(maxVelocity, 2.0) * 0.1020408163265306;
  return Math.min(missileRange, MISSILE_RANGE_CAP);
}

/**
 * The arc limit (AGENT.ranged-attack-range, 2026-10-12). TargetInRange above is only the server's first gate: at
 * launch ACE aims the missile with Trajectory.solve_ballistic_arc (Creature_Missile.GetProjectileVelocity, stationary
 * solver), from the launcher's spawn point (Height × ProjSpawnHeight over your feet) to the target's aim point
 * (target.Height / GetAimHeight over its feet), at GetProjectileSpeed. No arc (v⁴ − g(g·x² + 2·z·v²) < 0) answers
 * MissileOutOfRange too (Player_Missile "pre-check succeeded, but actual velocity calculation failed"), so uphill the
 * reach shrinks: a Shortbow (24.9 m/s) reaches only ~40 m across at +19 m.
 */
export const MISSILE_GRAVITY = 9.8;                 // PhysicsGlobals.Gravity
export const PROJ_SPAWN_HEIGHT = 0.8454;            // Creature_Missile.ProjSpawnHeight
export const FAST_MISSILE_MODIFIER = 1.2;           // PropertyManager fast_missile_modifier (retail 1.2)
export const PHYSICS_MAX_VELOCITY = 50.0;           // PhysicsGlobals.MaxVelocity

/** Creature_Missile.GetProjectileSpeed: the launcher's MaximumVelocity, × 1.2 with Use Fast Missiles, capped at 50. */
export function getProjectileSpeed(maximumVelocity: number | null | undefined, useFastMissiles = false): number {
  let v = maximumVelocity || DEFAULT_MAX_VELOCITY;
  if (useFastMissiles) v *= FAST_MISSILE_MODIFIER;
  return Math.min(v, PHYSICS_MAX_VELOCITY);
}

/** Player_Missile.GetAimHeight: the divisor of the target's height the missile is aimed at (high 1, medium 2, low 3). */
export function missileAimDivisor(height: 'high' | 'medium' | 'low'): number {
  return height === 'high' ? 1 : height === 'low' ? 3 : 2;
}

/**
 * The farthest ground distance a missile at `speed` reaches `rise` metres up (negative: down), from
 * solve_ballistic_arc's root: x = v·√(v² − 2·g·rise) / g; 0 when even straight up falls short.
 */
export function missileArcGroundReach(speed: number, rise: number): number {
  const v2 = speed * speed;
  const r = v2 - 2 * MISSILE_GRAVITY * rise;
  return r <= 0 ? 0 : (speed * Math.sqrt(r)) / MISSILE_GRAVITY;
}

export interface MissileShot {
  /** Feet to feet, 3D (Location.DistanceTo), and across the ground. */
  dist: number;
  ground: number;
  /** The aim point over the spawn point, metres. */
  rise: number;
  /** TargetInRange's limit (min(MaximumVelocity² / g, 85 yd)) and the arc's ground reach at this rise. */
  maxRange: number;
  arcReach: number;
  /** Both of the server's tests pass, with `margin` (0..1) of each limit to spare. */
  inRange: boolean;
}

/**
 * Would the server launch this shot (ACE TargetInRange, then the stationary solve_ballistic_arc)? `margin` 1 is the
 * server's own limits; 0.9 keeps a tenth in hand for a target that moves.
 */
export function missileShot(o: {
  dx: number; dy: number; dz: number; maximumVelocity: number | null | undefined; useFastMissiles?: boolean;
  shooterHeight: number; targetHeight: number; aim?: 'high' | 'medium' | 'low'; margin?: number;
}): MissileShot {
  const ground = Math.hypot(o.dx, o.dy);
  const dist = Math.hypot(ground, o.dz);
  const rise = o.dz + o.targetHeight / missileAimDivisor(o.aim ?? 'medium') - o.shooterHeight * PROJ_SPAWN_HEIGHT;
  const maxRange = getMaxMissileRange(o.maximumVelocity || null);
  const arcReach = missileArcGroundReach(getProjectileSpeed(o.maximumVelocity, o.useFastMissiles), rise);
  const m = o.margin ?? 1;
  return { dist, ground, rise, maxRange, arcReach, inRange: dist <= maxRange * m && ground <= arcReach * m };
}

/**
 * The radius of an arrow or bolt's physics sphere: Setup 0x02000124 (arrow) and 0x0200012A (bolt) both have one sphere
 * of 0.1 m (portal.dat), which ACE's GetProjectileRadius reads (Spheres[0].Radius × scale).
 */
export const DEFAULT_PROJECTILE_RADIUS = 0.1;

interface V3 { x: number; y: number; z: number }

/**
 * Trajectory.solve_ballistic_arc (the stationary solver), the low root: the launch velocity that carries a projectile
 * at `speed` from `from` to `to` under gravity 9.8, and its flight time. Null when no arc reaches (the root is negative)
 * or the points coincide.
 */
export function solveBallisticArc(from: V3, speed: number, to: V3): { velocity: V3; time: number } | null {
  const dx = to.x - from.x, dy = to.y - from.y, z = to.z - from.z;
  const x = Math.hypot(dx, dy);
  if ((x === 0 && z === 0) || speed <= 0) return null;
  const g = MISSILE_GRAVITY;
  const s2 = speed * speed;
  const root = s2 * s2 - g * (g * x * x + 2 * z * s2);
  if (root < 0) return null;
  const low = Math.atan2(s2 - Math.sqrt(root), g * x);
  const gx = x > 0 ? dx / x : 0, gy = x > 0 ? dy / x : 0;
  const c = Math.cos(low) * speed;
  return { velocity: { x: gx * c, y: gy * c, z: Math.sin(low) * speed }, time: x > 0 ? x / c : Math.abs(z) / speed };
}

/**
 * Creature_Missile.GetAimLevel's angle: the aim velocity's normalized z × 90 (not an arcsine), snapped to the
 * AimLevel / AimHigh15..90 / AimLow15..90 motions' 15° steps (MotionCommand.GetAimAngle).
 */
export function missileAimLevelDeg(velocity: V3): number {
  const len = Math.hypot(velocity.x, velocity.y, velocity.z);
  const zAngle = len > 0 ? (velocity.z / len) * 90 : 0;
  // >= 82.5 → 90, >= 67.5 → 75, … >= 7.5 → 15; > -7.5 → level; > -22.5 → -15, … > -82.5 → -75; else -90.
  for (let deg = 90; deg >= 15; deg -= 15) if (zAngle >= deg - 7.5) return deg;
  for (let deg = 0; deg >= -75; deg -= 15) if (zAngle > deg - 7.5) return deg;
  return -90;
}

export interface MissileArc {
  /** Where ACE spawns the projectile (GetProjectileSpawnOrigin, turned toward the target): global metres, z up. */
  origin: V3;
  /** The launch velocity (the stationary solve_ballistic_arc from the origin to the aim point) and the flight time. */
  velocity: V3;
  time: number;
  /** The aim point: the target's feet + its height / GetAimHeight. */
  aim: V3;
  /** The aim motion's angle (degrees, 15° steps) the spawn point is tilted by. */
  aimLevelDeg: number;
}

/**
 * The path ACE flies an arrow, bolt or thrown weapon along (Player_Missile.LaunchMissile): the aim velocity from your
 * feet + Height × ProjSpawnHeight to the aim point picks the aim motion (GetAimLevel); the projectile spawns
 * 2 × (your physics radius + its own) in front of you, tilted by that motion's angle, at Height × ProjSpawnHeight
 * (GetProjectileSpawnOrigin, turned to face the target: CalculateProjectileVelocity); and it is launched on the low
 * ballistic arc from there to the aim point. Null when no arc reaches (the server's "Out of Range!").
 * `from` / `to` are the shooter's and target's feet, global metres, z up.
 */
export function missileArc(o: {
  from: V3; to: V3; speed: number; shooterHeight: number; shooterRadius: number; targetHeight: number;
  aim?: 'high' | 'medium' | 'low'; projectileRadius?: number;
}): MissileArc | null {
  const aim = { x: o.to.x, y: o.to.y, z: o.to.z + o.targetHeight / missileAimDivisor(o.aim ?? 'medium') };
  const eye = { x: o.from.x, y: o.from.y, z: o.from.z + o.shooterHeight * PROJ_SPAWN_HEIGHT };
  const aimShot = solveBallisticArc(eye, o.speed, aim);
  if (!aimShot) return null;
  const aimLevelDeg = missileAimLevelDeg(aimShot.velocity);
  const radsum = o.shooterRadius * 2 + (o.projectileRadius ?? DEFAULT_PROJECTILE_RADIUS) * 2;
  const gdx = o.to.x - o.from.x, gdy = o.to.y - o.from.y;
  const gl = Math.hypot(gdx, gdy);
  const fx = gl > 0 ? gdx / gl : 0, fy = gl > 0 ? gdy / gl : 1;
  const a = (aimLevelDeg * Math.PI) / 180;
  const origin = {
    x: o.from.x + fx * radsum * Math.cos(a),
    y: o.from.y + fy * radsum * Math.cos(a),
    z: o.from.z + radsum * Math.sin(a) + o.shooterHeight * PROJ_SPAWN_HEIGHT,
  };
  const shot = solveBallisticArc(origin, o.speed, aim);
  if (!shot) return null;
  return { origin, velocity: shot.velocity, time: shot.time, aim, aimLevelDeg };
}

/** Where a projectile on `arc` is `t` seconds after launch (gravity 9.8 down). */
export function missileArcPoint(arc: Pick<MissileArc, 'origin' | 'velocity'>, t: number): V3 {
  return {
    x: arc.origin.x + arc.velocity.x * t,
    y: arc.origin.y + arc.velocity.y * t,
    z: arc.origin.z + arc.velocity.z * t - 0.5 * MISSILE_GRAVITY * t * t,
  };
}

/** ACE WorldObject_Magic.ProjHeight: a war or life bolt leaves at, and aims at, two thirds of the caster's / target's Height. */
export const SPELL_PROJ_HEIGHT = 2 / 3;
/** CalculateProjectileOrigins: a target within this cylinder distance (m) gets the bolt spawned one radius sum ahead, not two. */
export const SPELL_PROJ_CLOSE_CYL_DIST = 0.6;

/**
 * ACE Position.CylinderDistance: the gap between two upright cylinders (feet at `a` / `b`, global metres, z up); negative
 * when they overlap.
 */
export function cylinderDistance(a: V3, aRadius: number, aHeight: number, b: V3, bRadius: number, bHeight: number): number {
  const reach = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) - (aRadius + bRadius);
  const diffZ = a.z <= b.z ? b.z - (a.z + aHeight) : a.z - (b.z + bHeight);
  if (diffZ > 0 && reach > 0) return Math.hypot(diffZ, reach);
  if (diffZ < 0 && reach < 0) return -Math.hypot(diffZ, reach);
  return reach;
}

/** Where the server starts a targeted bolt and where it sends it ({@link boltLaunch}). */
export interface BoltLaunch {
  /** The spawn point (global, z up). */
  origin: V3;
  /** The point it flies straight at: the target's feet + Height × 2/3. */
  aim: V3;
  /** Where ACE's IsProjectileVisible looks back to from the spawn point: your feet + your Height less the bolt's own. */
  eye: V3;
  /** The target was within 0.6 m (cylinder distance): the bolt spawned one radius sum ahead of you, not two. */
  close: boolean;
}

/**
 * Where ACE launches a single targeted spell projectile (a war bolt, streak or life projectile with no spread, CreateOffset
 * 0, not a Strike or Arc), from the server's own maths (WorldObject_Magic.cs):
 * - CalculatePreOffset: start at your Height × 2/3, then tilt the spawn toward the target's Height × 2/3 point by
 *   (your physics radius + the bolt's radius);
 * - CalculateProjectileOrigins: 2 × that radius sum ahead of you, or 1 × when the target's cylinder is within 0.6 m;
 * - CalculateProjectileVelocity: straight from there at the target's feet + Height × 2/3 (no lead for a still target);
 * - LaunchSpellProjectiles → IsProjectileVisible: the spawn point must see back to your eye (feet + Height − the bolt's
 *   Height), else the server drops the bolt as "hit the environment" and tells you nothing.
 * Facing plays no part: ACE turns the offsets toward the target. `from` / `to` are the feet, global metres, z up;
 * `casterRadius` / `targetRadius` the Setup radii (GetRadius, for the cylinder distance), `casterPhysicsRadius` the
 * first collision sphere's (GetPhysicsRadius: 0.48 for a human, where the Setup radius is 0.68).
 */
export function boltLaunch(o: {
  from: V3; to: V3;
  casterHeight: number; casterRadius: number; casterPhysicsRadius: number;
  targetHeight: number; targetRadius: number;
  projectileRadius?: number; projectileHeight?: number;
}): BoltLaunch {
  const pr = o.projectileRadius ?? DEFAULT_PROJECTILE_RADIUS;
  const startZ = o.from.z + o.casterHeight * SPELL_PROJ_HEIGHT;
  const aim = { x: o.to.x, y: o.to.y, z: o.to.z + o.targetHeight * SPELL_PROJ_HEIGHT };
  const gdx = aim.x - o.from.x, gdy = aim.y - o.from.y, gdz = aim.z - startZ;
  const ground = Math.hypot(gdx, gdy);
  const len = Math.hypot(ground, gdz);
  // localDir: the start → aim direction in the frame turned to face the target (x across, y ahead, z up).
  const dirY = len > 0 ? ground / len : 1, dirZ = len > 0 ? gdz / len : 0;
  const rs = o.casterPhysicsRadius + pr;
  const close = cylinderDistance(o.from, o.casterRadius, o.casterHeight, o.to, o.targetRadius, o.targetHeight) < SPELL_PROJ_CLOSE_CYL_DIST;
  const radsum = close ? rs : rs * 2;
  const ahead = radsum + rs * dirY - rs;
  const up = o.casterHeight * SPELL_PROJ_HEIGHT + rs * dirZ;
  const fx = ground > 0 ? gdx / ground : 0, fy = ground > 0 ? gdy / ground : 1;
  const origin = { x: o.from.x + fx * ahead, y: o.from.y + fy * ahead, z: o.from.z + up };
  const eye = { x: o.from.x, y: o.from.y, z: o.from.z + o.casterHeight - (o.projectileHeight ?? pr * 2) };
  return { origin, aim, eye, close };
}
