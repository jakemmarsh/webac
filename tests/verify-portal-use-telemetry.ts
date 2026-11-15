/**
 * TELEMETRY.portal-use-failed — a portal tried (a Use, or the body walking into it) that did nothing
 * within PORTAL_REPLY_MS reports one portal_use_failed with the portal's flags, PhysicsState, use radius,
 * where it stood from the player, what the client did and what came back; a teleport reports a light
 * portal_used with its timing. Both go to POST /client-preworld and the bridge logs them as client_world
 * through its whitelist (services/ws-tcp-bridge/src/clientWorld.ts sanitizeClientPortal).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  PortalUseReporter, PORTAL_REPLY_MS, PORTAL_MAX_WAIT_MS, PORTAL_RATE_MS, chatTemplate, isPortalObject, overlapsPortal, bodyTouchesPortal,
  walkInActs, ownMovementTouch, OWN_MOVE_MIN_M, WEENIE_ERROR_ACTION_CANCELLED, WEENIE_ERROR_I_TELEPORTED, PORTAL_EARLY_REFUSAL_MS, PORTAL_REFUSAL_CODES,
  CHAIN_BREAK_ACTIONS, type MoveToStopReason,
  type PortalEvent, type PortalSnapshot, type PortalUseFailedEvent,
} from '../packages/renderer/src/telemetry/PortalUseReporter';
import {
  MoveToManager, MoveType, defaultMovementParams, performServerMovement, serverMovementStarts, serverMovementTarget, type MoveToHost,
} from '../packages/renderer/src/controllers/MoveToManager';
import { adjustMotion, applyInterpretedMotion, removeInterpretedMotion, readyMotion, HoldKey } from '../packages/renderer/src/world/RemoteMotion';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands';
import type { SeqV3 } from '../packages/renderer/src/animation/SequenceFrame';
import type { ParsedMoveTo, ParsedTurnTo } from '../packages/network/src/MovementDataParser';
import { sanitizeClientPortal, sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import { setupPhysicsSpheres, partArrayCylinder, type PhysicsSphere } from '../packages/renderer/src/world/CreatureCollision';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel';
import { openDat, DAT_PATHS } from './_harness/dat';

/** The Scrivener's Annex exit as a fake: Portal desc flag, ItemType Portal, Ethereal | ReportCollisions | Static. */
const PORTAL_GUID = 0x7013500a;
const portalObj = { itemType: 0x10000, objectDescFlags: 0x40000 };
const snap = (over: Partial<PortalSnapshot> = {}): PortalSnapshot => ({
  wcid: 90001, itemType: 0x10000, descFlags: 0x40014, physicsState: 0x4 | 0x8 | 0x1,
  useRadius: 3, reach: 1.234, rel: { dx: 2.04, dy: -1.96, dz: 0.31 },
  playerCell: 0x01350126, portalCell: 0x01350127, ...over,
});

function rig(snapshot: (g: number) => PortalSnapshot | null = () => snap()) {
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'eor', server: () => 'levistras', now: () => clock.t, snapshot,
    send: (_url, body) => { events.push(JSON.parse(body) as PortalEvent); },
  });
  /** Advance in 100 ms ticks, as main.ts does. */
  const run = (ms: number, moving = false): void => { for (let i = 0; i < ms / 100; i++) { clock.t += 100; r.tick(moving); } };
  return { r, clock, events, run };
}

describe('PortalUseReporter: a used portal that does nothing', () => {
  it('reports the portal, the player, what was sent and what came back (a server answer: portal_refused)', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    expect(g.r.watching).toBe(PORTAL_GUID);
    g.r.useDone(0);
    g.r.weenieError(0x0484);
    g.r.serverChat('Portal destination for portal ID 90001 not yet implemented!', 5);
    g.r.serverChat('Bob tells you, hi', 3); // counted, never kept
    g.run(PORTAL_REPLY_MS - 200);
    expect(g.events).toEqual([]);
    g.run(400);
    expect(g.events).toHaveLength(1);
    const e = g.events[0] as PortalUseFailedEvent & { eid: string };
    expect(e).toMatchObject({
      outcome: 'portal_refused', era: 'eor', server: 'levistras', trace: 'feedc0de12345678', build: 'b1',
      trigger: 'use', wcid: 90001, itemType: 0x10000, descFlags: 0x40014, physicsState: 0xd,
      ethereal: true, reportCollisions: true, useRadius: 3, reach: 1.23,
      dx: 2, dy: -2, dz: 0.3, dist: 2.8, endDist: 2.8,
      playerCell: '01350126', portalCell: '01350127',
      useSent: true, held: null, attempts: 1, overlapped: false, serverWalk: false, playerMoved: false,
      useDone: 0, weenieErrors: [0x0484], chatLines: 2, chatType: 5,
      chatTemplate: 'Portal destination for portal ID # not yet implemented!',
    });
    expect(e.waitedMs).toBeGreaterThanOrEqual(PORTAL_REPLY_MS);
    expect(JSON.stringify(e)).not.toMatch(/Bob/);
    expect(g.r.watching).toBeNull();
  });

  it('a Use the client kept reports useSent false and why', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, false, 'busy');
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', useSent: false, held: 'busy', useDone: null, weenieErrors: [] });
  });

  it('a use followed by a teleport reports portal_used and no failure', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(700);
    g.r.serverMovement();
    g.run(500, true);
    g.r.teleported();
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_used', trigger: 'use', wcid: 90001, ms: 1200, useSent: true, serverWalk: true, attempts: 1 });
  });

  it('ignores what is not a portal', () => {
    const g = rig();
    g.r.useAttempt(0x70000001, { itemType: 0x10, objectDescFlags: 0x1000 }, true); // a door
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toEqual([]);
    expect(isPortalObject({ itemType: 0, objectDescFlags: 0x40000 })).toBe(true);
    expect(isPortalObject({ itemType: 0x10000, objectDescFlags: 0 })).toBe(true);
    expect(isPortalObject(null)).toBe(false);
  });

  it("the server's walk to the portal extends the wait, up to the cap", () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.serverMovement();
    g.run(PORTAL_REPLY_MS * 3, true);
    expect(g.events).toEqual([]);
    g.run(PORTAL_MAX_WAIT_MS, true);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', serverWalk: true });
    expect((g.events[0] as PortalUseFailedEvent).waitedMs).toBeLessThanOrEqual(PORTAL_MAX_WAIT_MS + 100);
  });

  it('a second use of the same portal is another attempt in the same watch', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(3000);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(3000);
    expect(g.events).toEqual([]);
    g.run(2100);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ attempts: 2 });
  });

  it('reports a portal at most once a minute', () => {
    const g = rig();
    for (let i = 0; i < 3; i++) { g.r.useAttempt(PORTAL_GUID, portalObj, true); g.run(PORTAL_REPLY_MS + 100); }
    expect(g.events).toHaveLength(1);
    g.run(PORTAL_RATE_MS);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events).toHaveLength(2);
  });

  it('drops a watch whose portal is gone (nothing to report)', () => {
    const g = rig(() => null);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toEqual([]);
  });
});

