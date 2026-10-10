import { DatReader } from './DatReader.js';
import { Iteration, ITERATION_FILE_ID } from './file-types/Iteration.js';
import type { DatFileSource } from './RangedDat.js';

/**
 * Header offset in the DAT file — from ACE: DAT_HEADER_OFFSET = 0x140
 */
const DAT_HEADER_OFFSET = 0x140;

/**
 * The pre-Throne-of-Destiny container (the 1999–2005 retail CDs): header at
 * 0x12C = FileType 0x5442, BlockSize, FileSize, Iteration, FreeHead, FreeTail,
 * FreeCount, BTreeRoot (no DataSet / LRU / version fields), 12-byte directory
 * entries (ObjectId, FileOffset, FileSize) and no 0xFFFF0001 Iteration record:
 * the DAT version is the header Iteration (1999 retail CD: portal 102, cell 67).
 * Measured on the retail CD, docs/ac1999-support.md; bDekaru's Melt agrees.
 */
const PRE_TOD_HEADER_OFFSET = 0x12c;
const DAT_FILE_TYPE = 0x5442; // "BT"
const PRE_TOD_FILE_ENTRY_SIZE = 12;

/** Which container layout a DAT uses. */
export type DatContainer = 'tod' | 'pre-tod';

/**
 * B-tree directory node constants from DatDirectoryHeader.cs:
 * - 62 branch pointers (uint32 each)
 * - 1 entry count (uint32)
 * - 61 file entries (24 bytes each = 6 × uint32)
 * Total: 62*4 + 4 + 61*24 = 248 + 4 + 1464 = 1716 bytes
 */
const DIR_BRANCH_COUNT = 62;    // 0x3E
const DIR_MAX_ENTRIES = 61;     // 0x3D
const DAT_FILE_ENTRY_SIZE = 24; // 6 × uint32
const DIR_NODE_SIZE = (DIR_BRANCH_COUNT * 4) + 4 + (DIR_MAX_ENTRIES * DAT_FILE_ENTRY_SIZE); // 1716
const PRE_TOD_DIR_NODE_SIZE = (DIR_BRANCH_COUNT * 4) + 4 + (DIR_MAX_ENTRIES * PRE_TOD_FILE_ENTRY_SIZE); // 984

/**
 * Rewrites what a DAT serves, file by file, without touching the container:
 * the server's DAT patches (AC1999 0xF7B7) and the 1999 → end-of-retail format
 * translation (dat-parser era1999/) plug in here, so every parser and renderer
 * keeps reading end-of-retail formats. Absent (the default), reads are
 * unchanged.
 */
export interface DatOverlay {
  /** Bytes to serve for `id`, or undefined to serve the container's own (`base`). */
  get(id: number, base: (id: number) => ArrayBuffer | null): ArrayBuffer | null | undefined;
  /** Whether `id` exists; `baseHas` answers for the container (any id). */
  has(id: number, baseHas: (id: number) => boolean): boolean;
  /** Extra ids the overlay serves that the container lacks (optionally of one type prefix); `baseIds` lists the container's. */
  extraIds(typePrefix: number | undefined, baseIds: (typePrefix?: number) => number[]): number[];
  /** The DAT version to report instead of the container's (a server's patch stamps its own). */
  readonly iteration?: number;
  /**
   * The file's bytes BEFORE format translation (a server patch, else the
   * container's), or undefined for the container's own. Only for data the
   * translated format has no slot for (era1999 readCharGen1999Text).
   */
  getRaw?(id: number, base: (id: number) => ArrayBuffer | null): ArrayBuffer | null | undefined;
  /** What the overlay serves (e.g. 'ac1999': the 1999 world in end-of-retail formats); see DatDatabase.overlayKind. */
  readonly kind?: string;
}

export interface DatFileEntry {
  bitFlags: number;
  objectId: number;
  fileOffset: number;
  fileSize: number;
  date: number;
  iteration: number;
}

