/**
 * PublicUpdateProperty* handlers audit (FAITHFUL.158).
 *
 * Sister bug to FAITHFUL.157. Before this iteration, the only PublicUpdate
 * variant the client handled was PublicUpdatePropertyInt — the 5 others
 * (Int64, Bool, Float, String, DataID) fell through to `logUnhandled`
 * meaning ANY server-broadcast property update for visible NPCs, monsters,
 * or other players was silently dropped.
 *
 * Real-world impact: another player levels up (TotalXP int64 change),
 * an NPC enters combat (CombatMode int change visible publicly — already
 * handled), an item gets renamed (String change for items in inventory's
 * server-side view), an NPC gets a buff (Bool / Float changes for
 * enchantment effects). Pre-FAITHFUL.158 the client just stopped tracking
 * the change.
 *
 * Same wire-format trap as SetStackSize: 1-byte ByteSequence for the
 * sequence field, NOT a uint32.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_DIR = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages');
const aceFile = (name: string) => resolve(ACE_DIR, name);

describe('Opcode numeric pinning', () => {
  it('matches ACE numeric assignments (sniffable from retail pcaps)', () => {
    expect(GameMessageOpcode.PublicUpdatePropertyInt).toBe(0x02CE);
    expect(GameMessageOpcode.PublicUpdatePropertyInt64).toBe(0x02D0);
    expect(GameMessageOpcode.PublicUpdatePropertyBool).toBe(0x02D2);
    expect(GameMessageOpcode.PublicUpdatePropertyFloat).toBe(0x02D4);
    expect(GameMessageOpcode.PublicUpdatePropertyString).toBe(0x02D6);
    expect(GameMessageOpcode.PublicUpdatePropertyDataID).toBe(0x02D8);
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePublicUpdatePropertyInt64.cs')))('ACE Int64 wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessagePublicUpdatePropertyInt64.cs'), 'utf8');
  });
  it('writes seq + guid + property + int64 value', () => {
    expect(src).toMatch(/GetNextSequence\(SequenceType\.UpdatePropertyInt64/);
    expect(src).toMatch(/WriteGuid\(worldObject\.Guid\)/);
    expect(src).toMatch(/Writer\.Write\(\(uint\)property\)/);
    expect(src).toMatch(/Writer\.Write\(value\)/);  // long → 8 bytes
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePublicUpdatePropertyBool.cs')))('ACE Bool wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessagePublicUpdatePropertyBool.cs'), 'utf8');
  });
  it('writes seq + guid + property + value (Convert.ToUInt32)', () => {
    expect(src).toMatch(/GetNextSequence\(SequenceType\.UpdatePropertyBool/);
    expect(src).toMatch(/Convert\.ToUInt32\(value\)/);  // bool serialized as u32 0/1
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePublicUpdatePropertyFloat.cs')))('ACE Float wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessagePublicUpdatePropertyFloat.cs'), 'utf8');
  });
  it('writes seq + guid + property + double', () => {
    expect(src).toMatch(/GetNextSequence\(SequenceType\.UpdatePropertyDouble/);
    expect(src).toMatch(/public.*double value/);  // double = 8 bytes
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePublicUpdatePropertyString.cs')))('ACE String wire format (DIFFERENT field order)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessagePublicUpdatePropertyString.cs'), 'utf8');
  });
  it('writes seq, then property, THEN guid (different order!), then Align + WriteString16L', () => {
    // Pin the ordering: Write((uint)property) appears BEFORE WriteGuid in the source.
    const propPos = src.search(/Writer\.Write\(\(uint\)property\)/);
    const guidPos = src.search(/Writer\.WriteGuid\(worldObject\.Guid\)/);
    const alignPos = src.search(/Writer\.Align\(\)/);
    const strPos = src.search(/Writer\.WriteString16L/);
    expect(propPos).toBeGreaterThan(0);
    expect(guidPos).toBeGreaterThan(propPos);  // property BEFORE guid
    expect(alignPos).toBeGreaterThan(guidPos); // align AFTER guid
    expect(strPos).toBeGreaterThan(alignPos);  // string AFTER align
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePublicUpdateDataID.cs')))('ACE DataID wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(aceFile('GameMessagePublicUpdateDataID.cs'), 'utf8');
  });
  it('writes seq + guid + property + value(uint)', () => {
    expect(src).toMatch(/GetNextSequence\(SequenceType\.UpdatePropertyDataID/);
    expect(src).toMatch(/Writer\.WriteGuid\(worldObject\.Guid\)/);
    expect(src).toMatch(/Writer\.Write\(\(uint\)property\)/);
  });
});

describe('Round-trip parses (FAITHFUL.158)', () => {
  it('Int64: seq + guid + property + int64 = 17 bytes', () => {
    const buf = new Uint8Array(17);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x7F);
    dv.setUint32(1, 0xA0B0C0D0, true);   // guid
    dv.setUint32(5, 25,         true);   // property (e.g. TotalExperience)
    dv.setBigInt64(9, 1234567890123n, true); // value
    const r = new BinaryReader(buf);
    expect(r.readUInt8()).toBe(0x7F);
    expect(r.readUInt32()).toBe(0xA0B0C0D0);
    expect(r.readUInt32()).toBe(25);
    expect(r.readInt64()).toBe(1234567890123n);
  });

  it('Bool: 13 bytes', () => {
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x10);
    dv.setUint32(1, 0xAABBCCDD, true);
    dv.setUint32(5, 1, true);   // property (e.g. IsAdmin)
    dv.setUint32(9, 1, true);   // value=true
    const r = new BinaryReader(buf);
    expect(r.readUInt8()).toBe(0x10);
    expect(r.readUInt32()).toBe(0xAABBCCDD);
    expect(r.readUInt32()).toBe(1);
    expect(r.readUInt32() !== 0).toBe(true);
  });

  it('Float: seq + guid + property + double = 17 bytes', () => {
    const buf = new Uint8Array(17);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x20);
    dv.setUint32(1, 0x11223344, true);
    dv.setUint32(5, 100, true);
    dv.setFloat64(9, 3.14159, true);
    const r = new BinaryReader(buf);
    expect(r.readUInt8()).toBe(0x20);
    expect(r.readUInt32()).toBe(0x11223344);
    expect(r.readUInt32()).toBe(100);
    expect(r.readFloat64()).toBeCloseTo(3.14159, 5);
  });
});

describe('Integration (FAITHFUL.158, behavioural — real ServerMessageHandler)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatch(opcode: GameMessageOpcode, payload: Uint8Array): Array<[string, any]> {
    const h = new ServerMessageHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got: Array<[string, any]> = [];
    h.setHandlers({
      onPublicUpdatePropertyInt64: (d) => { got.push(['Int64', d]); },
      onPublicUpdatePropertyBool: (d) => { got.push(['Bool', d]); },
      onPublicUpdatePropertyFloat: (d) => { got.push(['Float', d]); },
      onPublicUpdatePropertyString: (d) => { got.push(['String', d]); },
      onPublicUpdatePropertyDataID: (d) => { got.push(['DataID', d]); },
    });
    h.handleMessage({ type: 'direct', opcode, payload });
    return got;
  }
  // seq(u8) + guid(u32) + key(u32) + value(size bytes)
  function header(size: number, guid: number, key: number): { buf: Uint8Array; dv: DataView } {
    const buf = new Uint8Array(9 + size);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x42);
    dv.setUint32(1, guid, true);
    dv.setUint32(5, key, true);
    return { buf, dv };
  }

  it('PublicUpdatePropertyInt64 → onPublicUpdatePropertyInt64 { guid, key, value }', () => {
    const { buf, dv } = header(8, 0x50000001, 1);
    dv.setBigInt64(9, 123456789012n, true);
    const got = dispatch(GameMessageOpcode.PublicUpdatePropertyInt64, buf);
    expect(got.length).toBe(1);
    expect(got[0][0]).toBe('Int64');
    expect(got[0][1].guid).toBe(0x50000001);
    expect(got[0][1].key).toBe(1);
    expect(Number(got[0][1].value)).toBe(123456789012);
  });

  it('PublicUpdatePropertyBool → onPublicUpdatePropertyBool (u32 != 0)', () => {
    const { buf, dv } = header(4, 0x50000002, 2);
    dv.setUint32(9, 1, true);
    expect(dispatch(GameMessageOpcode.PublicUpdatePropertyBool, buf)).toEqual([['Bool', { guid: 0x50000002, key: 2, value: true }]]);
  });

  it('PublicUpdatePropertyFloat → onPublicUpdatePropertyFloat (f64)', () => {
    const { buf, dv } = header(8, 0x50000003, 3);
    dv.setFloat64(9, 3.14159, true);
    const got = dispatch(GameMessageOpcode.PublicUpdatePropertyFloat, buf);
    expect(got[0][0]).toBe('Float');
    expect(got[0][1]).toMatchObject({ guid: 0x50000003, key: 3 });
    expect(got[0][1].value).toBeCloseTo(3.14159, 5);
  });

  it('PublicUpdatePropertyDataID → onPublicUpdatePropertyDataID', () => {
    const { buf, dv } = header(4, 0x50000004, 4);
    dv.setUint32(9, 0x06001234, true);
    expect(dispatch(GameMessageOpcode.PublicUpdatePropertyDataID, buf)).toEqual([['DataID', { guid: 0x50000004, key: 4, value: 0x06001234 }]]);
  });

  it('PublicUpdatePropertyString reads property BEFORE guid, then aligns to 4 before the String16L (ACE Writer.Align())', () => {
    // seq(1) key(4) guid(4) → pos 9 → align pad to 12 → u16 len + bytes (+pad).
    const text = 'Hello';
    const buf = new Uint8Array(12 + 2 + text.length + 1);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x01);
    dv.setUint32(1, 16, true);          // PropertyString key FIRST
    dv.setUint32(5, 0x50000005, true);  // then guid
    buf.fill(0xEE, 9, 12);              // alignment padding (must be skipped)
    dv.setUint16(12, text.length, true);
    for (let i = 0; i < text.length; i++) buf[14 + i] = text.charCodeAt(i);
    expect(dispatch(GameMessageOpcode.PublicUpdatePropertyString, buf)).toEqual([['String', { guid: 0x50000005, key: 16, value: 'Hello' }]]);
  });
});
