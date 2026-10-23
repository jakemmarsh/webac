/**
 * AUDIT.ac1999-request-completion — a standing check that every request our client can send on a
 * 1999 world comes back to idle, whatever the AC1999 server answers.
 *
 * webac#12 ("You can only move or use one item at a time" for the rest of the session) was client
 * state waiting on a reply the AC1999 server writes differently from ACE. This file is the guard
 * for that whole class:
 *
 *   - ROWS: every client→server message that arms client state, each with EVERY reply sequence
 *     the AC1999 server can produce for it (success, each refusal, busy, out of range, unknown
 *     object, vendor out of view, silence), built as the server writes them (file:line in
 *     docs/ac1999-support.md, "Request completion (1999)"). Each pair runs the request through the
 *     real client gate / trackers and the real Adapter1999 (codecs1999(), ContainOrder included)
 *     → ServerMessageHandler, wired as main.ts wires them, and asserts every waiting state is idle
 *     afterwards: at once, or after the client's own watchdog where the 1999 client itself stays
 *     pending until one (the 105 s inventory watchdog), or after the release retail itself waits
 *     for (the next examine, the panel closing, the mode window).
 *   - NO_WAIT: the messages that arm no client state, with why; sending each must leave everything
 *     idle.
 *   - NOT_SENT: end-of-retail actions the 1999 adapter never puts on the wire.
 *   - A coverage test: every outbound key the 1999 adapter registers is in exactly one table, so a
 *     new verb without an entry fails here.
 *
 * Leaks found and fixed by this audit (the "(the bug)" cases pin the old behaviour's shape):
 *   1. A deleted object never released a pending request unless it was carried (onObjectDelete).
 *      Both retail clients release it for any deleted object (EoL ACCWeenieObject::Remove @ 0058dd20
 *      → ServerSaysMoveItem @ 0058dbb0; 1999 Remove @ 0x004e23e0 → ServerSaysMoveItem @ 0x004e2120 →
 *      ClearRequestIfCurrent @ 0x004e2e30). The AC1999 server answers a full merge of a ground stack
 *      with only the stack's 0xF747 (Monster.cpp MergeItem → CWeenieObject::Remove). Every era.
 *   2. The raise guard (m_bAwaitingRaise) only ended when the XP / credit pools changed. The 1999
 *      client ends it on any stat update (StatsPanel_SetAttribute @ 0x0054a6f0, StatsPanel_SetInt
 *      @ 0x0054a740, the vital / skill fan-outs @ 0x0054a7e0 / 0x0054a840), and the AC1999 server
 *      answers a refused 0x45 with the unchanged 0x26 + 0x0E (ClientEvents.cpp SpendAttributeXP) and
 *      a refused 0x44 / 0x46 / 0x47 with nothing. 1999 only (eraClientRules().raiseAwaitClearsOnStatUpdate);
 *      end of retail and Dark Majesty keep the pools-changed release, pinned below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InventoryRequest, InventoryRequestTracker, OptimisticEquipmentTracker, CombatMode, WeenieError,
  INVENTORY_REQUEST_WATCHDOG_1999_SECONDS, type AttemptFailedObject,
} from '@ac/shared';
import { GameActionType } from '@ac/network';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { registerContainOrder1999, type ContainOrder1999 } from '../packages/network/src/era1999/codecs/ContainOrder1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { BinaryWriter, deserializeMessage, serializeGameAction } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import {
  gateInventoryRequestSend, handleAttemptFailed, recordInventoryRequestFromAction, respondToVendorOpen,
  type InventoryObjectState,
} from '../packages/renderer/src/inventory/InventoryRequests.js';
import { BusyCount, ExamineAwait, InventoryRequestBusy } from '../packages/renderer/src/ui/BusyCount.js';
import { AttackRequestController } from '../packages/renderer/src/controllers/AttackRequest.js';
import {
  UnconfirmedCombatMode, followModeRefusal, castOnceMagicTaken, MODE_REFUSAL_WINDOW_MS,
} from '../packages/renderer/src/controllers/CombatModeChange.js';
import { PingLatencyTracker } from '../packages/renderer/src/network/PingLatencyTracker.js';
import { BookModel } from '../packages/renderer/src/ui/BookModel.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { EOR_ERA_ID, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const ERA_1999 = 'ac1999-retail';
const DM_ERAS = ['classic-dereth', 'classicace-customdm', 'classicace-infiltration'];

const PLAYER = 0x50000003;
const CORPSE = 0x80000a01;
const SCROLL = 0x80000a02; // in the open corpse
const GROUND_STACK = 0x80000a03; // a stack lying on the ground
const MY_STACK = 0x80000b01; // a stack in the main pack
const MY_SWORD = 0x80000b02; // in the main pack
const MY_POTION = 0x80000b03;
const NEW_STACK = 0x80000c01; // a split's new guid (no create seen yet)
const OTHER = 0x80000d01; // another object the server names
const VENDOR = 0x70044012;
const NPC = 0x70044013;
const BOOK = 0x80000e01;
const ENEMY = 0x80000f01;

/** The AC1999 server's WERRORs (GameEnums.h order = ACE's numbers). */
const ERR = {
  None: 0, ActionsLocked: WeenieError.YoureTooBusy, Interrupted: WeenieError.ActionCancelled,
  ObjectGone: WeenieError.ObjectGone, NoObject: WeenieError.NoObject, Stuck: WeenieError.Stuck,
  Overload: WeenieError.YouAreTooEncumbered, Dead: WeenieError.Dead, TooFar: 0x3d,
  GiveNotAllowed: 0x4b4, BeWieldedFailure: 0x3e8, RankTooLow: 0x4ee, Fizzle: 0x402, ExternalActionsLocked: 0x41f,
  OutOfRange: 0x550,
} as const;

/* ── the AC1999 server's messages, as it writes them ───────────────────── */

