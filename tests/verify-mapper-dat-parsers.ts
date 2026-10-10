/**
 * FAITHFUL.58 — round-trip tests for EnumMapper / DidMapper / DualDidMapper.
 *
 * Sources:
 *   reference/ACE/Source/ACE.DatLoader/FileTypes/EnumMapper.cs
 *   reference/ACE/Source/ACE.DatLoader/FileTypes/DidMapper.cs
 *   reference/ACE/Source/ACE.DatLoader/FileTypes/DualDidMapper.cs
 *
 * The parsers consume the same wire bytes the AC client reads from
 * portal.dat. These tests synthesize valid byte sequences exercising every
 * field path (CompressedUInt32 boundary cases, PString length-1 encoding,
 * NumberingType byte, both client + server sides) and verify the parser
 * decodes them to the expected Map shapes.
 */
import { describe, it, expect } from 'vitest';
import { DatReader } from '@ac/dat-parser/DatReader';
import {
  NumberingType,
  SEQUENTIAL_NUMBERING,
  readEnumMapper,
} from '@ac/dat-parser/file-types/EnumMapper';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper';
import {
  readDualDidMapper,
  DUAL_DID_MATERIALS,
  DUAL_DID_SPELL_COMPONENTS,
  DUAL_DID_TRADE_NOTES,
} from '@ac/dat-parser/file-types/DualDidMapper';

// ── synthesis helpers ───────────────────────────────────────────

function packCompressedUInt32(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x4000) return new Uint8Array([(n >> 8) | 0x80, n & 0xFF]);
  return new Uint8Array([
    (n >> 24) | 0xC0, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF,
  ]);
}

function packUInt32LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF]);
}

function packPString1(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(1 + b.length);
  out[0] = b.length;
  out.set(b, 1);
  return out;
}

function cat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ── EnumMapper ──────────────────────────────────────────────────

describe('EnumMapper (0x22) wire-format parser', () => {
  it('round-trips a 3-entry mapper with Normal numbering', () => {
    const bytes = cat(
      packUInt32LE(0x22000005),         // Id
      packUInt32LE(0x22000000),         // BaseEnumMap
      new Uint8Array([NumberingType.Normal]),  // NumberingType byte
      packCompressedUInt32(3),          // 3 entries
      packUInt32LE(1), packPString1('Punch'),
      packUInt32LE(2), packPString1('Thrust'),
      packUInt32LE(4), packPString1('Slash'),
    );
    const result = readEnumMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.id).toBe(0x22000005);
    expect(result.baseEnumMap).toBe(0x22000000);
    expect(result.numberingType).toBe(NumberingType.Normal);
    expect(result.idToStringMap.size).toBe(3);
    expect(result.idToStringMap.get(1)).toBe('Punch');
    expect(result.idToStringMap.get(2)).toBe('Thrust');
    expect(result.idToStringMap.get(4)).toBe('Slash');
  });

  it('handles Bitfield numbering type', () => {
    const bytes = cat(
      packUInt32LE(0x22000007),
      packUInt32LE(0),
      new Uint8Array([NumberingType.Bitfield]),
      packCompressedUInt32(2),
      packUInt32LE(0x01), packPString1('FlagA'),
      packUInt32LE(0x02), packPString1('FlagB'),
    );
    const result = readEnumMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.numberingType).toBe(NumberingType.Bitfield);
    expect(result.idToStringMap.get(1)).toBe('FlagA');
    expect(result.idToStringMap.get(2)).toBe('FlagB');
  });

  it('handles empty mapper (numEnums=0)', () => {
    const bytes = cat(
      packUInt32LE(0x22000008),
      packUInt32LE(0),
      new Uint8Array([NumberingType.Undefined]),
      packCompressedUInt32(0),
    );
    const result = readEnumMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.idToStringMap.size).toBe(0);
  });

  it('handles entry count past CompressedUInt32 1-byte boundary (>127)', () => {
    const entryCount = 200;  // forces 2-byte CompressedUInt32 encoding
    const parts: Uint8Array[] = [
      packUInt32LE(0x22000009),
      packUInt32LE(0),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(entryCount),
    ];
    for (let i = 0; i < entryCount; i++) {
      parts.push(packUInt32LE(i), packPString1(`item${i}`));
    }
    const combined = cat(...parts);
    const result = readEnumMapper(new DatReader(combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength) as ArrayBuffer));
    expect(result.idToStringMap.size).toBe(entryCount);
    expect(result.idToStringMap.get(0)).toBe('item0');
    expect(result.idToStringMap.get(199)).toBe('item199');
  });
});

