/**
 * Publish a DAT set to Cloudflare R2 as content-addressed streaming objects
 * (design + rationale: docs/dat-streaming.md §3–§4).
 *
 *   npx tsx tools/publish-dats-r2.ts                 # dry run (default): build the plan, print it, write nothing
 *   npx tsx tools/publish-dats-r2.ts --stage-only    # also write the objects to the staging dir
 *   npx tsx tools/publish-dats-r2.ts --execute       # stage + upload with rclone (needs an "r2" remote)
 *
 * Options:
 *   --dat-dir <dir>        source DATs (default: ./dat)
 *   --set <name>           set name (default: derived from the four Iteration records, e.g. eol-p2072-c982-h497-l994)
 *   --pack-sets <json>     boot/world pack lists from tools/dat-access-sim.ts --boot-set
 *                          (default: verification/dat-streaming/pack-sets.json)
 *   --stage <dir>          staging dir (default: $TMPDIR/acjs-dat-publish/<set>)
 *   --remote <name>        rclone remote (default: r2)          --bucket <name>  (default: webac-dats)
 *   --raw                  also upload the raw .dat files under v1/raw/<set>/ (the "download everything" path)
 *   --overlay ac1999       a WORLD-ONLY set from the 1999 retail portal.dat + cell.dat in --dat-dir, every
 *                          file read through dat-parser era1999's overlay, so the set holds end-of-retail
 *                          formats (the client translates nothing it streams; only server patches). Packs:
 *                          skeleton + terrain + world (the Region's terrain texture closure, which the client
 *                          builds the terrain materials from once), leaves + landblock bundles; no boot/local/ui
 *                          packs and no highres (the interface streams from end of retail's set: era/EraBoot.ts
 *                          eraStreamPlan). Also carries the untranslated copies the client reads raw
 *                          (AC1999_UNTRANSLATED_COPIES). Default set name ac1999-retail-world-p<portal>-c<cell>.
 *   --print-cors           print the bucket CORS policy JSON and exit
 *   --no-areas             skip the area packs (default: built when --world-db exists, end-of-retail-format sets only)
 *   --world-db <path|none> ACE world DB for the area packs' server objects (default: ./dat/world.sqlite; `none` for
 *                          a set whose server runs another world, e.g. a classic era: terrain + buildings + statics only)
 *   --area-tile <n>        landblocks per area tile side (default 4)
 *   --area-common <n>      a leaf more than n landblocks need goes to the common pack (default 512)
 *   --areas-only <pointer url>
 *                          add area packs to a LIVE set and change nothing else: stages the area objects and
 *                          the live pointer plus `areas` (upload with tools/upload-stream-set-r2.ts)
 *
 * Idempotent: every object key is the hash of its uncompressed content, so a
 * re-run uploads only objects R2 does not already hold (rclone --ignore-existing),
 * and the one mutable key — the set pointer v1/sets/<set>.json — is written LAST,
 * after every object it references is in the bucket. A second DAT set (e.g.
 * Dark Majesty) shares every byte-identical file with the first.
 *
 * Object layout (bucket):
 *   v1/o/<h>            gzip(payload), h = first 8 bytes of sha256(payload) as 16 hex chars;
 *                       immutable, Cache-Control: public, max-age=31536000, immutable
 *   v1/sets/<set>.json  { format, set, iterations, manifest: {hash, key, size, gzSize}, packs: {role: {key, size, gzSize, files}},
 *                         dats: {dat: {blockSize, dataSet, dataSubset, masterMapId}}, created }
 *                       (dats = the header fields the client's DatDatabase getters expose; the container
 *                       header itself is not shipped. Added 2026-10-04 with RELEASE.dat-streaming.)
 *                       Cache-Control: public, max-age=60, must-revalidate
 *
 * Payload kinds (all gzip'd as whole objects; the client inflates with DecompressionStream):
 *   leaf    one DAT file's bytes (portal GfxObj/Animation/Palette/Texture/Wave/Environment, every highres file)
 *   pack    "ACPK" u32 count, count × (u32 id, u32 offset, u32 size), then the files (offsets from the
 *           end of the index). Packs: boot (pre-world), world (needed before the first landblock),
 *           skeleton (every small structural portal file), terrain (every CellLandblock 0xXXYYFFFF),
 *           local (the whole language DAT's files), ui (every LayoutDesc's portal art beyond boot/world:
 *           loaded in the background in world so panels never draw blank)
 *   bundle  a pack of one landblock's LandblockInfo 0xXXYYFFFE + all its EnvCells (5,346 landblocks)
 *   area    a pack of the portal leaves one tile of landblocks reads, and the common pack of the leaves
 *           very many landblocks share (RELEASE.streaming-area-packs, tools/lib/area-packs.ts); listed
 *           by the area index ("ACAI", packages/dat-parser/src/streaming/DatSetFormat.ts), which the
 *           pointer names as `areas`. Older clients ignore the key.
 *   manifest
 *           "ACDM" u32 format=1, u32 sectionCount, then sections:
 *             u8 kind, u8 dat, u16 reserved, u32 count, entries
 *             kind 1 leaves:  count × (u32 id, u32 size, u32 gzSize, 8-byte hash)       — 20 B
 *             kind 2 packs:   count × (u8 role, 3 pad, u32 size, u32 gzSize, u32 files, 8-byte hash) — 24 B
 *             kind 3 bundles: count × (u16 landblock, 2 pad, u32 size, u32 gzSize, 8-byte hash) — 20 B
 *           dat: 1 portal, 2 cell, 3 local, 4 highres; role: 1 boot, 2 world, 3 skeleton, 4 terrain, 5 local, 6 ui
 *
 * Never reads a whole DAT into memory: files come out one at a time through FileDatBytes.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { Surface } from '../packages/dat-parser/src/file-types/Surface.js';
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { SKELETON_TYPES, buildAreaIndex, parsePack, parseSetManifest } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { planAreas } from './lib/area-packs.js';
import { worldDbRoots } from './lib/world-db-roots.js';
import { AC1999_UNTRANSLATED_COPIES, ac1999CellOverlay, ac1999PortalOverlay, type Ac1999DatOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Small structural portal types shipped in the skeleton pack: one list, shared with the client and the sim. */
export { SKELETON_TYPES };
/** The iterations ACE's ITERATION_* constants pin (CLAUDE.md "Target Era"). */
const EXPECTED_ITERATIONS = { portal: 2072, cell: 982, highres: 497, local: 994 } as const;
const DAT_FILES = { portal: 'client_portal.dat', cell: 'client_cell_1.dat', local: 'client_local_English.dat', highres: 'client_highres.dat' } as const;
type DatName = keyof typeof DAT_FILES;
const DAT_CODE: Record<DatName, number> = { portal: 1, cell: 2, local: 3, highres: 4 };
const ROLE = { boot: 1, world: 2, skeleton: 3, terrain: 4, local: 5, ui: 6 } as const;
type Role = keyof typeof ROLE;
const ITERATION_FILE_ID = 0xFFFF0001;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const POINTER_CACHE = 'public, max-age=60, must-revalidate';

