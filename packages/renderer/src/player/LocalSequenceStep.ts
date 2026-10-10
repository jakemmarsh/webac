/**
 * The local player's body moves by its animation sequence, as retail's does
 * (BUG.local-movement-ignores-links, docs/movement-ab.md).
 *
 * `CPhysicsObj::UpdatePositionInternal @ 00512c30` builds an identity offset
 * frame, has `CPartArray::Update` advance the sequence by the quantum into it
 * (`CSequence::update_internal @ 005255d0`: every whole frame stepped over
 * combines that frame's root pos-frame, then `apply_physics @ 00524ab0` adds
 * the sequence velocity for 1 / framerate), scales the origin by `m_scale`
 * (zeroes it when the object is not on a walkable surface), and combines the
 * result onto `m_position`. So the player moves through whatever node is
 * playing: the Ready → Run start link's first slow steps, the Run → Ready
 * stop link's coast after the key is released, and a press made while the
 * stop link still plays waits for it (GetObjectSequence keeps the links and
 * only drops the cyclic tail). The retail A/B capture
 * (tools/retail-movement-ab.ts) shows exactly that: four 0.5 s run taps cover
 * 7.45 m in retail, 13.2 m when the body moved at the run cycle's averaged
 * velocity from the first frame.
 *
 * Heading stays with CameraController (the turn rate there matches the
 * capture); the sequence's omega is left out so the offset is pure
 * translation in the player's frame.
 */
import type { SequenceMotion } from '../animation/SequenceFrame.js';
import { identityFrame } from '../animation/SequenceFrame.js';
import type { MotionManager } from '../animation/MotionManager.js';
import { sequencePhysicsFor, type InterpretedMotion } from '../world/RemoteMotion.js';

/** What localSequenceStep advances: an AnimatedEntity (or anything that steps a MotionManager with a root-motion sink). */
export interface SequencedBody {
  readonly motionManager: MotionManager;
  update(deltaTime: number, motion?: SequenceMotion): void;
}

/**
 * Advance `body`'s sequence by `dt` and return the root offset it produced,
 * player-local metres (x + right, y + ahead) × `scale`. `st` is the
 * interpreted state, which sets the sequence velocity (a modifier's — the
 * sidestep while running — on top of the cycle's). Null when the body has no
 * motion table yet (the caller falls back to the averaged velocity).
 */
export function localSequenceStep(body: SequencedBody, dt: number, st: InterpretedMotion, scale = 1): { x: number; y: number } | null {
  const mm = body.motionManager;
  const table = mm.activeMotionTable;
  if (!table) return null;
  // The turn stays in the state: it decides whether a sidestep is the
  // substate or a modifier (InterpretedMotion.turnFirst). Its omega is not
  // applied here — CameraController owns the heading.
  // The local player's motion-table state knows which of a turn and a
  // sidestep is the substate and which a modifier (MotionTableState); the
  // stateless resolution stands in without one.
  const physics = mm.motionTableState ? mm.motionTableState.physics() : sequencePhysicsFor(table, mm.currentStyleId || table.defaultStyle, st);
  const motion: SequenceMotion = { frame: identityFrame(), velocity: physics.velocity, omega: { x: 0, y: 0, z: 0 } };
  body.update(dt, motion);
  return { x: motion.frame.origin.x * scale, y: motion.frame.origin.y * scale };
}
