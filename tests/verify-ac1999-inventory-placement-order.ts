/**
 * BUG.ac1999-inventory-placement-order — Jake on playwebac.com, AC1999 (2026-11-01): "it feels kind
 * of random where new items go in my bag. i picked a key off the ground and it went into the second
 * slot (between existing items). when an npc gave me a potion, it went to the end".
 *
 * A contain-in (0x22 InventoryPutObjInContainer, the same 4 u32s in every era) INSERTS the item at
 * its slot and shifts the rest, in the client (EoL IDList::AddAtNum @ 005add20 via AddContent
 * @ 0058cce0 / ServerSaysContainID @ 0058be40; 1999 ACCWeenieObject_AddContent @ 0x004e26d0) and on
 * both servers (AC1999 Container_InsertInventoryItem inserts into m_Items / m_Packs; ACE
 * Container.TryAddToInventory shifts every PlacementPosition at or past it). A double-click pick-up
 * asks for slot 0 in both clients (1999 PlaceInBackpack @ 0x004ffb80 → ItemHolder_AttemptPlaceIn-
 * Container(item, player, 0, 1); EoL PlaceInBackpack @ 0055d8c0), and the AC1999 server's vendor buy
 * and loot spawn (SpawnInContainer) send slot 0 and insert at 0. (A give sends the receiver no 0x22
 * at all, only the contained create: webac#29, tests/verify-give-receiver-placement.ts.)
 * So every one of them lands FIRST.
 *
 * Ours kept one guid → slot map with no shifting: the key's slot 0 tied with the item already at 0
 * and drew after it (the second slot), and each later slot-0 add queued behind the earlier ones.
 *
 * The bytes are built as the AC1999 server writes them (ObjectMsgs.cpp InventoryMove) and as ACE
 * writes GameEventItemServerSaysContainId, and go through the REAL 1999 adapter, the real
 * ServerMessageHandler and the shipped applyContainIdOrder + InventoryManager.
 */
import { describe, expect, it } from 'vitest';
import { InventoryManager, type InventoryItem } from '@ac/shared';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { applyContainIdOrder } from '../packages/renderer/src/inventory/applyContainIdOrder.js';
import { routeViewContents } from '../packages/renderer/src/world/ViewContentsRouter.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';

const PLAYER = 0x50000003;
const PACK = 0x90000200;
const PACK2 = 0x90000201;
const A = 0x90000301, B = 0x90000302, C = 0x90000303;
const KEY = 0x90000400;
const POTION = 0x90000401;
const SPLIT = 0x90000402;

const NAMES: Record<number, string> = {
  [A]: 'A', [B]: 'B', [C]: 'C', [KEY]: 'Key', [POTION]: 'Potion', [SPLIT]: 'Split', [PACK]: 'Pack', [PACK2]: 'Pack2',
};

/** The AC1999 server's InventoryMove (ObjectMsgs.cpp): 0xF7B0-wrapped 0x22 {item, container, slot, type}. */
const move1999 = (item: number, container: number, slot: number, type = 0) =>
  new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(0x22).u32(item).u32(container).u32(slot).u32(type).toBytes();

/** ACE GameEventItemServerSaysContainId: guid, container, PlacementPosition, ContainerType. */
const containIdEoR = (item: number, container: number, slot: number, type = 0) => {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  [0xf7b0, PLAYER, 7, 0x22, item, container, slot, type].forEach((x, i) => v.setUint32(i * 4, x >>> 0, true));
  return b;
};

/** A 1999 0xF745 for an item not contained yet (world POSITION, no container), as SpawnInContainer / a ground item. */
function create1999(guid: number): Uint8Array {
  const w = new Writer1999().u32(0xf745).u32(guid);
  w.u8(0x11).u8(0).u8(0).u8(0).align4();
  w.u32(0x1 | 0x2 | 0x20000 | 0x8000).u32(0x14).u32(0x65);
  w.u32(0).f32(0).f32(0).f32(0).f32(1).f32(0).f32(0).f32(0);
  w.u32(0x09000001).u32(0x020000c4);
  for (let i = 0; i < 9; i++) w.u16(i + 1);
  w.align4();
  const header = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x10000;
  w.u32(header).acString(NAMES[guid] ?? 'Thing').u16(0x0102).u16(0x1aa5).u32(0x2).u32(0x10);
  w.acString('Things').u8(0).u8(0).u32(10).u32(1).f32(0.5).u32(0).u8(0).u8(0).u16(5).u16(10).u16(1).u16(1);
  w.u32(0x1);
  return w.align4().toBytes();
}

const item = (guid: number, containerId = PLAYER): Omit<InventoryItem, 'id'> => ({
  weenieClassId: 1, name: NAMES[guid] ?? 'Thing', value: 0, burden: 0, stackSize: 1, maxStackSize: 1, stackable: false, containerId,
});

