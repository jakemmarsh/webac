import { DatReader } from '../DatReader.js';

/**
 * Palette — 0x04 portal.dat files.
 * Contains 256 ARGB color entries.
 */
export class Palette {
  id: number = 0;
  colors: number[] = [];

  static read(reader: DatReader): Palette {
    const pal = new Palette();
    pal.id = reader.readUInt32();

    // List<uint>.Unpack reads an Int32 count, then that many UInt32 values
    const count = reader.readInt32();
    for (let i = 0; i < count; i++) {
      pal.colors.push(reader.readUInt32());
    }

    return pal;
  }
}
