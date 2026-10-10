/**
 * GAP.22 — salvage panel is reachable and drives the real wire callback.
 *
 * Retail flow (documented in the FAITHFUL.473 comment + acpedia
 * Salvaging): double-click the Ust → the salvage panel opens CLIENT-side
 * (no server round-trip); drag pack items onto its list to queue them; the
 * Salvage button ships GameActionCreateTinkeringTool (toolGuid + count +
 * guids, per ACE GameActionCreateTinkeringTool.cs → Player.HandleSalvaging).
 *
 * CORE.17.k.b.b.c.c.a.a.c.a.a — the panel is the DAT slot 0x1000005e (layout
 * 0x2100000c through the transaction dock). The LayoutRenderer is stubbed
 * with a handle carrying the slot's elements, so the drive runs without
 * DATs; verify-core17kbbccaaacaa-salvage-slot.ts renders the real one.
 * happy-dom via tests/_harness/dom.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const PANEL_ELEMENT_IDS = [0x1000011b, 0x1000011c, 0x1000011d, 0x100000fe, 0x100000fc];
const INV_ELEMENT_IDS = [0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0];
/** The salvage slot's elements (list, bar, button, title, close). */
const SLOT = { list: 0x10000074, bar: 0x10000075, button: 0x10000076, title: 0x10000077, close: 0x10000078 };

const UST_GUID = 0x8000cccc;
const LOOT_GUID = 0x8000dddd;
const LOOT2_GUID = 0x8000eeee;

