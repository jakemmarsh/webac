/**
 * BUG.local-position-desync-after-pushout — the client reports its position
 * by retail's rule, not only while a movement key is held.
 *
 * Retail: CommandInterpreter::UseTime @ 006b3bf0 runs every frame and calls
 * SendPositionEvent @ 006b4770 (an AutonomousPosition) whenever
 * ShouldSendPositionEvent @ 006b45e0 says so:
 *   - 1 s (time_between_position_events, set in the constructor @ 006b3e40)
 *     after the last position OR movement event: iff the cell or frame
 *     (Frame::is_equal, ε = F_EPSILON 0.0002) changed since the last sent
 *     position;
 *   - inside that second: iff the cell changed or the contact plane changed
 *     (Plane::operator== @ 006b3dd0).
 * SendMovementEvent @ 006b4680 (a MoveToState) stamps the time only.
 *
 * ACE adopts whatever we report as Player.Location
 * (GameActionAutonomousPosition.cs → Player_Tick.UpdatePlayerPosition), so a
 * position change the player never keyed in — the collision push-out after a
 * teleport onto a drudge, a wall slide, a landing — used to leave the server
 * 1-2 m off (live: verification/position-sync) until the 20 s heartbeat.
 */
import { describe, it, expect } from 'vitest';
import { deserializeMessage, parseAutonomousPositionPayload, GameActionType } from '@ac/network';
import {
  MovementSync, shouldSendPositionEvent, framesEqual, contactPlanesEqual, contactPlaneFromNormal,
  TIME_BETWEEN_POSITION_EVENTS_MS, POSITION_EVENT_EPSILON,
  type ContactPlane, type SentPositionEvent, type PlayerPosition, type MovementState,
} from '../packages/renderer/src/network/MovementSync.js';

const IDLE: MovementState = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };
// Holtburg 0xA9B4, outdoor: world (32533, 34580.5) → block-local (85, 20.5), cell 0x19.
const HERE: PlayerPosition = { worldX: 32533, worldZ: 34580.5, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };

function harness() {
  const sent: Array<{ type: number; payload: Uint8Array }> = [];
  const conn = {
    sendMessage: (bytes: Uint8Array) => {
      const m = deserializeMessage(bytes);
      if (m.type !== 'action') throw new Error('expected a GameAction');
      sent.push({ type: m.actionType, payload: m.payload });
    },
  };
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync(conn as any, () => ++seq);
  const aps = () => sent.filter((m) => m.type === GameActionType.AutonomousPosition).map((m) => parseAutonomousPositionPayload(m.payload));
  const mtss = () => sent.filter((m) => m.type === GameActionType.MoveToState);
  return { sync, sent, aps, mtss };
}

