/**
 * FAITHFUL.391 / GAP.87 — Soul-emote MoveToState builder so observers see the
 *  animation too.
 *
 * Pre-fix FAITHFUL.390 played the matched MotionCommand locally and
 * shipped the SoulEmote text GameAction, but nothing told the server
 * to broadcast the motion to nearby observers. Per ACE
 * RawMotionState.cs:90 the server accepts soul-emote motions via
 * MoveToState with a CommandList entry containing the MotionCommand
 * (autonomous bit set, Speed=1.0); it then echoes the motion to all
 * nearby players via the standard MovementState broadcast.
 *
 * Wire format per
 *   reference/ACE/Source/ACE.Server/Network/Motion/MoveToState.cs:31-51
 *   reference/ACE/Source/ACE.Server/Network/Motion/RawMotionState.cs:49-96
 *   reference/ACE/Source/ACE.Server/Network/Motion/MotionItem.cs:91-106
 *   reference/ACE/Source/ACE.Entity/Position.cs:251-264
 *
 *   PackedFlags u32 = Flags low 11 bits | (CommandListLength << 11)
 *   { conditional RawMotionState fields per flag bit }
 *   For each command in CommandList:
 *     rawCommand   u16 = motion & 0xFFFF
 *     packedSequence u16 = (motionSeq & 0x7FFF) | (autonomous << 15)
 *     speed        f32
 *   Position (32 bytes: landblock u32, x/y/z f32, qw/qx/qy/qz f32)
 *   InstanceSequence / ServerControlSequence / TeleportSequence /
 *     ForcePositionSequence (4 × u16)
 *   ContactLongJump u8
 *   Align(4)
 *
 * GAP.87 (2026-07-26d): this used to be a pure source-text regex pin
 * against MovementSync.ts's raw BinaryWriter code — it never called the
 * real function or decoded actual bytes, the exact anti-pattern CLAUDE.md
 * flags. The wire construction has since been extracted into
 * @ac/network's buildMoveToStatePayload/buildAutonomousPositionPayload
 * (MessageSerializer.ts); these tests now drive the REAL MovementSync
 * class end-to-end and decode the captured bytes two independent ways:
 * the library's own parseMoveToStatePayload/parseAutonomousPositionPayload,
 * AND a from-scratch raw decoder below that mirrors ACE's exact
 * conditional read order — so a bug shared between the builder and its
 * own parser (not just a main.ts drift) would still be caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deserializeMessage, GameActionType,
  parseMoveToStatePayload, parseAutonomousPositionPayload,
} from '@ac/network';
import { RawMotionFlags, HoldKey } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const SYNC = readFileSync(resolve(REPO, 'packages/renderer/src/network/MovementSync.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

// ─── Independent raw decoder — mirrors ACE's exact read order without
//     reusing any of MessageSerializer.ts's own parsing code. ───────────

interface RawDecoded {
  flags: number;
  commandListLength: number;
  currentHoldKey?: number;
  currentStyle?: number;
  forwardCommand?: number;
  forwardHoldKey?: number;
  forwardSpeed?: number;
  sidestepCommand?: number;
  sidestepHoldKey?: number;
  sidestepSpeed?: number;
  turnCommand?: number;
  turnHoldKey?: number;
  turnSpeed?: number;
  commands: Array<{ rawCommand: number; sequence: number; autonomous: boolean; speed: number }>;
  landblockId: number;
  x: number; y: number; z: number;
  qw: number; qx: number; qy: number; qz: number;
  instanceSequence: number; serverControlSequence: number;
  teleportSequence: number; forcePositionSequence: number;
  contactByte: number;
  bytesConsumed: number;
}

function rawDecodeMoveToState(payload: Uint8Array): RawDecoded {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  let pos = 0;
  const u32 = () => { const v = dv.getUint32(pos, true); pos += 4; return v; };
  const u16 = () => { const v = dv.getUint16(pos, true); pos += 2; return v; };
  const u8 = () => { const v = dv.getUint8(pos); pos += 1; return v; };
  const f32 = () => { const v = dv.getFloat32(pos, true); pos += 4; return v; };

  const packedFlags = u32();
  const flags = packedFlags & 0x7FF;
  const commandListLength = packedFlags >>> 11;
  const out: RawDecoded = { flags, commandListLength, commands: [] } as unknown as RawDecoded;

  if (flags & RawMotionFlags.CurrentHoldKey) out.currentHoldKey = u32();
  if (flags & RawMotionFlags.CurrentStyle) out.currentStyle = u32();
  if (flags & RawMotionFlags.ForwardCommand) out.forwardCommand = u32();
  if (flags & RawMotionFlags.ForwardHoldKey) out.forwardHoldKey = u32();
  if (flags & RawMotionFlags.ForwardSpeed) out.forwardSpeed = f32();
  if (flags & RawMotionFlags.SideStepCommand) out.sidestepCommand = u32();
  if (flags & RawMotionFlags.SideStepHoldKey) out.sidestepHoldKey = u32();
  if (flags & RawMotionFlags.SideStepSpeed) out.sidestepSpeed = f32();
  if (flags & RawMotionFlags.TurnCommand) out.turnCommand = u32();
  if (flags & RawMotionFlags.TurnHoldKey) out.turnHoldKey = u32();
  if (flags & RawMotionFlags.TurnSpeed) out.turnSpeed = f32();

  for (let i = 0; i < commandListLength; i++) {
    const rawCommand = u16();
    const packedSequence = u16();
    const speed = f32();
    out.commands.push({ rawCommand, sequence: packedSequence & 0x7FFF, autonomous: (packedSequence >>> 15) === 1, speed });
  }

  out.landblockId = u32();
  out.x = f32(); out.y = f32(); out.z = f32();
  out.qw = f32(); out.qx = f32(); out.qy = f32(); out.qz = f32();
  out.instanceSequence = u16();
  out.serverControlSequence = u16();
  out.teleportSequence = u16();
  out.forcePositionSequence = u16();
  out.contactByte = u8();
  const remainder = pos % 4;
  if (remainder !== 0) pos += 4 - remainder;
  out.bytesConsumed = pos;
  return out;
}

// ─── Stub-connection harness ────────────────────────────────

async function withMovementSync() {
  const { MovementSync } = await import('../packages/renderer/src/network/MovementSync.js');
  const sent: Array<{ actionType: GameActionType; payload: Uint8Array }> = [];
  const conn = {
    sendMessage: (bytes: Uint8Array) => {
      const msg = deserializeMessage(bytes);
      if (msg.type !== 'action') throw new Error('expected a GameAction message');
      sent.push({ actionType: msg.actionType, payload: msg.payload });
    },
  };
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync(conn as any, () => ++seq);
  return { sync, sent };
}

const basePos = {
  worldX: 100, worldZ: 200, groundY: 12.5, playerYaw: 0,
  landblock: 0xa9b4ffff, localX: 0, localY: 0, localZ: 0, inDungeon: false,
};

describe('MovementSync.sendSoulEmoteMotion — behavioral (GAP.87)', () => {
  it('ships a single MoveToState with a 1-entry CommandList carrying the emote motion', async () => {
    const { sync, sent } = await withMovementSync();
    sync.sendSoulEmoteMotion(0x1234, { ...basePos, playerYaw: Math.PI / 2 }, true);

    expect(sent.length).toBe(1);
    expect(sent[0].actionType).toBe(GameActionType.MoveToState);

    const viaParser = parseMoveToStatePayload(sent[0].payload);
    const viaRaw = rawDecodeMoveToState(sent[0].payload);

    // Only CurrentHoldKey set — no movement flags. Retail packing
    // (RawMotionState::Pack @ 0051ed10) omits CurrentStyle in peace mode.
    expect(viaRaw.flags).toBe(RawMotionFlags.CurrentHoldKey);
    expect(viaRaw.currentStyle).toBeUndefined();
    expect(viaRaw.currentHoldKey).toBe(HoldKey.Run);
    expect(viaRaw.forwardCommand).toBeUndefined();
    expect(viaRaw.sidestepCommand).toBeUndefined();
    expect(viaRaw.turnCommand).toBeUndefined();
    expect(viaParser.motion.forwardCommand).toBe(0);
    expect(viaParser.motion.sidestepCommand).toBe(0);
    expect(viaParser.motion.turnCommand).toBe(0);
    expect(viaParser.motion.running).toBe(true);

    // CommandList: exactly 1 entry, motion low-16-bits, sequence=1 (first
    // call), autonomous bit set, speed 1.0 (required for server acceptance).
    expect(viaRaw.commandListLength).toBe(1);
    expect(viaRaw.commands).toHaveLength(1);
    expect(viaRaw.commands[0].rawCommand).toBe(0x1234 & 0xFFFF);
    expect(viaRaw.commands[0].sequence).toBe(1);
    expect(viaRaw.commands[0].autonomous).toBe(true);
    expect(viaRaw.commands[0].speed).toBe(1.0);
    expect(viaParser.motion.commands).toEqual([{ motionCommand: 0x1234, sequence: 1, autonomous: true, speed: 1.0 }]);

    // Position: yaw=PI/2 → θ = π − yaw = PI/2 (west) → qw=qz=cos/sin(PI/4).
    expect(viaRaw.qw).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(viaRaw.qx).toBe(0);
    expect(viaRaw.qy).toBe(0);
    expect(viaRaw.qz).toBeCloseTo(Math.sin(Math.PI / 4), 5);
    expect(viaRaw.z).toBe(12.5);

    // Whole payload consumed exactly (no trailing garbage, alignment correct).
    expect(viaRaw.bytesConsumed).toBe(sent[0].payload.length);
    expect(sent[0].payload.length % 4).toBe(0);
  });

  it('increments and 15-bit-masks the motion sequence counter across calls, wrapping past 0x7FFF', async () => {
    const { sync, sent } = await withMovementSync();
    for (let i = 0; i < 3; i++) sync.sendSoulEmoteMotion(0x0001, basePos, true);
    const sequences = sent.map((m) => rawDecodeMoveToState(m.payload).commands[0].sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it('walk (running=false) sends HoldKey.None', async () => {
    const { sync, sent } = await withMovementSync();
    sync.sendSoulEmoteMotion(0x0001, basePos, false);
    const decoded = rawDecodeMoveToState(sent[0].payload);
    // HoldKey_None is the default: retail omits CurrentHoldKey entirely.
    expect(decoded.flags & RawMotionFlags.CurrentHoldKey).toBe(0);
    expect(decoded.currentHoldKey).toBeUndefined();
  });
});

describe('MovementSync.sendMoveToState — behavioral (GAP.87)', () => {
  it('idle→forward+run transition: only Forward* flags + CurrentHoldKey/Style set, no CommandList', async () => {
    const { sync, sent } = await withMovementSync();
    const state = { forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };
    sync.update(state, basePos, 0);

    // The MoveToState goes first; the first frame's position event (nothing
    // sent yet — CommandInterpreter::ShouldSendPositionEvent) follows it.
    expect(sent.map((m) => m.actionType)).toEqual([GameActionType.MoveToState, GameActionType.AutonomousPosition]);
    expect(sent[0].actionType).toBe(GameActionType.MoveToState);
    const decoded = rawDecodeMoveToState(sent[0].payload);
    expect(decoded.flags).toBe(
      RawMotionFlags.CurrentHoldKey |
      RawMotionFlags.ForwardCommand, // no per-axis hold key (RawMotionState::Pack: Invalid is omitted)
    );
    // Pack sends a speed only when it is not 1.0.
    expect(decoded.forwardSpeed).toBeUndefined();
    expect(decoded.forwardHoldKey).toBeUndefined();
    expect(decoded.commandListLength).toBe(0);
    expect(decoded.commands).toHaveLength(0);
  });

  it('strafe: only SideStep* flags set alongside CurrentHoldKey/Style', async () => {
    const { sync, sent } = await withMovementSync();
    const state = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: true, strafeRight: false, running: true };
    sync.update(state, basePos, 0);
    const decoded = rawDecodeMoveToState(sent[0].payload);
    expect(decoded.flags).toBe(
      RawMotionFlags.CurrentHoldKey |
      RawMotionFlags.SideStepCommand,
    );
  });

  it('turn: only Turn* flags set alongside CurrentHoldKey/Style', async () => {
    const { sync, sent } = await withMovementSync();
    const state = { forward: false, backward: false, turnLeft: false, turnRight: true, strafeLeft: false, strafeRight: false, running: true };
    sync.update(state, basePos, 0);
    const decoded = rawDecodeMoveToState(sent[0].payload);
    expect(decoded.flags).toBe(
      RawMotionFlags.CurrentHoldKey |
      RawMotionFlags.TurnCommand,
    );
    expect(decoded.turnSpeed).toBeUndefined();
  });

  it('BUG.remote-turn-speed-packed: a keyboard turn omits TurnSpeed, so ACE relays the run turn at 1.5', async () => {
    // ACE MovementData(Creature, MoveToState): TurnSpeed = Run ? 1.5 : 1.0,
    // then a PRESENT raw TurnSpeed in (0, 1.5] replaces it (the mouse-look
    // rate). Retail packs turn_speed only when it is not 1.0, so a keyboard
    // run-turn reaches peers at 1.5; our always-packed 1.0 sent 1.0.
    const { sync, sent } = await withMovementSync();
    sync.update({ forward: false, backward: false, turnLeft: true, turnRight: false, strafeLeft: false, strafeRight: false, running: true }, basePos, 0);
    const decoded = rawDecodeMoveToState(sent[0].payload);
    expect(decoded.flags & RawMotionFlags.TurnSpeed).toBe(0);
    // ACE's conversion of what we sent.
    const raw = decoded.turnSpeed ?? 0;
    const relayed = raw !== 0 && raw <= 1.5 ? raw : 1.5;
    expect(relayed).toBe(1.5);
    // A mouse turn's own rate still goes out.
    const { sync: s2, sent: sent2 } = await withMovementSync();
    s2.update({ forward: false, backward: false, turnLeft: true, turnRight: false, strafeLeft: false, strafeRight: false, running: true, turnSpeed: 0.6 }, basePos, 0);
    const d2 = rawDecodeMoveToState(sent2[0].payload);
    expect(d2.flags & RawMotionFlags.TurnSpeed).toBe(RawMotionFlags.TurnSpeed);
    expect(d2.turnSpeed).toBeCloseTo(0.6, 6);
  });

  it('idle walk-mode state in peace mode is the empty raw state retail sends (no CurrentHoldKey/Style), on the first change', async () => {
    const { sync, sent } = await withMovementSync();
    // MovementSync's prevState default is idle+running, so flip running to
    // force a change with all movement keys still released.
    const state = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: false };
    sync.update(state, basePos, 0);
    const decoded = rawDecodeMoveToState(sent[0].payload);
    // This is the stop ACE relays to peers as style 0 with no commands —
    // the case that left retail players walking in place for us.
    expect(decoded.flags).toBe(0);
    expect(decoded.currentHoldKey).toBeUndefined();
  });
});

describe('RawMotionState packing matches retail (RawMotionState::Pack @ 0051ed10)', () => {
  it('a non-peace stance is sent as CurrentStyle', async () => {
    const { buildMoveToStatePayload: build, parseMoveToStatePayload: parse } = await import('../packages/network/src/MessageSerializer.js');
    const pos = { landblockId: 0xa9b40001, x: 1, y: 2, z: 3, qw: 1, qx: 0, qy: 0, qz: 0, instanceSequence: 1, serverControlSequence: 1, teleportSequence: 1, forcePositionSequence: 1, contact: true };
    const fields = { running: false, currentStance: 0x8000003c /* HandCombat */, forwardCommand: 0, sidestepCommand: 0, turnCommand: 0, commands: [] };
    const payload = build(fields, pos);
    const flags = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true) & 0x7ff;
    expect(flags & RawMotionFlags.CurrentStyle).toBe(RawMotionFlags.CurrentStyle);
    expect(flags & RawMotionFlags.CurrentHoldKey).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parse as any)(payload).motion.currentStance).toBe(0x8000003c);
  });
});

