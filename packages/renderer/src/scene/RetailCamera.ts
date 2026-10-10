/**
 * CORE.18.b — the retail 3rd-person camera rig (acclient.exe CameraSet /
 * CameraManager) and the retail world projection.
 *
 * Constants are the .rdata floats the decompiled client reads (acclient.exe
 * 0x79bc04..0x79bc3c, names from the PDB string table in declaration order):
 *   CAMERA_MOUSELOOK_INC 0.2, CAMERA_MOUSELOOK_LIMIT 0.8, CAMERA_FAR_LIMIT 10,
 *   CAMERA_ROTATE_DEGREES 8, CAMERA_TURN_INCREMENT 8, CAMERA_MAP_DISTANCE 450,
 *   CAMERA_IN_HEAD_Y 0.18, CAMERA_IN_HEAD_Z 0, CAMERA_DEFAULT_Y -2.5,
 *   CAMERA_DEFAULT_Z 0.75, CAMERA_DEFAULT_PIVOT_Z 1.5, CAMERA_MIN_CHAR_DIST 0.5,
 *   CAMERA_MIN_CHAR_DIST2 0.45, CAMERA_MIN_CHAR_TRANS_DIST 0.2,
 *   CAMERA_MIN_CHAR_GROUNDDIST 1.2.
 *
 * The rig (CameraManager::UpdateCamera @ 00456660): the pivot is the player
 * origin + pivot_offset (0, 0, CAMERA_DEFAULT_PIVOT_Z); the viewer is the
 * pivot + viewer_offset expressed in the player's heading frame (y = ahead,
 * z = up). CameraSet::SetDefaultOffsets @ 00458f80 sets viewer_offset =
 * (0, CAMERA_DEFAULT_Y, CAMERA_DEFAULT_Z) x cm->scale, and in game
 * gmGamePlayUI::UseTime @ 004ea3a0 calls CameraSet::SetScale(1.1) every tick,
 * so the in-world default is (0, -2.75, 0.825).
 *
 * Where the camera looks is chosen by CameraSet::SetTargetForOffset @
 * 004576e0 from that offset: an offset with z in [-0.5, 0.75] looks level
 * along the player's heading (LOOK_IN_DIRECTION, direction (0,1,0)); any
 * other height looks AT THE PIVOT (LOOK_AT_PIVOT). The scaled default z
 * 0.825 is above 0.75, so the retail default view looks down at the pivot:
 * atan(0.825 / 2.75) = 16.7 degrees.
 */

export const CAMERA_MOUSELOOK_INC = 0.2;
export const CAMERA_FAR_LIMIT = 10;
export const CAMERA_DEFAULT_Y = -2.5;
export const CAMERA_DEFAULT_Z = 0.75;
export const CAMERA_DEFAULT_PIVOT_Z = 1.5;
export const CAMERA_MIN_CHAR_DIST = 0.5;
export const CAMERA_MIN_CHAR_DIST2 = 0.45;
export const CAMERA_MIN_CHAR_TRANS_DIST = 0.2;
/** CameraSet::SetInHead: viewer_offset (0, CAMERA_IN_HEAD_Y, CAMERA_IN_HEAD_Z) — ahead of the pivot, level. */
export const CAMERA_IN_HEAD_Y = 0.18;
export const CAMERA_IN_HEAD_Z = 0;
export const CAMERA_MIN_CHAR_GROUNDDIST = 1.2;
/** gmGamePlayUI::UseTime → CameraSet::SetScale(1.1) (0x3f8ccccd). */
export const GAMEPLAY_CAMERA_SCALE = 1.1;
/** CameraSet::Farther from the in-head view: viewer_offset (0, -0.6, 0.5), unscaled. */
export const OUT_OF_HEAD_OFFSET = { back: 0.6, up: 0.5 } as const;

/** SetTargetForOffset's level-look band: 0xbf000000 <= z <= 0x3f400000. */
const LEVEL_LOOK_MIN_Z = -0.5;
const LEVEL_LOOK_MAX_Z = 0.75;

