import { DatReader } from '../DatReader.js';

/**
 * NameFilterTable — portal.dat file 0x0E000020.
 *
 * Per-language character-name validation rules: max-same-char-in-a-row,
 * max-vowels-in-a-row, vowel-prefix-requirement, plus allowed
 * extra-character set and compound-letter groups (e.g. "th", "sh", "ch"
 * are treated as a single letter for vowel/consonant counting).
 *
 * Used by the retail char-create screen to validate names before sending
 * to the server. ACE C# server uses this same DAT entry for canonical
 * validation server-side. Reference:
 *   reference/ACE/Source/ACE.DatLoader/FileTypes/NameFilterTable.cs
 *   reference/ACE/Source/ACE.DatLoader/Entity/NameFilterLanguageData.cs
 */
export interface NameFilterLanguageData {
  maximumSameCharactersInARow: number;
  maximumVowelsInARow: number;
  firstNCharactersMustHaveAVowel: number;
  vowelContainingSubstringLength: number;
  /** Set of characters allowed in addition to the alphanumerics (e.g. apostrophe, hyphen). */
  extraAllowedCharacters: string;
  /** Multi-char digraphs counted as one letter (e.g. "th", "sh"). */
  compoundLetterGroups: string[];
}

export class NameFilterTable {
  id: number = 0;
  /** Language id → rule set. Retail only ships languageId=1 (English). */
  languageData: Map<number, NameFilterLanguageData> = new Map();

  static read(reader: DatReader): NameFilterTable {
    const t = new NameFilterTable();
    t.id = reader.readUInt32();

    // Custom hash-table header (not PackableHashTable): total (uint8), bucket size (uint8).
    const total = reader.readUInt8();
    reader.readUInt8(); // bucket size — unused for in-order iteration
    for (let i = 0; i < total; i++) {
      const key = reader.readUInt32();
      const data: NameFilterLanguageData = {
        maximumSameCharactersInARow: reader.readUInt32(),
        maximumVowelsInARow: reader.readUInt32(),
        firstNCharactersMustHaveAVowel: reader.readUInt32(),
        vowelContainingSubstringLength: reader.readUInt32(),
        extraAllowedCharacters: reader.readUnicodeString(),
        compoundLetterGroups: [],
      };
      const numGroups = reader.readUInt32();
      for (let g = 0; g < numGroups; g++) {
        data.compoundLetterGroups.push(reader.readUnicodeString());
      }
      t.languageData.set(key, data);
    }

    return t;
  }
}
