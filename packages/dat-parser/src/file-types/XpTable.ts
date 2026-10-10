import { DatReader } from '../DatReader.js';

/**
 * XpTable — XP thresholds for levels, skills, attributes from portal.dat (0x0E000018)
 * Reference: ACE.DatLoader/FileTypes/XpTable.cs
 */
export class XpTable {
  id: number = 0;
  attributeXpList: number[] = [];
  vitalXpList: number[] = [];
  trainedSkillXpList: number[] = [];
  specializedSkillXpList: number[] = [];
  characterLevelXpList: bigint[] = [];
  characterLevelSkillCreditList: number[] = [];

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    const attributeCount = reader.readInt32();
    const vitalCount = reader.readInt32();
    const trainedSkillCount = reader.readInt32();
    const specializedSkillCount = reader.readInt32();
    const levelCount = reader.readUInt32();

    // Attribute XP costs (0 to attributeCount inclusive)
    for (let i = 0; i <= attributeCount; i++) {
      this.attributeXpList.push(reader.readUInt32());
    }

    // Vital XP costs
    for (let i = 0; i <= vitalCount; i++) {
      this.vitalXpList.push(reader.readUInt32());
    }

    // Trained skill XP costs
    for (let i = 0; i <= trainedSkillCount; i++) {
      this.trainedSkillXpList.push(reader.readUInt32());
    }

    // Specialized skill XP costs
    for (let i = 0; i <= specializedSkillCount; i++) {
      this.specializedSkillXpList.push(reader.readUInt32());
    }

    // Character level XP thresholds (uint64)
    for (let i = 0; i <= levelCount; i++) {
      const low = reader.readUInt32();
      const high = reader.readUInt32();
      this.characterLevelXpList.push(BigInt(high) * BigInt(0x100000000) + BigInt(low));
    }

    // Skill credits per level
    for (let i = 0; i <= levelCount; i++) {
      this.characterLevelSkillCreditList.push(reader.readUInt32());
    }
  }
}
