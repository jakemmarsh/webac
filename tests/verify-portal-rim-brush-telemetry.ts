/**
 * BUG.portal-rim-brush-telemetry (2026-11-08) — the server collides with a portal on the path it is SENT,
 * not on the body.
 *
 * Prod (trace 02fe566b3f8f77e2, wcid 24230 Deeper Catacombs in the Lair of Death 0x01AA): a walk-in reported
 * `portal_use_failed` with dist 2.5, endDist 2.2, closest 1.78, overlapped, playerMoved, no teleport and no
 * WeenieError. The body touched the portal (bodyTouchesPortal reaches ~1.835 m for a human) but the positions
 * the server was told (2.5 m, then 2.2 m) never came within its collision reach. Live on local ACE, same
 * portal: standing at 1.70 / 1.78 / 1.85 / 1.92 m did nothing, backing straight out from any of them did
 * nothing, strafing along the rim teleported at every one, and walking in teleported. Retail's DoCollision
 * (0x0058c3a0) sends nothing on a walk-in either. Such a walk-in is now `portal_rim_brush`; a silent walk-in
 * whose sent path did reach the portal stays `portal_use_failed`.
 *
 * Era-neutral: ACE, GDLE and the AC1999 server all learn the player's position only from MoveToState and
 * AutonomousPosition, which MovementSync sends the same way in every era.
 */
import { describe, it, expect } from 'vitest';
import {
  PortalUseReporter, PORTAL_REPLY_MS, PORTAL_OUTCOMES, SERVER_REACH_TOLERANCE_M, bodyTouchesPortal, sentPathReach, serverFramePoint,
  type PortalEvent, type PortalSnapshot, type SentPoint,
} from '../packages/renderer/src/telemetry/PortalUseReporter';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync';
import { sanitizeClientPortal } from '../services/ws-tcp-bridge/src/clientWorld';
import { setupPhysicsSpheres } from '../packages/renderer/src/world/CreatureCollision';

/** The stock portal (Setup 0x020001B3: one sphere r 1.357 at z 1.42) and the human body (0x02000001: r 0.48 at z 0.475 and 1.35). */
const PORTAL_SPHERES = setupPhysicsSpheres({ spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] });
const HUMAN_SPHERES = setupPhysicsSpheres({ spheres: [
  { origin: { x: 0, y: 0, z: 0.475 }, radius: 0.48 }, { origin: { x: 0, y: 0, z: 1.35 }, radius: 0.48 },
] });

/** Lair of Death 0x01AA: the portal and the player share the dungeon's frame. */
const CELL = 0x01aa010d;
const PORTAL_AT = serverFramePoint(CELL, 50, 60, -12);
const PORTAL_GUID = 0x7a1a0024;
/** A point `d` m from the portal's centre at `deg` degrees (0 = east), on the portal's floor. */
const around = (d: number, deg = 0): SentPoint => ({
  x: PORTAL_AT.x + d * Math.cos((deg * Math.PI) / 180), y: PORTAL_AT.y + d * Math.sin((deg * Math.PI) / 180), z: PORTAL_AT.z,
});

const snap = (over: Partial<PortalSnapshot> = {}): PortalSnapshot => ({
  wcid: 24230, itemType: 0x10000, descFlags: 0x40014, physicsState: 0xc0c,
  useRadius: 0, reach: 1.919, rel: { dx: -2.5, dy: 0, dz: 0 }, playerCell: CELL, portalCell: CELL,
  portalAt: PORTAL_AT, bodySpheres: HUMAN_SPHERES, portalSpheres: PORTAL_SPHERES, ...over,
});

function rig(snapshot: () => PortalSnapshot | null = () => snap()) {
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: '02fe566b3f8f77e2',
    era: () => 'eor', server: () => 'coldeve', now: () => clock.t, snapshot,
    send: (_url, body) => { events.push(JSON.parse(body) as PortalEvent); },
  });
  /** A walk-in watch on the portal, the body's closest approach, then the verdict with the keys held. */
  const walkIn = (closest: number, during: SentPoint[] = []): void => {
    r.overlaps([]); // the baseline
    r.overlaps([PORTAL_GUID], true);
    r.approach(PORTAL_GUID, closest);
    for (const p of during) { clock.t += 100; r.positionSent(p); }
    for (let i = 0; i < PORTAL_REPLY_MS / 100 + 2; i++) { clock.t += 100; r.tick({ serverWalking: false, playerMoving: true }); }
  };
  return { r, clock, events, walkIn };
}

