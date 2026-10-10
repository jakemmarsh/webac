/**
 * The motion interpreter of ANOTHER object (`CMotionInterp`, the part a
 * remote object runs): its interpreted motion state (forward / sidestep /
 * turn command + speed), `adjust_motion`, and the sequence physics that
 * state gives the object's CSequence — the velocity / omega its
 * `UpdatePositionInternal` moves it by (DECOMP.remote-motion-no-displacement).
 *
 * The walk / run / sidestep displacement lives in the animations' root
 * pos-frames (human 0x09000001: RunForward 0x03000002 moves 3.2 m over 24
 * frames at 30 fps = 4 m/s × speed); a turn's is the cycle's omega
 * (TurnRight: z = −1.5 rad/s × speed). `sequencePhysicsFor` reproduces what
 * `CMotionTable::GetObjectSequence` leaves on the sequence:
 *  - the substate's cycle sets it (`add_motion` → SetVelocity / SetOmega);
 *  - a command whose cycle is flagged 0x2 is allowed as the substate only
 *    from the style's default substate (`is_allowed`) — else it is a
 *    MODIFIER, whose MotionData only adds physics (`combine_motion`), unless
 *    the substate's cycle is flagged 0x1 (no modifiers).
 * So a monster turning in place plays its TurnRight cycle, and a runner who
 * also turns keeps the run cycle and adds the turn's omega.
 */
import type { MotionTable, MotionData } from '@ac/dat-parser/file-types/MotionTable.js';
import { MotionCommand, MotionSpeed } from '../animation/MotionCommands.js';
import type { SequencePhysics } from '../animation/SequenceFrame.js';

/** `HoldKey` (acclient enum): Invalid 0, None 1, Run 2. */
export const HoldKey = { Invalid: 0, None: 1, Run: 2 } as const;

/** The interpreted motion state (`InterpretedMotionState`): full MotionCommand ids. */
export interface InterpretedMotion {
  forward: number;
  forwardSpeed: number;
  /** 0 = none. */
  sidestep: number;
  sidestepSpeed: number;
  /** 0 = none. */
  turn: number;
  turnSpeed: number;
  /**
   * The turn became the motion first (GetObjectSequence is incremental: a
   * turn pressed from Ready becomes the substate, and a sidestep pressed
   * after it fails is_allowed — both cycles carry bitfield 0x2 — and plays
   * as a modifier on the turn). Absent / false: the sidestep is resolved
   * first, as apply_interpreted_movement re-applies a whole state.
   */
  turnFirst?: boolean;
}

export function readyMotion(): InterpretedMotion {
  return { forward: MotionCommand.Ready, forwardSpeed: 1, sidestep: 0, sidestepSpeed: 1, turn: 0, turnSpeed: 1 };
}

/** The motion table's key for (style, command) — ACE `(style << 16) | (motion & 0xFFFFFF)`, as MotionManager.compositeKey. */
function key(style: number, motion: number): number {
  return (((style & 0xFFFF) << 16) | (motion & 0xFFFFF)) >>> 0;
}

/**
 * `CMotionInterp::apply_run_to_command @ 00527be0`: WalkForward (forward)
 * becomes RunForward at `runRate` × speed, TurnRight speeds up by
 * run_turn_factor (1.5), SideStepRight by `runRate` (clamped to
 * max_sidestep_anim_rate, 3).
 */
export function applyRunToCommand(motion: number, speed: number, runRate: number): { motion: number; speed: number } {
  if (motion === MotionCommand.WalkForward) {
    return { motion: speed > 0 ? MotionCommand.RunForward : motion, speed: runRate * speed };
  }
  if (motion === MotionCommand.TurnRight) return { motion, speed: MotionSpeed.RunTurnFactor * speed };
  if (motion === MotionCommand.SideStepRight) {
    const s = runRate * speed;
    if (Math.abs(s) > MotionSpeed.MaxSidestepAnimRate) return { motion, speed: s <= 0 ? -MotionSpeed.MaxSidestepAnimRate : MotionSpeed.MaxSidestepAnimRate };
    return { motion, speed: s };
  }
  return { motion, speed };
}

/**
 * `CMotionInterp::adjust_motion @ 00528010` (creatures only — the caller
 * skips it for other weenies): RunForward stays as it is; WalkBackwards →
 * WalkForward × −backwards_factor; TurnLeft → TurnRight × −1;
 * SideStepLeft → SideStepRight × −1; either sidestep × (walk_anim_speed /
 * sidestep_anim_speed) × sidestep_factor; then the hold key (Invalid → the
 * raw state's current one) Run applies apply_run_to_command.
 */
