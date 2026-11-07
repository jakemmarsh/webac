/**
 * BUG.scenery-pop-in-order — offline, real-DAT measurement of WHEN each
 * landscape object (scenery, landblock statics, building shells) first draws
 * as a player runs, against when retail would have drawn it.
 *
 * Drives the shipped LandblockObjectStreamer + LandblockScenery (and the
 * shipped DegradeLod level selection over the real DIDDegrade chains) along
 * a scripted walk, with a simulated streamed-DAT network behind the
 * streamer's blockData hook: each block's closure takes `latencyS` once it
 * starts, at most `concurrency` blocks at once, Critical before Prefetch,
 * FIFO within a priority (DatStore's Limiter), re-requests promote. Mesh
 * builders are stubs: what is measured is which object's block is in the
 * pools at each tick and whether its degrade level draws.
 *
 * Retail (LScape::update_block @ 005063a0) loads every block of its grid
 * synchronously from the local DAT (DBObj::Get / LScape::get_all), and a
 * full-detail block (the 3×3 around the viewer, CLandBlock::
 * notify_change_size @ 005302c0) builds its statics, buildings and scenery
 * at once (CLandBlock::init_static_objs @ 00530a40 → get_land_scenes @
 * 00530460). So "retail first drawn" for an object = the first tick its
 * block is within the 3×3 AND its degrade level (get_degrade @ 0051e4b0) is
 * not INVALID. An object that WE draw later than that popped in late; the
 * distance at which it finally appeared is what the player saw.
 *
 * Distances are 2-D (the land-cell 2-D distance beyond 50 m is retail's
 * own rule, RenderDeviceD3D::UpdateObjCell @ 005a0690; inside 50 m height
 * is ignored here, which only matters at level-0 range where nothing is
 * INVALID).
 *
 * Usage: npx tsx tools/probe-scenery-popin-order.ts [--latency 3] [--conc 2] [--speed 10]
 *        [--path east|ne|teleport] [--era eol|dm|1999]
 */
