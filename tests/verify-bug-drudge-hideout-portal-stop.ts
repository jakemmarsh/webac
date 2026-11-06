/**
 * BUG.drudge-hideout-portal-stop (2026-11-06) — "the body stops dead 2.1 m from the Drudge Hideout portal".
 *
 * Live repro (local ACE, end of retail, the agent tools' `ac_move forward`): from (32455.8, 34403.1) on heading ~195°
 * the body stood at (32454.8, 34399.1), 2.1 m from portal wcid 2068 (#7A9B3000, landblock 0xA9B3 at (5.44567,
 * 29.4682, 94.005), Setup 0x020005D2, PhysicsState 0xC0C Ethereal | ReportCollisions | Gravity | LightingOn), and
 * holding W gave no motion; on heading ~230° it walked in.
 *
 * Root cause: NOT collision. The agent's portal sentinel (AgentApi.enforcePortalSentinel) let go of the agent's KeyW:
 * claude.log 16:50:04Z / 17:11:18Z "portal sentinel: 2.2 m from Drudge Hideout #7a9b3000, … (touching at 2.4); let go
 * of KeyW" (touch 2.4 = the Setup radius 1.919 + the body's 0.48). It guards only keys the agent holds and lets the body
 * into a portal only on a walk sent into it (ac_use / ac_walk_to), so a player's own W walks straight in. `ac_move`
 * answered "forward for 3s" all the same, so the stop read as a wall. Now its answer says the sentinel let go.
 *
 * Our collision is retail's here: CPhysicsObj::FindObjCollisions @ 0050f050 / ACE PhysicsObj.FindObjCollisions
 * (Physics/PhysicsObj.cs:381-455) pass an Ethereal target (recorded, not blocked; the ReportCollisions touch still
 * reaches the portal's weenie), and the block's buildings, statics, scenery and walkable interiors have nothing on
 * the way: replayed below through the shipped collision world (buildLandblockWorld: LandblockInfo, LandblockScenery,
 * EnvCells, server objects via CreatureCollision) and stepPlayerMovement with main.ts's ground services, in all three
 * eras. The inverse holds too: the same portal without Ethereal deflects the body round its sphere (a solid object
 * still blocks), and the ethereal walk-in comes inside bodyTouchesPortal's touch (the walk-in telemetry sees it).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, compassToYaw } from '../packages/renderer/src/agent/AgentApi.ts';
import { blocksLocalPlayer, setupPhysicsSpheres } from '../packages/renderer/src/world/CreatureCollision.ts';
import { bodyTouchesPortal } from '../packages/renderer/src/telemetry/PortalUseReporter.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.ts';

const BX = 0xa9, BY = 0xb3, OX = BX * 192, OY = BY * 192;
/** wcid 2068 portaldrudgehideout (ACE world DB landblock_instance 0x7A9B3000). */
const PORTAL = { guid: 0x7a9b3000, x: 5.44567, y: 29.4682, z: 94.005, quat: { w: -0.445343, x: 0, y: 0, z: -0.89536 }, setup: 0x020005d2 };
const ETHEREAL_STATE = 0xc0c; // Ethereal | ReportCollisions | Gravity | LightingOn (weenie PropertyInt 93 = 3084)
const SOLID_STATE = ETHEREAL_STATE & ~0x4;
/** The human body (Setup 0x02000001): two spheres r 0.48 at z 0.475 and 1.35. */
const BODY = [{ z: 0.4749999940395355, radius: 0.48 }, { z: 1.350000023841858, radius: 0.48 }];

describe('(no DAT) the Drudge Hideout portal\'s state: walk-through, and only by Ethereal', () => {
  it('PhysicsState 0xC0C never blocks our character; the same state without Ethereal does', () => {
    expect(blocksLocalPlayer({ physicsState: ETHEREAL_STATE, objectDescFlags: 0x40000 }, 0)).toBe(false);
    expect(blocksLocalPlayer({ physicsState: SOLID_STATE, objectDescFlags: 0x40000 }, 0)).toBe(true);
  });

  it('the live stop (2.1 m from the middle) is outside the walk-in touch; 1.5 m is inside it', () => {
    const portalSpheres = setupPhysicsSpheres({ spheres: [{ origin: { x: 0, y: 0, z: 1.42 }, radius: 1.357 }] });
    expect(bodyTouchesPortal(2.1, 0.005, BODY, portalSpheres)).toBe(false);
    expect(bodyTouchesPortal(1.5, 0.005, BODY, portalSpheres)).toBe(true);
  });
});

