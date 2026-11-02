/**
 * The AC1999 server-seed helpers behind tools/ac1999-dat-seed.ts and publish-dats-r2's
 * --server-seed / --seed-only (BUG.ac1999-slow-login-ddd-push).
 *
 * A seed is the login DAT push an AC1999 server sends a client at the pristine iterations
 * (packages/dat-parser/src/era1999/ServerPatchSeed.ts). Three sources describe it:
 *   - the server-level DATs: the patched portal.dat / cell.dat the server serves (the AC1999
 *     repo's DatInspector/patching/dat_patch.py build output), or a retail client's DATs that
 *     server has synced. The push is then planned with the server's own rule against the
 *     pristine DATs (TurbineData.cpp GetSyncPlan, Client.cpp PlanDatSync).
 *   - a capture: what a browser stored from a real push (Ac1999World's OPFS store, dumped by
 *     CAPTURE_SNIPPET).
 *   - a seed file (.acss), built from either.
 * compareSeeds says whether two of them hold the same records byte for byte.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';
import {
  decodeServerPatchSeed, planDatSync, sortRecords, stampOf,
  type DatIterations, type DatManifest, type PatchDat, type PatchRecord, type ServerPatchSeed, type SyncPlan,
} from '../../packages/dat-parser/src/era1999/ServerPatchSeed.js';

export const DAT_FILES: Record<PatchDat, string> = { portal: 'portal.dat', cell: 'cell.dat' };

/** The object hash publish-dats-r2 keys an object by (first 8 bytes of sha256), and so the seed's id. */
export function seedHash(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest().subarray(0, 8).toString('hex');
}

function openPreTod(path: string): DatDatabase {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const db = new DatDatabase(new FileDatBytes(path));
  if (db.container !== 'pre-tod') throw new Error(`${path} is not a pre-ToD (1999) DAT`);
  return db;
}

/** A pre-ToD DAT's header iteration (offset 0x138; no Iteration record in this container). */
export function datIteration(path: string): number {
  return openPreTod(path).totalIterations;
}

function manifestOf(db: DatDatabase): DatManifest {
  const m: DatManifest = new Map();
  for (const id of db.listFileIds()) m.set(id >>> 0, stampOf(new Uint8Array(db.getFileData(id)!)));
  return m;
}

/** Read a server manifest file ("# header", then "ID SIZE CRC32" in hex: TurbineData.cpp WriteManifest). */
export function parseServerManifest(text: string): DatManifest {
  const m: DatManifest = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.trim().split(/\s+/).map((x) => parseInt(x, 16));
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) throw new Error(`bad manifest line: ${line}`);
    m.set(parts[0] >>> 0, { size: parts[1] >>> 0, crc: parts[2] >>> 0 });
  }
  return m;
}

export interface PlannedSeed { seed: ServerPatchSeed; plans: Record<PatchDat, SyncPlan> }

/**
 * The push the server serving `serverDir`'s DATs sends a client holding `pristineDir`'s:
 * per DAT, every record GetSyncPlan would list, with the server's bytes.
 */
export function planSeedFromDats(pristineDir: string, serverDir: string): PlannedSeed {
  const records: PatchRecord[] = [];
  const plans = {} as Record<PatchDat, SyncPlan>;
  const base = {} as DatIterations;
  const iterations = {} as DatIterations;
  for (const dat of ['portal', 'cell'] as const) {
    const pristine = openPreTod(join(pristineDir, DAT_FILES[dat]));
    const server = openPreTod(join(serverDir, DAT_FILES[dat]));
    base[dat] = pristine.totalIterations;
    iterations[dat] = server.totalIterations;
    if (base[dat] === iterations[dat]) {
      // PlanDatSync: equal iterations are "up to date" and nothing is sent, whatever the records hold.
      plans[dat] = { files: [], rawBytes: 0, unremovable: 0 };
      continue;
    }
    const plan = planDatSync(manifestOf(server), manifestOf(pristine));
    if (!plan) throw new Error(`${dat}: a record is at or over the client's DDD limit; the server would not sync this client`);
    plans[dat] = plan;
    for (const id of plan.files) records.push({ dat, id, bytes: new Uint8Array(server.getFileData(id)!) });
  }
  return { seed: { base, iterations, records: sortRecords(records) }, plans };
}

