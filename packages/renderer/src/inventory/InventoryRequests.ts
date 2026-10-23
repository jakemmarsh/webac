/**
 * InventoryRequests — record the client's one pending inventory request as
 * retail's UIAttempt* entry points do, and port
 * ACCWeenieObject::ServerSaysAttemptFailed @ 0058eae0's own 0x1a line for the
 * 0x00A0 InventoryServerSaveFailed event (CORE.17.k.c.a).
 *
 * The tracker, the verb / suffix tables and the text composition live in
 * @ac/shared (InventoryRequest.ts, with the decomp citations); this module is
 * the renderer wiring: which GameAction records which request kind (by the
 * object's position state, as UIAttemptPutIn3D / UIAttemptPutInContainer
 * branch on `current_state == IN_3D_VIEW`; a vendor Buy / Sell records
 * IR_SHOP_EVENT on the VENDOR — CORE.17.k.c.a.a.b), the dispatch's object
 * choice + line + clear for a failure, and gmVendorUI::OpenVendor's clear.
 */
import {
  InventoryRequest,
  InventoryRequestTracker,
  attemptFailedText,
  type AttemptFailedObject,
} from '@ac/shared';
import { GameActionType } from '@ac/network';

/** Where the object sits from the client's point of view (ACCWeenieObject::current_state). */
export type InventoryObjectState = 'in3D' | 'contained' | 'unknown';

export interface RecordedInventoryRequest {
  readonly objectId: number;
  readonly request: InventoryRequest;
}

function u32(payload: Uint8Array, offset: number): number {
  if (payload.byteLength < offset + 4) return 0;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset, true);
}

/**
 * The request a sent GameAction records — the eight UIAttempt* arms:
 *   StackableMerge → IR_MERGE (UIAttemptMerge @ 0058d770)
 *   StackableSplitToContainer / StackableSplitTo3D → IR_SPLIT (@ 0058d7d0 / 0058d850)
 *   DropItem → IR_MOVE for an object in the 3D view, IR_DROP for a carried one
 *     (UIAttemptPutIn3D @ 0058d700; any other state records nothing)
 *   PutItemInContainer → IR_PICK_UP for an object in the 3D view, IR_PUT_IN_CONTAINER
 *     for a carried one (UIAttemptPutInContainer @ 0058d680)
 *   GetAndWieldItem → IR_WIELD (UIAttemptWield @ 0058d590)
 *   GiveObjectRequest → IR_GIVE on the GIVEN object, the payload's second guid
 *     (UIAttemptGive @ 0058d620)
 *   Buy / Sell → IR_SHOP_EVENT on the VENDOR, the payload's first guid
 *     (CORE.17.k.c.a.a.b: gmVendorUI::SendShopEvent @ 004c0220, BuySingleItem
 *     @ 004c2820, SellSingleItem @ 004c2b40 and the sell-all button case
 *     0x100000d3 of HandleButtonClicks @ 004c50d0 each call
 *     ACCWeenieObject::RecordRequest(shopVendorID, IR_SHOP_EVENT) right after
 *     CM_Vendor::Event_Buy / Event_Sell — it is the TRANSACTION that records,
 *     not the vendor approach; none of the four asks
 *     IsPlayerReadyToMakeInventoryRequest first, so a Buy / Sell overwrites
 *     whatever was pending)
 * StackableSplitToWield records NOTHING — UIAttemptWield's split branch returns
 * before the record. Every other action returns null.
 */
