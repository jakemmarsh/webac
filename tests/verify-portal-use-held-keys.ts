/**
 * BUG.portal-use-held-keys — a Gateway (wcid 1955, use-only) used while running did nothing (Coldeve,
 * 2026-11-04 20:51:45Z, trace 366632e24f96c61d: 5 attempts, serverWalk false, UseDone 0, ran through it).
 *
 * Retail (decomp, EoL acclient): a movement key merely HELD while the server's MoveTo runs sends nothing —
 * CommandInterpreter::UseTime @ 0x006b3bf0 hands control back only once CPhysicsObj::IsMovingTo and
 * motions_pending are both false, and that take-back sends no movement event; a key-UP under server control
 * only leaves its list (HandleKeyboardCommand @ 0x006b3690, vtable +0x14). A FRESH key-down runs
 * TakeControlFromServer @ 0x006b32d0 (StopCompletely + ApplyCurrentMovement) and SendMovementEvent
 * @ 0x006b4680: a MoveToState. ACE cancels a use's walk on ANY MoveToState while IsPlayerMovingTo
 * (GameActionMoveToState.cs StopExistingMoveToChains → Player_Move.cs MoveToChain callback(false) →
 * Player_Use.cs TryUseItem(item, false) → UseDone(None), no teleport).
 *
 * Ours already matches (pinned here through the real CameraController + MovementSync, with the new
 * onMoveToStateSent tap), so the change is telemetry: a use the player's own MoveToState went out on while
 * it was unanswered ends as `portal_cancelled`, and every failure says how many Uses went out, how many
 * were held busy, how many server movements came, whether keys were held at the send, the MoveToStates
 * sent while a Use was outstanding and the UseDone timing — what tells the 2026-11-04 shape apart next time.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import {
  PortalUseReporter, PORTAL_REPLY_MS, PORTAL_CANCELLED,
  type PortalEvent, type PortalSnapshot, type PortalUseFailedEvent,
} from '../packages/renderer/src/telemetry/PortalUseReporter.js';
import { sanitizeClientPortal } from '../services/ws-tcp-bridge/src/clientWorld.js';

const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const stateOf = (c: CameraController): MovementState => ({
  forward: c.isMovingForward, backward: c.isMovingBackward, turnLeft: c.isTurningLeft, turnRight: c.isTurningRight,
  strafeLeft: c.isStrafingLeft, strafeRight: c.isStrafingRight, running: c.isRunning, forwardHoldRun: c.rawForwardHoldRun,
  runToggle: c.runToggle, serverControlled: c.controlledByServer || c.consumeSilentTakeBack(), movementEvent: c.movementEvents,
});

/** The real interpreter and sync, wired as main.ts wires them (key events send at once; frames run update). */
function client() {
  const c = new CameraController(new THREE.PerspectiveCamera());
  let sent = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync({ sendMessage: () => {} } as any, () => 1);
  sync.onMoveToStateSent = () => { sent++; };
  c.onMovementEvent = () => sync.sendMovementEventNow(stateOf(c), POS);
  let t = 0;
  const frames = (n: number, movingTo: boolean): void => {
    for (let i = 0; i < n; i++) { c.useTime(false, movingTo); t += 16; sync.update(stateOf(c), POS, t); }
  };
  sync.update(stateOf(c), POS, 0);
  return { c, sync, frames, sent: () => sent };
}

describe('retail: a held movement key does not cancel the server walk; a fresh one does', () => {
  it('W held through the whole MoveTo (and OS key repeats) sends no MoveToState', () => {
    const k = client();
    k.c.handleKeyDown('KeyW');
    expect(k.sent()).toBe(1); // the press itself
    k.c.loseControlToServer(); // the server's MoveToPosition for the Use arrives
    for (let i = 0; i < 30; i++) k.c.handleKeyDown('KeyW'); // browser auto-repeat keydowns
    k.frames(120, true); // ~2 s of the MoveTo running
    expect(k.sent()).toBe(1);
    expect(k.c.controlledByServer).toBe(true);
    expect(k.c.movementInputHeld).toBe(true);
    expect(k.c.isMoving).toBe(false);
    // The MoveTo ends: UseTime hands control back to the held W silently (no packet).
    k.frames(2, false);
    expect(k.c.controlledByServer).toBe(false);
    expect(k.sent()).toBe(1);
  });

  it('a key released under server control sends nothing; a fresh press (or Stop Moving) sends one', () => {
    const k = client();
    k.c.handleKeyDown('KeyW');
    k.c.loseControlToServer();
    k.c.handleKeyUp('KeyW');
    k.frames(10, true);
    expect(k.sent()).toBe(1);
    k.c.handleKeyDown('KeyD'); // a turn pressed mid-walk: TakeControlFromServer + SendMovementEvent
    expect(k.c.controlledByServer).toBe(false);
    expect(k.sent()).toBe(2);
    k.c.loseControlToServer();
    k.c.stopMoving();
    expect(k.sent()).toBe(3);
  });

  it('movementInputHeld: keys in any list or autorun, whoever controls the player', () => {
    const k = client();
    expect(k.c.movementInputHeld).toBe(false);
    k.c.handleKeyDown('KeyZ');
    expect(k.c.movementInputHeld).toBe(true);
    k.c.handleKeyUp('KeyZ');
    k.c.toggleAutoRun();
    expect(k.c.movementInputHeld).toBe(true);
  });
});

