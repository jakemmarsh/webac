/**
 * docs/ac1999-support-scope.md Phase 1.3 — the UI/world portal split guard.
 *
 * AC1999 runs the 1999 portal for the world beside the end-of-retail portal
 * for the interface. The two share id spaces (0x06…, 0x0E…, 0x20…, 0x25…)
 * with different files behind them, so a read from the wrong one silently
 * draws the wrong art. These suites hand the real classes two DISTINCT
 * recording stub DATs (and texture sources) and assert that the interface ids
 * (fonts, enum / did mappers, the UI sound table, layout art) are only read
 * from `ui` and the world ids (game tables, server-sent icons, animations,
 * object sounds) only from `world`. With one DAT (every other era) the UI
 * side falls back to it, exactly as before the split.
 *
 * Also: the AC1999 server-patch plumbing (era/Ac1999World.ts) — inflate,
 * apply into the overlay, persist and restore per server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { SoundPlayer } from '../packages/renderer/src/audio/SoundPlayer.js';
import {
  ChargenViewAnimator, PaperdollPoser, CHARGEN_DID_MAPPER, CHARGEN_ANIMATION_DIDS, ChargenAnimationEnum,
} from '../packages/renderer/src/ui/ChargenViewAnimation.js';
import { CursorManager } from '../packages/renderer/src/ui/CursorManager.js';
import { Ac1999World, ac1999PatchKey, ac1999ServerKey, inflateAc1999Patch } from '../packages/renderer/src/era/Ac1999World.js';
import type { DatBlobStore, DatCacheMeta } from '../packages/renderer/src/dat/DatCache.js';
import type { IconRgba } from '../packages/renderer/src/ui/ItemIconComposite.js';

const MASTER = 0x27000000;

/** A DAT that records every id asked of it and holds no files. */
function recordingDb(name: string) {
  const reads: number[] = [];
  return {
    name, reads, masterMapId: MASTER, totalIterations: 1,
    getFileData(id: number): ArrayBuffer | null { reads.push(id >>> 0); return null; },
    hasFile(id: number): boolean { reads.push(id >>> 0); return false; },
    getReader(id: number): never { reads.push(id >>> 0); throw new Error('no file'); },
    listFileIds: () => [] as number[],
  };
}
type RecordingDb = ReturnType<typeof recordingDb>;

const solid = (): IconRgba => ({ width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(255) });

/** A texture source that records every id it is asked to decode. */
function recordingTm() {
  const reads: number[] = [];
  return {
    reads,
    getIconRGBA(id: number) { reads.push(id >>> 0); return solid(); },
    getIconDataURL(id: number) { reads.push(id >>> 0); return `data:image/png;id,${id}`; },
    getJPEGDataURL(id: number) { reads.push(id >>> 0); return null; },
    getTextureDataURL(id: number) { reads.push(id >>> 0); return null; },
  };
}

const hex = (ids: number[]) => [...new Set(ids)].map((i) => `0x${i.toString(16)}`).sort();
const prefixes = (ids: number[]) => new Set(ids.map((i) => i >>> 24));

describe('SoundPlayer: the interface sounds read the UI portal, object sounds the world', () => {
  const am = { audioContext: {}, getCategoryVolume: () => 1, getCategoryGain: () => null, isCategoryMuted: () => false } as never;

  it('playGameSound (the UI table 0x2000004B) and playFromCenter (layout waves) read only the UI portal', async () => {
    const world = recordingDb('world');
    const ui = recordingDb('ui');
    const sp = new SoundPlayer(world as never, am, ui as never);
    await sp.playGameSound(0x2000004b, 0x72, 'ui');
    await sp.playFromCenter(0x0a000123, 1.0, 'ui');
    expect(hex(ui.reads)).toEqual(['0x2000004b', '0xa000123']);
    expect(world.reads).toEqual([]);
  });

  it('object / ambient tables and waves (loadSoundTable, decodeWave, playSound) read only the world portal', async () => {
    const world = recordingDb('world');
    const ui = recordingDb('ui');
    const sp = new SoundPlayer(world as never, am, ui as never);
    sp.loadSoundTable(0x20000001);
    await sp.decodeWave(0x0a000001);
    await sp.playSound(0x0a000002);
    expect(hex(world.reads)).toEqual(['0x20000001', '0xa000001', '0xa000002']);
    expect(ui.reads).toEqual([]);
  });

  it('a missing Wave is fetched from its own side\'s streamed set (fetchMissing names the portal)', async () => {
    const world = recordingDb('world');
    const ui = recordingDb('ui');
    const sp = new SoundPlayer(world as never, am, ui as never);
    const asked: Array<[number, string]> = [];
    sp.fetchMissing = async (id, src) => { asked.push([id >>> 0, src]); return false; };
    await sp.playFromCenter(0x0a000123, 1.0, 'ui');
    await sp.decodeWave(0x0a000001);
    expect(asked).toEqual([[0x0a000123, 'ui'], [0x0a000001, 'world']]);
  });

  it('one portal (every other era) serves both, as before', async () => {
    const db = recordingDb('one');
    const sp = new SoundPlayer(db as never, am);
    await sp.playGameSound(0x2000004b, 0x72, 'ui');
    sp.loadSoundTable(0x20000001);
    expect(hex(db.reads)).toEqual(['0x20000001', '0x2000004b']);
  });
});