export function classifyInventoryRequest(
  actionType: GameActionType,
  payload: Uint8Array,
  stateOf: (guid: number) => InventoryObjectState,
): RecordedInventoryRequest | null {
  switch (actionType) {
    case GameActionType.StackableMerge:
      return { objectId: u32(payload, 0), request: InventoryRequest.Merge };
    case GameActionType.StackableSplitToContainer:
    case GameActionType.StackableSplitTo3D:
      return { objectId: u32(payload, 0), request: InventoryRequest.Split };
    case GameActionType.GetAndWieldItem:
      return { objectId: u32(payload, 0), request: InventoryRequest.Wield };
    case GameActionType.GiveObjectRequest:
      return { objectId: u32(payload, 4), request: InventoryRequest.Give };
    case GameActionType.Buy:
    case GameActionType.Sell:
      return { objectId: u32(payload, 0), request: InventoryRequest.ShopEvent };
    case GameActionType.DropItem: {
      const objectId = u32(payload, 0);
      const state = stateOf(objectId);
      if (state === 'in3D') return { objectId, request: InventoryRequest.Move };
      if (state === 'contained') return { objectId, request: InventoryRequest.Drop };
      return null;
    }
    case GameActionType.PutItemInContainer: {
      const objectId = u32(payload, 0);
      const state = stateOf(objectId);
      if (state === 'in3D') return { objectId, request: InventoryRequest.PickUp };
      if (state === 'contained') return { objectId, request: InventoryRequest.PutInContainer };
      return null;
    }
    default:
      return null;
  }
}

/**
 * The GameActions retail sends only past IsPlayerReadyToMakeInventoryRequest(0)
 * (CORE.17.k.c.a.a): the seven UIAttempt* (StackableMerge, the two splits,
 * DropItem, PutItemInContainer, GetAndWieldItem — and UIAttemptWield's
 * StackableSplitToWield branch, gated before the split test — GiveObjectRequest)
 * and ItemHolder::UseObject @ 00588a80's Use / UseWithTarget (the 3D
 * Event_UseEvent, the inventory double-click, the targeted use; every drop
 * legality — AttemptToPlaceInContainer, AttemptPlaceIn3D, IsMergeAttemptLegal,
 * AcceptPaperDollDragObject — gates the same way). Anything else (chat, trade,
 * identify, movement) is not an inventory request and never asks — and neither
 * do the vendor's Buy / Sell (CORE.17.k.c.a.a.b): the four gmVendorUI send
 * sites record IR_SHOP_EVENT without asking, so a transaction goes out even
 * while another request is pending (and replaces it).
 */
export const GATED_INVENTORY_ACTIONS: ReadonlySet<GameActionType> = new Set<GameActionType>([
  GameActionType.StackableMerge,
  GameActionType.StackableSplitToContainer,
  GameActionType.StackableSplitTo3D,
  GameActionType.StackableSplitToWield,
  GameActionType.DropItem,
  GameActionType.PutItemInContainer,
  GameActionType.GetAndWieldItem,
  GameActionType.GiveObjectRequest,
  GameActionType.Use,
  GameActionType.UseWithTarget,
]);

export function isGatedInventoryAction(actionType: GameActionType): boolean {
  return GATED_INVENTORY_ACTIONS.has(actionType);
}

/**
 * The pre-send gate for one GameAction: a non-inventory action always passes;
 * an inventory request passes only when IsPlayerReadyToMakeInventoryRequest(0)
 * would — otherwise the refusal line goes to `display` (the 0x1a spew strip)
 * and nothing must be sent. Returns whether the action may go out.
 */
export function gateInventoryRequestSend(
  tracker: InventoryRequestTracker,
  actionType: GameActionType,
  display: (text: string) => void,
): boolean {
  if (!isGatedInventoryAction(actionType)) return true;
  return tracker.isPlayerReadyToMakeInventoryRequest(false, display);
}

/**
 * Record the request a sent action implies (if any); returns what was recorded.
 * `snapshotOf` reads the object as the client knows it at the send (name /
 * plural / stack), kept with the request for the 0x00A0 dispatch
 * (InventoryRequestTracker.pendingSnapshot; BUG.webac12-inventory-request-lock).
 */
export function recordInventoryRequestFromAction(
  tracker: InventoryRequestTracker,
  actionType: GameActionType,
  payload: Uint8Array,
  stateOf: (guid: number) => InventoryObjectState,
  now = 0,
  snapshotOf?: (guid: number) => AttemptFailedObject | undefined,
): RecordedInventoryRequest | null {
  const rec = classifyInventoryRequest(actionType, payload, stateOf);
  if (rec) tracker.record(rec.objectId, rec.request, now, snapshotOf?.(rec.objectId));
  return rec;
}

