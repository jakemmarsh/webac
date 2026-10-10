/**
 * GAP.world-drag-drop.a / .a.a — what the paperdoll does with an object
 * dropped on it, owned or not (gmPaperDollUI::HandleDropRelease @ 004a4d80).
 * Neither branch asks whether the player carries the object: an object
 * dragged off the 3D view wields straight from the ground, as a pack item
 * does (ACE HandleActionGetAndWieldItem walks to a landblock item, picks it
 * up and wields it).
 *
 *  - The drag band 0x100001d6 over the figure → AcceptPaperDollDragObject
 *    @ 004a4a70: an object with no wearable location bit (valid_locations
 *    & 0x8007fff == 0) is refused with the 0x1a line "You can't put that
 *    item there"; otherwise CPlayerSystem::AutoWear(obj, &worn, 0)
 *    @ 005601c0.
 *  - A slot → AcceptDragObject @ 004a3b10 with the slot's location mask and
 *    side from GetLocationInfoFromElementID @ 004a37f0: a melee weapon
 *    (0x100000) dropped on the shield slot (0x200000) also counts as
 *    fitting it, on the LEFT side (dual wield); otherwise the slot mask must
 *    meet the object's valid locations, else the drop silently fails
 *    (HandleDropRelease just clears the waiting state). A clothing slot
 *    (head, shirt, pants, hands, feet, cloak: & 0x80001ff) goes through
 *    AutoWear(obj, &worn, 0); every other slot through
 *    CPlayerSystem::AutoWield(obj, side, 0, 1, 0, 0) @ 00560a60.
 *
 * AutoWear = AutoWearIsLegal(obj, &worn, 0) @ 0055ef40, then
 * UIAttemptWield(pwd._valid_locations) — the whole mask. AutoWearIsLegal
 * gates on IsPlayerReadyToMakeInventoryRequest(0), needs a wearable bit
 * (& 0x8007fff), and refuses an object whose pwd._priority overlaps the
 * player's clothingPriorityMask (the OR of the equipped objects'
 * priorities): "The %s is already being worn" (0x7cc8b4) when the object
 * itself is on the player, else "You must remove your %s to wear that"
 * (0x7cc868) naming GetObjectAtLocation(inventoryMask & valid, priority)
 * @ 0058ce00 — silently when no such object is found.
 *
 * AutoWield with those arguments (param_3 = 0 shows the legality lines,
 * param_4 = 1 suppresses every "You're already wearing …" line, param_5 = 0
 * never unwields the blocking item, param_6 = 0 never falls to the other
 * hand/wrist): IsPlayerReadyToMakeInventoryRequest(0); "The %s is being
 * wielded by someone else" (0x7cd350) for an object another creature
 * wields; AutoWieldIsLegal(obj, 0) @ 0055ed60 — ammunition whose AmmoType
 * differs from the ready launcher's: "Cannot be used with %s" (0x7cc834,
 * launcher NAME_APPROPRIATE); a shield while the ready weapon
 * BlocksUseOfShield: "A shield may not be worn with the %s" (0x7cc7e8,
 * weapon NAME_SINGULAR); a held (0x1000000) non-caster outside
 * NONCOMBAT mode: "Cannot hold %s while in combat" (0x7cc7a8, object
 * NAME_APPROPRIATE). Then the slot is resolved by the same chain as the
 * double-click (resolveAutoWield); an occupied weapon / ammo ready slot
 * first takes a merge of the same stack (ItemHolder::AttemptMerge — the
 * outcome's `merge`), a same-wcid ammo stack with no room says "You cannot
 * wield more %s" (0x7ccddc, NAME_PLURAL), and any other occupied target is
 * refused silently.
 */

import { resolveAutoWield, blocksUseOfShield, getAppropriateName, UISlotSide } from '@ac/shared';

/** The wearable EquipMask bits AcceptPaperDollDragObject / AutoWearIsLegal test (clothing + armor + cloak; jewelry and weapons are not worn). */
export const PAPERDOLL_WEARABLE_MASK = 0x8007fff;
/** The clothing slot masks AcceptDragObject sends through AutoWear rather than AutoWield. */
export const PAPERDOLL_AUTOWEAR_SLOT_MASK = 0x80001ff;
const MELEE_WEAPON = 0x100000;
const SHIELD = 0x200000;
const MISSILE_AMMO = 0x800000;
const HELD = 0x1000000;
/** weaponReadySlot — the melee / missile / held / two-handed location. */
const WEAPON_READY = 0x3500000;
const WRIST_LEFT = 0x10000;
const FINGER_LEFT = 0x40000;
const ITEM_TYPE_CASTER = 0x8000;

