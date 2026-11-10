/**
 * BUG.movetostate-burst-abuse-close (playwebac.com 2026-11-10 00:40:33Z): the bridge closed a
 * Classic Dereth player's session for abuse after the page sent 600+ WebSocket messages at once,
 * its last eight sends all MoveToState (0xF7B1 / 0xF61C) in the same millisecond, with an agent
 * routine (nav + loot) running.
 *
 * Driven through the real pieces main.ts wires together: the agent API (AgentApi) on a host whose
 * movement keys are the real CameraController, each movement event sent by the real MovementSync
 * (cameraController.onMovementEvent → sendMovementEventNow), and the real connections' outgoing
 * pacer (SendPacer, in ClientConnection and Connection1999).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { SendPacer } from '../packages/network/src/SendPacer.ts';
import { decodeMessage } from '../tools/lib/ac-wire.ts';
import { FakeHost } from './_harness/agentFake.ts';

const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const stateOf = (c: CameraController): MovementState => ({
  forward: c.isMovingForward, backward: c.isMovingBackward, turnLeft: c.isTurningLeft, turnRight: c.isTurningRight,
  strafeLeft: c.isStrafingLeft, strafeRight: c.isStrafingRight, running: c.isRunning, forwardHoldRun: c.rawForwardHoldRun,
  runToggle: c.runToggle, serverControlled: c.controlledByServer, movementEvent: c.movementEvents,
});

/** main.ts's wiring: one shared action counter, MovementSync with its peek, the camera's movement events sent at once. */
function wiredPage(opts: { peek?: boolean } = {}) {
  const sent: Uint8Array[] = [];
  let seq = 0;
  const conn = { sendMessage: (b: Uint8Array) => { sent.push(b); } };
  const sync = new MovementSync(conn as never, () => ++seq, opts.peek === false ? undefined : () => seq);
  const cam = new CameraController(new THREE.PerspectiveCamera());
  let clock = 1000;
  const now = () => clock;
  cam.onMovementEvent = () => sync.sendMovementEventNow(stateOf(cam), POS, now());
  /** Another game action (a Use, an attack) through the same counter. */
  const otherAction = () => { seq++; sent.push(new Uint8Array([0xb1, 0xf7, 0, 0])); };
  const mts = () => sent.map((b) => decodeMessage(b)).filter((a) => a?.kind === 'moveToState');
  return { sync, cam, sent, mts, otherAction, advance: (ms: number) => { clock += ms; } };
}

/** The agent's host with the real camera as its keys, as main.ts's agent host (key → simulateKeyDown / Up, stopMovingAction → stopMoving). */
class CameraHost extends FakeHost {
  constructor(private readonly cam: CameraController) { super(); }
  override key = (code: string, down: boolean) => {
    if (down) this.keys.add(code); else this.keys.delete(code);
    if (down) this.cam.simulateKeyDown(code); else this.cam.simulateKeyUp(code);
  };
  stopMovingAction = () => this.cam.stopMoving();
}

describe('the agent\'s stops (AgentApi.stopMoving, a walk\'s cancel) send no MoveToState flood', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('one stop_moving with nothing held sends ONE MoveToState (retail Stop Moving: one movement event), not seven', () => {
    const page = wiredPage();
    const api = new AgentApi(new CameraHost(page.cam));
    api.stopMoving();
    // Before the fix: six key releases of keys never pressed (each a movement event) + Stop Moving = 7.
    expect(page.mts()).toHaveLength(1);
  });

  it('a run of 100 stops in one go (the 2026-11-10 burst) sends the stop and at most its capped repeats', () => {
    const page = wiredPage();
    const api = new AgentApi(new CameraHost(page.cam));
    for (let i = 0; i < 100; i++) api.stopMoving();
    // Before: 700 MoveToStates in one synchronous run — past the bridge's 400 burst and its abuse close.
    expect(page.mts()).toHaveLength(1 + MovementSync.MOVE_TO_STATE_REPEATS);
    expect(page.sync.moveToStateRepeatsDropped).toBe(100 - 1 - MovementSync.MOVE_TO_STATE_REPEATS);
  });

  it('the same burst straight at the camera (Stop Moving × 600, no agent in between) is capped too', () => {
    const page = wiredPage();
    for (let i = 0; i < 600; i++) page.cam.stopMoving();
    expect(page.mts()).toHaveLength(1 + MovementSync.MOVE_TO_STATE_REPEATS);
  });

  it('a walk started and cancelled over and over sends only the key changes, never a release of a key not held', () => {
    const page = wiredPage();
    const host = new CameraHost(page.cam);
    const api = new AgentApi(host);
    for (let i = 0; i < 50; i++) { void api.walkTo('10m north', { within: 1 }); page.advance(1); }
    api.stopMoving();
    // The walks never ticked (no key went down): only the final Stop Moving's own event goes out.
    expect(page.mts().length).toBeLessThanOrEqual(1);
  });
});