/**
 * gmVendorUI::OpenVendor @ 004c4ba0's first act (CORE.17.k.c.a.a.b) — the
 * server's ApproachVendor (0x0062 VendorInfo) for `vendorGuid`:
 *   if (prevRequest == IR_SHOP_EVENT && prevRequestObjectID == vendor)
 *     ACCWeenieObject::RecordResponse(vendor);
 * so the vendor's answer to a Buy / Sell releases the one-request gate — but
 * ONLY a pending shop event on that same vendor: the vendor profile arriving
 * for the plain approach (nothing pending), for another vendor, or while a
 * non-shop request is pending leaves the tracker alone. (A refused
 * transaction is released by the 0x00A0 InventoryServerSaveFailed instead —
 * ACE sends it with the PLAYER's guid and code None, the dispatch resolves
 * the pending vendor, and ServerSaysAttemptFailed's line is empty for
 * IR_SHOP_EVENT.) Returns whether the pending request was cleared.
 */
export function respondToVendorOpen(tracker: InventoryRequestTracker, vendorGuid: number): boolean {
  if (tracker.pendingRequest !== InventoryRequest.ShopEvent) return false;
  if (tracker.pendingObjectId !== (vendorGuid >>> 0)) return false;
  return tracker.respond(vendorGuid);
}

export interface AttemptFailedOutcome {
  /** The object ServerSaysAttemptFailed ran on (the pending one, else the message's), or 0 when it did not resolve. */
  readonly objectId: number;
  /** The pending request the line was built from (None when nothing was pending). */
  readonly request: InventoryRequest;
  /** The 0x1a text that was displayed, or null when nothing visible was (an empty line, or no object). */
  readonly text: string | null;
  /** Whether the tracker's pending request was cleared (retail: iff the object resolved and matched). */
  readonly cleared: boolean;
}

/**
 * The 0x00A0 dispatch (decomp :339948) + ServerSaysAttemptFailed(obj, code, 1):
 * look the object up by the pending request's id when one is pending, else by
 * the message's guid; when it resolves, compose verb line + suffix, display a
 * non-empty result on the spew strip, and clear the pending request for that
 * object. When it does not resolve, nothing prints and nothing clears (retail
 * skips the call for a null weenie object). The caller then runs the code's
 * HandleFailureEvent sink unless the code is one of the seven the dispatch
 * excludes.
 *
 * The 1999 client's case 0xa0 (Net_DispatchServerMessage, reference/ac1999/
 * Client/decomp/UI/Net_DispatchServerMessage.c:693-706) is the same: the
 * pending id when one is armed, ObjMgr_GetWeenieObjectById, then
 * ServerSaysAttemptFailed → ClearRequestIfCurrent.
 *
 * BUG.webac12-inventory-request-lock — retail resolves the pending object
 * through CObjectMaint::GetWeenieObject, which still holds a ground
 * container's contents after its panel closes; ours (`resolve`) forgets them
 * with the panel. A pick-up from a corpse refused after the panel closed
 * (the player stepped out of range, so the server answered "too far" /
 * "object gone") then never cleared, and every inventory verb and use after
 * it read "You can only move or use one item at a time" for the rest of the
 * session. The pending object now falls back to the record taken when the
 * request was sent.
 */
export function handleAttemptFailed(
  tracker: InventoryRequestTracker,
  messageGuid: number,
  code: number,
  resolve: (guid: number) => AttemptFailedObject | undefined,
  display: (text: string) => void,
): AttemptFailedOutcome {
  const objectId = tracker.failedObjectId(messageGuid);
  const request = tracker.pendingRequest;
  const obj = resolve(objectId) ?? (objectId === tracker.pendingObjectId ? tracker.pendingSnapshot ?? undefined : undefined);
  if (!obj) return { objectId: 0, request, text: null, cleared: false };
  const text = attemptFailedText(request, code, obj);
  if (text) display(text);
  const cleared = tracker.respond(objectId);
  return { objectId, request, text: text || null, cleared };
}
