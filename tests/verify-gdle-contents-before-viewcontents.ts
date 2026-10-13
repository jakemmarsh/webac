/**
 * RELEASE.gdle-contents-before-viewcontents — a GDLE corpse / chest lists the
 * contents whose CreateObjects arrived BEFORE its 0x196 ViewContents.
 *
 * Server ground truth:
 *  - GDLE (GDL-Classic / Seedsow, reference/classic/Seedsow/Source/
 *    Container.cpp:1014-1050, and the AC1999 server's copy at
 *    reference/ac1999/Server/Source/Container.cpp:1097) opens a container
 *    with CContainerWeenie::MakeAwareViewContent: for each pack, the pack's
 *    own MakeAwareViewContent (its items' CreateObjects + its 0x196), then the
 *    pack's CreateObject; then a CreateObject per item; then the container's
 *    0x196. CPacketController queues every message in one FIFO
 *    (QueueNetMessage / FlushQueuedNetMessages), so that is the wire order.
 *  - ACE (Container.cs SendInventory) sends the 0x196 first, then the
 *    CreateObjects.
 *
 * Retail: ACCObjectMaint::ViewObjectContents @ 00558a70 only replaces the
 * container's id lists; the objects were made by their CreateObjects
 * whatever the order. Pre-fix our client linked a contained CreateObject to
 * the external container only when that container was already open, so the
 * first open of every GDLE corpse showed an empty loot strip (the Seedsow
 * launch report "no items on corpses").
 *
 * Drives the shipped parsers (parseCreateObject / parseViewContents) on wire
 * bytes and the shipped routeViewContents + OpenContainerTracker glue
 * (acceptCreateObject is main.ts's CreateObject branch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseCreateObject, parseViewContents } from '../packages/network/src/MessageSerializer.js';
import { routeViewContents, type ViewContentsContext } from '../packages/renderer/src/world/ViewContentsRouter.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { ContainerType, ItemType } from '@ac/shared';

class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  align(boundary = 4): this { while (this.pos % boundary !== 0) this.u8(0); return this; }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this.align(4);
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

const FLAG_CONTAINER = 0x00004000;

/** A contained item's CreateObject as GDLE writes it: no Position (HasOwner), WeenieHeader Container. */
function createObjectBytes(guid: number, name: string, containerId: number, itemType: number): Uint8Array {
  const w = new Writer();
  w.u32(guid);
  w.u8(0x11).u8(0).u8(0).u8(0); // ObjDesc header, no sub-blocks
  w.align(4);
  w.u32(0); // PhysicsDesc flags: no Position block
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0);
  w.align(4);
  w.u32(FLAG_CONTAINER);
  w.string16(name);
  w.u16(100); // weenieClassId
  w.u16(0x1234); // icon → 0x06001234
  w.u32(itemType);
  w.u32(0); // ObjectDescriptionFlags
  w.align(4);
  w.u32(containerId);
  w.align(4);
  return w.toUint8Array();
}

function viewContentsBytes(container: number, items: Array<[number, number]>): Uint8Array {
  const w = new Writer();
  w.u32(container).u32(items.length);
  for (const [g, t] of items) w.u32(g).u32(t);
  return w.toUint8Array();
}

const CHAR = 0x50000001;
const CORPSE = 0x80010000;
const TOKEN = 0x80010001;
const DRAUGHT = 0x80010002;
const POUCH = 0x80010003;
const GEM = 0x80010004;

