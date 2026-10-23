/**
 * BUG.webac12-inventory-request-lock (jakemmarsh/webac#12, AC1999): "You can only move or use one
 * item at a time" on every pick-up, scroll read and corpse open after looting a wisp, for the rest
 * of the session.
 *
 * That line is the client's own (IsPlayerReadyToMakeInventoryRequest: a pending inventory request,
 * ACCWeenieObject::prevRequest). Three ways ours kept a request pending forever:
 *   1. No watchdog. The 1999 client's Global_Loop @ 0x4c6b30 clears a request pending 105 s
 *      (reference/ac1999/Client/decomp/UI/Global_Loop.c:447-451); ours followed end of retail,
 *      which never does. The AC1999 server has replies that don't name the armed object: a busy
 *      ExecuteUseEvent answers an inventory verb with only a UseDone (WeenieObject.cpp:2760-2767), a
 *      vendor out of view only with a UseDone (ClientEvents.cpp TryBuyItems / TrySellItems).
 *   2. The 0x00A0 dispatch could not resolve a corpse item once the corpse panel had closed (both
 *      retail clients look it up in the object maintenance, which still holds it: 1999
 *      Net_DispatchServerMessage case 0xa0, EoL CObjectMaint), so the server's refusal cleared nothing.
 *   3. A request in flight when the connection dropped survived into the resumed session, whose
 *      server never heard of it.
 *
 * The 1999 server's replies are built as the AC1999 server writes them and run through the REAL
 * 1999 adapter and handler; the client side is the real tracker / gate / dispatch, wired as main.ts
 * wires them. End of retail and Dark Majesty are pinned unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  InventoryRequest, InventoryRequestTracker, INVENTORY_REQUEST_PENDING_TEXT,
  INVENTORY_REQUEST_WATCHDOG_1999_SECONDS, type AttemptFailedObject,
} from '@ac/shared';
import { GameActionType, buildPutItemInContainerPayload, buildStackableMergePayload } from '@ac/network';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerMovement1999 } from '../packages/network/src/era1999/codecs/Movement1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { BinaryWriter, deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import {
  gateInventoryRequestSend, handleAttemptFailed, recordInventoryRequestFromAction, respondToVendorOpen,
  type InventoryObjectState,
} from '../packages/renderer/src/inventory/InventoryRequests.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { EOR_ERA_ID, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

const PLAYER = 0x50000003;
const CORPSE = 0x80000a01;
const SCROLL = 0x80000a02;
const DRAUGHT = 0x80000a03;
const PYREALS = 0x80000a04;
const MY_DRAUGHTS = 0x80000b01;
const VENDOR = 0x70044012;

/** WeenieError (the AC1999 server's GameEnums.h order = ACE's numbers). */
const ERR = { ActionsLocked: 0x1d, ObjectGone: 0x37 } as const;

const ERA_1999 = 'ac1999-retail';
const DM_ERAS = ['classic-dereth', 'classicace-customdm', 'classicace-infiltration'];

/* ── the 1999 server's replies, as it writes them ───────────────────────── */

let seq1999 = 0;
/** CPlayerWeenie::NotifyInventoryFailedEvent (Player.cpp:1604): 0xA0 {item, error}, SendNetMessage(…, event = TRUE). */
const fail1999 = (item: number, error: number) =>
  new Writer1999().u32(0xf7b0).u32(PLAYER).u32(++seq1999).u32(0xa0).u32(item).u32(error).toBytes();
/** FinishMoveItemToContainer's InventoryMove (Monster.cpp:859): 0x22 {item, container, slot, type}, event = TRUE. */
const put1999 = (item: number, container: number, slot = 0) =>
  new Writer1999().u32(0xf7b0).u32(PLAYER).u32(++seq1999).u32(0x22).u32(item).u32(container).u32(slot).u32(0).toBytes();
/** CPlayerWeenie::NotifyUseDone: 0x1C7 {error}, event = TRUE. */
const useDone1999 = (error: number) =>
  new Writer1999().u32(0xf7b0).u32(PLAYER).u32(++seq1999).u32(0x1c7).u32(error).toBytes();

/* ── end of retail (ACE) replies, as ACE writes them ────────────────────── */

let seqEol = 0;
const eolEvent = (type: number, body: (w: BinaryWriter) => void): Uint8Array => {
  const w = new BinaryWriter(64);
  w.writeUInt32(0xf7b0); w.writeUInt32(PLAYER); w.writeUInt32(++seqEol); w.writeUInt32(type);
  body(w);
  return w.toBuffer();
};
/** GameEventItemServerSaysContainId. */
const putEol = (item: number, container: number) => eolEvent(0x22, (w) => { w.writeUInt32(item); w.writeUInt32(container); w.writeUInt32(0); w.writeUInt32(0); });
/** GameEventInventoryServerSaveFailed. */
const failEol = (item: number, error: number) => eolEvent(0xa0, (w) => { w.writeUInt32(item); w.writeUInt32(error); });
/** GameMessageInventoryRemoveObject (0x0024, not an event). */
const removeEol = (item: number) => { const w = new BinaryWriter(8); w.writeUInt32(0x24); w.writeUInt32(item); return w.toBuffer(); };

