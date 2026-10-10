import { DatReader } from '../DatReader.js';

export interface CombatManeuver {
  style: number;
  attackHeight: number;
  attackType: number;
  minSkillLevel: number;
  motion: number;
}

/**
 * CombatManeuverTable — combat animation lookup from portal.dat (0x30xxxxxx)
 * Reference: ACE.DatLoader/FileTypes/CombatManeuverTable.cs
 */
export class CombatManeuverTable {
  id: number = 0;
  maneuvers: CombatManeuver[] = [];

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // List<CombatManeuver>.Unpack = uint32 count + items
    const count = reader.readUInt32();
    for (let i = 0; i < count; i++) {
      this.maneuvers.push({
        style: reader.readUInt32(),
        attackHeight: reader.readUInt32(),
        attackType: reader.readUInt32(),
        minSkillLevel: reader.readUInt32(),
        motion: reader.readUInt32(),
      });
    }
  }
}