export interface DatHeader {
  fileType: number;
  blockSize: number;
  fileSize: number;
  dataSet: number;
  dataSubset: number;
  freeHead: number;
  freeTail: number;
  freeCount: number;
  bTreeRoot: number;
  newLRU: number;
  oldLRU: number;
  useLRU: boolean;
  masterMapId: number;
  enginePackVersion: number;
  gamePackVersion: number;
  versionMajor: Uint8Array;
  versionMinor: number;
}

/**
 * Synchronous random access to a DAT's bytes. The browser hands DatDatabase
 * the whole file as an ArrayBuffer; Node tools and tests can pass a
 * file-backed source instead (dat-parser/src/node/FileDatBytes.ts), so a
 * 900 MB portal.dat costs a directory map, not 900 MB per process.
 */
export interface DatBytes {
  readonly byteLength: number;
  /** Copy `length` bytes at `offset` into `dest` starting at `destOffset`. */
  read(offset: number, dest: Uint8Array, destOffset: number, length: number): void;
}

/** DatBytes over an in-memory ArrayBuffer. */
export class ArrayBufferDatBytes implements DatBytes {
  private readonly u8: Uint8Array;
  constructor(buffer: ArrayBuffer) { this.u8 = new Uint8Array(buffer); }
  get byteLength(): number { return this.u8.byteLength; }
  read(offset: number, dest: Uint8Array, destOffset: number, length: number): void {
    dest.set(this.u8.subarray(offset, offset + length), destOffset);
  }
}

/**
 * A DAT served from a resident-file map instead of a container image: the
 * streamed DAT set (renderer dat/streaming, docs/dat-streaming.md §3.1).
 * Reads stay synchronous; a file that exists but is not resident yet reads
 * as null (the source enqueues its fetch and notes the miss).
 */
export interface DatResidentSource {
  readonly kind: 'resident';
  /** The header fields the getters expose (the container header is not shipped). */
  readonly header: { blockSize: number; dataSet: number; dataSubset: number; masterMapId: number };
  /** The file's bytes (a fresh copy the caller may keep), or null when absent or not resident. */
  get(fileId: number): ArrayBuffer | null;
  /** Whether the file exists in the DAT (resident or not). */
  has(fileId: number): boolean;
  /** Ids known to exist, optionally of one type prefix (high byte). */
  listIds(typePrefix?: number): number[];
  /** Number of files known to exist. */
  readonly count: number;
  /** Uncompressed size of a known file, or -1 when unknown. */
  sizeOf(fileId: number): number;
}

function isDatBytes(x: ArrayBuffer | ArrayBufferView | DatBytes | DatResidentSource): x is DatBytes {
  return typeof (x as DatBytes).read === 'function' && !ArrayBuffer.isView(x);
}

function isResident(x: ArrayBuffer | ArrayBufferView | DatBytes | DatResidentSource): x is DatResidentSource {
  return (x as DatResidentSource).kind === 'resident';
}

export class DatDatabase implements DatFileSource {
  /** In-memory DAT (the browser path): the original direct-copy reads, unchanged. */
  private buffer: ArrayBuffer | null = null;
  private view: DataView | null = null;
  private bytes: DatBytes;
  private header: DatHeader;
  private files: Map<number, DatFileEntry> = new Map();
  /** One sector's worth of scratch for readSectorChain. */
  private sector = new Uint8Array(0);
  /** Streamed DAT: every read goes to the resident source (no container, no directory). */
  private readonly resident: DatResidentSource | null = null;
  /** Which container layout the file uses (detected from the header position). */
  readonly container: DatContainer = 'tod';
  /** Pre-ToD only: the header Iteration (the DAT version; there is no 0xFFFF0001 record). */
  private headerIteration = 0;
  private overlay: DatOverlay | null = null;

