/**
 * `MoveToManager` — the retail client's server-driven move / turn, one port
 * shared by every object: a creature chasing, an NPC turning to face us
 * (DECOMP.remote-moveto-walk-seed / DECOMP.remote-turnto-dropped), and our
 * own character walked to a Use / melee target by the server
 * (DECOMP.server-moveto-steering, DECOMP.client-use-approach).
 *
 * `MovementManager::unpack_movement @ 00524440` reads a movement of type
 * MoveToObject (6) / MoveToPosition (7) / TurnToObject (8) / TurnToHeading
 * (9) — a MoveToObject / TurnToObject whose target this client does not
 * know becomes a MoveToPosition to the sent origin / a TurnToHeading — and
 * hands it here (`PerformMovement @ 0052a900`). The move is a list of nodes:
 *
 *  - `MoveToObject_Internal @ 0052a400` / `MoveToPosition @ 0052a240`: when
 *    `MovementParameters::get_command @ 0052aa00` says there is ground to
 *    cover, a TurnToHeading node (face the target) THEN a MoveToPosition
 *    node; with UseFinalHeading (0x40) a last TurnToHeading node
 *    (MoveToObject: the heading to the target + desired_heading; position:
 *    desired_heading).
 *  - `BeginTurnToHeading @ 00529b90` turns in place — TurnRight when the
 *    heading difference is at most 180°, else TurnLeft — at the move's
 *    speed; `HandleTurnToHeading @ 0052a0c0` snaps onto the heading once
 *    it is passed (`heading_greater`).
 *  - `BeginMoveForward @ 00529a00` asks get_command ONCE: WalkForward with
 *    HoldKey Run when CanCharge (0x10) is set or CanRun and not CanWalk, or
 *    the distance left beyond DistanceToObject exceeds WalkRunThreshold —
 *    `adjust_motion` turns that into RunForward at the run rate.
 *    `HandleMoveToPosition @ 00529d80` steers with an aux TurnLeft /
 *    TurnRight while the heading to the target is off by more than
 *    FOLLOW_TURNING_THRESHHOLD (20°), and ends the node inside
 *    DistanceToObject (or beyond MinDistance when moving away); a mover
 *    farther than FailDistance from where it started cancels.
 *  - With no node left: Sticky (0x80) sticks to the target
 *    (StickyManager), then `CleanUpAndCallWeenie` stops the motions and
 *    `StopCompletely` returns to Ready.
 *
 * `UseTime @ 0052a780` runs the head node each frame while the object is on
 * the ground. There is no timeout: a move ends on arrival, on the next
 * movement (unpack_movement cancels first), when its target leaves, or when
 * it charges too far.
 */
import { MotionCommand } from '../animation/MotionCommands.js';
import { HoldKey } from '../world/RemoteMotion.js';
import { headingFromTo } from '../world/Heading.js';
import type { SeqV3 } from '../animation/SequenceFrame.js';
import type { ParsedMoveTo, ParsedTurnTo } from '@ac/network';

/** `F_EPSILON`. */
const F_EPSILON = 0.0002;
/** `FOLLOW_TURNING_THRESHHOLD` (degrees). */
export const FOLLOW_TURNING_THRESHHOLD = 20;

/**
 * Our character's turn rate at speed 1 (rad/s): the human motion table's
 * TurnRight cycle omega (0x09000001 cycle 0x3d000d, omega z = −1.5 — the
 * rate keyboard turning uses, CameraController BASE_TURN_RATE). A TurnRight
 * at speed s turns the heading up (clockwise) at s × this.
 */
export const PLAYER_TURN_OMEGA = 1.5;

/** MovementParameters bits (`MovementParameters::bitfield`). */
export const MoveFlag = {
  CanWalk: 0x1,
  CanRun: 0x2,
  CanSidestep: 0x4,
  CanWalkBackwards: 0x8,
  CanCharge: 0x10,
  FailWalk: 0x20,
  UseFinalHeading: 0x40,
  Sticky: 0x80,
  MoveAway: 0x100,
  MoveTowards: 0x200,
  UseSpheres: 0x400,
  SetHoldKey: 0x800,
  Autonomous: 0x1000,
  ModifyRawState: 0x2000,
  ModifyInterpretedState: 0x4000,
  CancelMoveTo: 0x8000,
  StopCompletely: 0x10000,
  DisableJumpDuringLink: 0x20000,
} as const;

