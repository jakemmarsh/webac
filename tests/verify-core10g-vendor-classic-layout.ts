/**
 * CORE.10.g — vendor bar rebuilt on the REAL classic_vendor layout
 * (LayoutDesc 0x21000012, subtree 0x100000b7, 800x110 — hosted in the
 * transaction dock's vendor slot since CORE.17.k.b.b.c.c.a.a.c.a).
 *
 * Ground truth (decompiled EoL client, build ac1_sep13):
 * - gmVendorUI::PostInit @ 004c09a0: three sub-UIs on a UIElement_Panel
 *   (0x100000b8) — VendorItemsUI (page 0x100000bc: shop list 0x100000bd,
 *   type-filter menu 0x100000bf, name/cost lines 0x100000c0/c1, Buy
 *   0x100000c2, Add to List 0x100000c3), VendorBuyUI (page 0x100000c4:
 *   buy list 0x100000c5, value/purse lines 0x100000c7/c8, Buy Item/
 *   Buy All/Clear Item/Clear List 0x100000c9-cc), VendorSellUI (page
 *   0x100000cd: sell list 0x100000ce, lines 0x100000d0/d1, buttons
 *   0x100000d2-d5).
 * - Tabs 0x100000b9/ba/bb ("Items"/"Buying"/"Selling", StringTable
 *   0x23000001 ids 84714627/257717255/97250503); UIElement_Panel::Update
 *   @ 0046bd00 sets state 0xc on the selected tab, 0xb on the rest.
 * - VendorItemsUI::OpenVendor @ 004c16d0: the filter menu only lists
 *   categories present in the merchandise (literal names + ITEM_TYPE
 *   masks, "Armor" 0x2 first), preserves the selected index across
 *   refreshes (clamped), and the shop list shows exactly ONE category.
 * - gmVendorUI::UpdateDragOver @ 004c03b0: dragging an item over the bar
 *   opens the Selling tab; VendorSellUI::AcceptDragObject queues the drop
 *   on the sell list (GetObjectSplitSize amount) — covered in
 *   verify-container-vendor-drop.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const EL = {
  tabItems: 0x100000b9, tabBuying: 0x100000ba, tabSelling: 0x100000bb,
  pageItems: 0x100000bc, pageBuying: 0x100000c4, pageSelling: 0x100000cd,
  close: 0x100000d6, filterMenu: 0x100000bf, filterText: 0x1000034d,
  itemsName: 0x100000c0, itemsCost: 0x100000c1, itemsList: 0x100000bd, itemsScroll: 0x100000be,
  itemsBuy: 0x100000c2, itemsAdd: 0x100000c3,
  buyList: 0x100000c5, buyScroll: 0x100000c6, buyValue: 0x100000c7, buyPurse: 0x100000c8,
  buyItem: 0x100000c9, buyAll: 0x100000ca, buyClearItem: 0x100000cb, buyClearList: 0x100000cc,
  sellList: 0x100000ce, sellScroll: 0x100000cf, sellValue: 0x100000d0, sellPurse: 0x100000d1,
  sellItem: 0x100000d2, sellAll: 0x100000d3, sellClearItem: 0x100000d4, sellClearList: 0x100000d5,
  root: 0x100000b7,
} as const;

describe('CORE.10.g — classic_vendor bar (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const texts = new Map<number, string>();
  const states = new Map<number, number>();
  const visible = new Map<number, boolean>();
  let bought: Array<{ guid: number; amount: number }> = [];
  let buyLists: Array<Array<{ guid: number; amount: number }>> = [];
  let sellLists: Array<Array<{ guid: number; amount: number }>> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement, opts?: { subtreeElementId?: number; omitChildIds?: number[] }) => {
        // CORE.17.k.b.b.c.c.a.a.c.a — the bar is the vendor slot 0x10000062
        // (based on 0x21000012:0x100000b7) of the transaction dock
        // 0x2100006d:0x100005fb, the other four slots not instantiated.
        expect(_layoutId).toBe(0x2100006d);
        expect(opts?.subtreeElementId).toBe(0x100005fb);
        expect([...(opts?.omitChildIds ?? [])].sort()).toEqual([0x1000005d, 0x1000005e, 0x1000005f, 0x10000060]);
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
          setState: (id: number, s: number) => { states.set(id, s); },
          setVisible: (id: number, v: boolean) => { visible.set(id, v); },
          setFill: () => {}, setPalette: () => {},
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

  beforeEach(() => {
    texts.clear(); states.clear(); visible.clear();
    bought = []; buyLists = []; sellLists = [];
    ui.setVendorCallbacks({
      onBuy: (guid: number, amount: number) => { bought.push({ guid, amount }); },
      onBuyList: (items: Array<{ guid: number; amount: number }>) => { buyLists.push(items); },
      onSellList: (items: Array<{ guid: number; amount: number }>) => { sellLists.push(items); },
    });
  });

  const MERCH = [
    { guid: 0x81000001, weenieClassId: 100, name: 'Leather Cap', price: 50, burden: 50, itemType: 0x2 },
    { guid: 0x81000002, weenieClassId: 101, name: 'Iron Dagger', price: 120, burden: 90, itemType: 0x1 },
    { guid: 0x81000003, weenieClassId: 102, name: 'Chainmail Greaves', price: 300, burden: 400, itemType: 0x2 },
  ];
  // Fresh guid per open by default: a NEW vendor starts on the Items tab
  // with filter index 0 (a same-vendor refresh keeps tab + filter, like
  // retail's persistent gmVendorUI instance — pass an explicit guid to
  // exercise that path).
  let nextGuid = 0x70140001;
  const openVendor = (guid?: number) => {
    // RECON.vendor-price-formulas — the Buy pre-check reads the purse; give
    // the fixture player money (the refusal itself is tested below).
    ui.hud.coinValue = 100000;
    ui.showVendorWindow('Aluvian Armorer', MERCH, [], '1.25', '0.75', undefined, undefined, guid ?? nextGuid++);
  };

  const cells = (listId: number): HTMLElement[] => {
    const listEl = ui.vendorLayoutHandle.elements.get(listId) as HTMLElement;
    const strip = listEl.children[0] as HTMLElement;
    // CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — the view is padded with EMPTY tiles; items only.
    return strip ? ([...strip.querySelectorAll('[data-item-cell]')] as HTMLElement[]) : [];
  };

  it('opens on the Items tab: selected tab state 0xc, others 0xb, only the Items page visible', () => {
    openVendor();
    expect(states.get(EL.tabItems)).toBe(0xc);
    expect(states.get(EL.tabBuying)).toBe(0xb);
    expect(states.get(EL.tabSelling)).toBe(0xb);
    expect(visible.get(EL.pageItems)).toBe(true);
    expect(visible.get(EL.pageBuying)).toBe(false);
    expect(visible.get(EL.pageSelling)).toBe(false);
  });

  it('filter menu lists only categories present in the merchandise, retail order — Armor first, and the shop strip shows ONE category', () => {
    openVendor();
    // Armor (0x2) precedes Weapons (0x101) in the retail table; the dagger
    // (0x1 ∈ 0x101) files under Weapons.
    expect(texts.get(EL.filterText)).toBe('Armor');
    expect(cells(EL.itemsList).length).toBe(2); // both armor pieces, no dagger
  });

  it('clicking the filter menu opens the category popup; picking Weapons re-filters the strip', () => {
    openVendor();
    ui.vendorLayoutHandle.elements.get(EL.filterMenu).click();
    // Popup is the last child of the wrapper; rows are the category names.
    const popup = ui.vendorWrapper.lastChild as HTMLElement;
    const rows = [...popup.children] as HTMLElement[];
    expect(rows.length).toBe(2); // Armor + Weapons only
    rows[1].click(); // Weapons
    expect(texts.get(EL.filterText)).toBe('Weapons');
    expect(cells(EL.itemsList).length).toBe(1);
  });

  it('the filter index survives a same-vendor refresh (clamped) and resets for a new vendor', () => {
    const guid = 0x70147777;
    openVendor(guid);
    ui.vendorData.typeFilterIdx = 1; // Weapons
    openVendor(guid); // same guid → preserved
    expect(ui.vendorData.typeFilterIdx).toBe(1);
    openVendor(); // different vendor → reset
    expect(ui.vendorData.typeFilterIdx).toBe(0);
  });

  it('selecting a shop item fills the name/cost lines and Buy buys it immediately (BuySingleItem)', () => {
    openVendor();
    cells(EL.itemsList)[0].click();
    expect(texts.get(EL.itemsName)).toBe('Leather Cap');
    // CORE.10.g.a — retail cost line "%s %hsp (you have %hsp)" ("costs"
    // for split < 2), recovered from acclient.exe @ 004c3b50.
    expect(texts.get(EL.itemsCost)).toMatch(/^costs 50p \(you have [\d,]+p\)$/);
    ui.vendorLayoutHandle.elements.get(EL.itemsBuy).click();
    expect(bought).toEqual([{ guid: 0x81000001, amount: 1 }]);
  });

  it('Add to List queues the item; the Buying tab sums the transaction value; Buy All sends ONE list', () => {
    openVendor();
    cells(EL.itemsList)[0].click();
    ui.vendorLayoutHandle.elements.get(EL.itemsAdd).click();
    cells(EL.itemsList)[1].click();
    ui.vendorLayoutHandle.elements.get(EL.itemsAdd).click();
    expect(ui.vendorData.buyList).toEqual([
      { guid: 0x81000001, qty: 1 }, { guid: 0x81000003, qty: 1 },
    ]);
    ui.vendorLayoutHandle.elements.get(EL.tabBuying).click();
    expect(states.get(EL.tabBuying)).toBe(0xc);
    expect(visible.get(EL.pageBuying)).toBe(true);
    expect(cells(EL.buyList).length).toBe(2);
    // CORE.10.g.a — retail "Buying %d %s worth %hsp" (@ 004c329c), count =
    // sum of queued stack amounts; 50 + 300 = 350 pyreals.
    expect(texts.get(EL.buyValue)).toBe('Buying 2 items worth 350p');
    ui.vendorLayoutHandle.elements.get(EL.buyAll).click();
    expect(buyLists).toEqual([[
      { guid: 0x81000001, amount: 1 }, { guid: 0x81000003, amount: 1 },
    ]]);
    expect(ui.vendorData.buyList).toEqual([]);
  });

  it('RECON.vendor-price-formulas — Buy refuses client-side like gmVendorUI: "You don\'t have enough money" when the purse is short, "You must empty some slots in your backpack first" when the main pack is full; nothing is sent', () => {
    const errors: string[] = [];
    const realErr = ui.displayErrorText;
    ui.displayErrorText = (t: string) => { errors.push(t); };
    try {
      openVendor();
      ui.hud.coinValue = 10; // the Leather Cap costs 50
      cells(EL.itemsList)[0].click();
      ui.vendorLayoutHandle.elements.get(EL.itemsBuy).click();
      expect(errors.at(-1)).toBe("You don't have enough money");
      expect(bought).toEqual([]);
      // Money enough, but a main pack with no free item slot.
      ui.hud.coinValue = 100000;
      ui.inventoryItemsCapacity = 1;
      ui.playerGuid = 0x50000001;
      ui.inventoryItems = [{ id: 0x80000001, name: 'Rock', containerId: 0x50000001, stackSize: 1 }];
      ui.vendorLayoutHandle.elements.get(EL.itemsBuy).click();
      expect(errors.at(-1)).toBe('You must empty some slots in your backpack first');
      expect(bought).toEqual([]);
    } finally {
      ui.displayErrorText = realErr;
      ui.inventoryItemsCapacity = 102;
      ui.inventoryItems = [];
    }
  });

  it('Clear Item removes the selected buy-list entry; Clear List empties it — nothing is bought', () => {
    openVendor();
    cells(EL.itemsList)[0].click();
    ui.vendorLayoutHandle.elements.get(EL.itemsAdd).click();
    cells(EL.itemsList)[1].click();
    ui.vendorLayoutHandle.elements.get(EL.itemsAdd).click();
    ui.vendorLayoutHandle.elements.get(EL.tabBuying).click();
    cells(EL.buyList)[0].click(); // select first entry
    ui.vendorLayoutHandle.elements.get(EL.buyClearItem).click();
    expect(ui.vendorData.buyList).toEqual([{ guid: 0x81000003, qty: 1 }]);
    ui.vendorLayoutHandle.elements.get(EL.buyClearList).click();
    expect(ui.vendorData.buyList).toEqual([]);
    expect(bought).toEqual([]);
    expect(buyLists).toEqual([]);
  });

  it('the sell-state set (Icon_SellState badge) follows the sell list and repaints the pack grid on every change (VendorItemSetSellState / FlushSellListSellState)', () => {
    let repaints = 0;
    const realRender = ui.renderInventoryPanel;
    const realVis = ui.inventoryVisible;
    ui.inventoryVisible = true;
    ui.inventoryPanel = ui.inventoryPanel ?? domWindow.document.createElement('div');
    ui.renderInventoryPanel = () => { repaints++; };
    try {
      ui.showVendorWindow('Aluvian Armorer', [], [
        { guid: 0x82000001, weenieClassId: 200, name: 'Loot A', price: 10, burden: 1, stackSize: 1 },
        { guid: 0x82000002, weenieClassId: 201, name: 'Loot B', price: 20, burden: 1, stackSize: 5 },
      ], '1.25', '0.75', undefined, undefined, 0x70140003);
      const before = repaints;
      ui.addVendorSellListItem(0x82000001, 1);
      expect([...ui.sellStateGuids()]).toEqual([0x82000001]);
      expect(repaints).toBeGreaterThan(before);
      ui.addVendorSellListItem(0x82000002, 5);
      expect([...ui.sellStateGuids()].sort()).toEqual([0x82000001, 0x82000002]);
      const n = repaints;
      ui.hideVendorWindow();
      expect([...ui.sellStateGuids()]).toEqual([]);   // closing flushes every sell state
      expect(repaints).toBeGreaterThan(n);
    } finally {
      ui.renderInventoryPanel = realRender;
      ui.inventoryVisible = realVis;
    }
  });

  it('each sell-list cell is a UIItem of template 0x1000033a and carries its object\'s sell-state badge 0x10000437 (UIItem_Update)', () => {
    ui.showVendorWindow('Aluvian Armorer', [], [
      { guid: 0x82000001, weenieClassId: 200, name: 'Loot A', price: 10, burden: 1, stackSize: 1 },
      { guid: 0x82000002, weenieClassId: 201, name: 'Loot B', price: 20, burden: 1, stackSize: 5 },
    ], '1.25', '0.75', undefined, undefined, 0x70140003);
    ui.addVendorSellListItem(0x82000001, 1);
    ui.addVendorSellListItem(0x82000002, 5);
    const listed = cells(EL.sellList);
    expect(listed.length).toBe(2);
    for (const cell of listed) {
      const badges = cell.querySelectorAll(':scope > [data-sell-state]');
      expect(badges.length).toBe(1);
      const badge = badges[0] as HTMLElement;
      expect(badge.style.width).toBe('32px');
      expect(badge.style.pointerEvents).toBe('none');
    }
    // The empty padding tiles are UIItems with no object: no badge.
    const strip = (ui.vendorLayoutHandle.elements.get(EL.sellList) as HTMLElement).children[0] as HTMLElement;
    for (const empty of strip.querySelectorAll('[data-item-cell-empty]')) {
      expect(empty.querySelector('[data-sell-state]')).toBeNull();
    }
    // The merchandise strip shows the vendor's objects, never sell-state.
    ui.vendorData.tab = 0;
    ui.renderVendorPanel();
    expect(ui.vendorLayoutHandle.elements.get(EL.itemsList)?.querySelector('[data-sell-state]') ?? null).toBeNull();
    ui.hideVendorWindow();
  });

  it('Sell All sends the whole sell list as ONE list message', () => {
    ui.showVendorWindow('Aluvian Armorer', [], [
      { guid: 0x82000001, weenieClassId: 200, name: 'Loot A', price: 10, burden: 1, stackSize: 1 },
      { guid: 0x82000002, weenieClassId: 201, name: 'Loot B', price: 20, burden: 1, stackSize: 5 },
    ], '1.25', '0.75', undefined, undefined, 0x70140002);
    ui.addVendorSellListItem(0x82000001, 1);
    ui.addVendorSellListItem(0x82000002, 5);
    expect(ui.vendorData.tab).toBe(2);
    expect(cells(EL.sellList).length).toBe(2);
    ui.vendorLayoutHandle.elements.get(EL.sellAll).click();
    expect(sellLists).toEqual([[
      { guid: 0x82000001, amount: 1 }, { guid: 0x82000002, amount: 5 },
    ]]);
    expect(ui.vendorData.sellList).toEqual([]);
  });

  it('updateVendorSellItems prunes sold/vanished entries and clamps qty to the fresh stack', () => {
    ui.showVendorWindow('Aluvian Armorer', [], [
      { guid: 0x82000003, weenieClassId: 202, name: 'Stack', price: 5, burden: 1, stackSize: 10 },
      { guid: 0x82000004, weenieClassId: 203, name: 'Gone', price: 5, burden: 1, stackSize: 1 },
    ], '1.25', '0.75', undefined, undefined, 0x70140003);
    ui.addVendorSellListItem(0x82000003, 10);
    ui.addVendorSellListItem(0x82000004, 1);
    ui.updateVendorSellItems([
      { guid: 0x82000003, weenieClassId: 202, name: 'Stack', price: 5, burden: 1, stackSize: 4 },
    ]);
    expect(ui.vendorData.sellList).toEqual([{ guid: 0x82000003, qty: 4 }]);
  });

  it('the close button hides the bar and clears the vendor guid (CORE.10.f seeding rule)', () => {
    openVendor();
    ui.vendorLayoutHandle.elements.get(EL.close).click();
    expect(ui.isVendorVisible).toBe(false);
    expect(ui.vendorData.vendorGuid).toBe(0);
    expect(ui.vendorWrapper).toBeNull();
  });
});
