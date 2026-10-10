/**
 * FAITHFUL.563 / GAP.87 — Production jump trigger ships GameActionType.Jump to
 * the server, with a byte-for-byte-correct JumpPack payload.
 *
 * Prior version of this suite (pre-GAP.87) asserted everything via regex
 * matches against main.ts's SOURCE TEXT — it never called the payload
 * builder or inspected a resulting byte buffer, so a transposed field or a
 * wrong offset would have passed silently. GAP.87 flagged this as
 * "source-text matching, not byte serialization."
 *
 * Fix: the payload construction was extracted out of main.ts's inline
 * `new BinaryWriter(32)` block into `buildJumpActionPayload()` in
 * packages/network/src/MessageSerializer.ts (mirroring the existing
 * buildPositionPayload/buildSpeechPayload convention). main.ts now just
 * calls that shared, exported, testable function. This suite drives the
 * REAL shipped `buildJumpActionPayload` with concrete inputs and decodes the
 * resulting bytes with `parseJumpActionPayload` (or a raw BinaryReader) to
 * assert actual field order and values — genuine behavioral coverage.
 *
 * ACE Player.HandleActionJump (Player.cs:866-958) does five distinct pieces
 * of server work on receipt of this GameAction:
 *   1. Deducts stamina server-side via UpdateVitalDelta.
 *   2. Sets PhysicsObj.set_local_velocity(jump.Velocity) — the authoritative
 *      jump velocity for server physics.
 *   3. EnqueueBroadcast(new GameMessageUpdateMotion / VectorUpdate) — so
 *      OTHER players see the jump animation.
 *   4. Stops existing MoveTo chains (GameActionJump.cs:17-21).
 *   5. Fails active spell-cast (Player.cs:918-924).
 *
 * Wire format anchor: JumpPack.cs:18-26 (ctor read order) +
 * GameActionJump.cs:10-14 (trailing reads after the JumpPack ctor):
 *   Extent f32 + Velocity Vec3 (X,Y,Z f32 local-frame) +
 *   4 ushort sequences + objectGuid u32 + spellId u32 = 32 bytes total.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildJumpActionPayload, parseJumpActionPayload, BinaryReader } from '@ac/network';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { jumpLaunchVelocity } from '../packages/renderer/src/player/JumpLaunch.js';
import { RUN_ANIM_SPEED } from '../packages/shared/src/index.js';

const REPO = resolve(__dirname, '..');
const PLAYER_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Player.cs'),
  'utf8',
);
const JUMPACT_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionJump.cs'),
  'utf8',
);
const JUMPPACK_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/JumpPack.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (FAITHFUL.563)', () => {
  it('GameActionJump.cs constructs JumpPack from payload then reads guid+spellId u32', () => {
    expect(JUMPACT_CS).toMatch(/new JumpPack\(message\.Payload\)/);
    expect(JUMPACT_CS).toMatch(/message\.Payload\.ReadUInt32\(\);[\s\S]+message\.Payload\.ReadUInt32\(\);/);
  });

  it('JumpPack reads Extent (f32) + Velocity (Vec3) + 4 × ushort sequences', () => {
    expect(JUMPPACK_CS).toMatch(/Extent\s*=\s*reader\.ReadSingle\(\)/);
    expect(JUMPPACK_CS).toMatch(/Velocity\s*=\s*reader\.ReadVector3\(\)/);
    expect(JUMPPACK_CS).toMatch(/InstanceSequence\s*=\s*reader\.ReadUInt16\(\)/);
    expect(JUMPPACK_CS).toMatch(/ServerControlSequence\s*=\s*reader\.ReadUInt16\(\)/);
    expect(JUMPPACK_CS).toMatch(/TeleportSequence\s*=\s*reader\.ReadUInt16\(\)/);
    expect(JUMPPACK_CS).toMatch(/ForcePositionSequence\s*=\s*reader\.ReadUInt16\(\)/);
  });

  it('Player.HandleActionJump deducts stamina + broadcasts motion + clears moveto chains', () => {
    expect(PLAYER_CS).toMatch(/UpdateVitalDelta\(Stamina,\s*-staminaCost\)/);
    expect(PLAYER_CS).toMatch(/PhysicsObj\.set_local_velocity\(jump\.Velocity/);
    expect(PLAYER_CS).toMatch(/EnqueueBroadcast\(new GameMessageUpdateMotion/);
    expect(PLAYER_CS).toMatch(/EnqueueBroadcast\(new GameMessageVectorUpdate/);
    expect(JUMPACT_CS).toMatch(/StopExistingMoveToChains\(\)/);
  });
});

describe('buildJumpActionPayload produces byte-exact JumpPack wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 32 bytes', () => {
    const payload = buildJumpActionPayload(0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    expect(payload.length).toBe(32);
  });

  it('round-trips through parseJumpActionPayload with distinct sentinel values per field', () => {
    // Distinct values per field so a transposition (e.g. velocityY/velocityZ
    // swapped, or a sequence field shifted) fails instead of passing by
    // coincidence.
    const payload = buildJumpActionPayload(
      0.75,           // extent
      11, 22, 33,     // velocity X/Y/Z
      111, 222, 333, 444, // instance/serverControl/teleport/forcePosition sequences
      555,            // objectGuid
      666,            // spellId
    );
    const parsed = parseJumpActionPayload(payload);
    expect(parsed).toEqual({
      extent: 0.75,
      velocityX: 11,
      velocityY: 22,
      velocityZ: 33,
      instanceSequence: 111,
      serverControlSequence: 222,
      teleportSequence: 333,
      forcePositionSequence: 444,
      objectGuid: 555,
      spellId: 666,
    });
  });

  it('matches JumpPack.cs field order exactly when decoded with a raw BinaryReader (extent, then Vec3, then 4×u16, then trailing u32s)', () => {
    // Bypass parseJumpActionPayload entirely and decode with the same
    // primitive reads JumpPack.cs's ctor performs, in the same order, so
    // this test can't share a bug with parseJumpActionPayload.
    const payload = buildJumpActionPayload(0.5, 1.5, 2.5, 3.5, 10, 20, 30, 40, 50, 60);
    const reader = new BinaryReader(payload);
    expect(reader.readFloat32()).toBeCloseTo(0.5, 5);   // Extent
    expect(reader.readFloat32()).toBeCloseTo(1.5, 5);   // Velocity.X
    expect(reader.readFloat32()).toBeCloseTo(2.5, 5);   // Velocity.Y
    expect(reader.readFloat32()).toBeCloseTo(3.5, 5);   // Velocity.Z
    expect(reader.readUInt16()).toBe(10);                // InstanceSequence
    expect(reader.readUInt16()).toBe(20);                // ServerControlSequence
    expect(reader.readUInt16()).toBe(30);                // TeleportSequence
    expect(reader.readUInt16()).toBe(40);                // ForcePositionSequence
    expect(reader.readUInt32()).toBe(50);                // objectGuid (GameActionJump.cs trailing read #1)
    expect(reader.readUInt32()).toBe(60);                // spellId (GameActionJump.cs trailing read #2)
    expect(reader.remaining).toBe(0);
  });

  it('masks 32-bit sequence numbers down to uint16 (matches production movementSync wraparound)', () => {
    const payload = buildJumpActionPayload(1, 0, 0, 0, 0x1FFFF, 0, 0, 0);
    const parsed = parseJumpActionPayload(payload);
    expect(parsed.instanceSequence).toBe(0x1FFFF & 0xFFFF);
  });
});

// DECOMP.jump-velocity-vertical-only — ClientCombatSystem::DoJump @ 0056b110
// sends get_local_physics_velocity after CMotionInterp::jump, i.e. the
// leave-ground velocity (get_leave_ground_velocity @ 005280c0: the
// interpreted motion's get_state_velocity plus the jump's z). The old
// payload sent (0, 0, vz), so peers saw every running jump as a vertical hop.
// main.ts builds the payload from jumpLaunchVelocity(cameraController, vz).local.
describe('the Jump payload carries the full local launch velocity (DECOMP.jump-velocity-vertical-only)', () => {
  function controller(keys: string[], runRate = 1.5): CameraController {
    const cc = new CameraController(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000));
    cc.runRate = runRate;
    for (const k of keys) cc.simulateKeyDown(k);
    return cc;
  }

  it('a running jump sends forward = run speed × run rate, side 0, z = the jump velocity', () => {
    const launch = jumpLaunchVelocity(controller(['KeyW']), 5.2);
    const parsed = parseJumpActionPayload(buildJumpActionPayload(0.8, launch.local.x, launch.local.y, launch.local.z, 1, 2, 3, 4));
    expect(parsed.velocityX).toBeCloseTo(0, 5);
    expect(parsed.velocityY).toBeCloseTo(RUN_ANIM_SPEED * 1.5, 4);
    expect(parsed.velocityZ).toBeCloseTo(5.2, 5);
  });

  it('a strafing jump sends a side component, sign = direction (x + right)', () => {
    const right = jumpLaunchVelocity(controller(['KeyC']), 3).local;
    const left = jumpLaunchVelocity(controller(['KeyZ']), 3).local;
    expect(right.x).toBeGreaterThan(0);
    expect(left.x).toBeCloseTo(-right.x, 6);
    expect(right.y).toBe(0);
  });

  it('a backward jump sends a negative forward (WalkForward at −BACKWARDS_FACTOR)', () => {
    expect(jumpLaunchVelocity(controller(['KeyS']), 3).local.y).toBeLessThan(0);
  });

  it('a standing jump sends only z', () => {
    expect(jumpLaunchVelocity(controller([]), 4).local).toEqual({ x: 0, y: 0, z: 4 });
  });

  it('the world launch velocity is the local one turned by the facing', () => {
    const cc = controller(['KeyW'], 1);
    cc.playerYaw = Math.PI; // facing north: forward = (−sin π, −cos π) = (0, +1)
    const { world } = jumpLaunchVelocity(cc, 2);
    expect(world.x).toBeCloseTo(0, 6);
    expect(world.z).toBeCloseTo(RUN_ANIM_SPEED, 6);
  });
});