let seq = 0;
/** SendNetMessage(…, event = TRUE): 0xF7B0 {player, sequence, type, body} (Client.cpp:495-503). */
const ev = (type: number, body: (w: Writer1999) => void = () => {}): Uint8Array => {
  const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(++seq).u32(type);
  body(w);
  return w.toBytes();
};
/** A flat message (event = FALSE). */
const flat = (op: number, body: (w: Writer1999) => void = () => {}): Uint8Array => {
  const w = new Writer1999().u32(op);
  body(w);
  return w.toBytes();
};
const S = {
  /** NotifyInventoryFailedEvent (Player.cpp:1604): 0xA0 {item, error}, event. */
  fail: (item: number, err: number) => ev(0xa0, (w) => w.u32(item).u32(err)),
  /** InventoryMove (ObjectMsgs.cpp:2770): 0x22 {item, container, slot, type}, event. */
  put: (item: number, container: number) => ev(0x22, (w) => w.u32(item).u32(container).u32(0).u32(0)),
  /** InventoryEquip (ObjectMsgs.cpp:2759): 0x23 {item, loc}, event. */
  wield: (item: number, loc: number) => ev(0x23, (w) => w.u32(item).u32(loc)),
  /** InventoryDrop (ObjectMsgs.cpp:2783): 0x19A {item}, event. */
  drop: (item: number) => ev(0x19a, (w) => w.u32(item)),
  /** SetStackSize (WeenieObject.cpp:1570-1590): flat 0x197 {item, stack, value}. */
  stack: (item: number, n: number) => flat(0x197, (w) => w.u32(item).u32(n).u32(n * 10)),
  /** NotifyContainedItemRemoved (WeenieObject.cpp:1592-1605): flat 0x24 {item}. */
  removed: (item: number) => flat(0x24, (w) => w.u32(item)),
  /** ObjectDelete: flat 0xF747 {guid, u16 instance}. */
  deleted: (guid: number) => flat(0xf747, (w) => w.u32(guid).u16(1).u16(0)),
  /** NotifyWeenieError (Player.cpp:1561): flat 0x1C {error}. */
  err: (e: number) => flat(0x1c, (w) => w.u32(e)),
  /** NotifyUseDone (Player.cpp:1546-1559): 0x1C {err} flat when err > 0, then 0x1C7 {0}, event. */
  useDone: (e = 0): Uint8Array[] => [...(e ? [flat(0x1c, (w) => w.u32(e))] : []), ev(0x1c7, (w) => w.u32(0))],
  /** OnContainerOpened (Container.cpp:1128-1132): 0x196 {container, PackableList}, event. */
  viewContents: (container: number) => ev(0x196, (w) => w.u32(container).u32(0)),
  /** Container close (Container.cpp:1185-1188): 0x52 {container}, event. */
  closeContainer: (container: number) => ev(0x52, (w) => w.u32(container)),
  /** SendVendorInventory (Vendor.cpp:613-656): 0x62 {vendor, profile, n = 0}, event. */
  vendorInfo: (vendor: number) => ev(0x62, (w) => w.u32(vendor).u32(0).i32(0).i32(1000).i32(0).f32(1).f32(1).u32(0)),
  /** IdentifyObject (WeenieObject.cpp:893 / 918): 0xC9 {object, flags, success}, event. */
  appraisal: (guid: number, success = 1) => ev(0xc9, (w) => w.u32(guid).u32(0).i32(success)),
  /** NotifyAttackDone (Player.cpp:1436): 0x1A7 {err}, event. */
  attackDone: (e = 0) => ev(0x1a7, (w) => w.u32(e)),
  /** NotifyCommenceAttack (Player.cpp:1444): 0x1B8, event. */
  commence: () => ev(0x1b8),
  /** SendText (WeenieObject.cpp:2443): flat 0xF62C {AcString, u32 type}. */
  text: (t: string) => flat(0xf62c, (w) => w.acString(t).u32(0)),
  /** NotifyAttributeStatUpdated (WeenieObject.cpp:1229): flat 0x26 {player, key, f0, f1, f2}. */
  attribute: (key: number) => flat(0x26, (w) => w.u32(PLAYER).u32(key).u32(10).u32(0).u32(0)),
  /** NotifyAttribute2ndStatUpdated: flat 0x29 {player, key, f0, f1, cp, current}. */
  vital: (key: number) => flat(0x29, (w) => w.u32(PLAYER).u32(key).u32(4).u32(0).u32(0).u32(36)),
  /** NotifiyObjectIntStatUpdated: flat 0x0E {object, key, value} (0x16 = available XP, ClientEvents.cpp SpendAttributeXP). */
  int: (key: number, value: number) => flat(0x0e, (w) => w.u32(PLAYER).u32(key).i32(value)),
  /** ReturnPing (ClientEvents.cpp:775): 0x1EA, event. */
  pong: () => ev(0x1ea),
  /** BookAddPageResponse (Book.cpp:139-161): 0xB6 {book, numPages − 1, 1}, event. */
  addPage: (book: number, page: number, ok = 1) => ev(0xb6, (w) => w.u32(book).i32(page).u32(ok)),
  /** BookPageDataResponse (Book.cpp:68-87): 0xB8 {book, page, PageData}, event. */
  pageData: (book: number, page: number) => ev(0xb8, (w) => w.u32(book).i32(page).u32(PLAYER).acString('Me').acString('acct').i32(1).acString('text')),
};

/* ── the client, wired as main.ts wires it ──────────────────────────────── */

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any;
const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ui: any;

beforeAll(async () => {
  domWindow = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
  installDomGlobals(domWindow, DOM_GLOBALS, saved);
  const mod = await import('../packages/renderer/src/ui/GameUI.js');
  const container = domWindow.document.createElement('div');
  domWindow.document.body.appendChild(container);
  ui = new mod.GameUI(container);
});
afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

interface Item { name: string; pluralName?: string; stackSize?: number }

type Client = ReturnType<typeof client>;

