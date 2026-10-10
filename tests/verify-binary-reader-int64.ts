/**
 * BinaryReader.readInt64 contract test.
 *
 * FAITHFUL.150 added `readInt64(): bigint` to deduplicate the lo+hi
 * Int64 assembly pattern that appeared in three places. ACE writes int64
 * wire fields via `BinaryWriter.Write(long)` (native LE 64-bit), e.g.
 * PrivateUpdatePropertyInt64 + the PropertiesInt64 hash table in
 * PlayerDescription. This test verifies:
 *  1. readInt64 returns mathematically identical values to the old
 *     lo + hi assembly for the full signed-int64 range.
 *  2. Pointer advances 8 bytes.
 *  3. Endianness is little-endian (ACE wire format).
 *  4. Negative values + boundary values (Int64.MAX, Int64.MIN) work.
 *  5. All three former call sites now use readInt64.
 */
import { describe, it, expect, vi } from 'vitest';
import { BinaryReader, GameEventType, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler, type IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser.js';

function packLoHi(lo: number, hi: number): Uint8Array {
  // Little-endian: lo bytes first (4 bytes), then hi bytes (4 bytes).
  const buf = new Uint8Array(8);
  const v = new DataView(buf.buffer);
  v.setUint32(0, lo >>> 0, true);
  v.setInt32(4, hi | 0, true);
  return buf;
}

describe('BinaryReader.readInt64', () => {
  it('reads zero', () => {
    const r = new BinaryReader(packLoHi(0, 0));
    expect(r.readInt64()).toBe(0n);
    expect(r.position).toBe(8);
  });

  it('reads positive small value', () => {
    const r = new BinaryReader(packLoHi(42, 0));
    expect(r.readInt64()).toBe(42n);
  });

  it('reads positive value with hi word set', () => {
    // 5 * 2^32 + 100
    const r = new BinaryReader(packLoHi(100, 5));
    expect(r.readInt64()).toBe(5n * (1n << 32n) + 100n);
  });

  it('reads negative value', () => {
    // -1 = all-ones (lo=0xFFFFFFFF, hi=-1 i32)
    const r = new BinaryReader(packLoHi(0xFFFFFFFF, -1));
    expect(r.readInt64()).toBe(-1n);
  });

  it('reads Int64.MAX (0x7FFFFFFFFFFFFFFF)', () => {
    const r = new BinaryReader(packLoHi(0xFFFFFFFF, 0x7FFFFFFF));
    expect(r.readInt64()).toBe((1n << 63n) - 1n);
  });

  it('reads Int64.MIN (0x8000000000000000)', () => {
    const r = new BinaryReader(packLoHi(0, -0x80000000));
    expect(r.readInt64()).toBe(-(1n << 63n));
  });

  it('matches the old lo+hi assembly formula', () => {
    // Randomized fuzzing over several non-trivial values.
    const cases: [number, number][] = [
      [0x12345678, 0],
      [0xDEADBEEF, 0x12345678],
      [0xFFFFFFFF, 0],
      [0, 0x12345678],
      [0xFFFFFFFF, -1],
      [0xCAFEBABE | 0, 0xFEDCBA98 | 0],
    ];
    for (const [lo, hi] of cases) {
      const oldFormula = BigInt(hi) * (1n << 32n) + BigInt(lo >>> 0);
      const r = new BinaryReader(packLoHi(lo, hi));
      expect(r.readInt64()).toBe(oldFormula);
    }
  });

  it('advances pointer 8 bytes per call (sequential reads)', () => {
    const buf = new Uint8Array(24);
    const v = new DataView(buf.buffer);
    v.setBigInt64(0,  1n, true);
    v.setBigInt64(8, -2n, true);
    v.setBigInt64(16, 3000000000000n, true);
    const r = new BinaryReader(buf);
    expect(r.readInt64()).toBe(1n);
    expect(r.readInt64()).toBe(-2n);
    expect(r.readInt64()).toBe(3000000000000n);
    expect(r.position).toBe(24);
  });
});

// Values that the pre-FAITHFUL.150 `BigInt(hi) * 0x100000000 + lo` assembly
// got wrong when lo's high bit was set / hi was negative, plus the extremes.
const HARD_VALUES: bigint[] = [-(1n << 63n), (1n << 63n) - 1n, -1n, 0xCAFEBABEn, -5000000000n, 191226310247n];

function bytes(write: (v: DataView) => number, size = 256): Uint8Array {
  const buf = new Uint8Array(size);
  const n = write(new DataView(buf.buffer));
  return buf.slice(0, n);
}

describe('integration: the Int64 wire sites decode full 64-bit values (FAITHFUL.150, behavioural)', () => {
  it('PrivateUpdatePropertyInt64 (seq u8, key u32, value i64) delivers the exact bigint', () => {
    for (const value of HARD_VALUES) {
      const got: Array<{ key: number; value: bigint }> = [];
      const h = new ServerMessageHandler();
      h.setHandlers({ onPrivateUpdatePropertyInt64: (d: { key: number; value: bigint }) => { got.push(d); } } as never);
      h.handleMessage({
        type: 'direct', opcode: GameMessageOpcode.PrivateUpdatePropertyInt64,
        payload: bytes((v) => { v.setUint8(0, 7); v.setUint32(1, 2, true); v.setBigInt64(5, value, true); return 13; }),
      });
      expect(got).toEqual([{ guid: 0, key: 2, value }]);
    }
  });

  it('IdentifyObjectResponse Int64StatsTable (flag 0x2000) delivers exact bigints', () => {
    const got: IdentifyResponseData[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onIdentifyResponse: (d: IdentifyResponseData) => { got.push(d); } } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.handleMessage({
        type: 'event', opcode: GameMessageOpcode.GameEvent, objectGuid: 0, sequence: 0,
        eventType: GameEventType.IdentifyObjectResponse,
        payload: bytes((v) => {
          let o = 0;
          v.setUint32(o, 0x80001234, true); o += 4;       // guid
          v.setUint32(o, 0x2000, true); o += 4;           // flags: Int64StatsTable
          v.setUint32(o, 1, true); o += 4;                // success
          v.setUint16(o, HARD_VALUES.length, true); o += 2; v.setUint16(o, 8, true); o += 2;
          HARD_VALUES.forEach((val, i) => { v.setUint32(o, 100 + i, true); o += 4; v.setBigInt64(o, val, true); o += 8; });
          return o;
        }, 512),
      });
    } finally { warn.mockRestore(); }
    expect(got.length).toBe(1);
    expect([...got[0].propertiesInt64!.entries()]).toEqual(HARD_VALUES.map((val, i) => [100 + i, val]));
  });

  it('PlayerDescription Int64 hash table (property flag 0x80) delivers exact bigints', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let result;
    try {
      result = parsePlayerDescription(bytes((v) => {
        let o = 0;
        v.setUint32(o, 0x80, true); o += 4;               // propertyFlags: Int64 only
        v.setUint32(o, 0, true); o += 4;                  // weenieType
        v.setUint16(o, HARD_VALUES.length, true); o += 2; v.setUint16(o, 8, true); o += 2;
        HARD_VALUES.forEach((val, i) => { v.setUint32(o, 200 + i, true); o += 4; v.setBigInt64(o, val, true); o += 8; });
        return o; // truncated after the table — the parser returns the partial result
      }, 512));
    } finally { warn.mockRestore(); }
    expect(result).not.toBeNull();
    expect([...result!.propertiesInt64.entries()]).toEqual(HARD_VALUES.map((val, i) => [200 + i, val]));
  });
});
