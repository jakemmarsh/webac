/**
 * EnumMapper (0x22) — symbolic-name lookup table.
 *
 * Per reference/ACE/Source/ACE.DatLoader/FileTypes/EnumMapper.cs:
 *   Id: uint32
 *   BaseEnumMap: uint32 (m_base_emp_did — parent mapper to inherit from)
 *   NumberingType: byte (Normal/Sequential/Bitfield/Bitfield32/Bitfield64)
 *   num_enums: CompressedUInt32
 *   entries: num_enums × { id: uint32, name: PString(length-1) }
 *
 * EnumMapper files are used by the AC client to translate raw numeric IDs to
 * human-readable enum names (e.g., chat color categories, item-flag labels).
 * A description of each EnumMapper is in DidMapper entry 0x25000000.
 */
import { DatReader } from '../DatReader.js';

/** NumberingType — per reference/ACE/Source/ACE.Entity/Enum/NumberingType.cs.
 *  ACE has Normal = Sequential = 0x1 (same value, two names). TS enum can't
 *  have two members with the same value, so we expose Sequential as a const
 *  alias for callers that prefer that name. */
export enum NumberingType {
  Undefined  = 0x0,
  Normal     = 0x1,
  Bitfield   = 0x2,
  Bitfield32 = 0x3,
  Bitfield64 = 0x4,
}
export const SEQUENTIAL_NUMBERING: NumberingType = NumberingType.Normal;

export interface EnumMapper {
  id: number;
  baseEnumMap: number;
  numberingType: NumberingType;
  idToStringMap: Map<number, string>;
}

export function readEnumMapper(reader: DatReader): EnumMapper {
  const id = reader.readUInt32();
  const baseEnumMap = reader.readUInt32();
  const numberingType = reader.readUInt8() as NumberingType;

  const numEnums = reader.readCompressedUInt32();
  const idToStringMap = new Map<number, string>();
  for (let i = 0; i < numEnums; i++) {
    const k = reader.readUInt32();
    const v = reader.readPString(1);
    idToStringMap.set(k, v);
  }
  return { id, baseEnumMap, numberingType, idToStringMap };
}