/**
 * Dashboard-format CORS policy. "*" on purpose: the objects are public,
 * credential-free GETs, and a single wildcard ACAO keeps the CDN cache safe
 * (a per-origin ACAO needs Vary: Origin, or a response cached for one origin
 * fails CORS for another). wrangler's file format differs — docs/dat-streaming.md §4.
 */
export const CORS_POLICY = [{
  AllowedOrigins: ['*'],
  AllowedMethods: ['GET', 'HEAD'],
  AllowedHeaders: ['Range', 'If-None-Match', 'If-Modified-Since'],
  ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified'],
  MaxAgeSeconds: 86400,
}];

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string, d: string | null = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
if (flag('--print-cors')) { console.log(JSON.stringify(CORS_POLICY, null, 2)); process.exit(0); }
const execute = flag('--execute');
const stageOnly = flag('--stage-only');
let writeStage = execute || stageOnly;
const datDir = resolve(opt('--dat-dir', join(REPO, 'dat'))!);
const packSetsPath = resolve(opt('--pack-sets', join(REPO, 'verification/dat-streaming/pack-sets.json'))!);
const remote = opt('--remote', 'r2')!;
const bucket = opt('--bucket', 'webac-dats')!;
const includeRaw = flag('--raw');
const overlayName = opt('--overlay');
const worldDbOpt = opt('--world-db', join(REPO, 'dat/world.sqlite'))!;
const worldDbPath = worldDbOpt === 'none' ? null : resolve(worldDbOpt);
const areaTile = Number(opt('--area-tile', '4'));
const areaCommon = Number(opt('--area-common', '512'));
if (overlayName !== null && overlayName !== 'ac1999') throw new Error(`--overlay: unknown overlay "${overlayName}" (known: ac1999)`);
/** A world-only set read through the 1999 overlay. */
const ac1999World = overlayName === 'ac1999';
/** The DATs this run packs: the four end-of-retail files, or the 1999 world's two. */
const SET_FILES: Partial<Record<DatName, string>> = ac1999World ? { portal: 'portal.dat', cell: 'cell.dat' } : DAT_FILES;

