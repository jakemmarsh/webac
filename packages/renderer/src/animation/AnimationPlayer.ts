import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import type { Animation } from '@ac/dat-parser/file-types/Animation.js';
import type { AnimationHook, AnimationFrame } from '@ac/dat-parser/file-types/AnimationHook.js';
import { applySequencePhysics, combineFrame, subtractFrame, type SequenceMotion } from './SequenceFrame.js';

export type HookCallback = (hook: AnimationHook, frameIndex: number) => void;

/**
 * Lerp between two numbers.
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Lerp between two 3D vectors.
 */
function lerpVec3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  t: number,
): { x: number; y: number; z: number } {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

/**
 * Spherical linear interpolation between two quaternions.
 */
function slerp(
  a: { w: number; x: number; y: number; z: number },
  b: { w: number; x: number; y: number; z: number },
  t: number,
): { w: number; x: number; y: number; z: number } {
  let dot = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;

  // If dot product is negative, negate one quaternion to take the shorter path
  let bw = b.w, bx = b.x, by = b.y, bz = b.z;
  if (dot < 0) {
    dot = -dot;
    bw = -bw; bx = -bx; by = -by; bz = -bz;
  }

  // If quaternions are very close, use linear interpolation
  if (dot > 0.9995) {
    const result = {
      w: lerp(a.w, bw, t),
      x: lerp(a.x, bx, t),
      y: lerp(a.y, by, t),
      z: lerp(a.z, bz, t),
    };
    // Normalize
    const len = Math.sqrt(result.w * result.w + result.x * result.x + result.y * result.y + result.z * result.z);
    result.w /= len; result.x /= len; result.y /= len; result.z /= len;
    return result;
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;

  return {
    w: wa * a.w + wb * bw,
    x: wa * a.x + wb * bx,
    y: wa * a.y + wb * by,
    z: wa * a.z + wb * bz,
  };
}

/**
 * Interpolate between two Frames (position lerp + orientation slerp).
 */
export function interpolateFrames(a: Frame, b: Frame, t: number): Frame {
  return {
    origin: lerpVec3(a.origin, b.origin, t),
    orientation: slerp(a.orientation, b.orientation, t),
  };
}

/** `F_EPSILON` — acclient.exe .rdata 0x007c84ec = 0.0002f (ACE PhysicsGlobals.EPSILON). */
export const SEQUENCE_EPSILON = 0.0002;

/** Retail's hook directions (ACE AnimationHookDir): a hook fires when its direction is Both (0) or the playing direction. */
export const HOOK_DIR_BACKWARD = -1;
export const HOOK_DIR_BOTH = 0;
export const HOOK_DIR_FORWARD = 1;

/**
 * AnimationPlayer — one animation node played the way the retail client's
 * CSequence plays it (BUG.animationplayer-loop-period-off-by-one-frame;
 * decomp `CSequence::update_internal @ 005255d0`,
 * `advance_to_next_animation @ 005252b0`, `get_curr_animframe @ 00524970`,
 * `AnimSequenceNode::get_starting_frame @ 00525c80` / `get_ending_frame @
 * 00525cb0`, `CPartArray::UpdateParts @ 005190f0`; ACE Sequence.cs:351-443):
 *
 *  - the frame number starts at the node's starting frame — low_frame for
 *    a framerate ≥ 0, high_frame + 1 − F_EPSILON for a negative one — and
 *    advances by framerate × dt (our framerate × speed);
 *  - the parts take the WHOLE frame floor(frame_number) — `get_curr_animframe`
 *    → `UpdateParts` combine it with no interpolation — so each keyframe,
 *    the last included, shows for a full 1/|rate|: an N-frame node lasts
 *    N/|rate| (a 33-frame loop at 30 fps is 1.1 s);
 *  - the node ends when floor(frame_number) passes high_frame (forward) or
 *    drops below low_frame (reverse); the overshoot carries into the next
 *    node — for a looping node, its own starting frame again;
 *  - hooks fire for each whole frame LEFT (forward: floor(old) … floor(new)−1;
 *    reverse the mirror image) with the direction filter of
 *    `CSequence::execute_hooks @ 00524830`. The frame a node ends on is
 *    clamped to its high (low) frame, so that frame's hooks never fire;
 *  - at framerate 0 the frame number never moves: the starting frame is held
 *    (the chargen rest pose, the motion tables' hold cycles).
 *
 * The retail sequence never blends between keyframes or between nodes; a
 * new node (MotionManager's next cycle / link) starts on its starting frame.
 */
export class AnimationPlayer {
  private animation: Animation | null = null;
  private lowFrame = 0;
  private highFrame = 0;
  private framerate = 30;
  private speed = 1.0;
  /** CSequence::frame_number — the absolute (fractional) frame index. */
  private frameNumber = 0;
  private playing = false;
  private looping = true;
  private hookListeners: HookCallback[] = [];
  private completeCallback: (() => void) | null = null;
  private overshoot = 0;
  /** Whole frames stepped over with a root-motion sink since the last takeSteps() (MOVE.chunked-motion-judder). */
  private steps = 0;
  /** Counts play() calls: a new node restarts the step interval (MOVE.chunked-motion-judder). */
  private epoch = 0;

  /** Changes each time a node is put on the player (play), restarting the step interval. */
  get nodeEpoch(): number {
    return this.epoch;
  }

  /**
   * Start playing an animation from its starting frame.
   */
  play(
    animation: Animation,
    lowFrame = 0,
    highFrame = -1,
    framerate = 30,
    speed = 1.0,
    looping = true,
    onComplete?: () => void,
  ): void {
    this.animation = animation;
    this.lowFrame = lowFrame;
    this.highFrame = highFrame < 0 ? animation.numFrames - 1 : highFrame;
    this.framerate = framerate;
    this.speed = speed;
    this.looping = looping;
    this.playing = true;
    this.completeCallback = onComplete ?? null;
    this.overshoot = 0;
    this.frameNumber = this.startingFrame();
    this.epoch++;
  }

  pause(): void {
    this.playing = false;
  }

  resume(): void {
    if (this.animation) this.playing = true;
  }

  stop(): void {
    this.playing = false;
    this.animation = null;
    this.frameNumber = 0;
    this.overshoot = 0;
    this.completeCallback = null;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentAnimation(): Animation | null {
    return this.animation;
  }

  /** The node's speed multiplier (signed: negative plays the node backwards). */
  get playbackSpeed(): number {
    return this.speed;
  }

  /**
   * Re-speed the playing node in place — the frame number is kept
   * (`CSequence::multiply_cyclic_animation_fr`, used by `change_cycle_speed`
   * when a same-substate request only changes the cycle's speed).
   */
  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /**
   * Seconds of the last `update` left over after a non-looping node ended —
   * retail hands them to the next node (`update_internal` recurses with the
   * overshoot); MotionManager plays them into the node it starts next.
   */
  get leftoverTime(): number {
    return this.overshoot;
  }

  /**
   * Register a callback for animation hooks.
   */
  onHook(callback: HookCallback): void {
    this.hookListeners.push(callback);
  }

  /**
   * Remove a hook listener.
   */
  offHook(callback: HookCallback): void {
    const idx = this.hookListeners.indexOf(callback);
    if (idx >= 0) this.hookListeners.splice(idx, 1);
  }

  /**
   * Advance playback by deltaTime seconds (`CSequence::update_internal`).
   *
   * With `motion` (DECOMP.remote-motion-no-displacement — the frame
   * `CPhysicsObj::UpdatePositionInternal @ 00512c30` passes through
   * `CPartArray::Update`): every whole frame stepped over folds its root
   * pos-frame into `motion.frame` (combine forward, subtract backward) and
   * applies the sequence velocity / omega for 1 / |framerate|; a node at
   * framerate 0 applies them for the whole elapsed time.
   */
  update(deltaTime: number, motion?: SequenceMotion): void {
    if (!this.playing || !this.animation) return;
    let time = deltaTime;
    // A looping node wraps onto itself with the overshoot; bound the loop
    // (a long frame hitch over a 1-frame node) — retail recurses unbounded.
    for (let guard = 0; guard < 10_000; guard++) {
      const rate = this.framerate * this.speed;
      if (!(time > 0)) return;
      if (rate === 0) {
        if (motion && Math.abs(time) > SEQUENCE_EPSILON) applySequencePhysics(motion.frame, motion, time, time);
        return;
      }
      const lastFrame = Math.floor(this.frameNumber);
      this.frameNumber += rate * time;
      let done = false;
      let remaining = 0;
      if (rate > 0) {
        if (Math.floor(this.frameNumber) > this.highFrame) {
          const offset = Math.max(this.frameNumber - this.highFrame - 1, 0);
          remaining = Math.abs(rate) > SEQUENCE_EPSILON ? offset / rate : 0;
          this.frameNumber = this.highFrame;
          done = true;
        }
        for (let f = lastFrame; f < Math.floor(this.frameNumber); f++) {
          if (motion) this.stepMotion(motion, f, rate, time, false);
          this.executeHooks(f, HOOK_DIR_FORWARD);
        }
      } else {
        if (Math.floor(this.frameNumber) < this.lowFrame) {
          const offset = Math.min(this.frameNumber - this.lowFrame, 0);
          remaining = Math.abs(rate) > SEQUENCE_EPSILON ? offset / rate : 0;
          this.frameNumber = this.lowFrame;
          done = true;
        }
        for (let f = lastFrame; f > Math.floor(this.frameNumber); f--) {
          if (motion) this.stepMotion(motion, f, rate, time, true);
          this.executeHooks(f, HOOK_DIR_BACKWARD);
        }
      }
      if (!done) return;
      // advance_to_next_animation @ 005252b0 leaving a backwards node
      // subtracts the frame it ends on (low_frame) and applies the physics
      // for one more frame.
      if (motion && rate < 0) this.stepMotion(motion, this.lowFrame, rate, time, true);
      if (!this.looping) {
        // The node is over: the pose holds its end frame until the owner
        // appends the next node (MotionManager's completion path).
        this.playing = false;
        this.overshoot = remaining;
        const cb = this.completeCallback;
        this.completeCallback = null;
        cb?.();
        return;
      }
      // advance_to_next_animation onto the same (first cyclic) node.
      this.frameNumber = this.startingFrame();
      if (motion) this.enterNode(motion);
      time = remaining;
    }
  }

  /**
   * `CSequence::advance_to_next_animation @ 005252b0` arriving on a node
   * that plays forwards: its starting frame's root pos-frame is combined at
   * once and the sequence physics applied for 1 / framerate (ACE
   * Sequence.advance_to_next_animation does the same). So a node's starting
   * frame moves the body on arrival AND again when it is stepped over, and
   * its last frame — the one update_internal clamps to — never does; without
   * this every link and every loop of a cycle came up one frame short
   * (BUG.local-movement-ignores-links). Only a sequence's natural advance
   * arrives this way: the first node of a fresh sequence (append_animation
   * onto an empty list, a cycle that replaced the cyclic tail) starts on its
   * starting frame with no offset.
   */
  enterNode(motion: SequenceMotion): void {
    if (!this.animation) return;
    const rate = this.framerate * this.speed;
    if (!(rate > 0)) return;
    this.stepMotion(motion, Math.floor(this.frameNumber), rate, 1, false);
  }

  /**
   * The current fractional frame position relative to lowFrame
   * (CSequence::frame_number − low_frame).
   */
  get currentFrame(): number {
    if (!this.animation) return 0;
    return this.frameNumber - this.lowFrame;
  }

  /** The whole frame on the parts (`get_curr_animframe`'s floor, kept inside the node). */
  get currentFrameIndex(): number {
    const f = Math.floor(this.frameNumber);
    return Math.min(Math.max(f, this.lowFrame), this.highFrame);
  }

  /**
   * Per-part Frames for the current playback position: the whole keyframe
   * `get_curr_animframe` returns — no interpolation.
   */
  getPartTransforms(): Frame[] {
    if (!this.animation || this.animation.numFrames === 0) return [];
    const partFrame = this.animation.partFrames[this.currentFrameIndex];
    return partFrame ? partFrame.frames.slice() : [];
  }

  /**
   * The root position frame (PosFrames) at the current whole frame, if the animation has them.
   */
  getRootMotion(): Frame | null {
    if (!this.animation || this.animation.posFrames.length === 0) return null;
    const pos = this.animation.posFrames[this.currentFrameIndex];
    return pos ? { ...pos } : null;
  }

  /**
   * MOVE.chunked-motion-judder — how many whole frames moved the body (each
   * `stepMotion`: a frame stepped over, or a node's starting frame on
   * arrival) since the last call, and reset the count. The body's root
   * offset only changes on these steps (update_internal).
   */
  takeSteps(): number {
    const n = this.steps;
    this.steps = 0;
    return n;
  }

  /**
   * MOVE.chunked-motion-judder — the elapsed fraction [0, 1) of the interval
   * to the next whole frame (the frame number's fraction; mirrored for a
   * node playing backwards), or null when the sequence is not stepping
   * (nothing playing, or a framerate-0 node, which moves by elapsed time).
   */
  get stepPhase(): number | null {
    if (!this.playing || !this.animation) return null;
    const rate = this.framerate * this.speed;
    if (rate === 0 || !Number.isFinite(rate)) return null;
    const f = this.frameNumber - Math.floor(this.frameNumber);
    return rate > 0 ? f : Math.min(1 - f, 1 - 1e-9);
  }

  /**
   * One stepped-over frame of `update_internal`: the frame's root pos-frame
   * (when the animation has them) and the sequence physics for 1 / rate.
   */
  private stepMotion(motion: SequenceMotion, frameIndex: number, rate: number, time: number, backward: boolean): void {
    this.steps++;
    const pos = this.animation?.posFrames[frameIndex];
    if (pos) {
      if (backward) subtractFrame(motion.frame, pos);
      else combineFrame(motion.frame, pos);
    }
    if (Math.abs(rate) > SEQUENCE_EPSILON) applySequencePhysics(motion.frame, motion, 1 / rate, time);
  }

  /** `AnimSequenceNode::get_starting_frame`: low_frame, or high_frame + 1 − F_EPSILON when playing backwards. */
  private startingFrame(): number {
    return this.framerate * this.speed >= 0 ? this.lowFrame : this.highFrame + 1 - SEQUENCE_EPSILON;
  }

  /** `CSequence::execute_hooks`: every hook on the frame whose direction is Both or `dir`. */
  private executeHooks(frameIndex: number, dir: number): void {
    if (!this.animation || this.hookListeners.length === 0) return;
    if (frameIndex < 0 || frameIndex >= this.animation.partFrames.length) return;
    for (const hook of this.animation.partFrames[frameIndex].hooks) {
      if (hook.direction !== HOOK_DIR_BOTH && hook.direction !== dir) continue;
      for (const listener of this.hookListeners) listener(hook, frameIndex);
    }
  }
}

export { slerp, lerpVec3 as lerp3 };
