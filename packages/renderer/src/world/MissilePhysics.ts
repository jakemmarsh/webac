/**
 * MissilePhysics — the retail client's local simulation of a server-created
 * missile (spell projectile, arrow, thrown weapon): BUG.spell-projectile-physics.
 *
 * The server launches a missile ONCE — CreateObject with the Missile
 * PhysicsState bit, a world velocity and (for spinning projectiles) omega —
 * and never streams its flight: ACE's WorldObject_Tick.UpdateObjectPhysics
 * runs the projectile's PhysicsObj server-side but its SendUpdatePosition is
 * commented out. Every client flies the object itself with CPhysicsObj
 * (reference/client-eol, build ac1_sep13):
 *
 *  - `CPhysicsObj::update_object` @ 00515d10 — the frame's elapsed time is
 *    dropped when under F_EPSILON or over HUGE_QUANTUM (2 s), stepped in
 *    MAX_QUANTUM (1 / MIN_FRAMERATE = 0.2 s) chunks when long, and a
 *    remainder of at most MIN_QUANTUM (1 / MAX_FRAMERATE) is carried to the
 *    next frame (update_time is only advanced by the simulated time).
 *  - `CPhysicsObj::calc_acceleration` @ 00510950 — acceleration is
 *    (0, 0, PhysicsGlobals::gravity = −9.8) ONLY when the Gravity state bit
 *    (0x400) is set, zero otherwise. ACE sets Gravity on a spell projectile
 *    only for ProjectileSpellType.Arc (SpellProjectile.SetProjectilePhysicsState
 *    `if (useGravity) GravityStatus = true`, useGravity = spellType == Arc in
 *    WorldObject_Magic.LaunchSpellProjectiles): bolts, streaks, blasts,
 *    volleys, rings and walls fly dead straight.
 *  - `CPhysicsObj::UpdatePhysicsInternal` @ 00510700 — velocity clamped to
 *    max_velocity (50), zeroed under small_velocity (0.25), movement
 *    `v·q + ½·a·q²`, then `v += a·q`, then `Frame::grotate(ω·q)` (a rotation
 *    about the GLOBAL axes: q' = r(ω·q) · q, @ 005357a0).
 *  - `CPhysicsObj::UpdateObjectInternal` @ 005156b0 — with AlignPath (0x100)
 *    the new frame's heading is `Frame::set_vector_heading(newPos − oldPos)`
 *    (local +Y along the path, no roll). The move then goes through
 *    `transition()` — collision against the world — and ONLY when the object's
 *    Setup has collision spheres (no spheres → the frame is set with no
 *    collision at all).
 *  - `CPhysicsObj::handle_all_collisions` @ 00514780 +
 *    `report_environment_collision` @ 00512fc0 / `report_object_collision`
 *    @ 00513060 — on contact a Missile loses Missile | AlignPath | PathClipped
 *    (`state & 0xfffffcbf`); its velocity is zeroed when Inelastic (0x20000,
 *    which every ACE spell projectile carries) and otherwise reflected off the
 *    contact normal with (elasticity + 1). A Missile that hits an OBJECT
 *    raises an AtkCollisionProfile → `ACCWeenieObject::DoCollision` @ 0058c3a0
 *    plays the object's PhysicsDesc default script when ScriptedCollision
 *    (0x8000) is set (ACE: DefaultScriptId = PlayScript.ProjectileCollision
 *    for bolts/streaks/arcs/volleys/blasts).
 *
 * The server's own verdict follows over the wire (SpellProjectile.
 * ProjectileImpact): SetState Ethereal|NoDraw|Cloaked…, PlayScript Explode,
 * VectorUpdate(0), and a DeleteObject 5 s later — or, for a missile that hit
 * nothing, a DeleteObject at the 30 s ProjectileTimeout. Nothing here homes
 * on a target: a missile that the target sidestepped keeps flying.
 *
 * All vectors are AC world axes (X east, Y north, Z up; landblock-global
 * metres, i.e. THREE (x, y, z) = AC (x, z, y)).
 */
import { PhysicsState } from '@ac/shared';