  constructor(source: ArrayBuffer | ArrayBufferView | DatBytes | DatResidentSource) {
    if (isResident(source)) {
      this.resident = source;
      this.bytes = { byteLength: 0, read: () => { throw new Error('streamed DAT has no container bytes'); } };
      this.header = {
        fileType: 0x5442, blockSize: source.header.blockSize, fileSize: 0, dataSet: source.header.dataSet,
        dataSubset: source.header.dataSubset, freeHead: 0, freeTail: 0, freeCount: 0, bTreeRoot: 0, newLRU: 0,
        oldLRU: 0, useLRU: false, masterMapId: source.header.masterMapId, enginePackVersion: 0, gamePackVersion: 0,
        versionMajor: new Uint8Array(16), versionMinor: 0,
      };
      return;
    }
    if (isDatBytes(source)) {
      this.bytes = source;
    } else {
      // An ArrayBuffer, or a Node Buffer / Uint8Array viewed without copying.
      const buffer = ArrayBuffer.isView(source)
        ? (source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
          ? source.buffer as ArrayBuffer
          : (source.buffer as ArrayBuffer).slice(source.byteOffset, source.byteOffset + source.byteLength))
        : source;
      this.buffer = buffer;
      this.view = new DataView(buffer);
      this.bytes = new ArrayBufferDatBytes(buffer);
    }
    this.container = this.detectContainer();
    this.header = this.container === 'pre-tod' ? this.readPreTodHeader() : this.readHeader();
    this.readDirectory(this.header.bTreeRoot);
  }

  /** ToD when FileType sits at 0x140 (checked first, so a ToD file is never misread),
   *  pre-ToD when it sits at 0x12C, else ToD as before (its header read decides). */
  private detectContainer(): DatContainer {
    if (this.bytes.byteLength < DAT_HEADER_OFFSET + 8) return 'tod';
    const word = new Uint8Array(4);
    const u32 = (off: number): number => {
      this.bytes.read(off, word, 0, 4);
      return new DataView(word.buffer).getUint32(0, true);
    };
    if (u32(DAT_HEADER_OFFSET) === DAT_FILE_TYPE) return 'tod';
    if (u32(PRE_TOD_HEADER_OFFSET) === DAT_FILE_TYPE) return 'pre-tod';
    return 'tod';
  }

  /** The pre-ToD header. DataSet is not stored; it follows from BlockSize as in
   *  every retail set (0x400 portal = 1, 0x100 cell = 2) so role checks still work. */
  private readPreTodHeader(): DatHeader {
    const head = new Uint8Array(32);
    this.bytes.read(PRE_TOD_HEADER_OFFSET, head, 0, head.length);
    const r = new DatReader(head.buffer);
    const fileType = r.readUInt32();
    const blockSize = r.readUInt32();
    const fileSize = r.readUInt32();
    this.headerIteration = r.readUInt32();
    const freeHead = r.readUInt32();
    const freeTail = r.readUInt32();
    const freeCount = r.readUInt32();
    const bTreeRoot = r.readUInt32();
    return {
      fileType, blockSize, fileSize, dataSet: blockSize === 0x400 ? 1 : blockSize === 0x100 ? 2 : 0,
      dataSubset: 0, freeHead, freeTail, freeCount, bTreeRoot, newLRU: 0, oldLRU: 0, useLRU: false,
      masterMapId: 0, enginePackVersion: 0, gamePackVersion: 0, versionMajor: new Uint8Array(16), versionMinor: 0,
    };
  }

  /** Serve some files from an overlay (server patches, era format translation); null removes it. */
  setOverlay(overlay: DatOverlay | null): void {
    this.overlay = overlay;
  }

  /** The installed overlay's kind (DatOverlay.kind), or null without one. */
  get overlayKind(): string | null {
    return this.overlay?.kind ?? null;
  }

  get blockSize(): number {
    return this.header.blockSize;
  }

  get fileCount(): number {
    if (this.resident) return this.resident.count;
    return this.files.size;
  }

