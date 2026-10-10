/**
 * PositionCorrection — decision logic for server-authoritative position
 * corrections of the local player. (ASSESS: extracted from main.ts so the
 * math is importable + unit-testable; main.ts owns the actual state
 * mutation and calls this for the decision.)
 *
 * When the server sends these:
 *   • ACE echoes the physics-verified result of every movement update back
 *     to the owning client as GameMessageUpdatePosition —
 *     reference/ACE/Source/ACE.Server/WorldObjects/Player_Tick.cs:513-516
 *     (UpdatePlayerPosition → SendUpdatePosition broadcast at most every
 *     MoveToState_UpdatePosition_Threshold = 1s, Player_Tick.cs:403, else a
 *     direct Session.Network.EnqueueSend(new GameMessageUpdatePosition(this))).
 *   • On movement violations the server FORCES the position: z-hack
 *     detection resets Location to LastGroundPos, bumps the
 *     ObjectForcePosition sequence and re-sends UpdatePosition
 *     (Player_Tick.cs:487-489). A bumped force sequence must always snap.
 *
 * Decision policy:
 *   • interior↔exterior (or a different dungeon block) AND far away (or
 *     forced) → 'teleport': the caller must run the full geometry
 *     transition path. Small-delta context flips (on-foot surface-building
 *     doorways) stay positional — no portal-space flash.
 *   • forced → 'snap'.
 *   • horizontal delta ≥ snapAbove → 'snap' (too far to hide a lerp).
 *   • interior vertical delta ≥ interiorFloorDelta → 'snap' (server says
 *     we're on a different floor — XZ-only blending would tunnel).
 *   • horizontal delta ≤ ignore threshold → 'ignore'. While the player is
 *     actively moving the threshold is raised: the self-echo is throttled
 *     to ~1s (Player_Tick.cs:403) plus RTT, so at run speed (~4-6 m/s per
 *     ACE MovementSystem run rates) a several-meter delta is pure latency
 *     lag along our own path, not drift — blending toward it would
 *     rubber-band every second.
 *   • otherwise → 'blend': ease toward the target over a few frames.
 *
 * Coordinate convention (same as main.ts/teleport path):
 *   AC (x, y, z) with cell id 0xXXYYcccc → Three.js
 *   worldX = XX*192 + x, worldZ = YY*192 + y, height (Three Y) = z.
 */

import { landblockX, landblockY, cellIndexOf, isInteriorCellIndex } from '@ac/shared';

/** Server-reported position: full 32-bit cell id + cell-local AC coords. */
export interface ServerPosition {
  cellId: number;
  x: number;
  y: number;
  z: number;
}

/** Client-side position state at the moment the correction arrives. */
export interface ClientPositionState {
  worldX: number;
  worldZ: number;
  /** Current standing height in Three.js Y (ground + jump offset). */
  height: number;
  inDungeon: boolean;
  /** Actual interior cell id (0xXXYYcccc) when inDungeon, else 0. */
  dungeonCellId: number;
}

export interface CorrectionFlags {
  /** Player has movement input / is airborne / is auto-approaching. */
  moving: boolean;
  /** ObjectForcePosition sequence bumped (Player_Tick.cs:488) — or any
   *  other "the server is explicitly setting your position" signal. */
  forced: boolean;
}

export interface CorrectionThresholds {
  /** Ignore horizontal deltas at or below this while stationary (m). */
  ignoreBelow: number;
  /** Ignore horizontal deltas at or below this while moving (m) — covers
   *  the ~1s echo throttle (Player_Tick.cs:403) at run speed. */
  movingIgnoreBelow: number;
  /** Snap at or above this horizontal delta (m). */
  snapAbove: number;
  /** Interior vertical delta at or above this snaps (different floor). */
  interiorFloorDelta: number;
}

export const DEFAULT_CORRECTION_THRESHOLDS: CorrectionThresholds = {
  ignoreBelow: 1.0,
  movingIgnoreBelow: 6.0,
  snapAbove: 20.0,
  interiorFloorDelta: 4.0,
};

export type CorrectionAction = 'ignore' | 'blend' | 'snap' | 'teleport';

export interface CorrectionDecision {
  action: CorrectionAction;
  /** Server position converted to Three.js world coords. */
  worldX: number;
  /** Server height (AC z) in Three.js Y. */
  worldY: number;
  worldZ: number;
  /** Server cell is an interior EnvCell (0x0100-0xFFFD index). */
  isInterior: boolean;
  /** interior↔exterior flip, or a different dungeon landblock. */
  contextChanged: boolean;
  horizontalDistance: number;
  verticalDistance: number;
}

/** Convert a server cell id + cell-local AC coords to Three.js world XZ. */
export function serverPositionToWorld(cellId: number, x: number, y: number): { worldX: number; worldZ: number } {
  return {
    worldX: landblockX(cellId) * 192 + x,
    worldZ: landblockY(cellId) * 192 + y,
  };
}

/**
 * Decide how to apply a server-authoritative position for the local player.
 * Pure function — no Three.js, no closures; see module doc for the policy.
 */
