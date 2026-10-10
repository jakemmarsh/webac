/**
 * BUG.spellcast-animations follow-up — "the spellcasting animation looks
 * right, but is the DURATION right?" (human mage, Magic stance, live ACE).
 *
 * Retail playback of one node (CSequence::update_internal; ACE
 * AnimSequenceNode.get_starting_frame / get_ending_frame): frames
 * low..high INCLUSIVE — high 1 frames past low at |framerate × speed| —
 * with high −1 / past the end clamped to numFrames − 1
 * (set_animation_id). The speed multiplies every AnimData's framerate
 * (Sequence.multiply_framerate); a negative framerate plays backwards.
 *
 * What ACE sends a non-PK caster (Player_Magic.cs DoWindupGestures :605 →
 * EnqueueMotionMagic, WorldObject_Networking.cs:1078; DoCastGesture :648;
 * FinishCast :978), each step then an ActionChain delay of
 * MotionTable.GetAnimationLength(Magic, cmd) / CastSpeed 2.0 — per AnimData
 * (high − low) / |framerate| (ACE FileTypes/MotionTable.cs:162, high −1 or
 * past the end → numFrames), i.e. ONE FRAME SHORTER than retail playback
 * whenever the DAT gives an explicit high frame:
 *   windup (Pyreal Scarab 0x10000078):  ACE waits 60/24/2 + 60/57/2 = 1.776 s
 *   talisman gesture link:              ACE waits (high − low)/24/2
 *   Ready @1.0, sent right after.
 * Human table 0x09000001, Magic:
 *   Ready→0x78 = 0x030005a0 0..75 @24 (clamped to 0..59) + 0..75 @−57
 *     → retail 60/48 = 1.2500 s raise + 60/114 = 0.5263 s lower;
 *   Heal Self VI  (Willow 0x4000002d):  link 0x0300059f 0..15 @24 → 16/48 = 0.3333 s
 *     (ACE waits 0.3125 s), hold 15 @0, release 15..49 @30 → 35/30 = 1.1667 s;
 *   Flame Bolt VI (Birch 0x40000033):   link 0x0300059c 0..25 @24 → 26/48 = 0.5417 s
 *     (ACE waits 0.5208 s), release 25..54 @30 → 30/30 = 1.0000 s.
 * So ACE's Ready reaches the client ~21 ms BEFORE the gesture link ends:
 * GetObjectSequence only drops the cyclic tail (remove_cyclic_anims), so
 * the release is appended AFTER the link — it must not cut the link short,
 * and nothing may drift (every node its exact length, overshoot carried).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);
const MAGIC = 0x80000049;
const ME = 0x50000001;

/** 0xF74C body: header (autonomous byte), type 0, style, CurrentStyle + ForwardCommand + ForwardSpeed. */
function castEvent(guid: number, forward: number, speed: number): { guid: number; movementData: Uint8Array } {
  const buf = new Uint8Array(6 + 4 + 4 + 2 + 2 + 4);
  const v = new DataView(buf.buffer);
  v.setUint8(4, 0);
  v.setUint8(6, 0);
  v.setUint16(8, MAGIC & 0xffff, true);
  v.setUint32(10, 0x1 | 0x2 | 0x4, true);
  v.setUint16(14, MAGIC & 0xffff, true);
  v.setUint16(16, forward & 0xffff, true);
  v.setFloat32(18, speed, true);
  return { guid, movementData: buf };
}

/** ACE GetAnimationLength(AnimData) summed over a MotionData, / speed (the server's ActionChain delay). */
function aceLength(mm: { loadAnimation(id: number): { numFrames: number } | null }, anims: { animId: number; lowFrame: number; highFrame: number; framerate: number }[], speed: number): number {
  let len = 0;
  for (const a of anims) {
    const n = mm.loadAnimation(a.animId)!.numFrames;
    let hi = a.highFrame === -1 ? n : a.highFrame;
    if (hi > n) hi = n;
    len += (hi - a.lowFrame) / Math.abs(a.framerate);
  }
  return len / speed;
}

