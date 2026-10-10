/**
 * BUG.holdframe-cycle-renders-frame-zero — a door's open / close chain,
 * driven end to end: 0xF74C MovementEvent bytes → ServerObjectManager →
 * MotionManager → AnimationPlayer → AnimatedEntity part meshes.
 *
 * Motion table 0x09000016 (every door): style NonCombat, style default Off;
 *   cycle On  (0x3d000b) = anim 0x03000559 low 31, high −1, rate 0 (hold open)
 *   cycle Off (0x3d000c) = anim 0x03000559 low 0,  high −1, rate 0 (hold shut)
 *   link Off→On = 0x03000559 0..31 at +30, link On→Off = 0x03000559 at −30.
 *
 * The chain bug: every MovementEvent re-entered the style's default cycle
 * (setStanceFromId → Off) before the substate transition, so the close
 * event found no Off→Off link and snapped the door shut, and a re-sent On
 * replayed the whole opening swing. Retail treats a style command equal to
 * the current style as a no-op and links from the CURRENT substate
 * (CMotionTable::GetObjectSequence @ 00522860 `if (state->style == motion)
 * return 1;`, get_link(style, state->substate, …); ACE MotionTable.cs:78,144);
 * a same-substate request only re-speeds the cycle (MotionTable.cs:132).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import type { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import type { MotionTable, MotionData } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);

const NONCOMBAT = 0x8000003d;
const ON = 0x4000000b;
const OFF = 0x4000000c;
const ON_KEY = MotionManager.compositeKey(NONCOMBAT, ON);   // 0x3d000b
const OFF_KEY = MotionManager.compositeKey(NONCOMBAT, OFF); // 0x3d000c
const DOOR_ANIM = 0x03000559;
const GUID = 0x7a9b4001;

/** 0xF74C body: 6-byte header, movement_type Invalid, outer style, then CurrentStyle + ForwardCommand (ACE InterpretedMotionState.Write). */
function doorEvent(forward: number): { guid: number; movementData: Uint8Array } {
  const buf = new Uint8Array(6 + 4 + 4 + 4);
  const v = new DataView(buf.buffer);
  v.setUint8(6, 0);                        // movement_type Invalid
  v.setUint16(8, NONCOMBAT & 0xffff, true); // outer style
  v.setUint32(10, 0x1 | 0x2, true);         // CurrentStyle | ForwardCommand
  v.setUint16(14, NONCOMBAT & 0xffff, true);
  v.setUint16(16, forward & 0xffff, true);
  return { guid: GUID, movementData: buf };
}

/** A 32-frame door swing whose part 0 sits at x = frame index. */
function syntheticDoorAnim(): Animation {
  const partFrames = Array.from({ length: 32 }, (_, i) => ({
    frames: [{ origin: { x: i, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }],
    hooks: [],
  }));
  return { id: DOOR_ANIM, flags: 0, numParts: 1, numFrames: 32, posFrames: [], partFrames } as unknown as Animation;
}

function syntheticDoorTable(): MotionTable {
  const md = (lowFrame: number, framerate: number): MotionData =>
    ({ numAnims: 1, bitfield: 0, flags: 0, anims: [{ animId: DOOR_ANIM, lowFrame, highFrame: -1, framerate }] }) as unknown as MotionData;
  return {
    defaultStyle: NONCOMBAT,
    styleDefaults: new Map([[NONCOMBAT, OFF]]),
    cycles: new Map([[ON_KEY, md(31, 0)], [OFF_KEY, md(0, 0)]]),
    modifiers: new Map(),
    links: new Map([
      [OFF_KEY, new Map([[ON, md(0, 30)]])],
      [ON_KEY, new Map([[OFF, md(0, -30)]])],
    ]),
  } as unknown as MotionTable;
}

/** A door group (part_0..part_N) wrapped in the real AnimatedEntity, registered with a real ServerObjectManager. */
async function makeDoor(portalDb: unknown, parts: number, table?: MotionTable, anim?: Animation) {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
  const group = new THREE.Group();
  for (let i = 0; i < parts; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; group.add(p); }
  const door = new AnimatedEntity(group, portalDb as never);
  if (table) {
    door.motionManager.setMotionTable(table);
    (door.motionManager as unknown as { animationCache: Map<number, Animation> }).animationCache.set(DOOR_ANIM, anim!);
    expect(door.motionManager.setDefaultStance()).toBe(true);
  } else {
    expect(door.initFromMotionTable(0x09000016)).toBe(true);
  }
  som.registerAnimatedEntity(GUID, door);
  const tick = (seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) som.updateAnimations(1 / 60); };
  return { som, group, door, tick };
}

