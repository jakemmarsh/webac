/**
 * Our local-player movement in simulated time, driven by physical keys the
 * way the browser delivers them: the real KeybindRegistry with the retail
 * default keymap (KeyMap 0x14000000) translates each key as main.ts's
 * keyTranslator does, CameraController.handleKeyDown / handleKeyUp take it as
 * bind()'s listeners do, and the one-shot actions main.ts routes itself (Stop
 * Moving, the spell bar's cast) go where main.ts sends them. Each 60 Hz frame
 * runs the main loop's order: CameraController.update (turn + the sequence
 * step's movement), CharacterAnimController.update (substates from the keys),
 * MovementSync.update (what goes on the wire).
 *
 * Shared by the retail golden tests (verify-retail-movement-golden.ts, the
 * hand-written scenarios; verify-retail-movement-sweep.ts, the combination
 * sweep) — docs/movement-ab.md.
 */
import * as THREE from 'three';
import { MotionManager } from '../../packages/renderer/src/animation/MotionManager.js';
import { CharacterAnimController } from '../../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionStance } from '../../packages/renderer/src/animation/MotionCommands.js';
import { CameraController } from '../../packages/renderer/src/scene/CameraController.js';
import { localSequenceStep } from '../../packages/renderer/src/player/LocalSequenceStep.js';
import { maybeStopCompletely } from '../../packages/renderer/src/controllers/StopCompletely.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../../packages/renderer/src/network/MovementSync.js';
import { KeybindRegistry } from '../../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS, MOVEMENT_CANONICAL, activeInputMaps } from '../../packages/renderer/src/input/KeybindDefaults.js';
import { CombatMode } from '@ac/shared';
import { decodeMessage, type WireAction } from '../../tools/lib/ac-wire.ts';
import type { Ev } from '../../tools/lib/movement-scenarios.ts';
import type { DatDatabase } from '@ac/dat-parser';
import { stepPlayerMovement, type MovementServices } from '../../packages/renderer/src/player/OutdoorMovement.js';
import { headingForYaw, yawForHeading } from '../../packages/renderer/src/world/Heading.js';
import { A9B4 } from './a9b4-world.js';
import { applyServerForwardToLocalPlayer } from '../../packages/renderer/src/world/ServerObjectManager.js';
import { MotionManager as MM } from '../../packages/renderer/src/animation/MotionManager.js';
import { AttackRequestController } from '../../packages/renderer/src/controllers/AttackRequest.js';
import { MotionCommand } from '../../packages/renderer/src/animation/MotionCommands.js';

/** A server combat event for the mover (the fixture's serverCombat). */
export interface ServerCombatRow { t: number; event: 'attackDone' | 'commenceAttack'; code: number }
/** What the client's combat system sent (TargetedMelee / MissileAttack, CancelAttack). */
export interface SimAttack { t: number; kind: 'attack' | 'cancelAttack' }

/** A server UpdateMotion for the mover (the fixture's serverMotions): t ms from the first key. */
export interface ServerMotionRow { t: number; type: number; style: number; fwd: number; fwdSpeed: number; actions: [number, number][] }

export const FRAME = 1 / Number(process.env.MVAB_SIM_HZ ?? 60);
/**
 * A server motion reaches the relay a little before the retail client acts on
 * it: the client reads the network after its input in the frame that follows.
 * (Measured on the sweep: a key the relay saw 17 ms after a server gesture
 * was still processed first.)
 */
export const SERVER_MOTION_DELAY_MS = Number(process.env.MVAB_SM_DELAY ?? 33);
const HUMAN_MOTION_TABLE = 0x09000001;

export interface SimFrame { t: number; right: number; fwd: number; heading: number }
export interface SimWire { t: number; a: WireAction }
export interface SimResult { frames: SimFrame[]; wire: SimWire[]; endControlledByServer: boolean; attacks: SimAttack[] }

