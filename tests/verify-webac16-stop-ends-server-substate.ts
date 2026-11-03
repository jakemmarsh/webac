/**
 * webac#16 (AC1999, "after firing an arrow the animation gets stuck and the combat stops until I
 * move away") — a StopCompletely on our own character ends a substate the SERVER put it in.
 *
 * Retail's CMotionInterp::StopCompletely (end of retail @ 00527e40, 1999 @ 0x00473c40) sets the
 * interpreted forward command to Ready and runs StopCompletely_Internal → CMotionTable::
 * StopObjectCompletely @ 00523ed0: a missile Aim / Reload, a cast gesture's hold, Eat / Drink end
 * with it, through their link back to Ready. Ours re-applied only the player's input (forward Ready
 * all along), so the server's substate stayed:
 *  - the 1999 attack press (PanelUI_StartAttackRequest @ 0x4f8850 → StopCompletely, every press)
 *    left the body in the Aim / Reload hold, out of the ready position, so no build started;
 *  - a server TurnTo (the AC1999 server's TurnToAttack, MovementParameters bitfield 0x1F09EE0F has
 *    stop_completely, PhatSDK Movement.cpp) runs MoveToManager TurnToObject's StopCompletely; the
 *    turn waits on motions_pending, which a held server substate kept true forever.
 *
 * Real MotionManager + CharacterAnimController + ServerObjectManager on the real motion table
 * (human 0x09000001), in the 1999, Dark Majesty and end-of-retail DATs: the code path is shared.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { MoveToManager, defaultMovementParams, type MoveToHost } from '../packages/renderer/src/controllers/MoveToManager.js';
import { adjustMotion, applyInterpretedMotion, removeInterpretedMotion, readyMotion, HoldKey } from '../packages/renderer/src/world/RemoteMotion.js';
import { DAT_PATHS, dataPath, openDat } from './_harness/dat.js';

const ME = 0x50000001;
const BOW = 0x8000003f;
const RELOAD = 0x16, AIM_LEVEL = 0x1e;
const DEG = 180 / Math.PI;

/** An 0xF74C body for our own character: style + forward (absent = Ready), non-autonomous. */
function movement(styleIndex: number, forwardCmd: number | null, speed?: number): Uint8Array {
  const buf = new Uint8Array(24);
  const v = new DataView(buf.buffer);
  let o = 6;
  v.setUint8(o, 0); o += 1; v.setUint8(o, 0); o += 1;
  v.setUint16(o, styleIndex, true); o += 2;
  if (forwardCmd === null) { v.setUint32(o, 0x1, true); o += 4; v.setUint16(o, styleIndex, true); return buf.subarray(0, 16); }
  v.setUint32(o, speed === undefined ? 0x3 : 0x3 | 0x10, true); o += 4;
  v.setUint16(o, styleIndex, true); o += 2;
  v.setUint16(o, forwardCmd, true); o += 2;
  if (speed !== undefined) v.setFloat32(o, speed, true);
  return speed === undefined ? buf.subarray(0, 18) : buf.subarray(0, 22);
}

const idleInput = () => ({
  isMovingForward: false, isMovingBackward: false, isStrafingLeft: false, isStrafingRight: false,
  isTurningLeft: false, isTurningRight: false, isRunning: true, isJumpHeld: false,
});

const ERAS = [
  ['AC1999', dataPath('dat-sets/ac1999-retail/portal.dat')],
  ['Dark Majesty (classic Dereth 1.1)', dataPath('dat-sets/classic-dereth-1.1/client_portal.dat')],
  ['end of retail', DAT_PATHS.portal],
] as const;

