/**
 * InventoryRequest — the retail client's ONE pending inventory request and the
 * "The %s can't be …" line it prints when the server refuses it (CORE.17.k.c.a).
 *
 * Retail (decompiled EoL client, ACCWeenieObject):
 *   - `prevRequest` / `prevRequestObjectID` / `prevRequestTime` are three STATIC
 *     fields — one pending request for the whole client, not one per object.
 *     `RecordRequest(id, kind) @ 0058c220` sets them; the eight UIAttempt*
 *     entry points set them inline after `CM_Inventory::Event_*`:
 *       UIAttemptMerge @ 0058d770 → IR_MERGE
 *       UIAttemptSplitToContainer @ 0058d7d0 / UIAttemptSplitTo3D @ 0058d850 → IR_SPLIT
 *       UIAttemptPutIn3D @ 0058d700 → IR_MOVE when the item is IN_3D_VIEW, else IR_DROP
 *       UIAttemptPutInContainer @ 0058d680 → IR_PICK_UP when IN_3D_VIEW, else IR_PUT_IN_CONTAINER
 *       UIAttemptWield @ 0058d590 → IR_WIELD (its StackableSplitToWield branch records nothing)
 *       UIAttemptGive @ 0058d620 → IR_GIVE
 *     and a vendor TRANSACTION records IR_SHOP_EVENT on the vendor (CORE.17.k.c.a.a.b):
 *     gmVendorUI::SendShopEvent @ 004c0220, BuySingleItem @ 004c2820, SellSingleItem
 *     @ 004c2b40 and HandleButtonClicks @ 004c50d0's sell-all case each call
 *     RecordRequest(shopVendorID, IR_SHOP_EVENT) right after CM_Vendor::Event_Buy /
 *     Event_Sell (plus ClientUISystem::IncrementBusyCount, undone by
 *     Handle_Item__UseDone @ 00564900); the vendor approach itself records nothing.
 *     gmVendorUI::OpenVendor @ 004c4ba0 (the server's VendorInfo answer) clears it iff
 *     prevRequest == IR_SHOP_EVENT && prevRequestObjectID == that vendor.
 *   - `RecordResponse(id) @ 0058cab0` clears the three iff `id == prevRequestObjectID`;
 *     `ServerSaysMoveItem @ 0058dbb0` (the 0x0022 ContainID / 0x0023 wield / 0x019A
 *     move messages, AND the 0x0024 InventoryRemoveObject case — UIQueueManager's
 *     `case 0x24` calls `ServerSaysRemove @ 0058e4c0`, which is
 *     `ServerSaysMoveItem(this, 0, 0, 0, 0, 1)`, so a consumed / given / fully-merged
 *     pending object clears too), `ServerSaysSetStackSize @ 0058cc40` (0x0197) and
 *     `ServerSaysAttemptFailed @ 0058eae0` (0x00A0) carry the same id-matched clear;
 *     `ClientUISystem::OnViewContents @ 00565870` and the 0x0052 close-ground-container
 *     case call RecordResponse for the container. Nothing clears on a timer:
 *     `prevRequestTime` is written and never compared.
 *   - `IsPlayerReadyToMakeInventoryRequest(int quiet) @ 0058d050` is the gate every
 *     request runs through first (CORE.17.k.c.a.a): `prevRequest != IR_NONE` →
 *     `SendNotice_DisplayStringInfo(0x1a, "You can only move or use one item at a time")`
 *     unless quiet, return 0; else `ACCWeenieObject::attackInProgress` →
 *     "You cannot move or use an item while attacking" unless quiet, return 0; else 1.
 *     The seven UIAttempt* (@ 0058d590–0058d850) call it with 0 BEFORE their
 *     CM_Inventory::Event_*, as do ItemHolder::UseObject @ 00588a80 (every Use — the
 *     3D Event_UseEvent, the inventory double-click, the targeted use),
 *     AttemptToPlaceInContainer @ 00588140, AttemptPlaceIn3D @ 00588600,
 *     AttemptSetGroundObject @ 005873d0, IsMergeAttemptLegal @ 00586f30 (quiet = its
 *     own flag), gmPaperDollUI::AcceptPaperDollDragObject @ 004a4a70,
 *     CPlayerSystem::AutoWield @ 00560a60 / AutoSort @ 005609a0 / AutoWearIsLegal
 *     @ 0055ef40; IsDragIntoContainerAttemptLegal @ 00587e90 (the hover legality)
 *     passes quiet = 1. `attackInProgress` is a second ACCWeenieObject static:
 *     ClientCombatSystem::HandleCommenceAttackEvent @ 0056ad20 sets it (the server's
 *     CombatCommenceAttack event) and HandleAttackDoneEvent @ 0056c500 clears it (every
 *     AttackDone, any code); ClientCombatSystem::Begin @ 0056a460 starts it false.
 *   - The 0x00A0 InventoryServerSaveFailed dispatch (UIQueueManager::ProcessNetBlobData
 *     @ 0055b000, decomp :339948) looks the object up by `prevRequestObjectID` WHEN ONE IS
 *     PENDING, else by the message's guid, and calls ServerSaysAttemptFailed(obj, code, 1)
 *     only when the object resolves.
 *   - `ServerSaysAttemptFailed` builds ONE string: the verb by `prevRequest` (jump table
 *     @ 0058ee84, index prevRequest − 1; the .rdata literals at 0x7e4190–0x7e42f8) with
 *     `GetObjectNameWide(NAME_PLURAL = 1)` for merge / split and `NAME_APPROPRIATE = 2`
 *     for the rest, then a per-code suffix (0x7e3ff8–0x7e4138), and sends it through
 *     `ECM_UI::SendNotice_DisplayStringInfo(0x1a)` — the spew box — even when both parts
 *     are empty (an empty 0x1a line draws nothing). The HandleFailureEvent sink for the
 *     code follows separately (so 0x3ee prints this line AND "The container is closed!").
 */

