/**
 * Reddit (Seedsow / GDLE and AC1999), 2026-10-17: "I can't seem to make a
 * shortcut to my main pack". Retail allowed the main pack on the 18-slot
 * item-shortcut bar.
 *
 * Retail (decompiled EoL client + acclient.exe + DAT):
 *  - The inventory's main-pack cell is m_topContainer (gmBackpackUI::PostInit
 *    @ 004a6f70: element 0x100001c9), an ItemList whose base 0x10000339
 *    @ 0x2100003d sets 0x10000016 = true (drag enabled); gmInventoryUI::
 *    RecvNotice_SetDisplayInventory @ 004a6750 ItemList_AddItem's the
 *    player's id into it, so ItemList_BeginDrag @ 004e32d0 drags the player.
 *  - gmToolbarUI::HandleDropRelease @ 004be7c0 → CreateShortcutToItem
 *    @ 004bdac0 → IsShortcutEligible @ 004bd1d0: stuck objects and creatures
 *    are refused unless vtable +0x10 is nonzero. The primary vtable
 *    (0x7e3ea0, set by ACCWeenieObject::ACCWeenieObject @ 0058c790) has
 *    +0x10 = ACCWeenieObject::IsPlayer @ 0058c890 (BF_PLAYER) and +0x18 =
 *    InqType @ 0058c8d0. IsOwnedByPlayer is true for the player itself
 *    (IsOwnedByObject @ 0058ceb0: id == player_id). So the main pack goes on
 *    the bar.
 *  - gmToolbarUI::UseShortcut @ 004bd350: with a target mode armed the
 *    slot's object is the target (a healing kit on yourself); otherwise
 *    ItemHolder::UseObject → CPlayerSystem::UsingItem @ 00562f70 →
 *    SendNotice_OpenContainedContainer(player) → gmInventoryUI::
 *    RecvNotice_OpenContainedContainer @ 004a6a80: inventory shown on the
 *    main pack, no request sent.
 *  - The player as a placement item: AttemptToPlaceInContainer_IsItemLegal
 *    @ 005870c0 refuses yourself ("You cannot place yourself within a
 *    container!") and a creature ("You cannot pick up creatures!").
 *
 * Drives the shipped ItemShortcutRestorer, ItemHolderPlacement and the real
 * GameUI inventory panel / shortcut slots.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  ItemShortcutRestorer, isShortcutEligible, type ShortcutItemInfo, type ShortcutTarget,
} from '../packages/renderer/src/network/itemShortcutRestore';
import {
  attemptToPlaceInContainer, placeInBackpack, isItemLegalHead, ITEM_LEGAL_STRINGS,
} from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { makeWorld, PLAYER } from './_harness/placementWorld.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const PACK = 0x80001111;
const KIT = 0x80002222;
/** The target main.ts's shortcutTargetOf builds for the player's own id. */
const playerItem: ShortcutItemInfo = { name: 'Tester', itemType: 0x10, isThePlayer: true };
const playerTarget: ShortcutTarget = { owned: true, eligible: true, item: playerItem, name: 'Tester' };