  get dataSet(): number {
    return this.header.dataSet;
  }

  /** Header DataSubset (offset 0x150): portal 0, cell 1, local_English 1 in
   *  the EoL DATs. With dataSet it forms the DAT's 64-bit iteration-list tag
   *  in DDD_InterrogationResponse. */
  get dataSubset(): number {
    return this.header.dataSubset;
  }

  /** Header MasterMapID (offset 0x170) — DBCache::m_MasterMapID, the DidMapper
   *  of DidMappers (0x25000000 in the EoL portal.dat). */
  get masterMapId(): number {
    return this.header.masterMapId;
  }

  /** Maximum per-entry iteration value across all files. NOT the DAT version
   *  (ACE DatDatabase.Iteration reads file 0xFFFF0001) — use totalIterations. */
  get maxIteration(): number {
    let max = 0;
    if (this.resident) return 0;
    for (const entry of this.files.values()) {
      if (entry.iteration > max) max = entry.iteration;
    }
    return max;
  }

  /** The parsed Iteration record (0xFFFF0001), or null when the DAT has none
   *  or it is unreadable. ACE DatDatabase reads it via ReadFromDat<Iteration>. */
  get iteration(): Iteration | null {
    const data = this.getFileData(ITERATION_FILE_ID);
    if (!data) return null;
    try {
      return new Iteration(new DatReader(data));
    } catch {
      return null;
    }
  }

  /** Total iterations from the Iteration file (0xFFFF0001) — ACE
   *  DatDatabase.GetTotalIterations (DatDatabase.cs ~153-166): TotalIterations
   *  when > 0 (an incomplete dat, Ints.Count > 1, is only logged, still
   *  returned), otherwise 0. No max-per-file fallback: the per-entry iteration
   *  max is NOT the DAT version (cell_1 EoL: max 538 vs Iteration 982), and
   *  a wrong value here is what DDD_InterrogationResponse would report. */
  get totalIterations(): number {
    if (this.overlay?.iteration !== undefined) return this.overlay.iteration;
    if (this.container === 'pre-tod') return this.headerIteration;
    const it = this.iteration;
    if (!it || it.totalIterations <= 0) {
      console.error('[DatDatabase] Unable to read iteration from dat');
      return 0;
    }
    if (!it.isComplete) console.error('[DatDatabase] dat contains an incomplete dat file!');
    return it.totalIterations;
  }

  private readHeader(): DatHeader {
    const head = new Uint8Array(0x60);
    this.bytes.read(DAT_HEADER_OFFSET, head, 0, head.length);
    const r = new DatReader(head.buffer);
    return {
      fileType: r.readUInt32(),
      blockSize: r.readUInt32(),
      fileSize: r.readUInt32(),
      dataSet: r.readUInt32(),
      dataSubset: r.readUInt32(),
      freeHead: r.readUInt32(),
      freeTail: r.readUInt32(),
      freeCount: r.readUInt32(),
      bTreeRoot: r.readUInt32(),
      newLRU: r.readUInt32(),
      oldLRU: r.readUInt32(),
      useLRU: r.readUInt32() === 1,
      masterMapId: r.readUInt32(),
      enginePackVersion: r.readUInt32(),
      gamePackVersion: r.readUInt32(),
      versionMajor: r.readBytes(16),
      versionMinor: r.readUInt32(),
    };
  }

  /**
   * Read data following sector chain links.
   * From DatReader.cs ReadDat():
   * - First 4 bytes of each sector = pointer to next sector (0 = last)
   * - Remaining blockSize-4 bytes = actual data
   */
  /** Pre-ToD sector links carry a flag in bit 31 (free blocks set it; KB DatFiles,
   *  Melt datFile.cs), so the link is the low 31 bits. ToD links are used as is. */
  private get nextMask(): number {
    return this.container === 'pre-tod' ? 0x7fffffff : 0xffffffff;
  }