/** The in-world default viewer offset: horizontal distance behind the pivot and height above it. */
export const DEFAULT_VIEWER_BACK = -CAMERA_DEFAULT_Y * GAMEPLAY_CAMERA_SCALE;
export const DEFAULT_VIEWER_UP = CAMERA_DEFAULT_Z * GAMEPLAY_CAMERA_SCALE;
/** Pivot-to-viewer distance of the default offset (≈ 2.871 m). */
export const DEFAULT_VIEWER_DISTANCE = Math.hypot(DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP);
/** Elevation of the default offset above the pivot's horizontal plane (≈ 16.7°). */
export const DEFAULT_VIEWER_ELEVATION = Math.atan2(DEFAULT_VIEWER_UP, DEFAULT_VIEWER_BACK);

/**
 * SetTargetForOffset: true when an offset of height `up` (metres above the
 * pivot) makes the camera look at the pivot rather than level ahead.
 */
export function looksAtPivot(up: number): boolean {
  return up > LEVEL_LOOK_MAX_Z || up < LEVEL_LOOK_MIN_Z;
}

/**
 * The view pitch (radians, negative = looking down) for a viewer at
 * `elevation` above the pivot: looking at the pivot means looking back down
 * the boom (-elevation); the level band looks straight ahead (0).
 */
export function viewPitchForOffset(distance: number, elevation: number): number {
  return looksAtPivot(distance * Math.sin(elevation)) ? -elevation : 0;
}

/**
 * The lowest orbit elevation CameraSet::Lower allows at `distance`: it
 * refuses a step that puts the viewer below the pivot plane (z < 0) while its
 * horizontal distance is inside CAMERA_MIN_CHAR_GROUNDDIST.
 */
export function minOrbitElevation(distance: number): number {
  if (distance <= CAMERA_MIN_CHAR_GROUNDDIST) return 0;
  return -Math.acos(CAMERA_MIN_CHAR_GROUNDDIST / distance);
}

/**
 * The world camera's vertical field of view (degrees) for the Config
 * "Field of View" preference. SmartBox::SetDefaultFov @ 00451e60 stores the
 * preference in radians as m_fGameFOV, and every frame SmartBox passes
 * Render::SetFOVRad(m_fGameFOV / (m_ViewportAspectRatio - 0.1)) (0x3dcccccd;
 * :86847), which PrimD3DRender::SetFOVInternal hands to
 * D3DXMatrixPerspectiveFovLH as the VERTICAL angle. At 16:9 the default 90
 * gives 53.6° vertical. SetFOVRad rejects angles outside (0, π) — returns
 * null so the caller keeps the previous projection, as retail does.
 */
export function retailVerticalFovDeg(gameFovDeg: number, aspect: number): number | null {
  const rad = (gameFovDeg * Math.PI / 180) / (aspect - 0.1);
  if (!(rad > 0 && rad < Math.PI)) return null;
  return rad * 180 / Math.PI;
}

/**
 * CORE.18.b.a — the player's translucency the camera imposes
 * (CameraSet::UpdateCamera @ 00458ae0 → CPhysicsObj::SetTranslucencyHierarchical;
 * 0 = opaque, 1 = invisible). In the head (viewer_offset is the SetInHead
 * offset) the player is fully translucent. Otherwise, when the viewer —
 * after the collision sweep, SmartBox's `viewer` — sits closer than
 * CAMERA_MIN_CHAR_DIST2 to the pivot, the player fades linearly to fully
 * translucent at CAMERA_MIN_CHAR_TRANS_DIST:
 *   t = 1 − (TRANS_DIST − d) / (TRANS_DIST − MIN_CHAR_DIST2), clamped to [0, 1];
 * any farther and the player is opaque again.
 */
export function cameraPlayerTranslucency(inHead: boolean, viewerToPivot: number): number {
  if (inHead) return 1;
  if (!(viewerToPivot < CAMERA_MIN_CHAR_DIST2)) return 0;
  const t = 1 - (CAMERA_MIN_CHAR_TRANS_DIST - viewerToPivot)
    / (CAMERA_MIN_CHAR_TRANS_DIST - CAMERA_MIN_CHAR_DIST2);
  return Math.max(0, Math.min(1, t));
}

// ── CORE.18.b.a.a — stiffness lag, the zoom step, slope alignment ─────────