/** main.ts's glue: a carried item's create adds it; a 0x22 adds a picked-up ground object, then places it. */
function client() {
  const inv = new InventoryManager();
  const world = new Set<number>();
  const h = new ServerMessageHandler();
  h.setHandlers({
    onObjectCreate: (d) => {
      if (d.containerId) inv.addItem(item(d.guid, d.containerId), d.guid);
      else world.add(d.guid);
    },
    onInventoryPut: (d) => {
      const held = inv.getItem(d.itemGuid);
      if (!held && world.delete(d.itemGuid)) inv.addItem(item(d.itemGuid, d.containerGuid), d.itemGuid);
      else if (held) held.containerId = d.containerGuid;
      applyContainIdOrder(inv, d);
    },
  });
  const login = (guids: number[]) => {
    for (const g of guids) inv.addItem(item(g), g);
    // The PlayerDescription's ContentProfile list (1999: m_Items then m_Packs; ACE: by PlacementPosition).
    inv.setContainerContents(PLAYER, guids.map((g) => ({ guid: g, containerType: g === PACK || g === PACK2 ? 1 : 0 })));
  };
  const mainPack = () => inv.getByContainer(PLAYER).filter((i) => i.id !== PACK && i.id !== PACK2).map((i) => i.name);
  const feed = (m: Uint8Array) => h.handleMessage(deserializeMessage(m));
  return { inv, h, login, mainPack, feed };
}

describe('AC1999: every way an item enters the main pack lands where the server put it', () => {
  const rig = () => {
    const c = client();
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    const send = (m: Uint8Array, group = 4) => { for (const out of a.inbound(m, group)) c.feed(out); };
    // The server created the carried items before the PlayerDescription (CClientEvents::LoginCharacter),
    // so the adapter knows them: a later 0x22 for one passes at once.
    const known = (guids: number[]) => { for (const g of guids) a.inbound(create1999(g), 3); };
    const login = (guids: number[]) => { known(guids); c.login(guids); };
    return { ...c, send, login, known };
  };

  it('a ground pick-up (double-click, slot 0) goes first, not second', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(create1999(KEY), 3); // the key on the ground
    r.send(move1999(KEY, PLAYER, 0)); // FinishMoveItemToContainer's 0x22, slot as asked
    expect(r.mainPack()).toEqual(['Key', 'A', 'B', 'C']);
  });

  it('a vendor buy / reward spawn (SpawnInContainer: 0x22 slot 0 before the create) goes first, not after the others', () => {
    // (A give reaches the receiver as a contained create alone: tests/verify-give-receiver-placement.ts.)
    const r = rig();
    r.login([A, B, C]);
    r.send(move1999(POTION, PLAYER, 0));
    r.send(create1999(POTION), 3);
    expect(r.mainPack()).toEqual(['Potion', 'A', 'B', 'C']);
  });

  it('a pick-up and then a give each go first, in turn (no slot-0 pile-up)', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 0));
    r.send(move1999(POTION, PLAYER, 0)); // a vendor buy / loot spawn (SpawnInContainer) is the same shape
    r.send(create1999(POTION), 3);
    expect(r.mainPack()).toEqual(['Potion', 'Key', 'A', 'B', 'C']);
  });

  it('a drag onto a cell (slot 2) inserts there and shifts the rest', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 2));
    expect(r.mainPack()).toEqual(['A', 'B', 'Key', 'C']);
  });

  it('a slot past the end appends (AddContent clamps it to the count)', () => {
    const r = rig();
    r.login([A, B]);
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 50));
    expect(r.mainPack()).toEqual(['A', 'B', 'Key']);
  });

  it('a split to slot 1 (0x22 before the new stack\'s create) lands at 1', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(move1999(SPLIT, PLAYER, 1));
    r.send(create1999(SPLIT), 3);
    expect(r.mainPack()).toEqual(['A', 'Split', 'B', 'C']);
  });

  it('a move within the pack takes the item out first, then inserts it', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(move1999(A, PLAYER, 2));
    expect(r.mainPack()).toEqual(['B', 'C', 'A']);
    r.send(move1999(C, PLAYER, 0));
    expect(r.mainPack()).toEqual(['C', 'B', 'A']);
  });

  it('a move into a side pack closes the gap in the main pack', () => {
    const r = rig();
    r.login([A, B, C, PACK]);
    r.send(move1999(B, PACK, 0));
    expect(r.mainPack()).toEqual(['A', 'C']);
    expect(r.inv.getByContainer(PACK).map((i) => i.name)).toEqual(['B']);
    // Then a pick-up at main-pack slot 1 counts only the main pack's items.
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 1));
    expect(r.mainPack()).toEqual(['A', 'Key', 'C']);
  });

  it('packs have their own list: a pack at slot 0 does not push the items, and an item slot ignores packs', () => {
    const r = rig();
    r.login([A, B, PACK]);
    r.inv.addItem(item(PACK2), PACK2);
    r.known([PACK2]);
    r.send(move1999(PACK2, PLAYER, 0, 1)); // type = RequiresPackSlot
    expect(r.inv.containerOrder(PLAYER, true)).toEqual([PACK2, PACK]);
    expect(r.inv.containerOrder(PLAYER)).toEqual([A, B]);
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 1));
    expect(r.mainPack()).toEqual(['A', 'Key', 'B']);
  });

  it('a wielded item leaves the list, so the server\'s later slots line up', () => {
    const r = rig();
    r.login([A, B, C]);
    r.inv.leaveContainer(A); // 0x23 WieldObject → ServerSaysMoveItem(0, …) → RemoveContent
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 1));
    expect(r.inv.containerOrder(PLAYER)).toEqual([B, KEY, C]);
  });

  it('an item that leaves (given away, dropped, deleted) closes the gap', () => {
    const r = rig();
    r.login([A, B, C]);
    r.inv.removeItem(B);
    r.send(create1999(KEY), 3);
    r.send(move1999(KEY, PLAYER, 1));
    expect(r.mainPack()).toEqual(['A', 'Key', 'C']);
  });
});

