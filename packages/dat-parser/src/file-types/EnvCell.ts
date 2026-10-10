import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';

export enum EnvCellFlags {
  SeenOutside = 0x01,
  HasStaticObjs = 0x02,
  HasRestrictionObj = 0x08,
}

export interface CellPortal {
  flags: number;
  polygonId: number;
  otherCellId: number;
  otherPortalId: number;
}

export interface Stab {
  id: number;
  frame: Frame;
}

/**
 * EnvCell — interior cell from cell.dat (0xXXYY01xx through 0xXXYYFExx)
 * Reference: ACE.DatLoader/FileTypes/EnvCell.cs
 */
export class EnvCell {
  id: number = 0;
  flags: number = 0;
  surfaces: number[] = [];
  environmentId: number = 0;
  cellStructure: number = 0;
  position: Frame;
  cellPortals: CellPortal[] = [];
  visibleCells: number[] = [];
  staticObjects: Stab[] = [];
  restrictionObj: number = 0;

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.flags = reader.readUInt32();

    // Skip duplicate cell ID
    reader.skip(4);

    const numSurfaces = reader.readUInt8();
    const numPortals = reader.readUInt8();
    const numStabs = reader.readUInt16();

    // Surfaces: stored as uint16, padded to full DID with 0x08000000
    for (let i = 0; i < numSurfaces; i++) {
      this.surfaces.push((0x08000000 | reader.readUInt16()) >>> 0);
    }

    // Environment ID: stored as uint16, padded to 0x0D000000
    this.environmentId = (0x0D000000 | reader.readUInt16()) >>> 0;

    this.cellStructure = reader.readUInt16();

    // Position frame
    this.position = readFrame(reader);

    // Cell portals
    for (let i = 0; i < numPortals; i++) {
      this.cellPortals.push({
        flags: reader.readUInt16(),
        polygonId: reader.readUInt16(),
        otherCellId: reader.readUInt16(),
        otherPortalId: reader.readUInt16(),
      });
    }

    // Visible cells
    for (let i = 0; i < numStabs; i++) {
      this.visibleCells.push(reader.readUInt16());
    }

    // Static objects
    if ((this.flags & EnvCellFlags.HasStaticObjs) !== 0) {
      const objCount = reader.readUInt32();
      for (let i = 0; i < objCount; i++) {
        this.staticObjects.push({
          id: reader.readUInt32(),
          frame: readFrame(reader),
        });
      }
    }

    // Restriction object
    if ((this.flags & EnvCellFlags.HasRestrictionObj) !== 0) {
      this.restrictionObj = reader.readUInt32();
    }
  }
}