/** acclient.exe .rdata 0x007c84ec F_EPSILON = 0.0002f. */
export const F_EPSILON = 0.0002;
/** CameraManager ctor: m_rCameraStiffness = t_stiffness = r_stiffness = 0.45 (Camera.Stiffness default). */
export const CAMERA_DEFAULT_STIFFNESS = 0.45;
/** CameraManager ctor: m_rCameraAdjustmentSpeed = 40 (Camera.AdjustmentSpeed default). */
export const CAMERA_DEFAULT_ADJUSTMENT_SPEED = 40;
/**
 * CameraSet::Closer / Farther / Raise / Lower: a new viewer_offset with
 * z <= −1.8 (0xbfe66666) forces CameraManager::SetStiffness(1.0); any higher
 * restores current_stiffness.
 */
export const CAMERA_STIFF_BELOW_Z = -1.8;
/** SceneTool::m_FramesPerSecond averages the last 20 frame times (m_LastFrameTimes[20]). */
export const FPS_WINDOW = 20;
/** CameraManager::old_velocities[5]. */
export const SLOPE_VELOCITY_WINDOW = 5;

/**
 * The per-update blend CameraManager::UpdateCamera @ 00456660 hands to
 * Frame::interpolate_origin (t_stiffness) / interpolate_rotation
 * (r_stiffness): a stiffness at or above 1 − F_EPSILON snaps; otherwise
 * stiffness × dt × 10 (0x4024000000000000), clamped to 1.
 */
export function stiffnessBlend(stiffness: number, dt: number): number {
  if (!(stiffness <= 1 - F_EPSILON)) return 1;
  return Math.min(1, stiffness * dt * 10);
}

/**
 * The factor one CameraSet::Closer / Farther tick scales viewer_offset by:
 * 1 ∓ elapsed × m_rCameraAdjustmentSpeed × CAMERA_MOUSELOOK_INC, where
 * `elapsed` is the time since the previous tick (m_ttLastZoom). The first
 * tick of a press has no previous one and takes 1 / SceneTool::
 * m_FramesPerSecond — which is all a wheel notch ever gets, since
 * CInputManager_WIN32::GenerateMouseWheelEvent fires the press and the
 * release back to back (StopCloser / StopFarther zero m_ttLastZoom). Returns
 * null when the tick is refused for being under F_EPSILON of the last one.
 */
export function zoomStepFactor(closer: boolean, elapsed: number, adjustmentSpeed: number): number | null {
  if (!(elapsed >= F_EPSILON)) return null;
  const k = elapsed * adjustmentSpeed * CAMERA_MOUSELOOK_INC;
  return closer ? 1 - k : 1 + k;
}

/** SceneTool::m_FramesPerSecond: 20 / (sum of the last 20 frame times); 0 until any time has passed. */
export class FrameRateMeter {
  private readonly times: number[] = [];
  push(dt: number): void {
    if (!(dt >= 0)) return;
    this.times.unshift(dt);
    if (this.times.length > FPS_WINDOW) this.times.length = FPS_WINDOW;
  }
  get fps(): number {
    let sum = 0;
    for (const t of this.times) sum += t;
    return sum > F_EPSILON ? FPS_WINDOW / sum : 0;
  }
}

/**
 * CameraSet::SetTargetForOffset's ALIGN_WITH_PLANE condition for a viewer
 * offset (x lateral, y ahead, z up in the player frame): −1 ≤ x < 1 and y < 0
 * (behind the pivot) — and always for the in-head offset.
 */
export function offsetAlignsWithPlane(lateral: number, ahead: number, inHead: boolean): boolean {
  return targetForOffset(lateral, ahead, 0, inHead).align;
}

/**
 * CameraSet::SetTargetForOffset @ 004576e0's target flags for a viewer offset
 * (x lateral, y ahead, z up, player frame):
 *   - the in-head offset → ALIGN_WITH_PLANE | LOOK_IN_DIRECTION;
 *   - −1 ≤ x < 1 and y < 0 (behind, near the centre line) → ALIGN_WITH_PLANE;
 *     plus LOOK_IN_DIRECTION when y < −0.5 and z ≥ −0.5; plus LOOK_AT_PIVOT
 *     unless −0.5 ≤ z ≤ 0.75 (the level-look band);
 *   - anything else (off to the side, or level with / ahead of the pivot)
 *     → LOOK_AT_PIVOT only.
 *   - looking down (CameraSet::LookDown) → LOOK_IN_DIRECTION only, checked
 *     before anything else;
 *   - targeting (CameraSet::TrackTarget) and not in the head →
 *     LOOK_AT_PIVOT | LOOK_AT_OBJECT, before the offset tests.
 */
