/**
 * MOVE.chunked-motion-judder — draw a body that moves in whole steps
 * (animation frames, physics quanta) at its in-between position on the
 * frames between those steps.
 *
 * Retail moves an object only when its sequence steps over a WHOLE animation
 * frame: `CSequence::update_internal @ 005255d0` folds the frame's root
 * pos-frame in and calls `CSequence::apply_physics @ 00524ab0` for
 * 1 / framerate once per frame stepped over (a node at framerate 0 is the
 * only one moved by the elapsed time). A running character's cycle steps at
 * 30 × the run rate frames per second, so the body advances in ~0.13 m jumps
 * 45–90 times a second, and a remote object's own velocity moves in
 * MIN_QUANTUM (1/30 s) updates (`CPhysics::UseTime @ 00509950`). Drawn at the
 * browser's 60–144 Hz that is a staircase: frames that do not move followed
 * by frames that move a whole step (measured on the human motion table: a
 * run at 144 Hz drew 0, 0, 0, 19.2 m/s, …), which players saw as a stutter
 * or "motion blur" on fast and combined motions (launch reports 2026-10-12).
 * Retail drew at most one frame per update, so it never showed the gaps.
 *
 * This is presentation only: the simulated position (collision, the wire,
 * the radar, everything else) is untouched and stays retail's. The drawn
 * position is the simulated one minus a lag: the last step's displacement
 * scaled by how much of the next step is still to come,
 *   lag = (1 − phase) × lastStep,   drawn = simulated − lag,
 * i.e. the body is drawn on the straight line from where the last step
 * started to where it ended, at the fraction of the step interval that has
 * passed. When the steps are even, the drawn body moves the same distance
 * every frame; it never runs ahead of the simulation (no position is drawn
 * that the body has not reached), and the lag is at most one step.
 *
 * `phase` is the fraction of the CURRENT step interval already elapsed
 * (AnimationPlayer.stepPhase: the frame number's fraction). Null means the
 * source is not stepping (a framerate-0 node, nothing playing, airborne
 * movement on continuous velocity): the lag then fades out over
 * FADE_SECONDS, so it never sticks.
 */

/** A displacement: metres on three axes plus a heading change (radians). */
export interface StepVector { x: number; y: number; z: number; yaw: number }

/** A lag left over when stepping stops fades out over this long (one 30 fps frame). */
export const FADE_SECONDS = 1 / 30;
/** A lag past these (a teleport mid-step, a snap) is dropped rather than drawn. */
const MAX_LAG_METRES = 2;
const MAX_LAG_RADIANS = 0.6;

const zero = (): StepVector => ({ x: 0, y: 0, z: 0, yaw: 0 });

export class StepSmoother {
  /** What to subtract from the simulated position (and heading) to draw it. */
  readonly lag: StepVector = zero();
  private step: StepVector = zero();
  private lastPhase = 1;
  private lastEpoch: number | undefined = undefined;

  /** Drop any lag (a teleport, a snap, a new body). */
  reset(): void {
    this.lag.x = this.lag.y = this.lag.z = this.lag.yaw = 0;
    this.step = zero();
    this.lastPhase = 1;
    this.lastEpoch = undefined;
  }

  /**
   * One drawn frame.
   * @param steps whole steps the source took this frame (0 = none)
   * @param moved the displacement those steps produced this frame (ignored when `steps` is 0)
   * @param phase the elapsed fraction of the current step interval, [0, 1), or null when not stepping
   * @param dt the frame's seconds (for the fade)
   * @param epoch changes whenever the source restarts its interval on its own (AnimationPlayer.nodeEpoch: a new node)
   */
  update(steps: number, moved: StepVector | null, phase: number | null, dt: number, epoch?: number): StepVector {
    const lag = this.lag;
    const restarted = epoch !== undefined && this.lastEpoch !== undefined && epoch !== this.lastEpoch;
    this.lastEpoch = epoch;
    if (phase === null || !(phase >= 0)) {
      const k = Math.max(0, 1 - Math.max(0, dt) / FADE_SECONDS);
      lag.x *= k; lag.y *= k; lag.z *= k; lag.yaw *= k;
      this.step = zero();
      this.lastPhase = 1;
      return lag;
    }
    const p = Math.min(phase, 1);
    const rest = 1 - p;
    if (steps > 0 && moved) {
      this.step = { x: moved.x / steps, y: moved.y / steps, z: moved.z / steps, yaw: moved.yaw / steps };
    } else if (restarted || p < this.lastPhase - 1e-9) {
      // The interval restarted without a step (a new node put on the
      // sequence — a substate change starts its cycle with no offset): keep
      // the drawn position where it was and close the lag over the new interval.
      const k = rest > 1e-6 ? 1 / rest : 0;
      this.step = { x: lag.x * k, y: lag.y * k, z: lag.z * k, yaw: lag.yaw * k };
    }
    this.lastPhase = p;
    const s = this.step;
    lag.x = s.x * rest; lag.y = s.y * rest; lag.z = s.z * rest; lag.yaw = s.yaw * rest;
    if (Math.hypot(lag.x, lag.y, lag.z) > MAX_LAG_METRES || Math.abs(lag.yaw) > MAX_LAG_RADIANS) this.reset();
    return lag;
  }
}

/** One drawn frame of the local player (main.ts): where its body was and is, and how its sequence stepped. */
export interface LocalStepFrame {
  /** Whole frames the player's sequence stepped this frame (AnimationPlayer.takeSteps). */
  steps: number;
  /** AnimationPlayer.stepPhase after the step. */
  phase: number | null;
  /** AnimationPlayer.nodeEpoch after the step. */
  epoch?: number;
  /**
   * The body moved by its sequence this frame: on the ground all frame, not
   * sliding, not carried by a server MoveTo (those move it by continuous
   * velocity, which needs no smoothing).
   */
  sequenceDriven: boolean;
  /** The simulated position before / after the frame (x, feet height, z). */
  before: { x: number; y: number; z: number };
  after: { x: number; y: number; z: number };
  dt: number;
}

/** The local player's draw lag this frame (subtract it from the simulated position to draw the body and aim the camera). */
export function updateLocalStepLag(smoother: StepSmoother, f: LocalStepFrame): StepVector {
  if (!f.sequenceDriven) return smoother.update(0, null, null, f.dt);
  const moved = { x: f.after.x - f.before.x, y: f.after.y - f.before.y, z: f.after.z - f.before.z, yaw: 0 };
  return smoother.update(f.steps, moved, f.phase, f.dt, f.epoch);
}