describe('MovementSync — retail position-event rule (ShouldSendPositionEvent @ 006b45e0)', () => {
  it('reports on the first in-world frame, then stays quiet while nothing moves', () => {
    const { sync, aps } = harness();
    sync.update(IDLE, HERE, 0);
    expect(aps()).toHaveLength(1);
    expect(aps()[0].landblockId).toBe(0xa9b40019);
    expect(aps()[0].x).toBeCloseTo(85, 3);
    expect(aps()[0].y).toBeCloseTo(20.5, 3);
    for (let t = 16; t < 19_000; t += 250) sync.update(IDLE, HERE, t);
    expect(aps()).toHaveLength(1);
  });

  it('a collision push-out with no input is reported within a second, at the pushed position', () => {
    const { sync, aps, mtss } = harness();
    sync.update(IDLE, HERE, 0);
    // Teleported onto a drudge: the push-out moves us 1.6 m north over a few
    // frames — same cell, same flat plane, no keys held.
    const pushed = { ...HERE, worldZ: HERE.worldZ + 1.6 };
    sync.update(IDLE, { ...HERE, worldZ: HERE.worldZ + 0.8 }, 300);
    sync.update(IDLE, pushed, 600);
    expect(aps()).toHaveLength(1); // inside the 1 s window: nothing yet
    sync.update(IDLE, pushed, 1016);
    expect(aps()).toHaveLength(2);
    expect(aps()[1].y).toBeCloseTo(22.1, 3);
    expect(mtss()).toHaveLength(0); // not movement input — no MoveToState
    // …and only once.
    for (let t = 1100; t < 10_000; t += 250) sync.update(IDLE, pushed, t);
    expect(aps()).toHaveLength(2);
  });

  it('the old key-held cadence is gone: turning in place reports the new heading after 1 s', () => {
    const { sync, aps } = harness();
    sync.update(IDLE, HERE, 0);
    sync.update(IDLE, { ...HERE, playerYaw: 0.5 }, 1500);
    expect(aps()).toHaveLength(2);
    expect(aps()[1].qz).not.toBeCloseTo(aps()[0].qz, 3);
  });

  it('inside the window: a cell change or a contact-plane change sends at once, a plain move does not', () => {
    const { sync, aps } = harness();
    let plane: ContactPlane = { nx: 0, ny: 0, nz: 1, d: -94 };
    const at = (worldX: number): PlayerPosition => ({ ...HERE, worldX, contactPlane: () => plane });
    sync.update(IDLE, at(32533), 0);
    sync.update(IDLE, at(32534), 200); // same cell 0x19, same plane
    expect(aps()).toHaveLength(1);
    sync.update(IDLE, at(32544.5), 400); // local x 96.5 → cell 0x21
    expect(aps()).toHaveLength(2);
    expect(aps()[1].landblockId).toBe(0xa9b40021);
    plane = { nx: 0.1, ny: 0, nz: 0.995, d: -3350 }; // stepped onto a sloped triangle
    sync.update(IDLE, at(32545), 500);
    expect(aps()).toHaveLength(3);
    sync.update(IDLE, at(32545.5), 700); // same slope
    expect(aps()).toHaveLength(3);
  });

  it('a MoveToState stamps the event clock but not the last sent position (teleport arrival)', () => {
    const { sync, aps, mtss } = harness();
    sync.update(IDLE, HERE, 0);
    // Arrival 3 blocks away: PlayerTeleported → SendMovementEvent only.
    const arrival: PlayerPosition = { ...HERE, worldX: HERE.worldX + 600, groundY: 60 };
    sync.sendMovementEventNow(IDLE, arrival, 5000);
    expect(mtss()).toHaveLength(1);
    // The next frames at the arrival: a cell change → the position event
    // goes out right away with the arrival.
    sync.update(IDLE, arrival, 5016);
    expect(aps()).toHaveLength(2);
    // Push-out after arrival (same cell): reported one second later.
    const pushed = { ...arrival, worldZ: arrival.worldZ - 1.2 };
    sync.update(IDLE, pushed, 5400);
    expect(aps()).toHaveLength(2);
    sync.update(IDLE, pushed, 6100);
    expect(aps()).toHaveLength(3);
    expect(aps()[2].y).toBeCloseTo(20.5 - 1.2, 3);
  });

  it('a key press (MoveToState) holds the next position event off for a second', () => {
    const { sync, aps, mtss } = harness();
    sync.update(IDLE, HERE, 0);
    sync.update({ ...IDLE, forward: true }, { ...HERE, worldZ: HERE.worldZ + 0.1 }, 2000);
    expect(mtss()).toHaveLength(1);
    expect(aps()).toHaveLength(1);
    sync.update({ ...IDLE, forward: true }, { ...HERE, worldZ: HERE.worldZ + 3 }, 2800);
    expect(aps()).toHaveLength(1);
    sync.update({ ...IDLE, forward: true }, { ...HERE, worldZ: HERE.worldZ + 4.5 }, 3050);
    expect(aps()).toHaveLength(2);
  });

  it('keeps the 20 s idle heartbeat (ACE session keep-alive)', () => {
    const { sync, aps } = harness();
    sync.update(IDLE, HERE, 0);
    sync.update(IDLE, HERE, 19_000);
    expect(aps()).toHaveLength(1);
    sync.update(IDLE, HERE, 20_001);
    expect(aps()).toHaveLength(2);
  });

  it('lastSentPositionEvent / autonomousPositionsSent track what went out', () => {
    const { sync } = harness();
    expect(sync.lastSentPositionEvent).toBeNull();
    sync.sendAutonomousPositionNow(HERE, 10);
    expect(sync.autonomousPositionsSent).toBe(1);
    expect(sync.lastSentPositionEvent?.cellId).toBe(0xa9b40019);
    expect(sync.lastSentPositionEvent?.contactPlane).not.toBeNull();
  });
});