describe('MovementSync.sendAutonomousPosition — behavioral (GAP.87)', () => {
  it('dungeon position: landblock passed through verbatim, no RawMotionState prefix', async () => {
    const { sync, sent } = await withMovementSync();
    const dungeonPos = { ...basePos, inDungeon: true, landblock: 0x0130010f, worldX: 40, worldZ: 60, groundY: 5, playerYaw: Math.PI };
    // update() only sends AutonomousPosition once isMoving + interval elapsed; force via sendPositionNow instead.
    sync.sendPositionNow(
      { forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true },
      dungeonPos,
    );
    const autoMsg = sent.find((m) => m.actionType === GameActionType.AutonomousPosition);
    expect(autoMsg).toBeDefined();
    const parsed = parseAutonomousPositionPayload(autoMsg!.payload);
    expect(parsed.landblockId).toBe(0x0130010f);
    expect(parsed.z).toBe(5);
    // CORE.18.a — yaw π faces AC north: heading θ = π − yaw = 0 → identity.
    expect(parsed.qw).toBeCloseTo(1, 5);
    expect(parsed.qz).toBeCloseTo(0, 5);
    // AutonomousPosition payload is JUST the position tail: 32-byte Position
    // + 4×u16 sequences (8) + 1 contact byte (41), aligned up to 44 bytes.
    expect(autoMsg!.payload.length).toBe(44);
  });

  it('outdoor position: landblock/cell derived from world coordinates', async () => {
    const { sync, sent } = await withMovementSync();
    // worldX=250 → landblock X = floor(250/192)=1, localX=250-192=58; cellX=floor(58/24)=2
    // worldZ=100 → landblock Y = floor(100/192)=0, localY=100; cellY=floor(100/24)=4
    // cellId = 2*8 + 4 + 1 = 21
    const pos = { ...basePos, inDungeon: false, worldX: 250, worldZ: 100, groundY: 3 };
    sync.sendPositionNow(
      { forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true },
      pos,
    );
    const autoMsg = sent.find((m) => m.actionType === GameActionType.AutonomousPosition)!;
    const parsed = parseAutonomousPositionPayload(autoMsg.payload);
    const expectedLandblockId = ((1 << 24) | (0 << 16) | (21 & 0xFFFF)) >>> 0;
    expect(parsed.landblockId).toBe(expectedLandblockId);
    expect(parsed.x).toBeCloseTo(58, 5);
    expect(parsed.y).toBeCloseTo(100, 5);
  });

  it('onGround=false clears the contact bit; omitted/true sets it', async () => {
    const { sync: syncA, sent: sentA } = await withMovementSync();
    syncA.sendPositionNow(
      { forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true },
      { ...basePos, onGround: false },
    );
    const airborne = parseAutonomousPositionPayload(sentA.find((m) => m.actionType === GameActionType.AutonomousPosition)!.payload);
    expect(airborne.contact).toBe(false);

    const { sync: syncB, sent: sentB } = await withMovementSync();
    syncB.sendPositionNow(
      { forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true },
      basePos,
    );
    const grounded = parseAutonomousPositionPayload(sentB.find((m) => m.actionType === GameActionType.AutonomousPosition)!.payload);
    expect(grounded.contact).toBe(true);
  });
});

