/**
 * An AC1999 server's login DAT push, prepared ahead of time (BUG.ac1999-slow-login-ddd-push).
 *
 * The AC1999 server serves patched portal.dat / cell.dat at its own iteration. A client that
 * reports any other iteration is sent every record that differs from the server's manifest for
 * that iteration before its character list (reference/ac1999 Server Client.cpp UpdateLoginScreen
 * → PlanDatSync → SendDatFile; the diff rule is TurbineData.cpp GetSyncPlan). A browser's first
 * visit reports the streamed 1999 world set's iterations (102 / 67) and waits 10–14 s for it.
 *
 * A seed is that push for one server, taken from the pristine iterations the world set carries:
 * the records and the server's iterations. Ac1999World applies it as if the server had sent it,
 * so a first visit already reports the server's iteration. It is published beside the world set
 * (the set pointer's `serverSeeds`) and built by tools/ac1999-dat-seed.ts.
 *
 * Payload (the whole object is gzipped like every set object):
 *   "ACSS" u32 format=1
 *   u32 basePortal, u32 baseCell          the iterations the diff was taken from (the world set's)
 *   u32 portalIteration, u32 cellIteration the server's
 *   u32 count
 *   count × (u8 dat: 1 portal / 2 cell, 3 pad, u32 id, u32 size, u32 crc32)
 *   the records' bytes, in index order
 * Records are sorted by (dat, id), so equal content encodes to equal bytes (and the same hash).
 *
 * Pure, no I/O: shared by the client, the tool and the tests.
 */

export type PatchDat = 'portal' | 'cell';

export interface PatchRecord { dat: PatchDat; id: number; bytes: Uint8Array }

export interface DatIterations { portal: number; cell: number }

export interface ServerPatchSeed {
  /** The iterations the client reports before the seed (the world set's). */
  base: DatIterations;
  /** The server's iterations: what the client reports once the seed is applied. */
  iterations: DatIterations;
  records: PatchRecord[];
}

const MAGIC = 0x53534341; // "ACSS"
const FORMAT = 1;
const DAT_CODE: Record<PatchDat, number> = { portal: 1, cell: 2 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib's crc32 (what the server's manifests hold: TurbineData.cpp BuildManifest). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One record's fingerprint, as the server's manifest line has it ("ID SIZE CRC32"). */
export interface RecordStamp { size: number; crc: number }
export type DatManifest = Map<number, RecordStamp>;

export function stampOf(bytes: Uint8Array): RecordStamp {
  return { size: bytes.length, crc: crc32(bytes) };
}

/** What a client at `client` needs to become record-identical to `server` (TurbineData.cpp GetSyncPlan). */
export interface SyncPlan {
  /** Records to push, ascending (the server walks its std::map manifest in key order). */
  files: number[];
  rawBytes: number;
  /** Records the client holds that the server lacks: DDD has no delete, so they stay. */
  unremovable: number;
}

/** The DDD client's raw-length limit (TurbineData.cpp kDDDMaxFileBytes): a record this big can't be synced. */
export const DDD_MAX_FILE_BYTES = 0x400000;

/**
 * GetSyncPlan's rule: every server record whose (size, crc32) differs from the client's, or that
 * the client lacks. Returns null where the server would refuse to sync (a record at or over the
 * client's DDD limit), and the server then leaves the client at its own iteration.
 */
export function planDatSync(server: DatManifest, client: DatManifest): SyncPlan | null {
  const files: number[] = [];
  let rawBytes = 0;
  for (const id of [...server.keys()].sort((a, b) => a - b)) {
    const s = server.get(id)!;
    const c = client.get(id);
    if (c && c.size === s.size && c.crc === s.crc) continue;
    if (s.size >= DDD_MAX_FILE_BYTES) return null;
    files.push(id);
    rawBytes += s.size;
  }
  let unremovable = 0;
  for (const id of client.keys()) if (!server.has(id)) unremovable++;
  return { files, rawBytes, unremovable };
}

/** Records in canonical order: portal before cell, then by id. */
export function sortRecords(records: readonly PatchRecord[]): PatchRecord[] {
  return [...records].sort((a, b) => DAT_CODE[a.dat] - DAT_CODE[b.dat] || (a.id >>> 0) - (b.id >>> 0));
}

export function encodeServerPatchSeed(seed: ServerPatchSeed): Uint8Array {
  const records = sortRecords(seed.records);
  const seen = new Set<string>();
  for (const r of records) {
    const k = `${r.dat}:${r.id >>> 0}`;
    if (seen.has(k)) throw new Error(`seed: ${r.dat} 0x${(r.id >>> 0).toString(16)} listed twice`);
    seen.add(k);
  }
  const head = 4 * 7;
  const index = records.length * 16;
  const out = new Uint8Array(head + index + records.reduce((s, r) => s + r.bytes.length, 0));
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, FORMAT, true);
  v.setUint32(8, seed.base.portal >>> 0, true);
  v.setUint32(12, seed.base.cell >>> 0, true);
  v.setUint32(16, seed.iterations.portal >>> 0, true);
  v.setUint32(20, seed.iterations.cell >>> 0, true);
  v.setUint32(24, records.length, true);
  let at = head + index;
  records.forEach((r, i) => {
    const o = head + i * 16;
    v.setUint8(o, DAT_CODE[r.dat]);
    v.setUint32(o + 4, r.id >>> 0, true);
    v.setUint32(o + 8, r.bytes.length, true);
    v.setUint32(o + 12, crc32(r.bytes), true);
    out.set(r.bytes, at);
    at += r.bytes.length;
  });
  return out;
}

/** Parse a seed; throws on a bad magic, a short payload or a record whose crc32 doesn't match. */
export function decodeServerPatchSeed(bytes: Uint8Array): ServerPatchSeed {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 28 || v.getUint32(0, true) !== MAGIC) throw new Error('seed: not an ACSS payload');
  if (v.getUint32(4, true) !== FORMAT) throw new Error(`seed: unsupported format ${v.getUint32(4, true)}`);
  const base = { portal: v.getUint32(8, true), cell: v.getUint32(12, true) };
  const iterations = { portal: v.getUint32(16, true), cell: v.getUint32(20, true) };
  const count = v.getUint32(24, true);
  const head = 28;
  if (head + count * 16 > bytes.length) throw new Error('seed: index runs past the payload');
  let at = head + count * 16;
  const records: PatchRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = head + i * 16;
    const code = v.getUint8(o);
    const dat: PatchDat | null = code === 1 ? 'portal' : code === 2 ? 'cell' : null;
    if (!dat) throw new Error(`seed: record ${i} has dat code ${code}`);
    const id = v.getUint32(o + 4, true);
    const size = v.getUint32(o + 8, true);
    const crc = v.getUint32(o + 12, true);
    if (at + size > bytes.length) throw new Error(`seed: ${dat} 0x${id.toString(16)} runs past the payload`);
    const rec = bytes.slice(at, at + size);
    if (crc32(rec) !== crc) throw new Error(`seed: ${dat} 0x${id.toString(16)} fails its crc32`);
    records.push({ dat, id, bytes: rec });
    at += size;
  }
  if (at !== bytes.length) throw new Error(`seed: ${bytes.length - at} trailing byte(s)`);
  return { base, iterations, records };
}
