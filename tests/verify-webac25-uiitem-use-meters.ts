/**
 * webac#25 — "Items such as lockpicks and healing kits do not show their uses
 * remaining bar in the hotbar."
 *
 * Retail (EoL acclient, decompiled + DAT):
 *  - The toolbar's 18 shortcut slots (0x21000016 0x100001a7..af /
 *    0x100006b7..bf) each name an item template in prop 0x1000000e:
 *    0x1000043b..43 / 0x100006c1..c9 (LayoutDesc 0x21000037), all based on
 *    0x1000045c, whose child 0x1000033c is the UIItem overlay group
 *    0x10000346: Icon_Cooldown_N0 (0x1000054f..558), CapacityBar 0x10000347,
 *    StructureBar 0x10000348 (5x30 at (26,1), 0x06004d24 / fill 0x06004d25).
 *  - UIElement_UIItem::PostInit @ 004e1870 binds m_elem_Icon_StructureBar
 *    from GetChildRecursive(0x10000348); gmToolbarUI::AddShortcut @ 004bd9a0
 *    → ItemList_AddItem @ 004e3e00 and UIElement_ItemList::
 *    ItemAttributesChanged @ 004e4f90 run UIItem_Update @ 004e21d0, which
 *    calls UpdateCapacityDisplay / UpdateStructureDisplay @ 004e17a0 /
 *    UpdateCooldownDisplay. So a shortcut slot draws the same bar a pack
 *    cell does and it drains as the kit is used.
 *  - The same overlay group sits under every item list's template: pack grid
 *    and ground container (0x1000033a: 0x21000021 / 0x21000008 / trade
 *    0x2100000d / salvage 0x2100000c / vendor 0x21000012 / slumlord
 *    0x2100000e), the paperdoll's wear slots (0x10000446.., base
 *    0x10000445). The spell bar's template 0x10000341 has none.
 *
 * Drives the real GameUI: the shortcut slots (no DATs needed) and, on the
 * DAT layouts, the paperdoll, ground container, trade and salvage lists.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { SECURE_TRADE_EL as TE } from '../packages/renderer/src/ui/SecureTradePanel.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Image', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

const PLAYER = 0x50000001;
const PACK = 0x80000020;
const KIT = 0x8000a001;
const PICK = 0x8000a002;
const GEM = 0x8000a003;
const POTION = 0x8000a004;
const COOLDOWN_ID = 7;

const inv = (id: number, extra: Record<string, unknown> = {}) => ({
  id, weenieClassId: id & 0xffff, name: `Item ${id.toString(16)}`, value: 1, burden: 1, iconDid: 0x06001022,
  stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, ...extra,
});
const ITEMS = () => [
  inv(KIT, { name: 'Healing Kit', structure: 15, maxStructure: 30 }),
  inv(PICK, { name: 'Lockpick', structure: 50, maxStructure: 50 }), // fresh: no bar (ratio exactly 1)
  inv(GEM, { name: 'Gem' }), // no MaxStructure: no bar
  inv(POTION, { name: 'Potion', cooldownId: COOLDOWN_ID, cooldownDuration: 10 }),
  inv(PACK, { name: 'Sack', itemType: 0x200, itemsCapacity: 24 }),
];
const bar = (el: Element | null | undefined) => el?.querySelector('[data-structure-bar]') as HTMLElement | null;
const fillPx = (b: HTMLElement | null) => (b?.firstElementChild as HTMLElement | null)?.style.height;

function stubTextures(ui: { uiTextures: Map<number, string> }): void {
  // The meter art (0x10000348 / 0x10000347) and the ten Icon_Cooldown_N0 deciles.
  for (const id of [0x06004d22, 0x06004d23, 0x06004d24, 0x06004d25]) ui.uiTextures.set(id, `data:tex-${id.toString(16)}`);
  for (let id = 0x060067cf; id <= 0x060067d8; id++) ui.uiTextures.set(id, `data:tex-${id.toString(16)}`);
}

describe.skipIf(!domWindow)('webac#25 — the toolbar shortcut slots carry the UIItem use meters (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let objects: number[];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // No portal DAT here: icons and meter art resolve to stand-in URLs.
    ui.getRenderedItemIconURL = (o: { isThePlayer?: boolean }) => (o.isThePlayer ? 'data:player-icon' : null);
    ui.getItemIconURL = (id: number) => `data:tex-${id.toString(16)}`;
    stubTextures(ui);
    for (let i = 0; i < 18; i++) {
      const el = domWindow.document.createElement('div');
      ui.itemShortcutSlots[i] = el;
    }
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => {
    objects = new Array(18).fill(0);
    ui.itemShortcutObjectAt = (i: number) => objects[i] ?? 0;
    ui.clearEnchantments();
    ui.setSidePackGuids([PLAYER, PACK]);
    ui.setInventoryData(ITEMS(), [], 1, 100, 102);
  });
  const put = (slot: number, guid: number, look: Record<string, unknown> = {}) => {
    objects[slot] = guid;
    ui.setItemShortcutIcon(slot, 0x06001022, `Item ${guid.toString(16)}`, { itemType: 0, ...look });
  };
  const slot = (i: number): HTMLElement => ui.itemShortcutSlots[i];

  it('a half-used healing kit on the bar shows the StructureBar at (26,1) 5x30, filled 15 of 30 px', () => {
    put(0, KIT);
    const b = bar(slot(0));
    expect(b).not.toBeNull();
    expect(b!.style.left).toBe('26px');
    expect(b!.style.top).toBe('1px');
    expect(b!.style.width).toBe('5px');
    expect(b!.style.height).toBe('30px');
    expect(b!.style.backgroundImage).toContain('tex-6004d24');
    expect((b!.firstElementChild as HTMLElement).style.backgroundImage).toContain('tex-6004d25');
    expect(fillPx(b)).toBe('15px');
  });

  it('the bar sits under the corner numeral (0x1000034a follows 0x10000348 in the template)', () => {
    put(2, KIT);
    const kids = [...slot(2).children] as HTMLElement[];
    const barAt = kids.findIndex((c) => c.dataset.structureBar);
    const numAt = kids.findIndex((c) => c.dataset.shortcutNum);
    expect(barAt).toBeGreaterThan(0);
    expect(numAt).toBeGreaterThan(barAt);
  });

  it('inverse: a fresh lockpick, an item with no MaxStructure and an empty slot show no bar', () => {
    put(0, PICK);
    put(1, GEM);
    expect(bar(slot(0))).toBeNull();
    expect(bar(slot(1))).toBeNull();
    expect(bar(slot(5))).toBeNull();
  });

  it('drains live as the kit is used (PublicUpdatePropertyInt Structure → setInventoryData), in place', () => {
    put(0, KIT);
    put(1, PICK);
    ui.setInventoryData(ITEMS().map((it) => it.id === KIT ? { ...it, structure: 6 } : it.id === PICK ? { ...it, structure: 49 } : it), [], 1, 100, 102);
    expect(fillPx(bar(slot(0)))).toBe('6px');
    // The fresh lockpick's first use shows its bar.
    expect(bar(slot(1))).not.toBeNull();
    // A spent kit keeps an empty bar.
    ui.setInventoryData(ITEMS().map((it) => it.id === KIT ? { ...it, structure: 0 } : it), [], 1, 100, 102);
    expect(fillPx(bar(slot(0)))).toBe('0px');
    // An unchanged slot is not rebuilt.
    const before = slot(0).firstElementChild;
    ui.setInventoryData(ITEMS().map((it) => it.id === KIT ? { ...it, structure: 0 } : it), [], 1, 100, 102);
    expect(slot(0).firstElementChild).toBe(before);
  });

  it('a shortcut whose object is not known yet draws no bar, and gains it when the item arrives', () => {
    put(0, KIT);
    ui.setInventoryData([], [], 1, 100, 102);
    expect(bar(slot(0))).toBeNull();
    ui.setInventoryData(ITEMS(), [], 1, 100, 102);
    expect(fillPx(bar(slot(0)))).toBe('15px');
  });

  it('a wielded item\'s shortcut reads the equipped list', () => {
    put(0, KIT);
    ui.setInventoryData(ITEMS().filter((it) => it.id !== KIT), [{ ...inv(KIT, { structure: 3, maxStructure: 4 }), slot: 0x100000 }], 1, 100, 102);
    expect(fillPx(bar(slot(0)))).toBe(`${Math.round(0.75 * 30)}px`);
  });

  it('the cooldown decile shows on the slot when its shared cooldown starts, and clears when it ends', () => {
    put(3, POTION);
    expect(slot(3).querySelector('[data-cooldown-decile]')).toBeNull();
    ui.addEnchantment({
      spellId: 0x8000 + COOLDOWN_ID, layer: 1, name: 'Cooldown', iconId: 0, isBeneficial: true, isVitae: false,
      isCooldown: true, duration: 10, startTime: 0, casterGuid: 0,
    });
    expect(slot(3).querySelector('[data-cooldown-decile]')).not.toBeNull();
    expect(ui.refreshItemShortcutOverlays()).toBe(true);
    ui.removeEnchantment(0x8000 + COOLDOWN_ID, 1);
    expect(slot(3).querySelector('[data-cooldown-decile]')).toBeNull();
    expect(ui.refreshItemShortcutOverlays()).toBe(false);
  });

  it('eras: Dark Majesty (the EoL exe) keeps the bar; a 1999 world draws none, on the bar or in the pack (UI_Item draw @ 0x004e7d20)', async () => {
    const { eraClientRules } = await import('../packages/renderer/src/era/EraFeatures.js');
    const { eraProfile } = await import('../packages/renderer/src/era/EraProfiles.js');
    expect(eraClientRules(null).itemIconMeters).toBe(true);
    expect(eraClientRules(eraProfile('classicace-customdm')).itemIconMeters).toBe(true);
    expect(eraClientRules(eraProfile('ac1999-retail')).itemIconMeters).toBe(false);
    try {
      ui.setClientRules(eraClientRules(eraProfile('classicace-customdm')));
      put(0, KIT);
      expect(fillPx(bar(slot(0)))).toBe('15px');
      ui.setClientRules(eraClientRules(eraProfile('ac1999-retail')));
      put(0, KIT);
      put(1, PACK);
      ui.setInventoryData([...ITEMS(), inv(0x8000b001, { containerId: PACK })], [], 1, 100, 102);
      expect(bar(slot(0))).toBeNull();
      expect(slot(1).querySelector('[data-capacity-bar]')).toBeNull();
      expect(ui.buildStructureBarEl(15, 30, 32)).toBeNull();
      expect(ui.buildCapacityBarEl(24, 3, 32)).toBeNull();
    } finally {
      ui.setClientRules(eraClientRules(null));
    }
  });

  it('a side-pack shortcut shows its fullness meter (0x10000347); the main pack (the player) its own', () => {
    put(0, PACK);
    expect(slot(0).querySelector('[data-capacity-bar]')).toBeNull(); // empty pack: hidden
    ui.setInventoryData([...ITEMS(), inv(0x8000b001, { containerId: PACK }), inv(0x8000b002, { containerId: PACK })], [], 1, 100, 102);
    expect(fillPx(slot(0).querySelector('[data-capacity-bar]') as HTMLElement)).toBe(`${Math.round((2 / 24) * 30)}px`);
    put(1, PLAYER, { isThePlayer: true });
    // The main pack holds KIT, PICK, GEM, POTION (the side pack is not counted) of 102.
    expect(fillPx(slot(1).querySelector('[data-capacity-bar]') as HTMLElement)).toBe(`${Math.round((4 / 102) * 30)}px`);
    expect(bar(slot(1))).toBeNull();
  });
});

describe.skipIf(!domWindow || !hasDats)('webac#25 sweep — every item list\'s UIItem keeps the uses-remaining bar (real GameUI on the DAT layouts)', () => {
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
    ui = new mod.GameUI(container, {}, portalDb, undefined, undefined, undefined, lang, new LayoutRenderer(lang, uiTextureLoader, null));
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
    stubTextures(ui);
    ui.itemShortcutObjectAt = () => 0;
    ui.itemRequestPendingFor = () => false;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => {
    ui.hideVendorWindow(); ui.hideTradeWindow(); ui.hideSalvagePanel();
    ui.setSidePackGuids([PLAYER, PACK]);
    ui.setInventoryData(ITEMS(), [], 30, 15000);
  });
  const listEl = (id: number): HTMLElement =>
    domWindow.document.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;

  it('pack grid (the existing cell): the kit has its bar, the gem and the fresh lockpick none', () => {
    if (!ui.inventoryVisible) ui.toggleInventory(); else ui.renderInventoryPanel();
    const cell = (g: number) => domWindow.document.querySelector(`[data-inv-guid="${g}"]`) as HTMLElement;
    expect(fillPx(bar(cell(KIT)))).toBe('15px');
    expect(bar(cell(GEM))).toBeNull();
    expect(bar(cell(PICK))).toBeNull();
  });

  it('paperdoll: a wielded item with uses left shows the bar on its wear slot; one without shows none', () => {
    const WAND = 0x8000a0f0;
    const SWORD = 0x8000a0f1;
    ui.setInventoryData(ITEMS(), [
      { ...inv(WAND, { name: 'Wand', structure: 10, maxStructure: 40, containerId: 0 }), slot: 0x01000000 },
      { ...inv(SWORD, { name: 'Amulet', containerId: 0 }), slot: 0x00008000 }, // NeckWear
    ], 30, 15000);
    if (!ui.inventoryVisible) ui.toggleInventory(); else ui.renderInventoryPanel();
    const wand = domWindow.document.querySelector(`[data-equip-guid="${WAND}"]`) as HTMLElement;
    const sword = domWindow.document.querySelector(`[data-equip-guid="${SWORD}"]`) as HTMLElement;
    expect(wand).not.toBeNull();
    expect(fillPx(bar(wand))).toBe(`${Math.round(0.25 * 30)}px`);
    expect(sword).not.toBeNull();
    expect(bar(sword)).toBeNull();
  });

  it('ground container (a corpse or chest): a used kit inside shows its bar; a plain item none', () => {
    const CHEST = 0x80003000;
    ui.showContainerPanel(CHEST, [
      { guid: KIT, name: 'Healing Kit', iconDid: 0x06001022, stackSize: 1, containerId: CHEST, structure: 5, maxStructure: 10 },
      { guid: GEM, name: 'Gem', iconDid: 0x06001022, stackSize: 1, containerId: CHEST },
    ], 12, { name: 'Chest', iconDid: 0x06001022, itemsCapacity: 12 });
    ui.renderContainerPanel();
    const cell = (g: number) => domWindow.document.querySelector(`[data-ac-container-cell="item"][data-ac-container-guid="${g}"]`) as HTMLElement;
    expect(fillPx(bar(cell(KIT)))).toBe('15px');
    expect(bar(cell(GEM))).toBeNull();
    ui.hideContainerPanel?.();
  });

  it('secure trade: our listed kit and the partner\'s used lockpick both show the bar; a gem none', () => {
    ui.showTradeWindow('Og');
    const entry = (guid: number, extra: Record<string, unknown> = {}) => ({ name: `i${guid}`, value: 1, guid, burden: 1, iconDid: 0x06001022, ...extra });
    ui.setTradeData({
      ...ui.tradeData, partnerGuid: 0x50000002,
      yourItems: [entry(KIT, { structure: 15, maxStructure: 30 }), entry(GEM)],
      theirItems: [entry(0x8000b001, { structure: 1, maxStructure: 4 })],
    });
    const cellIn = (list: number, g: number) =>
      ([...listEl(list).querySelectorAll('[data-ac-trade-cell]')] as HTMLElement[]).find((c) => c.dataset.guid === String(g));
    expect(fillPx(bar(cellIn(TE.selfList, KIT)))).toBe('15px');
    expect(bar(cellIn(TE.selfList, GEM))).toBeNull();
    expect(bar(cellIn(TE.partnerList, 0x8000b001))).not.toBeNull();
  });

  it('salvage: a queued partly used item keeps its bar', () => {
    ui.showSalvagePanel(0x8000c001);
    ui.salvageItems = [ITEMS()[0]];
    ui.renderSalvagePanel();
    const cell = domWindow.document.querySelector(`[data-ac-salvage-cell="item"][data-guid="${KIT}"]`) as HTMLElement | null;
    expect(cell).not.toBeNull();
    expect(bar(cell)).not.toBeNull();
  });
});

describe('webac#25 — the data paths carry Structure / MaxStructure', () => {
  it('tradeItemEntryFor keeps a used item\'s uses (self from InventoryItem, partner from ServerObject); none without MaxStructure', async () => {
    const { tradeItemEntryFor } = await import('../packages/renderer/src/ui/tradeItemEntry.js');
    expect(tradeItemEntryFor(KIT, { name: 'Kit', iconDid: 1, structure: 15, maxStructure: 30 }, true)).toMatchObject({ structure: 15, maxStructure: 30 });
    expect(tradeItemEntryFor(KIT, { name: 'Kit', iconId: 1, structure: 0, maxStructure: 30 }, false)).toMatchObject({ structure: 0, maxStructure: 30 });
    const plain = tradeItemEntryFor(GEM, { name: 'Gem', iconDid: 1 }, true);
    expect(plain.maxStructure).toBeUndefined();
    expect(plain.structure).toBeUndefined();
  });

  it('OpenContainerTracker.items() carries a contained kit\'s structure; a plain item none', async () => {
    const { OpenContainerTracker } = await import('../packages/renderer/src/world/OpenContainerTracker.js');
    const t = new OpenContainerTracker();
    const CHEST = 0x80003000;
    t.viewContents(CHEST, []);
    t.trackStoredItem(KIT, { name: 'Kit', iconDid: 1, stackSize: 1, structure: 5, maxStructure: 10 });
    t.trackStoredItem(GEM, { name: 'Gem', iconDid: 1, stackSize: 1 });
    // A CreateObject of a contained kit (acceptCreateObject's record) keeps them too.
    t.trackCreateObject({ guid: PICK, containerId: CHEST, name: 'Pick', iconDid: 1, stackSize: 1, itemType: 0, structure: 0, maxStructure: 5 });
    const items = new Map(t.items().map((i) => [i.guid, i]));
    expect(items.get(KIT)).toMatchObject({ structure: 5, maxStructure: 10 });
    expect(items.get(PICK)).toMatchObject({ structure: 0, maxStructure: 5 });
    expect(items.get(GEM)?.maxStructure).toBeUndefined();
  });
});
