/**
 * GAP.toolbar-item-shortcuts-inert — the 18 item-shortcut slots work.
 *
 * Retail gmToolbarUI:
 *  - ListenToGlobalMessage @ 004be4e0: Quickslot 1-12 (0x10000042-4d) and
 *    13-18 (0x10000132-137) → UseShortcut(slot, true); Select Quickslot
 *    1-12 (0x1000004e-59) / 13-18 (0x10000138-13d) → UseShortcut(slot,
 *    false); Create Shortcut (0x1000010d) → CreateShortcutToItem(selected,
 *    -1, true, false).
 *  - CreateShortcutToItem @ 004bdac0: IsShortcutEligible @ 004bd1d0 refusal
 *    "You cannot make a shortcut to the %s", unowned → PlaceInBackpack when
 *    allowed, index -1 duplicate "There is already a shortcut to the %s" /
 *    "There are no free shortcut slots" (acclient.exe .rdata literals).
 *  - HandleDropRelease @ 004be7c0: an item dropped on a slot displaces the
 *    old object to GetFirstEmptyShortcutToTheRightOf @ 004bd560; a shortcut
 *    dropped on a slot swaps into m_lastShortcutNumDragged when free.
 *  - RecvNotice_ItemListBeginDrag @ 004bd930: picking a shortcut up removes
 *    it (Event_RemoveShortCut) at once.
 *  - The slots are UIElement_ItemLists (ListenToElementMessage @ 004e4d50):
 *    click selects, double-click uses, right-click examines.
 *
 * Drives the shipped ItemShortcutRestorer and GameUI slot gestures.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import {
  ItemShortcutRestorer,
  quickslotCommand,
  isShortcutEligible,
  CREATE_SHORTCUT_ACTION,
  SHORTCUT_NO_FREE_SLOTS_TEXT,
  type ShortcutItemInfo,
  type ShortcutTarget,
} from '../packages/renderer/src/network/itemShortcutRestore';
import { KEYBIND_ACTIONS } from '../packages/renderer/src/input/KeybindActions.generated';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const A = 0x80000a01;
const B = 0x80000a02;
const C = 0x80000a03;
const items = new Map<number, ShortcutItemInfo>([
  [A, { iconDid: 0x06001111, name: 'Healing Kit' }],
  [B, { iconDid: 0x06002222, name: 'Mana Stone' }],
  [C, { iconDid: 0x06003333, name: 'Apple' }],
]);
const owned = (id: number): ShortcutTarget => ({ owned: true, item: items.get(id), name: items.get(id)?.name });

let sent: string[];
let icons: Map<number, number | undefined>;
let bar: ItemShortcutRestorer;

beforeEach(() => {
  sent = [];
  icons = new Map();
  bar = new ItemShortcutRestorer(
    (index, iconDid) => icons.set(index, iconDid),
    { add: (i, o) => sent.push(`add ${i} ${o.toString(16)}`), remove: (i) => sent.push(`remove ${i}`) },
  );
  bar.itemOf = (id) => items.get(id);
});

function restore(records: Array<{ index: number; objectId: number }>): void {
  bar.restoreFromDescription(records, (id) => items.get(id));
  sent = [];
}

describe('ListenToGlobalMessage — the Quickslot commands', () => {
  it('Quickslot 1-12 / 13-18 use their slot; Select Quickslot selects', () => {
    expect(quickslotCommand(0x10000042)).toEqual({ slot: 0, use: true });
    expect(quickslotCommand(0x1000004d)).toEqual({ slot: 11, use: true });
    expect(quickslotCommand(0x10000132)).toEqual({ slot: 12, use: true });
    expect(quickslotCommand(0x10000137)).toEqual({ slot: 17, use: true });
    expect(quickslotCommand(0x1000004e)).toEqual({ slot: 0, use: false });
    expect(quickslotCommand(0x10000056)).toEqual({ slot: 8, use: false });
    expect(quickslotCommand(0x1000013d)).toEqual({ slot: 17, use: false });
    expect(quickslotCommand(CREATE_SHORTCUT_ACTION)).toBeNull();
    expect(quickslotCommand(0x10000041)).toBeNull();
  });

  it('every DAT ActionMap Quickslot command resolves to the slot its name numbers', () => {
    const quick = KEYBIND_ACTIONS.filter(a => /^(Select )?Quickslot \d+$/.test(a.name));
    expect(quick.length).toBeGreaterThanOrEqual(27);
    for (const a of quick) {
      const n = Number(a.name.match(/(\d+)$/)![1]);
      expect(quickslotCommand(a.id), a.name).toEqual({ slot: n - 1, use: !a.name.startsWith('Select') });
    }
    expect(KEYBIND_ACTIONS.find(a => a.id === CREATE_SHORTCUT_ACTION)?.name).toBe('Create Shortcut');
  });
});

describe('IsShortcutEligible', () => {
  it('refuses unowned stuck objects, unowned creatures and vendor stock only', () => {
    expect(isShortcutEligible({ owned: false, stuck: true, itemType: 0x1 })).toBe(false);
    expect(isShortcutEligible({ owned: false, stuck: false, itemType: 0x10 })).toBe(false);
    expect(isShortcutEligible({ owned: true, stuck: false, itemType: 0x1, vendorItem: true })).toBe(false);
    expect(isShortcutEligible({ owned: false, stuck: false, itemType: 0x80 })).toBe(true);
    expect(isShortcutEligible({ owned: true, stuck: true, itemType: 0x10 })).toBe(true);
  });
});

describe('CreateShortcutToItem', () => {
  it('Create Shortcut (-1) takes the first empty slot and tells the server', () => {
    restore([{ index: 0, objectId: A }]);
    expect(bar.createShortcutToItem(B, -1, owned(B), true, false)).toBeNull();
    expect(bar.objectAt(1)).toBe(B);
    expect(icons.get(1)).toBe(0x06002222);
    expect(sent).toEqual([`add 1 ${B.toString(16)}`]);
  });

  it('-1 refuses an object already on the bar, and a full bar', () => {
    restore([{ index: 4, objectId: A }]);
    expect(bar.createShortcutToItem(A, -1, owned(A), true, false)).toBe('There is already a shortcut to the Healing Kit');
    expect(bar.objectAt(4)).toBe(A);
    restore(Array.from({ length: 18 }, (_, i) => ({ index: i, objectId: 0x80001000 + i })));
    expect(bar.createShortcutToItem(B, -1, owned(B), true, false)).toBe(SHORTCUT_NO_FREE_SLOTS_TEXT);
    expect(sent).toEqual([]);
  });

  it('an ineligible object is refused; quiet suppresses the notice', () => {
    const t: ShortcutTarget = { owned: false, eligible: false, name: 'Drudge Slinker' };
    expect(bar.createShortcutToItem(C, 3, t, true, false)).toBe('You cannot make a shortcut to the Drudge Slinker');
    expect(bar.createShortcutToItem(C, 3, t, true, true)).toBeNull();
    expect(bar.objectAt(3)).toBe(0);
    expect(bar.createShortcutToItem(C, 3, null, true, false)).toBeNull();
  });

  it('an unowned object is picked up first when allowed, refused otherwise', () => {
    const ground: ShortcutTarget = { owned: false, item: items.get(C), name: 'Apple' };
    expect(bar.createShortcutToItem(C, 2, ground, false, false)).toBe('You cannot make a shortcut to the Apple');
    const pickUp = vi.fn(() => true);
    expect(bar.createShortcutToItem(C, 2, ground, true, false, pickUp)).toBeNull();
    expect(pickUp).toHaveBeenCalledOnce();
    expect(bar.objectAt(2)).toBe(C);
    const failed = vi.fn(() => false);
    expect(bar.createShortcutToItem(B, 5, { owned: false, name: 'Mana Stone' }, true, false, failed)).toBeNull();
    expect(bar.objectAt(5)).toBe(0);
  });

  it('moving an object to a new slot removes its old shortcut', () => {
    restore([{ index: 0, objectId: A }]);
    bar.createShortcutToItem(A, 6, owned(A), true, false);
    expect(bar.objectAt(0)).toBe(0);
    expect(bar.objectAt(6)).toBe(A);
    expect(sent).toEqual(['remove 0', `add 6 ${A.toString(16)}`]);
  });
});

describe('HandleDropRelease / ItemListBeginDrag', () => {
  it('GetFirstEmptyShortcutToTheRightOf scans right, then wraps from 0 to the slot', () => {
    restore([{ index: 3, objectId: A }, { index: 4, objectId: B }]);
    expect(bar.firstEmptyRightOf(3)).toBe(5);
    restore(Array.from({ length: 18 }, (_, i) => ({ index: i, objectId: i === 1 ? 0 : 0x80001000 + i })));
    expect(bar.firstEmptyRightOf(10)).toBe(1);
    expect(bar.firstEmptyRightOf(0)).toBe(1);
    restore(Array.from({ length: 18 }, (_, i) => ({ index: i, objectId: 0x80001000 + i })));
    expect(bar.firstEmptyRightOf(10)).toBe(-1);
  });

  it('an item dropped on a filled slot pushes the old one to the first empty slot to its right', () => {
    restore([{ index: 2, objectId: A }, { index: 3, objectId: B }]);
    expect(bar.dropItemOnSlot(C, 2, owned(C), () => false)).toBeNull();
    expect(bar.objectAt(2)).toBe(C);
    expect(bar.objectAt(4)).toBe(A);
    expect(bar.objectAt(3)).toBe(B);
    expect(sent).toEqual(['remove 2', `add 2 ${C.toString(16)}`, `add 4 ${A.toString(16)}`]);
  });

  it('dragging a shortcut off removes it at once; dropping it off the bar leaves it gone', () => {
    restore([{ index: 0, objectId: A }]);
    expect(bar.beginShortcutDrag(0)).toBe(A);
    expect(bar.objectAt(0)).toBe(0);
    expect(icons.get(0)).toBeUndefined();
    expect(sent).toEqual(['remove 0']);
    bar.endShortcutDrag();
    bar.dropShortcutOnSlot(5);
    expect(bar.slotOf(A)).toBe(-1);
    expect(bar.beginShortcutDrag(7)).toBe(0);
  });

  it('a shortcut dropped on another slot swaps with that slot\'s object', () => {
    restore([{ index: 0, objectId: A }, { index: 5, objectId: B }]);
    bar.beginShortcutDrag(0);
    bar.dropShortcutOnSlot(5);
    expect(bar.objectAt(5)).toBe(A);
    expect(bar.objectAt(0)).toBe(B);
    expect(icons.get(0)).toBe(0x06002222);
    expect(sent).toEqual(['remove 0', 'remove 5', `add 5 ${A.toString(16)}`, `add 0 ${B.toString(16)}`]);
  });

  it('a shortcut dropped on an empty slot just moves', () => {
    restore([{ index: 1, objectId: A }]);
    bar.beginShortcutDrag(1);
    bar.dropShortcutOnSlot(9);
    expect(bar.objectAt(9)).toBe(A);
    expect(bar.objectAt(1)).toBe(0);
  });
});

// ── GameUI: the slot gestures ──────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI — shortcut slots are item lists', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let calls: string[];
  const slots: HTMLElement[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    for (let i = 0; i < 18; i++) {
      const el = domWindow.document.createElement('div');
      ui.itemShortcutSlots[i] = el;
      ui.bindItemShortcutSlot(el, i);
      ui.applyItemShortcutSlot(i);
      slots[i] = el;
    }
  });

  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  beforeEach(() => {
    calls = [];
    ui.itemShortcutCallbacks = {
      onClick: (s: number) => calls.push(`click ${s}`),
      onUse: (s: number) => calls.push(`use ${s}`),
      onExamine: (s: number) => calls.push(`examine ${s}`),
      onBeginDrag: (s: number) => calls.push(`begin ${s}`),
      onEndDrag: () => calls.push('end'),
      onDropShortcut: (s: number) => calls.push(`dropShortcut ${s}`),
      onDropItem: (s: number, src: { kind: string }) => calls.push(`dropItem ${s} ${JSON.stringify(src)}`),
    };
  });

  const fire = (el: HTMLElement, type: string): Event => {
    const e = new domWindow.Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  it('click selects, double-click uses, right-click examines', () => {
    fire(slots[3], 'click');
    fire(slots[3], 'dblclick');
    const ctx = fire(slots[3], 'contextmenu');
    expect(calls).toEqual(['click 3', 'use 3', 'examine 3']);
    expect(ctx.defaultPrevented).toBe(true);
  });

  it('an empty slot cannot be picked up', () => {
    const e = fire(slots[1], 'dragstart');
    expect(e.defaultPrevented).toBe(true);
    expect(slots[1].draggable).toBe(true);
  });

  it('a filled slot picks up its shortcut (after dragstart) and drops it on another slot', async () => {
    ui.setItemShortcutIcon(0, 0x06001111, 'Healing Kit');
    fire(slots[0], 'dragstart');
    expect(calls).toEqual([]);
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toEqual(['begin 0']);
    expect(fire(slots[6], 'dragover').defaultPrevented).toBe(true);
    fire(slots[6], 'drop');
    fire(slots[0], 'dragend');
    expect(calls).toEqual(['begin 0', 'dropShortcut 6']);
  });

  it('a shortcut dropped off the bar ends the drag', async () => {
    ui.setItemShortcutIcon(2, 0x06001111, 'Healing Kit');
    fire(slots[2], 'dragstart');
    await new Promise(r => setTimeout(r, 0));
    fire(slots[2], 'dragend');
    expect(calls).toEqual(['begin 2', 'end']);
  });

  it('a pack item dragged onto a slot is offered as a real item; nothing in flight is refused', () => {
    expect(fire(slots[4], 'dragover').defaultPrevented).toBe(false);
    ui.dragItemIndex = 7;
    expect(fire(slots[4], 'dragover').defaultPrevented).toBe(true);
    fire(slots[4], 'drop');
    expect(calls).toEqual(['dropItem 4 {"kind":"inventory","itemIndex":7}']);
    expect(ui.dragItemIndex).toBe(-1);
  });

  it('useHeldItem runs ItemHolder::UseObject on a pack or worn item (SWEEP1006B), and is false for anything else', () => {
    const used: number[] = [];
    ui.dragCallbacks.onUseObject = (guid: number) => used.push(guid);
    ui.inventoryItems = [{ id: A }, { id: B }];
    ui.equippedItems = [{ id: C, slot: 0x200000 }];
    expect(ui.useHeldItem(B)).toBe(true);
    expect(ui.useHeldItem(C)).toBe(true);
    expect(ui.useHeldItem(0x80009999)).toBe(false);
    expect(used).toEqual([B, C]);
  });
});