/** acclient.exe literals (UTF-16, .rdata / inline). */
export const PAPERDOLL_CANT_PUT_THERE = "You can't put that item there";
export const PAPERDOLL_STRINGS = {
  /** 0x7cc8b4, AutoWearIsLegal: the object itself is already on the player. */
  alreadyBeingWorn: 'The %s is already being worn',
  /** 0x7cc868, AutoWearIsLegal: an equipped object covers the same priority. */
  mustRemoveToWear: 'You must remove your %s to wear that',
  /** 0x7cd350, AutoWield: another creature wields the object. */
  wieldedBySomeoneElse: 'The %s is being wielded by someone else',
  /** 0x7cc834, AutoWieldIsLegal: ammunition the ready launcher does not use. */
  cannotBeUsedWith: 'Cannot be used with %s',
  /** 0x7cc7e8, AutoWieldIsLegal: the ready weapon blocks a shield. */
  shieldNotWithWeapon: 'A shield may not be worn with the %s',
  /** 0x7cc7a8, AutoWieldIsLegal: a held non-caster in combat mode. */
  cannotHoldInCombat: 'Cannot hold %s while in combat',
} as const;

export type PaperdollDropTarget =
  | { kind: 'band' }
  | { kind: 'slot'; mask: number };

/** The PublicWeenieDesc fields the drop reads. */
export interface PaperdollDropObject {
  id: number;
  validLocations?: number;
  /** pwd._priority (ClothingPriority). */
  clothingPriority?: number;
  ammoType?: number;
  combatUse?: number;
  itemType?: number;
  weenieClassId?: number;
  name: string;
  pluralName?: string;
  stackSize?: number;
  maxStackSize?: number;
  /** tradeState == 1 — listed in a secure trade. */
  inTrade?: boolean;
  /** ItemHolder::GetObjectSplitSize — the drag carries the toolbar split of the selected stack, else the whole stack. */
  dragAmount?: number;
  /** pwd._wielderID; 0 / undefined = nobody. */
  wielderId?: number;
}

export interface PaperdollEquippedObject extends PaperdollDropObject {
  /** InventoryPlacement.loc_ — where it is wielded. */
  slot: number;
}

export interface PaperdollWearContext {
  playerId: number;
  /** The player's InventoryPlacement list (what CPlayerSystem's inventoryMask / clothingPriorityMask are built from). */
  equipped: readonly PaperdollEquippedObject[];
  /** ClientCombatSystem::combatMode != NONCOMBAT_COMBAT_MODE. */
  inCombat: boolean;
  /** IsPlayerReadyToMakeInventoryRequest(0)'s refusal line, or null when the player is ready. */
  readyRefusal: string | null;
}

export interface PaperdollDropOutcome {
  /** The location mask for GetAndWieldItem / StackableSplitToWield, or null when nothing is sent. */
  wieldLocation: number | null;
  /** The 0x1a spew line, when the drop is refused out loud. */
  notice?: string;
  /** ItemHolder::AttemptMerge into the wielded stack: send StackableMerge(obj → targetId, amount). */
  merge?: { targetId: number; amount: number };
}

const fmt = (template: string, name: string) => template.replace('%s', name);
/** GetObjectNameWide(NAME_APPROPRIATE = 2). */
const appropriate = (o: PaperdollDropObject) => getAppropriateName(o.name, o.pluralName, o.stackSize);