export function adjustMotion(
  motion: number, speed: number, holdKey: number, currentHoldKey: number, runRate: number,
): { motion: number; speed: number } {
  let m = motion;
  let s = speed;
  if (m === MotionCommand.RunForward) return { motion: m, speed: s };
  if (m === MotionCommand.WalkBackwards) {
    m = MotionCommand.WalkForward;
    s *= -MotionSpeed.BackwardsFactor;
  } else if (m === MotionCommand.TurnLeft) {
    m = MotionCommand.TurnRight;
    s *= -1;
  } else if (m === MotionCommand.SideStepLeft || m === MotionCommand.SideStepRight) {
    if (m === MotionCommand.SideStepLeft) s *= -1;
    m = MotionCommand.SideStepRight;
    s *= (MotionSpeed.WalkAnimSpeed / MotionSpeed.SidestepAnimSpeed) * MotionSpeed.SidestepFactor;
  }
  const hk = holdKey === HoldKey.Invalid ? currentHoldKey : holdKey;
  if (hk === HoldKey.Run) return applyRunToCommand(m, s, runRate);
  return { motion: m, speed: s };
}

export function cycleOf(table: MotionTable, style: number, motion: number): MotionData | undefined {
  return table.cycles.get(key(style, motion)) ?? table.cycles.get(key(table.defaultStyle, motion));
}

export function modifierOf(table: MotionTable, style: number, motion: number): MotionData | undefined {
  return table.modifiers.get(key(style, motion)) ?? table.modifiers.get((motion & 0xFFFFF) >>> 0);
}

/** The substate the state plays and the modifiers layered on it (GetObjectSequence's SubState / Modifier branches). */
export interface ResolvedMotion {
  substate: number;
  substateSpeed: number;
  modifiers: { motion: number; speed: number }[];
}

export function resolveMotion(table: MotionTable, style: number, st: InterpretedMotion): ResolvedMotion {
  const defaultSub = table.styleDefaults.get(style) ?? table.styleDefaults.get(table.defaultStyle) ?? MotionCommand.Ready;
  let substate = st.forward || MotionCommand.Ready;
  let substateSpeed = st.forwardSpeed;
  if (!cycleOf(table, style, substate)) { substate = defaultSub; substateSpeed = 1; }
  const modifiers: { motion: number; speed: number }[] = [];
  const order = st.turnFirst
    ? [[st.turn, st.turnSpeed], [st.sidestep, st.sidestepSpeed]] as const
    : [[st.sidestep, st.sidestepSpeed], [st.turn, st.turnSpeed]] as const;
  for (const [motion, speed] of order) {
    if (!motion) continue;
    const cyc = cycleOf(table, style, motion);
    // is_allowed: an unflagged cycle, the current substate, or from the default substate.
    if (cyc && ((cyc.bitfield & 2) === 0 || motion === substate || substate === defaultSub)) {
      substate = motion;
      substateSpeed = speed;
      continue;
    }
    const subCycle = cycleOf(table, style, substate);
    if (subCycle && (subCycle.bitfield & 1) !== 0) continue;
    if (modifierOf(table, style, motion)) modifiers.push({ motion, speed });
  }
  return { substate, substateSpeed, modifiers };
}

/**
 * The CSequence velocity / omega for a motion state: the substate cycle's
 * (`add_motion`: data × speed) plus every modifier's (`combine_motion`).
 * Object-local AC axes.
 */
export function sequencePhysicsFor(table: MotionTable | null, style: number, st: InterpretedMotion): SequencePhysics {
  const physics: SequencePhysics = { velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } };
  if (!table) return physics;
  const add = (data: MotionData | undefined, speed: number) => {
    if (!data) return;
    if (data.velocity) {
      physics.velocity.x += data.velocity.x * speed;
      physics.velocity.y += data.velocity.y * speed;
      physics.velocity.z += data.velocity.z * speed;
    }
    if (data.omega) {
      physics.omega.x += data.omega.x * speed;
      physics.omega.y += data.omega.y * speed;
      physics.omega.z += data.omega.z * speed;
    }
  };
  const r = resolveMotion(table, style, st);
  add(cycleOf(table, style, r.substate), r.substateSpeed);
  for (const m of r.modifiers) add(modifierOf(table, style, m.motion), m.speed);
  return physics;
}

