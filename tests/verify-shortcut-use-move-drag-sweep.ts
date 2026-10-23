/**
 * Sweep after 4514bf23 (the main pack on the shortcut bar): retail gestures
 * on the shortcut bar, the spell bar and the vendor's sell list that ours
 * dropped. Each block drives the shipped module.
 *
 * 1. CPlayerSystem::UsingItem @ 00562f70's client tail. ItemHolder::UseObject
 *    @ 00588a80 on a side pack (ItemUseable 56 ContainedViewedRemote, ACE
 *    weenie 136) sends Event_UseEvent and then runs UsingItem, whose
 *    IsOwnedByPlayer && IsContainer branch raises
 *    SendNotice_OpenContainedContainer: the inventory opens on that pack.
 *    Ours sent the Use and showed "Using the Pack" but opened nothing.
 *    UsingItem's param_3 == 0 re-run of DetermineUseResult also makes case 8
 *    (WieldLeft, which UseObject's `1 < r < 8` gate passes on) AutoWield(left).
 * 2. gmToolbarUI::RecvNotice_ServerSaysMoveItem @ 004bf2b0: a shortcut whose
 *    object is no longer IsOwnedByPlayer (sold, given, dropped, stored, used
 *    up: ACCWeenieObject::Remove @ 0058dd20 → ServerSaysMoveItem(this, 0))
 *    leaves the bar via RemoveShortcutInSlotNum(slot, true), which sends
 *    Event_RemoveShortCut. Ours never removed one, so a used-up kit's slot
 *    stayed on the bar and on the server.
 * 3. gmSpellcastingUI::RecvNotice_ItemListBeginDrag @ 004c7360 / HandleDropRelease
 *    @ 004c7930: the spell bar's list 0x100000b6 is drag-enabled (it inherits
 *    0x10000016 = true from 0x2100003d:0x10000339). Picking a shortcut up
 *    takes it off the tab (RemoveSpellFromMenu); dropping it on a cell
 *    re-inserts it there, or on a tab label appends it to that tab. Ours
 *    had no drag source, so a spell could never leave the bar (removeSpellFromBar
 *    had no caller).
 * 4. gmVendorUI::RecvNotice_ItemListBeginDrag @ 004c4380: the sell list
 *    0x100000ce keeps the base's drag enable (the shop / buy lists set it
 *    false). An entry picked up leaves the sell list and the drag carries the
 *    player's own item on. Ours had no drag on it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  decideUseObject, usingItemEffects, useObjectRunsUsingItem, isContainerSubject, ownedUseSubject,
  BF_REQUIRES_PACK_SLOT, BF_WIELD_LEFT, type UseSubject, type UseObjectContext,
} from '../packages/renderer/src/input/UseObject.js';
import { ItemShortcutRestorer, toolbarObjectMoved } from '../packages/renderer/src/network/itemShortcutRestore.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { InventoryController } from '../packages/renderer/src/controllers/InventoryController.js';
import { removeItemLeavingPlayer } from '../packages/renderer/src/player/containInLeavesPlayer.js';
import { recordInventoryRequestFromAction, handleAttemptFailed } from '../packages/renderer/src/inventory/InventoryRequests.js';
import { InventoryRequestTracker } from '../packages/shared/src/index.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const PLAYER = 0x50000001;
const PACK = 0x80001111;

const ctx = (over: Partial<UseObjectContext> = {}): UseObjectContext => ({
  playerGuid: PLAYER, groundObject: 0, allowSelection: false, skipDetermine: false, selectedGuid: 0,
  attackable: false, peaceMode: true, confirmVolatileRare: false, selectionCompatible: false, ...over,
});

describe('UsingItem @ 00562f70 — an owned container opens in the inventory on every UseObject path that reaches it', () => {
  // ACE weenie 136 "Pack": ItemType Container 0x200, ItemsCapacity 24, ItemUseable 56.
  const sidePack = (): UseSubject => ownedUseSubject(PACK, {
    name: 'Pack', containerId: PLAYER, itemType: 0x200, usable: 56, itemsCapacity: 24, objectDescFlags: BF_REQUIRES_PACK_SLOT,
  }, PLAYER);

  it('a side pack used from its shortcut: the Use goes out ("Using the Pack") AND the pack opens', () => {
    const o = sidePack();
    expect(decideUseObject(o, ctx())).toEqual({ kind: 'use', text: 'Using the Pack' });
    expect(usingItemEffects(o, ctx())).toEqual({ autoWieldLeft: false, openContainer: true, createShortcut: false });
  });

  it('IsContainer reads RequiresPackSlot or either capacity (ACCWeenieObject::IsContainer @ 004a4530)', () => {
    expect(isContainerSubject({ bitfield: 0, itemsCapacity: 24, containersCapacity: 0 })).toBe(true);
    expect(isContainerSubject({ bitfield: BF_REQUIRES_PACK_SLOT, itemsCapacity: 0, containersCapacity: 0 })).toBe(true);
    expect(isContainerSubject({ bitfield: 0, itemsCapacity: 0, containersCapacity: 0 })).toBe(false);
  });

  it('ownedUseSubject keeps the pack\'s capacities (they were zeroed, so IsContainer could not see a pack)', () => {
    expect(sidePack().itemsCapacity).toBe(24);
  });

  it('a chest on the ground (not owned) does not open as a contained container', () => {
    const chest: UseSubject = { ...sidePack(), guid: 0x7a9b0001, name: 'Chest', containerId: 0, bitfield: 0x5, ownedByPlayer: false };
    expect(usingItemEffects(chest, ctx())?.openContainer).toBe(false);
  });

  it('a non-useable owned container still opens (UsingItem(…, 0, …) runs before the "cannot be used" tail)', () => {
    const o = { ...sidePack(), useability: 1 };
    expect(decideUseObject(o, ctx())).toEqual({ kind: 'message', text: 'The Pack cannot be used' });
    expect(usingItemEffects(o, ctx())?.openContainer).toBe(true);
  });

  it('the paths that return before UsingItem open nothing: trading, the target-mode arm, the confirmations', () => {
    expect(useObjectRunsUsingItem({ ...sidePack(), beingTraded: true }, ctx())).toBe(false);
    const kit = { ...sidePack(), name: 'Healing Kit', itemsCapacity: 0, bitfield: 0, useability: 0x00080008 };
    expect(decideUseObject(kit, ctx()).kind).toBe('targetMode');
    expect(usingItemEffects(kit, ctx())).toBeNull();
    expect(useObjectRunsUsingItem({ ...sidePack(), bitfield: BF_REQUIRES_PACK_SLOT | 0x400 }, ctx())).toBe(false);
  });

  it('a plain owned item runs UsingItem but opens nothing', () => {
    const food = ownedUseSubject(0x80003333, { name: 'Apple', containerId: PLAYER, itemType: 0x20, usable: 8 }, PLAYER);
    expect(usingItemEffects(food, ctx())).toEqual({ autoWieldLeft: false, openContainer: false, createShortcut: false });
  });

  it('DetermineUseResult case 8 (a WieldLeft caster in the pack) is UsingItem\'s AutoWield(SLOT_SIDE_LEFT)', () => {
    const left = ownedUseSubject(0x80004444, {
      name: 'Orb', containerId: PLAYER, itemType: 0x8000, usable: 8, objectDescFlags: BF_WIELD_LEFT,
    }, PLAYER);
    expect(usingItemEffects(left, ctx())?.autoWieldLeft).toBe(true);
    // A right-hand wieldable is case 3 — UseObject's own UsingItem case, no extra wield.
    const right = { ...left, bitfield: 0 };
    expect(decideUseObject(right, ctx())).toEqual({ kind: 'usingItem', result: 3 });
    expect(usingItemEffects(right, ctx())?.autoWieldLeft).toBe(false);
  });
});

describe('gmToolbarUI::RecvNotice_ServerSaysMoveItem @ 004bf2b0 — a shortcut to an object the player no longer owns leaves the bar', () => {
  let sent: string[];
  let icons: Map<number, string>;
  let bar: ItemShortcutRestorer;
  const KIT = 0x80002222;
  beforeEach(() => {
    sent = [];
    icons = new Map();
    bar = new ItemShortcutRestorer(
      (index, _icon, title) => icons.set(index, title),
      { add: (i, o) => sent.push(`add ${i} ${o.toString(16)}`), remove: (i) => sent.push(`remove ${i}`) },
    );
    bar.addShortcut(KIT, 3, { name: 'Healing Kit' }, false);
  });

  it('used up / sold / dropped (no longer owned): the slot clears and Event_RemoveShortCut goes out', () => {
    expect(bar.serverSaysMoveItem(KIT, false)).toBe(3);
    expect(bar.objectAt(3)).toBe(0);
    expect(icons.get(3)).toBe('');
    expect(sent).toEqual(['remove 3']);
  });

  it('moved between the player\'s own packs (still owned): kept, nothing sent', () => {
    expect(bar.serverSaysMoveItem(KIT, true)).toBe(-1);
    expect(bar.objectAt(3)).toBe(KIT);
    expect(sent).toEqual([]);
  });

  it('an object with no shortcut: nothing', () => {
    expect(bar.serverSaysMoveItem(0x80009999, false)).toBe(-1);
    expect(sent).toEqual([]);
  });

  it('a stack merged first (FullMergingItem moved the shortcut) is not removed again when the source is deleted', () => {
    const DST = 0x80002223;
    bar.fullMergingItem(KIT, DST, { owned: true, item: { name: 'Healing Kit' } });
    sent = [];
    expect(bar.serverSaysMoveItem(KIT, false)).toBe(-1);
    expect(bar.objectAt(3)).toBe(DST);
    expect(sent).toEqual([]);
  });
});

describe('a refused drop (0x00A0 InventoryServerSaveFailed) leaves the item in the pack — no optimistic removal (ServerSaysAttemptFailed @ 0058eae0)', () => {
  const FAVOR = 0x8000cc98; // Blackmoor's Favor, the live ACE case (error 426 "That item can't be dropped")
  it('DropItem records the request; the refusal names the item, clears the request and the item is still carried', () => {
    const ps = new PlayerState();
    ps.inventory.addItem({
      weenieClassId: 3, name: "Blackmoor's Favor", value: 0, burden: 5, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemType: 0x80,
    } as never, FAVOR);
    const tracker = new InventoryRequestTracker();
    const w = new BinaryWriter(4);
    w.writeUInt32(FAVOR);
    recordInventoryRequestFromAction(tracker, GameActionType.DropItem, w.toBuffer(), () => 'contained', 1);
    expect(tracker.pendingObjectId).toBe(FAVOR);
    const shown: string[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({
      onInventoryServerSaveFailed: ({ itemGuid, errorType }) => {
        handleAttemptFailed(tracker, itemGuid, errorType, (g) => {
          const it = ps.inventory.getItem(g);
          return it ? { name: it.name, pluralName: it.pluralName, stackSize: it.stackSize } : undefined;
        }, (t) => shown.push(t));
      },
    });
    const ev = new BinaryWriter(24);
    for (const v of [0xf7b0, PLAYER, 9, 0x00a0, FAVOR, 426]) ev.writeUInt32(v);
    h.handleMessage(deserializeMessage(ev.toBuffer()));
    expect(ps.inventory.getItem(FAVOR)).toBeTruthy();
    expect(tracker.pendingObjectId).toBe(0);
    // The line can name it only because it is still in the pack.
    expect(shown.join('|')).toContain("Blackmoor's Favor");
  });
});

describe('every era\'s "item left the player" message reaches the toolbar, with ownership read after the move', () => {
  const KIT = 0x900008dc; // the Handy Healing Kit of the GDLE report
  const WAND = 0x900008dd;
  const SACK = 0x900008de;
  function world() {
    const ps = new PlayerState();
    const item = (name: string, itemType: number) => ({
      weenieClassId: 1, name, value: 1, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, itemType,
    });
    ps.inventory.addItem(item('Handy Healing Kit', 0x80) as never, KIT);
    ps.inventory.addItem(item('Wand', 0x8000) as never, WAND);
    const sent: string[] = [];
    const bar = new ItemShortcutRestorer(() => {}, { add: (i, o) => sent.push(`add ${i} ${o.toString(16)}`), remove: (i) => sent.push(`remove ${i}`) });
    bar.addShortcut(WAND, 0, { name: 'Wand' }, false);
    bar.addShortcut(KIT, 1, { name: 'Handy Healing Kit' }, false);
    const inv = new InventoryController();
    inv.setPlayerState(ps);
    // main.ts's handlers: apply the move, then the toolbar (toolbarObjectMoved).
    const moved = (guid: number) => toolbarObjectMoved(bar, guid, { isThePlayer: guid === PLAYER, held: !!ps.inventory.getItem(guid) });
    const h = new ServerMessageHandler();
    h.setHandlers({
      onInventoryPutIn3D: ({ itemGuid }) => { removeItemLeavingPlayer(ps, itemGuid); moved(itemGuid); },
      onInventoryRemove: ({ itemGuid }) => { removeItemLeavingPlayer(ps, itemGuid); moved(itemGuid); },
      onInventoryPut: ({ itemGuid, containerGuid }) => {
        const it = ps.inventory.getItem(itemGuid);
        if (it && containerGuid !== PLAYER && containerGuid !== SACK) removeItemLeavingPlayer(ps, itemGuid);
        else if (it) it.containerId = containerGuid;
        moved(itemGuid);
      },
    });
    return { ps, bar, sent, inv, h };
  }
  /** An end-of-retail GameEvent (0xF7B0 player seq type …): what ACE and GDLE (ObjectMsgs.cpp InventoryDrop) send. */
  const eolEvent = (type: number, ...body: number[]) => {
    const w = new BinaryWriter(16 + body.length * 4);
    for (const v of [0xf7b0, PLAYER, 9, type, ...body]) w.writeUInt32(v);
    return deserializeMessage(w.toBuffer());
  };

  it('GDLE drag-drop to the ground: the kit stays in the pack until 0x19A, which takes it out and clears its slot', () => {
    const { ps, bar, sent, h } = world();
    // DropItem sent: nothing removed yet (UIAttemptPutIn3D only records the request).
    expect(ps.inventory.getItem(KIT)).toBeTruthy();
    h.handleMessage(eolEvent(0x19a, KIT));
    expect(ps.inventory.getItem(KIT)).toBeFalsy();
    expect(bar.objectAt(1)).toBe(0);
    expect(sent).toEqual(['remove 1']);
    expect(bar.objectAt(0)).toBe(WAND);
  });

  it('ownership is read after the move: an item already gone from the pack when 0x19A lands still loses its slot', () => {
    const { ps, bar, sent, inv, h } = world();
    inv.dropItem(KIT); // any earlier local removal
    expect(ps.inventory.getItem(KIT)).toBeFalsy();
    h.handleMessage(eolEvent(0x19a, KIT));
    expect(bar.objectAt(1)).toBe(0);
    expect(sent).toEqual(['remove 1']);
  });

  it('ACE 0x0024 InventoryRemoveObject (used up, given, lost on death) clears the slot', () => {
    const { bar, sent, h } = world();
    const w = new BinaryWriter(8);
    w.writeUInt32(0x0024); w.writeUInt32(KIT);
    h.handleMessage(deserializeMessage(w.toBuffer()));
    expect(bar.objectAt(1)).toBe(0);
    expect(sent).toEqual(['remove 1']);
  });

  it('a contain-in to a vendor clears the slot; a move into the player\'s own sack keeps it', () => {
    const { bar, sent, h } = world();
    h.handleMessage(eolEvent(0x22, WAND, SACK, 0, 0));
    expect(bar.objectAt(0)).toBe(WAND);
    h.handleMessage(eolEvent(0x22, KIT, 0x7f001234, 0, 0));
    expect(bar.objectAt(1)).toBe(0);
    expect(sent).toEqual(['remove 1']);
  });

  it('AC1999: the 1999 server\'s 0x19A and 0x24 come through Inventory1999 as the same messages and clear the slot', () => {
    const c = emptyCodecs();
    registerObjects1999(c, { movement: (b) => b });
    const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
    registerInventory1999(c, { player: () => player });
    const a = new Adapter1999(c, { account: 'acjs', log: () => {} });
    const { bar, sent, h } = world();
    const drop = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(0x19a).u32(KIT).toBytes();
    for (const m of a.inbound(drop, 4)) h.handleMessage(deserializeMessage(m));
    expect(bar.objectAt(1)).toBe(0);
    const remove = new Writer1999().u32(0x24).u32(WAND).toBytes();
    for (const m of a.inbound(remove, 4)) h.handleMessage(deserializeMessage(m));
    expect(bar.objectAt(0)).toBe(0);
    expect(sent).toEqual(['remove 1', 'remove 0']);
  });

  it('a shortcut still waiting on its weenie (GDLE ContainID ahead of CreateObject at login) is not removed', () => {
    const sent: string[] = [];
    const bar = new ItemShortcutRestorer(() => {}, { add: () => {}, remove: (i) => sent.push(`remove ${i}`) });
    bar.restoreFromDescription([{ index: 2, objectId: KIT }], () => undefined);
    expect(toolbarObjectMoved(bar, KIT, { isThePlayer: false, held: false })).toBe(-1);
    expect(bar.objectAt(2)).toBe(KIT);
    expect(sent).toEqual([]);
  });

  it('the main pack (the player\'s id) is never removed', () => {
    const bar = new ItemShortcutRestorer(() => {}, { add: () => {}, remove: () => {} });
    bar.addShortcut(PLAYER, 5, { name: 'Tester', isThePlayer: true }, false);
    expect(toolbarObjectMoved(bar, PLAYER, { isThePlayer: true, held: false })).toBe(-1);
    expect(bar.objectAt(5)).toBe(PLAYER);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

/** A drag event carrying a DataTransfer stand-in (happy-dom's events have none). */
function dragEvent(type: string, data: Record<string, string> = {}): Event {
  const e = new domWindow.Event(type, { bubbles: true, cancelable: true });
  const store = { ...data };
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      effectAllowed: '', setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '',
      setDragImage: () => {},
    },
  });
  return e;
}

