/**
 * CORE.18.b.a.a — the retail viewer frame (CameraManager::UpdateCamera @
 * 00456660, called from SmartBox::PlayerPhysicsUpdatedCallback @ 00452d60).
 *
 * Each update retail builds a TARGET frame for the viewer:
 *   - the offset frame's heading is the player's forward. Under
 *     ALIGN_WITH_PLANE (SlopeAlignment) it is tilted along the contact
 *     plane while moving. The frame is heading + pitch, no roll
 *     (Frame::set_vector_heading).
 *   - the viewer is the pivot + viewer_offset expressed in that frame;
 *   - it looks along the frame's forward (LOOK_IN_DIRECTION), or at the pivot
 *     (LOOK_AT_PIVOT) when SetTargetForOffset chose that.
 * It then moves the PREVIOUS viewer (SmartBox::viewer, i.e. last update's
 * collision-clipped viewer) toward that target: Frame::interpolate_origin by
 * stiffnessBlend(t_stiffness, dt), Frame::interpolate_rotation by
 * stiffnessBlend(r_stiffness, dt). The result is viewer_sought_position,
 * which SmartBox::update_viewer then sweeps from the pivot for collisions —
 * the caller does that and hands the clipped position back via commit().
 *
 * A teleport (SmartBox::PlayerPositionUpdated → set_viewer(player position,
 * 1)) puts the viewer on the player's own frame, so the camera eases back out
 * from the player's origin: snapTo().
 */
import * as THREE from 'three';
import {
  LOOK_DOWN_PITCH, SlopeAlignment, stiffnessBlend, targetForOffset, type OffsetTarget,
} from './RetailCamera.js';

