import { DatReader } from '../DatReader.js';
import { readCVertexArray, type CVertexArray } from './Vertex.js';
import { readPolygon, type Polygon } from './Polygon.js';
import { readBSPTree, BSPType, type BSPTree } from './BSPTree.js';

/**
 * CellStruct — geometry data for a dungeon room prefab cell
 * Reference: ACE.DatLoader/Entity/CellStruct.cs
 */
export interface CellStruct {
  vertexArray: CVertexArray;
  polygons: Map<number, Polygon>;
  portals: number[];
  cellBSP: BSPTree;
  physicsPolygons: Map<number, Polygon>;
  physicsBSP: BSPTree;
  drawingBSP: BSPTree | null;
}

function readCellStruct(reader: DatReader): CellStruct {
  const numPolygons = reader.readUInt32();
  const numPhysicsPolygons = reader.readUInt32();
  const numPortals = reader.readUInt32();

  const vertexArray = readCVertexArray(reader);

  // Polygons: ushort key + Polygon, fixed count
  const polygons = new Map<number, Polygon>();
  for (let i = 0; i < numPolygons; i++) {
    const key = reader.readUInt16();
    polygons.set(key, readPolygon(reader));
  }

  // Portal polygon indices
  const portals: number[] = [];
  for (let i = 0; i < numPortals; i++) {
    portals.push(reader.readUInt16());
  }
  reader.align(4);

  // Cell BSP (BSPType.Cell)
  const cellBSP = readBSPTree(reader, BSPType.Cell);

  // Physics polygons: ushort key + Polygon, fixed count
  const physicsPolygons = new Map<number, Polygon>();
  for (let i = 0; i < numPhysicsPolygons; i++) {
    const key = reader.readUInt16();
    physicsPolygons.set(key, readPolygon(reader));
  }

  // Physics BSP
  const physicsBSP = readBSPTree(reader, BSPType.Physics);

  // Optional Drawing BSP
  let drawingBSP: BSPTree | null = null;
  const hasDrawingBSP = reader.readUInt32();
  if (hasDrawingBSP !== 0) {
    drawingBSP = readBSPTree(reader, BSPType.Drawing);
  }

  reader.align(4);

  return {
    vertexArray,
    polygons,
    portals,
    cellBSP,
    physicsPolygons,
    physicsBSP,
    drawingBSP,
  };
}

/**
 * Environment — dungeon room prefab geometry from portal.dat (0x0Dxxxxxx)
 * Reference: ACE.DatLoader/FileTypes/Environment.cs
 */
export class Environment {
  id: number = 0;
  cells: Map<number, CellStruct> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // Dictionary<uint, CellStruct> with uint32 count
    const cellCount = reader.readUInt32();
    for (let i = 0; i < cellCount; i++) {
      const key = reader.readUInt32();
      this.cells.set(key, readCellStruct(reader));
    }
  }
}
