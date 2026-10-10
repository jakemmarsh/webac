/**
 * verify-position-correction.ts — server-authoritative position correction
 * decision logic (ASSESS: Tier-A playability — pre-fix the client only
 * console.logged its own UpdatePosition echoes and dead-reckoned forever).
 *
 * ACE anchoring:
 *   • reference/ACE/Source/ACE.Server/WorldObjects/Player_Tick.cs:513-516 —
 *     the server echoes every physics-verified movement of OUR player back
 *     as GameMessageUpdatePosition (direct EnqueueSend below the 1s
 *     broadcast throttle of Player_Tick.cs:403).
 *   • Player_Tick.cs:487-489 — movement violations force the position
 *     (Location=LastGroundPos + ObjectForcePosition sequence bump +
 *     SendUpdatePosition): the client must snap, not blend.
 *   • Coordinate transform: worldX = blockX*192 + x (CLAUDE.md terrain
 *     section; landblockX/Y from @ac/shared).
 */

import { describe, it, expect } from 'vitest';
import {
  decidePositionCorrection,
  serverPositionToWorld,
  blendStep,
  DEFAULT_CORRECTION_THRESHOLDS,
  BLEND_SNAP_WITHIN,
  type ClientPositionState,
} from '@ac/renderer/world/PositionCorrection.js';
// CORE.2 — the self-position gate compare (retail CPhysicsObj::newer_event);
// shared with SetState/ObjDesc sequence gating.
import { isSequenceNewer } from '@ac/renderer/world/ServerObjectManager.js';

/** Outdoor state helper at world (X, Z). */
function outdoors(worldX: number, worldZ: number, height = 50): ClientPositionState {
  return { worldX, worldZ, height, inDungeon: false, dungeonCellId: 0 };
}

/** Dungeon state helper. */
function inDungeon(worldX: number, worldZ: number, height: number, cellId: number): ClientPositionState {
  return { worldX, worldZ, height, inDungeon: true, dungeonCellId: cellId };
}

const STILL = { moving: false, forced: false };
const MOVING = { moving: true, forced: false };
const FORCED = { moving: false, forced: true };

describe('serverPositionToWorld — landblock→world transform', () => {
  it('outdoor cell: worldX = blockX*192 + x, worldZ = blockY*192 + y', () => {
    // Landblock 0xA9B4 (blockX=0xA9=169, blockY=0xB4=180), sub-cell 0x0029.
    const { worldX, worldZ } = serverPositionToWorld(0xA9B40029, 12.5, 100.25);
    expect(worldX).toBeCloseTo(169 * 192 + 12.5, 6);
    expect(worldZ).toBeCloseTo(180 * 192 + 100.25, 6);
  });

  it('interior cell uses the same block transform (high 16 bits)', () => {
    // Interior cell 0x01030100 (blockX=0x01, blockY=0x03, cell 0x0100).
    const { worldX, worldZ } = serverPositionToWorld(0x01030100, 30, 40);
    expect(worldX).toBeCloseTo(1 * 192 + 30, 6);
    expect(worldZ).toBeCloseTo(3 * 192 + 40, 6);
  });

  it('block coordinates 0xFF do not go negative (unsigned extraction)', () => {
    const { worldX, worldZ } = serverPositionToWorld(0xFFFF0029 >>> 0, 0, 0);
    expect(worldX).toBe(255 * 192);
    expect(worldZ).toBe(255 * 192);
  });
});