export interface SimOptions {
  portal: DatDatabase;
  events: Ev[];
  /** When our client acts on each event (ms from the first key), e.g. retail's own key-processing times. */
  keyTimes: number[];
  endMs: number;
  style: number;
  runRate: number;
  /**
   * The lane's collision world (a9b4-world.ts): the body moves through
   * stepPlayerMovement from the start spot facing north, as main.ts moves it.
   * Without it the body moves freely. A function gets the replay's clock
   * (ms from the first key), for a world whose objects change state mid-run.
   */
  world?: MovementServices | ((nowMs: () => number) => MovementServices);
  /**
   * The server's own non-autonomous motions for the mover, at the times the
   * retail client got them: each hands control to the server
   * (LoseControlToServer) and plays as ServerObjectManager plays it
   * (applyServerForwardToLocalPlayer, then the commands list as actions).
   */
  serverMotions?: ServerMotionRow[];
  /**
   * The server still had control when the scenario began: controlled_by_server
   * survives a teleport, and nothing held means UseTime never takes it back
   * (the previous scenario's last server motion — a cast's Ready — leaves it set).
   */
  startControlled?: boolean;
  /**
   * A melee / missile mover: the real AttackRequestController wired as
   * main.ts wires it (End = Medium Attack press / release, Slash = Select
   * Closest Player, Repeat Attacks on — ACE CharacterOptions1.Default), the
   * server's AttackDone / CommenceAttack replayed from the capture.
   */
  combat?: 'melee' | 'missile';
  serverCombat?: ServerCombatRow[];
}

