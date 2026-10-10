import { DatReader } from './DatReader.js';
import type { DatFileEntry } from './DatDatabase.js';

/**
 * Reads individual files out of a DAT through byte-range requests, without
 * holding the whole DAT: the header, the B-tree nodes on the path to each id,
 * and each file's sector chain. Used to draw the patch screen (LayoutDesc
 * 0x21000000) from portal.dat's own art while the 900 MB file is still
 * downloading — retail's DATs are local, so its first frame is already the
 * DAT-drawn splash.
 *
 * Same container format as DatDatabase (ACE DatDatabase / DatDirectory /
 * DatReader.ReadDat): header at 0x140, directory nodes of 62 branches +
 * entry count + 61 × 24-byte entries read through a sector chain, and every
 * sector's first uint32 pointing at the next one (0 = last).
 *
 * Lookup walks the B-tree the way a B-tree is searched (ACE's
 * DatDirectory.Read collects every node instead; the entries within a node
 * are sorted by ObjectId, and branch i holds the ids between entries i-1 and
 * i), so an id costs one node per level.
 */

/** Returns `length` bytes starting at `offset` (fewer only at end of file). */
export type RangeFetcher = (offset: number, length: number) => Promise<Uint8Array>;

/** The two reads the texture / font / sound consumers make of a DAT. */
export interface DatFileSource {
  getFileData(fileId: number): ArrayBuffer | null;
  hasFile(fileId: number): boolean;
}

const DAT_HEADER_OFFSET = 0x140;
/** FileType .. BTreeRoot: the header fields a lookup needs. */
const HEADER_READ_END = DAT_HEADER_OFFSET + 9 * 4;
const DIR_BRANCH_COUNT = 62;
const DAT_FILE_ENTRY_SIZE = 24;
const DIR_NODE_SIZE = DIR_BRANCH_COUNT * 4 + 4 + 61 * DAT_FILE_ENTRY_SIZE; // 1716

interface DirNode {
  branches: number[];
  entries: DatFileEntry[];
}

/** A fixed set of files already read out of a DAT. */
export class DatFileSubset implements DatFileSource {
  constructor(private readonly files: ReadonlyMap<number, ArrayBuffer>) {}

  getFileData(fileId: number): ArrayBuffer | null {
    return this.files.get(fileId >>> 0) ?? null;
  }

  hasFile(fileId: number): boolean {
    return this.files.has(fileId >>> 0);
  }

  get fileIds(): number[] {
    return [...this.files.keys()];
  }
}

export class RangedDat {
  private readonly nodes = new Map<number, Promise<DirNode>>();

  private constructor(
    private readonly fetchRange: RangeFetcher,
    readonly blockSize: number,
    readonly bTreeRoot: number,
  ) {}

  static async open(fetchRange: RangeFetcher): Promise<RangedDat> {
    const head = await fetchRange(0, HEADER_READ_END);
    if (head.length < HEADER_READ_END) throw new Error('DAT header truncated');
    const r = new DatReader(head.buffer.slice(head.byteOffset, head.byteOffset + head.length) as ArrayBuffer, DAT_HEADER_OFFSET);
    r.readUInt32(); // FileType
    const blockSize = r.readUInt32();
    for (let i = 0; i < 6; i++) r.readUInt32(); // FileSize .. FreeCount
    const bTreeRoot = r.readUInt32();
    if (blockSize <= 4 || bTreeRoot === 0) throw new Error(`not a DAT header (blockSize ${blockSize}, root ${bTreeRoot})`);
    return new RangedDat(fetchRange, blockSize, bTreeRoot);
  }

  /**
   * Read `size` bytes of a sector chain starting at `offset`. Each request
   * asks for enough whole sectors to finish the chain, so a chain whose
   * sectors are consecutive (the usual layout) costs one request; a jump
   * starts a new request at the next sector. `prefetched` (bytes already
   * read from `prefetched.start`) serves every sector it covers.
   */
  async readChain(offset: number, size: number, prefetched?: { start: number; bytes: Uint8Array }): Promise<ArrayBuffer> {
    const bs = this.blockSize;
    const payload = bs - 4;
    const out = new Uint8Array(size);
    let written = 0;
    let pos = offset;
    while (written < size) {
      let run: Uint8Array;
      let runStart: number;
      if (prefetched && pos >= prefetched.start && pos + 4 <= prefetched.start + prefetched.bytes.length) {
        run = prefetched.bytes;
        runStart = prefetched.start;
      } else {
        run = await this.fetchRange(pos, Math.ceil((size - written) / payload) * bs);
        runStart = pos;
      }
      const view = new DataView(run.buffer, run.byteOffset, run.byteLength);
      let p = pos - runStart;
      for (;;) {
        const n = Math.min(payload, size - written);
        if (p + 4 + n > run.length) {
          if (run === prefetched?.bytes) { prefetched = undefined; break; } // finish from the network
          throw new Error(`DAT sector at ${runStart + p} is truncated`);
        }
        const next = view.getUint32(p, true);
        out.set(run.subarray(p + 4, p + 4 + n), written);
        written += n;
        if (written >= size) break;
        if (next === 0) throw new Error(`DAT sector chain at ${offset} ends ${size - written} bytes early`);
        pos = next;
        if (next === runStart + p + bs && p + bs < run.length) {
          p += bs;
          continue;
        }
        break;
      }
    }
    return out.buffer;
  }