/** PhysicsGlobals::gravity (globals.tsv, .data 0x82122c). */
export const PHYSICS_GRAVITY = -9.8;
/** max_velocity. */
export const MAX_VELOCITY = 50;
/** small_velocity. */
export const SMALL_VELOCITY = 0.25;
/** F_EPSILON. */
export const F_EPSILON = 0.0002;
/** HUGE_QUANTUM (s). */
export const HUGE_QUANTUM = 2;
/** MAX_QUANTUM = 1 / MIN_FRAMERATE (5). */
export const MAX_QUANTUM = 1 / 5;
/** MIN_QUANTUM = 1 / MAX_FRAMERATE (30). */
export const MIN_QUANTUM = 1 / 30;
/** DEFAULT_ELASTICITY — CPhysicsObj's elasticity when the PhysicsDesc carries none. */
export const DEFAULT_ELASTICITY = 0.05;

/** State bits a Missile drops on its first contact (`state & 0xfffffcbf`). */
const MISSILE_CONTACT_CLEAR = PhysicsState.Missile | PhysicsState.AlignPath | PhysicsState.PathClipped;

export interface V3 { x: number; y: number; z: number }
/** AC quaternion (w, x, y, z), as on the wire. */
export interface Quat { w: number; x: number; y: number; z: number }

export interface MissileBody {
  pos: V3;
  vel: V3;
  omega: V3;
  orient: Quat;
  /** The object's PhysicsState; the server's SetState replaces it. */
  state: number;
  elasticity: number;
  /** Collision sphere radius (Setup sphere[0] × scale); 0 = no spheres → no collision. */
  radius: number;
  /** Unsimulated time carried from the last frame (≤ MIN_QUANTUM). */
  carry: number;
}

/** A contact found along a move: fraction `t` of the move, AC-space unit normal, and the object hit (if any). */
export interface MissileContact {
  t: number;
  normal: V3 | null;
  objectGuid?: number;
  /**
   * The object hit has IgnoreCollisions: it stops the missile (the
   * collision normal is valid) but `report_object_collision` reports
   * nothing — no attack profile, and the Missile bits stay.
   */
  silent?: boolean;
}

/**
 * How another object obstructs a missile — `CPhysicsObj::FindObjCollisions`
 * @ 0050f050 (run on the OTHER object with the missile's transition),
 * `OBJECTINFO::missile_ignore` @ 0050ceb0 and `report_object_collision`
 * @ 00513060:
 *  - `ignore`: another Missile (missile_ignore: missiles never hit
 *    missiles); an Ethereal object (missile_ignore's Ethereal-weenie test;
 *    a BSP object's `obstruction_ethereal` step yields OK_TS); an ethereal
 *    missile against anything but a Static object (the same
 *    `obstruction_ethereal` rule — ACE's ProjectileImpact SetState makes a
 *    spent missile Ethereal). The retail client's OBJECTINFO targetID is
 *    always 0 (only ever zeroed), so the creature-exemption clause of
 *    missile_ignore never applies client-side: a missile collides with any
 *    solid creature, not just its target.
 *  - `environment`: a Static object (FindObjCollisions sets
 *    collided_with_environment instead of adding the object) or one with
 *    ReportCollisionsAsEnvironment (report_object_collision forwards to
 *    report_environment_collision).
 *  - `object-silent`: IgnoreCollisions — the object stops the missile but
 *    report_object_collision reports nothing and keeps the Missile bits.
 *  - `object`: everything else — an object collision (AtkCollisionProfile).
 */
export type MissileObstacleKind = 'ignore' | 'environment' | 'object' | 'object-silent';

export function classifyMissileObstacle(otherState: number, missileState: number): MissileObstacleKind {
  if (otherState & PhysicsState.Missile) return 'ignore';
  if (otherState & PhysicsState.Ethereal) return 'ignore';
  const isStatic = (otherState & PhysicsState.Static) !== 0;
  if ((missileState & PhysicsState.Ethereal) && !isStatic) return 'ignore';
  if (isStatic || (otherState & PhysicsState.ReportCollisionsAsEnvironment)) return 'environment';
  if (otherState & PhysicsState.IgnoreCollisions) return 'object-silent';
  return 'object';
}

/** Tag a contact with how its object obstructs (classifyMissileObstacle); null for `ignore`. */
export function applyObstacleKind(contact: MissileContact | null, kind: MissileObstacleKind, guid: number): MissileContact | null {
  if (!contact || kind === 'ignore') return null;
  if (kind === 'environment') return { t: contact.t, normal: contact.normal };
  return { t: contact.t, normal: contact.normal, objectGuid: guid, ...(kind === 'object-silent' ? { silent: true } : {}) };
}