describe('GAP.22 — salvage panel flow (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let salvaged: Array<{ tool: number; items: number[] }> = [];
  /** The last dock handle the stub rendered: element states set through it. */
  let states = new Map<number, number>();
  let elements = new Map<number, HTMLElement>();

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      // The transaction dock 0x2100006d with the salvage slot's elements.
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        elements = new Map();
        states = new Map();
        for (const id of Object.values(SLOT)) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          if (id === SLOT.list) el.style.width = '500px';
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, descs: new Map(),
          setText: () => {}, setFill: () => {}, setPalette: () => {},
          setVisible: (id: number, v: boolean) => { const el = elements.get(id); if (el) el.style.display = v ? '' : 'none'; },
          setState: (id: number, s: number) => { states.set(id, s); },
          setInteractive: (id: number, h?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && h) el.addEventListener('click', () => h(id, el));
          },
          destroy: () => { root.remove(); },
        };
      },
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const els = new Map<number, HTMLElement>();
        for (const id of [...PANEL_ELEMENT_IDS, ...INV_ELEMENT_IDS]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          els.set(id, el);
        }
        return { root, elements: els, setText: () => {}, close: () => { root.remove(); } };
      },
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    salvaged = [];
    ui.dragItemIndex = -1;
    ui.dragSourceSlot = null;
    ui.setDragCallbacks({});
    ui.setSalvageCallbacks({ onSalvage: (tool: number, items: number[]) => { salvaged.push({ tool, items }); } });
    ui.setInventoryData(
      [
        {
          id: UST_GUID, weenieClassId: 20646, name: 'Ust', value: 0, burden: 50,
          stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0x50000001, itemType: 0x20000000,
        },
        {
          // CORE.17.k.b.b.c.c.a.a.c.a.a.a — IsItemSuitable wants a salvage
          // material type (Iron 0x3d / Steel 0x40); the Ust has none.
          id: LOOT_GUID, weenieClassId: 6353, name: 'Buckler', value: 120, burden: 300,
          stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0x50000001, materialType: 0x3d,
        },
        {
          id: LOOT2_GUID, weenieClassId: 6354, name: 'Kite Shield', value: 200, burden: 400,
          stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0x50000001, materialType: 0x40,
        },
      ],
      [], 30, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
    ui.hideSalvagePanel();
  });

  function dragInventoryIndex(idx: number) {
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cells = [...grid.querySelectorAll('div')].filter((c: any) => c.draggable === true);
    cells[idx].dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
  }

  function dropOn(el: HTMLElement) {
    el.dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
  }
  const dropOnList = () => dropOn(elements.get(SLOT.list)!);
  const click = (id: number) => elements.get(id)!.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
  const cells = (kind: 'item' | 'empty') => ui.salvagePanel.querySelectorAll(`[data-ac-salvage-cell="${kind}"]`);

  it('showSalvagePanel opens the panel with an empty queue for the tool', () => {
    expect(ui.isSalvageOpen).toBe(false);
    ui.showSalvagePanel(UST_GUID);
    expect(ui.isSalvageOpen).toBe(true);
    expect(ui.getSalvageQueue()).toEqual([]);
  });

  it('dragging a pack item onto the list queues it', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1); // Buckler
    dropOnList();
    expect(ui.getSalvageQueue()).toEqual([LOOT_GUID]);
  });

  it('HandleDropRelease: only a drop inside m_salvageList is accepted (the button is not a target)', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOn(elements.get(SLOT.button)!);
    expect(ui.getSalvageQueue()).toEqual([]);
  });

  it('the Ust itself (no salvage material — IsItemSuitable) and duplicates are refused', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(0); // the Ust
    dropOnList();
    expect(ui.getSalvageQueue()).toEqual([]);
    dragInventoryIndex(1);
    dropOnList();
    dragInventoryIndex(1);
    dropOnList();
    expect(ui.getSalvageQueue()).toEqual([LOOT_GUID]);
  });

  it('the list: 15 empty 32-px tiles when empty; a queued item fills the first; the button is disabled (0xd) until then, normal (1) after', () => {
    ui.showSalvagePanel(UST_GUID);
    expect(cells('empty')).toHaveLength(15);
    expect(cells('item')).toHaveLength(0);
    expect(states.get(SLOT.button)).toBe(0xd);
    dragInventoryIndex(1);
    dropOnList();
    expect(cells('item')).toHaveLength(1);
    expect(cells('empty')).toHaveLength(14);
    expect(states.get(SLOT.button)).toBe(1);
    // No invented strings in the panel.
    expect(ui.salvagePanel.textContent).not.toContain('Drag items here');
  });

  it('double-clicking a queued cell removes it (ListenToElementMessage dwParam1 10 → RemoveItem); the button goes back to 0xd', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOnList();
    cells('item')[0].dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true }));
    expect(ui.getSalvageQueue()).toEqual([]);
    expect(states.get(SLOT.button)).toBe(0xd);
  });

  it('dragging a queued cell out removes it (RecvNotice_ItemListBeginDrag → RemoveItem)', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOnList();
    cells('item')[0].dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
    expect(ui.getSalvageQueue()).toEqual([]);
  });

  it('queued items are staged (SetTradeState(1)): salvageStagedGuids follows the queue', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOnList();
    expect([...ui.salvageStagedGuids()]).toEqual([LOOT_GUID]);
    ui.hideSalvagePanel();
    expect([...ui.salvageStagedGuids()]).toEqual([]);
  });

  // BUG.character-tab-not-retail — Salvage Multiple Materials at Once is OFF
  // for a fresh character (options2_ 0x00948700 lacks SalvageMultiple), so
  // IsItemSuitable @ 004cb040 refuses a second, different material.
  it('with the retail default (Salvage Multiple Materials off) a different-material item is refused', () => {
    ui.optionsSettings.salvageMultipleMaterialsAtOnce = false;
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOnList();
    dragInventoryIndex(2);
    dropOnList();
    expect(ui.getSalvageQueue()).toEqual([LOOT_GUID]);
  });

  it('the Salvage button fires onSalvage with toolGuid + the list last-first (Salvage @ 004cb840), then flushes the list and stays open', () => {
    ui.optionsSettings.salvageMultipleMaterialsAtOnce = true; // the two shields are different materials
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOnList();
    dragInventoryIndex(2);
    dropOnList();
    expect(ui.getSalvageQueue()).toEqual([LOOT_GUID, LOOT2_GUID]);
    click(SLOT.button);
    expect(salvaged).toEqual([{ tool: UST_GUID, items: [LOOT2_GUID, LOOT_GUID] }]);
    expect(ui.getSalvageQueue()).toEqual([]);
    expect(ui.isSalvageOpen).toBe(true);
    expect(states.get(SLOT.button)).toBe(0xd);
  });

  it('Salvage button with an empty queue is a no-op', () => {
    ui.showSalvagePanel(UST_GUID);
    click(SLOT.button);
    expect(salvaged).toEqual([]);
  });

  it('the close box hides the panel and flushes the queue (OnVisibilityChanged(false) → CloseSalvagePanel)', () => {
    ui.showSalvagePanel(UST_GUID);
    dragInventoryIndex(1);
    dropOnList();
    click(SLOT.close);
    expect(ui.isSalvageOpen).toBe(false);
    expect(ui.getSalvageQueue()).toEqual([]);
    expect(ui.salvagePanel).toBeNull();
  });
});
