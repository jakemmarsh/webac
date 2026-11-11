/**
 * webac#29 "[AC1999] Traded items don't appear" (playwebac.com build 30e875d3): Dreadhew gives
 * Steel Chainmail Pauldrons to a player whose main pack is open and scrolled to the top. The item
 * landed at the END of the pack, so it was out of view until the receiver scrolled to the last row.
 *
 * The AC1999 server (GDLE-derived) sends the RECEIVER of a give only the item's contained 0xF745:
 * CMonsterWeenie::FinishGiveItem (Monster.cpp) sends the 0x22 InventoryMove to the GIVER, then
 * topLevelOwner->MakeAware(item, true) and OnReceiveInventoryItem(this, item, 0), which inserts the
 * item at m_Items slot 0 (Container_InsertInventoryItem). An NPC's Give emote
 * (CWeenieObject::SimulateGiveObject, WeenieObject.cpp) is the same shape: its 0x22 goes to the NPC.
 *
 * Both retail clients file such a create FIRST: ACCObjectMaint::SetWeenieDesc @ 00557a20 (1999:
 * 0x004df510) takes the object's place in its container's list (GetPlaceInItemsList /
 * GetPlaceInContainersList), 0 when it isn't listed, and calls ServerSaysMoveItem(container, place)
 * → AddContent @ 0058cce0 (1999 0x004e26d0) → IDList::AddAtNum. ACE sends CreateObject followed by
 * ServerSaysContainId with PlacementPosition 0 (TryCreateInInventoryWithNetworking), so end of
 * retail lands first too.
 *
 * Ours added the item to the inventory but listed it nowhere, and unlisted items draw after the
 * listed ones: the bottom of the pack, until a relog's PlayerDescription put it first.
 *
 * The 1999 bytes go through the REAL adapter, parser and handler; the client glue is main.ts's
 * (addItem, then applyContainOnCreate on a create; applyContainIdOrder on a 0x22).
 */
import { describe, expect, it } from 'vitest';
import { InventoryManager, type InventoryItem } from '@ac/shared';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage, type CreateObjectData } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { applyContainIdOrder, applyContainOnCreate } from '../packages/renderer/src/inventory/applyContainIdOrder.js';

const PLAYER = 0x50000003;
const A = 0x90000301, B = 0x90000302, C = 0x90000303;
const PAULDRONS = 0x90000500;
const POTION = 0x90000501;
const SPLIT = 0x90000502;
const SACK = 0x90000600;
const PACK = 0x90000601;
const NAMES: Record<number, string> = {
  [A]: 'A', [B]: 'B', [C]: 'C', [PAULDRONS]: 'Pauldrons', [POTION]: 'Potion', [SPLIT]: 'Split', [SACK]: 'Sack', [PACK]: 'Pack',
};

/** The AC1999 server's InventoryMove (ObjectMsgs.cpp): 0xF7B0-wrapped 0x22 {item, container, slot, type}. */
const move1999 = (item: number, container: number, slot: number, type = 0) =>
  new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(0x22).u32(item).u32(container).u32(slot).u32(type).toBytes();

/**
 * A 1999 0xF745 as CreateObject / OldPublicWeenieDesc::Pack lay it out. `container` given: the
 * contained form a give's MakeAware sends (no POSITION, PublicWeenieDesc 0x4000). No container:
 * the free form SpawnInContainer's create has (POSITION from the unset frame).
 */
function create1999(guid: number, opts: { container?: number; itemsCapacity?: number } = {}): Uint8Array {
  const pos = opts.container === undefined;
  const w = new Writer1999().u32(0xf745).u32(guid);
  w.u8(0x11).u8(0).u8(0).u8(0).align4();
  w.u32(0x1 | 0x2 | 0x20000 | (pos ? 0x8000 : 0)).u32(0x14).u32(0x65);
  if (pos) w.u32(0).f32(0).f32(0).f32(0).f32(1).f32(0).f32(0).f32(0);
  w.u32(0x09000001).u32(0x020000c4);
  for (let i = 0; i < 9; i++) w.u16(i + 1);
  w.align4();
  const header = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x10000
    | (opts.container !== undefined ? 0x4000 : 0);
  w.u32(header).acString(NAMES[guid] ?? 'Thing').u16(0x0102).u16(0x1aa5).u32(0x2).u32(0x10);
  // plural, itemsCap, containersCap, value, useability, useRadius, effects, ammo, combatUse,
  // structure, maxStructure, stack, maxStack, [container], validLocations.
  w.acString('Things').u8(opts.itemsCapacity ?? 0).u8(0).u32(10).u32(1).f32(0.5).u32(0).u8(0).u8(0).u16(5).u16(10).u16(1).u16(1);
  if (opts.container !== undefined) w.u32(opts.container);
  w.u32(0x1);
  return w.align4().toBytes();
}