/** `MovementType`. */
export const MoveType = { Invalid: 0, MoveToObject: 6, MoveToPosition: 7, TurnToObject: 8, TurnToHeading: 9 } as const;

/** `MovementParameters`. */
export interface MovementParams {
  flags: number;
  distanceToObject: number;
  minDistance: number;
  failDistance: number;
  speed: number;
  walkRunThreshold: number;
  desiredHeading: number;
  holdKeyToApply: number;
}

/** `MovementParameters::MovementParameters @ 00524380`: the constructor's defaults. */
export function defaultMovementParams(): MovementParams {
  return {
    flags: 0x1ee0f,
    distanceToObject: 0.6, // DEFAULT_DISTANCE_TO_OBJECT
    minDistance: 0, // DEFAULT_MIN_DISTANCE
    failDistance: 3.4028235e38, // DEFAULT_FAIL_DISTANCE
    speed: 1,
    walkRunThreshold: 15, // DEFAULT_WALK_RUN_THRESHHOLD
    desiredHeading: 0,
    holdKeyToApply: HoldKey.Invalid,
  };
}

/** `MovementParameters::get_command @ 0052aa00`. */
export function getCommand(p: MovementParams, dist: number): { motion: number; holdKey: number; movingAway: boolean } {
  let motion = 0;
  let movingAway = false;
  const towards = (p.flags & MoveFlag.MoveTowards) !== 0;
  const away = (p.flags & MoveFlag.MoveAway) !== 0;
  if (towards && away) {
    // towards_and_away @ 0052a9a0
    if (p.distanceToObject < dist) { motion = MotionCommand.WalkForward; movingAway = false; }
    else if (dist - p.minDistance < F_EPSILON) { motion = MotionCommand.WalkBackwards; movingAway = true; }
  } else if (!towards && away) {
    if (dist < p.minDistance) { motion = MotionCommand.WalkForward; movingAway = true; }
  } else if (dist > p.distanceToObject) {
    motion = MotionCommand.WalkForward;
    movingAway = false;
  }
  const run = (p.flags & MoveFlag.CanCharge) !== 0
    || ((p.flags & MoveFlag.CanRun) !== 0
      && ((p.flags & MoveFlag.CanWalk) === 0 || dist - p.distanceToObject > p.walkRunThreshold));
  return { motion, holdKey: run ? HoldKey.Run : HoldKey.None, movingAway };
}

/** `MovementParameters::get_desired_heading @ 0052aad0`. */
export function getDesiredHeading(motion: number, movingAway: boolean): number {
  if (motion === MotionCommand.RunForward || motion === MotionCommand.WalkForward) return movingAway ? 180 : 0;
  if (motion === MotionCommand.WalkBackwards) return movingAway ? 0 : 180;
  return 0;
}

/** `heading_diff @ 00528fb0`. */
export function headingDiff(h1: number, h2: number, motion: number): number {
  let r = h1 - h2;
  if (Math.abs(r) < F_EPSILON) r = 0;
  if (r < -F_EPSILON) r += 360;
  if (r > F_EPSILON && motion !== MotionCommand.TurnRight) r = 360 - r;
  return r;
}

/** `heading_greater @ 00528f60`. */
export function headingGreater(h1: number, h2: number, motion: number): boolean {
  const greater = Math.abs(h1 - h2) <= 180 ? h1 > h2 : h2 > h1;
  return motion === MotionCommand.TurnRight ? greater : !greater;
}

/** `Position::cylinder_distance @ 005a97f0`. */
export function cylinderDistance(r1: number, h1: number, p1: SeqV3, r2: number, h2: number, p2: SeqV3): number {
  const d = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) - (r1 + r2);
  let top: number;
  let low: number;
  if (p1.z <= p2.z) { low = p1.z + h1; top = p2.z; } else { low = p2.z + h2; top = p1.z; }
  const gap = top - low;
  if (gap <= 0) return d > 0 ? d : -Math.sqrt(d * d + gap * gap);
  return d > 0 ? Math.sqrt(d * d + gap * gap) : gap;
}