describe('CreateShortcutToItem / restore — the player as a shortcut', () => {
  let sent: string[];
  let looks: Map<number, ShortcutItemInfo | undefined>;
  let bar: ItemShortcutRestorer;
  beforeEach(() => {
    sent = [];
    looks = new Map();
    bar = new ItemShortcutRestorer(
      (index, _icon, _title, item) => looks.set(index, item),
      { add: (i, o) => sent.push(`add ${i} ${o.toString(16)}`), remove: (i) => sent.push(`remove ${i}`) },
    );
  });

  it('a player is shortcut-eligible (IsPlayer bypasses the creature gate); another creature is not', () => {
    expect(isShortcutEligible({ isPlayer: true, stuck: false, itemType: 0x10 })).toBe(true);
    expect(isShortcutEligible({ isPlayer: false, stuck: false, itemType: 0x10 })).toBe(false);
  });

  it('dropping the main pack on a slot makes a shortcut to the player and tells the server', () => {
    const pickUp = vi.fn(() => true);
    expect(bar.dropItemOnSlot(PLAYER, 3, playerTarget, pickUp)).toBeNull();
    expect(pickUp).not.toHaveBeenCalled(); // the player owns itself: no PlaceInBackpack
    expect(bar.objectAt(3)).toBe(PLAYER);
    expect(looks.get(3)?.isThePlayer).toBe(true);
    expect(sent).toEqual([`add 3 ${PLAYER.toString(16)}`]);
  });

  it('Create Shortcut on yourself (index -1) takes the first empty slot; a second is the duplicate line', () => {
    expect(bar.createShortcutToItem(PLAYER, -1, playerTarget, true, false)).toBeNull();
    expect(bar.objectAt(0)).toBe(PLAYER);
    expect(bar.createShortcutToItem(PLAYER, -1, playerTarget, true, false)).toBe('There is already a shortcut to the Tester');
  });

  it('a PlayerDescription shortcut to the player binds at once — no inventory item ever resolves it', () => {
    const getItem = (id: number) => (id === PLAYER ? playerItem : undefined);
    expect(bar.restoreFromDescription([{ index: 5, objectId: PLAYER }, { index: 6, objectId: KIT }], getItem))
      .toEqual({ restored: 1, deferred: 1 });
    expect(bar.objectAt(5)).toBe(PLAYER);
    expect(looks.get(5)?.isThePlayer).toBe(true);
    expect(bar.pendingCount).toBe(1); // only the kit waits for its CreateObject
  });
});

