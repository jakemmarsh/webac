/**
 * Retail headings (AC axes: x east, y north, z up). A heading is compass
 * degrees in [0, 360): 0 faces +y (north), 90 faces +x (east) — turning
 * right (TurnRight, omega z < 0) increases it.
 *
 *  - `Frame::get_heading @ 00535760` / ACE AFrame.get_heading:
 *    (450 − atan2(fy, fx)·180/π) mod 360 of the frame's local +y axis.
 *  - `Frame::set_heading @ 00535e40`: the upright orientation facing it
 *    (a rotation of −heading about +z).
 *  - `Position::heading @ 005a9520`: the heading from one position to
 *    another (0 when they coincide).
 */
import { rotateVector, type SeqQuat, type SeqV3 } from '../animation/SequenceFrame.js';

const F_EPSILON = 0.0002;
const RAD = 180 / Math.PI;

function norm360(h: number): number {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

/** The compass heading of a direction (dx east, dy north); 0 for a zero vector. */
export function headingOfVector(dx: number, dy: number): number {
  const l = Math.hypot(dx, dy);
  if (l < F_EPSILON) return 0;
  return norm360(450 - Math.atan2(dy / l, dx / l) * RAD);
}

export function headingOfQuat(q: SeqQuat): number {
  const f = rotateVector(q, { x: 0, y: 1, z: 0 });
  return norm360(450 - Math.atan2(f.y, f.x) * RAD);
}

export function quatForHeading(heading: number): SeqQuat {
  const t = (-heading * Math.PI) / 180;
  return { w: Math.cos(t / 2), x: 0, y: 0, z: Math.sin(t / 2) };
}

/** `Position::heading`: from `a` toward `b` (horizontal). */
export function headingFromTo(a: SeqV3, b: SeqV3): number {
  return headingOfVector(b.x - a.x, b.y - a.y);
}

/**
 * The local player's yaw (CameraController.playerYaw — facing our (x, z) =
 * (−sin yaw, −cos yaw), i.e. AC (x, y) = (−sin yaw, −cos yaw)) for a heading,
 * and back.
 */
export function yawForHeading(heading: number): number {
  const h = (heading * Math.PI) / 180;
  return Math.atan2(-Math.sin(h), -Math.cos(h));
}

export function headingForYaw(yaw: number): number {
  return headingOfVector(-Math.sin(yaw), -Math.cos(yaw));
}
