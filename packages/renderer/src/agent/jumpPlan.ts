/**
 * AGENT.walk-drops-jumps — the jumps and drops walk_to plans, flown with the
 * client's own jump physics.
 *
 * A player can't walk off a ledge: CTransition::edge_slide @ 0050b3d0 /
 * SPHEREPATH::precipice_slide @ 0050cc80 slide an EdgeSlide body (every
 * player, ACE PhysicsGlobals.DefaultState) along the edge of the floor it
 * stands on (OutdoorMovement.precipiceStep). Getting down a level, across a
 * gap or up onto a platform is a jump: the agent stands at the take-off,
 * faces the way, and makes a standing long jump (the charge started with no
 * movement key held, the forward key pressed during it — CMotionInterp
 * standing_longjump), so the body leaves from exactly where the plan said.
 *
 * The launch is the client's: get_leave_ground_velocity @ 005280c0 = the
 * held keys' get_state_velocity @ 00527d50 (RunForward × run_anim_speed ×
 * run rate, or WalkForward × walk_anim_speed with Shift) with z =
 * get_jump_v_z @ 00527aa0 → CACQualities::InqJumpVelocity @ 00592980 =
 * sqrt(MovementSystem::GetJumpHeight @ 006b09b0 (load, Jump skill, extent)
 * × 19.6). The extent is the charge time over ATTACK_POWERUP_TIME (1 s;
 * ClientCombatSystem::GetJumpPowerLevel @ 0056b050). The host supplies the
 * launch for the player's own skill and load (AgentHost.jumpLaunch).
 *
 * The flight is the client's too: each 1/30 s the body's momentum moves it
 * through the collision world as an airborne transition (the host's
 * airStep: OutdoorMovement.stepPlayerMovement, airborne, with the body at
 * its feet height), gravity −9.8 integrated exactly (ACE PhysicsObj.cs:1854
 * UpdatePositionInternal; MovementSystem.integrateAirborneStep), and it
 * lands on the first walkable its feet reach (fallPhysics.hasLanded).
 *
 * Fall damage is the server's, and the two server families differ
 * (AGENT.fall-damage-per-era, 2026-10-16). Both bill the landing's
 * EnvCollisionProfile velocity z (CPhysicsObj::report_environment_collision
 * @ 00512fc0 hands the client's own weenie only the profile;
 * ACCWeenieObject::DoCollision @ 0058c3a0 does no damage), never |v|:
 *   ratio = −(jV + v.z + 4.5) / jV, damage only when ratio > 0.
 * - ACE / ClassicACE (end of retail, the ClassicACE Dark Majesty worlds):
 *   Player_Move.cs:247 HandleFallingDamage, jV fixed at 11.25434 ("TODO:
 *   figure out how to scale this better"), damage = ratio × 87.293810,
 *   scaled by the bludgeon resistance and rounded (TakeDamage_Falling). No
 *   damage under 15.754 m/s (a 12.66 m fall).
 * - GDLE family (the AC1999 server, GDL-Classic Classic Dereth / Seedsow,
 *   GDLE end-of-retail worlds): CWeenieObject::DoCollision(EnvCollisionProfile)
 *   in Server/Source/WeenieObject.cpp, jV = the player's own full-power
 *   InqJumpVelocity(1.0) = sqrt(19.6 × GetJumpHeight(load, Jump, 1)) (2.62 m/s
 *   floor), damage = (int)(ratio × 40), unmitigated. A Jump-85 character
 *   (jV 5.26) takes damage past 9.76 m/s, a 4.9 m fall: the AC1999 start
 *   dungeon's 7.8 m drop landed at −12.55 m/s for 21 of 25 health
 *   ([FALLDMG] ratio=0.530 damage=21, 2026-10-16), where the ACE curve the
 *   planner then used said 0.
 * The planner estimates each landing FALL_SPEED_MARGIN faster than it flies it
 * (the server's tick lands ~2% fast) and keeps it within fallBudget.
 */
import type { NavPoint } from './navPlanner.js';
import { headroomClamp } from '../world/fallPhysics.js';