describe('decidePositionCorrection — outdoor thresholds', () => {
  // Server position at world (1000, 2000): block (5,10), local (40, 80).
  const CELL = (5 << 24) | (10 << 16) | 0x0001;
  const SERVER = { cellId: CELL, x: 40, y: 80, z: 50 };
  const TARGET_X = 5 * 192 + 40;   // 1000
  const TARGET_Z = 10 * 192 + 80;  // 2000

  it('sanity: target transform', () => {
    expect(TARGET_X).toBe(1000);
    expect(TARGET_Z).toBe(2000);
  });

  it('ignores deltas at/below ignoreBelow while stationary', () => {
    const d = decidePositionCorrection(outdoors(TARGET_X + 0.9, TARGET_Z), SERVER, STILL);
    expect(d.action).toBe('ignore');
    expect(d.isInterior).toBe(false);
    expect(d.contextChanged).toBe(false);
  });

  it('threshold edge: exactly ignoreBelow is still ignored (<=)', () => {
    const d = decidePositionCorrection(
      outdoors(TARGET_X + DEFAULT_CORRECTION_THRESHOLDS.ignoreBelow, TARGET_Z), SERVER, STILL);
    expect(d.action).toBe('ignore');
  });

  it('blends just above ignoreBelow while stationary', () => {
    const d = decidePositionCorrection(
      outdoors(TARGET_X + DEFAULT_CORRECTION_THRESHOLDS.ignoreBelow + 0.01, TARGET_Z), SERVER, STILL);
    expect(d.action).toBe('blend');
    expect(d.worldX).toBeCloseTo(TARGET_X, 6);
    expect(d.worldZ).toBeCloseTo(TARGET_Z, 6);
  });

  it('raises the ignore threshold while moving (echo lag ≠ drift)', () => {
    // 5m behind while running: within the ~1s echo throttle window
    // (Player_Tick.cs:403) at run speed — must NOT rubber-band.
    const still = decidePositionCorrection(outdoors(TARGET_X + 5, TARGET_Z), SERVER, STILL);
    const moving = decidePositionCorrection(outdoors(TARGET_X + 5, TARGET_Z), SERVER, MOVING);
    expect(still.action).toBe('blend');
    expect(moving.action).toBe('ignore');
  });

  it('blends above movingIgnoreBelow even while moving', () => {
    const d = decidePositionCorrection(
      outdoors(TARGET_X + DEFAULT_CORRECTION_THRESHOLDS.movingIgnoreBelow + 0.5, TARGET_Z), SERVER, MOVING);
    expect(d.action).toBe('blend');
  });

  it('snaps at/above snapAbove', () => {
    const d = decidePositionCorrection(
      outdoors(TARGET_X + DEFAULT_CORRECTION_THRESHOLDS.snapAbove, TARGET_Z), SERVER, STILL);
    expect(d.action).toBe('snap');
    expect(d.horizontalDistance).toBeCloseTo(DEFAULT_CORRECTION_THRESHOLDS.snapAbove, 6);
  });

  it('forced (ObjectForcePosition bump, Player_Tick.cs:487-489) snaps even tiny deltas', () => {
    const d = decidePositionCorrection(outdoors(TARGET_X + 0.2, TARGET_Z), SERVER, FORCED);
    expect(d.action).toBe('snap');
  });

  it('distance is computed in the horizontal plane (diagonal)', () => {
    const d = decidePositionCorrection(outdoors(TARGET_X + 3, TARGET_Z + 4), SERVER, STILL);
    expect(d.horizontalDistance).toBeCloseTo(5, 6);
    expect(d.action).toBe('blend');
  });
});

