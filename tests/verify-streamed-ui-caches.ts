/**
 * Streamed DATs: UI caches never keep a miss (UI.chargen-wheel-cache-keeps-misses,
 * UI.ac1999-icon-cache-keeps-misses, UI.selection-triangles-paint-once,
 * UI.texture-loader-paletteless-decode, TEX.very-high-remembers-highres-miss).
 *
 * A streamed DAT answers a read of a manifest file that is not resident yet
 * with null (or, when only the 0x04 palette missed, TextureManager's
 * palette-less decode) and bumps the DatMiss epoch. Each cache here used to
 * store that result for the session: the Magic panel's Components icons, the
 * chargen / barber colour wheel, AC1999's interface textures, the selection
 * triangles, layout art and Very High's highres level stayed blank (or wrong)
 * after the file arrived. These drive the real modules with a source that
 * misses, then has the file.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DatDatabase, type DatResidentSource } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { loadChargen1999 } from '../packages/renderer/src/ui/Chargen1999.js';
import { CHARGEN_DID_MAPPER, ChargenViewAnimator, PaperdollPoser } from '../packages/renderer/src/ui/ChargenViewAnimation.js';
import { DAT_ARRIVAL_COALESCE_MS, noteDatMiss, noteDatMissResolved } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import {
  TextureSamplerPrefs, VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL, textureSamplerPrefs,
} from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { UITextureLoader } from '../packages/renderer/src/ui/UITextureLoader.js';
import { VividTargetIndicatorView, type VtiFrame } from '../packages/renderer/src/ui/VividTargetIndicator.js';
import { installDomGlobals, loadDomWindow, restoreDomGlobals } from './_harness/dom.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import { MediaType, parseMasterProperty, setMasterPropertyTypes } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.js';
import { BarberModel, BarberPart } from '../packages/renderer/src/ui/BarberModel.js';
import { LayoutRenderer } from '../packages/renderer/src/ui/LayoutRenderer.js';
import { DEFAULT_TEXT_FONT_DID, textStyleFromDesc } from '../packages/renderer/src/ui/DatTextStyle.js';
import { onDatMissResolved } from '../packages/dat-parser/src/streaming/DatMiss.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A resident-source DAT whose files can be withheld (a streamed DAT before arrival). */
function streamedDat(files: Map<number, Uint8Array>, withheld: Set<number>): DatDatabase {
  const src: DatResidentSource = {
    kind: 'resident',
    header: { blockSize: 1024, dataSet: 1, dataSubset: 0, masterMapId: 0 },
    get: (id) => {
      if (withheld.has(id)) { noteDatMiss(); return null; }
      const f = files.get(id);
      return f ? f.slice().buffer : null;
    },
    has: (id) => files.has(id),
    listIds: () => [...files.keys()],
    get count() { return files.size; },
    sizeOf: (id) => files.get(id)?.byteLength ?? -1,
  };
  return new DatDatabase(src);
}

/** A P8 Texture `id`: `w`×1, every index 1, default palette 0x04000010. */
function p8TextureBytes(id: number, w: number): Uint8Array {
  const b = new Uint8Array(24 + w + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, id, true); dv.setInt32(4, 0, true); dv.setInt32(8, w, true); dv.setInt32(12, 1, true);
  dv.setUint32(16, 41, true); // PFID_P8
  dv.setInt32(20, w, true);
  b.fill(1, 24, 24 + w);
  dv.setUint32(24 + w, 0x04000010, true);
  return b;
}
/** SurfaceTexture `id` → its texture levels (highest detail first). */
function surfaceTextureBytes(id: number, levels: number[]): Uint8Array {
  const b = new Uint8Array(4 + 4 + 1 + 4 + 4 * levels.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, id, true); dv.setUint32(4, 0, true); b[8] = 0; dv.setUint32(9, levels.length, true);
  levels.forEach((l, i) => dv.setUint32(13 + 4 * i, l, true));
  return b;
}