function client(eraId: string) {
  let now = 1000; // seconds
  const rules = eraClientRules(eraProfile(eraId));
  ui.setClientRules(rules);
  ui.statRaiseAwaiting = false;

  const tracker = new InventoryRequestTracker({ watchdogSeconds: rules.inventoryRequestWatchdogSeconds, now: () => now });
  const busy = new BusyCount(() => {});
  const examine = new ExamineAwait(busy);
  const requestBusy = new InventoryRequestBusy(busy, rules.world.inventoryRequestBusy);
  const equip = new OptimisticEquipmentTracker();
  const unconfirmed = new UnconfirmedCombatMode();
  const ping = new PingLatencyTracker(() => now * 1000);
  let pingAwaited = false;
  let combatMode = CombatMode.NonCombat;
  const book = new BookModel({
    playerId: () => PLAYER, playerName: () => 'Me', bookName: () => 'Book',
    pageData: () => {}, addPage: () => {}, modifyPage: () => {}, deletePage: () => {}, bookData: () => {}, notice: () => {},
  });
  book.rules = rules.book;

  const pack = new Map<number, Item>([
    [MY_STACK, { name: 'Pyreal', pluralName: 'Pyreals', stackSize: 20 }],
    [MY_SWORD, { name: 'Sword' }],
    [MY_POTION, { name: 'Health Draught', pluralName: 'Health Draughts', stackSize: 3 }],
  ]);
  const corpse = new Map<number, Item>([[SCROLL, { name: 'Scroll of Flame Bolt' }]]);
  const world = new Map<number, Item>([
    [CORPSE, { name: 'Corpse of Wisp' }], [GROUND_STACK, { name: 'Pyreal', pluralName: 'Pyreals', stackSize: 5 }],
    [VENDOR, { name: 'Shopkeeper' }], [NPC, { name: 'Town Crier' }], [BOOK, { name: 'Book' }], [ENEMY, { name: 'Drudge' }],
  ]);
  const resolve = (g: number): AttemptFailedObject | undefined => pack.get(g) ?? corpse.get(g) ?? world.get(g);
  const stateOf = (g: number): InventoryObjectState => (pack.has(g) || corpse.has(g) ? 'contained' : world.has(g) ? 'in3D' : 'unknown');

  const wire: Uint8Array[] = [];
  const problems: string[] = [];
  const codecs = codecs1999();
  // The client holds a create for every object it acts on: tell the ContainOrder stage so (a real
  // session's creates do), so only a split's NEW guid waits for its create, as live.
  const order: ContainOrder1999 = registerContainOrder1999(codecs, { now: () => now * 1000 });
  const adapter = new Adapter1999(codecs, {
    account: 'acjs',
    log: (m) => { if (/failed to translate|no codec|could not/.test(m)) problems.push(m); },
  });
  {
    // The player module learns our guid from the enter-world request (Player1999).
    const w = new BinaryWriter(32); w.writeUInt32(0xf657); w.writeUInt32(PLAYER); w.writeString16('acjs');
    adapter.outbound(w.toBuffer());
  }
  for (const g of [PLAYER, CORPSE, SCROLL, GROUND_STACK, MY_STACK, MY_SWORD, MY_POTION, OTHER, VENDOR, NPC, BOOK, ENEMY]) {
    const w = new BinaryWriter(8); w.writeUInt32(0xf745); w.writeUInt32(g);
    order.process([w.toBuffer()], { account: 'acjs', log: () => {} });
  }

  let actionSeq = 0;
  /** The 1999 bytes for one end-of-retail GameAction (null: the adapter does not send it). */
  const wireFor = (type: GameActionType, payload: Uint8Array) => adapter.outbound(serializeGameAction(++actionSeq, type, payload));
  /** main.ts sendGameAction: the gate, the send, the busy count, the request record. */
  const send = (type: GameActionType, payload: Uint8Array): boolean => {
    if (!gateInventoryRequestSend(tracker, type, () => {})) return false;
    const out = wireFor(type, payload);
    if (!out) return false;
    for (const o of out) wire.push(o.message);
    busy.noteActionSent(type);
    recordInventoryRequestFromAction(tracker, type, payload, stateOf, now, resolve);
    return true;
  };

  const attack = new AttackRequestController({
    now: () => now, getTarget: () => ENEMY, isAttackable: () => true, inReadyPosition: () => true,
    combatMode: () => 'melee', currentStyle: () => 0, sliderPower: () => 1, autoRepeat: () => false,
    sendAttack: (_mode, target, height, power) => {
      const p = new BinaryWriter(12); p.writeUInt32(target); p.writeUInt32(height === 'high' ? 1 : height === 'medium' ? 2 : 3); p.writeFloat32(power);
      send(GameActionType.TargetedMeleeAttack, p.toBuffer());
    },
    setPowerBarLevel: () => {}, showError: () => {}, sendCancelAttack: () => {}, autoTarget: () => false,
    lastAttacker: () => 0, objectPresent: () => true, selectObject: () => {}, selectNextCompassItem: () => {},
    incrementBusyCount: () => busy.increment(), decrementBusyCount: () => busy.decrement(),
  });

  const h = new ServerMessageHandler();
  h.setHandlers({
    onInventoryPut: (d) => { tracker.respond(d.itemGuid); if (d.containerGuid === PLAYER) { const it = corpse.get(d.itemGuid) ?? world.get(d.itemGuid); if (it) pack.set(d.itemGuid, it); corpse.delete(d.itemGuid); world.delete(d.itemGuid); } },
    onWieldObject: (d) => { tracker.respond(d.itemGuid); equip.confirm(d.itemGuid); },
    onInventoryPutIn3D: (d) => { tracker.respond(d.itemGuid); },
    onInventoryRemove: (d) => { tracker.respond(d.itemGuid); pack.delete(d.itemGuid); corpse.delete(d.itemGuid); },
    onSetStackSize: (d) => { tracker.respond(d.guid); },
    // main.ts onObjectDelete (AUDIT.ac1999-request-completion): any deleted object releases its request.
    onObjectDelete: (d) => { pack.delete(d.guid); corpse.delete(d.guid); world.delete(d.guid); tracker.respond(d.guid); },
    onViewContents: (d) => {
      if (!(tracker.pendingObjectId === d.containerGuid && tracker.pendingRequest === InventoryRequest.PickUp)) tracker.respond(d.containerGuid);
    },
    onCloseGroundContainer: (d) => { if (d.containerGuid === CORPSE) tracker.respond(d.containerGuid); },
    onInventoryServerSaveFailed: (d) => {
      equip.rollback(d.itemGuid, { unequipItem: () => {}, equipItem: () => {} } as never);
      handleAttemptFailed(tracker, d.itemGuid, d.errorType, resolve, () => {});
    },
    onUseDone: () => busy.decrement(),
    onAttackDone: (d) => { tracker.setAttackInProgress(false); attack.handleAttackDone(d.errorType); },
    onCombatCommenceAttack: () => { tracker.setAttackInProgress(true); attack.handleCommenceAttack(); },
    onIdentifyResponse: (d) => examine.appraisalReceived(d.guid),
    onApproachVendor: (d) => { respondToVendorOpen(tracker, d.parsed?.vendorGuid ?? d.vendorGuid); },
    onWeenieError: (d) => {
      followModeRefusal(unconfirmed, d.errorType, now * 1000, { setMode: (m) => { combatMode = m; }, stance: () => 0, setStance: () => {} });
    },
    onPrivateUpdatePropertyInt: (d) => {
      ui.statQualityChanged();
      if (d.key === 40 /* CombatMode */) { combatMode = d.value as CombatMode; unconfirmed.serverMode(); }
    },
    onPrivateUpdatePropertyInt64: () => ui.statQualityChanged(),
    onPrivateUpdateAttribute: () => ui.statQualityChanged(),
    onPrivateUpdateVital: () => ui.statQualityChanged(),
    onPrivateUpdateAttribute2ndLevel: () => ui.statQualityChanged(),
    onPrivateUpdateSkill: () => ui.statQualityChanged(),
    onPingResponse: () => { if (ping.responseReceived()) pingAwaited = false; },
    onBookData: (d) => book.openBook(d.bookGuid, d.maxPages, d.pages, d.inscription, d.inscriptionAuthorId, d.inscriptionAuthor),
    onBookPageData: (d) => book.pageDataResponse(d.bookGuid, d.pageIndex, { authorId: d.authorId, authorName: d.authorName, textIncluded: true, ignoreAuthor: d.ignoreAuthor, pageText: d.pageText }),
    onBookAddPageResponse: (d) => book.addPageResponse(d.bookGuid, d.page, d.success),
  });

  /** Feed the AC1999 server's messages through the real adapter and handler. */
  const from1999 = (...msgs: Array<Uint8Array | Uint8Array[]>) => {
    for (const m of msgs.flat()) {
      const group = new DataView(m.buffer, m.byteOffset).getUint32(0, true) === 0xf7b0 ? 4 : 3;
      for (const out of adapter.inbound(m, group)) h.handleMessage(deserializeMessage(out));
    }
  };
  const fromAce = (...msgs: Uint8Array[]) => { for (const m of msgs) h.handleMessage(deserializeMessage(m)); };

  /** A frame: the 1999 watchdog and its hourglass (main.ts's per-frame tick). */
  const frame = () => { tracker.tick(); requestBusy.update(tracker.pending !== null); };

  /** Every waiting state, by name; idle = {}. */
  const waiting = (): Record<string, unknown> => {
    frame();
    const w: Record<string, unknown> = {};
    if (tracker.pending) w.inventoryRequest = tracker.pending;
    if (tracker.attackInProgress) w.attackInProgress = true;
    if (attack.attackServerResponsePending) w.attackResponsePending = true;
    if (attack.attackInProgress) w.attackControllerInProgress = true;
    if (busy.value) w.busyCount = busy.value;
    if (examine.awaitingId) w.examineAwait = examine.awaitingId;
    for (const g of [MY_SWORD, MY_POTION]) if (equip.hasPending(g)) w.equipPending = g;
    if (book.requestPending) w.bookRequestPending = true;
    if (ui.raiseAwaiting) w.raiseAwaiting = true;
    if (pingAwaited) w.ping = true;
    if (unconfirmed.waiting !== null) w.combatModeUnconfirmed = unconfirmed.waiting;
    return w;
  };

  const u32s = (...v: number[]) => { const p = new BinaryWriter(4 * v.length); for (const x of v) p.writeUInt32(x); return p.toBuffer(); };

  return {
    tracker, busy, examine, attack, book, unconfirmed, equip, wire, problems, adapter,
    send, wireFor, from1999, fromAce, waiting, u32s,
    advance: (s: number) => { now += s; frame(); },
    get combatMode() { return combatMode; },
    closeCorpsePanel: () => corpse.clear(),
    /** gmExaminationUI::RecvNotice_ExamineObject + CM_Item::Event_Appraise. */
    examineObject: (g: number) => { examine.examineObject(g); return send(GameActionType.IdentifyObject, u32s(g)); },
    /** The wield drop: the optimistic equip, then UIAttemptWield's send (main.ts autoWield). */
    wieldFromPack: (g: number) => { equip.recordEquip(g, 0x1 as never, undefined); return send(GameActionType.GetAndWieldItem, u32s(g, 0x1)); },
    /** A raise button click (GameUI's m_bAwaitingRaise), then the raise send. */
    raise: (type: GameActionType, id: number, cost: number) => { ui.statRaiseAwaiting = true; return send(type, u32s(id, cost)); },
    /** sendChangeCombatMode: the unconfirmed change, then the send. */
    changeMode: (mode: CombatMode) => { unconfirmed.sent(combatMode, 0, mode, now * 1000); combatMode = mode; return send(GameActionType.ChangeCombatMode, u32s(mode)); },
    /** The Link Status ping (gmLinkStatusUI::Update). */
    ping: () => { ping.requestSent(); pingAwaited = true; return send(GameActionType.PingRequest, new Uint8Array(0)); },
    /** A melee key press + release a full second later (StartAttackRequest → EndAttackRequest → ExecuteAttack). */
    meleeAttack: () => { attack.setRequestedAttackHeight('medium'); now += 1; attack.endAttackRequest('medium'); },
    /** Open a book of one page and turn to the blank page past it (SetCurPage → BookAddPage). */
    bookAddPage: () => {
      book.openBook(BOOK, 5, [{ authorId: PLAYER, authorName: 'Me', textIncluded: true, ignoreAuthor: false, pageText: 'one' }], '', 0, '');
      book.setCurPage(1);
      return send(GameActionType.BookAddPage, u32s(BOOK));
    },
    /** A page whose text did not come with the book (SetCurPage → BookPageData). */
    bookPageData: () => {
      book.openBook(BOOK, 5, [{ authorId: PLAYER, authorName: 'Me', textIncluded: true, ignoreAuthor: false, pageText: 'one' },
        { authorId: PLAYER, authorName: 'Me', textIncluded: false, ignoreAuthor: false, pageText: '' }], '', 0, '');
      book.setCurPage(1);
      return send(GameActionType.BookPageData, u32s(BOOK, 1));
    },
  };
}

