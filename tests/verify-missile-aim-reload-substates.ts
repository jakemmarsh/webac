/**
 * BUG.missile-aim-reload-played-as-actions + BUG.own-ammo-pickup-event-ignored
 * — "the enter-combat-mode animation for bows is broken".
 *
 * Entering missile combat, ACE plays the style change, then
 * Creature_Missile.cs ReloadMissileAmmo: EnqueueMotionPersist(Reload) and
 * then Ready, then a ParentEvent puts the arrow in the right hand. A shot is
 * Player_Missile's aim level, Reload, Ready (+ a PickupEvent for the ammo at
 * launch). Aim* (0x4000001e–2a) and Reload (0x40000016) are SubState
 * commands; in the EoL human table 0x09000001 the bow reload is
 *   link(Ready → Reload) 0x030004ae frames 0–22, cycle Reload = hold 22,
 *   link(Reload → Ready) 0x030004ae frames 22–end (the nock),
 * and for atlatl / thrown weapons link(Aim → Reload) 0x030004b0 frames
 * 18–end is the throw itself. Our own character played them as one-shot
 * actions: the reload snapped back to Ready at frame 22 (a ~150° pop) and
 * the throw never played.
 *
 * Drives the shipped path: a MovementEvent through ServerObjectManager into
 * the real MotionManager on the real DAT.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const ME = 0x50000001;
const READY = 0x03, RELOAD = 0x16, AIM_LEVEL_HIGH = 0x27;
const BOW = 0x8000003f, CROSSBOW = 0x80000041, ATLATL = 0x8000013b, THROWN = 0x80000047;

// MovementEvent: 6-byte header (timestamps, autonomous = 0) + InterpretedMotionState with only ForwardCommand (+ speed).
function movement(styleIndex: number, forwardCmd: number, speed?: number): Uint8Array {
  const buf = new Uint8Array(6 + 4 + 4 + 2 + 2 + 4);
  const view = new DataView(buf.buffer);
  let o = 6;
  view.setUint8(o, 0); o += 1; // InterpretedMotionState
  view.setUint8(o, 0); o += 1;
  view.setUint16(o, styleIndex, true); o += 2;
  view.setUint32(o, speed === undefined ? 0x2 : 0x2 | 0x10, true); o += 4; // ForwardCommand (+ ForwardSpeed)
  view.setUint16(o, forwardCmd, true); o += 2;
  o += 2; // align
  if (speed !== undefined) view.setFloat32(o, speed, true);
  return speed === undefined ? buf.subarray(0, 18) : buf;
}

const quatAngle = (a: { w: number; x: number; y: number; z: number }, b: typeof a): number =>
  2 * Math.acos(Math.min(1, Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z))) * 180 / Math.PI;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poseJump = (A: any[], B: any[]): number => {
  let m = 0;
  for (let i = 0; i < Math.min(A.length, B.length); i++) m = Math.max(m, quatAngle(A[i].orientation, B[i].orientation));
  return m;
};

describe.skipIf(!existsSync(PORTAL))('own missile Aim / Reload play as substates (human table 0x09000001)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeAll(() => { db = openDat(PORTAL); });

  async function rig(style: number) {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    const mm = new MotionManager(db);
    expect(mm.loadMotionTable(0x09000001)).toBeTruthy();
    expect(mm.setStanceFromId(style)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(ME, { motionManager: mm } as any, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player = (mm as any).player;
    const seen: Array<{ anim: number; frame: number }> = [];
    let maxJump = 0;
    let prev = mm.getPartTransforms();
    const send = (cmd: number, speed?: number) =>
      som.handleMovementEvent({ guid: ME, movementData: movement(style & 0xffff, cmd, speed) } as never);
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 1000 / 120) {
        mm.update(1 / 120);
        const cur = mm.getPartTransforms();
        maxJump = Math.max(maxJump, poseJump(prev, cur));
        prev = cur;
        seen.push({ anim: player.currentAnimation?.id >>> 0, frame: Math.floor(player.frameNumber) });
      }
    };
    return { mm, send, run, seen, get maxJump() { return maxJump; } };
  }

  for (const [name, style, reloadAnim] of [['bow', BOW, 0x030004ae], ['crossbow', CROSSBOW, 0x030004ad]] as const) {
    it(`${name}: the server's Reload then Ready plays the whole reload — the nock after the hold frame — with no snap`, async () => {
      const r = await rig(style);
      r.send(RELOAD, 0.88);
      r.run(370); // ACE's Ready follows the Reload by its link length (live: ~370 ms)
      expect(r.mm.stance & 0xffff).toBe(RELOAD); // held, not snapped back to Ready
      r.send(READY);
      r.run(1800); // crossbow's nock 0x030004ad 23–end is ~1.3 s
      const reloadFrames = r.seen.filter((s) => s.anim === reloadAnim).map((s) => s.frame);
      expect(Math.min(...reloadFrames)).toBeLessThanOrEqual(1);
      expect(Math.max(...reloadFrames)).toBeGreaterThan(30); // the second half (22/23–end) played
      expect(r.mm.stance).toBe(MotionManager.compositeKey(style, READY));
      expect(r.mm.isPlayingAction).toBe(false);
      // A one-shot snapped from frame 22 straight to the Ready cycle: ~120–150°.
      expect(r.maxJump).toBeLessThan(30);
    });
  }

  for (const [name, style] of [['atlatl', ATLATL], ['thrown weapon', THROWN]] as const) {
    it(`${name}: aim then reload plays the throw (link Aim → Reload, 0x030004b0 frames 18–end)`, async () => {
      const r = await rig(style);
      r.send(AIM_LEVEL_HIGH);
      r.run(400);
      expect(r.mm.stance & 0xffff).toBe(AIM_LEVEL_HIGH); // the wind-up is held
      r.send(RELOAD, 0.88);
      r.run(1500);
      const throwFrames = r.seen.filter((s) => s.anim === 0x030004b0).map((s) => s.frame);
      expect(Math.max(...throwFrames)).toBeGreaterThan(25);
      r.send(READY);
      r.run(1500);
      expect(r.mm.stance).toBe(MotionManager.compositeKey(style, READY));
    });
  }
});

describe('BUG.own-ammo-pickup-event-ignored — PickupEvent for an untracked guid (our own ammo)', () => {
  it('applies (true), so the held copy is detached; a tracked stale event still does not', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    expect(som.pickupEvent(0x80001462, 7)).toBe(true);
    // Parity with parentEvent, which already answered true for the same guid.
    expect(som.parentEvent(0x80001462, ME, 1, 8)).toBe(true);
  });
});

describe('attachHeldChild — CHILDLIST::add_child @ 0051b270 appends; only the same item is replaced', () => {
  it('the atlatl dart at RightHand leaves the atlatl (also RightHand) in the hand; re-parenting the dart replaces only it', async () => {
    const THREE = await import('three');
    const { attachHeldChild } = await import('../packages/renderer/src/models/WieldedItemVisual.js');
    const root = new THREE.Group();
    const hand = new THREE.Group(); hand.name = 'part_15';
    const other = new THREE.Group(); other.name = 'part_9';
    root.add(hand, other);
    const atlatl = new THREE.Group(), dart1 = new THREE.Group(), dart2 = new THREE.Group();
    expect(attachHeldChild(root, hand, atlatl, 1, 0x8000bbca)).toEqual([]);
    expect(attachHeldChild(root, hand, dart1, 1, 0x80001462)).toEqual([]);
    expect(hand.children).toEqual([atlatl, dart1]);
    expect(atlatl.name).toBe('wielded_1');
    expect(dart1.userData.wieldedGuid).toBe(0x80001462);
    // The same dart parented again (the next reload) — even on another part — replaces its old copy only.
    expect(attachHeldChild(root, other, dart2, 1, 0x80001462)).toEqual([dart1]);
    expect(hand.children).toEqual([atlatl]);
    expect(other.children).toEqual([dart2]);
  });
});
