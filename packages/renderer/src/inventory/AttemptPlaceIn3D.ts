/**
 * GAP.world-drag-drop — the 3D view as a drag source and a drop target.
 *
 * Retail routes both through UIElement_SmartBoxWrapper::
 * RecvNotice_SmartBoxObjectFound @ 004e5ad0, the answer to a SmartBox find
 * under the mouse:
 *
 * - search reason 5 (sr_Drop): `ItemHolder::AttemptPlaceIn3D(dragged,
 *   found, 1)`; a refusal (0) clears the dragged object's waiting state.
 * - search reason 6 (sr_Drag): a found object starts a drag when the player
 *   is in NonCombat mode, the object is not waiting, is neither Stuck
 *   (ObjectDescriptionFlag 0x4) nor a creature (ITEM_TYPE 0x10) — the player
 *   himself excepted — and is not wielded; then PrepareDragIcon +
 *   `UIElementManager::StartDragandDrop` + `CM_Item::SendNotice_BeginDrag`.
 *
 * `ItemHolder::AttemptPlaceIn3D @ 00588600` (param_3 = 1 from the drop, 0
 * from the keyboard Give / Drop commands) in retail order:
 *   1. IsPlayerReadyToMakeInventoryRequest(0) — else 0.
 *   2. The found object is the player → CPlayerSystem::PlaceInBackpack.
 *   3. Not owned → "You must first pick up the %s".
 *   4. tradeState != 0 → "You are trading the %s, it cannot be dropped".
 *   5. A found object:
 *      a. AttemptMerge(dragged, found, 0) (IsMergeAttemptLegal loud) → done;
 *      b. a vendor (bitfield 0x200): split == max → AttemptSellToVendor,
 *         else "You must split the stack before selling it.";
 *      c. DragItemOnPlayerOpensSecureTrade and a player → AttemptToTradeItem;
 *      d. a creature (ITEM_TYPE 0x10) → UIAttemptGive(found, split size);
 *      e. a container: not Openable → "The %s is locked"; not the open
 *         ground object → "You must open the %s first"; else
 *         AttemptToPlaceInContainer;
 *      f. param_3 == 0 → "Cannot give %s to %s" (dragged, found).
 *   6. param_3 == 0 → 0.
 *   7. The player on the ground: split < max → UIAttemptSplitTo3D; an object
 *      already in the 3D view → "Move cancelled"; else UIAttemptPutIn3D.
 *      In the air → "You cannot do that in mid air".
 * Every notice is ECM_UI::SendNotice_DisplayStringInfo(0x1a, …) — the spew
 * strip. The format strings are the UTF-16 literals the function pushes
 * (acclient.exe .rdata 0x7e2a34 / 0x7e29d8 / 0x7e2980 / 0x7e237c /
 * 0x7e2944 / 0x7e2918 / 0x7e28f8 / 0x7e28bc); names are NAME_APPROPRIATE (2).
 */

import { ItemType, ObjectDescriptionFlag } from '@ac/shared';
import { EOR_PLACEMENT_TEXT, type PlacementText } from './ItemHolderPlacement.js';

export const PLACE_IN_3D_STRINGS = {
  mustPickUp: 'You must first pick up the %s',
  tradingCannotDrop: 'You are trading the %s, it cannot be dropped',
  mustSplitToSell: 'You must split the stack before selling it.',
  locked: 'The %s is locked',
  mustOpenFirst: 'You must open the %s first',
  cannotGive: 'Cannot give %s to %s',
  moveCancelled: 'Move cancelled',
  midAir: 'You cannot do that in mid air',
  // ItemHolder::IsMergeAttemptLegal @ 00586f30, run loud by AttemptMerge(…, 0).
  mergeWhileTraded: 'You cannot merge items while they are being traded.',
  mergeStackFull: 'The destination stack is already full.',
  mergeDifferentTypes: 'You cannot merge different types of items.',
  // ClientTradeSystem::AttemptToTradeItem @ 0056df80.
  alreadyTrading: 'You are already trading with someone else.',
} as const;

function fmt(template: string, ...args: string[]): string {
  let i = 0;
  return template.replace(/%s/g, () => args[i++] ?? '');
}

/** The dragged object, as ACCWeenieObject answers for it. */
export interface PlaceIn3DItem {
  id: number;
  /** GetObjectNameWide(NAME_APPROPRIATE). */
  name: string;
  /** ACCWeenieObject::IsOwnedByPlayer — carried or wielded. */
  ownedByPlayer: boolean;
  /** tradeState != 0 — listed in a secure trade (or staged like one). */
  inTrade: boolean;
  /** current_state == IN_3D_VIEW. */
  in3DView: boolean;
  weenieClassId: number;
  stackSize: number;
  maxStackSize: number;
}

/** The object SmartBox found under the drop point. */
export interface PlaceIn3DTarget {
  id: number;
  name: string;
  weenieClassId: number;
  itemType: number;
  /** PublicWeenieDesc._bitfield (ObjectDescriptionFlag). */
  objectDescFlags: number;
  stackSize: number;
  maxStackSize: number;
  inTrade: boolean;
}