describe('(no DAT) ac_move into a portal: the answer names the sentinel that stopped it', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    // The portal 6 m due north of the body, the body facing it (the fake landblock's frame: y north).
    host.add({ guid: PORTAL.guid, name: 'Drudge Hideout', itemType: 0x10000, objectDescFlags: 0x40000, cell: host.me.cell, x: 80, y: 26, z: 94 });
    host.objectReach = (g) => (g === PORTAL.guid ? 1.919 : 0);
    host.me.yaw = compassToYaw(0);
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stopped short of the portal: "the portal sentinel let go of KeyW … from Drudge Hideout #7a9b3000"', async () => {
    const p = api.move('forward', 3);
    run(api, host, 3000);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(Math.hypot(host.me.x - 80, host.me.y - 26)).toBeGreaterThan(1.919 + 0.48);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^forward for 3s; the portal sentinel let go of KeyW [\d.]+ m from Drudge Hideout #7a9b3000 .*doesn't block: ac_use it or ac_walk_to it/);
  });

  it('a move nowhere near a portal answers as before', async () => {
    host.me.yaw = compassToYaw(180);
    const p = api.move('forward', 2);
    run(api, host, 2000);
    await vi.advanceTimersByTimeAsync(0);
    expect((await p).message).toBe('forward for 2s');
  });

  it('a stop on an earlier move is not reported on the next one', async () => {
    const p1 = api.move('forward', 3);
    run(api, host, 3000);
    await vi.advanceTimersByTimeAsync(0);
    expect((await p1).message).toMatch(/portal sentinel/);
    host.me.yaw = compassToYaw(180);
    const p2 = api.move('forward', 1);
    run(api, host, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect((await p2).message).toBe('forward for 1s');
  });
});

const CLASSIC = { portal: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat'), cell: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat') };
const AC1999 = { portal: resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat'), cell: resolve(DAT_SETS_DIR, 'ac1999-retail', 'cell.dat'), ac1999: true };
const ERAS = [
  { name: 'end of retail', dats: undefined, have: existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell) },
  { name: 'Dark Majesty', dats: CLASSIC, have: existsSync(CLASSIC.portal) && existsSync(CLASSIC.cell) },
  { name: 'AC1999', dats: AC1999, have: existsSync(AC1999.portal) && existsSync(AC1999.cell) },
];

