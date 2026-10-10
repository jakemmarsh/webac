/**
 * DAT parser fidelity fixes (2026-09-26 review):
 *
 *  - DAT.replaceobject-hook-packed-did — ACE ReplaceObjectHook.cs reads a
 *    ushort PartIndex then AnimationPartChange's PartID via
 *    ReadAsDataIDOfKnownType(0x01000000) (packed 2/4-byte DID), not a raw
 *    uint32. Anim 0x0300055B used to leave 2 bytes and decode its second hook
 *    as type 0xFFFF0000.
 *  - DAT.spelltable-spellsets — ACE SpellTable.cs unpacks the SpellSet
 *    PackedHashTable after Spells (SpellSet.cs / SpellSetTiers.cs).
 *  - DAT.parser-cleanup — Iteration file (ACE FileTypes/Iteration.cs,
 *    DatDatabase.GetTotalIterations) replaces the maxIteration fallback;
 *    RenderTexture (0x15), QualityFilter (0x0E01xxxx), BadData (0x0E00001A)
 *    ported from ACE; the duplicate CharGen parser is gone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  DatDatabase, DatReader, Animation, AnimationHookType, readAnimationHook, SpellTable,
  Iteration, ITERATION_FILE_ID, RenderTexture, QualityFilter, BadData, SpecialFileIds,
  CharacterGenerator,
} from '../packages/dat-parser/src/index.js';
import * as datIndex from '../packages/dat-parser/src/index.js';
import { readSpellSet } from '../packages/dat-parser/src/file-types/SpellTable.js';
import type { ReplaceObjectHookData } from '../packages/dat-parser/src/file-types/AnimationHook.js';

// ─── byte builder ──────────────────────────────────────────────────────────

class Bytes {
  private parts: number[] = [];
  u8(v: number): this { this.parts.push(v & 0xff); return this; }
  u16(v: number): this { return this.u8(v).u8(v >>> 8); }
  u32(v: number): this { return this.u16(v & 0xffff).u16(v >>> 16); }
  i32(v: number): this { return this.u32(v >>> 0); }
  f32(v: number): this { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(b.getUint8(i)); return this; }
  buffer(): ArrayBuffer { return new Uint8Array(this.parts).buffer; }
  reader(): DatReader { return new DatReader(this.buffer()); }
}

/** A minimal DAT: header at 0x140, one B-tree leaf node, each file in its own
 *  2048-byte sector (large enough that the 1716-byte node fits in one). */
function buildDat(files: Array<{ id: number; data: Uint8Array; iteration?: number }>): ArrayBuffer {
  const BS = 2048;
  const buf = new ArrayBuffer(BS * (2 + files.length));
  const v = new DataView(buf);
  v.setUint32(0x140, 0x5442, true);
  v.setUint32(0x144, BS, true);
  v.setUint32(0x148, buf.byteLength, true);
  v.setUint32(0x14c, 1, true);
  v.setUint32(0x160, BS, true); // BTreeRoot
  // node sector: next=0, 62 zero branches, entryCount, entries
  let p = BS + 4 + 62 * 4;
  v.setUint32(p, files.length, true); p += 4;
  files.forEach((f, i) => {
    const off = BS * (2 + i);
    v.setUint32(p, 0, true); v.setUint32(p + 4, f.id >>> 0, true);
    v.setUint32(p + 8, off, true); v.setUint32(p + 12, f.data.length, true);
    v.setUint32(p + 16, 0, true); v.setUint32(p + 20, f.iteration ?? 0, true);
    p += 24;
    new Uint8Array(buf, off + 4, f.data.length).set(f.data);
  });
  return buf;
}

// ─── ReplaceObject hook ────────────────────────────────────────────────────

describe('ReplaceObject hook: ushort part index + packed DID of known type 0x01000000', () => {
  it('reads a 2-byte packed part id and leaves the next hook aligned', () => {
    const r = new Bytes()
      .u32(AnimationHookType.ReplaceObject).i32(0)
      .u16(0xb401) // partIndex (masked to the low byte, as ACE does)
      .u16(0x000b) // packed DID, high bit clear → 0x01000000 + 0x0B
      .u32(AnimationHookType.Ethereal).i32(-1).i32(1)
      .reader();
    const h = readAnimationHook(r) as ReplaceObjectHookData;
    expect(h.hookType).toBe(AnimationHookType.ReplaceObject);
    expect(h.partIndex).toBe(1);
    expect(h.partId).toBe(0x0100000b);
    const next = readAnimationHook(r);
    expect(next.hookType).toBe(AnimationHookType.Ethereal);
    expect(next.direction).toBe(-1);
    expect(r.remaining).toBe(0);
  });

  it('reads the 4-byte packed form (high bit set) as knownType + ((hi & 0x3FFF) << 16 | lo)', () => {
    const r = new Bytes()
      .u32(AnimationHookType.ReplaceObject).i32(0)
      .u16(3)
      .u16(0x8001).u16(0x2345)
      .reader();
    const h = readAnimationHook(r) as ReplaceObjectHookData;
    expect(h.partIndex).toBe(3);
    expect(h.partId).toBe(0x01012345);
    expect(r.remaining).toBe(0);
  });
});