/** The object a MoveToManager moves. */
export interface MoveToHost {
  /** Position (AC world axes). */
  position(): SeqV3;
  heading(): number;
  /** `CPhysicsObj::set_heading(h, 1)`. */
  setHeading(heading: number): void;
  radius(): number;
  height(): number;
  /** `_DoMotion`: adjust_motion(motion, speed, holdKey) then DoInterpretedMotion. Returns 0 on success. */
  doMotion(motion: number, speed: number, holdKey: number): number;
  /** `_StopMotion`: adjust_motion then StopInterpretedMotion. */
  stopMotion(motion: number, speed: number, holdKey: number): number;
  /** `CPhysicsObj::StopCompletely`. */
  stopCompletely(): void;
  /** `CPhysicsObj::motions_pending`. */
  motionsPending(): boolean;
  /** transient_state & Contact. */
  hasContact(): boolean;
  /** A target object's position, radius and height (null = not known). */
  target(id: number): { pos: SeqV3; radius: number; height: number } | null;
  /** `PositionManager::StickTo`. */
  stickTo?(id: number, radius: number, height: number): void;
  /** `CPhysicsObj::unstick_from_object`. */
  unstick?(): void;
  /** A move / turn ended (`CleanUpAndCallWeenie`): 0 = arrived, else the WeenieError. */
  onComplete?(status: number): void;
  /** Seconds (Timer::cur_time). */
  now(): number;
}

type Node = { type: typeof MoveType.MoveToPosition } | { type: typeof MoveType.TurnToHeading; heading: number };

/** WeenieErrors CancelMoveTo reports. */
export const MoveToError = { None: 0, NoPhysicsObject: 8, ActionCancelled: 0x36, ObjectGone: 0x37, NoObject: 0x38, YouChargedTooFar: 0x3d } as const;

export class MoveToManager {
  movementType: number = MoveType.Invalid;
  params: MovementParams = { ...defaultMovementParams(), flags: 0 };
  soughtPosition: SeqV3 = { x: 0, y: 0, z: 0 };
  /** The sought frame's heading (TurnToObject_Internal adds it to the heading to the target). */
  soughtHeading = 0;
  currentTargetPosition: SeqV3 = { x: 0, y: 0, z: 0 };
  startingPosition: SeqV3 = { x: 0, y: 0, z: 0 };
  previousHeading = 0;
  previousDistance = 3.4028235e38;
  previousDistanceTime = 0;
  originalDistance = 3.4028235e38;
  originalDistanceTime = 0;
  failProgressCount = 0;
  soughtObjectId = 0;
  topLevelObjectId = 0;
  soughtObjectRadius = 0;
  soughtObjectHeight = 0;
  currentCommand = 0;
  auxCommand = 0;
  movingAway = false;
  initialized = false;
  pending: Node[] = [];

  constructor(private host: MoveToHost) {
    this.initializeLocalVariables();
  }

  /** `is_moving_to @ 00529220`. */
  isMovingTo(): boolean {
    return this.movementType !== MoveType.Invalid;
  }

  /** `InitializeLocalVariables @ 00529250`. */
  private initializeLocalVariables(): void {
    const now = this.host.now();
    this.movementType = MoveType.Invalid;
    this.params.flags = 0;
    this.previousDistance = 3.4028235e38;
    this.previousDistanceTime = now;
    this.originalDistance = 3.4028235e38;
    this.originalDistanceTime = now;
    this.previousHeading = 0;
    this.failProgressCount = 0;
    this.currentCommand = 0;
    this.auxCommand = 0;
    this.movingAway = false;
    this.initialized = false;
    this.soughtPosition = { x: 0, y: 0, z: 0 };
    this.soughtHeading = 0;
    this.currentTargetPosition = { x: 0, y: 0, z: 0 };
    this.soughtObjectId = 0;
    this.topLevelObjectId = 0;
    this.soughtObjectRadius = 0;
    this.soughtObjectHeight = 0;
  }

  /** A fresh MovementParameters for a _DoMotion / _StopMotion (CancelMoveTo bit cleared). */
  private motionParams(holdKey: number, speed = 1): { speed: number; holdKey: number } {
    return { speed, holdKey };
  }

  private doMotion(motion: number, p: { speed: number; holdKey: number }): number {
    return this.host.doMotion(motion, p.speed, p.holdKey);
  }

  private stopMotion(motion: number, p: { speed: number; holdKey: number }): number {
    return this.host.stopMotion(motion, p.speed, p.holdKey);
  }

