/**
 * STREAM.login-pack-split — the world pack in three parts (docs/dat-streaming.md §6.16).
 *
 * Unit part (always runs): the split rule (WorldSplit.splitWorldPack), which pointers carry a
 * usable split, and openStreamingDats over a fake bucket: a split pointer loads worldCore +
 * worldLand + terrain for the login and never the whole world pack, worldChargen behind them
 * (Background, or Critical once character creation is asked for); an old pointer loads exactly
 * what it did; an interface-only set never fetches worldLand.
 *
 * Real-DAT part (end of retail, skipped without DATs): the publish tool's planner over the
 * world pack the access simulation lists, then the shipped GameUI over a DatStore holding the
 * char-select set + worldCore + worldLand + the ui pack and NOT worldChargen: the HUD preload
 * defers exactly what the chargen pack holds, the in-world HUD and panels and the terrain
 * materials build with no miss, and character creation waits for its pack, asks for it, then
 * opens complete when it lands.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SKELETON_TYPES, parseSetPointer, type DatSetManifest, type DatSetPointer, type ObjectRef } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatStore, FetchPriority, fileKey, gunzip, splitFileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { CHARGEN_LAYOUTS, WORLD_SPLIT_ROLES, hasWorldSplit, inWorldLayoutIds, splitWorldPack } from '../packages/renderer/src/dat/streaming/WorldSplit.js';
import { FakeBucket, buildManifest, buildPack, type Obj } from './_harness/datSet.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);
const BASE = 'https://dats.test';

describe('WorldSplit rule', () => {
  it('puts land files in worldLand, art only chargen layouts draw in worldChargen, everything else (shared art, models no layout draws) in worldCore', () => {
    const parts = splitWorldPack({
      worldIds: [0x06000001, 0x06000002, 0x06000003, 0x06000004, 0x01000005, 0x01000006, 0x06000007],
      art: { inWorld: new Set([0x06000002, 0x06000003, 0x01000006]), chargen: new Set([0x06000001, 0x06000003]) },
      landIds: new Set([0x06000004]),
    });
    expect(parts.worldLand).toEqual([0x06000004]);
    // 0x06000001: only chargen draws it.
    expect(parts.worldChargen).toEqual([0x06000001]);
    // 0x06000003 is shared with an in-world layout; 0x01000005 a model no layout draws (a chargen preview's
    // human base figure is every human NPC's too); 0x06000007 nobody's.
    expect(parts.worldCore).toEqual([0x01000005, 0x01000006, 0x06000002, 0x06000003, 0x06000007]);
  });

  it('the chargen layouts are gmCharGenMainUI and its pages; every other layout is in-world', () => {
    const local = { listFileIds: () => [0x21000004, 0x21000038, 0x21000046, 0x2100004c, 0x21000068], getFileData: () => null };
    expect(inWorldLayoutIds(local)).toEqual([0x21000004, 0x21000068]);
    expect(CHARGEN_LAYOUTS).toContain(0x21000038);
    expect(CHARGEN_LAYOUTS).not.toContain(0x21000068); // the barber is in-world
  });

  it('a split is usable only with every part the scope needs', () => {
    const p = { world: 1, worldCore: 1, worldChargen: 1, worldLand: 1 };
    expect(hasWorldSplit(p, 'all')).toBe(true);
    expect(hasWorldSplit({ ...p, worldLand: undefined }, 'all')).toBe(false);
    expect(hasWorldSplit({ ...p, worldLand: undefined }, 'interface')).toBe(true);
    expect(hasWorldSplit(p, 'world')).toBe(false);
    expect(hasWorldSplit({ world: 1 }, 'interface')).toBe(false);
  });

  it('parseSetPointer keeps the split roles, and still skips roles it does not know (how an older client reads a new pointer)', () => {
    const ref = { key: 'v1/o/0123456789abcdef', size: 1, gzSize: 1, files: 1 };
    const p = parseSetPointer({ format: 1, set: 's', manifest: ref, packs: { world: ref, worldCore: ref, worldChargen: ref, worldLand: ref, someFutureRole: ref } });
    expect(Object.keys(p.packs).sort()).toEqual(['world', 'worldChargen', 'worldCore', 'worldLand']);
  });
});

/** A fake set: the char-select packs, the whole world pack, and (split) its three parts. */
function makeSet(split: boolean) {
  const bucket = new FakeBucket();
  const pack = (files: Array<[number, string]>) => ({ ...bucket.put(buildPack(files.map(([id, s]) => ({ id, data: enc(s) })))), files: files.length });
  const hud: [number, string] = [0x06000200, 'hud-frame'];
  const portrait: [number, string] = [0x06000201, 'heritage-portrait'];
  const land: [number, string] = [0x06000202, 'land-texture'];
  const packs: Record<string, Obj & { files: number }> = {
    boot: pack([[0x06000100, 'boot-texture']]),
    local: pack([[0x23000001, 'strings']]),
    skeleton: pack([[0x02000001, 'setup'], [0x13000000, 'region']]),
    world: pack([hud, portrait, land]),
    terrain: pack([[0xA9B4FFFF, 'land-a9b4']]),
    ui: pack([[0x06000300, 'panel-art']]),
  };
  if (split) {
    packs.worldCore = pack([hud]);
    packs.worldChargen = pack([portrait]);
    packs.worldLand = pack([land]);
  }
  const role: Record<string, number> = { boot: 1, world: 2, skeleton: 3, terrain: 4, local: 5, ui: 6 };
  // The split parts are pointer-only: the manifest is the one an older client reads.
  const manifest = bucket.put(buildManifest({ packs: Object.entries(packs).filter(([r]) => role[r]).map(([r, p]) => ({ role: role[r], ...p })) }));
  const pointer = {
    format: 1, set: 'test-set', iterations: { portal: 2072, cell: 982, highres: 497, local: 994 },
    manifest: { key: `v1/o/${manifest.hash}`, hash: manifest.hash, size: manifest.size, gzSize: manifest.gzSize },
    packs: Object.fromEntries(Object.entries(packs).map(([r, p]) => [r, { key: `v1/o/${p.hash}`, size: p.size, gzSize: p.gzSize, files: p.files }])),
  };
  return { bucket, pointer, packs };
}