describe('BUG.holdframe-cycle-renders-frame-zero — door open/close chain (synthetic 0x09000016)', () => {
  const x = (g: THREE.Group) => g.getObjectByName('part_0')!.position.x;

  it('On: the Off→On link swings 0→31, then the On hold cycle keeps frame 31', async () => {
    const { som, group, door, tick } = await makeDoor({ getFileData: () => null }, 1, syntheticDoorTable(), syntheticDoorAnim());
    tick(0.1);
    expect(x(group)).toBe(0); // closed: Off holds frame 0
    som.handleMovementEvent(doorEvent(ON) as never);
    tick(0.5);
    expect(x(group)).toBeGreaterThan(5);
    expect(x(group)).toBeLessThan(31);
    tick(1.0);
    expect(door.motionManager.stance).toBe(ON_KEY);
    expect(door.motionManager.animationPlayer.currentFrameIndex).toBe(31);
    expect(x(group)).toBe(31);
    tick(5);
    expect(x(group)).toBe(31); // held, rate 0
  });

  it('Off after On: the On→Off link plays in reverse (31→0) instead of snapping shut, then Off holds frame 0', async () => {
    const { som, group, door, tick } = await makeDoor({ getFileData: () => null }, 1, syntheticDoorTable(), syntheticDoorAnim());
    som.handleMovementEvent(doorEvent(ON) as never);
    tick(2);
    expect(x(group)).toBe(31);
    som.handleMovementEvent(doorEvent(OFF) as never);
    expect(door.motionManager.isPlayingAction).toBe(true);
    tick(1 / 60);
    expect(x(group)).toBe(31); // reverse node starts at high + 1 − F_EPSILON
    tick(0.5);
    expect(x(group)).toBeGreaterThan(0);
    expect(x(group)).toBeLessThan(31);
    tick(1.0);
    expect(door.motionManager.stance).toBe(OFF_KEY);
    expect(x(group)).toBe(0);
    tick(5);
    expect(x(group)).toBe(0);
  });

  it('a re-sent On while open (same style, same substate) keeps the open pose — no replayed swing', async () => {
    const { som, group, door, tick } = await makeDoor({ getFileData: () => null }, 1, syntheticDoorTable(), syntheticDoorAnim());
    som.handleMovementEvent(doorEvent(ON) as never);
    tick(2);
    som.handleMovementEvent(doorEvent(ON) as never);
    expect(door.motionManager.isPlayingAction).toBe(false);
    tick(1 / 60);
    expect(x(group)).toBe(31);
    tick(0.5);
    expect(x(group)).toBe(31);
  });
});

describe.skipIf(!hasDat)('BUG.holdframe-cycle-renders-frame-zero — the real 0x09000016 / 0x03000559', () => {
  let portalDb: { getFileData(id: number): ArrayBuffer | null };
  let anim: Animation;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Animation: AnimationFile } = await import('../packages/dat-parser/src/file-types/Animation.js');
    portalDb = openDat(PORTAL) as never;
    anim = new AnimationFile(new DatReader(portalDb.getFileData(DOOR_ANIM)!));
  });

  /** part_i's quaternion vs the animation's frame f (AnimatedEntity's Z-up → Y-up swap). */
  const posedAt = (group: THREE.Group, f: number): boolean => anim.partFrames[f].frames.every((fr, i) => {
    const q = group.getObjectByName(`part_${i}`)!.quaternion;
    return Math.abs(q.w - fr.orientation.w) < 1e-6 && Math.abs(q.x + fr.orientation.x) < 1e-6
      && Math.abs(q.y + fr.orientation.z) < 1e-6 && Math.abs(q.z + fr.orientation.y) < 1e-6;
  });

  it('the table is what the chain assumes: On holds low 31 at rate 0, Off holds 0; the links run ±30', async () => {
    const mm = new MotionManager(portalDb as never);
    const mt = mm.loadMotionTable(0x09000016)!;
    expect(mt.styleDefaults.get(NONCOMBAT)).toBe(OFF);
    expect(mt.cycles.get(ON_KEY)!.anims[0]).toMatchObject({ animId: DOOR_ANIM, lowFrame: 31, highFrame: -1, framerate: 0 });
    expect(mt.cycles.get(OFF_KEY)!.anims[0]).toMatchObject({ animId: DOOR_ANIM, lowFrame: 0, framerate: 0 });
    expect(mt.links.get(OFF_KEY)!.get(ON)!.anims[0].framerate).toBe(30);
    expect(mt.links.get(ON_KEY)!.get(OFF)!.anims[0].framerate).toBe(-30);
    expect(anim.numFrames).toBe(32);
    // the open and shut poses really differ (frame 31 vs frame 0)
    expect(Math.abs(anim.partFrames[31].frames[1].orientation.w - anim.partFrames[0].frames[1].orientation.w)).toBeGreaterThan(0.2);
  });

  it('open settles on frame 31, close swings back and settles on frame 0', async () => {
    const { som, group, tick } = await makeDoor(portalDb, anim.numParts);
    tick(0.1);
    expect(posedAt(group, 0)).toBe(true);
    som.handleMovementEvent(doorEvent(ON) as never);
    tick(2);
    expect(posedAt(group, 31)).toBe(true);
    som.handleMovementEvent(doorEvent(OFF) as never);
    tick(0.5);
    expect(posedAt(group, 31)).toBe(false);
    expect(posedAt(group, 0)).toBe(false);
    tick(1.5);
    expect(posedAt(group, 0)).toBe(true);
  });
});
