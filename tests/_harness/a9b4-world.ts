/**
 * The collision world of the retail movement A/B lane (Holtburg 0xA9B4, start
 * (85, 20.5) facing north — tools/retail-movement-ab.ts): the landblock's
 * terrain, every building and static object of its LandblockInfo, and the two
 * server objects next to the lane in the recordings (the Cooking Forge
 * 0x8000B490 and Pathwarden Thorolf 0x8000B698, as in
 * verify-move-slide-speed-around-sphere.ts). The retail mover slides along
 * these; a collision-free replay cannot follow it there (2026-10-08: the
 * house 0x01000BC3 at (79.5, 37.5) stops a north run 3 m left of the start).
 * DAT-dependent: build it inside beforeAll.
 *
 * `interiors: true` also registers the block's walkable interior cells (the
 * EnvCells a player can reach through the building doorways) and their
 * static objects, as LandblockObjectStreamer registers them for outdoor
 * collision (the Holtburg blacksmith's stairs: cell 0xA9B40104's staircase).
 */
import { DungeonCollision } from '../../packages/renderer/src/world/DungeonCollision.js';
import type { MovementServices, SlideState } from '../../packages/renderer/src/player/OutdoorMovement.js';
import { TerrainCollision } from '../../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap } from '../../packages/shared/src/physics/WaterMap.js';
import { DAT_PATHS, openDat } from './dat.js';

/** How many scenery placements the last build registered (diagnostics). */
export let sceneryCount = 0;

export const A9B4 = { BX: 0xa9, BY: 0xb4, OX: 0xa9 * 192, OY: 0xb4 * 192, START: { x: 85, y: 20.5 }, Z: 94 };

/**
 * The lane's collision world. `stateOf` gives a server object's PhysicsState
 * at the replay's current time (the recording's SetStates), else the world
 * DB's.
 */
/** A server object the caller adds to the world's blockers (world DB landblock_instance; global render coordinates). */
export interface A9b4Blocker {
  guid: number; worldX: number; worldY: number; worldZ: number; collisionRadius: number; setupId: number;
  quat: { w: number; x: number; y: number; z: number }; scale: number; physicsState: number;
}

export async function buildA9b4World(options: { interiors?: boolean; blockers?: A9b4Blocker[] } = {}): Promise<(slide?: SlideState, stateOf?: (guid: number) => number | undefined) => MovementServices> {
  const { OX, OY } = A9B4;
  // The server's doors next to the lane (ACE world DB landblock_instance, A9B4;
  // closed: state 0x10008 HasPhysicsBSP), registered per step as main.ts registers
  // every server object (creatureObstacles → addCreatureObstacles). Retail runs
  // into the grocer's door 3 m left of the start (sweep-pair-WZ-lifo,
  // sweep-alt-W-A), and retail's slide along it stops at the shop sign.
  const doors = [
    { guid: 0x7a9b401f, worldX: OX + 81.67, worldY: 94, worldZ: OY + 33.63, collisionRadius: 0, setupId: 0x020019ff,
      quat: { w: 0.923879, x: 0, y: 0, z: 0.382684 }, scale: 1, physicsState: 0x10008 },
    { guid: 0x7a9b401e, worldX: OX + 75.73, worldY: 94, worldZ: OY + 33.73, collisionRadius: 0, setupId: 0x020019ff,
      quat: { w: 0.92388, x: 0, y: 0, z: -0.382683 }, scale: 1, physicsState: 0x10008 },
    // The shop sign (state 0x418: IgnoreCollisions but not Ethereal — retail's
    // FindObjCollisions @ 0050f050 skips a target only when it is both).
    { guid: 0x7a9b402b, worldX: OX + 83.09, worldY: 94.08, worldZ: OY + 34.45, collisionRadius: 0, setupId: 0x02000290,
      quat: { w: 0.926529, x: 0, y: 0, z: 0.376224 }, scale: 1, physicsState: 0x418 },
    // The lifestone (Setup 0x020002EE) and Alcott (human 0x02000001) behind
    // the start: a backpedal with a left strafe ends against them
    // (sweep-pair-XZ-lifo-run).
    { guid: 0x7a9b404f, worldX: OX + 81.33, worldY: 94, worldZ: OY + 11.8, collisionRadius: 0, setupId: 0x020002ee,
      quat: { w: 0.839091, x: 0, y: 0, z: -0.543991 }, scale: 1, physicsState: 0x408 },
    { guid: 0x8000edf0, worldX: OX + 83.3, worldY: 94, worldZ: OY + 14.04, collisionRadius: 0.48, setupId: 0x02000001,
      quat: { w: 0.861654, x: 0, y: 0, z: -0.507496 }, scale: 1, physicsState: 0x408 },
  ];
  const blockers = [
    ...doors,
    ...(options.blockers ?? []),
    { guid: 0x8000b698, worldX: OX + 97, worldY: 94.005, worldZ: OY + 27, collisionRadius: 0.48, setupId: 0x02000001,
      quat: { w: 0.16847099, x: 0, y: 0, z: -0.98570698 }, scale: 1, physicsState: 0x600418 },
    { guid: 0x8000b490, worldX: OX + 91.519, worldY: 94, worldZ: OY + 37.745, collisionRadius: 2.048, setupId: 0x0200124b,
      quat: { w: 0, x: 0, y: 0, z: -1 }, scale: 1.4, physicsState: 0x600418 },
  ];
  return buildLandblockWorld(A9B4.BX, A9B4.BY, { interiors: options.interiors, blockers });
}

