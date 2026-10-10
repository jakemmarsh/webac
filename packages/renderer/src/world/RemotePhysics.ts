/**
 * The physics object of ANOTHER object — how the retail client moves
 * everything it did not create itself between server updates. AC world axes
 * (x east, y north, z up; landblock-global metres), headings in degrees.
 *
 * DECOMP.position-interpolation — a received position goes through
 * `SmartBox::HandleReceivedPosition @ 00453fd0`: a position whose
 * POSITION_TS is not newer than the object's is stale and dropped; one whose
 * TELEPORT_TS is older is dropped too. `CPhysicsObj::MoveOrTeleport
 * @ 00516330` then snaps it (a newer teleport stamp, or no cell yet), or —
 * for a position with contact — hands it to the InterpolationManager when
 * the object is within MAX_PHYSICS_DISTANCE (96 m) of the player, else snaps
 * it; a position without contact changes nothing (the object is flying on
 * its own velocity).
 *
 * `InterpolationManager` (InterpolateTo @ 00555b20, adjust_offset
 * @ 00555d30, NodeCompleted @ 005559a0, UseTime @ 00555f20): a queue of
 * target positions; each frame the object's offset is REPLACED by the move
 * toward the head node, capped at 2 × the motion interpreter's adjusted max
 * speed (7.5 m/s without one); a node reached within 0.05 m completes; a
 * node the object fails to approach at 30 % of that speed for 5 frames
 * fails, and after 4 failures (or a target farther than the blip distance —
 * 100 m outdoors, 20 m indoors) it blips (snaps) there.
 *
 * DECOMP.remote-motion-no-displacement — `CPhysicsObj::UpdatePositionInternal
 * @ 00512c30`: the sequence's offset (root pos-frames + velocity / omega,
 * see AnimationPlayer.update) is taken only while the object stands on
 * something walkable (its origin is dropped in the air, scaled by the
 * object's scale on the ground), the PositionManager adjusts it
 * (interpolation, then sticky), it is combined onto the position, and
 * `UpdatePhysicsInternal @ 00510700` adds the object's own velocity
 * (gravity, friction, omega).
 *
 * DECOMP.remote-constraint — after each position MoveOrTeleport takes,
 * HandleReceivedPosition constrains the object to where it stands
 * (ConstraintManager): its own motion carries it 10 m (5 indoors), then
 * fades to nothing by 50 m (20) until the next position.
 *
 * DECOMP.remote-vector-update — `SmartBox::DoVectorUpdate @ 004521c0`: a
 * VectorUpdate newer than the object's VECTOR_TS sets its velocity
 * (`set_velocity @ 005113f0`, clamped to max_velocity 50) and omega on ANY
 * object — a peer's jump, a knockback.
 *
 * No collision world is simulated for remote objects: an object on the
 * ground outdoors follows the terrain height under it, and an airborne one
 * lands on the terrain (outdoors) or back at the height it last stood at
 * (indoors) — the stand-in for `transition()`'s contact test.
 */
import {
  combineFrame, identityFrame, quatMultiply, quatNormalized, rotateVector,
  type SequenceFrame, type SeqQuat, type SeqV3,
} from '../animation/SequenceFrame.js';
import { headingFromTo, headingOfQuat, quatForHeading } from './Heading.js';
import { PhysicsState } from '@ac/shared';
import { MIN_QUANTUM, MAX_QUANTUM, HUGE_QUANTUM } from './MissilePhysics.js';

