import { DatReader } from '../DatReader.js';

/**
 * EmitterType — anchored against reference/ACE/Source/ACE.Entity/Enum/EmitterType.cs.
 *
 * BirthratePerSec = emit one particle every `birthrate` SECONDS (it is the
 * interval, not a rate — ACE ShouldEmitParticle: `now - lastEmit > Birthrate`).
 * BirthratePerMeter = emit by emitter travel distance.
 *
 * FAITHFUL.97 rename: TS port used `Birthrate=1, Initial=2` which obscured
 * the per-second vs per-meter distinction and was not 1:1 with ACE.
 */
export enum EmitterType {
  Unknown = 0,
  BirthratePerSec = 1,
  BirthratePerMeter = 2,
}

/**
 * ParticleType — anchored against reference/ACE/Source/ACE.Entity/Enum/ParticleType.cs.
 *
 * FAITHFUL.98 rename: TS port used elongated descriptive names that didn't
 * match ACE source naming (e.g., `ParabolicLVLLocalVelocity` for what ACE
 * calls `ParabolicLVGA`; off-by-one position for the parabolic variants).
 * Now mirrors ACE source byte-for-byte.
 *
 * LVGA = LocalVelocity GravityAffected; LVGAGR = LVGA + GravityRestricted;
 * LVLA = LocalVelocity LocalAcceleration; LVGGA = LVLA + GlobalRestriction;
 * GVGA = GlobalVelocity GravityAffected.
 *
 * NumParticleType=13 is ACE's sentinel "count of entries" — preserved here
 * for 1:1 audit coverage even though not used as a runtime particle type.
 */
export enum ParticleType {
  Unknown = 0,
  Still = 1,
  LocalVelocity = 2,
  ParabolicLVGA = 3,
  ParabolicLVGAGR = 4,
  Swarm = 5,
  Explode = 6,
  Implode = 7,
  ParabolicLVLA = 8,
  ParabolicLVLALR = 9,
  ParabolicGVGA = 10,
  ParabolicGVGAGR = 11,
  GlobalVelocity = 12,
  NumParticleType = 13,
}

/**
 * ParticleEmitterInfo — particle emitter definition from portal.dat (0x32xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/ParticleEmitterInfo.cs
 */
export class ParticleEmitterInfo {
  id = 0;
  emitterType = 0;
  particleType = 0;
  gfxObjId = 0;
  hwGfxObjId = 0;
  birthrate = 0;
  maxParticles = 0;
  initialParticles = 0;
  totalParticles = 0;
  totalSeconds = 0;
  lifespan = 0;
  lifespanRand = 0;
  offsetDir = { x: 0, y: 0, z: 0 };
  minOffset = 0;
  maxOffset = 0;
  a = { x: 0, y: 0, z: 0 };
  minA = 0;
  maxA = 0;
  b = { x: 0, y: 0, z: 0 };
  minB = 0;
  maxB = 0;
  c = { x: 0, y: 0, z: 0 };
  minC = 0;
  maxC = 0;
  startScale = 0;
  finalScale = 0;
  scaleRand = 0;
  startTrans = 0;
  finalTrans = 0;
  transRand = 0;
  isParentLocal = 0;

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    reader.readUInt32(); // unknown

    this.emitterType = reader.readInt32();
    this.particleType = reader.readInt32();

    this.gfxObjId = reader.readUInt32();
    this.hwGfxObjId = reader.readUInt32();

    this.birthrate = reader.readFloat64();

    this.maxParticles = reader.readInt32();
    this.initialParticles = reader.readInt32();
    this.totalParticles = reader.readInt32();

    this.totalSeconds = reader.readFloat64();
    this.lifespan = reader.readFloat64();
    this.lifespanRand = reader.readFloat64();

    this.offsetDir = reader.readVector3();
    this.minOffset = reader.readFloat32();
    this.maxOffset = reader.readFloat32();

    this.a = reader.readVector3();
    this.minA = reader.readFloat32();
    this.maxA = reader.readFloat32();

    this.b = reader.readVector3();
    this.minB = reader.readFloat32();
    this.maxB = reader.readFloat32();

    this.c = reader.readVector3();
    this.minC = reader.readFloat32();
    this.maxC = reader.readFloat32();

    this.startScale = reader.readFloat32();
    this.finalScale = reader.readFloat32();
    this.scaleRand = reader.readFloat32();

    this.startTrans = reader.readFloat32();
    this.finalTrans = reader.readFloat32();
    this.transRand = reader.readFloat32();

    this.isParentLocal = reader.readInt32();
  }
}
