/**
 * FAITHFUL.548 — drop an inventory item onto the trade window panel to
 * add it to the trade (alternative to the right-click "Add to Trade"
 * verb). Wire (unchanged from the right-click path): GameActionAddToTrade
 * per GameActionAddToTrade.cs reads itemGuid u32 + tradeSlot u32.
 *
 * CONVERTED from a source-text pin to a behavioral DOM test (GAP.20):
 * the old regex anchored on the FIRST `contentArea.addEventListener
 * ('drop'` in GameUI.ts and broke the moment another panel gained a drop
 * handler. This version renders the REAL trade panel (stub layout
 * handle, happy-dom) and dispatches real dragstart/drop events,
 * asserting the guards the pin used to grep for:
 *  - drop with an open trade fires onDropToTrade(draggedIdx)
 *  - partnerGuid === 0 (no active trade) → no-op
 *  - no active drag → no-op
 *  - equipped-slot drags go to onDropEquippedToTrade (CORE.17.k.b.b.c.c.a.a.c.a.b.a)
 *
 * CORE.17.k.b.b.c.c.a.a.c.a.b — the panel is the DAT slot; the drop target
 * is the player's own list 0x10000088 only (gmSecureTradeUI::HandleDropRelease
 * @ 004cae10: IsAncestorOfMe(m_pSelfItemsList)), not the whole slot.
 *
 * Requires happy-dom (devDep; tests/_harness/dom.ts fails loudly without it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const PANEL_ELEMENT_IDS = [0x1000011b, 0x1000011c, 0x1000011d, 0x100000fe, 0x100000fc];
const INV_ELEMENT_IDS = [0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0];
/** The trade slot 0x1000005f and its elements (layout 0x2100000d). */
const TRADE_SLOT_IDS = [0x1000005f, 0x1000007b, 0x1000007d, 0x1000007e, 0x1000007f, 0x10000080, 0x10000081, 0x10000082,
  0x10000083, 0x10000085, 0x10000086, 0x10000087, 0x10000088, 0x10000089, 0x1000008a, 0x1000008b];
/** The texts the last dock handle set, by element id. */
const TEXTS = new Map<number, string>();

describe('FAITHFUL.548 — trade window accepts inventory drops (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let added: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      // CORE.17.k.b.b.c.c.a.a.c.a.b — the transaction dock 0x2100006d with the
      // trade slot's elements (the panel is the DAT slot).
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TRADE_SLOT_IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          if (id === 0x10000088 || id === 0x10000081) el.style.width = '295px';
          root.appendChild(el);
          elements.set(id, el);
        }
        TEXTS.clear();
        return {
          root, elements, descs: new Map(),
          setText: (id: number, t: string) => { TEXTS.set(id, t); },
          setFill: () => {}, setPalette: () => {}, setVisible: () => {}, setState: () => {},
          setInteractive: () => {}, onClick: () => {},
          destroy: () => { root.remove(); },
        };
      },
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [...PANEL_ELEMENT_IDS, ...INV_ELEMENT_IDS]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function openTrade(partnerGuid: number) {
    ui.showTradeWindow('Partner');
    ui.setTradeData({
      yourItems: [], theirItems: [], theirName: 'Partner', yourName: 'Me',
      partnerGuid, initiatorGuid: partnerGuid ? 0x50000001 : 0,
      tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
  }

  beforeEach(() => {
    added = [];
    // In a real browser dragend clears drag state after every gesture;
    // tests dispatch no dragend, so reset explicitly between cases.
    ui.dragItemIndex = -1;
    ui.dragSourceSlot = null;
    ui.setDragCallbacks({ onDropToTrade: (idx: number) => { added.push(idx); } });
    ui.setInventoryData(
      [{
        id: 0x8000aaaa, weenieClassId: 300, name: 'Arrow', value: 1, burden: 1,
        stackSize: 10, maxStackSize: 250, stackable: true, containerId: 0x50000001,
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

  /** HandleDropRelease @ 004cae10: only a drop inside m_pSelfItemsList 0x10000088 (the RIGHT list) is taken. */
  function dropOnTrade(listId = 0x10000088) {
    const list = (ui.tradePanel as HTMLElement).querySelector(`[data-element-id="0x${listId.toString(16)}"]`) as HTMLElement;
    list.dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
  }

  it('drop with an open trade fires onDropToTrade with the dragged index', () => {
    openTrade(0x50002222);
    beginDragFirstItem();
    dropOnTrade();
    expect(added).toEqual([0]);
  });

  it('CORE.17.k.b.b.c.c.a.a.c.a.b — a drop on the PARTNER\'s list 0x10000081 (or elsewhere on the slot) adds nothing', () => {
    openTrade(0x50002222);
    beginDragFirstItem();
    dropOnTrade(0x10000081);
    dropOnTrade(0x1000005f);
    expect(added).toEqual([]);
  });

  it('drop with NO active trade (partnerGuid 0) is a no-op', () => {
    openTrade(0);
    beginDragFirstItem();
    dropOnTrade();
    expect(added).toEqual([]);
  });

  it('drop with no active drag is a no-op', () => {
    openTrade(0x50002222);
    dropOnTrade();
    expect(added).toEqual([]);
  });

  it('CORE.17.k.b.b.c.c.a.a.c.a.b.a — an equipped-slot drag is offered too (a wielded item IsOwnedByPlayer; ACE falls back to GetEquippedItem)', () => {
    const equippedDrops: number[] = [];
    ui.setDragCallbacks({
      onDropToTrade: (idx: number) => { added.push(idx); },
      onDropEquippedToTrade: (slot: number) => { equippedDrops.push(slot); },
    });
    openTrade(0x50002222);
    ui.dragItemIndex = -1;
    ui.dragSourceSlot = 0x100000; // a paperdoll dragstart: index -1, the slot set
    dropOnTrade();
    expect(added).toEqual([]);
    expect(equippedDrops).toEqual([0x100000]);
    expect(ui.dragSourceSlot).toBeNull();
  });
});
