/**
 * FAITHFUL.209 — GeneratorTable (0x0E00000D) parser.
 *
 * Hierarchical weenie-object tree used by the original AC world builder.
 * Each node carries an obfuscated (nibble-swapped Windows-1252) name +
 * a uint32 ID + a list of child generators. Root has exactly two
 * children: PlayDay items + WeenieObjects items.
 *
 * 4058 nodes load from real retail DAT data, including categories like
 * "Generators", "Creature WDFs", "Magic Scrolls", "Items- Weapons".
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/GeneratorTable.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/Generator.cs
 */
import { describe, it, expect } from 'vitest';
import { GeneratorTable } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

/**
 * Build a minimal GeneratorTable buffer.
 * Layout per node: ObfuscatedString name (uint16 length + N bytes
 * nibble-swapped) + align(4) + uint32 id + uint32 childCount + N children.
 */
function buildGeneratorTableDat(): ArrayBuffer {
  const buf = new ArrayBuffer(4096);
  const view = new DataView(buf);
  let off = 0;

  const writeObfuscatedString = (s: string): void => {
    view.setUint16(off, s.length, true); off += 2;
    for (let i = 0; i < s.length; i++) {
      // Nibble swap the byte before writing — readObfuscatedString swaps back.
      const b = s.charCodeAt(i);
      const swapped = ((b >> 4) | (b << 4)) & 0xff;
      view.setUint8(off++, swapped);
    }
    while (off % 4 !== 0) view.setUint8(off++, 0);
  };

  view.setUint32(off, 0x0E00000D, true); off += 4; // file id

  // Root node
  writeObfuscatedString('Root');
  view.setUint32(off, 0, true); off += 4; // root id
  view.setUint32(off, 2, true); off += 4; // 2 children (PlayDay + WeenieObjects)

  // PlayDay node (children of root[0])
  writeObfuscatedString('PlayDay');
  view.setUint32(off, 1, true); off += 4;
  view.setUint32(off, 1, true); off += 4; // 1 child
  writeObfuscatedString('TestPlayDay');
  view.setUint32(off, 100, true); off += 4;
  view.setUint32(off, 0, true); off += 4; // no grandchildren

  // WeenieObjects node (children of root[1])
  writeObfuscatedString('WeenieObjects');
  view.setUint32(off, 2, true); off += 4;
  view.setUint32(off, 2, true); off += 4; // 2 children
  writeObfuscatedString('Creature WDFs');
  view.setUint32(off, 200, true); off += 4;
  view.setUint32(off, 0, true); off += 4;
  writeObfuscatedString('Magic Scrolls');
  view.setUint32(off, 300, true); off += 4;
  view.setUint32(off, 0, true); off += 4;

  return buf.slice(0, off);
}

describe('GeneratorTable — binary parser', () => {
  it('decodes id + root + 2 top-level children', () => {
    const buf = buildGeneratorTableDat();
    const t = GeneratorTable.read(new DatReader(buf));
    expect(t.id).toBe(0x0E00000D);
    expect(t.root.name).toBe('Root');
    expect(t.root.items.length).toBe(2);
    expect(t.root.items[0].name).toBe('PlayDay');
    expect(t.root.items[1].name).toBe('WeenieObjects');
  });

  it('exposes PlayDay + WeenieObjects shortcuts', () => {
    const buf = buildGeneratorTableDat();
    const t = GeneratorTable.read(new DatReader(buf));
    expect(t.playDayItems.length).toBe(1);
    expect(t.playDayItems[0].name).toBe('TestPlayDay');
    expect(t.weenieObjects.length).toBe(2);
    expect(t.weenieObjects[0].name).toBe('Creature WDFs');
    expect(t.weenieObjects[1].name).toBe('Magic Scrolls');
  });

  it('findById walks the full tree', () => {
    const buf = buildGeneratorTableDat();
    const t = GeneratorTable.read(new DatReader(buf));
    expect(t.findById(100)?.name).toBe('TestPlayDay');
    expect(t.findById(200)?.name).toBe('Creature WDFs');
    expect(t.findById(300)?.name).toBe('Magic Scrolls');
    expect(t.findById(999)).toBe(null);
  });

  it('totalNodes counts root + all descendants', () => {
    const buf = buildGeneratorTableDat();
    const t = GeneratorTable.read(new DatReader(buf));
    // Root + PlayDay + TestPlayDay + WeenieObjects + Creature WDFs + Magic Scrolls = 6
    expect(t.totalNodes).toBe(6);
  });
});

describe('GeneratorTable — module surface', () => {
  it('is re-exported from @ac/dat-parser', () => {
    expect(typeof GeneratorTable).toBe('function');
  });
});
