/**
 * FAITHFUL.176 — NameFilterTable (0x0E000020) + TabooTable (0x0E00001E) parsers.
 *
 * Both DAT files are used by the retail AC client during char-create to
 * validate a typed character name before sending it to the server:
 *  - NameFilterTable enforces structural rules (max same chars in a row,
 *    max vowels in a row, must-have-vowel-in-first-N-chars, etc.).
 *  - TabooTable enforces a forbidden-word glob pattern list ("badword",
 *    "*badword*", "badprefix*", "*badsuffix").
 *
 * Reference: ACE.DatLoader/FileTypes/NameFilterTable.cs
 *            ACE.DatLoader/FileTypes/TabooTable.cs
 *            ACE.DatLoader/Entity/NameFilterLanguageData.cs
 *            ACE.DatLoader/Entity/TabooTableEntry.cs
 */
import { describe, it, expect } from 'vitest';
import { NameFilterTable, TabooTable } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

/**
 * Build a synthetic NameFilterTable buffer:
 *   id (uint32) + total (uint8) + bucket (uint8)
 *   + N × (key (uint32) + 4×uint32 rule fields
 *           + UnicodeString extra + uint32 groupCount + groupCount × UnicodeString)
 *
 * UnicodeString = compressed-uint32 length (1-3 bytes) + length × uint16 codepoints.
 */
function buildNameFilterDat(id: number, langs: Array<{ key: number; rules: { sameMax: number; vowelMax: number; firstN: number; subLen: number; extra: string; groups: string[] } }>): ArrayBuffer {
  const buf = new ArrayBuffer(4096);
  const view = new DataView(buf);
  let off = 0;

  const writeUnicodeString = (s: string): void => {
    // CompressedUInt32 length — for our small lengths (≤127) this is a single byte
    const len = s.length;
    if (len < 0x80) {
      view.setUint8(off++, len);
    } else if (len < 0x4000) {
      view.setUint8(off++, 0x80 | (len >> 8));
      view.setUint8(off++, len & 0xff);
    } else {
      view.setUint8(off++, 0xc0 | (len >> 24));
      view.setUint8(off++, (len >> 16) & 0xff);
      view.setUint16(off, len & 0xffff, true); off += 2;
    }
    for (let i = 0; i < s.length; i++) {
      view.setUint16(off, s.charCodeAt(i), true);
      off += 2;
    }
  };

  view.setUint32(off, id, true); off += 4;
  view.setUint8(off++, langs.length);
  view.setUint8(off++, 0); // bucket size
  for (const lang of langs) {
    view.setUint32(off, lang.key, true); off += 4;
    view.setUint32(off, lang.rules.sameMax, true); off += 4;
    view.setUint32(off, lang.rules.vowelMax, true); off += 4;
    view.setUint32(off, lang.rules.firstN, true); off += 4;
    view.setUint32(off, lang.rules.subLen, true); off += 4;
    writeUnicodeString(lang.rules.extra);
    view.setUint32(off, lang.rules.groups.length, true); off += 4;
    for (const g of lang.rules.groups) writeUnicodeString(g);
  }
  return buf.slice(0, off);
}

describe('NameFilterTable — binary parser', () => {
  it('decodes id-only with no language entries', () => {
    const buf = new ArrayBuffer(6);
    const view = new DataView(buf);
    view.setUint32(0, 0x0E000020, true);
    view.setUint8(4, 0); // total = 0
    view.setUint8(5, 0); // bucket size
    const t = NameFilterTable.read(new DatReader(buf));
    expect(t.id).toBe(0x0E000020);
    expect(t.languageData.size).toBe(0);
  });

  it('decodes one language (English = key 1) with rules + compound letters', () => {
    const buf = buildNameFilterDat(0x0E000020, [
      {
        key: 1,
        rules: {
          sameMax: 2,
          vowelMax: 3,
          firstN: 4,
          subLen: 5,
          extra: "'-",
          groups: ['th', 'sh', 'ch'],
        },
      },
    ]);
    const t = NameFilterTable.read(new DatReader(buf));
    expect(t.id).toBe(0x0E000020);
    const en = t.languageData.get(1);
    expect(en).toBeDefined();
    expect(en!.maximumSameCharactersInARow).toBe(2);
    expect(en!.maximumVowelsInARow).toBe(3);
    expect(en!.firstNCharactersMustHaveAVowel).toBe(4);
    expect(en!.vowelContainingSubstringLength).toBe(5);
    expect(en!.extraAllowedCharacters).toBe("'-");
    expect(en!.compoundLetterGroups).toEqual(['th', 'sh', 'ch']);
  });
});