// ── DidMapper ────────────────────────────────────────────────────

describe('DidMapper (0x25) wire-format parser', () => {
  it('round-trips a mapper with distinct client+server tables', () => {
    const bytes = cat(
      packUInt32LE(0x25000000),  // Id
      // client side
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(2),
      packUInt32LE(1), packUInt32LE(0x06000001),
      packUInt32LE(2), packUInt32LE(0x06000002),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(2),
      packUInt32LE(1), packPString1('IconUI'),
      packUInt32LE(2), packPString1('IconSpell'),
      // server side
      new Uint8Array([SEQUENTIAL_NUMBERING]),
      packCompressedUInt32(1),
      packUInt32LE(10), packUInt32LE(0xFFFF0010),
      new Uint8Array([SEQUENTIAL_NUMBERING]),
      packCompressedUInt32(1),
      packUInt32LE(10), packPString1('ServerEnumA'),
    );
    const result = readDidMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.id).toBe(0x25000000);

    // Client side
    expect(result.client.idNumberingType).toBe(NumberingType.Normal);
    expect(result.client.enumToId.size).toBe(2);
    expect(result.client.enumToId.get(1)).toBe(0x06000001);
    expect(result.client.enumToName.size).toBe(2);
    expect(result.client.enumToName.get(1)).toBe('IconUI');
    expect(result.client.enumToName.get(2)).toBe('IconSpell');

    // Server side
    expect(result.server.enumToId.size).toBe(1);
    expect(result.server.enumToId.get(10)).toBe(0xFFFF0010);
    expect(result.server.enumToName.get(10)).toBe('ServerEnumA');
  });

  it('handles asymmetric counts: server has more entries than client', () => {
    const bytes = cat(
      packUInt32LE(0x25000001),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(1),
      packUInt32LE(0), packUInt32LE(0xAAAA0000),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(1),
      packUInt32LE(0), packPString1('one'),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(3),
      packUInt32LE(0), packUInt32LE(0xBBBB0000),
      packUInt32LE(1), packUInt32LE(0xBBBB0001),
      packUInt32LE(2), packUInt32LE(0xBBBB0002),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(3),
      packUInt32LE(0), packPString1('alpha'),
      packUInt32LE(1), packPString1('beta'),
      packUInt32LE(2), packPString1('gamma'),
    );
    const result = readDidMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.client.enumToId.size).toBe(1);
    expect(result.server.enumToId.size).toBe(3);
    expect(result.server.enumToName.get(2)).toBe('gamma');
  });
});

// ── DualDidMapper ────────────────────────────────────────────────

describe('DualDidMapper (0x27) wire-format parser', () => {
  it('Materials mapper (0x27000000): weenie IDs → material category IDs', () => {
    const bytes = cat(
      packUInt32LE(DUAL_DID_MATERIALS),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(2),
      packUInt32LE(20100), packUInt32LE(56),  // wcid → materialId
      packUInt32LE(20101), packUInt32LE(57),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(2),
      packUInt32LE(56), packPString1('Iron'),
      packUInt32LE(57), packPString1('Steel'),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(0),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(0),
    );
    const result = readDualDidMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.id).toBe(0x27000000);
    expect(result.client.enumToId.get(20100)).toBe(56);
    expect(result.client.enumToName.get(56)).toBe('Iron');
    expect(result.client.enumToName.get(57)).toBe('Steel');
  });

  it('SpellComponents mapper (0x27000002): tracks spell-component WCIDs', () => {
    const bytes = cat(
      packUInt32LE(DUAL_DID_SPELL_COMPONENTS),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(1),
      packUInt32LE(694), packUInt32LE(34000),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(1),
      packUInt32LE(694), packPString1('Lead Scarab'),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(0),
      new Uint8Array([NumberingType.Normal]),
      packCompressedUInt32(0),
    );
    const result = readDualDidMapper(new DatReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(result.id).toBe(DUAL_DID_SPELL_COMPONENTS);
    expect(result.client.enumToName.get(694)).toBe('Lead Scarab');
  });

  it('Well-known ID constants match ACE docstring', () => {
    expect(DUAL_DID_MATERIALS).toBe(0x27000000);
    expect(DUAL_DID_SPELL_COMPONENTS).toBe(0x27000002);
    expect(DUAL_DID_TRADE_NOTES).toBe(0x27000004);
  });
});
