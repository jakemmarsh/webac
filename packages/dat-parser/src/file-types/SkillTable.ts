import { DatReader } from '../DatReader.js';

export interface SkillFormula {
  w: number;
  x: number;
  y: number;
  z: number;
  attr1: number;
  attr2: number;
}

export interface SkillBase {
  description: string;
  name: string;
  iconId: number;
  trainedCost: number;
  specializedCost: number;
  category: number;
  chargenUse: number;
  minLevel: number;
  formula: SkillFormula;
  upperBound: number;
  lowerBound: number;
  learnMod: number;
}

function readSkillFormula(reader: DatReader): SkillFormula {
  return {
    w: reader.readUInt32(),
    x: reader.readUInt32(),
    y: reader.readUInt32(),
    z: reader.readUInt32(),
    attr1: reader.readUInt32(),
    attr2: reader.readUInt32(),
  };
}

function readSkillBase(reader: DatReader): SkillBase {
  const description = reader.readPString(2); reader.align(4);
  const name = reader.readPString(2); reader.align(4);
  const iconId = reader.readUInt32();
  const trainedCost = reader.readInt32();
  const specializedCost = reader.readInt32();
  const category = reader.readUInt32();
  const chargenUse = reader.readUInt32();
  const minLevel = reader.readUInt32();
  const formula = readSkillFormula(reader);
  const upperBound = reader.readFloat64();
  const lowerBound = reader.readFloat64();
  const learnMod = reader.readFloat64();

  return {
    description, name, iconId, trainedCost, specializedCost,
    category, chargenUse, minLevel, formula, upperBound, lowerBound, learnMod,
  };
}

/**
 * SkillTable — all game skills from portal.dat (0x0E000004)
 * Reference: ACE.DatLoader/FileTypes/SkillTable.cs
 */
export class SkillTable {
  id: number = 0;
  skills: Map<number, SkillBase> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // PackedHashTable<uint, SkillBase>: uint16 count + uint16 bucketSize
    const count = reader.readUInt16();
    reader.readUInt16(); // bucket size

    for (let i = 0; i < count; i++) {
      const key = reader.readUInt32();
      this.skills.set(key, readSkillBase(reader));
    }
  }
}
