/**
 * The pre-Throne-of-Destiny DAT container (the 1999 retail CD), read by
 * DatDatabase (docs/ac1999-support-scope.md Phase 2; layout measured in
 * docs/ac1999-support.md): header at 0x12C with the Iteration in it, 12-byte
 * directory entries, bit-31-flagged sector links, no 0xFFFF0001 record.
 * Plus the overlay hook (server patches, era format translation) and the
 * guarantee that ToD files read exactly as before.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase, type DatOverlay } from '../packages/dat-parser/src/DatDatabase.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const BLOCK = 0x100;

/** A pre-ToD container: one directory node (leaf), files stored in chained sectors. */
function preTodDat(files: Array<{ id: number; data: Uint8Array }>, iteration = 102): Uint8Array {
  const sectorData = BLOCK - 4;
  const chunks: Uint8Array[] = [];
  let next = 0x400; // first free sector after the header area
  const alloc = (bytes: Uint8Array): number => {
    const start = next;
    const sectors = Math.max(1, Math.ceil(bytes.length / sectorData));
    for (let i = 0; i < sectors; i++) {
      const sec = new Uint8Array(BLOCK);
      const dv = new DataView(sec.buffer);
      const at = next;
      next += BLOCK;
      // Link to the following sector; flag bit 31 set on links as the retail files may carry it.
      if (i < sectors - 1) dv.setUint32(0, (next | 0x80000000) >>> 0, true);
      sec.set(bytes.subarray(i * sectorData, (i + 1) * sectorData), 4);
      chunks.push(sec);
      void at;
    }
    return start;
  };
  const entries = files.map((f) => ({ id: f.id, offset: alloc(f.data), size: f.data.length }));
  const node = new Uint8Array(62 * 4 + 4 + 61 * 12);
  const nv = new DataView(node.buffer);
  nv.setUint32(248, entries.length, true);
  entries.forEach((e, i) => {
    nv.setUint32(252 + i * 12, e.id >>> 0, true);
    nv.setUint32(256 + i * 12, e.offset, true);
    nv.setUint32(260 + i * 12, e.size, true);
  });
  const root = alloc(node);
  const out = new Uint8Array(next);
  chunks.forEach((c, i) => out.set(c, 0x400 + i * BLOCK));
  const hv = new DataView(out.buffer);
  [0x5442, BLOCK, out.length, iteration, 0, 0, 0, root].forEach((w, i) => hv.setUint32(0x12c + i * 4, w, true));
  return out;
}

const bytes = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

describe('pre-ToD container (synthetic)', () => {
  const small = bytes(40, 1);
  const multi = bytes(700, 3); // spans 3 sectors through flagged links
  const db = new DatDatabase(preTodDat([{ id: 0x01000001, data: small }, { id: 0x0d000002, data: multi }]));

  it('is detected as pre-ToD and reads its header', () => {
    expect(db.container).toBe('pre-tod');
    expect(db.blockSize).toBe(BLOCK);
    expect(db.dataSet).toBe(2); // 0x100 blocks = a cell DAT in every retail set
    expect(db.fileCount).toBe(2);
  });

  it('reports the header Iteration as the DAT version (there is no 0xFFFF0001 record)', () => {
    expect(db.totalIterations).toBe(102);
    expect(db.hasFile(0xffff0001)).toBe(false);
  });

  it('reads files through 12-byte entries and bit-31-flagged sector links', () => {
    expect(new Uint8Array(db.getFileData(0x01000001)!)).toEqual(small);
    expect(new Uint8Array(db.getFileData(0x0d000002)!)).toEqual(multi);
    expect(db.getFileEntry(0x0d000002)!.fileSize).toBe(700);
  });
});

