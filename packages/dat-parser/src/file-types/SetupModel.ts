import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';
import { readAnimationFrame, type AnimationFrame } from './AnimationHook.js';
import { type Sphere } from './BSPTree.js';

/**
 * SetupFlags — per ACE.Entity.Enum.SetupFlags.cs. Flags byte at offset 4
 * of the 0x02xxxxxx SetupModel binary. Only 4 bits are defined in ACE;
 * the higher bits are unused.
 *
 * NOTE: HoldingLocations / ConnectionPoints / PlacementFrames are all read
 * UNCONDITIONALLY in ACE.DatLoader/FileTypes/SetupModel.cs (each block has
 * its own count prefix). Bits 0x04 / 0x08 are NOT gates for them — they
 * encode AllowFreeHeading and HasPhysicsBSP respectively. Earlier versions
 * of this port had AllowFreeHeading=0x200, HasPhysicsBSP=0x400 (made up)
 * which caused both booleans to always read false. Now ACE-anchored.
 */
export enum SetupFlags {
  HasParent        = 0x1,
  HasDefaultScale  = 0x2,
  AllowFreeHeading = 0x4,
  HasPhysicsBSP    = 0x8,
}

export interface LocationType {
  partId: number;
  frame: Frame;
}

export interface CylSphere {
  origin: { x: number; y: number; z: number };
  radius: number;
  height: number;
}

export interface LightInfo {
  viewerSpaceLocation: Frame;
  color: number;
  intensity: number;
  falloff: number;
  coneAngle: number;
}

function readSphere(reader: DatReader): Sphere {
  return {
    origin: reader.readVector3(),
    radius: reader.readFloat32(),
  };
}

function readCylSphere(reader: DatReader): CylSphere {
  return {
    origin: reader.readVector3(),
    radius: reader.readFloat32(),
    height: reader.readFloat32(),
  };
}

function readLocationType(reader: DatReader): LocationType {
  return {
    partId: reader.readInt32(),
    frame: readFrame(reader),
  };
}

function readLightInfo(reader: DatReader): LightInfo {
  return {
    viewerSpaceLocation: readFrame(reader),
    color: reader.readUInt32(),
    intensity: reader.readFloat32(),
    falloff: reader.readFloat32(),
    coneAngle: reader.readFloat32(),
  };
}

/**
 * SetupModel — multi-part 3D model from portal.dat (0x02xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/SetupModel.cs
 */
export class SetupModel {
  id: number = 0;
  flags: number = 0;
  allowFreeHeading: boolean = false;
  hasPhysicsBSP: boolean = false;

  parts: number[] = [];          // GfxObj IDs (0x01xxxxxx)
  parentIndex: number[] = [];
  defaultScale: { x: number; y: number; z: number }[] = [];

  holdingLocations: Map<number, LocationType> = new Map();
  connectionPoints: Map<number, LocationType> = new Map();
  placementFrames: Map<number, AnimationFrame> = new Map();

  cylSpheres: CylSphere[] = [];
  spheres: Sphere[] = [];

  height: number = 0;
  radius: number = 0;
  stepUpHeight: number = 0;
  stepDownHeight: number = 0;

  sortingSphere: Sphere = { origin: { x: 0, y: 0, z: 0 }, radius: 0 };
  selectionSphere: Sphere = { origin: { x: 0, y: 0, z: 0 }, radius: 0 };

  lights: Map<number, LightInfo> = new Map();

  defaultAnimation: number = 0;
  defaultScript: number = 0;
  defaultMotionTable: number = 0;
  defaultSoundTable: number = 0;
  defaultScriptTable: number = 0;

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.flags = reader.readUInt32();

    this.allowFreeHeading = (this.flags & SetupFlags.AllowFreeHeading) !== 0;
    this.hasPhysicsBSP = (this.flags & SetupFlags.HasPhysicsBSP) !== 0;

    // Parts (GfxObj IDs)
    const numParts = reader.readUInt32();
    for (let i = 0; i < numParts; i++) {
      this.parts.push(reader.readUInt32());
    }

    // Parent indices
    if ((this.flags & SetupFlags.HasParent) !== 0) {
      for (let i = 0; i < numParts; i++) {
        this.parentIndex.push(reader.readUInt32());
      }
    }

    // Default scales
    if ((this.flags & SetupFlags.HasDefaultScale) !== 0) {
      for (let i = 0; i < numParts; i++) {
        this.defaultScale.push(reader.readVector3());
      }
    }

    // Holding locations: Dictionary<int, LocationType> with int32 count + int32 key
    {
      const count = reader.readInt32();
      for (let i = 0; i < count; i++) {
        const key = reader.readInt32();
        this.holdingLocations.set(key, readLocationType(reader));
      }
    }

    // Connection points: Dictionary<int, LocationType> with int32 count + int32 key
    {
      const count = reader.readInt32();
      for (let i = 0; i < count; i++) {
        const key = reader.readInt32();
        this.connectionPoints.set(key, readLocationType(reader));
      }
    }

    // Placement frames: int32 count, then (int32 key + PlacementType which is AnimationFrame(numParts))
    {
      const count = reader.readInt32();
      for (let i = 0; i < count; i++) {
        const key = reader.readInt32();
        this.placementFrames.set(key, readAnimationFrame(reader, numParts));
      }
    }

    // CylSpheres: List<CylSphere> with uint32 count
    {
      const count = reader.readUInt32();
      for (let i = 0; i < count; i++) {
        this.cylSpheres.push(readCylSphere(reader));
      }
    }

    // Spheres: List<Sphere> with uint32 count
    {
      const count = reader.readUInt32();
      for (let i = 0; i < count; i++) {
        this.spheres.push(readSphere(reader));
      }
    }

    // Physical dimensions
    this.height = reader.readFloat32();
    this.radius = reader.readFloat32();
    this.stepUpHeight = reader.readFloat32();
    this.stepDownHeight = reader.readFloat32();

    // Sorting & selection spheres
    this.sortingSphere = readSphere(reader);
    this.selectionSphere = readSphere(reader);

    // Lights: Dictionary<int, LightInfo> with int32 count + int32 key
    {
      const count = reader.readInt32();
      for (let i = 0; i < count; i++) {
        const key = reader.readInt32();
        this.lights.set(key, readLightInfo(reader));
      }
    }

    // Default table references
    this.defaultAnimation = reader.readUInt32();
    this.defaultScript = reader.readUInt32();
    this.defaultMotionTable = reader.readUInt32();
    this.defaultSoundTable = reader.readUInt32();
    this.defaultScriptTable = reader.readUInt32();
  }
}