const item = (guid: number, containerId = PLAYER): Omit<InventoryItem, 'id'> => ({
  weenieClassId: 1, name: NAMES[guid] ?? 'Thing', value: 0, burden: 0, stackSize: 1, maxStackSize: 1, stackable: false, containerId,
});

/** main.ts's glue for a carried item's create and for a 0x22. */
function client() {
  const inv = new InventoryManager();
  const world = new Set<number>();
  const creates: CreateObjectData[] = [];
  const onCreate = (d: CreateObjectData | (Partial<CreateObjectData> & { guid: number; containerId: number })) => {
    if (d.containerId || d.wielderId) {
      inv.addItem(item(d.guid, d.containerId), d.guid);
      applyContainOnCreate(inv, d);
    } else world.add(d.guid);
  };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onObjectCreate: (d) => { creates.push(d); onCreate(d); },
    onInventoryPut: (d) => {
      const held = inv.getItem(d.itemGuid);
      if (!held && world.delete(d.itemGuid)) inv.addItem(item(d.itemGuid, d.containerGuid), d.itemGuid);
      else if (held) held.containerId = d.containerGuid;
      applyContainIdOrder(inv, d);
    },
  });
  const mainPack = () => inv.getByContainer(PLAYER).filter((i) => i.id !== SACK && i.id !== PACK).map((i) => i.name);
  return { inv, h, creates, onCreate, mainPack, feed: (m: Uint8Array) => h.handleMessage(deserializeMessage(m)) };
}

describe('AC1999: a given item reaches the receiver first, where the server put it', () => {
  const rig = () => {
    const c = client();
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    const send = (m: Uint8Array, group = 3) => { for (const out of a.inbound(m, group)) c.feed(out); };
    // CClientEvents::LoginCharacter: the carried items' creates, then the 0x0013 ContentProfile.
    const login = (guids: number[]) => {
      for (const g of guids) send(create1999(g, { container: PLAYER }));
      c.inv.setContainerContents(PLAYER, guids.map((g) => ({ guid: g, containerType: 0 })));
    };
    return { ...c, send, login };
  };

  it('a player-to-player give (FinishGiveItem: the receiver gets only the contained create) goes first', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(create1999(PAULDRONS, { container: PLAYER }));
    expect(r.creates.at(-1)?.containerId).toBe(PLAYER);
    expect(r.mainPack()).toEqual(['Pauldrons', 'A', 'B', 'C']);
  });

  it('two gives in a row each go first, as the server inserts each at slot 0', () => {
    const r = rig();
    r.login([A, B]);
    r.send(create1999(PAULDRONS, { container: PLAYER }));
    r.send(create1999(POTION, { container: PLAYER })); // an NPC's Give emote (SimulateGiveObject): the same shape
    expect(r.mainPack()).toEqual(['Potion', 'Pauldrons', 'A', 'B']);
    // A relog's ContentProfile is the server's m_Items order: the same, so nothing jumps.
    r.inv.setContainerContents(PLAYER, [POTION, PAULDRONS, A, B].map((g) => ({ guid: g, containerType: 0 })));
    expect(r.mainPack()).toEqual(['Potion', 'Pauldrons', 'A', 'B']);
  });

  it('a re-sent create of an item already listed keeps its place (SetWeenieDesc finds it in the list)', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(create1999(B, { container: PLAYER }));
    expect(r.mainPack()).toEqual(['A', 'B', 'C']);
  });

  it('a given sack goes first among the packs and leaves the items list alone', () => {
    const r = rig();
    r.login([A, B]);
    r.inv.addItem(item(PACK), PACK);
    r.inv.setContainerContents(PLAYER, [{ guid: A, containerType: 0 }, { guid: B, containerType: 0 }, { guid: PACK, containerType: 1 }]);
    r.send(create1999(SACK, { container: PLAYER, itemsCapacity: 24 }));
    expect(r.inv.containerOrder(PLAYER, true)).toEqual([SACK, PACK]);
    expect(r.inv.containerOrder(PLAYER)).toEqual([A, B]);
  });

  it('SpawnInContainer order (0x22 before the create) still lands at the 0x22\'s slot', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(move1999(SPLIT, PLAYER, 1), 4);
    r.send(create1999(SPLIT));
    expect(r.mainPack()).toEqual(['A', 'Split', 'B', 'C']);
  });

  it('a ground pick-up still takes its 0x22 slot', () => {
    const r = rig();
    r.login([A, B, C]);
    r.send(create1999(POTION)); // on the ground
    r.send(move1999(POTION, PLAYER, 2), 4);
    expect(r.mainPack()).toEqual(['A', 'B', 'Potion', 'C']);
  });

  it('a side pack\'s contents created before its 0x196 (the GDLE order) end in the 0x196 order', () => {
    const r = rig();
    r.login([A]);
    for (const g of [B, C, POTION]) r.send(create1999(g, { container: PACK }));
    r.inv.setContainerContents(PACK, [B, C, POTION].map((g) => ({ guid: g, containerType: 0 })));
    expect(r.inv.getByContainer(PACK).map((i) => i.name)).toEqual(['B', 'C', 'Potion']);
  });
});