describe('TextureSamplerPrefs: Very High upgrades once a streamed highres level arrives', () => {
  it('a highres miss draws the portal level and re-applies on arrival (not remembered as unavailable)', async () => {
    const prefs = new TextureSamplerPrefs({ value: 0 });
    prefs.set({ environmentTextureDetail: VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL });
    prefs.setHighResMounted(true); // client_highres.dat mounts at once; its files arrive later
    const portal = { width: 2, height: 2, data: new Uint8Array(16) };
    const hires = { width: 4, height: 4, data: new Uint8Array(64).fill(7) };
    let resident = false;
    let reads = 0;
    const tex = new THREE.DataTexture(portal.data, 2, 2, THREE.RGBAFormat);
    prefs.register(tex, 'environment', portal, { hiRes: () => { reads++; if (!resident) { noteDatMiss(); return null; } return hires; } });
    expect(prefs.isAtHighRes(tex)).toBe(false);
    expect((tex.image as { width: number }).width).toBe(2);
    resident = true;
    noteDatMissResolved();
    await wait(DAT_ARRIVAL_COALESCE_MS + 30);
    expect(prefs.isAtHighRes(tex)).toBe(true);
    expect((tex.image as { width: number }).width).toBe(4);
    // Resolved for good: a later re-apply reads nothing again.
    const before = reads;
    prefs.set({ textureFiltering: prefs.textureFiltering === 0 ? 1 : 0 });
    expect(reads).toBe(before);
  });

  it('a texture with no highres level (whole DATs) is still remembered as unavailable', () => {
    const prefs = new TextureSamplerPrefs({ value: 0 });
    prefs.set({ environmentTextureDetail: VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL });
    prefs.setHighResMounted(true);
    let reads = 0;
    const tex = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat);
    prefs.register(tex, 'environment', undefined, { hiRes: () => { reads++; return null; } });
    prefs.set({ textureFiltering: prefs.textureFiltering === 0 ? 1 : 0 });
    expect(reads).toBe(1);
    expect(prefs.isAtHighRes(tex)).toBe(false);
  });
});

describe('TextureManager.getTextureWithPalette across a streamed highres miss', () => {
  const saved = { ...textureSamplerPrefs.values, mounted: textureSamplerPrefs.highResMounted };
  afterAll(() => {
    textureSamplerPrefs.set({ textureFiltering: saved.textureFiltering, landscapeTextureDetail: saved.landscapeTextureDetail, environmentTextureDetail: saved.environmentTextureDetail });
    textureSamplerPrefs.setHighResMounted(saved.mounted);
  });

  it('a texture built while its highres level missed is not cached; after arrival it is built from it', () => {
    textureSamplerPrefs.set({ environmentTextureDetail: VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL });
    textureSamplerPrefs.setHighResMounted(true);
    const portalFiles = new Map<number, Uint8Array>([
      [0x05000020, surfaceTextureBytes(0x05000020, [0x06000021, 0x06000020])],
      [0x06000020, p8TextureBytes(0x06000020, 2)],
    ]);
    const hiFiles = new Map<number, Uint8Array>([[0x06000021, p8TextureBytes(0x06000021, 8)]]);
    const withheld = new Set([0x06000021]);
    const tm = new TextureManager(streamedDat(portalFiles, new Set()), 64, 64, streamedDat(hiFiles, withheld));
    const colors = [0xff000000, 0xffff0000];
    const first = tm.getTextureWithPalette(0x05000020, colors)!;
    expect(first.image.width).toBe(2); // the portal level while the highres one streams
    withheld.clear();
    const second = tm.getTextureWithPalette(0x05000020, colors)!;
    expect(second).not.toBe(first);
    expect(second.image.width).toBe(8);
    expect(tm.getTextureWithPalette(0x05000020, colors)).toBe(second); // the real one is cached
  });
});