/* ── the table ──────────────────────────────────────────────────────────── */

interface Reply {
  /** What the server did, with its source line (docs/ac1999-support.md has the full list). */
  name: string;
  /** The server's messages, in order. */
  msgs: (c: Client) => Array<Uint8Array | Uint8Array[]>;
  /**
   * What releases the client when the server's messages alone don't, as the 1999 client itself
   * waits for it: the 105 s inventory watchdog, the next examine, the book closing, the mode window.
   */
  then?: (c: Client) => void;
  /** Client-side step between the send and the reply (the player walks off, …). */
  before?: (c: Client) => void;
}

interface Row {
  /** The adapter's outbound key: 'action:0x19' or 'direct:0xf656'. */
  keys: string[];
  name: string;
  /** Sends the request as the client does; the state names it must arm. */
  send: (c: Client) => void;
  arms: string[];
  replies: Reply[];
}

const act = (t: number) => `action:0x${t.toString(16)}`;
const direct = (op: number) => `direct:0x${op.toString(16)}`;
const watchdog = (c: Client) => c.advance(INVENTORY_REQUEST_WATCHDOG_1999_SECONDS);
const payloadBuySell = (c: Client, item: number) => {
  const p = new BinaryWriter(16); p.writeUInt32(VENDOR); p.writeUInt32(1); p.writeInt32(1); p.writeUInt32(item);
  return p.toBuffer();
};