describe('decidePositionCorrection — dungeon handling', () => {
  // Interior cell in block 0x0103 (the CLAUDE.md landmine block).
  const DCELL = 0x01030100;
  const D_X = 1 * 192;
  const D_Z = 3 * 192;

  it('same dungeon block: small delta blends, cell id preserved as interior', () => {
    const d = decidePositionCorrection(
      inDungeon(D_X + 30, D_Z + 40, 6, DCELL),
      { cellId: 0x01030105, x: 33, y: 40, z: 6 }, // 3m away, same block, different EnvCell
      STILL,
    );
    expect(d.action).toBe('blend');
    expect(d.isInterior).toBe(true);
    expect(d.contextChanged).toBe(false);
  });

  it('vertical floor change inside a dungeon snaps (no XZ-only tunnel)', () => {
    const d = decidePositionCorrection(
      inDungeon(D_X + 30, D_Z + 40, 0, DCELL),
      { cellId: 0x01030105, x: 31, y: 40, z: DEFAULT_CORRECTION_THRESHOLDS.interiorFloorDelta },
      STILL,
    );
    expect(d.action).toBe('snap');
    expect(d.verticalDistance).toBeCloseTo(DEFAULT_CORRECTION_THRESHOLDS.interiorFloorDelta, 6);
  });

  it('outdoor vertical deltas do NOT snap (terrain height is client-sampled)', () => {
    const CELL = (5 << 24) | (10 << 16) | 0x0001;
    // 2m horizontal (blend range) + 10m vertical: outdoors the vertical
    // component must not escalate to a snap — the render loop re-derives
    // ground height from the client heightmap every frame anyway.
    const d = decidePositionCorrection(
      outdoors(5 * 192 + 42, 10 * 192 + 80, 10),
      { cellId: CELL, x: 40, y: 80, z: 20 },
      STILL,
    );
    expect(d.verticalDistance).toBeCloseTo(10, 6);
    expect(d.action).toBe('blend');
  });

  it('far-away outdoor server cell while in a dungeon → teleport (full transition)', () => {
    const d = decidePositionCorrection(
      inDungeon(D_X + 30, D_Z + 40, 6, DCELL),
      { cellId: 0x01040001, x: 30, y: 40, z: 6 }, // next block over: 192m away
      STILL,
    );
    expect(d.action).toBe('teleport');
    expect(d.contextChanged).toBe(true);
    expect(d.isInterior).toBe(false);
  });

  it('far-away interior server cell while outdoors → teleport', () => {
    const d = decidePositionCorrection(
      outdoors(D_X + 30, D_Z + 40, 6),
      { cellId: 0x05940120, x: 30, y: 40, z: 6 },
      STILL,
    );
    expect(d.action).toBe('teleport');
    expect(d.contextChanged).toBe(true);
    expect(d.isInterior).toBe(true);
  });

  it('different dungeon BLOCK far away is a context change even interior↔interior', () => {
    const d = decidePositionCorrection(
      inDungeon(D_X + 30, D_Z + 40, 6, DCELL),
      { cellId: 0x01940120, x: 30, y: 40, z: 6 },
      STILL,
    );
    expect(d.action).toBe('teleport');
    expect(d.contextChanged).toBe(true);
  });

  it('large VERTICAL delta with a context change teleports (dungeon under same XZ)', () => {
    const d = decidePositionCorrection(
      outdoors(D_X + 30, D_Z + 40, 50),
      { cellId: DCELL, x: 30, y: 40, z: 50 - DEFAULT_CORRECTION_THRESHOLDS.snapAbove },
      STILL,
    );
    expect(d.action).toBe('teleport');
  });

  it('SMALL-delta context flip (surface-building doorway) stays positional — no portal flash', () => {
    // Walking out a shop door: server cell flips interior→exterior while
    // the position is continuous. Must NOT run the teleport path.
    const ignored = decidePositionCorrection(
      inDungeon(D_X + 30, D_Z + 40, 6, DCELL),
      { cellId: 0x01030001, x: 30.5, y: 40, z: 6 }, // 0.5m, exterior sub-cell
      STILL,
    );
    expect(ignored.contextChanged).toBe(true);
    expect(ignored.action).toBe('ignore');

    const blended = decidePositionCorrection(
      outdoors(D_X + 30, D_Z + 40, 6),
      { cellId: DCELL, x: 33, y: 40, z: 6 }, // 3m into the interior cell
      STILL,
    );
    expect(blended.contextChanged).toBe(true);
    expect(blended.action).toBe('blend');
  });

  it('forced + context change teleports even with a small delta', () => {
    const d = decidePositionCorrection(
      inDungeon(D_X + 30, D_Z + 40, 6, DCELL),
      { cellId: 0x01030001, x: 30, y: 40, z: 6 },
      FORCED,
    );
    expect(d.action).toBe('teleport');
  });

  it('terrain cell 0xFFFF is exterior (never treated as an interior cell)', () => {
    const d = decidePositionCorrection(
      outdoors(D_X + 30, D_Z + 45, 6),
      { cellId: 0x0103FFFF, x: 30, y: 40, z: 6 },
      STILL,
    );
    expect(d.isInterior).toBe(false);
    expect(d.contextChanged).toBe(false);
    expect(d.action).toBe('blend'); // 5m delta
  });
});