describe('End of retail / Dark Majesty (ACE): nothing reorders that the server did not move', () => {
  const containIdEoR = (it: number, container: number, slot: number, type = 0) => {
    const b = new Uint8Array(32);
    const v = new DataView(b.buffer);
    [0xf7b0, PLAYER, 7, 0x22, it, container, slot, type].forEach((x, i) => v.setUint32(i * 4, x >>> 0, true));
    return b;
  };
  /** Carried items already created and listed in this order. */
  const seed = (c: ReturnType<typeof client>, guids: number[]) => {
    for (const g of guids) c.inv.addItem(item(g), g);
    c.inv.setContainerContents(PLAYER, guids.map((g) => ({ guid: g, containerType: 0 })));
  };

  it('login: the PlayerDescription comes before the creates, so they keep its order', () => {
    const c = client();
    c.inv.setContainerContents(PLAYER, [C, A, B].map((g) => ({ guid: g, containerType: 0 })));
    for (const g of [A, B, C]) c.onCreate({ guid: g, containerId: PLAYER });
    expect(c.mainPack()).toEqual(['C', 'A', 'B']);
  });

  it('a give (CreateObject, then ServerSaysContainId PlacementPosition 0) goes first', () => {
    const c = client();
    seed(c, [A, B, C]);
    c.onCreate({ guid: PAULDRONS, containerId: PLAYER });
    c.feed(containIdEoR(PAULDRONS, PLAYER, 0));
    expect(c.mainPack()).toEqual(['Pauldrons', 'A', 'B', 'C']);
  });

  it('a create followed by a ServerSaysContainId at slot 2 lands at 2 (the event decides)', () => {
    const c = client();
    seed(c, [A, B, C]);
    c.onCreate({ guid: SPLIT, containerId: PLAYER });
    c.feed(containIdEoR(SPLIT, PLAYER, 2));
    expect(c.mainPack()).toEqual(['A', 'B', 'Split', 'C']);
  });

  it('a side pack\'s ViewContents before its contents\' creates keeps that order', () => {
    const c = client();
    c.inv.setContainerContents(PACK, [C, A, B].map((g) => ({ guid: g, containerType: 0 })));
    for (const g of [A, B, C]) c.onCreate({ guid: g, containerId: PACK });
    expect(c.inv.getByContainer(PACK).map((i) => i.name)).toEqual(['C', 'A', 'B']);
  });

  it('a wielded item\'s create lists it nowhere', () => {
    const c = client();
    c.inv.setContainerContents(PLAYER, [A, B].map((g) => ({ guid: g, containerType: 0 })));
    c.onCreate({ guid: POTION, containerId: 0, wielderId: PLAYER });
    expect(c.inv.containerOrder(PLAYER)).toEqual([A, B]);
  });
});

describe('InventoryManager.containOnCreate', () => {
  it('lists an unlisted guid first and reports the change; a listed one stays', () => {
    const inv = new InventoryManager();
    inv.setContainerContents(PLAYER, [A, B].map((g) => ({ guid: g, containerType: 0 })));
    expect(inv.containOnCreate(C, PLAYER)).toBe(true);
    expect(inv.containerOrder(PLAYER)).toEqual([C, A, B]);
    expect(inv.containOnCreate(B, PLAYER)).toBe(false);
    expect(inv.containerOrder(PLAYER)).toEqual([C, A, B]);
  });

  it('a create naming a different container moves the item there, first (GetPlaceIn… is -1 → 0)', () => {
    const inv = new InventoryManager();
    inv.setContainerContents(PLAYER, [A, B].map((g) => ({ guid: g, containerType: 0 })));
    inv.setContainerContents(PACK, [C].map((g) => ({ guid: g, containerType: 0 })));
    expect(inv.containOnCreate(B, PACK)).toBe(true);
    expect(inv.containerOrder(PLAYER)).toEqual([A]);
    expect(inv.containerOrder(PACK)).toEqual([B, C]);
  });
});