describe('End of retail / Dark Majesty (ACE and ClassicACE send the same GameEventItemServerSaysContainId)', () => {
  it('a pick-up at PlacementPosition 0 goes first; a later 0 goes before it', () => {
    const c = client();
    c.login([A, B, C]);
    c.inv.addItem(item(KEY), KEY); // ACE's vendor buy / give: CreateObject in the pack, then the event
    c.feed(containIdEoR(KEY, PLAYER, 0));
    expect(c.mainPack()).toEqual(['Key', 'A', 'B', 'C']);
    c.inv.addItem(item(POTION), POTION);
    c.feed(containIdEoR(POTION, PLAYER, 0));
    expect(c.mainPack()).toEqual(['Potion', 'Key', 'A', 'B', 'C']);
  });

  it('a Foci (ContainerType 2) goes to the containers list', () => {
    const c = client();
    c.login([A, B]);
    c.inv.addItem(item(PACK2), PACK2);
    c.feed(containIdEoR(PACK2, PLAYER, 0, 2));
    expect(c.inv.containerOrder(PLAYER, true)).toEqual([PACK2]);
    expect(c.inv.containerOrder(PLAYER)).toEqual([A, B]);
  });
});

describe('relog order: the PlayerDescription and a side pack\'s ViewContents (ViewObjectContents @ 00558a70)', () => {
  it('the login list splits into items and packs, each in order, and replaces the previous lists', () => {
    const inv = new InventoryManager();
    for (const g of [C, A, PACK, B]) inv.addItem(item(g), g);
    inv.setContainerContents(PLAYER, [
      { guid: A, containerType: 0 }, { guid: PACK, containerType: 1 }, { guid: B, containerType: 0 }, { guid: C, containerType: 0 },
    ]);
    expect(inv.containerOrder(PLAYER)).toEqual([A, B, C]);
    expect(inv.containerOrder(PLAYER, true)).toEqual([PACK]);
    inv.setContainerContents(PLAYER, [{ guid: C, containerType: 0 }, { guid: A, containerType: 0 }]);
    expect(inv.containerOrder(PLAYER)).toEqual([C, A]);
    expect(inv.containerOrder(PLAYER, true)).toEqual([]);
  });

  it('a carried pack\'s ViewContents orders that pack', () => {
    const inv = new InventoryManager();
    inv.addItem(item(PACK), PACK);
    for (const g of [A, B, C]) inv.addItem(item(g, PACK), g);
    const route = routeViewContents({
      charGuid: PLAYER, sidePackGuids: [PLAYER, PACK],
      hasInventoryItem: (g) => !!inv.getItem(g), isKnownWorldObject: () => false,
      setContainerContents: (container, items) => inv.setContainerContents(container, items),
      tracker: new OpenContainerTracker(),
    }, PACK, [{ guid: C, containerType: 0 }, { guid: A, containerType: 0 }, { guid: B, containerType: 0 }]);
    expect(route).toBe('own-pack');
    expect(inv.getByContainer(PACK).map((i) => i.name)).toEqual(['C', 'A', 'B']);
  });

  it('clear() forgets the order (a new character does not inherit it)', () => {
    const inv = new InventoryManager();
    inv.setContainerContents(PLAYER, [{ guid: B, containerType: 0 }, { guid: A, containerType: 0 }]);
    inv.clear();
    inv.addItem(item(A), A);
    inv.addItem(item(B), B);
    expect(inv.getAll().map((i) => i.name)).toEqual(['A', 'B']);
  });
});