export interface OffsetTarget {
  align: boolean;
  lookInDirection: boolean;
  lookAtPivot: boolean;
  /** LOOK_AT_OBJECT: UpdateCamera heads the offset frame toward the target object. */
  lookAtObject: boolean;
}

export interface OffsetModes {
  /** CameraSet::looking_down (Overhead View, action 0x3b). */
  lookingDown?: boolean;
  /** CameraSet::targeting (ClientCombatSystem::UpdateTargetTracking). */
  targeting?: boolean;
}

export function targetForOffset(x: number, y: number, z: number, inHead: boolean, modes: OffsetModes = {}): OffsetTarget {
  if (modes.lookingDown) return { align: false, lookInDirection: true, lookAtPivot: false, lookAtObject: false };
  if (inHead) return { align: true, lookInDirection: true, lookAtPivot: false, lookAtObject: false };
  if (modes.targeting) return { align: false, lookInDirection: false, lookAtPivot: true, lookAtObject: true };
  if (x < 1 && x >= -1 && y < 0) {
    return {
      align: true,
      lookInDirection: y < -0.5 && z >= LEVEL_LOOK_MIN_Z,
      lookAtPivot: z > LEVEL_LOOK_MAX_Z || z < LEVEL_LOOK_MIN_Z,
      lookAtObject: false,
    };
  }
  return { align: false, lookInDirection: false, lookAtPivot: true, lookAtObject: false };
}

/**
 * CameraSet::LookDown @ 00457ff0 (Overhead View, CameraManager::OnAction
 * 0x3b → ToggleLookDown): viewer_offset (0, −2, 0.75) — set as is, not
 * scaled (SetScale only rescales on a scale change) — and target direction
 * (0, 0.5, −1.8) in the player frame, looking steeply down past the player.
 * The saved offset / direction come back on the way out. Closer, Farther,
 * Rotate, SetInHead and SetDefaultOffsets end it first. CORE.18.b.a.a.a.a.a:
 * Raise / Lower do NOT ignore it — while looking down (Raise @ 00457980 /
 * Lower @ 00457cf0, the looking_down branch) they slide viewer_offset.y by
 * CAMERA_MOUSELOOK_INC per call (lookDownSlide), the direction unchanged.
 */
export const LOOK_DOWN_OFFSET = { back: 2, up: 0.75 } as const;
export const LOOK_DOWN_DIRECTION = { ahead: 0.5, up: -1.8 } as const;
/** The look-down view pitch (radians, − = down): atan2(−1.8, 0.5) ≈ −74.5°. */
export const LOOK_DOWN_PITCH = Math.atan2(LOOK_DOWN_DIRECTION.up, LOOK_DOWN_DIRECTION.ahead);

/**
 * CameraSet::TrackTarget @ 00458280 aims at the target object's origin
 * + target_offset (0, 0, 0.5) in the target's frame.
 */
export const TRACK_TARGET_OFFSET_Z = 0.5;

/**
 * CameraSet::Rotate @ 00458310 in the head: CommandInterpreter::TurnToHeading
 * (get_heading ± CAMERA_TURN_INCREMENT, wrapped to [0, 360)) — mouse-look
 * turns the player instead of orbiting. Degrees.
 */
export const CAMERA_TURN_INCREMENT = 8;

