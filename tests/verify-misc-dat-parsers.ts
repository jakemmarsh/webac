/**
 * FAITHFUL.210 — GfxObjDegradeInfo + LanguageString + ActionMap parsers.
 *
 * Three small DAT file-type parsers covering the remaining unimplemented
 * portal-dat types flagged by the stop hook:
 *   - GfxObjDegradeInfo (0x11) — LOD info per GfxObj
 *   - LanguageString (0x31) — single localizable text string
 *   - ActionMap (0x26) — default keyboard binding map
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/{GfxObjDegradeInfo,LanguageString,ActionMap}.cs
 */
import { describe, it, expect } from 'vitest';
import { GfxObjDegradeInfo, LanguageString, ActionMap } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

describe('GfxObjDegradeInfo — LOD parser', () => {
  it('decodes id + count + N × (id + mode + 3 floats)', () => {
    const buf = new ArrayBuffer(8 + 20 * 2); // 2 entries
    const v = new DataView(buf);
    v.setUint32(0, 0x11000042, true);
    v.setUint32(4, 2, true);
    let off = 8;
    v.setUint32(off, 0x01001234, true); off += 4;
    v.setUint32(off, 0, true); off += 4;
    v.setFloat32(off, 0, true); off += 4;
    v.setFloat32(off, 5, true); off += 4;
    v.setFloat32(off, 10, true); off += 4;
    v.setUint32(off, 0x01005678, true); off += 4;
    v.setUint32(off, 1, true); off += 4;
    v.setFloat32(off, 10, true); off += 4;
    v.setFloat32(off, 50, true); off += 4;
    v.setFloat32(off, 100, true); off += 4;
    const t = GfxObjDegradeInfo.read(new DatReader(buf));
    expect(t.id).toBe(0x11000042);
    expect(t.degrades).toHaveLength(2);
    expect(t.degrades[0].gfxObjId).toBe(0x01001234);
    expect(t.degrades[0].minDist).toBe(0);
    expect(t.degrades[0].maxDist).toBe(10);
    expect(t.degrades[1].gfxObjId).toBe(0x01005678);
    expect(t.degrades[1].idealDist).toBe(50);
  });

  it('pickLOD selects the band containing the camera distance', () => {
    const buf = new ArrayBuffer(8 + 20 * 2);
    const v = new DataView(buf);
    v.setUint32(0, 0x11000042, true); v.setUint32(4, 2, true);
    let off = 8;
    v.setUint32(off, 0x0A, true); v.setUint32(off + 4, 0, true);
    v.setFloat32(off + 8, 0, true); v.setFloat32(off + 12, 5, true); v.setFloat32(off + 16, 10, true);
    off += 20;
    v.setUint32(off, 0x0B, true); v.setUint32(off + 4, 1, true);
    v.setFloat32(off + 8, 10, true); v.setFloat32(off + 12, 50, true); v.setFloat32(off + 16, 100, true);
    const t = GfxObjDegradeInfo.read(new DatReader(buf));
    expect(t.pickLOD(3)?.gfxObjId).toBe(0x0A);
    expect(t.pickLOD(50)?.gfxObjId).toBe(0x0B);
  });
});

describe('LanguageString — single-string parser', () => {
  function buildLanguageString(id: number, text: string): ArrayBuffer {
    const buf = new ArrayBuffer(64);
    const v = new DataView(buf);
    let off = 0;
    v.setUint32(off, id, true); off += 4;
    // CompressedUInt32 length — for small lengths (≤127) this is 1 byte
    const len = text.length;
    if (len < 0x80) {
      v.setUint8(off++, len);
    } else {
      v.setUint8(off++, 0x80 | (len >> 8));
      v.setUint8(off++, len & 0xff);
    }
    for (let i = 0; i < text.length; i++) v.setUint8(off++, text.charCodeAt(i));
    return buf.slice(0, off);
  }

  it('decodes id + compressed-length-prefixed Windows-1252 string', () => {
    const buf = buildLanguageString(0x31000042, 'Hello AC');
    const s = LanguageString.read(new DatReader(buf));
    expect(s.id).toBe(0x31000042);
    expect(s.charBuffer).toBe('Hello AC');
  });

  it('handles empty string (length=0)', () => {
    const buf = buildLanguageString(0x31000099, '');
    const s = LanguageString.read(new DatReader(buf));
    expect(s.id).toBe(0x31000099);
    expect(s.charBuffer).toBe('');
  });
});

describe('ActionMap — keyboard binding parser', () => {
  function buildActionMap(): ArrayBuffer {
    const buf = new ArrayBuffer(256);
    const v = new DataView(buf);
    let off = 0;
    v.setUint32(off, 0x26000000, true); off += 4;
    // inputMaps header: uint8 bucket, uint8 count
    v.setUint8(off++, 0);
    v.setUint8(off++, 1); // 1 input map
    // input map key + sub-header + 1 sub-value
    v.setUint32(off, 1, true); off += 4;
    v.setUint8(off++, 0); v.setUint8(off++, 1);
    v.setUint32(off, 100, true); off += 4; // sub-key (key code)
    // ActionMapValue: byte + uint32 + uint32 + uint32 + UserBindingValue (3× uint32)
    v.setUint8(off++, 0);
    v.setUint32(off, 0, true); off += 4;
    v.setUint32(off, 0, true); off += 4;
    v.setUint32(off, 0, true); off += 4;
    v.setUint32(off, 42, true); off += 4; // actionClass
    v.setUint32(off, 0x12345678, true); off += 4; // actionNameHash
    v.setUint32(off, 0x9ABCDEF0, true); off += 4; // descriptionHash

    // StringTable DataID
    v.setUint32(off, 0x23000005, true); off += 4;

    // conflictingMaps header: 0 entries
    v.setUint8(off++, 0);
    v.setUint8(off++, 0);

    return buf.slice(0, off);
  }

  it('decodes inputMaps + stringTable + conflictingMaps', () => {
    const buf = buildActionMap();
    const m = ActionMap.read(new DatReader(buf));
    expect(m.id).toBe(0x26000000);
    expect(m.inputMaps.size).toBe(1);
    expect(m.stringTable).toBe(0x23000005);
    expect(m.conflictingMaps.size).toBe(0);
    const sub = m.inputMaps.get(1);
    expect(sub).toBeDefined();
    expect(sub!.size).toBe(1);
    const binding = sub!.get(100);
    expect(binding!.userBindingData.actionClass).toBe(42);
    expect(binding!.userBindingData.actionNameHash).toBe(0x12345678);
  });
});

describe('Module surface', () => {
  it('exposes all three classes from @ac/dat-parser', () => {
    expect(typeof GfxObjDegradeInfo).toBe('function');
    expect(typeof LanguageString).toBe('function');
    expect(typeof ActionMap).toBe('function');
  });
});
