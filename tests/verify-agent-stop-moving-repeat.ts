/**
 * BUG.agent-stop-moving-repeat (playwebac.com 2026-11-20 09:48Z, Classic Dereth, build 7b81a1bd1, a tab with Claude on):
 * `move_limiter limiter="repeat" recent=4 fields=["forward","movementEvent"]
 * sources=[key_up, key_down, key_up, stop_moving ×5] agent=true`. The agent's stops (AgentApi.stopMoving) always ran
 * retail's Stop Moving (CameraController.stopMoving → one movement event → one MoveToState), whether or not anything
 * was moving, and the agent stops from several places at once: a player takeover stops Claude AND pauses its routine
 * (whose pause stops again), `/automation pause` the same, a routine's recall / stop rule, Claude's own ac_stop_moving.
 * Five identical standing MoveToStates went out inside 500 ms and the outgoing repeat cap dropped the copies.
 *
 * Driven through the real pieces main.ts wires: AgentApi on a host whose keys and Stop Moving are the real
 * CameraController, each movement event sent by the real MovementSync (with the shared action counter's peek), and the
 * host's stopMovingNeeded built with the real agentStopMovingNeeded over MovementSync.standingStopSent, as main.ts does.
 * The MoveToState, the command interpreter and the agent API are shared code: the behaviour is the same in end of
 * retail, Dark Majesty (classic) and AC1999.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AgentApi, agentStopMovingNeeded } from '../packages/renderer/src/agent/AgentApi.ts';
import { ClaudeControl } from '../packages/renderer/src/agent/claudeControl.ts';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { decodeMessage } from '../tools/lib/ac-wire.ts';
import { FakeHost } from './_harness/agentFake.ts';

const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const stateOf = (c: CameraController): MovementState => ({
  forward: c.isMovingForward, backward: c.isMovingBackward, turnLeft: c.isTurningLeft, turnRight: c.isTurningRight,
  strafeLeft: c.isStrafingLeft, strafeRight: c.isStrafingRight, running: c.isRunning, forwardHoldRun: c.rawForwardHoldRun,
  runToggle: c.runToggle, serverControlled: c.controlledByServer, movementEvent: c.movementEvents,
});

function wiredPage() {
  const sent: Uint8Array[] = [];
  let seq = 0;
  const conn = { sendMessage: (b: Uint8Array) => { sent.push(b); } };
  const sync = new MovementSync(conn as never, () => ++seq, () => seq);
  const limiter: string[] = [];
  sync.onLimiter = (kind) => { limiter.push(kind); };
  const cam = new CameraController(new THREE.PerspectiveCamera());
  const clock = 1000;
  cam.onMovementEvent = () => sync.sendMovementEventNow(stateOf(cam), POS, clock);
  /** Another game action through the same counter (a Use, whose server MoveTo a stop then cancels). */
  const otherAction = () => { seq++; sent.push(new Uint8Array([0xb1, 0xf7, 0, 0])); };
  const mts = () => sent.map((b) => decodeMessage(b)).filter((a) => a?.kind === 'moveToState');
  return { sync, cam, mts, otherAction, limiter };
}

/** main.ts's agent host: keys → the camera, stopMovingAction → Stop Moving, stopMovingNeeded → agentStopMovingNeeded. */
class PageHost extends FakeHost {
  attackRunning = false;
  heldSubstate = 0;
  constructor(private readonly page: ReturnType<typeof wiredPage>) { super(); }
  override key = (code: string, down: boolean) => {
    if (down) this.keys.add(code); else this.keys.delete(code);
    if (down) this.page.cam.simulateKeyDown(code, 'agent'); else this.page.cam.simulateKeyUp(code, 'agent');
  };
  stopMovingAction = () => this.page.cam.stopMoving('agent');
  stopMovingNeeded = () => agentStopMovingNeeded({
    standingStopSent: this.page.sync.standingStopSent,
    autoRun: this.page.cam.autoRun,
    controlledByServer: this.page.cam.controlledByServer,
    attackPending: this.attackRunning,
    heldSubstate: this.heldSubstate,
  });
}