const ROWS: Row[] = [
  {
    keys: [act(GameActionType.PutItemInContainer)], name: 'PutItemInContainer (a corpse item to the main pack)',
    send: (c) => c.send(GameActionType.PutItemInContainer, c.u32s(SCROLL, PLAYER, 0)), arms: ['inventoryRequest'],
    replies: [
      { name: 'success: 0x22 {item, player} (Monster.cpp:848-860)', msgs: () => [S.put(SCROLL, PLAYER)] },
      { name: 'busy: 0xA0 {item, ACTIONS_LOCKED} (Monster.cpp:714-719)', msgs: () => [S.fail(SCROLL, ERR.ActionsLocked)] },
      { name: 'item too far / stuck: 0xA0 {item, TOO_FAR} (Monster.cpp:410-422)', msgs: () => [S.fail(SCROLL, ERR.TooFar)] },
      { name: 'container gone: 0xA0 {container, OBJECT_GONE}, 0xA0 {item, OBJECT_GONE} (Monster.cpp:440-462, 730-737)', msgs: () => [S.fail(PLAYER, ERR.ObjectGone), S.fail(SCROLL, ERR.ObjectGone)] },
      { name: 'overloaded at the end: 0xA0 {item, OVERLOAD} + 0x1C + Cancel 0xA0 {item, 0} (Monster.cpp:747; UseManager.cpp:543)', msgs: () => [S.fail(SCROLL, ERR.Overload), S.err(ERR.Overload), S.fail(SCROLL, 0)] },
      { name: 'the corpse panel closed first (range exit), then the event cancel 0xA0 {item, OBJECT_GONE} (webac#12)', before: (c) => c.closeCorpsePanel(), msgs: () => [S.fail(SCROLL, ERR.ObjectGone)] },
      { name: 'BeginUse while another use runs: 0xA0 naming the OLD target (UseManager.cpp:950-964)', msgs: () => [S.fail(OTHER, ERR.ActionsLocked)] },
      { name: 'busy branch of ExecuteUseEvent: 0x1C + 0x1C7 only, no 0xA0 (WeenieObject.cpp:2747-2768) → the 105 s watchdog', msgs: () => [S.useDone(ERR.ExternalActionsLocked)], then: watchdog },
      { name: 'the item is deleted under the request: 0xF747 {item}', msgs: () => [S.deleted(SCROLL)] },
    ],
  },
  {
    keys: [act(GameActionType.GetAndWieldItem)], name: 'GetAndWieldItem (from the pack)',
    send: (c) => c.wieldFromPack(MY_SWORD), arms: ['inventoryRequest', 'equipPending'],
    replies: [
      { name: 'success: 0x23 {item, loc} (Monster.cpp:1218)', msgs: () => [S.wield(MY_SWORD, 1)] },
      { name: 'requirements / busy / frozen: 0xA0 {item, err} (Monster.cpp:1045-1178)', msgs: () => [S.fail(MY_SWORD, ERR.BeWieldedFailure)] },
      { name: 'wielded, then 0xA0 {item, ACTIVATION_RANK_TOO_LOW} after the 0x23 (Monster.cpp:1300)', msgs: () => [S.wield(MY_SWORD, 1), S.fail(MY_SWORD, ERR.RankTooLow)] },
    ],
  },
  {
    keys: [act(GameActionType.DropItem)], name: 'DropItem (from the pack)',
    send: (c) => c.send(GameActionType.DropItem, c.u32s(MY_SWORD)), arms: ['inventoryRequest'],
    replies: [
      { name: 'success: 0x19A {item} after the animation (Monster.cpp:990-995)', msgs: () => [S.drop(MY_SWORD)] },
      { name: 'refused: 0xA0 {item, err} (Monster.cpp:905-928)', msgs: () => [S.fail(MY_SWORD, ERR.ActionsLocked)] },
      { name: 'fails at completion: 0xA0 {item, err} + Cancel 0xA0 {item, 0} (UseManager.cpp:556-585)', msgs: () => [S.fail(MY_SWORD, ERR.TooFar), S.fail(MY_SWORD, 0)] },
    ],
  },
  {
    keys: [act(GameActionType.StackableMerge)], name: 'StackableMerge',
    send: (c) => c.send(GameActionType.StackableMerge, c.u32s(MY_POTION, MY_STACK, 1)), arms: ['inventoryRequest'],
    replies: [
      { name: 'partial: 0x197 {to}, create(from), 0x197 {from} (Monster.cpp:1477-1488)', msgs: () => [S.stack(MY_STACK, 21), S.stack(MY_POTION, 2)] },
      { name: 'full, a carried source: 0x197 {to}, 0x24 {from} (WeenieObject.cpp:7774-7787)', msgs: () => [S.stack(MY_STACK, 23), S.removed(MY_POTION)] },
      { name: 'in use: 0xA0 {from, OBJECT_GONE} (ClientEvents.cpp:3277-3285)', msgs: () => [S.fail(MY_POTION, ERR.ObjectGone)] },
      { name: 'target lookup fails: 0xA0 naming the TARGET (Monster.cpp:1409)', msgs: () => [S.fail(MY_STACK, ERR.ObjectGone)] },
      { name: 'wrong kind / full: 0xA0 {from, 0} (Monster.cpp:1451-1471)', msgs: () => [S.fail(MY_POTION, 0)] },
    ],
  },
  {
    keys: [], name: 'StackableMerge of a ground stack onto a carried one (leak 1)',
    send: (c) => c.send(GameActionType.StackableMerge, c.u32s(GROUND_STACK, MY_STACK, 5)), arms: ['inventoryRequest'],
    replies: [
      { name: 'full: 0x197 {to}, then only the ground stack\'s 0xF747 (Monster.cpp:1490 → WeenieObject.cpp Remove → NotifyObjectRemoved)', msgs: () => [S.stack(MY_STACK, 25), S.deleted(GROUND_STACK)] },
      { name: 'event cancel: 0xA0 naming the target stack (Monster.cpp:1433-1436)', msgs: () => [S.fail(MY_STACK, ERR.TooFar)] },
    ],
  },
  {
    keys: [act(GameActionType.StackableSplitToContainer)], name: 'StackableSplitToContainer',
    send: (c) => c.send(GameActionType.StackableSplitToContainer, c.u32s(MY_STACK, PLAYER, 0, 5)), arms: ['inventoryRequest'],
    replies: [
      { name: 'success: 0x22 {new}, create(new), 0x197 {item, remaining} (Monster.cpp:1603-1607)', msgs: () => [S.put(NEW_STACK, PLAYER), S.stack(MY_STACK, 15)] },
      { name: 'container lookup fails: 0xA0 {container}, 0xA0 {item} (Monster.cpp:1537-1541)', msgs: () => [S.fail(PLAYER, ERR.ObjectGone), S.fail(MY_STACK, ERR.ObjectGone)] },
      { name: 'amount too big: 0xA0 {item, OBJECT_GONE} (Monster.cpp:1582-1593)', msgs: () => [S.fail(MY_STACK, ERR.ObjectGone)] },
      { name: 'CreateEntity fails: nothing (Monster.cpp:1597-1601) → the 105 s watchdog', msgs: () => [], then: watchdog },
    ],
  },
  {
    keys: [act(GameActionType.StackableSplitTo3D)], name: 'StackableSplitTo3D',
    send: (c) => c.send(GameActionType.StackableSplitTo3D, c.u32s(MY_STACK, 5)), arms: ['inventoryRequest'],
    replies: [
      { name: 'success: 0x22 {new, player}, 0x197 {item}, then 0x19A {new} (Monster.cpp:1683-1693)', msgs: () => [S.put(NEW_STACK, PLAYER), S.stack(MY_STACK, 15), S.drop(NEW_STACK)] },
      { name: 'the follow-up drop refused busy: 0x22 {new}, 0x197 {item}, 0x1C + 0x1C7', msgs: () => [S.put(NEW_STACK, PLAYER), S.stack(MY_STACK, 15)] },
      { name: 'refused: 0xA0 {item, err}', msgs: () => [S.fail(MY_STACK, ERR.ActionsLocked)] },
      { name: 'CreateEntity fails: nothing (Monster.cpp:1676-1680) → the 105 s watchdog', msgs: () => [], then: watchdog },
    ],
  },
  {
    keys: [act(GameActionType.StackableSplitToWield)], name: 'StackableSplitToWield (gated; UIAttemptWield records nothing for a split)',
    send: (c) => c.send(GameActionType.StackableSplitToWield, c.u32s(MY_STACK, 0x100000, 5)), arms: [],
    replies: [
      { name: 'success: 0x23 {new}, create(new), 0x197 {item} (Monster.cpp:1766-1769)', msgs: () => [S.wield(NEW_STACK, 0x100000), S.stack(MY_STACK, 15)] },
      { name: 'fails: 0xA0 {NEW guid, err} (Monster.cpp:1755-1765)', msgs: () => [S.fail(NEW_STACK, ERR.ObjectGone)] },
    ],
  },
  {
    keys: [act(GameActionType.GiveObjectRequest)], name: 'GiveObjectRequest (to an NPC)',
    send: (c) => c.send(GameActionType.GiveObjectRequest, c.u32s(NPC, MY_POTION, 3)), arms: ['inventoryRequest'],
    replies: [
      { name: 'full stack: 0x22 {item, recipient} + text (Monster.cpp:1984-2003)', msgs: () => [S.put(MY_POTION, NPC), S.text('You give Town Crier 3 Health Draughts.')] },
      { name: 'partial stack: only 0x197 {item, remaining} (Monster.cpp:1943, 1993)', msgs: () => [S.stack(MY_POTION, 1)] },
      { name: 'refused: 0xA0 {item, GIVE_NOT_ALLOWED} (Monster.cpp:1818-1928)', msgs: () => [S.fail(MY_POTION, ERR.GiveNotAllowed)] },
      { name: 'event cancel: 0xA0 {item, 0}, then 0xA0 {recipient, err} (UseManager.cpp:814-819, 882)', msgs: () => [S.fail(MY_POTION, 0), S.fail(NPC, ERR.TooFar)] },
      { name: 'recipient busy at start: text + 0x1C + 0x1C7 + 0xA0 {item, 0} (WeenieObject.cpp:2752-2765)', msgs: () => [S.text('Town Crier is busy.'), S.useDone(ERR.ExternalActionsLocked), S.fail(MY_POTION, 0)] },
      { name: 'refuse emote: text + 0xA0 {item, 0} (Monster.cpp:1873-1906)', msgs: () => [S.text('You allow Town Crier to examine your Health Draught.'), S.fail(MY_POTION, 0)] },
    ],
  },
  {
    keys: [act(GameActionType.Buy)], name: 'Buy',
    send: (c) => c.send(GameActionType.Buy, payloadBuySell(c, 0x80000c09)), arms: ['inventoryRequest', 'busyCount'],
    replies: [
      { name: 'success: 0x22 {new} per stack, 0x62 twice, 0x1C7 (Container.cpp:807-810, Vendor.cpp:409, ClientEvents.cpp:1246)', msgs: () => [S.put(NEW_STACK, PLAYER), S.vendorInfo(VENDOR), S.vendorInfo(VENDOR), S.useDone()] },
      { name: 'refused (money, stock, slots): 0x62 + 0x1C {NO_OBJECT} + 0x1C7 (ClientEvents.cpp:1246)', msgs: () => [S.text("You don't have enough money."), S.vendorInfo(VENDOR), S.useDone(ERR.NoObject)] },
      { name: 'vendor out of view: 0x1C {NO_OBJECT} + 0x1C7 only (ClientEvents.cpp:1237-1241) → the 105 s watchdog', msgs: () => [S.useDone(ERR.NoObject)], then: watchdog },
    ],
  },
  {
    keys: [act(GameActionType.Sell)], name: 'Sell',
    send: (c) => c.send(GameActionType.Sell, payloadBuySell(c, MY_SWORD)), arms: ['inventoryRequest', 'busyCount'],
    replies: [
      { name: 'success: 0x24 {item}, coins, 0x62, 0x1C7 (Vendor.cpp:505)', msgs: () => [S.removed(MY_SWORD), S.stack(MY_STACK, 40), S.vendorInfo(VENDOR), S.useDone()] },
      { name: 'all filtered: text + 0x62 + 0x1C7 (no 0x1C)', msgs: () => [S.text("Shopkeeper doesn't know what to do with that."), S.vendorInfo(VENDOR), S.useDone()] },
      { name: 'refused: 0x62 + 0x1C {NO_OBJECT} + 0x1C7', msgs: () => [S.vendorInfo(VENDOR), S.useDone(ERR.NoObject)] },
      { name: 'vendor out of view: 0x1C + 0x1C7 only → the 105 s watchdog', msgs: () => [S.useDone(ERR.NoObject)], then: watchdog },
    ],
  },
  {
    keys: [act(GameActionType.Use)], name: 'Use',
    send: (c) => c.send(GameActionType.Use, c.u32s(CORPSE)), arms: ['busyCount'],
    replies: [
      { name: 'a corpse / chest: creates, 0x196 {container}, 0x1C7 (Container.cpp:1157-1179)', msgs: () => [S.viewContents(CORPSE), S.useDone()] },
      { name: 'the container we have open: 0x52 + 0x1C7 (ClientEvents.cpp:833-839)', msgs: () => [S.closeContainer(CORPSE), S.useDone()] },
      { name: 'open by someone else / locked / busy / out of radius: 0x1C7 only (Container.cpp:1283-1304)', msgs: () => [S.useDone()] },
      { name: 'corpse permission: text + 0x1C7 (Corpse.cpp:35-121)', msgs: () => [S.text('You do not have permission to loot that corpse!'), S.useDone()] },
      { name: 'player busy / not in view: 0x1C + 0x1C7 (ClientEvents.cpp:818-824, 867-870)', msgs: () => [S.useDone(ERR.ActionsLocked)] },
      { name: 'a vendor: 0x62 + 0x1C7 (Vendor.cpp:687-708)', msgs: () => [S.vendorInfo(VENDOR), S.useDone()] },
      { name: 'a pick-up by Use: 0x1C7 at once, 0x22 later (ClientEvents.cpp:855-857)', msgs: () => [S.useDone(), S.put(SCROLL, PLAYER)] },
      { name: 'a house portal with no house: 0x1C7, then 0x1C + 0x1C7 again (House.cpp:1360-1376)', msgs: () => [S.useDone(), S.useDone(ERR.ActionsLocked)] },
    ],
  },
  {
    keys: [act(GameActionType.UseWithTarget)], name: 'UseWithTarget',
    send: (c) => c.send(GameActionType.UseWithTarget, c.u32s(MY_POTION, PLAYER)), arms: ['busyCount'],
    replies: [
      { name: 'success / most refusals: … + 0x1C7 (Healer.cpp, Lockpick.cpp, UseManager.cpp)', msgs: () => [S.useDone()] },
      { name: 'source or target not in view: 0x1C7 only (ClientEvents.cpp:806-809)', msgs: () => [S.useDone()] },
      { name: 'source == target: 0xA0 {source, 0} + 0x1C7 (WeenieObject.cpp:6183-6192)', msgs: () => [S.fail(MY_POTION, 0), S.useDone()] },
      { name: 'refused: 0x1C {err} + 0x1C7', msgs: () => [S.useDone(ERR.ActionsLocked)] },
    ],
  },
  {
    keys: [act(GameActionType.CastUntargetedSpell), act(GameActionType.CastTargetedSpell)], name: 'CastTargetedSpell / CastUntargetedSpell',
    send: (c) => c.send(GameActionType.CastTargetedSpell, c.u32s(ENEMY, 27)), arms: ['busyCount'],
    replies: [
      { name: 'launched: 0x1C7 (SpellcastingManager.cpp:41-62)', msgs: () => [S.useDone()] },
      { name: 'TryBeginCast refusal (unlearned, components, mana, busy): 0x1C + 0x1C7', msgs: () => [S.useDone(ERR.ActionsLocked)] },
      { name: 'fizzle: 0x1C {MAGIC_FIZZLE} + 0x1C7 (SpellcastingManager.cpp:1080)', msgs: () => [S.useDone(ERR.Fizzle)] },
      { name: 'out of range at launch: text + 0x1C + 0x1C7 (SpellcastingManager.cpp:1031-1045)', msgs: () => [S.text('That target is too far away!'), S.useDone(ERR.OutOfRange)] },
      { name: 'moved too far: two texts + 0x1C7 (SpellcastingManager.cpp:1061-1067)', msgs: () => [S.text('Your movement disrupted spell casting!'), S.text('Your movement disrupted spell casting!'), S.useDone()] },
      { name: 'timeout then peace: two 0x1C7 in one tick (SpellcastingManager.cpp:2264-2279)', msgs: () => [S.useDone(0x0b), S.useDone()] },
    ],
  },
  {
    keys: [act(GameActionType.ResearchSpell)], name: 'ResearchSpell (1999 only)',
    send: (c) => c.send(GameActionType.ResearchSpell, c.u32s(1, 2, 3, 0, 0, 0, 0, 0, ENEMY)), arms: ['busyCount'],
    replies: [
      { name: 'not a formula: text + 0x1C + 0x1C7 (ClientEvents.cpp:2890-2898)', msgs: () => [S.text('That is not a valid spell formula.'), S.useDone(0x430)] },
      { name: 'BeginResearchCast refusal: 0x1C + 0x1C7 (ClientEvents.cpp:2908-2916)', msgs: () => [S.useDone(ERR.ActionsLocked)] },
      { name: 'no match: fizzle 0x1C + 0x1C7; matched: … + 0x1C7 (SpellcastingManager.cpp:310-334)', msgs: () => [S.useDone(ERR.Fizzle)] },
    ],
  },
  {
    keys: [act(GameActionType.IdentifyObject)], name: 'IdentifyObject (examine)',
    send: (c) => c.examineObject(ENEMY), arms: ['examineAwait', 'busyCount'],
    replies: [
      { name: 'found: 0xC9 {target, success} (WeenieObject.cpp:918)', msgs: () => [S.appraisal(ENEMY)] },
      { name: 'appraisal failed: 0xC9 {target, 0} (WeenieObject.cpp:893)', msgs: () => [S.appraisal(ENEMY, 0)] },
      {
        name: 'unknown guid: nothing (ClientEvents.cpp:900-916); the 1999 client waits too (ExaminePanel_ExamineObject @ 0x005096d0) until the next examine is answered',
        msgs: () => [], then: (c) => { c.examineObject(NPC); c.from1999(S.appraisal(NPC)); },
      },
    ],
  },
  {
    keys: [act(GameActionType.TargetedMeleeAttack), act(GameActionType.TargetedMissileAttack)], name: 'TargetedMelee / MissileAttack',
    send: (c) => c.meleeAttack(), arms: ['attackResponsePending'],
    replies: [
      { name: 'one swing, no 0x1B8 for the first: 0x1A7 {0} (AttackManager.cpp:101-111)', msgs: () => [S.attackDone()] },
      { name: 'dead / busy / bad timing: 0x1A7 {err} (Monster.cpp:3454-3499)', msgs: () => [S.attackDone(ERR.Dead)] },
      { name: 'target gone / out of reach after the chase: 0x1A7 {OBJECT_GONE / TOO_FAR} (AttackEventData.cpp:296-305)', msgs: () => [S.attackDone(ERR.ObjectGone)] },
      { name: 'repeat: 0x1A7 {0}, 0x1B8, 0x1A7 {0} (AttackEventData.cpp:54-62)', msgs: () => [S.attackDone(), S.commence(), S.attackDone()] },
      { name: 'missile out of range: 0x1A7 {0} + 0x1C, the shot, 0x1A7 again (MissileAttackEventData.cpp:87-95)', msgs: () => [S.attackDone(), S.err(ERR.OutOfRange), S.attackDone()] },
      { name: 'a 0x1B8 then a teleport / death / timeout: 0x1A7 {0} (WeenieObject.cpp:578, 7494; AttackEventData.cpp:191-209)', msgs: () => [S.attackDone(), S.commence(), S.attackDone(ERR.Interrupted)] },
    ],
  },
  {
    keys: [act(GameActionType.RaiseAttribute)], name: 'RaiseAttribute',
    send: (c) => c.raise(GameActionType.RaiseAttribute, 1, 110), arms: ['raiseAwaiting'],
    replies: [
      { name: 'applied: 0x26 + 0x0E {avail XP} (ClientEvents.cpp SpendAttributeXP)', msgs: () => [S.attribute(1), S.int(0x16, 890)] },
      { name: 'refused: the UNCHANGED 0x26 + 0x0E (leak 2)', msgs: () => [S.attribute(1), S.int(0x16, 1000)] },
    ],
  },
  {
    keys: [act(GameActionType.RaiseVital), act(GameActionType.RaiseSkill), act(GameActionType.TrainSkill)], name: 'RaiseVital / RaiseSkill / TrainSkill',
    send: (c) => c.raise(GameActionType.RaiseVital, 1, 50), arms: ['raiseAwaiting'],
    replies: [
      { name: 'applied: 0x29 / 0x28 + 0x0E (ClientEvents.cpp:1000-1115)', msgs: () => [S.vital(1), S.int(0x16, 950)] },
      { name: 'refused: nothing at all (ClientEvents.cpp:1010-1020, 1055-1066, 1096-1115); the next stat update releases it, as in 1999 (leak 2)', msgs: () => [S.vital(2)] },
    ],
  },
  {
    keys: [act(GameActionType.ChangeCombatMode)], name: 'ChangeCombatMode',
    send: (c) => c.changeMode(CombatMode.Melee), arms: ['combatModeUnconfirmed'],
    replies: [
      { name: 'taken, mode differs from the request: 0x0E {COMBAT_MODE} (Monster.cpp:2966-3008)', msgs: () => [S.int(40, CombatMode.Melee)] },
      { name: 'refused: 0x1C {WERROR_INTERRUPTED} (Player.cpp:4318)', msgs: () => [S.err(ERR.Interrupted)] },
      {
        name: 'taken by stance only, or a no-op: nothing that names the mode; the cast gate stops waiting after MODE_REFUSAL_WINDOW_MS (castOnceMagicTaken)',
        msgs: () => [],
        then: (c) => {
          let cast = false;
          const queue: Array<() => void> = [];
          castOnceMagicTaken({ mode: () => CombatMode.Magic, waiting: () => CombatMode.Magic, schedule: (fn) => queue.push(fn), cast: () => { cast = true; }, suppressed: () => {} });
          while (queue.length) queue.shift()!();
          expect(cast).toBe(true); // the only reader of `waiting`, bounded
          c.unconfirmed.clear(); // nothing else reads it: the next change re-arms it (UnconfirmedCombatMode.sent)
        },
      },
    ],
  },
  {
    keys: [act(GameActionType.PingRequest)], name: 'Ping',
    send: (c) => c.ping(), arms: ['ping'],
    replies: [{ name: 'always 0x1EA (ClientEvents.cpp:775)', msgs: () => [S.pong()] }],
  },
  {
    keys: [act(GameActionType.BookAddPage)], name: 'BookAddPage',
    send: (c) => c.bookAddPage(), arms: ['bookRequestPending'],
    replies: [
      { name: 'added: 0xB6 {book, numPages − 1, 1} (Book.cpp:139-161)', msgs: () => [S.addPage(BOOK, 1)] },
      { name: 'the book is gone: nothing (Book.cpp); the panel closes on range (gmBookUI)', msgs: () => [], then: (c) => c.book.closeBook() },
    ],
  },
  {
    keys: [act(GameActionType.BookPageData)], name: 'BookPageData',
    send: (c) => c.bookPageData(), arms: ['bookRequestPending'],
    replies: [
      { name: 'the page: 0xB8 {book, page, PageData} (Book.cpp:68-87)', msgs: () => [S.pageData(BOOK, 1)] },
      { name: 'the book or page is gone: nothing; the panel closes', msgs: () => [], then: (c) => c.book.closeBook() },
    ],
  },
];

