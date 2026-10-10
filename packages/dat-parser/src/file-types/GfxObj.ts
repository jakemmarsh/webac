import { DatReader } from '../DatReader.js';
import { readCVertexArray, type CVertexArray, type SWVertex } from './Vertex.js';
import { readPolygon, type Polygon } from './Polygon.js';
import { readBSPTree, BSPType, type BSPTree } from './BSPTree.js';

/**
 * GfxObjFlags — per ACE.Entity.Enum.GfxObjFlags.cs. Flags byte at offset 4
 * of the 0x01xxxxxx GfxObj binary.
 *
 * - HasPhysics gates PhysicsPolygons + PhysicsBSP block (read AFTER Surfaces
 *   + VertexArray, BEFORE SortCenter).
 * - HasDrawing gates DrawingPolygons + DrawingBSP block (read AFTER SortCenter).
 * - HasDIDDegrade gates a trailing uint32.
 * - Unknown (0x4) is reserved in ACE; not used by the parser.
 */
export enum GfxObjFlags {
  HasPhysics    = 0x1,
  HasDrawing    = 0x2,
  Unknown       = 0x4,
  HasDIDDegrade = 0x8,
}

/**
 * GfxObj — 3D mesh from portal.dat (0x01xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/GfxObj.cs
 */
export class GfxObj {
  id: number = 0;
  flags: number = 0;
  surfaces: number[] = [];
  vertexArray: CVertexArray | null = null;

  physicsPolygons: Map<number, Polygon> = new Map();
  physicsBSP: BSPTree | null = null;

  sortCenter: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

  polygons: Polygon[] = [];
  polygonMap: Map<number, Polygon> = new Map();
  drawingBSP: BSPTree | null = null;

  didDegrade: number = 0;

  /** Convenience: flat array of vertices from the vertex array map */
  vertices: SWVertex[] = [];

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.flags = reader.readUInt32();

    // Surfaces: SmartArray (CompressedUInt32 count, then uint32[])
    const surfaceCount = reader.readCompressedUInt32();
    for (let i = 0; i < surfaceCount; i++) {
      this.surfaces.push(reader.readUInt32());
    }

    // Vertex array
    this.vertexArray = readCVertexArray(reader);

    // Extract flat vertices array for convenience
    this.vertices = Array.from(this.vertexArray.vertices.values());

    // Physics polygons + BSP — gated by GfxObjFlags.HasPhysics (0x1).
    if ((this.flags & GfxObjFlags.HasPhysics) !== 0) {
      // SmartArray of polygons: CompressedUInt32 count, then (uint16 key + Polygon)
      const physPolyCount = reader.readCompressedUInt32();
      for (let i = 0; i < physPolyCount; i++) {
        const key = reader.readUInt16();
        this.physicsPolygons.set(key, readPolygon(reader));
      }
      this.physicsBSP = readBSPTree(reader, BSPType.Physics);
    }

    // Sort center
    this.sortCenter = reader.readVector3();

    // Drawing polygons + BSP — gated by GfxObjFlags.HasDrawing (0x2).
    if ((this.flags & GfxObjFlags.HasDrawing) !== 0) {
      // SmartArray of polygons: CompressedUInt32 count, then (uint16 key + Polygon)
      const drawPolyCount = reader.readCompressedUInt32();
      for (let i = 0; i < drawPolyCount; i++) {
        const key = reader.readUInt16();
        const poly = readPolygon(reader);
        this.polygonMap.set(key, poly);
        this.polygons.push(poly);
      }
      this.drawingBSP = readBSPTree(reader, BSPType.Drawing);
    }

    // DID degrade
    if ((this.flags & GfxObjFlags.HasDIDDegrade) !== 0) {
      this.didDegrade = reader.readUInt32();
    }
  }
}