/** CPlayerSystem::AutoWear @ 005601c0 / AutoWearIsLegal @ 0055ef40 with param_3 = 0. */
function autoWear(obj: PaperdollDropObject, ctx: PaperdollWearContext): PaperdollDropOutcome {
  if (ctx.readyRefusal !== null) return { wieldLocation: null, notice: ctx.readyRefusal };
  const valid = (obj.validLocations ?? 0) >>> 0;
  if ((valid & PAPERDOLL_WEARABLE_MASK) === 0) return { wieldLocation: null };
  const priority = (obj.clothingPriority ?? 0) >>> 0;
  const priorityMask = ctx.equipped.reduce((m, e) => m | (e.clothingPriority ?? 0), 0);
  if ((priority & priorityMask) === 0) return { wieldLocation: valid };
  if (ctx.equipped.some((e) => e.id === obj.id && e.slot !== 0)) {
    return { wieldLocation: null, notice: fmt(PAPERDOLL_STRINGS.alreadyBeingWorn, appropriate(obj)) };
  }
  // GetObjectAtLocation(inventoryMask & valid, priority): the first placement
  // whose priority meets `priority` (or any, for priority 0) at those bits.
  const inventoryMask = ctx.equipped.reduce((m, e) => m | e.slot, 0);
  const locations = inventoryMask & valid;
  const blocker = ctx.equipped.find((e) =>
    ((((e.clothingPriority ?? 0) & priority) !== 0) || priority === 0) && (locations & e.slot) !== 0);
  if (!blocker) return { wieldLocation: null };
  return { wieldLocation: null, notice: fmt(PAPERDOLL_STRINGS.mustRemoveToWear, appropriate(blocker)) };
}

/** CPlayerSystem::AutoWieldIsLegal @ 0055ed60 with param_2 = 0: null when legal, else the refusal line. */
function autoWieldIllegal(obj: PaperdollDropObject, ctx: PaperdollWearContext): string | null {
  const valid = (obj.validLocations ?? 0) >>> 0;
  const weapon = ctx.equipped.find((e) => (e.slot & WEAPON_READY) !== 0);
  if ((valid & MISSILE_AMMO) !== 0 && weapon && (weapon.ammoType ?? 0) !== 0
    && weapon.ammoType !== (obj.ammoType ?? 0)) {
    return fmt(PAPERDOLL_STRINGS.cannotBeUsedWith, appropriate(weapon));
  }
  if ((valid & SHIELD) !== 0 && weapon && blocksUseOfShield({ ...weapon, validLocations: weapon.validLocations ?? 0 })) {
    return fmt(PAPERDOLL_STRINGS.shieldNotWithWeapon, weapon.name);
  }
  if ((valid & HELD) !== 0 && ctx.inCombat && ((obj.itemType ?? 0) & ITEM_TYPE_CASTER) === 0) {
    return fmt(PAPERDOLL_STRINGS.cannotHoldInCombat, appropriate(obj));
  }
  return null;
}

/** CPlayerSystem::AutoWield @ 00560a60 as AcceptDragObject calls it: (obj, side, 0, 1, 0, 0). */
function autoWield(obj: PaperdollDropObject, side: UISlotSide, ctx: PaperdollWearContext): PaperdollDropOutcome {
  if (ctx.readyRefusal !== null) return { wieldLocation: null, notice: ctx.readyRefusal };
  if (obj.wielderId && obj.wielderId !== ctx.playerId) {
    return { wieldLocation: null, notice: fmt(PAPERDOLL_STRINGS.wieldedBySomeoneElse, appropriate(obj)) };
  }
  const valid = (obj.validLocations ?? 0) >>> 0;
  if ((valid & 0x7fffffff) === 0) return { wieldLocation: null };
  const illegal = autoWieldIllegal(obj, ctx);
  if (illegal !== null) return { wieldLocation: null, notice: illegal };
  const occupiedMask = ctx.equipped.reduce((m, e) => m | e.slot, 0);
  const equippedAt = (bits: number) => ctx.equipped.find((e) => (e.slot & bits) !== 0)?.id ?? 0;
  const res = resolveAutoWield(
    {
      id: obj.id, validLocations: valid, combatUse: obj.combatUse, itemType: obj.itemType, weenieClassId: obj.weenieClassId,
      stackSize: obj.stackSize, maxStackSize: obj.maxStackSize, inTrade: obj.inTrade, dragAmount: obj.dragAmount,
      name: obj.name, pluralName: obj.pluralName,
    },
    occupiedMask, equippedAt, side, false,
    (id) => ctx.equipped.find((e) => e.id === id),
  );
  if (res.kind === 'wield') return { wieldLocation: res.slot >>> 0 };
  if (res.kind === 'merge') return { wieldLocation: null, merge: { targetId: res.targetId, amount: res.amount } };
  // param_3 = 0: the ammo branch's "You cannot wield more %s" is shown.
  if (res.kind === 'rejected' && res.legalityNotice) return { wieldLocation: null, notice: res.legalityNotice };
  // param_4 = 1 / param_5 = 0: a blocked location is refused without a word
  // and nothing is unwielded (ResetUnblocking). The robe line is not gated.
  if (res.kind === 'rejected' && res.notice) return { wieldLocation: null, notice: res.notice };
  return { wieldLocation: null };
}