/**
 * `InterpretedMotionState::ApplyMotion` / `RemoveMotion` as
 * `CMotionInterp::DoInterpretedMotion @ 00528360` /
 * `StopInterpretedMotion @ 00528470` use them: a sidestep or turn command
 * fills its own slot, anything else the forward one; stopping the forward
 * command returns it to Ready.
 */
export function applyInterpretedMotion(st: InterpretedMotion, motion: number, speed: number): void {
  if (motion === MotionCommand.SideStepRight || motion === MotionCommand.SideStepLeft) {
    st.sidestep = motion; st.sidestepSpeed = speed;
  } else if (motion === MotionCommand.TurnRight || motion === MotionCommand.TurnLeft) {
    st.turn = motion; st.turnSpeed = speed;
  } else {
    st.forward = motion; st.forwardSpeed = speed;
  }
}

export function removeInterpretedMotion(st: InterpretedMotion, motion: number): void {
  if (motion === st.sidestep) { st.sidestep = 0; st.sidestepSpeed = 1; }
  else if (motion === st.turn) { st.turn = 0; st.turnSpeed = 1; }
  else if (motion === st.forward) { st.forward = MotionCommand.Ready; st.forwardSpeed = 1; }
}

/**
 * `CMotionInterp::get_adjusted_max_speed @ 00527d00`: run_anim_speed ×
 * (the forward speed while RunForward — current_speed_factor is always 1 —
 * else my_run_rate).
 */
export function adjustedMaxSpeed(st: InterpretedMotion, runRate: number): number {
  const rate = st.forward === MotionCommand.RunForward ? st.forwardSpeed : runRate;
  return rate * MotionSpeed.RunAnimSpeed;
}

/** `CMotionInterp::get_max_speed @ 00527cb0`: run_anim_speed × my_run_rate. */
export function maxSpeed(runRate: number): number {
  return runRate * MotionSpeed.RunAnimSpeed;
}


/**
 * `CMotionInterp::contact_allows_move @ 00528240` for a creature: Dead,
 * Falling and the turns always may; otherwise an object with Gravity must
 * stand on walkable ground (transient Contact + OnWalkable). Non-creatures
 * and gravity-less objects always may.
 */
export function contactAllowsMove(motion: number, isCreature: boolean, hasGravity: boolean, onGround: boolean): boolean {
  const m = motion >>> 0;
  if (m === MotionCommand.Dead || m === MotionCommand.Falling) return true;
  if (m === MotionCommand.TurnRight || m === MotionCommand.TurnLeft) return true;
  if (!isCreature || !hasGravity) return true;
  return onGround;
}

/**
 * `CMotionInterp::apply_interpreted_movement @ 00528600`'s choice of what the
 * sequence plays: when contact does not allow the forward command (a
 * creature in the air) the forward AND sidestep become Falling at speed 1;
 * the turn always applies. The interpreted state itself is unchanged
 * (ModifyInterpretedState is off), so landing (HitGround →
 * apply_current_movement) plays it again.
 */
export function appliedMotion(st: InterpretedMotion, allowsMove: boolean): InterpretedMotion {
  if (allowsMove) return st;
  return { forward: MotionCommand.Falling, forwardSpeed: 1, sidestep: 0, sidestepSpeed: 1, turn: st.turn, turnSpeed: st.turnSpeed };
}

/**
 * `CMotionInterp::get_state_velocity @ 00527d50` — the object-local velocity
 * (x = sidestep right, y = forward) the interpreted state implies:
 * sidestep_anim_speed × the sidestep speed, walk_anim_speed / run_anim_speed
 * × the forward speed, capped at run_anim_speed × my_run_rate.
 */
export function stateVelocity(st: InterpretedMotion, runRate: number): { x: number; y: number; z: number } {
  const v = { x: 0, y: 0, z: 0 };
  if (st.sidestep === MotionCommand.SideStepRight) v.x = MotionSpeed.SidestepAnimSpeed * st.sidestepSpeed;
  if (st.forward === MotionCommand.WalkForward) v.y = MotionSpeed.WalkAnimSpeed * st.forwardSpeed;
  else if (st.forward === MotionCommand.RunForward) v.y = MotionSpeed.RunAnimSpeed * st.forwardSpeed;
  const max = runRate * MotionSpeed.RunAnimSpeed;
  const len = Math.hypot(v.x, v.y);
  if (len > max) { v.x *= max / len; v.y *= max / len; }
  return v;
}

