/**
 * MOVE.retail-ab-god-rerecord — our MoveToState RawMotionState bytes against
 * the retail client's, as recorded on the wire by the movement A/B
 * (tools/retail-movement-ab.ts, 2026-10-05 recording; docs/movement-ab.md).
 *
 * Retail's RawMotionState::Pack @ 0051ed10 packs a per-command hold key
 * (ForwardHoldKey / SidestepHoldKey / TurnHoldKey) only when it is not
 * HoldKey_Invalid, and the keyboard path never sets one, so a retail run is
 * `05000000 02000000 05000045`. Ours used to add ForwardHoldKey (`0d…`).
 *
 * Drives the real MovementSync with a stub connection.
 */
import { describe, it, expect } from 'vitest';
import { GameActionType } from '@ac/network';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState } from '../packages/renderer/src/network/MovementSync.js';

const POS = {
  worldX: 100, worldZ: 200, groundY: 10, playerYaw: 0, landblock: 0xa9b4ffff,
  localX: 100, localY: 8, localZ: 20, inDungeon: false, onGround: true,
};
const IDLE: MovementState = {
  forward: false, backward: false, turnLeft: false, turnRight: false,
  strafeLeft: false, strafeRight: false, running: true, runToggle: true,
};

/** The RawMotionState bytes of every MoveToState the states produce, in order. */
function rawStates(states: Partial<MovementState>[]): string[] {
  const sent: Uint8Array[] = [];
  const conn = { sendMessage: (bytes: Uint8Array) => { sent.push(bytes); } };
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync(conn as any, () => ++seq);
  states.forEach((s, i) => sync.update({ ...IDLE, ...s }, POS, i * 100));
  return sent
    .filter((m) => new DataView(m.buffer, m.byteOffset).getUint32(8, true) === GameActionType.MoveToState)
    .map((m) => {
      const flags = new DataView(m.buffer, m.byteOffset + 12).getUint32(0, true) & 0x7ff;
      const fields = [0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400].filter((b) => flags & b).length;
      return Buffer.from(m.subarray(12, 12 + 4 + fields * 4)).toString('hex');
    });
}

describe('MOVE.retail-ab-god-rerecord — MoveToState bytes match the retail client', () => {
  it('run: press and release', () => {
    expect(rawStates([{ forward: true }, {}])).toEqual(['050000000200000005000045', '0100000002000000']);
  });

  it('walk (Shift held through the press): no hold key at all', () => {
    expect(rawStates([{ forward: true, running: false }, { running: false }]))
      .toEqual(['0400000005000045', '00000000']);
  });

  it('backpedal', () => {
    expect(rawStates([{ backward: true }, {}])).toEqual(['050000000200000006000045', '0100000002000000']);
  });

  it('run, then strafe right while running', () => {
    expect(rawStates([{ forward: true }, { forward: true, strafeRight: true }, { forward: true }, {}])).toEqual([
      '050000000200000005000045', '2500000002000000050000450f000065', '050000000200000005000045', '0100000002000000',
    ]);
  });

  it('run, then turn right while running', () => {
    expect(rawStates([{ forward: true }, { forward: true, turnRight: true }, { forward: true }, {}])).toEqual([
      '050000000200000005000045', '0501000002000000050000450d000065', '050000000200000005000045', '0100000002000000',
    ]);
  });

  it('strafe right, then strafe left', () => {
    expect(rawStates([{ strafeRight: true }, {}, { strafeLeft: true }, {}])).toEqual([
      '21000000020000000f000065', '0100000002000000', '210000000200000010000065', '0100000002000000',
    ]);
  });

  it('shift-toggle: Shift taps while running send nothing (SetHoldRun @ 006b3370)', () => {
    expect(rawStates([
      { forward: true }, { forward: true, running: false }, { forward: true }, { forward: true, running: false }, { forward: true }, {},
    ])).toEqual(['050000000200000005000045', '0100000002000000']);
  });
});
