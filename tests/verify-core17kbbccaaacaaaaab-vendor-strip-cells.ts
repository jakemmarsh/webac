/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — the vendor / slumlord item strips'
 * UIItem cells.
 *
 * Retail (EoL DAT + decompiled acclient):
 *  - Every list renderVendorItemStrip draws (vendor 0x100000bd / 0x100000c5 /
 *    0x100000ce on 0x21000012, slumlord 0x10000095 / 0x1000009c on
 *    0x2100000e) names cell template p0x1000000e = 0x1000033a; in 0x21000037
 *    that template's icon 0x1000033b sits at (0,0) 32x32 and its EMPTY state
 *    0x1000001c draws 0x06004d20. Ours drew a 24 px icon in a 1 px gold CSS
 *    border; selection is the UIItem's marching-ants 0x06004d09.
 *  - Each list authors p95 = -1 and no 0x10000015, so
 *    UIElement_ItemList::UpdateEmptySlots @ 004e3700 pads the view with EMPTY
 *    items to (width - n*cell) / cell; p0x10000017 (TRUE on 0x100000ce /
 *    0x10000095 / 0x1000009c only) appends one EMPTY item after a filled last
 *    item.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COINSTACK_WCID } from '@ac/shared';
import { tradeListCellCount } from '../packages/renderer/src/ui/SecureTradePanel.js';
import { SLUMLORD_EL as SE } from '../packages/renderer/src/ui/SlumlordPanel.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const DECOMP_PATH = resolve(REPO, 'reference/client-eol/decomp/acclient-decompiled.c');
const hasDats = existsSync(LOCAL_DAT) && existsSync(PORTAL_DAT);

const V = { itemsList: 0x100000bd, buyList: 0x100000c5, sellList: 0x100000ce } as const;

describe('CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — UpdateEmptySlots for one 32-px row', () => {
  it('pads the view to floor(viewW / 32) and never trims below the item count', () => {
    expect(tradeListCellCount(0, 510, false)).toBe(15);
    expect(tradeListCellCount(3, 510, false)).toBe(15);
    expect(tradeListCellCount(20, 510, false)).toBe(20);
  });
  it('p0x10000017 keeps one empty tile after a filled last cell', () => {
    expect(tradeListCellCount(3, 355, true)).toBe(11);
    expect(tradeListCellCount(11, 355, true)).toBe(12);
    expect(tradeListCellCount(11, 355, false)).toBe(11);
  });
});

describe.skipIf(!hasDats)('CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — DAT: the strips\' list attributes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parse: (id: number) => any;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } =
      await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const pbuf = readFileSync(PORTAL_DAT);
    const portal = new DatDatabase(pbuf.buffer.slice(pbuf.byteOffset, pbuf.byteOffset + pbuf.byteLength));
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
    const db = openDat(LOCAL_DAT);
    parse = (id: number) => parseLayoutDesc(new DatReader(db.getFileData(id)!));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const find = (els: any, id: number, parent?: number): any => {
    for (const [, e] of els) {
      for (const [, c] of e.children ?? []) c.__parent = e.elementId;
      if (e.elementId === id && (parent === undefined || e.__parent === parent)) return e;
      const r = find(e.children ?? new Map(), id, parent);
      if (r) return r;
    }
    return null;
  };

  it.each([
    ['vendor Items', 0x21000012, V.itemsList, false],
    ['vendor Buying', 0x21000012, V.buyList, false],
    ['vendor Selling', 0x21000012, V.sellList, true],
    ['slumlord Buy', 0x2100000e, SE.buyList, true],
    ['slumlord Rent', 0x2100000e, SE.rentList, true],
  ])('%s: template 0x1000033a, p95 -1, no 0x10000015, p0x10000017 = %s', (_n, layout, el, trailing) => {
    const list = find(parse(layout).elements, el);
    const props = list.properties;
    expect(props.get(0x1000000e).valueEnum).toBe(0x1000033a);
    expect(props.get(0x5f).valueInt).toBe(-1);
    expect(props.has(0x10000015)).toBe(false);
    expect(props.get(0x10000017)?.valueBool ?? false).toBe(trailing);
  });

  it('template 0x1000033a: icon 0x1000033b at (0,0) 32x32, EMPTY state 0x1000001c draws 0x06004d20', () => {
    const icon = find(parse(0x21000037).elements, 0x1000033b, 0x1000033a);
    expect([icon.x, icon.y, icon.width, icon.height]).toEqual([0, 0, 32, 32]);
    expect((icon.states.get(0x1000001c)?.media ?? []).map((m: { file?: number }) => m.file)).toEqual([0x06004d20]);
  });
});

