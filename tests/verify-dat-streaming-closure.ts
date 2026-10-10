/**
 * RELEASE.dat-streaming / RELEASE.portal-space-cell-gate — closure
 * completeness against the real EoL DATs: after DatClosure makes a
 * destination resident (what the portal-space gate waits for), the SHIPPED
 * synchronous builders — LandblockObjectStreamer with the real model /
 * material / texture / EnvCell / scenery code, DungeonRenderer, the player's
 * Setup + MotionManager — build it without a single streamed-DAT miss.
 *
 * The store is a real DatStore over an in-memory "bucket" made from the
 * local DATs in the published layout (skeleton + terrain packs, per-landblock
 * bundles, per-file leaves). Objects are gzip'd on first fetch; hashes are
 * synthetic (verifyHash off) so the test never hashes 380 MB of leaves.
 */
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { SKELETON_TYPES, type DatSetManifest, type DatSetPointer, type ObjectRef } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatStore, DEFAULT_MAX_CONCURRENT, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { DatClosure, layoutArtIds } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { parseMasterProperty, setMasterPropertyTypes } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { CellGate } from '../packages/renderer/src/dat/streaming/PortalSpaceGate.js';
import { appearanceRoots } from '../packages/renderer/src/dat/streaming/ArrivalEvents.js';
import { buildPack } from './_harness/datSet.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const HAVE_DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
const HX = 0xA9, HY = 0xB4; // Holtburg
const DUNGEON = 0x01F6; // Holtburg dungeon (drop cell 0x01F60289)
const ITERATION = 0xffff0001;

