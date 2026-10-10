/**
 * VISUAL.preworld-placeholder-before-portal-dat — the patch splash draws from
 * its own portal.dat files read by byte range (RangedDat), ahead of the full
 * ~900 MB download, instead of a sans-serif placeholder.
 *
 * Unit: a synthetic DAT (two-level B-tree, a scattered sector chain) read
 * through a counting RangeFetcher; httpRangeFetcher refusing a 200.
 * DAT: RangedDat agrees with DatDatabase on the real portal.dat, and the
 * splash's file set (PATCH_SPLASH_DAT_FILES + fonts' glyph sheets + the
 * Cancel press's waves) reads in a few MB and decodes.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { ACFont } from '../packages/dat-parser/src/file-types/ACFont.js';
import { RangedDat, httpRangeFetcher, type RangeFetcher } from '../packages/dat-parser/src/RangedDat.js';
import {
  PATCH_SPLASH_DAT_FILES, PATCH_TITLE_IMAGE, PATCH_CANCEL_FONT, PATCH_CANCEL_PRESS_SOUND,
  PATCH_METER_BG_FRAMES, PATCH_METER_OV_FRAMES, loadPatchSplashFiles,
} from '../packages/renderer/src/ui/PatchScreen.js';

/** A RangeFetcher over an in-memory DAT that records every request. */
function bufferFetcher(bytes: Uint8Array): RangeFetcher & { calls: Array<[number, number]>; bytesRead: number } {
  const f = (async (offset: number, length: number) => {
    f.calls.push([offset, length]);
    const slice = bytes.subarray(offset, Math.min(offset + length, bytes.length));
    f.bytesRead += slice.length;
    return slice.slice();
  }) as RangeFetcher & { calls: Array<[number, number]>; bytesRead: number };
  f.calls = [];
  f.bytesRead = 0;
  return f;
}

// ── A synthetic DAT: blockSize 64, root node + two leaves ────────────
const BS = 64;
const NODE_SIZE = 62 * 4 + 4 + 61 * 24;

class DatBuilder {
  private sectors: Uint8Array[] = [];
  /** Sector 0..5 hold the 0x140 header region (6 × 64 = 384 bytes). */
  constructor() {
    for (let i = 0; i < 6; i++) this.sectors.push(new Uint8Array(BS));
  }
  private alloc(n: number): number[] {
    const first = this.sectors.length;
    for (let i = 0; i < n; i++) this.sectors.push(new Uint8Array(BS));
    return Array.from({ length: n }, (_, i) => first + i);
  }
  /** Write `data` as a sector chain; `scatter` links the sectors out of order. */
  writeChain(data: Uint8Array, scatter = false): number {
    const n = Math.max(1, Math.ceil(data.length / (BS - 4)));
    let order = this.alloc(n);
    if (scatter) order = [...order.filter((_, i) => i % 2 === 0), ...order.filter((_, i) => i % 2 === 1)];
    order.forEach((s, i) => {
      const dv = new DataView(this.sectors[s].buffer);
      dv.setUint32(0, i + 1 < n ? order[i + 1] * BS : 0, true);
      this.sectors[s].set(data.subarray(i * (BS - 4), (i + 1) * (BS - 4)), 4);
    });
    return order[0] * BS;
  }
  /** Reserve a chain now, fill it later (a node whose children come after it). */
  reserveChain(size: number): { offset: number; fill: (data: Uint8Array) => void } {
    const n = Math.ceil(size / (BS - 4));
    const order = this.alloc(n);
    return {
      offset: order[0] * BS,
      fill: (data) => order.forEach((s, i) => {
        new DataView(this.sectors[s].buffer).setUint32(0, i + 1 < n ? order[i + 1] * BS : 0, true);
        this.sectors[s].set(data.subarray(i * (BS - 4), (i + 1) * (BS - 4)), 4);
      }),
    };
  }
  build(root: number): Uint8Array {
    const out = new Uint8Array(this.sectors.length * BS);
    this.sectors.forEach((s, i) => out.set(s, i * BS));
    const dv = new DataView(out.buffer);
    dv.setUint32(0x140, 0x5442, true);
    dv.setUint32(0x144, BS, true);
    dv.setUint32(0x148, out.length, true);
    dv.setUint32(0x14c, 1, true);
    dv.setUint32(0x160, root, true);
    return out;
  }
}

