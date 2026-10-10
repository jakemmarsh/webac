/**
 * DAT streaming — offline access-pattern measurement (docs/dat-streaming.md).
 *
 * Opens the four DATs on demand (FileDatBytes, never a whole-file read),
 * wraps every byte read and every getFileData() call, and drives the SHIPPED
 * loader code through a scripted session, phase by phase:
 *
 *   open          header + full B-tree directory walk (what `new DatDatabase` does)
 *   splash        the patch screen's ranged read (PatchScreen.loadPatchSplashFiles over RangedDat)
 *   init          main() boot reads: MasterProperty, 0x0E tables, RegionDesc, font 0x40000000 + sheets, cursors
 *   charselect    the real GameUI (happy-dom) + real LayoutRenderer showing layout 0x21000004
 *   chargen       GameUI.showCharacterCreate (0x21000038) + CharacterGenerator + the default heritage's model
 *   chargen-all   upper bound: every heritage x sex model at chargen (a player clicking through all 13)
 *   world-init    terrain materials / blend + road overlays / detail surfaces (main() builds these at boot today)
 *   portal-space  the tunnel Setup 0x02000306 + DidMapper 0x25000010 + Animation 0x030005AC
 *   holtburg      TerrainManager.update (draw distance 8 → 17x17 CellLandblocks) + LandblockObjectStreamer
 *                 loadAround + pump (3x3 shown + prefetch ring, real models/EnvCells/scenery/degrades)
 *                 + the world-DB objects of the 3x3 server ring (setups, motion tables, idle animations)
 *                 + the player's own character model and motion table
 *   walk-1..4     the player walks east one landblock at a time (incremental cost of a block crossing)
 *   dungeon-gate  Holtburg dungeon 0x01F6: the drop cell + its visible-cell (stab) list — what retail's
 *                 CEnvCell::PreFetchCells gates portal exit on
 *   dungeon-rest  the rest of that dungeon's cells (ours builds the whole block)
 *   ui-all        upper bound: every LayoutDesc in the language DAT rendered once (all panels' art)
 *
 * Per phase per DAT it reports NEW (first-touch) files and bytes — the cache
 * makes later touches free — under two storage models:
 *   - per-file objects: request count = files, bytes = file payload sizes
 *   - Range into the raw .dat: bytes = whole sectors touched, requests = contiguous sector runs,
 *     plus a "coalesced" count that merges runs within a phase closer than COALESCE_GAP bytes.
 *
 * Usage: npx tsx tools/dat-access-sim.ts [--json out.json]
 * Assumptions and caveats: docs/dat-streaming.md §1.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import Database from 'better-sqlite3';
import { DatDatabase, type DatBytes } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { SKELETON_TYPES } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { CellLandblock } from '../packages/dat-parser/src/file-types/CellLandblock.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { ACFont } from '../packages/dat-parser/src/file-types/ACFont.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATS = {
  portal: resolve(REPO, 'dat/client_portal.dat'),
  cell: resolve(REPO, 'dat/client_cell_1.dat'),
  highres: resolve(REPO, 'dat/client_highres.dat'),
  local: resolve(REPO, 'dat/client_local_English.dat'),
} as const;
type DatName = keyof typeof DATS;
const COALESCE_GAP = 64 * 1024;
/**
 * Portal file types the publish plan puts in the "skeleton" pack (small
 * structural files: Setups, Surfaces, SurfaceTextures, MotionTables, tables,
 * fonts …) — SKELETON_TYPES, shared with tools/publish-dats-r2.ts and the client (DatSetFormat.ts).
 * Everything else in portal.dat (GfxObj 0x01, Animation 0x03, Palette 0x04,
 * Texture 0x06, Wave 0x0A, Environment 0x0D) is a per-file "leaf" object.
 */
export { SKELETON_TYPES };