describe('the coalescing keeps every genuine state change (the inverse)', () => {
  it('press / release / turn / strafe / run toggle each send, even in one synchronous run', () => {
    const { cam, mts, sync } = wiredPage();
    cam.simulateKeyDown('KeyW');
    cam.simulateKeyDown('KeyA');
    cam.simulateKeyUp('KeyA');
    cam.simulateKeyDown('KeyZ');
    cam.simulateKeyUp('KeyZ');
    cam.toggleAutoRun();
    cam.toggleAutoRun();
    cam.simulateKeyUp('KeyW');
    // Each event leaves a different raw motion state: eight events, eight MoveToStates.
    expect(mts()).toHaveLength(8);
    expect(sync.moveToStateRepeatsDropped).toBe(0);
  });

  it('stop, start, stop again in the same millisecond: every event goes (retail sends one per input event)', () => {
    const { cam, mts } = wiredPage();
    cam.stopMoving();
    cam.simulateKeyDown('KeyW');
    cam.simulateKeyUp('KeyW');
    cam.stopMoving();
    // stop, W down, W up, stop: the last repeats W-up's state, as retail's would (a repeat under the cap).
    expect(mts()).toHaveLength(4);
  });

  it('W held, S on top, W let go: the unchanged third MoveToState still goes (retail A/B)', () => {
    const { cam, mts } = wiredPage();
    cam.simulateKeyDown('KeyW');
    cam.simulateKeyDown('KeyS');
    cam.simulateKeyUp('KeyW');
    const m = mts();
    expect(m).toHaveLength(3);
    expect(m[1]!.kind === 'moveToState' && m[1]!.bytes).toBe(m[2]!.kind === 'moveToState' && m[2]!.bytes);
  });

  const capped = 1 + MovementSync.MOVE_TO_STATE_REPEATS;

  it('an identical MoveToState after another action (a Use, an attack) still goes: it cancels the server MoveTo that action began', () => {
    const { cam, mts, otherAction } = wiredPage();
    for (let i = 0; i < 10; i++) cam.stopMoving();
    expect(mts()).toHaveLength(capped);
    otherAction();
    cam.stopMoving();
    expect(mts()).toHaveLength(capped + 1);
  });

  it('an identical MoveToState after the repeat window goes again (a later Stop Moving press)', () => {
    const page = wiredPage();
    for (let i = 0; i < 10; i++) page.cam.stopMoving();
    page.advance(MovementSync.MOVE_TO_STATE_REPEAT_MS + 1);
    page.cam.stopMoving();
    expect(page.mts()).toHaveLength(capped + 1);
  });

  it('an AutonomousPosition between identical MoveToStates ends the run (no peek: MovementSync\'s own sends)', () => {
    const page = wiredPage({ peek: false });
    for (let i = 0; i < 10; i++) page.cam.stopMoving();
    page.sync.sendAutonomousPositionNow(POS, 1000);
    page.cam.stopMoving();
    expect(page.mts()).toHaveLength(capped + 1);
  });

  it('a soul emote is never dropped as a repeat (each carries its own motion sequence)', () => {
    const { sync, mts } = wiredPage();
    for (let i = 0; i < 10; i++) sync.sendSoulEmoteMotion(0x13000087, POS, true);
    expect(mts()).toHaveLength(10);
  });

  it('a key released that is held still sends (a release of a key down is an input event)', () => {
    const { cam, mts } = wiredPage();
    cam.simulateKeyDown('KeyD');
    cam.simulateKeyUp('KeyD');
    cam.simulateKeyUp('KeyD'); // already up: nothing
    expect(mts()).toHaveLength(2);
  });
});

