/**
 * CORE.17.o.d — the external-container strip's open state is tracked by
 * GUID the way retail's UIElement_ItemList does, never by list index.
 *
 * Ground truth (decompiled EoL client + acclient.exe):
 *  - m_itemList's parentContainerID is the container whose contents the row
 *    shows; ONE of the two upper lists holds openItemID, the cell with the
 *    open-arrow marker. A left click (message 7) on a container-list cell
 *    (ListenToElementMessage @ 004e4d50): ItemList_SetParentList(child,
 *    this) @ 004e3650 zeroes the OTHER list's openItemID + marker,
 *    ItemList_SetParentContainer(child, id) re-parents the row, then the
 *    clicked list's openItemID + marker follow.
 *  - A container moving into / out of the ground container refreshes
 *    m_containerList (ServerSaysMoveItem @ 004e5000 → SetParentContainer
 *    (this, ground, 1, 1) → ItemList_Flush @ 004e3d60: openItemID = 0,
 *    UpdateOpenContainerIndicator(0); ItemList_AddItem @ 004e3e00 re-adds
 *    the cells without the marker). The top list never refreshes (its
 *    parentContainerID is 0). Nothing re-parents the row — its own
 *    ServerSaysMoveItem skips containers (containerList false) and
 *    gmExternalContainerUI::RecvNotice_ServerSaysMoveItem @ 004cbb30
 *    (asm: [ecx+0x14] = m_itemList 0x60c, [ecx+0x10] = m_containerList
 *    0x608, [ecx+0xc] = m_topContainer 0x604, with ecx = this + 0x5f8) fires
 *    only for m_itemList's openItemID and calls ItemList_OpenFirstContainer
 *    on m_topContainer — the ground cell, never the nested list.
 *  - A double-click (message 10) on a row UIItem is ItemHolder::UseObject:
 *    a nested pack is taken like any item, not opened.
 *
 * The shipped GameUI in happy-dom against a stub layout handle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'WheelEvent'] as const;

describe('CORE.17.o.d — the container strip tracks its open container by GUID (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const CHEST = 0x80004000;
  const SACK = 0x80004001;
  const POUCH = 0x80004002;
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];
  let taken: number[] = [];

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
      // CORE.17.k.b.b.c.c.a.a.c.a — the strip renders as the dock's container slot.
      render: (layoutId: number, parent: HTMLElement) => ui.layoutRenderer.renderPanel(layoutId, parent),
    };
    ui.setContainerCallbacks({ onTakeItem: (guid: number) => { taken.push(guid); } });
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => { ui.hideContainerPanel(); taken = []; });

  function panel(): HTMLElement { return ui.containerPanel as HTMLElement; }
  function el(id: number): HTMLElement { return ui.containerPanelHandle.elements.get(id) as HTMLElement; }
  function cells(kind?: 'item' | 'empty'): HTMLElement[] {
    const sel = kind ? `[data-ac-container-cell="${kind}"]` : '[data-ac-container-cell]';
    return [...panel().querySelectorAll(sel)] as HTMLElement[];
  }
  function rowNames(): string[] { return cells('item').map((c) => c.dataset.acTooltipText ?? ''); }
  function packCell(guid: number): HTMLElement { return panel().querySelector(`[data-ac-container-tab="${guid}"]`) as HTMLElement; }
  function marked(): number[] {
    return ([...panel().querySelectorAll('[data-ac-container-open="1"]')] as HTMLElement[]).map((c) => Number(c.dataset.acContainerTab));
  }
  function item(guid: number, name: string, containerId = CHEST, extra: Record<string, unknown> = {}) {
    return { guid, name, iconDid: 0, stackSize: 1, containerId, isContainer: false, ...extra };
  }
  function click(target: HTMLElement): void { target.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); }
  function dblclick(target: HTMLElement): void { target.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true })); }

  const sack = () => item(SACK, 'Sack', CHEST, { isContainer: true, itemsCapacity: 24 });
  const pouch = () => item(POUCH, 'Pouch', CHEST, { isContainer: true, itemsCapacity: 10 });
  const apple = () => item(1, 'Apple');
  const emerald = () => item(5, 'Emerald', SACK);
  const ruby = () => item(6, 'Ruby', POUCH);

  function openChestWithBoth(): void {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Chest' });
    ui.setContainerPackGuids([CHEST, SACK, POUCH]);
    ui.updateContainerItems([apple(), sack(), pouch(), emerald(), ruby()]);
  }

  it('opens with the ground cell marked and the row on the chest; a nested cell click re-parents the row to that pack and moves the ONLY marker (ItemList_SetParentList clears the other list)', () => {
    openChestWithBoth();
    expect(marked()).toEqual([CHEST]);
    expect(rowNames()).toEqual(['Apple', 'Sack', 'Pouch']);
    click(packCell(POUCH));
    expect(marked()).toEqual([POUCH]);
    expect(rowNames()).toEqual(['Ruby']);
    expect(cells()).toHaveLength(10);
    click(packCell(CHEST));
    expect(marked()).toEqual([CHEST]);
    expect(rowNames()).toEqual(['Apple', 'Sack', 'Pouch']);
  });

  it('a nested pack leaving that is NOT the open one keeps the row on the open pack (by guid, not by its shifted index) — and the nested list\'s refresh flushes its marker', () => {
    openChestWithBoth();
    click(packCell(POUCH));
    // The Sack (first in the list) is taken: the Pouch shifts into its slot.
    ui.setContainerPackGuids([CHEST, POUCH]);
    ui.updateContainerItems([apple(), pouch(), ruby()]);
    expect(rowNames()).toEqual(['Ruby']);
    expect(cells()).toHaveLength(10);
    expect(marked()).toEqual([]);
    // A pack arriving refreshes the list the same way: still no marker, the row untouched.
    ui.setContainerPackGuids([CHEST, POUCH, SACK]);
    ui.updateContainerItems([apple(), pouch(), sack(), ruby(), emerald()]);
    expect(rowNames()).toEqual(['Ruby']);
    expect(marked()).toEqual([]);
  });

  it('a pack arriving or leaving while the ground row is open keeps the ground cell\'s marker (the top list never refreshes)', () => {
    ui.showContainerPanel(CHEST, [apple()], -1, { name: 'Chest' });
    expect(marked()).toEqual([CHEST]);
    ui.setContainerPackGuids([CHEST, SACK]);
    ui.updateContainerItems([apple(), sack(), emerald()]);
    expect(marked()).toEqual([CHEST]);
    expect(rowNames()).toEqual(['Apple', 'Sack']);
    ui.setContainerPackGuids([CHEST]);
    ui.updateContainerItems([apple()]);
    expect(marked()).toEqual([CHEST]);
    expect(rowNames()).toEqual(['Apple']);
  });

  it('re-setting the same pack list (no container moved) leaves the marker alone', () => {
    openChestWithBoth();
    click(packCell(SACK));
    ui.setContainerPackGuids([CHEST, SACK, POUCH]);
    ui.updateContainerItems([apple(), sack(), pouch(), emerald(), ruby()]);
    expect(marked()).toEqual([SACK]);
    expect(rowNames()).toEqual(['Emerald']);
  });

  it('the OPEN pack leaving: nothing re-parents the row — it keeps that pack\'s last-known contents and capacity with no marker; the ground cell click brings the chest back', () => {
    openChestWithBoth();
    click(packCell(POUCH));
    ui.setContainerPackGuids([CHEST, SACK]);
    ui.updateContainerItems([apple(), sack(), emerald()]);
    expect(marked()).toEqual([]);
    expect(rowNames()).toEqual(['Ruby']);
    expect(cells()).toHaveLength(10);
    expect(packCell(POUCH)).toBeNull();
    // A later item update on the chest does not disturb the stale row.
    ui.updateContainerItems([sack(), emerald()]);
    expect(rowNames()).toEqual(['Ruby']);
    click(packCell(CHEST));
    expect(marked()).toEqual([CHEST]);
    expect(rowNames()).toEqual(['Sack']);
    expect(cells()).toHaveLength(18); // 584 px of the 600-wide dock slot (CORE.17.k.b.b.c.c.a.a.c.a)
  });

  it('the departed pack put back resumes its live contents on the row (the snapshot is dropped)', () => {
    openChestWithBoth();
    click(packCell(POUCH));
    ui.setContainerPackGuids([CHEST, SACK]);
    ui.updateContainerItems([apple(), sack(), emerald()]);
    ui.setContainerPackGuids([CHEST, SACK, POUCH]);
    ui.updateContainerItems([apple(), sack(), pouch(), emerald(), item(7, 'Topaz', POUCH)]);
    expect(rowNames()).toEqual(['Topaz']);
    expect(marked()).toEqual([]);
  });

  it('a double-click on a nested pack cell in the row TAKES it (message 10 → ItemHolder::UseObject) and does not re-parent the row', () => {
    openChestWithBoth();
    const sackCell = cells('item').find((c) => c.dataset.acTooltipText === 'Sack')!;
    expect(sackCell.dataset.acContainerItem).toBe('1');
    dblclick(sackCell);
    expect(taken).toEqual([SACK]);
    expect(rowNames()).toEqual(['Apple', 'Sack', 'Pouch']);
    expect(marked()).toEqual([CHEST]);
  });

  it('hiding the panel forgets the row parent, the marker and any stale row', () => {
    openChestWithBoth();
    click(packCell(POUCH));
    ui.setContainerPackGuids([CHEST, SACK]);
    ui.updateContainerItems([apple(), sack(), emerald()]);
    ui.hideContainerPanel();
    ui.showContainerPanel(CHEST, [apple()], -1, { name: 'Chest' });
    expect(marked()).toEqual([CHEST]);
    expect(rowNames()).toEqual(['Apple']);
    expect(cells()).toHaveLength(18); // 584 px of the 600-wide dock slot (CORE.17.k.b.b.c.c.a.a.c.a)
  });
});
