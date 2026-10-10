/**
 * The retail client's `Frame` math the animation sequence moves an object
 * with (AC axes: x east, y north, z up; quaternions w, x, y, z).
 *
 * `CPhysicsObj::UpdatePositionInternal @ 00512c30` hands an identity frame to
 * `CPartArray::Update @ 00517db0` → `CSequence::update` →
 * `CSequence::update_internal @ 005255d0`, which, for every whole animation
 * frame the sequence steps over, folds that frame's root pos-frame in
 * (`Frame::combine @ 00525180` forward, `Frame::subtract1 @ 00535520`
 * backward) and applies the sequence's velocity / omega for 1 / framerate
 * (`CSequence::apply_physics @ 00524ab0` → `Frame::rotate @ 004525b0`). The
 * result is the object-LOCAL offset the object moves by this frame.
 */

export interface SeqV3 { x: number; y: number; z: number }
export interface SeqQuat { w: number; x: number; y: number; z: number }

/** An object-local offset frame (retail `Frame` / `AFrame`). */
export interface SequenceFrame {
  origin: SeqV3;
  orientation: SeqQuat;
}

/** The sequence's physics (`CSequence::velocity` / `omega`), object-local. */
export interface SequencePhysics {
  velocity: SeqV3;
  omega: SeqV3;
}

/** What `CSequence::update(dt, frame)` moves: the offset frame plus the sequence's physics. */
export interface SequenceMotion extends SequencePhysics {
  frame: SequenceFrame;
}

/** `F_EPSILON` (acclient .rdata 0x007c84ec). */
const F_EPSILON = 0.0002;

export function identityFrame(): SequenceFrame {
  return { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } };
}

export function quatMultiply(a: SeqQuat, b: SeqQuat): SeqQuat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatNormalized(q: SeqQuat): SeqQuat {
  const l = Math.hypot(q.w, q.x, q.y, q.z);
  if (l < 1e-12) return { w: 1, x: 0, y: 0, z: 0 };
  return { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l };
}

/** Rotate `v` by `q` (local → global). */
export function rotateVector(q: SeqQuat, v: SeqV3): SeqV3 {
  // v' = v + w·t + q.xyz × t, with t = 2 (q.xyz × v).
  const { w, x, y, z } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/** `Frame::combine @ 00525180`: frame ← frame ∘ b (b's origin in frame's axes). */
export function combineFrame(frame: SequenceFrame, b: SequenceFrame): void {
  const o = rotateVector(frame.orientation, b.origin);
  frame.origin = { x: frame.origin.x + o.x, y: frame.origin.y + o.y, z: frame.origin.z + o.z };
  frame.orientation = quatNormalized(quatMultiply(frame.orientation, b.orientation));
}

/** `Frame::subtract1 @ 00535520`: frame ← frame ∘ b⁻¹. */
export function subtractFrame(frame: SequenceFrame, b: SequenceFrame): void {
  const c = b.orientation;
  frame.orientation = quatNormalized(quatMultiply(frame.orientation, { w: c.w, x: -c.x, y: -c.y, z: -c.z }));
  const o = rotateVector(frame.orientation, b.origin);
  frame.origin = { x: frame.origin.x - o.x, y: frame.origin.y - o.y, z: frame.origin.z - o.z };
}

/**
 * `Frame::rotate @ 004525b0`: rotate by the rotation vector `rot` (axis ×
 * angle) about the frame's LOCAL axes (the vector is taken local → global,
 * then `grotate`), i.e. q ← q · r.
 */
export function rotateFrameLocal(frame: SequenceFrame, rot: SeqV3): void {
  const l2 = rot.x * rot.x + rot.y * rot.y + rot.z * rot.z;
  if (l2 < F_EPSILON * F_EPSILON) return;
  const l = Math.sqrt(l2);
  const s = Math.sin(l * 0.5) / l;
  frame.orientation = quatNormalized(quatMultiply(frame.orientation, { w: Math.cos(l * 0.5), x: rot.x * s, y: rot.y * s, z: rot.z * s }));
}

/**
 * `CSequence::apply_physics @ 00524ab0`: origin += velocity · q, then
 * rotate by omega · q, where q = |quantum| signed by the elapsed time.
 */
export function applySequencePhysics(frame: SequenceFrame, physics: SequencePhysics, quantum: number, sign: number): void {
  const q = sign < 0 ? -Math.abs(quantum) : Math.abs(quantum);
  const v = physics.velocity;
  frame.origin = { x: frame.origin.x + v.x * q, y: frame.origin.y + v.y * q, z: frame.origin.z + v.z * q };
  const w = physics.omega;
  rotateFrameLocal(frame, { x: w.x * q, y: w.y * q, z: w.z * q });
}
