/**
 * BUG.spellcast-animations — "spellcasting animations seem wrong" (human mage,
 * magic stance, live ACE).
 *
 * What ACE sends for a (non-PK, non-FastTick) cast, to everyone INCLUDING the
 * caster, each a non-autonomous MovementEvent in the Magic style
 * (Player_Magic.cs DoWindupGestures / DoCastGesture → EnqueueMotionMagic,
 * WorldObject_Networking.cs:1078; FinishCast :978):
 *   1. one ForwardCommand per windup gesture — MagicPowerUp01–10
 *      (0x1000006f–78, ACTION class) at CastSpeed 2.0;
 *   2. the talisman's cast gesture — MagicBlast…MagicPray (0x4000002b–39,
 *      SUBSTATE class) at 2.0;
 *   3. Ready (0x41000003) at 1.0 once the spell resolves.
 * The human motion table 0x09000001 in Magic (0x49):
 *   link Ready→MagicPowerUp10 = 0x030005a0 0..75 @24 THEN 0x030005a0 @−57
 *     (raise the hands, then lower them — two AnimData);
 *   link Ready→MagicThrowMissile (0x32) = 0x0300059d 0..21 @24;
 *   cycle 0x490032 = 0x0300059d 21..−1 @0 (hold the hands out);
 *   link 0x490032→Ready = 0x0300059d 21..−1 @30 (the release / throw).
 * Retail CMotionTable::GetObjectSequence (@ 00522860; ACE MotionTable.cs):
 * an Action plays link(substate→action) and returns to the substate cycle; a
 * SubState plays link(current→it) then its cycle and becomes the substate;
 * every AnimData of a link is appended (add_motion); a substate change only
 * drops the sequence's cyclic tail, so playing links finish first.
 *
 * What was wrong:
 *  - MotionManager played only anims[0] of a MotionData: the windup raised
 *    the hands and snapped back (the lowering node never played);
 *  - the local player's cast gesture was a one-shot action (link only) and
 *    the server's Ready was dropped as "controller-owned": hands out, snap
 *    back to Ready, the release never showed;
 *  - a remote caster's windup (an Action) was made the substate: the pose
 *    froze on its last frame and the gesture then snapped in with no link.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import type { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import type { MotionTable, MotionData } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import {
  motionCommandFromWireIndex, isActionCommand, isSubstateCommand, MotionCommand,
} from '../packages/renderer/src/animation/MotionCommands.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);

const MAGIC = 0x80000049;
const READY = 0x41000003;
const WINDUP = 0x10000078;   // MagicPowerUp10
const GESTURE = 0x40000032;  // MagicThrowMissile
const RUN = 0x44000007;
const READY_KEY = MotionManager.compositeKey(MAGIC, READY);     // 0x490003
const GESTURE_KEY = MotionManager.compositeKey(MAGIC, GESTURE); // 0x490032
const RUN_KEY = MotionManager.compositeKey(MAGIC, RUN);         // 0x490007

const READY_ANIM = 0x03000a01;
const WINDUP_ANIM = 0x03000a02;
const GESTURE_ANIM = 0x03000a03;
const RUN_ANIM = 0x03000a04;
const ME = 0x50000001;
const OTHER = 0x50000002;

describe('motionCommandFromWireIndex — the class bits behind a 16-bit command index', () => {
  it('recovers the full command, and with it Action vs SubState', () => {
    expect(motionCommandFromWireIndex(0x78)).toBe(WINDUP);
    expect(motionCommandFromWireIndex(0x6f)).toBe(MotionCommand.MagicPowerUp01);
    expect(motionCommandFromWireIndex(0x32)).toBe(GESTURE);
    expect(motionCommandFromWireIndex(0x03)).toBe(READY);
    expect(isActionCommand(WINDUP)).toBe(true);
    expect(isSubstateCommand(WINDUP)).toBe(false);
    expect(isActionCommand(GESTURE)).toBe(false);
    expect(isSubstateCommand(GESTURE)).toBe(true);
    for (let i = 0x2b; i <= 0x39; i++) expect(isSubstateCommand(motionCommandFromWireIndex(i)!)).toBe(true);
    for (let i = 0x6f; i <= 0x78; i++) expect(isActionCommand(motionCommandFromWireIndex(i)!)).toBe(true);
    expect(motionCommandFromWireIndex(0xfffe)).toBeUndefined();
  });
});

/** An animation whose part 0 sits at x = base + frame index. */
function anim(id: number, frames: number, base: number): Animation {
  const partFrames = Array.from({ length: frames }, (_, i) => ({
    frames: [{ origin: { x: base + i, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }],
    hooks: [],
  }));
  return { id, flags: 0, numParts: 1, numFrames: frames, posFrames: [], partFrames } as unknown as Animation;
}

/** The human 0x09000001 Magic entries above, with synthetic animations. */
function magicTable(): MotionTable {
  const md = (...anims: [number, number, number, number][]): MotionData => ({
    numAnims: anims.length, bitfield: 0, flags: 0,
    anims: anims.map(([animId, lowFrame, highFrame, framerate]) => ({ animId, lowFrame, highFrame, framerate })),
  }) as unknown as MotionData;
  return {
    defaultStyle: 0x8000003d,
    styleDefaults: new Map([[MAGIC, READY]]),
    cycles: new Map([
      [READY_KEY, md([READY_ANIM, 0, -1, 30])],
      [GESTURE_KEY, md([GESTURE_ANIM, 21, -1, 0])],
      [RUN_KEY, md([RUN_ANIM, 0, -1, 30])],
    ]),
    modifiers: new Map(),
    links: new Map([
      [READY_KEY, new Map([
        [WINDUP, md([WINDUP_ANIM, 0, 75, 24], [WINDUP_ANIM, 0, 75, -57])],
        [GESTURE, md([GESTURE_ANIM, 0, 21, 24])],
      ])],
      [GESTURE_KEY, new Map([[READY, md([GESTURE_ANIM, 21, -1, 30])]])],
    ]),
  } as unknown as MotionTable;
}

/** 0xF74C body: header (autonomous byte), type 0, style, CurrentStyle + ForwardCommand + ForwardSpeed. */
function castEvent(guid: number, forward: number, speed: number): { guid: number; movementData: Uint8Array } {
  const buf = new Uint8Array(6 + 4 + 4 + 2 + 2 + 4);
  const v = new DataView(buf.buffer);
  v.setUint8(4, 0);                         // non-autonomous
  v.setUint8(6, 0);                         // movement_type Invalid (InterpretedMotionState)
  v.setUint16(8, MAGIC & 0xffff, true);
  v.setUint32(10, 0x1 | 0x2 | 0x4, true);   // CurrentStyle | ForwardCommand | ForwardSpeed
  v.setUint16(14, MAGIC & 0xffff, true);
  v.setUint16(16, forward & 0xffff, true);
  v.setFloat32(18, speed, true);
  return { guid, movementData: buf };
}

async function makeCaster(local: boolean) {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
  const group = new THREE.Group();
  const p = new THREE.Object3D(); p.name = 'part_0'; group.add(p);
  const ent = new AnimatedEntity(group, { getFileData: () => null } as never);
  const mm = ent.motionManager;
  mm.setMotionTable(magicTable());
  const cache = (mm as unknown as { animationCache: Map<number, Animation> }).animationCache;
  cache.set(READY_ANIM, anim(READY_ANIM, 30, 1000));
  cache.set(WINDUP_ANIM, anim(WINDUP_ANIM, 60, 2000));
  cache.set(GESTURE_ANIM, anim(GESTURE_ANIM, 53, 3000));
  cache.set(RUN_ANIM, anim(RUN_ANIM, 24, 4000));
  expect(mm.setStanceFromId(MAGIC)).toBe(true);
  const guid = local ? ME : OTHER;
  som.registerAnimatedEntity(guid, ent, local);
  const x = () => group.getObjectByName('part_0')!.position.x;
  const trace: number[] = [];
  const tick = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { som.updateAnimations(1 / 60); trace.push(x()); }
  };
  const send = (forward: number, speed: number) => som.handleMovementEvent(castEvent(guid, forward, speed) as never);
  return { som, mm, x, tick, trace, send };
}

