/**
 * BUG.item-shortcut-restore-runs-before-inventory — the item-shortcut bar
 * restore resolved each PlayerDescription shortcut against
 * playerState.inventory inside the onPlayerDescription handler, but ACE
 * always delivers PlayerDescription BEFORE every inventory CreateObject:
 * Player_Networking.cs SendSelf() enqueues GameEventPlayerDescription
 * (:216/:220) before SendInventoryAndWieldedItems() (:226), and
 * PlayerDescription's UIQueue bundle (GameEventPlayerDescription.cs:41)
 * flushes fully before CreateObject's SmartboxQueue
 * (NetworkSession.cs:192-244, SendBundle :833-933). The inventory map is
 * therefore deterministically empty at handler time — every lookup missed,
 * restoredShortcuts was always 0, and the bar came back empty each login.
 *
 * Retail's own restore is deferred: gmToolbarUI::UpdateFromPlayerDesc
 * @ 004bf810 flushes all 0x12 (18) slots then AddShortcut @ 004bd9a0 binds
 * each non-zero objectId, storing the slot via
 * UIElement_UIItem::SetDelayedShortcutNum @ 004e1230 when
 * ClientObjMaintSystem::GetWeenieObject is still null so the binding
 * completes once the item exists.
 *
 * These tests drive the shipped ItemShortcutRestorer in the server's real
 * message order — restoreFromDescription first (empty inventory), then
 * onItemKnown per arriving CreateObject — and assert the toolbar slot
 * callback receives each icon exactly once.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ItemShortcutRestorer,
  ITEM_SHORTCUT_SLOT_COUNT,
  type ShortcutItemInfo,
} from '../packages/renderer/src/network/itemShortcutRestore';

interface SetIconCall { index: number; iconDid: number | undefined; title: string }

let calls: SetIconCall[];
let restorer: ItemShortcutRestorer;

beforeEach(() => {
  calls = [];
  restorer = new ItemShortcutRestorer((index, iconDid, title) => {
    calls.push({ index, iconDid, title });
  });
});

/** Only the non-flush (occupied) bindings after the initial 18-slot flush. */
function bindingsAfterFlush(): SetIconCall[] {
  return calls.slice(ITEM_SHORTCUT_SLOT_COUNT);
}