export function simulateKeys(o: SimOptions): SimResult {
  const mm = new MotionManager(o.portal);
  mm.loadMotionTable(HUMAN_MOTION_TABLE);
  mm.setDefaultStance(1);
  const anim = new CharacterAnimController(mm);
  anim.runRate = o.runRate;
  if (o.style !== MotionStance.NonCombat) {
    anim.setStance(o.style);
    for (let i = 0; i < 300; i++) mm.update(FRAME); // the stance change settles
  }
  const cam = new CameraController(new THREE.PerspectiveCamera());
  cam.runRate = o.runRate;
  cam.sequenceStep = (dt, st) => localSequenceStep({ motionManager: mm, update: (d, m) => mm.update(d, m) }, dt, st);

  const keybinds = new KeybindRegistry(DEFAULT_KEYBINDS);
  keybinds.setActiveInputMaps(activeInputMaps(o.style === MotionStance.Magic ? CombatMode.Magic : CombatMode.NonCombat));
  cam.keyTranslator = (code: string): string | null => {
    const id = keybinds.resolve(code);
    return id != null ? MOVEMENT_CANONICAL[id] ?? null : null;
  };

  const clock = { t: 0 };
  const wire: SimWire[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { const a = decodeMessage(b); if (a) wire.push({ t: clock.t, a }); } } as any, () => 1);
  // As main.ts: the MoveToState style is the player's motion style.
  sync.stanceProvider = () => mm.currentStyleId;
  // As main.ts builds it each frame.
  const state = (): MovementState => ({
    forward: cam.isMovingForward, backward: cam.isMovingBackward, turnLeft: cam.isTurningLeft, turnRight: cam.isTurningRight,
    strafeLeft: cam.isStrafingLeft, strafeRight: cam.isStrafingRight, running: cam.isRunning, forwardHoldRun: cam.rawForwardHoldRun,
    runToggle: cam.runToggle, turnSpeed: cam.turnSpeed, serverControlled: cam.controlledByServer || cam.consumeSilentTakeBack(),
    movementEvent: cam.movementEvents, standingLongJump: anim.standingLongJump, substate: anim.heldSubstate, jumpCharging: anim.jumpCharging,
  });
  const W = typeof o.world === 'function' ? o.world(() => clock.t) : o.world;
  const x0 = A9B4.OX + A9B4.START.x, z0 = A9B4.OY + A9B4.START.y;
  let wx = x0, wz = z0;
  if (W) cam.playerYaw = yawForHeading(0);
  const pos = (): PlayerPosition => W
    ? { worldX: wx, worldZ: wz, groundY: A9B4.Z, playerYaw: cam.playerYaw, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true }
    : { worldX: 85 + 169 * 192 + cam.camera.position.x, worldZ: 20.5 + 180 * 192 + cam.camera.position.z, groundY: 94, playerYaw: cam.playerYaw, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };

  if (o.startControlled) cam.loseControlToServer();

  // ── combat (main.ts's AttackRequestController wiring) ──
  const attacks: SimAttack[] = [];
  let target = 0;
  const stopDeps = () => ({
    controlledByServer: () => cam.controlledByServer,
    clearAllCommands: () => cam.stopCompletely(),
    stopPhysics: () => anim.stopCompletely(cam),
    sendMovementEvent: () => sync.sendMovementEventNow(state(), pos(), clock.t),
  });
  const ar = o.combat ? new AttackRequestController({
    now: () => clock.t / 1000, getTarget: () => target, isAttackable: () => true,
    inReadyPosition: () => o.combat === 'melee' || anim.interpretedForwardCommand(cam) === MotionCommand.Ready,
    combatMode: () => o.combat!, currentStyle: () => 0, sliderPower: () => 0.5, autoRepeat: () => true,
    sendAttack: () => attacks.push({ t: clock.t, kind: 'attack' }), setPowerBarLevel: () => {}, showError: () => {},
    sendCancelAttack: () => { attacks.push({ t: clock.t, kind: 'cancelAttack' }); }, autoTarget: () => true,
    lastAttacker: () => 0, objectPresent: () => true, selectObject: () => {}, selectNextCompassItem: () => {},
    finishJump: () => anim.cancelJumpCharge(), maybeStopCompletely: () => { maybeStopCompletely(stopDeps()); },
  }) : null;
  if (ar) cam.onAbortAutomaticAttack = () => ar.abortAutomaticAttack();
  let wasCharging = false;
  let ci = 0;
  const combatEvents = o.serverCombat ?? [];
  // main.ts: the movement event goes out inside the key handler.
  cam.onMovementEvent = () => sync.sendMovementEventNow(state(), pos(), clock.t);
  const frames: SimFrame[] = [];
  let ei = 0;
  let altHeld = false;
  let si = 0;
  let movingToUntil = -Infinity;
  const motions = o.serverMotions ?? [];
  for (let i = 0; i * FRAME * 1000 <= o.endMs; i++) {
    const t = i * FRAME * 1000;
    clock.t = t;
    while (ei < o.events.length && o.keyTimes[ei] <= t) {
      clock.t = o.keyTimes[ei];
      const [, dir, code] = o.events[ei++];
      const id = keybinds.resolve(code);
      if (dir === 'down' && id === ACT.StopMoving) { cam.stopMoving(); continue; }
      if (code === 'Digit1') {
        // The spell bar's cast: ClientMagicSystem::CastSpell @ 00568040 →
        // cmdinterp->MaybeStopCompletely(), wired as main.ts wires it.
        if (dir === 'down') {
          maybeStopCompletely({
            controlledByServer: () => cam.controlledByServer,
            clearAllCommands: () => cam.stopCompletely(),
            stopPhysics: () => anim.stopCompletely(cam),
            sendMovementEvent: () => sync.sendMovementEventNow(state(), pos(), t),
          });
        }
        continue;
      }
      if (code === 'AltLeft') { altHeld = dir === 'down'; continue; }
      if (code === 'Slash') { if (dir === 'down') { target = 0x50000001; ar?.onSelectionChanged(target); } continue; }
      if (code === 'End') { if (ar) { if (dir === 'down') ar.setRequestedAttackHeight('medium'); else ar.endAttackRequest(); } continue; }
      if (dir === 'down') cam.handleKeyDown(code, false, altHeld); else cam.handleKeyUp(code);
    }
    while (ci < combatEvents.length && combatEvents[ci].t + SERVER_MOTION_DELAY_MS <= t) {
      const e = combatEvents[ci++];
      clock.t = t;
      if (e.event === 'attackDone') ar?.handleAttackDone(e.code); else ar?.handleCommenceAttack();
    }
    while (si < motions.length && motions[si].t + SERVER_MOTION_DELAY_MS <= t) {
      const m = motions[si++];
      // Every non-autonomous movement hands control to the server; a MoveTo /
      // TurnTo (types 6–9) is MoveToManager's, which this replay does not run.
      cam.loseControlToServer();
      // Motions from before the first key (the setup's stance toggle, an
      // earlier scenario's last swings) only leave the server in control —
      // their animations finished long before the scenario began.
      if (m.t < 0) continue;
      // The server's TurnTo / MoveTo runs until its next motion for the mover
      // (the swing that follows it) or a second: IsMovingTo holds UseTime's take-back.
      if (m.type !== 0) { movingToUntil = motions[si]?.t !== undefined ? motions[si].t + SERVER_MOTION_DELAY_MS : t + 1000; continue; }
      const stance = (0x80000000 | m.style) >>> 0;
      applyServerForwardToLocalPlayer(mm, m.fwd, m.fwdSpeed, stance);
      for (const [cmd, speed] of m.actions) mm.queueAction(MM.compositeKey(stance, cmd), speed);
    }
    clock.t = t;
    if (W) {
      const p = cam.camera.position;
      p.set(wx, A9B4.Z, wz);
      cam.update(FRAME);
      const r = stepPlayerMovement({ x: wx, z: wz, floorY: A9B4.Z, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, p.x - wx, p.z - wz, FRAME, W);
      wx = r.x; wz = r.z;
        cam.useTime(anim.motionsPending, t < movingToUntil);
      anim.update(FRAME, cam);
      if (ar) { if (anim.jumpCharging && !wasCharging) ar.commenceJump(); wasCharging = anim.jumpCharging; ar.useTime(); }
      sync.update(state(), pos(), t);
      frames.push({ t: t + FRAME * 1000, right: wx - x0, fwd: wz - z0, heading: headingForYaw(cam.playerYaw) });
      continue;
    }
    cam.update(FRAME);
    cam.useTime(anim.motionsPending, t < movingToUntil);
    anim.update(FRAME, cam);
    if (ar) { if (anim.jumpCharging && !wasCharging) ar.commenceJump(); wasCharging = anim.jumpCharging; ar.useTime(); }
    sync.update(state(), pos(), t);
    // Scene axes: x = east, −z = north (forward at yaw 0 is (−sin yaw, −cos yaw)); right = east here.
    const p = cam.camera.position;
    const deg = ((cam.playerYaw * 180) / Math.PI % 360 + 360) % 360;
    frames.push({ t: t + FRAME * 1000, right: -p.x, fwd: -p.z, heading: deg });
  }
  return { frames, wire, endControlledByServer: cam.controlledByServer, attacks };
}

