import { DatReader } from '../DatReader.js';

export enum MotionDataFlags {
  HasVelocity = 0x01,
  HasOmega = 0x02,
}

export interface AnimData {
  animId: number;
  lowFrame: number;
  highFrame: number;
  framerate: number;
}

export interface MotionData {
  numAnims: number;
  bitfield: number;
  flags: number;
  anims: AnimData[];
  velocity?: { x: number; y: number; z: number };
  omega?: { x: number; y: number; z: number };
}

function readAnimData(reader: DatReader): AnimData {
  return {
    animId: reader.readUInt32(),
    lowFrame: reader.readInt32(),
    highFrame: reader.readInt32(),
    framerate: reader.readFloat32(),
  };
}

function readMotionData(reader: DatReader): MotionData {
  const numAnims = reader.readUInt8();
  const bitfield = reader.readUInt8();
  const flags = reader.readUInt8();
  reader.align(4); // AlignBoundary

  const anims: AnimData[] = [];
  for (let i = 0; i < numAnims; i++) {
    anims.push(readAnimData(reader));
  }

  const data: MotionData = { numAnims, bitfield, flags, anims };

  if ((flags & MotionDataFlags.HasVelocity) !== 0) {
    data.velocity = reader.readVector3();
  }

  if ((flags & MotionDataFlags.HasOmega) !== 0) {
    data.omega = reader.readVector3();
  }

  return data;
}

/**
 * MotionTable — animation state machine from portal.dat (0x09xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/MotionTable.cs
 */
export class MotionTable {
  id: number = 0;
  defaultStyle: number = 0;
  styleDefaults: Map<number, number> = new Map();
  cycles: Map<number, MotionData> = new Map();
  modifiers: Map<number, MotionData> = new Map();
  links: Map<number, Map<number, MotionData>> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.defaultStyle = reader.readUInt32();

    // StyleDefaults: uint32 count, then (uint32 key, uint32 value) pairs
    const numStyleDefaults = reader.readUInt32();
    for (let i = 0; i < numStyleDefaults; i++) {
      this.styleDefaults.set(reader.readUInt32(), reader.readUInt32());
    }

    // Cycles: Dictionary<uint, MotionData> with uint32 count
    {
      const count = reader.readUInt32();
      for (let i = 0; i < count; i++) {
        const key = reader.readUInt32();
        this.cycles.set(key, readMotionData(reader));
      }
    }

    // Modifiers: Dictionary<uint, MotionData> with uint32 count
    {
      const count = reader.readUInt32();
      for (let i = 0; i < count; i++) {
        const key = reader.readUInt32();
        this.modifiers.set(key, readMotionData(reader));
      }
    }

    // Links: Dictionary<uint, Dictionary<uint, MotionData>> with uint32 count
    {
      const outerCount = reader.readUInt32();
      for (let i = 0; i < outerCount; i++) {
        const outerKey = reader.readUInt32();
        const innerMap = new Map<number, MotionData>();

        const innerCount = reader.readUInt32();
        for (let j = 0; j < innerCount; j++) {
          const innerKey = reader.readUInt32();
          innerMap.set(innerKey, readMotionData(reader));
        }

        this.links.set(outerKey, innerMap);
      }
    }
  }
}