describe.skipIf(!existsSync(DECOMP_PATH))('CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — decompiled anchor', () => {
  let body = '';
  beforeAll(() => {
    const src = readFileSync(DECOMP_PATH, 'utf8');
    const at = src.indexOf('===== UIElement_ItemList::UpdateEmptySlots @ 004e3700');
    body = src.slice(at, src.indexOf('// =====', at + 10));
  });
  it('pads while 0x10000015 is -1, EMPTY items state 0x1000001c, the 0x10000017 trailing item', () => {
    expect(body).toMatch(/GetAttribute_Int\(\(UIElement \*\)this,0x10000015,&local_c\), local_c == -1/);
    expect(body).toMatch(/UIItem_SetState\(pUVar4,0x1000001c\)/);
    expect(body).toMatch(/GetAttribute_Bool\(\(UIElement \*\)this,0x10000017,&local_d\)/);
  });
});

// ── GameUI drive (happy-dom + DATs) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Image', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const PACK = 0x50000001;
const SWORD = 0x8000a001;
const COINS = 0x8000a003;
const INVENTORY = [
  { id: SWORD, weenieClassId: 351, name: 'Long Sword', value: 500, burden: 200, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PACK, itemType: 0x1, iconDid: 0x06001234 },
  { id: COINS, weenieClassId: COINSTACK_WCID, name: 'Pyreal', value: 500, burden: 0, stackSize: 500, maxStackSize: 25000, stackable: true, containerId: PACK, itemType: 0x40, iconDid: 0x06001235 },
];
const MERCH = [
  { guid: 0x8000b001, weenieClassId: 351, name: 'Long Sword', price: 250, burden: 200, stackSize: 1, itemType: 0x1, iconDid: 0x06002001 },
  { guid: 0x8000b002, weenieClassId: 352, name: 'Mace', price: 150, burden: 100, stackSize: 7, itemType: 0x1, iconDid: 0x06002002 },
];

