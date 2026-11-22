/**
 * BUG.agent-stop-moving-shift-held (playwebac.com 2026-11-21, Classic Dereth, build 2128f407f, a tab with Claude on), after
 * BUG.agent-stop-moving-repeat (5d2ec7bb4) shipped: `move_limiter limiter="repeat" recent=4 fields=["forward","movementEvent"]
 * origins=["event"×6] sources=[key_up, key_down, key_up, stop_moving ×5] agent=true`. Six sends: key_up, key_down, key_up
 * and three identical standing stops; the fourth stop was dropped by the repeat cap (3).
 *
 * Root cause: AgentApi.stopMoving's "something of the agent's own under way" test counted ANY key the agent held
 * (agentKeys.size > 0), and Shift / Space are agent keys that stop_moving never lets go of (it releases W S A D Z C).
 * The portal sentinel presses Shift to make the agent's run a walk near a portal and let go of it only when it vetoed
 * the move outright, so after an ac_move forward near a portal (key_down W, key_up W) Shift stayed down for good: every
 * later agent stop was "own" and went out whether or not anything moved (and the player's own W walked). A UB
 * `setmotion Walk` hold and a jump's Space charge did the same while they lasted.
 *
 * Fix (the 5d2ec7bb4 guard, extended): only a movement key the agent holds counts (AgentApi.STOP_RELEASES, the keys the
 * stop lets go of), and the sentinel's Shift goes when the last movement key it paced is let go of.
 *
 * Driven through the real pieces main.ts wires (as verify-agent-stop-moving-repeat.ts): AgentApi on a host whose keys
 * and Stop Moving are the real CameraController, each movement event sent by the real MovementSync, stopMovingNeeded
 * built with the real agentStopMovingNeeded. Shared code: the same in end of retail, Dark Majesty and AC1999.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AgentApi, agentStopMovingNeeded, compassToYaw } from '../packages/renderer/src/agent/AgentApi.ts';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { decodeMessage } from '../tools/lib/ac-wire.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const stateOf = (c: CameraController): MovementState => ({
  forward: c.isMovingForward, backward: c.isMovingBackward, turnLeft: c.isTurningLeft, turnRight: c.isTurningRight,
  strafeLeft: c.isStrafingLeft, strafeRight: c.isStrafingRight, running: c.isRunning, forwardHoldRun: c.rawForwardHoldRun,
  runToggle: c.runToggle, serverControlled: c.controlledByServer, movementEvent: c.movementEvents,
});

function wiredPage() {
  const sent: Uint8Array[] = [];
  let seq = 0;
  const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as never, () => ++seq, () => seq);
  const limiter: string[] = [];
  sync.onLimiter = (kind) => { limiter.push(kind); };
  const cam = new CameraController(new THREE.PerspectiveCamera());
  cam.onMovementEvent = () => sync.sendMovementEventNow(stateOf(cam), POS, 1000);
  const mts = () => sent.map((b) => decodeMessage(b)).filter((a) => a?.kind === 'moveToState');
  return { sync, cam, mts, limiter };
}

/** main.ts's agent host: keys → the camera, stopMovingAction → Stop Moving, stopMovingNeeded → agentStopMovingNeeded. */
class PageHost extends FakeHost {
  constructor(private readonly page: ReturnType<typeof wiredPage>) { super(); }
  override key = (code: string, down: boolean) => {
    if (down) this.keys.add(code); else this.keys.delete(code);
    if (down) this.page.cam.simulateKeyDown(code); else this.page.cam.simulateKeyUp(code);
  };
  stopMovingAction = () => this.page.cam.stopMoving();
  stopMovingNeeded = () => agentStopMovingNeeded({
    standingStopSent: this.page.sync.standingStopSent, autoRun: this.page.cam.autoRun,
    controlledByServer: this.page.cam.controlledByServer, attackPending: false, heldSubstate: 0,
  });
}