describe('AttemptToPlaceInContainer_IsItemLegal @ 005870c0 — yourself and creatures', () => {
  it('the player cannot be placed in a container', () => {
    const w = makeWorld([]);
    expect(isItemLegalHead(PLAYER, w)).toBe(ITEM_LEGAL_STRINGS.self);
    expect(attemptToPlaceInContainer(PLAYER, PLAYER, 0, true, 0, w)).toEqual({ kind: 'refused', notice: 'You cannot place yourself within a container!' });
  });

  it('a creature (another player too) cannot be picked up — nothing is sent', () => {
    const other = 0x50000002;
    const w = makeWorld([{ id: other, name: 'Bob', itemType: 0x10, isPlayer: true }]);
    expect(placeInBackpack(other, 0, false, w)).toEqual({ kind: 'refused', notice: 'You cannot pick up creatures!' });
  });

  it('a stuck object in no container cannot be picked up; inside a container it can (the branch keys on both)', () => {
    const w = makeWorld([
      { id: 0x70000002, name: 'Chest', stuck: true, isContainer: true, holder: true, itemsCapacity: -1 },
      { id: 0x70000003, name: 'Ring', stuck: true, contained: true },
    ]);
    expect(isItemLegalHead(0x70000002, w)).toBe('The Chest cannot be picked up!');
    expect(isItemLegalHead(0x70000003, w)).toBeNull();
  });

  it('something another creature wields is refused; a worn item of your own is not', () => {
    const w = makeWorld([
      { id: 0x70000004, name: 'Sword', contained: true, wieldedLocation: 0x100000 },
      { id: 0x70000005, name: 'Helm', contained: true, ownedByPlayer: true, wieldedLocation: 0x1 },
    ]);
    expect(isItemLegalHead(0x70000004, w)).toBe('The Sword is being wielded by someone else!');
    expect(isItemLegalHead(0x70000005, w)).toBeNull();
  });

  it('a container that holds containers (a corpse) cannot be picked up; a side pack can', () => {
    const w = makeWorld([
      { id: 0x70000006, name: 'Corpse of Drudge', isContainer: true, holder: true, itemsCapacity: -1, containersCapacity: 1 },
      { id: 0x70000007, name: 'Pack', isContainer: true, holder: true, itemsCapacity: 24 },
    ]);
    expect(placeInBackpack(0x70000006, 0, false, w)).toEqual({ kind: 'refused', notice: "The Corpse of Drudge can't be picked up!" });
    expect(isItemLegalHead(0x70000007, w)).toBeNull();
  });

  it('an ordinary item is unaffected', () => {
    const w = makeWorld([{ id: 0x70000001, itemType: 0x80 }]);
    expect(isItemLegalHead(0x70000001, w)).toBeNull();
    expect(placeInBackpack(0x70000001, 0, false, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
  });
});

// ── GameUI: the main-pack cell drags onto the toolbar ─────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI — the main pack is a drag source the toolbar takes', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let calls: string[];
  let shortcutObjects: number[];
  const slots: HTMLElement[] = [];

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
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
  }
  const item = (id: number, name: string, containerId: number, itemType = 0) => ({
    id, weenieClassId: id & 0xffff, name, value: 1, burden: 10, stackSize: 1, maxStackSize: 1, stackable: false, containerId, itemType,
  });

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
    for (let i = 0; i < 18; i++) {
      const el = domWindow.document.createElement('div');
      ui.itemShortcutSlots[i] = el;
      ui.bindItemShortcutSlot(el, i);
      ui.applyItemShortcutSlot(i);
      slots[i] = el;
    }
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  beforeEach(() => {
    calls = [];
    shortcutObjects = new Array(18).fill(0);
    ui.itemShortcutObjectAt = (i: number) => shortcutObjects[i] ?? 0;
    ui.itemShortcutCallbacks = {
      onDropItem: (s: number, src: unknown) => calls.push(`dropItem ${s} ${JSON.stringify(src)}`),
      onDropShortcut: (s: number) => calls.push(`dropShortcut ${s}`),
      onDropPlayer: (s: number, guid: number) => calls.push(`dropPlayer ${s} ${guid.toString(16)}`),
    };
    ui.onSelectObject = (guid: number) => calls.push(`select ${guid.toString(16)}`);
    ui.setDragCallbacks({ onItemListDrop: () => calls.push('itemListDrop') });
    ui.setInventoryOwner('Tester', 0);
    ui.setSidePackGuids([PLAYER, PACK]);
    ui.setInventoryData([item(KIT, 'Healing Kit', PLAYER), item(PACK, 'Pack', PLAYER, 0x200)], [], 30, 15000);
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  const fire = (el: Element, type: string): Event => {
    const e = new domWindow.Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };
  const packTabs = (): HTMLElement[] => {
    const strip = ui.inventoryPanelHandle.elements.get(0x100001ce);
    return [...strip.children].filter((c: HTMLElement) => c.dataset.acTooltipText) as HTMLElement[];
  };

  it('the main-pack cell is draggable and selects the player as the drag starts (ItemList_BeginDrag)', () => {
    const main = packTabs()[0];
    expect(main.dataset.acTooltipText).toBe('Tester');
    expect(main.draggable).toBe(true);
    fire(main, 'dragstart');
    expect(calls).toEqual([`select ${PLAYER.toString(16)}`]);
    expect(ui.worldDropSource()).toBeNull(); // not an inventory item: only the toolbar takes it
    ui.settleItemDragWaiting();
  });

  it('dropped on a toolbar slot it becomes a shortcut to the player', () => {
    fire(packTabs()[0], 'dragstart');
    expect(fire(slots[4], 'dragover').defaultPrevented).toBe(true);
    fire(slots[4], 'drop');
    expect(calls).toContain(`dropPlayer 4 ${PLAYER.toString(16)}`);
    expect(calls.some((c) => c.startsWith('dropItem'))).toBe(false);
    // The drag is over: a later slot is not offered anything.
    expect(fire(slots[5], 'dragover').defaultPrevented).toBe(false);
  });

  it('released anywhere else the drag ends with nothing sent', () => {
    fire(packTabs()[0], 'dragstart');
    expect(fire(packTabs()[1], 'dragover').defaultPrevented).toBe(false);
    fire(packTabs()[0], 'dragend');
    ui.settleItemDragWaiting();
    expect(calls).toEqual([`select ${PLAYER.toString(16)}`]);
    expect(fire(slots[4], 'dragover').defaultPrevented).toBe(false);
  });

  it('a toolbar shortcut to the player draws the IsThePlayer icon composite', () => {
    const spy = vi.spyOn(ui, 'buildItemIconElement');
    ui.setItemShortcutIcon(7, undefined, 'Tester', playerItem);
    expect(spy).toHaveBeenCalledWith(undefined, 32, undefined, undefined, { isThePlayer: true });
    spy.mockRestore();
  });

  it('the main-pack cell carries the shortcut tag of the slot holding the player (UIItem_Update → SetShortcutNum)', () => {
    shortcutObjects[2] = PLAYER;
    ui.renderInventoryPanel();
    const inset = packTabs()[0].querySelector('[data-pack-shortcut-cell]') as HTMLElement;
    expect(inset).toBeTruthy();
    expect(inset.querySelector('[data-shortcut-tag]')).toBeTruthy();
    // A side pack's cell shows none while it has no shortcut.
    expect(packTabs()[1].querySelector('[data-pack-shortcut-cell] [data-shortcut-tag]')).toBeNull();
  });

  it('a side pack with a shortcut shows its tag in the pack column too', () => {
    shortcutObjects[0] = PACK;
    ui.renderInventoryPanel();
    expect(packTabs()[1].querySelector('[data-pack-shortcut-cell] [data-shortcut-tag]')).toBeTruthy();
  });

  it('using the shortcut opens the inventory on the main pack (RecvNotice_OpenContainedContainer)', () => {
    ui.selectedPackSlot = 1;
    ui.renderInventoryPanel();
    ui.toggleInventory(); // hidden
    expect(ui.inventoryVisible).toBe(false);
    expect(ui.openContainedContainer(PLAYER)).toBe(true);
    expect(ui.inventoryVisible).toBe(true);
    expect(ui.getSelectedPackSlot()).toBe(0);
    expect(ui.openContainedContainer(0x80009999)).toBe(false);
  });
});

describe('GameUI — the open container strip\'s pack cells drag like its item row', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const CHEST = 0x80001000;
  const POUCH = 0x80002000;
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];

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
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); }, destroy: () => { root.remove(); },
        };
      },
      render: (_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent)),
    };
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  beforeEach(() => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Wooden Chest', iconDid: 0 });
    ui.setContainerPackGuids([CHEST, POUCH]);
    ui.updateContainerItems([
      { guid: POUCH, name: 'Leather Pouch', iconDid: 0, stackSize: 1, containerId: CHEST, isContainer: true },
    ]);
  });

  const tab = (guid: number): HTMLElement => ui.containerPanel.querySelector(`[data-ac-container-tab="${guid}"]`);
  const fire = (el: Element, type: string): void => { el.dispatchEvent(new domWindow.Event(type, { bubbles: true, cancelable: true })); };

  it('a nested pack (m_containerList) is a drag source carrying the pack as a ground object, ghosted while dragged', () => {
    expect(tab(POUCH).draggable).toBe(true);
    fire(tab(POUCH), 'dragstart');
    expect(ui.worldDropSource()).toEqual({ kind: 'world', guid: POUCH });
    expect(tab(POUCH).querySelector('[data-waiting-ghost]')).toBeTruthy();
    fire(tab(POUCH), 'dragend');
    ui.settleItemDragWaiting();
    expect(ui.worldDropSource()).toBeNull();
    expect(tab(POUCH).querySelector('[data-waiting-ghost]')).toBeNull();
  });

  it('the ground container itself (m_topContainer) drags too; the drop target refuses it', () => {
    expect(tab(CHEST).draggable).toBe(true);
    fire(tab(CHEST), 'dragstart');
    expect(ui.worldDropSource()).toEqual({ kind: 'world', guid: CHEST });
    fire(tab(CHEST), 'dragend');
  });
});