/** CAMERA_MOUSELOOK_LIMIT: the in-head direction.z bound Raise / Lower clamp to. */
export const CAMERA_MOUSELOOK_LIMIT = 0.8;
/** CAMERA_ROTATE_DEGREES — Rotate / Raise / Lower turn `angle` = π / (180 / 8) per unit step. */
/** CameraSet::MouseLookHandler's per-count scale (0x3d888889), times m_MouseLookSensitivity. */
export const MOUSE_LOOK_SCALE = 0.06666667;
export const CAMERA_ROTATE_DEGREES = 8;
export const CAMERA_ROTATE_RADIANS = Math.PI / (180 / CAMERA_ROTATE_DEGREES);
/**
 * CameraSet::SetMapMode @ 004581d0 (Map View, action 0x3c): the look-down
 * viewer_offset.y becomes −CAMERA_MAP_DISTANCE, the stiffness 1, and
 * SmartBox::DisableDegrades(1) / DisableFogging(1) until LookDown(0).
 */
export const CAMERA_MAP_DISTANCE = 450;
/**
 * Raise / Lower scale their step by 0.25 (.rdata 0x3fd0000000000000) while
 * CInputManager::m_UseMouseTurning (ICIDM + 0x89) is set.
 */
export const MOUSE_TURNING_RAISE_SCALE = 0.25;

/**
 * Raise / Lower in the looking_down branch (no time scaling, no target
 * change): Raise moves the viewer back (y −= CAMERA_MOUSELOOK_INC while
 * y ≥ −(CAMERA_FAR_LIMIT − CAMERA_MOUSELOOK_INC)); Lower moves it forward
 * (y += CAMERA_MOUSELOOK_INC while y ≤ 0.8 — .rdata 0x3fe999999999999a
 * compared as float). `back` is −viewer_offset.y; returns the new back.
 */
export function lookDownSlide(back: number, raise: boolean): number {
  const y = Math.fround(-back);
  if (raise) {
    return y >= -(CAMERA_FAR_LIMIT - CAMERA_MOUSELOOK_INC) ? -Math.fround(y - CAMERA_MOUSELOOK_INC) : back;
  }
  return y <= Math.fround(0.8) ? -Math.fround(y + CAMERA_MOUSELOOK_INC) : back;
}

/**
 * Raise / Lower in the head: direction.z ∓ CAMERA_MOUSELOOK_INC (Raise
 * looks down, Lower looks up), clamped to ±CAMERA_MOUSELOOK_LIMIT; the
 * direction's y stays 1 (SetInHead's (0, 1, 0)). Takes and returns the view
 * pitch (radians, + = up) = atan(direction.z).
 */
export function inHeadRaiseLower(pitch: number, raise: boolean): number {
  const z = Math.tan(pitch) + (raise ? -CAMERA_MOUSELOOK_INC : CAMERA_MOUSELOOK_INC);
  return Math.atan(Math.max(-CAMERA_MOUSELOOK_LIMIT, Math.min(CAMERA_MOUSELOOK_LIMIT, z)));
}

/**
 * CPhysicsObj::GetAutonomyBlipDistance @ 0050eb70 for the player:
 * PLAYER_OUTSIDE_BLIP_DISTANCE outdoors (cell id & 0xffff < 0x100),
 * PLAYER_INSIDE_BLIP_DISTANCE in an EnvCell. The .rdata values are not in the
 * decompile; ACE's port (PhysicsObj.GetAutonomyBlipDistance) carries 100 / 25.
 */
export const PLAYER_OUTSIDE_BLIP_DISTANCE = 100;
export const PLAYER_INSIDE_BLIP_DISTANCE = 25;

/**
 * SmartBox::PlayerPositionUpdated @ 00453870 with param_1 = 0 (a BlipPlayer,
 * not a teleport): set_viewer runs only when the blip moved the player
 * farther than the autonomy blip distance (`param_2 <= blip` skips it).
 * SmartBox::BlipPlayer @ 00453940 measures that distance with
 * Position::distance — 3D, from the old position to the blip's.
 */
export function blipResetsViewer(from: V3, to: V3, inside: boolean): boolean {
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  return distance > (inside ? PLAYER_INSIDE_BLIP_DISTANCE : PLAYER_OUTSIDE_BLIP_DISTANCE);
}

type V3 = { x: number; y: number; z: number };

/**
 * UpdateCamera's not-in-contact plane: the averaged velocity (already unit)
 * with its vertical scaled by 0x3dcccccd (0.1), renormalized, becomes the
 * heading of a fresh Frame (Frame::set_vector_heading — heading + pitch, no
 * roll), and that frame's up column is the plane normal. (Ghidra reads it as
 * local_88.frame.m_fl2gv[4..6], but local_88 is a Position cast to a Frame,
 * so those are the Frame's m_fl2gv[6..8] — the local Z / up column.) A
 * velocity that does not renormalize gives the world up (0, 0, 1).
 * Renderer axes: y is up.
 */