/**
 * Build a synthetic TabooTable buffer:
 *   id (uint32) + x01 (uint8 marker) + length (uint8) + N × entry
 *   entry = key (uint32) + unk1 (uint32) + unk2 (uint16)
 *           + patternCount (uint32) + patternCount × 7-bit-LE-length-prefixed string
 */
function buildTabooDat(
  id: number,
  entries: Array<{ key: number; unk1: number; unk2: number; patterns: string[] }>,
): ArrayBuffer {
  const buf = new ArrayBuffer(2048);
  const view = new DataView(buf);
  let off = 0;

  const writeString = (s: string): void => {
    let n = s.length;
    while (n >= 0x80) {
      view.setUint8(off++, (n & 0x7f) | 0x80);
      n >>= 7;
    }
    view.setUint8(off++, n);
    for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i));
  };

  view.setUint32(off, id, true); off += 4;
  view.setUint8(off++, 0x01); // marker
  view.setUint8(off++, entries.length);
  for (const e of entries) {
    view.setUint32(off, e.key, true); off += 4;
    view.setUint32(off, e.unk1, true); off += 4;
    view.setUint16(off, e.unk2, true); off += 2;
    view.setUint32(off, e.patterns.length, true); off += 4;
    for (const p of e.patterns) writeString(p);
  }
  return buf.slice(0, off);
}

describe('TabooTable — binary parser', () => {
  it('decodes an empty taboo table', () => {
    const buf = buildTabooDat(0x0E00001E, []);
    const t = TabooTable.read(new DatReader(buf));
    expect(t.id).toBe(0x0E00001E);
    expect(t.entries.size).toBe(0);
  });

  it('decodes a single entry with multiple banned patterns', () => {
    const buf = buildTabooDat(0x0E00001E, [
      {
        key: 1,
        unk1: 0x00010101,
        unk2: 0,
        patterns: ['fubar', '*ftw', 'bad*'],
      },
    ]);
    const t = TabooTable.read(new DatReader(buf));
    const e = t.entries.get(1);
    expect(e).toBeDefined();
    expect(e!.unknown1).toBe(0x00010101);
    expect(e!.unknown2).toBe(0);
    expect(e!.bannedPatterns).toEqual(['fubar', '*ftw', 'bad*']);
  });
});

describe('TabooTable.containsBadWord — glob matching', () => {
  const buf = buildTabooDat(0x0E00001E, [
    {
      key: 1,
      unk1: 0x00010101,
      unk2: 0,
      patterns: ['fubar', '*ftw', 'bad*', '*foo*'],
    },
  ]);
  const t = TabooTable.read(new DatReader(buf));

  it('matches exact words case-insensitively', () => {
    expect(t.containsBadWord('fubar')).toBe(true);
    expect(t.containsBadWord('FuBaR')).toBe(true);
  });

  it('matches suffix patterns (*ftw)', () => {
    expect(t.containsBadWord('lolftw')).toBe(true);
    expect(t.containsBadWord('ftw')).toBe(true);
  });

  it('matches prefix patterns (bad*)', () => {
    expect(t.containsBadWord('badword')).toBe(true);
    expect(t.containsBadWord('bad')).toBe(true);
  });

  it('matches substring patterns (*foo*)', () => {
    expect(t.containsBadWord('foobar')).toBe(true);
    expect(t.containsBadWord('nicefoo')).toBe(true);
    expect(t.containsBadWord('xfooy')).toBe(true);
  });

  it('does not match unrelated words', () => {
    expect(t.containsBadWord('alice')).toBe(false);
    expect(t.containsBadWord('hello world')).toBe(false);
  });

  it('splits on whitespace and checks each word independently', () => {
    expect(t.containsBadWord('hello fubar world')).toBe(true);
    expect(t.containsBadWord('niceword bad startup')).toBe(true);
  });
});

describe('Char-name filter — module exports', () => {
  it('exposes both classes from @ac/dat-parser', () => {
    expect(typeof NameFilterTable).toBe('function');
    expect(typeof TabooTable).toBe('function');
  });
});
