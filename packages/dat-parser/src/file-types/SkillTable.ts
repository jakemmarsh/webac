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

/**
 * The SkillTable file without the entries keyed by `drop`, the bytes a DAT
 * that never had those skills holds: the PackedHashTable count drops and the
 * kept entries stay byte for byte in order (the bucket size is unchanged).
 * Classic Dereth 1.0's table is exactly 1.1's without Salvaging (40), the
 * last entry (era/EraProfiles.ts 'classic-dereth-1-0').
 */
export function skillTableWithout(data: ArrayBuffer, drop: ReadonlySet<number>): ArrayBuffer {
  const src = new Uint8Array(data);
  const reader = new DatReader(data);
  reader.readUInt32(); // id
  const count = reader.readUInt16();
  reader.readUInt16(); // bucket size
  const kept: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const start = reader.position;
    const key = reader.readUInt32();
    readSkillBase(reader);
    if (!drop.has(key)) kept.push([start, reader.position]);
  }
  const header = 8;
  const size = header + kept.reduce((n, [a, b]) => n + (b - a), 0) + (src.length - reader.position);
  const out = new Uint8Array(size);
  out.set(src.subarray(0, header));
  new DataView(out.buffer).setUint16(4, kept.length, true);
  let o = header;
  for (const [a, b] of kept) { out.set(src.subarray(a, b), o); o += b - a; }
  out.set(src.subarray(reader.position), o);
  return out.buffer;
}
