/**
 * BUG.portal-walkin-body-spheres-unknown (2026-11-21) — the walk-in judge never knew the player's own body.
 *
 * main.ts took the player's body spheres from `serverObjectManager.getObject(ourGuid).physicsSpheres`, but
 * ServerObjectManager.createObject skips our own guid (it is never in the object table), so the lookup was
 * always empty. Every walk-in was then judged on the fallback: the portal's part-array radius (1.919 m for the
 * stock Setup 0x020001B3), horizontally, with no height at all, both for the touch that starts a watch and for
 * the sent path (sentReach 2.02 outdoors in every prod event, never the 1.94 a known body gives). ACE collides
 * sphere to sphere in 3-D: the player's Setup spheres (r 0.48 at 0.475 / 1.35 m) against the portal's (r 1.357
 * at 1.42 m) at each transition step's check position (Sphere.IntersectsSphere, ObstructionEthereal branch).
 * Prod 2026-11-21 (Coldeve, trace a6445ec44596b3eb, wcid 24436 at 0x9E440021, Setup 0x020005D6 = the stock
 * shape): sentClosest 1.92 judged "reached" against 2.02 horizontally; with the portal's base 0.15-0.61 m above
 * the walker's feet there (terrain around it), the 3-D gap is 1.93-1.98 m.
 * The body now comes from the collision body's resolved layout (DungeonCollision.bodySphereLayout), the touch
 * check carries the server's reach band, and every event carries `sentDz` (the height at sentClosest).
 *
 * BUG.portal-walkin-sent-judge-plain-sum (2026-11-21, live on local ACE, tools/probe-portal-walk-in.ts `pass` on the
 * stock 24436 and `graze` on a spawned 1087 at Holtburg): Coldeve 24436 west 1.84 m teleported, 1.92 / 1.94 /
 * 2.01 m did not (1.94 posted a false portal_use_failed, sentDz 0.1); east 1.80 teleported, 1.90 / 1.92 / 1.97
 * did not (1.92: sentDz -0.22); Holtburg 1.67-1.73 and 1.94 m teleported (1.94 with no event: no watch started),
 * 2.00 did not. The server's reach on the same spheres varies by site within (sum, sum + ~0.17]: a silent walk-in
 * is judged at the plain sum; the touch that starts a watch keeps a 0.2 m outdoor band, swept between checks.
 */
import { describe, it, expect } from 'vitest';
import {
  PortalUseReporter, PORTAL_REPLY_MS, bodySpheresFromLayout, bodyTouchesPortal, sentPathReach, serverFramePoint,
  serverReachTolerance, sweptPortalTouch,
  type PortalEvent, type PortalSnapshot,
} from '../packages/renderer/src/telemetry/PortalUseReporter';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision';
import { setupPhysicsSpheres } from '../packages/renderer/src/world/CreatureCollision';
import { sanitizeClientPortal } from '../services/ws-tcp-bridge/src/clientWorld';

/** The stock portal Setup 0x020001B3 / 0x020005D6: one sphere r 1.357 at z 1.42 (portal.dat, EoL). */
const PORTAL_SPHERES = setupPhysicsSpheres({ spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] });
const PORTAL_GUID = 0x7a1a0024;
const COLDEVE_CELL = 0x9e440021;

/** The body the shipped code now reads: a real collision body's layout (the human Setup 0x02000001's spheres). */
function liveBody() {
  return bodySpheresFromLayout(new DungeonCollision().bodySphereLayout);
}

describe('bodySpheresFromLayout: the player\'s spheres from the collision body', () => {
  it('a collision body gives the human Setup\'s two spheres (r 0.48 at 0.475 / 1.35 m)', () => {
    const b = liveBody()!;
    expect(b).toHaveLength(2);
    expect(b[0].radius).toBeCloseTo(0.48, 5);
    expect(b[0].z).toBeCloseTo(0.475, 5);
    expect(b[1].z).toBeCloseTo(1.35, 5);
  });

  it('follows the character\'s own Setup and scale (setPlayerDimensions)', () => {
    const c = new DungeonCollision();
    c.setPlayerDimensions({ radius: 0.7, height: 2, stepUpHeight: 0.6, spheres: [{ origin: { z: 0.5 }, radius: 0.5 }, { origin: { z: 1.5 }, radius: 0.5 }] }, 1.2);
    const b = bodySpheresFromLayout(c.bodySphereLayout)!;
    expect(b.map((s) => +s.z.toFixed(3))).toEqual([0.6, 1.8]);
    expect(b[0].radius).toBeCloseTo(0.6, 5);
  });

  it('no layout or no usable sphere → null (the part-array fallback stays for that case)', () => {
    expect(bodySpheresFromLayout(null)).toBeNull();
    expect(bodySpheresFromLayout(undefined)).toBeNull();
    expect(bodySpheresFromLayout({ radius: 0, heights: [0.5] })).toBeNull();
    expect(bodySpheresFromLayout({ radius: 0.48, heights: [] })).toBeNull();
    expect(bodySpheresFromLayout({ radius: Number.NaN, heights: [0.5] })).toBeNull();
  });
});

