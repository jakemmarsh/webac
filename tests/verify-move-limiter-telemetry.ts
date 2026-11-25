/**
 * BUG.movetostate-burst-abuse-close — the move_limiter client_world event: the first time in a world session that an
 * outgoing limiter engages (MovementSync's budget / repeat cap, the connection's SendPacer), one event says what was
 * sending (fields that kept changing, the sending paths, the movement-event inputs, fps, the routine running). Driven
 * through the real CameraController → MovementSync wiring (as main.ts) into the real MoveLimiterReporter, and the
 * bridge's sanitizer for the line it logs.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { MoveLimiterReporter, type MoveLimiterEvent } from '../packages/renderer/src/telemetry/MoveLimiterReporter.ts';
import { isMoveLimiterOutcome, sanitizeClientMoveLimiter, MOVEMENT_EVENT_SOURCES as BRIDGE_MOVEMENT_EVENT_SOURCES } from '../services/ws-tcp-bridge/src/clientWorld.ts';
import { MOVEMENT_EVENT_SOURCES } from '../packages/renderer/src/scene/CameraController.js';
import { dispatchGameAction, type ActionHost, type ActionInput } from '../packages/renderer/src/input/ActionDispatch.js';
import { routeGameKeyDown } from '../packages/renderer/src/input/GameKeyDown.js';
import { ACT } from '../packages/renderer/src/input/KeybindDefaults.js';
import { loadDomWindow, restoreDomGlobals } from './_harness/dom.js';

const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const stateOf = (c: CameraController): MovementState => ({
  forward: c.isMovingForward, backward: c.isMovingBackward, turnLeft: c.isTurningLeft, turnRight: c.isTurningRight,
  strafeLeft: c.isStrafingLeft, strafeRight: c.isStrafingRight, running: c.isRunning, forwardHoldRun: c.rawForwardHoldRun,
  runToggle: c.runToggle, serverControlled: c.controlledByServer, movementEvent: c.movementEvents,
});

function page() {
  const posted: MoveLimiterEvent[] = [];
  let seq = 0;
  let clock = 1000;
  const sync = new MovementSync({ sendMessage: () => {} } as never, () => ++seq, () => seq);
  const cam = new CameraController(new THREE.PerspectiveCamera());
  cam.onMovementEvent = () => sync.sendMovementEventNow(stateOf(cam), POS, clock);
  const reporter = new MoveLimiterReporter({
    endpoint: 'https://bridge.example/__client', build: 'test', trace: 'abcdef0123456789', era: () => 'classic-dereth-1-0', server: () => null,
    context: () => ({ sources: cam.recentMovementEventSources, fps: 431, routine: { driver: 'agent', kind: 'macro' }, txPaced: 0 }),
    now: () => clock,
    send: (_url, body) => { posted.push(JSON.parse(body) as MoveLimiterEvent); },
  });
  sync.onLimiter = (kind, snap) => { reporter.engage(kind, snap); };
  return { sync, cam, reporter, posted, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe('move_limiter: one event the first time a limiter engages in a session', () => {
  it('a state changing on every event (W down / up) engages the budget: one event naming the fields, paths and inputs', () => {
    const p = page();
    for (let i = 0; i < 400; i++) { p.cam.simulateKeyDown('KeyW'); p.cam.simulateKeyUp('KeyW'); if (i % 4 === 0) p.advance(1); }
    expect(p.posted).toHaveLength(1);
    const ev = p.posted[0];
    expect(ev).toMatchObject({ outcome: 'move_limiter', limiter: 'budget', recent: MovementSync.MOVE_TO_STATE_BUDGET, era: 'classic-dereth-1-0', fps: 431, driver: 'agent', kind: 'macro', txPaced: 0 });
    expect(ev.fields).toEqual(expect.arrayContaining(['forward', 'movementEvent']));
    expect(ev.fields).not.toContain('turnSpeed');
    expect(new Set(ev.origins)).toEqual(new Set(['event']));
    expect(new Set(ev.sources)).toEqual(new Set(['key_down', 'key_up']));
    expect(p.sync.moveToStatesHeld).toBeGreaterThan(100); // held on, reported once
    // The bridge keeps every field (closed vocabularies) and logs it as a client_world line.
    expect(isMoveLimiterOutcome(ev.outcome)).toBe(true);
    const clean = sanitizeClientMoveLimiter({ ...ev, eid: '0123456789ab' })!;
    expect(clean).toMatchObject({ outcome: 'move_limiter', limiter: 'budget', fields: ev.fields, origins: ev.origins, sources: ev.sources, fps: 431, driver: 'agent', kind: 'macro' });
  });

  it('a run of identical stops engages the repeat cap first: limiter repeat, no fields changing but the event count', () => {
    const p = page();
    for (let i = 0; i < 20; i++) p.cam.stopMoving();
    expect(p.posted).toHaveLength(1);
    expect(p.posted[0].limiter).toBe('repeat');
    expect(p.posted[0].fields).toEqual(['movementEvent']);
    expect(new Set(p.posted[0].sources)).toEqual(new Set(['stop_moving']));
  });

  it('once per session: a new world session reports again', () => {
    const p = page();
    for (let i = 0; i < 20; i++) p.cam.stopMoving();
    for (let i = 0; i < 400; i++) { p.cam.simulateKeyDown('KeyW'); p.cam.simulateKeyUp('KeyW'); }
    expect(p.posted).toHaveLength(1);
    // MovementSync is made anew for each world session (main.ts); the reporter starts a session on world entry.
    p.reporter.sessionStarted();
    expect(p.reporter.engage('pacer', { recent: 3, fields: [], origins: ['event'] })).toBe(true);
    expect(p.posted).toHaveLength(2);
    expect(p.posted[1].limiter).toBe('pacer');
  });

  it('never in normal play: two minutes of walking, turning, strafing, autorun and stops at 60 fps', () => {
    const p = page();
    const keys = ['KeyW', 'KeyA', 'KeyD', 'KeyZ', 'KeyC', 'KeyS'];
    for (let f = 0; f < 120 * 60; f++) {
      p.advance(16);
      if (f % 20 === 0) { const k = keys[(f / 20) % keys.length]; p.cam.simulateKeyDown(k); }
      if (f % 20 === 10) { const k = keys[((f - 10) / 20) % keys.length]; p.cam.simulateKeyUp(k); }
      if (f % 300 === 0) p.cam.toggleAutoRun();
      if (f % 450 === 0) p.cam.stopMoving();
      p.sync.update(stateOf(p.cam), POS, p.now());
    }
    expect(p.posted).toHaveLength(0);
    expect(p.reporter.engaged).toBe(0);
    expect(p.sync.moveToStatesSent).toBeGreaterThan(500);
  });

  it('keys the agent API pressed (a macro, Claude) are named apart from the player\'s own (BUG.macro-loot-rights-loop)', () => {
    const p = page();
    // The agent host's key() → simulateKeyDown / Up with 'agent' (main.ts); the player's own stay key_down / key_up.
    for (let i = 0; i < 400; i++) { p.cam.simulateKeyDown('KeyW', 'agent'); p.cam.simulateKeyUp('KeyW', 'agent'); if (i % 4 === 0) p.advance(1); }
    p.cam.simulateKeyDown('KeyA'); p.cam.simulateKeyUp('KeyA');
    expect(p.posted).toHaveLength(1);
    expect(new Set(p.posted[0].sources)).toEqual(new Set(['agent_key_down', 'agent_key_up']));
    expect(p.cam.recentMovementEventSources.slice(-2)).toEqual(['key_down', 'key_up']);
    // The bridge keeps the new values, and still the old ones from an older client.
    const clean = sanitizeClientMoveLimiter({ ...p.posted[0], eid: '0123456789ab' })!;
    expect(new Set(clean.sources)).toEqual(new Set(['agent_key_down', 'agent_key_up']));
    expect(sanitizeClientMoveLimiter({ outcome: 'move_limiter', sources: ['key_down', 'key_up', 'agent_key_up'] })!.sources).toEqual(['key_down', 'key_up', 'agent_key_up']);
  });

  it('the bridge drops anything outside the vocabularies (no free text reaches the log)', () => {
    const clean = sanitizeClientMoveLimiter({
      outcome: 'move_limiter', era: 'classic-dereth-1-0', trace: 'abcdef0123456789', build: 'x', limiter: 'nonsense',
      recent: -4, fields: ['forward', 'Claude Arcanist', 7], origins: ['event', 'rm -rf'], sources: ['key_up', '<script>'], fps: 'fast', driver: 'bot', kind: 'macro',
    })!;
    expect(clean).toMatchObject({ limiter: null, recent: null, fields: ['forward'], origins: ['event'], sources: ['key_up'], fps: null, driver: null, kind: 'macro' });
    expect(sanitizeClientMoveLimiter({ outcome: 'portal_used' })).toBeNull();
  });
});

/** dispatchGameAction's host as main.ts builds it, with only the camera real (Stop Moving touches nothing else). */
const hostFor = (cam: CameraController): ActionHost => ({ ui: {}, camera: cam, emoteMotion: () => undefined } as unknown as ActionHost);

