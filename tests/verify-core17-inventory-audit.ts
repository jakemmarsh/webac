/**
 * CORE.17.l / .m / .n / .o / .p — the 2026-09-07 gestalt scene audit's five
 * inventory findings, re-judged against the EoL DAT + decompiled client.
 * Three were WRONG-ERA / wrong-premise (judged against the ToD-era
 * inventory-panel.jpg / aetheria-slots.jpg), two were real. This suite
 * pins the ground truth so the wrong-premise items cannot be re-filed and
 * the real fixes cannot regress.
 *
 * - CORE.17.l "slot frames/pictograms steel-blue instead of retail gold":
 *   WRONG-ERA. Every paperdoll slot element in layout 0x21000024 derives
 *   from 0x100001e4 → ItemList 0x10000339, and names its own UIItem
 *   template (prop 0x1000000e) in layout 0x21000037, whose icon child
 *   0x1000033b shows a per-slot tile in the EMPTY state 0x1000001c
 *   (UIElement_ItemList::ItemList_AddEmptySlot @ 004e36b0 → UIItem_SetState
 *   (0x1000001c)). Those portal.dat tiles ARE blue-grey — the frame bevel
 *   and pictogram are baked into the texture, nothing is tinted. Same rule
 *   as the toolbar (docs/era-determination.md "Toolbar art is also
 *   era-bound", tests/verify-core17c-toolbar-button-art.ts).
 * - CORE.17.n "occupied slots drop their frame": WRONG-PREMISE for EoL.
 *   The templates carry NO frame element: the empty tile is the icon
 *   element's own state media, and UIElement_UIItem::UIItem_SetIcon @
 *   004e2080 does UIRegion::ClearImage + SetImage(weenie icon) on that same
 *   element — the item icon REPLACES the tile. Children 0x1000045a
 *   (m_elem_Icon_DragAccept) / 0x1000033c (m_elem_Icon_Overlays) have no
 *   media (UIElement_UIItem::PostInit @ 004e1870).
 * - CORE.17.o "grid renders ~9 rows, the DAT specifies 3": WRONG-PREMISE.
 *   96px is the AUTHORED viewport; el 0x100001c6 is edged L1T1R1B1 inside
 *   0x100001c4 (L1T1R1B1) inside 0x100001cf (L1T1R1B1) in the docked
 *   window, so the list stretches with the dock slot — and it always
 *   holds ItemsCapacity fixed cells (prop 0x10000015 = 102;
 *   ItemList_UpdateContainerListSize @ 004e39e0 → UpdateFixedSlots). More
 *   visible rows at a taller dock is retail. What WAS wrong: we padded to
 *   the visible area instead of 102 cells — fixed here.
 * - CORE.17.p "scrollbars are 5px black tracks with a red diamond": REAL.
 *   Both bars (0x100001c7, 0x100001cb) derive from the scrollbar widget
 *   0x10000367@0x2100003e (gold chain / gem buttons / blue 3-slice thumb),
 *   not the 37px template 0x100002dc we drew. Fixed: bindDatScrollbarWidget.
 * - CORE.17.m "paperdoll decapitated": REAL — see
 *   tests/verify-inventory-paperdoll-center.ts (retail camera).
 *
 * happy-dom block drives the real GameUI.renderInventoryPanel; the DAT
 * block reads the real layouts/textures (loads in beforeAll — the
 * describe body runs at collection time even when skipped).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const PLAYER_GUID = 0x50000001;
const PACK_GUID = 0x80001111;

const SCROLLBAR_WIDGET = { layout: 0x2100003e, element: 0x10000367 };
const WIDGET_TRACK = 0x06004c5f;
const WIDGET_UP = 0x06004c69;
const WIDGET_DOWN = 0x06004c6c;
const WIDGET_THUMB = [0x06004c60, 0x06004c63, 0x06004c66];
const GRID_EMPTY_TILE = 0x06004d20;
const EMPTY_STATE = 0x1000001c;

/** Paperdoll slot element → UIItem template → empty-state tile (layout 0x21000037). */
const FLANK_SLOT_TILES: Array<{ el: number; tpl: number; tex: number; label: string }> = [
  { el: 0x100001da, tpl: 0x10000446, tex: 0x06000f68, label: 'Neck' },
  { el: 0x1000058e, tpl: 0x1000058f, tex: 0x06006a6c, label: 'Trinket' },
  { el: 0x100001dd, tpl: 0x10000449, tex: 0x06000f6a, label: 'Right Bracelet' },
  { el: 0x100001de, tpl: 0x1000044a, tex: 0x06000f6b, label: 'Right Ring' },
  { el: 0x100001e1, tpl: 0x1000044d, tex: 0x06000f6c, label: 'Shield' },
  { el: 0x100005e9, tpl: 0x100005ea, tex: 0x0600708f, label: 'Cloak' },
  { el: 0x100001e2, tpl: 0x1000044e, tex: 0x060032c5, label: 'Shirt' },
  { el: 0x100001e3, tpl: 0x1000044f, tex: 0x060032c4, label: 'Pants' },
  { el: 0x100001db, tpl: 0x10000447, tex: 0x06000f5d, label: 'Left Bracelet' },
  { el: 0x100001dc, tpl: 0x10000448, tex: 0x06000f5a, label: 'Left Ring' },
  { el: 0x100001df, tpl: 0x1000044b, tex: 0x06000f66, label: 'Weapon' },
  { el: 0x100001e0, tpl: 0x1000044c, tex: 0x06000f5e, label: 'Ammunition' },
];

