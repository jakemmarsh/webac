/**
 * BUG.portal-rim-brush-indoor-reach (2026-11-13) — indoors the server's portal reach is the plain radius sum.
 *
 * PortalUseReporter judges a silent walk-in on the path the page SENT the server (sentPathReach). That path was
 * held to the body/portal Setup-sphere radius sum + SERVER_REACH_TOLERANCE_M (0.1 m), a band measured where the
 * server reaches past the body touch. Live on local ACE (end of retail), tools/probe-portal-walk-in.ts graze with
 * a spawned 1087 (closest horizontal pass of the body centre):
 *   outdoors (Holtburg, landcell): 1.93 / 1.94 / 1.97 / 1.99 / 2.00 m all teleported;
 *   indoors (EnvCells 0x01110108 "Storage", 0x00070143 "Town Network"): 1.41 / 1.52 / 1.64 / 1.76 m teleported,
 *   1.85 / 1.86 / 1.90 / 1.90 m did not (no WeenieError, no teleport; the page reported portal_use_failed with
 *   sentReached true), nor did 1.98-2.30 m.
 * Prod misfiled two indoor rim passes as findings: trace 80bb16163b8ab6fb (2026-11-10, cell 0x01110105,
 * sentClosest 1.88) and fa1539f3d8670e79 (2026-11-13, player 0x00070139, portal 0x0007012a, sentClosest 1.91).
 * Now an EnvCell portal (cell low 16 bits >= 0x0100) is judged with no tolerance; a landcell keeps 0.1 m.
 */
import { describe, it, expect } from 'vitest';
import {
  PortalUseReporter, PORTAL_REPLY_MS, SERVER_REACH_TOLERANCE_M, SERVER_REACH_TOLERANCE_INDOOR_M,
  sentPathReach, sentReachOf, serverReachTolerance, serverFramePoint,
  type PortalEvent, type PortalSnapshot, type SentPoint,
} from '../packages/renderer/src/telemetry/PortalUseReporter';
import { sanitizeClientPortal } from '../services/ws-tcp-bridge/src/clientWorld';
import { setupPhysicsSpheres } from '../packages/renderer/src/world/CreatureCollision';

/** The stock portal (Setup 0x020001B3: one sphere r 1.357 at z 1.42) and the human body (0x02000001: r 0.48 at z 0.475 and 1.35). */
const PORTAL_SPHERES = setupPhysicsSpheres({ spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] });
const HUMAN_SPHERES = setupPhysicsSpheres({ spheres: [
  { origin: { x: 0, y: 0, z: 0.475 }, radius: 0.48 }, { origin: { x: 0, y: 0, z: 1.35 }, radius: 0.48 },
] });
const PORTAL_GUID = 0x7a1a0024;

/** The prod cases' cells and an outdoor Holtburg landcell. */
const INDOOR_A = 0x01110105;
const INDOOR_B_PORTAL = 0x0007012a;
const INDOOR_B_PLAYER = 0x00070139;
const OUTDOOR = 0xa9b40031;

function rig(portalCell: number, playerCell = portalCell) {
  const at = serverFramePoint(portalCell, 50, 60, portalCell === OUTDOOR ? 66 : -12);
  const snap = (): PortalSnapshot => ({
    wcid: 1087, itemType: 0x10000, descFlags: 0x40014, physicsState: 0xc0c,
    useRadius: 0, reach: 1.919, rel: { dx: -3, dy: 0, dz: 0 }, playerCell, portalCell,
    portalAt: at, bodySpheres: HUMAN_SPHERES, portalSpheres: PORTAL_SPHERES,
  });
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'fa1539f3d8670e79',
    era: () => 'eor', server: () => 'local', now: () => clock.t, snapshot: snap,
    send: (_url, body) => { events.push(JSON.parse(body) as PortalEvent); },
  });
  /** A walk straight past the portal: sent positions 3 m either side, the chord passing `d` m from its centre. */
  const passAt = (d: number): Record<string, unknown> => {
    r.positionSent({ x: at.x - 3, y: at.y + d, z: at.z });
    r.overlaps([]);
    r.overlaps([PORTAL_GUID], true);
    r.approach(PORTAL_GUID, d);
    clock.t += 100;
    r.positionSent({ x: at.x + 3, y: at.y + d, z: at.z });
    for (let i = 0; i < PORTAL_REPLY_MS / 100 + 2; i++) { clock.t += 100; r.tick({ serverWalking: false, playerMoving: true }); }
    expect(events).toHaveLength(1);
    return events[0] as unknown as Record<string, unknown>;
  };
  return { passAt, at };
}