describe('agent stops after a held Shift / Space: no repeated standing MoveToState (every era)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the 2026-11-21 shape: Shift held (walk pace), ac_move forward (key_down, key_up), five stops: nothing more goes, no limiter', async () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    api.holdMotion('walk', true); // UB setmotion Walk: Shift down, no movement event
    const walk = api.move('forward', 0.2);
    await vi.advanceTimersByTimeAsync(250);
    await walk;
    expect(page.mts()).toHaveLength(2); // W down, W up (standing)
    for (let i = 0; i < 5; i++) api.stopMoving();
    // Before the fix: 2 + 3 identical stops, the rest dropped and limiter "repeat" reported.
    expect(page.mts()).toHaveLength(2);
    expect(page.sync.moveToStateRepeatsDropped).toBe(0);
    expect(page.limiter).toEqual([]);
    // stop_moving leaves a deliberate Shift hold alone (it lets go of movement keys only).
    expect(page.cam.isRunning).toBe(false);
  });

  it('a jump\'s Space charge held: the first stop goes (nothing told the server yet), the next four do not', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    api.jump({ holdMs: 1000 });
    for (let i = 0; i < 5; i++) api.stopMoving();
    expect(page.mts()).toHaveLength(1); // before: 4 sent, the 5th dropped
    expect(page.limiter).toEqual([]);
  });

  it('the key_up arriving after the stops (ac_move\'s timer lets go of a key the stop already released): nothing more goes', async () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    const walk = api.move('forward', 0.5);
    api.stopMoving(); // W up + Stop Moving: the first stop while moving goes at once
    expect(page.mts()).toHaveLength(3);
    api.stopMoving();
    await vi.advanceTimersByTimeAsync(600);
    await walk;
    for (let i = 0; i < 3; i++) api.stopMoving();
    expect(page.mts()).toHaveLength(3);
    expect(page.limiter).toEqual([]);
  });

  it('forward held by the player\'s own key: the agent\'s first stop stops it, the rest send nothing', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    page.cam.simulateKeyDown('KeyW');
    expect(page.cam.isMovingForward).toBe(true);
    for (let i = 0; i < 5; i++) api.stopMoving();
    expect(page.cam.isMovingForward).toBe(false);
    expect(page.mts()).toHaveLength(2); // W down, one stop
  });
});

describe('the inverse: a stop that changes something still goes at once', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('walking (Shift + W held by the agent): the release and the stop both go, and the body stops', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    api.holdMotion('walk', true);
    void api.move('forward', 5);
    expect(page.cam.isMovingForward).toBe(true);
    const before = page.mts().length;
    api.stopMoving();
    expect(page.cam.isMovingForward).toBe(false);
    expect(page.mts().length).toBe(before + 2);
  });

  it('turning by key (A held by the agent): the stop lets go and goes', () => {
    const page = wiredPage();
    const api = new AgentApi(new PageHost(page));
    page.cam.stopMoving();
    void api.move('turn_left', 5);
    expect(page.cam.isTurningLeft).toBe(true);
    const before = page.mts().length;
    api.stopMoving();
    expect(page.cam.isTurningLeft).toBe(false);
    expect(page.mts().length).toBe(before + 2); // A up + Stop Moving
  });

  it('a player\'s own Stop Moving presses still each send (retail ACCmdInterp case 0x2b), Shift held or not', () => {
    const page = wiredPage();
    page.cam.simulateKeyDown('ShiftLeft');
    for (let i = 0; i < 3; i++) page.cam.stopMoving();
    expect(page.mts()).toHaveLength(3);
  });
});

describe('the portal sentinel\'s walk-pace Shift lasts only as long as the movement it paced', () => {
  let host: FakeHost;
  let api: AgentApi;
  const PORTAL = 0x7a9b3000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    // A portal 7 m ahead, the page looking every 300 ms: a run's stride (4.4 m a look, and its 1.29 m stop coast) would
    // touch it (2.4 m); a walk's (1.06 m), after the Run → Walk link the switch starts (2.16 m) and the walk's stop
    // (0.41 m), not. (BUG.agent-sentinel-first-approach: a nearer portal is let go of, not walked toward.)
    host.add({ guid: PORTAL, name: 'Drudge Hideout', itemType: 0x10000, objectDescFlags: 0x40000, cell: host.me.cell, x: 80, y: 27, z: 94 });
    host.objectReach = (g) => (g === PORTAL ? 1.919 : 0);
    host.me.yaw = compassToYaw(0);
    api = new AgentApi(host);
    for (let i = 0; i < 4; i++) { host.t += 300; api.tick(); }
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('ac_move forward toward it walks (Shift), and when the move lets go of W, Shift goes too', async () => {
    const p = api.move('forward', 0.1);
    expect(host.keys.has('KeyW')).toBe(true);
    expect(host.keys.has('ShiftLeft')).toBe(true); // the sentinel made the run a walk
    run(api, host, 200);
    await p;
    expect(host.keys.has('KeyW')).toBe(false);
    // Before the fix Shift stayed down: the player's own W walked and every agent stop counted as "own".
    expect(host.keys.has('ShiftLeft')).toBe(false);
    expect(api.agentRunning()).toBe(true); // (the fake host has an agent attached)
  });

  it('a Shift the agent pressed itself (setmotion Walk) is not taken by the sentinel\'s release', async () => {
    api.holdMotion('walk', true);
    const p = api.move('forward', 0.1);
    run(api, host, 200);
    await p;
    expect(host.keys.has('ShiftLeft')).toBe(true);
  });
});