/** What the planner needs from the client to fly a jump. All heights are feet heights (agent global metres, z up). */
export interface JumpKit {
  /** The walkable floor at (x, y) at or below `fromZ` (+ 5 cm), or null when there is none. */
  floor(x: number, y: number, fromZ: number): number | null;
  /** One airborne transition: the body with its feet at `from.z` moved by (dx, dy) through the collision world; where it ends. */
  airStep(from: NavPoint, dx: number, dy: number): { x: number; y: number };
  /** A standing long jump charged to `power` (0..1): forward speed along the facing and upward speed, m/s; `walk` = Shift held. */
  launch(power: number, walk: boolean): { forward: number; up: number };
  /** Seconds of holding the jump key to charge it fully (ATTACK_POWERUP_TIME; 0.8 s in dual wield). */
  chargeSeconds: number;
  /**
   * BUG.jump-through-ceiling — the highest feet height a body rising at (x, y) from `fromZ` toward `toZ` reaches
   * before its head meets a ceiling (DungeonCollision.riseLimit), or null when nothing stops it. Absent: no ceilings.
   */
  ceiling?(x: number, y: number, fromZ: number, toZ: number): number | null;
  /** The body's height (Setup 0x02000001: 1.835 m), for the floor above its head (fallPhysics.headroomClamp). */
  bodyHeight?: number;
  /** The server's fall-damage formula (ACE's when absent). */
  fall?: FallModel;
}

/** A planned jump: from the take-off along `dir`, charged `holdMs`, landing at `to`. */
export interface JumpSpec {
  from: NavPoint;
  to: NavPoint;
  /** Unit direction to face (agent global x east, y north). */
  dir: { x: number; y: number };
  power: number;
  /** How long to hold the jump key, ms (power × the charge time). */
  holdMs: number;
  /** Shift held (a walking jump: shorter). */
  walk: boolean;
  /** Seconds in the air. */
  flight: number;
  /** The fall damage the planner counts on for the landing (expectedFallDamage, before resistances). */
  damage: number;
}

/** The human body's height, m (DungeonCollision.PLAYER_HEIGHT, Setup 0x02000001). */
const BODY_HEIGHT = 1.835;
/** ACE PhysicsGlobals.Gravity. */
export const GRAVITY = 9.8;
/** The fall-damage formula of the server the player is on (see the header). */
export interface FallModel {
  /** 'ace': ACE / ClassicACE; 'gdle': GDLE-family servers (the AC1999 server, GDL-Classic, GDLE). */
  server: 'ace' | 'gdle';
  /** The ratio's jump velocity, m/s: ACE's fixed 11.25434, or the player's own full-power jump (GDLE). */
  jumpVelocity: number;
  /** Damage per unit of overspeed ratio: ACE 87.293810, GDLE 40. */
  scale: number;
}
/** HandleFallingDamage's leeway, m/s (both families). */
const FALL_LEEWAY = 4.5;
/** ACE Player_Move.cs HandleFallingDamage (ClassicACE's is the same). */
export const ACE_FALL_MODEL: FallModel = Object.freeze({ server: 'ace', jumpVelocity: 11.25434, scale: 87.29381 });
/** The GetJumpHeight floor's velocity: sqrt(19.6 × 0.35), m/s (MovementSystem::GetJumpHeight). */
const GDLE_MIN_JUMP_VELOCITY = Math.sqrt(19.6 * 0.35);

/** GDLE's DoCollision for a player whose full-power jump leaves the ground at `fullJumpUp` m/s (InqJumpVelocity(1.0)). */
export function gdleFallModel(fullJumpUp: number): FallModel {
  return { server: 'gdle', jumpVelocity: Math.max(GDLE_MIN_JUMP_VELOCITY, fullJumpUp), scale: 40 };
}

/** The model for a server family, with the player's full-power jump velocity (used by GDLE only). */
export function fallModelFor(server: 'ace' | 'gdle', fullJumpUp: number): FallModel {
  return server === 'gdle' ? gdleFallModel(fullJumpUp) : ACE_FALL_MODEL;
}

/** The server's damage for landing at vertical speed `vz` (m/s, negative = down), before ACE's bludgeon resistance. */
export function fallDamage(vz: number, model: FallModel = ACE_FALL_MODEL): number {
  const ratio = -(model.jumpVelocity + vz + FALL_LEEWAY) / model.jumpVelocity;
  if (!(ratio > 0)) return 0;
  // GDLE: int damage = overSpeedRatio * 40.0 (truncated); ACE rounds only after the resistance.
  return model.server === 'gdle' ? Math.trunc(ratio * model.scale) : ratio * model.scale;
}

/**
 * How much faster than the flight's own landing speed the planner bills it, m/s. The server's
 * tick lands about 2% fast (the 1999 server: a max jump modelled at −5.76 landed at −5.89; the
 * 7.8 m drop modelled at −12.53 landed at −12.55), and GDLE bills ~7.6 health per m/s at jV 5.26.
 */
export const FALL_SPEED_MARGIN = 0.4;