export interface PlaceIn3DContext {
  /** SmartBox::player_id. */
  playerId: number;
  /** IsPlayerReadyToMakeInventoryRequest(0) — the caller shows its refusal. */
  ready: boolean;
  /** GetObjectSplitSize for the dragged object (the toolbar split on the selected stack, else the full stack). */
  dragAmount: number;
  /** GenItemHolder::splitSize < maxSplitSize for this drag. */
  splitPartial: boolean;
  /** PlayerModule::DragItemOnPlayerOpensSecureTrade (CharacterOptions1 0x04000000). */
  dragItemOnPlayerOpensSecureTrade: boolean;
  /** CPhysicsObj::on_ground for the player. */
  playerOnGround: boolean;
  /** ClientUISystem::groundObject — the open external container (0 = none). */
  groundObjectId: number;
  /** The era client's merge refusal wording (end of retail's when absent; INV-11). */
  text?: PlacementText;
  /**
   * EraClientRules.vendorDropNeedsWholeStack (INV-12). False on 1999: ItemHolder_AttemptPlaceIn3D
   * hands a vendor drop to 0x004d00d0 with no split test. Absent = true (end of retail).
   */
  vendorDropNeedsWholeStack?: boolean;
}

export type PlaceIn3DAction =
  | { kind: 'none' }
  /** CPlayerSystem::PlaceInBackpack(item). */
  | { kind: 'backpack' }
  /** ACCWeenieObject::UIAttemptMerge(found, amount) + SetSelectedObject(found). */
  | { kind: 'merge'; amount: number }
  /** ClientUISystem::AttemptSellToVendor(found, item). */
  | { kind: 'sell' }
  /** ClientTradeSystem::AttemptToTradeItem(found, item). */
  | { kind: 'trade' }
  /** ACCWeenieObject::UIAttemptGive(found, amount). */
  | { kind: 'give'; amount: number }
  /** ItemHolder::AttemptToPlaceInContainer(item, found, 0, 1, 0). */
  | { kind: 'container' }
  /** ACCWeenieObject::UIAttemptSplitTo3D(amount). */
  | { kind: 'split3d'; amount: number }
  /** ACCWeenieObject::UIAttemptPutIn3D. */
  | { kind: 'put3d' };

export interface PlaceIn3DOutcome {
  action: PlaceIn3DAction;
  /** 0x1a lines, in the order retail displays them. */
  notices: string[];
}

/**
 * ItemHolder::IsMergeAttemptLegal @ 00586f30 (loud): both objects stack
 * (maxStackSize > 1), neither is being traded, the same wcid, and the target
 * has room. Returns the refusal line, null when legal, or undefined when the
 * pair is not two stacks (silent — nothing is said).
 */
export function mergeAttemptRefusal(
  item: Pick<PlaceIn3DItem, 'id' | 'inTrade' | 'weenieClassId' | 'maxStackSize'>,
  target: Pick<PlaceIn3DTarget, 'id' | 'inTrade' | 'weenieClassId' | 'stackSize' | 'maxStackSize'>,
  text: PlacementText = EOR_PLACEMENT_TEXT,
): string | null | undefined {
  if (item.id === target.id) return undefined;
  if (!(item.maxStackSize > 1) || !(target.maxStackSize > 1)) return undefined;
  if (item.inTrade || target.inTrade) return PLACE_IN_3D_STRINGS.mergeWhileTraded;
  if (item.weenieClassId !== target.weenieClassId) return text.mergeDifferentTypes;
  if (target.stackSize < target.maxStackSize) return null;
  return text.mergeStackFull;
}

