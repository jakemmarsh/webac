/**
 * CORE.17.o.c — the external-container panel is retail's layout 0x21000008
 * (gmExternalContainerUI, element class 0x1000000d): an 800x110 strip at
 * (0,400) with the ground container's own UIItem cell (m_topContainer
 * 0x10000064), the nested-container list (m_containerList 0x10000067) with
 * its arrow-pair scroller (0x10000066, template 0x10000070), the close box
 * 0x10000068 (the ONLY element ListenToElementMessage @ 004cbad0 handles),
 * and ONE 32-px item row (m_itemList 0x1000006a, 784x32) with its
 * horizontal bar (0x1000006b, template 0x1000036d @ 0x2100003e). No "Take
 * All": the string does not exist in acclient.exe, the decomp or the
 * symbols.
 *
 * Two halves:
 *  1. The DAT premise through the shipped parser (skipped without the DATs).
 *  2. The shipped GameUI in happy-dom against a stub layout handle: the
 *     panel is rendered on 0x21000008 at (0,400) with the close box as its
 *     close button and no drag handle; no Take All / Loot text; the ground
 *     container's cell carries its name + icon; nested containers are
 *     36-px cells in the list, the open one marked; the item row is a single
 *     row scrolled by the bar / wheel; the row is the drop target; the
 *     CORE.17.o.b sizing rule carries over to the single row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZLayer, zLayer } from '../packages/renderer/src/ui/ZIndexRegistry.js';

const REPO = resolve(__dirname, '..');
const UI_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const HAVE_DATS = existsSync(UI_DAT) && existsSync(PORTAL_DAT);

/* ================================================================ */
/*  1. The DAT premise                                               */
/* ================================================================ */