function node(branches: number[], entries: Array<{ id: number; offset: number; size: number }>): Uint8Array {
  const out = new Uint8Array(NODE_SIZE);
  const dv = new DataView(out.buffer);
  branches.forEach((b, i) => dv.setUint32(i * 4, b, true));
  dv.setUint32(62 * 4, entries.length, true);
  entries.forEach((e, i) => {
    const o = 62 * 4 + 4 + i * 24;
    dv.setUint32(o + 4, e.id, true);
    dv.setUint32(o + 8, e.offset, true);
    dv.setUint32(o + 12, e.size, true);
  });
  return out;
}

const payload = (id: number, size: number) => Uint8Array.from({ length: size }, (_, i) => (id + i * 7) & 0xff);

function buildSyntheticDat() {
  const b = new DatBuilder();
  const root = b.reserveChain(NODE_SIZE);
  const files = new Map<number, Uint8Array>([
    [0x06000001, payload(1, 10)],
    [0x06000005, payload(5, 500)],   // 9 sectors, scattered
    [0x06000010, payload(16, 130)],  // lives in the root node
    [0x06000020, payload(32, 60)],   // exactly one sector's payload
  ]);
  const at = new Map<number, number>();
  for (const [id, data] of files) at.set(id, b.writeChain(data, id === 0x06000005));
  const e = (id: number) => ({ id, offset: at.get(id)!, size: files.get(id)!.length });
  const left = b.writeChain(node([0], [e(0x06000001), e(0x06000005)]));
  const right = b.writeChain(node([0], [e(0x06000020)]), true);
  root.fill(node([left, right], [e(0x06000010)]));
  return { bytes: b.build(root.offset), files };
}

describe('RangedDat over a synthetic DAT', () => {
  const { bytes, files } = buildSyntheticDat();

  it('finds every file through the B-tree and reads its sector chain', async () => {
    const dat = await RangedDat.open(bufferFetcher(bytes));
    expect(dat.blockSize).toBe(BS);
    for (const [id, data] of files) {
      const got = await dat.getFileData(id);
      expect(got, `0x${id.toString(16)}`).not.toBeNull();
      expect(new Uint8Array(got!)).toEqual(data);
    }
  });

  it('agrees with DatDatabase, which reads the whole buffer', async () => {
    const db = new DatDatabase(bytes.slice().buffer);
    const dat = await RangedDat.open(bufferFetcher(bytes));
    for (const id of files.keys()) {
      expect(new Uint8Array((await dat.getFileData(id))!)).toEqual(new Uint8Array(db.getFileData(id)!));
    }
  });

  it('returns null for ids the DAT lacks, on either side of every entry', async () => {
    const dat = await RangedDat.open(bufferFetcher(bytes));
    for (const id of [0x06000000, 0x06000003, 0x06000007, 0x06000011, 0x06000021, 0x40000001]) {
      expect(await dat.findEntry(id)).toBeNull();
      expect(await dat.getFileData(id)).toBeNull();
    }
  });

  it('reads a consecutive chain in one request and follows a scattered one', async () => {
    const f = bufferFetcher(bytes);
    const dat = await RangedDat.open(f);
    const entry = (await dat.findEntry(0x06000010))!;
    f.calls.length = 0;
    await dat.readChain(entry.fileOffset, entry.fileSize);
    expect(f.calls).toHaveLength(1); // 130 bytes over 3 consecutive sectors
    const scattered = (await dat.findEntry(0x06000005))!;
    f.calls.length = 0;
    await dat.readChain(scattered.fileOffset, scattered.fileSize);
    expect(f.calls.length).toBeGreaterThan(1);
  });

  it('reads a directory node once for parallel lookups', async () => {
    const f = bufferFetcher(bytes);
    const dat = await RangedDat.open(f);
    await Promise.all([0x06000001, 0x06000005, 0x06000020].map((id) => dat.findEntry(id)));
    const rootOffset = new DataView(bytes.buffer).getUint32(0x160, true);
    expect(f.calls.filter(([o]) => o === rootOffset)).toHaveLength(1);
  });

  it('readSubset follows dependencies and leaves out missing ids', async () => {
    const dat = await RangedDat.open(bufferFetcher(bytes));
    const subset = await dat.readSubset([0x06000001, 0x06000099], (id) => (id === 0x06000001 ? [0x06000020] : []));
    expect(subset.fileIds.sort()).toEqual([0x06000001, 0x06000020]);
    expect(subset.hasFile(0x06000099)).toBe(false);
    expect(subset.getFileData(0x06000099)).toBeNull();
    expect(new Uint8Array(subset.getFileData(0x06000020)!)).toEqual(files.get(0x06000020));
  });

  it('readSubset coalesces neighbouring files into shared requests, byte-identical to per-file reads', async () => {
    const f = bufferFetcher(bytes);
    const dat = await RangedDat.open(f);
    const ids = [...files.keys()];
    await Promise.all(ids.map((id) => dat.findEntry(id))); // warm the directory
    f.calls.length = 0;
    const subset = await dat.readSubset(ids);
    // Every file sits within the default 256 KB gap: one data request, plus
    // the scattered chain's sectors that fall outside it (none here — the
    // whole synthetic DAT is one span).
    expect(f.calls).toHaveLength(1);
    for (const [id, data] of files) expect(new Uint8Array(subset.getFileData(id)!)).toEqual(data);
  });

  it('a chain leaving the coalesced span finishes from the network', async () => {
    const f = bufferFetcher(bytes);
    const dat = await RangedDat.open(f);
    const e = (await dat.findEntry(0x06000005))!;
    // Only the first sector prefetched: the scattered rest is fetched.
    const first = bytes.slice(e.fileOffset, e.fileOffset + BS);
    f.calls.length = 0;
    const got = await dat.readChain(e.fileOffset, e.fileSize, { start: e.fileOffset, bytes: first });
    expect(new Uint8Array(got)).toEqual(files.get(0x06000005));
    expect(f.calls.length).toBeGreaterThan(0);
  });

  it('rejects a header that is not a DAT', async () => {
    await expect(RangedDat.open(bufferFetcher(new Uint8Array(0x200)))).rejects.toThrow(/not a DAT header/);
  });
});

