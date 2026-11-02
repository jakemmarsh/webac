/**
 * VISUAL.drag-merge-indicator, the AC1999 half: the drag-over art of the
 * widgets the first pass left on end of retail's handlers (progress.md
 * 2026-11-01, "Not ported").
 *
 * The 1999 client.exe (reference/ac1999/Client/decomp):
 *  - Toolbar backpack button: InventoryButton_DragOverAction @ 0x005014d0
 *    (Region slot 42 of vtable 0x6020d0): for an item drag, the red circle
 *    0x060011f8 when the object's type is 0 or exactly 0x10 (a creature, the
 *    player too) or it is stuck (0x004e4d70), else the arrow 0x060011f7.
 *    InventoryButton_DrawThis @ 0x00501420 puts the arrow at (31,0) and the
 *    circle at (15,13). End of retail (gmToolbarUI::HandleInventoryButtonDragOver
 *    @ 004bd180): the arrow for any object.
 *  - Open chest / corpse: the ItemEnvPanel (ctor @ 0x00538e00) holds three
 *    ItemLists (ctor @ 0x0053a350, the inventory's class), so its cells take
 *    the ItemList drag-over (DragOverAction @ 0x0053a650, Global_Loop
 *    @ 0x0053a790, the UI_Item draw @ 0x004e7d20), not end of retail's
 *    gmExternalContainerUI::OnItemListDragOver.
 *  - Vendor: every list is a ShopList (DragOverAction @ 0x005a95b0): the wares
 *    (flags 0x422) and buy list (0x544) refuse an item drag, the sell list
 *    (0x1af9) refuses an object the player does not carry and asks the vendor
 *    profile for one it does.
 *  - The main-pack cell (the player, InventoryPanel_PlayerInitialized
 *    @ 0x005244c0) drags as any item does, so those widgets answer it.
 *
 * Drives the shipped UIItemDragAccept rules and the real GameUI (happy-dom,
 * stub layout renderer) per era; end of retail / Dark Majesty pinned unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  COMBAT_BUTTON_DRAG_TEX, DRAG_ACCEPT_INTO, DRAG_ACCEPT_STATE, INVENTORY_BUTTON_DRAG_TEX, MAIN_PACK_DRAG_IS_CONTAINER_DRAG, SHORTCUT_SLOT_1999_DRAG_TEX,
  combatButtonDragArtAt, combatButtonDragOverState, combatButtonDropWields,
  externalContainerCellHasDragArt, externalContainerDragOverState, inventoryButtonDragArtAt,
  inventoryButtonDragOverState, paperdollFigureDragOverlayState, shortcutSlotDragOverState, spellBarDragOverState,
  vendorListDragOverState, vendorListHasDragArt,
} from '../packages/renderer/src/ui/UIItemDragAccept.js';
import { paperdollBandDragAcceptState, paperdollSlotDragAcceptState } from '../packages/renderer/src/inventory/PaperdollDragObject.js';
import { CLIENT_NOTICES } from '../packages/renderer/src/ui/ClientNotices.js';
import { shortcutDropIntoContainer1999 } from '../packages/renderer/src/network/itemShortcutRestore.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const RING = DRAG_ACCEPT_STATE.accept;
const CIRCLE = DRAG_ACCEPT_STATE.refuse;
const NONE = DRAG_ACCEPT_STATE.none;
const ARROW = DRAG_ACCEPT_INTO;
const PLAYER = 0x50000001;

describe('the era rules (UIItemDragAccept)', () => {
  it('every era names a rule: end of retail and Dark Majesty keep end of retail\'s, 1999 its own', () => {
    expect(eraClientRules(null).itemListDragOver).toBe('eor');
    expect(eraClientRules(eraProfile('classic-dereth')).itemListDragOver).toBe('eor');
    expect(eraClientRules(eraProfile('ac1999-retail')).itemListDragOver).toBe('ac1999');
  });

  it('backpack button, end of retail: the arrow for any object, whatever it is', () => {
    expect(inventoryButtonDragOverState('eor', 5, { itemType: 0x10 })).toBe(ARROW);
    expect(inventoryButtonDragOverState('eor', 5, { stuck: true })).toBe(ARROW);
    expect(inventoryButtonDragOverState('eor', 5, undefined)).toBe(ARROW);
    expect(inventoryButtonDragOverState('eor', 0, { itemType: 2 })).toBeNull();
    expect(inventoryButtonDragOverState('eor', 5, { itemType: 2 }, true)).toBeNull();
    expect(inventoryButtonDragArtAt('eor', ARROW)).toEqual({ x: 31, y: 0 });
  });

  it('backpack button, 1999: the circle for an untyped, creature or stuck object, the arrow otherwise', () => {
    expect(inventoryButtonDragOverState('ac1999', 5, { itemType: 0x2 })).toBe(ARROW); // armor
    expect(inventoryButtonDragOverState('ac1999', 5, { itemType: 0x200 })).toBe(ARROW); // a pack
    expect(inventoryButtonDragOverState('ac1999', 5, { itemType: 0 })).toBe(CIRCLE);
    expect(inventoryButtonDragOverState('ac1999', 5, { itemType: 0x10 })).toBe(CIRCLE);
    expect(inventoryButtonDragOverState('ac1999', 5, { itemType: 0x80, stuck: true })).toBe(CIRCLE);
    expect(inventoryButtonDragOverState('ac1999', 5, { isPlayer: true })).toBe(CIRCLE);
    // The 1999 compare is ==, not a mask: a creature bit beside another type is not a creature.
    expect(inventoryButtonDragOverState('ac1999', 5, { itemType: 0x11 })).toBe(ARROW);
    // No weenie object (the drag item's +0xc4 getter @ 0x004f51e0 gives 0) or no item drag → nothing.
    expect(inventoryButtonDragOverState('ac1999', 5, undefined)).toBeNull();
    expect(inventoryButtonDragOverState('ac1999', 0, { itemType: 2 })).toBeNull();
    // InventoryButton_DrawThis @ 0x00501420.
    expect(inventoryButtonDragArtAt('ac1999', ARROW)).toEqual({ x: 0x1f, y: 0 });
    expect(inventoryButtonDragArtAt('ac1999', CIRCLE)).toEqual({ x: 0xf, y: 0xd });
    expect(INVENTORY_BUTTON_DRAG_TEX[ARROW]).toBe(0x060011f7);
    expect(INVENTORY_BUTTON_DRAG_TEX[CIRCLE]).toBe(0x060011f8);
    expect(INVENTORY_BUTTON_DRAG_TEX[NONE]).toBeUndefined();
  });

  it('the main-pack drag is a container-list drag (end of retail: 0x100001c9 p0x10000011 = true)', () => {
    expect(MAIN_PACK_DRAG_IS_CONTAINER_DRAG).toBe(true);
  });

  it('combat button: end of retail and Dark Majesty take no drop; 1999 does (0x00502180)', () => {
    expect(eraClientRules(null).combatButtonWieldDrop).toBe(false);
    expect(eraClientRules(eraProfile('classic-dereth')).combatButtonWieldDrop).toBe(false);
    expect(eraClientRules(eraProfile('ac1999-retail')).combatButtonWieldDrop).toBe(true);
    // No drop taken → no art, whatever is dragged.
    expect(combatButtonDragOverState(false, 5, { combatUse: 1 })).toBeNull();
  });

  it('combat button, 1999 (DragOverAction @ 0x005020b0): the ring for a combat use or a caster, the circle otherwise', () => {
    expect(combatButtonDragOverState(true, 5, { combatUse: 1 })).toBe(RING); // melee
    expect(combatButtonDragOverState(true, 5, { combatUse: 2 })).toBe(RING); // missile
    expect(combatButtonDragOverState(true, 5, { combatUse: 3 })).toBe(RING); // ammo
    expect(combatButtonDragOverState(true, 5, { combatUse: 4 })).toBe(RING); // shield
    expect(combatButtonDragOverState(true, 5, { itemType: 0x8000 })).toBe(RING); // TYPE_CASTER
    expect(combatButtonDragOverState(true, 5, { itemType: 0x8100 })).toBe(RING); // a mask, not ==
    expect(combatButtonDragOverState(true, 5, { itemType: 0x2 })).toBe(CIRCLE); // armor
    expect(combatButtonDragOverState(true, 5, { itemType: 0x10 })).toBe(CIRCLE); // the player
    expect(combatButtonDragOverState(true, 5, undefined)).toBe(CIRCLE); // no object known
    expect(combatButtonDragOverState(true, 0, { combatUse: 1 })).toBeNull(); // no item drag
    expect(combatButtonDragOverState(true, 5, { combatUse: 1 }, true)).toBeNull(); // a shortcut
    expect(COMBAT_BUTTON_DRAG_TEX[RING]).toBe(0x060011f9);
    expect(COMBAT_BUTTON_DRAG_TEX[CIRCLE]).toBe(0x060011f8);
    expect(COMBAT_BUTTON_DRAG_TEX[NONE]).toBeUndefined();
    // DrawThis @ 0x00501fc0: centred on the 55x58 button.
    expect(combatButtonDragArtAt(55, 58)).toEqual({ x: 11, y: 13 });
  });

  it('combat button, 1999 drop (AcceptDragObject @ 0x00502180): wields what the ring shows, refuses the rest out loud', () => {
    expect(combatButtonDropWields({ combatUse: 1 })).toBe(true);
    expect(combatButtonDropWields({ itemType: 0x8000 })).toBe(true);
    expect(combatButtonDropWields({ itemType: 0x2 })).toBe(false);
    expect(combatButtonDropWields({ combatUse: 0, itemType: 0x10 })).toBe(false);
    expect(combatButtonDropWields(undefined)).toBe(false);
    expect(CLIENT_NOTICES.combatButtonNotWieldable.text).toBe('Only weaponry, shields, and magic items can be auto-wielded');
  });

  it('spell bar: the ring for a spell drag in both eras, nothing for any other drag', () => {
    expect(spellBarDragOverState(true)).toBe(RING);
    expect(spellBarDragOverState(false)).toBeNull();
  });

  it('paperdoll figure: end of retail at (33,68) of the band, 1999 at (32,65); "already worn" keeps vs clears', () => {
    expect(eraClientRules(null).paperdollFigureDragArt).toEqual({ x: 33, y: 68, wornDrawsNothing: false });
    expect(eraClientRules(eraProfile('classic-dereth')).paperdollFigureDragArt).toEqual({ x: 33, y: 68, wornDrawsNothing: false });
    // 0x00526f90: (+0x53,+0x58) of the InventoryPanel; the band sits at (51,23) of ours.
    expect(eraClientRules(eraProfile('ac1999-retail')).paperdollFigureDragArt).toEqual({ x: 32, y: 65, wornDrawsNothing: true });
    expect(paperdollFigureDragOverlayState(RING, false)).toBe(RING);
    expect(paperdollFigureDragOverlayState(CIRCLE, true)).toBe(CIRCLE);
    expect(paperdollFigureDragOverlayState(null, false)).toBeUndefined();
    expect(paperdollFigureDragOverlayState(null, true)).toBe(NONE);
  });

  it('paperdoll: the player (the main-pack drag) is not wearable or wieldable, so the circle on the figure and every slot', () => {
    const ctx = { playerId: PLAYER, equipped: [], inCombat: false, readyRefusal: null, slotDropSwaps: false, dualWieldShieldSlot: true };
    const player = { id: PLAYER, name: 'Tester', validLocations: 0 };
    expect(paperdollBandDragAcceptState(player, ctx)).toBe(CIRCLE);
    expect(paperdollSlotDragAcceptState(player, 0x1, ctx)).toBe(CIRCLE);
    expect(paperdollSlotDragAcceptState(player, 0x100000, ctx)).toBe(CIRCLE);
  });

  it('vendor lists: end of retail\'s sell list alone; every 1999 ShopList', () => {
    expect(vendorListHasDragArt('eor', 'sell')).toBe(true);
    expect(vendorListHasDragArt('eor', 'items')).toBe(false);
    expect(vendorListHasDragArt('eor', 'buy')).toBe(false);
    for (const l of ['items', 'buy', 'sell'] as const) expect(vendorListHasDragArt('ac1999', l)).toBe(true);
  });

  it('vendor lists, end of retail: the sell verdict, unchanged; nothing elsewhere', () => {
    expect(vendorListDragOverState('eor', 'sell', { draggedId: 5, sell: () => RING })).toBe(RING);
    expect(vendorListDragOverState('eor', 'sell', { draggedId: 5, sell: () => null })).toBeNull(); // a ground object
    expect(vendorListDragOverState('eor', 'items', { draggedId: 5, sell: () => RING })).toBeNull();
  });

  it('vendor lists, 1999: wares and buy list refuse; the sell list refuses what the player does not carry', () => {
    let asked = 0;
    const sell = (v: number | null) => () => { asked++; return v; };
    expect(vendorListDragOverState('ac1999', 'items', { draggedId: 5, sell: sell(RING) })).toBe(CIRCLE);
    expect(vendorListDragOverState('ac1999', 'buy', { draggedId: 5, sell: sell(RING) })).toBe(CIRCLE);
    expect(asked).toBe(0);
    expect(vendorListDragOverState('ac1999', 'sell', { draggedId: 5, sell: sell(RING) })).toBe(RING);
    expect(vendorListDragOverState('ac1999', 'sell', { draggedId: 5, sell: sell(CIRCLE) })).toBe(CIRCLE);
    expect(vendorListDragOverState('ac1999', 'sell', { draggedId: 5, sell: sell(null) })).toBe(CIRCLE); // not carried
    // No drag: untouched; the main-pack drag on the sell list: untouched (0x004e5530 not traced).
    expect(vendorListDragOverState('ac1999', 'sell', { draggedId: 0, sell: sell(RING) })).toBeNull();
    expect(vendorListDragOverState('ac1999', 'sell', { draggedId: 9, isPlayer: true, sell: sell(RING) })).toBeNull();
    expect(vendorListDragOverState('ac1999', 'items', { draggedId: 9, isPlayer: true, sell: sell(RING) })).toBe(CIRCLE);
  });

  describe('toolbar shortcut slots', () => {
    const full = { splitSize: 5, maxSplitSize: 5 };
    const potion = { id: 0x80000010, itemType: 0x80, usable: 0x2 }; // USEABLE_SELF; bit 1 is USEABLE_NO
    const junk = { id: 0x80000011, itemType: 0x20000000, usable: 0x1 }; // USEABLE_NO
    const sidePack = { id: 0x80000012, itemType: 0x200, isContainer: true };
    const sackOfPacks = { id: 0x80000013, itemType: 0x200, isContainer: true, holdsPacks: true };
    const mainPack = { id: PLAYER, itemType: 0x10, isPlayer: true, isContainer: true, holdsPacks: true };
    const drudge = { id: 0x70000001, itemType: 0x10, usable: 0x2 };
    const over = (rule: 'eor' | 'ac1999', dragged: object | undefined, slot: object | null, extra: Record<string, unknown> = {}) =>
      shortcutSlotDragOverState(rule, { carries: true, shortcutDrag: false, dragged, slot, split: full, ...extra } as Parameters<typeof shortcutSlotDragOverState>[1]);

    it('end of retail: the add-shortcut box (0x1000045f) for anything carried, unchanged', () => {
      expect(over('eor', junk, sidePack)).toEqual({ state: RING, template: '1000045f' });
      expect(over('eor', undefined, null)).toEqual({ state: RING, template: '1000045f' });
      expect(shortcutSlotDragOverState('eor', { carries: false, shortcutDrag: false, split: full })).toBeNull();
    });

    it('1999 (ShortcutSlot_DragOverAction @ 0x005004b0): the arrow onto a container\'s shortcut, from the 1999 table', () => {
      expect(over('ac1999', potion, sidePack)).toEqual({ state: ARROW, template: 'shortcut1999' });
      expect(over('ac1999', junk, sidePack)?.state).toBe(ARROW); // into the pack whatever it is
      expect(over('ac1999', potion, mainPack)?.state).toBe(ARROW); // the main pack's shortcut is a container
      expect(over('ac1999', sidePack, mainPack)?.state).toBe(ARROW); // a pack holding no packs into one that does
      expect(over('ac1999', sidePack, sidePack)?.state).toBe(RING); // a pack onto a pack: a shortcut
      expect(over('ac1999', sackOfPacks, mainPack)?.state).toBe(RING);
      // A shortcut moved between slots never goes in (the arrow wants UI_Item type 1).
      expect(over('ac1999', potion, sidePack, { shortcutDrag: true })?.state).toBe(RING);
      expect(SHORTCUT_SLOT_1999_DRAG_TEX[ARROW]).toBe(0x060011f7);
      expect(SHORTCUT_SLOT_1999_DRAG_TEX[RING]).toBe(0x060011fa);
      expect(SHORTCUT_SLOT_1999_DRAG_TEX[CIRCLE]).toBe(0x060011f8);
    });

    it('1999: else the box for what can be a shortcut (DetermineUseResult @ 0x004fe720), the circle otherwise', () => {
      expect(over('ac1999', potion, null)?.state).toBe(RING);
      expect(over('ac1999', mainPack, null)?.state).toBe(RING); // the player: a container
      expect(over('ac1999', junk, null)?.state).toBe(CIRCLE); // not usable
      expect(over('ac1999', drudge, sidePack)?.state).toBe(CIRCLE); // a creature: neither in nor a shortcut
      expect(over('ac1999', { ...potion, stuck: true }, null)?.state).toBe(CIRCLE);
      expect(over('ac1999', potion, null, { split: { splitSize: 2, maxSplitSize: 5 } })?.state).toBe(CIRCLE);
      expect(over('ac1999', undefined, null)?.state).toBe(CIRCLE); // no object known
    });

    it('the drop follows the same into-container test (ShortcutSlot_AcceptDragObject @ 0x00500240)', () => {
      expect(shortcutDropIntoContainer1999(potion, mainPack)).toBe(true);
      expect(shortcutDropIntoContainer1999(sidePack, mainPack)).toBe(true);
      expect(shortcutDropIntoContainer1999(sackOfPacks, mainPack)).toBe(false);
      expect(shortcutDropIntoContainer1999(drudge, sidePack)).toBe(false);
      expect(shortcutDropIntoContainer1999(potion, { id: 0x80000020, itemType: 0x80 })).toBe(false);
    });
  });

  it('external container: end of retail answers its filled item cells only; 1999 every cell, by the pack lists\' rule', () => {
    expect(externalContainerCellHasDragArt('eor', 'item')).toBe(true);
    expect(externalContainerCellHasDragArt('eor', 'emptyItem')).toBe(false);
    expect(externalContainerCellHasDragArt('eor', 'pack')).toBe(false);
    for (const c of ['item', 'emptyItem', 'pack'] as const) expect(externalContainerCellHasDragArt('ac1999', c)).toBe(true);
    const lists: boolean[] = [];
    const itemList = (containerList: boolean) => { lists.push(containerList); return ARROW; };
    expect(externalContainerDragOverState('eor', 'item', () => CIRCLE, itemList)).toBe(CIRCLE);
    expect(externalContainerDragOverState('eor', 'pack', () => CIRCLE, itemList)).toBeNull();
    expect(lists).toEqual([]);
    expect(externalContainerDragOverState('ac1999', 'item', () => CIRCLE, itemList)).toBe(ARROW);
    expect(externalContainerDragOverState('ac1999', 'emptyItem', () => CIRCLE, itemList)).toBe(ARROW);
    expect(externalContainerDragOverState('ac1999', 'pack', () => CIRCLE, itemList)).toBe(ARROW);
    expect(lists).toEqual([false, false, true]);
  });
});

// ── The real GameUI ──────────────────────────────────────────────────────────

/** A LayoutRenderer stand-in whose handles create any element asked for. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(H: GameUIFixture): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement) => {
    const root = doc.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = doc.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        el.style.width = '480px';
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop, resizeSubtree: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  return {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null,
    getResolvedLayout: () => null,
    setFontResolver: () => {},
  };
}

const ARROWS = 0x8000aaaa;
const CHEST = 0x70112233;
const LOOT = 0x70440001;
const BAG = 0x70440002;
const STUCK = 0x70440003;

for (const era of ['eor', 'classic-dereth', 'ac1999-retail'] as const) {
  const is1999 = era === 'ac1999-retail';
  describe(`GameUI drag-over art, era ${era}`, () => {
    let H: GameUIFixture;
    let ui: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const asked: Array<{ guid: number; containerList: boolean; cellObjectId: number }> = [];
    const askedFrom: boolean[] = [];
    const fire = (el: Element, type: string, init: Record<string, unknown> = {}, types?: string[]): Event => {
      const e = new H.win.Event(type, { bubbles: true, cancelable: true, ...init });
      if (types) Object.defineProperty(e, 'dataTransfer', { value: { types, setData: () => {}, setDragImage: () => {} } });
      el.dispatchEvent(e);
      return e;
    };
    const overlayOf = (el: Element): HTMLElement | null => el.querySelector(':scope > [data-ac-drag-accept]');

    beforeAll(async () => {
      H = await mountGameUI();
      ui = H.ui;
      ui.layoutRenderer = stubLayoutRenderer(H);
      ui.setClientRules(eraClientRules(eraProfile(era === 'eor' ? null : era)));
      for (const [id, url] of [[0x060011f7, 'data:arrow'], [0x060011f8, 'data:circle'], [0x060011f9, 'data:ring']] as const) ui.uiTextures.set(id, url);
      ui.setDragCallbacks({
        itemListDragAcceptState: (guid: number, d: { fromContainerList: boolean; containerList: boolean; cellObjectId: number }) => {
          asked.push({ guid, containerList: d.containerList, cellObjectId: d.cellObjectId });
          askedFrom.push(d.fromContainerList);
          return d.containerList ? ARROW : RING;
        },
        inventoryButtonDragObject: (guid: number) => guid === PLAYER ? { isPlayer: true }
          : guid === STUCK ? { itemType: 0x80, stuck: true } : { itemType: 0x100 },
      });
      ui.setInventoryOwner('Tester', 0);
      ui.setSidePackGuids([PLAYER]);
      ui.setInventoryData([{
        id: ARROWS, weenieClassId: 300, name: 'Arrow', value: 42, burden: 1, itemType: 0x100,
        stackSize: 42, maxStackSize: 250, stackable: true, containerId: PLAYER,
      }], [], 30, 15000);
      ui.uiManager.setScreen('game');
      ui.renderHUD();
      if (!ui.inventoryVisible) ui.toggleInventory();
    }, 60_000);
    afterAll(() => H?.teardown());

    const packDrag = (): HTMLElement => {
      const grid = ui.inventoryPanelHandle.elements.get(0x100001cf);
      const cell = [...grid.querySelectorAll('div')].find((c: HTMLElement) => c.draggable === true) as HTMLElement;
      fire(cell, 'dragstart');
      return cell;
    };
    const endPackDrag = (cell: HTMLElement): void => { fire(cell, 'dragend'); ui.settleItemDragWaiting?.(); };
    const mainPackDrag = (): HTMLElement => {
      const strip = ui.inventoryPanelHandle.elements.get(0x100001ce);
      const main = [...strip.children].find((c: HTMLElement) => c.draggable === true) as HTMLElement;
      fire(main, 'dragstart');
      return main;
    };

    describe('the toolbar backpack button', () => {
      const button = (): HTMLElement => H.win.document.getElementById('tb-inv');
      const art = (): HTMLElement => button().querySelector('[data-element-id="0x1000046c"]') as HTMLElement;

      it('a carried item: the arrow at (31,0), cleared when the drag leaves, and by the drop', () => {
        const cell = packDrag();
        expect(fire(button(), 'dragover').defaultPrevented).toBe(true);
        expect(art().dataset.acState).toBe('10000046');
        expect(art().style.backgroundImage).toContain('data:arrow');
        expect([art().style.left, art().style.top]).toEqual(['31px', '0px']);
        fire(button(), 'dragleave');
        expect(art().dataset.acState).toBe('1000003f');
        expect(art().style.backgroundImage).toBe('none');
        fire(button(), 'dragover');
        expect(art().dataset.acState).toBe('10000046');
        fire(button(), 'drop');
        expect(art().dataset.acState).toBe('1000003f');
        endPackDrag(cell);
      });

      it(is1999 ? 'a stuck ground object: the red circle, centred (InventoryButton_DrawThis @ 0x00501420)' : 'a stuck ground object: the arrow, as for anything (004bd180)', () => {
        ui.beginWorldDrag(STUCK);
        fire(button(), 'dragover');
        expect(art().dataset.acState).toBe(is1999 ? '10000041' : '10000046');
        expect(art().style.backgroundImage).toContain(is1999 ? 'data:circle' : 'data:arrow');
        expect([art().style.left, art().style.top]).toEqual(is1999 ? ['15px', '13px'] : ['31px', '0px']);
        fire(button(), 'dragleave');
        expect(art().dataset.acState).toBe('1000003f');
        // The next drag's arrow goes back to the corner.
        ui.endWorldDrag();
        const cell = packDrag();
        fire(button(), 'dragover');
        expect([art().style.left, art().style.top]).toEqual(['31px', '0px']);
        fire(button(), 'drop');
        endPackDrag(cell);
      });

      it(is1999 ? 'the main-pack drag (the player, a creature): the circle; nothing is accepted'
        : 'the main-pack drag: the arrow, as for any object (004bd180); nothing is accepted', () => {
        const main = mainPackDrag();
        expect(fire(button(), 'dragover').defaultPrevented).toBe(false);
        expect(art().dataset.acState).toBe(is1999 ? '10000041' : '10000046');
        fire(button(), 'dragleave');
        expect(art().dataset.acState).toBe('1000003f');
        fire(main, 'dragend');
        ui.settleItemDragWaiting?.();
      });
    });

    describe('a toolbar shortcut slot', () => {
      const SATCHEL = 0x80000300;
      it(is1999 ? 'a carried item over a pack\'s shortcut: the 1999 arrow; over an empty slot the box; cleared on leave and drop' : 'any carried item: 0x1000045f\'s add-shortcut box (unchanged)', () => {
        const slot = ui.itemShortcutSlots.find((s: HTMLElement | undefined) => !!s) as HTMLElement;
        expect(slot).toBeTruthy();
        const index = Number(slot.dataset.itemShortcut);
        ui.itemShortcutObjectAt = (i: number) => (i === index ? SATCHEL : 0);
        ui.setDragCallbacks({
          ...ui.dragCallbacks,
          shortcutSlotDragObject: (guid: number) => guid === SATCHEL ? { id: SATCHEL, itemType: 0x200, isContainer: true }
            : guid === ARROWS ? { id: ARROWS, itemType: 0x100, combatUse: 2 } : undefined,
        });
        const cell = packDrag();
        expect(fire(slot, 'dragover').defaultPrevented).toBe(true);
        const o = overlayOf(slot) as HTMLElement;
        expect(o.dataset.acDragTemplate).toBe(is1999 ? 'shortcut1999' : '1000045f');
        expect(o.dataset.acDragAccept).toBe(String(is1999 ? ARROW : RING));
        fire(slot, 'dragleave');
        expect(o.dataset.acDragAccept).toBe(String(NONE));
        ui.itemShortcutObjectAt = () => 0;
        fire(slot, 'dragover');
        expect(o.dataset.acDragAccept).toBe(String(RING)); // the box: arrows can be a shortcut
        fire(slot, 'drop');
        expect(o.dataset.acDragAccept).toBe(String(NONE));
        endPackDrag(cell);
        ui.itemShortcutObjectAt = null;
      });
    });

    describe('the pack column under the main-pack drag', () => {
      it('the pack column asks the list rule for the player, as a container-list drag (InqDropIconInfo @ 004e26f0)', () => {
        asked.length = 0;
        askedFrom.length = 0;
        const main = mainPackDrag();
        const strip = ui.inventoryPanelHandle.elements.get(0x100001ce);
        const inset = strip.querySelector('[data-ac-drag-template="1000045e"]')?.parentElement as HTMLElement;
        fire(inset, 'dragover');
        expect(asked.map((a) => a.guid)).toEqual([PLAYER]);
        expect(askedFrom).toEqual([true]);
        expect(overlayOf(inset)?.dataset.acDragAccept).toBe(String(ARROW));
        fire(inset, 'dragleave');
        expect(overlayOf(inset)?.dataset.acDragAccept).toBe(String(NONE));
        fire(main, 'dragend');
        ui.settleItemDragWaiting?.();
      });
    });

    describe('the toolbar combat button (BUG.ac1999-combat-button-drop)', () => {
      const SWORD = ARROWS; // the pack item the grid drags
      const button = (): HTMLElement => H.win.document.getElementById('combat-mode-btn') as HTMLElement;
      const art = (): HTMLElement => button().querySelector('[data-ac-combat-drag-art]') as HTMLElement;
      const drops: number[] = [];
      let facts: Record<number, { combatUse?: number; itemType?: number } | undefined> = {};
      beforeAll(() => {
        ui.setDragCallbacks({
          ...ui.dragCallbacks,
          combatButtonDragObject: (guid: number) => facts[guid],
          onCombatButtonDrop: (guid: number) => { drops.push(guid); },
        });
      });

      it(is1999 ? 'a weapon: the ring centred at (11,13), latched, cleared on leave; the drop clears it and auto-wields'
        : 'a weapon: no art and no drop (the combat button takes none)', () => {
        facts = { [SWORD]: { combatUse: 1 } };
        drops.length = 0;
        const cell = packDrag();
        expect(fire(button(), 'dragover').defaultPrevented).toBe(is1999);
        expect(art().dataset.acDragAccept).toBe(String(is1999 ? RING : NONE));
        if (is1999) {
          expect(art().style.backgroundImage).toContain('data:ring');
          expect([art().style.left, art().style.top]).toEqual(['11px', '13px']);
          // The latch: a later verdict does not replace the first while the drag stays over.
          facts = { [SWORD]: { itemType: 0x2 } };
          fire(button(), 'dragover');
          expect(art().dataset.acDragAccept).toBe(String(RING));
          fire(button(), 'dragleave');
          expect(art().dataset.acDragAccept).toBe(String(NONE));
          expect(art().style.backgroundImage).toBe('none');
          // Entering again: the new verdict (armor → the circle).
          fire(button(), 'dragover');
          expect(art().dataset.acDragAccept).toBe(String(CIRCLE));
          expect(art().style.backgroundImage).toContain('data:circle');
        }
        fire(button(), 'drop');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        expect(drops).toEqual(is1999 ? [SWORD] : []);
        endPackDrag(cell);
      });

      it(is1999 ? 'a ground object and the main-pack drag are item drags too; the drop goes to the callback' : 'a ground object and the main-pack drag: nothing', () => {
        facts = { [LOOT]: { itemType: 0x8000 }, [PLAYER]: { combatUse: 0, itemType: 0x10 } };
        drops.length = 0;
        ui.beginWorldDrag(LOOT);
        fire(button(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(is1999 ? RING : NONE));
        fire(button(), 'drop');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        ui.endWorldDrag();
        const main = mainPackDrag();
        fire(button(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(is1999 ? CIRCLE : NONE));
        fire(button(), 'dragleave');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        fire(button(), 'dragover');
        fire(button(), 'drop');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        fire(main, 'dragend');
        ui.settleItemDragWaiting?.();
        // main.ts refuses the player out loud (combatButtonDropWields); GameUI hands every item drop over.
        expect(drops).toEqual(is1999 ? [LOOT, PLAYER] : []);
      });

      it('a spell or shortcut drag carries no object: nothing in any era', () => {
        const e = fire(button(), 'dragover', {}, ['text/spell-id']);
        expect(e.defaultPrevented).toBe(false);
        expect(art().dataset.acDragAccept).toBe(String(NONE));
      });
    });

    describe('a spell bar cell (VISUAL.ac1999-spellbar-drag-hover)', () => {
      it('a spell drag rings the hovered cell (empty or not); leave and drop clear it; another drag shows nothing', () => {
        const slot = H.win.document.createElement('div');
        H.win.document.body.appendChild(slot);
        ui.wireSpellBarSlotEvents(slot, 0, 0);
        fire(slot, 'dragover', {}, ['text/plain']);
        expect(overlayOf(slot)).toBeNull();
        fire(slot, 'dragover', {}, ['text/spell-id']);
        expect(overlayOf(slot)?.dataset.acDragAccept).toBe(String(RING));
        expect((overlayOf(slot) as HTMLElement).style.backgroundImage).toContain('data:ring');
        fire(slot, 'dragleave');
        expect(overlayOf(slot)?.dataset.acDragAccept).toBe(String(NONE));
        fire(slot, 'dragover', {}, ['text/spell-index']); // a spellbook row
        expect(overlayOf(slot)?.dataset.acDragAccept).toBe(String(RING));
        fire(slot, 'drop', {}, ['text/spell-index']);
        expect(overlayOf(slot)?.dataset.acDragAccept).toBe(String(NONE));
        slot.remove();
      });
    });

    describe('the paperdoll figure and slots (VISUAL.ac1999-paperdoll-figure-drag-art)', () => {
      const WORN = 0x70660001;
      let verdicts: Record<number, number | null> = {};
      const band = (): HTMLElement => ui.inventoryPanelHandle.root.querySelector('[data-element-id="0x100001d6"]') as HTMLElement;
      const art = (): HTMLElement => band().querySelector('[data-element-id="0x1000046d"]') as HTMLElement;
      beforeAll(() => {
        ui.setDragCallbacks({
          ...ui.dragCallbacks,
          paperdollDragAcceptState: (guid: number) => (guid in verdicts ? verdicts[guid] : null),
        });
        ui.renderInventoryPanel();
      });

      it(is1999 ? 'the art sits at (32,65) of the band (0x00526f90)' : 'the art sits at (33,68) of the band (0x1000046d, unchanged)', () => {
        expect(band()).toBeTruthy();
        expect([art().style.left, art().style.top]).toEqual(is1999 ? ['32px', '65px'] : ['33px', '68px']);
      });

      it('ring / circle by the wear verdict; leave and drop clear it', () => {
        verdicts = { [ARROWS]: RING };
        const cell = packDrag();
        fire(band(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(RING));
        fire(band(), 'dragleave');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        verdicts = { [ARROWS]: CIRCLE };
        fire(band(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(CIRCLE));
        fire(band(), 'drop');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        endPackDrag(cell);
      });

      it(is1999 ? 'an item already worn: nothing drawn, even over earlier art' : 'an item already worn: the overlay keeps its state (004a3a70 sets nothing)', () => {
        verdicts = { [WORN]: RING };
        ui.beginWorldDrag(WORN);
        fire(band(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(RING));
        verdicts = { [WORN]: null };
        fire(band(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(is1999 ? NONE : RING));
        fire(band(), 'dragleave');
        expect(art().dataset.acDragAccept).toBe(String(NONE));
        ui.endWorldDrag();
      });

      it('the main-pack drag asks for the player on the figure and on a slot (the circle)', () => {
        verdicts = { [PLAYER]: CIRCLE };
        const main = mainPackDrag();
        fire(band(), 'dragover');
        expect(art().dataset.acDragAccept).toBe(String(CIRCLE));
        fire(band(), 'dragleave');
        const slot = ui.inventoryPanelHandle.root.querySelector('[data-equip-slot]') as HTMLElement;
        expect(slot).toBeTruthy();
        fire(slot, 'dragover');
        expect(overlayOf(slot)?.dataset.acDragAccept).toBe(String(CIRCLE));
        fire(slot, 'dragleave');
        expect(overlayOf(slot)?.dataset.acDragAccept).toBe(String(NONE));
        fire(main, 'dragend');
        ui.settleItemDragWaiting?.();
      });
    });

    describe('the panels\' DragItemAcceptable under the main-pack drag (VISUAL.eor-main-pack-drag-art)', () => {
      it('trade, salvage and vendor sell: the ring (owned, carries items); slumlord with no payment allowed: the circle', () => {
        const main = mainPackDrag();
        expect(ui.tradeDragAcceptStateForCurrentDrag()).toBe(RING);
        expect(ui.salvageDragAcceptStateForCurrentDrag()).toBe(RING);
        expect(ui.vendorSellDragAcceptStateForCurrentDrag()).toBe(RING);
        expect(ui.slumlordDragAcceptStateForCurrentDrag('buy')).toBe(CIRCLE);
        fire(main, 'dragend');
        ui.settleItemDragWaiting?.();
        // No drag: untouched, as before.
        expect(ui.tradeDragAcceptStateForCurrentDrag()).toBeNull();
        expect(ui.salvageDragAcceptStateForCurrentDrag()).toBeNull();
        expect(ui.vendorSellDragAcceptStateForCurrentDrag()).toBeNull();
        expect(ui.slumlordDragAcceptStateForCurrentDrag('buy')).toBeNull();
      });
    });

    describe('an open chest', () => {
      beforeAll(() => {
        ui.showContainerPanel(CHEST, [
          { guid: LOOT, name: 'Sword', iconDid: 0, stackSize: 1, containerId: CHEST },
          { guid: BAG, name: 'Bag', iconDid: 0, stackSize: 1, containerId: CHEST, isContainer: true, itemsCapacity: 24 },
        ], -1, { name: 'Chest' });
        ui.setContainerPackGuids([CHEST, BAG]);
        ui.renderContainerPanel();
      });
      const row = (): HTMLElement => ui.containerPanelHandle.root.querySelector('[data-ac-container-row]');
      const filled = (): HTMLElement => row().querySelector(`[data-ac-container-guid="${LOOT}"]`) as HTMLElement;
      const empty = (): HTMLElement => row().querySelector('[data-ac-container-cell="empty"]') as HTMLElement;
      const packInset = (guid: number): HTMLElement =>
        ui.containerPanelHandle.root.querySelector(`[data-ac-container-pack-guid="${guid}"]`) as HTMLElement;
      const emptyPackInset = (): HTMLElement =>
        ui.containerPanelHandle.root.querySelector('[data-ac-container-pack-empty] > div') as HTMLElement;

      it(is1999 ? 'every cell carries the drag-over overlay (the ItemLists\' UI_Item art)' : 'only the filled item cells carry the overlay (unchanged)', () => {
        expect(overlayOf(filled())).not.toBeNull();
        expect(!!overlayOf(empty())).toBe(is1999);
        expect(!!overlayOf(packInset(CHEST))).toBe(is1999);
        expect(!!overlayOf(packInset(BAG))).toBe(is1999);
        expect(!!overlayOf(emptyPackInset())).toBe(is1999);
        if (is1999) expect(overlayOf(packInset(BAG))?.dataset.acDragTemplate).toBe('1000045e');
      });

      it(is1999 ? 'a pack item: the item row asks the grid rule, the container cells the pack-column rule' : 'a pack item: the filled cell shows DragItemAcceptable\'s verdict', () => {
        ui.setContainerCallbacks({ dragAcceptable: () => false });
        asked.length = 0;
        const cell = packDrag();
        fire(filled(), 'dragover');
        expect(overlayOf(filled())?.dataset.acDragAccept).toBe(String(is1999 ? RING : CIRCLE));
        if (is1999) {
          fire(empty(), 'dragover');
          expect(overlayOf(empty())?.dataset.acDragAccept).toBe(String(RING));
          fire(packInset(BAG), 'dragover');
          expect(overlayOf(packInset(BAG))?.dataset.acDragAccept).toBe(String(ARROW));
          fire(packInset(CHEST), 'dragover');
          fire(emptyPackInset(), 'dragover');
          expect(asked).toEqual([
            { guid: ARROWS, containerList: false, cellObjectId: LOOT },
            { guid: ARROWS, containerList: false, cellObjectId: 0 },
            { guid: ARROWS, containerList: true, cellObjectId: BAG },
            { guid: ARROWS, containerList: true, cellObjectId: CHEST },
            { guid: ARROWS, containerList: true, cellObjectId: 0 },
          ]);
          // Leaving a cell clears it; the others keep theirs until left.
          fire(packInset(BAG), 'dragleave');
          expect(overlayOf(packInset(BAG))?.dataset.acDragAccept).toBe(String(NONE));
        } else {
          expect(asked).toEqual([]);
        }
        // The drop on the row clears every cell of it.
        fire(row().parentElement as HTMLElement, 'drop');
        expect(overlayOf(filled())?.dataset.acDragAccept).toBe(String(NONE));
        if (is1999) expect(overlayOf(empty())?.dataset.acDragAccept).toBe(String(NONE));
        endPackDrag(cell);
        ui.setContainerCallbacks({});
      });

      it(is1999 ? 'the main-pack drag: the item row asks the grid rule for the player' : 'the main-pack drag: the filled cell asks DragItemAcceptable for the player (004cbb60)', () => {
        const askedGuids: number[] = [];
        ui.setContainerCallbacks({ dragAcceptable: (g: number) => { askedGuids.push(g); return true; } });
        asked.length = 0;
        const main = mainPackDrag();
        fire(filled(), 'dragover');
        expect(overlayOf(filled())?.dataset.acDragAccept).toBe(String(RING));
        expect(is1999 ? asked.map((a) => a.guid) : askedGuids).toEqual([PLAYER]);
        fire(filled(), 'dragleave');
        expect(overlayOf(filled())?.dataset.acDragAccept).toBe(String(NONE));
        fire(main, 'dragend');
        ui.settleItemDragWaiting?.();
        ui.setContainerCallbacks({});
      });

      it(is1999 ? 'a chest item dragged across its own row is answered too' : 'a chest item dragged across its own row leaves the cells untouched (unchanged)', () => {
        asked.length = 0;
        ui.beginWorldDrag(LOOT);
        fire(empty(), 'dragover');
        if (is1999) {
          expect(asked).toEqual([{ guid: LOOT, containerList: false, cellObjectId: 0 }]);
          expect(overlayOf(empty())?.dataset.acDragAccept).toBe(String(RING));
          fire(empty(), 'dragleave');
          expect(overlayOf(empty())?.dataset.acDragAccept).toBe(String(NONE));
        } else {
          expect(asked).toEqual([]);
          fire(filled(), 'dragover');
          expect(overlayOf(filled())?.dataset.acDragAccept).toBe(String(NONE));
        }
        ui.endWorldDrag();
      });
    });

    describe('a vendor', () => {
      beforeAll(() => {
        ui.hideContainerPanel?.();
        ui.showVendorWindow('Test Vendor', [
          { guid: 0x70550001, weenieClassId: 77, name: 'Cap', price: 10, burden: 1, stackSize: 1, itemType: 0x2 },
        ], [
          { guid: ARROWS, weenieClassId: 300, name: 'Arrow', pluralName: 'Arrows', price: 10, burden: 1, stackSize: 42, itemType: 0x100 },
        ], undefined, undefined, undefined, undefined, 0x70110001, { itemTypes: 0x100, minValue: 0, maxValue: 25000 });
      });
      const ITEMS = 0x100000bd;
      const BUY = 0x100000c5;
      const SELL = 0x100000ce;
      const TAB: Record<number, number> = { [ITEMS]: 0, [BUY]: 1, [SELL]: 2 };
      /** The list's cells, its page shown (only the open tab's page is built). */
      const listCells = (elId: number): HTMLElement[] => {
        if (ui.vendorData.tab !== TAB[elId]) { ui.vendorData.tab = TAB[elId]; ui.renderVendorPanel(); }
        return [...ui.vendorLayoutHandle.elements.get(elId).querySelectorAll('[data-item-cell], [data-item-cell-empty]')] as HTMLElement[];
      };
      const stateOf = (c: Element): string => overlayOf(c)?.dataset.acDragAccept ?? String(NONE);

      it(is1999 ? 'every list\'s cells carry the overlay (all ShopLists)' : 'only the sell list\'s cells carry the overlay (unchanged)', () => {
        for (const id of [ITEMS, BUY, SELL]) {
          const cells = listCells(id);
          expect(cells.length, id.toString(16)).toBeGreaterThan(0);
          expect(cells.every((c) => !!overlayOf(c)), id.toString(16)).toBe(is1999 || id === SELL);
        }
      });

      it(is1999 ? 'a chest item over the wares, buying and selling lists: the circle on each, cleared on leave' : 'a chest item: nothing on any list (unchanged)', () => {
        for (const id of [ITEMS, BUY, SELL]) {
          const c = listCells(id)[0];
          ui.beginWorldDrag(LOOT);
          fire(c, 'dragover');
          expect(stateOf(c), id.toString(16)).toBe(String(is1999 ? CIRCLE : NONE));
          // A ground object flips no tab (ItemsEnvPanel_DragOverAction @ 0x005a5420: owned objects only).
          expect(ui.vendorData.tab).toBe(TAB[id]);
          fire(c, 'dragleave');
          expect(stateOf(c)).toBe(String(NONE));
          ui.endWorldDrag();
        }
      });

      it(is1999 ? 'the main-pack drag: the circle on the wares, untouched on the selling list'
        : 'the main-pack drag: DragItemAcceptable(player) on the selling list (it carries items: the ring), nothing on the wares', () => {
        for (const id of [ITEMS, SELL]) {
          const c = listCells(id)[0];
          const main = mainPackDrag();
          fire(c, 'dragover');
          expect(stateOf(c), id.toString(16)).toBe(String(is1999 ? (id === ITEMS ? CIRCLE : NONE) : (id === SELL ? RING : NONE)));
          fire(c, 'dragleave');
          fire(main, 'dragend');
          ui.settleItemDragWaiting?.();
        }
      });

      it('a carried item over the selling list: the vendor\'s verdict (the ring here), cleared by the drop', () => {
        const c = listCells(SELL)[0];
        const cell = packDrag();
        fire(c, 'dragover');
        expect(stateOf(c)).toBe(String(RING));
        fire(c, 'drop');
        expect(stateOf(c)).toBe(String(NONE));
        endPackDrag(cell);
      });
    });
  });
}