// ── helpers ─────────────────────────────────────────────────────────────────
const hash8 = (b: Uint8Array) => createHash('sha256').update(b).digest().subarray(0, 8);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

interface Planned { key: string; size: number; gzSize: number; hash: Buffer }
const objects = new Map<string, Planned>();
let stageDir = '';
let dedupedObjects = 0;

/** Plan (and when staging, write) one content-addressed object. */
function putObject(payload: Uint8Array): Planned {
  const h = Buffer.from(hash8(payload));
  const key = `v1/o/${hex(h)}`;
  const existing = objects.get(key);
  if (existing) { dedupedObjects++; return existing; }
  const gz = gzipSync(payload, { level: 9 });
  const p: Planned = { key, size: payload.length, gzSize: gz.length, hash: h };
  objects.set(key, p);
  if (writeStage) {
    const path = join(stageDir, key);
    if (!existsSync(path)) writeFileSync(path, gz);
  }
  return p;
}

function buildPack(files: Array<{ id: number; data: Uint8Array }>): Uint8Array {
  files.sort((a, b) => a.id - b.id);
  const indexBytes = 8 + files.length * 12;
  const total = indexBytes + files.reduce((s, f) => s + f.data.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x41, 0x43, 0x50, 0x4b], 0); // "ACPK"
  dv.setUint32(4, files.length, true);
  let off = 0;
  files.forEach((f, i) => {
    dv.setUint32(8 + i * 12, f.id >>> 0, true);
    dv.setUint32(12 + i * 12, off, true);
    dv.setUint32(16 + i * 12, f.data.length, true);
    out.set(f.data, indexBytes + off);
    off += f.data.length;
  });
  return out;
}

/**
 * The leaves (non-skeleton portal files) the terrain materials read: RegionDesc 0x13000000's TexMerge
 * (land textures + their detail textures, corner / side alpha maps, road maps) → SurfaceTexture 0x05
 * (every level) or Surface 0x08 → Texture 0x06/0x07 → default Palette 0x04. The structural files on the
 * way (0x05, 0x08, 0x13) ride the skeleton pack.
 */
function regionTerrainLeaves(get: (id: number) => ArrayBuffer | null): number[] {
  const region = get(0x13000000);
  if (!region) return [];
  const tm = new RegionDesc(new DatReader(region)).terrainInfo.landSurfaces.texMerge;
  if (!tm) return [];
  const roots = [
    ...tm.terrainDesc.flatMap((d) => [d.terrainTex.texGID, d.terrainTex.detailTexGID]),
    ...tm.cornerTerrainMaps.map((m) => m.texGID), ...tm.sideTerrainMaps.map((m) => m.texGID),
    ...tm.roadMaps.map((m) => m.roadTexGID),
  ];
  const seen = new Set<number>();
  const leaves = new Set<number>();
  const queue = roots.map((id) => id >>> 0).filter((id) => id !== 0);
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const data = get(id);
    if (!data) continue;
    const type = id >>> 24;
    if (!SKELETON_TYPES.has(type)) leaves.add(id);
    const next: number[] = [];
    if (type === 0x05) next.push(...SurfaceTexture.read(new DatReader(data)).textures);
    else if (type === 0x08) { const s = Surface.read(new DatReader(data)); next.push(s.origTextureId, s.origPaletteId); }
    else if (type === 0x06 || type === 0x07) { const t = Texture.read(new DatReader(data)); if (t.defaultPaletteId) next.push(t.defaultPaletteId); }
    for (const n of next) if (n) queue.push(n >>> 0);
  }
  return [...leaves].sort((a, b) => a - b);
}

function iterationOf(db: DatDatabase): number {
  if (db.container === 'pre-tod') return db.totalIterations; // the header's (no 0xFFFF0001 record)
  const d = db.getFileData(ITERATION_FILE_ID);
  return d ? new DataView(d).getInt32(0, true) : 0;
}