/** Sent with no client state waiting on the answer (the reply only updates what it names). */
const NO_WAIT: Record<string, string> = {
  [act(GameActionType.SetSingleCharacterOption)]: 'no reply but the channel-join text (ClientEvents.cpp:2042)',
  [act(GameActionType.Talk)]: 'chat: 0x37 to the area, or nothing',
  [act(GameActionType.AddFriend)]: '0xF7CD friends: texts only',
  [act(GameActionType.RemoveAllFriends)]: '0xF7CD friends: texts only',
  [act(GameActionType.SwearAllegiance)]: '0x20 + 0x1C8 (always, but nothing waits: gmAllegianceUI m_bAwaitingUpdate is not ported)',
  [act(GameActionType.BreakAllegiance)]: '0x20 + 0x1C8 + texts; nothing waits',
  [act(GameActionType.AllegianceUpdateRequest)]: '0x20 + 0x1C8 on the next tick; nothing waits',
  [act(GameActionType.TalkDirect)]: 'tell by guid: echo or nothing',
  [act(GameActionType.Tell)]: 'tell: echo, or nothing for an unknown name',
  [act(GameActionType.ModifyCharacterSquelch)]: '0x5A / 0x5B or "Player not found."; the squelch list follows the server',
  [act(GameActionType.Suicide)]: '@lifestone: death sequence or 0x1C',
  [act(GameActionType.LoginComplete)]: 'no ack (ExitPortal); TeleportBusy ends on the client\'s own fade',
  [act(GameActionType.FellowshipCreate)]: '0xAF, or nothing when already fellowed; no pending state',
  [act(GameActionType.FellowshipQuit)]: '0xA7 + 0xAF, or nothing',
  [act(GameActionType.FellowshipDismiss)]: '0xB1 + 0xAF, 0x1C, or nothing',
  [act(GameActionType.FellowshipRecruit)]: '0xAF / 0xB0, 0x1C, text, or nothing',
  [act(GameActionType.FellowshipUpdateRequest)]: 'never answered (FellowshipManager.cpp:810-817); nothing waits',
  [act(GameActionType.BookData)]: '0xB4 opens the book; sent after a refused add page, whose requestPending the open clears',
  [act(GameActionType.BookModifyPage)]: '0xB5 {success}: logged only',
  [act(GameActionType.BookDeletePage)]: '0xB7 {success}: logged only',
  [act(GameActionType.SetInscription)]: 'never answered (ClientEvents.cpp:1185-1226)',
  [act(GameActionType.AdvocateTeleport)]: 'admin: a teleport or nothing',
  [act(GameActionType.AbuseLogRequest)]: 'empty case (ClientEvents.cpp:3757-3797); the UI no longer sends it',
  [act(GameActionType.AddChannel)]: 'empty case',
  [act(GameActionType.RemoveChannel)]: 'empty case',
  [act(GameActionType.ChatChannel)]: '0x14A to the channel, or nothing',
  [act(GameActionType.ListChannels)]: 'empty case',
  [act(GameActionType.IndexChannels)]: 'empty case',
  [act(GameActionType.NoLongerViewingContents)]: 'never answered (Container.cpp:1495-1501)',
  [act(GameActionType.AddShortCut)]: 'no reply',
  [act(GameActionType.RemoveShortCut)]: 'no reply',
  [act(GameActionType.SetCharacterOptions)]: 'no reply',
  [act(GameActionType.RemoveSpellC2S)]: '0x4D + text, or a text, or nothing',
  [act(GameActionType.CancelAttack)]: 'ends the attack with its 0x1A7 (or nothing in magic mode / with none running); the attack row covers the 0x1A7',
  [act(GameActionType.QueryHealth)]: '0x1C0 only for a creature in view; nothing waits (the heart meter shows on arrival)',
  [act(GameActionType.QueryAge)]: '0xF62C text',
  [act(GameActionType.QueryBirth)]: '0xF62C text',
  [act(GameActionType.Emote)]: '0x1E0 to the area',
  [act(GameActionType.SoulEmote)]: '0x1E2 to the area',
  [act(GameActionType.AddSpellFavorite)]: 'no reply',
  [act(GameActionType.RemoveSpellFavorite)]: 'no reply',
  [act(GameActionType.QueryItemMana)]: '0x264 or 0xA0 / nothing; not an inventory request (classifyInventoryRequest records nothing)',
  [act(GameActionType.MoveToState)]: 'no ack (Animation_Update, a force-position snap at ≥ 10 m)',
  [act(GameActionType.AutonomousPosition)]: 'no ack',
  [act(GameActionType.Jump)]: 'no ack (Movement_UpdateVector)',
  [direct(0xf656)]: 'pre-world: CharacterCreate → 0xF643 on every path but a framing mismatch; GameUI\'s FINISH has its own CHARGEN_REPLY_TIMEOUT_MS',
  [direct(0xf7c8)]: 'pre-world: 0xF7C7',
  [direct(0xf657)]: 'pre-world: the login stream or 0xF659; the connecting screen has its own timeout',
  [direct(0xf655)]: 'pre-world: 0xF655 + the list, or nothing for a bad slot; no client state waits',
  [direct(0xf653)]: 'logoff: 0xF653 after ~5 s; LogOffRequest is a client timer',
  [direct(0xf7cd)]: '/friends: 0xF62C texts',
};

