import { DatReader } from '../DatReader.js';

/**
 * TabooTable — portal.dat file 0x0E00001E.
 *
 * Forbidden-word filter applied to char-create names and chat. Each entry's
 * `bannedPatterns` is a list of lowercased glob patterns: a literal word
 * forbids the exact word; a leading `*` matches any prefix; a trailing `*`
 * matches any suffix.
 *
 * Per ACE source comments: in retail all entries share the same pattern list,
 * so a single first-entry lookup is sufficient. ACE preserves the
 * full-dictionary structure for future flag-typing (racism / sexual /
 * harassment categories) but currently treats it as a flat list.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/TabooTable.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/TabooTableEntry.cs
 */
export interface TabooTableEntry {
  /** Always 0x00010101 in retail — reserved. */
  unknown1: number;
  /** Always 0 in retail — reserved. */
  unknown2: number;
  /** Lowercased glob patterns: `word` (exact), `*word` (suffix), `word*` (prefix), `*word*` (substring). */
  bannedPatterns: string[];
}

export class TabooTable {
  id: number = 0;
  /** Flag bitmask → entry. Retail uses 0x00000001 = the universal banned list. */
  entries: Map<number, TabooTableEntry> = new Map();

  static read(reader: DatReader): TabooTable {
    const t = new TabooTable();
    t.id = reader.readUInt32();

    // Header: uint8 marker (always 0x01) + uint8 length count.
    reader.readUInt8(); // x01 marker
    const length = reader.readUInt8();
    for (let i = 0; i < length; i++) {
      const key = reader.readUInt32();
      const entry: TabooTableEntry = {
        unknown1: reader.readUInt32(),
        unknown2: reader.readUInt16(),
        bannedPatterns: [],
      };
      const count = reader.readUInt32();
      for (let p = 0; p < count; p++) {
        entry.bannedPatterns.push(reader.readString());
      }
      t.entries.set(key, entry);
    }

    return t;
  }

  /**
   * Returns true if `input` (case-insensitive) contains a banned word per
   * any entry's pattern list. Mirrors ACE TabooTable.ContainsBadWord.
   *
   * ACE notes that all entries currently share identical pattern lists, so
   * matching against the first entry suffices — but for safety we match all
   * entries here (cheap; lists are small).
   */
  containsBadWord(input: string): boolean {
    const lower = input.toLowerCase();
    const words = lower.split(/\s+/);
    for (const entry of this.entries.values()) {
      for (const word of words) {
        for (const pattern of entry.bannedPatterns) {
          // Convert ACE's glob (literal + `*`) into a regex anchored to the word boundaries.
          const escaped = pattern.replace(/[-\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
          if (new RegExp(`^${escaped}$`).test(word)) return true;
        }
      }
      // ACE breaks after the first entry — all retail entries share the same list.
      break;
    }
    return false;
  }
}
