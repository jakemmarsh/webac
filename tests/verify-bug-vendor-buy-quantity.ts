/**
 * BUG.vendor-buy-quantity — "you can't seem to buy in multiples… the slider
 * doesn't appear" (Levistras, ACE end of retail, 2026-10-21, prismatic tapers).
 *
 * ACE sends a shop object's ItemProfile amount as -1 (unlimited,
 * GameEventApproachVendor.cs:54) beside a PublicWeenieDesc whose own
 * StackSize is the weenie's 1 (Prismatic Taper 20631: StackSize 1,
 * MaxStackSize 1000). We put the -1 on the selection, so the toolbar's
 * stack test (>= 2) never passed and the split entry 0x100001a3 / slider
 * 0x100001a4 stayed hidden. Retail rewrites the object's _stackSize when it
 * builds the shop list (VendorItemsUI::UpdateItemsList @ 004c1ea0 →
 * VendorSubUI::SetObjectStackSize @ 004c0490): unlimited → _maxStackSize.
 * gmToolbarUI::HandleSelectionChanged @ 004bf380 then shows the slider with
 * max 1000, seeded 1 (SpellComponents is in mask 0xdc41cb0), and Add to List
 * (HandleButtonClicks 0x100000c3) queues GetObjectSplitSize; the Buy message
 * carries that amount.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { BinaryWriter, parseApproachVendor, buildBuyPayload, parseBuyPayload } from '@ac/network';
import { shopSellPrice, unitValueOf } from '@ac/shared';
import { vendorShopStackSize } from '../packages/renderer/src/ui/VendorShopStack.js';

describe('vendorShopStackSize — VendorItemsUI::UpdateItemsList / RemoveFromShop', () => {
  it('unlimited stock (-1) of a stackable takes _maxStackSize', () => {
    expect(vendorShopStackSize({ stackSize: -1, maxStackSize: 1000, descStackSize: 1 }, 0)).toBe(1000);
    // Queued amounts do not change an unlimited stock.
    expect(vendorShopStackSize({ stackSize: -1, maxStackSize: 1000, descStackSize: 1 }, 300)).toBe(1000);
  });
  it('a non-stackable (max <= 1) keeps the desc stack', () => {
    expect(vendorShopStackSize({ stackSize: -1, maxStackSize: 1, descStackSize: 1 }, 0)).toBe(1);
    expect(vendorShopStackSize({ stackSize: -1, maxStackSize: 0, descStackSize: 0 }, 0)).toBe(0);
  });
  it('a finite stock is what is left after the Buying list, capped at _maxStackSize', () => {
    expect(vendorShopStackSize({ stackSize: 40, maxStackSize: 100, descStackSize: 40 }, 0)).toBe(40);
    expect(vendorShopStackSize({ stackSize: 40, maxStackSize: 100, descStackSize: 40 }, 15)).toBe(25);
    expect(vendorShopStackSize({ stackSize: 400, maxStackSize: 100, descStackSize: 100 }, 0)).toBe(100);
  });
  it('a finite stock all on the Buying list leaves the shop list', () => {
    expect(vendorShopStackSize({ stackSize: 40, maxStackSize: 100, descStackSize: 40 }, 40)).toBeNull();
    expect(vendorShopStackSize({ stackSize: 1, maxStackSize: 1, descStackSize: 1 }, 1)).toBeNull();
  });
});

const WHF_PLURAL_NAME = 0x00000001;
const WHF_VALUE = 0x00000008;
const WHF_STACK_SIZE = 0x00001000;
const WHF_MAX_STACK_SIZE = 0x00002000;
const WHF_BURDEN = 0x00200000;
const VENDOR_GUID = 0x50002303;
const TAPER_GUID = 0x80004321;

function align(w: BinaryWriter): void {
  while (w.position % 4 !== 0) w.writeUInt8(0);
}

/** ACE GameEventApproachVendor for one Prismatic Taper, exactly as ACE builds it from the world DB. */
function aceTaperVendor(): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeUInt32(VENDOR_GUID);
  w.writeUInt32(0x1000); // merchandise types
  w.writeUInt32(0); w.writeUInt32(1000000); w.writeUInt32(1);
  w.writeFloat32(0.9); // buy price
  w.writeFloat32(1.25); // sell price
  w.writeUInt32(0); w.writeUInt32(0); w.writeString16('');
  w.writeUInt32(1);
  // VendorShopCreateListStackSize = -1 (create list `(2303, 4, 20631, -1, …)`).
  w.writeUInt32(((-1 & 0x00ffffff) | 0xff000000) >>> 0);
  w.writeUInt32(TAPER_GUID);
  w.writeUInt32(WHF_PLURAL_NAME | WHF_VALUE | WHF_STACK_SIZE | WHF_MAX_STACK_SIZE | WHF_BURDEN);
  w.writeString16('Prismatic Taper');
  w.writeUInt16(20631);
  w.writeUInt16(0x1234);
  w.writeUInt32(0x1000); // ItemType SpellComponents
  w.writeUInt32(0);
  align(w);
  w.writeString16('Prismatic Tapers');
  w.writeUInt32(22); // Value
  w.writeUInt16(1); // StackSize
  w.writeUInt16(1000); // MaxStackSize
  w.writeUInt16(1); // Burden
  align(w);
  return w.toBuffer();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent'] as const;