async function open(set: ReturnType<typeof makeSet>, scope: 'all' | 'interface' = 'all', fetchObject?: (url: string, o: { priority: FetchPriority }) => Promise<Uint8Array>, cache = new MemoryObjectCache()) {
  const { openStreamingDats } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
  return openStreamingDats({
    pointerUrl: `${BASE}/v1/sets/test-set.json`,
    fetchPointer: async () => JSON.parse(JSON.stringify(set.pointer)),
    fetchObject: fetchObject ?? set.bucket.fetch,
    cache,
    scope,
  });
}

describe('openStreamingDats over a split world pack', () => {
  it('backgroundPacks: the split parts stand in for the world pack', async () => {
    const { backgroundPacks } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    expect(backgroundPacks('all', true)).toEqual(['worldCore', 'worldLand', 'terrain']);
    expect(backgroundPacks('interface', true)).toEqual(['worldCore']);
    expect(backgroundPacks('all')).toEqual(['world', 'terrain']);
  });

  it('the login waits for worldCore + worldLand + terrain; the whole world pack is never fetched; worldChargen follows at Background', async () => {
    const set = makeSet(true);
    const prio = new Map<string, FetchPriority>();
    const sd = await open(set, 'all', async (url, o) => { prio.set(url.slice(url.lastIndexOf('/') + 1), o.priority); return set.bucket.fetch(url); });
    expect(sd.worldSplit).toBe(true);
    await sd.worldPacks;
    expect(sd.store.isPackResident('worldCore')).toBe(true);
    expect(sd.store.isPackResident('worldLand')).toBe(true);
    expect(sd.store.isPackResident('terrain')).toBe(true);
    expect(dec(sd.portal.getFileData(0x06000200))).toBe('hud-frame');
    await sd.uiArtReady;
    await sd.chargenArtReady;
    expect(dec(sd.portal.getFileData(0x06000201))).toBe('heritage-portrait');
    expect(set.bucket.requests).not.toContain(set.packs.world.hash);
    expect(prio.get(set.packs.worldCore.hash)).toBe(FetchPriority.Prefetch);
    expect(prio.get(set.packs.worldLand.hash)).toBe(FetchPriority.Prefetch);
    expect(prio.get(set.packs.worldChargen.hash)).toBe(FetchPriority.Background);
    // The chargen pack was requested only after the login's packs and the ui pack.
    const req = set.bucket.requests;
    expect(req.indexOf(set.packs.worldChargen.hash)).toBeGreaterThan(req.indexOf(set.packs.ui.hash));
    expect(req.indexOf(set.packs.worldChargen.hash)).toBeGreaterThan(req.indexOf(set.packs.worldLand.hash));
  });

  it('chargenArtDeferred: a file not resident while worldChargen is on its way waits; false once it has landed', async () => {
    const set = makeSet(true);
    const chargenHash = set.packs.worldChargen.hash;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const sd = await open(set, 'all', async (url) => { if (url.endsWith(chargenHash)) await held; return set.bucket.fetch(url); });
    await sd.worldPacks;
    await sd.uiArtReady;
    expect(sd.chargenArtDeferred(0x06000201)).toBe(true); // the portrait: in the chargen pack, not resident
    expect(sd.chargenArtDeferred(0x06000200)).toBe(false); // the HUD frame: resident (worldCore)
    release();
    await sd.chargenArtReady;
    expect(sd.chargenArtDeferred(0x06000201)).toBe(false);
  });

  it('wantChargenArt: character creation asked for before the login packs land fetches its pack at once, at Critical, and chargenArtReady does not wait for the land textures', async () => {
    const set = makeSet(true);
    const landHash = set.packs.worldLand.hash;
    let releaseLand!: () => void;
    const landHeld = new Promise<void>((r) => { releaseLand = r; });
    const prio = new Map<string, FetchPriority>();
    const sd = await open(set, 'all', async (url, o) => {
      const h = url.slice(url.lastIndexOf('/') + 1);
      prio.set(h, Math.min(prio.get(h) ?? 9, o.priority));
      if (h === landHash) await landHeld;
      return set.bucket.fetch(url);
    });
    sd.wantChargenArt();
    await sd.chargenArtReady;
    expect(sd.store.isPackResident('worldLand')).toBe(false);
    expect(prio.get(set.packs.worldChargen.hash)).toBe(FetchPriority.Critical);
    releaseLand();
    await sd.worldPacks;
  });

  it('an old pointer (no split) loads the whole world pack exactly as before; chargen has no pack of its own', async () => {
    const set = makeSet(false);
    const sd = await open(set);
    expect(sd.worldSplit).toBe(false);
    expect(sd.chargenArtReady).toBeNull();
    expect(sd.chargenArtDeferred(0x06000201)).toBe(false);
    await sd.worldPacks;
    expect(set.bucket.requests).toContain(set.packs.world.hash);
    expect(dec(sd.portal.getFileData(0x06000201))).toBe('heritage-portrait');
  });

  it('a profile that cached the whole world pack before the split keeps using it: no part is downloaded', async () => {
    const set = makeSet(true);
    const cache = new MemoryObjectCache();
    await cache.put(set.packs.world.hash, set.bucket.objects.get(set.packs.world.hash)!);
    const sd = await open(set, 'all', undefined, cache);
    expect(sd.worldSplit).toBe(false);
    await sd.worldPacks;
    await sd.uiArtReady;
    for (const r of ['worldCore', 'worldChargen', 'worldLand']) expect(set.bucket.requests).not.toContain(set.packs[r].hash);
    expect(set.bucket.requests).not.toContain(set.packs.world.hash); // from the cache
    expect(dec(sd.portal.getFileData(0x06000201))).toBe('heritage-portrait');
    // Once the parts are cached too (a later visit after a clear), the split serves again.
    const cache2 = new MemoryObjectCache();
    await cache2.put(set.packs.world.hash, set.bucket.objects.get(set.packs.world.hash)!);
    for (const r of ['worldCore', 'worldChargen', 'worldLand']) await cache2.put(set.packs[r].hash, set.bucket.objects.get(set.packs[r].hash)!);
    expect((await open(set, 'all', undefined, cache2)).worldSplit).toBe(true);
  });

  it('an interface-only set (AC1999) waits for worldCore alone and never fetches worldLand, terrain or the whole world pack', async () => {
    const set = makeSet(true);
    const sd = await open(set, 'interface');
    expect(sd.worldSplit).toBe(true);
    await sd.worldPacks;
    await sd.uiArtReady;
    await sd.chargenArtReady;
    for (const r of ['world', 'worldLand', 'terrain']) expect(set.bucket.requests).not.toContain(set.packs[r].hash);
    expect(dec(sd.portal.getFileData(0x06000201))).toBe('heritage-portrait');
  });
});

