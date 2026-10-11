/**
 * CORE.1 — the inventory panel matches the retail EoL layout chain
 * (behavioral, real GameUI DOM in happy-dom).
 *
 * Ground truth (2026-08-23, decompiled client + DAT):
 *  - gmInventoryUI (layout 0x21000023) hosts gmPaperDollUI (0x100001cd),
 *    gmBackpackUI (0x100001ce, layout 0x21000022) and gm3DItemsUI
 *    (0x100001cf, layout 0x21000021).
 *  - Every ItemList cell is a UIItem from template layout 0x21000037. The
 *    grid list (el 0x100001c6) uses template 0x1000033a: empty state
 *    (0x1000001c) shows texture 0x06004d20 (dark recessed tile); selection
 *    is the marching-ants overlay 0x06004d09; in-trade the corner badge
 *    0x06001dae. Grid is SIX 32px columns (prop 0x5f=6) with a
 *    "Contents of Backpack" label above (gmInventoryUI::
 *    RecvNotice_NewParentContainer).
 *  - The backpack strip has a "Burden" label (str 0x074464be) + % text +
 *    vertical meter (gradient 0x0600121c under dark cover 0x0600121d,
 *    gmBackpackUI::SetLoadLevel), the main-pack slot (6,32) and SEVEN
 *    side-pack slots (list capacity 7), each 36x36 (template 0x1000033f)
 *    with the open-pack arrow 0x06005d9c on the open pack.
 *  - Paperdoll equip slots each name a per-slot template whose empty state
 *    is a slot pictogram tile (e.g. Neck el 0x100001da → tpl 0x10000446 →
 *    0x06000f68). This REFUTES the prior "EoL slots are blank" reading.
 *  - The panel title is the character's name
 *    (gmInventoryUI::RecvNotice_PlayerDescReceived).
 *  - Layout 0x21000022 has NO pyreal element and 0x21000023 has NO bottom
 *    detail bar — both were inventions and must stay gone.
 *
 * Requires happy-dom (devDep; tests/_harness/dom.ts fails loudly without it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const PLAYER_GUID = 0x50000001;
const PACK_GUID = 0x80001111;

// Fake data URLs injected into uiTextures so cell styling is observable.
const TEX = {
  gridEmpty: 0x06004d20,
  selected: 0x06004d09,
  tradeBadge: 0x06001dae,
  packEmpty: 0x06000f6e,
  openArrow: 0x06005d9c,
  meterGrad: 0x0600121c,
  meterCover: 0x0600121d,
  neckPictogram: 0x06000f68,
  headPictogram: 0x06006d7f,
  // CORE.17.p — both inventory bars derive from the scrollbar widget
  // 0x10000367@0x2100003e (gold-chain track, gem buttons, 3-slice thumb).
  sbTrack: 0x06004c5f,
  sbThumbTop: 0x06004c60,
  sbThumbMid: 0x06004c63,
  sbThumbBot: 0x06004c66,
  sbUp: 0x06004c69,
  sbDown: 0x06004c6c,
  // The 37px red-gem template 0x100002dc — must NOT be used here any more.
  wrongTrack: 0x06004d33,
  wrongThumb: 0x06004d34,
} as const;
const url = (did: number) => `data:image/png;base64,tex${did.toString(16)}`;

describe('CORE.1 — retail inventory panel (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  // Captures the options of the most recent renderPanel call (CORE.1.b
  // asserts the dock position x=500/y=140 and the bumped persist key).
  let lastPanelOptions: Record<string, unknown> = {};

  function stubLayoutRenderer() {
    return {
      renderPanel: (_layoutId: number, container: HTMLElement, options: Record<string, unknown> = {}) => {
        lastPanelOptions = options;
        // Mirror the real renderPanel: root lives inside a positioned
        // wrapper (the element the dock-fit sizes and scales).
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
        const titles = new Map<number, string>();
        return {
          root, elements,
          setText: (id: number, text: string) => { titles.set(id, text); (root as HTMLElement & { titles?: Map<number, string> }).titles = titles; },
          close: () => { wrapper.remove(); },
        };
      },
    };
  }

  function item(id: number, name: string, containerId: number, itemType = 0) {
    return {
      id, weenieClassId: id & 0xffff, name, value: 1, burden: 10,
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
    for (const did of Object.values(TEX)) ui.uiTextures.set(did, url(did));
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    ui.selectedPackSlot = 0;
    ui.hud.setTarget(null);
    ui.inventorySlotsView = false;
    ui.setTradeData({
      yourItems: [], theirItems: [], theirName: '', yourName: '',
      partnerGuid: 0, initiatorGuid: 0, tradeStamp: 0, tradeStatus: 0,
      yourReady: false, theirReady: false,
    });
    ui.setSidePackGuids([PLAYER_GUID, PACK_GUID]);
    ui.setInventoryData(
      [
        item(0x8000aaaa, 'Dagger', PLAYER_GUID),
        item(PACK_GUID, 'Leather Pack', PLAYER_GUID, 0x200),
        item(0x8000bbbb, 'Apple', PACK_GUID),
      ],
      [], 30, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  function strip(): HTMLElement { return ui.inventoryPanelHandle.elements.get(0x100001ce); }
  function packSlots(): HTMLElement[] {
    return ([...strip().children] as HTMLElement[]).filter(
      (c) => c.style.width === '36px' && c.style.height === '36px',
    );
  }
  function gridArea(): HTMLElement { return ui.inventoryPanelHandle.elements.get(0x100001cf); }
  function paperdoll(): HTMLElement { return ui.inventoryPanelHandle.elements.get(0x100001cd); }
  function gridCells(): HTMLElement[] {
    const grid = gridArea().querySelector('div[style*="grid"]') as HTMLElement;
    return [...grid.children] as HTMLElement[];
  }

  it('grid is SIX 32px columns (layout 0x21000021 prop 0x5f=6), not seven', () => {
    const grid = gridArea().querySelector('div[style*="grid"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(6, 32px)');
  });

  it('grid pads with empty tiles to every visible row of the reflowed viewport, empty cells use texture 0x06004d20', () => {
    // CORE.18.e — the panel is the 300x362 body of the EoL panels window
    // (HUD slot 0x100005ff, fixed at its authored size until the player
    // resizes it), so the grid viewport is the authored 96px → 3 visible
    // rows → 18 padding cells (retail-inventory-vendor.png: three rows).
    // CORE.17.o — the OWN main pack is a FIXED list of ItemsCapacity cells
    // (el 0x100001c6 prop 0x10000015 = 102; ItemList_UpdateContainerListSize
    // @ 004e39e0 → UpdateFixedSlots), so 102 cells regardless of the
    // viewport; the visible-area padding applies to side packs.
    const cells = gridCells();
    expect(cells.length).toBe(102);
    // one occupied cell: the Dagger. The Leather Pack is a side pack — it
    // sits in the pack column, not the item grid (BUG.side-packs-in-item-grid:
    // ACCObjectMaint::ViewObjectContents @ 00558a70 keeps _itemsList and
    // _containersList apart; the ItemList shows only the items).
    const empty = cells.filter(c => c.style.backgroundImage.includes(url(TEX.gridEmpty)));
    expect(empty.length).toBe(101);
    ui.selectedPackSlot = 1;
    ui.renderInventoryPanel();
    expect(gridCells().length).toBe(18); // side pack: 96px viewport → 3 rows × 6
  });

  it('shows "Contents of Backpack" above the grid for the main pack', () => {
    expect(gridArea().textContent).toContain('Contents of Backpack');
  });

  it('shows "Contents of <pack name>" when a side pack is open', () => {
    // click the side-pack slot (second element with a tooltip in the strip —
    // CORE.17.k.b.b.a.g: the pack icons carry the DAT tooltip, no native title)
    const packSlots = ([...strip().children] as HTMLElement[]).filter((c) => c.dataset.acTooltipText);
    packSlots[1].click();
    expect(gridArea().textContent).toContain('Contents of Leather Pack');
  });

  it('selected cell gets the marching-ants overlay 0x06004d09 (not a CSS outline)', () => {
    const cells = gridCells();
    // The press selects (UIElement::MouseDown → message 0x1c action 7).
    cells[0].dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const overlay = gridCells()[0].querySelector('[data-slot-state="selected"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.backgroundImage).toContain(url(TEX.selected));
  });

  it('in-trade cell gets the corner badge 0x06001dae and no dim (RECON.inventory-grid-dat-cells); its tooltip stays the bare item name (UIElement_UIItem::UpdateTooltip — no "(in trade)" suffix, no native title)', () => {
    ui.setTradeData({
      yourItems: [{ name: 'Dagger', value: 1, guid: 0x8000aaaa, burden: 10, iconDid: 0 }],
      theirItems: [], theirName: '', yourName: '',
      partnerGuid: 0x50000099, initiatorGuid: 0, tradeStamp: 0, tradeStatus: 0,
      yourReady: false, theirReady: false,
    });
    const cell = gridCells()[0];
    const badge = cell.querySelector('[data-slot-state="trade"]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.style.backgroundImage).toContain(url(TEX.tradeBadge));
    expect(cell.style.opacity).toBe('');
    expect(cell.dataset.acTooltipText).toBe('Dagger');
    expect(cell.getAttribute('title')).toBeNull();
  });

  it('the old chunky CSS bevel is gone from cells', () => {
    for (const cell of gridCells()) {
      expect(cell.style.boxShadow === '' || cell.style.boxShadow === 'none').toBe(true);
    }
  });

  it('backpack strip renders the Burden label, % text and vertical meter (layout 0x21000022)', () => {
    const s = strip();
    expect(s.textContent).toContain('Burden');
    // load = 30/15000 = 0.002 → floor(clamp(load/3)*300) = 0%
    expect(s.textContent).toContain('0%');
    const meter = [...s.querySelectorAll('div')].find(
      (d: HTMLElement) => d.style.backgroundImage.includes(url(TEX.meterGrad)),
    ) as HTMLElement;
    expect(meter).toBeTruthy();
    expect(meter.style.width).toBe('11px');
    expect(meter.style.height).toBe('58px');
    const cover = meter.querySelector('div') as HTMLElement;
    expect(cover.style.backgroundImage).toContain(url(TEX.meterCover));
    expect(cover.style.height).toBe('58px'); // ~zero load → fully covered
  });

  it('burden % text and meter fill track the load (gmBackpackUI::SetLoadLevel)', () => {
    ui.setInventoryData([], [], 22500, 15000); // load 1.5 → 150%
    const s = strip();
    expect(s.textContent).toContain('150%');
    const meter = [...s.querySelectorAll('div')].find(
      (d: HTMLElement) => d.style.backgroundImage.includes(url(TEX.meterGrad)),
    ) as HTMLElement;
    const cover = meter.querySelector('div') as HTMLElement;
    expect(cover.style.height).toBe('29px'); // (1 - 0.5) * 58
  });

  it('strip has the main-pack slot + 7 side-pack rows, 36x36 each', () => {
    const slots = packSlots();
    expect(slots.length).toBe(8);
    expect(slots[0].style.top).toBe('32px');  // main pack (6,32)
    expect(slots[1].style.top).toBe('73px');  // side column starts (6,73)
    expect(slots[7].style.top).toBe(`${73 + 6 * 36}px`);
  });

  it('the open pack shows the arrow 0x06005d9c painted OVER its icon (template 0x1000033f: 0x10000450 reads after the icon 0x10000340 — CORE.18.c); others do not', () => {
    const arrowOf = (slot: HTMLElement) => slot.querySelector('[data-ac-open-pack-arrow]') as HTMLElement | null;
    const slots = packSlots();
    expect(arrowOf(slots[0])!.style.backgroundImage).toContain(url(TEX.openArrow));
    // Over the icon: the arrow is the slot's LAST child, after the 32x32 icon inset.
    expect(slots[0].lastElementChild).toBe(arrowOf(slots[0]));
    expect(slots[0].style.backgroundImage).not.toContain(url(TEX.openArrow));
    expect(arrowOf(slots[1])).toBeNull();
    slots[1].click();
    const after = packSlots();
    expect(arrowOf(after[0])).toBeNull();
    expect(arrowOf(after[1])!.style.backgroundImage).toContain(url(TEX.openArrow));
  });

  it('empty side-pack rows show the empty pack tile 0x06000f6e', () => {
    const slots = packSlots();
    const inset = slots[3].querySelector('div') as HTMLElement; // row with no pack
    expect(inset.style.backgroundImage).toContain(url(TEX.packEmpty));
  });

  it('strip has NO pyreal readout and panel has NO bottom detail bar (both were inventions)', () => {
    expect(strip().textContent).not.toContain('Pyreal');
    ui.selectInventoryItem(ui.inventoryItems[0]);
    ui.renderInventoryPanel();
    const rootText = ui.inventoryPanelHandle.root.textContent ?? '';
    expect(rootText).not.toContain('Val:');
    expect(rootText).not.toContain('Bur:');
  });

  it('panel title is the character name once known (RecvNotice_PlayerDescReceived)', () => {
    ui.setInventoryOwner('Asheron', 0);
    const titles = (ui.inventoryPanelHandle.root as HTMLElement & { titles?: Map<number, string> }).titles;
    // CORE.18.e — L"Inventory of %s" (acclient.exe 0x7aca50, pushed by
    // gmInventoryUI::RecvNotice_PlayerDescReceived @ 004a6bee).
    expect(titles?.get(0x100001d3)).toBe('Inventory of Asheron');
  });

  it('main-pack slot shows the owner icon and carries the owner name as its DAT tooltip (the main pack IS the player)', () => {
    ui.uiTextures.set(0x06005678, url(0x06005678));
    ui.setInventoryOwner('Asheron', 0x06005678);
    const slots = packSlots();
    expect(slots[0].dataset.acTooltipText).toBe('Asheron');
    expect(slots[0].getAttribute('title')).toBeNull();
    // CORE.18.c.a — the pack cell is a UIItem: its icon is the item-icon
    // element (buildItemIconElement, IsThePlayer) inside the 32-px inset.
    const inset = slots[0].querySelector('div') as HTMLElement;
    const icon = inset.firstElementChild as HTMLElement;
    expect(icon.style.backgroundImage).toContain(url(0x06005678));
  });

  it('empty paperdoll equip slots show their per-slot pictogram tiles (e.g. Neck 0x06000f68, Head 0x06006d7f in Slots view)', () => {
    const neck = [...paperdoll().querySelectorAll('div')].find(
      (d: HTMLElement) => d.dataset.equipSlot === 'Neck',
    ) as HTMLElement;
    expect(neck).toBeTruthy();
    expect(neck.style.backgroundImage).toContain(url(TEX.neckPictogram));

    ui.inventorySlotsView = true;
    ui.renderInventoryPanel();
    const head = [...paperdoll().querySelectorAll('div')].find(
      (d: HTMLElement) => d.dataset.equipSlot === 'Head',
    ) as HTMLElement;
    expect(head).toBeTruthy();
    expect(head.style.backgroundImage).toContain(url(TEX.headPictogram));
  });

  /* ── CORE.1.a/b — dock-fit sizing, retail scrollbars, burden text fit ── */

  function scrollbars(parent: HTMLElement): HTMLElement[] {
    return [...parent.querySelectorAll('[data-dat-scrollbar]')] as HTMLElement[];
  }

  it('CORE.18.e — panel opens in the EoL panels window at its default rect: 310x372 right-flush, 100 px above the bottom (HUD slot 0x100005ff L2/T2), body at (5,5) 300x362', () => {
    // 1024x768 → window (1024-310, 768-100-372) = (714, 296).
    expect(lastPanelOptions.x).toBe(714);
    expect(lastPanelOptions.y).toBe(296);
    expect(lastPanelOptions.anchorLeft).toBe(true);
    const wrapper = ui.inventoryPanel as HTMLElement;
    expect(wrapper.style.width).toBe('310px');
    expect(wrapper.style.height).toBe('372px');
    expect(wrapper.style.transform).toBe('');
    const root = ui.inventoryPanelHandle.root as HTMLElement;
    expect(root.style.left).toBe('5px');
    expect(root.style.top).toBe('5px');
    // The window renders as a SUBTREE so the real renderPanel rebases it to
    // (0,0) and exposes resizeSubtree (this file stubs LayoutRenderer; the
    // per-element reflow geometry — rebase, stretched grid/strip/filler,
    // fixed background — is asserted against the REAL renderer + DAT in
    // tests/verify-dock-panel-reflow.ts).
    expect(lastPanelOptions.subtreeElementId).toBe(0x100001cc);
  });

  it('CORE.18.e — the window moves by its frame borders (WindowID 9 rect), not a title drag with a separate localStorage key', () => {
    expect(lastPanelOptions.persistKey).toBeUndefined();
    expect(lastPanelOptions.dragHandleId).toBeUndefined();
  });

  it('grid viewport is the DAT-exact 192px (el 0x100001c6) with the native scrollbar hidden', () => {
    const vp = gridArea().querySelector('.layout-scroll-content') as HTMLElement;
    expect(vp).toBeTruthy();
    expect(vp.style.width).toBe('192px');
    // CORE.18.e — the default panels window body is the authored 362, so
    // the B1-edged list keeps its authored 96 (three rows).
    expect(vp.style.height).toBe('96px');
    expect(vp.style.overflowY).toBe('auto');
    expect(vp.style.scrollbarWidth).toBe('none');
  });

  it('grid scrollbar is the DAT widget 0x10000367@0x2100003e at el 0x100001c7 (207,20) 16x96: gold-chain track 0x06004c5f, gem buttons 0x06004c69/6c, 3-slice thumb 0x06004c60/63/66 (CORE.17.p)', () => {
    const bars = scrollbars(gridArea());
    expect(bars.length).toBe(1);
    const bar = bars[0];
    expect(bar.style.left).toBe('207px');
    expect(bar.style.top).toBe('20px');
    expect(bar.style.width).toBe('16px');
    expect(bar.style.height).toBe('96px'); // CORE.18.e — authored at the default window height
    expect(bar.style.backgroundImage).toContain(url(TEX.sbTrack));
    expect(bar.style.backgroundImage).not.toContain(url(TEX.wrongTrack));
    const pieces = [...bar.children] as HTMLElement[];
    const imgs = pieces.map(p => p.style.backgroundImage);
    expect(imgs.some(i => i.includes(url(TEX.sbUp)))).toBe(true);
    expect(imgs.some(i => i.includes(url(TEX.sbDown)))).toBe(true);
    const thumb = bar.querySelector('[data-dat-thumb]') as HTMLElement;
    expect(thumb).toBeTruthy();
    const slices = ([...thumb.children] as HTMLElement[]).map(s => s.style.backgroundImage);
    expect(slices.some(i => i.includes(url(TEX.sbThumbTop)))).toBe(true);
    expect(slices.some(i => i.includes(url(TEX.sbThumbMid)))).toBe(true);
    expect(slices.some(i => i.includes(url(TEX.sbThumbBot)))).toBe(true);
    expect(bar.innerHTML).not.toContain(url(TEX.wrongThumb));
  });

  it('pack-column scrollbar at el 0x100001cb (41,73) 16x252 hides while the 7-slot list fits (p121 hideDisabled, the widget default — retail shows no bar there)', () => {
    const bars = scrollbars(strip());
    expect(bars.length).toBe(1);
    const bar = bars[0];
    expect(bar.style.left).toBe('41px');
    expect(bar.style.top).toBe('73px');
    // B1-edged (layout 0x21000022): authored 252 at the default 362 body
    // (CORE.18.e); it would stretch with a taller persisted window.
    expect(bar.style.height).toBe('252px');
    // The list frame (0x100001ca) it scrolls sits at (6,73) 36x252 and
    // never overflows — UIElement_Scrollbar::UpdateLayout @ 004710d0
    // hides the whole column when disabled + hideDisabled.
    const frame = strip().querySelector('[data-dat-pack-list]') as HTMLElement;
    expect(frame).toBeTruthy();
    expect(frame.style.left).toBe('6px');
    expect(frame.style.top).toBe('73px');
    expect(frame.style.height).toBe('252px');
    expect(bar.style.display).toBe('none');
    expect(bar.style.backgroundImage).toContain(url(TEX.sbTrack));
  });

  it('burden label + % fit the 36px column (els 0x100001d7/d8, centered small font): oversize text is scaled down to 34px (CORE.1.a)', () => {
    // Fake AC font: 10px per character, so 'Burden' measures 60px (> 34)
    // and must come back scaled to exactly 34px; '0%' measures 20px and
    // must stay unscaled. Drives the real renderInventoryPanel →
    // fitACText → renderACText path.
    const fakeFont = {
      isReady: true,
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: (t: string, _c: string, scale = 1) => {
        const cv = domWindow.document.createElement('canvas');
        cv.width = Math.max(1, Math.ceil(t.length * 10 * scale));
        cv.height = 15;
        return cv;
      },
      renderWrappedTextToCanvas: (t: string, _w: number, _c: string, scale = 1) => {
        const cv = domWindow.document.createElement('canvas');
        cv.width = Math.max(1, Math.ceil(t.length * 10 * scale));
        cv.height = 15;
        return cv;
      },
    };
    const savedFont = ui.fontRenderer;
    try {
      ui.fontRenderer = fakeFont;
      ui.renderInventoryPanel();
      const canvases = [...strip().querySelectorAll('canvas')] as HTMLCanvasElement[];
      // 'Burden' (6 chars → 60px raw) scaled to the 34px usable column
      expect(canvases.some(c => c.width === 34)).toBe(true);
      // '0%' (2 chars → 20px raw) needs no scaling
      expect(canvases.some(c => c.width === 20)).toBe(true);
      // nothing rendered wider than the 36px column
      for (const c of canvases) expect(c.width).toBeLessThanOrEqual(36);
    } finally {
      ui.fontRenderer = savedFont;
      ui.renderInventoryPanel();
    }
  });
});
