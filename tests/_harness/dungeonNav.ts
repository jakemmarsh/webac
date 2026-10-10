/**
 * The agent's navigation hooks over a dungeon landblock's real collision,
 * offline: every EnvCell of the landblock registered in a DungeonCollision
 * (as the academy tests do), and navProbe / navFloor / navAirStep built the
 * way main.ts builds them (stepPlayerMovement through the same services, the
 * human Setup's StepDownHeight). Agent global metres = the collision's own
 * frame here (cells sit at their landblock offset). Call inside beforeAll.
 */
import { getJumpVelocity } from '@ac/shared';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { stepPlayerMovement, type MovementServices } from '../../packages/renderer/src/player/OutdoorMovement.js';
import type { NavPoint, NavProbe } from '../../packages/renderer/src/agent/navPlanner.js';
import type { JumpKit } from '../../packages/renderer/src/agent/jumpPlan.js';
import { DAT_PATHS, openDat } from './dat.js';

export interface DungeonNav {
  col: import('../../packages/renderer/src/world/DungeonCollision.js').DungeonCollision;
  probe: NavProbe;
  kit: JumpKit;
  stepDown: number;
}

export async function dungeonNav(landblock: number, opts: { jumpSkill?: number; runRate?: number } = {}): Promise<DungeonNav> {
  const { DungeonCollision } = await import('../../packages/renderer/src/world/DungeonCollision.js');
  const { EnvCellRenderer } = await import('../../packages/renderer/src/world/EnvCellRenderer.js');
  const { SetupModelRenderer } = await import('../../packages/renderer/src/models/SetupModelRenderer.js');
  const { ModelRenderer } = await import('../../packages/renderer/src/models/ModelRenderer.js');
  const { MaterialFactory } = await import('../../packages/renderer/src/models/MaterialFactory.js');
  const { TextureManager } = await import('../../packages/renderer/src/models/TextureManager.js');
  const portalDb = openDat(DAT_PATHS.portal), cellDb = openDat(DAT_PATHS.cell);
  const stepDown = new SetupModel(new DatReader(portalDb.getFileData(0x02000001)!)).stepDownHeight;
  const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
  const mr = new ModelRenderer(portalDb, mf);
  const env = new EnvCellRenderer(portalDb, cellDb, mf, new SetupModelRenderer(portalDb, mr), mr);
  const col = new DungeonCollision();
  const lb = (landblock & 0xffff0000) >>> 0;
  for (let c = 0x100; c <= 0xfffd; c++) {
    const id = (lb | c) >>> 0;
    const cd = env.getCellCollisionData(id);
    if (!cd) break;
    col.addCell(id, cd.cellStruct, cd.position);
  }
  const services = (): MovementServices => ({
    dungeonCollision: col, outdoorCollision: col,
    terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true },
    water: { cellWaterTypeAt: () => null }, creatureObstacles: null, defaultPlayerRadius: col.playerRadius,
    edgeSlide: true, stepDownHeight: stepDown, slide: { slidingNormal: null },
    dungeonGroundAt: (x, z, fromY) => col.getFloorHeight(x, z, fromY, Infinity),
  } as MovementServices);
  // main.ts navProbe, verbatim in behaviour.
  const probe: NavProbe = (from, to) => {
    const sv = services();
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.15));
    let x = from.x, z = from.y, floorY = from.z;
    for (let i = 1; i <= n; i++) {
      const tx = from.x + ((to.x - from.x) * i) / n, tz = from.y + ((to.y - from.y) * i) / n;
      const step = stepPlayerMovement({ x, z, floorY, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, tx - x, tz - z, 1 / 30, sv);
      const ground = sv.dungeonGroundAt!(step.x, step.z, floorY + 0.6);
      if (ground === null || floorY - ground > stepDown + 0.05) break;
      const moved = Math.hypot(step.x - x, step.z - z);
      x = step.x; z = step.z; floorY = ground;
      if (moved < 0.01) break;
    }
    return { x, y: z, z: floorY };
  };
  const skill = opts.jumpSkill ?? 100, runRate = opts.runRate ?? 2;
  const kit: JumpKit = {
    floor: (x, y, fromZ) => col.getFloorHeight(x, y, fromZ + 0.05, Infinity),
    airStep: (from: NavPoint, dx, dy) => {
      const r = stepPlayerMovement({ x: from.x, z: from.y, floorY: from.z, inDungeon: true, airborne: true, jumpVelocityX: dx, jumpVelocityZ: dy, slideVelocity: null }, 0, 0, 1, services());
      return { x: r.x, y: r.z };
    },
    launch: (power, walk) => ({ forward: walk ? 3.12 : 4 * runRate, up: getJumpVelocity(0, skill, power) }),
    chargeSeconds: 1,
  };
  return { col, probe, kit, stepDown };
}