/** Check the pristine DATs' records against the server's manifests for those iterations (portal-102.manifest …). */
export function checkPristineAgainstManifests(pristineDir: string, manifestDir: string): string[] {
  const problems: string[] = [];
  for (const dat of ['portal', 'cell'] as const) {
    const db = openPreTod(join(pristineDir, DAT_FILES[dat]));
    const path = join(manifestDir, `${dat}-${db.totalIterations}.manifest`);
    if (!existsSync(path)) { problems.push(`${dat}: no ${path}`); continue; }
    const want = parseServerManifest(readFileSync(path, 'utf8'));
    const have = manifestOf(db);
    for (const [id, s] of want) {
      const h = have.get(id);
      if (!h || h.size !== s.size || h.crc !== s.crc) problems.push(`${dat} 0x${hex8(id)}: ours ${h ? `${h.size}/${hex8(h.crc)}` : 'missing'}, the server's manifest ${s.size}/${hex8(s.crc)}`);
    }
    for (const id of have.keys()) if (!want.has(id)) problems.push(`${dat} 0x${hex8(id)}: ours only`);
  }
  return problems;
}

/**
 * A seed against the server's own manifests for its iterations (`portal-<it>.manifest`,
 * `cell-<it>.manifest` from the server's ServerModes/<Mode>/Data/manifests): the records it holds
 * must be exactly the ones GetSyncPlan would push from the pristine DATs, each with the size and
 * crc32 the server recorded. The server's manifests need none of its DATs, so this checks a seed
 * whose later migrations' inputs we don't hold.
 */
export function verifyAgainstServerManifests(seed: ServerPatchSeed, pristineDir: string, manifestDir: string): string[] {
  const problems: string[] = [];
  for (const dat of ['portal', 'cell'] as const) {
    const pristine = openPreTod(join(pristineDir, DAT_FILES[dat]));
    const mine = seed.records.filter((r) => r.dat === dat);
    if (seed.iterations[dat] === pristine.totalIterations) {
      if (mine.length) problems.push(`${dat}: the server is at the pristine iteration, but the seed holds ${mine.length} record(s)`);
      continue;
    }
    const path = join(manifestDir, `${dat}-${seed.iterations[dat]}.manifest`);
    if (!existsSync(path)) { problems.push(`${dat}: no ${path}`); continue; }
    const server = parseServerManifest(readFileSync(path, 'utf8'));
    const plan = planDatSync(server, manifestOf(pristine));
    if (!plan) { problems.push(`${dat}: the server would not sync a pristine client`); continue; }
    const want = new Set(plan.files);
    const have = new Map(mine.map((r) => [r.id >>> 0, r] as const));
    for (const id of want) if (!have.has(id)) problems.push(`${dat} 0x${hex8(id)}: the server pushes it, the seed lacks it`);
    for (const [id, r] of have) {
      if (!want.has(id)) { problems.push(`${dat} 0x${hex8(id)}: in the seed, but the server would not push it`); continue; }
      const s = server.get(id)!;
      const st = stampOf(r.bytes);
      if (st.size !== s.size || st.crc !== s.crc) problems.push(`${dat} 0x${hex8(id)}: seed ${st.size}/${hex8(st.crc)}, the server's manifest ${s.size}/${hex8(s.crc)}`);
    }
  }
  return problems;
}

// ── captures ────────────────────────────────────────────────────────────────

/**
 * Paste into the DevTools console of the page that logged in (playwebac.com) once the character
 * list is up. It reads the AC1999 patches Ac1999World stored in the origin's OPFS root
 * (`ac1999-patch__<server>__<file id>.datcache` + `…__manifest.datcache`: era/Ac1999World.ts,
 * dat/DatCache.ts OpfsDatBlobStore) and downloads them as ac1999-push-capture.json. Plain
 * JavaScript, so it pastes as it is; tests run this exact string.
 */
export const CAPTURE_SNIPPET = String.raw`(async () => {
  const PREFIX = 'ac1999-patch__', SUFFIX = '.datcache';
  const root = await navigator.storage.getDirectory();
  const servers = {};
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file' || !name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const key = name.slice(PREFIX.length, name.length - SUFFIX.length);
    const cut = key.lastIndexOf('__');
    if (cut < 0) continue;
    const server = key.slice(0, cut), part = key.slice(cut + 2);
    const s = servers[server] || (servers[server] = { manifest: null, files: {} });
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if (part === 'manifest') { s.manifest = JSON.parse(new TextDecoder().decode(bytes)); continue; }
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    s.files[part] = btoa(bin);
  }
  const capture = { format: 'acjs-ac1999-patch-capture', version: 1, capturedAt: new Date().toISOString(), origin: location.origin, servers };
  const lines = Object.entries(servers).map(([k, s]) => k + ': ' + (s.manifest
    ? s.manifest.files.length + ' listed, ' + Object.keys(s.files).length + ' stored, iterations ' + s.manifest.portalIteration + ' / ' + s.manifest.cellIteration + (s.manifest.seed ? ', over seed ' + s.manifest.seed : '')
    : 'no manifest, ' + Object.keys(s.files).length + ' stored'));
  console.log('[ac1999 capture] ' + (lines.join('\n') || 'nothing stored on this origin'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(capture)], { type: 'application/json' }));
  a.download = 'ac1999-push-capture.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return capture;
})()`;

