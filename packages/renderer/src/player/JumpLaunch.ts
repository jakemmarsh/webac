/**
 * The player's jump launch velocity (DECOMP.jump-velocity-vertical-only,
 * DECOMP.standing-long-jump).
 *
 * CMotionInterp::LeaveGround @ 00528b00 sets the body's local velocity to
 * get_leave_ground_velocity @ 005280c0: get_state_velocity @ 00527d50 of the
 * interpreted motion (the held forward / backward / sidestep, capped at the
 * run speed) with z = get_jump_v_z. ClientCombatSystem::DoJump @ 0056b110
 * then sends that local physics velocity in the JumpPack — the whole vector,
 * so peers see a running jump carry forward. A standing long jump launches
 * the same way: the keys held during its charge never moved the body, but
 * they are in the interpreted state, so the launch carries their full speed.
 */

/** What the launch reads from the input side (CameraController). */
export interface JumpLaunchInput {
  /** get_state_velocity, player-local m/s: side + right, forward + ahead. */
  stateVelocity(): { side: number; forward: number };
  /** Player-local horizontal velocity → scene axes at the current facing. */
  localToWorld(side: number, forward: number): { x: number; z: number };
}

export interface JumpLaunch {
  /** The JumpPack velocity: AC object-local (x right, y forward, z up). */
  local: { x: number; y: number; z: number };
  /** The same horizontal velocity in scene axes (x east, z = AC y). */
  world: { x: number; z: number };
}

/** get_leave_ground_velocity for `vz` (get_jump_v_z, m/s up). */
export function jumpLaunchVelocity(input: JumpLaunchInput, vz: number): JumpLaunch {
  const { side, forward } = input.stateVelocity();
  return {
    local: { x: side, y: forward, z: vz },
    world: input.localToWorld(side, forward),
  };
}
