/**
 * BUG.createobject-movement-placement-skipped — CreateObject must parse the
 * PhysicsDesc Movement blob (the object's authoritative CurrentMotionState)
 * and the AnimationFrame Placement uint instead of skipping them, and the
 * renderer must apply the initial motion so corpses lie dead and open doors
 * render open on first sight — without the old "Corpse of " name-prefix hack.
 *
 * ACE ground truth:
 *  - WorldObject_Networking.cs SerializePhysicsData: under
 *    PhysicsDescriptionFlag.Movement writes a uint32 length prefix, then
 *    `writer.Write(movementData, false)` — the HEADERLESS MovementData form
 *    (no timestamps/autonomous/pad header, straight to movement_type u8 +
 *    motion_flags u8 + style u16 + type-specific section) — then, when the
 *    blob is non-empty, uint32 IsAutonomous. Under AnimationFrame (the
 *    CurrentMotionState==null else-branch of CalculatedPhysicsDescriptionFlag)
 *    it writes the Placement uint32 instead.
 *  - MovementData.cs Write(writer, motion, header): header=true adds the
 *    6-byte timestamps/autonomous/pad prefix — that form is the 0xF74C body.
 *  - InterpretedMotionState.cs Write: bitfield = flags | numCommands << 7,
 *    then flag-gated u16 commands (CurrentStyle, ForwardCommand,
 *    SideStepCommand, TurnCommand), f32 speeds, then MotionItem list
 *    (command u16 + sequence u16 + speed f32 each).
 *  - Corpse.cs:58: CurrentMotionState = new Motion(NonCombat,
 *    MotionCommand.Dead) — a corpse's dead pose IS on the wire at create.
 *  - Door.cs:43-49: CurrentMotionState = motionClosed/motionOpen
 *    (MotionCommand.Off/On) — an already-open door's pose likewise.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import type { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import type { MotionTable, MotionData } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { Sound } from '@ac/shared';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';
import { openDat } from './_harness/dat.js';
import { BinaryReader, parseCreateObjectFromReader, parseMovementData } from '@ac/network';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';

const DEAD_WIRE = MotionCommand.Dead & 0xFFFF;        // 0x11
const ON_WIRE = MotionCommand.On & 0xFFFF;            // 0x0b (door open)
const NONCOMBAT_STANCE_WIRE = MotionStance.NonCombat & 0xFFFF; // 0x3d

function u32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return Array.from(b);
}
function u16(n: number): number[] {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return Array.from(b);
}

/**
 * Headerless MovementData blob (the CreateObject PhysicsDesc form):
 * movement_type=Invalid + motion_flags=0 + outer style + an
 * InterpretedMotionState with CurrentStyle + ForwardCommand. Padded to a
 * DWORD multiple like ACE's writer.Align() inside the length prefix.
 */
function movementBlob(styleWire: number, forwardWire: number): number[] {
  const body = [
    0x00,                 // movement_type = Invalid
    0x00,                 // motion_flags
    ...u16(styleWire),    // outer style (MotionStance low 16 bits)
    ...u32(0x1 | 0x2),    // bitfield: CurrentStyle | ForwardCommand
    ...u16(styleWire),    // CurrentStyle
    ...u16(forwardWire),  // ForwardCommand
  ];
  while (body.length % 4 !== 0) body.push(0); // ACE writer.Align()
  return body;
}

const PHYS_MOVEMENT = 0x010000;       // PhysicsDescFlag.Movement
const PHYS_ANIMATION_FRAME = 0x020000; // PhysicsDescFlag.AnimationFrame

/**
 * Minimal CreateObject payload (same skeleton as
 * verify-create-object-final-align.ts) with either a Movement blob or an
 * AnimationFrame placement in the physics section.
 */
