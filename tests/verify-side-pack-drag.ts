/**
 * GAP.18 — drag-between-packs (behavioral, real GameUI DOM).
 *
 * Retail gesture: drag an inventory item onto a pack tab (or onto a pack
 * ITEM in the grid) to move it into that container. Wire: ACE
 * GameActionPutItemInContainer.cs (itemGuid u32 + containerGuid u32 +
 * placement i32), validated server-side by Player_Inventory.cs:790
 * HandleActionPutItemInContainer_Verify (burden, nesting, corpse targets).
 *
 * This suite drives the REAL renderInventoryPanel with a stub layout
 * handle (no DAT needed) in happy-dom and dispatches real dragstart/drop
 * events on the rendered pack tabs, asserting the new onDropToPack
 * callback fires with the dragged item index + target pack slot — and
 * that the guards (no active drag / equipment-slot drags) hold.
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

describe('GAP.18 — pack tabs accept item drops (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let drops: Array<Record<string, unknown>> = [];

  /** Minimal stand-in for LayoutRenderer.renderPanel: hands back live divs
   * for every element id the inventory renderer touches. */
  function stubLayoutRenderer() {
    return {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        container.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setText: () => {},
          close: () => { root.remove(); },
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
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    drops = [];
    ui.setDragCallbacks({
      // SWEEP1006B — every item-list drop goes through onItemListDrop (AcceptDragObject).
      onItemListDrop: (source: { kind: string; itemIndex?: number; slot?: number }, target: { list: string; packSlot: number; cellItemId?: number }) => {
        drops.push(source.kind === 'inventory'
          ? { itemIndex: source.itemIndex!, packSlot: target.packSlot, list: target.list, cellItemId: target.cellItemId }
          : { kind: source.kind, slot: source.slot, packSlot: target.packSlot, list: target.list, cellItemId: target.cellItemId });
      },
    });
    ui.setSidePackGuids([PLAYER_GUID, PACK_GUID]);
    ui.setInventoryData(
      [
        item(0x8000aaaa, 'Dagger', PLAYER_GUID),
        item(PACK_GUID, 'Pack', PLAYER_GUID, 0x200),
        item(0x8000bbbb, 'Apple', PACK_GUID),
      ],
      [], 30, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  function packTabs(): HTMLElement[] {
    // Pack tabs live in the right strip (element 0x100001ce), one per
    // sidePackGuids entry, in order.
    const strip = ui.inventoryPanelHandle.elements.get(0x100001ce);
    // CORE.17.k.b.b.a.g — the pack icons carry their DAT tooltip (the pack's name), no native title.
    return [...strip.children].filter((c: HTMLElement) => c.dataset.acTooltipText) as HTMLElement[];
  }

  function itemCells(): HTMLElement[] {
    // happy-dom does not reflect the `draggable` PROPERTY into the
    // attribute, so filter on the property instead of a CSS selector.
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return [...grid.querySelectorAll('div')].filter((c: any) => c.draggable === true) as HTMLElement[];
  }

  function fire(el: HTMLElement, type: string) {
    const ev = new domWindow.Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }

  it('renders one tab per pack (main + side)', () => {
    const tabs = packTabs();
    expect(tabs.length).toBe(2);
    expect(tabs[0].dataset.acTooltipText).toBe('Main Pack');
    expect(tabs[1].dataset.acTooltipText).toBe('Pack');
  });

  it('dragging an item cell onto a side-pack tab drops it on the pack column slot 1', () => {
    const cells = itemCells();
    expect(cells.length).toBeGreaterThan(0);
    fire(cells[0], 'dragstart'); // Dagger — inventoryItems[0]
    fire(packTabs()[1], 'drop');
    expect(drops).toEqual([{ itemIndex: 0, packSlot: 1, list: 'packs', cellItemId: undefined }]);
  });

  it('a worn item dropped on a pack tab is accepted (AcceptDragObject ignores the drag source)', () => {
    ui.dragSourceSlot = 0x200000;
    const ev = new domWindow.Event('dragover', { bubbles: true, cancelable: true });
    packTabs()[1].dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    fire(packTabs()[1], 'drop');
    expect(drops).toEqual([{ kind: 'equipped', slot: 0x200000, packSlot: 1, list: 'packs', cellItemId: undefined }]);
    expect(ui.dragSourceSlot).toBeNull();
  });

  it('a worn item dropped on a grid cell names the cell (occupied) for the merge / placement', () => {
    const cells = itemCells();
    ui.dragSourceSlot = 0x200000;
    fire(cells[0], 'drop'); // Dagger cell in the main pack
    expect(drops).toEqual([{ kind: 'equipped', slot: 0x200000, packSlot: 0, list: 'items', cellItemId: 0x8000aaaa }]);
  });

  it('dropping onto the MAIN pack tab fires packSlot 0 (move back to main)', () => {
    // Select the side pack tab so the grid shows the Apple, then drag it home.
    packTabs()[1].click();
    const cells = itemCells();
    fire(cells[0], 'dragstart'); // Apple — inventoryItems[2]
    fire(packTabs()[0], 'drop');
    expect(drops).toEqual([{ itemIndex: 2, packSlot: 0, list: 'packs', cellItemId: undefined }]);
  });

  it('drop with no active drag is a no-op', () => {
    fire(packTabs()[1], 'drop');
    expect(drops).toEqual([]);
  });

  it('drop after dragend (drag cancelled) is a no-op', () => {
    const cells = itemCells();
    fire(cells[0], 'dragstart');
    fire(cells[0], 'dragend');
    fire(packTabs()[1], 'drop');
    expect(drops).toEqual([]);
  });
});