/** The damage the planner counts on for a landing at `vz`: the server's at FALL_SPEED_MARGIN faster. */
export function expectedFallDamage(vz: number, model: FallModel = ACE_FALL_MODEL): number {
  return vz < 0 ? fallDamage(vz - FALL_SPEED_MARGIN, model) : 0;
}

/** The damage the planner counts on for stepping off a ledge `h` metres high (no upward speed). */
export function dropDamage(h: number, model: FallModel = ACE_FALL_MODEL): number {
  return expectedFallDamage(-Math.sqrt(2 * GRAVITY * Math.max(0, h)), model);
}

/**
 * The fall damage the agent will take on a planned drop or jump: at most half the health it has now,
 * with a quarter more for a bludgeon vulnerability (ACE's TakeDamage_Falling scales by the bludgeon
 * resistance). A landing never leaves it below 60% of the health it had: a full-health character
 * never risks more than 40% of it; a hurt one less.
 */
export function fallBudget(health: { current: number; max: number }): number {
  return Math.max(0, health.current * 0.5) / 1.25;
}

/** The highest ledge a step off costs (by the planner's estimate) no more than `budget` of fall damage. */
export function safeDropHeight(budget: number, model: FallModel = ACE_FALL_MODEL): number {
  // ACE: below ~12 m (12.66 m less the margin) a fall does no damage at all; GDLE: from 2.6 m to ~11 m by Jump and load.
  const speed = model.jumpVelocity + FALL_LEEWAY + (Math.max(0, budget) / model.scale) * model.jumpVelocity - FALL_SPEED_MARGIN;
  return speed > 0 ? (speed * speed) / (2 * GRAVITY) : 0;
}

export interface Landing extends NavPoint { vz: number; t: number }

/** The flight's time step: the client's physics quantum at 30 frames a second. */
const FLIGHT_DT = 1 / 30;

/**
 * Fly the body from `from` (standing, feet at from.z) with launch velocity (vx, vy, vz): the landing
 * (where its feet reach a walkable, with the vertical speed then) or null when it never lands within
 * `maxSeconds` or falls more than `maxFall` metres.
 */
export function simulateFlight(kit: Pick<JumpKit, 'floor' | 'airStep' | 'bodyHeight' | 'ceiling'>, from: NavPoint, vx: number, vy: number, vz: number, opts: { maxSeconds?: number; maxFall?: number } = {}): Landing | null {
  const maxT = opts.maxSeconds ?? 4;
  const maxFall = opts.maxFall ?? 60;
  const height = kit.bodyHeight ?? BODY_HEIGHT;
  let x = from.x, y = from.y, z = from.z, v = vz, t = 0;
  while (t < maxT) {
    let nz = z + v * FLIGHT_DT - 0.5 * GRAVITY * FLIGHT_DT * FLIGHT_DT;
    let nv = v - GRAVITY * FLIGHT_DT;
    // The head meets the ceiling: the rise stops there (as the live frame's ceilingStop does).
    if (nz > z && kit.ceiling) {
      const top = kit.ceiling(x, y, z, nz);
      if (top !== null) { nz = top; nv = 0; }
    }
    if (nv > 0) ({ feetY: nz, velocityY: nv } = headroomClamp(nz, nv, kit.floor(x, y, nz + height), height));
    const moved = vx || vy ? kit.airStep({ x, y, z }, vx * FLIGHT_DT, vy * FLIGHT_DT) : { x, y };
    t += FLIGHT_DT;
    // The walkable under the body at or below where its feet were (a floor passed through this step counts).
    const ground = kit.floor(moved.x, moved.y, Math.max(z, nz));
    if (nv < 0 && ground !== null && nz <= ground) return { x: moved.x, y: moved.y, z: ground, vz: nv, t };
    x = moved.x; y = moved.y; z = nz; v = nv;
    if (from.z - z > maxFall) return null;
  }
  return null;
}

/** How far round a landing it must not drop away (m): about the body's radius (0.48), so no part of it hangs over a drop. */
export const LANDING_MARGIN_M = 0.45;
/** A drop beside a landing deeper than this makes it an edge (m). */
const LANDING_EDGE_DROP_M = 1;

/**
 * Whether a landing spot holds the body: eight points LANDING_MARGIN_M out round it, none over a drop of
 * more than a metre. A landing on a pylon's lip or a ledge's rim slides
 * the body off (CTransition::edge_slide only holds it while it walks): the dam at 42.3N 78.35W, planned
 * as a 4.8 m drop, became a 28 m fall and 47 damage (2026-10-11).
 */