import { getAppropriateName, getPluralName } from './objectName.js';

/** ACCWeenieObject::InventoryRequest — the jump table @ 0058ee84 is indexed by value − 1. */
export enum InventoryRequest {
  None = 0,
  Merge = 1,
  Split = 2,
  Move = 3,
  PickUp = 4,
  PutInContainer = 5,
  Drop = 6,
  Wield = 7,
  /** A vendor Buy / Sell, recorded on the vendor (gmVendorUI's four send sites); no verb line. */
  ShopEvent = 8,
  Give = 9,
}

/** ACCWeenieObject::GetObjectName's NameType argument. */
export type AttemptFailedNameType = 'plural' | 'appropriate';

export interface AttemptFailedVerb {
  /** The .rdata sprintf template (`%s` = the object name). */
  readonly template: string;
  readonly nameType: AttemptFailedNameType;
}

/** The verb line per pending request — the eight sprintf arms of ServerSaysAttemptFailed. */
export const ATTEMPT_FAILED_VERB: Readonly<Partial<Record<InventoryRequest, AttemptFailedVerb>>> = Object.freeze({
  [InventoryRequest.Merge]: { template: "The %s can't be merged", nameType: 'plural' }, // 0x7e42f8
  [InventoryRequest.Split]: { template: "The %s can't be split", nameType: 'plural' }, // 0x7e42cc
  [InventoryRequest.Move]: { template: "The %s can't be moved", nameType: 'appropriate' }, // 0x7e42a0
  [InventoryRequest.PickUp]: { template: "The %s can't be picked up", nameType: 'appropriate' }, // 0x7e426c
  [InventoryRequest.PutInContainer]: { template: "The %s can't be put in the container", nameType: 'appropriate' }, // 0x7e4220
  [InventoryRequest.Drop]: { template: "The %s can't be dropped", nameType: 'appropriate' }, // 0x7e41ec
  [InventoryRequest.Wield]: { template: "The %s can't be wielded", nameType: 'appropriate' }, // 0x7e41bc
  [InventoryRequest.Give]: { template: "The %s can't be given", nameType: 'appropriate' }, // 0x7e4190
});

/** The per-code suffix appended after the verb line (ServerSaysAttemptFailed @ 0058eca3–0058ede1). */
export const ATTEMPT_FAILED_SUFFIX: Readonly<Record<number, string>> = Object.freeze({
  [0x001d]: " - you're too busy", // YoureTooBusy, 0x7e40c4
  [0x0020]: ' - you must control both objects', // IllegalInventoryTransaction, 0x7e40f0
  [0x0028]: " - the item is under someone else's control", // Frozen, 0x7e4138
  [0x002a]: ' - you are too encumbered', // YouAreTooEncumbered, 0x7e4090 (append_n_chars of the same literal)
  [0x0036]: ' - action cancelled', // ActionCancelled, 0x7e4068
  [0x0037]: ' - unable to move to object', // ObjectGone, 0x7e4030 — the 0x37..0x39 range shares one arm
  [0x0038]: ' - unable to move to object', // NoObject
  [0x0039]: ' - unable to move to object', // CantGetThere
  [0x03ee]: ' - the container is closed', // TheContainerIsClosed, 0x7e3ff8
});

export interface AttemptFailedObject {
  readonly name: string;
  readonly pluralName?: string;
  readonly stackSize?: number;
}

/** GetObjectNameWide(this, nameType, 0) as ServerSaysAttemptFailed calls it. */
export function attemptFailedObjectName(obj: AttemptFailedObject, nameType: AttemptFailedNameType): string {
  return nameType === 'plural'
    ? getPluralName(obj.name, obj.pluralName)
    : getAppropriateName(obj.name, obj.pluralName, obj.stackSize);
}

/** The verb line for a pending request, or '' when the request has no arm (None / ShopEvent). */
export function attemptFailedVerbLine(request: InventoryRequest, obj: AttemptFailedObject): string {
  const verb = ATTEMPT_FAILED_VERB[request];
  return verb ? verb.template.replace('%s', attemptFailedObjectName(obj, verb.nameType)) : '';
}

