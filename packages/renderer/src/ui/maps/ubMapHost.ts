/**
 * The game side of UtilityBelt's map windows (UbMaps.ts UbMapHost), from what main.ts already holds: the
 * agent host's view of you and the world's objects, the era's cell.dat through DungeonRenderer /
 * EnvCellRenderer, the Region, and the era's marker table (tools/build-map-markers.ts). The same code
 * serves every era: each reads its own DATs and its own table.
 */
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import type { RegionDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import type { AgentHostObject, AgentHostSelf } from '../../agent/AgentApi.js';
import { yawToCompass } from '../../agent/AgentApi.js';
import { decalObjectClass } from '../../agent/decalObjectClass.js';
import type { DungeonCellGeometry } from './dungeonMapModel.js';
import { meanColor, parseMapTable, type MapTable } from './landscapeMapModel.js';
import type { UbMapHost, UbMapRoute } from './UbMaps.js';

export type UbMapEra = 'eol' | 'dm' | 'ac1999';

export interface UbMapHostDeps {
  self(): AgentHostSelf | null;
  objects(): Iterable<AgentHostObject>;
  /** An object's icon (PropertyDataId Icon), when the client has it. */
  icon(guid: number): number | undefined;
  interiorCells(landblock: number): number[];
  cellGeometry(cellId: number): DungeonCellGeometry | null;
  envCellFlags(cellId: number): number | null;
  ensureLandblock?(landblock: number): Promise<void>;
  cellFile(id: number): ArrayBuffer | null;
  region(): RegionDesc | null;
  /** A texture's RGBA (the road's), from the era's portal.dat. */
  textureRgba(id: number): ArrayLike<number> | null;
  era(): UbMapEra;
  /** The automation window's loaded route as landblock-local points of `landblock` (scene/NavLines routeNavPoints). */
  navRoute?(landblock: number): UbMapRoute | null;
}

const ROAD_TERRAIN_TYPE = 0x20;

/** The era's marker table, its own lazily loaded chunk. */
export async function loadMapTable(era: UbMapEra): Promise<MapTable> {
  const mod = era === 'ac1999' ? await import('./markers/ac1999.ts') : era === 'eol' ? await import('./markers/eol.ts') : await import('./markers/dm.ts');
  return parseMapTable(mod.default);
}

export function createUbMapHost(d: UbMapHostDeps): UbMapHost {
  const tables = new Map<UbMapEra, Promise<MapTable>>();
  return {
    me: () => {
      const s = d.self();
      return s ? { guid: s.guid, name: s.name, cell: s.cell >>> 0, x: s.x, y: s.y, z: s.z, heading: yawToCompass(s.yaw) } : null;
    },
    *objects() {
      for (const o of d.objects()) {
        if (o.cell === null || o.lost || o.wielderId || o.containerId) continue;
        yield { guid: o.guid, name: o.name, objectClass: decalObjectClass(o.itemType, o.objectDescFlags), cell: o.cell >>> 0, x: o.x, y: o.y, z: o.z, icon: d.icon(o.guid) };
      }
    },
    dungeonSource: () => ({ cellIds: (lb) => d.interiorCells(lb), cell: (id) => d.cellGeometry(id) }),
    envCellFlags: (id) => d.envCellFlags(id),
    ensureDungeon: d.ensureLandblock ? (lb) => d.ensureLandblock!(lb) : undefined,
    terrain: () => {
      const region = d.region();
      if (!region) return null;
      const roadDesc = region.terrainInfo.landSurfaces.texMerge?.terrainDesc.find((t) => t.terrainType === ROAD_TERRAIN_TYPE);
      const roadRgba = roadDesc ? d.textureRgba(roadDesc.terrainTex.texGID) : null;
      return {
        read: (lbx, lby) => {
          const data = d.cellFile(((lbx << 24) | (lby << 16) | 0xffff) >>> 0);
          if (!data) return null;
          const lb = CellLandblock.read(new DatReader(data));
          return { terrain: lb.terrain, heights: lb.heights };
        },
        heightTable: region.landDefs.landHeightTable,
        terrainColors: region.terrainInfo.terrainTypes.map((t) => t.terrainColor >>> 0),
        road: roadRgba ? meanColor(roadRgba) : [0, 0, 0],
      };
    },
    mapTable: () => {
      const era = d.era();
      let t = tables.get(era);
      if (!t) { t = loadMapTable(era); tables.set(era, t); }
      return t;
    },
    navRoute: d.navRoute,
  };
}