const url = (did: number) => `data:image/png;base64,tex${did.toString(16)}`;

describe('CORE.17.l/.n/.o/.p — inventory panel behaviour (real GameUI in happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  function stubLayoutRenderer() {
    return {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const wrapper = domWindow.document.createElement('div');
        container.appendChild(wrapper);
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { wrapper.remove(); } };
      },
    };
  }

  function item(id: number, name: string, containerId: number, itemType = 0, iconDid = 0) {
    return {
      id, weenieClassId: id & 0xffff, name, value: 1, burden: 10, iconDid,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId, itemType,
    };
  }

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
    for (const did of [WIDGET_TRACK, WIDGET_UP, WIDGET_DOWN, ...WIDGET_THUMB, GRID_EMPTY_TILE, 0x06000f6e, 0x06005d9c, 0x0600121c, 0x0600121d, 0x06001234]) {
      ui.uiTextures.set(did, url(did));
    }
    for (const s of FLANK_SLOT_TILES) ui.uiTextures.set(s.tex, url(s.tex));
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    ui.selectedPackSlot = 0;
    ui.hud.setTarget(null);
    ui.inventorySlotsView = false;
    ui.setSidePackGuids([PLAYER_GUID, PACK_GUID]);
    ui.setInventoryData(
      [item(0x8000aaaa, 'Dagger', PLAYER_GUID, 0, 0x06001234), item(PACK_GUID, 'Leather Pack', PLAYER_GUID, 0x200), item(0x8000bbbb, 'Apple', PACK_GUID)],
      [{ id: 0x8000cccc, name: 'Wand', slot: 0x1000000 /* Held */, iconDid: 0x06001234, stackSize: 1 }],
      30, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  const gridArea = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cf);
  const strip = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001ce);
  const paperdoll = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cd);
  const gridCells = (): HTMLElement[] => [...(gridArea().querySelector('div[style*="grid"]') as HTMLElement).children] as HTMLElement[];
  const slotByTitle = (t: string): HTMLElement =>
    [...paperdoll().querySelectorAll('div')].find((d: HTMLElement) => d.dataset.equipSlot === t) as HTMLElement;

  /* ── CORE.17.l ── */
  it('paperdoll slots paint their DAT empty-state tiles as-is — no CSS tint, filter, border or box-shadow (the blue is the texture)', () => {
    for (const s of FLANK_SLOT_TILES) {
      if (s.label === 'Weapon') continue; // occupied by the Wand in this fixture (covered below)
      const el = slotByTitle(s.label);
      expect(el, s.label).toBeTruthy();
      expect(el.style.backgroundImage).toContain(url(s.tex));
      expect(el.style.filter || '').toBe('');
      expect(el.style.backgroundColor || '').toBe('');
      // No drawn frame: styleSlotTile clears border/box-shadow ('none').
      expect(/solid|double|dashed|dotted|ridge|groove|inset|outset/.test(el.style.border)).toBe(false);
      expect(/px/.test(el.style.boxShadow)).toBe(false);
    }
  });

  /* ── CORE.17.n ── */
  it('an occupied equip slot shows the item icon with NO tile behind it (UIItem_SetIcon replaces the icon element image)', () => {
    const wand = slotByTitle('Weapon');
    expect(wand).toBeTruthy();
    // CORE.17.k.b.b.a.g — gmPaperDollUI::UpdateItemSlotTooltip: the occupied
    // slot's tooltip is the worn item's name (no native title box).
    expect(wand.dataset.acTooltipText).toBe('Wand');
    expect(wand.getAttribute('title')).toBeNull();
    expect(wand.style.backgroundImage || '').toBe('');
    const icon = wand.querySelector('div') as HTMLElement;
    expect(icon.style.backgroundImage).toContain(url(0x06001234));
  });

  it('an occupied grid cell has no empty tile behind the icon; empty cells do', () => {
    const cells = gridCells();
    expect(cells[0].style.backgroundImage || '').not.toContain(url(GRID_EMPTY_TILE)); // Dagger
    expect(cells[5].style.backgroundImage).toContain(url(GRID_EMPTY_TILE));
  });

  /* ── CORE.17.o ── */
  it('the main pack grid holds ItemsCapacity fixed cells — 102 by default (17 rows of six), not just the visible rows', () => {
    expect(gridCells().length).toBe(102);
  });

  it('ItemsCapacity from the player desc resizes the fixed cell count (Inventory Space augmentation)', () => {
    ui.setInventoryData([item(0x8000aaaa, 'Dagger', PLAYER_GUID)], [], 30, 15000, 120);
    expect(gridCells().length).toBe(120);
    ui.setInventoryData([item(0x8000aaaa, 'Dagger', PLAYER_GUID)], [], 30, 15000, 102);
    expect(gridCells().length).toBe(102);
  });

  it('a side pack whose capacity is unknown to the item (not Openable) keeps the visible-area padding rather than the player capacity', () => {
    ui.selectedPackSlot = 1;
    ui.renderInventoryPanel();
    // The default panels-window body keeps the authored 96px viewport →
    // 3 rows → 18 cells (CORE.18.e: retail never stretches the window to
    // the screen).
    expect(gridCells().length).toBe(18);
  });

  /* ── CORE.17.o.a ── */
  it('an openable side pack is a FIXED grid of its own ItemsCapacity cells (ACE packs: 24 = four rows), not the visible-area padding', () => {
    ui.setInventoryData(
      [item(0x8000aaaa, 'Dagger', PLAYER_GUID, 0, 0x06001234), { ...item(PACK_GUID, 'Leather Pack', PLAYER_GUID, 0x200), itemsCapacity: 24 }, item(0x8000bbbb, 'Apple', PACK_GUID)],
      [], 30, 15000,
    );
    ui.selectedPackSlot = 1;
    ui.renderInventoryPanel();
    expect(gridCells().length).toBe(24);
  });

  /* ── CORE.17.p ── */
  it('the grid bar is the live widget: once the 102-cell list overflows the 262px viewport the column shows with a proportional thumb; it hides when the list fits', () => {
    const bar = gridArea().querySelector('[data-dat-scrollbar]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.backgroundImage).toContain(url(WIDGET_TRACK));
    const kids = [...bar.children] as HTMLElement[];
    expect(kids.some(k => k.style.backgroundImage.includes(url(WIDGET_UP)))).toBe(true);
    expect(kids.some(k => k.style.backgroundImage.includes(url(WIDGET_DOWN)))).toBe(true);
    const thumb = bar.querySelector('[data-dat-thumb]') as HTMLElement;
    expect(thumb).toBeTruthy();
    // happy-dom has no layout (scrollHeight = clientHeight = 0 → "fits" →
    // hidden, the p121 default). Give the viewport the geometry the
    // browser lays out (17 rows × 32 = 544 content in a 262 viewport) and
    // let the scroll listener re-sync: the column shows and the thumb is
    // floor(262/544 × (262 − 2×16)) = 110px (UpdateLayout @ 004710d0).
    const vp = gridArea().querySelector('.layout-scroll-content') as HTMLElement;
    expect(bar.style.display).toBe('none');
    Object.defineProperty(vp, 'scrollHeight', { configurable: true, get: () => 544 });
    Object.defineProperty(vp, 'clientHeight', { configurable: true, get: () => 262 });
    Object.defineProperty(bar, 'clientHeight', { configurable: true, get: () => 262 });
    vp.dispatchEvent(new domWindow.Event('scroll'));
    expect(bar.style.display).toBe('');
    expect(thumb.style.height).toBe('110px');
    expect(thumb.style.top).toBe('16px'); // scrollTop 0 → parked under the up button
  });

  it('the pack column bar is built against the 7-slot list frame and hidden while it fits', () => {
    const bar = strip().querySelector('[data-dat-scrollbar]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.display).toBe('none');
  });

  it('no inventory scrollbar uses the 37px red-gem template art (0x06004d33/34/35/36)', () => {
    for (const did of [0x06004d33, 0x06004d34, 0x06004d35, 0x06004d36]) ui.uiTextures.set(did, url(did));
    ui.renderInventoryPanel();
    const html = (ui.inventoryPanelHandle.root as HTMLElement).innerHTML;
    for (const did of [0x06004d33, 0x06004d34, 0x06004d35, 0x06004d36]) expect(html).not.toContain(url(did));
  });

  /* ── CORE.17.m plumbing ── */
  it('setInventoryOwner carries the heritage the paperdoll camera table keys on', () => {
    ui.setInventoryOwner('Asheron', 0, 8);
    expect(ui.paperdollHeritage).toBe(8);
  });
});

