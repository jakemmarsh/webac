import { DatReader } from '../DatReader.js';

/**
 * BadData — portal.dat 0x0E00001A: WCIDs that are "bad" and should not exist.
 * Reference: ACE.DatLoader/FileTypes/BadData.cs — Id, then
 * PackedHashTable<uint, uint> (uint16 count + uint16 bucket size, then
 * uint32 key / uint32 value pairs; the value is always 1 in practice).
 */
export class BadData {
  static readonly FILE_ID = 0x0e00001a;

  id: number = 0;
  bad: Map<number, number> = new Map();

  static read(reader: DatReader): BadData {
    const bd = new BadData();
    bd.id = reader.readUInt32();
    const count = reader.readUInt16();
    reader.readUInt16(); // bucket size (unused)
    for (let i = 0; i < count; i++) {
      const key = reader.readUInt32();
      bd.bad.set(key, reader.readUInt32());
    }
    return bd;
  }
}