/** Sweep a sphere of `radius` from `from` to `to`; the first contact or null. */
export type MissileSweep = (from: V3, to: V3, radius: number) => MissileContact | null;

export interface MissileCollisionEvent {
  kind: 'environment' | 'object';
  objectGuid?: number;
  pos: V3;
  /** The retail client plays the object's default script for this contact (AtkCollision + ScriptedCollision). */
  playDefaultScript: boolean;
}

export function createMissileBody(init: {
  pos: V3; vel: V3; omega?: V3; orient: Quat; state: number; elasticity?: number; radius?: number;
}): MissileBody {
  return {
    pos: { ...init.pos },
    vel: { ...init.vel },
    omega: init.omega ? { ...init.omega } : { x: 0, y: 0, z: 0 },
    orient: { ...init.orient },
    state: init.state,
    elasticity: init.elasticity ?? DEFAULT_ELASTICITY,
    radius: init.radius ?? 0,
    carry: 0,
  };
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l };
}

/**
 * `Frame::grotate` @ 005357a0 — rotate by the rotation vector `rot` (axis ×
 * angle) about the GLOBAL axes: q' = r · q. Below F_EPSILON it is a no-op.
 */
export function grotate(q: Quat, rot: V3): Quat {
  const l2 = rot.x * rot.x + rot.y * rot.y + rot.z * rot.z;
  if (l2 < F_EPSILON * F_EPSILON) return q;
  const l = Math.sqrt(l2);
  const s = Math.sin(l * 0.5) / l;
  return quatNormalize(quatMul({ w: Math.cos(l * 0.5), x: rot.x * s, y: rot.y * s, z: rot.z * s }, q));
}

/**
 * `Frame::set_vector_heading` @ 00535db0 — the orientation whose local +Y
 * points along `dir` with no roll: yaw about Z, then pitch asin(dir.z) about
 * the local X. Null when `dir` is too small to normalise.
 */
export function vectorHeadingQuat(dir: V3): Quat | null {
  const l = Math.hypot(dir.x, dir.y, dir.z);
  if (l < F_EPSILON) return null;
  const nx = dir.x / l, ny = dir.y / l, nz = Math.max(-1, Math.min(1, dir.z / l));
  const yaw = Math.atan2(-nx, ny);
  const pitch = Math.asin(nz);
  const qz: Quat = { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) };
  const qx: Quat = { w: Math.cos(pitch / 2), x: Math.sin(pitch / 2), y: 0, z: 0 };
  return quatNormalize(quatMul(qz, qx));
}

/** Rotate `v` by `q`. */
export function quatRotateV3(q: Quat, v: V3): V3 {
  const p = quatMul(quatMul(q, { w: 0, x: v.x, y: v.y, z: v.z }), { w: q.w, x: -q.x, y: -q.y, z: -q.z });
  return { x: p.x, y: p.y, z: p.z };
}

