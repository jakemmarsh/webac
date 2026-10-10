/**
 * RECON.wire-full-consumption — GameEvent parsers consume their whole payload.
 *
 * ACE GameEventFellowshipFullUpdate.cs:40-42 writes DepartedMembers
 * (FellowshipExtensions.Write: PackableHashTable header, then guid u32 +
 * timestamp i32, Fellowship.cs:785) and FellowshipLocks
 * (FellowshipLockDataExtensions.Write: u16 count, u16 buckets 32, then
 * String16L name + five u32s) after isLocked. Our parser used to stop at
 * isLocked and drop both tables. Retail Fellowship::UnPack @ 005b94f0 reads
 * through _fellows_departed (PackableHashTable<ulong,long>), and
 * CM_Fellowship::DispatchUI_FullUpdate @ 006a68a0 applies the fellowship even
 * when UnPack fails, so a short tail must still yield the roster.
 *
 * The inventory below is the checked per-event list: every entry drives the
 * REAL parser over an ACE-shaped payload and asserts nothing is left unread
 * (tests/_harness/wire-consumption.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseFellowshipFullUpdate, parseFellowshipUpdateFellow } from '@ac/network';
import { probeConsumption } from './_harness/wire-consumption.js';

class Writer {
  private bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32(v: number) { this.u16(v); this.u16(v >>> 16); }
  // ACE Extensions.cs WriteString16L: u16 length + bytes + pad (2+len) to 4.
  s16L(s: string) {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    for (let i = (2 + s.length) % 4; i !== 0 && i < 4; i++) this.u8(0);
  }
  build(): Uint8Array { return new Uint8Array(this.bytes); }
}

function writeFellow(w: Writer, guid: number, name: string, shareLoot = 0x10) {
  w.u32(guid); w.u32(0); w.u32(0); w.u32(50);
  w.u32(100); w.u32(90); w.u32(80); w.u32(99); w.u32(89); w.u32(79);
  w.u32(shareLoot);
  w.s16L(name);
}

interface Tail {
  departed?: Array<[number, number]>;
  locks?: Array<[string, number[]]>;
  /** Stop after isLocked (a short tail). */
  omitTail?: boolean;
  /** Stop after the departed table. */
  omitLocks?: boolean;
}

function buildFullUpdate(tail: Tail = {}): Uint8Array {
  const w = new Writer();
  w.u16(2); w.u16(16);
  writeFellow(w, 0x50000001, 'Leader');
  writeFellow(w, 0x50000002, 'Bob');
  w.s16L('Fellows');
  w.u32(0x50000001); w.u32(1); w.u32(0); w.u32(1); w.u32(0);
  if (tail.omitTail) return w.build();
  const departed = tail.departed ?? [];
  w.u16(departed.length); w.u16(32);
  for (const [guid, ts] of departed) { w.u32(guid); w.u32(ts); }
  if (tail.omitLocks) return w.build();
  const locks = tail.locks ?? [];
  w.u16(locks.length); w.u16(32);
  for (const [name, data] of locks) { w.s16L(name); for (const v of data) w.u32(v); }
  return w.build();
}

function buildUpdateFellow(name: string, updateType: number): Uint8Array {
  const w = new Writer();
  writeFellow(w, 0x60000001, name, 1 << 1);
  w.u32(updateType);
  return w.build();
}

afterEach(() => { vi.restoreAllMocks(); });

describe('parseFellowshipFullUpdate reads ACE DepartedMembers and FellowshipLocks', () => {
  it('parses departed members (guid -> timestamp) and fellowship locks', () => {
    const bytes = buildFullUpdate({
      departed: [[0x50000003, 1_700_000_000], [0x50000004, 1_700_000_500]],
      locks: [['QuestFlagA', [0, 0, 0, 1_700_000_100, 1]], ['Lk', [0, 7, 9, 1_700_000_200, 3]]],
    });
    const r = parseFellowshipFullUpdate(bytes)!;
    expect(r.fellows.map(f => f.name)).toEqual(['Leader', 'Bob']);
    expect([...r.departedMembers]).toEqual([[0x50000003, 1_700_000_000], [0x50000004, 1_700_000_500]]);
    expect([...r.fellowshipLocks.keys()]).toEqual(['QuestFlagA', 'Lk']);
    expect(r.fellowshipLocks.get('Lk')).toEqual({ unknown1: 0, unknown2: 7, unknown3: 9, timestamp: 1_700_000_200, sequence: 3 });
  });

  it('a short tail still yields the roster (retail applies a failed UnPack)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const short = parseFellowshipFullUpdate(buildFullUpdate({ omitTail: true }))!;
    expect(short.fellows).toHaveLength(2);
    expect(short.departedMembers.size).toBe(0);
    expect(short.fellowshipLocks.size).toBe(0);

    const noLocks = parseFellowshipFullUpdate(buildFullUpdate({ departed: [[0x50000009, 5]], omitLocks: true }))!;
    expect([...noLocks.departedMembers]).toEqual([[0x50000009, 5]]);

    // Departed header claims 3 entries but the payload ends after one.
    const bytes = buildFullUpdate({ departed: [[0x5000000a, 1], [0x5000000b, 2], [0x5000000c, 3]], omitLocks: true });
    const cut = parseFellowshipFullUpdate(bytes.slice(0, bytes.length - 12))!;
    expect(cut.fellows).toHaveLength(2);
    expect(cut.fellowshipName).toBe('Fellows');
    expect(warn).toHaveBeenCalled();
  });

  it('warns on bytes left after FellowshipLocks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bytes = buildFullUpdate();
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes);
    expect(parseFellowshipFullUpdate(padded)).not.toBeNull();
    expect(warn.mock.calls.some(c => String(c[0]).includes('4 trailing byte'))).toBe(true);
  });
});

describe('wire-consumption probe', () => {
  it('reports unread bytes when a parser stops early', () => {
    const bytes = buildUpdateFellow('Abc', 1);
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes);
    expect(probeConsumption(padded, parseFellowshipUpdateFellow).remaining).toBe(8);
  });
});

/** Checked per-event inventory: each row is an ACE-shaped payload the parser must consume whole. */
const INVENTORY: Array<{ event: string; payload: () => Uint8Array; parse: (p: Uint8Array) => unknown }> = [
  { event: 'FellowshipFullUpdate (0x02BE), empty tables', payload: () => buildFullUpdate(), parse: parseFellowshipFullUpdate },
  {
    event: 'FellowshipFullUpdate (0x02BE), departed + locks',
    payload: () => buildFullUpdate({ departed: [[0x50000003, 42]], locks: [['abc', [0, 0, 0, 9, 1]], ['abcd', [0, 0, 0, 10, 2]]] }),
    parse: parseFellowshipFullUpdate,
  },
  { event: 'FellowshipUpdateFellow (0x02C0), pad 3', payload: () => buildUpdateFellow('Bob', 1), parse: parseFellowshipUpdateFellow },
  { event: 'FellowshipUpdateFellow (0x02C0), pad 0', payload: () => buildUpdateFellow('Mo', 2), parse: parseFellowshipUpdateFellow },
];

describe('GameEvent parsers consume their whole ACE payload', () => {
  for (const row of INVENTORY) {
    it(row.event, () => {
      const warn = vi.spyOn(console, 'warn');
      const { result, remaining } = probeConsumption(row.payload(), row.parse);
      expect(result).not.toBeNull();
      expect(remaining).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });
  }
});