/**
 * When the retail client acted on each key event: the MoveToState it sent
 * for it (the first one within 150 ms after the event) — each key reaches
 * the retail client 15–80 ms after the driver posts it and is acted on at
 * its next frame — else the scenario's median latency.
 */
export function retailKeyTimes(events: Ev[], moveToStateTimes: number[], actionTimes: { attack?: number[]; cast?: number[] } = {}): number[] {
  const ev = events.map((e) => e[0]);
  // An attack release / a cast press is timed by the message it sent (no MoveToState).
  const fromAction = (e: number, list?: number[]) => list?.find((m) => m >= e && m - e <= 150);
  // Shift and Alt send no movement event (SetHoldRun; a modifier), so they
  // never claim a MoveToState; each MoveToState is claimed once.
  const sends = (code: string) => code !== 'ShiftLeft' && code !== 'AltLeft';
  // Claimed by index: two MoveToStates can share a millisecond (keys handled in one frame).
  const claimed = new Set<number>();
  const caused = events.map(([e, dir, code]) => {
    if (code === 'End' && dir === 'up') return fromAction(e, actionTimes.attack);
    if (code === 'Digit1' || code === 'Digit2') return dir === 'down' ? fromAction(e, actionTimes.cast) : undefined;
    if (code === 'End' || code === 'Slash' || code === 'Space') return undefined;
    if (!sends(code)) return undefined;
    const i = moveToStateTimes.findIndex((m, j) => m >= e && m - e <= 150 && !claimed.has(j));
    if (i < 0) return undefined;
    claimed.add(i);
    return moveToStateTimes[i];
  });
  const lags = caused.flatMap((t, i) => (t === undefined ? [] : [t - ev[i]])).sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)] : 0;
  // Keys reach the client in the order they were posted.
  const out: number[] = [];
  ev.forEach((e, i) => {
    const t = caused[i] ?? e + median;
    out.push(i > 0 && e >= ev[i - 1] ? Math.max(t, out[i - 1] + 0.5) : t);
  });
  return out;
}

export function frameAt(frames: SimFrame[], t: number): SimFrame {
  let best = frames[0];
  for (const f of frames) { if (f.t <= t) best = f; else break; }
  return best;
}

export const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