function buildPayload(opts: {
  guid?: number;
  name?: string;
  blob?: number[];
  placement?: number;
  isAutonomous?: number;
}): Uint8Array {
  const physFlags = opts.blob ? PHYS_MOVEMENT : (opts.placement !== undefined ? PHYS_ANIMATION_FRAME : 0);
  const name = opts.name ?? '';
  const nameBytes = [...u16(name.length), ...Array.from(new TextEncoder().encode(name))];
  while (nameBytes.length % 4 !== 0) nameBytes.push(0); // string16L align

  const bytes: number[] = [
    ...u32(opts.guid ?? 0x60001001),   // guid
    0x11, 0, 0, 0,                      // model header, no sub-blocks
    ...u32(physFlags),
    ...u32(0),                          // physicsState
    ...(opts.blob
      ? [...u32(opts.blob.length), ...opts.blob, ...u32(opts.isAutonomous ?? 0)]
      : []),
    ...(opts.placement !== undefined ? u32(opts.placement) : []),
    ...Array(18).fill(0),               // 9x u16 sequence timestamps
    0, 0,                               // align(4): cursor is at a +2 offset here
    ...u32(0),                          // weenieFlags = 0
    ...nameBytes,                       // name string16L + align
    ...u16(1000),                       // weenieClassId (packed dword)
    ...u16(0x0010),                     // iconId (packed dword)
    ...u32(0x200),                      // itemType = Container (corpse-like)
    ...u32(0),                          // objectDescFlags
  ];
  return new Uint8Array(bytes);
}

describe('parseCreateObjectFromReader — PhysicsDesc Movement blob (BUG.createobject-movement-placement-skipped)', () => {
  it('dead corpse: initialMotion carries stance + MotionCommand.Dead, isAutonomous decoded', () => {
    const blob = movementBlob(NONCOMBAT_STANCE_WIRE, DEAD_WIRE);
    const r = new BinaryReader(buildPayload({ name: 'Corpse of Tester', blob, isAutonomous: 0 }));
    const obj = parseCreateObjectFromReader(r);
    expect(obj.name).toBe('Corpse of Tester');
    expect(obj.initialMotion).toBeDefined();
    expect(obj.initialMotion!.movementType).toBe(0);
    expect(obj.initialMotion!.styleIndex).toBe(NONCOMBAT_STANCE_WIRE);
    expect(obj.initialMotion!.forwardCommand).toBe(DEAD_WIRE);
    expect(obj.initialMotion!.forwardSpeed).toBe(1.0); // flag absent → ACE default
    expect(obj.isAutonomous).toBe(false);
  });

  it('open door: initialMotion carries MotionCommand.On', () => {
    const blob = movementBlob(NONCOMBAT_STANCE_WIRE, ON_WIRE);
    const r = new BinaryReader(buildPayload({ name: 'Door', blob }));
    const obj = parseCreateObjectFromReader(r);
    expect(obj.initialMotion!.forwardCommand).toBe(ON_WIRE);
    expect(obj.placement).toBeUndefined();
  });

  it('framing parity: cursor lands at the same final offset as the old skip(movLen) path', () => {
    // The blob carries trailing align bytes the body parse does not consume —
    // the parser must still frame by the length prefix, or every field after
    // the physics section shifts. weenieClassId/iconId parsing correctly is
    // the observable proof, plus the final 4-aligned cursor.
    const blob = movementBlob(NONCOMBAT_STANCE_WIRE, DEAD_WIRE);
    const payload = buildPayload({ name: 'X', blob });
    const r = new BinaryReader(payload);
    const obj = parseCreateObjectFromReader(r);
    expect(obj.weenieClassId).toBe(1000);
    expect(obj.iconId).toBe(0x06000010);
    expect(r.position % 4).toBe(0);
    expect(r.position).toBeGreaterThanOrEqual(payload.length - 3);
  });

  it('AnimationFrame branch: placement uint is captured (was read-and-discarded)', () => {
    const r = new BinaryReader(buildPayload({ placement: 0x65 }));
    const obj = parseCreateObjectFromReader(r);
    expect(obj.placement).toBe(0x65);
    expect(obj.initialMotion).toBeUndefined();
    expect(obj.isAutonomous).toBeUndefined();
    expect(obj.weenieClassId).toBe(1000); // fields after the branch still parse
  });

  it('no Movement/AnimationFrame flags: all three new fields stay undefined', () => {
    const r = new BinaryReader(buildPayload({}));
    const obj = parseCreateObjectFromReader(r);
    expect(obj.initialMotion).toBeUndefined();
    expect(obj.isAutonomous).toBeUndefined();
    expect(obj.placement).toBeUndefined();
  });
});