const GATEWAY = 0x7a9b4021;
const gatewayObj = { itemType: 0x10000, objectDescFlags: 0x40014 };
const snap = (): PortalSnapshot => ({
  wcid: 1955, itemType: 0x10000, descFlags: 0x40014, physicsState: 0x804, useRadius: 0.75, reach: 1.92,
  rel: { dx: 6.3, dy: -5.7, dz: -0.1 }, playerCell: 0xa9b40019, portalCell: 0xa9b40021,
});
function rig() {
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'eor', server: () => 'coldeve', now: () => clock.t, snapshot: () => snap(),
    send: (_u, body) => { events.push(JSON.parse(body) as PortalEvent); },
  });
  const tick = (ms: number, st: { serverWalking: boolean; playerMoving: boolean }): void => {
    for (let i = 0; i < ms / 100; i++) { clock.t += 100; r.tick(st); }
  };
  return { r, clock, events, tick };
}

describe('portal telemetry: the player cancelled the walk (portal_cancelled)', () => {
  it('a MoveToState between the Use and its UseDone, then a run through the Gateway → portal_cancelled with the counts', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.useAttempt(GATEWAY, gatewayObj, true, null, true);
    g.clock.t += 120;
    g.r.serverMovement(); // ACE's MoveToPosition
    g.clock.t += 200;
    g.r.movementSent(); // a fresh key: ACE StopExistingMoveToChains
    g.clock.t += 100;
    g.r.useDone(0); // TryUseItem(item, false) → UseDone(None)
    g.r.movementSent(); // after the UseDone: no longer counted
    g.tick(300, { serverWalking: false, playerMoving: true });
    g.r.overlaps([GATEWAY]); // ran through it (use-only: nothing)
    g.tick(PORTAL_REPLY_MS + 200, { serverWalking: false, playerMoving: true });
    expect(g.events).toHaveLength(1);
    const e = g.events[0] as PortalUseFailedEvent;
    expect(e).toMatchObject({
      outcome: PORTAL_CANCELLED, trigger: 'use', wcid: 1955, sends: 1, busyHeld: 0, serverMoves: 1, serverWalk: true,
      keysAtSend: true, movesSent: 1, useDones: 1, firstUseDoneMs: 420, useDone: 0, playerMoved: true, overlapped: true,
    });
    expect(sanitizeClientPortal(e)).toEqual(e);
  });

  it('a MoveToState only after the UseDone (or with no Use out) is no cancel: portal_use_failed', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.movementSent(); // no watch yet
    g.r.useAttempt(GATEWAY, gatewayObj, true, null, false);
    g.r.serverMovement();
    g.r.useDone(0);
    g.r.movementSent();
    g.tick(200, { serverWalking: false, playerMoving: true });
    g.r.overlaps([GATEWAY]);
    g.tick(PORTAL_REPLY_MS + 200, { serverWalking: false, playerMoving: false });
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', movesSent: 0, keysAtSend: false, serverMoves: 1 });
  });

  it('the 2026-11-04 shape: attempts held busy, one sent, no server movement — every count says so', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.useAttempt(GATEWAY, gatewayObj, false, 'busy', true);
    g.r.useAttempt(GATEWAY, gatewayObj, false, 'busy', true);
    g.r.useAttempt(GATEWAY, gatewayObj, true, null, true);
    g.r.useAttempt(GATEWAY, gatewayObj, false, 'busy', true);
    g.r.useAttempt(GATEWAY, gatewayObj, false, 'stale', true);
    g.clock.t += 150;
    g.r.useDone(0);
    g.tick(200, { serverWalking: false, playerMoving: true });
    g.r.overlaps([GATEWAY]);
    g.tick(PORTAL_REPLY_MS + 200, { serverWalking: false, playerMoving: true });
    const e = g.events[0] as PortalUseFailedEvent;
    expect(e).toMatchObject({
      outcome: 'portal_use_failed', attempts: 5, sends: 1, busyHeld: 3, serverMoves: 0, serverWalk: false,
      keysAtSend: true, movesSent: 0, useDones: 1, firstUseDoneMs: 150, useSent: true,
    });
    expect(sanitizeClientPortal(e)).toEqual(e);
  });

  it('a refusal still wins over a cancel; a teleport still ends well', () => {
    const g = rig();
    g.r.useAttempt(GATEWAY, gatewayObj, true, null, true);
    g.r.movementSent();
    g.r.weenieError(0x04a7);
    g.tick(PORTAL_REPLY_MS + 200, { serverWalking: false, playerMoving: false });
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', movesSent: 1 });
    const h = rig();
    h.r.useAttempt(GATEWAY, gatewayObj, true, null, true);
    h.r.movementSent();
    h.r.teleported();
    expect(h.events[0]).toMatchObject({ outcome: 'portal_used' });
  });

  it('the bridge keeps old pages\' events (no new fields) as nulls and drops junk counts', () => {
    const e = sanitizeClientPortal({ outcome: 'portal_cancelled', trigger: 'use', wcid: 1955, sends: -1, keysAtSend: 'yes', movesSent: 2 });
    expect(e).toMatchObject({ outcome: 'portal_cancelled', sends: null, keysAtSend: null, movesSent: 2, firstUseDoneMs: null });
  });
});