/** End-of-retail actions the 1999 adapter never puts on the wire. */
const NOT_SENT: Record<string, string> = {
  [act(GameActionType.RemoveFriend)]: '1999 removes friends by name (0xF7CD)',
  [act(GameActionType.TeleToLifestone)]: '0x63 is the 1999 @lifestone suicide; recall was a spell (Suicide sends it)',
  [act(GameActionType.SetDesiredComponentLevel)]: 'no 1999 builder',
  [act(GameActionType.SpellbookFilter)]: 'no 1999 builder',
  [act(GameActionType.DoMovementCommand)]: 'the AC1999 server reads none',
  [act(GameActionType.TurnTo)]: 'the AC1999 server reads none',
  [act(GameActionType.StopMovementCommand)]: 'the AC1999 server reads none',
  [act(GameActionType.AutonomyLevel)]: 'the AC1999 server reads none',
};

/* ── the tests ──────────────────────────────────────────────────────────── */

describe('every 1999 outbound message is in the audit table', () => {
  it('each key the 1999 adapter registers appears in exactly one of ROWS / NO_WAIT / NOT_SENT', () => {
    const c = codecs1999();
    const registered = [...[...c.outbound.keys()].map(direct), ...[...c.outboundAction.keys()].map(act)].sort();
    const rowKeys = ROWS.flatMap((r) => r.keys);
    const listed = [...rowKeys, ...Object.keys(NO_WAIT), ...Object.keys(NOT_SENT)];
    const missing = registered.filter((k) => !listed.includes(k));
    expect(missing, 'a 1999 verb with no request-completion entry: add it to ROWS (with every reply the AC1999 server writes) or NO_WAIT').toEqual([]);
    expect(listed.filter((k) => !registered.includes(k)), 'an entry for a key the adapter no longer registers').toEqual([]);
    expect(new Set(listed).size, 'a key listed twice').toBe(listed.length);
  });

  it('NOT_SENT: the adapter puts none of them on the wire', () => {
    const c = client(ERA_1999);
    for (const key of Object.keys(NOT_SENT)) {
      const type = Number(key.slice('action:'.length));
      expect(c.wireFor(type, new Uint8Array(64)), key).toBeNull();
    }
  });

  it('NO_WAIT: each goes out and arms no waiting state', () => {
    const c = client(ERA_1999);
    // Jump needs a position first (Movement1999): a MoveToState carries one.
    c.send(GameActionType.MoveToState, new Uint8Array(64));
    for (const key of Object.keys(NO_WAIT).filter((k) => k.startsWith('action:'))) {
      const type = Number(key.slice('action:'.length));
      const payload = new Uint8Array(64);
      expect(c.send(type, payload), `${key} translates`).toBe(true);
      expect(c.waiting(), key).toEqual({});
    }
    expect(c.problems).toEqual([]);
  });
});