describe('BUG.item-shortcut-restore-runs-before-inventory — deferred toolbar restore', () => {
  it('login order (PlayerDescription before any CreateObject) restores the bar as items arrive', () => {
    // PlayerDescription first — inventory is empty, exactly as ACE orders it.
    const empty = new Map<number, ShortcutItemInfo>();
    const { restored, deferred } = restorer.restoreFromDescription(
      [
        { index: 0, objectId: 0x80001111 },
        { index: 4, objectId: 0x80002222 },
      ],
      (id) => empty.get(id),
    );
    expect(restored).toBe(0);
    expect(deferred).toBe(2);
    expect(restorer.pendingCount).toBe(2);
    // Nothing bound yet beyond the retail 18-slot flush.
    expect(calls.length).toBe(ITEM_SHORTCUT_SLOT_COUNT);
    expect(calls.every((c) => c.iconDid === undefined && c.title === '')).toBe(true);

    // Inventory CreateObjects land (SmartboxQueue) — each completes its slot.
    expect(restorer.onItemKnown(0x80001111, { iconDid: 0x06001234, name: 'Healing Kit' })).toBe(true);
    expect(restorer.onItemKnown(0x80002222, { iconDid: 0x06005678, name: 'Massive Mattekar Jerky' })).toBe(true);

    expect(bindingsAfterFlush()).toEqual([
      { index: 0, iconDid: 0x06001234, title: 'Healing Kit' },
      { index: 4, iconDid: 0x06005678, title: 'Massive Mattekar Jerky' },
    ]);
    expect(restorer.pendingCount).toBe(0);
  });

  it('an item the description never referenced does not touch the bar', () => {
    restorer.restoreFromDescription([{ index: 2, objectId: 0x80001111 }], () => undefined);
    expect(restorer.onItemKnown(0xdeadbeef, { iconDid: 0x0600aaaa, name: 'Unrelated' })).toBe(false);
    expect(bindingsAfterFlush()).toEqual([]);
    expect(restorer.pendingCount).toBe(1);
  });

  it('a guid whose CreateObject never arrives stays unresolved (slot stays empty)', () => {
    restorer.restoreFromDescription([{ index: 7, objectId: 0x80003333 }], () => undefined);
    expect(bindingsAfterFlush()).toEqual([]);
    expect(restorer.pendingCount).toBe(1);
  });

  it('resolves at most once per entry — a duplicate CreateObject (ObjectUpdate) does not double-bind', () => {
    restorer.restoreFromDescription([{ index: 1, objectId: 0x80004444 }], () => undefined);
    expect(restorer.onItemKnown(0x80004444, { iconDid: 0x06000001, name: 'Fire Compound Bow' })).toBe(true);
    expect(restorer.onItemKnown(0x80004444, { iconDid: 0x06000001, name: 'Fire Compound Bow' })).toBe(false);
    expect(bindingsAfterFlush().length).toBe(1);
  });

  it('an already-known item resolves immediately (re-sent description mid-session)', () => {
    const inv = new Map<number, ShortcutItemInfo>([
      [0x80005555, { iconDid: 0x06002222, name: 'Tusker Paw Zharalim' }],
    ]);
    const { restored, deferred } = restorer.restoreFromDescription(
      [
        { index: 3, objectId: 0x80005555 },
        { index: 5, objectId: 0x80006666 },
      ],
      (id) => inv.get(id),
    );
    expect(restored).toBe(1);
    expect(deferred).toBe(1);
    expect(bindingsAfterFlush()).toEqual([
      { index: 3, iconDid: 0x06002222, title: 'Tusker Paw Zharalim' },
    ]);
  });

  it('covers all 18 retail slots (UpdateFromPlayerDesc iterates 0x12), rejecting out-of-range indices', () => {
    restorer.restoreFromDescription(
      [
        { index: 17, objectId: 0x80007777 },  // last valid slot
        { index: 18, objectId: 0x80008888 },  // out of range
        { index: -1, objectId: 0x80009999 },  // out of range
        { index: 6, objectId: 0 },            // retail AddShortcut ignores zero objectIds
      ],
      () => undefined,
    );
    expect(restorer.pendingCount).toBe(1);
    expect(restorer.onItemKnown(0x80007777, { iconDid: 0x06003333, name: 'Bloodscorch Bow' })).toBe(true);
    expect(bindingsAfterFlush()).toEqual([
      { index: 17, iconDid: 0x06003333, title: 'Bloodscorch Bow' },
    ]);
  });

  it('restoreFromDescription flushes every slot first (retail FlushShortcuts) and replaces prior state', () => {
    const inv = new Map<number, ShortcutItemInfo>([
      [0x8000aaaa, { iconDid: 0x06004444, name: 'Old Item' }],
    ]);
    restorer.restoreFromDescription([{ index: 0, objectId: 0x8000aaaa }], (id) => inv.get(id));
    calls = [];
    // A second description (e.g. next character) with no shortcuts: 18
    // flush writes, nothing bound, and the old deferred set is gone.
    restorer.restoreFromDescription([], () => undefined);
    expect(calls.length).toBe(ITEM_SHORTCUT_SLOT_COUNT);
    expect(calls.every((c) => c.iconDid === undefined && c.title === '')).toBe(true);
    expect(restorer.pendingCount).toBe(0);
  });

  it('clear() (teardownWorldState) drops deferrals so a character switch cannot cross-resolve', () => {
    restorer.restoreFromDescription([{ index: 8, objectId: 0x8000bbbb }], () => undefined);
    expect(restorer.pendingCount).toBe(1);
    restorer.clear();
    expect(restorer.pendingCount).toBe(0);
    // The new character's inventory happens to reuse the guid — must not bind.
    expect(restorer.onItemKnown(0x8000bbbb, { iconDid: 0x06005555, name: 'Other Char Item' })).toBe(false);
    expect(bindingsAfterFlush()).toEqual([]);
  });
});