/** One UpdateObjectInternal quantum. */
export function stepMissileQuantum(body: MissileBody, q: number, sweep: MissileSweep | null, events: MissileCollisionEvent[]): void {
  // UpdatePositionInternal: a Hidden object runs no physics.
  if (body.state & PhysicsState.Hidden) return;
  const az = (body.state & PhysicsState.Gravity) ? PHYSICS_GRAVITY : 0;
  const v = body.vel;
  let v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  const from = body.pos;
  let to = from;
  if (v2 > 0) {
    if (v2 > MAX_VELOCITY * MAX_VELOCITY) {
      const k = MAX_VELOCITY / Math.sqrt(v2);
      v.x *= k; v.y *= k; v.z *= k;
      v2 = MAX_VELOCITY * MAX_VELOCITY;
    }
    if (v2 - SMALL_VELOCITY * SMALL_VELOCITY < F_EPSILON) { v.x = 0; v.y = 0; v.z = 0; }
    to = { x: from.x + v.x * q, y: from.y + v.y * q, z: from.z + v.z * q + 0.5 * az * q * q };
  }
  v.z += az * q;
  body.orient = grotate(body.orient, { x: body.omega.x * q, y: body.omega.y * q, z: body.omega.z * q });
  if (to === from || (to.x === from.x && to.y === from.y && to.z === from.z)) return;
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  if (body.state & PhysicsState.AlignPath) {
    const h = vectorHeadingQuat(delta);
    if (h) body.orient = h;
  }
  const contact = body.radius > 0 && sweep ? sweep(from, to, body.radius) : null;
  if (!contact) { body.pos = to; return; }
  const t = Math.max(0, Math.min(1, contact.t));
  body.pos = { x: from.x + delta.x * t, y: from.y + delta.y * t, z: from.z + delta.z * t };
  const wasMissile = (body.state & PhysicsState.Missile) !== 0;
  const isObject = contact.objectGuid !== undefined;
  events.push({
    kind: isObject ? 'object' : 'environment',
    objectGuid: contact.objectGuid,
    pos: { ...body.pos },
    playDefaultScript: isObject && wasMissile && !contact.silent
      && (body.state & PhysicsState.ReportCollisions) !== 0
      && (body.state & PhysicsState.ScriptedCollision) !== 0,
  });
  // report_object_collision leaves the Missile bits on a hit against an
  // IgnoreCollisions object (it returns before `state & 0xfffffcbf`).
  if (wasMissile && !contact.silent) body.state &= ~MISSILE_CONTACT_CLEAR;
  if (contact.normal) {
    if (body.state & PhysicsState.Inelastic) {
      v.x = 0; v.y = 0; v.z = 0;
    } else {
      const n = contact.normal;
      const d = v.x * n.x + v.y * n.y + v.z * n.z;
      if (d < 0) {
        const k = -(body.elasticity + 1) * d;
        v.x += k * n.x; v.y += k * n.y; v.z += k * n.z;
      }
    }
  }
}

/**
 * `CPhysicsObj::update_object` — advance `body` by one frame's `dt`,
 * quantised like retail. Returns the contacts made this frame.
 */
export function advanceMissile(body: MissileBody, dt: number, sweep: MissileSweep | null): MissileCollisionEvent[] {
  const events: MissileCollisionEvent[] = [];
  let remaining = dt + body.carry;
  body.carry = 0;
  if (remaining < F_EPSILON || remaining > HUGE_QUANTUM) return events;
  if (remaining >= MAX_QUANTUM) {
    do {
      stepMissileQuantum(body, MAX_QUANTUM, sweep, events);
      remaining -= MAX_QUANTUM;
    } while (remaining > MAX_QUANTUM);
    if (remaining <= MIN_QUANTUM) { body.carry = remaining; return events; }
  }
  stepMissileQuantum(body, remaining, sweep, events);
  return events;
}

/** AC orientation → THREE quaternion components (x, y, z, w) — the same mapping CreateObject/UpdatePosition use. */
export function acQuatToThree(q: Quat): [number, number, number, number] {
  return [-q.x, -q.z, -q.y, q.w];
}

/**
 * Sweep a sphere against vertical cylinders (creatures): the first entry
 * along from→to. `cylinders` give base centre (AC) + radius + height.
 *
 * A cylinder the sphere already overlaps at `from`: retail
 * `CCylSphere::intersects_sphere` @ 0053b440 has no start exemption — it
 * tests the sphere at each step's check position, so an overlap collides
 * (collide_with_point). ACE spawns every spell missile outside its caster
 * (CalculateProjectileOrigins: radsum ≥ caster radius + missile radius), so
 * an overlap at launch means ANOTHER creature stands in the spawn spot —
 * live: a Ring of Fire missile born inside a drudge, which the server hit
 * 136 ms later. That overlap is a contact at t = 0 when the move heads
 * inward; a move heading outward (a missile leaving the body it grazes, or
 * our own cylinder when our local position lags the server's) passes.
 */
