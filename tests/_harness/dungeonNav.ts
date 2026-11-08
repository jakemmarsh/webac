/**
 * The agent's navigation hooks over a dungeon landblock's real collision,
 * offline: every EnvCell of the landblock registered in a DungeonCollision
 * (as the academy tests do), and navProbe / navFloor / navAirStep built the
 * way main.ts builds them (stepPlayerMovement through the same services, the
 * human Setup's StepDownHeight). Agent global metres = the collision's own
 * frame here (cells sit at their landblock offset). Call inside beforeAll.
 */
import { getJumpVelocity } from '@ac/shared';
import { existsSync } from 'node:fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999CellOverlay, ac1999PortalOverlay } from '../../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { LandblockInfo } from '../../packages/dat-parser/src/file-types/LandblockInfo.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { stepPlayerMovement, type MovementServices } from '../../packages/renderer/src/player/OutdoorMovement.js';
import type { NavPoint, NavProbe } from '../../packages/renderer/src/agent/navPlanner.js';
import type { FlightBody, JumpKit } from '../../packages/renderer/src/agent/jumpPlan.js';
import { floorSearchFromY, interiorGroundY, outdoorGroundY, traceGroundAlongPath, type OutdoorGroundSources } from '../../packages/renderer/src/world/outdoorGround.js';
import { DAT_PATHS, dataPath, openDat } from './dat.js';

export interface DungeonNav {
  col: import('../../packages/renderer/src/world/DungeonCollision.js').DungeonCollision;
  probe: NavProbe;
  kit: JumpKit;
  stepDown: number;
  /** The body's run speed, m/s (DungeonNavOptions.bodySpeed): DungeonHost's run and the probe's sub-step. */
  runSpeed: number;
  /**
   * One frame of the player's own grounded move, as main.ts's frame loop runs it: stepPlayerMovement by (dx, dy)
   * through `slide` (the body's one sliding normal, kept by the caller across frames), then the frame's ground
   * (bodyGroundY: interiorGroundY in a dungeon, the outdoor trace on a surface landblock). Where the body ends, feet z.
   */
  stepBody(from: NavPoint, dx: number, dy: number, dt: number, slide: { slidingNormal: unknown }): NavPoint;
}

export interface DungeonNavOptions {
  jumpSkill?: number;
  runRate?: number;
  /** The world portal and cell DATs (default the end-of-retail pair), e.g. an era's overlaid set. */
  dats?: { portal: DatDatabase; cell: DatDatabase };
  /**
   * Build the collision as main.ts does on entering (DungeonCollisionBuild.populateDungeonCollision):
   * the cells' statics (furniture, fences, columns) and the building shells too, not the cells alone.
   */
  statics?: boolean;
  /**
   * A flat landscape at this height wherever no cell or static floor is (no terrain otherwise): a town building's
   * doorstep and the street outside it, for walks that leave by a door. Not the landblock's real terrain.
   */
  ground?: number;
  /**
   * A town landblock's buildings (BUG.planner-live-jump-gap): the live client walks a surface building's rooms in its
   * OUTDOOR movement (main.ts playerInDungeon false: stepPlayerMovement's outdoor branch, outdoorGroundY over the
   * terrain and the cells, the land cells' rules), not the dungeon branch. With `surface` the landblock's real terrain
   * is loaded and every hook (probe, floor, airStep, flight) runs that way. Use with `statics`.
   */
  surface?: boolean;
  /**
   * The body's run speed, m/s (default 4): DungeonHost's run and navProbe's sub-step (one 60 Hz frame of it, as main.ts).
   * A tight corner is passed or not by centimetres the run's frames carry the body past a leg's point: the Holtburg
   * scriveners' corner behind the War Magic scrivener let the live walk out at a real character's run, not at 4 m/s.
   */
  bodySpeed?: number;
}

/** The AC1999 world portal + cell (dat-sets/ac1999-retail), each through its 1999 overlay; null when absent. */
export function ac1999Dats(): { portal: DatDatabase; cell: DatDatabase } | null {
  const portal = dataPath('dat-sets/ac1999-retail/portal.dat'), cell = dataPath('dat-sets/ac1999-retail/cell.dat');
  if (!existsSync(portal) || !existsSync(cell)) return null;
  // Own instances, not openDat's shared cache: the overlay changes every read.
  const p = new DatDatabase(new FileDatBytes(portal)); p.setOverlay(ac1999PortalOverlay());
  const c = new DatDatabase(new FileDatBytes(cell)); c.setOverlay(ac1999CellOverlay());
  return { portal: p, cell: c };
}