// ── recording ───────────────────────────────────────────────────────────────
interface PhaseStats {
  files: number; fileBytes: number;
  /** gzip -6 of each new file on its own (the per-file object transfer size). */
  gzBytes: number;
  /** Portal leaves only (per-file objects under the publish plan): count + gz bytes. */
  leafFiles: number; leafGzBytes: number;
  sectorBytes: number; runs: number; coalescedRuns: number;
  /** [start,end) byte runs touched this phase (for coalescing). */
  spans: Array<[number, number]>;
  byType: Map<number, { files: number; bytes: number }>;
}
const newStats = (): PhaseStats => ({ files: 0, fileBytes: 0, gzBytes: 0, leafFiles: 0, leafGzBytes: 0, sectorBytes: 0, runs: 0, coalescedRuns: 0, spans: [], byType: new Map() });

class Recorder {
  phase = 'open';
  readonly phases: string[] = ['open'];
  readonly stats = new Map<string, Map<DatName, PhaseStats>>();
  readonly seenFiles = new Map<DatName, Set<number>>();
  readonly seenSectors = new Map<DatName, Set<number>>();
  readonly blockSize = new Map<DatName, number>();
  /** First-touch file ids per phase per DAT (the publish script's boot/world pack lists). */
  readonly ids = new Map<string, Map<DatName, number[]>>();
  /** Inside a getFileData call: the sector offsets its chain touched. */
  private chain: number[] | null = null;
  setPhase(p: string): void { this.phase = p; if (!this.phases.includes(p)) this.phases.push(p); }
  s(dat: DatName): PhaseStats {
    let m = this.stats.get(this.phase);
    if (!m) { m = new Map(); this.stats.set(this.phase, m); }
    let st = m.get(dat);
    if (!st) { st = newStats(); m.set(dat, st); }
    return st;
  }
  noteBytes(dat: DatName, offset: number, length: number): void {
    const bs = this.blockSize.get(dat) ?? 1024;
    const seen = this.seenSectors.get(dat)!;
    const first = Math.floor(offset / bs);
    const last = Math.floor((offset + length - 1) / bs);
    const st = this.s(dat);
    let runOpen = false;
    for (let sct = first; sct <= last; sct++) {
      if (this.chain && sct === first) this.chain.push(sct);
      if (seen.has(sct)) { runOpen = false; continue; }
      seen.add(sct);
      st.sectorBytes += bs;
      if (!runOpen) { st.spans.push([sct * bs, (sct + 1) * bs]); runOpen = true; } else st.spans[st.spans.length - 1][1] = (sct + 1) * bs;
    }
  }
  noteFile(dat: DatName, id: number, size: number): boolean {
    const seen = this.seenFiles.get(dat)!;
    if (seen.has(id)) return false;
    seen.add(id);
    let pm = this.ids.get(this.phase);
    if (!pm) { pm = new Map(); this.ids.set(this.phase, pm); }
    let list = pm.get(dat);
    if (!list) { list = []; pm.set(dat, list); }
    list.push(id);
    const st = this.s(dat);
    st.files++; st.fileBytes += size;
    const t = id >>> 24;
    const bt = st.byType.get(t) ?? { files: 0, bytes: 0 };
    bt.files++; bt.bytes += size;
    st.byType.set(t, bt);
    return true;
  }
  beginChain(): void { this.chain = []; }
  endChain(dat: DatName, isNew: boolean): void {
    const c = this.chain; this.chain = null;
    if (!c || !isNew || c.length === 0) return;
    // contiguous sector runs in this file's chain = Range requests for it alone
    let runs = 1;
    for (let i = 1; i < c.length; i++) if (c[i] !== c[i - 1] + 1) runs++;
    this.s(dat).runs += runs;
  }
  finalize(): void {
    for (const m of this.stats.values()) {
      for (const st of m.values()) {
        const spans = st.spans.slice().sort((a, b) => a[0] - b[0]);
        let n = 0; let end = -Infinity;
        for (const [a, b] of spans) { if (a - end > COALESCE_GAP) n++; end = Math.max(end, b); }
        st.coalescedRuns = n;
      }
    }
  }
}
const rec = new Recorder();