describe('sentPathReach: the server\'s swept move between two sent positions', () => {
  const reach = (a: SentPoint, b: SentPoint) => sentPathReach(a, b, PORTAL_AT, HUMAN_SPHERES, PORTAL_SPHERES, 1.919);

  it('outdoors (the default tolerance) the server reaches ~0.1 m past the body touch (1.835 m → ~1.936 m for a human at the stock portal)', () => {
    expect(bodyTouchesPortal(1.83, 0, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(true);
    expect(bodyTouchesPortal(1.9, 0, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(false);
    // A move straight in that stops at 1.92 m (the live strafe distance that still teleported) reaches; 1.98 m does not.
    expect(reach(around(4), around(1.92)).reached).toBe(true);
    expect(reach(around(4), around(1.98)).reached).toBe(false);
    expect(SERVER_REACH_TOLERANCE_M).toBe(0.1);
  });

  it('live: standing still at 1.70 m is no move; backing straight out from 1.70 m is no collision; strafing along the rim is', () => {
    for (const d of [1.7, 1.78, 1.85, 1.92]) {
      expect(reach(around(d), around(d)).reached).toBe(false); // teleloc'd, standing
      expect(reach(around(d), around(d + 3)).reached).toBe(false); // backing straight away
      const p = around(d);
      expect(reach(p, { x: p.x, y: p.y + 2.5, z: p.z }).reached).toBe(true); // strafing: tangent from inside the rim
    }
  });

  it('a chord that dips inside counts even with both ends outside; its horizontal nearest approach is reported', () => {
    const r = reach({ x: PORTAL_AT.x - 3, y: PORTAL_AT.y + 1.85, z: PORTAL_AT.z }, { x: PORTAL_AT.x + 3, y: PORTAL_AT.y + 1.85, z: PORTAL_AT.z });
    expect(r.reached).toBe(true);
    expect(r.closest).toBeCloseTo(1.85, 6);
    const wide = reach({ x: PORTAL_AT.x - 3, y: PORTAL_AT.y + 2.2, z: PORTAL_AT.z }, { x: PORTAL_AT.x + 3, y: PORTAL_AT.y + 2.2, z: PORTAL_AT.z });
    expect(wide).toEqual({ closest: expect.closeTo(2.2, 6), reached: false });
  });

  it('height counts: a path 3 m below the portal never reaches it', () => {
    const below = (p: SentPoint): SentPoint => ({ ...p, z: p.z - 3 });
    expect(reach(below(around(4)), below(around(0))).reached).toBe(false);
  });

  it('with either shape unknown the part-array reach stands in (horizontal)', () => {
    expect(sentPathReach(around(4), around(1.95), PORTAL_AT, null, PORTAL_SPHERES, 1.919).reached).toBe(true);
    expect(sentPathReach(around(4), around(2.1), PORTAL_AT, HUMAN_SPHERES, [], 1.919).reached).toBe(false);
  });
});

describe('PortalUseReporter: a silent walk-in judged on the path the server was sent', () => {
  it('the prod shape: sent 2.5 m → 2.2 m, body touched at 1.78 m → portal_rim_brush with every field', () => {
    const g = rig();
    g.r.positionSent(around(6));
    g.r.positionSent(around(2.5)); // the server's latest swept move ends 2.5 m out when the body touches
    g.walkIn(1.78, [around(2.2, 10)]); // the body turns away; the next position the server hears is 2.2 m out
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({
      outcome: 'portal_rim_brush', trigger: 'walk_in', wcid: 24230, overlapped: true, closest: 1.78, playerMoved: true,
      weenieErrors: [], sentReached: false, dist: 2.5, playerCell: '01aa010d',
    });
    expect((g.events[0] as { sentClosest: number }).sentClosest).toBeGreaterThanOrEqual(2.15);
    expect((g.events[0] as { sentClosest: number }).sentClosest).toBeLessThanOrEqual(2.5);
    expect(PORTAL_OUTCOMES).toContain('portal_rim_brush');
  });

  it('a sent segment passing 1.7 m from the portal stays portal_use_failed (a real finding)', () => {
    const g = rig();
    g.r.positionSent(around(6));
    g.walkIn(1.7, [around(1.7)]);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', trigger: 'walk_in', sentReached: true, sentClosest: 1.7 });
  });

  it('a tangent segment whose chord passes inside, both ends outside, counts as reached → portal_use_failed', () => {
    // BUG.portal-rim-brush-indoor-reach: this dungeon (an EnvCell) is judged on the plain radius sum (1.837 m),
    // so the chord passes at 1.75 m; a 1.85 m chord here is a rim brush (tests/verify-portal-rim-brush-indoor-reach.ts).
    const g = rig();
    g.r.positionSent({ x: PORTAL_AT.x - 3, y: PORTAL_AT.y + 1.75, z: PORTAL_AT.z });
    g.walkIn(1.7, [{ x: PORTAL_AT.x + 3, y: PORTAL_AT.y + 1.75, z: PORTAL_AT.z }]);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', sentReached: true, sentClosest: 1.75 });
  });

  it('the segment into the last position before the watch is part of the path', () => {
    const g = rig();
    g.r.positionSent(around(5));
    g.r.positionSent(around(1.6)); // the server was told the player walked in, then the body touch fired
    g.walkIn(1.6);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', sentReached: true });
  });

  it('a server placement breaks the path: a teleloc across the portal is no swept move', () => {
    const g = rig();
    g.r.positionSent(around(5, 180));
    g.r.positionPlaced(around(1.8)); // @teleloc to 1.8 m: placed, not swept
    g.walkIn(1.8, [around(4)]); // then backs straight away
    expect(g.events[0]).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false, sentClosest: 1.8 });
  });

  it('no sent segment at all is not judged: portal_use_failed with sentClosest null (unchanged)', () => {
    const g = rig();
    g.walkIn(1.5);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', sentClosest: null, sentReached: null });
  });

  it('an unknown portal position is not judged either', () => {
    const g = rig(() => snap({ portalAt: null }));
    g.r.positionSent(around(6));
    g.walkIn(1.78, [around(2.2)]);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', sentClosest: null });
  });

  it('a use is never a rim brush (the server walks the player in itself)', () => {
    const g = rig();
    g.r.positionSent(around(8));
    g.r.useAttempt(PORTAL_GUID, { itemType: 0x10000, objectDescFlags: 0x40000 }, true);
    g.r.positionSent(around(7));
    for (let i = 0; i < PORTAL_REPLY_MS / 100 + 2; i++) { g.clock.t += 100; g.r.tick(false); }
    // The path is reported (7 m out, no reach) but a use is not judged on it.
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', trigger: 'use', sentClosest: 7, sentReached: false });
  });

  it('a teleport and a world change forget the path', () => {
    const g = rig();
    g.r.positionSent(around(5));
    g.r.positionSent(around(1.5));
    g.r.reset();
    g.walkIn(1.78, [around(2.2)]);
    // After the reset the first position starts a new path: no segment, nothing judged.
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', sentClosest: null });
  });

  it('the bridge keeps portal_rim_brush with sentClosest / sentReached', () => {
    const g = rig();
    g.r.positionSent(around(6));
    g.r.positionSent(around(2.5));
    g.walkIn(1.78, [around(2.2, 10)]);
    expect(sanitizeClientPortal(g.events[0])).toEqual(g.events[0]);
    expect(sanitizeClientPortal({ ...g.events[0], sentClosest: 'near', sentReached: 'yes' })).toMatchObject({ sentClosest: null, sentReached: null });
  });
});

describe('MovementSync.onPositionSent: every position the server is told', () => {
  const IDLE: MovementState = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };
  const pos = (localX: number, localY: number): PlayerPosition => ({
    worldX: 0x01 * 192 + localX, worldZ: 0xaa * 192 + localY, groundY: -12, playerYaw: 0,
    landblock: CELL, localX, localY, localZ: -12, inDungeon: true, onGround: true,
  });

  it('a MoveToState and an AutonomousPosition each report their cell + origin, and the reporter sees the swept move', () => {
    const ms = new MovementSync({ sendMessage: () => {} } as never, () => 1);
    const frames: { cellId: number; x: number; y: number; z: number }[] = [];
    const g = rig();
    ms.onPositionSent = (f) => { frames.push(f); g.r.positionSent(serverFramePoint(f.cellId, f.x, f.y, f.z)); };
    ms.sendPositionNow(IDLE, pos(53, 60)); // MoveToState + AutonomousPosition: 3 m east of the portal
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ cellId: CELL, x: 53, y: 60, z: -12 });
    expect(frames[1]).toMatchObject({ cellId: CELL, x: 53, y: 60, z: -12 });
    g.walkIn(1.78, []);
    // The server was told only the spot 3 m out (twice): no move into the portal.
    expect(g.events[0]).toMatchObject({ outcome: 'portal_rim_brush', sentClosest: 3, sentReached: false });
  });

  it('a listener that throws never breaks the send', () => {
    const sent: unknown[] = [];
    const ms = new MovementSync({ sendMessage: (m: unknown) => { sent.push(m); } } as never, () => 1);
    ms.onPositionSent = () => { throw new Error('boom'); };
    expect(() => ms.sendAutonomousPositionNow(pos(53, 60))).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});
