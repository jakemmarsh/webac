/**
 * CORE.17.k.c.a.a — ACCWeenieObject::IsPlayerReadyToMakeInventoryRequest(int quiet)
 * @ 0058d050 gates every inventory request and every use BEFORE it is sent:
 * a pending request (prevRequest != IR_NONE) refuses with the 0x1a line
 * "You can only move or use one item at a time", an attack in progress
 * (ACCWeenieObject::attackInProgress, set by HandleCommenceAttackEvent
 * @ 0056ad20 and cleared by HandleAttackDoneEvent @ 0056c500) with "You cannot
 * move or use an item while attacking"; quiet callers (the drag-hover
 * legality, IsDragIntoContainerAttemptLegal @ 00587e90) get the verdict with no
 * line. The seven UIAttempt* (@ 0058d590–0058d850) and ItemHolder::UseObject
 * @ 00588a80 call it with quiet = 0, so a refusal prints once and sends nothing.
 *
 * Ground truth: the decompiled EoL client + the acclient.exe .rdata literals
 * (pinned below when the reference is present). Real modules throughout.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  InventoryRequest, InventoryRequestTracker,
  INVENTORY_REQUEST_PENDING_TEXT, INVENTORY_REQUEST_ATTACKING_TEXT, inventoryRequestRefusalText,
} from '@ac/shared';
import { GameActionType } from '@ac/network';
import {
  GATED_INVENTORY_ACTIONS, isGatedInventoryAction, gateInventoryRequestSend,
} from '../packages/renderer/src/inventory/InventoryRequests.js';

const REPO = resolve(__dirname, '..');
const EXE = resolve(REPO, 'reference/client-eol/acclient.exe');

const recorder = () => { const lines: string[] = []; return { lines, display: (t: string) => { lines.push(t); } }; };

/* ── the gate itself ─────────────────────────────────────────────────────── */

describe('CORE.17.k.c.a.a — IsPlayerReadyToMakeInventoryRequest on the tracker', () => {
  it('a fresh tracker is ready: no refusal, no line', () => {
    const t = new InventoryRequestTracker();
    const r = recorder();
    expect(t.refusal()).toBeNull();
    expect(t.isPlayerReadyToMakeInventoryRequest(false, r.display)).toBe(true);
    expect(r.lines).toEqual([]);
    expect(t.attackInProgress).toBe(false);
  });

  it('a pending request refuses with "You can only move or use one item at a time" — once per ask, and not when quiet', () => {
    const t = new InventoryRequestTracker();
    t.record(0x80001234, InventoryRequest.PickUp, 10);
    const r = recorder();
    expect(t.refusal()).toBe('pending');
    expect(t.isPlayerReadyToMakeInventoryRequest(false, r.display)).toBe(false);
    expect(r.lines).toEqual(['You can only move or use one item at a time']);
    expect(t.isPlayerReadyToMakeInventoryRequest(true, r.display)).toBe(false);
    expect(r.lines).toHaveLength(1);
    // the pending request is untouched by the ask
    expect(t.pending).toEqual({ objectId: 0x80001234, request: InventoryRequest.PickUp, time: 10 });
  });

  it('the server\'s answer for the pending object (RecordResponse / ServerSaysMoveItem\'s id-matched clear) makes it ready again — an answer for another object does not', () => {
    const t = new InventoryRequestTracker();
    t.record(0x80001234, InventoryRequest.Drop);
    expect(t.respond(0x80009999)).toBe(false);
    expect(t.refusal()).toBe('pending');
    expect(t.respond(0x80001234)).toBe(true);
    expect(t.refusal()).toBeNull();
    expect(t.isPlayerReadyToMakeInventoryRequest(false, recorder().display)).toBe(true);
  });

  it('an attack in progress refuses with "You cannot move or use an item while attacking" until AttackDone clears it', () => {
    const t = new InventoryRequestTracker();
    t.setAttackInProgress(true); // HandleCommenceAttackEvent
    const r = recorder();
    expect(t.attackInProgress).toBe(true);
    expect(t.refusal()).toBe('attacking');
    expect(t.isPlayerReadyToMakeInventoryRequest(false, r.display)).toBe(false);
    expect(r.lines).toEqual(['You cannot move or use an item while attacking']);
    expect(t.isPlayerReadyToMakeInventoryRequest(true, r.display)).toBe(false);
    expect(r.lines).toHaveLength(1);
    t.setAttackInProgress(false); // HandleAttackDoneEvent, any code
    expect(t.refusal()).toBeNull();
    expect(t.isPlayerReadyToMakeInventoryRequest(false, r.display)).toBe(true);
    expect(r.lines).toHaveLength(1);
  });

  it('the pending test comes first: pending + attacking prints the "one item at a time" line', () => {
    const t = new InventoryRequestTracker();
    t.setAttackInProgress(true);
    t.record(0x80001234, InventoryRequest.Wield);
    const r = recorder();
    expect(t.refusal()).toBe('pending');
    expect(t.isPlayerReadyToMakeInventoryRequest(false, r.display)).toBe(false);
    expect(r.lines).toEqual([INVENTORY_REQUEST_PENDING_TEXT]);
    t.respond(0x80001234);
    expect(t.refusal()).toBe('attacking');
  });

  it('ClientCombatSystem::Begin\'s reset (resetAttack) drops the attack flag and nothing else', () => {
    const t = new InventoryRequestTracker();
    t.setAttackInProgress(true);
    t.record(0x80000001, InventoryRequest.Merge);
    t.resetAttack();
    expect(t.attackInProgress).toBe(false);
    expect(t.pendingRequest).toBe(InventoryRequest.Merge);
  });

  it('the refusal texts are the two .rdata literals', () => {
    expect(inventoryRequestRefusalText('pending')).toBe(INVENTORY_REQUEST_PENDING_TEXT);
    expect(inventoryRequestRefusalText('attacking')).toBe(INVENTORY_REQUEST_ATTACKING_TEXT);
    expect(INVENTORY_REQUEST_PENDING_TEXT).toBe('You can only move or use one item at a time');
    expect(INVENTORY_REQUEST_ATTACKING_TEXT).toBe('You cannot move or use an item while attacking');
  });
});