const ITEMS_NAME = 0x100000c0;
const ITEMS_ADD = 0x100000c3;
const ITEMS_BUY = 0x100000c2;

describe('BUG.vendor-buy-quantity — the toolbar split drives a multi-buy of an ACE unlimited stackable', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const texts = new Map<number, string>();
  const clicks = new Map<number, () => void>();
  const buys: Array<{ guid: number; amount: number }> = [];
  const buyLists: Array<Array<{ guid: number; amount: number }>> = [];
  let row: Record<string, unknown>;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setText: (id: number, t: string) => { texts.set(id, t); },
        setInteractive: (id: number, fn: () => void) => { clicks.set(id, fn); },
        setVisible: () => {}, setState: () => {}, setFill: () => {}, setPalette: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
    ui.hud.coinValue = 1_000_000;
    ui.inventoryItemsCapacity = 102;
    ui.inventoryContainersCapacity = 7;
    ui.setVendorCallbacks({
      onBuy: (guid: number, amount: number) => { buys.push({ guid, amount }); },
      onBuyList: (items: Array<{ guid: number; amount: number }>) => { buyLists.push(items); },
    });

    // The merchandise row main.ts builds from the parsed ApproachVendor.
    const parsed = parseApproachVendor(aceTaperVendor())!;
    const item = parsed.items[0];
    expect(item.stackSize).toBe(-1); // the ItemProfile amount: unlimited
    expect(item.descStackSize).toBe(1);
    expect(item.maxStackSize).toBe(1000);
    row = {
      guid: item.guid, weenieClassId: item.weenieClassId, name: item.name, pluralName: item.pluralName,
      stackSize: item.stackSize, descStackSize: item.descStackSize, maxStackSize: item.maxStackSize,
      itemType: item.itemType, burden: item.burden,
      price: shopSellPrice(unitValueOf({ value: item.value, stackSize: item.descStackSize }), item.itemType, parsed.sellPrice, 1),
      unitValue: unitValueOf({ value: item.value, stackSize: item.descStackSize }),
      priceRate: parsed.sellPrice, pricing: 'vendorSells',
    };
    ui.showVendorWindow('Singud Trell the Archmage', [row], [], '1.25', '0.90', undefined, undefined, parsed.vendorGuid);
  });

  afterAll(() => {
    ui.hideVendorWindow();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const entry = () => ui.targetStackEntry as HTMLInputElement;
  const slider = () => ui.targetStackSlider as HTMLDivElement;
  const typeSplit = (n: number) => {
    entry().value = String(n);
    entry().dispatchEvent(new domWindow.Event('change'));
  };

  it('opening the vendor selects the taper and shows the split entry + slider (max 1000, seeded 1)', () => {
    expect(ui.hud.target?.id).toBe(TAPER_GUID);
    expect(ui.hud.target?.stackSize).toBe(1000);
    expect(slider().style.display).toBe('block');
    expect(ui.targetStackEntryWrap.style.display).toBe('block');
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 1000 });
    expect(entry().value).toBe('1');
    expect(texts.get(ITEMS_NAME)).toBe('Prismatic Taper');
  });

  it('typing 25 in the entry redraws the Items line as "25 Prismatic Tapers" (RecvNotice_StackSliderChanged)', () => {
    typeSplit(25);
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 25, maxSplitSize: 1000 });
    expect(texts.get(ITEMS_NAME)).toBe('25 Prismatic Tapers');
  });

  it('a split above the stack clamps to 1000 (ListenToElementMessage @ 004bee90)', () => {
    typeSplit(5000);
    expect(ui.getToolbarSplitState().splitSize).toBe(1000);
    expect(entry().value).toBe('1000');
    typeSplit(25);
  });

  it('Buy sends the split amount, priced once for the whole amount', () => {
    clicks.get(ITEMS_BUY)!();
    expect(buys).toEqual([{ guid: TAPER_GUID, amount: 25 }]);
    const wire = parseBuyPayload(buildBuyPayload(VENDOR_GUID, buys.map((b) => ({ amount: b.amount, objectId: b.guid }))));
    expect(wire.items).toEqual([{ amount: 25, objectId: TAPER_GUID }]);
    expect(ui.vendorUnitCost(row, 25)).toBe(shopSellPrice(22, 0x1000, 1.25, 25));
  });

  it('Add to List queues the split; a second Add merges into the one entry; Buy All sends the total', () => {
    clicks.get(ITEMS_ADD)!();
    expect(ui.vendorData.buyList).toEqual([{ guid: TAPER_GUID, qty: 25 }]);
    typeSplit(10);
    clicks.get(ITEMS_ADD)!();
    expect(ui.vendorData.buyList).toEqual([{ guid: TAPER_GUID, qty: 35 }]);
    // Unlimited stock: the selection and its slider stay as they were.
    expect(ui.hud.target?.stackSize).toBe(1000);
    ui.vendorData.tab = 1;
    ui.renderVendorPanel();
    clicks.get(0x100000ca)?.(); // Buy All (VENDOR_EL.buyAll)
    expect(buyLists.at(-1)).toEqual([{ guid: TAPER_GUID, amount: 35 }]);
    ui.vendorData.tab = 0;
    ui.renderVendorPanel();
  });

  it('a merge reaching 0x1389 is refused with the vendor line (AddToBuyList @ 004c3dc0)', () => {
    ui.vendorData.buyList = [{ guid: TAPER_GUID, qty: 4500 }];
    typeSplit(600);
    const shown: string[] = [];
    const orig = ui.displayErrorText.bind(ui);
    ui.displayErrorText = (t: string) => { shown.push(t); };
    clicks.get(ITEMS_ADD)!();
    ui.displayErrorText = orig;
    expect(shown).toEqual(["I can't possibly sell you that much! Please be a little more reasonable."]);
    expect(ui.vendorData.buyList).toEqual([{ guid: TAPER_GUID, qty: 4500 }]);
    ui.vendorData.buyList = [];
  });
});