describe('serverReachTolerance: by the portal\'s cell', () => {
  it('an EnvCell gets no tolerance; a landcell keeps 0.1 m; unknown keeps 0.1 m (stays a finding)', () => {
    expect(SERVER_REACH_TOLERANCE_M).toBe(0.1);
    expect(SERVER_REACH_TOLERANCE_INDOOR_M).toBe(0);
    expect(serverReachTolerance(INDOOR_A)).toBe(0);
    expect(serverReachTolerance(INDOOR_B_PORTAL, INDOOR_B_PLAYER)).toBe(0);
    expect(serverReachTolerance(0x01aa0100)).toBe(0); // the first EnvCell id
    expect(serverReachTolerance(OUTDOOR)).toBe(0.1);
    expect(serverReachTolerance(0xa9b400ff)).toBe(0.1); // below 0x0100: a landcell
    expect(serverReachTolerance(null, null)).toBe(0.1);
    // The portal's cell decides; the player's only stands in when the portal's is unknown.
    expect(serverReachTolerance(OUTDOOR, INDOOR_A)).toBe(0.1);
    expect(serverReachTolerance(null, INDOOR_A)).toBe(0);
    expect(serverReachTolerance(0xffff0100)).toBe(0); // a high cell id is still read as unsigned
  });

  it('sentPathReach takes the tolerance: a 1.88 m chord reaches with 0.1 m, not with 0', () => {
    const at = serverFramePoint(INDOOR_A, 50, 60, -12);
    const a: SentPoint = { x: at.x - 3, y: at.y + 1.88, z: at.z };
    const b: SentPoint = { x: at.x + 3, y: at.y + 1.88, z: at.z };
    expect(sentPathReach(a, b, at, HUMAN_SPHERES, PORTAL_SPHERES, 1.919).reached).toBe(true); // default = outdoor band
    expect(sentPathReach(a, b, at, HUMAN_SPHERES, PORTAL_SPHERES, 1.919, 0.1).reached).toBe(true);
    expect(sentPathReach(a, b, at, HUMAN_SPHERES, PORTAL_SPHERES, 1.919, 0).reached).toBe(false);
    // The part-array fallback takes it too.
    expect(sentPathReach(a, { ...b, y: at.y + 1.95 }, at, null, null, 1.919, 0.1).reached).toBe(true);
    expect(sentPathReach({ ...a, y: at.y + 1.95 }, { ...b, y: at.y + 1.95 }, at, null, null, 1.919, 0).reached).toBe(false);
  });
});

describe('PortalUseReporter: an indoor walk past the rim is a rim brush; outdoors the band stays', () => {
  for (const d of [1.85, 1.88, 1.91]) {
    it(`indoors (0x01110105) a pass at ${d} m with no teleport → portal_rim_brush`, () => {
      const ev = rig(INDOOR_A).passAt(d);
      expect(ev).toMatchObject({ outcome: 'portal_rim_brush', trigger: 'walk_in', sentReached: false, sentClosest: d, portalCell: '01110105' });
    });
  }

  it('the second prod case: player in 0x00070139, portal in 0x0007012a, sentClosest 1.91 → portal_rim_brush', () => {
    const ev = rig(INDOOR_B_PORTAL, INDOOR_B_PLAYER).passAt(1.91);
    expect(ev).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false, sentClosest: 1.91, playerCell: '00070139', portalCell: '0007012a' });
  });

  it('indoors a pass at 1.5 m with no teleport stays portal_use_failed (a real failure surfaces)', () => {
    const ev = rig(INDOOR_A).passAt(1.5);
    expect(ev).toMatchObject({ outcome: 'portal_use_failed', sentReached: true, sentClosest: 1.5 });
  });

  for (const d of [1.88, 1.91]) {
    it(`outdoors (landcell 0xa9b40031) a pass at ${d} m with no teleport stays portal_use_failed (the 0.1 m band kept)`, () => {
      const ev = rig(OUTDOOR).passAt(d);
      expect(ev).toMatchObject({ outcome: 'portal_use_failed', sentReached: true, sentClosest: d, portalCell: 'a9b40031' });
    });
  }

  it('outdoors a pass at 2.0 m is still a rim brush (beyond the band)', () => {
    expect(rig(OUTDOOR).passAt(2.0)).toMatchObject({ outcome: 'portal_rim_brush', sentReached: false });
  });
});

describe('the event reports the reach it judged with (sentReach); reach stays the part-array radius', () => {
  it('indoors sentReach = the radius sum 1.84 m, outdoors 1.94 m; reach is 1.92 in both', () => {
    const indoor = rig(INDOOR_A).passAt(1.88);
    expect(indoor).toMatchObject({ reach: 1.92, sentReach: 1.84 });
    const outdoor = rig(OUTDOOR).passAt(1.88);
    expect(outdoor).toMatchObject({ reach: 1.92, sentReach: 1.94 });
  });

  it('sentReachOf: the largest sphere pair + tolerance; the part-array reach when a shape is unknown', () => {
    const base = { reach: 1.919, bodySpheres: HUMAN_SPHERES, portalSpheres: PORTAL_SPHERES, playerCell: null };
    expect(sentReachOf({ ...base, portalCell: INDOOR_A })).toBeCloseTo(0.48 + 1.357, 6);
    expect(sentReachOf({ ...base, portalCell: OUTDOOR })).toBeCloseTo(0.48 + 1.357 + 0.1, 6);
    expect(sentReachOf({ ...base, bodySpheres: null, portalCell: INDOOR_A })).toBeCloseTo(1.919, 6);
    expect(sentReachOf({ ...base, portalSpheres: [], portalCell: OUTDOOR })).toBeCloseTo(2.019, 6);
  });

  it('the bridge keeps sentReach and drops a malformed one', () => {
    const ev = rig(INDOOR_A).passAt(1.88);
    expect(sanitizeClientPortal(ev)).toEqual(ev);
    expect(sanitizeClientPortal({ ...ev, sentReach: 'far' })).toMatchObject({ sentReach: null });
  });
});