describe('UITextureLoader across a streamed palette miss', () => {
  it('a palette-less decode is drawn but not cached; the next read takes the real one', () => {
    let paletteResident = false;
    const tm = {
      getJPEGDataURL: () => null,
      getIconDataURL: (id: number) => {
        if (!paletteResident) { noteDatMiss(); return `data:paletteless-${id}`; }
        return `data:real-${id}`;
      },
    };
    const loader = new UITextureLoader(tm as unknown as TextureManager);
    expect(loader.getTextureDataURL(0x06000005)).toBe('data:paletteless-100663301');
    paletteResident = true;
    expect(loader.getTextureDataURL(0x06000005)).toBe('data:real-100663301');
    paletteResident = false; // cached now: no re-read
    expect(loader.getTextureDataURL(0x06000005)).toBe('data:real-100663301');
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('VividTargetIndicatorView: triangles whose textures missed paint once they arrive', () => {
  const saved: Record<string, unknown> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function view(isResident: () => boolean) {
    const img = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
    return new VividTargetIndicatorView(domWindow.document.body, '1',
      () => { if (!isResident()) { noteDatMiss(); return null; } return img; },
      () => 'data:tri');
  }
  const red = { r: 1, g: 0, b: 0, a: 1 };

  it('corners left blank by a miss fill on a later frame in the same colour', () => {
    let resident = false;
    const v = view(() => resident);
    const frame: VtiFrame = { kind: 'onscreen', placement: { x: 0, y: 0, w: 10, h: 10 } };
    v.update(frame, red);
    expect(v.corners[0].style.backgroundImage).toBe('');
    resident = true;
    v.update(frame, red);
    for (const c of v.corners) expect(c.style.backgroundImage).toContain('data:tri');
  });

  it('the off-screen arrow too', () => {
    let resident = false;
    const v = view(() => resident);
    const frame: VtiFrame = { kind: 'offscreen', image: 5, x: 0, y: 0 };
    v.update(frame, red);
    expect(v.offScreen.style.backgroundImage).toBe('');
    resident = true;
    v.update(frame, red);
    expect(v.offScreen.style.backgroundImage).toContain('data:tri');
  });
});

describe('GameUI icon / wheel caches across a streamed miss', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    // A 2D context stand-in (happy-dom has none): the data URL names the first pixel.
    const proto = domWindow.HTMLCanvasElement.prototype;
    proto.getContext = function getContext(this: { _px?: Uint8ClampedArray }) {
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (d: { data: Uint8ClampedArray }) => { this._px = d.data; },
      };
    };
    proto.toDataURL = function toDataURL(this: { _px?: Uint8ClampedArray }) { return `data:px,${this._px?.[0] ?? 'none'}`; };
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  /** Icon pixels: red 9 while the palette is missing (a palette-less decode), 200 once resident; null while the file is missing. */
  function textures(state: { file: boolean; palette: boolean }) {
    const rgba = () => {
      if (!state.file) { noteDatMiss(); return null; }
      if (!state.palette) noteDatMiss();
      return { width: 1, height: 1, data: new Uint8Array([state.palette ? 200 : 9, 0, 0, 255]) };
    };
    return {
      getIconRGBA: rgba,
      getIconDataURL: () => { const p = rgba(); return p ? `data:px,${p.data[0]}` : null; },
      getJPEGDataURL: () => null,
    };
  }
  function makeUI(state: { file: boolean; palette: boolean }, separateUi = false) {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const tm = textures(state);
    const uiTm = separateUi ? textures(state) : null;
    return new GameUICtor(container, {}, undefined, tm, undefined, undefined, null, null, undefined,
      uiTm ? { portalDb: {} as never, textureManager: uiTm } : null);
  }

  it('Components-tab icons (chargenWheelImageURL) are not cached across a miss, and the open Magic panel repaints', () => {
    const state = { file: false, palette: false };
    const ui = makeUI(state);
    let magicRenders = 0;
    ui.magicVisible = true;
    ui.renderMagicPanel = () => { magicRenders++; };
    const paint = (img: { width: number; height: number; data: Uint8Array }) => img;
    expect(ui.chargenWheelImageURL(0x06001234, 'spellcomp', paint, 'world')).toBeNull();
    state.file = true; // the texture lands; its palette hasn't yet
    expect(ui.chargenWheelImageURL(0x06001234, 'spellcomp', paint, 'world')).toBe('data:px,9');
    ui.onStreamedFilesArrived();
    expect(magicRenders).toBe(1);
    state.palette = true;
    expect(ui.chargenWheelImageURL(0x06001234, 'spellcomp', paint, 'world')).toBe('data:px,200');
    state.file = false; // cached now: no re-read
    expect(ui.chargenWheelImageURL(0x06001234, 'spellcomp', paint, 'world')).toBe('data:px,200');
  });

  it('an open barber page repaints its wheel when streamed files land after a wheel miss', () => {
    const state = { file: false, palette: true };
    const ui = makeUI(state);
    let paints = 0;
    ui.barberPanel = { paint: () => { paints++; }, close: () => {} };
    expect(ui.chargenWheelImageURL(0x06004d40, 'x#ff0000', (img: unknown) => img)).toBeNull();
    ui.onStreamedFilesArrived();
    expect(paints).toBe(1);
  });

  it('a separate interface portal (AC1999): getUiIconURL does not cache a miss or a palette-less decode', () => {
    const state = { file: false, palette: false };
    const ui = makeUI(state, true);
    expect(ui.getTexURL(0x060067cf)).toBeNull();
    state.file = true;
    expect(ui.getTexURL(0x060067cf)).toBe('data:px,9');
    state.palette = true;
    expect(ui.getTexURL(0x060067cf)).toBe('data:px,200');
    state.file = false;
    expect(ui.getTexURL(0x060067cf)).toBe('data:px,200');
  });

  it('getItemIconURL does not cache an icon decoded while its palette was missing', () => {
    const state = { file: true, palette: false };
    const ui = makeUI(state);
    expect(ui.getItemIconURL(0x06001111)).toBe('data:px,9');
    state.palette = true;
    expect(ui.getItemIconURL(0x06001111)).toBe('data:px,200');
  });

  it('datDescFor does not remember a layout that missed', () => {
    const ui = makeUI({ file: true, palette: true });
    let resident = false;
    const el = { elementId: 0x10000001, children: new Map(), properties: new Map() };
    ui.layoutRenderer = {
      getResolvedLayout: () => {
        if (!resident) { noteDatMiss(); return null; }
        return { layoutId: 0x21000001, width: 1, height: 1, elements: new Map([[0x10000001, el]]) };
      },
    };
    expect(ui.datDescFor('0x21000001:0x10000001')).toBeNull();
    resident = true;
    expect(ui.datDescFor('0x21000001:0x10000001')).toBe(el);
  });
});

describe('chargen DidMapper 0x25000010 is read again after a streamed miss', () => {
  /** A portal stand-in: every read is absent; `miss` makes it a streamed miss. */
  function fakeDb(state: { miss: boolean; reads: number[] }) {
    return {
      masterMapId: 0,
      getFileData(id: number) { state.reads.push(id); if (state.miss) noteDatMiss(); return null; },
      hasFile() { return true; },
    } as never;
  }
  const mapperReads = (s: { reads: number[] }) => s.reads.filter((r) => r === CHARGEN_DID_MAPPER).length;

  it('ChargenViewAnimator: a missed mapper is retried on the next bind, then kept', () => {
    const state = { miss: true, reads: [] as number[] };
    const animator = new ChargenViewAnimator(fakeDb(state));
    animator.bind(new THREE.Group(), 1);
    animator.bind(new THREE.Group(), 1);
    expect(mapperReads(state)).toBe(2);
    state.miss = false;
    animator.bind(new THREE.Group(), 1);
    animator.bind(new THREE.Group(), 1);
    expect(mapperReads(state)).toBe(3);
  });

  it('PaperdollPoser: a missed mapper is retried, then kept', () => {
    const state = { miss: true, reads: [] as number[] };
    const poser = new PaperdollPoser(fakeDb(state));
    poser.animationDid(1);
    poser.animationDid(1);
    expect(mapperReads(state)).toBe(2);
    state.miss = false;
    poser.animationDid(1);
    poser.animationDid(1);
    expect(mapperReads(state)).toBe(3);
  });
});

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('AC1999 chargen text is read again after a streamed miss', () => {
  it('a heritage description that missed is not remembered as absent', () => {
    const world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    let missing = true;
    const read = world.getFileData.bind(world);
    world.getFileData = (id: number) => {
      if (missing && (id >>> 24) === 0x31) { noteDatMiss(); return null; }
      return read(id);
    };
    const text = loadChargen1999(world)!;
    expect(text.heritageText(1)).toBeNull();
    missing = false;
    expect(text.heritageText(1)!.startsWith('ALUVIANS')).toBe(true);
  });
});

describe('GameUI chargen preload / paperdoll hit map across a palette miss', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function newUI() {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  it('a preload texture decoded without its palette is not kept; the retry stores the real one', () => {
    const ui = newUI();
    let palette = false;
    ui.textureManager = {
      getIconRGBA: () => { if (!palette) noteDatMiss(); return { width: 1, height: 1, data: new Uint8Array(4) }; },
      getIconDataURL: (id: number) => `data:${palette ? 'real' : 'paletteless'}-${id}`,
      getJPEGDataURL: () => null,
    };
    ui.loadChargenTextures();
    expect(ui.uiTextures.get(0x06004d26)).toBeUndefined();
    palette = true;
    ui.onStreamedFilesArrived();
    expect(ui.uiTextures.get(0x06004d26)).toBe('data:real-100683046');
  });

  it.skipIf(!existsSync(DAT_PATHS.portal))('a hit-test image decoded without its palette is used once, not kept', () => {
    const ui = newUI();
    ui.portalDb = openDat(DAT_PATHS.portal);
    const partial = { width: 1, height: 1, data: new Uint8Array(4) };
    const real = { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) };
    let palette = false;
    ui.textureManager = { getIconRGBA: () => { if (!palette) { noteDatMiss(); return partial; } return real; } };
    expect(ui.paperdollClickMap()).toBe(partial);
    palette = true;
    expect(ui.paperdollClickMap()).toBe(real);
  });
});

describe('GameUI.loadDATAssets re-runs the steps that missed when files arrive', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function newUI(portal: unknown) {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container, {}, portal);
  }

  it('the tables and the UI font are read again after a boot-time miss, then kept', () => {
    const state = { miss: true, reads: [] as number[] };
    const portal = {
      masterMapId: 0,
      getFileData(id: number) { state.reads.push(id); if (state.miss) noteDatMiss(); return null; },
      hasFile() { return true; },
    };
    const ui = newUI(portal);
    const count = (id: number) => state.reads.filter((r) => r === id).length;
    const ids = [0x0E000002, 0x0E000004, 0x0E00000E, 0x0E00000F, 0x40000000];
    for (const id of ids) expect(count(id)).toBe(1);
    state.miss = false;
    ui.onStreamedFilesArrived();
    // The tables once more; the font at least once more (the chat-font pass may look it up too).
    expect(ids.slice(0, 4).map(count)).toEqual([2, 2, 2, 2]);
    expect(count(0x40000000)).toBeGreaterThanOrEqual(2);
    const after = ids.map(count);
    ui.onStreamedFilesArrived(); // nothing missed since: nothing re-read
    expect(ids.map(count)).toEqual(after);
  });

  it.skipIf(!existsSync(DAT_PATHS.portal))('a SkillTable / CharacterGenerator that missed load on arrival, and chargen + panels repaint', () => {
    // Its own instance: openDat's is shared per worker.
    const portal = new DatDatabase(new FileDatBytes(DAT_PATHS.portal));
    let missing = true;
    const read = portal.getFileData.bind(portal);
    portal.getFileData = (id: number) => {
      if (missing && (id === 0x0E000004 || id === 0x0E000002)) { noteDatMiss(); return null; }
      return read(id);
    };
    const ui = newUI(portal);
    expect(ui.skillTable).toBeNull();
    expect(ui.charGen).toBeNull();
    let charPanelRefreshes = 0;
    ui.refreshCharPanel = () => { charPanelRefreshes++; };
    missing = false;
    ui.onStreamedFilesArrived();
    expect(ui.skillTable).not.toBeNull();
    expect(ui.charGen).not.toBeNull();
    expect(charPanelRefreshes).toBe(1);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('BarberModel: wheel spots computed across a palette miss are recomputed', () => {
  it('refreshSpotColors fills the spots once the palettes land, and is a no-op after a clean selection', () => {
    const portal = openDat(DAT_PATHS.portal);
    const charGen = new CharacterGenerator(new DatReader(portal.getFileData(0x0E000002)!));
    const sex = charGen.heritageGroups.get(1)!.genders.get(1)!;
    const real = new AppearanceManager(portal);
    let missing = true;
    const pal = {
      loadPaletteSet: (id: number) => real.loadPaletteSet(id),
      loadPaletteColors: (id: number) => { if (missing) { noteDatMiss(); return null; } return real.loadPaletteColors(id); },
    };
    const m = new BarberModel(1, 1, sex, pal);
    m.setSelection(BarberPart.Eyes);
    expect(m.wheel.spotColors[0]).toEqual({ r: 0, g: 0, b: 0 });
    missing = false;
    expect(m.refreshSpotColors()).toBe(true);
    expect(m.wheel.spotColors[0]).not.toEqual({ r: 0, g: 0, b: 0 });
    expect(m.refreshSpotColors()).toBe(false);
  });
});

describe('LayoutRenderer re-applies panel art that drew across a streamed miss', () => {
  const saved: Record<string, unknown> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function renderer(resident: Set<number>) {
    const loader = {
      getTextureDataURL: (id: number) => {
        if (!resident.has(id)) { noteDatMiss(); return null; }
        return `data:tex-${id.toString(16)}`;
      },
    };
    return new LayoutRenderer({} as never, loader as never, null);
  }
  const image = (file: number) => [{ type: MediaType.Image, file }];

  it('an element whose texture missed gets it when the files land', async () => {
    const resident = new Set<number>();
    const lr = renderer(resident);
    const el = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(el);
    lr.applyMediaToElement(el, image(0x06000001), 1);
    expect(el.style.backgroundImage).toBe('');
    expect(lr.pendingMediaCount).toBe(1);
    resident.add(0x06000001);
    noteDatMissResolved();
    await wait(DAT_ARRIVAL_COALESCE_MS + 30);
    expect(el.style.backgroundImage).toContain('data:tex-6000001');
    expect(lr.pendingMediaCount).toBe(0);
  });

  it('a newer clean state is not overwritten by the replay; a closed panel is dropped', () => {
    const resident = new Set<number>([0x06000003]);
    const lr = renderer(resident);
    const el = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(el);
    lr.applyMediaToElement(el, image(0x06000002), 1); // missed
    lr.applyMediaToElement(el, image(0x06000003), 1); // the element moved to another state, drawn cleanly
    resident.add(0x06000002);
    lr.replayMissedMedia();
    expect(el.style.backgroundImage).toContain('data:tex-6000003');
    const gone = domWindow.document.createElement('div');
    lr.applyMediaToElement(gone, image(0x06000004), 1);
    lr.replayMissedMedia();
    expect(lr.pendingMediaCount).toBe(0);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.local) || !existsSync(DAT_PATHS.portal))('LayoutRenderer: scrollbar textures and p26-font labels across a streamed miss', () => {
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    setMasterPropertyTypes(parseMasterProperty(openDat(DAT_PATHS.portal).getReader(0x39000001)));
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function renderer(missing: Set<number>) {
    const loader = {
      getTextureDataURL: (id: number) => {
        if (missing.has(id)) { noteDatMiss(); return null; }
        return `data:tex-${id.toString(16)}`;
      },
      getTextureDataURLWithAlpha: () => null,
    };
    return new LayoutRenderer(openDat(DAT_PATHS.local), loader as never, null);
  }

  it('a direct track / thumb texture that missed is applied when the files land', () => {
    const missing = new Set([0x06000aa1, 0x06000aa2]);
    const lr = renderer(missing);
    const parent = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(parent);
    const handle = lr.render(0x21000068, parent)!;
    const id = [...handle.elements.keys()][1];
    handle.setScrollable(id, { trackTextureId: 0x06000aa1, thumbTextureId: 0x06000aa2 });
    const track = parent.querySelector('.layout-scrollbar-track') as HTMLElement;
    const thumb = track.firstElementChild as HTMLElement;
    expect(track.style.backgroundImage).toBe('');
    missing.clear();
    lr.replayMissedMedia();
    expect(track.style.backgroundImage).toContain('data:tex-6000aa1');
    expect(thumb.style.backgroundImage).toContain('data:tex-6000aa2');
  });

  it('a label whose p26 font missed is painted again on arrival (with its latest text)', () => {
    const lr = renderer(new Set());
    let missing = true;
    const asked: number[] = [];
    lr.setFontResolver((did) => { asked.push(did); if (missing) noteDatMiss(); return null; });
    const parent = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(parent);
    const handle = lr.render(0x21000068, parent)!;
    const fontId = [...handle.descs].find(([, d]) => textStyleFromDesc(d).font !== DEFAULT_TEXT_FONT_DID)?.[0];
    expect(fontId).toBeDefined();
    handle.setText(fontId!, 'first');
    handle.setText(fontId!, 'latest');
    const before = asked.length;
    expect(lr.pendingLabelCount).toBeGreaterThan(0);
    missing = false;
    lr.replayMissedMedia();
    expect(asked.length).toBeGreaterThan(before);
    expect(lr.pendingLabelCount).toBe(0);
    expect(handle.elements.get(fontId!)!.textContent).toContain('latest');
  });
});

describe('GameUI: chat font that missed is applied on arrival; arrival repaint runs after the other listeners', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function newUI() {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new GameUICtor(container);
  }

  it('applyChatFont keeps the current font across a miss and applies the new one when files land', () => {
    const ui = newUI();
    let missing = true;
    const renderer = { isReady: true };
    ui.resolveChatFontDidFromOptions = () => 0x40000017;
    ui.loadFontRenderer = () => { if (missing) noteDatMiss(); return renderer; };
    ui.chatLogElements = () => [];
    expect(ui.applyChatFont()).toBe(false);
    expect(ui.currentChatFontDid).not.toBe(0x40000017);
    missing = false;
    ui.onStreamedFilesArrived();
    expect(ui.currentChatFontDid).toBe(0x40000017);
  });

  it('the paperdoll / panel repaint sees what later arrival listeners did (held items re-attached)', async () => {
    const ui = newUI();
    const world = { reattached: false };
    let sawReattached: boolean | null = null;
    ui.onStreamedFilesArrived = () => { sawReattached = world.reattached; };
    const off = onDatMissResolved(() => { world.reattached = true; }); // main.ts's held-item listener registers later
    try {
      noteDatMissResolved();
      await wait(DAT_ARRIVAL_COALESCE_MS + 30);
      expect(sawReattached).toBe(true);
    } finally {
      off();
    }
  });

  it('replaceExaminePreview redraws only the open figure of that object', () => {
    const ui = newUI();
    const canvas = domWindow.document.createElement('canvas');
    canvas.className = 'ac-examine-preview';
    const viewport = domWindow.document.createElement('div');
    viewport.appendChild(canvas);
    const drawn: unknown[] = [];
    ui.renderExaminePreview = (_c: unknown, mesh: unknown) => { drawn.push(mesh); };
    const mesh = new THREE.Group();
    expect(ui.replaceExaminePreview(0x50000001, mesh)).toBe(false); // nothing open
    ui.examinePanelHandle = { elements: new Map([[0x10000148, viewport]]) };
    ui.examineCurrentGuid = 0x50000001;
    ui.examineCurrentPage = 'creature';
    expect(ui.isExaminingFigure(0x50000001)).toBe(true);
    expect(ui.replaceExaminePreview(0x50000002, mesh)).toBe(false);
    expect(ui.replaceExaminePreview(0x50000001, mesh)).toBe(true);
    expect(drawn).toEqual([mesh]);
    ui.examineCurrentPage = 'item';
    expect(ui.replaceExaminePreview(0x50000001, mesh)).toBe(false);
  });
});