describe('shouldSendPositionEvent / Frame::is_equal / Plane::operator== — the pure rule', () => {
  const last: SentPositionEvent = { cellId: 0xa9b40019, x: 85, y: 20.5, z: 94, qw: 1, qx: 0, qy: 0, qz: 0, contactPlane: { nx: 0, ny: 0, nz: 1, d: -94 } };
  const flat = () => last.contactPlane;

  it('nothing sent yet always sends', () => {
    expect(shouldSendPositionEvent(null, 0, last, flat, 1)).toBe(true);
  });
  it('the window is strict: exactly 1 s later is still inside it', () => {
    const moved = { ...last, x: 86 };
    expect(shouldSendPositionEvent(last, 0, moved, flat, TIME_BETWEEN_POSITION_EVENTS_MS)).toBe(false);
    expect(shouldSendPositionEvent(last, 0, moved, flat, TIME_BETWEEN_POSITION_EVENTS_MS + 1)).toBe(true);
  });
  it('frames equal within F_EPSILON (origin ≤ ε, quaternion < ε)', () => {
    expect(POSITION_EVENT_EPSILON).toBe(0.0002);
    expect(framesEqual(last, { ...last, x: last.x + 0.0001 })).toBe(true);
    expect(framesEqual(last, { ...last, x: last.x + 0.001 })).toBe(false);
    expect(framesEqual(last, { ...last, qz: 0.0001 })).toBe(true);
    expect(framesEqual(last, { ...last, qz: 0.0003 })).toBe(false);
    expect(shouldSendPositionEvent(last, 0, { ...last, z: 94.0001 }, flat, 5000)).toBe(false);
  });
  it('contact planes compare component-wise; losing or regaining contact is a change', () => {
    const p = last.contactPlane!;
    expect(contactPlanesEqual(p, { ...p, d: p.d + 0.0001 })).toBe(true);
    expect(contactPlanesEqual(p, { ...p, nx: 0.01 })).toBe(false);
    expect(contactPlanesEqual(p, null)).toBe(false);
    expect(contactPlanesEqual(null, null)).toBe(true);
    expect(shouldSendPositionEvent(last, 0, last, () => null, 100)).toBe(true);
  });
  it('the plane getter is only consulted inside the window with an unchanged cell', () => {
    let calls = 0;
    const getter = () => { calls++; return last.contactPlane; };
    shouldSendPositionEvent(last, 0, last, getter, 5000);
    shouldSendPositionEvent(last, 0, { ...last, cellId: 0xa9b40021 }, getter, 10);
    expect(calls).toBe(0);
    shouldSendPositionEvent(last, 0, last, getter, 10);
    expect(calls).toBe(1);
  });
  it('contactPlaneFromNormal maps Three.js (Y-up) to AC (Z-up) and puts the floor point on the plane', () => {
    const pl = contactPlaneFromNormal({ x: 0.2, y: 0.9798, z: 0 }, 32533, 34580.5, 94);
    expect(pl.nx).toBeCloseTo(0.2, 6);
    expect(pl.ny).toBeCloseTo(0, 6);
    expect(pl.nz).toBeCloseTo(0.9798, 6);
    expect(pl.nx * 32533 + pl.ny * 34580.5 + pl.nz * 94 + pl.d).toBeCloseTo(0, 6);
  });
});