  private readSectorChain(offset: number, size: number): ArrayBuffer {
    return this.buffer ? this.readSectorChainInMemory(offset, size) : this.readSectorChainFromBytes(offset, size);
  }

  /** The in-memory read (browser): each sector's data copied straight out of the buffer. */
  private readSectorChainInMemory(offset: number, size: number): ArrayBuffer {
    const buffer = this.buffer!;
    const view = this.view!;
    const bs = this.header.blockSize;
    const result = new Uint8Array(size);
    let bufferOffset = 0;
    let remaining = size;
    let pos = offset;
    let nextAddress = view.getUint32(pos, true);
    pos += 4;
    while (remaining > 0) {
      if (nextAddress === 0) {
        result.set(new Uint8Array(buffer, pos, remaining), bufferOffset);
        remaining = 0;
      } else {
        const chunkSize = bs - 4;
        result.set(new Uint8Array(buffer, pos, chunkSize), bufferOffset);
        bufferOffset += chunkSize;
        remaining -= chunkSize;
        pos = nextAddress & this.nextMask;
        nextAddress = view.getUint32(pos, true);
        pos += 4;
      }
    }
    return result.buffer;
  }

  /** The on-demand read (Node FileDatBytes): one sector per read into scratch. */
  private readSectorChainFromBytes(offset: number, size: number): ArrayBuffer {
    const bs = this.header.blockSize;
    if (this.sector.length !== bs) this.sector = new Uint8Array(bs);
    const sector = this.sector;
    const sv = new DataView(sector.buffer);
    const result = new Uint8Array(size);
    let bufferOffset = 0;
    let remaining = size;
    let pos = offset;
    while (remaining > 0) {
      // Each sector: uint32 next-sector pointer (0 = last), then blockSize-4 data bytes.
      const want = Math.min(bs, 4 + remaining);
      this.bytes.read(pos, sector, 0, want);
      const nextAddress = sv.getUint32(0, true);
      if (nextAddress === 0 && remaining > bs - 4) {
        // Last sector but more bytes than it holds: read them contiguously, as ACE ReadDat does.
        this.bytes.read(pos + 4, result, bufferOffset, remaining);
        break;
      }
      const chunk = nextAddress === 0 ? remaining : Math.min(bs - 4, remaining);
      result.set(sector.subarray(4, 4 + chunk), bufferOffset);
      bufferOffset += chunk;
      remaining -= chunk;
      if (nextAddress === 0) break;
      pos = nextAddress & this.nextMask;
    }
    return result.buffer;
  }

  /**
   * Recursively read B-tree directory nodes.
   * From DatDirectory.cs Read():
   * - Read node data via sector chain (size = DIR_NODE_SIZE)
   * - Parse: 62 branches, entryCount, entries[entryCount]
   * - If branches[0] != 0, recurse into entryCount+1 children
   */
  private readDirectory(sectorOffset: number): void {
    // Read the directory node data via sector chain
    const preTod = this.container === 'pre-tod';
    const nodeData = this.readSectorChain(sectorOffset, preTod ? PRE_TOD_DIR_NODE_SIZE : DIR_NODE_SIZE);
    const r = new DatReader(nodeData);

    // Read 62 branch pointers
    const branches: number[] = [];
    for (let i = 0; i < DIR_BRANCH_COUNT; i++) {
      branches.push(r.readUInt32());
    }

    // Read entry count
    const entryCount = r.readUInt32();

    // Read file entries
    const entries: DatFileEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      if (preTod) {
        const objectId = r.readUInt32();
        const fileOffset = r.readUInt32();
        const fileSize = r.readUInt32();
        entries.push({ bitFlags: 0, objectId, fileOffset, fileSize, date: 0, iteration: 0 });
        continue;
      }
      entries.push({
        bitFlags: r.readUInt32(),
        objectId: r.readUInt32(),
        fileOffset: r.readUInt32(),
        fileSize: r.readUInt32(),
        date: r.readUInt32(),
        iteration: r.readUInt32(),
      });
    }

