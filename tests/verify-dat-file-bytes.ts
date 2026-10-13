/**
 * FileDatBytes (on-demand reads) returns byte-identical files to the
 * in-memory ArrayBuffer path the browser uses.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatDatabase, ArrayBufferDatBytes } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** A tiny synthetic DAT: header at 0x140, one leaf directory node, two files (one spanning 3 sectors). */
function syntheticDat(): Uint8Array {
  const bs = 64;
  const buf = new Uint8Array(bs * 64);
  const dv = new DataView(buf.buffer);
  const H = 0x140;
  dv.setUint32(H, 0x5442, true); dv.setUint32(H + 4, bs, true); dv.setUint32(H + 8, buf.length, true);
  dv.setUint32(H + 12, 1, true);
  const root = bs * 8;
  dv.setUint32(H + 32, root, true);
  // Directory node (1716 bytes) through a sector chain starting at `root`.
  const node = new Uint8Array(1716);
  const nv = new DataView(node.buffer);
  nv.setUint32(62 * 4, 2, true); // entryCount
  const fileA = bs * 50, fileB = bs * 55;
  const entries = [[0, 0x01000001, fileA, 10, 0, 1], [0, 0x01000002, fileB, 150, 0, 1]];
  entries.forEach((e, i) => e.forEach((v, j) => nv.setUint32(62 * 4 + 4 + i * 24 + j * 4, v, true)));
  const writeChain = (start: number, data: Uint8Array, spare: number[]) => {
    let pos = start, off = 0;
    while (off < data.length) {
      const take = Math.min(bs - 4, data.length - off);
      const next = off + take < data.length ? spare.shift()! : 0;
      dv.setUint32(pos, next, true);
      buf.set(data.subarray(off, off + take), pos + 4);
      off += take; pos = next;
    }
  };
  writeChain(root, node, Array.from({ length: 30 }, (_, i) => bs * (10 + i)));
  writeChain(fileA, Uint8Array.from({ length: 10 }, (_, i) => i + 1), []);
  writeChain(fileB, Uint8Array.from({ length: 150 }, (_, i) => (i * 7) & 0xff), [bs * 58, bs * 61]);
  return buf;
}

describe('FileDatBytes vs in-memory DatDatabase', () => {
  it('reads the same directory and file bytes from a synthetic multi-sector DAT', () => {
    const bytes = syntheticDat();
    const dir = mkdtempSync(join(tmpdir(), 'acjs-dat-'));
    const path = join(dir, 'synthetic.dat');
    writeFileSync(path, bytes);
    const mem = new DatDatabase(bytes.buffer as ArrayBuffer);
    const file = new DatDatabase(new FileDatBytes(path));
    const view = new DatDatabase(new ArrayBufferDatBytes(bytes.buffer as ArrayBuffer));
    for (const db of [file, view]) {
      expect(db.listFileIds().sort()).toEqual(mem.listFileIds().sort());
      for (const id of [0x01000001, 0x01000002]) {
        expect(new Uint8Array(db.getFileData(id)!)).toEqual(new Uint8Array(mem.getFileData(id)!));
      }
    }
    expect(new Uint8Array(file.getFileData(0x01000002)!)[149]).toBe((149 * 7) & 0xff);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.local))('FileDatBytes on the real DATs', () => {
  let mem: DatDatabase;
  beforeAll(() => { mem = new DatDatabase(readFileSync(DAT_PATHS.local)); });
  it('local_English.dat: every file is byte-identical through openDat', () => {
    const lazy = openDat(DAT_PATHS.local);
    expect(lazy.fileCount).toBe(mem.fileCount);
    for (const id of mem.listFileIds()) {
      expect(new Uint8Array(lazy.getFileData(id)!)).toEqual(new Uint8Array(mem.getFileData(id)!));
    }
  });
  it.skipIf(!existsSync(DAT_PATHS.portal))('portal.dat: a spread of files is byte-identical and openDat is cached', () => {
    const lazy = openDat(DAT_PATHS.portal);
    expect(openDat(DAT_PATHS.portal)).toBe(lazy);
    const full = new DatDatabase(readFileSync(DAT_PATHS.portal));
    const ids = full.listFileIds();
    for (let i = 0; i < ids.length; i += Math.floor(ids.length / 400)) {
      expect(new Uint8Array(lazy.getFileData(ids[i])!)).toEqual(new Uint8Array(full.getFileData(ids[i])!));
    }
  });
});