describe.skipIf(!hasDats)('CORE.17.l/.n/.o/.p — DAT ground truth (layouts 0x21000021/22/23/24/37 + portal tiles)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let datMod: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loadLayout: (id: number) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: (id: number) => any;
  let decode: (did: number) => { width: number; height: number; data: Uint8Array };

  beforeAll(async () => {
    datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = new Map<number, any>();
    loadLayout = (id: number) => {
      if (!cache.has(id)) {
        const data = langDb.getFileData(id);
        cache.set(id, data ? datMod.parseLayoutDesc(new datMod.DatReader(data)) : null);
      }
      return cache.get(id);
    };
    resolved = (id: number) => datMod.resolveLayoutDesc(loadLayout(id), loadLayout);
    decode = (did: number) => {
      const tex = datMod.Texture.read(new datMod.DatReader(portalDb.getFileData(did)!));
      return tex.toRGBA()!;
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const findEl = (el: any, id: number): any => {
    if (el.elementId === id) return el;
    for (const c of el.children.values()) { const f = findEl(c, id); if (f) return f; }
    return null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stateFiles = (el: any, stateId: number): number[] =>
    [...(el.states.get(stateId)?.media ?? [])].map((m: { file?: number }) => m.file).filter((f: number | undefined): f is number => f != null).map(f => f >>> 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const propInt = (el: any, id: number): number | undefined => el.properties.get(id)?.valueInt;

  /* ── CORE.17.p ── */
  it('both inventory scrollbars derive from the scrollbar widget 0x10000367@0x2100003e, not the 37px template 0x100002dc', () => {
    const grid = loadLayout(0x21000021).elements.get(0x100001c4);
    const bar = findEl(grid, 0x100001c7);
    expect([bar.baseLayout >>> 0, bar.baseElement >>> 0]).toEqual([SCROLLBAR_WIDGET.layout, SCROLLBAR_WIDGET.element]);
    expect([bar.x, bar.y, bar.width, bar.height]).toEqual([207, 20, 16, 96]);
    const strip = loadLayout(0x21000022).elements.get(0x100001c8);
    const packBar = findEl(strip, 0x100001cb);
    expect([packBar.baseLayout >>> 0, packBar.baseElement >>> 0]).toEqual([SCROLLBAR_WIDGET.layout, SCROLLBAR_WIDGET.element]);
    expect([packBar.x, packBar.y, packBar.width, packBar.height]).toEqual([41, 73, 16, 252]);
    // Neither desc overrides p121 (hideDisabled) — the widget default holds.
    expect(bar.properties.has(0x79)).toBe(false);
    expect(packBar.properties.has(0x79)).toBe(false);
  });

  it('the resolved widget is element class 11 (UIElement_Scrollbar) carrying the gold-chain track 0x06004c5f, gem buttons and the 3-slice blue thumb', () => {
    const full = resolved(0x21000021);
    const bar = findEl(full.elements.get(0x100001c4), 0x100001c7);
    expect(bar.type).toBe(11);
    const files = new Set<number>(bar.media.map((m: { file?: number }) => (m.file ?? -1) >>> 0));
    expect(files.has(WIDGET_TRACK)).toBe(true);
    const thumb = bar.children.get(1) ?? [...bar.children.values()].find((c: { elementId: number }) => c.elementId === 1);
    expect(thumb).toBeTruthy();
    const thumbFiles: number[] = [];
    for (const c of thumb.children.values()) thumbFiles.push(...stateFiles(c, 1));
    expect(thumbFiles.sort((a, b) => a - b)).toEqual([...WIDGET_THUMB].sort((a, b) => a - b));
    const allFiles: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (el: any) => { for (const st of el.states.values()) allFiles.push(...stateFiles(el, st.stateId)); for (const c of el.children.values()) walk(c); };
    walk(bar);
    expect(allFiles).toContain(WIDGET_UP);
    expect(allFiles).toContain(WIDGET_DOWN);
    for (const wrong of [0x06004d33, 0x06004d34, 0x06004d35, 0x06004d36]) expect(allFiles).not.toContain(wrong);
  });

  /* ── CORE.17.o ── */
  it('the item list 0x100001c6 is L1T1R1B1 all the way up to the docked window (it stretches) and authors ItemsCapacity 102 fixed cells', () => {
    const grid = loadLayout(0x21000021).elements.get(0x100001c4);
    const list = findEl(grid, 0x100001c6);
    expect([list.leftEdge, list.topEdge, list.rightEdge, list.bottomEdge]).toEqual([1, 1, 1, 1]);
    expect([grid.leftEdge, grid.topEdge, grid.rightEdge, grid.bottomEdge]).toEqual([1, 1, 1, 1]);
    expect([list.width, list.height]).toEqual([192, 96]);
    expect(propInt(list, 0x10000015)).toBe(102);
    expect(propInt(list, 0x5f)).toBe(6); // columns
    const win = loadLayout(0x21000023).elements.get(0x100001cc);
    const gridHost = findEl(win, 0x100001cf);
    expect([gridHost.leftEdge, gridHost.topEdge, gridHost.rightEdge, gridHost.bottomEdge]).toEqual([1, 1, 1, 1]);
    expect([win.leftEdge, win.topEdge, win.rightEdge, win.bottomEdge]).toEqual([2, 1, 1, 1]);
  });

  /* ── CORE.17.n ── */
  it('the UIItem templates carry NO frame element: the empty tile is the icon child 0x1000033b\'s state-0x1000001c media and nothing else has media', () => {
    const tpl = loadLayout(0x21000037);
    for (const { tpl: id, tex } of [{ tpl: 0x1000033a, tex: GRID_EMPTY_TILE }, ...FLANK_SLOT_TILES]) {
      const t = tpl.elements.get(id);
      expect(t, `template 0x${id.toString(16)}`).toBeTruthy();
      const icon = findEl(t, 0x1000033b);
      expect(stateFiles(icon, EMPTY_STATE)).toEqual([tex]);
      expect(icon.media.length).toBe(0);
      for (const c of t.children.values()) {
        if (c.elementId === 0x1000033b) continue;
        expect(c.media.length, `child 0x${c.elementId.toString(16)} of 0x${id.toString(16)}`).toBe(0);
        for (const st of c.states.values()) expect(stateFiles(c, st.stateId)).toEqual([]);
      }
    }
  });

  it('each paperdoll slot element names its own UIItem template via prop 0x1000000e', () => {
    const doll = loadLayout(0x21000024).elements.get(0x100001d4);
    for (const s of FLANK_SLOT_TILES) {
      const el = findEl(doll, s.el);
      expect(el, s.label).toBeTruthy();
      const p = el.properties.get(0x1000000e);
      expect(p, `${s.label} prop 0x1000000e`).toBeTruthy();
      const val = (p.valueEnum ?? p.valueInt ?? p.valueDataFile) >>> 0;
      expect(val).toBe(s.tpl);
    }
  });

  /* ── CORE.17.l ── */
  it('the EoL slot tiles are the BLUE-GREY family: every pictogram tile is blue-dominant (mean B exceeds mean R over opaque pixels) — gold/tan is the ToD-era art', () => {
    for (const s of [...FLANK_SLOT_TILES, { tex: 0x06006d7f, label: 'Head (Slots view)' }]) {
      const px = decode(s.tex);
      expect([px.width, px.height]).toEqual([32, 32]);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < px.data.length; i += 4) {
        if (px.data[i + 3] < 32) continue;
        r += px.data[i]; g += px.data[i + 1]; b += px.data[i + 2]; n++;
      }
      expect(n).toBeGreaterThan(200);
      expect(b / n, `${s.label} 0x${s.tex.toString(16)} mean B > mean R`).toBeGreaterThan(r / n + 15);
      expect(b / n, `${s.label} mean B >= mean G`).toBeGreaterThanOrEqual(g / n);
    }
  });
});
