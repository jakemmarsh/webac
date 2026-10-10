import { DatReader } from '../DatReader.js';

export interface CloTextureEffect {
  oldTexture: number;
  newTexture: number;
}

export interface CloObjectEffect {
  index: number;
  modelId: number;
  cloTextureEffects: CloTextureEffect[];
}

export interface ClothingBaseEffect {
  cloObjectEffects: CloObjectEffect[];
}

export interface CloSubPaletteRange {
  offset: number;
  numColors: number;
}

export interface CloSubPalette {
  ranges: CloSubPaletteRange[];
  paletteSet: number;
}

export interface CloSubPalEffect {
  icon: number;
  cloSubPalettes: CloSubPalette[];
}

function readCloTextureEffect(reader: DatReader): CloTextureEffect {
  return {
    oldTexture: reader.readUInt32(),
    newTexture: reader.readUInt32(),
  };
}

function readCloObjectEffect(reader: DatReader): CloObjectEffect {
  const index = reader.readUInt32();
  const modelId = reader.readUInt32();

  const count = reader.readUInt32();
  const cloTextureEffects: CloTextureEffect[] = [];
  for (let i = 0; i < count; i++) {
    cloTextureEffects.push(readCloTextureEffect(reader));
  }

  return { index, modelId, cloTextureEffects };
}

function readClothingBaseEffect(reader: DatReader): ClothingBaseEffect {
  const count = reader.readUInt32();
  const cloObjectEffects: CloObjectEffect[] = [];
  for (let i = 0; i < count; i++) {
    cloObjectEffects.push(readCloObjectEffect(reader));
  }
  return { cloObjectEffects };
}

function readCloSubPaletteRange(reader: DatReader): CloSubPaletteRange {
  return {
    offset: reader.readUInt32(),
    numColors: reader.readUInt32(),
  };
}

function readCloSubPalette(reader: DatReader): CloSubPalette {
  const rangeCount = reader.readUInt32();
  const ranges: CloSubPaletteRange[] = [];
  for (let i = 0; i < rangeCount; i++) {
    ranges.push(readCloSubPaletteRange(reader));
  }
  const paletteSet = reader.readUInt32();
  return { ranges, paletteSet };
}

function readCloSubPalEffect(reader: DatReader): CloSubPalEffect {
  const icon = reader.readUInt32();
  const count = reader.readUInt32();
  const cloSubPalettes: CloSubPalette[] = [];
  for (let i = 0; i < count; i++) {
    cloSubPalettes.push(readCloSubPalette(reader));
  }
  return { icon, cloSubPalettes };
}

/**
 * ClothingTable — item model/texture/palette data from portal.dat (0x10xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/ClothingTable.cs
 */
export class ClothingTable {
  id: number = 0;
  clothingBaseEffects: Map<number, ClothingBaseEffect> = new Map();
  clothingSubPalEffects: Map<number, CloSubPalEffect> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // PackedHashTable<uint, ClothingBaseEffect>
    const baseCount = reader.readUInt16();
    reader.readUInt16(); // bucket size
    for (let i = 0; i < baseCount; i++) {
      const key = reader.readUInt32();
      this.clothingBaseEffects.set(key, readClothingBaseEffect(reader));
    }

    // PackedHashTable<uint, CloSubPalEffect>
    const palCount = reader.readUInt16();
    reader.readUInt16(); // bucket size
    for (let i = 0; i < palCount; i++) {
      const key = reader.readUInt32();
      this.clothingSubPalEffects.set(key, readCloSubPalEffect(reader));
    }
  }
}