describe('GameUI — spell bar shortcuts drag off, back on, and onto another tab (gmSpellcastingUI @ 004c7360 / 004c7930)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const spell = (id: number, name: string) => ({
    id, name, school: 1, level: 1, power: 1, manaCost: 10, difficulty: 50, duration: 0, components: [], targetType: 2,
  });
  const A = spell(100, 'Spell A');
  const B = spell(200, 'Spell B');
  const C = spell(300, 'Spell C');

  function setup() {
    domWindow.localStorage.clear();
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    const events: string[] = [];
    ui.setSpellData([A, B, C]);
    ui.setSpellCallbacks({
      onAddSpellFavorite: (id: number, pos: number, bar: number) => events.push(`add ${id} @${pos} bar${bar}`),
      onRemoveSpellFavorite: (id: number, bar: number) => events.push(`remove ${id} bar${bar}`),
    });
    ui.spellBarSlots[0] = [A, B, C, null, null, null, null, null, null];
    const cells = [0, 1, 2, 3].map((i) => {
      const el = domWindow.document.createElement('div');
      ui.wireSpellBarSlotEvents(el, i, 0);
      return el;
    });
    const ids = (tab = 0) => (ui.spellBarSlots[tab] as Array<{ id: number } | null>).filter(Boolean).map((s) => s!.id);
    return { ui, events, cells, ids };
  }

  it('picking a shortcut up takes it off the tab (RemoveSpellFavorite) and released nowhere it stays off', async () => {
    const { events, cells, ids } = setup();
    expect(cells[1].draggable).toBe(true);
    const e = dragEvent('dragstart');
    cells[1].dispatchEvent(e);
    expect((e as unknown as { dataTransfer: DataTransfer }).dataTransfer.getData('text/spell-id')).toBe('200');
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['remove 200 bar0']);
    expect(ids()).toEqual([100, 300]);
  });

  it('dropped on a cell it goes back in at that cell (a reorder)', async () => {
    const { events, cells, ids } = setup();
    cells[0].dispatchEvent(dragEvent('dragstart'));
    await new Promise((r) => setTimeout(r, 0));
    cells[2].dispatchEvent(dragEvent('drop', { 'text/spell-id': '100' }));
    expect(ids()).toEqual([200, 300, 100]);
    expect(events).toEqual(['remove 100 bar0', 'add 100 @2 bar0']);
  });

  it('an empty cell is no drag source', () => {
    const { events, cells } = setup();
    const e = dragEvent('dragstart');
    cells[3].dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(events).toEqual([]);
  });

  it('a spellbook row still drops on a cell (text/spell-index)', () => {
    const { ui, events, cells, ids } = setup();
    ui.spellBarSlots[0] = [A, null, null, null, null, null, null, null, null];
    cells[0].dispatchEvent(dragEvent('drop', { 'text/spell-index': '2' }));
    expect(ids()).toEqual([300, 100]);
    expect(events).toEqual(['add 300 @0 bar0']);
  });

  it('dropped on another tab\'s label it is appended there and the open tab stays open', () => {
    const { ui, events } = setup();
    ui.dropSpellOnBar(B, -1, 4);
    expect((ui.spellBarSlots[4] as Array<{ id: number } | null>).filter(Boolean).map((s) => s!.id)).toEqual([200]);
    expect(ui.activeSpellBarTab).toBe(0);
    // AddFavorite(-1) ships m_numSpells after the add, as the spellbook's append does.
    expect(events).toEqual(['add 200 @1 bar4']);
  });
});

