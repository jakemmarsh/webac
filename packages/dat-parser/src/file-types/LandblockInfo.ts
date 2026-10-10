import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';

export interface Stab {
  id: number;
  frame: Frame;
}

export interface CBldPortal {
  flags: number;
  otherCellId: number;
  otherPortalId: number;
  stabList: number[];
}

export interface BuildInfo {
  modelId: number;
  frame: Frame;
  numLeaves: number;
  portals: CBldPortal[];
}

function readStab(reader: DatReader): Stab {
  return {
    id: reader.readUInt32(),
    frame: readFrame(reader),
  };
}

function readCBldPortal(reader: DatReader): CBldPortal {
  const flags = reader.readUInt16();
  const otherCellId = reader.readUInt16();
  const otherPortalId = reader.readUInt16();
  const numStabs = reader.readUInt16();
  const stabList: number[] = [];
  for (let i = 0; i < numStabs; i++) {
    stabList.push(reader.readUInt16());
  }
  reader.align(4);
  return { flags, otherCellId, otherPortalId, stabList };
}

function readBuildInfo(reader: DatReader): BuildInfo {
  const modelId = reader.readUInt32();
  const frame = readFrame(reader);
  const numLeaves = reader.readUInt32();

  // Portals: List<CBldPortal> with uint32 count
  const portalCount = reader.readUInt32();
  const portals: CBldPortal[] = [];
  for (let i = 0; i < portalCount; i++) {
    portals.push(readCBldPortal(reader));
  }

  return { modelId, frame, numLeaves, portals };
}

/**
 * LandblockInfo — building and object placement data from cell.dat (0xXXYYFFFE)
 * Reference: ACE.DatLoader/FileTypes/LandblockInfo.cs
 */
export class LandblockInfo {
  id: number = 0;
  numCells: number = 0;
  objects: Stab[] = [];
  packMask: number = 0;
  buildings: BuildInfo[] = [];
  restrictionTables: Map<number, number> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.numCells = reader.readUInt32();

    // Objects: List<Stab> with uint32 count
    const objCount = reader.readUInt32();
    for (let i = 0; i < objCount; i++) {
      this.objects.push(readStab(reader));
    }

    const numBuildings = reader.readUInt16();
    this.packMask = reader.readUInt16();

    // Buildings: fixed count
    for (let i = 0; i < numBuildings; i++) {
      this.buildings.push(readBuildInfo(reader));
    }

    // Restriction tables (PackedHashTable: uint16 count + uint16 bucketSize + entries)
    if ((this.packMask & 1) === 1) {
      const rtCount = reader.readUInt16();
      reader.readUInt16(); // bucket size (unused)
      for (let i = 0; i < rtCount; i++) {
        this.restrictionTables.set(reader.readUInt32(), reader.readUInt32());
      }
    }
  }
}
