/**
 * GAP.20 — the two missing drag targets (behavioral, real GameUI DOM):
 *
 *  1. inventory → OPEN CONTAINER panel: drop stores the item in the chest.
 *     Wire: GameActionPutItemInContainer at the open container's guid,
 *     validated by ACE Player_Inventory.cs:790 _Verify (IsOpen for
 *     landscape containers at :881; corpses rejected with "You cannot put
 *     X in that." at :853).
 *  2. inventory → VENDOR panel: drop sells the dragged stack (retail
 *     drag-to-vendor). Wire: GameActionSellItems.cs vendorGuid + numItems
 *     + [amount + guid] — the existing onSell callback, amount = the full
 *     dragged stack per retail's stack-to-sell-pane semantics.
 *
 * Both drives render the REAL panels (renderContainerPanel /
 * renderVendorPanel) with a stub layout handle in happy-dom and dispatch
 * real dragstart/drop events. Requires happy-dom (tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const PLAYER_GUID = 0x50000001;
const CHEST_GUID = 0x70112233;

// Element ids the container/vendor renderers touch (layout 0x2100001a).
// CORE.17.o.c — the external-container strip (layout 0x21000008); the drop target is the item row 0x1000006a.
const PANEL_ELEMENT_IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];
// Inventory panel ids (layout 0x21000023) — needed to source a drag.
const INV_ELEMENT_IDS = [0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0];

describe('GAP.20 — container + vendor panels accept inventory drops', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let stored: number[] = [];
  let sold: Array<{ guid: number; amount: number }> = [];

  function stubLayoutRenderer() {
    const stub = {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        container.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [...PANEL_ELEMENT_IDS, ...INV_ELEMENT_IDS]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, setVisible: () => {}, setInteractive: () => {}, close: () => { root.remove(); }, destroy: () => { root.remove(); } };
      },
      // CORE.10.g — the vendor bar renders the classic_vendor layout via
      // render(0x21000012, …, { subtreeElementId }): stub every element id
      // the rebuilt bar touches and wire setInteractive as plain clicks.
      render: (_layoutId: number, container: HTMLElement): unknown => {
        // CORE.17.k.b.b.c.c.a.a.c.a — both panels render as slots of the
        // transaction dock 0x2100006d; the host names the panel it holds.
        if (container.dataset.dockPanel === 'container') return stub.renderPanel(_layoutId, container);
        const root = domWindow.document.createElement('div');
        container.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const E: any = { root: 0x100000b7, close: 0x100000d6, filterMenu: 0x100000bf, filterText: 0x1000034d,
          itemsName: 0x100000c0, itemsCost: 0x100000c1, itemsList: 0x100000bd, itemsScroll: 0x100000be,
          itemsBuy: 0x100000c2, itemsAdd: 0x100000c3, buyList: 0x100000c5, buyScroll: 0x100000c6,
          buyValue: 0x100000c7, buyPurse: 0x100000c8, buyItem: 0x100000c9, buyAll: 0x100000ca,
          buyClearItem: 0x100000cb, buyClearList: 0x100000cc, sellList: 0x100000ce, sellScroll: 0x100000cf,
          sellValue: 0x100000d0, sellPurse: 0x100000d1, sellItem: 0x100000d2, sellAll: 0x100000d3,
          sellClearItem: 0x100000d4, sellClearList: 0x100000d5,
          tabItems: 0x100000b9, tabBuying: 0x100000ba, tabSelling: 0x100000bb,
          pageItems: 0x100000bc, pageBuying: 0x100000c4, pageSelling: 0x100000cd };
        for (const id of Object.values(E) as number[]) {
          const el = domWindow.document.createElement('div');
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, descs: new Map(),
          setText: () => {}, setState: () => {}, setVisible: () => {},
          setFill: () => {}, setPalette: () => {},
          setInteractive: (id: number, fn?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && fn) el.addEventListener('click', () => fn(id, el));
          },
        };
      },
    };
    return stub;
  }

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    stored = [];
    sold = [];
    ui.setDragCallbacks({});
    ui.setContainerCallbacks({ onStoreItem: (guid: number) => { stored.push(guid); } });
    ui.setVendorCallbacks({ onSell: (guid: number, amount: number) => { sold.push({ guid, amount }); } });
    ui.setInventoryData(
      [{
        id: 0x8000aaaa, weenieClassId: 300, name: 'Arrow', value: 42, burden: 1, itemType: 0x100,
        stackSize: 42, maxStackSize: 250, stackable: true, containerId: PLAYER_GUID,
      }],
      [], 30, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  function beginDragFirstItem() {
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cell = [...grid.querySelectorAll('div')].find((c: any) => c.draggable === true);
    expect(cell).toBeTruthy();
    cell.dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
  }

  function dropOn(el: HTMLElement) {
    el.dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
  }

  it('drop on the open container\'s item row stores the dragged item (OnItemListDragOver → PutItemInContainer)', () => {
    ui.showContainerPanel(CHEST_GUID, []);
    const contentArea = ui.containerPanelHandle.elements.get(0x1000006a);
    beginDragFirstItem();
    dropOn(contentArea);
    expect(stored).toEqual([0x8000aaaa]);
    ui.hideContainerPanel();
  });

  it('container drop with no active drag is a no-op', () => {
    ui.showContainerPanel(CHEST_GUID, []);
    dropOn(ui.containerPanelHandle.elements.get(0x1000006a));
    expect(stored).toEqual([]);
    ui.hideContainerPanel();
  });

  // CORE.10.g — retail drop semantics (VendorSellUI::AcceptDragObject):
  // the drop ADDS the dragged stack to the Selling-tab list; the sale only
  // fires on Sell Item / Sell All. gmVendorUI::UpdateDragOver also flips
  // the bar to the Selling tab while an item is dragged over it.
  it('drop on the vendor bar queues the FULL dragged stack on the sell list; Sell Item sends it', () => {
    ui.showVendorWindow('Test Vendor', [], [
      { guid: 0x8000aaaa, weenieClassId: 300, name: 'Arrow', pluralName: 'Arrows', price: 10, burden: 1, stackSize: 42, itemType: 0x100 },
    ], undefined, undefined, undefined, undefined, 0x70110001, { itemTypes: 0x100, minValue: 0, maxValue: 25000 });
    beginDragFirstItem();
    dropOn(ui.vendorWrapper);
    // Queued, tab flipped to Selling, nothing sold yet.
    expect(sold).toEqual([]);
    expect(ui.vendorData.sellList).toEqual([{ guid: 0x8000aaaa, qty: 42 }]);
    expect(ui.vendorData.tab).toBe(2);
    // Sell Item (layout element 0x100000d2) sells the queued entry.
    ui.vendorLayoutHandle.elements.get(0x100000d2).click();
    expect(sold).toEqual([{ guid: 0x8000aaaa, amount: 42 }]);
    expect(ui.vendorData.sellList).toEqual([]);
  });

  it('a drop of an item the vendor will not buy back is ignored', () => {
    ui.showVendorWindow('Test Vendor', [], [], undefined, undefined, undefined, undefined, 0x70110002);
    beginDragFirstItem();
    dropOn(ui.vendorWrapper);
    expect(sold).toEqual([]);
    expect(ui.vendorData.sellList).toEqual([]);
  });

  it('vendor drop with no active drag is a no-op', () => {
    ui.showVendorWindow('Test Vendor', [], [], undefined, undefined, undefined, undefined, 0x70110003);
    dropOn(ui.vendorWrapper);
    expect(sold).toEqual([]);
  });
});