interface CaptureManifest { portalIteration: number; cellIteration: number; files: Array<{ dat: PatchDat; id: number }>; seed?: string }
interface CaptureFile { format: string; version: number; servers: Record<string, { manifest: CaptureManifest | null; files: Record<string, string> }> }

export interface Capture {
  serverKey: string;
  iterations: DatIterations;
  /** The seed the stored patches were applied over (a profile that was seeded), or null (a full push). */
  seedId: string | null;
  records: PatchRecord[];
}

/**
 * One server's stored patches from a capture. `serverKey` picks the server when the origin
 * stored more than one (it may be a substring of the key, e.g. "server_ac1999").
 */
export function parseCapture(json: unknown, serverKey?: string): Capture {
  const c = json as CaptureFile;
  if (!c || c.format !== 'acjs-ac1999-patch-capture' || c.version !== 1 || !c.servers) throw new Error('not an ac1999 patch capture (CAPTURE_SNIPPET output)');
  const keys = Object.keys(c.servers).filter((k) => !serverKey || k === serverKey || k.includes(serverKey));
  if (keys.length !== 1) {
    throw new Error(keys.length ? `the capture holds several servers (${keys.join(', ')}): pick one with --server-key`
      : `the capture holds no server${serverKey ? ` matching "${serverKey}"` : ''} (servers: ${Object.keys(c.servers).join(', ') || 'none'})`);
  }
  const s = c.servers[keys[0]];
  if (!s.manifest) throw new Error(`${keys[0]}: no manifest stored (the push was never persisted)`);
  const records: PatchRecord[] = [];
  const missing: string[] = [];
  for (const f of s.manifest.files) {
    const b64 = s.files[hex8(f.id)];
    if (b64 === undefined) { missing.push(`${f.dat} 0x${hex8(f.id)}`); continue; }
    records.push({ dat: f.dat, id: f.id >>> 0, bytes: new Uint8Array(Buffer.from(b64, 'base64')) });
  }
  if (missing.length) throw new Error(`${keys[0]}: the manifest lists ${missing.length} file(s) not stored (${missing.slice(0, 5).join(', ')}…): an incomplete store`);
  return {
    serverKey: keys[0],
    iterations: { portal: s.manifest.portalIteration, cell: s.manifest.cellIteration },
    seedId: typeof s.manifest.seed === 'string' ? s.manifest.seed : null,
    records: sortRecords(records),
  };
}

/**
 * A capture as a seed over `base`. A capture from a profile that was already seeded holds only
 * what the server sent on top of the seed: give that seed (`over`) and its records are merged
 * under the capture's, as Ac1999World.restore serves them.
 */
export function seedFromCapture(capture: Capture, base: DatIterations, over?: { id: string; seed: ServerPatchSeed }): ServerPatchSeed {
  if (capture.seedId) {
    if (!over) throw new Error(`the capture was stored over seed ${capture.seedId}: pass that seed (--seed) to rebuild the whole push`);
    if (over.id !== capture.seedId) throw new Error(`the capture was stored over seed ${capture.seedId}, not ${over.id}`);
    const merged = new Map(over.seed.records.map((r) => [`${r.dat}:${r.id}`, r] as const));
    for (const r of capture.records) merged.set(`${r.dat}:${r.id}`, r);
    return { base: over.seed.base, iterations: capture.iterations, records: sortRecords([...merged.values()]) };
  }
  return { base, iterations: capture.iterations, records: capture.records };
}

export function readSeedFile(bytes: Uint8Array): { id: string; seed: ServerPatchSeed } {
  return { id: seedHash(bytes), seed: decodeServerPatchSeed(bytes) };
}

// ── compare ─────────────────────────────────────────────────────────────────

export interface SeedComparison { identical: boolean; lines: string[] }

