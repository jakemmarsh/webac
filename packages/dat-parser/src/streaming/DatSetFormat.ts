/**
 * The published DAT-set formats (docs/dat-streaming.md §3.2), read side.
 * The write side, and the authority on every byte here, is
 * tools/publish-dats-r2.ts (its header comment documents the layout).
 *
 *   v1/sets/<set>.json   the set pointer (JSON, the only mutable key)
 *   v1/o/<hash>          gzip(payload), hash = first 8 bytes of sha256(payload), hex
 *
 * Payloads:
 *   pack      "ACPK" u32 count, count × (u32 id, u32 offset, u32 size), then the files
 *             (offsets from the end of the index)
 *   bundle    a pack of one landblock's LandblockInfo 0xXXYYFFFE + all its EnvCells
 *   manifest  "ACDM" u32 format=1, u32 sectionCount, then sections
 *             (u8 kind, u8 dat, u16 reserved, u32 count, entries):
 *               kind 1 leaves:  count × (u32 id, u32 size, u32 gzSize, 8-byte hash)
 *               kind 2 packs:   count × (u8 role, 3 pad, u32 size, u32 gzSize, u32 files, 8-byte hash)
 *               kind 3 bundles: count × (u16 landblock, 2 pad, u32 size, u32 gzSize, 8-byte hash)
 *   area index  (RELEASE.streaming-area-packs; named by the pointer's optional `areas`)
 *             "ACAI" u32 format=1, u32 tileSize, u32 count,
 *             the common pack: u32 size, u32 gzSize, u32 files, 8-byte hash (all zero: none),
 *             count × (u16 tile, 2 pad, u32 size, u32 gzSize, 8-byte hash)
 *             tile = (x / tileSize) << 8 | (y / tileSize) for landblock 0xXXYY
 *   area      an "ACPK" pack of portal leaves: every leaf the landblocks of one
 *             tileSize × tileSize tile read (DatClosure.ensureLandblock + the world DB's
 *             static objects and their generators' spawns there) that is not in the
 *             common pack (the leaves very many landblocks share: trees, rocks)
 *
 * Pure parsing, no I/O: shared by the browser's streaming store and Node tests/tools.
 */

export type DatName = 'portal' | 'cell' | 'local' | 'highres';
export const DAT_NAMES: readonly DatName[] = ['portal', 'cell', 'local', 'highres'];
/** Manifest `dat` byte (tools/publish-dats-r2.ts DAT_CODE). */
export const DAT_CODE: Readonly<Record<DatName, number>> = { portal: 1, cell: 2, local: 3, highres: 4 };
const DAT_BY_CODE: Record<number, DatName> = { 1: 'portal', 2: 'cell', 3: 'local', 4: 'highres' };

export type PackRole = 'boot' | 'world' | 'skeleton' | 'terrain' | 'local' | 'ui';
/** Manifest `role` byte (tools/publish-dats-r2.ts ROLE). */
export const PACK_ROLE_CODE: Readonly<Record<PackRole, number>> = { boot: 1, world: 2, skeleton: 3, terrain: 4, local: 5, ui: 6 };
const ROLE_BY_CODE: Record<number, PackRole> = { 1: 'boot', 2: 'world', 3: 'skeleton', 4: 'terrain', 5: 'local', 6: 'ui' };
/** Which DAT each pack's files belong to. */
export const PACK_DAT: Readonly<Record<PackRole, DatName>> = { boot: 'portal', world: 'portal', skeleton: 'portal', terrain: 'cell', local: 'local', ui: 'portal' };

/**
 * Portal file types shipped in the skeleton pack (small structural files:
 * Setups, Surfaces, SurfaceTextures, MotionTables, tables, fonts …); every
 * other portal type (GfxObj 0x01, Animation 0x03, Palette 0x04, Texture 0x06,
 * Wave 0x0A, Environment 0x0D) is a per-file leaf. tools/publish-dats-r2.ts
 * and tools/dat-access-sim.ts both use this list.
 */
export const SKELETON_TYPES: ReadonlySet<number> = new Set([0x02, 0x05, 0x08, 0x09, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x20, 0x22, 0x25, 0x26, 0x27, 0x30, 0x31, 0x32, 0x33, 0x34, 0x39, 0x40, 0x78, 0xFF]);

/** One content-addressed object. */
export interface ObjectRef {
  /** 16 hex chars (first 8 bytes of sha256(payload)). */
  hash: string;
  /** Uncompressed payload bytes. */
  size: number;
  /** Stored (gzip) bytes. */
  gzSize: number;
}