for (const [era, path] of ERAS) {
  describe.skipIf(!existsSync(path))(`webac#16 — StopCompletely ends a server-held substate (${era})`, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any;
    beforeAll(() => { db = openDat(path); });

    async function rig() {
      const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
      const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
      const mm = new MotionManager(db);
      expect(mm.loadMotionTable(0x09000001)).toBeTruthy();
      mm.setStanceFromId(BOW);
      som.registerAnimatedEntity(ME, { motionManager: mm } as never, true);
      (som as unknown as { localPlayerGuid: number }).localPlayerGuid = ME;
      const ac = new CharacterAnimController(mm);
      ac.setStance(BOW);
      const input = idleInput();
      const anims: Array<{ anim: number; frame: number }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const player = (mm as any).player;
      const run = (ms: number) => {
        for (let t = 0; t < ms; t += 1000 / 60) {
          ac.update(1 / 60, input as never);
          mm.update(1 / 60);
          anims.push({ anim: player.currentAnimation?.id >>> 0, frame: player.frameNumber });
        }
      };
      const send = (cmd: number | null, speed?: number) =>
        som.handleMovementEvent({ guid: ME, movementData: movement(BOW & 0xffff, cmd, speed) } as never);
      run(2000); // the style change plays out
      return { som, mm, ac, input, run, send, anims };
    }

    it('the server\'s Reload held: StopCompletely puts the forward command back to Ready, the nock plays, the body settles; the server\'s Ready after it replays nothing', async () => {
      const r = await rig();
      r.send(AIM_LEVEL, 1.5);
      r.run(30);
      r.send(RELOAD);
      r.run(1000); // into the Reload hold
      expect(r.ac.interpretedForwardCommand(r.input as never)).toBe(MotionCommand.Reload);
      expect(r.ac.motionsPending).toBe(true);
      expect(r.ac.forwardHeldByServer(r.input as never)).toBe(true);
      // The attack press (1999) / a movement key's take-back: CommandInterpreter StopCompletely.
      r.ac.stopCompletely(r.input as never);
      expect(r.ac.interpretedForwardCommand(r.input as never)).toBe(MotionCommand.Ready);
      expect(r.ac.forwardHeldByServer(r.input as never)).toBe(false);
      const from = r.anims.length;
      r.run(2500);
      const after = r.anims.slice(from);
      // The link out of the Reload hold played (frames past the hold), not a snap to the Ready cycle.
      const reloadAnim = after[0].anim;
      expect(Math.max(...after.filter((a) => a.anim === reloadAnim).map((a) => a.frame))).toBeGreaterThan(30);
      expect(r.ac.motionsPending).toBe(false);
      expect(r.mm.stance).toBe(MotionManager.compositeKey(BOW, 0x03));
      // The server's own Ready for that Reload (WeenieObject.cpp OnMotionDone → DoForcedStopCompletely) changes nothing.
      const before = r.anims.length;
      r.send(null);
      r.run(300);
      expect(r.mm.isPlayingAction).toBe(false);
      expect(r.anims.slice(before).every((a) => a.anim === r.anims[before - 1].anim)).toBe(true);
    });

    it('nothing held by the server: StopCompletely changes nothing (no extra link)', async () => {
      const r = await rig();
      const before = r.anims.length;
      r.ac.stopCompletely(r.input as never);
      r.ac.stopServerSubstate();
      r.run(300);
      expect(r.mm.isPlayingAction).toBe(false);
      expect(r.anims.slice(before).every((a) => a.anim === r.anims[before - 1].anim)).toBe(true);
    });

    it('the player\'s own posture is not the server\'s: stopServerSubstate leaves it', async () => {
      const r = await rig();
      r.ac.setStance(0x8000003d); // peace: Sitting is a NonCombat posture
      r.run(2000);
      r.ac.setHeldSubstate(MotionCommand.Sitting);
      r.run(1500);
      expect(r.ac.interpretedForwardCommand(r.input as never)).toBe(MotionCommand.Sitting);
      r.ac.stopServerSubstate();
      expect(r.ac.interpretedForwardCommand(r.input as never)).toBe(MotionCommand.Sitting);
    });

    it('a server TurnTo while a server Aim holds: TurnToObject\'s StopCompletely ends it, and the turn runs once the link has played', async () => {
      for (const endsServerSubstate of [true, false]) {
        const r = await rig();
        r.send(AIM_LEVEL, 1.5);
        r.run(500); // the Aim hold (the server's attack cancelled with no Ready, or a TurnTo before it)
        expect(r.ac.forwardHeldByServer(r.input as never)).toBe(true);
        let heading = 0;
        let t = 0;
        const st = readyMotion();
        const host: MoveToHost = {
          position: () => ({ x: 0, y: 0, z: 0 }),
          heading: () => heading,
          setHeading: (h) => { heading = h; },
          radius: () => 0.5, height: () => 1.8,
          doMotion: (cmd, speed, hk) => { const a = adjustMotion(cmd, speed, hk, HoldKey.None, 1); applyInterpretedMotion(st, a.motion, a.speed); return 0; },
          stopMotion: (cmd, speed, hk) => { removeInterpretedMotion(st, adjustMotion(cmd, speed, hk, HoldKey.None, 1).motion); return 0; },
          // main.ts's player host: the MoveTo state to Ready, and (the fix) the server's substate ends.
          stopCompletely: () => { Object.assign(st, readyMotion()); },
          ...(endsServerSubstate ? { stopServerSubstate: () => r.ac.stopServerSubstate() } : {}),
          motionsPending: () => r.ac.motionsPending,
          hasContact: () => true,
          target: () => ({ pos: { x: -5, y: 0, z: 0 }, radius: 0.4, height: 1.8 }),
          now: () => t,
        };
        const mgr = new MoveToManager(host);
        mgr.turnToObject(9, { ...defaultMovementParams(), flags: 0x1F09EE0F });
        for (let i = 0; i < 4 * 60; i++) {
          mgr.useTime();
          r.ac.update(1 / 60, r.input as never);
          r.mm.update(1 / 60);
          if (st.turn) heading = (((heading + 1.5 * st.turnSpeed * (1 / 60) * DEG) % 360) + 360) % 360;
          t += 1 / 60;
        }
        if (endsServerSubstate) expect(heading).toBeCloseTo(270, 0);
        else expect(heading).toBe(0); // before: motions_pending held by the Aim, the turn never began
      }
    });

    it('the opposite: a server substate that arrives DURING a MoveTo survives its end (only the start stops it)', async () => {
      const r = await rig();
      let heading = 0;
      let t = 0;
      const st = readyMotion();
      const host: MoveToHost = {
        position: () => ({ x: 0, y: 0, z: 0 }),
        heading: () => heading,
        setHeading: (h) => { heading = h; },
        radius: () => 0.5, height: () => 1.8,
        doMotion: (cmd, speed, hk) => { const a = adjustMotion(cmd, speed, hk, HoldKey.None, 1); applyInterpretedMotion(st, a.motion, a.speed); return 0; },
        stopMotion: (cmd, speed, hk) => { removeInterpretedMotion(st, adjustMotion(cmd, speed, hk, HoldKey.None, 1).motion); return 0; },
        stopCompletely: () => { Object.assign(st, readyMotion()); },
        stopServerSubstate: () => r.ac.stopServerSubstate(),
        motionsPending: () => false, // the turn runs at once
        hasContact: () => true,
        target: () => ({ pos: { x: -5, y: 0, z: 0 }, radius: 0.4, height: 1.8 }),
        now: () => t,
      };
      const mgr = new MoveToManager(host);
      mgr.turnToObject(9, { ...defaultMovementParams(), flags: 0x1F09EE0F });
      r.send(RELOAD); // the server's Reload arrives while our turn still runs
      for (let i = 0; i < 4 * 60; i++) {
        mgr.useTime();
        r.mm.update(1 / 60);
        if (st.turn) heading = (((heading + 1.5 * st.turnSpeed * (1 / 60) * DEG) % 360) + 360) % 360;
        t += 1 / 60;
      }
      expect(heading).toBeCloseTo(270, 0); // the turn finished (CleanUpAndCallWeenie ran)
      expect(r.ac.interpretedForwardCommand(r.input as never)).toBe(MotionCommand.Reload);
    });
  });
}
