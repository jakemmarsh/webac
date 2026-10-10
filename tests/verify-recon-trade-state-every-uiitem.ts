/**
 * RECON.inventory-grid-dat-cells.c.b — the trade-state overlay on every UIItem.
 *
 * Retail (EoL acclient, decompiled): UIElement_UIItem::UIItem_Update @ 004e21d0
 * SetVisible(weenObj->tradeState != 0)s m_elem_Icon_TradeState (overlays
 * 0x21000037:0x10000346 child 0x10000438, media 0x06001dae) on EVERY UIItem
 * whose template carries the overlay layer, not only the pack grid's. The
 * object's tradeState is set by gmSecureTradeUI::AddItem @ 004ca780 /
 * AddMyItem @ 004c9e80 (our own listed items; AddPartnerItem never sets it),
 * gmSalvageUI::_AddItem @ 004cb2d0 and gmSlumlordUI::AddItem. So a traded or
 * salvage-queued worn item shows it on its paperdoll slot, an empty side pack
 * on its pack column cell, and our own cells in the trade window's self list,
 * the salvage list and the slumlord's lists carry it too. The trade window's
 * partner list never does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { COINSTACK_WCID } from '@ac/shared';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';
import { SECURE_TRADE_EL as TE } from '../packages/renderer/src/ui/SecureTradePanel.js';
import { SLUMLORD_EL as SE } from '../packages/renderer/src/ui/SlumlordPanel.js';

const REPO = resolve(__dirname, '..');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const hasDats = existsSync(LOCAL_DAT) && existsSync(PORTAL_DAT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Image', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];
const TRADE_TEX = 'data:image/png;base64,TRADE';

const PLAYER = 0x50000001;
const PACK = 0x80000020;
const DAGGER = 0x8000a001;
const COINS = 0x8000a003;
const SWORD = 0x8000a0ff;
const HAND = 0x00100000; // EquipMask.MeleeWeapon
const IRON = 4; // MaterialType.Iron… any valid salvage material
const INVENTORY = [
  { id: DAGGER, weenieClassId: 900, name: 'Plain Dagger', value: 10, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemType: 0x1 },
  { id: COINS, weenieClassId: COINSTACK_WCID, name: 'Pyreal', value: 500, burden: 0, stackSize: 500, maxStackSize: 25000, stackable: true, containerId: PLAYER, itemType: 0x40 },
  { id: PACK, weenieClassId: 902, name: 'Sack', value: 10, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemsCapacity: 24 },
];
const WIELDED = [
  { id: SWORD, weenieClassId: 903, name: 'Long Sword', value: 300, burden: 100, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0, slot: HAND, materialType: IRON, structure: 0 },
];
const tradeEntry = (guid: number, name: string) => ({ name, value: 10, guid, burden: 1, iconDid: 0 });
const trading = (ui: { tradeData: object }, yours: number[], theirs: number[] = []) => ({
  ...ui.tradeData,
  partnerGuid: 0x50000002,
  yourItems: yours.map(g => tradeEntry(g, `mine${g}`)),
  theirItems: theirs.map(g => tradeEntry(g, `theirs${g}`)),
});
const tradeOverlay = (cell: Element | null | undefined) =>
  (cell?.querySelector(':scope > [data-slot-state="trade"]') ?? null) as HTMLElement | null;

describe.skipIf(!domWindow)('RECON.inventory-grid-dat-cells.c.b — paperdoll slots and the pack column (real GameUI)', () => {
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
    ui.uiTextures.set(0x06001dae, TRADE_TEX);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => {
    ui.tradeData = { ...ui.tradeData, partnerGuid: 0, yourItems: [], theirItems: [] };
    ui.salvageItems = [];
  });

  function render(): void {
    ui.setInventoryData(INVENTORY, WIELDED, 1, 100);
    ui.setSidePackGuids([PLAYER, PACK]);
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    else ui.renderInventoryPanel();
  }
  const panel = (): HTMLElement => ui.inventoryPanelHandle.root as HTMLElement;
  const swordSlot = (): HTMLElement | null =>
    panel().querySelector(`[data-equip-slot][data-ac-sel-guid="${SWORD}"]`) ?? panel().querySelector(`[data-ac-sel-guid="${SWORD}"]`);
  const sackCell = (): HTMLElement | undefined =>
    ([...panel().querySelectorAll('[data-pack-wait-cell]')] as HTMLElement[]).find(c => c.dataset.acSelGuid === String(PACK));

  it('a worn item listed in a secure trade shows 0x06001dae on its paperdoll slot', () => {
    ui.tradeData = trading(ui, [SWORD]);
    render();
    const o = tradeOverlay(swordSlot());
    expect(o).not.toBeNull();
    expect(o!.style.backgroundImage).toContain('TRADE');
    expect(o!.style.width).toBe('32px');
  });

  it('a worn item queued for salvage shows it too (gmSalvageUI::_AddItem SetTradeState(1))', () => {
    ui.salvageItems = [WIELDED[0]];
    render();
    expect(tradeOverlay(swordSlot())).not.toBeNull();
  });

  it('a traded empty side pack shows it on its pack column cell; nothing else carries it', () => {
    ui.tradeData = trading(ui, [PACK]);
    render();
    expect(tradeOverlay(sackCell())).not.toBeNull();
    expect(tradeOverlay(swordSlot())).toBeNull();
    expect(panel().querySelectorAll('[data-slot-state="trade"]')).toHaveLength(1);
  });

  it('no trade, no salvage queue → no overlay anywhere in the panel', () => {
    render();
    expect(panel().querySelectorAll('[data-slot-state="trade"]')).toHaveLength(0);
  });

  it('a trade-list change restyles the paperdoll slot and pack column in place (no rebuild), both ways', () => {
    render();
    const slot = swordSlot()!;
    const sack = sackCell()!;
    expect(tradeOverlay(slot)).toBeNull();
    ui.setTradeData(trading(ui, [SWORD, PACK]));
    expect(slot.isConnected).toBe(true);
    expect(sack.isConnected).toBe(true);
    expect(tradeOverlay(slot)).not.toBeNull();
    expect(tradeOverlay(sack)).not.toBeNull();
    ui.setTradeData(trading(ui, []));
    expect(tradeOverlay(slot)).toBeNull();
    expect(tradeOverlay(sack)).toBeNull();
  });

  it('an in-place restyle never stacks a second overlay on a cell that already has one', () => {
    ui.tradeData = trading(ui, [SWORD]);
    render();
    ui.setTradeData(trading(ui, [SWORD, PACK]));
    ui.setTradeData(trading(ui, [SWORD, PACK, DAGGER]));
    expect(swordSlot()!.querySelectorAll(':scope > [data-slot-state="trade"]')).toHaveLength(1);
  });
});

describe.skipIf(!domWindow || !hasDats)('RECON.inventory-grid-dat-cells.c.b — the transaction-dock lists (real GameUI on the DAT layouts)', () => {
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
    const portalDb = openDat(PORTAL_DAT);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001)!)));
    const lang = openDat(LOCAL_DAT);
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000001)!)));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000002)!)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    ui = new mod.GameUI(container, {}, portalDb, undefined, undefined, undefined, lang, new LayoutRenderer(lang, uiTextureLoader, null));
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
    ui.uiTextures.set(0x06001dae, TRADE_TEX);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => {
    ui.hideVendorWindow(); ui.hideTradeWindow(); ui.hideSlumlordPanel(); ui.hideSalvagePanel();
    ui.setInventoryData(INVENTORY, WIELDED, 30, 15000);
  });
  const listEl = (id: number): HTMLElement =>
    domWindow.document.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;

  it('trade: our own listed items carry the overlay; the partner\'s items and the empty cells never do', () => {
    ui.showTradeWindow('Og');
    ui.setTradeData(trading(ui, [DAGGER], [0x8000b001]));
    const self = [...listEl(TE.selfList).querySelectorAll('[data-ac-trade-cell]')] as HTMLElement[];
    const partner = [...listEl(TE.partnerList).querySelectorAll('[data-ac-trade-cell]')] as HTMLElement[];
    const mine = self.find(c => c.dataset.guid === String(DAGGER));
    const theirs = partner.find(c => c.dataset.guid === String(0x8000b001));
    expect(tradeOverlay(mine)?.style.backgroundImage).toContain('TRADE');
    expect(theirs).toBeDefined();
    expect(tradeOverlay(theirs)).toBeNull();
    for (const c of [...self, ...partner]) if (c.dataset.acTradeCell === 'empty') expect(tradeOverlay(c)).toBeNull();
  });

  it('salvage: each queued object\'s list cell carries the overlay', () => {
    ui.showSalvagePanel(0x8000c001);
    ui.salvageItems = [WIELDED[0]];
    ui.renderSalvagePanel();
    const cell = domWindow.document.querySelector(`[data-ac-salvage-cell="item"][data-guid="${SWORD}"]`) as HTMLElement | null;
    expect(cell).not.toBeNull();
    expect(tradeOverlay(cell)?.style.backgroundImage).toContain('TRADE');
  });

  it('slumlord: a staged payment\'s Buy-list cell carries the overlay', () => {
    ui.showSlumlordPanel();
    ui.setHouseData({
      profile: {
        dwellingId: 0x7200016e, bitmask: 1, houseType: 1, typeName: 'Cottage', ownerName: '', ownerId: 0,
        maintenanceFree: false, slumlordGuid: 0x80000123, minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
        buy: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: COINSTACK_WCID }],
        rent: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 0, weenieId: COINSTACK_WCID }],
      },
    });
    expect(ui.addHousePaymentItem('buy', {
      guid: COINS, name: 'Pyreal', weenieClassId: COINSTACK_WCID, itemType: 0x40, stackSize: 500, value: 500, ownedByPlayer: true,
    })).toBe(true);
    const cells = [...listEl(SE.buyList).querySelectorAll('[data-item-cell]')] as HTMLElement[];
    expect(cells).toHaveLength(1);
    expect(tradeOverlay(cells[0])?.style.backgroundImage).toContain('TRADE');
  });
});