/** The DAT header fields the client reads (DatDatabase getters). */
export interface DatHeaderInfo {
  blockSize: number;
  dataSet: number;
  dataSubset: number;
  masterMapId: number;
}

export interface DatSetPointer {
  format: 1;
  set: string;
  iterations: Record<DatName, number>;
  manifest: ObjectRef;
  packs: Partial<Record<PackRole, ObjectRef & { files: number }>>;
  /** Header fields per DAT. Absent from pointers published before 2026-10-04's second format revision. */
  dats?: Partial<Record<DatName, DatHeaderInfo>>;
  /**
   * The area index (RELEASE.streaming-area-packs): per-landblock packs of the
   * leaves a destination needs. Optional: older sets have none, and older
   * clients ignore the key, so adding it never breaks a deployed client.
   */
  areas?: ObjectRef;
  created?: string;
}

/**
 * Header values of the end-of-retail DATs (portal 2072 / cell 982 / highres 497 /
 * local 994), read from their headers at 0x140 (2026-10-04). ONLY the fallback
 * for a pointer that predates the `dats` field (the first EoL publish); a
 * pointer that carries `dats` always wins, and a non-EoL set without it gets
 * zeros (masterMapId 0 makes the DidMapper-driven lookups no-ops, never wrong ids).
 */
export const EOL_DAT_HEADERS: Readonly<Record<DatName, DatHeaderInfo>> = {
  portal: { blockSize: 1024, dataSet: 1, dataSubset: 0, masterMapId: 0x25000000 },
  cell: { blockSize: 256, dataSet: 2, dataSubset: 1, masterMapId: 0 },
  local: { blockSize: 1024, dataSet: 3, dataSubset: 1, masterMapId: 0 },
  highres: { blockSize: 1024, dataSet: 1, dataSubset: 0x69466948, masterMapId: 0 },
};
const EOL_ITERATIONS: Readonly<Record<DatName, number>> = { portal: 2072, cell: 982, highres: 497, local: 994 };

/** Header info for one DAT of a set: the pointer's, else (EoL only) the measured EoL values. */
export function datHeaderFor(p: DatSetPointer, dat: DatName): DatHeaderInfo {
  const own = p.dats?.[dat];
  if (own) return own;
  const isEol = DAT_NAMES.every((d) => p.iterations[d] === EOL_ITERATIONS[d]);
  return isEol ? EOL_DAT_HEADERS[dat] : { blockSize: 0, dataSet: 0, dataSubset: 0, masterMapId: 0 };
}

const HASH_RE = /^[0-9a-f]{16}$/;

/** "v1/o/<hash>" → hash (the pointer names objects by key). */
export function hashOfKey(key: string): string {
  const h = key.slice(key.lastIndexOf('/') + 1);
  if (!HASH_RE.test(h)) throw new Error(`not an object key: ${key}`);
  return h;
}

export function objectKey(hash: string): string {
  return `v1/o/${hash}`;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`set pointer: bad ${what}`);
  return v;
}

/** Validate + normalize the set pointer JSON. Throws on anything malformed. */
export function parseSetPointer(json: unknown): DatSetPointer {
  if (!json || typeof json !== 'object') throw new Error('set pointer: not an object');
  const j = json as Record<string, unknown>;
  if (j.format !== 1) throw new Error(`set pointer: unsupported format ${String(j.format)}`);
  if (typeof j.set !== 'string' || !j.set) throw new Error('set pointer: missing set name');
  const it = (j.iterations ?? {}) as Record<string, unknown>;
  const iterations = {} as Record<DatName, number>;
  for (const d of DAT_NAMES) iterations[d] = num(it[d] ?? 0, `iterations.${d}`);
  const ref = (v: unknown, what: string): ObjectRef => {
    const o = (v ?? {}) as Record<string, unknown>;
    const hash = typeof o.hash === 'string' ? o.hash : hashOfKey(String(o.key ?? ''));
    if (!HASH_RE.test(hash)) throw new Error(`set pointer: bad ${what} hash`);
    return { hash, size: num(o.size, `${what}.size`), gzSize: num(o.gzSize, `${what}.gzSize`) };
  };
  const packs: DatSetPointer['packs'] = {};
  for (const [role, v] of Object.entries((j.packs ?? {}) as Record<string, unknown>)) {
    if (!(role in PACK_ROLE_CODE)) continue;
    packs[role as PackRole] = { ...ref(v, `packs.${role}`), files: num((v as Record<string, unknown>).files ?? 0, `packs.${role}.files`) };
  }
  let dats: DatSetPointer['dats'];
  if (j.dats && typeof j.dats === 'object') {
    dats = {};
    for (const d of DAT_NAMES) {
      const h = (j.dats as Record<string, unknown>)[d] as Record<string, unknown> | undefined;
      if (!h) continue;
      dats[d] = { blockSize: num(h.blockSize, 'blockSize'), dataSet: num(h.dataSet, 'dataSet'), dataSubset: num(h.dataSubset, 'dataSubset'), masterMapId: num(h.masterMapId, 'masterMapId') };
    }
  }
  const areas = j.areas ? ref(j.areas, 'areas') : null;
  return { format: 1, set: j.set, iterations, manifest: ref(j.manifest, 'manifest'), packs, ...(dats ? { dats } : {}), ...(areas ? { areas } : {}), ...(typeof j.created === 'string' ? { created: j.created } : {}) };
}