class TracingBytes implements DatBytes {
  constructor(private readonly inner: FileDatBytes, private readonly dat: DatName) {}
  get byteLength(): number { return this.inner.byteLength; }
  read(offset: number, dest: Uint8Array, destOffset: number, length: number): void {
    rec.noteBytes(this.dat, offset, length);
    this.inner.read(offset, dest, destOffset, length);
  }
}

function openTraced(dat: DatName): DatDatabase {
  rec.seenFiles.set(dat, new Set());
  rec.seenSectors.set(dat, new Set());
  // block size first (header read is not attributed until we know it)
  const probe = new FileDatBytes(DATS[dat]);
  const head = new Uint8Array(8); probe.read(0x144, head, 0, 4);
  rec.blockSize.set(dat, new DataView(head.buffer).getUint32(0, true));
  const db = new DatDatabase(new TracingBytes(probe, dat));
  const orig = db.getFileData.bind(db);
  (db as unknown as { getFileData: (id: number) => ArrayBuffer | null }).getFileData = (id: number) => {
    const entry = db.getFileEntry(id);
    if (!entry) return null;
    const isNew = rec.noteFile(dat, id >>> 0, entry.fileSize);
    rec.beginChain();
    let data: ArrayBuffer | null = null;
    try { data = orig(id); return data; } finally {
      rec.endChain(dat, isNew);
      if (isNew && data) {
        const gz = gzipSync(new Uint8Array(data), { level: 6 }).length;
        const st = rec.s(dat);
        st.gzBytes += gz;
        if ((dat === 'portal' || dat === 'highres') && !SKELETON_TYPES.has(id >>> 24)) { st.leafFiles++; st.leafGzBytes += gz; }
      }
    }
  };
  return db;
}

function quiet<T>(fn: () => T): T {
  const { warn, log, error } = console;
  console.warn = () => {}; console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.warn = warn; console.log = log; console.error = error; }
}
async function quietAsync<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, log, error } = console;
  console.warn = () => {}; console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.log = log; console.error = error; }
}
const tryRun = (label: string, fn: () => void): void => {
  try { quiet(fn); } catch (e) { process.stderr.write(`[sim] ${label}: ${(e as Error).message}\n`); }
};