describe('GameUI — a sell-list entry drags off the list and on as the player\'s item (gmVendorUI @ 004c4380)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const SWORD = 0x80005555;
  const COINS = 0x80006666;
  const inv = (id: number, name: string, stackSize = 1) => ({
    id, weenieClassId: id & 0xffff, name, value: 10, burden: 10, stackSize, maxStackSize: stackSize, stackable: stackSize > 1, containerId: PLAYER, itemType: 1,
  });
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => {
    ui.setInventoryData([inv(COINS, 'Pyreal', 50), inv(SWORD, 'Sword')], [], 0, 15000);
    ui.vendorData.sellList = [{ guid: SWORD, qty: 1 }];
  });

  it('the entry leaves the sell list and the drag is the inventory item (a pack, the toolbar or the 3D view take it)', async () => {
    ui.beginSellListDrag(SWORD);
    expect(ui.worldDropSource()).toEqual({ kind: 'inventory', itemIndex: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.vendorData.sellList).toEqual([]);
  });

  it('a lowered split size is refused and reset: "You cannot split items from this panel"', () => {
    const shown: string[] = [];
    const spy = vi.spyOn(ui, 'displayErrorText').mockImplementation((t: unknown) => { shown.push(String(t)); });
    ui.toolbarMaxSplitSize = 5;
    ui.toolbarSplitSize = 2;
    ui.beginSellListDrag(SWORD);
    expect(shown).toEqual(['You cannot split items from this panel']);
    expect(ui.getToolbarSplitState().splitSize).toBe(5);
    spy.mockRestore();
  });

  it('a later drag starts with no source: the sell-list drag\'s kind does not leak when its cell was re-rendered away', () => {
    ui.beginSellListDrag(SWORD);
    expect(ui.worldDropSource()).not.toBeNull();
    // A spellbook row's drag (which sets no item source) begins.
    const row = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(row);
    row.dispatchEvent(new domWindow.Event('dragstart', { bubbles: true, cancelable: true }));
    expect(ui.worldDropSource()).toBeNull();
  });
});