describe('PortalUseReporter: walking into a portal', () => {
  it('a newly overlapped portal with no teleport reports trigger walk_in', () => {
    const g = rig();
    g.r.overlaps([]); // the baseline
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', trigger: 'walk_in', useSent: false, held: null, overlapped: true, attempts: 0 });
  });

  it('standing on a portal at arrival (the check after a teleport or world entry) is no try', () => {
    const g = rig();
    g.r.reset();
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS * 2);
    g.r.teleported();
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toEqual([]);
  });

  it('walking into the portal being used marks the use overlapped; the teleport reports portal_used', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(300);
    g.r.overlaps([PORTAL_GUID]);
    g.r.teleported();
    expect(g.events).toEqual([expect.objectContaining({ outcome: 'portal_used', trigger: 'use', ms: 300 })]);
  });

  it('the closest approach of the body during the watch rides on the failure', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.overlaps([PORTAL_GUID]);
    g.r.approach(PORTAL_GUID, 1.734);
    g.r.approach(PORTAL_GUID, 0.416);
    g.r.approach(0x70000001, 0.01); // another portal: not this watch
    g.r.approach(PORTAL_GUID, 3.2);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ trigger: 'walk_in', closest: 0.42 });
    const h = rig();
    h.r.useAttempt(PORTAL_GUID, portalObj, true);
    h.run(PORTAL_REPLY_MS + 100);
    expect(h.events[0]).toMatchObject({ trigger: 'use', closest: null });
  });

  it('overlapsPortal: the body within the reach, the portal base near the feet', () => {
    expect(overlapsPortal(1.0, 0, 1.2, 0)).toBe(true);
    expect(overlapsPortal(1.3, 0, 1.2, 0)).toBe(false);
    expect(overlapsPortal(1.3, 0, 1.2, 0.5)).toBe(true);
    expect(overlapsPortal(0.5, 5, 1.2, 0)).toBe(false); // a floor above
    expect(overlapsPortal(Number.NaN, 0, 1.2, 0)).toBe(false);
  });
});

/**
 * BUG.gdle-walkin-portal-silent — a walk-in counts only when the body's Setup spheres touch the portal's,
 * as the server's transition finds them (GDLE CPhysicsObj::report_object_collision → CPortal::DoCollision;
 * ACE PhysicsObj.FindObjCollisions). The stock portal (Setup 0x020001B3): one sphere r 1.357 at z 1.42,
 * part-array radius 1.919. The human body (0x02000001): r 0.48 at z 0.475 and z 1.35.
 */
const PORTAL_SPHERES: PhysicsSphere[] = setupPhysicsSpheres({ spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] });
const HUMAN_SPHERES: PhysicsSphere[] = setupPhysicsSpheres({ spheres: [
  { origin: { x: 0, y: 0, z: 0.475 }, radius: 0.48 }, { origin: { x: 0, y: 0, z: 1.35 }, radius: 0.48 },
] });

