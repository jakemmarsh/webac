/**
 * BUG.movetostate-burst-abuse-close — the move_limiter client_world event: the first time in a world session that an
 * outgoing limiter engages (MovementSync's budget / repeat cap, the connection's SendPacer), one event says what was
 * sending (fields that kept changing, the sending paths, the movement-event inputs, fps, the routine running). Driven
 * through the real CameraController → MovementSync wiring (as main.ts) into the real MoveLimiterReporter, and the
 * bridge's sanitizer for the line it logs.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { MoveLimiterReporter, type MoveLimiterEvent } from '../packages/renderer/src/telemetry/MoveLimiterReporter.ts';
import { isMoveLimiterOutcome, sanitizeClientMoveLimiter } from '../services/ws-tcp-bridge/src/clientWorld.ts';

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

  it('the bridge drops anything outside the vocabularies (no free text reaches the log)', () => {
    const clean = sanitizeClientMoveLimiter({
      outcome: 'move_limiter', era: 'classic-dereth-1-0', trace: 'abcdef0123456789', build: 'x', limiter: 'nonsense',
      recent: -4, fields: ['forward', 'Claude Arcanist', 7], origins: ['event', 'rm -rf'], sources: ['key_up', '<script>'], fps: 'fast', driver: 'bot', kind: 'macro',
    })!;
    expect(clean).toMatchObject({ limiter: null, recent: null, fields: ['forward'], origins: ['event'], sources: ['key_up'], fps: null, driver: null, kind: 'macro' });
    expect(sanitizeClientMoveLimiter({ outcome: 'portal_used' })).toBeNull();
  });
});