const PACK_SETS = 'verification/dat-streaming/pack-sets.json';
const HAVE_DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local) && existsSync(PACK_SETS);
const ITERATION = 0xffff0001;

describe.skipIf(!HAVE_DATS)('the split world pack over the real EoL DATs: the login draws from worldCore + worldLand, chargen waits for worldChargen', () => {
  let store: DatStore;
  let parts: Record<(typeof WORLD_SPLIT_ROLES)[number], number[]>;
  let chargenPack: Uint8Array;
  const fetched: number[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let win: any;
  const saved: Record<string, unknown> = {};
  const missesOf = (fn: () => void): string[] => {
    const { scope } = store.scoped(fn);
    return [...scope.keys].map((k) => { const { dat, id } = splitFileKey(k); return `${dat}:${id.toString(16)}`; });
  };

  beforeAll(async () => {
    const portalSrc: DatDatabase = openDat(DAT_PATHS.portal);
    const localSrc: DatDatabase = openDat(DAT_PATHS.local);
    const read = (db: DatDatabase, id: number) => new Uint8Array(db.getFileData(id)!);
    const sets = JSON.parse(readFileSync(PACK_SETS, 'utf8')) as { boot: { portal: string[] }; world: { portal: string[] }; ui: { portal: string[] }; worldPhases: Record<string, Record<string, string[]>> };
    const leaves = new Map<number, ObjectRef>();
    const gzCache = new Map<number, Uint8Array>();
    const gzOf = (id: number): Uint8Array => { let g = gzCache.get(id); if (!g) { g = new Uint8Array(gzipSync(read(portalSrc, id), { level: 1 })); gzCache.set(id, g); } return g; };
    const skeleton: Array<{ id: number; data: Uint8Array }> = [];
    for (const id of portalSrc.listFileIds()) {
      if (id === ITERATION) continue;
      if (SKELETON_TYPES.has(id >>> 24)) { skeleton.push({ id, data: read(portalSrc, id) }); continue; }
      leaves.set(id, { hash: `01${(id >>> 0).toString(16).padStart(8, '0')}000000`, size: portalSrc.getFileEntry(id)!.fileSize, get gzSize() { return gzOf(id).length; } } as ObjectRef);
    }
    const manifest: DatSetManifest = { leaves: { portal: leaves, highres: new Map() }, packs: new Map(), bundles: new Map() };
    const pointer: DatSetPointer = { format: 1, set: 'test-eol', iterations: { portal: 2072, cell: 982, local: 994, highres: 497 }, manifest: { hash: '0000000000000000', size: 0, gzSize: 0 }, packs: {} };
    store = DatStore.fromParts('https://dats.test', pointer, manifest, {
      verifyHash: false,
      fetchObject: async (url) => {
        const id = parseInt(url.slice(url.lastIndexOf('/') + 3, url.lastIndexOf('/') + 11), 16) >>> 0;
        fetched.push(id);
        return gzOf(id);
      },
    });
    const ids = (l: string[]) => l.map((h) => parseInt(h, 16) >>> 0).filter((id) => portalSrc.hasFile(id));
    const files = (l: number[]) => l.map((id) => ({ id, data: read(portalSrc, id) }));
    const worldIds = ids(sets.world.portal);
    const bootIds = new Set(ids(sets.boot.portal));
    const local = localSrc.listFileIds().filter((id) => id !== ITERATION).map((id) => ({ id, data: read(localSrc, id) }));
    store.addPackBytes('boot', buildPack(files([...bootIds])));
    store.addPackBytes('local', buildPack(local));
    store.addPackBytes('skeleton', buildPack(skeleton));
    // The publish tool's own planner, over the world pack's files.
    const { planWorldSplit } = await import('../tools/lib/world-split.js');
    const world = new Map(worldIds.map((id) => [id, read(portalSrc, id)]));
    parts = planWorldSplit(world, sets.worldPhases, (id) => portalSrc.getFileData(id), localSrc);
    // What the login waits for: worldCore + worldLand, then the ui pack (layout art beyond boot / world).
    store.addPackBytes('worldCore', buildPack(files(parts.worldCore)));
    store.addPackBytes('worldLand', buildPack(files(parts.worldLand)));
    const inWorld = new Set(worldIds);
    store.addPackBytes('ui', buildPack(files(ids(sets.ui.portal).filter((id) => !bootIds.has(id) && !inWorld.has(id) && !SKELETON_TYPES.has(id >>> 24)))));
    chargenPack = buildPack(files(parts.worldChargen));

    await gunzip(new Uint8Array(gzipSync(new Uint8Array(1))));
    const { loadDomWindow, installDomGlobals } = await import('./_harness/dom.js');
    const { GAMEUI_DOM_GLOBALS } = await import('./_harness/gameui.js');
    win = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(win, GAMEUI_DOM_GLOBALS, saved, 'functions');
    win.localStorage.clear();
    const ctx2d: unknown = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'createImageData') return (w: number, h: number) => ({ width: w || 1, height: h || 1, data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)) });
        if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ width: w || 1, height: h || 1, data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)).fill(255) });
        if (k === 'measureText') return () => ({ width: 0 });
        if (k === 'canvas') return null;
        return () => {};
      },
      set: () => true,
    });
    win.HTMLCanvasElement.prototype.getContext = function () { return ctx2d; };
    win.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,'; };
  }, 300_000);

  afterAll(async () => {
    const { restoreDomGlobals } = await import('./_harness/dom.js');
    const { GAMEUI_DOM_GLOBALS } = await import('./_harness/gameui.js');
    restoreDomGlobals(GAMEUI_DOM_GLOBALS, saved);
  });

  it('the planner splits the world pack: the 512×512 land textures in worldLand, the heritage portraits in worldChargen, the HUD frames in worldCore', () => {
    expect(parts.worldLand).toContain(0x06006d49); // a land texture (RegionDesc TexMerge)
    expect(parts.worldChargen).toContain(0x06004d27); // the Aluvian heritage portrait
    expect(parts.worldChargen).toContain(0x06004d26); // the chargen backdrop
    expect(parts.worldCore).toContain(0x06004cf9); // the radar's ornate frame
    expect(parts.worldCore).toContain(0x0600127d); // the in-game Dereth map (the map panel draws it too)
    expect(parts.worldCore).toContain(0x01001860); // a human base figure's GfxObj (chargen's preview and every human NPC)
    const all = [...parts.worldCore, ...parts.worldChargen, ...parts.worldLand];
    expect(new Set(all).size).toBe(all.length);
  });

  it('the HUD, the in-world panels and the terrain build with no miss before worldChargen lands; chargen waits for it, asks for it, then opens complete', async () => {
    const portalDb = store.db('portal');
    const localDb = store.db('local');
    const dp = await import('../packages/dat-parser/src/index.js');
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d, 0x2300000e]) dp.registerStringTable(dp.parseStringTable(new DatReader(localDb.getFileData(id)!)));
    const rd = new dp.RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));

    // uiArtReady's roots (the in-world layouts' art, as the client computes them): none of it is in the chargen pack.
    const { DatClosure, layoutArtIds } = await import('../packages/renderer/src/dat/streaming/DatClosure.js');
    const closure = new DatClosure(store);
    const chargenIds = new Set(parts.worldChargen);
    const hudArt = layoutArtIds(localDb, inWorldLayoutIds(localDb)).filter((id) => store.exists('portal', id));
    expect(hudArt.filter((id) => chargenIds.has(id))).toEqual([]);
    const f0 = fetched.length;
    await closure.ensure(hudArt.map((id) => fileKey('portal', id)));
    expect(fetched.slice(f0).filter((id) => chargenIds.has(id))).toEqual([]);

    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const textureManager = new TextureManager(portalDb, 2048, 4096, null);
    const layoutRenderer = new LayoutRenderer(localDb, new UITextureLoader(textureManager));
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);

    let releaseChargen!: () => void;
    const chargenReady = new Promise<void>((r) => { releaseChargen = r; });
    let wanted = 0;
    const deferredAsked = new Set<number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ui: any = null;
    // The login's packs are in (worldArtReady resolved); the chargen pack is not.
    expect(missesOf(() => {
      ui = new GameUI(container, {}, portalDb, textureManager, undefined, undefined, localDb, layoutRenderer, {
        worldArtReady: Promise.resolve(),
        chargenArtReady: chargenReady,
        chargenArtDeferred: (id) => {
          const d = !store.isPackResident('worldChargen') && !store.isResident('portal', id);
          if (d) deferredAsked.add(id);
          return d;
        },
        onChargenArtWanted: () => { wanted++; },
      });
    })).toEqual([]);
    const missesBefore = store.stats.misses;
    await new Promise((r) => setTimeout(r, 0));
    // The HUD's preload ran and skipped only what the chargen pack holds (nothing read twice).
    expect(store.stats.misses).toBe(missesBefore);
    expect(deferredAsked.size).toBeGreaterThan(0);
    for (const id of deferredAsked) expect(chargenIds.has(id)).toBe(true);
    expect(ui.uiTextures.size).toBeGreaterThan(200);

    // The world view's first frames: the HUD and the in-world panels, the terrain materials.
    expect(missesOf(() => {
      ui.showGame();
      ui.toggleInventory();
      ui.toggleCharPanel();
      ui.toggleMagicPanel();
      ui.toggleSocialPanel();
      ui.toggleMapPanel();
    })).toEqual([]);
    const THREE = await import('three');
    const { TerrainManager } = await import('../packages/renderer/src/terrain/TerrainManager.js');
    const { TerrainRenderer } = await import('../packages/renderer/src/terrain/TerrainRenderer.js');
    const { detailTexturing } = await import('../packages/renderer/src/models/DetailTexturing.js');
    const texMerge = rd.terrainInfo.landSurfaces.texMerge!;
    const terrainRenderer = new TerrainRenderer(new THREE.Scene(), new TerrainManager({ loadRadius: 2, landHeightTable: rd.landDefs.landHeightTable }));
    expect(missesOf(() => {
      terrainRenderer.buildTerrainMaterials(texMerge.terrainDesc, textureManager, texMerge.baseTexSize);
      terrainRenderer.buildTerrainBlendOverlays(texMerge, textureManager);
      terrainRenderer.buildRoadOverlays(texMerge, textureManager);
      detailTexturing.loadSurfaces(texMerge, textureManager);
    })).toEqual([]);
    ui.toggleInventory(); ui.toggleCharPanel(); ui.toggleMagicPanel(); ui.toggleSocialPanel(); ui.toggleMapPanel();

    // Character creation before its pack: Please Wait, and the pack is asked for first.
    ui.showCharacterSelect([{ id: '1', name: 'Sim Tester' }], 11);
    ui.showCharacterCreate();
    expect(ui.uiManager.currentScreen).toBe('character-select');
    expect(wanted).toBe(1);
    // The pack lands: chargen opens with every texture, no miss.
    store.addPackBytes('worldChargen', chargenPack);
    const m2 = store.stats.misses;
    releaseChargen();
    await chargenReady;
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.uiManager.currentScreen).toBe('character-create');
    for (const id of deferredAsked) expect(ui.uiTextures.has(id)).toBe(true);
    expect(store.stats.misses).toBe(m2);
  }, 300_000);
});
