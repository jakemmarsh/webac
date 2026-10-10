import { DatReader } from '../DatReader.js';
import { readFrame, type Frame } from './Frame.js';

/**
 * ContractTable — portal.dat file 0x0E00001D.
 *
 * Authoritative source for quest contract metadata: name, description,
 * progress text, start/end NPC names, quest-flag identifiers, and the
 * world positions of the start NPC, end NPC, and quest area.
 *
 * Pre-FAITHFUL.206 the quest panel showed entries as "Contract #N"
 * because we only had the ContractTracker's contractId. Now contractId
 * lookups via this table give the player the actual quest name.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/ContractTable.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/Contract.cs
 */

export interface Position {
  /** Object cell ID (landblock-cell composite). */
  objCellId: number;
  /** Frame: origin + orientation quaternion. */
  frame: Frame;
}

export interface Contract {
  version: number;
  contractId: number;
  contractName: string;
  description: string;
  descriptionProgress: string;
  nameNpcStart: string;
  nameNpcEnd: string;
  questflagStamped: string;
  questflagStarted: string;
  questflagFinished: string;
  questflagProgress: string;
  questflagTimer: string;
  questflagRepeatTime: string;
  locationNpcStart: Position;
  locationNpcEnd: Position;
  locationQuestArea: Position;
}

function readPosition(reader: DatReader): Position {
  const objCellId = reader.readUInt32();
  const frame = readFrame(reader);
  return { objCellId, frame };
}

function readContract(reader: DatReader): Contract {
  const version = reader.readUInt32();
  const contractId = reader.readUInt32();
  const contractName = reader.readPString(); reader.align(4);
  const description = reader.readPString(); reader.align(4);
  const descriptionProgress = reader.readPString(); reader.align(4);
  const nameNpcStart = reader.readPString(); reader.align(4);
  const nameNpcEnd = reader.readPString(); reader.align(4);
  const questflagStamped = reader.readPString(); reader.align(4);
  const questflagStarted = reader.readPString(); reader.align(4);
  const questflagFinished = reader.readPString(); reader.align(4);
  const questflagProgress = reader.readPString(); reader.align(4);
  const questflagTimer = reader.readPString(); reader.align(4);
  const questflagRepeatTime = reader.readPString(); reader.align(4);
  const locationNpcStart = readPosition(reader);
  const locationNpcEnd = readPosition(reader);
  const locationQuestArea = readPosition(reader);
  return {
    version, contractId, contractName, description, descriptionProgress,
    nameNpcStart, nameNpcEnd,
    questflagStamped, questflagStarted, questflagFinished,
    questflagProgress, questflagTimer, questflagRepeatTime,
    locationNpcStart, locationNpcEnd, locationQuestArea,
  };
}

export class ContractTable {
  id: number = 0;
  /** Keyed by contractId. */
  contracts: Map<number, Contract> = new Map();

  static read(reader: DatReader): ContractTable {
    const t = new ContractTable();
    t.id = reader.readUInt32();
    const numContracts = reader.readUInt16();
    reader.readUInt16(); // table_size — C# memory hint, ignored
    for (let i = 0; i < numContracts; i++) {
      const key = reader.readUInt32();
      const contract = readContract(reader);
      t.contracts.set(key, contract);
    }
    return t;
  }

  /** Look up a contract's display name; returns null if missing. */
  nameFor(contractId: number): string | null {
    return this.contracts.get(contractId)?.contractName ?? null;
  }

  /** Look up a contract's full description; returns null if missing. */
  descriptionFor(contractId: number): string | null {
    return this.contracts.get(contractId)?.description ?? null;
  }
}
