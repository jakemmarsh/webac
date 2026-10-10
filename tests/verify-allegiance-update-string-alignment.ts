/**
 * FAITHFUL.559 — readString16L must 4-byte align after reading.
 *
 * ACE's Extensions.cs:12-21 WriteString16L pads `sizeof(ushort) + data.Length`
 * to a multiple of 4 ("client expects string length to be a multiple of 4
 * including the 2 bytes for length"). Our prior `readString16L` skipped the
 * pad bytes entirely — so every callsite was misaligned by 0–3 bytes per
 * string. The bug was latent in parseAllegianceUpdate because retail
 * AllegianceHierarchy.cs forces motd/motdSetBy empty (line 88), but each
 * empty string still consumes 4 bytes on the wire (2 length + 2 pad). Two
 * empty strings = 4 bytes of cascading drift; chatRoomID, bindPoint,
 * allegianceName, and the entire member list were all corrupted.
 *
 * The fix unifies readString16L to match WriteString16L's padding behavior
 * (matching the prior `readString16LAligned` which was duplicated for
 * parseFriendsListUpdate). This test pins the corrected behavior by
 * constructing a synthetic payload using the exact ACE write semantics and
 * verifies all top-level + per-member fields round-trip cleanly.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAllegianceUpdate } from '@ac/network';
import { AllegianceIndex } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACE_EXT = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Extensions.cs');
const ACE_HIER = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/AllegianceHierarchy.cs');

/* Synthetic wire-format builder — mirrors ACE Extensions.cs WriteString16L
 * + the AllegianceHierarchy / AllegianceData Write methods exactly. */
class Writer {
  private bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32(v: number) { this.u16(v); this.u16(v >>> 16); }
  i32(v: number) { this.u32(v >>> 0); }
  f32(v: number) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    const u = new Uint8Array(buf);
    for (let i = 0; i < 4; i++) this.u8(u[i]);
  }
  // Matches Extensions.cs:12-21 — uint16 length + bytes + pad (2+len) → multiple of 4.
  s16L(s: string) {
    const enc = new TextEncoder().encode(s);
    this.u16(enc.length);
    for (const b of enc) this.u8(b);
    const total = 2 + enc.length;
    const pad = ((total + 3) & ~3) - total;
    for (let i = 0; i < pad; i++) this.u8(0);
  }
  build(): Uint8Array { return new Uint8Array(this.bytes); }
  pos(): number { return this.bytes.length; }
}

function writeAllegianceData(w: Writer, opts: {
  guid: number; bitfield: number; gender: number; heritage: number; rank: number;
  level?: number; name: string; xpProduced?: number; loyalty?: number; leadership?: number;
}) {
  w.u32(opts.guid);
  w.u32(0);                  // cpCached
  w.u32(opts.xpProduced ?? 0); // cpTithed
  w.u32(opts.bitfield);
  w.u8(opts.gender);
  w.u8(opts.heritage);
  w.u16(opts.rank);
  if (opts.bitfield & AllegianceIndex.HasPackedLevel) {
    w.u32(opts.level ?? 0);
  }
  w.u16(opts.loyalty ?? 0);
  w.u16(opts.leadership ?? 0);
  if (opts.bitfield & AllegianceIndex.HasAllegianceAge) {
    w.u32(0);                // timeOnline
    w.u32(0);                // allegianceAge
  } else {
    w.u32(0); w.u32(0);      // uTimeOnline (uint64)
  }
  w.s16L(opts.name);
}