/* ── the client, wired as main.ts wires it ──────────────────────────────── */

interface Item { name: string; pluralName?: string; stackSize?: number }

function client(eraId: string, opts: { snapshots?: boolean } = {}) {
  let now = 1000;
  const rules = eraClientRules(eraProfile(eraId));
  const tracker = new InventoryRequestTracker({ watchdogSeconds: rules.inventoryRequestWatchdogSeconds, now: () => now });
  const pack = new Map<number, Item>([[MY_DRAUGHTS, { name: 'Health Draught', pluralName: 'Health Draughts', stackSize: 2 }]]);
  /** The open corpse's contents (openContainer); flushed when its panel closes. */
  const corpse = new Map<number, Item>([
    [SCROLL, { name: 'Scroll of Flame Bolt' }],
    [DRAUGHT, { name: 'Health Draught', pluralName: 'Health Draughts', stackSize: 1 }],
    [PYREALS, { name: 'Pyreal', pluralName: 'Pyreals', stackSize: 2 }],
  ]);
  /** 3D objects (serverObjectManager). */
  const world = new Map<number, Item>([[VENDOR, { name: 'Shopkeeper' }], [CORPSE, { name: 'Corpse of Wisp' }]]);
  const spew: string[] = [];
  const sent: GameActionType[] = [];
  /** resolveAttemptFailedObject: our packs, the open ground container, the world. */
  const resolve = (g: number): AttemptFailedObject | undefined => pack.get(g) ?? corpse.get(g) ?? world.get(g);
  const stateOf = (g: number): InventoryObjectState => (pack.has(g) || corpse.has(g) ? 'contained' : world.has(g) ? 'in3D' : 'unknown');

  /** sendGameAction: the gate, the send, the record. */
  const send = (type: GameActionType, payload: Uint8Array): boolean => {
    if (!gateInventoryRequestSend(tracker, type, (t) => spew.push(t))) return false;
    sent.push(type);
    recordInventoryRequestFromAction(tracker, type, payload, stateOf, now, opts.snapshots === false ? undefined : resolve);
    return true;
  };
  const use = (guid: number) => { const p = new BinaryWriter(4); p.writeUInt32(guid); return send(GameActionType.Use, p.toBuffer()); };

  const h = new ServerMessageHandler();
  h.setHandlers({
    onInventoryPut: (d) => {
      tracker.respond(d.itemGuid);
      const it = corpse.get(d.itemGuid);
      if (it && d.containerGuid === PLAYER) { corpse.delete(d.itemGuid); pack.set(d.itemGuid, it); }
    },
    onInventoryRemove: (d) => { tracker.respond(d.itemGuid); corpse.delete(d.itemGuid); pack.delete(d.itemGuid); },
    onSetStackSize: (d) => { tracker.respond(d.guid); },
    onInventoryServerSaveFailed: (d) => { handleAttemptFailed(tracker, d.itemGuid, d.errorType, resolve, (t) => spew.push(t)); },
    onUseDone: () => { /* the busy count's; the inventory request is not its to clear */ },
  });

  const c = emptyCodecs();
  const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
  registerInventory1999(c, { player: () => player });
  registerMovement1999(c, { playerGuid: () => PLAYER });
  const adapter = new Adapter1999(c, { account: 'acjs', log: () => {} });
  const from1999 = (bytes: Uint8Array) => { for (const m of adapter.inbound(bytes, 4)) h.handleMessage(deserializeMessage(m)); };
  const fromAce = (bytes: Uint8Array) => h.handleMessage(deserializeMessage(bytes));

  return {
    tracker, pack, corpse, spew, sent, send, use, from1999, fromAce,
    pickUp: (g: number) => send(GameActionType.PutItemInContainer, buildPutItemInContainerPayload(g, PLAYER, 0)),
    /** gmExternalContainerUI::CloseCurrentContainer (the range exit): the list is flushed. */
    closeCorpsePanel: () => corpse.clear(),
    advance: (s: number) => { now += s; },
  };
}

/* ── the reporter's flow on the AC1999 server ───────────────────────────── */