export function airbornePlaneNormal(averageVelocity: V3): V3 {
  const len = Math.hypot(averageVelocity.x, averageVelocity.y, averageVelocity.z);
  if (!(len > F_EPSILON)) return { x: 0, y: 1, z: 0 };
  const vx = averageVelocity.x / len;
  const vy = averageVelocity.y / len * AIRBORNE_VERTICAL_SCALE;
  const vz = averageVelocity.z / len;
  const vl = Math.hypot(vx, vy, vz);
  if (!(vl > F_EPSILON)) return { x: 0, y: 1, z: 0 };
  const fx = vx / vl, fy = vy / vl, fz = vz / vl;
  // The no-roll frame's up: world up with its forward component removed.
  const ux = -fy * fx, uy = 1 - fy * fy, uz = -fy * fz;
  const ul = Math.hypot(ux, uy, uz);
  if (!(ul > F_EPSILON)) return { x: 0, y: 1, z: 0 };
  return { x: ux / ul, y: uy / ul, z: uz / ul };
}

/** UpdateCamera: the airborne velocity's vertical is damped by 0x3dcccccd. */
const AIRBORNE_VERTICAL_SCALE = 0.1;

/**
 * CameraManager::UpdateCamera's ALIGN_WITH_PLANE branch (m_bAlignCameraToSlope,
 * Camera.AlignToSlope default on). Every update it pushes the pivot object's
 * velocity into old_velocities[5] and averages the samples it has
 * (old_velocity_num, up to 5). The heading is aligned only when that
 * average normalizes AND both of its horizontal components are at least
 * F_EPSILON of the unit vector — so standing still, or moving exactly along a
 * world axis, keeps the level heading. In contact (transient_state & 1) the
 * aligned heading is the player's forward with its contact-plane-normal
 * component removed: forward − (forward·N) N, i.e. the forward direction
 * along the slope.
 *
 * Coordinates are this renderer's world (x, z horizontal, y up); the gate
 * only reads |x| and |z|, so the axis mirroring to AC's (x, y) does not matter.
 */
export class SlopeAlignment {
  private readonly samples: V3[] = [];

  /** Forget the history (a new pivot / a teleport). */
  reset(): void { this.samples.length = 0; }

  /** Push this update's velocity; returns the averaged velocity. */
  push(velocity: V3): V3 {
    this.samples.push({ x: velocity.x, y: velocity.y, z: velocity.z });
    if (this.samples.length > SLOPE_VELOCITY_WINDOW) this.samples.shift();
    const n = this.samples.length;
    let x = 0, y = 0, z = 0;
    for (const s of this.samples) { x += s.x; y += s.y; z += s.z; }
    return { x: x / n, y: y / n, z: z / n };
  }

  /**
   * The aligned forward for `forward` (unit, horizontal) given the averaged
   * velocity and the contact-plane normal, or null when retail keeps the
   * plain heading (velocity too small or axis-aligned). A null
   * `contactNormal` means the body is not in contact (airborne): the plane is
   * airbornePlaneNormal(average velocity).
   */
  static alignedForward(forward: V3, averageVelocity: V3, contactNormal: V3 | null): V3 | null {
    const len = Math.hypot(averageVelocity.x, averageVelocity.y, averageVelocity.z);
    if (!(len > F_EPSILON)) return null;
    if (Math.abs(averageVelocity.x / len) < F_EPSILON || Math.abs(averageVelocity.z / len) < F_EPSILON) return null;
    const n = contactNormal ?? airbornePlaneNormal(averageVelocity);
    const d = forward.x * n.x + forward.y * n.y + forward.z * n.z;
    const ax = forward.x - d * n.x;
    const ay = forward.y - d * n.y;
    const az = forward.z - d * n.z;
    const al = Math.hypot(ax, ay, az);
    if (!(al > F_EPSILON)) return null;
    return { x: ax / al, y: ay / al, z: az / al };
  }
}
