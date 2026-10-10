/**
 * RECON.inventory-grid-dat-cells.b.a — the two waiting paths the pack-grid
 * ghost (.b) left out:
 *
 *  1. UIElement_ItemList::ItemList_BeginDrag @ 004e32d0 ghosts a drag out of
 *     ANY non-vendor / salvage / shortcut ItemList, the open ground
 *     container's m_itemList included: the object is selected, waits
 *     (SetWaitingState(1): overlay 0x10000349, media 0x0600109a) and rides
 *     the drag (StartDragandDrop) to the drop targets as a ground object.
 *  2. UIElement_ItemList::m_pendingItem: CPlayerSystem::PlaceInBackpack
 *     @ 0055d8c0 sends ShowPendingInPlayer, and
 *     gmInventoryUI::RecvNotice_ShowPendingInPlayer @ 004a6b50 inserts a
 *     non-container object into the shown pack's list at index 0, ghosted
 *     (ItemList_InsertItem @ 004e3f40 + SetWaitingState(1) +
 *     SetAsPendingItem); AcceptDragObject @ 004e4250 does the same at the
 *     drop cell for a placement into the list's own container. It goes on
 *     EndPendingInPlayer (DeletePendingItem @ 004e25c0), a list flush
 *     (ItemList_Flush @ 004e3d60, a pack switch) or the server's answer
 *     (ServerSaysAttemptFailed @ 004e4c20 re-parents the list; a move /
 *     delete re-lists the object).
 *
 * The shipped GameUI in happy-dom against stub layout handles, and the shipped
 * PendingPackItem decisions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { placeInBackpackPendingIndex, itemListDropPendingIndex } from '../packages/renderer/src/inventory/PendingPackItem.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'WheelEvent'] as const;
const GHOST = (0x0600109a).toString(16);
const PACK = 0x50000001;

describe('PendingPackItem — where the inventory list shows an object pending', () => {
  it('PlaceInBackpack: index 0 for an item, none for a container (RecvNotice_ShowPendingInPlayer skips IsContainer)', () => {
    expect(placeInBackpackPendingIndex(false)).toBe(0);
    expect(placeInBackpackPendingIndex(true)).toBeNull();
  });

  it('AcceptDragObject: a put / split into the list\'s own container shows it at the drop cell, clamped to the item count', () => {
    expect(itemListDropPendingIndex({ kind: 'put', containerId: PACK, placement: 2 }, PACK, 2, 5)).toBe(2);
    expect(itemListDropPendingIndex({ kind: 'split', containerId: PACK, placement: 0, amount: 3 }, PACK, 0, 5)).toBe(0);
    // An empty cell past the items (WhatNum > GetNumUIItems) lands after the last item.
    expect(itemListDropPendingIndex({ kind: 'put', containerId: PACK, placement: 5 }, PACK, undefined, 5)).toBe(5);
    expect(itemListDropPendingIndex({ kind: 'put', containerId: PACK, placement: 5 }, PACK, 40, 5)).toBe(5);
  });

  it('AcceptDragObject: no pending item for a merge, a refusal, or a placement into another container (a pack cell)', () => {
    expect(itemListDropPendingIndex({ kind: 'merge', targetId: 9, amount: 1 }, PACK, 1, 5)).toBeNull();
    expect(itemListDropPendingIndex({ kind: 'refused' }, PACK, 1, 5)).toBeNull();
    expect(itemListDropPendingIndex({ kind: 'put', containerId: 0x50000099, placement: 0 }, PACK, 1, 5)).toBeNull();
  });
});

const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];

describe('m_pendingItem in the pack grid (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of INVENTORY_ELEMENT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
    ui.itemShortcutObjectAt = () => 0;
    ui.itemRequestPendingFor = () => false;
    ui.uiTextures.set(0x0600109a, 'data:image/png;base64,G');
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });
  beforeEach(() => { ui.endPendingInPack(); });

  const dagger = { id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  const potion = { id: 9, weenieClassId: 901, name: 'Health Potion', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  const APPLE = 0x80001234;
  function cells(): HTMLElement[] {
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    const grid = ui.inventoryPanelHandle.elements.get(0x100001cf).querySelector('div[style*="grid"]') as HTMLElement;
    return [...grid.children] as HTMLElement[];
  }
  const order = (): string[] => cells().slice(0, 4).map((c) => c.dataset.acPendingGuid ? `pending:${c.dataset.acPendingGuid}` : c.dataset.acSelGuid ?? 'empty');
  const ghostOf = (cell: HTMLElement) => cell.querySelector(':scope > [data-waiting-ghost]') as HTMLElement | null;

  it('ShowPendingInPlayer puts the picked-up object at index 0, ghosted, ahead of the pack\'s items', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    expect(order()).toEqual(['7', '9', 'empty', 'empty']);
    ui.showPendingInPack({ guid: APPLE, packSlot: 0, index: 0, iconDid: 0x06001234 });
    expect(order()).toEqual([`pending:${APPLE}`, '7', '9', 'empty']);
    const cell = cells()[0]!;
    expect(ghostOf(cell)?.dataset.waitingGhost).toBe(GHOST);
    expect(ghostOf(cell)?.style.backgroundImage).toContain('base64,G');
    // It is not a held item: no select / drag on it.
    expect(cell.draggable).not.toBe(true);
    // The grid still holds every cell it had (the open slot came from the padding).
    expect(cells().length).toBe(102);
  });

  it('AcceptDragObject\'s pending item sits at the drop cell', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    ui.showPendingInPack({ guid: APPLE, packSlot: 0, index: 1, iconDid: 0x06001234 });
    expect(order()).toEqual(['7', `pending:${APPLE}`, '9', 'empty']);
  });

  // RECON.inventory-grid-dat-cells.b.a.a — AcceptDragObject @ 004e4250 with
  // m_pendingItem set: the 0x1a line (.rdata 0x7bfd40) and no placement.
  it('a second drop on a list that shows a pending item waits: "Already attempting to place <name> here", nothing sent', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    ui.showPendingInPack({ guid: APPLE, packSlot: 0, index: 0, iconDid: 0x06001234, name: 'Apple' });
    const lines: string[] = [];
    const orig = ui.displayErrorText;
    ui.displayErrorText = (t: string) => { lines.push(t); };
    const sent: unknown[] = [];
    const prevCallbacks = ui.dragCallbacks;
    ui.dragCallbacks = { ...prevCallbacks, onItemListDrop: (src: unknown, tgt: unknown) => { sent.push([src, tgt]); } };
    ui.worldDragGuid = 0x80005555;
    ui.itemListDrop({ list: 'items', packSlot: 0, cellItemId: 0 });
    expect(lines).toEqual(['Already attempting to place Apple here']);
    expect(sent).toEqual([]);
    // A list with no pending item (another pack) takes the drop.
    ui.worldDragGuid = 0x80005555;
    ui.itemListDrop({ list: 'items', packSlot: 1, cellItemId: 0 });
    expect(sent.length).toBe(1);
    ui.displayErrorText = orig;
    ui.dragCallbacks = prevCallbacks;
    ui.endPendingInPack();
  });

  it('survives a grid rebuild and goes on the server\'s answer for that object only', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    ui.showPendingInPack({ guid: APPLE, packSlot: 0, index: 0, iconDid: 0x06001234 });
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    expect(order()[0]).toBe(`pending:${APPLE}`);
    ui.itemRequestAnswered(9);
    expect(order()[0]).toBe(`pending:${APPLE}`);
    ui.itemRequestAnswered(APPLE);
    expect(ui.pendingPackItemNow()).toBeNull();
    expect(order()).toEqual(['7', '9', 'empty', 'empty']);
  });

  it('EndPendingInPlayer (nothing was sent) deletes it', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    ui.showPendingInPack({ guid: APPLE, packSlot: 0, index: 0, iconDid: 0x06001234 });
    ui.endPendingInPack(APPLE);
    expect(order()).toEqual(['7', '9', 'empty', 'empty']);
  });

  it('a full fixed list takes none (ItemList_InsertItem finds no empty cell)', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 2);
    ui.showPendingInPack({ guid: APPLE, packSlot: 0, index: 0, iconDid: 0x06001234 });
    expect(cells().some((c) => c.dataset.acPendingGuid)).toBe(false);
  });

  it('shows only in the pack it was put in', () => {
    ui.setInventoryData([dagger, potion], [], 1, 100, 102);
    ui.showPendingInPack({ guid: APPLE, packSlot: 3, index: 0, iconDid: 0x06001234 });
    expect(cells().some((c) => c.dataset.acPendingGuid)).toBe(false);
  });
});

describe('ItemList_BeginDrag on the ground container\'s item row (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let requestPending = 0;
  const CHEST = 0x80004000;
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];
  const selected: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
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
        const bar = elements.get(0x1000006b)!;
        for (const cid of ['0x1', '0x1000036c', '0x1000036b']) {
          const c = domWindow.document.createElement('div');
          c.dataset.elementId = cid;
          bar.appendChild(c);
        }
        return {
          root, elements,
          setText: () => {}, setInteractive: () => {}, setTexture: () => {},
          setVisible: () => {}, resizeSubtree: () => {}, onClick: () => {},
          close: () => { wrapper.remove(); }, destroy: () => { wrapper.remove(); },
        };
      },
      render: (layoutId: number, parent: HTMLElement) => ui.layoutRenderer.renderPanel(layoutId, parent),
    };
    ui.itemRequestPendingFor = (guid: number) => guid === requestPending;
    ui.onInventorySelectionToToolbar = (guid: number) => { selected.push(guid); };
    ui.uiTextures.set(0x0600109a, 'data:image/png;base64,G');
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  const nextTick = () => new Promise<void>((r) => setTimeout(r, 5));
  function rowCell(guid: number): HTMLElement {
    return (ui.containerPanel as HTMLElement).querySelector(`[data-ac-container-guid="${guid}"]`) as HTMLElement;
  }
  const ghostOf = (cell: HTMLElement) => cell.querySelector(':scope > [data-waiting-ghost]') as HTMLElement | null;
  function openChest(): void {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Chest' });
    ui.setContainerPackGuids([CHEST]);
    ui.updateContainerItems([
      { guid: 1, name: 'Apple', iconDid: 0x06001111, stackSize: 1, containerId: CHEST, isContainer: false },
      { guid: 2, name: 'Pear', iconDid: 0x06002222, stackSize: 1, containerId: CHEST, isContainer: false },
    ]);
  }

  // RECON.inventory-grid-dat-cells.b.a.b — AcceptDragObject @ 004e4250 on the
  // ground container's m_itemList: the stored object shows at the drop cell,
  // ghosted, until the server answers.
  it('a store drop shows the object pending at its cell in the chest row until the answer', () => {
    openChest();
    const POTION = 0x80007777;
    ui.showPendingInContainer({ guid: POTION, listGuid: CHEST, packSlot: 0, index: 1, iconDid: 0x06003333, name: 'Potion' });
    const row = (ui.containerPanel as HTMLElement).querySelector('[data-ac-container-row]') as HTMLElement;
    const order = [...row.children].slice(0, 3).map((c) => (c as HTMLElement).dataset.acPendingGuid ? 'pending' : (c as HTMLElement).dataset.acContainerGuid ?? 'empty');
    expect(order).toEqual(['1', 'pending', '2']);
    const pcell = row.children[1] as HTMLElement;
    expect(pcell.querySelector(':scope > [data-waiting-ghost]')).not.toBeNull();
    ui.itemRequestAnswered(2);
    expect(ui.pendingContainerItemNow()?.guid).toBe(POTION);
    ui.itemRequestAnswered(POTION);
    expect(ui.pendingContainerItemNow()).toBeNull();
    expect((ui.containerPanel as HTMLElement).querySelector('[data-ac-pending-guid]')).toBeNull();
  });

  it('a pending item for another list (a nested pack) does not show in this row; opening a new container clears it', () => {
    openChest();
    ui.showPendingInContainer({ guid: 0x80007778, listGuid: 0x80009999, packSlot: 0, index: 0, iconDid: 0x06003333 });
    expect((ui.containerPanel as HTMLElement).querySelector('[data-ac-pending-guid]')).toBeNull();
    openChest();
    expect(ui.pendingContainerItemNow()).toBeNull();
  });

  it('a row cell starts a drag: the object is selected, ghosted, and carried as a ground object', () => {
    openChest();
    const cell = rowCell(1);
    expect(cell.draggable).toBe(true);
    expect(ghostOf(cell)).toBeNull();
    cell.dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
    expect(selected.at(-1)).toBe(1);
    expect(ui.isItemWaiting(1)).toBe(true);
    expect(ghostOf(cell)?.dataset.waitingGhost).toBe(GHOST);
    expect(ghostOf(rowCell(2))).toBeNull();
    expect(ui.worldDropSource()).toEqual({ kind: 'world', guid: 1 });
  });

  it('a drag that sent nothing ends un-ghosted; the drag source is gone', async () => {
    requestPending = 0;
    rowCell(1).dispatchEvent(new domWindow.Event('dragend', { bubbles: true }));
    await nextTick();
    expect(ui.isItemWaiting(1)).toBe(false);
    expect(ghostOf(rowCell(1))).toBeNull();
    expect(ui.worldDropSource()).toBeNull();
  });

  it('a drop that sent a request keeps the row cell ghosted through a re-render until the server answers', async () => {
    openChest();
    rowCell(2).dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
    requestPending = 2;
    domWindow.document.body.dispatchEvent(new domWindow.Event('drop', { bubbles: true }));
    await nextTick();
    ui.updateContainerItems([
      { guid: 1, name: 'Apple', iconDid: 0x06001111, stackSize: 1, containerId: CHEST, isContainer: false },
      { guid: 2, name: 'Pear', iconDid: 0x06002222, stackSize: 1, containerId: CHEST, isContainer: false },
    ]);
    expect(ghostOf(rowCell(2))?.dataset.waitingGhost).toBe(GHOST);
    requestPending = 0;
    ui.itemRequestAnswered(2);
    expect(ghostOf(rowCell(2))).toBeNull();
  });
});