/** `F_EPSILON`. */
export const F_EPSILON = 0.0002;
/** `DESIRED_DISTANCE`. */
export const DESIRED_DISTANCE = 0.05;
/** `MAX_INTERPOLATED_VELOCITY` (m/s) — the cap when there is no motion interpreter. */
export const MAX_INTERPOLATED_VELOCITY = 7.5;
/** `MAX_INTERPOLATED_VELOCITY_MOD`. */
export const MAX_INTERPOLATED_VELOCITY_MOD = 2;
/** `CREATURE_FAILED_INTERPOLATION_PERCENTAGE`. */
export const CREATURE_FAILED_INTERPOLATION_PERCENTAGE = 0.3;
/** `MIN_DISTANCE_TO_REACH_POSITION`. */
export const MIN_DISTANCE_TO_REACH_POSITION = 0.2;
/** `BIG_DISTANCE`. */
export const BIG_DISTANCE = 999999;
/** `CREATURE_OUTSIDE_BLIP_DISTANCE` / `CREATURE_INSIDE_BLIP_DISTANCE` (m). */
export const CREATURE_OUTSIDE_BLIP_DISTANCE = 100;
export const CREATURE_INSIDE_BLIP_DISTANCE = 20;
/**
 * `CREATURE_{OUTSIDE,INSIDE}_CONSTRAINT_DISTANCE_{START,MAX}` (m) —
 * `CPhysicsObj::GetStartConstraintDistance @ 0050ebc0` /
 * `GetMaxConstraintDistance @ 0050ec10` for an object other than the player.
 */
export const CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_START = 10;
export const CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_MAX = 50;
export const CREATURE_INSIDE_CONSTRAINT_DISTANCE_START = 5;
export const CREATURE_INSIDE_CONSTRAINT_DISTANCE_MAX = 20;
/** `MAX_PHYSICS_DISTANCE` (m): farther than this from the player, a position snaps. */
export const MAX_PHYSICS_DISTANCE = 96;
/** `STICKY_RADIUS` (m) / `STICKY_TIMEOUT` (s). */
export const STICKY_RADIUS = 0.3;
export const STICKY_TIMEOUT = 1;
/** `MAX_VELOCITY_MOD` / `MAX_VELOCITY` (StickyManager's speed). */
export const STICKY_MAX_VELOCITY_MOD = 5;
export const STICKY_MAX_VELOCITY = 15;
/** `max_velocity` / `small_velocity` (CPhysicsObj). */
export const MAX_OBJECT_VELOCITY = 50;
export const SMALL_VELOCITY = 0.25;
/** `PhysicsGlobals::gravity`. */
export const GRAVITY = -9.8;
/** `DEFAULT_FRICTION`. */
export const DEFAULT_FRICTION = 0.95;
/** The interpolation queue holds at most this many nodes (InterpolateTo drops the oldest at 20). */
const MAX_QUEUE = 20;
/** InterpolationManager's node-fail count that triggers the blip. */
const NODE_FAIL_BLIP = 4;

/** PhysicsState `Sledding` (0x800000) — calc_acceleration / calc_friction's sled branch. */
const SLEDDING = 0x800000;

export interface PhysPosition {
  /** Full cell id (0xXXYYcccc). */
  cell: number;
  pos: SeqV3;
  orient: SeqQuat;
}

/** Wraparound-aware ushort "newer" (`CPhysicsObj::newer_event`'s comparison): equal is not newer. */
export function newerStamp(incoming: number, stored: number): boolean {
  const diff = (incoming - stored) & 0xffff;
  return diff > 0 && diff < 0x8000;
}