describe('RELEASE.gdle-contents-before-viewcontents', () => {
  let tracker: OpenContainerTracker;
  let known: Set<number>;
  let slots: Map<number, number>;
  let ctx: ViewContentsContext;

  /** main.ts's CreateObject branch for a non-player subject. */
  const recvCreateObject = (bytes: Uint8Array): boolean => {
    const d = parseCreateObject(bytes)!;
    expect(d.position).toBeFalsy();
    return tracker.acceptCreateObject({
      guid: d.guid, containerId: d.containerId, name: d.name, pluralName: d.pluralName,
      iconDid: d.iconId, stackSize: d.stackSize || 1, itemType: d.itemType,
      objectDescFlags: d.objectDescFlags ?? 0, itemsCapacity: d.itemsCapacity ?? 0,
    });
  };
  const recvViewContents = (bytes: Uint8Array) => {
    const v = parseViewContents(bytes)!;
    return routeViewContents(ctx, v.containerGuid, v.items);
  };

  beforeEach(() => {
    tracker = new OpenContainerTracker();
    known = new Set([CORPSE]);
    slots = new Map();
    ctx = {
      charGuid: CHAR,
      sidePackGuids: [CHAR],
      hasInventoryItem: () => false,
      isKnownWorldObject: (g) => known.has(g),
      setSlotForItem: (g, s) => slots.set(g, s),
      tracker,
    };
  });

  it("GDLE order (items' CreateObjects, then the 0x196) lists every item on the first open", () => {
    expect(recvCreateObject(createObjectBytes(TOKEN, 'Academy Token', CORPSE, ItemType.Misc))).toBe(false);
    expect(recvCreateObject(createObjectBytes(DRAUGHT, 'Mana Draught', CORPSE, ItemType.Food))).toBe(false);
    expect(recvViewContents(viewContentsBytes(CORPSE, [[TOKEN, 0], [DRAUGHT, 0]]))).toBe('opened');
    expect(tracker.adoptedOnLastView).toBe(2);
    const items = tracker.items();
    expect(items.map((i) => [i.guid, i.name, i.containerId, i.iconDid])).toEqual([
      [TOKEN, 'Academy Token', CORPSE, 0x06001234],
      [DRAUGHT, 'Mana Draught', CORPSE, 0x06001234],
    ]);
  });

  it('a GDLE nested pack: its list before the pack, its items listed under it, the pack a nested container', () => {
    // MakeAwareViewContent recursion: the pouch's item, the pouch's 0x196, the pouch, then the corpse's.
    recvCreateObject(createObjectBytes(GEM, 'Amethyst', POUCH, ItemType.Gem));
    expect(recvViewContents(viewContentsBytes(POUCH, [[GEM, 0]]))).toBe('deferred');
    expect(slots.size).toBe(0); // not misfiled as one of our packs
    recvCreateObject(createObjectBytes(POUCH, 'Pouch', CORPSE, ItemType.Container));
    recvCreateObject(createObjectBytes(TOKEN, 'Academy Token', CORPSE, ItemType.Misc));
    expect(recvViewContents(viewContentsBytes(CORPSE, [[TOKEN, ContainerType.NonContainer], [POUCH, ContainerType.Container]]))).toBe('opened');
    expect(tracker.packGuids()).toEqual([CORPSE, POUCH]);
    const byGuid = new Map(tracker.items().map((i) => [i.guid, i]));
    expect(byGuid.get(GEM)).toMatchObject({ name: 'Amethyst', containerId: POUCH, isContainer: false });
    expect(byGuid.get(POUCH)).toMatchObject({ name: 'Pouch', containerId: CORPSE, isContainer: true });
    expect(byGuid.get(TOKEN)).toMatchObject({ name: 'Academy Token', containerId: CORPSE });
  });

  it('ACE order (0x196 first, then the CreateObjects) is unchanged: nothing adopted, each CreateObject tracked live', () => {
    expect(recvViewContents(viewContentsBytes(CORPSE, [[TOKEN, 0]]))).toBe('opened');
    expect(tracker.adoptedOnLastView).toBe(0);
    expect(tracker.items()[0].name).toBe('???');
    expect(recvCreateObject(createObjectBytes(TOKEN, 'Academy Token', CORPSE, ItemType.Misc))).toBe(true);
    expect(tracker.items().map((i) => i.name)).toEqual(['Academy Token']);
  });

  it("another container's early contents stay out of this one; a reopen of that container still finds them", () => {
    const CHEST = 0x80020000;
    known.add(CHEST);
    recvCreateObject(createObjectBytes(GEM, 'Amethyst', CHEST, ItemType.Gem));
    recvCreateObject(createObjectBytes(TOKEN, 'Academy Token', CORPSE, ItemType.Misc));
    recvViewContents(viewContentsBytes(CORPSE, [[TOKEN, 0]]));
    expect(tracker.items().map((i) => i.guid)).toEqual([TOKEN]);
    recvViewContents(viewContentsBytes(CHEST, [[GEM, 0]]));
    expect(tracker.items().map((i) => i.name)).toEqual(['Amethyst']);
  });

  it('an unknown container with no early contents is still a login pack snapshot (own-pack), and a deleted early object is forgotten', () => {
    expect(recvViewContents(viewContentsBytes(0x80030000, [[GEM, 0]]))).toBe('own-pack');
    recvCreateObject(createObjectBytes(TOKEN, 'Academy Token', CORPSE, ItemType.Misc));
    tracker.forgetEarly(TOKEN);
    recvViewContents(viewContentsBytes(CORPSE, []));
    expect(tracker.items()).toEqual([]);
    expect(tracker.adoptedOnLastView).toBe(0);
  });

  it('an early record of an item the next 0x196 no longer lists (taken by someone else meanwhile) stays out', () => {
    recvCreateObject(createObjectBytes(TOKEN, 'Academy Token', CORPSE, ItemType.Misc));
    recvCreateObject(createObjectBytes(DRAUGHT, 'Mana Draught', CORPSE, ItemType.Food));
    recvViewContents(viewContentsBytes(CORPSE, [[DRAUGHT, 0]]));
    expect(tracker.items().map((i) => i.name)).toEqual(['Mana Draught']);
  });
});