describe('httpRangeFetcher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a bytes= Range header and returns the 206 body', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    const got = await httpRangeFetcher('/client_portal.dat')(100, 3);
    expect([...got]).toEqual([1, 2, 3]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Range).toBe('bytes=100-102');
  });

  it('refuses a server that answers the whole file (200) without reading it', async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream({ pull() { /* never ends */ }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(httpRangeFetcher('/client_portal.dat')(0, 16)).rejects.toThrow(/not 206/);
    expect(cancel).toHaveBeenCalled();
  });
});

const PORTAL_DAT = resolve(__dirname, '../dat/client_portal.dat');

describe.skipIf(!existsSync(PORTAL_DAT))('RangedDat against the real portal.dat', () => {
  let bytes: Uint8Array;
  let db: DatDatabase;
  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    db = new DatDatabase(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  });

  it('the B-tree search finds the same entry as the full directory walk for every file', async () => {
    const dat = await RangedDat.open(bufferFetcher(bytes));
    const ids = db.listFileIds();
    expect(ids.length).toBeGreaterThan(50_000);
    for (let i = 0; i < ids.length; i += 1) {
      const e = await dat.findEntry(ids[i]);
      expect(e?.objectId).toBe(ids[i]);
    }
    expect(await dat.findEntry(0x06ffffff)).toBeNull();
  }, 60_000);

  it('reads the splash files byte-identical to DatDatabase in a few MB of requests', async () => {
    const f = bufferFetcher(bytes);
    const files = await loadPatchSplashFiles(f);
    // 39 distinct textures/fonts/sound table + 6 glyph sheets + the press wave(s).
    expect(files.fileIds.length).toBeGreaterThanOrEqual(new Set(PATCH_SPLASH_DAT_FILES).size + 7);
    for (const id of files.fileIds) {
      expect(new Uint8Array(files.getFileData(id)!)).toEqual(new Uint8Array(db.getFileData(id)!));
    }
    expect(f.bytesRead).toBeLessThan(6 * 1024 * 1024);
    // Header + the B-tree paths + coalesced file spans (28 on the EoL DAT).
    expect(f.calls.length).toBeLessThan(60);
  });

  it('the subset carries what the splash decodes: title image, meter frames, font glyph sheets, press wave', async () => {
    const files = await loadPatchSplashFiles(bufferFetcher(bytes));
    const title = Texture.read(new DatReader(files.getFileData(PATCH_TITLE_IMAGE)!));
    expect([title.width, title.height]).toEqual([800, 482]);
    for (const id of [...PATCH_METER_BG_FRAMES, ...PATCH_METER_OV_FRAMES]) expect(files.hasFile(id)).toBe(true);
    const font = ACFont.read(new DatReader(files.getFileData(PATCH_CANCEL_FONT)!));
    expect(files.hasFile(font.foregroundSurfaceDataId)).toBe(true);
    expect(files.hasFile(font.backgroundSurfaceDataId)).toBe(true);
    expect(files.hasFile(PATCH_CANCEL_PRESS_SOUND.table)).toBe(true);
    expect(files.fileIds.some((id) => id >>> 24 === 0x0a)).toBe(true);
  });
});