// ── plan ────────────────────────────────────────────────────────────────────
function main(): void {
  const t0 = Date.now();
  const dbs = {} as Record<DatName, DatDatabase>;
  const iterations: Record<DatName, number> = { portal: 0, cell: 0, local: 0, highres: 0 };
  const overlays: Ac1999DatOverlay[] = [];
  let untranslatable = 0;
  for (const [name, file] of Object.entries(SET_FILES) as Array<[DatName, string]>) {
    const path = join(datDir, file);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    dbs[name] = new DatDatabase(new FileDatBytes(path));
    iterations[name] = iterationOf(dbs[name]);
    if (ac1999World) {
      if (dbs[name].container !== 'pre-tod') throw new Error(`--overlay ac1999: ${path} is not a pre-ToD DAT`);
      const onError = (id: number, err: unknown) => { untranslatable++; console.warn(`[publish] ${file} 0x${(id >>> 0).toString(16)} did not translate (left out):`, err); };
      const ov = name === 'portal' ? ac1999PortalOverlay({ onError }) : ac1999CellOverlay({ onError });
      dbs[name].setOverlay(ov);
      overlays.push(ov);
    } else if (iterations[name] !== EXPECTED_ITERATIONS[name]) {
      console.warn(`[publish] WARNING ${file}: iteration ${iterations[name]}, expected ${EXPECTED_ITERATIONS[name]} (end-of-retail). Publishing anyway under its own set name.`);
    }
  }
  const setName = opt('--set', ac1999World ? `ac1999-retail-world-p${iterations.portal}-c${iterations.cell}`
    : `eol-p${iterations.portal}-c${iterations.cell}-h${iterations.highres}-l${iterations.local}`)!;
  stageDir = resolve(opt('--stage', join(tmpdir(), 'acjs-dat-publish', setName))!);
  if (writeStage) mkdirSync(join(stageDir, 'v1/o'), { recursive: true });
  if (writeStage) mkdirSync(join(stageDir, 'v1/sets'), { recursive: true });

  const packSets = ac1999World ? null : existsSync(packSetsPath)
    ? JSON.parse(readFileSync(packSetsPath, 'utf8')) as { boot: Record<string, string[]>; world: Record<string, string[]>; ui?: Record<string, string[]> }
    : null;
  if (!packSets && !ac1999World) console.warn(`[publish] no pack-sets file at ${packSetsPath} — boot/world packs will be empty (run tools/dat-access-sim.ts --boot-set first)`);

  // Through the 1999 overlay a file is translated once and cached: let the cache go as we stream.
  let reads = 0;
  const readOrNull = (dat: DatName, id: number): Uint8Array | null => {
    if (overlays.length && ++reads % 512 === 0) for (const o of overlays) o.clearCache();
    const d = dbs[dat].getFileData(id);
    return d ? new Uint8Array(d) : null;
  };
  const read = (dat: DatName, id: number) => {
    const d = readOrNull(dat, id);
    if (!d) throw new Error(`${dat} 0x${(id >>> 0).toString(16)}: listed but unreadable`);
    return d;
  };
  const leaves: Record<'portal' | 'highres', Array<{ id: number; p: Planned }>> = { portal: [], highres: [] };
  const packs: Array<{ role: Role; p: Planned; files: number }> = [];
  const bundles: Array<{ lb: number; p: Planned }> = [];

  // portal: skeleton pack + leaves
  const skeleton: Array<{ id: number; data: Uint8Array }> = [];
  for (const id of dbs.portal.listFileIds().sort((a, b) => a - b)) {
    if (id === ITERATION_FILE_ID) continue;
    const data = ac1999World ? readOrNull('portal', id) : read('portal', id);
    if (!data) continue; // did not translate (counted + logged)
    if (SKELETON_TYPES.has(id >>> 24)) skeleton.push({ id, data });
    else leaves.portal.push({ id, p: putObject(data) });
  }
  // The 1999 bytes the client still reads untranslated, under their copy ids (skeleton types).
  if (ac1999World) {
    for (const [id, copy] of AC1999_UNTRANSLATED_COPIES) {
      const raw = dbs.portal.getUntranslatedFileData(id);
      if (raw) skeleton.push({ id: copy, data: new Uint8Array(raw) });
    }
  }
  packs.push({ role: 'skeleton', p: putObject(buildPack(skeleton)), files: skeleton.length });
  // highres: every file a leaf
  for (const id of (dbs.highres?.listFileIds() ?? []).sort((a, b) => a - b)) {
    if (id === ITERATION_FILE_ID) continue;
    leaves.highres.push({ id, p: putObject(read('highres', id)) });
  }
  // local: one pack
  if (dbs.local) {
    const localFiles = dbs.local.listFileIds().filter((id) => id !== ITERATION_FILE_ID).map((id) => ({ id, data: read('local', id) }));
    packs.push({ role: 'local', p: putObject(buildPack(localFiles)), files: localFiles.length });
  }
  // boot / world / ui packs from the access simulation (portal ids; local is its own pack).
  // ui leaves out what boot + world already carry, and the skeleton types (always resident).
  const inEarlierPack = new Set<number>();
  for (const role of ['boot', 'world', 'ui'] as const) {
    if (ac1999World) break; // a world-only set: the interface set carries them
    if (role === 'ui' && !packSets?.ui) continue;
    const ids = (packSets?.[role]?.portal ?? []).map((h) => parseInt(h, 16))
      .filter((id) => dbs.portal.hasFile(id) && (role !== 'ui' || (!inEarlierPack.has(id) && !SKELETON_TYPES.has(id >>> 24))));
    for (const id of ids) inEarlierPack.add(id);
    const files = ids.map((id) => ({ id, data: read('portal', id) }));
    packs.push({ role, p: putObject(buildPack(files)), files: files.length });
  }
  // A world-only set has no access-simulated world pack, but the client builds the terrain materials
  // ONCE when the world + terrain packs are resident (main.ts deferredWorldInit; TerrainRenderer
  // buildTerrainMaterials / blend + road overlays, DetailTexturing). Their textures are leaves, so
  // without this pack every terrain texture missed and the landscape drew flat. The world pack carries
  // the Region's terrain texture closure, derived from the translated Region (no hardcoded ids).
  if (ac1999World) {
    const ids = regionTerrainLeaves((id) => dbs.portal.getFileData(id));
    const files = ids.map((id) => ({ id, data: read('portal', id) }));
    packs.push({ role: 'world', p: putObject(buildPack(files)), files: files.length });
  }
  // cell: one terrain pack + a bundle per landblock with a LandblockInfo
  const terrain: Array<{ id: number; data: Uint8Array }> = [];
  const byLandblock = new Map<number, number[]>();
  for (const id of dbs.cell.listFileIds()) {
    if (id === ITERATION_FILE_ID) continue;
    if ((id & 0xffff) === 0xffff) {
      const data = ac1999World ? readOrNull('cell', id) : read('cell', id);
      if (data) terrain.push({ id, data });
    }
    else {
      const lb = id >>> 16;
      let l = byLandblock.get(lb);
      if (!l) { l = []; byLandblock.set(lb, l); }
      l.push(id);
    }
  }
  packs.push({ role: 'terrain', p: putObject(buildPack(terrain)), files: terrain.length });
  let cellOrphans = 0;
  for (const [lb, ids] of [...byLandblock.entries()].sort((a, b) => a[0] - b[0])) {
    if (!ids.includes(((lb << 16) | 0xfffe) >>> 0)) cellOrphans += ids.length;
    const files = ids.map((id) => ({ id, data: ac1999World ? readOrNull('cell', id) : read('cell', id) }))
      .filter((f): f is { id: number; data: Uint8Array } => f.data !== null);
    bundles.push({ lb, p: putObject(buildPack(files)) });
  }

  // area packs: a world-only 1999 set reads its world through the overlay; its area packs are a later step
  const areas = !flag('--no-areas') && !ac1999World && (worldDbPath === null || existsSync(worldDbPath)) ? buildAreas(dbs, inEarlierPack, read) : null;
  const areaIndex = areas?.index ?? null;
  const areaReport = areas?.report ?? '';

  // manifest
  const sections: Buffer[] = [];
  const section = (kind: number, dat: number, count: number, body: Buffer) => {
    const h = Buffer.alloc(8); h.writeUInt8(kind, 0); h.writeUInt8(dat, 1); h.writeUInt32LE(count, 4);
    sections.push(h, body);
  };
  for (const dat of ['portal', 'highres'] as const) {
    const b = Buffer.alloc(leaves[dat].length * 20);
    leaves[dat].forEach(({ id, p }, i) => { b.writeUInt32LE(id >>> 0, i * 20); b.writeUInt32LE(p.size, i * 20 + 4); b.writeUInt32LE(p.gzSize, i * 20 + 8); p.hash.copy(b, i * 20 + 12); });
    section(1, DAT_CODE[dat], leaves[dat].length, b);
  }
  {
    const b = Buffer.alloc(packs.length * 24);
    packs.forEach(({ role, p, files }, i) => { b.writeUInt8(ROLE[role], i * 24); b.writeUInt32LE(p.size, i * 24 + 4); b.writeUInt32LE(p.gzSize, i * 24 + 8); b.writeUInt32LE(files, i * 24 + 12); p.hash.copy(b, i * 24 + 16); });
    section(2, 0, packs.length, b);
  }
  {
    const b = Buffer.alloc(bundles.length * 20);
    bundles.forEach(({ lb, p }, i) => { b.writeUInt16LE(lb, i * 20); b.writeUInt32LE(p.size, i * 20 + 4); b.writeUInt32LE(p.gzSize, i * 20 + 8); p.hash.copy(b, i * 20 + 12); });
    section(3, DAT_CODE.cell, bundles.length, b);
  }
  const head = Buffer.alloc(12); head.write('ACDM', 0, 'latin1'); head.writeUInt32LE(1, 4); head.writeUInt32LE(sections.length / 2, 8);
  const manifest = putObject(Buffer.concat([head, ...sections]));
  const dats = Object.fromEntries((Object.keys(SET_FILES) as DatName[]).map((d) => [d, {
    blockSize: dbs[d].blockSize, dataSet: dbs[d].dataSet, dataSubset: dbs[d].dataSubset, masterMapId: dbs[d].masterMapId,
  }]));
  const pointer = { format: 1, set: setName, iterations, manifest: { hash: hex(manifest.hash), key: manifest.key, size: manifest.size, gzSize: manifest.gzSize },
    // the packs again, so boot can fetch boot+local in parallel with (not after) the manifest
    packs: Object.fromEntries(packs.map(({ role, p, files }) => [role, { key: p.key, size: p.size, gzSize: p.gzSize, files }])),
    dats,
    ...(areaIndex ? { areas: { key: areaIndex.key, size: areaIndex.size, gzSize: areaIndex.gzSize } } : {}),
    created: new Date().toISOString() };
  if (writeStage) writeFileSync(join(stageDir, `v1/sets/${setName}.json`), JSON.stringify(pointer, null, 2) + '\n');

  // ── report ────────────────────────────────────────────────────────────────
  const sum = (a: Planned[]) => a.reduce((s, p) => s + p.gzSize, 0);
  const all = [...objects.values()];
  console.log(`\nDAT set ${setName}  (iterations ${JSON.stringify(iterations)})  planned in ${((Date.now() - t0) / 1000).toFixed(0)} s${ac1999World ? `  [1999 world through the overlay; ${untranslatable} file(s) did not translate and are left out]` : ''}`);
  console.log(`  objects: ${objects.size} unique (${dedupedObjects} duplicate payloads deduped), ${mb(all.reduce((s, p) => s + p.size, 0))} raw → ${mb(sum(all))} gzip`);
  console.log(`  leaves:  portal ${leaves.portal.length} (${mb(sum(leaves.portal.map((l) => l.p)))} gz), highres ${leaves.highres.length} (${mb(sum(leaves.highres.map((l) => l.p)))} gz)`);
  for (const { role, p, files } of packs) console.log(`  pack ${role.padEnd(8)} ${String(files).padStart(6)} files  ${mb(p.size).padStart(9)} raw  ${mb(p.gzSize).padStart(9)} gz  ${p.key}`);
  const bsz = bundles.map((b) => b.p.gzSize).sort((a, b) => a - b);
  console.log(`  landblock bundles: ${bundles.length} (${mb(sum(bundles.map((b) => b.p)))} gz; median ${(bsz[bsz.length >> 1] / 1024).toFixed(1)} KB, max ${(bsz[bsz.length - 1] / 1024).toFixed(0)} KB${cellOrphans ? `; ${cellOrphans} cell files in blocks without a LandblockInfo` : ''})`);
  if (areaReport) console.log(areaReport);
  console.log(`  manifest: ${mb(manifest.size)} raw, ${mb(manifest.gzSize)} gz  ${manifest.key}`);
  console.log(`  largest object: ${mb(Math.max(...all.map((p) => p.gzSize)))} gz (CDN-cacheable limit 512 MB)`);
  console.log(`  pointer: v1/sets/${setName}.json → ${manifest.key}`);
  const cmds = uploadCommands(setName);
  console.log(`\nUpload plan (${execute ? 'EXECUTING' : stageOnly ? 'staged only, not uploading' : 'dry run — nothing written'}); staging dir ${stageDir}:`);
  for (const c of cmds) console.log(`  ${c.map((a) => (/[\s,]/.test(a) ? `'${a}'` : a)).join(' ')}`);
  if (!execute) return;

  // ── execute ───────────────────────────────────────────────────────────────
  try { execFileSync('rclone', ['version'], { stdio: 'ignore' }); } catch { throw new Error('rclone is not installed (brew install rclone) — see docs/dat-streaming.md §4'); }
  const remotes = execFileSync('rclone', ['listremotes'], { encoding: 'utf8' });
  if (!remotes.split('\n').includes(`${remote}:`)) throw new Error(`rclone remote "${remote}:" is not configured — see docs/dat-streaming.md §4`);
  for (const c of cmds) { console.log(`$ ${c.join(' ')}`); execFileSync(c[0], c.slice(1), { stdio: 'inherit' }); }
  console.log(`\nPublished ${setName}. Set pointer: https://<your-dat-domain>/v1/sets/${setName}.json`);
}

