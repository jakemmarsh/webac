/**
 * GAP.world-drag-drop.a.a.a.a — merging a stack moves its toolbar shortcut.
 *
 * Retail ItemHolder::AttemptMerge @ 005878f0 sends UIAttemptMerge(src → dst),
 * then CM_UI::SendNotice_FullMergingItem(src, dst) and SetSelectedObject(dst).
 * gmToolbarUI::RecvNotice_FullMergingItem @ 004be9b0 runs
 * RemoveShortcut(src, true) (@ 004bd450: flush + Event_RemoveShortCut(slot))
 * and, when src had a slot, CreateShortcutToItem(dst, slot, false, true)
 * (@ 004bdac0: quiet; an unowned dst is refused; otherwise
 * RemoveShortcut(dst, true) then AddShortcut(dst, slot, true) →
 * Event_AddShortCut(slot, dst)).
 *
 * Drives the shipped ItemShortcutRestorer slot model and asserts the slot
 * contents, the redrawn icons and the outbound shortcut events in order.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ItemShortcutRestorer,
  ITEM_SHORTCUT_SLOT_COUNT,
  type ShortcutItemInfo,
} from '../packages/renderer/src/network/itemShortcutRestore';

const SRC = 0x80000a01;
const DST = 0x80000a02;
const OTHER = 0x80000a03;

const items = new Map<number, ShortcutItemInfo>([
  [SRC, { iconDid: 0x06001111, name: 'Arrowhead' }],
  [DST, { iconDid: 0x06002222, name: 'Arrowhead' }],
  [OTHER, { iconDid: 0x06003333, name: 'Healing Kit' }],
]);

let icons: Array<{ index: number; iconDid: number | undefined; title: string }>;
let sent: string[];
let bar: ItemShortcutRestorer;

beforeEach(() => {
  icons = [];
  sent = [];
  bar = new ItemShortcutRestorer(
    (index, iconDid, title) => icons.push({ index, iconDid, title }),
    { add: (i, o) => sent.push(`add ${i} ${o.toString(16)}`), remove: (i) => sent.push(`remove ${i}`) },
  );
});

function restore(records: Array<{ index: number; objectId: number }>): void {
  bar.restoreFromDescription(records, (id) => items.get(id));
  icons = [];
}

describe('GAP.world-drag-drop.a.a.a.a — RecvNotice_FullMergingItem', () => {
  it('moves the merged-away stack\'s shortcut onto the destination in the same slot', () => {
    restore([{ index: 3, objectId: SRC }]);
    bar.fullMergingItem(SRC, DST, { owned: true, item: items.get(DST) });
    expect(bar.objectAt(3)).toBe(DST);
    expect(bar.slotOf(SRC)).toBe(-1);
    expect(sent).toEqual(['remove 3', `add 3 ${DST.toString(16)}`]);
    // Flushed, then redrawn with the destination's icon.
    expect(icons.at(-1)).toEqual({ index: 3, iconDid: 0x06002222, title: 'Arrowhead' });
  });

  it('a destination that already had a shortcut leaves its old slot for the source\'s', () => {
    restore([{ index: 1, objectId: SRC }, { index: 7, objectId: DST }]);
    bar.fullMergingItem(SRC, DST, { owned: true, item: items.get(DST) });
    expect(bar.objectAt(1)).toBe(DST);
    expect(bar.objectAt(7)).toBe(0);
    expect(sent).toEqual(['remove 1', 'remove 7', `add 1 ${DST.toString(16)}`]);
  });

  it('a source with no shortcut changes nothing — the destination keeps its slot', () => {
    restore([{ index: 5, objectId: DST }, { index: 0, objectId: OTHER }]);
    bar.fullMergingItem(SRC, DST, { owned: true, item: items.get(DST) });
    expect(bar.objectAt(5)).toBe(DST);
    expect(bar.objectAt(0)).toBe(OTHER);
    expect(sent).toEqual([]);
    expect(icons).toEqual([]);
  });

  it('merging onto a stack the player does not own (a 3D drop) only removes the shortcut', () => {
    restore([{ index: 2, objectId: SRC }]);
    bar.fullMergingItem(SRC, DST, { owned: false });
    expect(bar.objectAt(2)).toBe(0);
    expect(sent).toEqual(['remove 2']);
    expect(icons).toEqual([{ index: 2, iconDid: undefined, title: '' }]);
  });

  it('an unknown destination weenie is bound deferred and drawn when its object arrives', () => {
    restore([{ index: 4, objectId: SRC }]);
    bar.fullMergingItem(SRC, DST, { owned: true });
    expect(bar.objectAt(4)).toBe(DST);
    expect(sent).toEqual(['remove 4', `add 4 ${DST.toString(16)}`]);
    expect(bar.onItemKnown(DST, items.get(DST)!)).toBe(true);
    expect(icons.at(-1)).toEqual({ index: 4, iconDid: 0x06002222, title: 'Arrowhead' });
  });

  it('a removed deferred shortcut no longer binds when its object arrives', () => {
    bar.restoreFromDescription([{ index: 6, objectId: SRC }], () => undefined);
    expect(bar.pendingCount).toBe(1);
    bar.fullMergingItem(SRC, DST, { owned: false });
    expect(bar.pendingCount).toBe(0);
    icons = [];
    expect(bar.onItemKnown(SRC, items.get(SRC)!)).toBe(false);
    expect(icons).toEqual([]);
  });
});

describe('gmToolbarUI::AddShortcut / RemoveShortcut slot model', () => {
  it('an out-of-range slot takes the first empty one; a full bar takes nothing', () => {
    restore([{ index: 0, objectId: OTHER }]);
    bar.addShortcut(DST, -1, items.get(DST), true);
    expect(bar.objectAt(1)).toBe(DST);
    expect(sent).toEqual([`add 1 ${DST.toString(16)}`]);

    const full = Array.from({ length: ITEM_SHORTCUT_SLOT_COUNT }, (_, i) => ({ index: i, objectId: 0x80001000 + i }));
    restore(full);
    sent = [];
    bar.addShortcut(SRC, ITEM_SHORTCUT_SLOT_COUNT, items.get(SRC), true);
    expect(bar.slotOf(SRC)).toBe(-1);
    expect(sent).toEqual([]);
  });

  it('removing an object without a shortcut returns -1 and sends nothing', () => {
    restore([{ index: 0, objectId: OTHER }]);
    expect(bar.removeShortcut(SRC, true)).toBe(-1);
    expect(sent).toEqual([]);
  });

  it('a re-sent PlayerDescription replaces the whole slot model', () => {
    restore([{ index: 3, objectId: SRC }]);
    restore([{ index: 8, objectId: DST }]);
    expect(bar.slotOf(SRC)).toBe(-1);
    expect(bar.objectAt(8)).toBe(DST);
  });
});
