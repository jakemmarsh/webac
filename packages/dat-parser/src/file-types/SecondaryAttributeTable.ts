import { DatReader } from '../DatReader.js';
import type { SkillFormula } from './SkillTable.js';

function readSkillFormula(reader: DatReader): SkillFormula {
  return {
    w: reader.readUInt32(),
    x: reader.readUInt32(),
    y: reader.readUInt32(),
    z: reader.readUInt32(),
    attr1: reader.readUInt32(),
    attr2: reader.readUInt32(),
  };
}

/**
 * SecondaryAttributeTable — health/stamina/mana formulas from portal.dat (0x0E000003)
 * Reference: ACE.DatLoader/FileTypes/SecondaryAttributeTable.cs (Attribute2ndTable)
 */
export class SecondaryAttributeTable {
  id: number = 0;
  maxHealth: SkillFormula;
  maxStamina: SkillFormula;
  maxMana: SkillFormula;

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.maxHealth = readSkillFormula(reader);
    this.maxStamina = readSkillFormula(reader);
    this.maxMana = readSkillFormula(reader);
  }
}