/**
 * Any landblock's collision world, built as buildA9b4World builds Holtburg's: its terrain (with the block's real
 * WaterMap), every LandblockInfo building and static, its procedural scenery, with `interiors` its walkable
 * interior cells and their statics, and `blockers` (server objects: doors, NPCs) as main.ts registers them.
 * `dats` opens another era's portal / cell DATs (dat-sets/…) instead of the end-of-retail ones; `ac1999` serves
 * them through the 1999 overlays (Ac1999Overlay.ts) as the AC1999 lane does.
 */
export async function buildLandblockWorld(BX: number, BY: number, options: { interiors?: boolean; blockers?: A9b4Blocker[]; dats?: { portal: string; cell: string; ac1999?: boolean } } = {}): Promise<(slide?: SlideState, stateOf?: (guid: number) => number | undefined) => MovementServices> {
  const OX = BX * 192, OY = BY * 192;
  const portalDb = openDat(options.dats?.portal ?? DAT_PATHS.portal);
  const cellDb = openDat(options.dats?.cell ?? DAT_PATHS.cell);
  if (options.dats?.ac1999) {
    const { ac1999PortalOverlay, ac1999CellOverlay } = await import('../../packages/dat-parser/src/era1999/Ac1999Overlay.js');
    if (!portalDb.overlayKind) portalDb.setOverlay(ac1999PortalOverlay());
    if (!cellDb.overlayKind) cellDb.setOverlay(ac1999CellOverlay());
  }
  const { DatReader } = await import('../../packages/dat-parser/src/DatReader.js');
  const { RegionDesc, CellLandblock, LandblockInfo } = await import('@ac/dat-parser');
  const { TextureManager } = await import('../../packages/renderer/src/models/TextureManager.js');
  const { MaterialFactory } = await import('../../packages/renderer/src/models/MaterialFactory.js');
  const { ModelRenderer } = await import('../../packages/renderer/src/models/ModelRenderer.js');
  const { SetupModelRenderer } = await import('../../packages/renderer/src/models/SetupModelRenderer.js');
  const { resolveObjectPhysics, addObjectCollision } = await import('../../packages/renderer/src/world/ObjectCollision.js');
  const { addCreatureObstacles, blocksLocalPlayer } = await import('../../packages/renderer/src/world/CreatureCollision.js');

  const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
  const mr = new ModelRenderer(portalDb, mf);
  const sr = new SetupModelRenderer(portalDb, mr);
  const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
  const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (region as any).landDefs?.landHeightTable ?? (region as any).landHeightTable;
  const terrain = new TerrainCollision();
  const lbId = ((BX << 24) | (BY << 16) | 0xffff) >>> 0;
  const lb = CellLandblock.read(new DatReader(cellDb.getFileData(lbId)!));
  terrain.setLandblock(BX, BY, { heights: lb.heights.map((h: number) => table[h]), blockX: BX, blockY: BY });
  const water = new WaterMap();
  if (BX === A9B4.BX && BY === A9B4.BY) water.setLandblock(BX, BY, new Array(256).fill(1));
  else {
    const { LandblockMesh } = await import('../../packages/renderer/src/terrain/LandblockMesh.js');
    water.setLandblock(BX, BY, new LandblockMesh({ heights: lb.heights, terrain: lb.terrain }).cellCornerTerrainTypes);
  }
  const collider = new DungeonCollision();
  const info = new LandblockInfo(new DatReader(cellDb.getFileData(((lbId & 0xffff0000) | 0xfffe) >>> 0)!));
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const o of [...((info as any).buildings ?? []).map((b: any) => ({ id: b.modelId, frame: b.frame, building: true })), ...((info as any).objects ?? []).map((s: any) => ({ id: s.id, frame: s.frame, building: false }))]) {
    const phys = resolveObjectPhysics(o.id, src);
    if (!phys) continue;
    const k = n++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addObjectCollision(collider, (a, j) => `s${k}:${a}${j}` as any, phys, o.frame.origin, o.frame.orientation, 1, OX, OY, { building: o.building });
  }
  if (options.interiors) {
    const { EnvCellRenderer } = await import('../../packages/renderer/src/world/EnvCellRenderer.js');
    const { collectBuildingStabCells, collectWalkableCells } = await import('../../packages/renderer/src/world/buildingCells.js');
    const { collisionKey } = await import('../../packages/renderer/src/world/DungeonCollision.js');
    const env = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    const prefix = ((BX << 24) | (BY << 16)) >>> 0;
    const stab = collectBuildingStabCells(info.buildings, info.numCells);
    const walkable = collectWalkableCells(stab, info.numCells, (idx) => env.loadEnvCell((prefix | idx) >>> 0)?.cellPortals);
    for (const idx of [...walkable].sort((a, b) => a - b)) {
      const cellId = (prefix | idx) >>> 0;
      const cd = env.getCellCollisionData(cellId);
      if (cd) collider.addCell(cellId, cd.cellStruct, cd.position, cd.outsidePortalPolygonIds);
      const envCell = env.loadEnvCell(cellId);
      envCell?.staticObjects.forEach((s, si) => {
        const model = resolveObjectPhysics(s.id, src);
        if (model) addObjectCollision(collider, (kind, i) => collisionKey.cellStatic(cellId, si, kind, i), model, s.frame.origin, s.frame.orientation, 1, OX, OY);
      });
    }
  }
  // The block's procedural scenery (trees, rocks, plants) with its physics,
  // as the outdoor streamer registers it (LandblockScenery).
  const { createLandblockSceneryBuilder } = await import('../../packages/renderer/src/world/LandblockScenery.js');
  const scenery = createLandblockSceneryBuilder({
    cellDb, portalDb, regionDesc: region, hasModel: () => true,
    objectPhysics: (id) => resolveObjectPhysics(id, src), collision: collider, warn: { warn: () => {} },
  });
  const built = scenery(BX, BY);
  sceneryCount = built?.entries.length ?? 0;
  const blockers = options.blockers ?? [];
  return (slide, stateOf) => ({
    dungeonCollision: null, outdoorCollision: collider, terrain, water,
    creatureObstacles: (c, x, z, range) => {
      // The state the server last sent for each (a door it holds open is
      // Ethereal), filtered as main.ts filters every server object.
      const near = blockers.map((b) => ({ ...b, physicsState: stateOf?.(b.guid) ?? b.physicsState }))
        .filter((b) => blocksLocalPlayer({ physicsState: b.physicsState, objectDescFlags: 0 }, 0) && Math.hypot(b.worldX - x, b.worldZ - z) <= range);
      const keys = addCreatureObstacles(c as DungeonCollision, near, (id) => resolveObjectPhysics(id, src));
      return () => { for (const key of keys) (c as DungeonCollision).removeKey(key); };
    },
    defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS, edgeSlide: true, stepDownHeight: 0.6, slide,
  });
}
