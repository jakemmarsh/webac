/**
 * Combat / use motion on OUR character, as retail applies it (behavioural).
 *
 * Found live 2026-09-27 (tools/probe-combat-motion.ts, Jake: "when i targeted
 * an enemy i kinda just slid towards it … no attack animations … no eating
 * animation"):
 *  - ACE sends the melee swing (fwd 0x5F) and Eat (fwd 0x1A) for the player as
 *    NON-autonomous ForwardCommands; ServerObjectManager dropped every forward
 *    command for the local player, so neither played.
 *  - the client walked the player to a melee target itself, moving the
 *    position without any animation (and without movement traffic).
 * Retail (decompiled EoL client):
 *  - CPhysics::SetObjectMovement @ 00509690 applies a movement to the player
 *    unless it is autonomous; MovementManager::unpack_movement @ 00524440 runs
 *    type 6/7 through the MoveToManager.
 *  - ClientCombatSystem::ExecuteAttack @ 0056bb70 sends the attack at any
 *    range and plays no local swing; the server's MoveToObject brings the
 *    player in (ACE Player_Move CreateMoveToChain), and a MoveToState from
 *    the client cancels that chain (GameActionMoveToState.cs:22).
 */
import { describe, it, expect } from 'vitest';
import { parseMovementData } from '@ac/network';
import { approachAnimInput } from '../packages/renderer/src/controllers/MoveToManager.js';
import { yawForHeading, headingForYaw } from '../packages/renderer/src/world/Heading.js';

/** 0xF74C body: header (u16 u16 autonomous u8 pad), type 0, style, ForwardCommand only. */
function interpreted(styleIndex: number, forwardCmd: number, autonomous = false): Uint8Array {
  const buf = new Uint8Array(6 + 4 + 4 + 2 + 2);
  const v = new DataView(buf.buffer);
  v.setUint8(4, autonomous ? 1 : 0);
  let o = 6;
  v.setUint8(o, 0); o += 1;
  v.setUint8(o, 0); o += 1;
  v.setUint16(o, styleIndex, true); o += 2;
  v.setUint32(o, 0x2, true); o += 4;
  v.setUint16(o, forwardCmd, true);
  return buf;
}

/** 0xF74C body of type 6 MoveToObject (ACE MoveToObject.cs Write). */
function moveToObject(target: number, autonomous = false): Uint8Array {
  const buf = new Uint8Array(6 + 4 + 4 + 16 + 28 + 4);
  const v = new DataView(buf.buffer);
  v.setUint8(4, autonomous ? 1 : 0);
  let o = 6;
  v.setUint8(o, 6); o += 1;
  v.setUint8(o, 0); o += 1;
  v.setUint16(o, 0x3e, true); o += 2;
  v.setUint32(o, target, true); o += 4;
  v.setUint32(o, 0xa9b40019, true); o += 4;
  for (const f of [84.5, 12.25, 94]) { v.setFloat32(o, f, true); o += 4; }
  v.setUint32(o, 0x400 | 0x200 | 0x3, true); o += 4;
  for (const f of [0.6, 0, 3.4028234663852886e38, 1, 1.5, 0]) { v.setFloat32(o, f, true); o += 4; }
  v.setFloat32(o, 1.35, true);
  return buf;
}

describe('parseMovementData — the autonomous byte and the MoveTo body', () => {
  it('reads the header autonomous byte (false for the headerless CreateObject form)', () => {
    expect(parseMovementData(interpreted(0x3e, 0x5f, false), true)!.autonomous).toBe(false);
    expect(parseMovementData(interpreted(0x3e, 0x5f, true), true)!.autonomous).toBe(true);
    expect(parseMovementData(interpreted(0x3e, 0x5f, true).subarray(6), false)!.autonomous).toBe(false);
  });
  it('decodes MoveToObject: target, origin, MoveToParameters and the run rate', () => {
    const p = parseMovementData(moveToObject(0x80000513), true)!;
    expect(p.movementType).toBe(6);
    expect(p.moveTo).toMatchObject({
      target: 0x80000513, cellId: 0xa9b40019, flags: 0x603,
      origin: { x: 84.5, y: 12.25, z: 94 },
      walkRunThreshold: 1.5, speed: 1,
    });
    expect(p.moveTo!.distanceToObject).toBeCloseTo(0.6, 6);
    expect(p.moveTo!.runRate).toBeCloseTo(1.35, 6);
  });
});