describe('parseMovementData — shared decoder (header vs headerless forms)', () => {
  it('decodes the same body identically with and without the 6-byte 0xF74C header', () => {
    const body = movementBlob(NONCOMBAT_STANCE_WIRE, DEAD_WIRE);
    const withHeader = new Uint8Array([0, 0, 0, 0, 0, 0, ...body]);
    const a = parseMovementData(new Uint8Array(body), false);
    const b = parseMovementData(withHeader, true);
    expect(a).toEqual(b);
    expect(a!.forwardCommand).toBe(DEAD_WIRE);
  });

  it('decodes the MotionItem actions list (count at bitfield bits 7+)', () => {
    const body = [
      0x00, 0x00, ...u16(NONCOMBAT_STANCE_WIRE),
      ...u32((1 << 7) | 0x2),  // 1 action, ForwardCommand flag
      ...u16(0x05),            // ForwardCommand = WalkForward wire
      ...u16(0x42), ...u16(0x1), ...u32(0x3f800000), // action: cmd 0x42, seq, speed 1.0f
    ];
    // speed float needs proper little-endian float bytes:
    const buf = new Uint8Array(body.length);
    buf.set(body.slice(0, body.length - 4));
    new DataView(buf.buffer).setFloat32(buf.length - 4, 1.5, true);
    const parsed = parseMovementData(buf, false)!;
    expect(parsed.forwardCommand).toBe(0x05);
    expect(parsed.actions.length).toBe(1);
    expect(parsed.actions[0].command).toBe(0x42);
    expect(parsed.actions[0].speed).toBeCloseTo(1.5, 6);
  });

  it('non-Invalid movement types return outer type + style without a state section', () => {
    const body = [0x06, 0x00, ...u16(NONCOMBAT_STANCE_WIRE)]; // MoveToObject
    const parsed = parseMovementData(new Uint8Array(body), false)!;
    expect(parsed.movementType).toBe(0x06);
    expect(parsed.styleIndex).toBe(NONCOMBAT_STANCE_WIRE);
    expect(parsed.forwardCommand).toBe(0);
  });

  it('returns null on truncation', () => {
    expect(parseMovementData(new Uint8Array([0x00, 0x00]), false)).toBeNull();
    expect(parseMovementData(new Uint8Array([0, 0, 0, 0, 0, 0, 0x00, 0x00, 0x3d]), true)).toBeNull();
  });
});

/* ── Renderer application: createObject applies the initial motion ────── */

async function makeSOM() {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
  const deaths: Array<{ cmd: number; speed?: number }> = [];
  const forward: Array<{ key: number; speed: number }> = [];
  const mm = {
    queueAction: () => {},
    setForwardMotion: (key: number, speed: number) => { forward.push({ key, speed }); return true; },
    setStanceFromId: () => {},
    playDeath: (cmd: number, speed?: number) => { deaths.push({ cmd, speed }); },
    removeAllLinkAnimations: () => {},
    isPlayingAction: false,
    currentStyleId: 0,
  };
  return { som, deaths, forward, mm };
}