describe('BUG.vendor-buy-quantity — a finite stock shrinks as it is queued (RemoveFromShop @ 004c3ce0)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const clicks = new Map<number, () => void>();

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setText: () => {}, setInteractive: (id: number, fn: () => void) => { clicks.set(id, fn); },
        setVisible: () => {}, setState: () => {}, setFill: () => {}, setPalette: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
    ui.showVendorWindow('Pawn', [
      { guid: 0x80005001, weenieClassId: 300, name: 'Arrow', pluralName: 'Arrows', price: 1, burden: 1, stackSize: 40, descStackSize: 40, maxStackSize: 250, itemType: 0x100 },
    ], [], '1.25', '0.90', undefined, undefined, 0x50005000);
  });

  afterAll(() => {
    ui.hideVendorWindow();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('queuing part re-seeds the toolbar to what is left; queuing the rest drops the row and the selection', () => {
    // MissileWeapon is outside 0xdc41cb0: the split seeds the whole stack.
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 40, maxSplitSize: 40 });
    const e = ui.targetStackEntry as HTMLInputElement;
    e.value = '15';
    e.dispatchEvent(new domWindow.Event('change'));
    clicks.get(ITEMS_ADD)!();
    expect(ui.vendorData.buyList).toEqual([{ guid: 0x80005001, qty: 15 }]);
    expect(ui.hud.target?.stackSize).toBe(25);
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 25, maxSplitSize: 25 });
    clicks.get(ITEMS_ADD)!();
    expect(ui.vendorData.buyList).toEqual([{ guid: 0x80005001, qty: 40 }]);
    expect(ui.hud.target).toBeNull();
  });
});

describe('BUG.vendor-buy-quantity — the buy-one-at-a-time ware mask follows the era (EraClientRules.vendorBuyOneMask)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setState: () => {},
        setFill: () => {}, setPalette: () => {}, setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });

  afterAll(() => {
    ui.hideVendorWindow();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const GEM = { guid: 0x80006001, weenieClassId: 2413, name: 'Amber', pluralName: 'Ambers', price: 50, burden: 5, stackSize: -1, descStackSize: 1, maxStackSize: 100, itemType: 0x800 };
  const TAPER = { guid: 0x80006002, weenieClassId: 20631, name: 'Prismatic Taper', pluralName: 'Prismatic Tapers', price: 27, burden: 1, stackSize: -1, descStackSize: 1, maxStackSize: 1000, itemType: 0x1000 };
  const open = () => {
    // A fresh selection each time (the mask is read on a selection change).
    ui.hud.setTarget(null);
    ui.updateHUD();
    ui.showVendorWindow('Jeweler', [GEM, TAPER], [], '1.25', '0.90', undefined, undefined, 0x50006000);
  };

  it('end of retail (and the classic eras): a gem (0x800, inside 0xdc41cb0) seeds 1 of 100', async () => {
    const { eraClientRules } = await import('../packages/renderer/src/era/EraFeatures.js');
    ui.setVendorBuyOneMask(eraClientRules(null).vendorBuyOneMask);
    open();
    ui.seedVendorSelection(GEM, true);
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 100 });
    ui.hideVendorWindow();
  });

  it('1999: the gem seeds the whole 100 (0x14b0 has no Gem bit); a taper still seeds 1 of 1000', async () => {
    const { eraClientRules } = await import('../packages/renderer/src/era/EraFeatures.js');
    const { eraProfile } = await import('../packages/renderer/src/era/EraProfiles.js');
    ui.setVendorBuyOneMask(eraClientRules(eraProfile('ac1999-retail')).vendorBuyOneMask);
    open();
    ui.seedVendorSelection(GEM, true);
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 100, maxSplitSize: 100 });
    ui.seedVendorSelection(TAPER, true);
    expect(ui.getToolbarSplitState()).toEqual({ splitSize: 1, maxSplitSize: 1000 });
    expect((ui.targetStackSlider as HTMLDivElement).style.display).toBe('block');
    ui.hideVendorWindow();
  });
});