/** Byte-for-byte: the server's iterations, the base where both know it, and every record. */
export function compareSeeds(a: { label: string; seed: Pick<ServerPatchSeed, 'iterations' | 'records'> & { base?: DatIterations } },
  b: { label: string; seed: Pick<ServerPatchSeed, 'iterations' | 'records'> & { base?: DatIterations } }): SeedComparison {
  const lines: string[] = [];
  let ok = true;
  const it = (x: DatIterations) => `${x.portal} / ${x.cell}`;
  const sameIt = a.seed.iterations.portal === b.seed.iterations.portal && a.seed.iterations.cell === b.seed.iterations.cell;
  ok &&= sameIt;
  lines.push(`server iterations  ${a.label} ${it(a.seed.iterations)}   ${b.label} ${it(b.seed.iterations)}   ${sameIt ? 'same' : 'DIFFERENT'}`);
  if (a.seed.base && b.seed.base) {
    const sameBase = a.seed.base.portal === b.seed.base.portal && a.seed.base.cell === b.seed.base.cell;
    ok &&= sameBase;
    lines.push(`base iterations    ${a.label} ${it(a.seed.base)}   ${b.label} ${it(b.seed.base)}   ${sameBase ? 'same' : 'DIFFERENT'}`);
  }
  const mapOf = (rs: readonly PatchRecord[]) => new Map(rs.map((r) => [`${r.dat}:${hex8(r.id)}`, r] as const));
  const am = mapOf(a.seed.records);
  const bm = mapOf(b.seed.records);
  const onlyA = [...am.keys()].filter((k) => !bm.has(k)).sort();
  const onlyB = [...bm.keys()].filter((k) => !am.has(k)).sort();
  const differ: string[] = [];
  let sameCount = 0;
  for (const [k, ra] of am) {
    const rb = bm.get(k);
    if (!rb) continue;
    const at = firstDifference(ra.bytes, rb.bytes);
    if (at < 0) { sameCount++; continue; }
    differ.push(`${k} (${ra.bytes.length} vs ${rb.bytes.length} bytes, first difference at byte ${at})`);
  }
  for (const dat of ['portal', 'cell'] as const) {
    const n = (m: Map<string, PatchRecord>) => [...m.values()].filter((r) => r.dat === dat);
    const bytes = (rs: PatchRecord[]) => rs.reduce((s, r) => s + r.bytes.length, 0);
    lines.push(`${dat.padEnd(6)} records   ${a.label} ${n(am).length} (${bytes(n(am))} bytes)   ${b.label} ${n(bm).length} (${bytes(n(bm))} bytes)`);
  }
  lines.push(`identical records  ${sameCount}`);
  const list = (label: string, ks: string[]) => {
    if (!ks.length) return;
    ok = false;
    lines.push(`${label} ${ks.length}: ${ks.slice(0, 40).join(' ')}${ks.length > 40 ? ` … (+${ks.length - 40})` : ''}`);
  };
  list(`only in ${a.label}`, onlyA);
  list(`only in ${b.label}`, onlyB);
  list('DIFFERENT bytes', differ);
  lines.push(ok ? 'IDENTICAL' : 'NOT IDENTICAL');
  return { identical: ok, lines };
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

// ── the set pointer ─────────────────────────────────────────────────────────

export interface StagedObject { key: string; size: number; gzSize: number }

/** Stage one object as publish-dats-r2 does: v1/o/<hash>, gzip level 9. */
export function gzipObject(payload: Uint8Array): StagedObject & { gz: Uint8Array } {
  const gz = gzipSync(payload, { level: 9 });
  return { key: `v1/o/${seedHash(payload)}`, size: payload.length, gzSize: gz.length, gz };
}

/**
 * The set pointer with `serverId`'s seed added (or replaced). `stage` writes the seed object and
 * says where it went. Refuses a seed diffed from other iterations than the set's own: a client
 * reports the set's iterations before the seed, and the seed is that server's push to them.
 */
export function pointerWithServerSeed<P extends { iterations?: Record<string, number>; serverSeeds?: Record<string, unknown> }>(
  pointer: P, serverId: string, payload: Uint8Array, stage: (payload: Uint8Array) => StagedObject,
): P & { serverSeeds: Record<string, unknown> } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverId)) throw new Error(`server id "${serverId}" is not a launcher world id`);
  const seed = decodeServerPatchSeed(payload);
  const set = { portal: pointer.iterations?.portal ?? 0, cell: pointer.iterations?.cell ?? 0 };
  if (seed.base.portal !== set.portal || seed.base.cell !== set.cell) {
    throw new Error(`the seed was diffed from ${seed.base.portal} / ${seed.base.cell}; this set is ${set.portal} / ${set.cell}`);
  }
  const o = stage(payload);
  const entry = { key: o.key, size: o.size, gzSize: o.gzSize, base: seed.base, iterations: seed.iterations };
  return { ...pointer, serverSeeds: { ...(pointer.serverSeeds ?? {}), [serverId]: entry } };
}
