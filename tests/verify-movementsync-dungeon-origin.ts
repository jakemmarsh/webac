/**
 * BUG.movementsync-dungeon-origin-floor-division — behavioral.
 *
 * In dungeon mode MovementSync must derive the reported local origin
 * relative to the REPORTED interior cell's landblock, not by floor
 * division of the world position. Interior geometry can extend outside
 * its host block: the four starter cottages sit at y=-28.482 in their
 * cell's frame (portal.dat CharGen, mirrored in Heritage.ts
 * STARTING_POSITIONS). Floor division put that origin in the
 * neighboring block's frame (y=163.518) while still naming the interior
 * cell, so ACE placed the player 192m north of reality, echoed it back
 * (Player_Tick.cs:513-516), and the client snap-teleported out of the
 * sealed dungeon — observed live 2026-08-19 as collisionState z
 * flapping 355.518 <-> 547.518 on a fresh character.
 *
 * Drives the REAL MovementSync with a stub connection and decodes the
 * emitted wire bytes with the round-trip payload parsers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMoveToStatePayload,
  parseAutonomousPositionPayload,
} from '@ac/network';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState, PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';

const GAMEACTION_HEADER = 12; // [u32 opcode][u32 sequence][u32 actionType]

const IDLE_STATE: MovementState = {
  forward: false, backward: false,
  turnLeft: false, turnRight: false,
  strafeLeft: false, strafeRight: false,
  running: true,
};

/** Send one position through the real MovementSync, decode both emitted
 *  messages (MoveToState + AutonomousPosition) back into position fields. */
function roundTrip(pos: PlayerPosition) {
  const sent: Uint8Array[] = [];
  const conn = { sendMessage: (bytes: Uint8Array) => { sent.push(bytes); } };
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync(conn as any, () => ++seq);
  sync.sendPositionNow(IDLE_STATE, pos);
  expect(sent.length).toBe(2);
  const mts = parseMoveToStatePayload(sent[0].subarray(GAMEACTION_HEADER));
  const ap = parseAutonomousPositionPayload(sent[1].subarray(GAMEACTION_HEADER));
  return { moveToState: mts.position, autonomous: ap };
}

describe('MovementSync dungeon-local origin (BUG.movementsync-dungeon-origin-floor-division)', () => {
  // Holtburg starting cottage: interior cell 0x860201AD, cell-relative
  // origin y=-28.482 (portal.dat CharGen). World AC-Y = 0x02*192 - 28.482.
  const COTTAGE_CELL = 0x860201ad;
  const cottagePos: PlayerPosition = {
    worldX: 0x86 * 192 + 82.111,
    worldZ: 0x02 * 192 - 28.482, // = 355.518, south of the host block edge
    groundY: 0.005,
    playerYaw: 0,
    landblock: COTTAGE_CELL,
    localX: 0, localY: 0, localZ: 0, // unused by buildPosition
    inDungeon: true,
    onGround: true,
  };

  it('reports the interior cell id AND an origin in that cell\'s landblock frame (negative y allowed)', () => {
    const { moveToState, autonomous } = roundTrip(cottagePos);
    for (const p of [moveToState, autonomous]) {
      expect(p.landblockId >>> 0).toBe(COTTAGE_CELL);
      expect(p.x).toBeCloseTo(82.111, 3);
      // The defect reported y=163.518 (origin in block 0x8601's frame).
      expect(p.y).toBeCloseTo(-28.482, 3);
      expect(p.z).toBeCloseTo(0.005, 3);
    }
  });

  it('lastSentCellId reports the cell of the last AutonomousPosition (null before any)', () => {
    const conn = { sendMessage: () => {} };
    let seq = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync(conn as any, () => ++seq);
    expect(sync.lastSentCellId).toBeNull();
    sync.sendPositionNow(IDLE_STATE, cottagePos);
    expect(sync.lastSentCellId).toBe(COTTAGE_CELL);
    const f = sync.lastSentFrame!;
    expect(f.cellId).toBe(COTTAGE_CELL);
    expect(f.x).toBeCloseTo(82.111, 3);
    expect(f.y).toBeCloseTo(-28.482, 3);
  });

  it('server-side decode of the reported position lands on the true world position (no ±192m)', () => {
    const { autonomous: p } = roundTrip(cottagePos);
    // ACE reconstructs world coords as landblock-of-cell * 192 + origin
    // (Position.cs GetWorldPos; our inbound serverPositionToWorld mirrors it).
    const decodedWorldX = ((p.landblockId >>> 24) & 0xff) * 192 + p.x;
    const decodedWorldY = ((p.landblockId >>> 16) & 0xff) * 192 + p.y;
    expect(decodedWorldX).toBeCloseTo(cottagePos.worldX, 3);
    expect(decodedWorldY).toBeCloseTo(cottagePos.worldZ, 3);
  });

  it('dungeon origin east/above the host block also stays cell-relative (positive out-of-range)', () => {
    // Interior extending past the block's far edge: world X beyond 192m of
    // the cell's landblock → local x > 192, never wrapped into a neighbor.
    const cell = 0x01640142;
    const pos: PlayerPosition = {
      ...cottagePos,
      landblock: cell,
      worldX: 0x01 * 192 + 205.25, // 13.25m past the east edge
      worldZ: 0x64 * 192 + 50.5,
    };
    const { autonomous: p } = roundTrip(pos);
    expect(p.landblockId >>> 0).toBe(cell);
    expect(p.x).toBeCloseTo(205.25, 3);
    expect(p.y).toBeCloseTo(50.5, 3);
  });

  it('outdoor path is unchanged: floor-division landblock + 1-based row-major cell id', () => {
    const pos: PlayerPosition = {
      ...cottagePos,
      inDungeon: false,
      landblock: 0,
      worldX: 0xa9 * 192 + 100.0, // cell col floor(100/24)=4
      worldZ: 0xb4 * 192 + 8.0,   // cell row floor(8/24)=0
    };
    const { moveToState, autonomous } = roundTrip(pos);
    const expectedCell = ((0xa9 << 24) | (0xb4 << 16) | (4 * 8 + 0 + 1)) >>> 0;
    for (const p of [moveToState, autonomous]) {
      expect(p.landblockId >>> 0).toBe(expectedCell);
      expect(p.x).toBeCloseTo(100.0, 3);
      expect(p.y).toBeCloseTo(8.0, 3);
    }
  });
});