describe('webac#12 on the AC1999 server: looting a wisp no longer locks every inventory verb and use', () => {
  it('pick-ups answered by 0x22 clear one by one; the scroll is then read', () => {
    const c = client(ERA_1999);
    expect(c.pickUp(SCROLL)).toBe(true);
    expect(c.tracker.pending).toMatchObject({ objectId: SCROLL, request: InventoryRequest.PutInContainer });
    c.from1999(put1999(SCROLL, PLAYER));
    expect(c.tracker.pending).toBeNull();
    expect(c.pickUp(DRAUGHT)).toBe(true);
    c.from1999(put1999(DRAUGHT, PLAYER));
    expect(c.use(SCROLL)).toBe(true);
    expect(c.spew).toEqual([]);
  });

  it('a pick-up the server refuses after the corpse panel closed clears: the refusal names the scroll, and the scroll can be read', () => {
    const c = client(ERA_1999);
    c.pickUp(SCROLL);
    // The player steps out of the corpse's use radius: our range check closes the panel (and flushes
    // its list); the server's pick-up then finds the corpse no longer opened by us and cancels.
    c.closeCorpsePanel();
    c.from1999(fail1999(SCROLL, ERR.ObjectGone));
    expect(c.tracker.pending).toBeNull();
    expect(c.spew).toEqual(["The Scroll of Flame Bolt can't be put in the container - unable to move to object"]);
    expect(c.use(SCROLL)).toBe(true);
  });

  it('(the bug) without the send-time record the same refusal resolved nothing and the lock stayed', () => {
    const c = client(EOR_ERA_ID, { snapshots: false }); // no watchdog either: the pre-fix client in every era
    c.pickUp(SCROLL);
    c.closeCorpsePanel();
    c.from1999(fail1999(SCROLL, ERR.ObjectGone));
    expect(c.tracker.pending).toMatchObject({ objectId: SCROLL });
    c.advance(3600);
    expect(c.use(CORPSE)).toBe(false);
    expect(c.spew).toEqual([INVENTORY_REQUEST_PENDING_TEXT]);
  });

  it('a request the server answers with only a UseDone (a busy ExecuteUseEvent) holds 105 s, then the corpse opens — the 1999 client\'s watchdog', () => {
    const c = client(ERA_1999);
    expect(INVENTORY_REQUEST_WATCHDOG_1999_SECONDS).toBe(105);
    c.pickUp(PYREALS);
    c.from1999(useDone1999(ERR.ActionsLocked));
    expect(c.tracker.pending).toMatchObject({ objectId: PYREALS, request: InventoryRequest.PutInContainer });
    c.advance(104.9);
    expect(c.use(CORPSE)).toBe(false);
    expect(c.spew).toEqual([INVENTORY_REQUEST_PENDING_TEXT]);
    c.advance(0.1); // 105.0 <= cur_time - prevRequestTime
    expect(c.tracker.pending).toBeNull();
    expect(c.use(CORPSE)).toBe(true);
    expect(c.sent).toEqual([GameActionType.PutItemInContainer, GameActionType.Use]);
  });

  it('a 0xA0 naming another object (the merge use-event cancelled with its target, UseManager.cpp:882) still clears the pending merge', () => {
    const c = client(ERA_1999);
    c.send(GameActionType.StackableMerge, buildStackableMergePayload(DRAUGHT, MY_DRAUGHTS, 1));
    expect(c.tracker.pending).toMatchObject({ objectId: DRAUGHT, request: InventoryRequest.Merge });
    c.from1999(fail1999(MY_DRAUGHTS, ERR.ActionsLocked));
    expect(c.tracker.pending).toBeNull();
    expect(c.spew).toEqual(["The Health Draughts can't be merged - you're too busy"]);
  });

  it('a vendor transaction the server answers without a VendorInfo (vendor out of view) holds 105 s, not forever', () => {
    const c = client(ERA_1999);
    const p = new BinaryWriter(16); p.writeUInt32(VENDOR); p.writeUInt32(1); p.writeInt32(1); p.writeUInt32(0x80000c01);
    c.send(GameActionType.Buy, p.toBuffer());
    expect(c.tracker.pending).toMatchObject({ objectId: VENDOR, request: InventoryRequest.ShopEvent });
    c.from1999(useDone1999(0x38)); // TryBuyItems: ActionComplete(WERROR_NO_OBJECT) only
    c.advance(105);
    expect(c.tracker.pending).toBeNull();
  });

  it('the logoff deferred behind a stuck request goes out once the watchdog clears it (the same Global_Loop)', () => {
    const c = client(ERA_1999);
    c.pickUp(SCROLL);
    c.advance(60);
    expect(c.tracker.pending).not.toBeNull();
    c.advance(45);
    expect(c.tracker.tick()).toBe(true);
    expect(c.tracker.pending).toBeNull();
  });
});

/* ── a dropped session's request ────────────────────────────────────────── */

