/**
 * FAITHFUL.211 — LanguageInfo (0x41000000) + DbProperty (0x78) parsers.
 *
 * Closes the last 2 hook-flagged unimplemented DAT file-type parsers:
 *
 *   LanguageInfo (0x41000000) — locale-specific number formatting, plural
 *   rules, treasure-name letter pools, IME UI styling. ~40 fields. Stored
 *   in client_local_English.dat.
 *
 *   DbProperty (0x78) — generic property-bag entries (window-opacity et al
 *   per ACE retrospectives). BaseProperty dispatch depends on the
 *   MasterProperty type table loaded via setMasterPropertyTypes().
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/LanguageInfo.cs
 *            reference/ACE/Source/ACE.DatLoader/FileTypes/DbProperty.cs
 *            reference/ACE/Source/ACE.DatLoader/Entity/BaseProperty.cs
 */
import { describe, it, expect } from 'vitest';
import { LanguageInfo, DbProperty } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { setMasterPropertyTypes, BasePropertyType } from '@ac/dat-parser/file-types/LayoutDesc.js';

describe('LanguageInfo — locale-formatting parser', () => {
  function buildLanguageInfoDat(): ArrayBuffer {
    const buf = new ArrayBuffer(512);
    const v = new DataView(buf);
    let off = 0;
    // version int32 + base int16 + numDecimalDigits int16 + leadingZero bool
    v.setInt32(off, 1, true); off += 4;
    v.setInt16(off, 10, true); off += 2; // base 10
    v.setInt16(off, 2, true); off += 2; // 2 decimal digits
    v.setUint8(off++, 1); // leadingZero = true
    v.setInt16(off, 3, true); off += 2; // groupingSize = 3

    // 5× char lists — each: uint8 count + N × uint16 codepoints
    // Numerals: '0','1','2'
    v.setUint8(off++, 3);
    v.setUint16(off, 0x30, true); off += 2;
    v.setUint16(off, 0x31, true); off += 2;
    v.setUint16(off, 0x32, true); off += 2;
    // DecimalSeparator: '.'
    v.setUint8(off++, 1); v.setUint16(off, 0x2e, true); off += 2;
    // GroupingSeparator: ','
    v.setUint8(off++, 1); v.setUint16(off, 0x2c, true); off += 2;
    // NegativeNumberFormat: '-'
    v.setUint8(off++, 1); v.setUint16(off, 0x2d, true); off += 2;
    // 5× bool singular flags
    v.setUint8(off++, 0); v.setUint8(off++, 1); v.setUint8(off++, 0);
    v.setUint8(off++, 0); v.setUint8(off++, 0);
    while (off % 4 !== 0) v.setUint8(off++, 0); // align

    // 5× treasure / player letter lists (each empty for brevity)
    for (let i = 0; i < 5; i++) v.setUint8(off++, 0);

    v.setUint32(off, 0, true); off += 4; // imeEnabledSetting

    // 15× uint32 IME/symbol params
    for (let i = 0; i < 15; i++) { v.setUint32(off, 0, true); off += 4; }
    v.setUint32(off, 0, true); off += 4; // otherIme
    v.setInt32(off, 1, true); off += 4; // wordWrapOnSpace

    v.setUint8(off++, 0); // additionalSettings empty
    v.setUint32(off, 0, true); off += 4; // additionalFlags

    return buf.slice(0, off);
  }

  it('decodes locale-formatting fields and char-list arrays', () => {
    const buf = buildLanguageInfoDat();
    const t = LanguageInfo.read(new DatReader(buf));
    expect(t.version).toBe(1);
    expect(t.base).toBe(10);
    expect(t.numDecimalDigits).toBe(2);
    expect(t.leadingZero).toBe(true);
    expect(t.groupingSize).toBe(3);
    expect(t.numerals).toEqual(['0', '1', '2']);
    expect(t.decimalSeparator).toEqual(['.']);
    expect(t.groupingSeparator).toEqual([',']);
    expect(t.negativeNumberFormat).toEqual(['-']);
    expect(t.isOneSingular).toBe(true);
    expect(t.isZeroSingular).toBe(false);
  });
});

describe('DbProperty — generic property-bag parser', () => {
  function buildDbPropertyDat(): ArrayBuffer {
    const buf = new ArrayBuffer(128);
    const v = new DataView(buf);
    let off = 0;
    v.setUint32(off, 0x78000001, true); off += 4; // id
    v.setUint8(off++, 0); // bucketSize
    v.setUint8(off++, 2); // 2 properties

    // Property 1: id=0x100, type=Integer, value=42
    v.setUint32(off, 0x100, true); off += 4; // key
    v.setUint32(off, 0x100, true); off += 4; // BaseProperty.Id
    v.setInt32(off, 42, true); off += 4; // int value

    // Property 2: id=0x200, type=Bool, value=true
    v.setUint32(off, 0x200, true); off += 4; // key
    v.setUint32(off, 0x200, true); off += 4; // BaseProperty.Id
    v.setUint8(off++, 1); // bool

    return buf.slice(0, off);
  }

  it('decodes id + N properties when MasterProperty types are set', () => {
    // Set up master property type table before parsing.
    setMasterPropertyTypes(new Map([
      [0x100, BasePropertyType.Integer],
      [0x200, BasePropertyType.Bool],
    ]));
    const buf = buildDbPropertyDat();
    const t = DbProperty.read(new DatReader(buf));
    expect(t.id).toBe(0x78000001);
    expect(t.properties.size).toBe(2);
    expect(t.properties.get(0x100)?.valueInt).toBe(42);
    expect(t.properties.get(0x200)?.valueBool).toBe(true);
  });
});

describe('Module surface', () => {
  it('exposes both classes from @ac/dat-parser', () => {
    expect(typeof LanguageInfo).toBe('function');
    expect(typeof DbProperty).toBe('function');
  });
});