export interface ManifestPack extends ObjectRef { role: PackRole; files: number }
export interface DatSetManifest {
  /** Per-file objects: portal + highres. id → ref. */
  leaves: Record<'portal' | 'highres', Map<number, ObjectRef>>;
  packs: Map<PackRole, ManifestPack>;
  /** Landblock (0xXXYY) → its cell bundle. */
  bundles: Map<number, ObjectRef>;
}

function hex8(u8: Uint8Array, off: number): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += u8[off + i].toString(16).padStart(2, '0');
  return s;
}

/** Parse the binary manifest ("ACDM", format 1). */
export function parseSetManifest(bytes: Uint8Array): DatSetManifest {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'ACDM') throw new Error('manifest: bad magic');
  const format = dv.getUint32(4, true);
  if (format !== 1) throw new Error(`manifest: unsupported format ${format}`);
  const sectionCount = dv.getUint32(8, true);
  const out: DatSetManifest = { leaves: { portal: new Map(), highres: new Map() }, packs: new Map(), bundles: new Map() };
  let p = 12;
  for (let s = 0; s < sectionCount; s++) {
    if (p + 8 > bytes.byteLength) throw new Error('manifest: truncated section header');
    const kind = bytes[p];
    const dat = DAT_BY_CODE[bytes[p + 1]];
    const count = dv.getUint32(p + 4, true);
    p += 8;
    const width = kind === 2 ? 24 : 20;
    if (p + count * width > bytes.byteLength) throw new Error(`manifest: truncated section ${s}`);
    for (let i = 0; i < count; i++, p += width) {
      if (kind === 1) {
        if (dat !== 'portal' && dat !== 'highres') throw new Error(`manifest: leaves for ${dat ?? '?'}`);
        out.leaves[dat].set(dv.getUint32(p, true), { size: dv.getUint32(p + 4, true), gzSize: dv.getUint32(p + 8, true), hash: hex8(bytes, p + 12) });
      } else if (kind === 2) {
        const role = ROLE_BY_CODE[bytes[p]];
        if (!role) continue;
        out.packs.set(role, { role, size: dv.getUint32(p + 4, true), gzSize: dv.getUint32(p + 8, true), files: dv.getUint32(p + 12, true), hash: hex8(bytes, p + 16) });
      } else if (kind === 3) {
        out.bundles.set(dv.getUint16(p, true), { size: dv.getUint32(p + 4, true), gzSize: dv.getUint32(p + 8, true), hash: hex8(bytes, p + 12) });
      } else {
        throw new Error(`manifest: unknown section kind ${kind}`);
      }
    }
  }
  return out;
}

/** The parsed area index ("ACAI"). */
export interface AreaIndex {
  /** Landblocks per tile side. */
  tileSize: number;
  /** The leaves very many landblocks share, in one pack (null: the set has none). */
  common: (ObjectRef & { files: number }) | null;
  /** Tile key (areaTileOf) → its area pack. */
  areas: Map<number, ObjectRef>;
}

/** The area tile key of a landblock: 0xXXYY, or a full cell id 0xXXYYCCCC. */
export function areaTileOf(landblock: number, tileSize: number): number {
  const lb = (landblock >>> 0) > 0xffff ? landblock >>> 16 : landblock;
  return (Math.floor((lb >>> 8) / tileSize) << 8) | Math.floor((lb & 0xff) / tileSize);
}

