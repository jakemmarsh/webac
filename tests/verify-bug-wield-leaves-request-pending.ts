/**
 * BUG.wield-leaves-request-pending + GAP.world-drag-drop.a — the WieldObject
 * game event (0x0023) through applyServerWieldObject, with the real
 * InventoryRequestTracker and WorldObjectRecords:
 *
 *  - UIQueueManager case 0x23 → ServerSaysMoveItem(obj, 0, 0, player, loc, 1)
 *    clears the pending GetAndWieldItem. Armor never gets the ParentEvent that
 *    used to be the only clear, so without it every later inventory request
 *    was refused with "You can only move or use one item at a time" (found
 *    live on the ACE stack: wear gloves from the pack, then nothing moves).
 *  - A ground object wielded off the landblock (no CreateObject) is built
 *    from its CreateObject record, leaves the 3D view and is equipped.
 */
import { describe, it, expect } from 'vitest';
import { InventoryRequest, InventoryRequestTracker, INVENTORY_REQUEST_PENDING_TEXT, ItemType } from '@ac/shared';
import { applyServerWieldObject } from '../packages/renderer/src/inventory/ServerWieldObject.js';
import { WorldObjectRecords, buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';

const PLAYER = 0x50000001;
type Entry = ReturnType<typeof buildInventoryEntry>;
type Item = Entry & { id: number };

function harness(tracker: InventoryRequestTracker, records: WorldObjectRecords, carried: Item[] = []) {
  const items = new Map<number, Item>(carried.map((i) => [i.id, i]));
  const removed: number[] = [];
  const equipped: Array<{ id: number; location: number }> = [];
  const events: string[] = [];
  const deps = {
    respond: (id: number) => tracker.respond(id),
    containIn: (guid: number, container: number) => records.containIn(guid, container),
    playerId: PLAYER as number | null,
    getItem: (guid: number) => items.get(guid),
    addItem: (entry: Entry, guid: number) => { items.set(guid, { ...entry, id: guid }); },
    removeWorldObject: (guid: number) => { removed.push(guid); },
    equip: (item: Item, location: number) => { equipped.push({ id: item.id, location }); },
    confirmEquip: (id: number) => { events.push(`confirm:${id.toString(16)}`); },
    markInventoryDirty: () => { events.push('dirty'); },
  };
  return { deps, items, removed, equipped, events };
}

const gauntlets = {
  weenieClassId: 56, name: 'Leather Gauntlets', value: 30, burden: 60, stackSize: 0, maxStackSize: 0, containerId: 0,
  iconId: 0x06001111, validLocations: 0x20, itemType: ItemType.Armor, uiEffects: 0, usable: 1, objectDescFlags: 0,
};

describe('BUG.wield-leaves-request-pending — WieldObject clears the pending request', () => {
  it('armor worn from the pack: the GetAndWieldItem stops refusing the next request', () => {
    const tracker = new InventoryRequestTracker();
    const carried = { ...buildInventoryEntry({ ...gauntlets, containerId: PLAYER }), id: 0x80000400 };
    const h = harness(tracker, new WorldObjectRecords(), [carried]);
    tracker.record(0x80000400, InventoryRequest.Wield);
    expect(tracker.refusal()).not.toBeNull();
    const lines: string[] = [];
    expect(tracker.isPlayerReadyToMakeInventoryRequest(false, (t) => lines.push(t))).toBe(false);
    expect(lines).toEqual([INVENTORY_REQUEST_PENDING_TEXT]);

    expect(applyServerWieldObject(h.deps, 0x80000400, 0x20)).toMatchObject({ id: 0x80000400, name: 'Leather Gauntlets' });
    expect(tracker.refusal()).toBeNull();
    expect(h.equipped).toEqual([{ id: 0x80000400, location: 0x20 }]);
    expect(h.removed).toEqual([]);
    // BUG.equip-unequip-optimistic-no-rollback confirm, the dirty view, FAITHFUL.419's chime.
    expect(h.events).toEqual(['confirm:80000400', 'dirty']); // no local chime (BUG.duplicate-local-sounds)
  });

  it('a WieldObject for another object leaves the pending request alone (the id-matched clear)', () => {
    const tracker = new InventoryRequestTracker();
    const h = harness(tracker, new WorldObjectRecords());
    tracker.record(0x80000400, InventoryRequest.Wield);
    expect(applyServerWieldObject(h.deps, 0x80000999, 0x20)).toBeNull();
    expect(tracker.refusal()).not.toBeNull();
  });
});

describe('GAP.world-drag-drop.a — a ground object wielded off the landblock', () => {
  it('becomes a carried item in the main pack, leaves the 3D view and is equipped — once', () => {
    const tracker = new InventoryRequestTracker();
    const records = new WorldObjectRecords();
    records.remember(0x8000034a, gauntlets);
    const h = harness(tracker, records);
    tracker.record(0x8000034a, InventoryRequest.Wield);

    const item = applyServerWieldObject(h.deps, 0x8000034a, 0x20);
    expect(item).toMatchObject({ id: 0x8000034a, name: 'Leather Gauntlets', containerId: PLAYER, validLocations: 0x20, iconDid: 0x06001111 });
    expect(h.removed).toEqual([0x8000034a]);
    expect(h.equipped).toEqual([{ id: 0x8000034a, location: 0x20 }]);
    expect(tracker.refusal()).toBeNull();
    expect(records.has(0x8000034a)).toBe(false);
  });

  it('an object neither carried nor known on the ground is ignored (no equip, no removal)', () => {
    const h = harness(new InventoryRequestTracker(), new WorldObjectRecords());
    expect(applyServerWieldObject(h.deps, 0x8000077, 0x1)).toBeNull();
    expect([h.removed, h.equipped]).toEqual([[], []]);
    // The chime still plays on every WieldObject (FAITHFUL.419 kept it unconditional).
    expect(h.events).toEqual([]);
  });
});