/** The ItemHolder::AttemptPlaceIn3D decision (see the module header). */
export function attemptPlaceIn3D(
  item: PlaceIn3DItem | null,
  target: PlaceIn3DTarget | null,
  placeIn3D: boolean,
  ctx: PlaceIn3DContext,
): PlaceIn3DOutcome {
  const notices: string[] = [];
  const done = (action: PlaceIn3DAction): PlaceIn3DOutcome => ({ action, notices });
  if (!ctx.ready || !item) return done({ kind: 'none' });
  if (target && target.id === ctx.playerId) return done({ kind: 'backpack' });
  if (!item.ownedByPlayer) {
    notices.push(fmt(PLACE_IN_3D_STRINGS.mustPickUp, item.name));
    return done({ kind: 'none' });
  }
  if (item.inTrade) {
    notices.push(fmt(PLACE_IN_3D_STRINGS.tradingCannotDrop, item.name));
    return done({ kind: 'none' });
  }
  if (target) {
    const refusal = mergeAttemptRefusal(item, target, ctx.text);
    if (refusal === null) {
      const tgtSize = Math.max(1, target.stackSize || 1);
      const amount = Math.min(Math.max(1, ctx.dragAmount), target.maxStackSize - tgtSize);
      return done({ kind: 'merge', amount });
    }
    if (refusal) notices.push(refusal);
    const flags = target.objectDescFlags >>> 0;
    if (flags & ObjectDescriptionFlag.Vendor) {
      if (!ctx.splitPartial || ctx.vendorDropNeedsWholeStack === false) return done({ kind: 'sell' });
      notices.push(PLACE_IN_3D_STRINGS.mustSplitToSell);
      return done({ kind: 'none' });
    }
    if (ctx.dragItemOnPlayerOpensSecureTrade && (flags & ObjectDescriptionFlag.Player)) {
      return done({ kind: 'trade' });
    }
    if (target.itemType === ItemType.Creature) {
      return done({ kind: 'give', amount: Math.max(1, ctx.dragAmount) });
    }
    if (target.itemType & ItemType.Container) {
      if (!(flags & ObjectDescriptionFlag.Openable)) {
        notices.push(fmt(PLACE_IN_3D_STRINGS.locked, target.name));
        return done({ kind: 'none' });
      }
      if (ctx.groundObjectId !== target.id) {
        notices.push(fmt(PLACE_IN_3D_STRINGS.mustOpenFirst, target.name));
        return done({ kind: 'none' });
      }
      return done({ kind: 'container' });
    }
    if (!placeIn3D) {
      notices.push(fmt(PLACE_IN_3D_STRINGS.cannotGive, item.name, target.name));
      return done({ kind: 'none' });
    }
  }
  if (!placeIn3D) return done({ kind: 'none' });
  if (!ctx.playerOnGround) {
    notices.push(PLACE_IN_3D_STRINGS.midAir);
    return done({ kind: 'none' });
  }
  if (ctx.splitPartial) return done({ kind: 'split3d', amount: Math.max(1, ctx.dragAmount) });
  if (item.in3DView) {
    notices.push(PLACE_IN_3D_STRINGS.moveCancelled);
    return done({ kind: 'none' });
  }
  return done({ kind: 'put3d' });
}

/** What RecvNotice_SmartBoxObjectFound's sr_Drag branch reads about the found object. */
export interface WorldDragCandidate {
  id: number;
  itemType: number;
  objectDescFlags: number;
  wielderId: number;
  /** ACCWeenieObject::waiting — a request on it is pending. */
  waiting: boolean;
}

/** The sr_Drag gate: may a drag start on this found object? */
export function canBeginWorldDrag(found: WorldDragCandidate | null, nonCombat: boolean, playerId: number): boolean {
  if (!found || found.id === 0 || !nonCombat || found.waiting) return false;
  const stuck = ((found.objectDescFlags >>> 0) & ObjectDescriptionFlag.Stuck) !== 0;
  const creature = (found.itemType & ItemType.Creature) !== 0;
  if ((stuck || creature) && found.id !== playerId) return false;
  return found.wielderId === 0;
}

/**
 * ClientUISystem::attemptOpenVendorID / attemptSaleObjectID and
 * ClientTradeSystem::attemptTradeToPlayerID / attemptTradeObjectID: a drop
 * on a vendor or player whose window is not open Uses them and remembers the
 * object; Handle_VendorInfo @ (decomp :348340) adds it to the sell list when
 * that vendor answers (in sell mode), Recv_RegisterTrade re-runs
 * AttemptToTradeItem for that partner. Either answer clears the memory.
 */
export class WorldDropHandoff {
  private vendorId = 0;
  private saleObjectId = 0;
  private tradePlayerId = 0;
  private tradeObjectId = 0;

  /** AttemptSellToVendor: 'add' when that vendor is open, else 'use' (the vendor is approached and the item remembered). */
  attemptSellToVendor(openVendorId: number, vendorId: number, itemId: number): 'add' | 'use' {
    if (openVendorId === vendorId) return 'add';
    this.vendorId = vendorId;
    this.saleObjectId = itemId;
    return 'use';
  }

  /** Handle_VendorInfo: whether this vendor was the one approached for a sale (SHOP_MODE_SELL), and the object to add (0 = none). Clears the memory. */
  vendorOpened(vendorId: number): { sellMode: boolean; objectId: number } {
    const match = vendorId === this.vendorId && this.vendorId !== 0;
    const objectId = match ? this.saleObjectId : 0;
    this.vendorId = 0;
    this.saleObjectId = 0;
    return { sellMode: match, objectId };
  }

  /** AttemptToTradeItem: 'add' with that partner, 'busy' with another ("You are already trading with someone else."), else 'use'. */
  attemptToTradeItem(partnerId: number, playerId: number, itemId: number): 'add' | 'busy' | 'use' {
    if (partnerId !== 0) return partnerId === playerId ? 'add' : 'busy';
    this.tradePlayerId = playerId;
    this.tradeObjectId = itemId;
    return 'use';
  }

  /** Recv_RegisterTrade: the object to trade with this partner (0 = none). Clears the memory. */
  tradeRegistered(partnerId: number): number {
    const objectId = partnerId === this.tradePlayerId && partnerId !== 0 ? this.tradeObjectId : 0;
    this.tradePlayerId = 0;
    this.tradeObjectId = 0;
    return objectId;
  }
}
