/**
 * DualDidMapper (0x27) — weenie-class lookup for crafting categories.
 *
 * Per reference/ACE/Source/ACE.DatLoader/FileTypes/DualDidMapper.cs:
 *   Same wire format as DidMapper — client side + server side, each with
 *   ID-mapping and Name-mapping sub-tables.
 *
 * Known instances (per ACE docstring on the 27xxxxxx range):
 *   0x27000000 — Materials
 *   0x27000001 — Gems
 *   0x27000002 — SpellComponents
 *   0x27000003 — ComponentPacks
 *   0x27000004 — TradeNotes
 *
 * Used by the AC client to track spell-component possession (which weenies
 * count as which crafting category) and rendering of crafting UI.
 */
import { DatReader } from '../DatReader.js';
import { NumberingType } from './EnumMapper.js';

interface DualDidMapperSide {
  idNumberingType: NumberingType;
  enumToId: Map<number, number>;
  nameNumberingType: NumberingType;
  enumToName: Map<number, string>;
}

export interface DualDidMapper {
  id: number;
  client: DualDidMapperSide;
  server: DualDidMapperSide;
}

function readSide(reader: DatReader): DualDidMapperSide {
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

export function readDualDidMapper(reader: DatReader): DualDidMapper {
  const id = reader.readUInt32();
  const client = readSide(reader);
  const server = readSide(reader);
  return { id, client, server };
}

/** Known well-known DualDidMapper IDs per ACE docstring. */
export const DUAL_DID_MATERIALS        = 0x27000000;
export const DUAL_DID_GEMS             = 0x27000001;
export const DUAL_DID_SPELL_COMPONENTS = 0x27000002;
export const DUAL_DID_COMPONENT_PACKS  = 0x27000003;
export const DUAL_DID_TRADE_NOTES      = 0x27000004;