describe.skipIf(!HAVE_DATS)('CORE.17.o.c — layout 0x21000008 is gmExternalContainerUI\'s strip (DAT)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layout: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<number, any>();

  beforeAll(async () => {
    const mod = await import('../packages/dat-parser/src/index.js');
    const open = (path: string) => {
      const buf = readFileSync(path);
      return new mod.DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    };
    const portal = open(PORTAL_DAT);
    const ui = open(UI_DAT);
    const mp = portal.getFileData(0x39000001);
    if (mp) mod.setMasterPropertyTypes(mod.parseMasterProperty(new mod.DatReader(mp)));
    layout = mod.parseLayoutDesc(new mod.DatReader(ui.getFileData(0x21000008)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (id: number, e: any) => { byId.set(id >>> 0, e); for (const [cid, c] of e.children ?? []) walk(cid, c); };
    for (const [id, e] of layout.elements) walk(id, e);
  });

  it('the top element 0x10000063 is class 0x1000000d (gmExternalContainerUI::Register @ 004cbfe0): 800x110 at (0,400) of 800x600, zLevel 1000, edges L1 T1 R1 B2', () => {
    expect(layout.displayWidth).toBe(800);
    expect(layout.displayHeight).toBe(600);
    const root = byId.get(0x10000063);
    expect(root.type).toBe(0x1000000d);
    expect([root.x, root.y, root.width, root.height]).toEqual([0, 400, 800, 110]);
    expect(root.zLevel).toBe(1000);
    expect([root.leftEdge, root.topEdge, root.rightEdge, root.bottomEdge]).toEqual([1, 1, 1, 2]);
  });

  it('the three UIElement_ItemLists derive from template 0x10000339 @ 0x2100003d: the 36x36 container cell, the 680x36 nested list, the 784x32 item row', () => {
    for (const [id, w, h] of [[0x10000064, 36, 36], [0x10000067, 680, 36], [0x1000006a, 784, 32]] as const) {
      const e = byId.get(id);
      expect(e.baseElement >>> 0).toBe(0x10000339);
      expect(e.baseLayout >>> 0).toBe(0x2100003d);
      expect([e.width, e.height]).toEqual([w, h]);
    }
    // The item row is ONE row: 32 px tall, unlimited columns (p95 = -1);
    // the container cell holds exactly one (0x10000015 = 1, p95 = p96 = 1).
    expect(byId.get(0x1000006a).properties.get(95).valueInt).toBe(-1);
    expect(byId.get(0x10000064).properties.get(0x10000015).valueInt).toBe(1);
  });

  it('the item row\'s bar 0x1000006b is the vendor list\'s horizontal template 0x1000036d @ 0x2100003e; the nested list\'s scroller 0x10000066 is the local arrow-pair template 0x10000070', () => {
    const bar = byId.get(0x1000006b);
    expect(bar.baseElement >>> 0).toBe(0x1000036d);
    expect(bar.baseLayout >>> 0).toBe(0x2100003e);
    expect([bar.width, bar.height]).toEqual([784, 16]);
    const scroller = byId.get(0x10000066);
    expect(scroller.baseElement >>> 0).toBe(0x10000070);
    const tpl = byId.get(0x10000070);
    expect(tpl.type).toBe(11);
    expect([tpl.width, tpl.height]).toEqual([86, 36]);
    // p121 hideDisabled on the arrow pair.
    expect(tpl.properties.get(121).valueBool).toBe(true);
    expect(byId.get(0x10000072).x).toBe(0);
    expect(byId.get(0x10000071).leftEdge).toBe(2);
  });

  it('the close box 0x10000068 (25x23, right-anchored) is the only button — there is no Take All element', () => {
    const close = byId.get(0x10000068);
    expect([close.x, close.y, close.width, close.height]).toEqual([770, 1, 25, 23]);
    expect(close.leftEdge).toBe(2);
    expect(close.baseElement >>> 0).toBe(0x1000047f);
    // Every element under the root, by kind: two lists + a cell, a region
    // pair, the close box, the bordered frame + its rails, the bar — no
    // other button (base 0x1000047f) than the close box.
    const buttons = [...byId.entries()].filter(([id, e]) => (e.baseElement >>> 0) === 0x1000047f && id !== 0x10000071 && id !== 0x10000072);
    expect(buttons.map(([id]) => id)).toEqual([0x10000068]);
  });
});

/* ================================================================ */
/*  2. GameUI behaviour                                              */
/* ================================================================ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'WheelEvent'] as const;

describe('CORE.17.o.c — GameUI renders the container on the 0x21000008 strip (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const CHEST = 0x80004000;
  const POUCH = 0x80004001;
  const SACK = 0x80004002;
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];
  // What the stub layout renderer was asked for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastRender: { layoutId: number; options: any } | null = null;
  const visible = new Map<number, boolean>();
  let resized: Array<[number, number]> = [];
  let stored: number[] = [];
  let taken: number[] = [];
  let closed = 0;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      // CORE.17.k.b.b.c.c.a.a.c.a — the strip renders as the container slot
      // of the transaction dock: render(0x2100006d, host, { subtreeElementId, omitChildIds }).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement, options: any) => {
        lastRender = { layoutId, options };
        const wrapper = domWindow.document.createElement('div');
        parent.appendChild(wrapper);
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        // The bar's inherited children (template 0x1000036d): thumb 0x1, arrows.
        const bar = elements.get(0x1000006b)!;
        for (const cid of ['0x1', '0x1000036c', '0x1000036b']) {
          const c = domWindow.document.createElement('div');
          c.dataset.elementId = cid;
          bar.appendChild(c);
        }
        return {
          root, elements,
          setText: () => {}, setTexture: () => {},
          setInteractive: (id: number, fn?: () => void) => { if (fn) elements.get(id)?.addEventListener('click', fn); },
          setVisible: (id: number, v: boolean) => { visible.set(id, v); },
          resizeSubtree: (w: number, h: number) => { resized.push([w, h]); },
          onClick: () => {},
          destroy: () => { wrapper.remove(); },
        };
      },
    };
    ui.setContainerCallbacks({
      onTakeItem: (guid: number) => { taken.push(guid); },
      onStoreItem: (guid: number) => { stored.push(guid); },
      onClose: () => { closed++; },
    });
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => {
    ui.hideContainerPanel();
    lastRender = null; visible.clear(); resized = []; stored = []; taken = []; closed = 0;
  });

  function panel(): HTMLElement { return ui.containerPanel as HTMLElement; }
  function el(id: number): HTMLElement { return ui.containerPanelHandle.elements.get(id) as HTMLElement; }
  function cells(kind?: 'item' | 'empty'): HTMLElement[] {
    const sel = kind ? `[data-ac-container-cell="${kind}"]` : '[data-ac-container-cell]';
    return [...panel().querySelectorAll(sel)] as HTMLElement[];
  }
  function packCells(): HTMLElement[] { return [...panel().querySelectorAll('[data-ac-container-tab]')] as HTMLElement[]; }
  function item(guid: number, name: string, containerId = CHEST, extra: Record<string, unknown> = {}) {
    return { guid, name, iconDid: 0, stackSize: 1, containerId, isContainer: false, ...extra };
  }
  function click(target: HTMLElement): void { target.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); }
  function dblclick(target: HTMLElement): void { target.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true })); }

  it('CORE.17.k.b.b.c.c.a.a.c.a — renders the transaction dock 0x2100006d:0x100005fb with only its container slot 0x1000005d (based on 0x21000008:0x10000063) instantiated', () => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Wooden Chest', iconDid: 0 });
    expect(lastRender!.layoutId).toBe(0x2100006d);
    const o = lastRender!.options;
    expect(o.subtreeElementId).toBe(0x100005fb);
    // The vendor / salvage / trade / slumlord slots are not instantiated.
    expect([...o.omitChildIds].sort()).toEqual([0x1000005e, 0x1000005f, 0x10000060, 0x10000062]);
    expect(ui.transactionDockPanel).toBe('container');
  });

  it('CORE.17.k.b.b.c.c.a.a.c.a — the host is HUD slot 0x100005fd: 610x120 centred, 80 px above the bottom (not the old (0,400) full-width strip); no resize — the slot is the DAT 600x110', () => {
    ui.showContainerPanel(CHEST, [], -1);
    const s = panel().style;
    expect([s.left, s.marginLeft, s.bottom, s.width, s.height, s.top]).toEqual(['50%', '-305px', '80px', '610px', '120px', '']);
    expect(panel().dataset.dock).toBe('0x2100006d');
    expect(resized).toEqual([]);
    expect(s.zIndex).toBe(String(zLayer(ZLayer.HUD_BOTTOM_BAR)));
  });

  it('no "Take All" and no "Loot" anywhere on the strip', () => {
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], -1, { name: 'Wooden Chest', iconDid: 0 });
    expect(panel().textContent).not.toMatch(/Take All|Loot/);
  });

  it('m_topContainer (0x10000064) holds the ground container\'s own 36x36 cell: its name as the UIItem tooltip, its icon, the open-container marker', () => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Wooden Chest', iconDid: 0x06001cef });
    const top = el(0x10000064);
    const cell = top.firstElementChild as HTMLElement;
    expect(cell.dataset.acContainerTab).toBe(String(CHEST));
    expect(cell.dataset.acTooltipText).toBe('Wooden Chest');
    expect(cell.getAttribute('title')).toBeNull();
    expect([cell.style.width, cell.style.height]).toEqual(['36px', '36px']);
    expect(cell.dataset.acContainerOpen).toBe('1');
  });

  it('nested containers are 36-px cells in m_containerList (0x10000067), in ViewContents order; clicking one re-parents the item row to it (its own capacity), the marker moves', () => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Wooden Chest' });
    ui.setContainerPackGuids([CHEST, POUCH, SACK]);
    ui.updateContainerItems([
      item(POUCH, 'Leather Pouch', CHEST, { isContainer: true, itemsCapacity: 24 }),
      item(SACK, 'Sack', CHEST, { isContainer: true, itemsCapacity: 10 }),
      item(5, 'Emerald', POUCH),
      item(6, 'Ruby', SACK),
    ]);
    const list = el(0x10000067);
    const nested = [...list.querySelectorAll('[data-ac-container-tab]')] as HTMLElement[];
    expect(nested.map((c) => c.dataset.acTooltipText)).toEqual(['Leather Pouch', 'Sack']);
    for (const c of nested) expect([c.style.width, c.style.height]).toEqual(['36px', '36px']);
    // Three cells overall (the ground container's + two nested); only the ground one marked open.
    expect(packCells().filter((c) => c.dataset.acContainerOpen === '1').map((c) => c.dataset.acContainerTab)).toEqual([String(CHEST)]);
    click(nested[1]);
    expect(cells()).toHaveLength(10);
    expect(cells('item')).toHaveLength(1);
    expect(packCells().filter((c) => c.dataset.acContainerOpen === '1').map((c) => c.dataset.acContainerTab)).toEqual([String(SACK)]);
  });

  it('the arrow-pair scroller (0x10000066) is shown only while the nested containers overflow the list; its arrows page the list', () => {
    ui.showContainerPanel(CHEST, [], -1);
    ui.setContainerPackGuids([CHEST, POUCH]);
    ui.updateContainerItems([item(POUCH, 'Leather Pouch', CHEST, { isContainer: true, itemsCapacity: 24 })]);
    expect(visible.get(0x10000066)).toBe(false);
    // CORE.17.k.b.b.c.c.a.a.c.a — 480 px in the 600-wide dock slot (680 − 200) = 13 cells; 25 nested packs overflow.
    const guids = Array.from({ length: 25 }, (_, i) => 0x80005000 + i);
    ui.setContainerPackGuids([CHEST, ...guids]);
    ui.updateContainerItems(guids.map((g, i) => item(g, `Pack ${i}`, CHEST, { isContainer: true, itemsCapacity: 24 })));
    expect(visible.get(0x10000066)).toBe(true);
    const strip = el(0x10000067).querySelector('[data-ac-container-packs]') as HTMLElement;
    expect(strip.style.left).toBe('0px');
    click(el(0x10000071));
    const after = el(0x10000067).querySelector('[data-ac-container-packs]') as HTMLElement;
    expect(after.style.left).toBe('-36px');
    click(el(0x10000072));
    expect((el(0x10000067).querySelector('[data-ac-container-packs]') as HTMLElement).style.left).toBe('0px');
  });

  it('the item list is ONE 32-px row in 0x1000006a: every cell 32x32 in a single flex row', () => {
    ui.showContainerPanel(CHEST, Array.from({ length: 30 }, (_, i) => item(100 + i, `Loot ${i}`)), -1);
    const row = el(0x1000006a).querySelector('[data-ac-container-row]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.style.height).toBe('32px');
    expect(row.style.display).toBe('flex');
    expect(row.style.width).toBe(`${30 * 32}px`);
    expect(row.children).toHaveLength(30);
    for (const c of cells()) expect([c.style.width, c.style.height]).toEqual(['32px', '32px']);
  });

  it('the CORE.17.o.b sizing rule carries over: a fixed capacity is exactly that many cells, -1 pads the row\'s visible cells (18 in the 600-wide dock slot: 584 px)', () => {
    ui.showContainerPanel(CHEST, [item(1, 'Book')], 10);
    expect(cells()).toHaveLength(10);
    expect(cells('empty')).toHaveLength(9);
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], -1);
    expect(cells()).toHaveLength(18);
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], 0);
    expect(cells()).toHaveLength(1);
  });

  it('the bar (0x1000006b) hides while the row fits (p121) and shows when it overflows; its right arrow scrolls one cell, the wheel too', () => {
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], -1);
    expect(visible.get(0x1000006b)).toBe(false);
    ui.showContainerPanel(CHEST, Array.from({ length: 40 }, (_, i) => item(100 + i, `Loot ${i}`)), -1);
    expect(visible.get(0x1000006b)).toBe(true);
    const row = () => el(0x1000006a).querySelector('[data-ac-container-row]') as HTMLElement;
    expect(row().style.left).toBe('0px');
    click(el(0x1000006b).querySelector('[data-element-id="0x1000036b"]') as HTMLElement);
    expect(row().style.left).toBe('-32px');
    el(0x1000006a).dispatchEvent(new domWindow.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(row().style.left).toBe('-64px');
    // The scroll survives an item update (a CreateObject re-render).
    ui.updateContainerItems(Array.from({ length: 40 }, (_, i) => item(100 + i, `Loot ${i}`)));
    expect(row().style.left).toBe('-64px');
    // Never past the end: 40 cells (1280 px) through the 584-px row (784 − 200 in the dock slot) = 696 px of travel.
    for (let i = 0; i < 40; i++) click(el(0x1000006b).querySelector('[data-element-id="0x1000036b"]') as HTMLElement);
    expect(row().style.left).toBe(`${-(40 * 32 - 584)}px`);
  });

  it('the item row is the drop target (OnItemListDragOver → DragItemAcceptable): a dragged inventory item dropped on it is stored', () => {
    ui.showContainerPanel(CHEST, [], -1);
    ui.dragItemIndex = 0;
    ui.dragSourceSlot = null;
    ui.inventoryItems = [{ id: 0x8000aaaa, name: 'Arrow', iconDid: 0, stackSize: 1 }];
    el(0x1000006a).dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
    expect(stored).toEqual([0x8000aaaa]);
  });

  it('double-click takes an item — and a nested pack too (message 10 on a row UIItem is ItemHolder::UseObject); a nested pack OPENS by a single click on its m_containerList cell', () => {
    ui.showContainerPanel(CHEST, [], -1);
    ui.setContainerPackGuids([CHEST, POUCH]);
    ui.updateContainerItems([
      item(7, 'Apple'),
      item(POUCH, 'Leather Pouch', CHEST, { isContainer: true, itemsCapacity: 24 }),
      item(5, 'Emerald', POUCH),
    ]);
    const byName = (n: string) => cells('item').find((c) => c.dataset.acTooltipText?.includes(n))!;
    dblclick(byName('Leather Pouch'));
    expect(taken).toEqual([POUCH]);
    // The row is still the chest's (the double-click did not re-parent it).
    expect(cells()).toHaveLength(18);
    expect(byName('Emerald')).toBeUndefined();
    const nestedCell = el(0x10000067).querySelector('[data-ac-container-tab]') as HTMLElement;
    click(nestedCell);
    expect(byName('Emerald')).toBeTruthy();
    dblclick(byName('Emerald'));
    expect(taken).toEqual([POUCH, 5]);
  });

  it('the close box\'s onClose (0x10000068 → SetVisible(0) → CloseCurrentContainer) reports the close and resets the state', () => {
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], -1, { name: 'Wooden Chest' });
    click(el(0x10000068));
    expect(closed).toBe(1);
    expect(ui.transactionDockPanel).toBeNull();
    expect(ui.isContainerOpen).toBe(false);
    expect(ui.openContainerGuid).toBe(0);
    expect(ui.containerItems).toEqual([]);
  });
});
