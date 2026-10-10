import { DatReader } from '../DatReader.js';

/**
 * PaletteSet — set of palette IDs from portal.dat (0x0Fxxxxxx)
 * Reference: ACE.DatLoader/FileTypes/PaletteSet.cs
 */
export class PaletteSet {
  id: number = 0;
  paletteList: number[] = [];

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // List<uint>.Unpack = int32 count + uint32 items
    const count = reader.readInt32();
    for (let i = 0; i < count; i++) {
      this.paletteList.push(reader.readUInt32());
    }
  }

  /** Map a hue (0.0–1.0) to a palette ID from the list */
  getPaletteId(hue: number): number {
    if (this.paletteList.length === 0 || hue < 0 || hue > 1) return 0;
    let palIndex = Math.floor((this.paletteList.length - 0.000001) * hue);
    if (palIndex < 0) palIndex = 0;
    if (palIndex > this.paletteList.length - 1) palIndex = this.paletteList.length - 1;
    return this.paletteList[palIndex];
  }
}