  /** `CleanUp @ 005295c0`. */
  private cleanUp(): void {
    const p = this.motionParams(this.params.holdKeyToApply);
    if (this.currentCommand) this.stopMotion(this.currentCommand, p);
    if (this.auxCommand) this.stopMotion(this.auxCommand, p);
    this.initializeLocalVariables();
  }

  /** `CleanUpAndCallWeenie @ 00529650`. */
  private cleanUpAndCallWeenie(status: number): void {
    this.cleanUp();
    this.host.stopCompletely();
    this.host.onComplete?.(status);
  }

  /** `CancelMoveTo @ 00529930`. */
  cancelMoveTo(status: number = MoveToError.ActionCancelled): void {
    if (this.movementType === MoveType.Invalid) return;
    this.pending.length = 0;
    this.cleanUpAndCallWeenie(status);
  }

  /** `GetCurrentDistance @ 005291b0`. */
  getCurrentDistance(): number {
    const me = this.host.position();
    if (this.params.flags & MoveFlag.UseSpheres) {
      return cylinderDistance(this.host.radius(), this.host.height(), me,
        this.soughtObjectRadius, this.soughtObjectHeight, this.currentTargetPosition);
    }
    const t = this.currentTargetPosition;
    return Math.hypot(t.x - me.x, t.y - me.y, t.z - me.z);
  }

  /** `PerformMovement @ 0052a900` for a MoveToObject: `MoveToObject @ 00529680`. */
  moveToObject(objectId: number, params: MovementParams): void {
    this.cancelMoveTo();
    this.host.unstick?.();
    this.host.stopCompletely();
    const t = this.host.target(objectId);
    this.startingPosition = { ...this.host.position() };
    this.soughtObjectId = objectId;
    this.soughtObjectRadius = t?.radius ?? 0;
    this.soughtObjectHeight = t?.height ?? 0;
    this.movementType = MoveType.MoveToObject;
    this.topLevelObjectId = objectId;
    this.params = { ...params };
    this.initialized = false;
    // set_target: the TargetManager reports the target at once.
    this.updateTarget();
  }

  /** `MoveToPosition @ 0052a240`. */
  moveToPosition(pos: SeqV3, params: MovementParams): void {
    this.cancelMoveTo();
    this.host.unstick?.();
    this.host.stopCompletely();
    this.currentTargetPosition = { ...pos };
    this.soughtObjectRadius = 0;
    // get_command runs with the NEW params (its argument), GetCurrentDistance with the old.
    const dist = this.getCurrentDistance();
    const cmd = getCommand(params, dist);
    if (cmd.motion) {
      this.addTurnToHeadingNode(headingFromTo(this.host.position(), pos));
      this.addMoveToPositionNode();
    }
    if (params.flags & MoveFlag.UseFinalHeading) this.addTurnToHeadingNode(params.desiredHeading);
    this.soughtPosition = { ...pos };
    this.startingPosition = { ...this.host.position() };
    this.movementType = MoveType.MoveToPosition;
    this.params = { ...params, flags: params.flags & ~MoveFlag.Sticky };
    this.beginNextNode();
  }

  /** `TurnToObject @ 005297d0`. */
  turnToObject(objectId: number, params: MovementParams): void {
    this.cancelMoveTo();
    this.host.unstick?.();
    if (params.flags & MoveFlag.StopCompletely) this.host.stopCompletely();
    this.movementType = MoveType.TurnToObject;
    this.soughtObjectId = objectId;
    this.topLevelObjectId = objectId;
    this.params = { ...params };
    this.initialized = false;
    this.updateTarget();
  }

  /** `TurnToHeading @ 0052a630`. */
  turnToHeading(params: MovementParams): void {
    this.cancelMoveTo();
    this.host.unstick?.();
    if (params.flags & MoveFlag.StopCompletely) this.host.stopCompletely();
    this.params = { ...params, flags: params.flags & ~MoveFlag.Sticky };
    this.soughtHeading = params.desiredHeading;
    this.movementType = MoveType.TurnToHeading;
    this.pending.push({ type: MoveType.TurnToHeading, heading: params.desiredHeading });
    this.beginNextNode();
  }

