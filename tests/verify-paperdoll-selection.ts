/**
 * Paperdoll selection — worn items take the selection ants, and the
 * portrait's click map selects the worn item under the mouse.
 *
 * Ground truth (decompiled EoL client, build ac1_sep13):
 *  - every pack cell and paperdoll slot is a UIItem in an ItemList that
 *    takes RecvNotice_SetSelectedItem (UIElement_ItemList @ 004e3560), so
 *    the ants follow ACCWeenieObject::selectedID — selecting a worn item
 *    moves them off the pack cell onto its slot;
 *  - gmPaperDollUI::CreateClickMap @ 004a4850 (UIASSET 0x1000000c =
 *    PaperDollHitTest), GetPaperDollItemUnderMouse @ 004a4920,
 *    GetUpperInvObj @ 004a4750 + InventoryPlacement::DetermineHigherPriority
 *    @ 004a44b0, GetSelectionMaskFromObject @ 004a4b50,
 *    ApplyPartSelectionLighting @ 004a3ca0, UpdatePartSelectionLighting
 *    @ 004a4360, ListenToElementMessage @ 004a5c30.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { EquipMask } from '@ac/shared';
import {
  hitColorMask, upperWornObject, paperdollItemAt, selectionMaskFromObject, partsForSelectionMask,
  partSelectionFlipLevels, loadPaperdollHitTestDid, PAPERDOLL_HIT_COLORS, PAPERDOLL_WHOLE_FIGURE_MASK,
  type WornPlacement, type HitTestImage,
} from '../packages/renderer/src/ui/PaperdollHitTest.js';
import { LIGHT_HIGH, LIGHT_LOW } from '../packages/renderer/src/world/SelectionLighting.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const PLAYER = 0x50000001;
const HELM = 0x80000001;
const SHIRT = 0x80000002;
const BREASTPLATE = 0x80000003;
const ROBE = 0x80000004;

describe('PaperdollHitTest — GetPaperDollItemUnderMouse / GetUpperInvObj', () => {
  it('maps each RGBAColor_HitTest_* colour to its region mask, anything else to 0', () => {
    expect(hitColorMask(0, 0, 255)).toBe(0x1);
    expect(hitColorMask(0, 255, 0)).toBe(0x202);
    expect(hitColorMask(255, 0, 0)).toBe(0x404);
    expect(hitColorMask(0, 255, 255)).toBe(0x808);
    expect(hitColorMask(255, 0, 255)).toBe(0x1010);
    expect(hitColorMask(255, 255, 0)).toBe(0x2040);
    expect(hitColorMask(0, 0, 128)).toBe(0x4080);
    expect(hitColorMask(0, 128, 0)).toBe(0x20);
    expect(hitColorMask(128, 0, 0)).toBe(0x100);
    expect(hitColorMask(0, 0, 0)).toBe(0);
  });

  it('the armor over the shirt is the upper object; a bare region is the player; no region is 0', () => {
    const worn: WornPlacement[] = [
      { id: SHIRT, loc: EquipMask.ChestWear | EquipMask.UpperArmWear, priority: 0x8 },
      { id: BREASTPLATE, loc: EquipMask.ChestArmor, priority: 0x400 },
    ];
    expect(upperWornObject(worn, 0x202, PLAYER)).toBe(BREASTPLATE);
    expect(upperWornObject(worn, 0x808, PLAYER)).toBe(SHIRT);
    expect(upperWornObject(worn, 0x1, PLAYER)).toBe(PLAYER);
    expect(upperWornObject(worn, 0, PLAYER)).toBe(0);
  });

  it('DetermineHigherPriority: priority 0 counts as 0x7f on an armor bit, and loses on a clothing bit', () => {
    // A priority-less armor piece (0x7f) outranks a shirt at 0x8 …
    expect(upperWornObject([
      { id: SHIRT, loc: EquipMask.ChestWear, priority: 0x8 },
      { id: BREASTPLATE, loc: EquipMask.ChestArmor, priority: 0 },
    ], 0x202, PLAYER)).toBe(BREASTPLATE);
    // … but not one at 0x400.
    expect(upperWornObject([
      { id: ROBE, loc: EquipMask.ChestArmor, priority: 0x400 },
      { id: BREASTPLATE, loc: EquipMask.ChestArmor, priority: 0 },
    ], 0x202, PLAYER)).toBe(ROBE);
    // A priority-less clothing-bit placement never displaces the incumbent.
    expect(upperWornObject([
      { id: SHIRT, loc: EquipMask.ChestWear, priority: 0x8 },
      { id: ROBE, loc: EquipMask.ChestWear, priority: 0 },
    ], 0x202, PLAYER)).toBe(SHIRT);
  });

  it('reads the click map at the band offset; off the image is no hit', () => {
    // 2x1 map: head blue, then black.
    const map: HitTestImage = { width: 2, height: 1, data: new Uint8Array([0, 0, 255, 255, 0, 0, 0, 255]) };
    const worn: WornPlacement[] = [{ id: HELM, loc: EquipMask.HeadWear, priority: 0x4000 }];
    expect(paperdollItemAt(map, 0.5, 0.5, worn, PLAYER)).toBe(HELM);
    expect(paperdollItemAt(map, 1, 0, worn, PLAYER)).toBe(0);
    expect(paperdollItemAt(map, -1, 0, worn, PLAYER)).toBe(0);
    expect(paperdollItemAt(map, 0, 1, worn, PLAYER)).toBe(0);
  });
});

describe('PaperdollHitTest — the part blink', () => {
  const worn: WornPlacement[] = [
    { id: HELM, loc: EquipMask.HeadWear, priority: 0x4000 },
    { id: ROBE, loc: EquipMask.ChestArmor | EquipMask.AbdomenArmor | EquipMask.UpperLegArmor, priority: 0x400 },
  ];

  it('GetSelectionMaskFromObject: the regions the item is upper on; the player is the whole figure', () => {
    expect(selectionMaskFromObject(HELM, worn, PLAYER)).toBe(0x1);
    expect(selectionMaskFromObject(ROBE, worn, PLAYER)).toBe(0x2 | 0x4 | 0x40);
    expect(selectionMaskFromObject(PLAYER, worn, PLAYER)).toBe(PAPERDOLL_WHOLE_FIGURE_MASK);
    expect(selectionMaskFromObject(0x80009999, worn, PLAYER)).toBe(0);
  });

  it('ApplyPartSelectionLighting: Setup part indices per region', () => {
    expect(partsForSelectionMask(0x1)).toEqual([0x10]);
    expect(partsForSelectionMask(0x2 | 0x4 | 0x40)).toEqual([9, 0, 1, 5]);
    expect(partsForSelectionMask(0x100)).toEqual([3, 7, 4, 8]);
    expect(partsForSelectionMask(PAPERDOLL_WHOLE_FIGURE_MASK)).toBeNull();
  });

  it('UpdatePartSelectionLighting: HIGH, then LOW, then restore', () => {
    expect(partSelectionFlipLevels(1)).toBe(LIGHT_HIGH);
    expect(partSelectionFlipLevels(2)).toBe(LIGHT_LOW);
    expect(partSelectionFlipLevels(3)).toBeNull();
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('PaperdollHitTest — the DAT click map', () => {
  let did = 0;
  let tex: ReturnType<Texture['toRGBA']>;
  beforeAll(() => {
    const db = openDat(DAT_PATHS.portal);
    did = loadPaperdollHitTestDid(db, db.masterMapId);
    tex = Texture.read(new DatReader(db.getFileData(did)!)).toRGBA();
  });

  it('UIASSET 0x1000000c is PaperDollHitTest 0x06004d8b, the drag band\'s 100x214', () => {
    expect(did).toBe(0x06004d8b);
    expect([tex.width, tex.height]).toEqual([100, 214]);
  });

  it('every pixel is black or one of the nine region colours, and all nine appear', () => {
    const seen = new Set<number>();
    for (let i = 0; i < tex.data.length; i += 4) {
      const m = hitColorMask(tex.data[i], tex.data[i + 1], tex.data[i + 2]);
      if (m === 0) expect([tex.data[i], tex.data[i + 1], tex.data[i + 2]]).toEqual([0, 0, 0]);
      else seen.add(m);
    }
    expect(seen.size).toBe(PAPERDOLL_HIT_COLORS.length);
  });

  it('the head sits at the top centre and the feet at the bottom', () => {
    const at = (x: number, y: number) => {
      const o = (y * tex.width + x) * 4;
      return hitColorMask(tex.data[o], tex.data[o + 1], tex.data[o + 2]);
    };
    expect(at(50, 15)).toBe(0x1);
    const footRow = [...Array(tex.width).keys()].some(x => at(x, 190) === 0x100);
    expect(footRow).toBe(true);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const url = (did: number) => `data:image/png;base64,tex${did.toString(16)}`;

describe('GameUI — worn-item selection (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const clicks: Array<[number, boolean]> = [];

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

  function item(id: number, name: string) {
    return {
      id, weenieClassId: id & 0xffff, name, value: 1, burden: 10,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemType: 0,
    };
  }

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
    for (const did of [0x06004d20, 0x06004d09, 0x06006d7f]) ui.uiTextures.set(did, url(did));
    ui.setDragCallbacks({ onPaperdollFigureClick: (guid: number, examine: boolean) => clicks.push([guid, examine]) });
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    clicks.length = 0;
    ui.hud.setTarget(null);
    ui.selectedPackSlot = 0;
    ui.inventorySlotsView = true;
    ui.setSidePackGuids([PLAYER]);
    ui.setInventoryData(
      [item(0x8000aaaa, 'Dagger')],
      [{ ...item(HELM, 'Helm'), slot: EquipMask.HeadWear, clothingPriority: 0x4000 }],
      10, 15000,
    );
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  const paperdoll = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cd);
  const gridArea = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cf);
  const daggerCell = (): HTMLElement => gridArea().querySelector(`[data-ac-sel-guid="${0x8000aaaa}"]`) as HTMLElement;
  const headSlot = (): HTMLElement => paperdoll().querySelector('[data-equip-slot="Head"]') as HTMLElement;
  const ants = (el: HTMLElement) => el.querySelector('[data-slot-state="selected"]');

  it('selecting the worn item moves the ants from the pack cell onto its slot', () => {
    daggerCell().click();
    expect(ants(daggerCell())).toBeTruthy();
    expect(ants(headSlot())).toBeNull();
    headSlot().click();
    expect(ui.hud.target?.id).toBe(HELM);
    expect(ants(headSlot())).toBeTruthy();
    expect(ants(daggerCell())).toBeNull();
  });

  it('a selection made elsewhere (the world) clears the inventory ants on the next HUD update', () => {
    daggerCell().click();
    ui.hud.setTarget({ id: 0x7000beef, name: 'Drudge', level: 1, healthFraction: 1, distance: 3, type: 'monster' });
    ui.refreshInventorySelection();
    expect(ants(daggerCell())).toBeNull();
  });

  it('the panel rebuilds with the ants on the selected worn item', () => {
    headSlot().click();
    ui.renderInventoryPanel();
    expect(ants(headSlot())).toBeTruthy();
  });

  it('portrait view: the drag band hit-tests the click map — the helm on the head, the player on a bare region', () => {
    ui.inventorySlotsView = false;
    ui.renderInventoryPanel();
    // A 100x214 map: head blue in the top rows, chest green below, black elsewhere.
    const data = new Uint8Array(100 * 214 * 4);
    for (let y = 0; y < 214; y++) {
      for (let x = 0; x < 100; x++) {
        const o = (y * 100 + x) * 4;
        data[o + 3] = 255;
        if (x >= 40 && x < 60 && y < 30) data[o + 2] = 255;
        else if (x >= 30 && x < 70 && y >= 30 && y < 80) data[o + 1] = 255;
      }
    }
    ui.paperdollHitMap = { width: 100, height: 214, data };
    const band = paperdoll().querySelector('[data-element-id="0x100001d6"]') as HTMLElement;
    // The HUD may be scaled: the band is drawn at 2x here.
    band.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 428, right: 300, bottom: 478, x: 100, y: 50, toJSON() {} }) as DOMRect;
    const at = (type: string, x: number, y: number) =>
      band.dispatchEvent(new domWindow.MouseEvent(type, { clientX: 100 + x * 2, clientY: 50 + y * 2, bubbles: true, cancelable: true }));
    at('click', 50, 10);        // head → the helm
    at('contextmenu', 50, 50);  // chest, nothing worn → the player, examined
    at('click', 5, 200);        // black → no hit
    expect(clicks).toEqual([[HELM, false], [PLAYER, true]]);
  });
});
