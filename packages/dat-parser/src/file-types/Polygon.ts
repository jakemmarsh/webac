import { DatReader } from '../DatReader.js';

/**
 * StipplingType flags — from ACE StipplingType.cs
 */
export enum StipplingType {
  None = 0x0,
  Positive = 0x1,
  Negative = 0x2,
  Both = 0x3,
  NoPos = 0x4,
  NoNeg = 0x8,
  NoUVS = 0x14,
}

/**
 * CullMode — polygon culling mode from ACE CullMode.cs
 */
export enum CullMode {
  Landblock = 0x0,
  None = 0x1,
  Clockwise = 0x2,
  CounterClockwise = 0x3,
}

/**
 * Polygon — triangle/quad face with vertex references and UV indices.
 * From ACE Polygon.cs.
 */
export interface Polygon {
  numPts: number;
  stippling: number;
  sidesType: number;
  posSurface: number;
  negSurface: number;
  vertexIndices: number[];
  posUVIndices: number[];
  negUVIndices: number[];
}

export function readPolygon(reader: DatReader): Polygon {
  const numPts = reader.readUInt8();
  const stippling = reader.readUInt8();
  const sidesType = reader.readInt32();
  const posSurface = reader.readInt16();
  const negSurface = reader.readInt16();

  const vertexIndices: number[] = [];
  for (let i = 0; i < numPts; i++) {
    vertexIndices.push(reader.readInt16());
  }

  const posUVIndices: number[] = [];
  if ((stippling & StipplingType.NoPos) === 0) {
    for (let i = 0; i < numPts; i++) {
      posUVIndices.push(reader.readUInt8());
    }
  }

  let negUVIndices: number[] = [];
  // CullMode.Clockwise = 2 — double-sided with separate neg UVs
  if (sidesType === CullMode.Clockwise && (stippling & StipplingType.NoNeg) === 0) {
    for (let i = 0; i < numPts; i++) {
      negUVIndices.push(reader.readUInt8());
    }
  }

  // CullMode.None = 1 — double-sided, neg mirrors pos
  const finalNegSurface = sidesType === CullMode.None ? posSurface : negSurface;
  const finalNegUVIndices = sidesType === CullMode.None ? posUVIndices : negUVIndices;

  return {
    numPts,
    stippling,
    sidesType,
    posSurface,
    negSurface: finalNegSurface,
    vertexIndices,
    posUVIndices,
    negUVIndices: finalNegUVIndices,
  };
}