/* ── which GameActions ask ───────────────────────────────────────────────── */

const GATED: GameActionType[] = [
  GameActionType.StackableMerge, GameActionType.StackableSplitToContainer, GameActionType.StackableSplitTo3D,
  GameActionType.StackableSplitToWield, GameActionType.DropItem, GameActionType.PutItemInContainer,
  GameActionType.GetAndWieldItem, GameActionType.GiveObjectRequest, GameActionType.Use, GameActionType.UseWithTarget,
];
const NOT_GATED: GameActionType[] = [
  GameActionType.PingRequest, GameActionType.IdentifyObject, GameActionType.TalkDirect, GameActionType.AddToTrade,
  GameActionType.SetAfkMode, GameActionType.ChangeCombatMode, GameActionType.CastUntargetedSpell,
];

describe('CORE.17.k.c.a.a — the gated GameActions are the UIAttempt* sends and UseObject\'s uses', () => {
  it('exactly the seven UIAttempt* wire actions (with UIAttemptWield\'s split branch) plus Use / UseWithTarget', () => {
    expect(GATED_INVENTORY_ACTIONS.size).toBe(10);
    for (const a of GATED) expect(isGatedInventoryAction(a), GameActionType[a]).toBe(true);
    for (const a of NOT_GATED) expect(isGatedInventoryAction(a), GameActionType[a]).toBe(false);
  });

  it('while a request is pending every gated action is refused with one line each and non-inventory actions pass silently', () => {
    const t = new InventoryRequestTracker();
    t.record(0x80001234, InventoryRequest.PutInContainer);
    const r = recorder();
    for (const a of GATED) expect(gateInventoryRequestSend(t, a, r.display), GameActionType[a]).toBe(false);
    expect(r.lines).toEqual(GATED.map(() => INVENTORY_REQUEST_PENDING_TEXT));
    for (const a of NOT_GATED) expect(gateInventoryRequestSend(t, a, r.display), GameActionType[a]).toBe(true);
    expect(r.lines).toHaveLength(GATED.length);
  });

  it('during an attack the same set is refused with the attacking line', () => {
    const t = new InventoryRequestTracker();
    t.setAttackInProgress(true);
    const r = recorder();
    expect(gateInventoryRequestSend(t, GameActionType.Use, r.display)).toBe(false);
    expect(gateInventoryRequestSend(t, GameActionType.DropItem, r.display)).toBe(false);
    expect(gateInventoryRequestSend(t, GameActionType.TalkDirect, r.display)).toBe(true);
    expect(r.lines).toEqual([INVENTORY_REQUEST_ATTACKING_TEXT, INVENTORY_REQUEST_ATTACKING_TEXT]);
  });

  it('idle: everything passes with no line', () => {
    const t = new InventoryRequestTracker();
    const r = recorder();
    for (const a of [...GATED, ...NOT_GATED]) expect(gateInventoryRequestSend(t, a, r.display)).toBe(true);
    expect(r.lines).toEqual([]);
  });

  it('the retail sequence: send (record) → a second attempt refused → the answer clears → the next attempt passes', () => {
    const t = new InventoryRequestTracker();
    const r = recorder();
    expect(gateInventoryRequestSend(t, GameActionType.PutItemInContainer, r.display)).toBe(true);
    t.record(0x80001234, InventoryRequest.PickUp); // the UIAttempt* record after Event_*
    expect(gateInventoryRequestSend(t, GameActionType.DropItem, r.display)).toBe(false);
    expect(gateInventoryRequestSend(t, GameActionType.Use, r.display)).toBe(false);
    expect(r.lines).toHaveLength(2);
    t.respond(0x80001234); // 0x0022 ServerSaysContainID / 0x0024 remove / 0x00A0
    expect(gateInventoryRequestSend(t, GameActionType.DropItem, r.display)).toBe(true);
    expect(r.lines).toHaveLength(2);
  });
});

/* ── acclient.exe: the two literals ─────────────────────────────────────── */

describe.skipIf(!existsSync(EXE))('CORE.17.k.c.a.a — the two refusal lines are acclient.exe\'s UTF-16 .rdata literals', () => {
  let hay: string;
  const RDATA_OFF = 0x392000;
  beforeAll(() => { hay = readFileSync(EXE).subarray(RDATA_OFF, RDATA_OFF + 0x773a6).toString('utf16le'); });

  it('"You can only move or use one item at a time" and "You cannot move or use an item while attacking"', () => {
    expect(hay).toContain(INVENTORY_REQUEST_PENDING_TEXT);
    expect(hay).toContain(INVENTORY_REQUEST_ATTACKING_TEXT);
  });
});
