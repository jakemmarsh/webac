/**
 * RELEASE.streaming-charselect-weight — the character screen over only the
 * char-select set (docs/dat-streaming.md §6.6), against the real EoL DATs.
 *
 * A real DatStore in the published layout: the boot pack from
 * verification/dat-streaming/pack-sets.json, the whole language DAT and the
 * skeleton pack resident, a leaf per other portal file. The world pack is NOT
 * resident: it loads behind character select. The shipped boot-time code then
 * runs over the streamed DatDatabases in main()'s order — the boot tables,
 * the UI font, the cursor, LayoutRenderer, the real GameUI constructor (with
 * its preload deferred to the world packs), the launcher, the connecting
 * screen, character select — and must not miss a single streamed file once
 * the pre-world layouts' art (StreamingDats PREWORLD_LAYOUTS) is resident.
 * When the world pack lands: the deferred preload, chargen (which waits for
 * it), the terrain materials and the sky objects build with no miss either,
 * and the power bar's DDD mode shows the gate's progress.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SKELETON_TYPES, type DatSetManifest, type DatSetPointer, type ObjectRef } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatStore, gunzip, splitFileKey, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { buildPack } from './_harness/datSet.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const PACK_SETS = 'verification/dat-streaming/pack-sets.json';
const HAVE_DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local) && existsSync(PACK_SETS);
const ITERATION = 0xffff0001;

describe.skipIf(!HAVE_DATS)('character select over the streamed char-select set (real EoL DATs)', () => {
  let store: DatStore;
  let portalSrc: DatDatabase;
  let worldPack: Uint8Array;
  const fetched: Array<{ id: number; gz: number }> = [];
  const packGz: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let win: any;
  const saved: Record<string, unknown> = {};
  /** "<dat>:<id hex>" of every file a step missed. */
  const missesOf = (fn: () => void): string[] => {
    const { scope } = store.scoped(fn);
    return [...scope.keys].map((k) => { const { dat, id } = splitFileKey(k); return `${dat}:${id.toString(16)}`; });
  };

  beforeAll(async () => {
    portalSrc = openDat(DAT_PATHS.portal);
    const localSrc = openDat(DAT_PATHS.local);
    const read = (db: DatDatabase, id: number) => new Uint8Array(db.getFileData(id)!);
    const sets = JSON.parse(readFileSync(PACK_SETS, 'utf8')) as { boot: { portal: string[] }; world: { portal: string[] } };
    const gzOf = new Map<string, () => Uint8Array>();
    const leafOf = new Map<string, number>();
    const leaves = new Map<number, ObjectRef>();
    const skeleton: Array<{ id: number; data: Uint8Array }> = [];
    for (const id of portalSrc.listFileIds()) {
      if (id === ITERATION) continue;
      if (SKELETON_TYPES.has(id >>> 24)) { skeleton.push({ id, data: read(portalSrc, id) }); continue; }
      const hash = `01${(id >>> 0).toString(16).padStart(8, '0')}000000`;
      let gz: Uint8Array | null = null;
      const get = () => (gz ??= new Uint8Array(gzipSync(read(portalSrc, id), { level: 6 })));
      gzOf.set(hash, get);
      leafOf.set(hash, id);
      leaves.set(id, { hash, size: portalSrc.getFileEntry(id)!.fileSize, get gzSize() { return get().length; } } as ObjectRef);
    }
    const manifest: DatSetManifest = { leaves: { portal: leaves, highres: new Map() }, packs: new Map(), bundles: new Map() };
    const pointer: DatSetPointer = {
      format: 1, set: 'test-eol', iterations: { portal: 2072, cell: 982, local: 994, highres: 497 },
      manifest: { hash: '0000000000000000', size: 0, gzSize: 0 }, packs: {},
    };
    store = DatStore.fromParts('https://dats.test', pointer, manifest, {
      verifyHash: false,
      fetchObject: async (url) => {
        const h = url.slice(url.lastIndexOf('/') + 1);
        const gz = gzOf.get(h)!();
        fetched.push({ id: leafOf.get(h)!, gz: gz.length });
        return gz;
      },
    });
    const ids = (l: string[]) => l.map((h) => parseInt(h, 16)).filter((id) => portalSrc.hasFile(id)).map((id) => ({ id, data: read(portalSrc, id) }));
    const boot = ids(sets.boot.portal);
    const local = localSrc.listFileIds().filter((id) => id !== ITERATION).map((id) => ({ id, data: read(localSrc, id) }));
    for (const [role, files] of [['boot', boot], ['local', local], ['skeleton', skeleton]] as const) {
      const bytes = buildPack(files);
      packGz[role] = gzipSync(bytes, { level: 6 }).length;
      store.addPackBytes(role, bytes);
    }
    worldPack = buildPack(ids(sets.world.portal));

    // undici builds Response lazily on first use, extending the global Event:
    // build it (one gunzip) before happy-dom replaces Event.
    await gunzip(new Uint8Array(gzipSync(new Uint8Array(1))));
    const { loadDomWindow, installDomGlobals } = await import('./_harness/dom.js');
    const { GAMEUI_DOM_GLOBALS } = await import('./_harness/gameui.js');
    win = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(win, GAMEUI_DOM_GLOBALS, saved, 'functions');
    win.localStorage.clear();
    // happy-dom has no 2D canvas: a no-op context so the UI's canvas paths run.
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
  }, 300_000);

  afterAll(async () => {
    const { restoreDomGlobals } = await import('./_harness/dom.js');
    const { GAMEUI_DOM_GLOBALS } = await import('./_harness/gameui.js');
    restoreDomGlobals(GAMEUI_DOM_GLOBALS, saved);
  });

  it('draws the launcher and character select with no miss; chargen, preload art, terrain and sky wait for the world pack', async () => {
    const portalDb = store.db('portal');
    const localDb = store.db('local');
    const dp = await import('../packages/dat-parser/src/index.js');

    // main(): the boot tables (MasterProperty, string tables, 0x0E tables, RegionDesc).
    let regionDesc: InstanceType<typeof dp.RegionDesc> | null = null;
    expect(missesOf(() => {
      dp.setMasterPropertyTypes(dp.parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
      for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d, 0x2300000e]) dp.registerStringTable(dp.parseStringTable(new DatReader(localDb.getFileData(id)!)));
      for (const id of [0x0E000020, 0x0E00001E, 0x0E000004, 0x0E000003, 0x0E00000D, 0x0E00001D, 0x0E000007, 0x0E00000E, 0x0E00000F, 0x0E000018]) expect(portalDb.getFileData(id)).not.toBeNull();
      regionDesc = new dp.RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    })).toEqual([]);

    // The pre-world layouts' art: what openStreamingDats makes resident before it resolves.
    const { DatClosure, layoutArtIds, skyObjectRoots } = await import('../packages/renderer/src/dat/streaming/DatClosure.js');
    const { PREWORLD_LAYOUTS } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    const closure = new DatClosure(store);
    const art = layoutArtIds(localDb, PREWORLD_LAYOUTS).filter((id) => store.exists('portal', id));
    expect(art).toContain(0x06007576); // the char-select backdrop
    const f0 = fetched.length;
    await closure.ensure(art.map((id) => fileKey('portal', id)));
    const artObjects = fetched.length - f0;
    const artGz = fetched.slice(f0).reduce((a, b) => a + b.gz, 0);

    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { CursorManager } = await import('../packages/renderer/src/ui/CursorManager.js');
    const { ACFont } = await import('../packages/dat-parser/src/file-types/ACFont.js');
    const { ACFontRenderer } = await import('../packages/renderer/src/ui/ACFontRenderer.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const textureManager = new TextureManager(portalDb, 2048, 4096, null);
    let acFont: InstanceType<typeof ACFontRenderer> | null = null;
    expect(missesOf(() => {
      new CursorManager(portalDb, textureManager).getCursorCSS('Default');
      const font = ACFont.read(new DatReader(portalDb.getFileData(0x40000000)!));
      acFont = new ACFontRenderer(font);
      const fg = textureManager.getIconRGBA(font.foregroundSurfaceDataId);
      if (fg) acFont.initSpritesheet(fg.width, fg.height, fg.data);
      const bg = textureManager.getIconRGBA(font.backgroundSurfaceDataId);
      if (bg) acFont.initBackgroundSpritesheet(bg.width, bg.height, bg.data);
    })).toEqual([]);
    const layoutRenderer = new LayoutRenderer(localDb, new UITextureLoader(textureManager), acFont);
    const container = win.document.createElement('div');
    win.document.body.appendChild(container);

    let releaseWorld!: () => void;
    const worldReady = new Promise<void>((r) => { releaseWorld = r; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ui: any = null;
    expect(missesOf(() => {
      ui = new GameUI(container, {}, portalDb, textureManager, undefined, undefined, localDb, layoutRenderer, { worldArtReady: worldReady });
    })).toEqual([]);
    expect(ui.characterGenerator).not.toBeNull(); // 0x0E000002 from the skeleton pack
    expect(missesOf(() => { void ui.showLauncher({ bridgeUrl: 'ws://x', loadDirectory: () => new Promise(() => {}) }); })).toEqual([]);
    expect(missesOf(() => ui.showConnectingScreen())).toEqual([]);
    expect(missesOf(() => ui.showCharacterSelect([{ id: '1', name: 'Sim Tester' }, { id: '2', name: 'Second' }], 11))).toEqual([]);
    expect(store.stats.misses).toBe(0);

    // Chargen waits for the world pack (its heritage / clothing art).
    ui.showCharacterCreate();
    expect(ui.uiManager.currentScreen).toBe('character-select');
    expect(fetched.length - f0).toBe(artObjects); // nothing reached for the world pack's files as leaves

    // The world pack lands: the deferred preload + chargen run, with no miss.
    store.addPackBytes('world', worldPack);
    const missesBefore = store.stats.misses;
    releaseWorld();
    await worldReady;
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.uiManager.currentScreen).toBe('character-create');
    expect(ui.uiTextures.size).toBeGreaterThan(300); // loadChargenTextures ran (≈ 333 preload textures)
    expect(store.stats.misses).toBe(missesBefore);

    // main()'s deferred world init: terrain materials + sky objects (after the sky closure).
    const THREE = await import('three');
    const { TerrainManager } = await import('../packages/renderer/src/terrain/TerrainManager.js');
    const { TerrainRenderer } = await import('../packages/renderer/src/terrain/TerrainRenderer.js');
    const { detailTexturing } = await import('../packages/renderer/src/models/DetailTexturing.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SkyboxRenderer } = await import('../packages/renderer/src/effects/SkyboxRenderer.js');
    const rd = regionDesc!;
    await closure.ensure(skyObjectRoots(rd.skyInfo));
    const texMerge = rd.terrainInfo.landSurfaces.texMerge!;
    const terrainRenderer = new TerrainRenderer(new THREE.Scene(), new TerrainManager({ loadRadius: 2, landHeightTable: rd.landDefs.landHeightTable }));
    const modelRenderer = new ModelRenderer(portalDb, new MaterialFactory(portalDb, textureManager));
    const sky = new SkyboxRenderer(rd.skyInfo, rd.gameTime);
    expect(missesOf(() => {
      terrainRenderer.buildTerrainMaterials(texMerge.terrainDesc, textureManager, texMerge.baseTexSize);
      terrainRenderer.buildTerrainBlendOverlays(texMerge, textureManager);
      terrainRenderer.buildRoadOverlays(texMerge, textureManager);
      detailTexturing.loadSurfaces(texMerge, textureManager);
      for (let g = 0; g < (rd.skyInfo?.dayGroups.length ?? 0); g++) {
        (sky as unknown as { activeDayGroup: unknown }).activeDayGroup = rd.skyInfo!.dayGroups[g];
        sky.initSkyObjects(modelRenderer);
      }
    })).toEqual([]);
    expect(sky.skyObjectsGroup?.children.length ?? 0).toBeGreaterThan(0);

    // BUG.login-hold-powerbar-before-hud — the login hold reports before the gameplay UI is up;
    // bringing the HUD up (showGame rebuilds the power bar) shows the count it already has.
    ui.setRuntimeDDDStatus(true, 1, 4);
    ui.showGame();
    expect(ui.isPowerBarVisible()).toBe(true);
    expect((ui as unknown as { powerBarContainer: HTMLElement | null }).powerBarContainer?.isConnected).toBe(true);
    expect(ui.powerBarHandle.elements.get(0x2).style.width).toBe('25%');
    ui.setRuntimeDDDStatus(false, 0, 0);
    expect(ui.isPowerBarVisible()).toBe(false);

    // RuntimeDDDStatus → the power bar's DDD mode (gmPowerbarUI::RecvNotice_RuntimeDDDStatus).
    ui.setRuntimeDDDStatus(true, 0, 9);
    expect(ui.isPowerBarVisible()).toBe(true);
    const texts: Array<[number, string]> = [];
    const handle = ui.powerBarHandle;
    const setText = handle.setText.bind(handle);
    handle.setText = (id: number, t: string, c?: string) => { texts.push([id, t]); setText(id, t, c); };
    ui.setRuntimeDDDStatus(true, 3, 9);
    expect(texts).toContainEqual([0x10000035, 'Download: 3 / 9']);
    expect(handle.elements.get(0x2).style.width).toBe(`${(3 / 9) * 100}%`);
    ui.setRuntimeDDDStatus(false, 0, 0);
    expect(ui.isPowerBarVisible()).toBe(false);

    // The numbers docs/dat-streaming.md §6.6 quotes (gzip level 6 here; the publish tool's packs are within a few %).
    const kb = (n: number) => Math.round(n / 1024);
    console.log(`[charselect set] boot ${kb(packGz.boot)} KB + local ${kb(packGz.local)} KB + skeleton ${kb(packGz.skeleton)} KB + pre-world art ${artObjects} leaves / ${kb(artGz)} KB (of ${art.length} art files)`);
    expect(artObjects).toBeLessThan(200);
  }, 300_000);
});
