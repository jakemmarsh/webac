/**
 * BUG.stack-merge-not-found — prod telemetry (end of retail, ACE, build
 * 35b2f7284, 2026-10-24): six "Source stack not found!" / "Target stack not
 * found!" transients in 15 minutes, each right after a StackableMerge (0x54),
 * three of them within 3.3 s, while the player looted a corpse.
 *
 * Cause: ACE ends a merge that uses up a stack held in a corpse or chest with
 * only GameMessageInventoryRemoveObject (0x0024) for it
 * (Player_Inventory.cs:3096; the contained stack's Destroy broadcasts no
 * DeleteObject). Retail runs 0x0024 through ACCWeenieObject::ServerSaysRemove
 * @ 0058e4c0 = ServerSaysMoveItem(this, 0, 0, 0, 0, 1) @ 0058dbb0, which takes
 * the object out of its container and re-lists it
 * (UIElement_ItemList::RecvNotice_ServerSaysMoveItem @ 004e5110). Ours left
 * the merged-away stack in the open container's strip, so the next click on
 * it sent StackableMerge for a guid ACE had destroyed: FindObject(…,
 * LocationsICanMove) → null → "Source stack not found!" (or "Target stack not
 * found!" when an inventory stack was dropped on the ghost), every time.
 *
 * Sweep: retail's 0x0023 WieldObject and 0x019A PutObjectIn3D take the same
 * ServerSaysMoveItem path (UIQueueManager dispatch, decomp :339897 / :340073);
 * a weapon wielded straight out of a corpse stayed listed the same way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ContainerType, ItemType } from '@ac/shared';
import { GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import {
  OpenContainerTracker,
  serverMoveContainer,
  type ServerMoveMessage,
} from '../packages/renderer/src/world/OpenContainerTracker.js';
import {
  attemptMerge,
  attemptToPlaceInContainer,
  type PlacementObject,
  type PlacementWorld,
} from '../packages/renderer/src/inventory/ItemHolderPlacement.js';

const PLAYER = 0x50000001;
const CORPSE = 0x80001000;
const SIDE_PACK = 0x80001001; // a pack inside the corpse
const PYREALS_ON_CORPSE = 0x80001002;
const ARROWS_ON_CORPSE = 0x80001003;
const SWORD_ON_CORPSE = 0x80001004;
const GEM_IN_SIDE_PACK = 0x80001005;
const MY_PYREALS = 0x80002000;
const MY_LOOSE_PYREALS = 0x80002001;
const PYREAL_WCID = 273;

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

describe('BUG.stack-merge-not-found — a merged-away corpse stack leaves the open container', () => {
  let tracker: OpenContainerTracker;
  let handler: ServerMessageHandler;
  /** The handler wiring main.ts runs for each ServerSaysMoveItem message. */
  const sync: number[] = [];

  beforeEach(() => {
    sync.length = 0;
    tracker = new OpenContainerTracker();
    tracker.viewContents(CORPSE, [
      { guid: PYREALS_ON_CORPSE, containerType: 0 },
      { guid: ARROWS_ON_CORPSE, containerType: 0 },
      { guid: SWORD_ON_CORPSE, containerType: 0 },
      { guid: SIDE_PACK, containerType: ContainerType.Container },
    ]);
    tracker.viewContents(SIDE_PACK, [{ guid: GEM_IN_SIDE_PACK, containerType: 0 }]);
    const rec = (guid: number, name: string, containerId: number, stackSize: number, itemType: number) =>
      tracker.acceptCreateObject({ guid, containerId, name, iconDid: 0x06001234, stackSize, itemType });
    rec(PYREALS_ON_CORPSE, 'Pyreal', CORPSE, 25, ItemType.Money);
    rec(ARROWS_ON_CORPSE, 'Arrow', CORPSE, 12, ItemType.MissileWeapon);
    rec(SWORD_ON_CORPSE, 'Sword', CORPSE, 1, ItemType.MeleeWeapon);
    rec(SIDE_PACK, 'Pack', CORPSE, 1, ItemType.Container);
    rec(GEM_IN_SIDE_PACK, 'Amethyst', SIDE_PACK, 1, ItemType.Gem);

    handler = new ServerMessageHandler();
    handler.setHandlers({
      onInventoryRemove: (d) => { if (tracker.serverSaysMoveFor(d.itemGuid, { kind: 'remove' })) sync.push(d.itemGuid); },
      onInventoryPutIn3D: (d) => { if (tracker.serverSaysMoveFor(d.itemGuid, { kind: 'putIn3D' })) sync.push(d.itemGuid); },
    });
  });

  /** The client's placement view: the corpse strip from the tracker, the player's pack, the toolbar split at max. */
  function world(): PlacementWorld {
    const listed = new Map(tracker.items().map((i) => [i.guid, i]));
    const pack: Record<number, PlacementObject> = {
      [MY_PYREALS]: {
        id: MY_PYREALS, name: 'Pyreal', weenieClassId: PYREAL_WCID, stackSize: 100, maxStackSize: 25000,
        itemsCapacity: 0, containersCapacity: 0, isContainer: false, holder: false, inTrade: false, isPlayer: false,
        contained: true, ownedByPlayer: true,
      },
      [MY_LOOSE_PYREALS]: {
        id: MY_LOOSE_PYREALS, name: 'Pyreal', weenieClassId: PYREAL_WCID, stackSize: 7, maxStackSize: 25000,
        itemsCapacity: 0, containersCapacity: 0, isContainer: false, holder: false, inTrade: false, isPlayer: false,
        contained: true, ownedByPlayer: true,
      },
    };
    const object = (id: number): PlacementObject | undefined => {
      if (id === PLAYER) {
        return { id, name: 'Me', weenieClassId: 0, stackSize: 0, maxStackSize: 0, itemsCapacity: 102, containersCapacity: 7, isContainer: true, holder: true, inTrade: false, isPlayer: true };
      }
      if (pack[id]) return pack[id];
      const i = listed.get(id);
      if (!i) return undefined;
      return {
        id, name: i.name, weenieClassId: id === PYREALS_ON_CORPSE ? PYREAL_WCID : 0, stackSize: i.stackSize,
        maxStackSize: id === PYREALS_ON_CORPSE ? 25000 : 1, itemsCapacity: 0, containersCapacity: 0,
        isContainer: false, holder: false, inTrade: false, isPlayer: false, contained: true,
      };
    };
    return {
      playerId: PLAYER, object,
      itemsOf: (h) => (h === PLAYER ? [MY_PYREALS] : h === CORPSE ? tracker.items().filter((i) => i.containerId === CORPSE && !i.isContainer).map((i) => i.guid) : []),
      containersOf: () => [],
      splitSize: 1, maxSplitSize: 1,
      objectSplitSize: (id) => object(id)?.stackSize ?? 1,
      dragSplit: (id) => ({ amount: object(id)?.stackSize ?? 1, partial: false }),
    };
  }

  it('reproduces the failing request: the corpse stack auto-merges into the pack stack (PlaceInBackpack)', () => {
    const r = attemptToPlaceInContainer(PYREALS_ON_CORPSE, PLAYER, 0, true, 0, world());
    expect(r).toEqual({ kind: 'merge', targetId: MY_PYREALS, amount: 25 });
  });

  it("ACE's 0x0024 for the used-up stack (real bytes) takes it out of the strip, the rest stays", () => {
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.InventoryRemoveObject, payload: u32(PYREALS_ON_CORPSE) } as any);
    expect(sync).toEqual([PYREALS_ON_CORPSE]);
    expect(tracker.has(PYREALS_ON_CORPSE)).toBe(false);
    expect(tracker.items().map((i) => i.guid).sort()).toEqual([ARROWS_ON_CORPSE, SWORD_ON_CORPSE, SIDE_PACK, GEM_IN_SIDE_PACK].sort());
  });

  it('after the merge no placement offers the destroyed stack again (the "Source stack not found!" repeat)', () => {
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.InventoryRemoveObject, payload: u32(PYREALS_ON_CORPSE) } as any);
    const w = world();
    // The strip no longer lists it, so the client has no object to place: nothing is sent.
    expect(w.itemsOf(CORPSE)).not.toContain(PYREALS_ON_CORPSE);
    expect(attemptToPlaceInContainer(PYREALS_ON_CORPSE, PLAYER, 0, true, 0, w).kind).toBe('refused');
    // An inventory stack dropped where the ghost was finds no merge target ("Target stack not found!").
    expect(attemptMerge(MY_LOOSE_PYREALS, PYREALS_ON_CORPSE, w)).toBeNull();
  });

  it('a partial merge (the stack shrinks, ACE sends SetStackSize, no 0x0024) keeps it listed with its new size', () => {
    expect(tracker.updateStackSize(PYREALS_ON_CORPSE, 5)).toBe(true);
    expect(tracker.items().find((i) => i.guid === PYREALS_ON_CORPSE)?.stackSize).toBe(5);
  });

  it('a 0x0024 for an object the strip does not hold (a consumed pack item) changes nothing', () => {
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.InventoryRemoveObject, payload: u32(MY_PYREALS) } as any);
    expect(sync).toEqual([]);
    expect(tracker.items()).toHaveLength(5);
  });

  it('a 0x0024 for an item inside a pack in the corpse takes it out of that pack', () => {
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.InventoryRemoveObject, payload: u32(GEM_IN_SIDE_PACK) } as any);
    expect(tracker.has(GEM_IN_SIDE_PACK)).toBe(false);
    expect(tracker.packGuids()).toEqual([CORPSE, SIDE_PACK]);
  });

  // ── Sweep: every message retail runs through ServerSaysMoveItem ──
  it('sweep: a weapon wielded straight out of the corpse (0x0023) leaves the strip', () => {
    expect(tracker.serverSaysMoveFor(SWORD_ON_CORPSE, { kind: 'wield' })).toBe(true);
    expect(tracker.has(SWORD_ON_CORPSE)).toBe(false);
  });

  it('sweep: 0x019A PutObjectIn3D for a listed object leaves the strip (real bytes)', () => {
    handler.handleMessage({
      type: 'event', opcode: GameMessageOpcode.GameEvent, sequence: 1, eventType: 0x019a, objectGuid: 0, payload: u32(ARROWS_ON_CORPSE),
    } as any);
    expect(sync).toEqual([ARROWS_ON_CORPSE]);
    expect(tracker.has(ARROWS_ON_CORPSE)).toBe(false);
  });

  it('the open container itself is never dropped by these (its own close path)', () => {
    for (const kind of ['remove', 'wield', 'putIn3D', 'delete'] as const) {
      expect(tracker.serverSaysMoveFor(CORPSE, { kind })).toBe(false);
    }
    expect(tracker.packGuids()[0]).toBe(CORPSE);
  });

  // ── Unchanged (every era: ContainID moves and DeleteObject — GDLE and the AC1999 server end merges with them) ──
  it('pinned: ContainID into a nested pack re-parents, into our pack removes; DeleteObject removes', () => {
    expect(tracker.serverSaysMoveFor(ARROWS_ON_CORPSE, { kind: 'containId', containerGuid: SIDE_PACK })).toBe(true);
    expect(tracker.items().find((i) => i.guid === ARROWS_ON_CORPSE)?.containerId).toBe(SIDE_PACK);
    expect(tracker.serverSaysMoveFor(ARROWS_ON_CORPSE, { kind: 'containId', containerGuid: PLAYER })).toBe(true);
    expect(tracker.has(ARROWS_ON_CORPSE)).toBe(false);
    expect(tracker.serverSaysMoveFor(PYREALS_ON_CORPSE, { kind: 'delete' })).toBe(true);
    expect(tracker.has(PYREALS_ON_CORPSE)).toBe(false);
  });

  it("serverMoveContainer: only ContainID names a container; the rest are ServerSaysMoveItem(0, …)", () => {
    const cases: Array<[ServerMoveMessage, number]> = [
      [{ kind: 'containId', containerGuid: 0x80001234 }, 0x80001234],
      [{ kind: 'wield' }, 0],
      [{ kind: 'putIn3D' }, 0],
      [{ kind: 'remove' }, 0],
      [{ kind: 'delete' }, 0],
    ];
    for (const [m, c] of cases) expect(serverMoveContainer(m)).toBe(c);
  });
});