describe('a request in flight when the world session ends does not lock the next one (every era)', () => {
  for (const era of [ERA_1999, EOR_ERA_ID, ...DM_ERAS]) {
    it(era, () => {
      const c = client(era);
      c.pickUp(DRAUGHT); // the connection drops before the 0x22 arrives
      expect(c.tracker.pending).not.toBeNull();
      c.tracker.clear(); // teardownWorldState
      expect(c.tracker.pending).toBeNull();
      expect(c.tracker.pendingSnapshot).toBeNull();
      expect(c.use(SCROLL)).toBe(true);
    });
  }
});

/* ── end of retail and Dark Majesty: unchanged ──────────────────────────── */

describe('end of retail and Dark Majesty keep the end-of-retail client: no watchdog, the same clears', () => {
  it('the rules: 105 s for a 1999 world only', () => {
    expect(eraClientRules(eraProfile(ERA_1999)).inventoryRequestWatchdogSeconds).toBe(105);
    for (const id of [EOR_ERA_ID, ...DM_ERAS]) expect(eraClientRules(eraProfile(id)).inventoryRequestWatchdogSeconds).toBeNull();
    expect(eraClientRules(null).inventoryRequestWatchdogSeconds).toBeNull();
  });

  for (const era of [EOR_ERA_ID, ...DM_ERAS]) {
    it(`${era}: an unanswered request stays pending however long (prevRequestTime is never read)`, () => {
      const c = client(era);
      c.pickUp(SCROLL);
      c.advance(1e6);
      expect(c.tracker.tick()).toBe(false);
      expect(c.use(CORPSE)).toBe(false);
      expect(c.spew).toEqual([INVENTORY_REQUEST_PENDING_TEXT]);
    });
  }

  it('ACE: ServerSaysContainId clears a pick-up; InventoryRemoveObject clears a full merge', () => {
    const c = client(EOR_ERA_ID);
    c.pickUp(SCROLL);
    c.fromAce(putEol(SCROLL, PLAYER));
    expect(c.tracker.pending).toBeNull();
    c.send(GameActionType.StackableMerge, buildStackableMergePayload(DRAUGHT, MY_DRAUGHTS, 1));
    c.fromAce(removeEol(DRAUGHT));
    expect(c.tracker.pending).toBeNull();
  });

  it('ACE: a refused transaction (0xA0 in the player\'s name) clears the vendor\'s shop event with no line; VendorInfo clears a completed one', () => {
    const c = client(EOR_ERA_ID);
    const buy = () => { const p = new BinaryWriter(16); p.writeUInt32(VENDOR); p.writeUInt32(1); p.writeInt32(1); p.writeUInt32(0x80000c01); c.send(GameActionType.Buy, p.toBuffer()); };
    buy();
    c.fromAce(failEol(PLAYER, 0));
    expect(c.tracker.pending).toBeNull();
    buy();
    expect(respondToVendorOpen(c.tracker, VENDOR)).toBe(true);
    expect(c.tracker.pending).toBeNull();
    expect(c.spew).toEqual([]);
  });

  it('ACE: a refused pick-up whose item is still listed prints the same line it always did', () => {
    const c = client(EOR_ERA_ID);
    c.pickUp(DRAUGHT);
    c.fromAce(failEol(DRAUGHT, ERR.ObjectGone));
    expect(c.tracker.pending).toBeNull();
    expect(c.spew).toEqual(["The Health Draught can't be put in the container - unable to move to object"]);
  });
});

/* ── the send-time record itself ────────────────────────────────────────── */

describe('InventoryRequestTracker: the send-time record belongs to its request', () => {
  it('cleared with the request, replaced by the next one, and only offered for the pending object', () => {
    const t = new InventoryRequestTracker();
    t.record(SCROLL, InventoryRequest.PickUp, 0, { name: 'Scroll' });
    expect(t.pendingSnapshot).toEqual({ name: 'Scroll' });
    t.record(DRAUGHT, InventoryRequest.PickUp, 0);
    expect(t.pendingSnapshot).toBeNull();
    t.record(DRAUGHT, InventoryRequest.PickUp, 0, { name: 'Health Draught' });
    // A 0xA0 with nothing pending resolves the message's own guid only: no record is borrowed.
    t.respond(DRAUGHT);
    const lines: string[] = [];
    const out = handleAttemptFailed(t, SCROLL, ERR.ObjectGone, () => undefined, (l) => lines.push(l));
    expect(out).toMatchObject({ objectId: 0, cleared: false });
    expect(lines).toEqual([]);
  });

  it('without a clock the watchdog is inert even when configured', () => {
    const t = new InventoryRequestTracker({ watchdogSeconds: 105 });
    t.record(SCROLL, InventoryRequest.PickUp, -1e9);
    expect(t.tick()).toBe(false);
    expect(t.pending).not.toBeNull();
  });
});
