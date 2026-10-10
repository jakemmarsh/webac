import { DatReader } from '../DatReader.js';

/**
 * Frame — position (Vector3) + orientation (Quaternion).
 * Origin: 3 × float32, Orientation: W, X, Y, Z as 4 × float32.
 * Total: 28 bytes.
 */
export interface Frame {
  origin: { x: number; y: number; z: number };
  orientation: { w: number; x: number; y: number; z: number };
}

export function readFrame(reader: DatReader): Frame {
  const origin = reader.readVector3();
  const w = reader.readFloat32();
  const x = reader.readFloat32();
  const y = reader.readFloat32();
  const z = reader.readFloat32();
  return { origin, orientation: { w, x, y, z } };
}