  /** `MoveToObject_Internal @ 0052a400`. */
  private moveToObjectInternal(targetPos: SeqV3): void {
    this.soughtPosition = { ...targetPos };
    this.currentTargetPosition = { ...targetPos };
    const iHeading = headingFromTo(this.host.position(), targetPos);
    const dist = this.getCurrentDistance();
    const cmd = getCommand(this.params, dist);
    if (cmd.motion) {
      this.addTurnToHeadingNode(iHeading);
      this.addMoveToPositionNode();
    }
    if (this.params.flags & MoveFlag.UseFinalHeading) {
      let h = iHeading + this.params.desiredHeading;
      if (h >= 360) h -= 360;
      this.addTurnToHeadingNode(h);
    }
    this.initialized = true;
    this.beginNextNode();
  }

  /** `TurnToObject_Internal @ 0052a550`. */
  private turnToObjectInternal(targetPos: SeqV3): void {
    this.currentTargetPosition = { ...targetPos };
    const h = (this.soughtHeading + headingFromTo(this.host.position(), targetPos)) % 360;
    this.soughtHeading = h;
    this.pending.push({ type: MoveType.TurnToHeading, heading: h });
    this.initialized = true;
    this.beginNextNode();
  }

  /** `HandleUpdateTarget @ 0052a7d0` — the TargetManager's report on the target. */
  updateTarget(): void {
    if (!this.topLevelObjectId || this.movementType === MoveType.Invalid) return;
    const t = this.host.target(this.topLevelObjectId);
    if (!this.initialized) {
      if (!t) { this.cancelMoveTo(MoveToError.NoObject); return; }
      if (this.movementType === MoveType.MoveToObject) this.moveToObjectInternal(t.pos);
      else if (this.movementType === MoveType.TurnToObject) this.turnToObjectInternal(t.pos);
      return;
    }
    if (!t) { this.cancelMoveTo(MoveToError.ObjectGone); return; }
    if (this.movementType === MoveType.MoveToObject) {
      this.soughtPosition = { ...t.pos };
      this.currentTargetPosition = { ...t.pos };
      this.previousDistance = 3.4028235e38;
      this.previousDistanceTime = this.host.now();
      this.originalDistance = 3.4028235e38;
      this.originalDistanceTime = this.host.now();
    }
  }

  private addTurnToHeadingNode(heading: number): void {
    this.pending.push({ type: MoveType.TurnToHeading, heading });
  }

  private addMoveToPositionNode(): void {
    this.pending.push({ type: MoveType.MoveToPosition });
  }

  /** `BeginNextNode @ 00529cb0`. */
  private beginNextNode(): void {
    const head = this.pending[0];
    if (!head) {
      if (this.params.flags & MoveFlag.Sticky) {
        const r = this.soughtObjectRadius, h = this.soughtObjectHeight, id = this.topLevelObjectId;
        this.cleanUp();
        this.host.stopCompletely();
        this.host.stickTo?.(id, r, h);
        this.host.onComplete?.(MoveToError.None);
        return;
      }
      this.cleanUpAndCallWeenie(MoveToError.None);
      return;
    }
    if (head.type === MoveType.MoveToPosition) this.beginMoveForward();
    else this.beginTurnToHeading();
  }

  /** `BeginMoveForward @ 00529a00`. */
  private beginMoveForward(): void {
    const dist = this.getCurrentDistance();
    const cmd = getCommand(this.params, dist);
    if (!cmd.motion) {
      this.pending.shift();
      this.beginNextNode();
      return;
    }
    const r = this.doMotion(cmd.motion, this.motionParams(cmd.holdKey, this.params.speed));
    if (r) { this.cancelMoveTo(r); return; }
    const now = this.host.now();
    this.currentCommand = cmd.motion;
    this.movingAway = cmd.movingAway;
    this.params.holdKeyToApply = cmd.holdKey;
    this.previousDistance = dist;
    this.previousDistanceTime = now;
    this.originalDistance = dist;
    this.originalDistanceTime = now;
  }