for (const era of ERAS) {
  describe.skipIf(!era.have)(`the walk at the Drudge Hideout portal through the shipped collision world (0xA9B3, ${era.name})`, () => {
    type Svc = import('../packages/renderer/src/player/OutdoorMovement.ts').MovementServices;
    const worlds = new Map<number, Svc>();
    let step: typeof import('../packages/renderer/src/player/OutdoorMovement.ts').stepPlayerMovement;
    let ground: typeof import('../packages/renderer/src/world/outdoorGround.ts');
    let portalSpheres: { x: number; y: number; z: number; radius: number }[] = [];

    beforeAll(async () => {
      ({ stepPlayerMovement: step } = await import('../packages/renderer/src/player/OutdoorMovement.ts'));
      ground = await import('../packages/renderer/src/world/outdoorGround.ts');
      const { buildLandblockWorld } = await import('./_harness/a9b4-world.ts');
      const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.ts');
      const { openDat } = await import('./_harness/dat.ts');
      const { DatReader, SetupModel } = await import('@ac/dat-parser');
      const portalDb = openDat(era.dats?.portal ?? DAT_PATHS.portal);
      // The stock portal Setup where this era's DAT lacks 0x020005D2 (both carry the one sphere r 1.357 at z 1.42).
      const setupId = portalDb.getFileData(PORTAL.setup) ? PORTAL.setup : 0x020001b3;
      portalSpheres = setupPhysicsSpheres(new SetupModel(new DatReader(portalDb.getFileData(setupId)!)));
      for (const state of [ETHEREAL_STATE, SOLID_STATE]) {
        const base = (await buildLandblockWorld(BX, BY, {
          interiors: true, dats: era.dats,
          blockers: [{ guid: PORTAL.guid, worldX: OX + PORTAL.x, worldY: PORTAL.z, worldZ: OY + PORTAL.y, collisionRadius: 0, setupId, quat: PORTAL.quat, scale: 1, physicsState: state }],
        }))({ slidingNormal: null });
        const dc = base.outdoorCollision as InstanceType<typeof DungeonCollision>;
        // main.ts's movementServices: groundAt over outdoorGroundSources (with the cell rule) and landReachable.
        const src = {
          terrainHeight: (x: number, z: number) => base.terrain.getHeightAt(x, z),
          floorHeight: (x: number, z: number, y: number, d?: number, f?: number) => dc.getFloorHeight(x, z, y, d, f),
          cellAt: (x: number, z: number, f: number) => dc.findCellContaining(x, z, f + dc.lowerSphereHeight),
          landReachable: (x: number, z: number, f: number) => dc.reachesLandCells(x, z, f),
        };
        worlds.set(state, { ...base, groundAt: (x, z, y) => ground.outdoorGroundY(src, x, z, y), landReachable: src.landReachable });
      }
    }, 300_000);

    /** Run `n` 1/30 s substeps of 0.31 m (a run) on compass `heading` from global (x, y); the floor followed as main.ts follows it. */
    function walk(state: number, heading: number, x0: number, y0: number, n: number) {
      const svc = worlds.get(state)!;
      svc.slide!.slidingNormal = null;
      const dc = svc.outdoorCollision as unknown as { getBodyFloorHeight(x: number, z: number, y: number, s: number, d?: number, f?: number): number | null; lastStepUp: number; transitionSphereRadius: number };
      const h = (heading * Math.PI) / 180;
      let x = x0, z = y0;
      let floorY = svc.terrain.getHeightAt(x, z)!;
      let closest = Infinity, stalls = 0, touched = false;
      for (let i = 0; i < n; i++) {
        const r = step({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, Math.sin(h) * 0.31, Math.cos(h) * 0.31, 1 / 30, svc);
        if (Math.hypot(r.x - x, r.z - z) < 1e-4) stalls++;
        const g = ground.traceGroundAlongPath(
          (a, b, y) => ground.outdoorGroundY({ terrainHeight: (p, q) => svc.terrain.getHeightAt(p, q), floorHeight: (p, q, y2, d, f) => dc.getBodyFloorHeight(p, q, y2, 0.6, d, f) }, a, b, y),
          x, z, r.x, r.z, ground.floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
        x = r.x; z = r.z;
        if (g !== null) floorY = g;
        const d = Math.hypot(x - (OX + PORTAL.x), z - (OY + PORTAL.y));
        closest = Math.min(closest, d);
        if (bodyTouchesPortal(d, PORTAL.z - floorY, BODY, portalSpheres)) touched = true;
      }
      return { closest, stalls, touched, x, y: z };
    }

    it('the portal Setup is one collision sphere (r 1.357 at z 1.42): no BSP, no cylsphere', () => {
      expect(portalSpheres).toHaveLength(1);
      expect(portalSpheres[0].radius).toBeCloseTo(1.357, 3);
      expect(portalSpheres[0].z).toBeCloseTo(1.42, 3);
    });

    it('heading 195° from (32455.8, 34403.1), the live stop: nothing stops the body; it runs through the portal\'s middle, touching it', () => {
      const w = walk(ETHEREAL_STATE, 195, 32455.8, 34403.1, 30);
      expect(w.stalls).toBe(0);
      expect(w.closest).toBeLessThan(1);
      expect(w.touched).toBe(true);
      // Past the portal, on the line (9.3 m along it).
      expect(Math.hypot(w.x - 32455.8, w.y - 34403.1)).toBeCloseTo(30 * 0.31, 1);
    });

    it('heading 230° to (32455.0, 34398.8) walks in too', () => {
      const w = walk(ETHEREAL_STATE, 230, 32457.5, 34400.9, 20);
      expect(w.stalls).toBe(0);
      expect(w.touched).toBe(true);
      expect(w.closest).toBeLessThan(1.5);
    });

    it('from the live stop itself (32454.8, 34399.1), W goes on', () => {
      const w = walk(ETHEREAL_STATE, 195, 32454.8, 34399.1, 5);
      expect(w.stalls).toBe(0);
      expect(w.touched).toBe(true);
    });

    it('inverse: the same portal WITHOUT Ethereal deflects the body round its sphere (a solid object still blocks)', () => {
      const w = walk(SOLID_STATE, 195, 32455.8, 34403.1, 30);
      // The upper body sphere (z 1.35 vs the portal sphere's 1.42 above a near-level base) stays out at ~1.837 m.
      expect(w.closest).toBeGreaterThan(1.357 + 0.48 - 0.1);
      expect(w.touched).toBe(false);
    });
  });
}