export function stableLanding(kit: Pick<JumpKit, 'floor'>, at: NavPoint): boolean {
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const f = kit.floor(at.x + LANDING_MARGIN_M * Math.cos(a), at.y + LANDING_MARGIN_M * Math.sin(a), at.z + 0.5);
    // No floor at all there is a wall's footing or the world's edge, not a drop: only a floor found far below is.
    if (f !== null && f < at.z - LANDING_EDGE_DROP_M) return false;
  }
  return true;
}

/** The charge powers tried, gentlest first. A press shorter than ~0.15 s can't fit the forward key in after the charge starts. */
const POWERS = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];
/** A jump must land the same way when the key is held a frame or two longer or shorter. */
const POWER_SLOP = 0.05;

/**
 * The jumps from `from` facing `dir` that land somewhere new: walking (Shift) jumps first, then
 * running ones, each from the gentlest charge up. Kept only when the landing deals at most
 * `maxDamage` and a slightly shorter or longer charge lands on the same floor. At most `max`.
 */
export function jumpOptions(kit: JumpKit, from: NavPoint, dir: { x: number; y: number }, opts: { maxDamage: number; max?: number; minDistance?: number }): JumpSpec[] {
  const out: JumpSpec[] = [];
  const max = opts.max ?? 3;
  const minDistance = opts.minDistance ?? 0.6;
  const n = Math.hypot(dir.x, dir.y) || 1;
  const u = { x: dir.x / n, y: dir.y / n };
  const fly = (power: number, walk: boolean): Landing | null => {
    const l = kit.launch(power, walk);
    return simulateFlight(kit, from, u.x * l.forward, u.y * l.forward, l.up);
  };
  for (const walk of [true, false]) {
    for (const power of POWERS) {
      const to = fly(power, walk);
      if (!to || Math.hypot(to.x - from.x, to.y - from.y) < minDistance) continue;
      const damage = expectedFallDamage(to.vz, kit.fall);
      if (damage > opts.maxDamage) continue;
      if (!stableLanding(kit, to)) continue;
      if (out.some((o) => Math.hypot(o.to.x - to.x, o.to.y - to.y) < 1 && Math.abs(o.to.z - to.z) < 0.5)) continue;
      const steady = [power - POWER_SLOP, power + POWER_SLOP].filter((p) => p > 0 && p <= 1).every((p) => {
        const o = fly(p, walk);
        return !!o && Math.abs(o.z - to.z) < 0.5 && Math.hypot(o.x - to.x, o.y - to.y) < 1.5 && expectedFallDamage(o.vz, kit.fall) <= opts.maxDamage;
      });
      if (!steady) continue;
      out.push({ from, to: { x: to.x, y: to.y, z: to.z }, dir: u, power, holdMs: Math.round(power * kit.chargeSeconds * 1000), walk, flight: to.t, damage });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Re-aim a planned jump from where the body really stands: the charge (same walk / run) whose landing
 * is nearest the planned one, on its floor. Null when none lands there (re-plan).
 */
export function reaimJump(kit: JumpKit, here: NavPoint, plan: JumpSpec, maxDamage: number): JumpSpec | null {
  const dir = { x: plan.to.x - here.x, y: plan.to.y - here.y };
  const d = Math.hypot(dir.x, dir.y);
  if (d < 0.1) return null;
  const u = { x: dir.x / d, y: dir.y / d };
  let best: JumpSpec | null = null;
  let bestErr = Infinity;
  for (let power = 0.15; power <= 1.0001; power += 0.025) {
    const l = kit.launch(power, plan.walk);
    const to = simulateFlight(kit, here, u.x * l.forward, u.y * l.forward, l.up);
    if (!to || Math.abs(to.z - plan.to.z) > 0.5 || expectedFallDamage(to.vz, kit.fall) > maxDamage || !stableLanding(kit, to)) continue;
    const err = Math.hypot(to.x - plan.to.x, to.y - plan.to.y);
    if (err < bestErr) { bestErr = err; best = { from: here, to: { x: to.x, y: to.y, z: to.z }, dir: u, power, holdMs: Math.round(power * kit.chargeSeconds * 1000), walk: plan.walk, flight: to.t, damage: expectedFallDamage(to.vz, kit.fall) }; }
  }
  return best && bestErr < 1.5 ? best : null;
}

/** Whether a planned jump is a drop (lands more than a step down) rather than a jump across or up. */
export const isDrop = (j: Pick<JumpSpec, 'from' | 'to'>): boolean => j.to.z < j.from.z - 1;