describe('the touch that starts a watch: the 0.2 m outdoor band, swept between checks', () => {
  it('Holtburg 1.94 m flat (teleported live with no event): touches with the outdoor band, not with the old 0.1 m', () => {
    const body = liveBody()!;
    expect(serverReachTolerance(0xa9b40031)).toBe(0.2);
    expect(bodyTouchesPortal(1.94, 0, body, PORTAL_SPHERES, serverReachTolerance(0xa9b40031))).toBe(true);
    expect(bodyTouchesPortal(1.94, 0, body, PORTAL_SPHERES, 0.1)).toBe(false);
    // 2.00 m flat (the widest teleport measured, 2026-11-13) is inside the band too.
    expect(bodyTouchesPortal(2.0, 0, body, PORTAL_SPHERES, serverReachTolerance(0xa9b40031))).toBe(true);
  });

  it('a graze that crosses the band between two 100 ms checks still touches (both ends outside)', () => {
    const body = liveBody()!;
    const portal = { x: 0, baseY: 0, z: 0 };
    const prev = { x: -1.5, y: 0, z: 1.85 }, now = { x: 1.5, y: 0, z: 1.85 };
    expect(sweptPortalTouch(null, now, portal, body, PORTAL_SPHERES, 0.2).touching).toBe(false);
    const t = sweptPortalTouch(prev, now, portal, body, PORTAL_SPHERES, 0.2);
    expect(t.touching).toBe(true);
    expect(t.horizontal).toBeCloseTo(1.85, 6);
    // Height is interpolated: the same graze 1.5 m below the portal's base does not touch.
    expect(sweptPortalTouch({ ...prev, y: -1.5 }, { ...now, y: -1.5 }, portal, body, PORTAL_SPHERES, 0.2).touching).toBe(false);
  });
});

describe('bodyTouchesPortal: 3-D sphere touch with the server\'s band', () => {
  it('flat ground: 1.83 m touches at the plain radius sum, 1.90 m only with the outdoor 0.1 m band', () => {
    const body = liveBody()!;
    expect(bodyTouchesPortal(1.83, 0, body, PORTAL_SPHERES)).toBe(true);
    expect(bodyTouchesPortal(1.9, 0, body, PORTAL_SPHERES)).toBe(false);
    expect(bodyTouchesPortal(1.9, 0, body, PORTAL_SPHERES, 0.1)).toBe(true);
  });

  it('the Coldeve 24436 shape: 1.92 m with the portal base 0.45 m above the feet is no touch, band or not', () => {
    const body = liveBody()!;
    expect(bodyTouchesPortal(1.92, 0.45, body, PORTAL_SPHERES, 0.1)).toBe(false);
    expect(bodyTouchesPortal(1.92, 0, body, PORTAL_SPHERES, 0.1)).toBe(true); // the same distance on the level touches
  });
});