// ─── SpellSet ──────────────────────────────────────────────────────────────

describe('SpellSet (ACE SpellSet.cs): sorted tiers, HighestTier, gap-filled tiers', () => {
  it('parses a PackedHashTable of List<uint> tiers and fills gaps from the nearest lower tier', () => {
    const r = new Bytes()
      .u16(2).u16(4)                       // count, bucket size
      .u32(3).i32(2).u32(10).u32(11)       // tier 3 → [10, 11]
      .u32(1).i32(1).u32(5)                // tier 1 → [5] (out of order on disk)
      .reader();
    const s = readSpellSet(r);
    expect(r.remaining).toBe(0);
    expect([...s.tiers.keys()]).toEqual([1, 3]);
    expect(s.highestTier).toBe(3);
    expect([...s.tiersNoGaps.keys()]).toEqual([1, 2, 3]);
    expect(s.tiersNoGaps.get(2)).toEqual([5]);
    expect(s.tiersNoGaps.get(3)).toEqual([10, 11]);
  });

  it('SpellTable reads the SpellSet table after the spells', () => {
    const r = new Bytes()
      .u32(0x0e00000e)
      .u16(0).u16(0)                       // no spells
      .u16(1).u16(1)                       // one set
      .u32(42)                             // SpellSetID
      .u16(1).u16(1).u32(0).i32(1).u32(7)  // tier 0 → [7]
      .reader();
    const t = new SpellTable(r);
    expect(r.remaining).toBe(0);
    expect(t.spellSets.size).toBe(1);
    expect(t.spellSets.get(42)!.tiers.get(0)).toEqual([7]);
  });
});

// ─── Iteration ─────────────────────────────────────────────────────────────

describe('Iteration (0xFFFF0001) and DatDatabase.totalIterations — ACE semantics', () => {
  const iterBytes = (total: number, pairs: Array<[number, number]>) => {
    const b = new Bytes().i32(total);
    for (const [consec, start] of pairs) b.i32(consec).i32(start);
    return new Uint8Array(b.buffer());
  };

  it('reads (consecutive, starting) ranges until the running total reaches 0', () => {
    const r = new DatReader(iterBytes(2072, [[-2072, 1]]).buffer as ArrayBuffer);
    const it = new Iteration(r);
    expect(r.remaining).toBe(0);
    expect(it.totalIterations).toBe(2072);
    expect([...it.ints]).toEqual([[1, -2072]]);
    expect(it.isComplete).toBe(true);
    const split = new Iteration(new DatReader(iterBytes(10, [[-4, 1], [-6, 6]]).buffer as ArrayBuffer));
    expect(split.ints.size).toBe(2);
    expect(split.isComplete).toBe(false);
  });

  it('returns TotalIterations from the Iteration file, not the per-entry max', () => {
    const db = new DatDatabase(buildDat([
      { id: 0x06000001, data: new Uint8Array(8), iteration: 538 },
      { id: ITERATION_FILE_ID, data: iterBytes(982, [[-982, 1]]) },
    ]));
    expect(db.maxIteration).toBe(538);
    expect(db.totalIterations).toBe(982);
    expect(db.iteration!.isComplete).toBe(true);
  });

  it('returns 0 (ACE: "Unable to read iteration") when the DAT has no Iteration file', () => {
    const db = new DatDatabase(buildDat([{ id: 0x06000001, data: new Uint8Array(8), iteration: 5 }]));
    expect(db.iteration).toBeNull();
    expect(db.totalIterations).toBe(0);
  });

  it('still returns TotalIterations for an incomplete (multi-range) DAT, as ACE does', () => {
    const db = new DatDatabase(buildDat([{ id: ITERATION_FILE_ID, data: iterBytes(10, [[-4, 1], [-6, 6]]) }]));
    expect(db.totalIterations).toBe(10);
  });
});

// ─── RenderTexture / QualityFilter / BadData ───────────────────────────────