  /** `BeginTurnToHeading @ 00529b90`. */
  private beginTurnToHeading(): void {
    const head = this.pending[0];
    if (!head || head.type !== MoveType.TurnToHeading) { this.cancelMoveTo(MoveToError.NoPhysicsObject); return; }
    if (this.host.motionsPending()) return;
    const diff = headingDiff(head.heading, this.host.heading(), MotionCommand.TurnRight);
    let motion: number;
    if (diff > 180) {
      if (360 <= F_EPSILON + diff) { this.pending.shift(); this.beginNextNode(); return; }
      motion = MotionCommand.TurnLeft;
    } else {
      if (diff <= F_EPSILON) { this.pending.shift(); this.beginNextNode(); return; }
      motion = MotionCommand.TurnRight;
    }
    const r = this.doMotion(motion, this.motionParams(this.params.holdKeyToApply, this.params.speed));
    if (r) { this.cancelMoveTo(r); return; }
    this.currentCommand = motion;
    this.previousHeading = diff;
  }

  /** `CheckProgressMade @ 005290f0`. */
  private checkProgressMade(dist: number): boolean {
    const now = this.host.now();
    const dt = now - this.previousDistanceTime;
    if (dt <= 1) return true;
    const d = this.movingAway ? dist - this.previousDistance : this.previousDistance - dist;
    if (d / dt < 0.25) return false;
    this.previousDistance = dist;
    this.previousDistanceTime = now;
    const o = this.movingAway ? dist - this.originalDistance : this.originalDistance - dist;
    return o / (now - this.originalDistanceTime) >= 0.25;
  }

  /** `HandleMoveToPosition @ 00529d80`. */
  private handleMoveToPosition(): void {
    const p = this.motionParams(this.params.holdKeyToApply, this.params.speed);
    if (!this.host.motionsPending()) {
      let h = getDesiredHeading(this.currentCommand, this.movingAway) + headingFromTo(this.host.position(), this.currentTargetPosition);
      if (h >= 360) h -= 360;
      let diff = h - this.host.heading();
      if (Math.abs(diff) < F_EPSILON) diff = 0;
      if (diff < -F_EPSILON) diff += 360;
      if (diff <= FOLLOW_TURNING_THRESHHOLD || 360 - FOLLOW_TURNING_THRESHHOLD <= diff) {
        if (this.auxCommand) { this.stopMotion(this.auxCommand, p); this.auxCommand = 0; }
      } else {
        const aux = diff >= 180 ? MotionCommand.TurnLeft : MotionCommand.TurnRight;
        if (aux !== this.auxCommand) {
          this.doMotion(aux, p);
          this.auxCommand = aux;
        }
      }
    } else if (this.auxCommand) {
      this.stopMotion(this.auxCommand, p);
      this.auxCommand = 0;
    }
    const dist = this.getCurrentDistance();
    if (!this.checkProgressMade(dist)) {
      if (!this.host.motionsPending()) this.failProgressCount++;
      return;
    }
    this.failProgressCount = 0;
    const arrived = this.movingAway ? this.params.minDistance <= dist : dist <= this.params.distanceToObject;
    if (arrived) {
      this.pending.shift();
      this.stopMotion(this.currentCommand, p);
      this.currentCommand = 0;
      if (this.auxCommand) { this.stopMotion(this.auxCommand, p); this.auxCommand = 0; }
      this.beginNextNode();
      return;
    }
    const s = this.startingPosition, me = this.host.position();
    if (Math.hypot(me.x - s.x, me.y - s.y, me.z - s.z) > this.params.failDistance) this.cancelMoveTo(MoveToError.YouChargedTooFar);
  }

  /** `HandleTurnToHeading @ 0052a0c0`. */
  private handleTurnToHeading(): void {
    if (this.currentCommand !== MotionCommand.TurnRight && this.currentCommand !== MotionCommand.TurnLeft) {
      this.beginTurnToHeading();
      return;
    }
    const head = this.pending[0];
    if (!head || head.type !== MoveType.TurnToHeading) return;
    const heading = this.host.heading();
    if (headingGreater(heading, head.heading, this.currentCommand)) {
      this.failProgressCount = 0;
      this.host.setHeading(head.heading);
      this.pending.shift();
      this.stopMotion(this.currentCommand, this.motionParams(this.params.holdKeyToApply));
      this.currentCommand = 0;
      this.beginNextNode();
      return;
    }
    const d = headingDiff(heading, this.previousHeading, this.currentCommand);
    if (d < 180 && F_EPSILON < d) {
      this.failProgressCount = 0;
      this.previousHeading = heading;
      return;
    }
    this.previousHeading = heading;
    if (!this.host.motionsPending()) this.failProgressCount++;
  }