/** Decide a paperdoll drop of `obj` (gmPaperDollUI::HandleDropRelease @ 004a4d80). */
export function acceptPaperdollDrop(
  obj: PaperdollDropObject,
  target: PaperdollDropTarget,
  ctx: PaperdollWearContext,
): PaperdollDropOutcome {
  const valid = (obj.validLocations ?? 0) >>> 0;
  if (target.kind === 'band') {
    if ((valid & PAPERDOLL_WEARABLE_MASK) === 0) return { wieldLocation: null, notice: PAPERDOLL_CANT_PUT_THERE };
    return autoWear(obj, ctx);
  }
  const slot = target.mask >>> 0;
  let fits = valid;
  let side = slot === WRIST_LEFT || slot === FINGER_LEFT ? UISlotSide.Left : UISlotSide.Right;
  if (slot === SHIELD && (valid & MELEE_WEAPON) !== 0) {
    fits |= SHIELD;
    side = UISlotSide.Left;
  }
  if ((slot & fits) === 0) return { wieldLocation: null };
  if ((slot & PAPERDOLL_AUTOWEAR_SLOT_MASK) !== 0) return autoWear(obj, ctx);
  return autoWield(obj, side, ctx);
}

/** UIItem drag-accept states (UIItemDragAccept.DRAG_ACCEPT_STATE): accept / refuse. */
const DRAG_ACCEPT = 0x10000040;
const DRAG_REFUSE = 0x10000041;

/**
 * gmPaperDollUI::OnItemListDragOver @ 004a4270 — the slot under a drag: its
 * location (GetLocationInfoFromElementID; a melee weapon also fits the
 * shield slot) must meet the object's valid_locations and
 * CPlayerSystem::AutoWieldIsLegal(obj, silent) must pass — every slot,
 * clothing included — for the green ring 0x10000040; else the red circle
 * 0x10000041.
 */
export function paperdollSlotDragAcceptState(obj: PaperdollDropObject, slotMask: number, ctx: PaperdollWearContext): number {
  let valid = (obj.validLocations ?? 0) >>> 0;
  const slot = slotMask >>> 0;
  if (slot === SHIELD && (valid & MELEE_WEAPON) !== 0) valid |= SHIELD;
  if ((slot & valid) === 0) return DRAG_REFUSE;
  if (ctx.readyRefusal !== null) return DRAG_REFUSE;
  return autoWieldIllegal(obj, ctx) === null ? DRAG_ACCEPT : DRAG_REFUSE;
}

/**
 * gmPaperDollUI::HandlePaperDollDragOver @ 004a3a70 — the figure's drag
 * overlay 0x1000046d under a drag: CPlayerSystem::AutoWearIsLegal(obj,
 * &worn, silent) @ 0055ef40 passing → 0x10000040; failing for an object
 * the player already wears → null (the overlay keeps its state); any other
 * failure (not ready, not wearable, a covering item) → 0x10000041.
 */
export function paperdollBandDragAcceptState(obj: PaperdollDropObject, ctx: PaperdollWearContext): number | null {
  if (ctx.readyRefusal !== null) return DRAG_REFUSE;
  const valid = (obj.validLocations ?? 0) >>> 0;
  if ((valid & PAPERDOLL_WEARABLE_MASK) === 0) return DRAG_REFUSE;
  const priority = (obj.clothingPriority ?? 0) >>> 0;
  const priorityMask = ctx.equipped.reduce((m, e) => m | (e.clothingPriority ?? 0), 0);
  if ((priority & priorityMask) === 0) return DRAG_ACCEPT;
  if (ctx.equipped.some((e) => e.id === obj.id && e.slot !== 0)) return null;
  return DRAG_REFUSE;
}
