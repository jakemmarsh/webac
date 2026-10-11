/**
 * CORE.10.g.a — vendor bar polish (behavioral).
 *
 * Ground truth (decompiled EoL client + DAT layouts + acclient.exe string
 * operands):
 * - Type-filter POPUP: menu element 0x100000bf inherits UIElement_Menu
 *   (type 6) from 0x21000043:0x1000034b. Its popup is DAT-authored, not
 *   free CSS: popup layout p7=0x21000043, root p6=0x1000034f (120 wide,
 *   max height p60=126 = 7 rows), listbox p2=0x10000350 (100 wide), item
 *   rows p9/p10 → template 0x10000352: 100x18, tile 0x60012b3, hover
 *   (state 6) 0x60012b4, NO distinct selected-row art. UIElement_Menu::Open
 *   @ 0046cc30 opens UP (p19), left-aligned with the button.
 * - Quantity overlay: UIElement_UIItem::m_quantity starts -1 (hidden;
 *   ctor @ 004e0f40) and the client's only SetQuantity caller is
 *   VendorItemsUI::UpdateQuantityOverlay @ 004c0cc0 — the SELECTED shop
 *   cell shows the merchandise ItemProfile amount (amount < 1 = unlimited
 *   stays hidden); no other vendor cell ever shows a number. Overlay text
 *   element 0x100004f5 (template 0x21000037): right-justified, bottom,
 *   3px right margin.
 * - Host: the EoL client never draws root 0x100000b7 at its authored
 *   (0,500) — the HUD's transaction dock 0x2100006d hosts it in slot
 *   0x10000062 (CORE.17.k.b.b.c.c.a.a.c.a; the old bottom:-10 overhang
 *   premise is superseded).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const EL = {
  root: 0x100000b7,
  filterMenu: 0x100000bf, filterText: 0x1000034d,
  itemsList: 0x100000bd, itemsScroll: 0x100000be,
  buyList: 0x100000c5, buyScroll: 0x100000c6,
  tabBuying: 0x100000ba, tabItems: 0x100000b9, tabSelling: 0x100000bb,
  pageItems: 0x100000bc, pageBuying: 0x100000c4, pageSelling: 0x100000cd,
  itemsAdd: 0x100000c3,
} as const;

describe('CORE.10.g.a — vendor bar polish (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const texts = new Map<number, string>();

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of Object.values(EL)) {
          const el = domWindow.document.createElement('div');
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, descs: new Map(),
          setText: (id: number, text: string) => { texts.set(id, text); },
          setState: () => {}, setVisible: () => {}, setFill: () => {}, setPalette: () => {},
          setInteractive: (id: number, fn?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && fn) el.addEventListener('click', () => fn(id, el));
          },
        };
      },
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => { texts.clear(); });

  // Armor, Weapons, Food present → 3-entry filter menu; the arrow stack is
  // limited supply (100), the cap unlimited (-1), the pie a single (1).
  const MERCH = [
    { guid: 0x83000001, weenieClassId: 100, name: 'Leather Cap', price: 50, burden: 50, itemType: 0x2, stackSize: -1 },
    { guid: 0x83000002, weenieClassId: 101, name: 'Arrow', pluralName: 'Arrows', price: 100, burden: 5, itemType: 0x100, stackSize: 100 },
    { guid: 0x83000003, weenieClassId: 102, name: 'Meat Pie', price: 10, burden: 10, itemType: 0x20, stackSize: 1 },
  ];
  let nextGuid = 0x701a0001;
  const openVendor = () =>
    ui.showVendorWindow('Aluvian Provisioner', MERCH, [], '1.25', '0.75', undefined, undefined, nextGuid++);

  const cells = (listId: number): HTMLElement[] => {
    const listEl = ui.vendorLayoutHandle.elements.get(listId) as HTMLElement;
    const strip = listEl.children[0] as HTMLElement;
    // CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — the view is padded with EMPTY tiles; items only.
    return strip ? ([...strip.querySelectorAll('[data-item-cell]')] as HTMLElement[]) : [];
  };
  const qtyOverlay = (cell: HTMLElement): HTMLElement | null => {
    for (const child of [...cell.children] as HTMLElement[]) {
      if (child.style.position === 'absolute' && child.style.right === '3px') return child;
    }
    return null;
  };
  const openPopup = (): HTMLElement | null => {
    ui.vendorLayoutHandle.elements.get(EL.filterMenu).click();
    // The popup is the host child positioned above the button: the button's
    // top is at bar y 24, the bar at the dock slot's (5,5) in the 120-tall
    // host (CORE.17.k.b.b.c.c.a.a.c.a) — bottom 120 − 29 = 91 px, left 5 + 4.
    const wrapper = ui.vendorWrapper as HTMLElement;
    for (const child of [...wrapper.children] as HTMLElement[]) {
      if (child.style.bottom === '91px' && child.style.left === '9px') return child;
    }
    return null;
  };

  it('CORE.17.k.b.b.c.c.a.a.c.a — the bar sits in the transaction dock (HUD slot 0x100005fd: 610x120 centred, 80 px above the bottom), not at the authored y=500 overhang (bottom:-10)', () => {
    openVendor();
    const s = (ui.vendorWrapper as HTMLElement).style;
    expect([s.left, s.marginLeft, s.bottom, s.width, s.height]).toEqual(['50%', '-305px', '80px', '610px', '120px']);
    expect(ui.transactionDockPanel).toBe('vendor');
  });

  const listOf = (popup: HTMLElement): HTMLElement => popup.querySelector('[data-vendor-filter-list]') as HTMLElement;

  it('filter popup uses the DAT menu chrome: 120px wide, sized to its rows (p60 caps it at 7), 100x18 rows, no CSS border', () => {
    openVendor();
    const popup = openPopup();
    expect(popup).not.toBeNull();
    expect(popup!.style.width).toBe('120px'); // root 0x1000034f
    expect(popup!.style.height).toBe('54px'); // 3 rows of 18 (p60 = 126 = 7 rows at most)
    expect(popup!.style.border).toBe(''); // rows carry the chrome, not the box
    const rows = [...listOf(popup!).children] as HTMLElement[];
    expect(rows.length).toBe(3); // Armor, Food, Weapons present in MERCH
    for (const row of rows) {
      expect(row.style.width).toBe('100px'); // listbox/item template width
      expect(row.style.height).toBe('18px'); // item template 0x10000352
    }
    // Retail authors NO selected-row art (ListBox state 2 falls back to the
    // default tile) — every row renders identically, selected included.
    const bgs = new Set(rows.map(r =>
      `${r.style.background}|${r.style.backgroundImage}|${r.style.backgroundColor}`));
    expect(bgs.size).toBe(1);
  });

  it('clicking a popup row selects that category and closes the popup', () => {
    openVendor();
    const popup = openPopup()!;
    (listOf(popup).children[2] as HTMLElement).click(); // "Weapons" (retail order: Armor, Food, Weapons)
    expect(ui.vendorData.filterMenuOpen).toBe(false);
    expect(texts.get(EL.filterText)).toBe('Weapons');
  });

  // More than 7 categories: the listbox 0x10000350 scrolls under its p114 bar
  // 0x10000351 (16 px at x=100). The old addPanelScrollbar path moved the rows
  // into an absolute inner box and the popup collapsed to 0 px: invisible.
  it('more than 7 categories: a 7-row (126 px) list beside the DAT scrollbar 0x10000351, never collapsed', () => {
    const TYPES = [0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800];
    const many = TYPES.map((t, i) => ({ guid: 0x83100000 + i, weenieClassId: 200 + i, name: `Thing ${i}`, price: 5, burden: 1, itemType: t, stackSize: -1 }));
    ui.showVendorWindow('Bazaar', many, [], '1', '1', undefined, undefined, nextGuid++);
    const popup = openPopup()!;
    const list = listOf(popup);
    expect(list.children.length).toBeGreaterThan(7);
    expect(popup.style.height).toBe('126px');
    expect(list.style.height).toBe('126px');
    expect(list.style.width).toBe('100px');
    expect(list.style.getPropertyValue('scrollbar-width')).toBe('none');
    const bar = popup.querySelector('[data-vendor-filter-scrollbar]') as HTMLElement;
    expect(bar.style.left).toBe('100px');
    expect(bar.style.width).toBe('16px');
    expect(bar.style.height).toBe('126px');
    expect(popup.style.position).toBe('absolute');
    ui.vendorData.filterMenuOpen = false;
  });

  it('only the SELECTED shop cell shows a quantity, and only for a limited (>= 1) amount', () => {
    openVendor();
    // Weapons category → the Arrow stack (amount 100).
    ui.vendorData.typeFilterIdx = 2;
    ui.renderVendorPanel();
    let strip = cells(EL.itemsList);
    expect(strip.length).toBe(1);
    expect(qtyOverlay(strip[0])).toBeNull(); // unselected → no number
    strip[0].click();
    strip = cells(EL.itemsList);
    const overlay = qtyOverlay(strip[0]);
    expect(overlay).not.toBeNull(); // selected + amount 100 → overlay
    expect(overlay!.textContent).toBe('100');
  });

  it('an unlimited-supply (amount -1) selection keeps the overlay hidden', () => {
    openVendor(); // filter 0 = Armor → Leather Cap (stackSize -1)
    let strip = cells(EL.itemsList);
    strip[0].click();
    strip = cells(EL.itemsList);
    expect(qtyOverlay(strip[0])).toBeNull();
  });

  it('Buying-tab cells never show quantity numbers (no SetQuantity caller for them in retail)', () => {
    openVendor();
    ui.vendorData.typeFilterIdx = 2; // Weapons → Arrow stack
    ui.renderVendorPanel();
    cells(EL.itemsList)[0].click();
    ui.vendorLayoutHandle.elements.get(EL.itemsAdd).click();
    ui.vendorLayoutHandle.elements.get(EL.tabBuying).click();
    const buyCells = cells(EL.buyList);
    expect(buyCells.length).toBe(1);
    expect(qtyOverlay(buyCells[0])).toBeNull();
  });
});