describe('ServerObjectManager — the server\'s motions on our own character', () => {
  async function makeSOM() {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    const queued: number[] = [];
    const forward: unknown[] = [];
    const mm = {
      queueAction: (key: number) => queued.push(key),
      setForwardMotion: (key: unknown) => forward.push(key),
      setStanceFromId: () => {},
      isPlayingAction: false,
      motion: 0,
      currentStyleId: 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(0x50000001, { motionManager: mm } as any, true);
    return { som, queued, forward, mm };
  }

  it('a non-autonomous swing (0x5F, Action class) plays once as an action; Eat (0x1A, SubState class) becomes the substate', async () => {
    const { som, queued, forward } = await makeSOM();
    som.handleMovementEvent({ guid: 0x50000001, movementData: interpreted(0x3e, 0x5f) } as never);
    som.handleMovementEvent({ guid: 0x50000001, movementData: interpreted(0x3d, 0x1a) } as never);
    expect(queued.map((k) => k & 0xffff)).toEqual([0x5f]);
    expect(queued[0] >>> 16).toBe(0x3e); // keyed with the event's style (MotionManager.compositeKey)
    // Eat (0x4000001a) is a SubState: link Ready→Eat, hold, and the server's
    // following Ready plays the return link (BUG.spellcast-animations).
    expect(forward).toEqual([0x3d001a]);
  });

  it('an AUTONOMOUS echo of our own motion is ignored (SetObjectMovement\'s player rule)', async () => {
    const { som, queued } = await makeSOM();
    som.handleMovementEvent({ guid: 0x50000001, movementData: interpreted(0x3e, 0x5f, true) } as never);
    expect(queued).toEqual([]);
  });

  it('Ready and the locomotion cycles stay the local controller\'s', async () => {
    const { som, queued } = await makeSOM();
    for (const cmd of [0x03, 0x05, 0x07, 0x0d, 0x0f, 0x15]) {
      som.handleMovementEvent({ guid: 0x50000001, movementData: interpreted(0x3e, cmd) } as never);
    }
    expect(queued).toEqual([]);
  });

  it('the same action already playing (a local prediction) is not restarted', async () => {
    const { som, queued, mm } = await makeSOM();
    mm.isPlayingAction = true;
    mm.motion = 0x1000005f;
    som.handleMovementEvent({ guid: 0x50000001, movementData: interpreted(0x3e, 0x5f) } as never);
    expect(queued).toEqual([]);
  });

  it('a non-autonomous MoveToObject for us goes to the player\'s MoveToManager, not the walk-cycle shortcut', async () => {
    const { som, forward } = await makeSOM();
    const moves: number[] = [];
    som.onLocalPlayerMovement = (t, m) => { moves.push(t, m.moveTo!.target); };
    som.handleMovementEvent({ guid: 0x50000001, movementData: moveToObject(0x80000513) } as never);
    expect(moves).toEqual([6, 0x80000513]);
    expect(forward).toEqual([]);
  });
});

describe('approachAnimInput — the controller input while the MoveToManager drives us', () => {
  it('reports forward (run or walk) and keeps the rest of the real input live', () => {
    const real = { isMovingForward: false, isRunning: false, isStrafingLeft: true, isJumpHeld: true };
    const v = approachAnimInput(real, { forward: true, running: true, turn: null });
    expect(v.isMovingForward).toBe(true);
    expect(v.isRunning).toBe(true);
    expect(v.isStrafingLeft).toBe(false);
    expect(v.isJumpHeld).toBe(true);
    real.isJumpHeld = false;
    expect(v.isJumpHeld).toBe(false);
    expect(approachAnimInput(real, { forward: true, running: false, turn: null }).isRunning).toBe(false);
  });
  it('an aux turn while running shows both (HandleMoveToPosition steering)', () => {
    const v = approachAnimInput({ isMovingForward: false, isRunning: false }, { forward: true, running: true, turn: 'left' });
    expect(v.isMovingForward).toBe(true);
    expect((v as { isTurningLeft?: boolean }).isTurningLeft).toBe(true);
  });
});

describe('MovementSync during a server MoveTo — AutonomousPosition only', () => {
  async function makeSync() {
    const { MovementSync } = await import('../packages/renderer/src/network/MovementSync.js');
    const sent: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = { sendMessage: (msg: Uint8Array) => { sent.push(new DataView(msg.buffer, msg.byteOffset).getUint32(8, true)); } } as any;
    let seq = 0;
    return { sync: new MovementSync(conn, () => ++seq), sent };
  }
  const pos = { worldX: 100, worldZ: 200, groundY: 5, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
  const idle = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: false };
  it('serverControlled keeps the AutonomousPosition cadence without a MoveToState', async () => {
    const { sync, sent } = await makeSync();
    sync.update({ ...idle }, pos, 0);
    sent.length = 0;
    // The server's MoveTo moves us with no keys held: the position rule
    // reports each second's progress, and nothing emits a MoveToState (which
    // would cancel ACE's MoveTo chain).
    sync.update({ ...idle, serverControlled: true }, { ...pos, worldX: pos.worldX + 2 }, 1200);
    sync.update({ ...idle, serverControlled: true }, { ...pos, worldX: pos.worldX + 3 }, 1600);
    sync.update({ ...idle, serverControlled: true }, { ...pos, worldX: pos.worldX + 6 }, 2400);
    expect(sent).toEqual([0xf753, 0xf753]); // AutonomousPosition at 1.2 s and 2.4 s
  });
  it('sendAutonomousPositionNow sends only an AutonomousPosition', async () => {
    const { sync, sent } = await makeSync();
    sync.sendAutonomousPositionNow(pos);
    expect(sent).toEqual([0xf753]);
  });
});

describe('TurnToObject / TurnToHeading — the cast and attack turn to face', () => {
  /** 0xF74C body of type 8 (ACE TurnToObject.cs Write). */
  function turnToObject(target: number, heading: number, speed = 1, autonomous = false): Uint8Array {
    const buf = new Uint8Array(6 + 4 + 8 + 12);
    const v = new DataView(buf.buffer);
    v.setUint8(4, autonomous ? 1 : 0);
    let o = 6;
    v.setUint8(o, 8); o += 1;
    v.setUint8(o, 0); o += 1;
    v.setUint16(o, 0x49, true); o += 2;
    v.setUint32(o, target, true); o += 4;
    v.setFloat32(o, heading, true); o += 4;
    v.setUint32(o, 0x3, true); o += 4;
    v.setFloat32(o, speed, true); o += 4;
    v.setFloat32(o, 0, true);
    return buf;
  }
  it('parses the target, heading and speed', () => {
    const p = parseMovementData(turnToObject(0x80000513, 90, 1.5), true)!;
    expect(p.turnTo).toEqual({ target: 0x80000513, flags: 3, speed: 1.5, desiredHeading: 90 });
  });
  it('routes a non-autonomous TurnTo for us to the turn runner', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(0x50000001, { motionManager: { queueAction: () => {}, setForwardMotion: () => {}, setStanceFromId: () => {}, isPlayingAction: false, motion: 0 } } as any, true);
    const turns: number[] = [];
    som.onLocalPlayerMovement = (_t, m) => { turns.push(m.turnTo!.target); };
    som.handleMovementEvent({ guid: 0x50000001, movementData: turnToObject(7, 0) } as never);
    som.handleMovementEvent({ guid: 0x50000001, movementData: turnToObject(8, 0, 1, true) } as never); // autonomous: ignored
    expect(turns).toEqual([7]);
  });
  it('AC heading ↔ our yaw (0 north / AC +y, 90 east / AC +x)', () => {
    expect(yawForHeading(0)).toBeCloseTo(Math.atan2(-0, -1), 9);
    expect(yawForHeading(90)).toBeCloseTo(Math.atan2(-1, -0), 9);
    for (const h of [0, 45, 90, 200, 359]) expect(headingForYaw(yawForHeading(h))).toBeCloseTo(h, 6);
  });
  it('approachAnimInput with a turn shows the turn cycle, not forward', () => {
    const v = approachAnimInput({ isMovingForward: true, isRunning: true }, { forward: false, running: true, turn: 'right' });
    expect(v.isMovingForward).toBe(false);
    expect((v as { isTurningRight?: boolean }).isTurningRight).toBe(true);
  });
});