describe('an agent stop with nothing moving sends no further MoveToState (every era)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the 2026-11-20 shape: a walk\'s key down / up, then five agent stops: W up already told the server you stand, so none goes and the repeat cap never engages', async () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    const walk = api.move('forward', 0.2);
    expect(page.mts()).toHaveLength(1); // W down
    await vi.advanceTimersByTimeAsync(250);
    await walk;
    expect(page.mts()).toHaveLength(2); // W up: standing
    for (let i = 0; i < 5; i++) api.stopMoving();
    // Before the fix: 2 + 3 sent copies, the 4th and 5th dropped and limiter "repeat" reported.
    expect(page.mts()).toHaveLength(2);
    expect(page.sync.moveToStateRepeatsDropped).toBe(0);
    expect(page.limiter).toEqual([]);
  });

  it('a player takeover (Claude\'s stop + its routine pause\'s stop) sends one stop, not two', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    // main.ts: stopMoving → the relay surface's stopMoving; pauseRoutine → RoutineEngine.pause, which stops again.
    const control = new ClaudeControl({ stopMoving: () => { api.stopMoving(); }, pauseRoutine: () => { api.stopMoving(); }, say: () => {} });
    control.claudeRoutine = true;
    expect(control.gate('walkTo')).toBeNull();
    control.playerInput();
    expect(control.control).toBe('player');
    expect(page.mts()).toHaveLength(1);
    // /automation pause later: both stops again, nothing moving: nothing sent.
    control.pause();
    expect(page.mts()).toHaveLength(1);
  });

  it('a hundred agent stops while standing still send exactly one MoveToState', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    for (let i = 0; i < 100; i++) expect(api.stopMoving().ok).toBe(true);
    expect(page.mts()).toHaveLength(1);
    expect(page.limiter).toEqual([]);
    // OBS.stop-moving-input-source: the one stop that ran is named the agent's, not the player's Stop Moving key.
    expect(page.cam.recentMovementEventSources).toEqual(['agent_stop_moving']);
  });

  it('standingStopSent: false before any MoveToState, after a moving one, and once another action went out', () => {
    const page = wiredPage();
    expect(page.sync.standingStopSent).toBe(false);
    page.cam.simulateKeyDown('KeyW');
    expect(page.sync.standingStopSent).toBe(false);
    page.cam.simulateKeyUp('KeyW');
    expect(page.sync.standingStopSent).toBe(true);
    page.otherAction();
    expect(page.sync.standingStopSent).toBe(false);
    page.cam.stopMoving();
    expect(page.sync.standingStopSent).toBe(true);
    page.sync.sendAutonomousPositionNow(POS, 1000);
    expect(page.sync.standingStopSent).toBe(false);
  });

  it('without the action counter\'s peek it can\'t tell, and the stop always goes (as before)', () => {
    const sync = new MovementSync({ sendMessage: () => {} } as never, () => 1);
    const cam = new CameraController(new THREE.PerspectiveCamera());
    cam.onMovementEvent = () => sync.sendMovementEventNow(stateOf(cam), POS, 1000);
    cam.stopMoving();
    expect(sync.standingStopSent).toBe(false);
  });
});

describe('the inverse: a stop that changes something still goes at once', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the agent holding W (a move under way): the release and the stop both go, and the body stops', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    page.cam.stopMoving(); // already standing as far as the server knows
    void api.move('forward', 5);
    expect(page.cam.isMovingForward).toBe(true);
    const before = page.mts().length;
    api.stopMoving();
    expect(page.cam.isMovingForward).toBe(false);
    expect(page.mts().length).toBe(before + 2); // W up + Stop Moving
  });

  it('autorun on: the agent\'s stop ends it', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    page.cam.stopMoving();
    page.cam.toggleAutoRun();
    expect(page.cam.autoRun).toBe(true);
    const before = page.mts().length;
    api.stopMoving();
    expect(page.cam.autoRun).toBe(false);
    expect(page.mts().length).toBe(before + 1);
  });

  it('a Use (another action) went out since the standing stop: the stop goes, cancelling the server MoveTo it began', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    api.stopMoving();
    page.otherAction();
    api.stopMoving();
    expect(page.mts()).toHaveLength(2);
  });

  it('the server has control (its MoveTo under way): the stop takes it back', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    api.stopMoving();
    page.cam.loseControlToServer();
    api.stopMoving();
    expect(page.cam.controlledByServer).toBe(false);
    expect(page.mts()).toHaveLength(2);
  });

  it('an attack of ours still running, or a held posture (Sit): the stop goes', () => {
    const page = wiredPage();
    const host = new PageHost(page);
    const api = new AgentApi(host);
    api.stopMoving();
    host.attackRunning = true;
    api.stopMoving();
    expect(page.mts()).toHaveLength(2);
    host.attackRunning = false;
    host.heldSubstate = 0x41000012; // Crouch
    // The repeat run's own copies: the posture stop is still sent (under the cap).
    api.stopMoving();
    expect(page.mts()).toHaveLength(3);
  });

  it('a player\'s own Stop Moving presses are untouched: each sends (retail ACCmdInterp case 0x2b), up to the repeat cap', () => {
    const page = wiredPage();
    for (let i = 0; i < 3; i++) page.cam.stopMoving();
    expect(page.mts()).toHaveLength(3);
  });

  it('agentStopMovingNeeded: only a standing stop already sent with nothing else on says "no"', () => {
    const idle = { standingStopSent: true, autoRun: false, controlledByServer: false, attackPending: false, heldSubstate: 0 };
    expect(agentStopMovingNeeded(idle)).toBe(false);
    expect(agentStopMovingNeeded({ ...idle, standingStopSent: false })).toBe(true);
    expect(agentStopMovingNeeded({ ...idle, autoRun: true })).toBe(true);
    expect(agentStopMovingNeeded({ ...idle, controlledByServer: true })).toBe(true);
    expect(agentStopMovingNeeded({ ...idle, attackPending: true })).toBe(true);
    expect(agentStopMovingNeeded({ ...idle, heldSubstate: 0x41000012 })).toBe(true);
  });

  it('a host that can\'t say (no stopMovingNeeded) still sends every stop, as before: the 2026-11-20 limiter event', () => {
    const page = wiredPage();
    const host = new PageHost(page);
    (host as unknown as { stopMovingNeeded?: unknown }).stopMovingNeeded = undefined;
    const api = new AgentApi(host);
    page.cam.simulateKeyDown('KeyW');
    page.cam.simulateKeyUp('KeyW');
    for (let i = 0; i < 5; i++) api.stopMoving();
    // The pre-fix shape: W down, W up, then 3 copies sent and 2 dropped, limiter "repeat".
    expect(page.mts()).toHaveLength(2 + MovementSync.MOVE_TO_STATE_REPEATS);
    expect(page.sync.moveToStateRepeatsDropped).toBe(5 - MovementSync.MOVE_TO_STATE_REPEATS);
    expect(page.limiter).toEqual(['repeat']);
  });
});