/**
 * `CMotionInterp::get_leave_ground_velocity @ 005280c0` for an object that
 * never charged a jump (jump_extent 0 → get_jump_v_z 0): the state velocity
 * with no lift — or null when that is zero, which keeps the object's own
 * velocity (the code's localize-then-set_local round trip of it). A
 * VectorUpdate jump therefore survives only with a still interpreted state:
 * ACE sends a blank UpdateMotion before each jump's VectorUpdate for exactly
 * this (Player.HandleActionJump).
 */
export function leaveGroundVelocity(st: InterpretedMotion, runRate: number): { x: number; y: number; z: number } | null {
  const v = stateVelocity(st, runRate);
  if (Math.abs(v.x) < 0.0002 && Math.abs(v.y) < 0.0002) return null;
  return v;
}

/** What sequenceRootVelocity reads of an Animation. */
export type RootAnimationLoader = (animId: number) => { numFrames: number; posFrames: { origin: { x: number; y: number; z: number } }[] } | null;

const rootVelocityCache = new WeakMap<MotionData, { x: number; y: number; z: number }>();

/**
 * The average root velocity (object-local m/s at speed 1) a cycle's
 * pos-frames carry: every AnimData's frames low..high folded in at its
 * framerate (a negative framerate walks them backwards — CSequence::
 * update_internal subtracts the pos-frame), over the cycle's whole time.
 */
export function cycleRootVelocity(data: MotionData, load: RootAnimationLoader): { x: number; y: number; z: number } {
  const hit = rootVelocityCache.get(data);
  if (hit) return hit;
  const d = { x: 0, y: 0, z: 0 };
  let time = 0;
  for (const a of data.anims) {
    const an = load(a.animId);
    if (!an || !(Math.abs(a.framerate) > 0)) continue;
    const hi = a.highFrame < 0 || a.highFrame >= an.numFrames ? an.numFrames - 1 : a.highFrame;
    const lo = Math.max(0, a.lowFrame);
    const n = hi - lo + 1;
    if (n <= 0) continue;
    const sign = Math.sign(a.framerate);
    for (let i = lo; i <= hi; i++) {
      const p = an.posFrames[i];
      if (!p) continue;
      d.x += sign * p.origin.x; d.y += sign * p.origin.y; d.z += sign * p.origin.z;
    }
    time += n / Math.abs(a.framerate);
  }
  const v = time > 0 ? { x: d.x / time, y: d.y / time, z: d.z / time } : { x: 0, y: 0, z: 0 };
  rootVelocityCache.set(data, v);
  return v;
}

/**
 * The velocity (object-local m/s) the sequence for an interpreted state
 * moves its object by, averaged over the cycle: the substate cycle's root
 * pos-frames × its speed plus its MotionData velocity, plus every
 * modifier's velocity (GetObjectSequence: add_motion / combine_motion;
 * CPhysicsObj::UpdatePositionInternal takes this offset every frame). This
 * — not get_state_velocity, which retail uses only for a jump's
 * leave-ground velocity — is how fast a retail character walks, runs and
 * strafes: a peace-mode walk is 2.6 m/s, a combat stance's walk ~1.2–1.4,
 * a sidestep from standing its own cycle's pace, and a sidestep while
 * walking / running the SideStepRight modifier's 1.25 m/s × speed added to
 * the forward motion without any cap (the strafe-run diagonal).
 */
export function sequenceRootVelocity(
  table: MotionTable, style: number, st: InterpretedMotion, load: RootAnimationLoader,
): { x: number; y: number; z: number } {
  const v = { x: 0, y: 0, z: 0 };
  const r = resolveMotion(table, style, st);
  const cyc = cycleOf(table, style, r.substate);
  if (cyc) {
    const u = cycleRootVelocity(cyc, load);
    v.x += u.x * r.substateSpeed; v.y += u.y * r.substateSpeed; v.z += u.z * r.substateSpeed;
    if (cyc.velocity) { v.x += cyc.velocity.x * r.substateSpeed; v.y += cyc.velocity.y * r.substateSpeed; v.z += cyc.velocity.z * r.substateSpeed; }
  }
  for (const m of r.modifiers) {
    const mod = modifierOf(table, style, m.motion);
    if (mod?.velocity) { v.x += mod.velocity.x * m.speed; v.y += mod.velocity.y * m.speed; v.z += mod.velocity.z * m.speed; }
  }
  return v;
}
