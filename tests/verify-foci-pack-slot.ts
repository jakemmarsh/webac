/**
 * BUG.foci-in-main-pack — a Foci (Enchantment 15268, Artifice 15269, Verdancy 15270, Strife 15271,
 * Shadow 43173) sat in the main pack grid instead of the side-pack column, and the grid refused to
 * move it ("Cannot place container in item list"). Player report, end-of-retail ACE.
 *
 * Retail: ACCWeenieObject::IsContainer @ 004a4530 = bitfield & RequiresPackSlot (0x800000) ||
 * _itemsCapacity || _containersCapacity; AddContent @ 0058cce0 lists those in the containers list
 * (the side-pack column). A focus is WeenieType Generic / ItemType Misc with no capacities and
 * PropertyBool RequiresBackpackSlot; ACE sends ObjectDescriptionFlag.RequiresPackSlot for it
 * (WorldObject_Networking.cs UpdateObjectDescriptionFlags), lists it among the packs in
 * PlayerDescription (ContainerType Foci) and counts it against the side-pack slots (Container.cs).
 * Ours admitted only ItemType.Container to the column.
 *
 * Drives the shipped code with server-shaped CreateObject bytes (parseCreateObject), the inventory
 * ordering, the placement port, the real GameUI (happy-dom), the open-container tracker and the
 * agent's pack picker.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { InventoryManager, ObjectDescriptionFlag, ContainerType } from '../packages/shared/src/index.js';
import { isRetailContainer, joinsSidePackColumn, sideContainerFixedSlots } from '../packages/renderer/src/inventory/RetailIsContainer.js';
import { applyContainIdOrder, applyContainOnCreate } from '../packages/renderer/src/inventory/applyContainIdOrder.js';
import { placementObjectFromRecords } from '../packages/renderer/src/inventory/PlacementObjectOf.js';
import { acceptItemListDrop, ITEM_LIST_DROP_STRINGS, type PlacementObject, type PlacementWorld } from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { isContainerSubject } from '../packages/renderer/src/input/UseObject.js';
import { orderSidePacks } from '../packages/renderer/src/player/sidePackOrder.js';
import { packSlotCounts } from '../packages/renderer/src/agent/packCounts.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost } from './_harness/agentFake.ts';

const PLAYER = 0x50000001;
const FOCUS = 0x80001001;
const PACK = 0x80001002;
const DAGGER = 0x80001003;

// ─── ACE CreateObject wire bytes (BinaryReader semantics, as verify-core17oa-side-pack-fixed-grid.ts) ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  align(b = 4): this { const r = this.pos % b; if (r) for (let i = 0; i < b - r; i++) this.u8(0); return this; }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    const r = (2 + s.length) % 4;
    if (r) for (let i = 0; i < 4 - r; i++) this.u8(0);
    return this;
  }
  out(): Uint8Array { return new Uint8Array(this.bytes); }
}
const WHF_ITEMS_CAPACITY = 0x2;
const WHF_CONTAINERS_CAPACITY = 0x4;
const WHF_CONTAINER = 0x4000;

function createObjectBytes(o: { guid: number; name: string; wcid: number; itemType: number; bitfield: number; itemsCapacity?: number; containersCapacity?: number; containerId: number }): Uint8Array {
  const w = new Writer();
  w.u32(o.guid);
  w.u8(0x11).u8(0).u8(0).u8(0); // ObjDesc header, no sub-blocks
  w.align(4);
  w.u32(0); // physics flags
  w.u32(0); // physics state
  for (let i = 0; i < 9; i++) w.u16(0); // sequence timestamps
  w.align(4);
  let flags = WHF_CONTAINER;
  if (o.itemsCapacity !== undefined) flags |= WHF_ITEMS_CAPACITY;
  if (o.containersCapacity !== undefined) flags |= WHF_CONTAINERS_CAPACITY;
  w.u32(flags);
  w.string16(o.name);
  w.u16(o.wcid); // packed wcid (2-byte form)
  w.u16(0x1234); // packed icon
  w.u32(o.itemType);
  w.u32(o.bitfield);
  w.align(4);
  if (o.itemsCapacity !== undefined) w.u8(o.itemsCapacity);
  if (o.containersCapacity !== undefined) w.u8(o.containersCapacity);
  w.u32(o.containerId);
  w.align(4);
  return w.out();
}

// What ACE sends: a focus is Misc (0x80), Attackable + RequiresPackSlot; a pack is Container (0x200), Openable, ItemsCapacity 24.
const focusWire = () => parseCreateObject(createObjectBytes({
  guid: FOCUS, name: 'Foci of Strife', wcid: 15271, itemType: 0x80,
  bitfield: ObjectDescriptionFlag.Attackable | ObjectDescriptionFlag.RequiresPackSlot, containerId: PLAYER,
}))!;
const packWire = () => parseCreateObject(createObjectBytes({
  guid: PACK, name: 'Pack', wcid: 136, itemType: 0x200,
  bitfield: ObjectDescriptionFlag.Openable | ObjectDescriptionFlag.Attackable, itemsCapacity: 24, containersCapacity: 0, containerId: PLAYER,
}))!;
const daggerWire = () => parseCreateObject(createObjectBytes({
  guid: DAGGER, name: 'Dagger', wcid: 314, itemType: 0x1, bitfield: ObjectDescriptionFlag.Attackable, containerId: PLAYER,
}))!;

describe('the side-pack column admits what IsContainer admits (CreateObject / pick-up)', () => {
  it('parses the focus as ACE sends it: ItemType Misc, RequiresPackSlot, no capacities', () => {
    const f = focusWire();
    expect(f.guid).toBe(FOCUS);
    expect(f.itemType).toBe(0x80);
    expect(f.objectDescFlags & ObjectDescriptionFlag.RequiresPackSlot).toBe(ObjectDescriptionFlag.RequiresPackSlot);
    expect(f.itemsCapacity).toBe(0);
    expect(f.containerId).toBe(PLAYER);
  });

  it('a focus in the player joins the column; so does a pack; a dagger does not', () => {
    expect(joinsSidePackColumn(focusWire(), PLAYER)).toBe(true);
    expect(joinsSidePackColumn(packWire(), PLAYER)).toBe(true);
    expect(joinsSidePackColumn(daggerWire(), PLAYER)).toBe(false);
  });

  it('only directly in the player and not wielded (nothing extra joins)', () => {
    expect(joinsSidePackColumn({ ...focusWire(), containerId: PACK }, PLAYER)).toBe(false);
    expect(joinsSidePackColumn({ ...focusWire(), containerId: 0, wielderId: PLAYER }, PLAYER)).toBe(false);
    expect(joinsSidePackColumn(focusWire(), null)).toBe(false);
    // An AC1999 / GDLE object whose RequiresPackSlot is 0 and has no capacity stays an item.
    expect(joinsSidePackColumn({ ...focusWire(), objectDescFlags: ObjectDescriptionFlag.Attackable }, PLAYER)).toBe(false);
  });

  it('the inventory entry built from it keeps the answer (the ServerSaysContainID pick-up path)', () => {
    const focus = buildInventoryEntry(focusWire());
    const pack = buildInventoryEntry(packWire());
    expect(isRetailContainer(focus)).toBe(true);
    expect(joinsSidePackColumn({ ...focus, containerId: PLAYER }, PLAYER)).toBe(true);
    expect(isRetailContainer(pack)).toBe(true);
    expect(isRetailContainer(buildInventoryEntry(daggerWire()))).toBe(false);
  });

  it('the same test drives UseObject and the placement records', () => {
    const f = focusWire();
    expect(isContainerSubject({ bitfield: f.objectDescFlags, itemsCapacity: f.itemsCapacity ?? 0, containersCapacity: f.containersCapacity ?? 0 })).toBe(true);
    expect(placementObjectFromRecords(FOCUS, { created: { ...f } }, { inTrade: false, inOpenContainer: false })!.isContainer).toBe(true);
    expect(placementObjectFromRecords(DAGGER, { created: { ...daggerWire() } }, { inTrade: false, inOpenContainer: false })!.isContainer).toBe(false);
  });
});

describe('the focus is listed among the player\'s containers (ordering)', () => {
  const add = (inv: InventoryManager, d: ReturnType<typeof focusWire>) => inv.addItem(buildInventoryEntry(d), d.guid);

  it('a create lists it in the containers list (SetWeenieDesc / AddContent), not the items list', () => {
    const inv = new InventoryManager();
    add(inv, daggerWire());
    add(inv, packWire());
    add(inv, focusWire());
    expect(applyContainOnCreate(inv, { guid: PACK, containerId: PLAYER, objectDescFlags: packWire().objectDescFlags, itemsCapacity: 24 }).packs).toBe(true);
    expect(applyContainOnCreate(inv, { guid: FOCUS, containerId: PLAYER, objectDescFlags: focusWire().objectDescFlags }).packs).toBe(true);
    expect(applyContainOnCreate(inv, { guid: DAGGER, containerId: PLAYER, objectDescFlags: daggerWire().objectDescFlags }).packs).toBe(false);
    expect(inv.containerOrder(PLAYER, true)).toEqual(expect.arrayContaining([FOCUS, PACK]));
    expect(inv.containerOrder(PLAYER, true)).not.toContain(DAGGER);
  });

  it('a ServerSaysContainID with ContainerType Foci moves it within the containers list', () => {
    const inv = new InventoryManager();
    add(inv, packWire());
    add(inv, focusWire());
    inv.setContainerContents(PLAYER, [{ guid: PACK, containerType: ContainerType.Container }, { guid: FOCUS, containerType: ContainerType.Foci }]);
    expect(applyContainIdOrder(inv, { itemGuid: FOCUS, containerGuid: PLAYER, slot: 0, itemType: ContainerType.Foci })).toBe(true);
    expect(inv.containerOrder(PLAYER, true)).toEqual([FOCUS, PACK]);
  });

  it('PlayerDescription\'s placement (packs and foci together) orders the column', () => {
    const placement = [{ guid: DAGGER, containerType: 0 }, { guid: FOCUS, containerType: ContainerType.Foci }, { guid: PACK, containerType: ContainerType.Container }];
    const inv = new InventoryManager();
    add(inv, daggerWire()); add(inv, packWire()); add(inv, focusWire());
    inv.setContainerContents(PLAYER, placement);
    expect(inv.containerOrder(PLAYER, true)).toEqual([FOCUS, PACK]);
    // Creates arrived pack first; the column follows the saved order.
    expect(orderSidePacks([PLAYER, PACK, FOCUS], placement.map((p) => p.guid))).toEqual([PLAYER, FOCUS, PACK]);
  });
});

describe('dragging a focus (UIElement_ItemList::AcceptDragObject)', () => {
  const objs = new Map<number, PlacementObject>();
  const base = { stackSize: 1, maxStackSize: 1, holder: false, inTrade: false, isPlayer: false, contained: true, ownedByPlayer: true };
  objs.set(PLAYER, { id: PLAYER, name: 'Me', weenieClassId: 1, stackSize: 0, maxStackSize: 0, itemsCapacity: 102, containersCapacity: 7, isContainer: true, holder: true, inTrade: false, isPlayer: true });
  objs.set(FOCUS, { id: FOCUS, name: 'Foci of Strife', weenieClassId: 15271, itemsCapacity: 0, containersCapacity: 0, isContainer: true, ...base });
  objs.set(PACK, { id: PACK, name: 'Pack', weenieClassId: 136, itemsCapacity: 24, containersCapacity: 0, isContainer: true, ...base, holder: true });
  objs.set(DAGGER, { id: DAGGER, name: 'Dagger', weenieClassId: 314, itemsCapacity: 0, containersCapacity: 0, isContainer: false, ...base });
  const world: PlacementWorld = {
    playerId: PLAYER, object: (id) => objs.get(id),
    itemsOf: (h) => (h === PLAYER ? [DAGGER] : []), containersOf: (h) => (h === PLAYER ? [PACK, FOCUS] : []),
    splitSize: 1, maxSplitSize: 1, objectSplitSize: () => 1, dragSplit: () => ({ amount: 1, partial: false }),
  };

  it('onto the item grid it is refused (why it must not be shown there)', () => {
    expect(acceptItemListDrop({ itemId: FOCUS, cellItemId: 0, listContainerId: PLAYER, cellPlacement: 0, containerList: false }, world))
      .toEqual({ kind: 'refused', notice: ITEM_LIST_DROP_STRINGS.containerInItemList });
  });

  it('within the pack column it moves: onto the pack\'s cell it is put back in the player at that place', () => {
    const r = acceptItemListDrop({ itemId: FOCUS, cellItemId: PACK, listContainerId: PLAYER, cellPlacement: 0, containerList: true }, world);
    expect(r.kind).toBe('put');
    expect(r.kind === 'put' && r.containerId).toBe(PLAYER);
  });

  it('a real pack still moves in the column and an item onto the focus is refused by name (it holds nothing)', () => {
    expect(acceptItemListDrop({ itemId: PACK, cellItemId: FOCUS, listContainerId: PLAYER, cellPlacement: 1, containerList: true }, world).kind).toBe('put');
    expect(acceptItemListDrop({ itemId: DAGGER, cellItemId: FOCUS, listContainerId: PLAYER, cellPlacement: 1, containerList: true }, world))
      .toEqual({ kind: 'refused', notice: ITEM_LIST_DROP_STRINGS.cannotAcceptItems.replace('%s', 'Foci of Strife') });
  });
});

describe('counts: the focus takes a pack slot, not an item slot', () => {
  it('packSlotCounts leaves it out of the main pack\'s items', () => {
    const items = [buildInventoryEntry(daggerWire()), buildInventoryEntry(focusWire()), buildInventoryEntry(packWire())]
      .map((e, i) => ({ ...e, id: [DAGGER, FOCUS, PACK][i] }));
    const counts = packSlotCounts(items, {
      playerGuid: PLAYER, sidePackGuids: [PLAYER, PACK, FOCUS], worn: new Set(), isPack: (i) => isRetailContainer(i),
      capacityOf: (slot, guid) => (slot === 0 ? 102 : sideContainerFixedSlots(items.find((i) => i.id === guid)!)),
    });
    expect(counts).toEqual([
      { slot: 0, guid: PLAYER, capacity: 102, count: 1 },
      { slot: 1, guid: PACK, capacity: 24, count: 0 },
      { slot: 2, guid: FOCUS, capacity: 0, count: 0 },
    ]);
  });

  it('ItemList_UpdateContainerListSize: a focus (not Openable) lists 0 cells; a pack its capacity; a bare record pads', () => {
    expect(sideContainerFixedSlots(buildInventoryEntry(focusWire()))).toBe(0);
    expect(sideContainerFixedSlots(buildInventoryEntry(packWire()))).toBe(24);
    expect(sideContainerFixedSlots({})).toBe(-1);
  });
});

describe('a focus stored into a chest is a sub-container there (OpenContainerTracker)', () => {
  it('trackStoredItem with no ViewContents entry reads IsContainer, not the ItemType', () => {
    const t = new OpenContainerTracker();
    t.viewContents(0x80009999, []);
    const f = buildInventoryEntry(focusWire());
    t.trackStoredItem(FOCUS, { name: f.name, iconDid: f.iconDid, stackSize: 1, itemType: f.itemType, itemsCapacity: f.itemsCapacity, objectDescFlags: f.objectDescFlags });
    const d = buildInventoryEntry(daggerWire());
    t.trackStoredItem(DAGGER, { name: d.name, iconDid: d.iconDid, stackSize: 1, itemType: d.itemType, objectDescFlags: d.objectDescFlags });
    const byGuid = new Map(t.items().map((i) => [i.guid, i.isContainer]));
    expect(byGuid.get(FOCUS)).toBe(true);
    expect(byGuid.get(DAGGER)).toBe(false);
  });
});

describe('the agent never picks a focus as the pack to move into', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('"side" picks the pack even when the focus comes first; the focus by name is no pack', () => {
    host.inv = [
      { guid: FOCUS, name: 'Foci of Strife', where: 'pack slots', itemType: 0x80 },
      { guid: PACK, name: 'Pack', where: 'pack slots', itemType: 0x200 },
    ];
    host.packs = () => [
      { slot: 0, guid: host.me.guid, capacity: 102, count: 0 },
      { slot: 1, guid: FOCUS, capacity: 0, count: 0 },
      { slot: 2, guid: PACK, capacity: 24, count: 0 },
    ];
    expect(api.packFor(null)).toMatchObject({ slot: 2, name: 'Pack' });
    expect(api.packFor('foci of strife')).toMatch(/^no side pack named/);
  });
});

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('the inventory panel (real GameUI): the focus shows in the column, not the grid', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const ELEMENT_IDS = [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_id: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of ELEMENT_IDS) { const el = domWindow.document.createElement('div'); root.appendChild(el); elements.set(id, el); }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
    const entries = [
      { ...buildInventoryEntry(daggerWire()), id: DAGGER },
      { ...buildInventoryEntry(packWire()), id: PACK },
      { ...buildInventoryEntry(focusWire()), id: FOCUS },
    ];
    ui.setSidePackGuids([PLAYER, PACK, FOCUS]);
    ui.setInventoryData(entries, [], 30, 15000, 102, 7);
    ui.selectedPackSlot = 0;
    ui.toggleInventory();
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const grid = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cf);
  const gridGuids = (): number[] => [...grid().querySelectorAll('[data-ac-sel-guid]')].map((e) => Number((e as HTMLElement).dataset.acSelGuid));
  const columnSlot = (row: number): HTMLElement => {
    const strip = ui.inventoryPanelHandle.elements.get(0x100001ce);
    return [...strip.children].find((d) => (d as HTMLElement).style.width === '36px' && (d as HTMLElement).style.top === `${73 + (row - 1) * 36}px`) as HTMLElement;
  };

  it('the main pack grid lists the dagger and neither the pack nor the focus', () => {
    expect(gridGuids()).toContain(DAGGER);
    expect(gridGuids()).not.toContain(FOCUS);
    expect(gridGuids()).not.toContain(PACK);
  });

  it('the focus has its own cell in the column (once), after the pack', () => {
    expect(columnSlot(2).querySelector('[data-ac-sel-guid]')?.getAttribute('data-ac-sel-guid')).toBe(`${FOCUS}`);
    expect(columnSlot(1).querySelector('[data-ac-sel-guid]')?.getAttribute('data-ac-sel-guid')).toBe(`${PACK}`);
    expect(columnSlot(2).draggable).toBe(true);
  });

  it('clicking it opens it as retail does: "Contents of Foci of Strife" over an empty list (0 fixed cells)', () => {
    columnSlot(2).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.selectedPackSlot).toBe(2);
    expect(grid().textContent).toContain('Contents of Foci of Strife');
    const cells = grid().querySelector('div[style*="grid"]') as HTMLElement | null;
    expect(cells ? cells.children.length : 0).toBe(0);
  });

  it('the pack still opens to its 24 cells', () => {
    columnSlot(1).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.selectedPackSlot).toBe(1);
    expect((grid().querySelector('div[style*="grid"]') as HTMLElement).children.length).toBe(24);
  });

  it('a vendor buy counts a focus against the side-pack slots (InqListSlotCount)', () => {
    ui.hud.coinValue = 1000;
    const focus = { objectDescFlags: ObjectDescriptionFlag.RequiresPackSlot, maxStackSize: 1 };
    // 7 container slots, 2 taken (the pack and the focus): 5 more fit, a 6th does not.
    expect(ui.vendorBuyRefusal([{ item: focus, qty: 5 }], 0)).toBeNull();
    expect(ui.vendorBuyRefusal([{ item: focus, qty: 6 }], 0)).toBe('You must empty some slots in your backpack first');
  });
});