import * as THREE from 'three';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { LandblockObjectStreamer, type LandblockObjectStreamerDeps } from '../packages/renderer/src/world/LandblockObjectStreamer.js';
import { createLandblockSceneryBuilder } from '../packages/renderer/src/world/LandblockScenery.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { DegradeLod, INVALID_DID, MAX_CELL_2D_DEGRADE_DISTANCE, landCellCenter, type DegradeChain } from '../packages/renderer/src/models/DegradeLod.js';
import type { InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';

/** Priority classes, as DatStore.FetchPriority. */
const CRITICAL = 0, PREFETCH = 1;

/** A block-closure network: latency per block, a concurrency cap, priority FIFO, promote on re-request. */
export class SimBlockNet {
  private readonly ready = new Set<number>();
  private readonly queued = new Map<number, { prio: number; seq: number; resolve: () => void; promise: Promise<void> }>();
  private readonly active = new Map<number, { doneAt: number; resolve: () => void }>();
  private seq = 0;
  /** Block keys in the order their fetch STARTED. */
  readonly startOrder: number[] = [];
  constructor(private readonly latencyS: number, private readonly concurrency: number) {}
  markReady(bx: number, by: number): void { this.ready.add((bx << 8) | by); }
  isReady(bx: number, by: number): boolean { return this.ready.has((bx << 8) | by); }
  request(bx: number, by: number, priority: number = PREFETCH): Promise<void> {
    const key = (bx << 8) | by;
    if (this.ready.has(key)) return Promise.resolve();
    const q = this.queued.get(key);
    if (q) { if (priority < q.prio) q.prio = priority; return q.promise; }
    const a = this.active.get(key);
    if (a) return new Promise<void>((r) => { const prev = a.resolve; a.resolve = () => { prev(); r(); }; });
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this.queued.set(key, { prio: priority, seq: this.seq++, resolve, promise });
    return promise;
  }
  /** Advance to time `t` (s): finish due fetches, start queued ones (best priority, then FIFO). */
  tick(t: number): void {
    for (const [key, a] of [...this.active]) {
      if (a.doneAt <= t) { this.active.delete(key); this.ready.add(key); a.resolve(); }
    }
    while (this.active.size < this.concurrency && this.queued.size > 0) {
      let bestKey = -1, best: { prio: number; seq: number } | null = null;
      for (const [k, q] of this.queued) if (!best || q.prio < best.prio || (q.prio === best.prio && q.seq < best.seq)) { best = q; bestKey = k; }
      const q = this.queued.get(bestKey)!;
      this.queued.delete(bestKey);
      this.active.set(bestKey, { doneAt: t + this.latencyS, resolve: q.resolve });
      this.startOrder.push(bestKey);
    }
  }
}

export interface WalkDats { portalDb: DatDatabase; cellDb: DatDatabase }

export interface WalkOptions {
  /** Start position (world metres: x = blockX·192 + local x, z = blockY·192 + local y). */
  start: { x: number; z: number };
  /** Waypoints the player runs through in order (world metres). */
  path: { x: number; z: number }[];
  /** Run speed, m/s. */
  speed?: number;
  /** Simulated tick, s. */
  dt?: number;
  /** null = whole local DATs (no streaming); else the simulated network. */
  net?: { latencyS: number; concurrency: number } | null;
  /** Teleport to this point halfway along (fast travel: the arrival ring is gate-ready, its prefetch ring is not). */
  teleportTo?: { x: number; z: number } | null;
  /** Ticks after the last waypoint (s). */
  settleS?: number;
  /**
   * The order before BUG.scenery-pop-in-order: no player position / heading
   * for the scheduler (block-centre distance, ties lowest key) and every
   * block fetched at prefetch priority (no promotion when the ring reaches it).
   */
  legacy?: boolean;
}

export interface PopIn { kind: 'scenery' | 'static' | 'building'; objId: number; dist: number; lateS: number; retailDist: number }

export interface WalkResult {
  objectsSeen: number;
  /** Objects drawn later than retail drew them. */
  late: PopIn[];
  /** Objects retail drew that never drew here by the end. */
  neverDrawn: number;
  /** Late objects that appeared within 60 m (right next to the player). */
  lateNear: number;
  /** Histogram of first-drawn distance (ours) for late objects, 0-60 / 60-120 / 120-200 / 200+. */
  lateHist: Record<string, number>;
  /** Block keys in the order the network started fetching them (streaming only). */
  fetchOrder: number[];
  /** Block keys in the order their scenery was built. */
  blocksBuiltOrder: number[];
}

/** 2-D degrade-aware "drawn" test for one object at `viewer` (retail get_degrade, Adaptive Degrade at deg_mul 1). */
function makeDrawnTest(dats: WalkDats): (objId: number, ox: number, oz: number, scale: number, vx: number, vz: number) => boolean {
  const lod = new DegradeLod(dats.portalDb);
  lod.setPrefs({ adaptiveDegrade: false, adaptiveDegradeBias: 1 });
  const partChains = new Map<number, (DegradeChain | null)[]>();
  const chainsOf = (objId: number): (DegradeChain | null)[] => {
    let c = partChains.get(objId);
    if (c) return c;
    if (((objId >>> 24) & 0xff) === 0x02) {
      const data = dats.portalDb.getFileData(objId);
      const setup = data ? new SetupModel(new DatReader(data)) : null;
      c = setup ? setup.parts.map((p) => lod.chainFor(p)) : [null];
    } else {
      c = [lod.chainFor(objId)];
    }
    partChains.set(objId, c);
    return c;
  };
  const cell = new THREE.Vector3();
  return (objId, ox, oz, scale, vx, vz) => {
    const chains = chainsOf(objId);
    landCellCenter(ox, oz, cell);
    const cellD = Math.hypot(cell.x - vx, cell.z - vz);
    const d = (cellD > MAX_CELL_2D_DEGRADE_DISTANCE ? cellD : Math.hypot(ox - vx, oz - vz)) / (scale || 1);
    for (const ch of chains) {
      if (!ch) return true;
      if (ch.levelIds[lod.levelFor(ch, d)] !== INVALID_DID) return true;
    }
    return false;
  };
}

type Rec = { kind: PopIn['kind']; objId: number; x: number; z: number; scale: number; retailT: number; retailD: number; oursT: number; oursD: number };

export async function runPopinWalk(dats: WalkDats, opts: WalkOptions): Promise<WalkResult> {
  const { portalDb, cellDb } = dats;
  const regionDesc = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
  const speed = opts.speed ?? 10;
  const dt = opts.dt ?? 0.2;
  const net = opts.net ? new SimBlockNet(opts.net.latencyS, opts.net.concurrency) : null;
  const collision = new DungeonCollision();
  const warn = { warn: () => {} };
  const pool = () => {
    const m = new Map<number, InstanceEntry[]>();
    return { m, addBlock: (k: number, e: InstanceEntry[]) => { m.set(k, e); }, removeBlock: (k: number) => { m.delete(k); }, setVisible: () => {} };
  };
  const scenery = pool(), statics = pool(), buildings = pool();
  const builtOrder: number[] = [];
  const sceneryBuilder = createLandblockSceneryBuilder({ cellDb, portalDb, regionDesc, hasModel: () => true, objectPhysics: () => null, collision, warn });
  const deps: LandblockObjectStreamerDeps = {
    cellDb,
    addToScene: () => {}, removeFromScene: () => {}, setTerrainVisible: () => {},
    instancer: { hasModel: () => true, getWorldBBox: (_id, m) => new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1)).applyMatrix4(m) },
    sceneryPool: scenery, staticsPool: statics, buildingsPool: buildings,
    envCells: { createCellMesh: () => new THREE.Group(), getCellCollisionData: () => null, loadEnvCell: () => null },
    setupModels: { createSetupMesh: () => null, loadSetupModel: () => null },
    models: { createMesh: () => null, loadGfxObj: () => null },
    degradeLod: { attachPart: () => false } as unknown as LandblockObjectStreamerDeps['degradeLod'],
    collision,
    objectPhysics: () => null,
    buildScenery: (bx, by) => { builtOrder.push((bx << 8) | by); return sceneryBuilder(bx, by); },
    warn,
    onCollisionMeshesChanged: () => {},
    loadRadius: 8,
    budgetMs: 1e9,
    ...(net ? { blockData: { isReady: (bx: number, by: number) => net.isReady(bx, by), request: (bx: number, by: number, urgent?: boolean) => net.request(bx, by, urgent && !opts.legacy ? CRITICAL : PREFETCH) } } : {}),
  };
  const streamer = new LandblockObjectStreamer(deps);
  const drawnAt = makeDrawnTest(dats);

  // Retail's view of every block's objects (built directly, instantly).
  const retailCache = new Map<number, Rec[]>();
  const recs = new Map<string, Rec>();
  const objectsOf = (bx: number, by: number): Rec[] => {
    const k = (bx << 8) | by;
    let list = retailCache.get(k);
    if (list) return list;
    list = [];
    const add = (kind: Rec['kind'], entries: InstanceEntry[]) => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i].matrix.elements;
        const key = `${k}:${kind}:${i}`;
        let r = recs.get(key);
        if (!r) {
          r = { kind, objId: entries[i].objId, x: e[12], z: e[14], scale: Math.hypot(e[4], e[5], e[6]), retailT: -1, retailD: 0, oursT: -1, oursD: 0 };
          recs.set(key, r);
        }
        list!.push(r);
      }
    };
    // The same builders the streamer runs: a throwaway streamer over whole DATs.
    const s = sceneryBuilder(bx, by);
    if (s) add('scenery', s.entries);
    const tmp = { s: pool(), b: pool(), c: pool() };
    const one = new LandblockObjectStreamer({ ...deps, blockData: undefined, buildScenery: undefined, staticsPool: tmp.s, buildingsPool: tmp.b, sceneryPool: tmp.c, collision: new DungeonCollision() });
    one.loadNow(bx, by);
    add('static', tmp.s.m.get(k) ?? []);
    add('building', tmp.b.m.get(k) ?? []);
    retailCache.set(k, list);
    return list;
  };
  const oursKind = { scenery: scenery.m, static: statics.m, building: buildings.m } as const;

  let px = opts.start.x, pz = opts.start.z;
  let hx = 1, hz = 0;
  { const w0 = opts.path[0]; const l = w0 ? Math.hypot(w0.x - px, w0.z - pz) : 0; if (l > 0) { hx = (w0.x - px) / l; hz = (w0.z - pz) / l; } }
  const blockOf = (v: number) => Math.floor(v / 192);
  const arrive = (x: number, z: number) => {
    px = x; pz = z;
    if (net) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) net.markReady(blockOf(x) + dx, blockOf(z) + dy); // the portal-space gate
    streamer.loadAround(blockOf(x), blockOf(z));
  };
  arrive(px, pz);

  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r)); };
  const sample = (t: number) => {
    const cbx = blockOf(px), cby = blockOf(pz);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bx = cbx + dx, by = cby + dy;
        const k = (bx << 8) | by;
        const list = objectsOf(bx, by);
        for (const r of list) {
          const d = Math.hypot(r.x - px, r.z - pz);
          const vis = drawnAt(r.objId, r.x, r.z, r.scale, px, pz);
          if (vis && r.retailT < 0) { r.retailT = t; r.retailD = d; }
          if (vis && r.oursT < 0 && oursKind[r.kind].has(k)) { r.oursT = t; r.oursD = d; }
        }
      }
    }
  };

  const waypoints = [...opts.path];
  const total = waypoints.reduce((acc, w, i) => acc + Math.hypot(w.x - (i ? waypoints[i - 1].x : opts.start.x), w.z - (i ? waypoints[i - 1].z : opts.start.z)), 0);
  let travelled = 0, teleported = !opts.teleportTo;
  let t = 0;
  sample(t);
  const settleTicks = Math.round((opts.settleS ?? 3) / dt);
  let settle = 0;
  while (settle < settleTicks) {
    t += dt;
    net?.tick(t);
    await flush();
    if (waypoints.length > 0) {
      let step = speed * dt;
      while (step > 0 && waypoints.length > 0) {
        const w = waypoints[0];
        const ddx = w.x - px, ddz = w.z - pz, len = Math.hypot(ddx, ddz);
        if (len < 1e-6) { waypoints.shift(); continue; }
        hx = ddx / len; hz = ddz / len;
        const m = Math.min(step, len);
        px += hx * m; pz += hz * m; step -= m; travelled += m;
        if (m === len) waypoints.shift();
      }
      if (!teleported && travelled >= total / 2) {
        teleported = true;
        const tp = opts.teleportTo!;
        const off = { x: px - tp.x, z: pz - tp.z };
        for (const w of waypoints) { w.x -= off.x; w.z -= off.z; }
        arrive(tp.x, tp.z);
      }
    } else {
      settle++;
    }
    if (opts.legacy) streamer.pump(blockOf(px), blockOf(pz));
    else streamer.pump(blockOf(px), blockOf(pz), { x: px, z: pz, dirX: hx, dirZ: hz });
    sample(t);
  }

  const late: PopIn[] = [];
  let neverDrawn = 0;
  for (const r of recs.values()) {
    if (r.retailT < 0) continue;
    if (r.oursT < 0) { neverDrawn++; continue; }
    if (r.oursT > r.retailT + 1e-6) late.push({ kind: r.kind, objId: r.objId, dist: r.oursD, lateS: r.oursT - r.retailT, retailDist: r.retailD });
  }
  const lateHist: Record<string, number> = { '0-60': 0, '60-120': 0, '120-200': 0, '200+': 0 };
  for (const p of late) lateHist[p.dist < 60 ? '0-60' : p.dist < 120 ? '60-120' : p.dist < 200 ? '120-200' : '200+']++;
  return {
    objectsSeen: [...recs.values()].filter((r) => r.retailT >= 0).length,
    late, neverDrawn, lateNear: late.filter((p) => p.dist < 60).length, lateHist,
    fetchOrder: net?.startOrder ?? [], blocksBuiltOrder: builtOrder,
  };
}