describe('ACE-ported minor file types', () => {
  it('RenderTexture: Id, DataCategory, TextureType byte, List<uint>', () => {
    const r = new Bytes().u32(0x15000000).u32(0).u8(2).i32(2).u32(0x06001234).u32(0x06005678).reader();
    const rt = RenderTexture.read(r);
    expect(r.remaining).toBe(0);
    expect(rt).toMatchObject({ id: 0x15000000, dataCategory: 0, textureType: 2, textures: [0x06001234, 0x06005678] });
  });

  it('QualityFilter: eight counts + lists, then three counts + lists', () => {
    const b = new Bytes().u32(0x0e010001);
    b.u32(2).u32(0).u32(1).u32(0).u32(0).u32(0).u32(0).u32(1); // int, int64, bool, float, did, iid, string, position
    b.u32(28).u32(30).u32(7).u32(9);
    b.u32(1).u32(0).u32(2).u32(4).u32(6).u32(8);               // attribute, attribute2nd, skill
    const r = b.reader();
    const qf = QualityFilter.read(r);
    expect(r.remaining).toBe(0);
    expect(qf.intStatFilter).toEqual([28, 30]);
    expect(qf.boolStatFilter).toEqual([7]);
    expect(qf.positionStatFilter).toEqual([9]);
    expect(qf.attributeStatFilter).toEqual([4]);
    expect(qf.attribute2ndStatFilter).toEqual([]);
    expect(qf.skillStatFilter).toEqual([6, 8]);
  });

  it('BadData: Id + PackedHashTable<uint, uint>', () => {
    const r = new Bytes().u32(0x0e00001a).u16(2).u16(8).u32(100).u32(1).u32(200).u32(1).reader();
    const bd = BadData.read(r);
    expect(r.remaining).toBe(0);
    expect(BadData.FILE_ID).toBe(SpecialFileIds.BadData);
    expect([...bd.bad]).toEqual([[100, 1], [200, 1]]);
  });

  it('the package exports one CharGen parser (CharacterGenerator), not the deleted duplicate', () => {
    expect(datIndex.CharacterGenerator).toBe(CharacterGenerator);
    expect((datIndex as Record<string, unknown>).CharGen).toBeUndefined();
  });
});

// ─── Real EoL DATs ─────────────────────────────────────────────────────────

const DAT_DIR = path.resolve(__dirname, '..', 'dat');
const PORTAL = path.join(DAT_DIR, 'client_portal.dat');
const CELL = path.join(DAT_DIR, 'client_cell_1.dat');

function load(p: string): DatDatabase {
  const b = readFileSync(p);
  return new DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

describe.skipIf(!existsSync(PORTAL))('EoL portal.dat', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = load(PORTAL); });

  it('anim 0x0300055B parses with 0 leftover bytes; both hooks are ReplaceObject → GfxObj 0x0100000B', () => {
    const r = portal.getReader(0x0300055b);
    const a = new Animation(r);
    expect(r.remaining).toBe(0);
    const hooks = a.partFrames.flatMap((f) => f.hooks);
    expect(hooks.length).toBe(2);
    for (const h of hooks) {
      expect(h.hookType).toBe(AnimationHookType.ReplaceObject);
      expect((h as ReplaceObjectHookData).partIndex).toBe(1);
      expect((h as ReplaceObjectHookData).partId).toBe(0x0100000b);
    }
  });

  it('every Animation with a ReplaceObject hook parses to the end of its file', () => {
    let replaceHooks = 0;
    for (const id of portal.listFileIds(0x03)) {
      const r = portal.getReader(id);
      const a = new Animation(r);
      expect(r.remaining, `0x${id.toString(16)}`).toBe(0);
      for (const f of a.partFrames) {
        for (const h of f.hooks) {
          if (h.hookType === AnimationHookType.ReplaceObject) {
            replaceHooks++;
            expect((h as ReplaceObjectHookData).partId >>> 24).toBe(0x01);
          }
        }
      }
    }
    expect(replaceHooks).toBeGreaterThan(0);
  });

  it('SpellTable reads to the end: 6266 spells + 139 spell sets', () => {
    const r = portal.getReader(SpecialFileIds.SpellTable);
    const t = new SpellTable(r);
    expect(r.remaining).toBe(0);
    expect(t.spellSets.size).toBe(139);
    const set2 = t.spellSets.get(2)!;
    expect(set2.highestTier).toBe(5);
    expect(set2.tiersNoGaps.size).toBe(5);
  });

  it('RenderTexture, QualityFilter and BadData files all parse with 0 leftover bytes', () => {
    const all = portal.listFileIds();
    const cases: Array<[number[], (r: DatReader) => unknown]> = [
      [portal.listFileIds(0x15), RenderTexture.read],
      [all.filter((i) => i >>> 16 === 0x0e01), QualityFilter.read],
      [[SpecialFileIds.BadData], BadData.read],
    ];
    for (const [ids, read] of cases) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const r = portal.getReader(id);
        read(r);
        expect(r.remaining, `0x${id.toString(16)}`).toBe(0);
      }
    }
    expect(BadData.read(portal.getReader(SpecialFileIds.BadData)).bad.size).toBeGreaterThan(0);
  });

  it('Iteration: 2072 (ACE ITERATION_PORTAL), one complete range', () => {
    expect(portal.totalIterations).toBe(2072);
    expect(portal.iteration!.isComplete).toBe(true);
  });
});

describe.skipIf(!existsSync(CELL))('EoL cell.dat', () => {
  let cell: DatDatabase;
  beforeAll(() => { cell = load(CELL); });

  it('Iteration: 982 (ACE ITERATION_CELL), which the per-entry max (538) would have got wrong', () => {
    expect(cell.totalIterations).toBe(982);
    expect(cell.maxIteration).toBeLessThan(982);
  });
});