  /** `UseTime @ 0052a780` (with the frame's target report first). */
  useTime(): void {
    if (this.topLevelObjectId && this.movementType !== MoveType.Invalid && this.initialized) this.updateTarget();
    if (!this.host.hasContact()) return;
    const head = this.pending[0];
    if (!head) return;
    if (this.topLevelObjectId !== 0 && this.movementType !== MoveType.Invalid && !this.initialized) return;
    if (head.type === MoveType.MoveToPosition) this.handleMoveToPosition();
    else this.handleTurnToHeading();
  }

  /** `HitGround @ 00529d70`. */
  hitGround(): void {
    if (this.movementType !== MoveType.Invalid) this.beginNextNode();
  }
}

/** The MovementParameters a parsed MoveTo / TurnTo carries (`UnPackNet @ 0052ac50` over the constructor's defaults). */
export function movementParamsFromWire(w: {
  flags: number; distanceToObject?: number; minDistance?: number; failDistance?: number;
  speed: number; walkRunThreshold?: number; desiredHeading: number;
}): MovementParams {
  const d = defaultMovementParams();
  return {
    flags: w.flags >>> 0,
    distanceToObject: w.distanceToObject ?? d.distanceToObject,
    minDistance: w.minDistance ?? d.minDistance,
    failDistance: w.failDistance ?? d.failDistance,
    speed: w.speed,
    walkRunThreshold: w.walkRunThreshold ?? d.walkRunThreshold,
    desiredHeading: w.desiredHeading,
    holdKeyToApply: HoldKey.Invalid,
  };
}

/** A MoveToPosition's destination in AC world axes (landblock-global metres) from its cell + origin. */
export function moveToDestination(m: ParsedMoveTo): SeqV3 {
  const lbX = (m.cellId >>> 24) & 0xff;
  const lbY = (m.cellId >>> 16) & 0xff;
  return { x: lbX * 192 + m.origin.x, y: lbY * 192 + m.origin.y, z: m.origin.z };
}

/**
 * `MovementManager::unpack_movement @ 00524440` cases 6–9: start the move /
 * turn a parsed movement carries. A MoveToObject whose target this client
 * does not know walks to the sent origin (MoveToPosition); a TurnToObject
 * whose target is unknown turns to the sent heading (TurnToHeading).
 * Returns the move's run rate (`my_run_rate`) for a MoveTo, else null.
 */
export function performServerMovement(
  mgr: MoveToManager, type: number, move: { moveTo?: ParsedMoveTo; turnTo?: ParsedTurnTo }, knows: (id: number) => boolean,
): number | null {
  if ((type === MoveType.MoveToObject || type === MoveType.MoveToPosition) && move.moveTo) {
    const m = move.moveTo;
    const params = movementParamsFromWire(m);
    if (type === MoveType.MoveToObject && m.target && knows(m.target)) mgr.moveToObject(m.target, params);
    else mgr.moveToPosition(moveToDestination(m), params);
    return m.runRate;
  }
  if ((type === MoveType.TurnToObject || type === MoveType.TurnToHeading) && move.turnTo) {
    const t = move.turnTo;
    const params = movementParamsFromWire(t);
    if (type === MoveType.TurnToObject && t.target && knows(t.target)) mgr.turnToObject(t.target, params);
    else mgr.turnToHeading(params);
  }
  return null;
}

/**
 * The movement input CharacterAnimController reads for our character while
 * the MoveToManager drives it (a server MoveTo / TurnTo): the forward
 * command (run or walk) and / or a turn, and nothing else of the locomotion
 * keys; everything else (jump charge, …) as the real input says. A
 * prototype-linked view, so the controller's own getters stay live.
 */
export function approachAnimInput<T extends object>(
  input: T, drive: { forward: boolean; running: boolean; turn: 'left' | 'right' | null },
): T {
  return Object.create(input, {
    isMovingForward: { value: drive.forward },
    isMovingBackward: { value: false },
    isStrafingLeft: { value: false },
    isStrafingRight: { value: false },
    isTurningLeft: { value: drive.turn === 'left' },
    isTurningRight: { value: drive.turn === 'right' },
    isRunning: { value: drive.running },
  }) as T;
}