describe.skipIf(!HAVE_DATS)('DatClosure over the real EoL DATs', () => {
  let store: DatStore;
  let closure: DatClosure;
  let portalSrc: DatDatabase;
  let regionDesc: RegionDesc;
  const fetched: string[] = [];
  /** Published object hash → its gzip bytes (the fake bucket). */
  const gzOf = new Map<string, () => Uint8Array>();
  /** A second, independent store + closure over the same bucket, with its own fetcher. */
  let freshClosure: (fetchObject: (url: string) => Promise<Uint8Array>) => { store: DatStore; closure: DatClosure };

  beforeAll(() => {
    portalSrc = openDat(DAT_PATHS.portal);
    const cellSrc = openDat(DAT_PATHS.cell);
    const lazyRef = (hash: string, size: number, payload: () => Uint8Array): ObjectRef => {
      let gz: Uint8Array | null = null;
      const get = () => (gz ??= new Uint8Array(gzipSync(payload(), { level: 1 })));
      gzOf.set(hash, get);
      return { hash, size, get gzSize() { return get().length; } } as ObjectRef;
    };
    const hex = (n: number, w: number) => (n >>> 0).toString(16).padStart(w, '0');
    const read = (db: DatDatabase, id: number) => new Uint8Array(db.getFileData(id)!);

    // Portal: skeleton pack + a leaf per other file.
    const skeleton: Array<{ id: number; data: Uint8Array }> = [];
    const leaves = new Map<number, ObjectRef>();
    for (const id of portalSrc.listFileIds()) {
      if (id === ITERATION) continue;
      if (SKELETON_TYPES.has(id >>> 24)) skeleton.push({ id, data: read(portalSrc, id) });
      else leaves.set(id, lazyRef(`01${hex(id, 8)}000000`, portalSrc.getFileEntry(id)!.fileSize, () => read(portalSrc, id)));
    }
    // Cell: terrain + bundles for a box around Holtburg and the dungeon block.
    const blocks = new Set<number>([DUNGEON]);
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) blocks.add(((HX + dx) << 8) | (HY + dy));
    const byBlock = new Map<number, number[]>();
    const terrain: Array<{ id: number; data: Uint8Array }> = [];
    for (const id of cellSrc.listFileIds()) {
      const lb = id >>> 16;
      if (id === ITERATION || !blocks.has(lb)) continue;
      if ((id & 0xffff) === 0xffff) terrain.push({ id, data: read(cellSrc, id) });
      else { let l = byBlock.get(lb); if (!l) byBlock.set(lb, l = []); l.push(id); }
    }
    const bundles = new Map<number, ObjectRef>();
    for (const [lb, ids] of byBlock) {
      const payload = buildPack(ids.map((id) => ({ id, data: read(cellSrc, id) })));
      bundles.set(lb, lazyRef(`02${hex(lb, 4)}0000000000`, payload.length, () => payload));
    }
    const manifest: DatSetManifest = { leaves: { portal: leaves, highres: new Map() }, packs: new Map(), bundles };
    const pointer: DatSetPointer = {
      format: 1, set: 'test-eol', iterations: { portal: 2072, cell: 982, local: 994, highres: 497 },
      manifest: { hash: '0000000000000000', size: 0, gzSize: 0 }, packs: {},
    };
    store = DatStore.fromParts('https://dats.test', pointer, manifest, {
      verifyHash: false,
      fetchObject: async (url) => { const h = url.slice(url.lastIndexOf('/') + 1); fetched.push(h); return gzOf.get(h)!(); },
    });
    store.addPackBytes('skeleton', buildPack(skeleton));
    store.addPackBytes('terrain', buildPack(terrain));
    regionDesc = new RegionDesc(new DatReader(store.db('portal').getFileData(0x13000000)!));
    closure = new DatClosure(store, { regionDesc: () => regionDesc });
    const skeletonPack = buildPack(skeleton);
    const terrainPack = buildPack(terrain);
    freshClosure = (fetchObject) => {
      const s = DatStore.fromParts('https://dats.test', pointer, manifest, { verifyHash: false, fetchObject });
      s.addPackBytes('skeleton', skeletonPack);
      s.addPackBytes('terrain', terrainPack);
      return { store: s, closure: new DatClosure(s, { regionDesc: () => regionDesc }) };
    };
  }, 120_000);

  /** The real renderer stack over the streamed DATs (the dat-access-sim wiring). */
  async function renderers() { return rendererStack(store); }
  async function rendererStack(store: DatStore) {
    const portalDb = store.db('portal');
    const cellDb = store.db('cell');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { DegradeLod } = await import('../packages/renderer/src/models/DegradeLod.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SceneryInstancer } = await import('../packages/renderer/src/terrain/SceneryInstancer.js');
    const textureManager = new TextureManager(portalDb, 2048, 4096, null);
    const materialFactory = new MaterialFactory(portalDb, textureManager);
    const modelRenderer = new ModelRenderer(portalDb, materialFactory);
    const setupModelRenderer = new SetupModelRenderer(portalDb, modelRenderer);
    const degradeLod = new DegradeLod(portalDb);
    setupModelRenderer.setDegradeLod(degradeLod);
    const envCellRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupModelRenderer, modelRenderer);
    const sceneryInstancer = new SceneryInstancer(modelRenderer, setupModelRenderer);
    envCellRenderer.setInstancer(sceneryInstancer);
    envCellRenderer.setDegradeLod(degradeLod);
    return { portalDb, cellDb, textureManager, materialFactory, modelRenderer, setupModelRenderer, degradeLod, envCellRenderer, sceneryInstancer };
  }

  it('a Holtburg arrival: the gate makes the 3×3 ring resident in a few waves, then the real streamer builds it with no miss', async () => {
    const gate = new CellGate(closure, { objectRadius: () => 1 });
    expect(gate.isSatisfied((HX << 24 | HY << 16 | 0x0019) >>> 0)).toBe(false);
    const t0 = fetched.length;
    const out = await gate.prefetch((HX << 24 | HY << 16 | 0x0019) >>> 0);
    expect(out.ok).toBe(true);
    expect(gate.isSatisfied((HX << 24 | HY << 16 | 0x0019) >>> 0)).toBe(true);
    const objects = fetched.length - t0;
    expect(objects).toBeGreaterThan(100); // bundles + GfxObjs + textures + palettes (doc §1: ~760 leaves for 3×3 + ring)

    const r = await renderers();
    const { SceneryInstancePool } = await import('../packages/renderer/src/terrain/SceneryInstancePool.js');
    const { LandblockObjectStreamer } = await import('../packages/renderer/src/world/LandblockObjectStreamer.js');
    const { createLandblockSceneryBuilder } = await import('../packages/renderer/src/world/LandblockScenery.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const noop = () => {};
    const pool = (n: string) => new SceneryInstancePool(r.sceneryInstancer, n, noop, noop, { lod: r.degradeLod } as never);
    const collision = new DungeonCollision();
    const warns: string[] = [];
    const warn = { warn: (d: string) => { warns.push(d); } };
    const streamer = new LandblockObjectStreamer({
      cellDb: r.cellDb, addToScene: noop, removeFromScene: noop, setTerrainVisible: noop,
      instancer: r.sceneryInstancer, sceneryPool: pool('s'), staticsPool: pool('t'), buildingsPool: pool('b'),
      envCells: r.envCellRenderer, setupModels: r.setupModelRenderer, models: r.modelRenderer, degradeLod: r.degradeLod,
      collision, objectPhysics: () => null,
      buildScenery: createLandblockSceneryBuilder({ cellDb: r.cellDb, portalDb: r.portalDb, regionDesc, hasModel: (id) => r.sceneryInstancer.hasModel(id), objectPhysics: () => null, collision, warn }),
      warn, onCollisionMeshesChanged: noop, loadRadius: 8, budgetMs: 1e9,
    } as never);
    const { scope } = store.scoped(() => {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) streamer.loadNow(HX + dx, HY + dy);
    });
    expect([...scope.keys].map((k) => k.toString(16))).toEqual([]);
    expect(streamer.totalModelsPlaced).toBeGreaterThan(50);
    expect(streamer.census().blocks).toBe(9);
  }, 120_000);

  it('the walk is pipelined: one slow file does not hold back the rest of the closure (real-GPU gate check, 2026-10-06)', async () => {
    // A cold edge-cache miss to R2 costs ~0.5 s. Behind a per-depth barrier every
    // level waited for its slowest fetch; pipelined, only the slow file's own
    // subtree waits. Hold the first portal leaf the Holtburg block asks for and
    // let everything else run: the rest of the closure must arrive meanwhile.
    const hash = (url: string) => url.slice(url.lastIndexOf('/') + 1);
    // Reference run: every file the block's closure fetches.
    const all = new Set<string>();
    const ref = freshClosure(async (url) => { all.add(hash(url)); return gzOf.get(hash(url))!(); });
    await ref.closure.ensureLandblock((HX << 8) | HY);
    expect(all.size).toBeGreaterThan(100);

    const during = new Set<string>();
    let held: string | null = null;
    let release!: () => void;
    const releaseP = new Promise<void>((r) => { release = r; });
    let last = Date.now();
    const run = freshClosure(async (url) => {
      const h = hash(url);
      last = Date.now();
      if (held === null && h.startsWith('01')) { held = h; await releaseP; return gzOf.get(h)!(); }
      if (held !== null) during.add(h);
      await new Promise((r) => setTimeout(r, 1));
      return gzOf.get(h)!();
    });
    const done = run.closure.ensureLandblock((HX << 8) | HY);
    // Wait for the fetch stream to go quiet with the one file still held.
    while (held === null || Date.now() - last < 150) await new Promise((r) => setTimeout(r, 20));
    // Behind a level barrier only the held file's level could be in flight
    // (a small fraction); pipelined, nearly the whole closure has landed.
    expect(during.size).toBeGreaterThan(all.size * 0.6);
    release();
    await done;
    expect(run.closure.isLandblockReady((HX << 8) | HY)).toBe(true);
  }, 120_000);

  it('area packs carry exactly the leaves the gate\'s walk fetches: the publish planner and the client agree (RELEASE.streaming-area-packs)', async () => {
    // The client: every portal leaf ensureLandblock fetches for Holtburg (leaf hashes are "01" + id).
    const fetchedLeaves = new Set<number>();
    const run = freshClosure(async (url) => {
      const h = url.slice(url.lastIndexOf('/') + 1);
      if (h.startsWith('01')) fetchedLeaves.add(parseInt(h.slice(2, 10), 16));
      return gzOf.get(h)!();
    });
    await run.closure.ensureLandblock((HX << 8) | HY);
    // The publish tool: the same block through tools/lib/area-packs.ts over the local DATs.
    const { planAreas } = await import('../tools/lib/area-packs.js');
    const plan = planAreas({ portal: portalSrc, cell: openDat(DAT_PATHS.cell), regionDesc, commonThreshold: Infinity, tileSize: 4, landblocks: [(HX << 8) | HY] });
    const planned = plan.blockLeaves.get((HX << 8) | HY)!;
    expect(fetchedLeaves.size).toBeGreaterThan(100);
    expect([...fetchedLeaves].filter((id) => !planned.has(id))).toEqual([]);
    expect([...planned].filter((id) => !fetchedLeaves.has(id))).toEqual([]);
    // With nothing common, the block's tile pack holds all of them.
    const tile = plan.tiles.get(((HX >> 2) << 8) | (HY >> 2))!;
    expect(new Set(tile)).toEqual(planned);
  }, 120_000);

  it('the store keeps DEFAULT_MAX_CONCURRENT (96) fetches in flight: Cloudflare allows 100 HTTP/2 streams', async () => {
    let inFlight = 0, peak = 0;
    const run = freshClosure(async (url) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return gzOf.get(url.slice(url.lastIndexOf('/') + 1))!();
    });
    await run.closure.ensureLandblockRing(HX, HY, 1);
    expect(DEFAULT_MAX_CONCURRENT).toBe(96);
    expect(peak).toBe(DEFAULT_MAX_CONCURRENT);
  }, 120_000);

  it('the login / teleport "pink bubbles": the PhysicsScriptTable\'s Hidden and UnHide emitters resolve textured after the gate (2026-10-06)', async () => {
    // CPhysicsObj::set_hidden plays the object's table entries for Hidden (0x76) /
    // UnHide (0x75) on every arrival. Their emitters' HW GfxObjs + textures were
    // not in the gate's closure, so on a cold stream the bubbles drew as white
    // squares (Jake, 2026-10-06, right after DAT streaming went live).
    const run = freshClosure(async (url) => gzOf.get(url.slice(url.lastIndexOf('/') + 1))!());
    await run.closure.ensure(appearanceRoots({ setupId: 0x02000001, motionTableId: 0x09000001, peTableId: 0x34000004 }));
    const r = await rendererStack(run.store);
    const { resolveEmitterSprite } = await import('../packages/renderer/src/effects/EmitterSprite.js');
    const { PhysicsScript, PhysicsScriptTable } = await import('../packages/dat-parser/src/file-types/PhysicsScript.js');
    const { ParticleEmitterInfo } = await import('../packages/dat-parser/src/file-types/ParticleEmitterInfo.js');
    const table = PhysicsScriptTable.read(new DatReader(r.portalDb.getFileData(0x34000004)!));
    const emitters = new Set<number>();
    for (const key of [0x75, 0x76]) {
      for (const e of table.scripts.get(key) ?? []) {
        for (const step of PhysicsScript.read(new DatReader(r.portalDb.getFileData(e.scriptId)!)).steps) {
          const h = step.hook as { hookType: number; emitterInfoId?: number } | null;
          if (h?.hookType === 13 && h.emitterInfoId) emitters.add(h.emitterInfoId);
        }
      }
    }
    expect(emitters.has(0x3200028C)).toBe(true);
    const sprites = run.store.scoped(() => [...emitters].map((id) => resolveEmitterSprite(new ParticleEmitterInfo(new DatReader(r.portalDb.getFileData(id)!)), r.portalDb, r.textureManager)));
    expect([...sprites.scope.keys].map((k) => k.toString(16))).toEqual([]);
    expect(sprites.result.every((sp) => sp !== null && !!sp.map)).toBe(true);
  }, 120_000);

  it('a dungeon arrival: the whole block resident, then DungeonRenderer builds it with no miss', async () => {
    await closure.ensureLandblock(DUNGEON);
    const r = await renderers();
    const { DungeonRenderer } = await import('../packages/renderer/src/world/DungeonRenderer.js');
    const dungeon = new DungeonRenderer(r.cellDb, r.envCellRenderer);
    const { result, scope } = store.scoped(() => dungeon.createDungeon(((DUNGEON << 16) | 0xffff) >>> 0));
    expect([...scope.keys].map((k) => k.toString(16))).toEqual([]);
    expect(result?.children.length ?? 0).toBeGreaterThan(100);

    // The torches' DefaultScript emitters (Setup → PhysicsScript → CreateParticle →
    // ParticleEmitterInfo → HW GfxObj) draw textured, not as white quads.
    const { resolveEmitterSprite } = await import('../packages/renderer/src/effects/EmitterSprite.js');
    const { EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const { PhysicsScript } = await import('../packages/dat-parser/src/file-types/PhysicsScript.js');
    const { ParticleEmitterInfo } = await import('../packages/dat-parser/src/file-types/ParticleEmitterInfo.js');
    const emitters = new Set<number>();
    for (const cid of store.bundleIds(DUNGEON)) {
      if ((cid & 0xffff) === 0xfffe) continue;
      for (const st of new EnvCell(new DatReader(r.cellDb.getFileData(cid)!)).staticObjects) {
        if (st.id >>> 24 !== 0x02) continue;
        const setup = new SetupModel(new DatReader(r.portalDb.getFileData(st.id)!));
        if (!setup.defaultScript) continue;
        for (const step of PhysicsScript.read(new DatReader(r.portalDb.getFileData(setup.defaultScript)!)).steps) {
          const h = step.hook as { hookType: number; emitterInfoId?: number } | null;
          if (h?.hookType === 13 && h.emitterInfoId) emitters.add(h.emitterInfoId);
        }
      }
    }
    expect(emitters.size).toBeGreaterThan(0);
    const sprites = store.scoped(() => [...emitters].map((id) => resolveEmitterSprite(new ParticleEmitterInfo(new DatReader(r.portalDb.getFileData(id)!)), r.portalDb, r.textureManager)));
    expect(sprites.scope.missed).toBe(false);
    expect(sprites.result.every((sp) => sp !== null)).toBe(true);
  }, 120_000);

  it('the player\'s model: Setup + motion table roots, then the real model build + default stance with no miss', async () => {
    const roots = appearanceRoots({ setupId: 0x02000001, motionTableId: 0x09000001 });
    const res = await closure.ensure(roots);
    expect(res.waves).toBeGreaterThan(0);
    const r = await renderers();
    const { MotionManager } = await import('../packages/renderer/src/animation/MotionManager.js');
    const { result, scope } = store.scoped(() => {
      const mesh = r.setupModelRenderer.createSetupMesh(0x02000001);
      const mm = new MotionManager(r.portalDb);
      const t = mm.loadMotionTable(0x09000001);
      if (t) { mm.setMotionTable(t); mm.setDefaultStance(); mm.update(0.1); }
      return mesh;
    });
    expect([...scope.keys].map((k) => k.toString(16))).toEqual([]);
    expect(result).not.toBeNull();
  }, 120_000);

  it('without a prefetch the build misses; rebuilding on arrival converges to a complete model', async () => {
    const r = await renderers();
    // A Setup far from Holtburg's closure: the highest-numbered one in the DAT.
    const setupId = Math.max(...r.portalDb.listFileIds(0x02));
    let rounds = 0;
    let last = store.scoped(() => r.setupModelRenderer.createSetupMesh(setupId));
    expect(last.scope.missed).toBe(true);
    while (last.scope.missed && rounds < 6) {
      await store.ensure(last.scope.keys);
      rounds++;
      last = store.scoped(() => r.setupModelRenderer.createSetupMesh(setupId));
    }
    expect(last.scope.missed).toBe(false);
    expect(rounds).toBeLessThanOrEqual(4); // GfxObj → surfaces → textures → palettes
  }, 60_000);

  it('UI art made resident before entering (StreamingDats.uiArtReady): the login gate then fetches the destination only', async () => {
    // 2026-10-05 regression: the HUD art loaded at Background priority behind char select and
    // the login gate's critical requests joined it, holding the gate 2–5× longer than when the art
    // was resident before char select. Now main() awaits uiArtReady with the world packs.
    setMasterPropertyTypes(parseMasterProperty(new DatReader(store.db('portal').getFileData(0x39000001)!)));
    const uiRoots = layoutArtIds(openDat(DAT_PATHS.local)).filter((id) => store.exists('portal', id)).map((id) => fileKey('portal', id));
    await closure.ensure(uiRoots);
    const uiIds = new Set(uiRoots.map((k) => k % 0x100000000));
    const gate = new CellGate(closure, { objectRadius: () => 1 });
    const dest = (((HX - 2) << 24) | (HY << 16) | 0x0019) >>> 0;
    const t0 = fetched.length;
    const out = await gate.prefetch(dest, [...appearanceRoots({ setupId: 0x02000001, motionTableId: 0x09000001 }), ...uiRoots]);
    expect(out.ok).toBe(true);
    const during = fetched.slice(t0).filter((h) => h.startsWith('01')).map((h) => parseInt(h.slice(2, 10), 16));
    expect(during.length).toBeGreaterThan(0); // the new destination's objects
    expect(during.filter((id) => uiIds.has(id))).toEqual([]);
  }, 120_000);

  it('the layout art the login gate waits for: every LayoutDesc image the HUD and panels draw', () => {
    setMasterPropertyTypes(parseMasterProperty(new DatReader(store.db('portal').getFileData(0x39000001)!)));
    const ids = layoutArtIds(openDat(DAT_PATHS.local));
    const textures = ids.filter((id) => id >>> 24 === 0x06);
    expect(textures.length).toBeGreaterThan(150); // docs/dat-streaming.md §1 ui-all: ~200 leaves
    expect(ids.every((id) => [0x04, 0x05, 0x06, 0x08, 0x40].includes(id >>> 24))).toBe(true);
    expect(textures.every((id) => portalSrc.hasFile(id) || openDat(DAT_PATHS.highres).hasFile(id))).toBe(true);
  });

  it('the layouts\' fonts are UI art, and the closure makes their glyph + halo surfaces resident (wrong-font labels, 2026-10-06)', async () => {
    setMasterPropertyTypes(parseMasterProperty(new DatReader(store.db('portal').getFileData(0x39000001)!)));
    const fonts = layoutArtIds(openDat(DAT_PATHS.local)).filter((id) => id >>> 24 === 0x40);
    expect(fonts.length).toBeGreaterThan(0);
    const run = freshClosure(async (url) => gzOf.get(url.slice(url.lastIndexOf('/') + 1))!());
    await run.closure.ensure(fonts.filter((id) => run.store.exists('portal', id)).map((id) => fileKey('portal', id)));
    const r = await rendererStack(run.store);
    const { ACFont } = await import('../packages/dat-parser/src/file-types/ACFont.js');
    const { scope } = run.store.scoped(() => {
      for (const id of fonts) {
        const data = r.portalDb.getFileData(id);
        if (!data) continue;
        const f = ACFont.read(new DatReader(data));
        if (f.foregroundSurfaceDataId) r.textureManager.getIconRGBA(f.foregroundSurfaceDataId);
        if (f.backgroundSurfaceDataId) r.textureManager.getIconRGBA(f.backgroundSurfaceDataId);
      }
    });
    expect([...scope.keys].map((k) => k.toString(16))).toEqual([]);
  }, 120_000);
});
