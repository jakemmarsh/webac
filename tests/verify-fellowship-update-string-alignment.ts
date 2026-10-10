/**
 * FAITHFUL.560 — fellowship parsers must 4-byte align after WriteString16L.
 *
 * ACE GameEventFellowshipFullUpdate.cs writes each fellow's name via
 * Writer.WriteString16L (line 65) and the fellowship name via
 * WriteString16L (line 32). Extensions.cs:12-21 pads `sizeof(ushort) +
 * data.Length` to a multiple of 4. Pre-fix our `parseFellowshipFullUpdate`
 * read names via raw `readUInt16` + `readBytes` with NO alignment, so each
 * fellow's trailing-pad bytes (0–3) cascaded into the next fellow's guid,
 * silently corrupting the entire fellowship roster after the first fellow
 * whose name length didn't happen to be 2 mod 4.
 *
 * Worse: `parseFellowshipUpdateFellow` had the same bug, and its
 * `updateType` field (FellowUpdateType enum — Full, ToggleShareXP, etc.)
 * drives client dispatch logic. A misaligned read would silently change
 * the update type, mis-routing the per-fellow update.
 *
 * Fix unifies both parsers on the corrected `readString16L` helper that
 * matches ACE Extensions.cs WriteString16L's pad-to-4 contract. Tests pin
 * (a) ACE source for the WriteString16L call sites, (b) round-trip parsing
 * of a multi-fellow payload with mixed name lengths (1/2/3/4 mod 4), and
 * (c) parseFellowshipUpdateFellow reads the correct updateType after the
 * trailing string-pad.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFellowshipFullUpdate, parseFellowshipUpdateFellow } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_FULL = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventFellowshipFullUpdate.cs');
const ACE_UPD = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventFellowshipUpdateFellow.cs');

class Writer {
  private bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32(v: number) { this.u16(v); this.u16(v >>> 16); }
  // Mirrors ACE Extensions.cs:12-21 — uint16 length + bytes + pad (2+len) → multiple of 4.
  s16L(s: string) {
    const enc = new TextEncoder().encode(s);
    this.u16(enc.length);
    for (const b of enc) this.u8(b);
    const total = 2 + enc.length;
    const pad = ((total + 3) & ~3) - total;
    for (let i = 0; i < pad; i++) this.u8(0);
  }
  build(): Uint8Array { return new Uint8Array(this.bytes); }
}

function writeFellow(w: Writer, opts: {
  guid: number; level: number; hpMax: number; stMax: number; mnMax: number;
  hp: number; st: number; mn: number; shareLoot: boolean; name: string;
}) {
  w.u32(opts.guid);
  w.u32(0);                    // cpCached
  w.u32(0);                    // lumCached
  w.u32(opts.level);
  w.u32(opts.hpMax); w.u32(opts.stMax); w.u32(opts.mnMax);
  w.u32(opts.hp);    w.u32(opts.st);    w.u32(opts.mn);
  w.u32(opts.shareLoot ? 0x10 : 0); // ACE writes 0x10 for shareLoot, 0 otherwise
  w.s16L(opts.name);
}

function buildFullUpdate(): { bytes: Uint8Array; expected: any } {
  const w = new Writer();
  // PackableHashTable header: count u16 + numBuckets u16 (FellowComparer.NumBuckets = 16)
  w.u16(4);                    // 4 fellows
  w.u16(16);                   // buckets

  // Names chosen so (2 + len) % 4 hits all four residues — proves alignment
  // is correct regardless of name length:
  //   "A"   → 2+1=3 → pad 1
  //   "Bo"  → 2+2=4 → pad 0
  //   "Cat" → 2+3=5 → pad 3
  //   "Davy"→ 2+4=6 → pad 2
  writeFellow(w, { guid: 0x50000001, level: 100, hpMax: 200, stMax: 150, mnMax: 175, hp: 200, st: 150, mn: 175, shareLoot: true,  name: 'A'    });
  writeFellow(w, { guid: 0x50000002, level: 110, hpMax: 210, stMax: 160, mnMax: 185, hp: 100, st: 160, mn:  85, shareLoot: false, name: 'Bo'   });
  writeFellow(w, { guid: 0x50000003, level: 120, hpMax: 220, stMax: 170, mnMax: 195, hp: 220, st:  50, mn: 195, shareLoot: true,  name: 'Cat'  });
  writeFellow(w, { guid: 0x50000004, level: 130, hpMax: 230, stMax: 180, mnMax: 205, hp:   0, st:   0, mn:   0, shareLoot: false, name: 'Davy' });

  // Fellowship metadata — name "GoldenGate" = 10 bytes → 2+10=12, pad 0.
  w.s16L('GoldenGate');
  w.u32(0x50000001);           // leaderGuid (first fellow)
  w.u32(1);                    // shareXP
  w.u32(0);                    // evenShare
  w.u32(1);                    // open
  w.u32(0);                    // isLocked
  // (departedMembers + fellowshipLocks omitted: a short tail still yields the
  //  roster — the full tail is covered by verify-wire-full-consumption.ts)

  return {
    bytes: w.build(),
    expected: {
      fellows: [
        { guid: 0x50000001, level: 100, healthMax: 200, staminaMax: 150, manaMax: 175, healthCurrent: 200, staminaCurrent: 150, manaCurrent: 175, shareLoot: true,  name: 'A'    },
        { guid: 0x50000002, level: 110, healthMax: 210, staminaMax: 160, manaMax: 185, healthCurrent: 100, staminaCurrent: 160, manaCurrent:  85, shareLoot: false, name: 'Bo'   },
        { guid: 0x50000003, level: 120, healthMax: 220, staminaMax: 170, manaMax: 195, healthCurrent: 220, staminaCurrent:  50, manaCurrent: 195, shareLoot: true,  name: 'Cat'  },
        { guid: 0x50000004, level: 130, healthMax: 230, staminaMax: 180, manaMax: 205, healthCurrent:   0, staminaCurrent:   0, manaCurrent:   0, shareLoot: false, name: 'Davy' },
      ],
      fellowshipName: 'GoldenGate',
      leaderGuid: 0x50000001,
      shareXP: true, evenShare: false, open: true, isLocked: false,
    },
  };
}

describe.skipIf(!aceReferenceExists(ACE_FULL))('ACE GameEventFellowshipFullUpdate writes WriteString16L for names', () => {
  it('per-fellow name uses WriteString16L', () => {
    const src = readFileSync(ACE_FULL, 'utf8');
    expect(src).toMatch(/Writer\.WriteString16L\(fellow\.Name\)/);
  });
  it('fellowship name uses WriteString16L', () => {
    const src = readFileSync(ACE_FULL, 'utf8');
    expect(src).toMatch(/Writer\.WriteString16L\(fellowship\.FellowshipName\)/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_UPD))('ACE GameEventFellowshipUpdateFellow writes WriteString16L for name', () => {
  it('name uses WriteString16L, then writes updateType', () => {
    const src = readFileSync(ACE_UPD, 'utf8');
    const namePos = src.search(/Writer\.WriteString16L\(player\.Name\)/);
    const typePos = src.search(/Writer\.Write\(\(uint\)fellowUpdateType\)/);
    expect(namePos).toBeGreaterThan(0);
    expect(typePos).toBeGreaterThan(namePos);
  });
});

describe('parseFellowshipFullUpdate aligns each WriteString16L correctly', () => {
  const { bytes, expected } = buildFullUpdate();

  it('parses without exception', () => {
    expect(parseFellowshipFullUpdate(bytes)).not.toBeNull();
  });

  it('reads all 4 fellows with correct guids (proves no per-fellow drift)', () => {
    const r = parseFellowshipFullUpdate(bytes)!;
    expect(r.fellows.map(f => f.guid)).toEqual([0x50000001, 0x50000002, 0x50000003, 0x50000004]);
  });

  it('reads all 4 fellows with correct names (mixed name-length residues)', () => {
    const r = parseFellowshipFullUpdate(bytes)!;
    expect(r.fellows.map(f => f.name)).toEqual(['A', 'Bo', 'Cat', 'Davy']);
  });

  it('reads vitals correctly after the variable-length name pad', () => {
    const r = parseFellowshipFullUpdate(bytes)!;
    expect(r.fellows[3].level).toBe(expected.fellows[3].level);
    expect(r.fellows[3].healthMax).toBe(expected.fellows[3].healthMax);
    expect(r.fellows[3].manaCurrent).toBe(expected.fellows[3].manaCurrent);
  });

  it('reads fellowship metadata at the correct offset', () => {
    const r = parseFellowshipFullUpdate(bytes)!;
    expect(r.fellowshipName).toBe('GoldenGate');
    expect(r.leaderGuid).toBe(0x50000001);
    expect(r.shareXP).toBe(true);
    expect(r.evenShare).toBe(false);
    expect(r.open).toBe(true);
    expect(r.isLocked).toBe(false);
  });
});

describe('parseFellowshipUpdateFellow aligns the trailing WriteString16L correctly', () => {
  function buildUpdate(name: string, updateType: number, shareLoot: boolean): Uint8Array {
    const w = new Writer();
    w.u32(0x60000001);           // guid
    w.u32(0);                    // cpCached
    w.u32(0);                    // lumCached
    w.u32(150);                  // level
    w.u32(300); w.u32(200); w.u32(250); // vital max
    w.u32(300); w.u32(200); w.u32(250); // vital current
    // ACE: Writer.Write(Convert.ToUInt32(shareLoot) << 1) — so shareLoot=true → 2.
    w.u32(shareLoot ? 2 : 0);
    w.s16L(name);
    w.u32(updateType);           // FellowUpdateType
    return w.build();
  }

  it('reads updateType correctly after name with len%4==1 (pad=1)', () => {
    // "PlayerA" = 7 bytes → 2+7=9, pad=3 → total 12. Pre-fix would read 3 pad bytes into updateType.
    const r = parseFellowshipUpdateFellow(buildUpdate('PlayerA', 0x42, true))!;
    expect(r.fellow.name).toBe('PlayerA');
    expect(r.updateType).toBe(0x42);
    expect(r.fellow.shareLoot).toBe(true);
  });

  it('reads updateType correctly after name with len%4==2 (pad=0, aligned)', () => {
    // "Bob" = 3 bytes → 2+3=5, pad=3 → total 8. Pre-fix would have ALREADY drifted.
    const r = parseFellowshipUpdateFellow(buildUpdate('Bob', 99, false))!;
    expect(r.fellow.name).toBe('Bob');
    expect(r.updateType).toBe(99);
    expect(r.fellow.shareLoot).toBe(false);
  });

  it('reads updateType correctly after long name "TestPartner" (11 bytes, pad=3)', () => {
    // "TestPartner" = 11 bytes → 2+11=13, pad=3 → total 16. Pre-fix updateType reads 3 pad + 1 type byte.
    const r = parseFellowshipUpdateFellow(buildUpdate('TestPartner', 0xCAFE, true))!;
    expect(r.fellow.name).toBe('TestPartner');
    expect(r.updateType).toBe(0xCAFE);
  });
});
