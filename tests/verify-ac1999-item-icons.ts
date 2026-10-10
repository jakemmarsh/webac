/**
 * Item icons on a 1999 world (era ac1999-retail; docs/ac1999-support.md
 * Gotchas). A 1999 0x06 icon is bare RGB (Textures1999.ts): pure black is its
 * transparent key, and the end-of-retail art of the same icon has alpha 0 at
 * exactly those pixels. Read opaque, every 1999 item drew as a black square
 * over IconData::RenderIcons' ITEM_TYPE backdrop. GameUI keys the icons it
 * reads from a 1999 world portal (ItemIconComposite.keyBlackTransparent);
 * every other era reads its icons untouched.
 *
 * Unit + the real GameUI in happy-dom with stub DATs (CI); the real-DAT case
 * skips without dat-sets/ac1999-retail and loads in beforeAll.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  keyBlackTransparent, worldIconsBlackKeyed, renderIcons, type IconRgba,
} from '../packages/renderer/src/ui/ItemIconComposite.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay, AC1999_OVERLAY_KIND } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** A 2x1 icon: pure black, then a dark red. */
const icon2 = (): IconRgba => ({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 40, 0, 0, 255]) });
const solid = (w: number, h: number, rgb: [number, number, number]): IconRgba => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { width: w, height: h, data };
};

describe('keyBlackTransparent / worldIconsBlackKeyed', () => {
  it('pure black becomes alpha 0, every other pixel is kept; the source is not touched', () => {
    const src = icon2();
    const out = keyBlackTransparent(src);
    expect([...out.data]).toEqual([0, 0, 0, 0, 40, 0, 0, 255]);
    expect([...src.data]).toEqual([0, 0, 0, 255, 40, 0, 0, 255]);
  });

  it('only a 1999 world portal (the pre-ToD file, or any DAT wearing the 1999 overlay) is black-keyed', () => {
    expect(worldIconsBlackKeyed({ container: 'tod', overlayKind: AC1999_OVERLAY_KIND })).toBe(true);
    expect(worldIconsBlackKeyed({ container: 'pre-tod', overlayKind: null })).toBe(true);
    expect(worldIconsBlackKeyed({ container: 'tod', overlayKind: null })).toBe(false);
    expect(worldIconsBlackKeyed(null)).toBe(false);
  });

  it('a keyed 1999 icon shows the ITEM_TYPE backdrop where it was black (RenderIcons), an unkeyed one hides it', () => {
    const bg = solid(2, 1, [0, 0, 200]);
    const keyed = renderIcons({ icon: keyBlackTransparent(icon2()), overlay: null, underlay: null, background: bg, effects: null });
    expect([...keyed.icon.data.slice(0, 4)]).toEqual([0, 0, 200, 255]);
    expect([...keyed.icon.data.slice(4, 8)]).toEqual([40, 0, 0, 255]);
    const raw = renderIcons({ icon: icon2(), overlay: null, underlay: null, background: bg, effects: null });
    expect([...raw.icon.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

/** A DAT holding no files, with the overlay kind a 1999 world (or not) carries. */
function emptyDb(overlayKind: string | null) {
  return {
    overlayKind, container: 'tod', masterMapId: 0x27000000, totalIterations: 1,
    getFileData: (): ArrayBuffer | null => null,
    hasFile: () => false,
    getReader: (): never => { throw new Error('no file'); },
    listFileIds: () => [] as number[],
  };
}

/** A texture source whose every icon is icon2(), recording which call decoded it. */
function iconTm() {
  const calls: string[] = [];
  return {
    calls,
    getIconRGBA(id: number) { calls.push(`rgba:${id.toString(16)}`); return icon2(); },
    getIconDataURL(id: number) { calls.push(`url:${id.toString(16)}`); return `data:image/png;id,${id}`; },
    getJPEGDataURL() { return null; },
    getTextureDataURL() { return null; },
  };
}

describe('GameUI reads a 1999 world\'s icons black-keyed, every other era\'s untouched (happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (worldOverlay: string | null): { gui: any; worldTm: ReturnType<typeof iconTm> } => {
    const worldTm = iconTm();
    const c = domWindow.document.createElement('div');
    const gui = new mod.GameUI(c, {}, emptyDb(worldOverlay), worldTm, undefined, undefined, null, null, undefined,
      worldOverlay ? { portalDb: emptyDb(null), textureManager: iconTm() } : null);
    return { gui, worldTm };
  };

  it('1999: the compositor\'s icon / overlay / underlay pixels come keyed from the world textures', () => {
    const { gui, worldTm } = make(AC1999_OVERLAY_KIND);
    worldTm.calls.length = 0;
    const px = gui.worldIconRGBA(0x060010c6) as IconRgba;
    expect([...px.data]).toEqual([0, 0, 0, 0, 40, 0, 0, 255]);
    expect(worldTm.calls).toEqual(['rgba:60010c6']);
  });

  it('1999: a bare item icon (getItemIconURL) is decoded and keyed, not served opaque by getIconDataURL', () => {
    const { gui, worldTm } = make(AC1999_OVERLAY_KIND);
    worldTm.calls.length = 0;
    gui.getItemIconURL(0x06001036);
    expect(worldTm.calls).toEqual(['rgba:6001036']);
  });

  it('end of retail / classic (one portal, no overlay): pixels and the bare-icon path unchanged', () => {
    const { gui, worldTm } = make(null);
    worldTm.calls.length = 0;
    const px = gui.worldIconRGBA(0x060010c6) as IconRgba;
    expect([...px.data]).toEqual([0, 0, 0, 255, 40, 0, 0, 255]);
    gui.itemIconCache.clear();
    worldTm.calls.length = 0;
    expect(gui.getItemIconURL(0x06001036)).toBe(`data:image/png;id,${0x06001036}`);
    expect(worldTm.calls).toEqual(['url:6001036']);
  });
});

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');
const HAVE_DATS = existsSync(PORTAL_1999) && existsSync(DAT_PATHS.portal);

describe.skipIf(!HAVE_DATS)('real 1999 icons: keyed, they match the end-of-retail alpha', () => {
  let tm1999: TextureManager;
  let tmEol: TextureManager;
  let world: DatDatabase;
  let eol: DatDatabase;
  beforeAll(() => {
    world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    eol = openDat(DAT_PATHS.portal);
    tm1999 = new TextureManager(world);
    tmEol = new TextureManager(eol);
  });

  it('only the 1999 world portal is black-keyed', () => {
    expect(worldIconsBlackKeyed(world)).toBe(true);
    expect(worldIconsBlackKeyed(eol)).toBe(false);
  });

  // The AC1999 world's most common item icons (WeenieDefaults Icon counts) and the throwing dagger.
  it.each([0x060010c6, 0x06001066, 0x0600106b, 0x060012d3, 0x06001036, 0x06001317, 0x06001020])('%i: opaque on black raw, the EoL alpha once keyed', (id) => {
    const raw = tm1999.getIconRGBA(id)!;
    const ref = tmEol.getIconRGBA(id)!;
    expect([raw.width, raw.height]).toEqual([32, 32]);
    let opaque = 0;
    for (let i = 3; i < raw.data.length; i += 4) if (raw.data[i] === 255) opaque++;
    expect(opaque).toBe(32 * 32);
    const keyed = keyBlackTransparent(raw);
    for (let i = 0; i < keyed.data.length; i += 4) {
      expect(keyed.data[i + 3] === 0, `pixel ${i / 4}`).toBe(ref.data[i + 3] === 0);
    }
  });
});