  private readNode(offset: number): Promise<DirNode> {
    let node = this.nodes.get(offset);
    if (!node) {
      node = this.readChain(offset, DIR_NODE_SIZE).then((data) => {
        const r = new DatReader(data);
        const branches: number[] = [];
        for (let i = 0; i < DIR_BRANCH_COUNT; i++) branches.push(r.readUInt32());
        const entryCount = r.readUInt32();
        const entries: DatFileEntry[] = [];
        for (let i = 0; i < entryCount; i++) {
          entries.push({
            bitFlags: r.readUInt32(),
            objectId: r.readUInt32(),
            fileOffset: r.readUInt32(),
            fileSize: r.readUInt32(),
            date: r.readUInt32(),
            iteration: r.readUInt32(),
          });
        }
        return { branches, entries };
      });
      node.catch(() => this.nodes.delete(offset));
      this.nodes.set(offset, node);
    }
    return node;
  }

  /** The directory entry for `fileId`, or null when the DAT has no such file. */
  async findEntry(fileId: number): Promise<DatFileEntry | null> {
    const id = fileId >>> 0;
    let offset = this.bTreeRoot;
    for (;;) {
      const node = await this.readNode(offset);
      let i = 0;
      while (i < node.entries.length && node.entries[i].objectId < id) i++;
      if (i < node.entries.length && node.entries[i].objectId === id) return node.entries[i];
      if (node.branches[0] === 0) return null;
      offset = node.branches[i];
    }
  }

  /** The file's bytes, or null when the DAT has no such file. */
  async getFileData(fileId: number): Promise<ArrayBuffer | null> {
    const entry = await this.findEntry(fileId);
    return entry ? this.readChain(entry.fileOffset, entry.fileSize) : null;
  }

  /**
   * Read a set of files. `dependenciesOf` names the further files a read file
   * needs (a font's glyph sheets, a sound's waves); they are read in turn
   * until nothing new is named. Ids the DAT lacks are left out.
   *
   * The ids' directory entries are looked up in parallel, then files lying
   * within `coalesceGap` bytes of each other are read with one request (the
   * splash's 30 meter frames sit side by side), so a set costs a handful of
   * requests instead of one or more per file.
   */
  async readSubset(
    fileIds: Iterable<number>,
    dependenciesOf: (fileId: number, data: ArrayBuffer) => Iterable<number> = () => [],
    coalesceGap = 256 * 1024,
  ): Promise<DatFileSubset> {
    const files = new Map<number, ArrayBuffer>();
    const seen = new Set<number>();
    let wave = [...fileIds].map((id) => id >>> 0);
    while (wave.length > 0) {
      const todo = wave.filter((id) => id !== 0 && !seen.has(id));
      todo.forEach((id) => seen.add(id));
      const entries = (await Promise.all(todo.map((id) => this.findEntry(id))))
        .filter((e): e is DatFileEntry => e !== null)
        .sort((a, b) => a.fileOffset - b.fileOffset);
      // Spans of whole sectors, merged across gaps up to coalesceGap.
      const groups: Array<{ start: number; end: number; entries: DatFileEntry[] }> = [];
      for (const e of entries) {
        const end = e.fileOffset + Math.ceil(e.fileSize / (this.blockSize - 4)) * this.blockSize;
        const last = groups[groups.length - 1];
        if (last && e.fileOffset - last.end <= coalesceGap) {
          last.end = Math.max(last.end, end);
          last.entries.push(e);
        } else {
          groups.push({ start: e.fileOffset, end, entries: [e] });
        }
      }
      const read = await Promise.all(groups.map(async (g) => {
        const bytes = await this.fetchRange(g.start, g.end - g.start);
        return Promise.all(g.entries.map(async (e) =>
          [e.objectId, await this.readChain(e.fileOffset, e.fileSize, { start: g.start, bytes })] as const));
      }));
      wave = [];
      for (const [id, data] of read.flat()) {
        files.set(id, data);
        for (const dep of dependenciesOf(id, data)) wave.push(dep >>> 0);
      }
    }
    return new DatFileSubset(files);
  }
}

/**
 * How many times a range read is sent before an answer that ignored the
 * range is final. Only a server that says it serves ranges (Accept-Ranges:
 * bytes) on that answer is retried: dats.playwebac.com (R2 behind
 * Cloudflare) answered about 1 in 7 of client_portal.dat's ranges with the
 * whole 927 MB file under a 200 (2026-10-06), and the splash read makes
 * dozens of ranges, so one such answer used to cost the whole splash.
 */
export const RANGE_FETCH_ATTEMPTS = 5;

/**
 * A RangeFetcher over HTTP `Range: bytes=` requests. A server that answers
 * with the whole file (200 instead of 206) is refused before its body is
 * read — the caller falls back to the full download. One that advertises
 * ranges and only sometimes ignores them, or a dropped connection, is asked
 * again first.
 */
export function httpRangeFetcher(url: string, signal?: AbortSignal): RangeFetcher {
  return async (offset, length) => {
    for (let attempt = 1; ; attempt++) {
      // no-store: Chrome keeps a cached 206 as a sparse entry and can answer a
      // later full GET of the same URL with ONLY those bytes under a 200
      // (seen on R2 objects with Cache-Control: immutable, 2026-10-04).
      let resp: Response;
      try {
        resp = await fetch(url, {
          cache: 'no-store',
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        // A dropped connection is asked again; an abort (the patch's Cancel) is final.
        if (signal?.aborted || (e as { name?: string }).name === 'AbortError' || attempt >= RANGE_FETCH_ATTEMPTS) throw e;
        continue;
      }
      if (resp.status === 206) return new Uint8Array(await resp.arrayBuffer());
      await resp.body?.cancel().catch(() => undefined);
      const servesRanges = /\bbytes\b/i.test(resp.headers.get('accept-ranges') ?? '');
      if (!resp.ok || !servesRanges || attempt >= RANGE_FETCH_ATTEMPTS) {
        throw new Error(`${url}: range request answered ${resp.status}, not 206`);
      }
    }
  };
}
