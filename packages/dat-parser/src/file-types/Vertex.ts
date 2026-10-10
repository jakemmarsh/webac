import { DatReader } from '../DatReader.js';

/**
 * SWVertex — vertex with position, normal, and UV coordinates.
 * From ACE CVertexArray / SWVertex.
 */
export interface UV {
  u: number;
  v: number;
}

export interface SWVertex {
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  uvs: UV[];
}

export function readSWVertex(reader: DatReader): SWVertex {
  const numUVs = reader.readUInt16();
  const origin = reader.readVector3();
  const normal = reader.readVector3();

  const uvs: UV[] = [];
  for (let i = 0; i < numUVs; i++) {
    uvs.push({ u: reader.readFloat32(), v: reader.readFloat32() });
  }

  return { origin, normal, uvs };
}

/**
 * CVertexArray — indexed vertex collection.
 * Reads: vertexType (int32), numVertices (uint32), then dict of (ushort key → SWVertex).
 */
export interface CVertexArray {
  vertexType: number;
  vertices: Map<number, SWVertex>;
}

export function readCVertexArray(reader: DatReader): CVertexArray {
  const vertexType = reader.readInt32();
  const numVertices = reader.readUInt32();

  const vertices = new Map<number, SWVertex>();
  for (let i = 0; i < numVertices; i++) {
    const key = reader.readUInt16();
    vertices.set(key, readSWVertex(reader));
  }

  return { vertexType, vertices };
}
