import { DatReader } from '../DatReader.js';

export interface SpellComponentBase {
  name: string;
  category: number;
  icon: number;
  type: number;
  gesture: number;
  time: number;
  text: string;
  cdm: number;
}

function readSpellComponentBase(reader: DatReader): SpellComponentBase {
  const name = reader.readObfuscatedString();
  reader.align(4);
  const category = reader.readUInt32();
  const icon = reader.readUInt32();
  const type = reader.readUInt32();
  const gesture = reader.readUInt32();
  const time = reader.readFloat32();
  const text = reader.readObfuscatedString();
  reader.align(4);
  const cdm = reader.readFloat32();

  return { name, category, icon, type, gesture, time, text, cdm };
}

/**
 * SpellComponentsTable — spell reagent/component definitions from portal.dat (0x0E00000F)
 * Reference: ACE.DatLoader/FileTypes/SpellComponentsTable.cs
 */
export class SpellComponentTable {
  id: number = 0;
  components: Map<number, SpellComponentBase> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    const numComps = reader.readUInt16();
    reader.align(4);

    // PackedHashTable: uint16 count + uint16 bucketSize already read above
    // Actually the format is: uint16 numComps, align, then (uint32 key + component) × numComps
    for (let i = 0; i < numComps; i++) {
      const key = reader.readUInt32();
      this.components.set(key, readSpellComponentBase(reader));
    }
  }
}
