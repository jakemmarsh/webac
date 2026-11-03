/**
 * BUG.webac16-nock-stutter (jakemmarsh/webac#16, "0:03 - knocking back an arrow has an animation
 * stutter", AC1999 crossbow repeat): checked, retail. These tests pin the retail behaviour so it is
 * not "smoothed" away.
 *
 * The crossbow reload in the human motion table 0x09000001 is
 *   link(Ready → Reload) 0x030004ad frames 0–22, cycle Reload = 0x030004ad frame 22 at framerate 0
 *   (a hold), link(Reload → Ready) 0x030004ad frames 23–end.
 * 1999's portal.dat plays both links at 42 fps (end of retail and Dark Majesty: 84). The AC1999
 * server sends Reload, runs the same link on its side and sends Ready (DoForcedStopCompletely) from
 * OnMotionDone(Reload) (Server/Source/WeenieObject.cpp OnMotionDone), so Ready can only reach the
 * client after the client's own 548 ms link has ended, by the server's tick + network jitter. For
 * that gap the sequence stands in the Reload cycle: frame 22 held. CMotionTable::GetObjectSequence
 * (EoL @ 00522860; 1999 @ 0x0046fdb0) then calls remove_cyclic_anims (EoL @ 00524e40, 1999 @
 * 0x0048aed0), which drops only the hold and appends link(Reload → Ready): frame 23 starts at once.
 *
 * The aim twitch before each shot is the same machinery: the server's AimLevel (at the attack speed)
 * plays link(Ready → AimLevel) 0x03000474 frames 0–1; its Reload ~60 ms later has no direct
 * AimLevel → Reload link, so GetObjectSequence goes via the style default: link(AimLevel → Ready)
 * (frames 1..0 reversed, which set_animation_id clamps to frame 1) at the aim's speed, then
 * link(Ready → Reload) at 1.0.
 *
 * Drives the shipped path: a MovementEvent through ServerObjectManager into the real MotionManager
 * on the real DATs of each era.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { openDat, DAT_PATHS, dataPath } from './_harness/dat.js';

const ME = 0x50000032;
const READY = 0x03, RELOAD = 0x16, AIM_LEVEL = 0x1e;
const CROSSBOW = 0x80000041;
const NOCK = 0x030004ad, AIM = 0x03000474;

const ERAS = [
  { era: 'AC1999', portal: dataPath('dat-sets/ac1999-retail/portal.dat'), linkMs: (23 / 42) * 1000 },
  { era: 'end of retail', portal: DAT_PATHS.portal, linkMs: (23 / 84) * 1000 },
  { era: 'Dark Majesty', portal: dataPath('dat-sets/classic-dereth-1.1/client_portal.dat'), linkMs: (23 / 84) * 1000 },
];

// MovementEvent: 6-byte header (timestamps, autonomous = 0) + InterpretedMotionState with only ForwardCommand (+ speed).
function movement(styleIndex: number, forwardCmd: number, speed?: number): Uint8Array {
  // InterpretedMotionState::Pack: the commands, then the speeds (no padding between), aligned at the end.
  const buf = new Uint8Array(6 + 4 + 4 + 2 + 4 + 2);
  const view = new DataView(buf.buffer);
  let o = 6;
  view.setUint8(o, 0); o += 1;
  view.setUint8(o, 0); o += 1;
  view.setUint16(o, styleIndex, true); o += 2;
  view.setUint32(o, speed === undefined ? 0x2 : 0x2 | 0x4, true); o += 4; // ForwardCommand (+ ForwardSpeed)
  view.setUint16(o, forwardCmd, true); o += 2;
  if (speed !== undefined) view.setFloat32(o, speed, true);
  return speed === undefined ? buf.subarray(0, 18) : buf.subarray(0, 20);
}

for (const { era, portal, linkMs } of ERAS) {
  describe.skipIf(!existsSync(portal))(`${era}: crossbow nock hold and aim twitch are the motion table's (webac#16)`, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any;
    beforeAll(() => { db = openDat(portal); });

    async function rig(viaState: boolean) {
      const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
      const mm = new MotionManager(db);
      expect(mm.loadMotionTable(0x09000001)).toBeTruthy();
      expect(mm.setStanceFromId(CROSSBOW)).toBe(true);
      if (viaState) {
        // The local player's path: CharacterAnimController's MotionTableState hands each substate change to setForwardMotion.
        const { MotionTableState } = await import('../packages/renderer/src/animation/MotionTableState.js');
        const ts = new MotionTableState(mm.activeMotionTable!, () => mm.currentStyleId, (motion, speed) =>
          mm.setForwardMotion(MotionManager.compositeKey(mm.styleKey, motion & 0xfffff), speed));
        ts.reset(0x41000003);
        mm.motionTableState = ts;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      som.registerAnimatedEntity(ME, { motionManager: mm } as any, true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const player = (mm as any).player;
      // Let the style change's draw finish: the shot starts from the Ready cycle.
      for (let i = 0; i < 600; i++) mm.update(1 / 120);
      expect(mm.isPlayingAction).toBe(false);
      const seen: Array<{ t: number; anim: number; frame: number; rate: number }> = [];
      let t = 0;
      const send = (cmd: number, speed?: number) =>
        som.handleMovementEvent({ guid: ME, movementData: movement(CROSSBOW & 0xffff, cmd, speed) } as never);
      const run = (ms: number) => {
        const end = t + ms;
        for (; t < end; t += 1000 / 120) {
          mm.update(1 / 120);
          seen.push({ t, anim: player.currentAnimation?.id >>> 0, frame: Math.floor(player.frameNumber), rate: player.framerate * player.playbackSpeed });
        }
      };
      return { mm, send, run, seen };
    }

    for (const viaState of [false, true]) describe(viaState ? 'local player (MotionTableState)' : 'MotionManager', () => {
      it('a Ready that arrives after the link holds frame 22 (the Reload cycle) until it comes, then frame 23 at once', async () => {
        const r = await rig(viaState);
        r.send(RELOAD);
        r.run(linkMs + 90); // Ready 90 ms late
        expect(r.mm.stance & 0xffff).toBe(RELOAD);
        const held = r.seen.filter((s) => s.anim === NOCK && s.frame === 22);
        // Frame 22's own 1/rate plus the ~90 ms wait: retail's hold, not skipped.
        expect(held.length * (1000 / 120)).toBeGreaterThan(70);
        const before = r.seen.length;
        r.send(READY);
        r.run(1 / 120 * 1000 * 2);
        const after = r.seen.slice(before).filter((s) => s.anim === NOCK);
        expect(after.length).toBeGreaterThan(0);
        expect(after[after.length - 1].frame).toBeGreaterThanOrEqual(23);
        r.run(2000);
        expect(r.mm.stance).toBe(MotionManager.compositeKey(CROSSBOW, READY));
      });

      it('a Ready that arrives during the link never holds: frame 22 lasts one frame, the nock follows', async () => {
        const r = await rig(viaState);
        r.send(RELOAD);
        r.run(linkMs * 0.8);
        r.send(READY);
        r.run(2000);
        const frames = r.seen.filter((s) => s.anim === NOCK).map((s) => s.frame);
        for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]); // never restarts
        const ticksAt22 = frames.filter((f) => f === 22).length;
        expect(ticksAt22 * (1000 / 120)).toBeLessThanOrEqual((linkMs / 23) + 1000 / 120);
        expect(Math.max(...frames)).toBeGreaterThan(100);
        // The first link is never cut short by the Ready: every frame 0–22 shows.
        for (let f = 0; f <= 22; f++) expect(frames).toContain(f);
      });

      it('a repeated Reload while the link plays does not restart or re-plan it', async () => {
        const r = await rig(viaState);
        r.send(RELOAD);
        r.run(linkMs * 0.5);
        r.send(RELOAD);
        r.run(linkMs * 0.6);
        const frames = r.seen.filter((s) => s.anim === NOCK).map((s) => s.frame);
        for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]);
        expect(frames[frames.length - 1]).toBe(22);
      });

      it('AimLevel then Reload: aim link frames 0–1, back through Ready (frame 1 reversed), then the reload link', async () => {
        const r = await rig(viaState);
        r.send(AIM_LEVEL, 1.187);
        r.run(20);
        r.send(RELOAD);
        r.run(linkMs + 200);
        const nodes: Array<{ anim: number; frame: number; rate: number }> = [];
        for (const s of r.seen) {
          const last = nodes[nodes.length - 1];
          if (!last || last.anim !== s.anim || last.frame !== s.frame || Math.sign(last.rate) !== Math.sign(s.rate)) nodes.push(s);
        }
        const firstNock = nodes.findIndex((n) => n.anim === NOCK);
        expect(firstNock).toBeGreaterThan(0);
        const aim = nodes.slice(0, firstNock).filter((n) => n.anim === AIM).map((n) => n.frame);
        expect(aim[0]).toBe(0);
        expect(aim).toContain(1);
        // link(AimLevel → Ready) at the aim's speed: frame 1 played backwards (-30 × 1.187), right before the nock.
        const back = nodes[firstNock - 1];
        expect(back.anim).toBe(AIM);
        expect(back.frame).toBe(1);
        expect(back.rate).toBeCloseTo(-30 * 1.187, 3);
        expect(nodes[firstNock].frame).toBe(0);
        expect(nodes[firstNock].rate).toBeCloseTo(era === 'AC1999' ? 42 : 84, 3);
        expect(r.mm.stance & 0xffff).toBe(RELOAD);
      });
    });
  });
}