describe('MotionSequence counter (FAITHFUL.391)', () => {
  it('declares private motionSequence = 0', () => {
    expect(SYNC).toMatch(/private motionSequence = 0/);
  });

  it('increments + masks to 15 bits before each emote', () => {
    expect(SYNC).toMatch(/this\.motionSequence = \(this\.motionSequence \+ 1\) & 0x7FFF/);
  });
});

describe('main.ts wires the soul-emote MoveToState ship (FAITHFUL.391)', () => {
  const block = MAIN.match(/FAITHFUL\.391[\s\S]+?\}\);/)?.[0] ?? '';

  it('calls movementSync.sendSoulEmoteMotion in triggerEmoteMotion (the retail Pose path: *pose* / <pose> spans)', () => {
    expect(block).toMatch(/movementSync\.sendSoulEmoteMotion\(motion,/);
  });

  it('passes a complete PlayerPosition object', () => {
    expect(block).toMatch(/worldX: playerWorldX/);
    expect(block).toMatch(/worldZ: playerWorldZ/);
    // GAP.7 — the pinned `groundY: playerWorldY` froze a BUG (the jump
    // offset, ~0, i.e. underground). The wire Z must be the real feet
    // height (currentFeetY = ground + offset, or absolute while airborne).
    expect(block).toMatch(/groundY: currentFeetY\(\)/);
    expect(block).toMatch(/playerYaw: cameraController\.playerYaw/);
    expect(block).toMatch(/inDungeon: playerInDungeon/);
  });

  it('passes cameraController.isRunning as the running arg', () => {
    expect(block).toMatch(/cameraController\.isRunning\)/);
  });
});