/**
 * The area packs (RELEASE.streaming-area-packs): plan every tile with the client's own closure walk
 * (tools/lib/area-packs.ts), write each tile's pack, the common pack and the area index.
 */
function buildAreas(dbs: Record<DatName, DatDatabase>, inPacks: ReadonlySet<number>, read: (dat: DatName, id: number) => Uint8Array, leaves?: ReadonlySet<number>, onRead?: () => void): { index: Planned; report: string } {
  const ta = Date.now();
  const region = dbs.portal.getFileData(0x13000000);
  const world = worldDbPath ? worldDbRoots(worldDbPath) : null;
  const plan = planAreas({
    portal: dbs.portal, cell: dbs.cell, regionDesc: region ? new RegionDesc(new DatReader(region)) : null,
    serverRoots: world?.roots, commonThreshold: areaCommon, tileSize: areaTile, inPacks,
    onProgress: (d, t) => process.stderr.write(`\r[publish] area plan ${d}/${t}`),
    onRead,
  });
  world?.close();
  process.stderr.write('\n');
  // Only files the set publishes as leaves (a file that did not translate, e.g. in the 1999 world, is not one).
  const leafPack = (ids: number[]) => putObject(buildPack(ids.filter((id) => !leaves || leaves.has(id)).map((id) => ({ id, data: read('portal', id) }))));
  const ref = (p: Planned) => ({ hash: hex(p.hash), size: p.size, gzSize: p.gzSize });
  const common = plan.common.length ? leafPack(plan.common) : null;
  const tiles = [...plan.tiles].map(([tile, ids]) => ({ tile, p: leafPack(ids) }));
  const index = putObject(buildAreaIndex(areaTile, common ? { ...ref(common), files: plan.common.length } : null, tiles.map(({ tile, p }) => ({ tile, ref: ref(p) }))));
  const tsz = tiles.map((t) => t.p.gzSize).sort((a, b) => a - b);
  const report = `  area packs: ${tiles.length} tiles of ${areaTile}x${areaTile} (${mb(tiles.reduce((s, t) => s + t.p.gzSize, 0))} gz; median ${(tsz[tsz.length >> 1] / 1024).toFixed(0)} KB, max ${mb(tsz[tsz.length - 1])}), `
    + `${world ? '' : '(no world DB) '}common ${plan.common.length} leaves ${mb(common?.gzSize ?? 0)} gz (> ${areaCommon} landblocks), index ${(index.gzSize / 1024).toFixed(0)} KB gz ${index.key}; planned in ${((Date.now() - ta) / 1000).toFixed(0)} s`;
  return { index, report };
}