describe('OBS.stop-moving-input-source: Stop Moving is named by the input that ran it', () => {
  it('the 2026-11-25 shape (trace 330560b65d77850b): a run of stops from a bound mouse control engages the repeat cap and says so', () => {
    const p = page();
    // main.ts mouseControlHandler → dispatchAction(id, 'mouse') → dispatchGameAction → camera.stopMoving('mouse').
    for (let i = 0; i < 20; i++) expect(dispatchGameAction(ACT.StopMoving, hostFor(p.cam), 'mouse')).toBe(true);
    expect(p.posted).toHaveLength(1);
    expect(p.posted[0].limiter).toBe('repeat');
    expect(new Set(p.posted[0].sources)).toEqual(new Set(['mouse_stop_moving']));
    const clean = sanitizeClientMoveLimiter({ ...p.posted[0], eid: '0123456789ab' })!;
    expect(new Set(clean.sources)).toEqual(new Set(['mouse_stop_moving']));
  });

  it('each input reads apart: the keyboard stays stop_moving; mouse, UI, synthetic and agent each have their own', () => {
    const p = page();
    const inputs: ActionInput[] = ['key', 'mouse', 'ui', 'synthetic'];
    for (const input of inputs) dispatchGameAction(ACT.StopMoving, hostFor(p.cam), input);
    dispatchGameAction(ACT.StopMoving, hostFor(p.cam)); // no input given: a key (the old call shape)
    p.cam.stopMoving('agent'); // main.ts AgentHost.stopMovingAction
    p.cam.stopMoving(); // the default stays the keyboard's
    expect(p.cam.recentMovementEventSources).toEqual([
      'stop_moving', 'mouse_stop_moving', 'ui_stop_moving', 'synthetic_stop_moving', 'stop_moving', 'agent_stop_moving', 'stop_moving',
    ]);
  });

  it('the keyboard route: a trusted press dispatches as a key, an untrusted one as synthetic, an OS repeat not at all', () => {
    const cam = new CameraController(new THREE.PerspectiveCamera());
    // main.ts's document keydown listener: routeGameKeyDown with dispatch → dispatchAction(id, e.isTrusted ? 'key' : 'synthetic').
    const route = (e: { code: string; repeat: boolean; isTrusted: boolean }) => routeGameKeyDown(e, {
      textFocused: () => false, automationHotkey: () => false, syncMaps: () => {},
      resolve: (code) => (code === 'KeyS' ? ACT.StopMoving : null),
      dispatch: (id) => dispatchGameAction(id, hostFor(cam), e.isTrusted === false ? 'synthetic' : 'key'),
    });
    expect(route({ code: 'KeyS', repeat: false, isTrusted: true })).toBe('dispatched');
    expect(route({ code: 'KeyS', repeat: true, isTrusted: true })).toBe('held'); // a repeat never reaches stopMoving
    expect(route({ code: 'KeyS', repeat: false, isTrusted: false })).toBe('dispatched');
    expect(cam.recentMovementEventSources).toEqual(['stop_moving', 'synthetic_stop_moving']);
  });

  it('the bridge keeps every renderer source (the lists match), and an older client\'s values still', () => {
    expect([...BRIDGE_MOVEMENT_EVENT_SOURCES]).toEqual([...MOVEMENT_EVENT_SOURCES]);
    const all = sanitizeClientMoveLimiter({ outcome: 'move_limiter', sources: [...MOVEMENT_EVENT_SOURCES].slice(-8) })!;
    expect(all.sources).toEqual([...MOVEMENT_EVENT_SOURCES].slice(-8));
    expect(sanitizeClientMoveLimiter({ outcome: 'move_limiter', sources: ['stop_moving', 'key_up'] })!.sources).toEqual(['stop_moving', 'key_up']);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('OBS.stop-moving-input-source: real DOM events into CameraController', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'Event'] as const;
  let c: CameraController;
  let root: HTMLElement;
  let canvas: HTMLElement;
  afterAll(() => restoreDomGlobals(GLOBALS, saved));
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) { if (!(key in saved)) saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    domWindow.document.body.innerHTML = '';
    root = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(root);
    canvas = domWindow.document.createElement('canvas');
    root.appendChild(canvas);
    c = new CameraController(new THREE.PerspectiveCamera());
    c.bind(root);
  });

  it('a dispatched (untrusted) KeyboardEvent, as the agent\'s ac_press or a script sends, reads synthetic_*; a real key key_down / key_up', () => {
    const key = (type: string, code: string) => {
      const e = new domWindow.KeyboardEvent(type, { code, bubbles: true, cancelable: true });
      // A browser marks every dispatchEvent'd event isTrusted false (happy-dom leaves it unset; unset reads as trusted).
      Object.defineProperty(e, 'isTrusted', { value: false });
      root.dispatchEvent(e);
    };
    key('keydown', 'KeyW');
    expect(c.isMovingForward).toBe(true); // the behaviour is unchanged
    key('keyup', 'KeyW');
    expect(c.isMovingForward).toBe(false);
    key('keydown', 'NumLock'); // the autorun toggle
    expect(c.autoRun).toBe(true);
    // The browser's own events (isTrusted true) arrive through the same handlers with trusted = true.
    c.handleKeyDown('KeyW', false, false, true);
    c.handleKeyUp('KeyW', true);
    c.handleKeyDown('NumLock');
    // An event with isTrusted unset (happy-dom, an old engine) reads as the player's own key.
    root.dispatchEvent(new domWindow.KeyboardEvent('keydown', { code: 'KeyD', bubbles: true, cancelable: true }));
    expect(c.recentMovementEventSources).toEqual(['synthetic_key_down', 'synthetic_key_up', 'synthetic_autorun', 'key_down', 'key_up', 'autorun', 'key_down']);
  });

  it('a mouse button bound to a movement command holds it as mouse_button_down / mouse_button_up, not as a key', () => {
    c.keyTranslator = (code) => (code === 'MouseButton3' ? 'KeyW' : code);
    const fire = (type: string) => canvas.dispatchEvent(new domWindow.MouseEvent(type, { button: 3, bubbles: true, cancelable: true }));
    fire('mousedown');
    expect(c.isMoving).toBe(true);
    fire('mouseup');
    expect(c.isMoving).toBe(false);
    expect(c.recentMovementEventSources).toEqual(['mouse_button_down', 'mouse_button_up']);
  });
});