/**
 * RELEASE.open-container-stale-members — retail removes a cell from the
 * open container's strip whenever its object leaves the container
 * (UIElement_ItemList::RecvNotice_ServerSaysMoveItem @ 004e5110), including a
 * DeleteObject: ObjectBeingDeleted @ 0058e4d0 → ACCWeenieObject::Remove
 * @ 0058dd20 → ServerSaysMoveItem(this, 0, …). Pre-fix only a move into one
 * of our own packs left the strip; a deleted or elsewhere-moved item stayed.
 */
describe('RELEASE.open-container-stale-members — OpenContainerTracker.serverSaysMove', () => {
  const CHEST = 0x80020000;
  const OTHER_PLAYER_PACK = 0x50000999;
  let t: OpenContainerTracker;
  const rec = (guid: number, name: string, containerId: number, itemType = ItemType.Misc) => ({
    guid, containerId, name, iconDid: 0x06001234, stackSize: 1, itemType,
  });

  beforeEach(() => {
    t = new OpenContainerTracker();
    t.viewContents(CHEST, [{ guid: TOKEN, containerType: 0 }, { guid: POUCH, containerType: ContainerType.Container }]);
    t.viewContents(POUCH, [{ guid: GEM, containerType: 0 }]);
    t.acceptCreateObject(rec(TOKEN, 'Academy Token', CHEST));
    t.acceptCreateObject(rec(POUCH, 'Pouch', CHEST, ItemType.Container));
    t.acceptCreateObject(rec(GEM, 'Amethyst', POUCH, ItemType.Gem));
  });

  it('a DeleteObject (newContainer 0) removes the item', () => {
    expect(t.serverSaysMove(TOKEN, 0)).toBe(true);
    expect(t.items().map((i) => i.guid).sort()).toEqual([POUCH, GEM].sort());
  });

  it('deleting a nested pack drops its tab and its contents', () => {
    expect(t.serverSaysMove(POUCH, 0)).toBe(true);
    expect(t.packGuids()).toEqual([CHEST]);
    expect(t.items().map((i) => i.guid)).toEqual([TOKEN]);
  });

  it("a move to a container outside the open one (another player's pack) removes it", () => {
    expect(t.serverSaysMove(TOKEN, OTHER_PLAYER_PACK)).toBe(true);
    expect(t.has(TOKEN)).toBe(false);
  });

  it('a move from the nested pack to the top level re-parents, and a same-parent move changes nothing', () => {
    expect(t.serverSaysMove(GEM, CHEST)).toBe(true);
    expect(t.items().find((i) => i.guid === GEM)!.containerId).toBe(CHEST);
    expect(t.serverSaysMove(GEM, CHEST)).toBe(false);
  });

  it('an object the list does not hold is ignored', () => {
    expect(t.serverSaysMove(0x80099999, 0)).toBe(false);
    expect(t.items()).toHaveLength(3);
  });
});