/** Holtburg (0xA9B4) centre and three walks out of it. */
export const HOLTBURG = { x: 0xa9 * 192 + 96, z: 0xb4 * 192 + 96 };
export function walkPath(kind: string): { start: { x: number; z: number }; path: { x: number; z: number }[]; teleportTo?: { x: number; z: number } } {
  const s = HOLTBURG;
  if (kind === 'ne') return { start: s, path: [{ x: s.x + 1100, z: s.z + 1100 }] };
  if (kind === 'teleport') return { start: s, path: [{ x: s.x + 1500, z: s.z }], teleportTo: { x: 0xda * 192 + 96, z: 0x55 * 192 + 96 } };
  return { start: s, path: [{ x: s.x + 1500, z: s.z }] };
}

const isMain = process.argv[1]?.endsWith('probe-scenery-popin-order.ts');
if (isMain) {
  const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
  const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
  const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.js');
  const openDat = (p: string) => new DatDatabase(new FileDatBytes(p));
  const sets = process.env.ACJS_DAT_SETS_DIR ?? 'dat-sets';
  const era = arg('era', 'eol');
  const paths = era === '1999' ? [`${sets}/ac1999-retail/portal.dat`, `${sets}/ac1999-retail/cell.dat`]
    : era === 'dm' ? [`${sets}/classic-dereth-1.1/client_portal.dat`, `${sets}/classic-dereth-1.1/client_cell_1.dat`]
      : ['dat/client_portal.dat', 'dat/client_cell_1.dat'];
  const dats = { portalDb: openDat(paths[0]), cellDb: openDat(paths[1]) };
  if (era === '1999') {
    // The AC1999 lane reads its DATs through the 1999 overlays (Ac1999Overlay.ts).
    const { ac1999PortalOverlay, ac1999CellOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.js');
    dats.portalDb.setOverlay(ac1999PortalOverlay());
    dats.cellDb.setOverlay(ac1999CellOverlay());
  }
  const latency = Number(arg('latency', '3')), conc = Number(arg('conc', '2'));
  for (const legacy of [true, false]) {
    const r = await runPopinWalk(dats, { ...walkPath(arg('path', 'east')), speed: Number(arg('speed', '10')), legacy, net: latency > 0 ? { latencyS: latency, concurrency: conc } : null });
    console.log(JSON.stringify({ order: legacy ? 'before' : 'after', era, path: arg('path', 'east'), latency, conc, objectsSeen: r.objectsSeen, late: r.late.length, lateNear: r.lateNear, neverDrawn: r.neverDrawn, lateHist: r.lateHist }));
    console.log('  fetch order:', r.fetchOrder.slice(0, 20).map((k) => k.toString(16)).join(' '));
  }
}