const AREA_HEADER = 36;

/** Parse the area index ("ACAI", format 1). */
export function parseAreaIndex(bytes: Uint8Array): AreaIndex {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < AREA_HEADER || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'ACAI') throw new Error('area index: bad magic');
  const format = dv.getUint32(4, true);
  if (format !== 1) throw new Error(`area index: unsupported format ${format}`);
  const tileSize = dv.getUint32(8, true);
  if (tileSize < 1 || tileSize > 256) throw new Error(`area index: bad tile size ${tileSize}`);
  const count = dv.getUint32(12, true);
  if (AREA_HEADER + count * 20 > bytes.byteLength) throw new Error('area index: truncated');
  const commonSize = dv.getUint32(16, true);
  const common = commonSize > 0
    ? { size: commonSize, gzSize: dv.getUint32(20, true), files: dv.getUint32(24, true), hash: hex8(bytes, 28) }
    : null;
  const areas = new Map<number, ObjectRef>();
  for (let i = 0, p = AREA_HEADER; i < count; i++, p += 20) {
    areas.set(dv.getUint16(p, true), { size: dv.getUint32(p + 4, true), gzSize: dv.getUint32(p + 8, true), hash: hex8(bytes, p + 12) });
  }
  return { tileSize, common, areas };
}

/** Write the area index ("ACAI", format 1): the publish tool's side of parseAreaIndex. */
export function buildAreaIndex(tileSize: number, common: (ObjectRef & { files: number }) | null, areas: ReadonlyArray<{ tile: number; ref: ObjectRef }>): Uint8Array {
  const out = new Uint8Array(AREA_HEADER + areas.length * 20);
  const dv = new DataView(out.buffer);
  out.set([0x41, 0x43, 0x41, 0x49], 0); // "ACAI"
  dv.setUint32(4, 1, true);
  dv.setUint32(8, tileSize, true);
  dv.setUint32(12, areas.length, true);
  const putHash = (hash: string, at: number) => { for (let i = 0; i < 8; i++) out[at + i] = parseInt(hash.slice(i * 2, i * 2 + 2), 16); };
  if (common) {
    dv.setUint32(16, common.size, true);
    dv.setUint32(20, common.gzSize, true);
    dv.setUint32(24, common.files, true);
    putHash(common.hash, 28);
  }
  [...areas].sort((a, b) => a.tile - b.tile).forEach(({ tile, ref }, i) => {
    const p = AREA_HEADER + i * 20;
    dv.setUint16(p, tile & 0xffff, true);
    dv.setUint32(p + 4, ref.size, true);
    dv.setUint32(p + 8, ref.gzSize, true);
    putHash(ref.hash, p + 12);
  });
  return out;
}

/** A parsed pack: id → a view of the file's bytes inside the pack payload. */
export interface DatPack {
  ids: number[];
  files: Map<number, Uint8Array>;
}

/** Parse an "ACPK" pack (or landblock bundle). The returned views share the payload's buffer. */
export function parsePack(bytes: Uint8Array): DatPack {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'ACPK') throw new Error('pack: bad magic');
  const count = dv.getUint32(4, true);
  const dataStart = 8 + count * 12;
  if (dataStart > bytes.byteLength) throw new Error('pack: truncated index');
  const ids: number[] = new Array(count);
  const files = new Map<number, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const id = dv.getUint32(8 + i * 12, true);
    const off = dv.getUint32(12 + i * 12, true);
    const size = dv.getUint32(16 + i * 12, true);
    const start = dataStart + off;
    if (start + size > bytes.byteLength) throw new Error(`pack: file 0x${id.toString(16)} out of bounds`);
    ids[i] = id;
    files.set(id, bytes.subarray(start, start + size));
  }
  return { ids, files };
}

/**
 * The Iteration record 0xFFFF0001 of a complete DAT at `total` iterations:
 * int32 total, then the single (consecutive = -total, starting = 1) pair —
 * byte-for-byte what all four EoL DATs carry (e.g. portal 18080000 e8f7ffff 01000000).
 * The publish tool skips the record, so the streamed DAT synthesizes it.
 */
export function iterationRecordBytes(total: number): ArrayBuffer {
  const b = new ArrayBuffer(12);
  const dv = new DataView(b);
  dv.setInt32(0, total, true);
  dv.setInt32(4, -total, true);
  dv.setInt32(8, 1, true);
  return b;
}
