/**
 * GAP.42 — Map panel: BEHAVIORAL conversion of the VISUAL.76/.26/.130/.131/.77
 * map-fidelity source-pins.
 *
 * PREMISE CORRECTION: the task asks for 'full-world vs current-landblock
 * vs dungeon as three distinct data-driven modes'. The EoL DAT
 * (verification/panel-specs/map.md) shows NO such thing — the map panel
 * (0x21000027) is a single WORLD map (Dereth texture 0x0600127d + a
 * 'you are here' green-ring marker 0x06004d10 positioned by the map
 * page's calibration rect, no coordinate readout — see VISUAL3.79) plus
 * a HOUSE tab.
 * Retail dungeons had no in-game map at all; there is no landblock mode.
 * The DAT wins per CLAUDE.md.
 *
 * This drives the REAL renderMapPanel + setPlayerMapPosition in happy-dom
 * and asserts the DOM: the two DAT tabs (Map/House), the real map
 * texture, the DAT green-ring marker, and — the real behavior — that the
 * marker MOVES per the DAT calibration rect (x∈[6,247], y∈[8,258] of the
 * 257x267 texture, N-up y inversion) when the player position changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Map/World-panel 0x21000027 element ids renderMapPanel touches (incl. the
// map page's T3/B3-centered content block 0x100001ea from base 0x21000026).
const MAP_IDS = [0x100001f2, 0x100001f3, 0x100001f4, 0x100001f5, 0x100001f6, 0x100001f7, 0x100001ea];

describe('GAP.42 — map panel single world map + tracking marker (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AC_COLORS: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof (g as Record<string, unknown>).requestAnimationFrame !== 'function') {
      (g as Record<string, unknown>).requestAnimationFrame = () => 0;
      (g as Record<string, unknown>).cancelAnimationFrame = () => {};
    }
    // happy-dom's Window has HTMLImageElement but no global Image ctor;
    // renderMapPanel does `new Image()` to preload the DXT map. Shim it.
    if (typeof (g as Record<string, unknown>).Image !== 'function') {
      (g as Record<string, unknown>).Image = domWindow.Image
        ?? function ThisImage(this: Record<string, unknown>) { return domWindow.document.createElement('img'); };
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    AC_COLORS = mod.AC_COLORS;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Seed the map + marker textures so getTexURL resolves them.
    ui.uiTextures.set(0x0600127d, 'fake://dereth-map');
    ui.uiTextures.set(0x06004d10, 'fake://you-are-here');
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of MAP_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, visible: boolean) => {
            const el = elements.get(id);
            if (el) el.style.display = visible ? '' : 'none';
          },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function openMap() {
    if (!ui.mapPanelVisible) ui.toggleMapPanel();
    else ui.renderMapPanel();
  }

  it('renders exactly two DAT tabs (Map + House) — no world/landblock/dungeon modes', () => {
    openMap();
    const tabs = [...ui.mapPanel.querySelectorAll('[data-map-tab]')] as HTMLElement[];
    const labels = tabs.map(t => t.dataset.mapTab);
    expect(labels).toContain('Map');
    expect(labels).toContain('House');
    expect(tabs.length).toBe(2);
  });

  it('renders the map canvas at the DAT texture dimensions (257x267); no sepia chargen map', () => {
    openMap();
    // The map draws via `new Image()` → canvas.drawImage, so the texture
    // URL isn't in the DOM; the canvas carries the DAT native dimensions.
    const canvas = ui.mapCanvas as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.width).toBe(257);
    expect(canvas.height).toBe(267);
  });

  it('renders the DAT green-ring "you are here" marker as an <img>', () => {
    openMap();
    const marker = ui.mapPlayerMarker as HTMLImageElement;
    expect(marker).toBeTruthy();
    expect(marker.src).toContain('you-are-here');
  });

  it('marker MOVES per the DAT marker box (gmMapUI::PlaceMarkerOnMap over p0x1000004e–51) when the cell changes (N-up)', () => {
    openMap();
    // happy-dom never fires Image.onload and canvas.getContext returns null;
    // seed the map image + a no-op 2d context so updateMapMarkers' real
    // placement math executes against the DAT-sized canvas.
    ui.mapImage = domWindow.document.createElement('img');
    ui.mapCanvas.getContext = () => ({ drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillStyle: '' });
    // CORE.17.k.b.b.a.g.d — the feed is the player's landscape cell
    // (0..2039) + outside; two distinct cells (SW-ish vs NE-ish).
    ui.setPlayerMapCell(80, 80, true);
    const atSW = { left: ui.mapPlayerMarker.style.left, top: ui.mapPlayerMarker.style.top };
    ui.setPlayerMapCell(1960, 1960, true);
    const atNE = { left: ui.mapPlayerMarker.style.left, top: ui.mapPlayerMarker.style.top };
    // x grows eastward; y INVERTS (cell 2039 = north = smaller top).
    expect(parseFloat(atNE.left)).toBeGreaterThan(parseFloat(atSW.left));
    expect(parseFloat(atNE.top)).toBeLessThan(parseFloat(atSW.top));
    expect(ui.mapPlayerMarker.style.display).toBe('block');
  });

  // VISUAL3.79 read 0x100001ef ((21,303) 257x20) as never written because
  // reference/images/hud/map-panel.jpg shows the strip blank — that frame is
  // an INDOOR one (no player ring either). CORE.17.k.b.b.a.g.d: gmMapUI::
  // Update @ 004a1eb0 writes sprintf("%.1f%s, %.1f%s") into it while
  // CPlayerSystem::IsOutside and L"" inside (acclient.exe 4a20e0–4a2258).
  it('the coordinate line 0x100001ef reads the player\'s NS / EW outside and is blank inside — as gmMapUI::Update writes it', () => {
    openMap();
    const contentArea = ui.mapCanvas.parentElement as HTMLElement;
    ui.setPlayerMapCell(0xa9 * 8, 0xb4 * 8, false);
    expect(contentArea.textContent ?? '').not.toMatch(/\d+(\.\d+)?[NS],\s*\d+(\.\d+)?[EW]/);
    expect(ui.mapPlayerMarker.style.display).toBe('none');
    ui.setPlayerMapCell(0xa9 * 8, 0xb4 * 8, true);
    const coords = contentArea.querySelector('[data-map-coords]') as HTMLElement;
    expect(coords.dataset.acText).toBe('42.1N, 33.3E');
    expect([coords.style.left, coords.style.top, coords.style.width, coords.style.height]).toEqual(['21px', '303px', '257px', '20px']);
  });

  // CORE.5.d premise corrections: the DAT itself authors the parchment
  // scroll chrome (0x21000019/0x10000116 base subtree: center 0x10000110 →
  // 0x0600126f, torn edges 0x10000117 → 0x06001273 / 0x1000011a →
  // 0x06001270, sides 0x06001271/72 — see the DAT ground-truth suite
  // below), so GameUI must NOT paint an invented pane fill or edge strips
  // on top of it; and the inactive House pane 0x100001f7 (leather
  // 0x06004cc2 on its root via base 0x21000025) must be hidden or it
  // paints dark leather over the whole map pane (live-diagnosed 2026-08-26:
  // the panel rendered near-uniformly dark).
  it('does not paint an invented pane background — the DAT scroll chrome is the fill', () => {
    openMap();
    const pane = ui.mapPanelHandle.elements.get(0x100001f6) as HTMLElement;
    expect(pane.style.backgroundImage).toBe('');
    expect(pane.style.backgroundColor).toBe('');
    const contentArea = ui.mapCanvas.parentElement as HTMLElement;
    expect(contentArea.style.backgroundImage).toBe('');
  });

  it('hides the inactive House pane so its leather never covers the map pane', () => {
    openMap();
    const housePane = ui.mapPanelHandle.elements.get(0x100001f7) as HTMLElement;
    expect(housePane.style.display).toBe('none');
  });

  // CORE.5.d — the custom content is appended INSIDE the DAT block element
  // 0x100001ea ((0,135) 300x330, edges T3/B3 = vertically centered), so the
  // LayoutRenderer's edge reflow centers it in the reflowed pane exactly as
  // retail UIElement::UpdateForParentSizeChange does. The old code pinned a
  // detached div at top:135px reading the authored y as a fixed
  // "radar-showthrough" offset.
  it('content area lives inside the DAT content block 0x100001ea, filling it', () => {
    openMap();
    const block = ui.mapPanelHandle.elements.get(0x100001ea) as HTMLElement;
    const contentArea = ui.mapCanvas.parentElement as HTMLElement;
    expect(contentArea.parentElement).toBe(block);
    expect(contentArea.style.inset).toBe('0');
  });

  it('Date/Time header text is dark ink, not goldLight, on the new light parchment', () => {
    openMap();
    // dtBlock is the content area's first child (appended before the map
    // canvas); font renderer is unavailable in happy-dom, so renderACText
    // falls back to plain <span> elements carrying style.color directly.
    const contentArea = ui.mapCanvas.parentElement as HTMLElement;
    const dtBlock = contentArea.firstElementChild as HTMLElement;
    const spans = [...dtBlock.querySelectorAll('span')] as HTMLElement[];
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.style.color).not.toBe(AC_COLORS.goldLight);
      expect(span.style.color).toBe(AC_COLORS.black);
    }
  });
});

// CORE.5.d — DAT ground truth for the premise corrections: resolve the real
// world-panel layout 0x21000027 through the real base-inheritance resolver
// and pin (a) the parchment scroll chrome the DAT authors on the map pane's
// inherited 0x10000116 subtree (refuting the VISUAL3.76-era "the client
// bakes this chrome in code" claim), and (b) the dock-slot geometry: slot
// 0x1000018c (300x362, L1T1R1B1) bases 0x21000027/0x100001f2 in BOTH the
// classic dock 0x21000017 and the EoL floaty panels window 0x2100006e, and
// the map content block 0x100001ea is T3/B3 (vertically centered).
const HAS_DATS = existsSync(resolve(__dirname, '..', 'dat/client_portal.dat'))
  && existsSync(resolve(__dirname, '..', 'dat/client_local_English.dat'));

describe.skipIf(!HAS_DATS)('CORE.5.d — world panel DAT ground truth', () => {
  let load: (id: number) => import('@ac/dat-parser').LayoutDescData | null;
  let resolved: import('@ac/dat-parser').LayoutDescData;

  function findEl(layout: import('@ac/dat-parser').LayoutDescData, id: number): import('@ac/dat-parser').ElementDesc | null {
    const walk = (el: import('@ac/dat-parser').ElementDesc): import('@ac/dat-parser').ElementDesc | null => {
      if ((el.elementId >>> 0) === id) return el;
      for (const [, c] of el.children) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    for (const [, e] of layout.elements) { const hit = walk(e); if (hit) return hit; }
    return null;
  }

  beforeAll(async () => {
    const dp = await import('@ac/dat-parser');
    const pbuf = readFileSync(resolve(__dirname, '..', 'dat/client_portal.dat'));
    const portal = new dp.DatDatabase(pbuf.buffer.slice(pbuf.byteOffset, pbuf.byteOffset + pbuf.byteLength));
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new dp.DatReader(portal.getFileData(0x39000001)!)));
    const lbuf = readFileSync(resolve(__dirname, '..', 'dat/client_local_English.dat'));
    const lang = new dp.DatDatabase(lbuf.buffer.slice(lbuf.byteOffset, lbuf.byteOffset + lbuf.byteLength));
    const cache = new Map<number, import('@ac/dat-parser').LayoutDescData | null>();
    load = (id: number) => {
      if (cache.has(id)) return cache.get(id)!;
      const data = lang.getFileData(id);
      const parsed = data ? dp.parseLayoutDesc(new dp.DatReader(data)) : null;
      cache.set(id, parsed);
      return parsed;
    };
    resolved = dp.resolveLayoutDesc(load(0x21000027)!, load);
  });

  it('is a dock-body page in BOTH HUD families (slot 0x1000018c, 300x362, L1T1R1B1)', () => {
    for (const hostId of [0x21000017, 0x2100006e]) {
      const host = load(hostId)!;
      const slot = findEl(host, 0x1000018c)!;
      expect(slot, `slot in 0x${hostId.toString(16)}`).toBeTruthy();
      expect(slot.baseLayout >>> 0).toBe(0x21000027);
      expect(slot.baseElement >>> 0).toBe(0x100001f2);
      expect([slot.width, slot.height]).toEqual([300, 362]);
      expect([slot.leftEdge, slot.topEdge, slot.rightEdge, slot.bottomEdge]).toEqual([1, 1, 1, 1]);
    }
  });

  it('the map content block 0x100001ea is T3/B3 (vertically centered), 300x330', () => {
    // Raw (authored) layout: y=135 = (600-330)/2, i.e. centered in the
    // authored 600-tall page — NOT a fixed "radar-showthrough" offset.
    const rawBlock = findEl(load(0x21000026)!, 0x100001ea)!;
    expect(rawBlock.y).toBe(135);
    expect([rawBlock.topEdge, rawBlock.bottomEdge]).toEqual([3, 3]);
    // Resolved into 0x21000027 the incorporation reflow has already
    // re-centered it for the 575-tall pane: (575-330)/2 = 122.
    const block = findEl(resolved, 0x100001ea)!;
    expect(block).toBeTruthy();
    expect([block.topEdge, block.bottomEdge]).toEqual([3, 3]);
    expect([block.width, block.height]).toEqual([300, 330]);
    expect(block.y).toBe(122);
  });

  it('the DAT authors the parchment scroll chrome on the inherited 0x10000116 subtree', () => {
    const expected: Array<[number, number]> = [
      [0x10000110, 0x0600126f], // center parchment tile
      [0x10000117, 0x06001273], // top torn edge
      [0x1000011a, 0x06001270], // bottom torn edge
      [0x10000118, 0x06001271], // left edge
      [0x10000119, 0x06001272], // right edge
    ];
    for (const [elemId, texId] of expected) {
      const el = findEl(resolved, elemId)!;
      expect(el, `0x${elemId.toString(16)}`).toBeTruthy();
      const files = el.media.map((m) => (m.file ?? 0) >>> 0);
      expect(files, `0x${elemId.toString(16)} media`).toContain(texId);
    }
  });

  it('the House pane root resolves the dark leather 0x06004cc2 — hidden-when-inactive is load-bearing', () => {
    const house = findEl(resolved, 0x100001f7)!;
    expect(house).toBeTruthy();
    const files = house.media.map((m) => (m.file ?? 0) >>> 0);
    expect(files).toContain(0x06004cc2);
  });
});

describe('GAP.42 — DAT ground truth (data-driven, retained)', () => {
  const REPO = resolve(__dirname, '..');
  const idxPath = resolve(REPO, 'verification/texture-index.json');
  const idx: Array<{ id: string; w: number; h: number }> | null =
    existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : null;

  it.skipIf(!idx)('0x0600127d is the 257x267 in-game Dereth map', () => {
    const t = idx!.find((x) => x.id === '0x0600127d');
    expect(t).toBeTruthy();
    expect(t!.w).toBe(257);
    expect(t!.h).toBe(267);
  });
});