/** The x values of the trace inside [lo, hi). */
const band = (trace: number[], lo: number, hi: number) => trace.filter((v) => v >= lo && v < hi);

for (const local of [true, false]) {
  describe(`cast choreography on ${local ? 'OUR character' : 'another player'} (synthetic human Magic table)`, () => {
    it('the windup (an Action) plays BOTH link nodes — raise then lower — and returns to the Ready cycle', async () => {
      const { mm, tick, trace, send, x } = await makeCaster(local);
      tick(0.2);
      send(0x78, 2.0);
      tick(2.2);
      const w = band(trace, 2000, 3000);
      const peak = w.indexOf(2059);
      expect(peak).toBeGreaterThan(0);               // raised to the (clamped) last frame
      const lowering = w.slice(peak);
      expect(lowering.length).toBeGreaterThan(5);     // …then the reverse node brings the hands down
      expect(lowering.every((v, i) => i === 0 || v <= lowering[i - 1])).toBe(true);
      expect(Math.min(...lowering)).toBeLessThan(2005);
      expect(x()).toBeGreaterThanOrEqual(1000);       // back on the Ready cycle, not frozen
      expect(x()).toBeLessThan(2000);
      expect(mm.stance).toBe(READY_KEY);              // an Action never becomes the substate
      expect(mm.isPlayingAction).toBe(false);
    });

    it('the cast gesture (a SubState) holds its frame until Ready, which plays the release link', async () => {
      const { mm, tick, trace, send, x } = await makeCaster(local);
      tick(0.2);
      send(0x32, 2.0);
      tick(1.0);
      expect(x()).toBe(3021);                         // link 0..21 done, hold cycle at frame 21
      expect(mm.stance).toBe(GESTURE_KEY);
      tick(3.0);
      expect(x()).toBe(3021);                         // held until the server's Ready
      trace.length = 0;
      send(0x03, 1.0);
      tick(0.5);
      expect(x()).toBeGreaterThan(3021);              // the release (frames 21→52 at 30 fps)
      expect(x()).toBeLessThan(3052);
      tick(1.0);
      expect(band(trace, 3021, 3053)).toContain(3052);
      expect(x()).toBeGreaterThanOrEqual(1000);
      expect(x()).toBeLessThan(2000);                 // then the Ready cycle
      expect(mm.stance).toBe(READY_KEY);
    });

    it('a gesture sent while the windup still plays waits for it (the playing links finish first)', async () => {
      const { tick, trace, send, x } = await makeCaster(local);
      tick(0.2);
      send(0x78, 2.0);
      tick(0.5);                                      // mid-raise
      send(0x32, 2.0);
      tick(3.0);
      const firstGesture = trace.findIndex((v) => v >= 3000);
      const windup = trace.slice(0, firstGesture).filter((v) => v >= 2000);
      expect(windup).toContain(2059);                 // the raise completed…
      expect(windup[windup.length - 1]).toBeLessThan(2005); // …and the lowering too, before the gesture
      expect(x()).toBe(3021);
    });
  });
}

