/**
 * Selection sweep (2026-10-03) — every retail ItemList follows the one global
 * selection (ACCWeenieObject::selectedID) and shares the base gestures of
 * UIElement_ItemList::ListenToElementMessage @ 004e4d50: a left press (0x1c
 * action 7, sent by UIElement::MouseDown @ 00460f10) runs an armed target mode
 * (HandleTargetedUseLeftClick @ 004e24d0) before it would select, a
 * right-click selects and examines. Plus the paperdoll drag rules
 * (OnItemListDragOver @ 004a4270, HandlePaperDollDragOver @ 004a3a70,
 * HandleDropRelease @ 004a4d80) and the vendor list notice.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EquipMask } from '@ac/shared';
import {
  paperdollSlotDragAcceptState, paperdollBandDragAcceptState,
  type PaperdollWearContext, type PaperdollDropObject,
} from '../packages/renderer/src/inventory/PaperdollDragObject.js';
import { vendorRemovingFromListText } from '../packages/renderer/src/ui/VendorSellDrag.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const ACCEPT = 0x10000040;
const REFUSE = 0x10000041;
const PLAYER = 0x50000001;

describe('paperdoll drag-accept rules', () => {
  const ctx = (over: Partial<PaperdollWearContext> = {}): PaperdollWearContext => ({
    playerId: PLAYER, equipped: [], inCombat: false, readyRefusal: null, ...over,
  });
  const ring: PaperdollDropObject = { id: 0x80000010, name: 'Ring', validLocations: EquipMask.FingerWearLeft | EquipMask.FingerWearRight };
  const sword: PaperdollDropObject = { id: 0x80000011, name: 'Sword', validLocations: EquipMask.MeleeWeapon };
  const shirt: PaperdollDropObject = { id: 0x80000012, name: 'Shirt', validLocations: 0x1e, clothingPriority: 0x68 };

  it('OnItemListDragOver: the slot must meet valid_locations (a melee weapon also fits the shield slot)', () => {
    expect(paperdollSlotDragAcceptState(ring, EquipMask.FingerWearLeft, ctx())).toBe(ACCEPT);
    expect(paperdollSlotDragAcceptState(ring, EquipMask.MeleeWeapon | EquipMask.MissileWeapon | EquipMask.Held | EquipMask.TwoHanded, ctx())).toBe(REFUSE);
    expect(paperdollSlotDragAcceptState(sword, EquipMask.Shield, ctx())).toBe(ACCEPT);
  });

  it('OnItemListDragOver: AutoWieldIsLegal (and readiness) gate every slot', () => {
    expect(paperdollSlotDragAcceptState(ring, EquipMask.FingerWearLeft, ctx({ readyRefusal: 'busy' }))).toBe(REFUSE);
    const wand: PaperdollDropObject = { id: 0x80000013, name: 'Stick', validLocations: EquipMask.Held, itemType: 0 };
    expect(paperdollSlotDragAcceptState(wand, EquipMask.Held, ctx({ inCombat: true }))).toBe(REFUSE);
  });

  it('HandlePaperDollDragOver: wearable → ring; covered or unwearable → circle; already worn → unchanged', () => {
    expect(paperdollBandDragAcceptState(shirt, ctx())).toBe(ACCEPT);
    expect(paperdollBandDragAcceptState(ring, ctx())).toBe(REFUSE);
    const jerkin = { id: 0x80000014, name: 'Jerkin', validLocations: 0x6, clothingPriority: 0x8, slot: 0x6 };
    expect(paperdollBandDragAcceptState(shirt, ctx({ equipped: [jerkin] }))).toBe(REFUSE);
    expect(paperdollBandDragAcceptState(shirt, ctx({ equipped: [{ ...shirt, slot: 0x1e }] }))).toBeNull();
  });
});

describe('gmVendorUI::HandleMousePresses notice', () => {
  it('reads "Removing %s from shopping list" (acclient.exe 0x3b5a6c)', () => {
    expect(vendorRemovingFromListText('3 Apples')).toBe('Removing 3 Apples from shopping list');
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const url = (did: number) => `data:image/png;base64,tex${did.toString(16)}`;

describe('GameUI — item lists follow the global selection (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const targeted: number[] = [];
  const selected: number[] = [];
  const examined: number[] = [];
  const worn: Array<[number, unknown]> = [];
  let armed = false;

  const PACK = 0x80001111;
  const DAGGER = 0x8000aaaa;
  const HELM = 0x80000001;

  function stubLayoutRenderer() {
    return {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const wrapper = domWindow.document.createElement('div');
        container.appendChild(wrapper);
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { wrapper.remove(); } };
      },
    };
  }
  function item(id: number, name: string, extra: Record<string, unknown> = {}) {
    return {
      id, weenieClassId: id & 0xffff, name, value: 1, burden: 10,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemType: 0, ...extra,
    };
  }

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
    for (const did of [0x06004d20, 0x06004d09, 0x06004d21, 0x060011f9, 0x060011f8]) ui.uiTextures.set(did, url(did));
    ui.itemTargetModeClick = (g: number) => { if (!armed) return false; targeted.push(g); return true; };
    ui.onSelectObject = (g: number) => { selected.push(g); ui.hud.setTarget({ id: g, name: 'x', level: 0, healthFraction: 1, distance: 0, type: 'player' }); };
    ui.onExamineObject = (g: number) => { examined.push(g); };
    ui.setDragCallbacks({ onDropWornToPaperdoll: (slot: number, target: unknown) => worn.push([slot, target]) });
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => {
    targeted.length = 0; selected.length = 0; examined.length = 0; worn.length = 0; armed = false;
    ui.hud.setTarget(null);
    ui.selectedPackSlot = 0;
    ui.inventorySlotsView = true;
    ui.setSidePackGuids([PLAYER, PACK]);
    ui.setInventoryData(
      [item(DAGGER, 'Dagger'), item(PACK, 'Leather Pack', { itemsCapacity: 24 })],
      [{ ...item(HELM, 'Helm'), slot: EquipMask.HeadWear, clothingPriority: 0x4000 }],
      10, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  const panel = (): HTMLElement => ui.inventoryPanel;
  const cellOf = (guid: number): HTMLElement => panel().querySelector(`[data-ac-sel-guid="${guid}"]`) as HTMLElement;
  const ants = (el: HTMLElement) => el.querySelector('[data-slot-state="selected"]');
  const press = (el: HTMLElement, button = 0) => el.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, cancelable: true, button }));

  it('the press selects (message 0x1c action 7): a press that goes on to drag leaves the ants on the ghosted cell', () => {
    const cell = cellOf(DAGGER);
    press(cell, 2); // a right-button press is not action 7
    expect(ui.hud.target).toBeNull();
    press(cell);
    expect(ui.hud.target?.id).toBe(DAGGER);
    // The browser never sends 'click' once the press turns into a drag.
    cell.dispatchEvent(new domWindow.Event('dragstart', { bubbles: true }));
    const dragged = cellOf(DAGGER);
    expect(dragged.querySelector('[data-waiting-ghost]')).toBeTruthy();
    expect(ants(dragged)).toBeTruthy();
    // Overlays 0x10000346 paint in read order: the ghost (3) under the ants (4).
    const layers = [...dragged.children].filter((c) => (c as HTMLElement).dataset.waitingGhost || (c as HTMLElement).dataset.slotState);
    expect(layers.map((c) => ((c as HTMLElement).dataset.waitingGhost ? 'ghost' : (c as HTMLElement).dataset.slotState))).toEqual(['ghost', 'selected']);
    cell.dispatchEvent(new domWindow.Event('dragend', { bubbles: true }));
    ui.settleItemDragWaiting();
    // A release alone (a click with no press) does not select.
    ui.hud.setTarget(null);
    (panel().querySelector('[data-equip-slot="Head"]') as HTMLElement).click();
    expect(ui.hud.target).toBeNull();
    press(panel().querySelector('[data-equip-slot="Head"]') as HTMLElement);
    expect(ui.hud.target?.id).toBe(HELM);
  });

  it('an armed target mode takes a pack cell or worn-slot press instead of selecting', () => {
    armed = true;
    press(cellOf(DAGGER));
    press(panel().querySelector('[data-equip-slot="Head"]') as HTMLElement);
    expect(targeted).toEqual([DAGGER, HELM]);
    expect(ui.hud.target).toBeNull();
  });

  it('a side pack click selects the pack (its cell carries the ants) and right-click examines it', () => {
    const packCell = cellOf(PACK);
    (packCell.parentElement as HTMLElement).click();
    expect(ui.hud.target?.id).toBe(PACK);
    expect(ants(cellOf(PACK))).toBeTruthy();
    (cellOf(PACK).parentElement as HTMLElement).dispatchEvent(new domWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(examined).toEqual([PACK]);
  });

  it('a worn item dropped on another paperdoll slot goes to onDropWornToPaperdoll; back on its own slot does nothing', () => {
    const neck = panel().querySelector('[data-equip-slot="Neck"]') as HTMLElement;
    const head = panel().querySelector('[data-equip-slot="Head"]') as HTMLElement;
    ui.dragSourceSlot = EquipMask.HeadWear;
    neck.dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
    ui.dragSourceSlot = EquipMask.HeadWear;
    head.dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
    expect(worn).toEqual([[EquipMask.HeadWear, { kind: 'slot', mask: EquipMask.NeckWear }]]);
  });

  it('a pack-column drag dropped on the paperdoll is ignored without a word (DROPITEM_IS_CONTAINER)', () => {
    const neck = panel().querySelector('[data-equip-slot="Neck"]') as HTMLElement;
    const dropped: unknown[] = [];
    ui.setDragCallbacks({ onDropToSlot: (...a: unknown[]) => dropped.push(a) });
    ui.dragItemIndex = 1;
    ui.dragIsContainer = true;
    neck.dispatchEvent(new domWindow.Event('drop', { bubbles: true, cancelable: true }));
    expect(dropped).toEqual([]);
    expect(ui.dragIsContainer).toBe(false);
    ui.setDragCallbacks({ onDropWornToPaperdoll: (slot: number, target: unknown) => worn.push([slot, target]) });
  });

  it('a selected in-trade pack item shows both the trade badge and the ants (SetSelectedState)', () => {
    ui.setTradeData({
      yourItems: [{ name: 'Dagger', value: 1, guid: DAGGER, burden: 10, iconDid: 0 }],
      theirItems: [], theirName: '', yourName: '', partnerGuid: 0x50000099, initiatorGuid: 0,
      tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
    ui.selectInventoryItem(ui.inventoryItems[0]);
    ui.renderInventoryPanel();
    const cell = cellOf(DAGGER);
    expect(cell.querySelector('[data-slot-state="trade"]')).toBeTruthy();
    expect(ants(cell)).toBeTruthy();
    ui.setTradeData({
      yourItems: [], theirItems: [], theirName: '', yourName: '', partnerGuid: 0, initiatorGuid: 0,
      tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
  });

  it('toolbar shortcut slots draw the selected overlay 0x06004d21 while their object is selected', () => {
    const slot = domWindow.document.createElement('div');
    ui.itemShortcutSlots[0] = slot;
    ui.itemShortcutObjectAt = (i: number) => (i === 0 ? DAGGER : 0);
    ui.setItemShortcutIcon(0, 0x06001234, 'Dagger');
    expect(slot.querySelector('[data-slot-state="selected"]')).toBeNull();
    ui.selectInventoryItem(ui.inventoryItems[0]);
    ui.refreshShortcutSelection();
    const overlay = slot.querySelector('[data-slot-state="selected"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.backgroundImage).toContain(url(0x06004d21));
  });

  it('gmFellowshipUI::UpdateFellowSelection: a fellow selected elsewhere becomes the row; other selections keep it', () => {
    ui.setFellowshipData({ name: 'F', leaderGuid: 0x50000010, shareXP: false, openFellow: false,
      fellows: [0x50000010, 0x50000011].map(g => ({ guid: g, name: `P${g}`, level: 1, healthCurrent: 1, healthMax: 1, staminaCurrent: 1, staminaMax: 1, manaCurrent: 1, manaMax: 1, shareLoot: false })) });
    ui.hud.setTarget({ id: 0x50000011, name: 'P', level: 1, healthFraction: 1, distance: 1, type: 'player' });
    ui.refreshFellowSelection();
    expect(ui.selectedFellowGuid).toBe(0x50000011);
    ui.hud.setTarget({ id: 0x7000beef, name: 'Drudge', level: 1, healthFraction: 1, distance: 3, type: 'monster' });
    ui.refreshFellowSelection();
    expect(ui.selectedFellowGuid).toBe(0x50000011);
    ui.setFellowshipData(null);
  });

  it('gmSpellComponentUI::RecvNotice_SelectionChanged: an owned component selects its row; anything else clears it', () => {
    const taper = item(0x80002222, 'Prismatic Taper', { itemType: 0x1000, weenieClassId: 0x1234 });
    ui.setInventoryData([taper], [], 10, 15000);
    ui.selectInventoryItem(taper);
    ui.refreshComponentSelection();
    expect(ui.componentRowWcid).toBe(0x1234);
    ui.hud.setTarget({ id: 0x7000beef, name: 'Drudge', level: 1, healthFraction: 1, distance: 3, type: 'monster' });
    ui.refreshComponentSelection();
    expect(ui.componentRowWcid).toBe(0);
  });

  it('trade cells: a press selects, right-click selects and examines, an armed target mode takes the press', () => {
    const listEl = domWindow.document.createElement('div');
    const handle = { elements: new Map([[0x1, listEl]]), descs: new Map(), setText: () => {}, setState: () => {}, setVisible: () => {} };
    ui.renderTradeItemList(handle, 0x1, 0x2, [{ name: 'Gem', guid: 0x80003333, iconDid: 0 }], false, () => 0, () => {});
    const cell = listEl.querySelector('[data-ac-trade-cell="item"]') as HTMLElement;
    cell.click(); // the release alone is not action 7
    expect(selected).toEqual([]);
    cell.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(selected).toEqual([0x80003333]);
    cell.dispatchEvent(new domWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(examined).toEqual([0x80003333]);
    armed = true;
    cell.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(targeted).toEqual([0x80003333]);
  });
});
