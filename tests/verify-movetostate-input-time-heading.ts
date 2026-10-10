import { describe, it, expect } from 'vitest';
import { parseMoveToStatePayload, GameActionType } from '@ac/network';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState } from '../packages/renderer/src/network/MovementSync.js';

// Retail's CommandInterpreter sends the MoveToState from input handling,
// before the physics tick turns the player, so a turn's first MoveToState
// carries the pre-turn heading (retail capture 2026-10-04: 0°; ours had 16°).
const BASE = {
  worldX: 100, worldZ: 200, groundY: 10, playerYaw: 0, landblock: 0xa9b4ffff,
  localX: 100, localY: 8, localZ: 20, inDungeon: false, onGround: true,
};
const TURN_RIGHT: MovementState = {
  forward: false, backward: false, turnLeft: false, turnRight: true,
  strafeLeft: false, strafeRight: false, running: true,
};

function sendOnce(pos: typeof BASE & { moveToStateYaw?: number }) {
  const sent: Uint8Array[] = [];
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => ++seq);
  sync.update(TURN_RIGHT, pos, 0);
  const mts = sent.find((m) => new DataView(m.buffer, m.byteOffset).getUint32(8, true) === GameActionType.MoveToState)!;
  return parseMoveToStatePayload(mts.subarray(12)).position;
}

describe('MoveToState heading is the input-time (pre-turn) heading', () => {
  it('uses moveToStateYaw when given, not the post-turn playerYaw', () => {
    const turned = 16 * Math.PI / 180;
    const withInput = sendOnce({ ...BASE, playerYaw: turned, moveToStateYaw: 0 });
    const asBefore = sendOnce({ ...BASE, playerYaw: 0 });
    const postTurn = sendOnce({ ...BASE, playerYaw: turned });
    expect([withInput.qw, withInput.qx, withInput.qy, withInput.qz]).toEqual([asBefore.qw, asBefore.qx, asBefore.qy, asBefore.qz]);
    expect(withInput.qw).not.toBeCloseTo(postTurn.qw, 6);
  });
});