/** A walk straight past an outdoor portal, judged on `body` (null = the old, always-empty lookup). */
function rigPass(d: number, baseAboveFeet: number, body: { z: number; radius: number }[] | null, teleport = false) {
  const at = serverFramePoint(COLDEVE_CELL, 103.121, 15.0475, 33.78);
  const feetZ = at.z - baseAboveFeet;
  const snap = (): PortalSnapshot => ({
    wcid: 24436, itemType: 0x10000, descFlags: 0x40014, physicsState: 0xc0c,
    useRadius: 0, reach: 1.919, rel: { dx: -3, dy: 0, dz: baseAboveFeet }, playerCell: COLDEVE_CELL, portalCell: COLDEVE_CELL,
    portalAt: at, bodySpheres: body, portalSpheres: PORTAL_SPHERES,
  });
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'a6445ec44596b3eb',
    era: () => 'eor', server: () => 'local', now: () => clock.t, snapshot: snap,
    send: (_url, b) => { events.push(JSON.parse(b) as PortalEvent); },
  });
  r.positionSent({ x: at.x - 3, y: at.y + d, z: feetZ });
  r.overlaps([]);
  r.overlaps([PORTAL_GUID], true);
  r.approach(PORTAL_GUID, d);
  clock.t += 100;
  r.positionSent({ x: at.x + 3, y: at.y + d, z: feetZ });
  if (teleport) { clock.t += 300; r.teleported(); }
  for (let i = 0; i < PORTAL_REPLY_MS / 100 + 2; i++) { clock.t += 100; r.tick({ serverWalking: false, playerMoving: true }); }
  expect(events).toHaveLength(1);
  return events[0] as unknown as Record<string, unknown>;
}
const passAt = (d: number, baseAboveFeet: number, body: { z: number; radius: number }[] | null) => rigPass(d, baseAboveFeet, body);

describe('PortalUseReporter: walk-ins judged on the real body, at the plain radius sum (live 2026-11-21)', () => {
  it('Coldeve 24436 west side: the 1.92 m pass (sentDz 0.1) that never teleported is a rim brush, sentReach = the sum 1.84', () => {
    expect(passAt(1.92, 0.1, liveBody())).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false, sentClosest: 1.92, sentReach: 1.84, sentDz: 0.1 });
  });

  it('Coldeve 24436 east side: the 1.92 m pass (sentDz -0.22) is a rim brush', () => {
    expect(passAt(1.92, -0.22, liveBody())).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false, sentDz: -0.22 });
  });

  it('the prod a6445ec44596b3eb shape (1.92 m) is a rim brush on the old fallback too (part-array 1.919 m, no band)', () => {
    expect(passAt(1.92, 0.45, null)).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false, sentReach: 1.92 });
  });

  it('a silent pass inside the sum (1.80 m, west side) stays portal_use_failed', () => {
    expect(passAt(1.8, 0.1, liveBody())).toMatchObject({ outcome: 'portal_use_failed', sentReached: true, sentClosest: 1.8 });
  });

  it('a pass in the band that the server DID take (Holtburg 1.94 m) ends as portal_used', () => {
    expect(rigPass(1.94, 0, liveBody(), true)).toMatchObject({ outcome: 'portal_used', trigger: 'walk_in', wcid: 24436 });
  });

  // The inverse: nothing within the sum is hidden.
  for (const [d, dz] of [[1.7, 0], [0.37, 0], [1.7, 0.3], [0.37, -1.2]] as const) {
    it(`a pass at ${d} m with the portal base ${dz} m above the feet and no teleport stays portal_use_failed`, () => {
      const ev = passAt(d, dz, liveBody());
      expect(ev).toMatchObject({ outcome: 'portal_use_failed', sentReached: true, sentClosest: d, sentDz: dz });
    });
  }

  it('flat passes at 1.88 m and 2.00 m (in the band, no teleport) are rim brushes', () => {
    expect(passAt(1.88, 0, liveBody())).toMatchObject({ outcome: 'portal_rim_brush' });
    expect(passAt(2.0, 0, liveBody())).toMatchObject({ outcome: 'portal_rim_brush' });
  });

  it('a 1.70 m pass with the portal base 1.0 m above the feet (a ramp or stair below it) is out of 3-D reach', () => {
    const ev = passAt(1.7, 1.0, liveBody());
    expect(ev).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false, sentDz: 1 });
  });

  it('sentPathReach reports the height at the horizontal nearest point of a sloped segment', () => {
    const at = { x: 0, y: 0, z: 10 };
    const r = sentPathReach({ x: -3, y: 1, z: 9 }, { x: 3, y: 1, z: 11 }, at, liveBody(), PORTAL_SPHERES, 1.919, 0.1);
    expect(r.closest).toBeCloseTo(1, 5);
    expect(r.dz).toBeCloseTo(0, 5);
  });

  it('the bridge keeps sentDz (signed metres, 0.01)', () => {
    const ev = passAt(1.92, 0.45, liveBody());
    const out = sanitizeClientPortal({ ...ev, sentDz: -0.456 }) as unknown as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    expect(out!.sentDz).toBe(-0.46);
    const kept = sanitizeClientPortal(ev) as unknown as Record<string, unknown>;
    expect(kept.sentDz).toBe(0.45);
  });
});