// ── session ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argOf = (flag: string): string | null => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
  const jsonOut = argOf('--json');
  const bootSetOut = argOf('--boot-set');
  for (const p of Object.values(DATS)) if (!existsSync(p)) throw new Error(`missing ${p}`);

  // Phase: open — what `new DatDatabase(buf)` reads (header + every directory node).
  const portalDb = openTraced('portal');
  const cellDb = openTraced('cell');
  const localDb = openTraced('local');
  const highresDb = openTraced('highres');
  const fileCounts = { portal: portalDb.fileCount, cell: cellDb.fileCount, local: localDb.fileCount, highres: highresDb.fileCount };

  // Phase: splash — the shipped ranged read, through a counting RangeFetcher.
  rec.setPhase('splash');
  const splash = { requests: 0, bytes: 0 };
  {
    const { loadPatchSplashFiles } = await import('../packages/renderer/src/ui/PatchScreen.js');
    const fb = new FileDatBytes(DATS.portal);
    const files = await quietAsync(() => loadPatchSplashFiles(async (offset, length) => {
      const n = Math.max(0, Math.min(length, fb.byteLength - offset));
      const out = new Uint8Array(n);
      fb.read(offset, out, 0, n);
      splash.requests++; splash.bytes += n;
      return out;
    }));
    // Attribute the splash's files to this phase (per-file sizes for the boot pack) —
    // the RangedDat request/byte counts above are the ranged-read cost itself.
    for (const id of files.fileIds) portalDb.getFileData(id);
  }

  // Phase: init — main()'s boot reads ahead of the character screen.
  rec.setPhase('init');
  const dp = await import('@ac/dat-parser');
  const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
  const textureManager = new TextureManager(portalDb, 2048, 4096, null);
  let regionDesc: RegionDesc | null = null;
  tryRun('init tables', () => {
    dp.setMasterPropertyTypes(dp.parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x0E000020, 0x0E00001E, 0x0E000004, 0x0E000003, 0x0E00000D, 0x0E00001D, 0x0E000007, 0x0E00000E, 0x0E00000F, 0x0E000018]) portalDb.getFileData(id);
    regionDesc = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    // string tables (language DAT)
    for (const id of localDb.listFileIds(0x23)) dp.registerStringTable(dp.parseStringTable(localDb.getReader(id)));
    const font = ACFont.read(new DatReader(portalDb.getFileData(0x40000000)!));
    if (font.foregroundSurfaceDataId) textureManager.getIconRGBA(font.foregroundSurfaceDataId);
    if (font.backgroundSurfaceDataId) textureManager.getIconRGBA(font.backgroundSurfaceDataId);
  });
  {
    const { loadDomWindow, installDomGlobals } = await import('../tests/_harness/dom.js');
    const { GAMEUI_DOM_GLOBALS } = await import('../tests/_harness/gameui.js');
    const win = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(win, GAMEUI_DOM_GLOBALS, {}, 'functions');
    // happy-dom has no 2D canvas: a no-op context so the UI's canvas paths run
    // (the DAT reads happen before any pixel reaches a canvas).
    const ctx2d: unknown = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'createImageData' || k === 'getImageData') return (w: number, h: number) => ({ width: w || 1, height: h || 1, data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)) });
        if (k === 'measureText') return () => ({ width: 0 });
        if (k === 'canvas') return null;
        return () => {};
      },
      set: () => true,
    });
    win.HTMLCanvasElement.prototype.getContext = function () { return ctx2d; };
    win.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,'; };
  }
  tryRun('cursor', () => { void import('../packages/renderer/src/ui/CursorManager.js'); });
  const { CursorManager } = await import('../packages/renderer/src/ui/CursorManager.js');
  tryRun('cursor', () => { new CursorManager(portalDb, textureManager).getCursorCSS('Default'); });

  // Phase: charselect — real GameUI + LayoutRenderer.
  rec.setPhase('charselect');
  const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
  const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
  const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
  const layoutRenderer = new LayoutRenderer(localDb, new UITextureLoader(textureManager), null);
  const doc = (globalThis as unknown as { document: Document }).document;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  // GameUI's ctor preload (HUD art, chargen portraits) waits for the world
  // packs in a streaming client (worldArtReady): the ctor and the pre-world
  // screens are 'charselect', the preload its own phase once released — so
  // the boot pack carries what the launcher / connecting / character screens
  // draw (RELEASE.streaming-charselect-weight).
  let releasePreload!: () => void;
  const preloadGate = new Promise<void>((r) => { releasePreload = r; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any = null;
  tryRun('GameUI ctor', () => { ui = new GameUI(container, {}, portalDb, textureManager, undefined, undefined, null, layoutRenderer, { worldArtReady: preloadGate }); });
  tryRun('showLauncher', () => { void ui?.showLauncher({ bridgeUrl: 'ws://sim', loadDirectory: () => new Promise(() => {}) }); });
  tryRun('showConnectingScreen', () => ui?.showConnectingScreen());
  tryRun('showCharacterSelect', () => ui?.showCharacterSelect([{ id: 1, name: 'Sim Tester' }, { id: 2, name: 'Second Char' }]));
  // Every pre-world layout's art (dialogs the sim does not open), as the client prefetches it.
  {
    const { layoutArtIds } = await import('../packages/renderer/src/dat/streaming/DatClosure.js');
    const { PREWORLD_LAYOUTS } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    tryRun('pre-world art', () => { for (const id of layoutArtIds(localDb, PREWORLD_LAYOUTS)) if (portalDb.hasFile(id)) portalDb.getFileData(id); });
  }
  rec.setPhase('gameui-preload');
  releasePreload();
  await preloadGate;
  await new Promise((r) => setTimeout(r, 0));

  // Phase: chargen
  rec.setPhase('chargen');
  const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
  const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
  const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
  const { DegradeLod } = await import('../packages/renderer/src/models/DegradeLod.js');
  const { ClothingRenderer } = await import('../packages/renderer/src/models/ClothingRenderer.js');
  const { AppearanceManager } = await import('../packages/renderer/src/models/AppearanceManager.js');
  const { CharacterModelBuilder } = await import('../packages/renderer/src/models/CharacterModelBuilder.js');
  const { MotionManager } = await import('../packages/renderer/src/animation/MotionManager.js');
  const materialFactory = new MaterialFactory(portalDb, textureManager);
  const modelRenderer = new ModelRenderer(portalDb, materialFactory);
  const setupModelRenderer = new SetupModelRenderer(portalDb, modelRenderer);
  const degradeLod = new DegradeLod(portalDb);
  setupModelRenderer.setDegradeLod(degradeLod);
  const clothingRenderer = new ClothingRenderer(portalDb, setupModelRenderer, modelRenderer, materialFactory);
  const characterModelBuilder = new CharacterModelBuilder(portalDb, setupModelRenderer, clothingRenderer, new AppearanceManager(portalDb));
  const appearance = { hairStyle: 0, hairColor: 0, eyesStrip: 0, eyeColor: 0, skinColor: 0, noseStyle: 0, mouthStyle: 0, headgearStyle: 0, headgearColor: 0, shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0, footwearStyle: 0, footwearColor: 0 };
  tryRun('showCharacterCreate', () => ui?.showCharacterCreate());
  const buildChar = (h: number, g: number): void => tryRun(`char ${h}/${g}`, () => {
    characterModelBuilder.buildCharacterModel(h, g, appearance as never);
    const mt = characterModelBuilder.getMotionTableId(h, g);
    if (mt) { const mm = new MotionManager(portalDb); const t = mm.loadMotionTable(mt); if (t) { mm.setMotionTable(t); mm.setDefaultStance(); mm.update(0.1); } }
  });
  buildChar(1, 1);
  rec.setPhase('chargen-all');
  for (let h = 1; h <= 13; h++) for (const g of [1, 2]) buildChar(h, g);

  // Phase: world-init — terrain materials etc. (main() does these at boot today).
  rec.setPhase('world-init');
  const { TerrainManager } = await import('../packages/renderer/src/terrain/TerrainManager.js');
  const { TerrainRenderer } = await import('../packages/renderer/src/terrain/TerrainRenderer.js');
  const { detailTexturing } = await import('../packages/renderer/src/models/DetailTexturing.js');
  const scene = new THREE.Scene();
  const rd = regionDesc as RegionDesc | null;
  const terrainManager = new TerrainManager({ loadRadius: 8, landHeightTable: rd?.landDefs.landHeightTable });
  terrainManager.init(cellDb, { read: (r: DatReader) => CellLandblock.read(r) });
  const terrainRenderer = new TerrainRenderer(scene, terrainManager);
  tryRun('terrain materials', () => {
    const texMerge = rd!.terrainInfo.landSurfaces.texMerge!;
    terrainRenderer.buildTerrainMaterials(texMerge.terrainDesc, textureManager, texMerge.baseTexSize);
    terrainRenderer.buildTerrainBlendOverlays(texMerge, textureManager);
    terrainRenderer.buildRoadOverlays(texMerge, textureManager);
    detailTexturing.loadSurfaces(texMerge, textureManager);
  });

  // Phase: portal-space
  rec.setPhase('portal-space');
  tryRun('portal space', () => {
    portalDb.getFileData(0x25000010);
    setupModelRenderer.createSetupMesh(0x02000306);
    portalDb.getFileData(0x030005AC);
  });

  // Phase: holtburg
  rec.setPhase('holtburg');
  const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
  const { DungeonRenderer } = await import('../packages/renderer/src/world/DungeonRenderer.js');
  const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
  const { SceneryInstancer } = await import('../packages/renderer/src/terrain/SceneryInstancer.js');
  const { SceneryInstancePool } = await import('../packages/renderer/src/terrain/SceneryInstancePool.js');
  const { LandblockObjectStreamer } = await import('../packages/renderer/src/world/LandblockObjectStreamer.js');
  const { createLandblockSceneryBuilder } = await import('../packages/renderer/src/world/LandblockScenery.js');
  const envCellRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupModelRenderer, modelRenderer);
  const sceneryInstancer = new SceneryInstancer(modelRenderer, setupModelRenderer);
  envCellRenderer.setInstancer(sceneryInstancer);
  envCellRenderer.setDegradeLod(degradeLod);
  const noop = () => {};
  const pool = (n: string) => new SceneryInstancePool(sceneryInstancer, n, noop, noop, { lod: degradeLod } as never);
  const collision = new DungeonCollision();
  const warn = { warn: noop };
  const streamer = new LandblockObjectStreamer({
    cellDb, addToScene: noop, removeFromScene: noop, setTerrainVisible: noop,
    instancer: sceneryInstancer,
    sceneryPool: pool('s'), staticsPool: pool('t'), buildingsPool: pool('b'),
    envCells: envCellRenderer, setupModels: setupModelRenderer, models: modelRenderer, degradeLod,
    collision, objectPhysics: () => null,
    buildScenery: createLandblockSceneryBuilder({ cellDb, portalDb, regionDesc: rd!, hasModel: (id: number) => sceneryInstancer.hasModel(id), objectPhysics: () => null, collision, warn }),
    warn, onCollisionMeshesChanged: noop, loadRadius: 8, budgetMs: 1e9,
  } as never);

  const world = new Database(resolve(REPO, 'dat/world.sqlite'), { readonly: true });
  const didStmt = world.prepare('select type, value from weenie_properties_d_i_d where object_Id = ?');
  const genStmt = world.prepare('select weenie_Class_Id from weenie_properties_generator where object_Id = ?');
  const instStmt = world.prepare('select distinct weenie_Class_Id from landblock_instance where landblock = ?');
  const seenWeenies = new Set<number>();
  const loadWeenie = (wcid: number, depth = 0): void => {
    if (seenWeenies.has(wcid) || depth > 2) return;
    seenWeenies.add(wcid);
    const dids = new Map<number, number>();
    for (const r of didStmt.all(wcid) as Array<{ type: number; value: number }>) dids.set(r.type, r.value >>> 0);
    tryRun(`weenie ${wcid}`, () => {
      const setup = dids.get(1); // PropertyDataId.Setup
      if (setup) setupModelRenderer.createSetupMesh(setup);
      const mt = dids.get(2); // MotionTable
      if (mt) { const mm = new MotionManager(portalDb); const t = mm.loadMotionTable(mt); if (t) { mm.setMotionTable(t); mm.setDefaultStance(); mm.update(0.1); } }
      const st = dids.get(3); if (st) portalDb.getFileData(st); // SoundTable (waves load on play)
      const pst = dids.get(4); if (pst) portalDb.getFileData(pst); // PhysicsEffectTable
      const cb = dids.get(7); if (cb) clothingRenderer.loadClothingTable(cb); // ClothingBase
    });
    for (const g of genStmt.all(wcid) as Array<{ weenie_Class_Id: number }>) loadWeenie(g.weenie_Class_Id, depth + 1);
  };
  const serverRing = (cx: number, cy: number): void => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const r of instStmt.all(((cx + dx) << 8) | (cy + dy)) as Array<{ weenie_Class_Id: number }>) loadWeenie(r.weenie_Class_Id);
    }
  };

  const HX = 0xA9, HY = 0xB4;
  const worldPos = (bx: number, by: number) => ({ x: bx * 192 + 96, z: by * 192 + 96 });
  const sub = { terrain: 0, objects: 0, server: 0, player: 0 };
  const snap = () => totalNew('holtburg');
  let t0 = snap();
  tryRun('terrain', () => { const p = worldPos(HX, HY); terrainManager.update(p.x, p.z); });
  sub.terrain = snap() - t0; t0 = snap();
  tryRun('objects', () => { streamer.loadAround(HX, HY); streamer.pump(HX, HY); });
  sub.objects = snap() - t0; t0 = snap();
  serverRing(HX, HY);
  sub.server = snap() - t0; t0 = snap();
  buildChar(1, 1); // player's model + motion table (cached from chargen if it ran this session)
  sub.player = snap() - t0;

  // walk east, one landblock per step
  const walks: number[] = [];
  for (let i = 1; i <= 4; i++) {
    rec.setPhase(`walk-${i}`);
    tryRun(`walk ${i}`, () => {
      const p = worldPos(HX + i, HY); terrainManager.update(p.x, p.z);
      streamer.pump(HX + i, HY);
    });
    serverRing(HX + i, HY);
    walks.push(totalNew(`walk-${i}`));
  }

  // dungeon: Holtburg dungeon drop cell 0x01F60289 (world DB portalholtburgdungeon)
  rec.setPhase('dungeon-gate');
  const dungeonRenderer = new DungeonRenderer(cellDb, envCellRenderer);
  const DROP = 0x01F60289;
  let gateCells = 0; let dungeonCells = 0;
  tryRun('dungeon gate', () => {
    const ec = new EnvCell(new DatReader(cellDb.getFileData(DROP)!));
    const set = new Set<number>([DROP]);
    for (const v of ec.visibleCells ?? []) set.add(((DROP & 0xffff0000) | v) >>> 0);
    gateCells = set.size;
    for (const id of set) envCellRenderer.createCellMesh(id);
  });
  tryRun('dungeon server objects', () => {
    for (const r of instStmt.all(0x01F6) as Array<{ weenie_Class_Id: number }>) loadWeenie(r.weenie_Class_Id);
  });
  rec.setPhase('dungeon-rest');
  tryRun('dungeon rest', () => { const g = dungeonRenderer.createDungeon(0x01F6FFFF); dungeonCells = g?.children.length ?? 0; });

  // ui-all: every layout once
  rec.setPhase('ui-all');
  for (const id of localDb.listFileIds(0x21)) {
    tryRun(`layout ${id.toString(16)}`, () => { const host = doc.createElement('div'); layoutRenderer.render(id, host); });
  }

  rec.finalize();

  // totals for the DAT inventory
  const inventory: Record<string, { files: number; payloadBytes: number; fileBytes: number; byType: Record<string, { files: number; bytes: number; maxFile: number }> }> = {};
  for (const [name, db] of [['portal', portalDb], ['cell', cellDb], ['local', localDb], ['highres', highresDb]] as const) {
    const byType: Record<string, { files: number; bytes: number; maxFile: number }> = {};
    let payload = 0;
    for (const id of db.listFileIds()) {
      const e = db.getFileEntry(id)!;
      payload += e.fileSize;
      const t = `0x${(id >>> 24).toString(16).padStart(2, '0')}`;
      const b = (byType[t] ??= { files: 0, bytes: 0, maxFile: 0 });
      b.files++; b.bytes += e.fileSize; b.maxFile = Math.max(b.maxFile, e.fileSize);
    }
    inventory[name] = { files: db.fileCount, payloadBytes: payload, fileBytes: db.blockSize ? new FileDatBytes(DATS[name]).byteLength : 0, byType };
  }

  const out = {
    generated: new Date().toISOString(),
    coalesceGapBytes: COALESCE_GAP,
    fileCounts, splash, holtburgBreakdownBytes: sub, walkStepBytes: walks,
    dungeon: { dropCell: '0x01F60289', gateCells, dungeonCellsBuilt: dungeonCells },
    weeniesLoaded: seenWeenies.size,
    phases: rec.phases.map((p) => ({
      phase: p,
      dats: Object.fromEntries([...(rec.stats.get(p) ?? new Map()).entries()].map(([d, st]) => [d, {
        files: st.files, fileBytes: st.fileBytes, gzBytes: st.gzBytes, leafFiles: st.leafFiles, leafGzBytes: st.leafGzBytes, sectorBytes: st.sectorBytes, rangeRuns: st.runs, coalescedRuns: st.coalescedRuns,
        topTypes: Object.fromEntries([...st.byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6).map(([t, v]) => [`0x${t.toString(16).padStart(2, '0')}`, v])),
      }])),
    })),
    inventory,
  };
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2) + '\n');
  if (bootSetOut) {
    // Pack lists for tools/publish-dats-r2.ts: 'boot' = everything up to the
    // first char-select frame; 'world' = what entering the world needs before
    // the first landblock (fetched in the background while at char select).
    const pick = (phases: string[]) => {
      const o: Record<string, string[]> = {};
      for (const ph of phases) for (const [d, l] of rec.ids.get(ph) ?? []) (o[d] ??= []).push(...l.map((x) => `0x${x.toString(16).padStart(8, '0')}`));
      for (const d of Object.keys(o)) o[d].sort();
      return o;
    };
    writeFileSync(bootSetOut, JSON.stringify({
      generatedBy: 'tools/dat-access-sim.ts',
      boot: pick(['splash', 'init', 'charselect']),
      world: pick(['gameui-preload', 'chargen', 'world-init', 'portal-space']),
      // 'ui' = every other LayoutDesc's art (the publish tool drops ids boot/world carry);
      // the streaming client loads it in the background once in world.
      ui: pick(['ui-all']),
    }, null, 1) + '\n');
  }

  // human summary
  const mb = (n: number) => (n / 1048576).toFixed(2);
  console.log(`phase            dat      files   payloadMB  gzMB   leaves leafGzMB  sectorMB  runs  coalesced`);
  for (const p of out.phases) {
    for (const [d, v] of Object.entries(p.dats) as Array<[string, { files: number; fileBytes: number; gzBytes: number; leafFiles: number; leafGzBytes: number; sectorBytes: number; rangeRuns: number; coalescedRuns: number }]>) {
      console.log(`${p.phase.padEnd(16)} ${d.padEnd(8)} ${String(v.files).padStart(6)} ${mb(v.fileBytes).padStart(10)} ${mb(v.gzBytes).padStart(6)} ${String(v.leafFiles).padStart(6)} ${mb(v.leafGzBytes).padStart(8)} ${mb(v.sectorBytes).padStart(9)} ${String(v.rangeRuns).padStart(5)} ${String(v.coalescedRuns).padStart(9)}`);
    }
  }
  console.log(`splash (RangedDat): ${splash.requests} requests, ${mb(splash.bytes)} MB`);
  console.log(`holtburg breakdown (payload+dir bytes): ${JSON.stringify(sub)}; walk steps: ${JSON.stringify(walks)}`);
  console.log(`dungeon: gate cells ${gateCells}, whole-dungeon cells ${dungeonCells}; weenies ${seenWeenies.size}`);
  world.close();
}

/** New payload bytes recorded so far in a phase, all DATs. */
function totalNew(phase: string): number {
  let n = 0;
  for (const st of (rec.stats.get(phase) ?? new Map<DatName, PhaseStats>()).values()) n += st.fileBytes;
  return n;
}

main().catch((e) => { console.error(e); process.exit(1); });