describe('ServerObjectManager.createObject — applies initialMotion (replaces the "Corpse of " name hack)', () => {
  it('corpse CreateObject with MotionCommand.Dead on the wire plays the death cycle (no Setup here, so no part-array cylinder)', async () => {
    const { som, deaths, mm } = await makeSOM();
    const guid = 0x60001001;
    // Pre-register the animated entity (tryInitAnimation is DAT-dependent).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(guid, { motionManager: mm } as any, false);
    const blob = movementBlob(NONCOMBAT_STANCE_WIRE, DEAD_WIRE);
    const data = parseCreateObjectFromReader(new BinaryReader(buildPayload({ guid, name: 'Corpse of Tester', blob })));
    const obj = som.createObject(data)!;
    expect(deaths.length).toBe(1);
    expect(deaths[0].cmd).toBe(DEAD_WIRE);
    expect(obj.collisionRadius).toBe(0);
    expect(obj.collisionHeight).toBe(0);
  });

  it('open-door CreateObject with MotionCommand.On drives the forward motion (name hack could never cover this)', async () => {
    const { som, forward, deaths, mm } = await makeSOM();
    const guid = 0x60001002;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(guid, { motionManager: mm } as any, false);
    const blob = movementBlob(NONCOMBAT_STANCE_WIRE, ON_WIRE);
    const data = parseCreateObjectFromReader(new BinaryReader(buildPayload({ guid, name: 'Door', blob })));
    som.createObject(data);
    expect(deaths.length).toBe(0);
    expect(forward.length).toBe(1);
    const expectedStance = (0x80000000 | NONCOMBAT_STANCE_WIRE) >>> 0;
    expect(forward[0].key).toBe(MotionManager.compositeKey(expectedStance, ON_WIRE));
  });

  it('a "Corpse of ..." name WITHOUT a Movement blob no longer triggers the death pose (hack removed — the wire decides)', async () => {
    const { som, deaths, mm } = await makeSOM();
    const guid = 0x60001003;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(guid, { motionManager: mm } as any, false);
    const data = parseCreateObjectFromReader(new BinaryReader(buildPayload({ guid, name: 'Corpse of Tester' })));
    const obj = som.createObject(data)!;
    expect(deaths.length).toBe(0);
    expect(obj.collisionRadius).toBe(0); // no Setup resolves in this harness → no part array → 0
  });
});

/* ── enter_world: a created object stands in its final cycle ─────────────
 * SWEEP1006B.world-objects.objects-created-already-state-replay. Retail
 * SmartBox::HandleCreateObject unpacks the movement, then (parentless, with
 * a cell) CPhysicsObj::enter_world @ 00516170 (:268480-268484) runs
 * CPartArray::RemoveLinkAnimations → CSequence::remove_all_link_animations
 * @ 00524ca0: every link the created state queued is dropped and the
 * sequence starts in the target cycle. A corpse appears lying (no second
 * fall), an already-open door appears open (no Off→On swing).
 */
const DOOR_ANIM = 0x03000559;
const NONCOMBAT = 0x8000003d;
const ON: number = MotionCommand.On;
const OFF: number = MotionCommand.Off;
const ON_KEY = MotionManager.compositeKey(NONCOMBAT, ON);
const OFF_KEY = MotionManager.compositeKey(NONCOMBAT, OFF);