/** The per-code suffix, or '' when the code has none. */
export function attemptFailedSuffix(code: number): string {
  return ATTEMPT_FAILED_SUFFIX[code] ?? '';
}

/**
 * The whole 0x1a string ServerSaysAttemptFailed sends for (pending request, code, object):
 * verb line + suffix. '' means retail sent an empty line, i.e. nothing visible.
 */
export function attemptFailedText(request: InventoryRequest, code: number, obj: AttemptFailedObject): string {
  return attemptFailedVerbLine(request, obj) + attemptFailedSuffix(code);
}

/** IsPlayerReadyToMakeInventoryRequest's first refusal — a request is pending (acclient.exe .rdata, UTF-16). */
export const INVENTORY_REQUEST_PENDING_TEXT = 'You can only move or use one item at a time';
/** Its second refusal — ACCWeenieObject::attackInProgress is set (acclient.exe .rdata, UTF-16). */
export const INVENTORY_REQUEST_ATTACKING_TEXT = 'You cannot move or use an item while attacking';

/** Why IsPlayerReadyToMakeInventoryRequest returned 0, in the order it tests them. */
export type InventoryRequestRefusal = 'pending' | 'attacking';

/** The 0x1a line for a refusal. */
export function inventoryRequestRefusalText(refusal: InventoryRequestRefusal): string {
  return refusal === 'pending' ? INVENTORY_REQUEST_PENDING_TEXT : INVENTORY_REQUEST_ATTACKING_TEXT;
}

export interface PendingInventoryRequest {
  readonly objectId: number;
  readonly request: InventoryRequest;
  /** The recording time (Timer::cur_time in retail; whatever clock the caller passes). */
  readonly time: number;
}

/**
 * The client's one pending inventory request — ACCWeenieObject::prevRequest /
 * prevRequestObjectID / prevRequestTime.
 */
export class InventoryRequestTracker {
  private objectId = 0;
  private request = InventoryRequest.None;
  private time = 0;

  /** prevRequestObjectID (0 = none pending). */
  get pendingObjectId(): number { return this.objectId; }
  /** prevRequest. */
  get pendingRequest(): InventoryRequest { return this.request; }
  /** The pending request, or null when none is. */
  get pending(): PendingInventoryRequest | null {
    return this.request === InventoryRequest.None && this.objectId === 0
      ? null
      : { objectId: this.objectId, request: this.request, time: this.time };
  }

  /** ACCWeenieObject::RecordRequest @ 0058c220 — overwrites whatever was pending. */
  record(objectId: number, request: InventoryRequest, now = 0): void {
    this.objectId = objectId >>> 0;
    this.request = request;
    this.time = now;
  }

  /** ACCWeenieObject::RecordResponse @ 0058cab0 — clears iff `objectId` is the pending one. Returns whether it cleared. */
  respond(objectId: number): boolean {
    if ((objectId >>> 0) !== this.objectId) return false;
    this.objectId = 0;
    this.request = InventoryRequest.None;
    this.time = 0;
    return true;
  }

  /** The 0x00A0 dispatch's object choice: the pending object when one is, else the message's guid. */
  failedObjectId(messageGuid: number): number {
    return this.objectId !== 0 ? this.objectId : (messageGuid >>> 0);
  }

  /** ACCWeenieObject::IsPlayerReadyToMakeInventoryRequest's first gate: nothing pending. */
  get isIdle(): boolean { return this.request === InventoryRequest.None; }

  private attacking = false;

  /** ACCWeenieObject::attackInProgress — set by HandleCommenceAttackEvent, cleared by HandleAttackDoneEvent. */
  get attackInProgress(): boolean { return this.attacking; }
  setAttackInProgress(inProgress: boolean): void { this.attacking = inProgress; }

  /** ClientCombatSystem::Begin's reset — a fresh world session starts with no attack in progress. */
  resetAttack(): void { this.attacking = false; }

  /**
   * Why a request would be refused right now — 'pending' (prevRequest != IR_NONE,
   * tested first), 'attacking' (attackInProgress), or null when the player is ready.
   */
  refusal(): InventoryRequestRefusal | null {
    if (this.request !== InventoryRequest.None) return 'pending';
    if (this.attacking) return 'attacking';
    return null;
  }

  /**
   * ACCWeenieObject::IsPlayerReadyToMakeInventoryRequest(quiet) @ 0058d050: true when
   * the request may go out; otherwise displays the refusal's 0x1a line (unless quiet)
   * and returns false. `display` is ECM_UI::SendNotice_DisplayStringInfo(0x1a, …).
   */
  isPlayerReadyToMakeInventoryRequest(quiet: boolean, display: (text: string) => void): boolean {
    const refusal = this.refusal();
    if (refusal === null) return true;
    if (!quiet) display(inventoryRequestRefusalText(refusal));
    return false;
  }
}