describe('bodyTouchesPortal: the shapes the server collides', () => {
  it('touches inside the sphere sum (1.837 m level), not on the rim the part-array reach still covered', () => {
    expect(bodyTouchesPortal(0, 0, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(true);
    expect(bodyTouchesPortal(1.8, 0, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(true);
    // The rim: within the 1.919 m reach the old test used, outside every sphere pair.
    expect(overlapsPortal(1.88, 0, 1.919, 0)).toBe(true);
    expect(bodyTouchesPortal(1.88, 0, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(false);
  });

  it('height counts: a portal base 1.9 m above the feet is out of reach, 1.9 m below only near the middle', () => {
    expect(overlapsPortal(0.5, 1.9, 1.919, 0)).toBe(true); // the old window took it
    expect(bodyTouchesPortal(0.5, 1.9, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(false);
    expect(bodyTouchesPortal(0.3, -1.9, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(true);
    expect(bodyTouchesPortal(1.6, -1.9, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(false);
  });

  it('scale grows both the centre heights and the radii; empty or NaN never touches', () => {
    const big = setupPhysicsSpheres({ spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] }, 2);
    expect(big).toEqual([{ x: 0, y: 0, z: 2.84, radius: 2.714 }]);
    expect(bodyTouchesPortal(2.7, 0, HUMAN_SPHERES, big)).toBe(true);
    expect(bodyTouchesPortal(3.0, 0, HUMAN_SPHERES, big)).toBe(false);
    expect(bodyTouchesPortal(0, 0, [], PORTAL_SPHERES)).toBe(false);
    expect(bodyTouchesPortal(Number.NaN, 0, HUMAN_SPHERES, PORTAL_SPHERES)).toBe(false);
    expect(setupPhysicsSpheres(null)).toEqual([]);
    expect(setupPhysicsSpheres({ spheres: [{ radius: 0.7 }] })).toEqual([{ x: 0, y: 0, z: 0, radius: 0.7 }]);
  });

  it('ServerObjectManager gives every part-array object its scaled Setup spheres', () => {
    const smr = {
      createSetupMeshWithOverrides: () => new THREE.Group(),
      loadSetupModel: (id: number) => (id === 0x020001b3
        ? { radius: 1.919, height: 2.714, cylSpheres: [], spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] }
        : null),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
    const o = m.createObject({
      guid: 0x7a0000aa, name: 'Portal', weenieClassId: 22011, itemType: 0x10000,
      position: { landblock: 0xA9B40017, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 }, setupId: 0x020001b3, motionTableId: 0, iconId: 0,
      physicsState: 0xc0c, objectDescFlags: 0x40000, radarColor: 0, radarBehavior: 0, basePalette: 0, subPalettes: [],
      textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
      validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0,
      velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
      iconOverlayId: 0, iconUnderlayId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)!;
    expect(o.physicsSpheres).toEqual(PORTAL_SPHERES);
    expect(o.collisionRadius).toBeCloseTo(1.919, 6);
    m.setObjectScale(0x7a0000aa, 1.5);
    expect(o.physicsSpheres![0].radius).toBeCloseTo(1.357 * 1.5, 6);
  });
});

const CLASSIC_PORTAL = resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat');
describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(CLASSIC_PORTAL))('bodyTouchesPortal on the DAT shapes (end of retail and Dark Majesty)', () => {
  const shapes: Record<string, { portal: PhysicsSphere[]; body: PhysicsSphere[]; reach: number }> = {};
  beforeAll(() => {
    for (const [era, path] of [['eor', DAT_PATHS.portal], ['classic', CLASSIC_PORTAL]] as const) {
      const db = openDat(path);
      const portal = new SetupModel(db.getReader(0x020001b3));
      const body = new SetupModel(db.getReader(0x02000001));
      shapes[era] = { portal: setupPhysicsSpheres(portal), body: setupPhysicsSpheres(body), reach: partArrayCylinder(portal).radius };
    }
  });

  it('both eras: the rim between the touch and the part-array reach is no walk-in', () => {
    for (const era of ['eor', 'classic']) {
      const { portal, body, reach } = shapes[era];
      expect(portal).toHaveLength(1);
      expect(body).toHaveLength(2);
      expect(reach).toBeGreaterThan(1.9);
      expect(bodyTouchesPortal(1.8, 0, body, portal)).toBe(true);
      expect(bodyTouchesPortal(reach - 0.02, 0, body, portal)).toBe(false);
      expect(overlapsPortal(reach - 0.02, 0, reach, 0)).toBe(true);
    }
  });
});

/**
 * BUG.portal-walk-in-nothing — 7 days of production portal_use_failed (2026-10-28 → 11-03): 31 of 49
 * were the server refusing (0x0474 quest: the Training Academy exits 31061 / 29338 with
 * QuestRestriction; 0x04AB level; 0x0592 account age; AC1999 chat refusals), 15 were walk-ins into
 * portals that cannot act on a walk-in (Gateway 1955 PhysicsState 0x804, IgnoreCollisions portals),
 * 2 were uses the player walked away from or died during. Retail and all three servers reach a portal's
 * weenie on a collision only when it has ReportCollisions and the mover lacks IgnoreCollisions
 * (retail CPhysicsObj::report_object_collision @ 0x00513060; ACE PhysicsObj.cs; GDLE and the AC1999
 * server PhatSDK/PhysicsObj.cpp report_object_collision).
 */
describe('BUG.portal-walk-in-nothing: what a walk-in can reach, and what counts as a failure', () => {
  /** PhysicsStates read off the production events and the servers' weenie data, per era. */
  const STATES = {
    eorPurple: 3084, // 0xC0C Ethereal | ReportCollisions | Gravity | LightingOn (ACE 31061, 29338, 1087)
    eorGateway: 2052, // 0x804 Ethereal | LightingOn (ACE 1955 "Gateway": "You must use this portal…")
    classicGateway: 2052, // GDLE Classic Dereth 1955 at 0x01C9022E (production 2026-10-29 … 10-31)
    classicPortal: 3084, // GDLE 12770 at 0x03630299
    ac1999Portal: 3084, // AC1999 CPortal: ETHEREAL | REPORT_COLLISIONS | LIGHTING_ON | GRAVITY (Portal.cpp)
    ignoreCollisions: 3100, // 0xC1C custom 530018: IgnoreCollisions set
    asEnvironment: 0x200000 | 0xc0c,
  };

  it('walkInActs: ReportCollisions without IgnoreCollisions, in every era', () => {
    expect(walkInActs(STATES.eorPurple)).toBe(true);
    expect(walkInActs(STATES.classicPortal)).toBe(true);
    expect(walkInActs(STATES.ac1999Portal)).toBe(true);
    expect(walkInActs(0xd)).toBe(true);
    expect(walkInActs(STATES.eorGateway)).toBe(false);
    expect(walkInActs(STATES.classicGateway)).toBe(false);
    expect(walkInActs(STATES.ignoreCollisions)).toBe(false);
    expect(walkInActs(6292508)).toBe(false); // custom 1000052: IgnoreCollisions among its bits
    expect(walkInActs(STATES.asEnvironment)).toBe(false);
    expect(walkInActs(Number.NaN)).toBe(false);
  });

  it('walking through a Gateway is no try (nothing reported); using it is watched as before', () => {
    for (const ps of [STATES.eorGateway, STATES.classicGateway, STATES.ignoreCollisions]) {
      const g = rig(() => snap({ wcid: 1955, physicsState: ps, useRadius: 0.75 }));
      g.r.overlaps([]);
      g.r.overlaps([PORTAL_GUID]);
      expect(g.r.watching).toBeNull();
      g.run(PORTAL_REPLY_MS * 2);
      expect(g.events).toEqual([]);
      g.r.useAttempt(PORTAL_GUID, portalObj, true);
      g.r.serverMovement();
      g.run(800, true);
      g.r.teleported();
      expect(g.events).toEqual([expect.objectContaining({ outcome: 'portal_used', trigger: 'use', wcid: 1955 })]);
    }
  });

  it('a walk-in into a portal that reports collisions is still watched, in every era', () => {
    for (const ps of [STATES.eorPurple, STATES.classicPortal, STATES.ac1999Portal]) {
      const g = rig(() => snap({ physicsState: ps }));
      g.r.overlaps([]);
      g.r.overlaps([PORTAL_GUID]);
      g.run(PORTAL_REPLY_MS + 100);
      expect(g.events).toEqual([expect.objectContaining({ outcome: 'portal_use_failed', trigger: 'walk_in', weenieErrors: [] })]);
    }
  });

  it('a server refusal is portal_refused: a quest / level / age WeenieError, or a portal chat line (AC1999)', () => {
    for (const code of [0x0474, 0x04ab, 0x0592, 0x04a7]) {
      const g = rig();
      g.r.overlaps([]);
      g.r.overlaps([PORTAL_GUID]);
      g.r.weenieError(code);
      g.run(PORTAL_REPLY_MS + 100);
      expect(g.events).toEqual([expect.objectContaining({ outcome: 'portal_refused', trigger: 'walk_in', weenieErrors: [code] })]);
    }
    const h = rig(() => snap({ physicsState: STATES.ac1999Portal }));
    h.r.overlaps([]);
    h.r.overlaps([PORTAL_GUID]);
    h.r.serverChat('You are not powerful enough to interact with that portal!', 0);
    h.run(PORTAL_REPLY_MS + 100);
    expect(h.events[0]).toMatchObject({ outcome: 'portal_refused', chatTemplate: 'You are not powerful enough to interact with that portal!' });
  });

  it('a use the client refused itself (UseObject decided: an ItemUseable-No portal, 28709) is portal_refused', () => {
    const g = rig(() => snap({ wcid: 28709, physicsState: 3092 }));
    g.r.useAttempt(PORTAL_GUID, portalObj, false, 'decided');
    g.r.useAttempt(PORTAL_GUID, portalObj, false, 'decided');
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', useSent: false, held: 'decided', attempts: 2 });
    const h = rig();
    h.r.useAttempt(PORTAL_GUID, portalObj, false, 'busy');
    h.run(PORTAL_REPLY_MS + 100);
    expect(h.events[0]).toMatchObject({ outcome: 'portal_use_failed', held: 'busy' });
  });

  it('ActionCancelled alone is no refusal: an unanswered try stays portal_use_failed', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.weenieError(WEENIE_ERROR_ACTION_CANCELLED);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', weenieErrors: [0x36], playerMoved: false });
  });

  it("the player's own movement never extends the wait; walking off from a use without reaching the portal is no failure", () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.serverMovement();
    g.r.tick({ serverWalking: true, playerMoving: false });
    for (let i = 0; i < 300; i++) { g.clock.t += 100; g.r.tick({ serverWalking: false, playerMoving: true }); }
    expect(g.r.watching).toBeNull();
    expect(g.events).toEqual([]);
  });

  it('a use the player then walked into themselves is still reported when nothing came of it', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.clock.t += 100; g.r.tick({ serverWalking: false, playerMoving: true });
    g.r.overlaps([PORTAL_GUID]);
    for (let i = 0; i < 60; i++) { g.clock.t += 100; g.r.tick({ serverWalking: false, playerMoving: false }); }
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', trigger: 'use', overlapped: true, playerMoved: true });
  });

  it('a death during the watch drops it (no event either way)', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.serverMovement();
    g.clock.t += 100; g.r.tick({ serverWalking: true, playerMoving: false, dead: true });
    expect(g.r.watching).toBeNull();
    g.run(PORTAL_MAX_WAIT_MS);
    expect(g.events).toEqual([]);
  });

  it('the bridge keeps portal_refused with every field, and playerMoved', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.overlaps([PORTAL_GUID]);
    g.r.weenieError(0x0474);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', playerMoved: false });
    expect(sanitizeClientPortal(g.events[0])).toEqual(g.events[0]);
  });
});

/**
 * BUG.portal-refusal-before-watch — Coldeve (ACE), trace c9340448a5d0ec95, build 12059fff4: a walk-in into
 * wcid 1307 (PhysicsState 3084) drew 0x04A7 "You have been teleported too recently!" at 13:22:20.541; the
 * walk-in watch began 6 ms later and reported portal_use_failed with weenieErrors [] at 13:22:25.612
 * (waitedMs 5065). The server's collision beat the page's 100 ms touch check.
 */
describe('BUG.portal-refusal-before-watch: a refusal that beat the watch is its answer', () => {
  const PURPLE = 3084;
  const COLDEVE = { wcid: 1307, physicsState: PURPLE };
  /** In the world past the overlap baseline, touching nothing. */
  const inWorld = (snapOver: Partial<PortalSnapshot> = COLDEVE) => {
    const g = rig(() => snap(snapOver));
    g.r.overlaps([]);
    return g;
  };

  it('the production shape: 0x04A7 6 ms before the walk-in watch → portal_refused, not portal_use_failed (end of retail)', () => {
    const g = inWorld();
    g.r.weenieError(0x04a7);
    g.clock.t += 6;
    g.r.overlaps([PORTAL_GUID]);
    expect(g.r.watching).toBe(PORTAL_GUID);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', trigger: 'walk_in', wcid: 1307, weenieErrors: [0x04a7], refusalLeadMs: 6 });
    expect(sanitizeClientPortal(g.events[0])).toEqual(g.events[0]);
  });

  it('every ACE portal refusal code is held; GDLE and AC1999 chat refusals are held too', () => {
    for (const code of PORTAL_REFUSAL_CODES) {
      const g = inWorld();
      g.r.weenieError(code);
      g.clock.t += 80;
      g.r.overlaps([PORTAL_GUID]);
      g.run(PORTAL_REPLY_MS + 100);
      expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', weenieErrors: [code], refusalLeadMs: 80 });
    }
    for (const [era, line] of [
      ['dm', 'You try to enter the portal but there is no effect.'], // GDLE Portal.cpp CheckedTeleport (quest)
      ['dm', 'You are not powerful enough to use this portal yet.'],
      ['ac1999', 'You have been teleported too recently!'], // AC1999 Portal.cpp
      ['ac1999', 'You are not powerful enough to interact with that portal!'],
    ] as const) {
      const g = inWorld();
      g.r.serverChat(line, era === 'dm' ? 0x11 : 0);
      g.clock.t += 50;
      g.r.overlaps([PORTAL_GUID]);
      g.run(PORTAL_REPLY_MS + 100);
      expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', chatTemplate: line, weenieErrors: [], refusalLeadMs: 50 });
    }
  });

  it('a use right after an unattributed refusal is refused too (ACE answers a repeat inside 3.5 s with silence)', () => {
    const g = inWorld();
    g.r.weenieError(0x04a7);
    g.clock.t += 900;
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', trigger: 'use', weenieErrors: [0x04a7], refusalLeadMs: 900 });
  });

  it('a refusal older than PORTAL_EARLY_REFUSAL_MS is stale: a later silent walk-in stays portal_use_failed', () => {
    const g = inWorld();
    g.r.weenieError(0x04a7);
    g.clock.t += PORTAL_EARLY_REFUSAL_MS + 1;
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', weenieErrors: [], refusalLeadMs: null });
  });

  it('a held refusal is taken once: the next portal tried stays portal_use_failed', () => {
    const g = inWorld();
    const other = PORTAL_GUID + 1;
    g.r.weenieError(0x0474);
    g.r.overlaps([PORTAL_GUID]);
    g.r.overlaps([]);
    g.clock.t += 100;
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS + 100);
    g.r.overlaps([]);
    g.r.overlaps([other]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events.map((e) => [e.outcome, (e as PortalUseFailedEvent).weenieErrors])).toEqual([
      ['portal_refused', [0x0474]],
      ['portal_use_failed', []],
    ]);
  });

  it("another request's answer is not held: a busy / inventory / combat error before a walk-in stays out of it", () => {
    for (const code of [0x001d, 0x0036, 0x003c, 0x0484, 0x04c9]) {
      expect(PORTAL_REFUSAL_CODES.has(code)).toBe(false);
      const g = inWorld();
      g.r.weenieError(code);
      g.clock.t += 10;
      g.r.overlaps([PORTAL_GUID]);
      g.run(PORTAL_REPLY_MS + 100);
      expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', weenieErrors: [], refusalLeadMs: null });
    }
    const h = inWorld();
    h.r.serverChat('Bob tells you, see you at the portal', 3);
    expect(h.events).toEqual([]);
  });

  it('a walk-in into a portal that cannot act on walk-ins takes no refusal (and leaves it for a real try)', () => {
    const gate = PORTAL_GUID + 7;
    const g = rig((guid) => snap(guid === gate ? { wcid: 1955, physicsState: 2052 } : COLDEVE)); // Gateway: Ethereal | LightingOn
    g.r.overlaps([]);
    g.r.weenieError(0x04a7);
    g.r.overlaps([gate]);
    expect(g.r.watching).toBeNull();
    g.clock.t += 100;
    g.r.overlaps([gate, PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', wcid: 1307, weenieErrors: [0x04a7], refusalLeadMs: 100 });
    // Only the Gateway: nothing at all.
    const h = rig(() => snap({ wcid: 1955, physicsState: 2052 }));
    h.r.overlaps([]);
    h.r.weenieError(0x04a7);
    h.r.overlaps([PORTAL_GUID]);
    h.run(PORTAL_REPLY_MS + 100);
    expect(h.events).toEqual([]);
  });

  it('a refusal heard before the overlap baseline (portal space, entry) or before a teleport is not held', () => {
    // Before the baseline: the notices around a teleport.
    const g = rig(() => snap(COLDEVE));
    g.r.weenieError(0x04a7);
    g.r.serverChat('You have been teleported.', 0x11);
    g.r.overlaps([]);
    g.clock.t += 100;
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', weenieErrors: [], chatTemplate: null });
    // Held, then a teleport (the try went through elsewhere) or leaving the world drops it.
    for (const drop of ['teleported', 'reset'] as const) {
      const h = inWorld();
      h.r.weenieError(0x04a7);
      h.r[drop]();
      h.r.overlaps([]);
      h.clock.t += 100;
      h.r.overlaps([PORTAL_GUID]);
      h.run(PORTAL_REPLY_MS + 100);
      expect(h.events[0]).toMatchObject({ outcome: 'portal_use_failed', weenieErrors: [] });
    }
  });

  it('a refusal during a watch still goes to that watch, never held for the next', () => {
    const g = inWorld();
    g.r.overlaps([PORTAL_GUID]);
    g.r.weenieError(0x04ab);
    g.run(PORTAL_REPLY_MS + 100);
    g.r.overlaps([]);
    g.r.overlaps([PORTAL_GUID + 1]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events.map((e) => [e.outcome, (e as PortalUseFailedEvent).refusalLeadMs])).toEqual([
      ['portal_refused', null],
      ['portal_use_failed', null],
    ]);
  });

  it('ITeleported (0x003C, ACE after every portal teleport) is no refusal inside a watch', () => {
    const g = inWorld();
    g.r.overlaps([PORTAL_GUID]);
    g.r.weenieError(WEENIE_ERROR_I_TELEPORTED);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', weenieErrors: [0x3c] });
  });
});

describe('BUG.portal-walkin-without-moving: a touch the player\'s own movement did not make is no try', () => {
  /** The Coldeve portal: wcid 42155, PhysicsState 0xC0C (ReportCollisions), in cell 0x8a020111. */
  const coldeve = () => rig(() => snap({ wcid: 42155, physicsState: 3084, playerCell: 0x8a020111, portalCell: 0x8a020111 }));

  it('a portal that reaches a standing body (the Coldeve event) starts no watch and reports nothing', () => {
    const g = coldeve();
    g.r.overlaps([]); // the baseline
    for (let i = 0; i < 60; i++) { g.r.overlaps([PORTAL_GUID], false); g.run(100); }
    expect(g.r.watching).toBeNull();
    expect(g.events).toEqual([]);
  });

  it('the first own step while still touching is the try (retail: teleported on the first step)', () => {
    const g = coldeve();
    g.r.overlaps([]);
    g.r.overlaps([PORTAL_GUID], false);
    g.r.overlaps([PORTAL_GUID], false);
    expect(g.r.watching).toBeNull();
    g.r.overlaps([PORTAL_GUID], true);
    expect(g.r.watching).toBe(PORTAL_GUID);
    g.clock.t += 400;
    g.r.teleported();
    expect(g.events).toEqual([expect.objectContaining({ outcome: 'portal_used', trigger: 'walk_in', wcid: 42155 })]);
  });

  it('a keyboard walk-in into a portal that does nothing still reports portal_use_failed', () => {
    const g = coldeve();
    g.r.overlaps([]);
    g.r.overlaps([PORTAL_GUID], true);
    expect(g.r.watching).toBe(PORTAL_GUID);
    for (let i = 0; i < PORTAL_REPLY_MS / 100 + 2; i++) {
      g.r.overlaps([PORTAL_GUID], true);
      g.clock.t += 100;
      g.r.tick({ serverWalking: false, playerMoving: true });
    }
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', trigger: 'walk_in', wcid: 42155, playerMoved: true });
  });

  it('a body that stops inside after the walk-in began keeps the one watch, and does not restart it', () => {
    const g = coldeve();
    g.r.overlaps([]);
    g.r.overlaps([PORTAL_GUID], true);
    g.r.overlaps([PORTAL_GUID], false);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events).toHaveLength(1);
    expect(g.r.watching).toBeNull();
    g.r.overlaps([PORTAL_GUID], true); // still inside: not a new touch
    expect(g.r.watching).toBeNull();
  });

  it('a use watch is unchanged: a still body touching the used portal marks it overlapped', () => {
    const g = coldeve();
    g.r.overlaps([]);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.overlaps([PORTAL_GUID], false);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ trigger: 'use', overlapped: true, outcome: 'portal_use_failed' });
  });

  it('a refusal heard before a still touch stays held for the next real walk-in', () => {
    const g = coldeve();
    g.r.overlaps([]);
    g.r.weenieError(0x04a7);
    g.r.overlaps([PORTAL_GUID], false);
    expect(g.r.watching).toBeNull();
    g.clock.t += 100;
    g.r.overlaps([PORTAL_GUID], true);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_refused', weenieErrors: [0x04a7], refusalLeadMs: 100 });
  });

  it('ownMovementTouch: the body moved, no placement, and the player\'s own movement drove it', () => {
    const base = { displacedM: 0.5, placed: false, keys: false, serverWalk: false, airborne: false, moveSent: false };
    expect(ownMovementTouch(base)).toBe(false); // moved with nothing of its own driving it
    expect(ownMovementTouch({ ...base, keys: true })).toBe(true);
    expect(ownMovementTouch({ ...base, serverWalk: true })).toBe(true);
    expect(ownMovementTouch({ ...base, airborne: true })).toBe(true);
    expect(ownMovementTouch({ ...base, moveSent: true })).toBe(true);
    expect(ownMovementTouch({ ...base, keys: true, placed: true })).toBe(false); // a forced position / an arrival
    expect(ownMovementTouch({ ...base, keys: true, displacedM: 0 })).toBe(false); // keys against a wall, or only turning
    expect(ownMovementTouch({ ...base, keys: true, displacedM: OWN_MOVE_MIN_M / 2 })).toBe(false);
    expect(ownMovementTouch({ ...base, keys: true, displacedM: NaN })).toBe(false);
  });
});

describe('chatTemplate', () => {
  it('keeps only portal lines, numbers as #', () => {
    expect(chatTemplate('You have been teleported too recently!')).toBe('You have been teleported too recently!');
    expect(chatTemplate('Portal 0x7013500A at 12.5 m')).toBe('Portal # at # m');
    expect(chatTemplate('Welcome to Asheron\'s Call')).toBeNull();
  });
});

describe('the bridge keeps the portal fields', () => {
  it('sanitizeClientPortal keeps every field the page sends and drops junk', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.approach(PORTAL_GUID, 0.734);
    g.r.useDone(0);
    g.r.weenieError(0x0484);
    g.r.serverChat('Portal destination for portal ID 90001 not yet implemented!', 5);
    g.run(PORTAL_REPLY_MS + 100);
    const sent = g.events[0];
    expect(sanitizeClientPortal(sent)).toEqual(sent);
    // The world sanitizer does not take them (their own route branch does).
    expect(sanitizeClientWorld(sent)).toBeNull();
    const junk = sanitizeClientPortal({
      ...sent, name: 'Portal to Zaikhal', chatTemplate: 'Bob has 3 pyreals', playerCell: '0x0135', weenieErrors: [1, 'x', -1, 2, 3, 4, 5],
      trigger: 'telepathy', dx: Infinity, physicsState: 2 ** 33, closest: 'near',
    }) as unknown as Record<string, unknown>;
    expect((sent as PortalUseFailedEvent).closest).toBe(0.73);
    expect(junk).not.toHaveProperty('name');
    expect(junk).toMatchObject({ chatTemplate: null, playerCell: null, weenieErrors: [1, 2], trigger: null, dx: null, physicsState: null, closest: null });
  });

  it('sanitizeClientPortal keeps portal_used', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.clock.t += 850;
    g.r.teleported();
    expect(sanitizeClientPortal(g.events[0])).toEqual(g.events[0]);
    expect(sanitizeClientPortal({ outcome: 'first_minute' })).toBeNull();
  });

  it('POST /client-preworld logs a portal event as one client_world line', async () => {
    const c: BridgeConfig = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const g = rig();
      g.r.useAttempt(PORTAL_GUID, portalObj, true);
      g.run(PORTAL_REPLY_MS + 100);
      const res = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(g.events[0]) });
      expect(res.status).toBe(204);
      const line = logs.find((l) => l[1] === 'client_world')!;
      const { ip, ...fields } = line[2];
      expect(ip).toEqual(expect.any(String));
      expect(fields).toEqual(Object.fromEntries(Object.entries(g.events[0]).filter(([, v]) => v !== null)));
      expect(bridge.metrics.clientPreworld.get('portal_use_failed')).toBe(1);
    } finally {
      await bridge.shutdown();
    }
  });
});