describe('DatOverlay', () => {
  const base = bytes(16, 9);
  const patched = bytes(24, 5);
  const synthetic = bytes(8, 2);
  const db = new DatDatabase(preTodDat([{ id: 0x06000001, data: base }]));
  const overlay: DatOverlay = {
    get: (id, getBase) => id === 0x06000001 ? patched.slice().buffer : id === 0x07000001 ? synthetic.slice().buffer : id === 0x06000009 ? getBase(0x06000001) : undefined,
    has: (id, baseHas) => baseHas(id) || id === 0x07000001 || id === 0x06000009,
    extraIds: (p) => (p === undefined || p === 0x07 ? [0x07000001] : []),
    iteration: 10006,
  };

  it('serves overlay bytes first, extra ids, and the overlay iteration; removing it restores the container', () => {
    db.setOverlay(overlay);
    expect(new Uint8Array(db.getFileData(0x06000001)!)).toEqual(patched);
    expect(new Uint8Array(db.getFileData(0x07000001)!)).toEqual(synthetic);
    expect(new Uint8Array(db.getFileData(0x06000009)!)).toEqual(base); // overlay built from the container's bytes
    expect(db.hasFile(0x07000001)).toBe(true);
    expect(db.listFileIds(0x07)).toEqual([0x07000001]);
    expect(db.getFileEntry(0x07000001)!.fileSize).toBe(8);
    expect(db.totalIterations).toBe(10006);
    db.setOverlay(null);
    expect(new Uint8Array(db.getFileData(0x06000001)!)).toEqual(base);
    expect(db.hasFile(0x07000001)).toBe(false);
    expect(db.totalIterations).toBe(102);
  });

  it('getUntranslatedFileData reads under the translation: the overlay\'s raw (a patch), else the container; no overlay = getFileData', () => {
    expect(new Uint8Array(db.getUntranslatedFileData(0x06000001)!)).toEqual(base);
    db.setOverlay(overlay); // no getRaw: the container's bytes, not the served ones
    expect(new Uint8Array(db.getUntranslatedFileData(0x06000001)!)).toEqual(base);
    const raw = bytes(12, 3);
    db.setOverlay({ ...overlay, getRaw: (id, getBase) => (id === 0x06000002 ? raw.slice().buffer : getBase(id)) });
    expect(new Uint8Array(db.getFileData(0x06000001)!)).toEqual(patched);
    expect(new Uint8Array(db.getUntranslatedFileData(0x06000001)!)).toEqual(base);
    expect(new Uint8Array(db.getUntranslatedFileData(0x06000002)!)).toEqual(raw);
    db.setOverlay(null);
  });

  it('the 1999 overlay\'s getRaw: a server patch, else the container — never the translation', () => {
    const patch = bytes(20, 7);
    const ov = ac1999PortalOverlay({ patches: new Map([[0x0e000002, patch.slice().buffer]]) });
    expect(new Uint8Array(ov.getRaw!(0x0e000002, () => null)!)).toEqual(patch);
    expect(new Uint8Array(ov.getRaw!(0x06000001, () => base.slice().buffer)!)).toEqual(base);
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
const HAS_1999 = existsSync(resolve(AC1999, 'portal.dat')) && existsSync(resolve(AC1999, 'cell.dat'));

describe.skipIf(!HAS_1999)('the 1999 retail CD DATs (dat-sets/ac1999-retail)', () => {
  let portal: DatDatabase;
  let cell: DatDatabase;
  beforeAll(() => {
    portal = openDat(resolve(AC1999, 'portal.dat'));
    cell = openDat(resolve(AC1999, 'cell.dat'));
  });

  it('opens both as pre-ToD with the measured census and iterations', () => {
    expect(portal.container).toBe('pre-tod');
    expect(cell.container).toBe('pre-tod');
    expect(portal.fileCount).toBe(17794);
    expect(cell.fileCount).toBe(131560);
    expect(portal.totalIterations).toBe(102);
    expect(cell.totalIterations).toBe(67);
    expect(portal.dataSet).toBe(1);
    expect(cell.dataSet).toBe(2);
  });

  it('reads files of every size the census has (GfxObj, a landblock)', () => {
    const gfx = portal.listFileIds(0x01)[0];
    expect(portal.getFileData(gfx)!.byteLength).toBe(portal.getFileEntry(gfx)!.fileSize);
    const lb = cell.listFileIds().find((id) => (id & 0xffff) === 0xffff)!;
    expect(cell.getFileData(lb)!.byteLength).toBe(252); // CellLandblock: id, flag, 81 u16 terrain, 81 heights, align
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('ToD DATs are read exactly as before', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });
  it('stays ToD with its Iteration record', () => {
    expect(portal.container).toBe('tod');
    expect(portal.totalIterations).toBe(2072);
    expect(portal.hasFile(0xffff0001)).toBe(true);
  });
});