describe.skipIf(!hasDats)('CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — the live strips (GameUI, DATs)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
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
    const dat = await import('@ac/dat-parser');
    const pbuf = readFileSync(PORTAL_DAT);
    const portalDb = new dat.DatDatabase(pbuf.buffer.slice(pbuf.byteOffset, pbuf.byteOffset + pbuf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001)!)));
    const lbuf = readFileSync(LOCAL_DAT);
    const lang = new dat.DatDatabase(lbuf.buffer.slice(lbuf.byteOffset, lbuf.byteOffset + lbuf.byteLength));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000001)!)));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000002)!)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    ui = new mod.GameUI(container, {}, portalDb, undefined, undefined, undefined, lang, new LayoutRenderer(lang, uiTextureLoader, null));
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
    ui.getItemIconURL = (id: number): string => `icon:0x${id.toString(16)}`;
    ui.uiTextures.set(0x06004d20, 'data:image/png;base64,EMPTY');
    ui.uiTextures.set(0x06004d09, 'data:image/png;base64,SELECTED');
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => {
    ui.hideVendorWindow(); ui.hideSlumlordPanel();
    ui.dragItemIndex = -1;
    ui.dragSourceSlot = null;
    ui.setInventoryData(INVENTORY, [], 30, 15000);
  });
  const doc = () => domWindow.document;
  const listEl = (id: number): HTMLElement => doc().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const filled = (id: number) => [...listEl(id).querySelectorAll('[data-item-cell]')] as HTMLElement[];
  const empty = (id: number) => [...listEl(id).querySelectorAll('[data-item-cell-empty]')] as HTMLElement[];
  const viewW = (id: number) => parseFloat(listEl(id).style.width);
  const openVendor = () => ui.showVendorWindow('Tunlok Weaponsmith', MERCH, [
    { guid: SWORD, weenieClassId: 351, name: 'Long Sword', price: 250, burden: 200, stackSize: 1, iconDid: 0x06001234 },
    { guid: COINS, weenieClassId: COINSTACK_WCID, name: 'Pyreal', price: 1, burden: 0, stackSize: 500, iconDid: 0x06001235 },
  ], undefined, undefined, undefined, undefined, 0x80008888, { itemTypes: 0x1 | 0x40, minValue: 0, maxValue: 25000 });

  it('Items strip: each icon fills its 32x32 cell with no CSS border; the view is padded with the recess tile', () => {
    openVendor();
    const cells = filled(V.itemsList);
    expect(cells).toHaveLength(2);
    for (const c of cells) {
      expect(c.style.width).toBe('32px');
      expect(c.style.border).not.toMatch(/solid/);
      const icon = [...c.children].find(k => (k as HTMLElement).style.backgroundImage.includes('icon:')) as HTMLElement;
      expect(icon.style.width).toBe('32px');
      expect(icon.style.height).toBe('32px');
    }
    const w = viewW(V.itemsList);
    expect(w).toBeGreaterThan(64);
    expect(cells.length + empty(V.itemsList).length).toBe(Math.floor(w / 32));
    for (const e of empty(V.itemsList)) expect(e.style.backgroundImage).toContain('EMPTY');
  });

  it('a selected merchandise cell carries the marching-ants overlay, not a gold border', () => {
    openVendor();
    filled(V.itemsList)[1].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    const cells = filled(V.itemsList);
    const overlay = cells[1].querySelector('[data-slot-state="selected"]') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.style.backgroundImage).toContain('SELECTED');
    expect(cells[1].style.border).not.toMatch(/solid/);
    expect(cells[0].querySelector('[data-slot-state]')).toBeNull();
    // UpdateQuantityOverlay: the selected cell's amount rides above the ants.
    expect(cells[1].textContent).toContain('7');
  });

  it('Selling strip (p0x10000017): a full view still keeps one trailing empty tile; the empty tiles are drop cells', () => {
    openVendor();
    const slots = Math.floor(viewW(V.sellList) / 32);
    const n = slots;
    const sellItems = Array.from({ length: n }, (_, i) => ({ guid: 0x8000c000 + i, weenieClassId: 351, name: `Item${i}`, price: 1, burden: 1, stackSize: 1, iconDid: 0x06001234 }));
    ui.vendorData.sellItems = sellItems;
    ui.vendorData.sellList = sellItems.map(s => ({ guid: s.guid, qty: 1 }));
    ui.vendorData.tab = 2;
    ui.renderVendorPanel();
    expect(filled(V.sellList)).toHaveLength(n);
    expect(empty(V.sellList)).toHaveLength(1);
    expect(empty(V.sellList)[0].querySelector('[data-ac-drag-accept]')).not.toBeNull();
    // The Buying strip (no 0x10000017) pads to the view only.
    ui.vendorData.buyList = MERCH.map(m => ({ guid: m.guid, qty: 1 }));
    ui.vendorData.tab = 1;
    ui.renderVendorPanel();
    expect(filled(V.buyList).length + empty(V.buyList).length).toBe(Math.floor(viewW(V.buyList) / 32));
  });

  it('slumlord Buy list: staged items at 32 px, padded, with the trailing empty tile', () => {
    ui.showSlumlordPanel();
    ui.setHouseData({ profile: {
      dwellingId: 0x7200016e, bitmask: 1, houseType: 1, typeName: 'Cottage', ownerName: '', ownerId: 0,
      maintenanceFree: false, slumlordGuid: 0x80000123,
      minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
      buy: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: COINSTACK_WCID }], rent: [],
    } });
    expect(ui.addHousePaymentItem('buy', {
      guid: COINS, name: 'Pyreal', weenieClassId: COINSTACK_WCID, itemType: 0x40, stackSize: 500, value: 500, ownedByPlayer: true, iconDid: 0x06001235,
    })).toBe(true);
    const cells = filled(SE.buyList);
    expect(cells).toHaveLength(1);
    const icon = [...cells[0].children].find(k => (k as HTMLElement).style.backgroundImage.includes('icon:')) as HTMLElement;
    expect(icon.style.width).toBe('32px');
    expect(cells.length + empty(SE.buyList).length).toBe(Math.max(Math.floor(viewW(SE.buyList) / 32), 2));
  });
});
