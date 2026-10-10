/**
 * DidMapper (0x25) — DataId lookup mapper with separate client + server tables.
 *
 * Per reference/ACE/Source/ACE.DatLoader/FileTypes/DidMapper.cs:
 *   Id: uint32
 *   For each of {client, server}:
 *     IDNumberingType: byte
 *     numEnumToIDs: CompressedUInt32
 *     enumToID: { uint32 key, uint32 did }
 *     NameNumberingType: byte
 *     numEnumToNames: CompressedUInt32
 *     enumToName: { uint32 key, PString(length-1) }
 *
 * From ACE docstring: "DidMapper entry 0x25000000 holds the description of
 * each DidMapper". So DidMapper is recursive — it describes itself.
 */
import { DatReader } from '../DatReader.js';
import { NumberingType } from './EnumMapper.js';

interface DidMapperSide {
  idNumberingType: NumberingType;
  enumToId: Map<number, number>;
  nameNumberingType: NumberingType;
  enumToName: Map<number, string>;
}

export interface DidMapper {
  id: number;
  client: DidMapperSide;
  server: DidMapperSide;
}

function readSide(reader: DatReader): DidMapperSide {
  const idNumberingType = reader.readUInt8() as NumberingType;
  const numEnumToIDs = reader.readCompressedUInt32();
  const enumToId = new Map<number, number>();
  for (let i = 0; i < numEnumToIDs; i++) {
    enumToId.set(reader.readUInt32(), reader.readUInt32());
  }

  const nameNumberingType = reader.readUInt8() as NumberingType;
  const numEnumToNames = reader.readCompressedUInt32();
  const enumToName = new Map<number, string>();
  for (let i = 0; i < numEnumToNames; i++) {
    const k = reader.readUInt32();
    const v = reader.readPString(1);
    enumToName.set(k, v);
  }

  return { idNumberingType, enumToId, nameNumberingType, enumToName };
}

export function readDidMapper(reader: DatReader): DidMapper {
  const id = reader.readUInt32();
  const client = readSide(reader);
  const server = readSide(reader);
  return { id, client, server };
}
