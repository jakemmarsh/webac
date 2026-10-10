/**
 * CORE.18.a — the one conversion between the camera's `playerYaw` and AC's
 * heading.
 *
 * The world is built with AC (x east, y north, z up) → three (x, z, y), and
 * CameraController moves along forward = (−sin yaw, −cos yaw) in (east,
 * north): yaw 0 faces SOUTH, yaw π faces north, and lowering yaw turns left
 * (CORE.18). ACE's Position.GetCurrentDir (ACE.Entity/Position.cs:80) is
 * Transform(UnitY, Rotation): a Z-rotation of θ faces (−sin θ, cos θ), i.e.
 * θ = 0 is north and θ grows counter-clockwise (north → west). Matching the
 * two forward vectors gives θ = π − yaw (and yaw = π − θ — the map is its own
 * inverse). The radar's compass heading (0 = north, 90 = east, clockwise —
 * RadarCompassTokens / RadarBlips) is −θ = yaw − π, taken mod 360.
 *
 * Before this module every site read θ = yaw: MovementSync told ACE a heading
 * reflected about the east-west axis, arrivals turned the camera to the
 * reflected heading (interiors) or not at all (outdoors), and the radar put S
 * at the top while facing north.
 */

const TWO_PI = Math.PI * 2;

/** Wrap an angle into (−π, π]. */
function wrapPi(a: number): number {
  let r = a % TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  else if (r > Math.PI) r -= TWO_PI;
  return r;
}

/** AC heading θ (radians, 0 = north, counter-clockwise) for a camera yaw. */
export function yawToAcHeading(yaw: number): number {
  return wrapPi(Math.PI - yaw);
}

/** Camera yaw that faces AC heading θ. */
export function acHeadingToYaw(theta: number): number {
  return wrapPi(Math.PI - theta);
}

/**
 * AC heading of a server orientation quaternion (w, x, y, z) — the Z-axis
 * yaw angle, the same extraction ACE's Position heading uses for an upright
 * frame.
 */
export function acHeadingFromQuaternion(w: number, x: number, y: number, z: number): number {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/** Camera yaw that faces a server orientation quaternion (w, x, y, z). */
export function yawFromAcQuaternion(w: number, x: number, y: number, z: number): number {
  return acHeadingToYaw(acHeadingFromQuaternion(w, x, y, z));
}

/** The upright AC orientation quaternion for a camera yaw (rotation about +Z by θ). */
export function acQuaternionFromYaw(yaw: number): { qw: number; qx: number; qy: number; qz: number } {
  const half = yawToAcHeading(yaw) / 2;
  return { qw: Math.cos(half), qx: 0, qy: 0, qz: Math.sin(half) };
}

/** Compass heading in degrees [0, 360), 0 = north, 90 = east — the radar's input. */
export function yawToCompassDegrees(yaw: number): number {
  let d = ((yaw - Math.PI) * 180 / Math.PI) % 360;
  if (d < 0) d += 360;
  // -0 and float noise just under 360 read as north.
  if (d >= 360 - 1e-9) d = 0;
  return d + 0;
}