export function decidePositionCorrection(
  current: ClientPositionState,
  server: ServerPosition,
  flags: CorrectionFlags,
  thresholds: CorrectionThresholds = DEFAULT_CORRECTION_THRESHOLDS,
): CorrectionDecision {
  const { worldX, worldZ } = serverPositionToWorld(server.cellId, server.x, server.y);
  const worldY = server.z;
  const isInterior = isInteriorCellIndex(cellIndexOf(server.cellId));

  // Different "space": interior↔exterior, or a different dungeon landblock
  // (high 16 bits of the cell id select the 0xXXYY block).
  const contextChanged = isInterior !== current.inDungeon
    || (isInterior && current.inDungeon
        && (server.cellId >>> 16) !== (current.dungeonCellId >>> 16));

  const dx = worldX - current.worldX;
  const dz = worldZ - current.worldZ;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
  const verticalDistance = Math.abs(worldY - current.height);

  let action: CorrectionAction;
  const ignoreBelow = flags.moving ? thresholds.movingIgnoreBelow : thresholds.ignoreBelow;
  if (contextChanged && (flags.forced || Math.max(horizontalDistance, verticalDistance) >= thresholds.snapAbove)) {
    // Genuinely elsewhere (or an explicit server set) in a different space —
    // the caller must run the full geometry transition.
    action = 'teleport';
  } else if (contextChanged) {
    // Small-delta context flip: walking into/out of a surface building on
    // foot makes the server's echoed cell flip interior↔exterior while the
    // position stays continuous. The client deliberately keeps surface
    // buildings in outdoor mode (buildingShells) — running the teleport
    // path here would flash portal space on every shop doorway. Apply
    // positionally only; never let the mismatched cell change the mode.
    action = horizontalDistance <= ignoreBelow ? 'ignore' : 'blend';
  } else if (flags.forced) {
    action = 'snap';
  } else if (horizontalDistance >= thresholds.snapAbove) {
    action = 'snap';
  } else if (isInterior && verticalDistance >= thresholds.interiorFloorDelta) {
    action = 'snap';
  } else {
    action = horizontalDistance <= ignoreBelow ? 'ignore' : 'blend';
  }

  return { action, worldX, worldY, worldZ, isInterior, contextChanged, horizontalDistance, verticalDistance };
}

/*
 * CORE.2 — retail self-position gate (policy note; the gate lives at
 * main.ts onUpdatePosition, the ushort compare is ServerObjectManager's
 * isSequenceNewer): per the decompiled retail client's
 * SmartBox::HandleReceivedPosition @ 00453fd0 (acclient-decompiled.c:
 * 87070-87089), the SELF player applies a received position ONLY when the
 * ObjectForcePosition timestamp is NEWER than the tracked one
 * (CPhysicsObj::newer_event) — then "BlipPlayer" snaps, keeping the
 * client's own heading. Routine non-forced UpdatePosition echoes are NEVER
 * applied to the self player — the client is authoritative for its own
 * motion, so this module's blend/ignore machinery only ever sees FORCED
 * self corrections (plus the teleport path).
 *
 * Why (Jake's live report, "run/walk feels inverted"): ACE's self-echo
 * (Player_Tick.cs:513-516) reflects our position from ~1-2s ago (1s
 * broadcast throttle + tick + RTT). At run speed (4.0×runRate ≈ 6.2 m/s)
 * that stale echo trails by MORE than the 6m moving-ignore threshold, so
 * blending toward it rubber-banded the running player back along their own
 * path — running netted zero while walking (3.12 m/s ≈ 5.6m echo lag)
 * stayed under the threshold and worked. Live evidence:
 * verification/core2-run-default/.
 */

/** Distance below which a blend completes by snapping exactly to target. */
export const BLEND_SNAP_WITHIN = 0.05;

/** Default blend time constant (s) — ~95% converged after 3·tau ≈ 0.45s. */
export const BLEND_TIME_CONSTANT = 0.15;

/**
 * One frame of exponential easing toward a correction target. Frame-rate
 * independent (factor = 1 - e^(-dt/tau)); never overshoots; reports done
 * (and returns the exact target) once within BLEND_SNAP_WITHIN.
 */
export function blendStep(
  x: number, z: number,
  targetX: number, targetZ: number,
  dt: number,
  timeConstant: number = BLEND_TIME_CONSTANT,
): { x: number; z: number; done: boolean } {
  const dx = targetX - x;
  const dz = targetZ - z;
  if (Math.sqrt(dx * dx + dz * dz) <= BLEND_SNAP_WITHIN) {
    return { x: targetX, z: targetZ, done: true };
  }
  const f = 1 - Math.exp(-dt / timeConstant);
  const nx = x + dx * f;
  const nz = z + dz * f;
  const ndx = targetX - nx;
  const ndz = targetZ - nz;
  const done = Math.sqrt(ndx * ndx + ndz * ndz) <= BLEND_SNAP_WITHIN;
  return done ? { x: targetX, z: targetZ, done: true } : { x: nx, z: nz, done: false };
}