/**
 * --areas-only <pointer url>: add area packs to a set that is already live, changing nothing else.
 * The new pointer is the live one plus `areas`: same manifest, same packs, so a client that ignores
 * the key loads exactly what it did. The live boot / world / ui packs (not this checkout's pack
 * lists, which may have moved on) decide which leaves the area packs leave out. Stages only the new
 * objects and the pointer; upload with tools/upload-stream-set-r2.ts.
 */
async function areasOnly(pointerUrl: string): Promise<void> {
  const t0 = Date.now();
  const base = pointerUrl.slice(0, pointerUrl.indexOf('/v1/sets/'));
  const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
  const live = JSON.parse(new TextDecoder().decode(await get(pointerUrl))) as { set: string; packs: Record<string, { key: string }>; areas?: unknown; [k: string]: unknown };
  const inPacks = new Set<number>();
  for (const role of ['boot', 'world', 'ui']) {
    const ref = live.packs[role];
    if (!ref) continue;
    for (const id of parsePack(gunzipSync(await get(`${base}/${ref.key}`))).ids) inPacks.add(id >>> 0);
  }
  const dbs = {} as Record<DatName, DatDatabase>;
  const overlays: Ac1999DatOverlay[] = [];
  for (const name of ['portal', 'cell'] as const) {
    dbs[name] = new DatDatabase(new FileDatBytes(join(datDir, SET_FILES[name]!)));
    // The 1999 world reads through the overlay, as its set was published (end-of-retail formats).
    if (ac1999World) {
      const ov = name === 'portal' ? ac1999PortalOverlay({ onError: () => {} }) : ac1999CellOverlay({ onError: () => {} });
      dbs[name].setOverlay(ov);
      overlays.push(ov);
    }
  }
  // The DATs must be the live set's own: a tile pack carries their bytes under the set's ids.
  for (const name of ['portal', 'cell'] as const) {
    const want = (live.iterations as Record<string, number> | undefined)?.[name];
    const have = iterationOf(dbs[name]);
    if (want !== have) throw new Error(`--areas-only: ${join(datDir, SET_FILES[name]!)} is iteration ${have}, the live set ${live.set} is ${want} (wrong --dat-dir?)`);
  }
  let reads = 0;
  const dropOverlayCaches = () => { if (overlays.length && ++reads % 512 === 0) for (const o of overlays) o.clearCache(); };
  stageDir = resolve(opt('--stage', join(tmpdir(), 'acjs-dat-publish', `${live.set}-areas`))!);
  writeStage = true;
  mkdirSync(join(stageDir, 'v1/o'), { recursive: true });
  mkdirSync(join(stageDir, 'v1/sets'), { recursive: true });
  const read = (dat: DatName, id: number) => { dropOverlayCaches(); const d = dbs[dat].getFileData(id); if (!d) throw new Error(`${dat} 0x${(id >>> 0).toString(16)}: unreadable`); return new Uint8Array(d); };
  // The live set's leaves are the only files a client can be sent: an area pack holds nothing else.
  const liveLeaves = new Set<number>();
  {
    const live = await get(`${base}/${(JSON.parse(new TextDecoder().decode(await get(pointerUrl))) as { manifest: { key: string } }).manifest.key}`);
    for (const id of parseSetManifest(gunzipSync(live)).leaves.portal.keys()) liveLeaves.add(id >>> 0);
  }
  const { index, report } = buildAreas(dbs, inPacks, read, liveLeaves, dropOverlayCaches);
  const pointer = { ...live, areas: { key: index.key, size: index.size, gzSize: index.gzSize } };
  writeFileSync(join(stageDir, `v1/sets/${live.set}.json`), JSON.stringify(pointer, null, 2) + '\n');
  console.log(`\nareas for live set ${live.set} (${inPacks.size} leaves already in its boot / world / ui packs), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(report);
  console.log(`  staged ${objects.size} objects + the pointer in ${stageDir}`);
  console.log(`  upload: UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> ${stageDir}`);
}

function uploadCommands(setName: string): string[][] {
  const common = ['--s3-no-check-bucket', '--transfers', '64', '--checkers', '64', '--retries', '5', '--stats-one-line', '--stats', '30s'];
  const cmds: string[][] = [
    // 1. immutable objects first; --ignore-existing makes re-runs upload only what is missing
    ['rclone', 'copy', join(stageDir, 'v1/o'), `${remote}:${bucket}/v1/o`, '--ignore-existing', ...common,
      '--header-upload', `Cache-Control: ${IMMUTABLE}`, '--header-upload', 'Content-Type: application/octet-stream'],
  ];
  if (includeRaw) {
    for (const file of Object.values(SET_FILES)) {
      cmds.push(['rclone', 'copyto', join(datDir, file), `${remote}:${bucket}/v1/raw/${setName}/${file}`, '--ignore-existing', ...common,
        '--s3-chunk-size', '64M', '--header-upload', `Cache-Control: ${IMMUTABLE}`, '--header-upload', 'Content-Type: application/octet-stream']);
    }
  }
  // 2. the set pointer last (the only mutable key), so it never names a missing object
  cmds.push(['rclone', 'copyto', join(stageDir, `v1/sets/${setName}.json`), `${remote}:${bucket}/v1/sets/${setName}.json`, ...common,
    '--header-upload', `Cache-Control: ${POINTER_CACHE}`, '--header-upload', 'Content-Type: application/json']);
  return cmds;
}

const areasOnlyUrl = opt('--areas-only');
if (areasOnlyUrl) void areasOnly(areasOnlyUrl).catch((err) => { console.error(err); process.exit(1); });
else main();