/**
 * OBS.portal-use-server-walk-run — did our client run the server's walk to the portal, and why did it stop?
 * Prod (DreamWeave ACE, end of retail, wcid 1003604, 2026-11-15): serverWalk true, serverMoves 1, the body never
 * moved (closest = dist = endDist 3.54), UseDone(0) at 503 ms, no MoveToState. These drive the real MoveToManager
 * the way main.ts's onLocalPlayerMovement does (serverMovementStarts → the superseding cancel named →
 * serverMovement → performServerMovement; its onComplete → moveToEnded) and read the event's move fields.
 */
describe('OBS.portal-use-server-walk-run: the server walk our client ran, and why it stopped', () => {
  const LB = 0x2561;
  /** Player at cell 0x25610030 local (10, 10, 0); the portal 3.54 m east in 0x25610028 (one dungeon frame). */
  const START: SeqV3 = { x: ((LB >>> 8) & 0xff) * 192 + 10, y: (LB & 0xff) * 192 + 10, z: 0 };
  const moveToPortal = (over: Partial<ParsedMoveTo> = {}): { moveTo: ParsedMoveTo } => ({
    moveTo: {
      target: 0, cellId: 0x25610028, origin: { x: 13.54, y: 10, z: 0 }, flags: defaultMovementParams().flags,
      distanceToObject: 0.6, minDistance: 0, failDistance: 3.4028235e38, speed: 1, walkRunThreshold: 15,
      desiredHeading: 0, runRate: 1, ...over,
    },
  });

  function walkRig(opts: { motionsPending?: () => boolean } = {}) {
    const g = rig();
    const s = { pos: { ...START }, heading: 0, st: readyMotion(), reason: null as MoveToStopReason | null };
    const host: MoveToHost = {
      position: () => s.pos,
      heading: () => s.heading,
      setHeading: (h) => { s.heading = h; },
      radius: () => 0.5,
      height: () => 1.8,
      doMotion: (cmd, speed, hk) => { const a = adjustMotion(cmd, speed, hk, HoldKey.None, 1); applyInterpretedMotion(s.st, a.motion, a.speed); return 0; },
      stopMotion: (cmd, speed, hk) => { removeInterpretedMotion(s.st, adjustMotion(cmd, speed, hk, HoldKey.None, 1).motion); return 0; },
      stopCompletely: () => { Object.assign(s.st, readyMotion()); },
      motionsPending: opts.motionsPending ?? (() => false),
      hasContact: () => true,
      target: () => null,
      // main.ts: portalUseReporter.moveToEnded(status, playerMoveToStopReason, playerMovePoint())
      onComplete: (status) => g.r.moveToEnded(status, s.reason, { ...s.pos }),
      now: () => g.clock.t / 1000,
    };
    const mgr = new MoveToManager(host);
    /** main.ts stopPlayerMoveTo. */
    const stop = (reason: MoveToStopReason): void => { s.reason = reason; try { mgr.cancelMoveTo(); } finally { s.reason = null; } };
    /** main.ts serverObjectManager.onLocalPlayerMovement. */
    const serverMove = (type: number, move: { moveTo?: ParsedMoveTo; turnTo?: ParsedTurnTo }): void => {
      const starts = serverMovementStarts(type, move);
      if (starts && mgr.isMovingTo()) stop('superseded');
      g.r.serverMovement(type, { started: starts, at: { ...s.pos }, target: serverMovementTarget(type, move, () => null) });
      performServerMovement(mgr, type, move, () => false);
    };
    /** 100 ms portal checks, each over five 20 ms frames of MoveToManager.useTime + the motion's movement. */
    const run = (ms: number): void => {
      for (let i = 0; i < ms / 100; i++) {
        for (let f = 0; f < 5; f++) {
          if (mgr.isMovingTo()) mgr.useTime();
          const dt = 0.02;
          if (s.st.turn) s.heading = (((s.heading + 1.5 * s.st.turnSpeed * dt * (180 / Math.PI)) % 360) + 360) % 360;
          const v = s.st.forward === MotionCommand.RunForward ? 4 * s.st.forwardSpeed
            : s.st.forward === MotionCommand.WalkForward ? 3.12 * s.st.forwardSpeed : 0;
          const h = s.heading * (Math.PI / 180);
          s.pos = { x: s.pos.x + Math.sin(h) * v * dt, y: s.pos.y + Math.cos(h) * v * dt, z: s.pos.z };
          g.clock.t += 20;
        }
        g.r.tick({
          serverWalking: mgr.isMovingTo(), playerMoving: false,
          moveTo: mgr.isMovingTo() ? { at: { ...s.pos }, phase: mgr.phase() } : null,
        });
      }
    };
    return { ...g, s, mgr, stop, serverMove, run };
  }
  const failed = (g: { events: PortalEvent[] }): PortalUseFailedEvent => g.events.find((e) => e.outcome !== 'portal_used') as PortalUseFailedEvent;

  it('a MoveToPosition our client started and never stepped (its turn waiting on motions), the UseDone(0) at 500 ms: running, 0 m', () => {
    const g = walkRig({ motionsPending: () => true });
    g.r.useAttempt(PORTAL_GUID, portalObj, true, null, false);
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    expect(g.mgr.isMovingTo()).toBe(true);
    g.run(500);
    g.r.useDone(0); // ACE's chain gave up; our client does not stop its MoveTo on a UseDone
    g.run(PORTAL_MAX_WAIT_MS);
    const e = failed(g);
    expect(e).toMatchObject({
      outcome: 'portal_use_failed', serverWalk: true, serverMoves: 1, useDone: 0, useDones: 1, firstUseDoneMs: 500, movesSent: 0,
      moveTypes: [7], moveEnds: ['running'], moveDist: 3.54, moveLeft: 3.54, moveMoved: 0, movePhase: 'turn_wait',
      chainBreaks: 0, chainBreakTypes: [],
    });
    expect(e.moveMs).toBeGreaterThanOrEqual(PORTAL_MAX_WAIT_MS - 1000);
  });

  it('a MoveToPosition our client judged already in range ends at once (arrived, 0 ms, 0 m, never sampled)', () => {
    const g = walkRig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.serverMove(MoveType.MoveToPosition, moveToPortal({ origin: { x: 10.3, y: 10, z: 0 } }));
    expect(g.mgr.isMovingTo()).toBe(false);
    g.run(200);
    g.r.useDone(0);
    g.run(PORTAL_REPLY_MS + 100);
    expect(failed(g)).toMatchObject({
      outcome: 'portal_use_failed', moveTypes: [7], moveEnds: ['arrived'], moveDist: 0.3, moveLeft: 0.3, moveMoved: 0, moveMs: 0, movePhase: null,
    });
  });

  it('a MoveToPosition our client walked to the end (arrived), with no teleport after it', () => {
    const g = walkRig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    g.run(3000);
    expect(g.mgr.isMovingTo()).toBe(false);
    g.run(PORTAL_REPLY_MS + 100);
    const e = failed(g);
    expect(e).toMatchObject({ outcome: 'portal_use_failed', moveTypes: [7], moveEnds: ['arrived'], moveDist: 3.54, movePhase: 'move' });
    // Arrival is judged on the cylinder distance (UseSpheres: less the body's 0.5 m radius); moveLeft is origin to origin.
    expect(e.moveLeft!).toBeLessThanOrEqual(0.6 + 0.5);
    expect(e.moveMoved!).toBeGreaterThan(2.3);
    expect(e.moveMs!).toBeGreaterThan(0);
    expect(e.moveMs!).toBeLessThan(3000);
  });

  it("a MoveToPosition the player's movement key took back (input), its MoveToState sent: portal_cancelled", () => {
    const g = walkRig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true, null, false);
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    g.run(1300); // the 90° turn east first, then part of the walk
    g.stop('input'); // CameraController.takeControlFromServer → onTakeControlFromServer
    g.r.movementSent();
    g.run(PORTAL_REPLY_MS + 100);
    const e = failed(g);
    expect(e).toMatchObject({ outcome: 'portal_cancelled', movesSent: 1, moveTypes: [7], moveEnds: ['input'], moveDist: 3.54 });
    expect(e.moveMoved!).toBeGreaterThan(0.2);
    expect(e.moveLeft!).toBeLessThan(3.54);
    expect(e.moveLeft!).toBeGreaterThan(0.6);
    expect(e.moveMs).toBe(1300);
  });

  it('a later server movement supersedes the MoveTo (ACE TurnTo after it); a movement without data never started', () => {
    const g = walkRig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    g.run(300);
    g.serverMove(MoveType.TurnToHeading, { turnTo: { target: 0, flags: 0, speed: 1, desiredHeading: g.s.heading } });
    g.serverMove(MoveType.MoveToObject, {}); // no MoveTo data: performServerMovement starts nothing
    g.run(PORTAL_REPLY_MS + 100);
    const e = failed(g);
    expect(e.moveTypes).toEqual([7, 9, 6]);
    expect(e.moveEnds).toEqual(['superseded', 'arrived', 'not_started']);
    // The numbers stay on the last MoveTo: the one with no data has none to go by.
    expect(e).toMatchObject({ moveDist: null, moveLeft: null, moveMoved: 0, moveMs: 0 });
    expect(e.serverMoves).toBe(3);
  });

  it('counts the actions after the Use that stop ACE\'s chain (a Jump, a Use of another object), not a re-use or a chat line', () => {
    const g = walkRig();
    g.r.actionSent(0xf61b); // before the Use: no watch
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    g.r.actionSent(0xf61b); // Jump (GameActionJump.cs StopExistingMoveToChains)
    g.r.actionSent(0x0036, PORTAL_GUID); // a Use of this portal: an attempt, counted there
    g.r.actionSent(0x0036, 0x50000001); // a Use of something else (Player_Use.cs StopExistingMoveToChains)
    g.r.actionSent(0x0015); // Talk: no chain
    g.r.actionSent(0xf61c); // MoveToState: movesSent's
    g.run(PORTAL_REPLY_MS + 3000); // the walk (about 2.5 s) extends the wait
    expect(failed(g)).toMatchObject({ chainBreaks: 2, chainBreakTypes: [0xf61b, 0x0036] });
    expect(CHAIN_BREAK_ACTIONS.has(0x0019) && CHAIN_BREAK_ACTIONS.has(0x0008) && !CHAIN_BREAK_ACTIONS.has(0xf61c)).toBe(true);
  });

  it('a watch with no server movement carries empty move fields; a MoveTo end from before the watch is ignored', () => {
    const g = walkRig();
    g.r.moveToEnded(0, null, START); // no watch
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.moveToEnded(0x36, null, START); // no move recorded in this watch
    g.run(PORTAL_REPLY_MS + 100);
    expect(failed(g)).toMatchObject({
      moveTypes: [], moveEnds: [], moveDist: null, moveLeft: null, moveMoved: null, moveMs: null, movePhase: null, chainBreaks: 0, chainBreakTypes: [],
    });
  });

  it('MoveToManager.phase() reads what the move waits on, read-only', () => {
    const g = walkRig({ motionsPending: () => true });
    expect(g.mgr.phase()).toBeNull();
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    expect(g.mgr.phase()).toBe('turn_wait');
    const h = walkRig();
    h.serverMove(MoveType.MoveToPosition, moveToPortal());
    expect(h.mgr.phase()).toBe('turn');
    h.run(1500);
    expect(h.mgr.phase()).toBe('move');
    expect(serverMovementStarts(MoveType.TurnToObject, {})).toBe(false);
    expect(serverMovementTarget(MoveType.MoveToObject, moveToPortal({ target: 0x50000002 }), () => ({ pos: { x: 1, y: 2, z: 3 } }))).toEqual({ x: 1, y: 2, z: 3 });
    expect(serverMovementTarget(MoveType.TurnToHeading, moveToPortal(), () => null)).toBeNull();
  });

  it('the bridge keeps every move field, and drops junk in them', () => {
    const g = walkRig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.serverMove(MoveType.MoveToPosition, moveToPortal());
    g.run(500);
    g.r.actionSent(0xf61b);
    g.stop('input');
    g.run(PORTAL_REPLY_MS + 100);
    const sent = failed(g);
    expect(sent.moveEnds).toEqual(['input']);
    expect(sanitizeClientPortal(sent)).toEqual(sent);
    const junk = sanitizeClientPortal({
      ...sent, moveTypes: [7, 'x', -1, 9, 6, 8, 7], moveEnds: ['arrived', 'teleported_home'], moveDist: 'far', movePhase: 'dancing',
      chainBreaks: -2, chainBreakTypes: [0xf61b, 2 ** 33],
    }) as unknown as Record<string, unknown>;
    expect(junk).toMatchObject({ moveTypes: [7, 9], moveEnds: ['arrived', null], moveDist: null, movePhase: null, chainBreaks: null, chainBreakTypes: [0xf61b] });
  });
});
