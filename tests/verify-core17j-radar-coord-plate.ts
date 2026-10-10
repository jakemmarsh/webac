/**
 * CORE.17.j — the radar coordinate strip's backing plate.
 *
 * DAT: EoL floaty radar layout 0x21000074 (root 0x100006d3, 120x140) authors
 * the combined-coords strip 0x1000003e at (0,120) 120x18 with media
 * 0x06004cc0 — a 48x48 A8R8G8B8 tile that is pure black at a constant
 * alpha of 105/255 (0.41). That translucent band IS the retail "plate":
 * over Holtburg's ground in the EoL client (docs/images/retail-client-
 * wine-inworld-holtburg.png) the strip measures 0.61 of the luminance of
 * the ground directly beneath it; over a black night sky the same band is
 * invisible in retail and in ours alike (the 2026-09-07 scene audit judged
 * world-night.png, which is how the "no backing plate" finding arose).
 *
 * Behavior pinned here:
 *  - #radar-coord paints the DAT media itself when the texture is loaded,
 *    with NO colour behind it (a colour behind a 41% tile would double-
 *    darken to ~65% — buildTexBgStyle's backgroundColor path must not fire).
 *  - with the texture unavailable it falls back to the same 41% black.
 *  - loadChargenTextures() requests 0x06004cc0 from the TextureManager, so
 *    the live client paints the DAT tile rather than the CSS fallback.
 *  - DAT ground truth (skipped in CI): the tile's dimensions and pixels.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const HAS_DAT = existsSync(PORTAL_DAT) && existsSync(LOCAL_DAT);

const COORD_PLATE_TILE = 0x06004cc0;
const PLATE_ALPHA = 105; // 0x69 — 0.41 of 255
const FAKE_URL = 'data:image/png;base64,PLATE06004cc0';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.j — #radar-coord backing plate (happy-dom, real GameUI)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  function makeUI(withTexture: boolean) {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    if (withTexture) ui.uiTextures.set(COORD_PLATE_TILE, FAKE_URL);
    ui.showGame();
    return { ui, container, coord: container.querySelector('#radar-coord') as HTMLElement };
  }

  it('paints DAT media 0x06004cc0 as the strip background when the texture is loaded', () => {
    const { coord } = makeUI(true);
    expect(coord).toBeTruthy();
    expect(coord.style.backgroundImage).toContain(FAKE_URL);
    // The tile is stretched over the whole 120x18 strip element.
    expect(coord.style.backgroundSize).toBe('120px 18px');
  });

  it('puts NO colour behind the translucent tile (no double-darkening of the 41% plate)', () => {
    const { coord } = makeUI(true);
    expect(coord.style.backgroundColor).toBe('');
  });

  it('falls back to the tile\'s own value — black at 0.41 — when the texture is unavailable', () => {
    const { coord } = makeUI(false);
    expect(coord.style.backgroundImage).not.toContain('url(');
    const bg = coord.style.background || coord.style.backgroundColor;
    const m = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/.exec(bg);
    expect(m, `fallback background was "${bg}"`).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(PLATE_ALPHA / 255, 2);
  });

  it('loadChargenTextures() requests 0x06004cc0 from the TextureManager', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    const requested = new Set<number>();
    ui.textureManager = {
      getIconRGBA: (id: number) => { requested.add(id); return { width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) }; },
      getIconDataURL: (id: number) => `data:image/png;base64,tex${id.toString(16)}`,
      getJPEGDataURL: () => null,
    };
    ui.loadChargenTextures();
    expect(requested.has(COORD_PLATE_TILE)).toBe(true);
    expect(ui.uiTextures.get(COORD_PLATE_TILE)).toBe(`data:image/png;base64,tex${COORD_PLATE_TILE.toString(16)}`);
  });
});

/* ── DAT ground truth (skipped in CI — no dat/) ───────────────────────── */

describe.skipIf(!HAS_DAT)('CORE.17.j — DAT ground truth for the plate tile 0x06004cc0', () => {
  let tile: { width: number; height: number; data: Uint8Array };
  let strip: { x: number; y: number; w: number; h: number; media: number[] } | null = null;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } = await import(
      '../packages/dat-parser/src/file-types/LayoutDesc.js'
    );
    const open = (path: string) => {
      return openDat(path);
    };
    const portalDb = open(PORTAL_DAT);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    const tex = Texture.read(new DatReader(portalDb.getFileData(COORD_PLATE_TILE)!));
    const rgba = tex.toRGBA();
    tile = { width: rgba.width, height: rgba.height, data: rgba.data };

    // Layouts live in client_local_English.dat; elements are id → element Maps.
    const uiDb = open(LOCAL_DAT);
    const layout = parseLayoutDesc(new DatReader(uiDb.getFileData(0x21000074)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findElem = (map: Map<number, any>, id: number): any => {
      for (const [eid, el] of map) {
        if (eid === id) return el;
        const sub = el.children ? findElem(el.children, id) : null;
        if (sub) return sub;
      }
      return null;
    };
    const el = findElem(layout.elements, 0x1000003e);
    if (el) {
      strip = {
        x: el.x, y: el.y, w: el.width, h: el.height,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        media: (el.media ?? []).map((m: any) => m.file),
      };
    }
  });

  it('is a 48x48 tile, pure black at a constant alpha of 105/255 (0.41)', () => {
    expect(tile.width).toBe(48);
    expect(tile.height).toBe(48);
    for (let i = 0; i < tile.data.length; i += 4) {
      expect(tile.data[i]).toBe(0);
      expect(tile.data[i + 1]).toBe(0);
      expect(tile.data[i + 2]).toBe(0);
      expect(tile.data[i + 3]).toBe(PLATE_ALPHA);
    }
  });

  it('layout 0x21000074 authors strip 0x1000003e at (0,120) 120x18 with that tile as its media', () => {
    expect(strip, 'strip element 0x1000003e not found in 0x21000074').toBeTruthy();
    expect([strip!.x, strip!.y, strip!.w, strip!.h]).toEqual([0, 120, 120, 18]);
    expect(strip!.media).toContain(COORD_PLATE_TILE);
  });
});
