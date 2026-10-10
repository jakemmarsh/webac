/**
 * BUG.viewcontents-containertype-discarded — nested containers/foci inside an
 * opened chest/corpse were indistinguishable from plain items.
 *
 * ACE ground truth: GameEventViewContents.cs:16-25 writes a per-item
 * ContainerType (0=NonContainer, 1=Container, 2=Foci) for every entry, and
 * Container.SendInventory (Container.cs:786-808) sends the opened container's
 * ViewContents FIRST, then one ViewContents per nested container, then the
 * CreateObject messages. Retail splits entries into _itemsList vs
 * _containersList on exactly this field (ACCObjectMaint::ViewObjectContents
 * @00558a70 in reference/client-eol/decomp/acclient-decompiled.c) so a nested
 * pack can be viewed on its own.
 *
 * Pre-fix, onViewContents kept only item.guid (containerType discarded), the
 * CreateObject open-container branch dropped data.itemType, and each
 * sub-container ViewContents clobbered the whole panel state — a chest
 * holding a pack showed only the pack's contents, with the chest's own items
 * leaking into the world-object path.
 *
 * Behavioral coverage: drives the real OpenContainerTracker with ACE's exact
 * message order, and the real GameUI container panel (happy-dom) with
 * pack-tab + nested-container rendering.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { ContainerType, ItemType } from '@ac/shared';

const CHEST = 0x80001000;
const POUCH = 0x80002000;
const FOCI = 0x80003000;
const APPLE = 0x80004000;
const EMERALD = 0x80005000;

describe('OpenContainerTracker — ViewContents ContainerType retained (behavioral)', () => {
  let t: OpenContainerTracker;

  beforeEach(() => {
    t = new OpenContainerTracker();
  });

  function openChest(): void {
    // ACE Container.SendInventory order: main ViewContents…
    expect(t.viewContents(CHEST, [
      { guid: APPLE, containerType: ContainerType.NonContainer },
      { guid: POUCH, containerType: ContainerType.Container },
      { guid: FOCI, containerType: ContainerType.Foci },
    ])).toBe('opened');
    // …then one ViewContents per nested container…
    expect(t.viewContents(POUCH, [
      { guid: EMERALD, containerType: ContainerType.NonContainer },
    ])).toBe('sub');
    // …then CreateObjects for everything (nested contents included).
    expect(t.trackCreateObject({ guid: APPLE, containerId: CHEST, name: 'Apple', iconDid: 0x0600, stackSize: 5, itemType: ItemType.Food })).toBe(true);
    expect(t.trackCreateObject({ guid: POUCH, containerId: CHEST, name: 'Leather Pouch', iconDid: 0x0601, stackSize: 1, itemType: ItemType.Container })).toBe(true);
    expect(t.trackCreateObject({ guid: FOCI, containerId: CHEST, name: 'Foci of Enchantment', iconDid: 0x0602, stackSize: 1, itemType: ItemType.Container })).toBe(true);
    expect(t.trackCreateObject({ guid: EMERALD, containerId: POUCH, name: 'Emerald', iconDid: 0x0603, stackSize: 1, itemType: ItemType.Gem })).toBe(true);
  }

  it('keeps the opened container as openGuid across sub-container ViewContents (no clobber)', () => {
    openChest();
    expect(t.openGuid).toBe(CHEST);
  });

  it('exposes Container AND Foci entries as pack tabs, in ViewContents order', () => {
    openChest();
    expect(t.packGuids()).toEqual([CHEST, POUCH, FOCI]);
  });

  it('marks isContainer from the authoritative ViewContents ContainerType', () => {
    openChest();
    const byGuid = new Map(t.items().map(i => [i.guid, i]));
    expect(byGuid.get(APPLE)).toMatchObject({ isContainer: false, containerId: CHEST, name: 'Apple', stackSize: 5 });
    expect(byGuid.get(POUCH)).toMatchObject({ isContainer: true, containerId: CHEST });
    expect(byGuid.get(FOCI)).toMatchObject({ isContainer: true, containerId: CHEST });
    expect(byGuid.get(EMERALD)).toMatchObject({ isContainer: false, containerId: POUCH, name: 'Emerald' });
  });

  it('rejects a CreateObject unrelated to the open container', () => {
    openChest();
    expect(t.trackCreateObject({ guid: 0x9999, containerId: 0x7777, name: 'Rat Tail', iconDid: 0, stackSize: 1, itemType: ItemType.Misc })).toBe(false);
    expect(t.has(0x9999)).toBe(false);
  });

  it('renders ViewContents-listed items as placeholders until their CreateObject arrives', () => {
    t.viewContents(CHEST, [{ guid: APPLE, containerType: ContainerType.NonContainer }]);
    expect(t.items()).toEqual([
      { guid: APPLE, name: '???', pluralName: '', iconDid: 0, stackSize: 1, containerId: CHEST, isContainer: false },
    ]);
  });

  it('take-all set (mainLevelGuids) excludes nested-container CONTENTS but includes the packs', () => {
    openChest();
    expect(t.mainLevelGuids().sort()).toEqual([APPLE, POUCH, FOCI].sort());
  });

  it('removing a nested pack drops its tab and its contents (they move with the pack)', () => {
    openChest();
    t.remove(POUCH);
    expect(t.packGuids()).toEqual([CHEST, FOCI]);
    expect(t.has(POUCH)).toBe(false);
    expect(t.has(EMERALD)).toBe(false);
    expect(t.has(APPLE)).toBe(true);
  });

  it('updates a tracked stack size in place', () => {
    openChest();
    expect(t.updateStackSize(APPLE, 3)).toBe(true);
    expect(t.items().find(i => i.guid === APPLE)?.stackSize).toBe(3);
    expect(t.updateStackSize(0xdead, 3)).toBe(false);
  });

  it('a ViewContents for an unrelated container re-opens (resets) the tracker', () => {
    openChest();
    const CORPSE = 0x80009000;
    expect(t.viewContents(CORPSE, [{ guid: 0x8000a000, containerType: ContainerType.NonContainer }])).toBe('opened');
    expect(t.openGuid).toBe(CORPSE);
    expect(t.has(APPLE)).toBe(false);
    expect(t.packGuids()).toEqual([CORPSE]);
  });

  it('falls back to the ItemType.Container bit for a container the ViewContents did not mark', () => {
    t.viewContents(CHEST, []);
    const LATE_PACK = 0x8000b000;
    // e.g. a pack another player stores into the open chest later — arrives
    // via CreateObject only, no fresh ViewContents entry.
    t.trackCreateObject({ guid: LATE_PACK, containerId: CHEST, name: 'Pack', iconDid: 0, stackSize: 1, itemType: ItemType.Container });
    expect(t.items().find(i => i.guid === LATE_PACK)?.isContainer).toBe(true);
    expect(t.packGuids()).toEqual([CHEST, LATE_PACK]);
  });

  it('tracks a player-stored item (GAP.20 path), honoring its ItemType.Container bit', () => {
    t.viewContents(CHEST, []);
    t.trackStoredItem(APPLE, { name: 'Apple', iconDid: 1, stackSize: 5, itemType: ItemType.Food });
    t.trackStoredItem(POUCH, { name: 'Pouch', iconDid: 2, stackSize: 1, itemType: ItemType.Container });
    const byGuid = new Map(t.items().map(i => [i.guid, i]));
    expect(byGuid.get(APPLE)).toMatchObject({ isContainer: false, containerId: CHEST });
    expect(byGuid.get(POUCH)).toMatchObject({ isContainer: true, containerId: CHEST });
    expect(t.packGuids()).toEqual([CHEST, POUCH]);
  });

  it('clear() empties everything', () => {
    openChest();
    t.clear();
    expect(t.openGuid).toBe(0);
    expect(t.packGuids()).toEqual([]);
    expect(t.items()).toEqual([]);
  });
});

/* ================================================================ */
/*  GameUI container panel — pack tabs + openable nested packs        */
/* ================================================================ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI container panel — nested pack tabs (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let taken: number[] = [];

  // CORE.17.o.c — the external-container strip, layout 0x21000008
  // (gmExternalContainerUI): root, the ground container's cell, the
  // nested-container row / scroller / list, the close box, the item frame,
  // the item row + its bar, the two arrows.
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Permissive stub layout handle (GAP.36 recipe).
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); }, destroy: () => { root.remove(); },
        };
      },
      render: (_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent)),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    taken = [];
    ui.setContainerCallbacks({ onTakeItem: (guid: number) => { taken.push(guid); } });
    ui.showContainerPanel(CHEST, [], -1, { name: 'Wooden Chest', iconDid: 0 });
    ui.setContainerPackGuids([CHEST, POUCH]);
    ui.updateContainerItems([
      { guid: APPLE, name: 'Apple', iconDid: 0, stackSize: 5, containerId: CHEST, isContainer: false },
      { guid: POUCH, name: 'Leather Pouch', iconDid: 0, stackSize: 1, containerId: CHEST, isContainer: true },
      { guid: EMERALD, name: 'Emerald', iconDid: 0, stackSize: 1, containerId: POUCH, isContainer: false },
    ]);
  });

  function panel(): HTMLElement { return ui.containerPanel as HTMLElement; }
  function tabs(): HTMLElement[] { return [...panel().querySelectorAll('[data-ac-container-tab]')] as HTMLElement[]; }
  function cellByTitle(prefix: string): HTMLElement | null {
    // Grid cells only — CORE.17.k.b.b.a.g: a cell's hover text is its DAT
    // tooltip (data-ac-tooltip-text = the item's name), not a native title.
    const all = [...panel().querySelectorAll('[data-ac-tooltip-text]:not([data-ac-container-tab])')] as HTMLElement[];
    // A stack reads "<count> <plural>" ("5 Apples"), so match the name anywhere in the text.
    return all.find(el => el.dataset.acTooltipText?.includes(prefix)) ?? null;
  }
  function dblclick(el: HTMLElement): void {
    el.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true }));
  }

  it('renders a UIItem cell per container (the ground container in m_topContainer + the nested pack in m_containerList), each with its name as the tooltip — no "Loot" label, no native title', () => {
    const tabEls = tabs();
    expect(tabEls.length).toBe(2);
    expect(tabEls[0].dataset.acTooltipText).toBe('Wooden Chest');
    expect(tabEls[1].dataset.acTooltipText).toBe('Leather Pouch');
    expect(tabEls[0].getAttribute('title')).toBeNull();
    expect(panel().textContent).not.toContain('Loot');
  });

  it('main tab shows the container\'s direct contents only (nested contents hidden)', () => {
    expect(cellByTitle('Apple')).not.toBeNull();
    expect(cellByTitle('Leather Pouch')).not.toBeNull();
    expect(cellByTitle('Emerald')).toBeNull();
  });

  it('marks nested packs distinctly (data attribute); the tooltip is the bare name (UIElement_UIItem::UpdateTooltip — no "double-click to open" hint, no native title)', () => {
    const pouchCell = cellByTitle('Leather Pouch')!;
    expect(pouchCell.getAttribute('data-ac-container-item')).toBe('1');
    expect(pouchCell.dataset.acTooltipText).toBe('Leather Pouch');
    expect(pouchCell.getAttribute('title')).toBeNull();
    const appleCell = cellByTitle('Apple')!;
    expect(appleCell.getAttribute('data-ac-container-item')).toBeNull();
  });

  it('double-clicking a nested pack in the row TAKES it (UIElement_ItemList::ListenToElementMessage @ 004e4d50 message 10 → ItemHolder::UseObject); a single click on its m_containerList cell opens it', () => {
    dblclick(cellByTitle('Leather Pouch')!);
    expect(taken).toEqual([POUCH]);
    // The row stayed on the chest.
    expect(cellByTitle('Apple')).not.toBeNull();
    expect(cellByTitle('Emerald')).toBeNull();
    // The nested list's cell opens it: its contents now visible.
    tabs()[1].click();
    expect(cellByTitle('Emerald')).not.toBeNull();
    expect(cellByTitle('Apple')).toBeNull();
    // The ground cell restores the chest's row.
    tabs()[0].click();
    expect(cellByTitle('Apple')).not.toBeNull();
    expect(cellByTitle('Emerald')).toBeNull();
  });

  it('double-clicking a plain item still takes it', () => {
    dblclick(cellByTitle('Apple')!);
    expect(taken).toEqual([APPLE]);
  });

  it('a flat container (single pack guid) has no nested UIItem — only the ground container\'s own cell; CORE.18.c: the list still pads its view with 13 empty cells (retail frame, UpdateEmptySlots)', () => {
    ui.setContainerPackGuids([CHEST]);
    ui.updateContainerItems([
      { guid: APPLE, name: 'Apple', iconDid: 0, stackSize: 5, containerId: CHEST, isContainer: false },
    ]);
    expect(tabs().length).toBe(1);
    const packs = panel().querySelector('[data-ac-container-packs]')!;
    expect(packs.querySelectorAll('[data-ac-container-tab]').length).toBe(0);
    expect(packs.querySelectorAll('[data-ac-container-pack-empty]').length).toBe(13);
    expect(cellByTitle('Apple')).not.toBeNull();
  });

  it('the row stays parented to the open pack when it leaves (nothing re-parents m_itemList — CORE.17.o.d); the ground cell click brings the chest back', () => {
    tabs()[1].click();                       // the pouch open
    ui.setContainerPackGuids([CHEST]);       // pouch taken → its cell gone
    ui.updateContainerItems([
      { guid: APPLE, name: 'Apple', iconDid: 0, stackSize: 5, containerId: CHEST, isContainer: false },
    ]);
    expect(cellByTitle('Apple')).toBeNull();
    expect(cellByTitle('Emerald')).not.toBeNull();
    tabs()[0].click();
    expect(cellByTitle('Apple')).not.toBeNull();
  });
});
