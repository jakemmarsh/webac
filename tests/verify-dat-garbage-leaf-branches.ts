/**
 * DAT B-tree leaves whose branch slots hold garbage instead of 0.
 *
 * Dark Destiny 1.0's client_portal.dat (a ClassicACE Infiltration world, its
 * own DAT tool) leaves all 62 branches of 27 leaves as 0xCDCDCDCD (MSVC's
 * uninitialised-heap fill), and internal nodes' slots past EntryCount + 1 too.
 * Retail treats a node as internal when NextNode_[0] != 0 (BTree::Search
 * @ 0x006731c0), and a child it cannot load (SetFilePointer on a negative
 * LONG, ReadFile short past the end: DiskDev::SyncRead @ 0x00676c60) holds
 * nothing; ACE reads a zeroed node there. DatDatabase and RangedDat now do
 * the same instead of throwing "short read at 3452816845". The same file
 * stores a Surface under id 0 (INVALID_DID), which retail never finds.
 *
 * Unit: a synthetic DAT with that shape, read through every source kind.
 * Real: the Dark Destiny portal.dat, only when ACJS_DARK_DESTINY_DATS names
 * its folder (the file is not ours to keep).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatDatabase, ArrayBufferDatBytes, isReadableDirBranch } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { RangedDat, type RangeFetcher } from '../packages/dat-parser/src/RangedDat.js';

const BS = 64;
const NODE_SIZE = 62 * 4 + 4 + 61 * 24;
const CD = 0xcdcdcdcd;

/** Root (internal, garbage past its 3 children) + three leaves, the middle two filled with CD branches. */
function buildDat(): { bytes: Uint8Array; files: Map<number, Uint8Array> } {
  const sectors: Uint8Array[] = Array.from({ length: 6 }, () => new Uint8Array(BS));
  const chain = (data: Uint8Array): number => {
    const n = Math.max(1, Math.ceil(data.length / (BS - 4)));
    const first = sectors.length;
    for (let i = 0; i < n; i++) {
      const s = new Uint8Array(BS);
      new DataView(s.buffer).setUint32(0, i + 1 < n ? (first + i + 1) * BS : 0, true);
      s.set(data.subarray(i * (BS - 4), (i + 1) * (BS - 4)), 4);
      sectors.push(s);
    }
    return first * BS;
  };
  const node = (branches: number[], fill: number, entries: Array<[number, number, number]>): Uint8Array => {
    const out = new Uint8Array(NODE_SIZE).fill(0xcd);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 62; i++) dv.setUint32(i * 4, i < branches.length ? branches[i] : fill, true);
    dv.setUint32(62 * 4, entries.length, true);
    entries.forEach(([id, off, size], i) => {
      const o = 62 * 4 + 4 + i * 24;
      [0, id, off, size, 0, 1].forEach((v, j) => dv.setUint32(o + j * 4, v, true));
    });
    return out;
  };
  const files = new Map<number, Uint8Array>();
  const ids = [0x01000001, 0x01000002, 0x01000010, 0x01000011, 0x01000020, 0x01000030, 0x01000031];
  const at = new Map<number, number>();
  for (const id of ids) {
    const data = Uint8Array.from({ length: 20 + (id & 0xff) * 3 }, (_, i) => (id + i) & 0xff);
    files.set(id, data);
    at.set(id, chain(data));
  }
  const e = (id: number): [number, number, number] => [id, at.get(id)!, files.get(id)!.length];
  // An entry under id 0 (INVALID_DID), as Dark Destiny's portal.dat has: stored but unreachable.
  const zero: [number, number, number] = [0, chain(new Uint8Array(24).fill(7)), 24];
  const leafA = chain(node([], CD, [zero, e(0x01000001), e(0x01000002)]));
  const leafB = chain(node([], CD, [e(0x01000011)]));
  const leafC = chain(node([0], 0, [e(0x01000030), e(0x01000031)]));
  const root = chain(node([leafA, leafB, leafC], CD, [e(0x01000010), e(0x01000020)]));
  const bytes = new Uint8Array(sectors.length * BS);
  sectors.forEach((s, i) => bytes.set(s, i * BS));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0x140, 0x5442, true);
  dv.setUint32(0x144, BS, true);
  dv.setUint32(0x148, bytes.length, true);
  dv.setUint32(0x14c, 1, true);
  dv.setUint32(0x160, root, true);
  return { bytes, files };
}

const fetcher = (bytes: Uint8Array): RangeFetcher => async (offset, length) =>
  bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length)).slice();

describe('DAT directory leaves with 0xCDCDCDCD branches', () => {
  const { bytes, files } = buildDat();
  let dir: string;
  let path: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-cd-leaf-'));
    path = join(dir, 'cd.dat');
    writeFileSync(path, bytes);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('isReadableDirBranch: in-file sectors only (retail: no negative LONG seek, no read past the end)', () => {
    expect(isReadableDirBranch(0x400, 0x10000)).toBe(true);
    expect(isReadableDirBranch(0, 0x10000)).toBe(false);
    expect(isReadableDirBranch(CD, 0x10000)).toBe(false);
    expect(isReadableDirBranch(CD, 0xf0000000)).toBe(false); // bit 31: SetFilePointer fails
    expect(isReadableDirBranch(0x10000, 0x10000)).toBe(false);
  });

  for (const [name, open] of [
    ['an in-memory ArrayBuffer', () => new DatDatabase(bytes.slice().buffer)],
    ['ArrayBufferDatBytes', () => new DatDatabase(new ArrayBufferDatBytes(bytes.slice().buffer))],
    ['FileDatBytes', () => new DatDatabase(new FileDatBytes(path))],
  ] as Array<[string, () => DatDatabase]>) {
    it(`DatDatabase over ${name} lists every file and reads each`, () => {
      const db = open();
      expect(db.listFileIds().sort()).toEqual([...files.keys()].sort());
      for (const [id, data] of files) expect(new Uint8Array(db.getFileData(id)!)).toEqual(data);
      // INVALID_DID: retail's BTree::Lookup @ 0x00673800 refuses id 0 before searching.
      expect(db.hasFile(0)).toBe(false);
      expect(db.getFileData(0)).toBeNull();
    });
  }

  it('RangedDat finds every file, and a miss inside a garbage leaf is null, not a throw', async () => {
    const dat = await RangedDat.open(fetcher(bytes));
    for (const [id, data] of files) expect(new Uint8Array((await dat.getFileData(id))!)).toEqual(data);
    // 0x01000003 / 0x01000012 fall inside the CD leaves; 0x01000032 inside the clean one.
    for (const id of [0, 0x01000003, 0x01000000, 0x01000012, 0x01000015, 0x01000032]) {
      expect(await dat.findEntry(id)).toBeNull();
    }
  });
});

const DD = process.env.ACJS_DARK_DESTINY_DATS;
describe.skipIf(!DD || !existsSync(join(DD ?? '', 'client_portal.dat')))('Dark Destiny 1.0 client_portal.dat', () => {
  let db: DatDatabase;
  beforeAll(() => { db = new DatDatabase(new FileDatBytes(join(DD!, 'client_portal.dat'))); });

  it('opens and lists the whole directory', () => {
    expect(db.fileCount).toBeGreaterThan(80000);
    expect(db.getFileData(0x0e000002)).not.toBeNull(); // CharGen
  });
});