describe('every (request, AC1999 reply) pair returns the client to idle', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      for (const reply of row.replies) {
        it(reply.name, () => {
          const c = client(ERA_1999);
          row.send(c);
          const armed = c.waiting();
          for (const s of row.arms) expect(armed, `the send arms ${s}`).toHaveProperty(s);
          reply.before?.(c);
          c.from1999(...reply.msgs(c));
          reply.then?.(c);
          expect(c.waiting()).toEqual({});
          expect(c.problems, 'every server message translated').toEqual([]);
        });
      }
    });
  }
});

describe('end of retail and Dark Majesty keep their releases', () => {
  it('the rules: the any-stat release is 1999\'s only', () => {
    expect(eraClientRules(eraProfile(ERA_1999)).raiseAwaitClearsOnStatUpdate).toBe(true);
    for (const id of [EOR_ERA_ID, ...DM_ERAS]) expect(eraClientRules(eraProfile(id)).raiseAwaitClearsOnStatUpdate).toBe(false);
    expect(eraClientRules(null).raiseAwaitClearsOnStatUpdate).toBe(false);
  });

  for (const era of [EOR_ERA_ID, ...DM_ERAS]) {
    it(`${era}: a stat update leaves the raise guard to the pools-changed release`, () => {
      client(era);
      ui.statRaiseAwaiting = true;
      ui.statQualityChanged();
      expect(ui.raiseAwaiting).toBe(true);
      ui.statRaiseAwaiting = false;
    });

    it(`${era}: a deleted object releases its pending request (ObjectBeingDeleted → Remove → ServerSaysMoveItem, as in retail)`, () => {
      const c = client(era);
      c.send(GameActionType.PutItemInContainer, c.u32s(GROUND_STACK, PLAYER, 0));
      expect(c.tracker.pending).toMatchObject({ objectId: GROUND_STACK, request: InventoryRequest.PickUp });
      const w = new BinaryWriter(8); w.writeUInt32(0xf747); w.writeUInt32(GROUND_STACK); w.writeUInt16(1);
      c.fromAce(w.toBuffer());
      expect(c.tracker.pending).toBeNull();
    });

    it(`${era}: a delete of another object leaves the pending request alone`, () => {
      const c = client(era);
      c.send(GameActionType.PutItemInContainer, c.u32s(GROUND_STACK, PLAYER, 0));
      const w = new BinaryWriter(8); w.writeUInt32(0xf747); w.writeUInt32(OTHER); w.writeUInt16(1);
      c.fromAce(w.toBuffer());
      expect(c.tracker.pending).toMatchObject({ objectId: GROUND_STACK });
    });
  }
});