export async function dungeonNav(landblock: number, opts: DungeonNavOptions = {}): Promise<DungeonNav> {
  const { DungeonCollision } = await import('../../packages/renderer/src/world/DungeonCollision.js');
  const { EnvCellRenderer } = await import('../../packages/renderer/src/world/EnvCellRenderer.js');
  const { SetupModelRenderer } = await import('../../packages/renderer/src/models/SetupModelRenderer.js');
  const { ModelRenderer } = await import('../../packages/renderer/src/models/ModelRenderer.js');
  const { MaterialFactory } = await import('../../packages/renderer/src/models/MaterialFactory.js');
  const { TextureManager } = await import('../../packages/renderer/src/models/TextureManager.js');
  const portalDb = opts.dats?.portal ?? openDat(DAT_PATHS.portal), cellDb = opts.dats?.cell ?? openDat(DAT_PATHS.cell);
  const stepDown = new SetupModel(new DatReader(portalDb.getFileData(0x02000001)!)).stepDownHeight;
  const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
  const mr = new ModelRenderer(portalDb, mf);
  const env = new EnvCellRenderer(portalDb, cellDb, mf, new SetupModelRenderer(portalDb, mr), mr);
  const col = new DungeonCollision();
  const lb = (landblock & 0xffff0000) >>> 0;
  if (opts.statics) {
    const { populateDungeonCollision } = await import('../../packages/renderer/src/world/DungeonCollisionBuild.js');
    const sr = new SetupModelRenderer(portalDb, mr);
    const info = (b: number): LandblockInfo | null => {
      const d = cellDb.getFileData(((b & 0xffff0000) | 0xfffe) >>> 0);
      return d ? new LandblockInfo(new DatReader(d)) : null;
    };
    populateDungeonCollision(col, (lb | 0xffff) >>> 0, {
      findInteriorCells: (b) => {
        const n = info(b)?.numCells ?? 0;
        const out: number[] = [];
        for (let i = 0; i < n; i++) { const id = ((b & 0xffff0000) | (0x100 + i)) >>> 0; if (cellDb.hasFile(id)) out.push(id); }
        return out;
      },
      getCellCollisionData: (id) => env.getCellCollisionData(id),
      loadEnvCell: (id) => env.loadEnvCell(id),
      loadSetupModel: (id) => sr.loadSetupModel(id),
      loadGfxObj: (id) => mr.loadGfxObj(id),
      loadLandblockInfo: info,
    });
  } else {
    for (let c = 0x100; c <= 0xfffd; c++) {
      const id = (lb | c) >>> 0;
      const cd = env.getCellCollisionData(id);
      if (!cd) break;
      col.addCell(id, cd.cellStruct, cd.position);
    }
  }
  const runRate = opts.runRate ?? 2;
  // The body's run in DungeonHost and the probe's 60 Hz sub-step: 4 m/s unless the test gives the character's run.
  const runSpeed = opts.bodySpeed ?? 4;
  // main.ts navProbe's sub-step: one 60 Hz frame of the run (at most 0.15 m).
  const PROBE_STEP_M = Math.min(0.15, Math.max(0.04, runSpeed / 60));
  const groundAt = (fromY: number): number | null => (opts.ground !== undefined && fromY >= opts.ground - 0.05 ? opts.ground : null);
  // A town landblock's terrain (surface): main.ts's outdoorGroundSources / playerGroundSources over it and the cells.
  const surface = !!opts.surface;
  const inDungeon = !surface;
  let terrain: { getHeightAt(x: number, z: number): number | null; getTriangleNormalAt(x: number, z: number): unknown; isWalkable(x: number, z: number): boolean } =
    { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true };
  let water: unknown = { blockWaterTypeAt: () => null };
  if (surface) {
    const { TerrainCollision } = await import('../../packages/shared/src/physics/TerrainCollision.js');
    const { WaterMap } = await import('../../packages/shared/src/physics/WaterMap.js');
    const { RegionDesc, CellLandblock } = await import('@ac/dat-parser');
    const { LandblockMesh } = await import('../../packages/renderer/src/terrain/LandblockMesh.js');
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = (region as any).landDefs?.landHeightTable ?? (region as any).landHeightTable;
    const bx = (lb >>> 24) & 0xff, by = (lb >>> 16) & 0xff;
    const block = CellLandblock.read(new DatReader(cellDb.getFileData((lb | 0xffff) >>> 0)!));
    const t = new TerrainCollision();
    t.setLandblock(bx, by, { heights: block.heights.map((h: number) => table[h]), blockX: bx, blockY: by });
    const w = new WaterMap();
    w.setLandblock(bx, by, new LandblockMesh({ heights: block.heights, terrain: block.terrain }).cellCornerTerrainTypes);
    terrain = t as never; water = w;
  }
  const surfaceCellAt = (x: number, z: number, footY: number): number => col.findCellContaining(x, z, footY + col.lowerSphereHeight);
  const groundSources: OutdoorGroundSources = {
    terrainHeight: (x, z) => terrain.getHeightAt(x, z),
    floorHeight: (x, z, fromY, maxDrop, bodyFeetY) => col.getFloorHeight(x, z, fromY, maxDrop, bodyFeetY),
    cellAt: surfaceCellAt,
    landReachable: (x, z, footY) => col.reachesLandCells(x, z, footY),
  };
  const bodyGroundSources: OutdoorGroundSources = {
    ...groundSources,
    floorHeight: (x, z, fromY, maxDrop, bodyFeetY) => col.getBodyFloorHeight(x, z, fromY, stepDown, maxDrop, bodyFeetY),
  };
  const services = (): MovementServices => ({
    dungeonCollision: surface ? null : col, outdoorCollision: col,
    terrain, water, creatureObstacles: null, defaultPlayerRadius: col.playerRadius,
    edgeSlide: true, stepDownHeight: stepDown, slide: { slidingNormal: null },
    dungeonGroundAt: (x, z, fromY) => col.getFloorHeight(x, z, fromY, Infinity) ?? groundAt(fromY),
    ...(surface ? { groundAt: (x: number, z: number, fromY: number) => outdoorGroundY(groundSources, x, z, fromY), landReachable: (x: number, z: number, footY: number) => col.reachesLandCells(x, z, footY) } : {}),
  } as MovementServices);
  /** main.ts navFloor's ground: the dungeon's walkable below, or outdoors outdoorGroundY. */
  const groundUnder = (sv: MovementServices, x: number, z: number, fromY: number): number | null =>
    (surface ? sv.groundAt?.(x, z, fromY) : sv.dungeonGroundAt?.(x, z, fromY)) ?? null;
  /** main.ts bodyGroundY after a step from (px, py) to (x, y) by a body whose feet were at `feet` (searched from feet + lastStepUp). */
  const frameGround = (px: number, py: number, x: number, y: number, feet: number): number | null => {
    const fromY = floorSearchFromY(null, feet, col.lastStepUp ?? 0);
    return surface
      ? traceGroundAlongPath((qx, qz, q) => outdoorGroundY(bodyGroundSources, qx, qz, q, { fallbackY: feet }), px, py, x, y, fromY, col.transitionSphereRadius)
      : interiorGroundY({
        floorHeight: (qx, qz, q, maxDrop) => col.getBodyFloorHeight(qx, qz, q, stepDown, maxDrop) ?? groundAt(q),
        cellAt: (qx, qz, footY) => col.findCellContaining(qx, qz, footY + col.lowerSphereHeight, lb),
      }, px, py, x, y, fromY, col.transitionSphereRadius, feet);
  };
  // main.ts navProbe, verbatim in behaviour.
  const probe: NavProbe = (from, to) => {
    const sv = services();
    // One live frame's move per sub-step (main.ts navProbe: the run's step at 60 Hz): a collision step-up depends on the
    // step's length, and 0.15 m steps climbed the scriveners' 0.82 m plinth that the live body's 0.07 m steps don't.
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / PROBE_STEP_M));
    let x = from.x, z = from.y, floorY = from.z;
    for (let i = 1; i <= n; i++) {
      const tx = from.x + ((to.x - from.x) * i) / n, tz = from.y + ((to.y - from.y) * i) / n;
      const step = stepPlayerMovement({ x, z, floorY, inDungeon, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, tx - x, tz - z, 1 / 60, sv);
      // The frame's own ground (bodyGroundY), as the body that walks the probe's way will have it.
      const ground = frameGround(x, z, step.x, step.z, floorY);
      if (ground === null || floorY - ground > stepDown + 0.05) break;
      const moved = Math.hypot(step.x - x, step.z - z);
      x = step.x; z = step.z; floorY = ground;
      if (moved < PROBE_STEP_M * 0.07) break; // blocked (main.ts: 0.01 of a 0.15 m step)
    }
    return { x, y: z, z: floorY };
  };
  const skill = opts.jumpSkill ?? 100;
  const kit: JumpKit = {
    floor: (x, y, fromZ) => (surface ? outdoorGroundY(groundSources, x, y, fromZ + 0.05) : col.getFloorHeight(x, y, fromZ + 0.05, Infinity) ?? groundAt(fromZ + 0.05)),
    airStep: (from: NavPoint, dx, dy) => {
      const r = stepPlayerMovement({ x: from.x, z: from.y, floorY: from.z, inDungeon, airborne: true, jumpVelocityX: dx, jumpVelocityZ: dy, slideVelocity: null }, 0, 0, 1, services());
      return { x: r.x, y: r.z };
    },
    // main.ts navCeiling: the rise stops under a ceiling (DungeonCollision.riseLimit).
    ceiling: (x, y, fromZ, toZ) => col.riseLimit(x, y, fromZ, toZ),
    // main.ts navFlight: one set of services for the flight (one sliding normal), the coast, the frame's ground
    // (bodyGroundY's dungeon branch: interiorGroundY over getBodyFloorHeight, searched from the feet + lastStepUp).
    flight: (): FlightBody => {
      const sv = services();
      // The flight's own last-move results (main.ts navFlight): nothing leaks into the next probe.
      const st = { lastStepUp: 0, collisionNormal: null, lastShellCell: 0 };
      return {
        air: (from, dx, dy) => col.withMoveState(st, () => {
          const r = stepPlayerMovement({ x: from.x, z: from.y, floorY: from.z, inDungeon, airborne: true, jumpVelocityX: dx, jumpVelocityZ: dy, slideVelocity: null }, 0, 0, 1, sv);
          return { x: r.x, y: r.z };
        }),
        coast: (from, v, dt) => col.withMoveState(st, () => {
          const r = stepPlayerMovement({ x: from.x, z: from.y, floorY: from.z, inDungeon, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null, groundVelocity: { x: v.x, z: v.y } }, 0, 0, dt, sv);
          return { x: r.x, y: r.z, v: r.groundVelocity ? { x: r.groundVelocity.x, y: r.groundVelocity.z } : null };
        }),
        ground: (px, py, x, y, feetZ, lastGround) => col.withMoveState(st, () => surface
          // main.ts bodyGroundY's outdoor branch (the wade below water-textured terrain left out: no water here).
          ? traceGroundAlongPath((qx, qz, fromY) => outdoorGroundY(bodyGroundSources, qx, qz, fromY, { fallbackY: lastGround }),
            px, py, x, y, floorSearchFromY(null, feetZ, col.lastStepUp ?? 0), col.transitionSphereRadius)
          : interiorGroundY(
          {
            floorHeight: (qx, qz, fromY, maxDrop) => col.getBodyFloorHeight(qx, qz, fromY, stepDown, maxDrop) ?? groundAt(fromY),
            cellAt: (qx, qz, footY) => col.findCellContaining(qx, qz, footY + col.lowerSphereHeight, lb),
          },
          px, py, x, y, floorSearchFromY(null, feetZ, col.lastStepUp ?? 0), col.transitionSphereRadius, lastGround,
        )),
        stepDown,
      };
    },
    launch: (power, walk) => ({ forward: walk ? 3.12 : 4 * runRate, up: getJumpVelocity(0, skill, power) }),
    chargeSeconds: 1,
  };
  const stepBody = (from: NavPoint, dx: number, dy: number, dt: number, slide: { slidingNormal: unknown }): NavPoint => {
    const sv = { ...services(), slide } as MovementServices;
    const r = stepPlayerMovement({ x: from.x, z: from.y, floorY: from.z, inDungeon, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, dx, dy, dt, sv);
    const g = frameGround(from.x, from.y, r.x, r.z, from.z);
    return { x: r.x, y: r.z, z: g ?? from.z };
  };
  return { col, probe, kit, stepDown, stepBody, runSpeed };
}