describe('chargen / paperdoll animation: the DidMapper from the UI portal, the animation from the world', () => {
  it('PaperdollPoser', () => {
    const world = recordingDb('world');
    const ui = recordingDb('ui');
    const poser = new PaperdollPoser(world as never, ui as never);
    const did = poser.animationDid(1);
    expect(did).toBe(CHARGEN_ANIMATION_DIDS[ChargenAnimationEnum.PaperDollAnimation]);
    poser.pose({ children: [] } as never, 1);
    expect(hex(ui.reads)).toEqual([`0x${CHARGEN_DID_MAPPER.toString(16)}`]);
    expect(hex(world.reads)).toEqual([`0x${did.toString(16)}`]);
  });

  it('ChargenViewAnimator reads its mapper from the UI portal', () => {
    const world = recordingDb('world');
    const ui = recordingDb('ui');
    const animator = new ChargenViewAnimator(world as never, ui as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (animator as any).loadMapper();
    expect(hex(ui.reads)).toEqual([`0x${CHARGEN_DID_MAPPER.toString(16)}`]);
    expect(world.reads).toEqual([]);
  });

  it('one portal: both from it', () => {
    const db = recordingDb('one');
    new PaperdollPoser(db as never).pose({ children: [] } as never, 1);
    expect(prefixes(db.reads)).toEqual(new Set([0x25, 0x03]));
  });
});

describe('CursorManager reads the UICURSOR mapper from the portal it is given (main.ts: the UI one)', () => {
  it('UI portal + UI textures', () => {
    const ui = recordingDb('ui');
    const tm = recordingTm();
    new CursorManager(ui as never, tm as never).getCursorCSS('Default');
    expect(prefixes(ui.reads)).toEqual(new Set([0x25]));
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI with two portals (happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  let world: RecordingDb;
  let ui: RecordingDb;
  let worldTm: ReturnType<typeof recordingTm>;
  let uiTm: ReturnType<typeof recordingTm>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
    world = recordingDb('world');
    ui = recordingDb('ui');
    worldTm = recordingTm();
    uiTm = recordingTm();
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    gui = new mod.GameUI(container, {}, world, worldTm, undefined, undefined, null, null, undefined,
      { portalDb: ui, textureManager: uiTm });
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('boot: the game tables (CharGen, SkillTable, SpellTable, components) from the world; the UI font from the interface', () => {
    for (const id of [0x0e000002, 0x0e000004, 0x0e00000e, 0x0e00000f]) {
      expect(world.reads).toContain(id);
      expect(ui.reads).not.toContain(id);
    }
    expect(ui.reads).toContain(0x40000000);
    expect(world.reads).not.toContain(0x40000000);
    // The chargen layout art preloads from the UI textures.
    expect(uiTm.reads).toContain(0x06004d26);
    expect(worldTm.reads).not.toContain(0x06004d26);
  });

  it('fonts, the chat-font / icon / spell-icon / color-wheel / paperdoll-hit-test mappers: interface only', () => {
    const w0 = world.reads.length;
    ui.reads.length = 0;
    gui.loadFontRenderer(0x40000001);
    gui.resolveChatFontDidFromOptions();
    gui.itemIconFileIds({ iconDid: 0x06001234 });
    gui.spellIconFileIds([]);
    gui.chargenColorWheelAssets();
    gui.paperdollClickMap();
    expect(world.reads.length).toBe(w0);
    expect(ui.reads).toContain(0x40000001);
    expect(ui.reads).toContain(MASTER); // every enum mapper resolves through the master map
    expect([...prefixes(ui.reads)].every((p) => p === 0x40 || p === 0x27 || p === 0x25 || p === 0x22)).toBe(true);
  });

  it('layout art (getTexURL) decodes from the UI textures; a server icon DID (getItemIconURL) from the world', () => {
    worldTm.reads.length = 0;
    uiTm.reads.length = 0;
    expect(gui.getTexURL(0x06009999)).toBeTruthy();
    expect(gui.getItemIconURL(0x06001234)).toBeTruthy();
    expect(uiTm.reads).toEqual([0x06009999]);
    expect(worldTm.reads).toEqual([0x06001234]);
  });

  it('item icon composite: the item\'s icon / underlay / overlay from the world, the type backdrop + effect tint from the UI', () => {
    gui.iconEnumMaps = { backgrounds: new Map([[2, 0x06000b02]]), effects: new Map([[1, 0x06000e01]]), playerIconDid: 0x0600127e };
    worldTm.reads.length = 0;
    uiTm.reads.length = 0;
    gui.getRenderedItemIconURL({ iconDid: 0x06000100, overlayDid: 0x06000200, underlayDid: 0x06000300, itemType: 2, effects: 1 });
    expect(hex(worldTm.reads)).toEqual(['0x6000100', '0x6000200', '0x6000300']);
    expect(hex(uiTm.reads)).toEqual(['0x6000b02', '0x6000e01']);
    // The main pack: UIASSET's PlayerIcon (a UI mapper's DID) on the Container backdrop.
    worldTm.reads.length = 0;
    uiTm.reads.length = 0;
    gui.getRenderedItemIconURL({ iconDid: 0x06000100, isThePlayer: true });
    expect(worldTm.reads).toEqual([]);
    expect(uiTm.reads).toContain(0x0600127e);
  });

  it('spell icon composite: the SpellTable icon from the world, the power backdrop / tint from the UI', () => {
    gui.spellTable = { spells: new Map([[7, { icon: 0x06000400, formula: [1], bitfield: 0 }]]) };
    gui.spellIconEnumMaps = { levelBackgrounds: new Map([[1, 0x06000a01]]), effects: new Map([[2, 0x06000e02]]) };
    worldTm.reads.length = 0;
    uiTm.reads.length = 0;
    gui.getSpellIconURL(7);
    expect(worldTm.reads).toContain(0x06000400);
    expect(worldTm.reads.every((id) => id === 0x06000400)).toBe(true);
    expect(hex(uiTm.reads)).toEqual(['0x6000a01', '0x6000e02']);
  });

  it('one portal (no ui argument): the interface reads go to it, as before the split', () => {
    const db = recordingDb('one');
    const tm = recordingTm();
    const c = domWindow.document.createElement('div');
    const one = new mod.GameUI(c, {}, db, tm);
    expect(db.reads).toContain(0x40000000);
    expect(db.reads).toContain(0x0e000002);
    tm.reads.length = 0;
    one.getTexURL(0x06009999);
    expect(tm.reads).toContain(0x06009999);
  });
});

function memStore(): DatBlobStore & { data: Map<string, ArrayBuffer> } {
  const data = new Map<string, ArrayBuffer>();
  const meta = new Map<string, DatCacheMeta>();
  return {
    available: true, data,
    async getMeta(k) { return meta.get(k) ?? null; },
    async getData(k) { return data.get(k) ?? null; },
    async put(k, d, m) { data.set(k, d); meta.set(k, m); },
    async remove(k) { data.delete(k); meta.delete(k); },
    async clear() { data.clear(); meta.clear(); },
  };
}

/** A pre-ToD DAT stand-in: serves through its overlay like DatDatabase does. */
function preTodDb(baseIteration: number, files = new Map<number, ArrayBuffer>()) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    overlay: null as any,
    setOverlay(o: unknown) { this.overlay = o; },
    get totalIterations(): number { return this.overlay?.iteration ?? baseIteration; },
    getFileData(id: number): ArrayBuffer | null {
      const base = (i: number) => files.get(i) ?? null;
      const served = this.overlay?.get(id, base);
      return served !== undefined ? served : base(id);
    },
  };
}

const bytes = (...b: number[]) => new Uint8Array(b);

describe('AC1999 server DAT patches (era/Ac1999World.ts)', () => {
  it('inflates zlib (the server\'s framing) and passes stored files through', async () => {
    const raw = new Uint8Array(256).map((_, i) => i % 7);
    const z = new Uint8Array(deflateSync(raw));
    expect(z[0]).toBe(0x78);
    expect(new Uint8Array(await inflateAc1999Patch({ compressed: z, rawLength: raw.length }))).toEqual(raw);
    expect(new Uint8Array(await inflateAc1999Patch({ compressed: raw, rawLength: raw.length }))).toEqual(raw);
  });

  it('inflates zlib whose compressed length happens to equal the raw length (the server always compresses)', async () => {
    // Incompressible bytes then a zero run: grow the run until zlib's output is exactly the raw length.
    let seed = 7;
    const noise = Array.from({ length: 200 }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; });
    let raw = new Uint8Array(0);
    let z = new Uint8Array(0);
    for (let zeros = 0; zeros < 400; zeros++) {
      raw = new Uint8Array([...noise, ...new Array(zeros).fill(0)]);
      z = new Uint8Array(deflateSync(raw, { level: 9 }));
      if (z.length === raw.length) break;
    }
    expect(z.length).toBe(raw.length);
    expect(z).not.toEqual(raw);
    // The old rule (equal lengths = stored) served the zlib bytes as the file.
    expect(new Uint8Array(await inflateAc1999Patch({ compressed: z, rawLength: raw.length }))).toEqual(raw);
  });

  it('uses equal-length bytes as stored only when they are not zlib/deflate of that length; refuses other garbage', async () => {
    const stored = new Uint8Array([0x78, 0x9c, 1, 2, 3, 4, 5, 6]); // zlib-looking header, not a valid stream
    expect(new Uint8Array(await inflateAc1999Patch({ compressed: stored, rawLength: stored.length }))).toEqual(stored);
    await expect(inflateAc1999Patch({ compressed: new Uint8Array([0xff, 0xff, 0xff]), rawLength: 40 })).rejects.toThrow();
  });

  it('applies a login\'s patches to the right DAT, reports the server\'s iterations, persists and restores them per server', async () => {
    const portal = preTodDb(102);
    const cell = preTodDb(67);
    const w = new Ac1999World(portal as never, cell as never);
    expect(w.iterations).toEqual({ portal: 102, cell: 67 });
    const wave = bytes(9, 8, 7, 6);
    const lbi = bytes(1, 1, 1, 1);
    const files = await w.applyEvent({
      portalIteration: 110, cellIteration: 70,
      patches: [
        { dat: 'portal', fileId: 0x0a000005, compressed: new Uint8Array(deflateSync(wave)), rawLength: wave.length },
        { dat: 'cell', fileId: 0x0101fffe, compressed: lbi, rawLength: lbi.length },
      ],
    });
    expect(files).toHaveLength(2);
    expect(new Uint8Array(portal.getFileData(0x0a000005)!)).toEqual(wave);
    expect(new Uint8Array(cell.getFileData(0x0101fffe)!)).toEqual(lbi);
    expect(portal.getFileData(0x0101fffe)).toBeNull(); // never crosses DATs
    expect(w.iterations).toEqual({ portal: 110, cell: 70 });

    const store = memStore();
    const key = ac1999ServerKey('wss://bridge.example.org/connect?server=ac1999-local');
    await w.persist(store, key, files);
    expect(store.data.has(ac1999PatchKey(key, 0x0a000005))).toBe(true);

    const portal2 = preTodDb(102);
    const cell2 = preTodDb(67);
    const w2 = new Ac1999World(portal2 as never, cell2 as never);
    expect(await w2.restore(store, key)).toBe(2);
    expect(new Uint8Array(portal2.getFileData(0x0a000005)!)).toEqual(wave);
    expect(w2.iterations).toEqual({ portal: 110, cell: 70 });

    // Another server's patches never apply here.
    const w3 = new Ac1999World(preTodDb(102) as never, preTodDb(67) as never);
    expect(await w3.restore(store, ac1999ServerKey('wss://bridge.example.org/connect?server=other'))).toBe(0);
    expect(w3.iterations).toEqual({ portal: 102, cell: 67 });
  });

  it('a patch for a file already translated drops the overlay\'s translation cache', async () => {
    const cell = preTodDb(67, new Map([[0x01010100, bytes(0, 0, 0, 0).buffer as ArrayBuffer]]));
    const w = new Ac1999World(preTodDb(102) as never, cell as never);
    cell.getFileData(0x01010100); // an EnvCell: translated (here: fails) and cached
    expect(w.cellOverlay.cachedCount).toBe(1);
    w.apply([{ dat: 'cell', fileId: 0x01010100, bytes: bytes(1).buffer as ArrayBuffer }], { portal: 0, cell: 0 });
    expect(w.cellOverlay.cachedCount).toBe(0);
    expect(w.iterations.cell).toBe(67); // 0 keeps the iteration
  });

  it('an incomplete store restores nothing (the server sends everything again)', async () => {
    const store = memStore();
    const w = new Ac1999World(preTodDb(102) as never, preTodDb(67) as never);
    await w.persist(store, 'srv', [{ dat: 'portal', fileId: 0x0a000001, bytes: bytes(1).buffer as ArrayBuffer }]);
    store.data.delete(ac1999PatchKey('srv', 0x0a000001));
    const w2 = new Ac1999World(preTodDb(102) as never, preTodDb(67) as never);
    expect(await w2.restore(store, 'srv')).toBe(0);
    expect(w2.iterations).toEqual({ portal: 102, cell: 67 });
  });
});