describe('blendStep — smooth correction easing', () => {
  it('moves toward the target without overshooting', () => {
    const s = blendStep(0, 0, 10, 0, 1 / 60);
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(10);
    expect(s.z).toBe(0);
    expect(s.done).toBe(false);
  });

  it('larger dt converges faster (frame-rate independent easing)', () => {
    const fast = blendStep(0, 0, 10, 0, 0.1);
    const slow = blendStep(0, 0, 10, 0, 0.016);
    expect(fast.x).toBeGreaterThan(slow.x);
  });

  it('snaps exactly to the target once within BLEND_SNAP_WITHIN', () => {
    const s = blendStep(10 - BLEND_SNAP_WITHIN / 2, 5, 10, 5, 1 / 60);
    expect(s.x).toBe(10);
    expect(s.z).toBe(5);
    expect(s.done).toBe(true);
  });

  it('converges and reports done within a bounded number of frames', () => {
    let x = 0, z = 0;
    let done = false;
    let frames = 0;
    while (!done && frames < 600) {
      const s = blendStep(x, z, 3, -4, 1 / 60);
      x = s.x; z = s.z; done = s.done;
      frames++;
    }
    expect(done).toBe(true);
    expect(x).toBe(3);
    expect(z).toBe(-4);
    // tau=0.15s → ~95% in 0.45s; full snap well under 2s at 60fps.
    expect(frames).toBeLessThan(120);
  });

  it('handles diagonal targets symmetrically', () => {
    const s = blendStep(0, 0, 6, 8, 0.15);
    // Equal fractional progress on both axes.
    expect(s.x / 6).toBeCloseTo(s.z / 8, 10);
  });
});

// ── CORE.2 — retail self-position gate (SmartBox::HandleReceivedPosition) ──
//
// The decompiled retail client @ 00453fd0 (acclient-decompiled.c:87070-87089)
// applies a received position to the SELF player ONLY when the
// ObjectForcePosition timestamp advanced (CPhysicsObj::newer_event); routine
// non-forced UpdatePosition echoes are never applied to self. main.ts's
// onUpdatePosition now gates applyServerPositionCorrection on
// isSequenceNewer(incoming, tracked) — without the gate, ACE's ~1-2s-stale
// self-echo (Player_Tick.cs:513-516 1s throttle + tick + RTT) sat further
// behind than the 6m moving-ignore threshold at run speed (6.2 m/s) and the
// blend rubber-banded the running player back along their own path (live:
// verification/core2-run-default/ probes — running netted 0m while walking
// worked, presenting as Jake's "run/walk inverted" report).
describe('isSequenceNewer — retail newer_event 16-bit compare (CORE.2)', () => {
  it('strictly newer within the window', () => {
    expect(isSequenceNewer(1, 0)).toBe(true);
    expect(isSequenceNewer(100, 99)).toBe(true);
    expect(isSequenceNewer(0x7FFF, 0)).toBe(true);
  });

  it('equal is not newer (the routine-echo case — must NOT apply)', () => {
    expect(isSequenceNewer(0, 0)).toBe(false);
    expect(isSequenceNewer(42, 42)).toBe(false);
  });

  it('older is not newer', () => {
    expect(isSequenceNewer(0, 1)).toBe(false);
    expect(isSequenceNewer(99, 100)).toBe(false);
  });

  it('wraps around 0xFFFF: 0 is newer than 0xFFFF', () => {
    expect(isSequenceNewer(0, 0xFFFF)).toBe(true);
    expect(isSequenceNewer(5, 0xFFF0)).toBe(true);
    expect(isSequenceNewer(0xFFF0, 5)).toBe(false);
  });

  it('half-window boundary: distance 0x8000 reads as not-newer', () => {
    expect(isSequenceNewer(0x8000, 0)).toBe(false);
  });
});