function buildPayload(): { bytes: Uint8Array; expected: any } {
  const BIT = AllegianceIndex.HasAllegianceAge | AllegianceIndex.HasPackedLevel;
  const w = new Writer();

  // Top-level: playerRank, totalMembers, totalVassals
  w.u32(2);                                  // playerRank
  w.u32(3);                                  // totalMembers (monarch + patron + self)
  w.u32(0);                                  // totalVassals

  // AllegianceHierarchy
  w.u16(3);                                  // recordCount
  w.u16(0x000B);                             // oldVersion

  // Officers PHashTable (always empty in retail)
  w.u16(0);                                  // officer count
  w.u16(256);                                // bucket count

  // Officer titles
  w.u32(0);                                  // titleCount = 0

  // Broadcast times
  w.u32(0); w.u32(0); w.u32(0); w.u32(0);

  // MOTD strings — ACE AllegianceHierarchy.cs:88 forces both empty.
  // Each consumes 4 wire bytes (2 length + 2 pad) — the alignment that
  // pre-fix readString16L skipped.
  w.s16L('');                                // motd
  w.s16L('');                                // motdSetBy

  // Chat room
  w.u32(0xCAFEBABE);                         // chatRoomID

  // Bind point: cell uint32 + Vector3 (xyz) + Quaternion (wxyz) = 8 fields
  w.u32(0x12345678);                         // cell
  w.f32(1.5); w.f32(2.5); w.f32(3.5);        // origin xyz
  w.f32(1.0); w.f32(0); w.f32(0); w.f32(0);  // rotation wxyz

  w.s16L('Test Allegiance');                 // allegianceName — 15 chars + 2 length = 17, pad to 20 (3 pad)
  w.u32(0);                                  // nameLastSetTime
  w.u32(1);                                  // isLocked = true
  w.i32(0);                                  // approvedVassal

  // Monarch record (no parent prefix)
  writeAllegianceData(w, {
    guid: 0xA0000001, bitfield: BIT | AllegianceIndex.LoggedIn,
    gender: 1, heritage: 1, rank: 1, level: 275, name: 'KingMonarch', xpProduced: 152000000,
    loyalty: 291, leadership: 240,
  });

  // Patron record (treeParent = monarch guid)
  w.u32(0xA0000001);
  writeAllegianceData(w, {
    guid: 0xA0000002, bitfield: BIT,        // offline
    gender: 2, heritage: 3, rank: 2, level: 180, name: 'PatronChar', xpProduced: 48200000,
    loyalty: 150, leadership: 60,
  });

  // Self record (treeParent = patron)
  w.u32(0xA0000002);
  writeAllegianceData(w, {
    guid: 0xA0000003, bitfield: BIT | AllegianceIndex.LoggedIn,
    gender: 1, heritage: 4, rank: 3, level: 107, name: '+TestChar', xpProduced: 0,
    loyalty: 0, leadership: 0,
  });

  return {
    bytes: w.build(),
    expected: {
      playerRank: 2, totalMembers: 3, totalVassals: 0,
      allegianceName: 'Test Allegiance', isLocked: true,
      members: [
        { guid: 0xA0000001, parentGuid: 0, name: 'KingMonarch', level: 275, rank: 1, gender: 1, heritage: 1, isOnline: true, xpProduced: 152000000, loyalty: 291, leadership: 240 },
        { guid: 0xA0000002, parentGuid: 0xA0000001, name: 'PatronChar', level: 180, rank: 2, gender: 2, heritage: 3, isOnline: false, xpProduced: 48200000, loyalty: 150, leadership: 60 },
        { guid: 0xA0000003, parentGuid: 0xA0000002, name: '+TestChar', level: 107, rank: 3, gender: 1, heritage: 4, isOnline: true, xpProduced: 0, loyalty: 0, leadership: 0 },
      ],
    },
  };
}

describe.skipIf(!aceReferenceExists(ACE_EXT))('ACE Extensions.cs pins WriteString16L padding behavior', () => {
  it('pads `sizeof(ushort) + data.Length` to multiple of 4', () => {
    const src = readFileSync(ACE_EXT, 'utf8');
    expect(src).toContain('WriteString16L');
    expect(src).toContain('writer.Pad(CalculatePadMultiple(sizeof(ushort) + (uint)data.Length, 4u))');
  });
});

describe.skipIf(!aceReferenceExists(ACE_HIER))('AllegianceHierarchy.cs forces empty motd/motdSetBy', () => {
  it('motd and motdSetBy are explicitly emptied to fix decal parsing', () => {
    const src = readFileSync(ACE_HIER, 'utf8');
    expect(src).toMatch(/motd\s*=\s*""\s*;\s*\/\/\s*fixes decal AllegianceUpdate parsing/);
    expect(src).toMatch(/motdSetBy\s*=\s*""\s*;/);
  });
});

describe('parseAllegianceUpdate handles ACE WriteString16L padding correctly', () => {
  const { bytes, expected } = buildPayload();

  it('returns non-null (no parse exception)', () => {
    const result = parseAllegianceUpdate(bytes);
    expect(result).not.toBeNull();
  });

  it('reads top-level rank/totals correctly', () => {
    const r = parseAllegianceUpdate(bytes)!;
    expect(r.playerRank).toBe(expected.playerRank);
    expect(r.totalMembers).toBe(expected.totalMembers);
    expect(r.totalVassals).toBe(expected.totalVassals);
  });

  it('reads allegianceName after empty motd/motdSetBy + bindpoint without drift', () => {
    const r = parseAllegianceUpdate(bytes)!;
    expect(r.allegianceName).toBe('Test Allegiance');
    expect(r.isLocked).toBe(true);
  });

  it('reads all member records with correct guid/parent/name/level/rank', () => {
    const r = parseAllegianceUpdate(bytes)!;
    expect(r.members).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(r.members[i]).toEqual(expected.members[i]);
    }
  });

  it('consumes exactly the bytes produced (no leftover / no overrun)', () => {
    const r = parseAllegianceUpdate(bytes)!;
    // Member name "+TestChar" = 9 bytes + 2 length = 11, pad to 12 (1 pad).
    // If readString16L did NOT align, the final record's tail would leave
    // 1 byte unconsumed and the prior records would have been corrupt.
    expect(r.members[2].name).toBe('+TestChar');
  });
});

describe('Pre-fix regression: misalignment would corrupt allegianceName', () => {
  it('chatRoomID + bindpoint + allegianceName all read at the correct offset', () => {
    const r = parseAllegianceUpdate(buildPayload().bytes)!;
    // Pre-fix, two empty s16L calls each leak 2 unconsumed pad bytes, so
    // by the time the parser reaches allegianceName it is 4 bytes behind
    // (the misaligned reads would pull random bytes from the bindpoint
    // floats). The bug presents as garbled-looking allegianceName text.
    expect(r.allegianceName).toBe('Test Allegiance');
    // Both monarchy member names depend on every preceding field being
    // sized correctly — a misalignment of even 1 byte cascades.
    expect(r.members.map(m => m.name)).toEqual(['KingMonarch', 'PatronChar', '+TestChar']);
  });
});