export interface RigInput {
  /** Pivot (player origin + CAMERA_DEFAULT_PIVOT_Z), renderer world space. */
  pivot: THREE.Vector3;
  /**
   * The offset frame's heading — the PLAYER's forward (renderer yaw; forward
   * = (−sin, 0, −cos)). UpdateCamera builds the frame from the pivot
   * object's heading, never the camera's.
   */
  facing: number;
  /**
   * Mouse-look orbit (radians, same sense as `facing`): CameraSet::Rotate
   * turns viewer_offset's (x, y) about the pivot inside the player's frame,
   * so the viewer sits where a level frame at facing + orbit would put it.
   * 0 = straight behind. Ignored in the head.
   */
  orbit?: number;
  /** viewer_offset in polar form: metres behind the pivot / above it (3rd person), before the orbit. */
  back: number;
  up: number;
  /** In the head (CameraSet::SetInHead): viewer CAMERA_IN_HEAD_Y ahead of the pivot. */
  inHead: boolean;
  inHeadAhead: number;
  /** Extra pitch (radians, + = up) applied to a LOOK_IN_DIRECTION view (mouse-look in the head). */
  lookPitch: number;
  /**
   * m_bAlignCameraToSlope (Config "Align camera to slope"). The rig ANDs it
   * with SetTargetForOffset's ALIGN_WITH_PLANE for the (orbited) offset.
   */
  align: boolean;
  /** Player velocity this update (world units / s) — old_velocities input. */
  velocity: { x: number; y: number; z: number };
  /**
   * Contact-plane normal while the player is in contact (transient_state &
   * 1); null when airborne — the plane then comes from the velocity
   * (airbornePlaneNormal).
   */
  contactNormal: { x: number; y: number; z: number } | null;
  tStiffness: number;
  rStiffness: number;
  dt: number;
  /**
   * CORE.18.b.a.a.a.a — Overhead View (CameraSet::LookDown): the caller
   * hands the look-down offset as back / up (LOOK_DOWN_OFFSET, orbit 0,
   * not in the head); the frame pitches to LOOK_DOWN_PITCH and the view
   * looks along it (LOOK_IN_DIRECTION only).
   */
  lookingDown?: boolean;
  /**
   * CORE.18.b.a.a.a.a — the tracked target (CameraSet::TrackTarget): the
   * target object's origin + TRACK_TARGET_OFFSET_Z, renderer world space,
   * or null when not targeting. UpdateCamera heads the offset frame from
   * the pivot toward it (LOOK_AT_OBJECT) and looks at the pivot.
   */
  trackTarget?: THREE.Vector3 | null;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class RetailCameraRig {
  private readonly viewer = new THREE.Vector3();
  private readonly viewerQuat = new THREE.Quaternion();
  private hasViewer = false;
  private readonly slope = new SlopeAlignment();

  /** This update's target viewer (before the stiffness lerp). */
  readonly targetPosition = new THREE.Vector3();
  readonly targetQuaternion = new THREE.Quaternion();
  /** viewer_sought_position: where the viewer heads this update, before the collision sweep. */
  readonly soughtPosition = new THREE.Vector3();
  readonly soughtQuaternion = new THREE.Quaternion();
  /** The offset frame's forward this update (aligned or level). */
  readonly frameForward = new THREE.Vector3();

  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  /** Forget the viewer: the next update snaps to its target (first frame). */
  reset(): void {
    this.hasViewer = false;
    this.slope.reset();
  }

  /** SmartBox::set_viewer(player position): the viewer sits on the player's frame. */
  snapTo(position: THREE.Vector3, facing: number): void {
    this.viewer.copy(position);
    this.scratchEuler.set(0, facing, 0, 'YXZ');
    this.viewerQuat.setFromEuler(this.scratchEuler);
    this.hasViewer = true;
    this.slope.reset();
  }

  /** SetTargetForOffset's flags for this update's (orbited) offset. */
  readonly target: OffsetTarget = { align: false, lookInDirection: false, lookAtPivot: true, lookAtObject: false };

  /** Build the target frame and the stiffness-blended sought frame. */
  update(input: RigInput): void {
    const lookingDown = input.lookingDown === true;
    const inHead = input.inHead && !lookingDown;
    const orbit = inHead || lookingDown ? 0 : (input.orbit ?? 0);
    // viewer_offset in the player frame: CameraSet::Rotate turns (0, −back)
    // by the orbit — lateral |x| = back·|sin|, ahead y = −back·cos.
    const lateral = input.back * Math.sin(orbit);
    const ahead = -input.back * Math.cos(orbit);
    const targeting = input.trackTarget != null;
    const t = targetForOffset(lateral, inHead ? input.inHeadAhead : ahead, inHead ? 0 : input.up, inHead,
      { lookingDown, targeting });
    this.target.align = t.align;
    this.target.lookInDirection = t.lookInDirection;
    this.target.lookAtPivot = t.lookAtPivot;
    this.target.lookAtObject = t.lookAtObject;

    const level = this.frameForward.set(-Math.sin(input.facing), 0, -Math.cos(input.facing));
    if (t.lookAtObject && input.trackTarget) {
      // UpdateCamera: the pivot → target unit vector is the frame's heading
      // (with its pitch; Frame::set_vector_heading). A target on the pivot
      // (normalize_check_small) falls back to the player's direction.
      const d = this.scratchDir.copy(input.trackTarget).sub(input.pivot);
      if (d.lengthSq() > 1e-8) this.frameForward.copy(d.normalize());
    } else if (lookingDown) {
      // direction (0, 0.5, −1.8) in the player frame.
      const c = Math.cos(LOOK_DOWN_PITCH);
      this.frameForward.set(level.x * c, Math.sin(LOOK_DOWN_PITCH), level.z * c);
    } else if (input.align && t.align) {
      // The velocity history only advances inside the ALIGN_WITH_PLANE branch.
      const avg = this.slope.push(input.velocity);
      const aligned = SlopeAlignment.alignedForward(level, avg, input.contactNormal);
      if (aligned) this.frameForward.set(aligned.x, aligned.y, aligned.z);
    }
    const f = this.frameForward;
    // Frame::set_vector_heading: no roll — the frame's up is world-up with
    // its forward component removed; its lateral axis stays horizontal
    // (d forward / d yaw of the frame's heading).
    const u = this.scratchUp.copy(WORLD_UP).addScaledVector(f, -f.y).normalize();
    const heading = Math.hypot(f.x, f.z) > 1e-9 ? Math.atan2(-f.x, -f.z) : input.facing;
    const r = this.scratchRight.set(-Math.cos(heading), 0, Math.sin(heading));

    const dir = this.scratchDir;
    if (inHead) {
      this.targetPosition.copy(input.pivot).addScaledVector(f, input.inHeadAhead);
      dir.copy(f);
    } else {
      this.targetPosition.copy(input.pivot)
        .addScaledVector(f, ahead)
        .addScaledVector(r, -lateral)
        .addScaledVector(u, input.up);
      if (t.lookAtPivot) dir.copy(input.pivot).sub(this.targetPosition);
      else dir.copy(f);
    }
    if (dir.lengthSq() < 1e-12) dir.copy(f);
    const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z))
      + (inHead ? input.lookPitch : t.lookAtPivot || lookingDown ? 0 : input.lookPitch);
    const maxPitch = Math.PI / 2 - 0.01;
    const yaw = Math.hypot(dir.x, dir.z) > 1e-9 ? Math.atan2(-dir.x, -dir.z) : input.facing;
    this.scratchEuler.set(Math.max(-maxPitch, Math.min(maxPitch, pitch)), yaw, 0, 'YXZ');
    this.targetQuaternion.setFromEuler(this.scratchEuler);

    if (!this.hasViewer) {
      this.soughtPosition.copy(this.targetPosition);
      this.soughtQuaternion.copy(this.targetQuaternion);
      return;
    }
    this.soughtPosition.copy(this.viewer).lerp(this.targetPosition, stiffnessBlend(input.tStiffness, input.dt));
    this.soughtQuaternion.copy(this.viewerQuat).slerp(this.targetQuaternion, stiffnessBlend(input.rStiffness, input.dt));
  }

  /**
   * The vector from `pivot` to this update's sought viewer — the direction
   * and length SmartBox::update_viewer's collision sweep runs along (it
   * starts at the pivot and moves toward the viewer).
   */
  sweepFrom(pivot: THREE.Vector3, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.soughtPosition).sub(pivot);
  }

  /** SmartBox::update_viewer's result: the collision-clipped viewer becomes next update's start. */
  commit(position: THREE.Vector3, quaternion: THREE.Quaternion = this.soughtQuaternion): void {
    this.viewer.copy(position);
    this.viewerQuat.copy(quaternion);
    this.hasViewer = true;
  }
}