describe.skipIf(!hasDat)('cast timing on the real human motion table 0x09000001 at ACE\'s schedule', () => {
  let portalDb: { getFileData(id: number): ArrayBuffer | null };
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const buf = fs.readFileSync(PORTAL);
    portalDb = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) as never;
  });

  /**
   * Drives one cast: windup 0x78 @2 at t = 0, the gesture @2 after ACE's
   * windup delay, Ready @1 after ACE's gesture delay — ticking the real
   * ServerObjectManager in 1 ms steps. Returns each node put on the player
   * with its start time (ms) and ACE's send times.
   */
  async function runCast(gesture: number) {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
    const group = new THREE.Group();
    for (let i = 0; i < 34; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; group.add(p); }
    const ent = new AnimatedEntity(group, portalDb as never);
    expect(ent.initFromMotionTable(0x09000001)).toBe(true);
    const mm = ent.motionManager;
    expect(mm.setStanceFromId(MAGIC)).toBe(true);
    som.registerAnimatedEntity(ME, ent, true);

    const table = (mm as unknown as { motionTable: { links: Map<number, Map<number, { anims: never[] }>> } }).motionTable;
    const link = (from: number, to: number) => [...table.links.get(0x490000 | from)!].find(([k]) => (k & 0xffff) === to)![1].anims;
    const windupWait = aceLength(mm, link(0x03, 0x78), 2.0);
    const gestureWait = aceLength(mm, link(0x03, gesture), 2.0);

    let clock = 0; // ms
    const plays: { t: number; node: string }[] = [];
    const player = mm.animationPlayer;
    const orig = player.play.bind(player);
    player.play = (a, low, high, rate, speed, looping, cb) => {
      plays.push({ t: clock, node: `${a.id.toString(16)} ${low}..${high} x${((rate ?? 30) * (speed ?? 1)).toFixed(0)}` });
      return orig(a, low, high, rate, speed, looping, cb);
    };
    const runUntil = (ms: number) => { while (clock < ms - 1e-9) { clock += 1; som.updateAnimations(0.001); } };
    const sends = { windup: 0, gesture: windupWait * 1000, ready: (windupWait + gestureWait) * 1000 };
    som.handleMovementEvent(castEvent(ME, 0x78, 2.0) as never);
    runUntil(sends.gesture);
    som.handleMovementEvent(castEvent(ME, gesture, 2.0) as never);
    runUntil(sends.ready);
    som.handleMovementEvent(castEvent(ME, 0x03, 1.0) as never);
    runUntil(sends.ready + 2000);
    return { plays, sends, windupWait, gestureWait };
  }

  it('ACE\'s delays: windup 1.776 s, gesture link one frame shorter than its retail playback', async () => {
    const heal = await runCast(0x2d);
    expect(heal.windupWait).toBeCloseTo(60 / 48 + 60 / 114, 4);
    expect(heal.gestureWait).toBeCloseTo(15 / 48, 4);
    const bolt = await runCast(0x33);
    expect(bolt.gestureWait).toBeCloseTo(25 / 48, 4);
  });

  for (const [name, gesture, anim, linkFrames, hold, releaseEnd] of [
    ['Heal Self VI (Willow, MagicSelfHeart 0x2d)', 0x2d, '300059f', 16, 15, 49],
    ['Flame Bolt VI (Birch, MagicRecoilMissile 0x33)', 0x33, '300059c', 26, 25, 54],
  ] as const) {
    it(`${name}: every node plays its full retail length, the Ready waits for the link, no drift`, async () => {
      const { plays, sends } = await runCast(gesture);
      const at = (node: string, from = 0) => {
        const p = plays.find((x, i) => i >= from && x.node === node);
        expect(p, `${node} never played: ${JSON.stringify(plays)}`).toBeDefined();
        return p!.t;
      };
      const raise = at('30005a0 0..59 x48');
      const lower = at('30005a0 0..59 x-114');
      const idle = at('300076c 0..29 x30');
      const gLink = at(`${anim} 0..${hold} x48`);
      const release = at(`${anim} ${hold}..${releaseEnd} x30`);
      const back = plays.findIndex((x) => x.t > release && x.node === '300076c 0..29 x30');
      expect(back).toBeGreaterThan(0);
      const end = plays[back].t;

      expect(raise).toBe(0);
      expect(lower - raise).toBeCloseTo(1250, -0.5);                   // 60 frames / (24 × 2)
      expect(idle - lower).toBeCloseTo(526.3, -0.5);                   // 60 frames / (57 × 2), backwards
      expect(gLink).toBeCloseTo(sends.gesture, -0.5);                   // starts when the server's gesture arrives
      // The server's Ready arrives one link frame early — the release is
      // appended after the link, which plays all its frames.
      expect(sends.ready).toBeLessThan(gLink + (linkFrames / 48) * 1000);
      expect(release - gLink).toBeCloseTo((linkFrames / 48) * 1000, -0.5);
      // No hold frame between link and release when the Ready arrived first.
      expect(plays.some((x) => x.node === `${anim} ${hold}..${releaseEnd} x0`)).toBe(false);
      expect(end - release).toBeCloseTo(((releaseEnd - hold + 1) / 30) * 1000, -0.5);
      // Whole cast on screen: ACE's windup delay + the full link + the release.
      expect(end).toBeCloseTo(sends.gesture + (linkFrames / 48) * 1000 + ((releaseEnd - hold + 1) / 30) * 1000, -0.5);
    });
  }
});