function dist3(a: SeqV3, b: SeqV3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isOutdoorCell(cell: number): boolean {
  return (cell & 0xffff) < 0x100;
}

/** What InterpolationManager / StickyManager need from their object. */
export interface PositionHost {
  position(): PhysPosition;
  /** `CPhysicsObj::SetPositionSimple` — snap. */
  setPositionSimple(p: PhysPosition): void;
  /** `CPhysicsObj::set_heading(h, 1)`. */
  setHeading(heading: number): void;
  /** transient_state & Contact. */
  hasContact(): boolean;
  /** `CMotionInterp::get_adjusted_max_speed` (0 = no motion interpreter). */
  adjustedMaxSpeed(): number;
  /** `CMotionInterp::get_max_speed` (0 = no motion interpreter). */
  maxSpeed(): number;
  /** `CPhysicsObj::GetRadius`. */
  radius(): number;
  /** The sticky target's current position (null = gone). */
  stickyTargetPosition(id: number): SeqV3 | null;
  /** `CPhysicsObj::cancel_moveto` (a sticky object that loses its target). */
  cancelMoveTo(): void;
  /** `CPhysicsObj::get_sticky_object_id` (0 = none). */
  stickyObjectId(): number;
}

type InterpNode = { kind: 'position'; p: PhysPosition };

/** `InterpolationManager` (retail @ 005558d0…). */
export class InterpolationManager {
  queue: InterpNode[] = [];
  keepHeading = false;
  frameCounter = 0;
  originalDistance = BIG_DISTANCE;
  progressQuantum = 0;
  nodeFailCounter = 0;
  blipTo: PhysPosition | null = null;

  constructor(private host: PositionHost) {}

  isInterpolating(): boolean {
    return this.queue.length > 0;
  }

  stopInterpolating(): void {
    this.queue.length = 0;
    this.frameCounter = 0;
    this.progressQuantum = 0;
    this.nodeFailCounter = 0;
    this.originalDistance = BIG_DISTANCE;
  }

  private node(p: PhysPosition): InterpNode {
    const n: InterpNode = { kind: 'position', p: { cell: p.cell, pos: { ...p.pos }, orient: { ...p.orient } } };
    if (this.keepHeading) n.p.orient = quatForHeading(headingOfQuat(this.host.position().orient));
    return n;
  }

  /** `InterpolateTo @ 00555b20`. */
  interpolateTo(p: PhysPosition, keepHeading: boolean): void {
    const tail = this.queue[this.queue.length - 1];
    const cur = this.host.position();
    const from = tail ? tail.p.pos : cur.pos;
    const blip = isOutdoorCell(cur.cell) ? CREATURE_OUTSIDE_BLIP_DISTANCE : CREATURE_INSIDE_BLIP_DISTANCE;
    if (dist3(from, p.pos) > blip) {
      this.queue.push(this.node(p));
      this.nodeFailCounter = NODE_FAIL_BLIP;
      return;
    }
    if (dist3(cur.pos, p.pos) <= DESIRED_DISTANCE) {
      if (!keepHeading) this.host.setHeading(headingOfQuat(p.orient));
      this.stopInterpolating();
      return;
    }
    while (this.queue.length > 0 && dist3(this.queue[this.queue.length - 1].p.pos, p.pos) < DESIRED_DISTANCE) this.queue.pop();
    while (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.keepHeading = keepHeading;
    this.queue.push(this.node(p));
  }

  /** `NodeCompleted @ 005559a0`. */
  private nodeCompleted(success: boolean): void {
    this.frameCounter = 0;
    this.progressQuantum = 0;
    const head = this.queue.shift();
    const next = this.queue[0];
    if (!next) {
      this.originalDistance = BIG_DISTANCE;
      if (success) { this.stopInterpolating(); return; }
    } else {
      this.originalDistance = dist3(this.host.position().pos, next.p.pos);
      return;
    }
    if (head) this.blipTo = head.p;
  }

  /**
   * `adjust_offset @ 00555d30`: replace `offset` with the move toward the
   * head node. Returns true when it did.
   */
  adjustOffset(offset: SequenceFrame, quantum: number): boolean {
    const head = this.queue[0];
    if (!head || !this.host.hasContact()) return false;
    const cur = this.host.position();
    const d = dist3(cur.pos, head.p.pos);
    if (d < DESIRED_DISTANCE) { this.nodeCompleted(true); return false; }
    let speed = this.host.adjustedMaxSpeed() * MAX_INTERPOLATED_VELOCITY_MOD;
    if (speed < F_EPSILON) speed = MAX_INTERPOLATED_VELOCITY;
    this.frameCounter++;
    this.progressQuantum += quantum;
    if (this.frameCounter > 4) {
      const progress = this.originalDistance - d;
      if (this.host.stickyObjectId() === 0
        && (progress < F_EPSILON || (progress / this.progressQuantum) / speed < CREATURE_FAILED_INTERPOLATION_PERCENTAGE)) {
        if (d >= MIN_DISTANCE_TO_REACH_POSITION) {
          this.nodeFailCounter++;
          this.nodeCompleted(false);
        } else {
          this.nodeCompleted(true);
        }
        return false;
      }
      this.frameCounter = 0;
      this.progressQuantum = 0;
      this.originalDistance = d;
    }
    // Position::subtract2: the target in the object's local frame.
    const conj = { w: cur.orient.w, x: -cur.orient.x, y: -cur.orient.y, z: -cur.orient.z };
    const local = rotateVector(conj, { x: head.p.pos.x - cur.pos.x, y: head.p.pos.y - cur.pos.y, z: head.p.pos.z - cur.pos.z });
    let rot = quatNormalized(quatMultiply(conj, head.p.orient));
    const mag = Math.hypot(local.x, local.y, local.z);
    if (mag <= DESIRED_DISTANCE) this.nodeCompleted(true);
    const step = speed * quantum;
    const k = mag > step ? step / mag : 1;
    if (this.keepHeading) rot = { w: 1, x: 0, y: 0, z: 0 };
    offset.origin = { x: local.x * k, y: local.y * k, z: local.z * k };
    offset.orientation = rot;
    return true;
  }

  /** `UseTime @ 00555f20`: blip after too many failures. */
  useTime(): void {
    if (this.nodeFailCounter < NODE_FAIL_BLIP) {
      if (this.queue.length > 0 || this.nodeFailCounter < 1) return;
    }
    const tail = this.queue[this.queue.length - 1];
    const target = tail ? tail.p : this.blipTo;
    if (target) this.host.setPositionSimple(target);
    this.stopInterpolating();
  }
}

/** `StickyManager` (retail @ 00555400…): hold within STICKY_RADIUS of a target for STICKY_TIMEOUT. */
export class StickyManager {
  targetId = 0;
  targetRadius = 0;
  initialized = false;
  timeout = 0;
  targetPosition: SeqV3 | null = null;

  constructor(private host: PositionHost) {}

  /** `StickTo @ 00555710`. */
  stickTo(id: number, radius: number, now: number): void {
    if (this.targetId) this.unStick();
    this.targetId = id;
    this.targetRadius = radius;
    this.initialized = false;
    this.timeout = now + STICKY_TIMEOUT;
  }

  /** `UnStick @ 00555400`. */
  unStick(): void {
    if (!this.targetId) return;
    this.targetId = 0;
    this.initialized = false;
    this.host.cancelMoveTo();
  }

  /** `HandleUpdateTarget @ 00555780`. */
  updateTarget(): void {
    if (!this.targetId) return;
    const p = this.host.stickyTargetPosition(this.targetId);
    if (p) { this.initialized = true; this.targetPosition = p; } else this.unStick();
  }

  /** `UseTime @ 00555610`. */
  useTime(now: number): void {
    if (this.targetId && this.timeout < now) this.unStick();
  }

  /** `adjust_offset @ 00555430`: step toward the target's cylinder (no z) and face it. */
  adjustOffset(offset: SequenceFrame, quantum: number): boolean {
    if (!this.targetId || !this.initialized || !this.targetPosition) return false;
    const cur = this.host.position();
    const t = this.host.stickyTargetPosition(this.targetId) ?? this.targetPosition;
    const conj = { w: cur.orient.w, x: -cur.orient.x, y: -cur.orient.y, z: -cur.orient.z };
    const local = rotateVector(conj, { x: t.x - cur.pos.x, y: t.y - cur.pos.y, z: t.z - cur.pos.z });
    local.z = 0;
    const flat = Math.hypot(t.x - cur.pos.x, t.y - cur.pos.y);
    const dist = flat - (this.host.radius() + this.targetRadius) - STICKY_RADIUS;
    const l = Math.hypot(local.x, local.y);
    const dir = l < F_EPSILON ? { x: 0, y: 0 } : { x: local.x / l, y: local.y / l };
    let speed = this.host.maxSpeed() * STICKY_MAX_VELOCITY_MOD;
    if (speed < F_EPSILON) speed = STICKY_MAX_VELOCITY;
    const step = speed * quantum;
    const move = Math.abs(dist) <= step ? dist : step;
    offset.origin = { x: dir.x * move, y: dir.y * move, z: 0 };
    let h = headingFromTo(cur.pos, t) - headingOfQuat(cur.orient);
    if (Math.abs(h) < F_EPSILON) h = 0;
    if (h < -F_EPSILON) h += 360;
    offset.orientation = quatForHeading(h);
    return true;
  }
}

/**
 * `ConstraintManager` (retail @ 00556090…). `SmartBox::HandleReceivedPosition
 * @ 00453fd0` constrains a remote object to where it stands each time
 * MoveOrTeleport takes a position (`ConstrainTo(obj, &obj->m_position,
 * start, max)`); from then on every frame's offset adds its length to
 * `constraintPosOffset`, and while the object has contact an offset past
 * `start` metres is scaled down linearly to nothing at `max` metres. An
 * object whose updates stop (lost behind a wall, its stop late) runs on its
 * motion for 10 m outdoors, then slows to a halt by 50 m — instead of
 * running away forever.
 */
export class ConstraintManager {
  isConstrained = false;
  constraintPosOffset = 0;
  constraintDistanceStart = 0;
  constraintDistanceMax = 0;

  constructor(private host: { hasContact(): boolean }) {}

  /** `ConstrainTo @ 00556240` — `distance` = Position::distance(constraint pos, the object's position). */
  constrainTo(distance: number, start: number, max: number): void {
    this.isConstrained = true;
    this.constraintDistanceStart = start;
    this.constraintDistanceMax = max;
    this.constraintPosOffset = distance;
  }

  /** `UnConstrain @ 005560c0`. */
  unConstrain(): void {
    this.isConstrained = false;
  }

  /** `IsFullyConstrained @ 005560d0`: past 90 % of the max distance. */
  isFullyConstrained(): boolean {
    return this.constraintDistanceMax * 0.9 < this.constraintPosOffset;
  }

  /** `adjust_offset @ 00556180`. */
  adjustOffset(offset: SequenceFrame): void {
    if (!this.isConstrained) return;
    if (this.host.hasContact()) {
      if (this.constraintPosOffset < this.constraintDistanceMax) {
        if (this.constraintPosOffset > this.constraintDistanceStart) {
          const k = (this.constraintDistanceMax - this.constraintPosOffset) / (this.constraintDistanceMax - this.constraintDistanceStart);
          offset.origin = { x: offset.origin.x * k, y: offset.origin.y * k, z: offset.origin.z * k };
        }
      } else {
        offset.origin = { x: 0, y: 0, z: 0 };
      }
    }
    this.constraintPosOffset += Math.hypot(offset.origin.x, offset.origin.y, offset.origin.z);
  }
}

/** What the object's physics reads from its surroundings. */
export interface RemotePhysicsEnv {
  /** AC ground height (z) under (x, y) outdoors, or null (no terrain there / unknown). */
  terrainHeight(x: number, y: number): number | null;
}

/** Receiving a position (the PositionPack fields HandleReceivedPosition uses). */
export interface ReceivedPosition extends PhysPosition {
  contact: boolean;
  positionTs?: number;
  teleportTs?: number;
}

/** The per-object update timestamps (`update_times`) this object tracks. */
export interface PhysicsStamps {
  position?: number;
  teleport?: number;
  vector?: number;
}

/**
 * A remote object's CPhysicsObj. `host` is the rest of the object (its motion
 * interpreter, MoveToManager and target lookups).
 */
export class RemotePhysicsObject implements PositionHost {
  cell: number;
  pos: SeqV3;
  orient: SeqQuat;
  velocity: SeqV3 = { x: 0, y: 0, z: 0 };
  omega: SeqV3 = { x: 0, y: 0, z: 0 };
  acceleration: SeqV3 = { x: 0, y: 0, z: 0 };
  state: number;
  scale = 1;
  friction = DEFAULT_FRICTION;
  contact = true;
  onWalkable = true;
  /** The height the object last stood at (the indoor landing floor). */
  groundZ: number;
  /** Elapsed time not yet stepped by the physics (under MIN_QUANTUM). */
  private physicsCarry = 0;
  /** Placed in a cell yet (`CPhysicsObj::cell`) — false until a first position arrives. */
  inCell: boolean;
  stamps: PhysicsStamps;
  readonly interp: InterpolationManager;
  readonly sticky: StickyManager;
  readonly constraint: ConstraintManager;

  /** Hooks into the rest of the object. */
  motion: {
    adjustedMaxSpeed(): number;
    maxSpeed(): number;
    radius(): number;
    isMovingTo(): boolean;
    cancelMoveTo(): void;
    /** `MovementManager::HitGround` — the object landed on something walkable. */
    hitGround(): void;
    /** `MovementManager::LeaveGround` — the object left the walkable ground. */
    leaveGround(): void;
    targetPosition(id: number): SeqV3 | null;
  } = {
    adjustedMaxSpeed: () => 0, maxSpeed: () => 0, radius: () => 0, isMovingTo: () => false,
    cancelMoveTo: () => {}, hitGround: () => {}, leaveGround: () => {}, targetPosition: () => null,
  };

  constructor(init: { position: PhysPosition | null; state: number; stamps?: PhysicsStamps; velocity?: SeqV3; omega?: SeqV3; scale?: number }) {
    this.cell = init.position?.cell ?? 0;
    this.pos = init.position ? { ...init.position.pos } : { x: 0, y: 0, z: 0 };
    this.orient = init.position ? { ...init.position.orient } : { w: 1, x: 0, y: 0, z: 0 };
    this.inCell = !!init.position;
    this.state = init.state;
    this.stamps = { ...(init.stamps ?? {}) };
    this.scale = init.scale ?? 1;
    this.groundZ = this.pos.z;
    this.interp = new InterpolationManager(this);
    this.sticky = new StickyManager(this);
    this.constraint = new ConstraintManager(this);
    this.calcAcceleration();
    if (init.velocity) this.setVelocity(init.velocity);
    if (init.omega) this.omega = { ...init.omega };
  }

  // ── PositionHost ──
  position(): PhysPosition { return { cell: this.cell, pos: this.pos, orient: this.orient }; }
  setPositionSimple(p: PhysPosition): void {
    this.cell = p.cell;
    this.pos = { ...p.pos };
    this.orient = { ...p.orient };
    this.inCell = true;
    if (this.contact) this.groundZ = this.pos.z;
  }
  setHeading(heading: number): void { this.orient = quatForHeading(heading); }
  hasContact(): boolean { return this.contact; }
  adjustedMaxSpeed(): number { return this.motion.adjustedMaxSpeed(); }
  maxSpeed(): number { return this.motion.maxSpeed(); }
  radius(): number { return this.motion.radius(); }
  stickyTargetPosition(id: number): SeqV3 | null { return this.motion.targetPosition(id); }
  cancelMoveTo(): void { this.motion.cancelMoveTo(); }
  stickyObjectId(): number { return this.sticky.targetId; }

  get heading(): number { return headingOfQuat(this.orient); }

  /** `CPhysicsObj::set_velocity @ 005113f0` — clamped to max_velocity. */
  setVelocity(v: SeqV3): void {
    const l2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (l2 > MAX_OBJECT_VELOCITY * MAX_OBJECT_VELOCITY) {
      const k = MAX_OBJECT_VELOCITY / Math.sqrt(l2);
      this.velocity = { x: v.x * k, y: v.y * k, z: v.z * k };
    } else {
      this.velocity = { ...v };
    }
  }

  /** `CPhysicsObj::set_local_velocity @ 005114d0` — an object-local velocity, turned into the world by the object's orientation. */
  setLocalVelocity(v: SeqV3): void {
    this.setVelocity(rotateVector(this.orient, v));
  }

  /** `CPhysicsObj::calc_acceleration @ 00510950`. */
  calcAcceleration(): void {
    if (this.contact && this.onWalkable && (this.state & SLEDDING) === 0) {
      this.acceleration = { x: 0, y: 0, z: 0 };
      this.omega = { x: 0, y: 0, z: 0 };
      return;
    }
    this.acceleration = { x: 0, y: 0, z: (this.state & PhysicsState.Gravity) ? GRAVITY : 0 };
  }

  setState(state: number): void {
    this.state = state;
    this.calcAcceleration();
  }

  /**
   * `SmartBox::HandleReceivedPosition @ 00453fd0` + `MoveOrTeleport
   * @ 00516330`. Returns what happened.
   */
  receivePosition(p: ReceivedPosition, playerDistance: number): 'stale' | 'teleport' | 'interpolate' | 'snap' | 'ignored' {
    const prevPositionTs = this.stamps.position;
    if (p.positionTs !== undefined) {
      if (this.stamps.position !== undefined && !newerStamp(p.positionTs, this.stamps.position)) return 'stale';
      this.stamps.position = p.positionTs;
    }
    let teleported = false;
    if (p.teleportTs !== undefined && this.stamps.teleport !== undefined) {
      if (newerStamp(this.stamps.teleport, p.teleportTs)) {
        this.stamps.position = prevPositionTs;
        return 'stale';
      }
      teleported = newerStamp(p.teleportTs, this.stamps.teleport);
    }
    if (p.teleportTs !== undefined) this.stamps.teleport = p.teleportTs;
    let r: 'teleport' | 'interpolate' | 'snap';
    if (teleported || !this.inCell) {
      this.interp.stopInterpolating();
      this.setPositionSimple(p);
      r = 'teleport';
    } else if (!p.contact) {
      return 'ignored';
    } else if (playerDistance < MAX_PHYSICS_DISTANCE) {
      this.interp.interpolateTo(p, this.motion.isMovingTo());
      this.cell = p.cell;
      r = 'interpolate';
    } else {
      this.interp.stopInterpolating();
      this.setPositionSimple(p);
      r = 'snap';
    }
    // HandleReceivedPosition: MoveOrTeleport took it — constrain the object
    // to where it now stands (its own position: the offset starts at 0).
    const outdoor = isOutdoorCell(this.cell);
    this.constraint.constrainTo(0,
      outdoor ? CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_START : CREATURE_INSIDE_CONSTRAINT_DISTANCE_START,
      outdoor ? CREATURE_OUTSIDE_CONSTRAINT_DISTANCE_MAX : CREATURE_INSIDE_CONSTRAINT_DISTANCE_MAX);
    return r;
  }

  /** `SmartBox::DoVectorUpdate @ 004521c0`. Returns false for a stale update. */
  receiveVector(velocity: SeqV3, omega: SeqV3, vectorTs?: number): boolean {
    if (vectorTs !== undefined && this.stamps.vector !== undefined && !newerStamp(vectorTs, this.stamps.vector)) return false;
    if (vectorTs !== undefined) this.stamps.vector = vectorTs;
    this.setVelocity(velocity);
    this.omega = { ...omega };
    return true;
  }

  /**
   * One frame: `UpdatePositionInternal` with the sequence's offset
   * (`motionOffset`, object-local — null when the object has no sequence).
   */
  update(dt: number, motionOffset: SequenceFrame | null, env: RemotePhysicsEnv, now: number): void {
    if (!(dt > 0)) return;
    const hidden = (this.state & PhysicsState.Hidden) !== 0;
    const offset = motionOffset && !hidden ? motionOffset : identityFrame();
    if (!hidden) {
      if (!this.onWalkable) offset.origin = { x: 0, y: 0, z: 0 };
      else offset.origin = { x: offset.origin.x * this.scale, y: offset.origin.y * this.scale, z: offset.origin.z * this.scale };
    }
    this.sticky.updateTarget();
    const interpolated = this.interp.adjustOffset(offset, dt);
    const stuck = this.sticky.adjustOffset(offset, dt);
    // PositionManager::adjust_offset @ 00555190: interpolation, sticky, then the constraint.
    this.constraint.adjustOffset(offset);
    const oldX = this.pos.x, oldY = this.pos.y;
    const frame: SequenceFrame = { origin: { ...this.pos }, orientation: { ...this.orient } };
    combineFrame(frame, offset);
    if (!hidden) {
      // CPhysicsObj::update_object's quanta: physics steps of at least
      // MIN_QUANTUM (1/30 s — shorter frames carry over), at most MAX_QUANTUM.
      this.physicsCarry += dt;
      if (this.physicsCarry > HUGE_QUANTUM) this.physicsCarry = 0;
      if (this.physicsCarry >= MIN_QUANTUM) {
        let rem = this.physicsCarry;
        this.physicsCarry = 0;
        while (rem > MAX_QUANTUM) { this.updatePhysicsInternal(MAX_QUANTUM, frame); rem -= MAX_QUANTUM; }
        this.updatePhysicsInternal(rem, frame);
      }
    }
    const outdoor = isOutdoorCell(this.cell);
    if (this.contact) {
      // Ground contact: follow the terrain under a self-moved object (a
      // server target is already at the height the server gave).
      if (!interpolated && !stuck && outdoor) {
        const h0 = env.terrainHeight(oldX, oldY);
        const h1 = env.terrainHeight(frame.origin.x, frame.origin.y);
        if (h0 !== null && h1 !== null) frame.origin.z += h1 - h0;
      }
      if (this.velocity.z > SMALL_VELOCITY) {
        // Moving up off the ground (set_on_walkable(false) → MovementManager::
        // LeaveGround, then calc_acceleration).
        this.contact = false;
        this.onWalkable = false;
        this.motion.leaveGround();
        this.calcAcceleration();
      }
    } else {
      const ground = (outdoor ? env.terrainHeight(frame.origin.x, frame.origin.y) : null) ?? this.groundZ;
      if (frame.origin.z <= ground && this.velocity.z <= 0) {
        frame.origin.z = ground;
        this.velocity = { x: this.velocity.x, y: this.velocity.y, z: 0 };
        this.contact = true;
        this.onWalkable = true;
        this.calcAcceleration();
        this.motion.hitGround();
      }
    }
    this.pos = frame.origin;
    this.orient = frame.orientation;
    if (this.contact) this.groundZ = this.pos.z;
    this.interp.useTime();
    this.sticky.useTime(now);
  }

  /** `UpdatePhysicsInternal @ 00510700` (+ `calc_friction @ 0050ee70` on a flat walkable plane). */
  private updatePhysicsInternal(q: number, frame: SequenceFrame): void {
    const v = this.velocity;
    let v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (v2 > 0) {
      if (v2 > MAX_OBJECT_VELOCITY * MAX_OBJECT_VELOCITY) {
        const k = MAX_OBJECT_VELOCITY / Math.sqrt(v2);
        v.x *= k; v.y *= k; v.z *= k;
        v2 = MAX_OBJECT_VELOCITY * MAX_OBJECT_VELOCITY;
      }
      if (this.onWalkable) {
        // calc_friction against the contact plane (up): drop the into-plane part, then damp.
        if (v.z < SMALL_VELOCITY) {
          v.z = 0;
          const k = Math.pow(1 - this.friction, q);
          v.x *= k; v.y *= k;
        }
      }
      if (v2 - SMALL_VELOCITY * SMALL_VELOCITY < F_EPSILON) { v.x = 0; v.y = 0; v.z = 0; }
      const a = this.acceleration;
      frame.origin = {
        x: frame.origin.x + v.x * q + 0.5 * a.x * q * q,
        y: frame.origin.y + v.y * q + 0.5 * a.y * q * q,
        z: frame.origin.z + v.z * q + 0.5 * a.z * q * q,
      };
    }
    const a = this.acceleration;
    v.x += a.x * q; v.y += a.y * q; v.z += a.z * q;
    // Frame::grotate(omega · q) — about the global axes.
    const w = this.omega;
    const l = Math.hypot(w.x * q, w.y * q, w.z * q);
    if (l >= F_EPSILON) {
      const s = Math.sin(l / 2) / l;
      frame.orientation = quatNormalized(quatMultiply({ w: Math.cos(l / 2), x: w.x * q * s, y: w.y * q * s, z: w.z * q * s }, frame.orientation));
    }
  }
}