export function sweepCylinders(
  from: V3, to: V3, radius: number,
  cylinders: Iterable<{ guid: number; x: number; y: number; z: number; radius: number; height: number }>,
): MissileContact | null {
  let best: MissileContact | null = null;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  for (const c of cylinders) {
    const r = c.radius + radius;
    const bottom = c.z - radius, top = c.z + c.height + radius;
    const ox = from.x - c.x, oy = from.y - c.y;
    const inside0 = ox * ox + oy * oy < r * r && from.z >= bottom && from.z <= top;
    if (inside0) {
      if (ox * dx + oy * dy < 0 && (!best || best.t > 0)) {
        const l = Math.hypot(ox, oy);
        best = { t: 0, normal: l > 1e-9 ? { x: ox / l, y: oy / l, z: 0 } : null, objectGuid: c.guid };
      }
      continue;
    }
    let tHit = Infinity;
    let normal: V3 | null = null;
    // Side wall.
    const a = dx * dx + dy * dy;
    if (a > 1e-12) {
      const b = ox * dx + oy * dy;
      const cc = ox * ox + oy * oy - r * r;
      const disc = b * b - a * cc;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        if (t >= 0 && t <= 1) {
          const z = from.z + dz * t;
          if (z >= bottom && z <= top) {
            tHit = t;
            const hx = ox + dx * t, hy = oy + dy * t;
            const hl = Math.hypot(hx, hy) || 1;
            normal = { x: hx / hl, y: hy / hl, z: 0 };
          }
        }
      }
    }
    // Top / bottom caps.
    if (dz !== 0) {
      for (const [plane, nz] of [[top, 1], [bottom, -1]] as const) {
        const t = (plane - from.z) / dz;
        if (t < 0 || t > 1 || t >= tHit) continue;
        if ((nz === 1 && dz > 0) || (nz === -1 && dz < 0)) continue;
        const hx = ox + dx * t, hy = oy + dy * t;
        if (hx * hx + hy * hy <= r * r) { tHit = t; normal = { x: 0, y: 0, z: nz }; }
      }
    }
    if (tHit <= 1 && (!best || tHit < best.t)) best = { t: tHit, normal, objectGuid: c.guid };
  }
  return best;
}

/**
 * BUG.missile-creature-shape — the sphere half of a creature's collision
 * (CSphere::intersects_sphere, from CPhysicsObj::FindObjCollisions @ 0050f050
 * for a Setup with no CylSpheres): the first entry of the moving sphere into
 * any of `spheres` (AC centres). The start overlap follows sweepCylinders:
 * a contact at t = 0 when the move heads inward, a pass when it heads out.
 */
export function sweepSpheres(
  from: V3, to: V3, radius: number,
  spheres: Iterable<{ guid: number; x: number; y: number; z: number; radius: number }>,
): MissileContact | null {
  let best: MissileContact | null = null;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  for (const s of spheres) {
    const r = s.radius + radius;
    const ox = from.x - s.x, oy = from.y - s.y, oz = from.z - s.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const b = ox * dx + oy * dy + oz * dz;
    if (c < 0) {
      if (b < 0 && (!best || best.t > 0)) {
        const l = Math.sqrt(ox * ox + oy * oy + oz * oz);
        best = { t: 0, normal: l > 1e-9 ? { x: ox / l, y: oy / l, z: oz / l } : null, objectGuid: s.guid };
      }
      continue;
    }
    const a = dx * dx + dy * dy + dz * dz;
    if (a < 1e-12) continue;
    const disc = b * b - a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t < 0 || t > 1) continue;
    if (best && best.t <= t) continue;
    const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
    const l = Math.sqrt(hx * hx + hy * hy + hz * hz);
    best = { t, normal: l > 1e-9 ? { x: hx / l, y: hy / l, z: hz / l } : null, objectGuid: s.guid };
  }
  return best;
}

/**
 * Sweep a sphere over the landscape heightfield: `heightAt(x, y)` is the
 * terrain Z under AC (x, y) (null = not loaded → no contact). Stepped by the
 * sphere radius like CTransition; the contact is the first step whose sphere
 * dips below the surface, reported at the last free step.
 */
export function sweepHeightfield(
  from: V3, to: V3, radius: number,
  heightAt: (x: number, y: number) => number | null,
  normalAt: (x: number, y: number) => V3 | null,
): MissileContact | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0) || !(radius > 0)) return null;
  const n = Math.max(1, Math.ceil(len / radius));
  for (let i = 1; i <= n; i++) {
    const x = from.x + dx * (i / n), y = from.y + dy * (i / n), z = from.z + dz * (i / n);
    const h = heightAt(x, y);
    if (h === null || z - radius >= h) continue;
    return { t: (i - 1) / n, normal: normalAt(x, y) ?? { x: 0, y: 0, z: 1 } };
  }
  return null;
}

/** The nearer of two contacts. */
export function nearestContact(a: MissileContact | null, b: MissileContact | null): MissileContact | null {
  if (!a) return b;
  if (!b) return a;
  return b.t < a.t ? b : a;
}
