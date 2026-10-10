/**
 * RECON.inventory-grid-dat-cells.c.a — a worn item can go on the vendor's
 * Selling list.
 *
 * Retail (EoL acclient, decompiled):
 *  - VendorSellUI::DragItemAcceptable @ 004c20c0 refuses only an object that
 *    is not ACCWeenieObject::IsOwnedByPlayer; IsOwnedByObject @ 0058ceb0
 *    answers 1 when `_wielderID == player`, so a paperdoll item passes and
 *    gmVendorUI::AddItem @ 004c14b0 lists it.
 *  - ClientUISystem::AttemptSellToVendor @ 00564010 (a drop on the vendor in
 *    the 3D view) gates on the same IsOwnedByPlayer.
 * ACE Player_Commerce.VerifySellItems looks the object up in
 * GetAllPossessions (equipped included), so the sale goes through.
 *
 * Before: the sell bar's drop handler returned on any drag with
 * dragSourceSlot set, and main.ts built the sell price rows from the pack
 * contents only, so a worn item had no row to list against.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { EquipMask, vendorBuyPrice } from '@ac/shared';
import { buildVendorSellRows, type VendorSellProfile } from '../packages/renderer/src/ui/VendorSellDrag.js';
import { DRAG_ACCEPT_STATE } from '../packages/renderer/src/ui/UIItemDragAccept.js';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const PACK = 0x50000001;
const SWORD = 0x8000c001;
const HELM = 0x8000c002;
const WORN_SWORD = 0x8000c003;
const ROBE = 0x8000c004;

const INVENTORY = [
  { id: SWORD, weenieClassId: 351, name: 'Long Sword', value: 500, burden: 200, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PACK, itemType: 0x1 },
];
const EQUIPPED = [
  { id: WORN_SWORD, weenieClassId: 352, name: 'Broad Sword', value: 800, burden: 220, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0, itemType: 0x1, slot: EquipMask.MeleeWeapon },
  { id: HELM, weenieClassId: 554, name: 'Leather Cap', value: 60, burden: 50, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0, itemType: 0x2, slot: EquipMask.HeadWear },
  // A starter robe: no value, so ACE's VerifySellItems refuses it.
  { id: ROBE, weenieClassId: 2587, name: 'Robe', value: 0, burden: 150, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0, itemType: 0x4, slot: EquipMask.ChestWear },
];
const WEAPONSMITH_TYPES = 0x1 | 0x100;
const WEAPONSMITH: VendorSellProfile = { itemTypes: WEAPONSMITH_TYPES, minValue: 0, maxValue: 25000 };

describe('buildVendorSellRows: the Selling tab prices pack AND worn items', () => {
  it('a worn weapon gets a row next to the pack sword, priced by VendorBuyPrice', () => {
    const rows = buildVendorSellRows([...INVENTORY, ...EQUIPPED], WEAPONSMITH_TYPES, 0.75);
    expect(rows.map(r => r.guid)).toEqual([SWORD, WORN_SWORD]);
    const worn = rows.find(r => r.guid === WORN_SWORD)!;
    expect(worn.price).toBe(vendorBuyPrice({ value: 800, stackSize: 1, itemType: 0x1 }, 0.75));
    expect(worn).toMatchObject({ name: 'Broad Sword', weenieClassId: 352, pricing: 'vendorBuys', priceRate: 0.75, burden: 220 });
  });

  it('ACE\'s gates still apply to worn items: a type the vendor does not buy, or no value, gets no row', () => {
    const all = buildVendorSellRows(EQUIPPED, 0, 0.75); // 0 = the vendor's mask is unset → every type
    expect(all.map(r => r.guid)).toEqual([WORN_SWORD, HELM]); // the 0-value robe is out
    expect(buildVendorSellRows(EQUIPPED, WEAPONSMITH_TYPES, 0.75).map(r => r.guid)).toEqual([WORN_SWORD]);
  });

  it('an object listed twice keeps one row', () => {
    expect(buildVendorSellRows([...INVENTORY, ...INVENTORY], WEAPONSMITH_TYPES, 1).map(r => r.guid)).toEqual([SWORD]);
  });
});

// ── GameUI drive (happy-dom) ──────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Image', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const hasDats = existsSync(DAT_PATHS.local) && existsSync(DAT_PATHS.portal);

function harness(withDats: boolean) {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const H: { ui: any; notices: string[] } = { ui: null, notices: [] };
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof g.requestAnimationFrame !== 'function') {
      g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
      domWindow.requestAnimationFrame = g.requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    if (!withDats) {
      H.ui = new mod.GameUI(container);
      return;
    }
    const dat = await import('@ac/dat-parser');
    const portalDb = openDat(DAT_PATHS.portal);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001)!)));
    const lang = openDat(DAT_PATHS.local);
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000001)!)));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000002)!)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    H.ui = new mod.GameUI(container, {}, portalDb, undefined, undefined, undefined, lang, new LayoutRenderer(lang, uiTextureLoader, null));
    H.ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
    H.ui.getItemIconURL = (id: number): string => `icon:0x${id.toString(16)}`;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => {
    const ui = H.ui;
    H.notices = [];
    ui.displayErrorText = (t: string) => { H.notices.push(t); };
    ui.setInventoryData(INVENTORY, EQUIPPED, 0, 15000);
    ui.hideVendorWindow();
    ui.showVendorWindow('Tunlok Weaponsmith', [],
      buildVendorSellRows([...INVENTORY, ...EQUIPPED], WEAPONSMITH_TYPES, 0.75),
      '1.25', '0.75', undefined, undefined, 0x80009999, WEAPONSMITH);
    ui.toolbarSplitSize = 1;
    ui.toolbarMaxSplitSize = 1;
    ui.dragItemIndex = -1;
    ui.dragSourceSlot = null;
  });
  return H;
}

describe('GameUI: a worn item reaches the Selling list (no DATs)', () => {
  const H = harness(false);

  it('the sell list cells\' drag-over probe answers for a paperdoll drag (before: null)', () => {
    H.ui.dragSourceSlot = EquipMask.MeleeWeapon;
    expect(H.ui.vendorSellDragAcceptStateForCurrentDrag()).toBe(DRAG_ACCEPT_STATE.accept);
    H.ui.dragSourceSlot = EquipMask.HeadWear;
    expect(H.ui.vendorSellDragAcceptStateForCurrentDrag()).toBe(DRAG_ACCEPT_STATE.refuse);
    H.ui.dragSourceSlot = null;
    expect(H.ui.vendorSellDragAcceptStateForCurrentDrag()).toBeNull();
  });

  it('a 3D-view drop on the open vendor (AttemptSellToVendor → addItemToSellById) takes a worn item too', () => {
    expect(H.ui.addItemToSellById(WORN_SWORD)).toBe(true);
    expect(H.ui.vendorData.sellList).toEqual([{ guid: WORN_SWORD, qty: 1 }]);
  });
});

describe.skipIf(!hasDats)('GameUI: a paperdoll drag onto the vendor bar lists the worn item (DATs)', () => {
  const H = harness(true);
  const fire = (type: 'dragover' | 'drop') => {
    const ev = new domWindow.Event(type, { bubbles: true, cancelable: true });
    H.ui.vendorWrapper.dispatchEvent(ev);
    return ev;
  };

  it('dragging the wielded sword over the bar flips to Selling and accepts the drop target', () => {
    H.ui.vendorData.tab = 0;
    H.ui.dragSourceSlot = EquipMask.MeleeWeapon;
    const ev = fire('dragover');
    expect(ev.defaultPrevented).toBe(true);
    expect(H.ui.vendorData.tab).toBe(2);
  });

  it('dropping it lists the worn sword (before: the drop returned on dragSourceSlot)', () => {
    H.ui.dragSourceSlot = EquipMask.MeleeWeapon;
    fire('drop');
    expect(H.ui.vendorData.sellList).toEqual([{ guid: WORN_SWORD, qty: 1 }]);
    expect(H.notices).toEqual([]);
    expect(H.ui.dragSourceSlot).toBeNull();
  });

  it('a worn item the vendor does not buy is refused with retail\'s line', () => {
    H.ui.dragSourceSlot = EquipMask.HeadWear;
    fire('drop');
    expect(H.ui.vendorData.sellList).toEqual([]);
    expect(H.notices).toEqual(['That item cannot be sold here']);
  });

  it('pack drags still work: the inventory sword is listed', () => {
    H.ui.dragItemIndex = 0;
    fire('drop');
    expect(H.ui.vendorData.sellList).toEqual([{ guid: SWORD, qty: 1 }]);
  });
});