describe('the MoveToState budget (a state that changes every frame)', () => {
  it('W pressed and let go 1000 times in one second sends at most the budget, then the newest state once the window frees', () => {
    const page = wiredPage();
    for (let i = 0; i < 1000; i++) {
      page.cam.simulateKeyDown('KeyW');
      page.cam.simulateKeyUp('KeyW');
      if (i % 4 === 0) page.advance(1);
    }
    page.cam.simulateKeyDown('KeyW');
    page.cam.simulateKeyUp('KeyW'); // the last event, inside a full window: held
    // Before the budget: 2000 MoveToStates (each differs from the one before, so no repeat cap applies).
    expect(page.mts().length).toBeLessThanOrEqual(MovementSync.MOVE_TO_STATE_BUDGET * 2);
    expect(page.sync.moveToStatesHeld).toBeGreaterThan(1000);
    // The window frees: the next frame's update sends the held newest state (W up: stopped).
    page.advance(MovementSync.MOVE_TO_STATE_BUDGET_MS);
    const before = page.mts().length;
    page.sync.update(stateOf(page.cam), POS, 1000 + 250 + MovementSync.MOVE_TO_STATE_BUDGET_MS);
    const after = page.mts();
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1]!;
    const stopped = wiredPage();
    stopped.cam.stopMoving();
    // Same raw motion state as a plain stop (position fields identical in these fixtures).
    expect(last.kind === 'moveToState' && last.bytes).toBe(stopped.mts()[0]!.kind === 'moveToState' && stopped.mts()[0]!.bytes);
  });

  it('ordinary input never reaches it: a burst of 15 different key events in one frame all go', () => {
    const { cam, mts, sync } = wiredPage();
    for (const k of ['KeyW', 'KeyA', 'KeyZ', 'KeyD', 'KeyC', 'KeyS']) cam.simulateKeyDown(k);
    for (const k of ['KeyW', 'KeyA', 'KeyZ', 'KeyD', 'KeyC', 'KeyS']) cam.simulateKeyUp(k);
    cam.toggleAutoRun(); cam.toggleAutoRun(); cam.stopMoving();
    expect(sync.moveToStatesHeld).toBe(0);
    expect(mts().length).toBeGreaterThanOrEqual(13);
  });
});

describe('SendPacer (every connection\'s outgoing game messages)', () => {
  function pacer() {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const p = new SendPacer({ now: () => t, setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; }, clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); } });
    const advance = (ms: number) => {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    };
    return { p, advance };
  }

  it('a normal run of sends goes at once', () => {
    const { p } = pacer();
    const out: number[] = [];
    for (let i = 0; i < 40; i++) p.submit(() => out.push(i));
    expect(out).toHaveLength(40);
    expect(p.deferred).toBe(0);
  });

  it('a burst past the bridge\'s limit is held and sent in order, never more than the bridge takes (200/s, burst 400)', () => {
    const { p, advance } = pacer();
    const out: number[] = [];
    for (let i = 0; i < 700; i++) p.submit(() => out.push(i));
    expect(out).toHaveLength(SendPacer.BURST);
    expect(SendPacer.BURST).toBeLessThan(400);
    expect(SendPacer.RATE_PER_SEC).toBeLessThan(200);
    // No 10 s window sends more than the bridge's bucket allows.
    advance(1000);
    expect(out.length).toBeLessThanOrEqual(SendPacer.BURST + SendPacer.RATE_PER_SEC + 1);
    advance(10_000);
    expect(out).toHaveLength(700);
    expect(out).toEqual([...out].sort((a, b) => a - b));
    // A send after the queue drained goes at once again.
    p.submit(() => out.push(700));
    expect(out).toHaveLength(701);
  });

  it('a send while others wait queues behind them (order holds)', () => {
    const { p, advance } = pacer();
    const out: string[] = [];
    for (let i = 0; i < SendPacer.BURST + 2; i++) p.submit(() => out.push(`a${i}`));
    p.submit(() => out.push('late'));
    advance(5000);
    expect(out[out.length - 1]).toBe('late');
  });

  it('clear() drops what waits (a new session\'s sequencing)', () => {
    const { p, advance } = pacer();
    const out: number[] = [];
    for (let i = 0; i < SendPacer.BURST + 10; i++) p.submit(() => out.push(i));
    p.clear();
    advance(5000);
    expect(out).toHaveLength(SendPacer.BURST);
    expect(p.pending).toBe(0);
  });
});