describe('our character: the controller\'s own motion ends a held gesture', () => {
  it('moving during the hold makes run the substate, so the later server Ready is the controller\'s', async () => {
    const { mm, tick, send, x } = await makeCaster(true);
    send(0x32, 2.0);
    tick(1.0);
    expect(x()).toBe(3021);
    mm.requestMotion(RUN_KEY, 1.0);                   // CharacterAnimController starts the run cycle
    expect(mm.targetSubstate).toBe(RUN_KEY);
    tick(0.1);
    send(0x03, 1.0);
    tick(0.2);
    expect(x()).toBeGreaterThanOrEqual(4000);         // still running — no release link replayed
  });
});

describe.skipIf(!hasDat)('the real human motion table 0x09000001 — our character casting Flame Bolt-style', () => {
  let portalDb: { getFileData(id: number): ArrayBuffer | null };
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const buf = fs.readFileSync(PORTAL);
    portalDb = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) as never;
  });

  it('plays windup raise + lower, gesture link, hold, release, Ready — each node the DAT lists', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
    const group = new THREE.Group();
    for (let i = 0; i < 34; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; group.add(p); }
    const ent = new AnimatedEntity(group, portalDb as never);
    expect(ent.initFromMotionTable(0x09000001)).toBe(true);
    const mm = ent.motionManager;
    expect(mm.setStanceFromId(MAGIC)).toBe(true);
    som.registerAnimatedEntity(ME, ent, true);
    const plays: string[] = [];
    const player = mm.animationPlayer;
    const orig = player.play.bind(player);
    player.play = (a, low, high, rate, speed, looping, cb) => {
      plays.push(`${a.id.toString(16)} ${low}..${high} x${((rate ?? 30) * (speed ?? 1)).toFixed(0)}`);
      return orig(a, low, high, rate, speed, looping, cb);
    };
    const tick = (s: number) => { for (let t = 0; t < s - 1e-9; t += 1 / 60) som.updateAnimations(1 / 60); };
    som.handleMovementEvent(castEvent(ME, 0x78, 2.0) as never);
    tick(2.0);
    som.handleMovementEvent(castEvent(ME, 0x32, 2.0) as never);
    tick(1.5);
    som.handleMovementEvent(castEvent(ME, 0x03, 1.0) as never);
    tick(2.0);
    expect(plays).toEqual([
      '30005a0 0..59 x48',    // raise (high 75 clamps to the 60-frame anim)
      '30005a0 0..59 x-114',  // lower
      '300076c 0..29 x30',    // Ready cycle
      '300059d 0..21 x48',    // Ready → MagicThrowMissile
      '300059d 21..52 x0',    // hold
      '300059d 21..52 x30',   // release
      '300076c 0..29 x30',    // Ready cycle
    ]);
    expect(mm.stance).toBe(READY_KEY);
  });
});