    // If non-leaf node, recurse into children
    if (branches[0] !== 0) {
      for (let i = 0; i < entryCount + 1; i++) {
        this.readDirectory(branches[i]);
      }
    }

    // Add all entries to the file map
    for (const entry of entries) {
      this.files.set(entry.objectId, entry);
    }
  }

  /**
   * Get raw file data by object ID.
   * Returns null if file not found.
   */
  getFileData(fileId: number): ArrayBuffer | null {
    if (this.overlay) {
      const served = this.overlay.get(fileId >>> 0, (id) => this.getBaseFileData(id));
      if (served !== undefined) return served;
    }
    return this.getBaseFileData(fileId);
  }

  /**
   * A file's bytes before the overlay's format translation (a server patch,
   * else the container's). Without an overlay, the same as getFileData.
   */
  getUntranslatedFileData(fileId: number): ArrayBuffer | null {
    const raw = this.overlay?.getRaw?.(fileId >>> 0, (id) => this.getBaseFileData(id));
    return raw !== undefined ? raw : this.getBaseFileData(fileId);
  }

  /** The container's own bytes for a file (no overlay). */
  private getBaseFileData(fileId: number): ArrayBuffer | null {
    if (this.resident) return this.resident.get(fileId >>> 0);
    const entry = this.files.get(fileId >>> 0);
    if (!entry) return null;
    return this.readSectorChain(entry.fileOffset, entry.fileSize);
  }

  /**
   * Get a DatReader positioned at the start of a file's data.
   */
  getReader(fileId: number): DatReader {
    const data = this.getFileData(fileId);
    if (!data) throw new Error(`File ID 0x${(fileId >>> 0).toString(16).padStart(8, '0')} not found in DAT`);
    return new DatReader(data);
  }

  /**
   * List all file IDs, optionally filtered by type prefix (high byte).
   * If no prefix given, returns all IDs.
   */
  listFileIds(typePrefix?: number): number[] {
    const base = this.listBaseFileIds(typePrefix);
    if (!this.overlay) return base;
    const extra = this.overlay.extraIds(typePrefix, (p) => this.listBaseFileIds(p)).filter((id) => !this.hasBaseFile(id));
    return extra.length ? base.concat(extra) : base;
  }

  private listBaseFileIds(typePrefix?: number): number[] {
    if (this.resident) return this.resident.listIds(typePrefix);
    if (typePrefix === undefined) {
      return Array.from(this.files.keys());
    }

    const ids: number[] = [];
    for (const id of this.files.keys()) {
      if (((id >>> 24) & 0xff) === typePrefix) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Check if a file ID exists in this database.
   */
  hasFile(fileId: number): boolean {
    if (!this.overlay) return this.hasBaseFile(fileId);
    return this.overlay.has(fileId >>> 0, (id) => this.hasBaseFile(id));
  }

  private hasBaseFile(fileId: number): boolean {
    if (this.resident) return this.resident.has(fileId >>> 0);
    return this.files.has(fileId >>> 0);
  }

  /**
   * Get the file entry metadata for a given ID.
   */
  getFileEntry(fileId: number): DatFileEntry | undefined {
    if (this.overlay && !this.hasBaseFile(fileId) && this.overlay.has(fileId >>> 0, (id) => this.hasBaseFile(id))) {
      const data = this.getFileData(fileId);
      return data ? { bitFlags: 0, objectId: fileId >>> 0, fileOffset: 0, fileSize: data.byteLength, date: 0, iteration: 0 } : undefined;
    }
    if (this.resident) {
      const id = fileId >>> 0;
      const size = this.resident.sizeOf(id);
      return size < 0 ? undefined : { bitFlags: 0, objectId: id, fileOffset: 0, fileSize: size, date: 0, iteration: 0 };
    }
    return this.files.get(fileId >>> 0);
  }
}