/** Motion table 0x09000016 (every door) in miniature: On holds frame 31, Off frame 0, the Off→On link swings 0..31. */
function doorTable(): MotionTable {
  const md = (lowFrame: number, framerate: number): MotionData =>
    ({ numAnims: 1, bitfield: 0, flags: 0, anims: [{ animId: DOOR_ANIM, lowFrame, highFrame: -1, framerate }] }) as unknown as MotionData;
  return {
    defaultStyle: NONCOMBAT,
    styleDefaults: new Map<number, number>([[NONCOMBAT, OFF]]),
    cycles: new Map([[ON_KEY, md(31, 0)], [OFF_KEY, md(0, 0)]]),
    modifiers: new Map(),
    links: new Map<number, Map<number, MotionData>>([[OFF_KEY, new Map([[ON, md(0, 30)]])], [ON_KEY, new Map([[OFF, md(0, -30)]])]]),
  } as unknown as MotionTable;
}
function doorAnim(): Animation {
  const partFrames = Array.from({ length: 32 }, (_, i) => ({
    frames: [{ origin: { x: i, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }], hooks: [],
  }));
  return { id: DOOR_ANIM, flags: 0, numParts: 1, numFrames: 32, posFrames: [], partFrames } as unknown as Animation;
}

async function realEntity(portalDb: unknown, guid: number, setup: (e: AnimatedEntity) => void) {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
  const group = new THREE.Group();
  const part = new THREE.Object3D(); part.name = 'part_0'; group.add(part);
  const entity = new AnimatedEntity(group, portalDb as never);
  setup(entity);
  som.registerAnimatedEntity(guid, entity);
  return { som, entity, part };
}

describe('SWEEP1006B objects-created-already-state-replay — CreateObject enters the world in its final cycle', () => {
  it('an already-open door is created open: no Off→On swing, the On cycle holds frame 31 from the first frame', async () => {
    const guid = 0x7a9b5001;
    const { som, entity } = await realEntity({ getFileData: () => null }, guid, (e) => {
      e.motionManager.setMotionTable(doorTable());
      (e.motionManager as unknown as { animationCache: Map<number, Animation> }).animationCache.set(DOOR_ANIM, doorAnim());
      e.motionManager.setDefaultStance();
    });
    som.createObject(parseCreateObjectFromReader(new BinaryReader(buildPayload({ guid, name: 'Door', blob: movementBlob(NONCOMBAT_STANCE_WIRE, ON_WIRE) }))));
    const mm = entity.motionManager;
    expect(mm.stance).toBe(ON_KEY);
    expect(mm.isPlayingAction).toBe(false);
    for (let i = 0; i < 3; i++) som.updateAnimations(1 / 60);
    expect(mm.animationPlayer.currentFrameIndex).toBe(31);
  });

  it('a live On MovementEvent on the same door still plays the swing (only enter_world drops links)', async () => {
    const guid = 0x7a9b5002;
    const { som, entity } = await realEntity({ getFileData: () => null }, guid, (e) => {
      e.motionManager.setMotionTable(doorTable());
      (e.motionManager as unknown as { animationCache: Map<number, Animation> }).animationCache.set(DOOR_ANIM, doorAnim());
      e.motionManager.setDefaultStance();
    });
    som.createObject(parseCreateObjectFromReader(new BinaryReader(buildPayload({ guid, name: 'Door', blob: movementBlob(NONCOMBAT_STANCE_WIRE, MotionCommand.Off & 0xffff) }))));
    expect(entity.motionManager.stance).toBe(OFF_KEY);
    const ev = new Uint8Array([0, 0, 0, 0, 0, 0, ...movementBlob(NONCOMBAT_STANCE_WIRE, ON_WIRE)]);
    som.handleMovementEvent({ guid, movementData: ev } as never);
    expect(entity.motionManager.isPlayingAction).toBe(true);
  });

  const hasDat = fs.existsSync('dat/client_portal.dat');
  describe.skipIf(!hasDat)('DAT: human motion table 0x09000001 corpse', () => {
    let db: unknown;
    beforeAll(() => { db = openDat('dat/client_portal.dat'); });

    it('a corpse CreateObject (NonCombat + Dead) lies dead at once: no fall link, no Knockdown3, the Dead cycle plays', async () => {
      const guid = 0x7a9b5003;
      const { som, entity } = await realEntity(db, guid, (e) => { expect(e.initFromMotionTable(0x09000001)).toBe(true); });
      const hooks: Array<{ hookType: number; soundType?: number }> = [];
      entity.motionManager.onHook((h) => { hooks.push(h as never); });
      som.createObject(parseCreateObjectFromReader(new BinaryReader(buildPayload({ guid, name: 'Corpse of Tester', blob: movementBlob(NONCOMBAT_STANCE_WIRE, DEAD_WIRE) }))));
      const mm = entity.motionManager;
      expect(mm.isDead).toBe(true);
      expect(mm.isPlayingAction).toBe(false);
      const deadCycle = mm.activeMotionTable!.cycles.get(MotionManager.compositeKey(NONCOMBAT, MotionCommand.Dead))!;
      expect(mm.animationPlayer.currentAnimation?.id ?? deadCycle.anims[0].animId).toBe(deadCycle.anims[0].animId);
      for (let i = 0; i < 120; i++) som.updateAnimations(1 / 30);
      expect(hooks.filter((h) => h.hookType === AnimationHookType.SoundTable && h.soundType === Sound.Knockdown3).length).toBe(0);
      expect(mm.isPlayingAction).toBe(false);
    });

    it('the same Dead as a live MotionManager.playDeath still plays the fall (the link is real)', () => {
      const mm = new MotionManager(db as never);
      mm.loadMotionTable(0x09000001);
      mm.setStanceFromId(MotionStance.NonCombat);
      mm.playDeath(DEAD_WIRE);
      expect(mm.isPlayingAction).toBe(true);
      mm.removeAllLinkAnimations();
      expect(mm.isPlayingAction).toBe(false);
      expect(mm.isDead).toBe(true);
    });
  });
});
