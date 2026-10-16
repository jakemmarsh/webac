/**
 * AutoWield — retail client-side wield-slot resolution.
 *
 * Transcribed from the decompiled EoL retail client,
 * CPlayerSystem::AutoWield @ 00560a60 (reference/client-eol/decomp/
 * acclient-decompiled.c:344219). The retail client — NOT the server —
 * decides which single EquipMask slot a wield request targets, and when
 * every valid slot is occupied it dequips the blocking item itself
 * (ItemHolder::AttemptToPlaceInContainer → Event_PutItemInContainer to
 * the player's pack), remembers the blocked wield (blockedID/blockedSide),
 * and retries once the dequip's inventory update arrives
 * (CPlayerSystem @ LAB_005633cf re-calls AutoWield). ACE's server
 * documents the same observed traffic: "the client handles dequipping a
 * lot of conflicting items automatically" / "the typical DequipItem ->
 * GetAndWieldItem" (ACE Player_Inventory.cs:1664,1684).
 *
 * This module is the pure decision function; the renderer owns the
 * network sends and the dequip-confirmation retry loop.
 */

import { EquipMask } from '../game-types.js';
import { CombatUse } from '../combat/CombatSystem.js';
import { getPluralName } from './objectName.js';

/** Retail UI_SLOT_SIDE — which hand/side a gesture prefers (rings, wrists,
 *  dual wield). Double-click uses Right (DetermineUseResult case 3);
 *  case 8 uses Left. */
export enum UISlotSide {
  Right = 0,
  Left = 1,
}

export interface AutoWieldItem {
  id: number;
  /** EquipMask bitmask of valid equip slots (PropertyInt.ValidLocations). */
  validLocations: number;
  /** ACE CombatUse byte — drives BlocksUseOfShield (missile launcher /
   *  two-hander force the shield off, decomp @ 0055d3e0). */
  combatUse?: number;
  /** ACE ItemType bitmask — Caster (0x8000) also blocks shield use. */
  itemType?: number;
  /** Weenie class id — retail merges same-wcid stacks into the occupied
   *  weapon / ammo ready slot instead of dequipping (AttemptMerge). */
  weenieClassId?: number;
  /** pwd._stackSize (0 / undefined = 1). */
  stackSize?: number;
  /** pwd._maxStackSize — IsMergeAttemptLegal needs > 1 on both sides. */
  maxStackSize?: number;
  /** tradeState == 1 — listed in a secure trade (merges are refused). */
  inTrade?: boolean;
  /** ItemHolder::GetObjectSplitSize — the toolbar split size when this is
   *  the selected stack, else the full stack. Defaults to stackSize. */
  dragAmount?: number;
  /** For the "You cannot wield more %s" line (GetObjectNameWide NAME_PLURAL). */
  name?: string;
  pluralName?: string;
}

/** The ACCWeenieObject fields IsMergeAttemptLegal reads off a wielded stack. */
export interface AutoWieldStack {
  weenieClassId?: number;
  stackSize?: number;
  maxStackSize?: number;
  inTrade?: boolean;
}

/** acclient.exe 0x7ccddc — AutoWield's ammo branch, same-wcid full stack. */
export const AUTOWIELD_CANNOT_WIELD_MORE = 'You cannot wield more %s';

export type AutoWieldResolution =
  /** Send GetAndWieldItem(item, slot) — retail UIAttemptWield with the
   *  single chosen slot bit (or the masked weapon/robe group). */
  | { kind: 'wield'; slot: number }
  /** Every valid slot occupied: dequip `blockingId` (PutItemInContainer →
   *  player pack), then retry after the server confirms.
   *  `notice` is the exact retail blocked string, shown only by gestures
   *  that display notices (drag paths; double-click suppresses them —
   *  AutoWield param_4). */
  | { kind: 'blocked'; blockingId: number; notice?: string }
  /** ItemHolder::AttemptMerge @ 005878f0 into the wielded stack: send
   *  StackableMerge(item → targetId, amount) — UIAttemptMerge — instead of
   *  wielding or dequipping anything. */
  | { kind: 'merge'; targetId: number; amount: number }
  /** No action. `notice`, when present, is shown even on double-click
   *  (the robe "shirt and pants" message is not gated in retail).
   *  `legalityNotice` is shown only by callers passing retail param_3 = 0
   *  (the drag paths; double-click passes 1 and stays silent). */
  | { kind: 'rejected'; reason: string; notice?: string; legalityNotice?: string };

/** Lookup: id of the equipped item whose wield location overlaps `bits`,
 *  or 0 when those slots are free. */
export type EquippedLookup = (bits: number) => number;

/** BlocksUseOfShield, decomp @ 0055d3e0: missile launcher (CombatUse
 *  Missile with ammo), two-hander, or Caster item type. */
export function blocksUseOfShield(item: AutoWieldItem): boolean {
  if (item.combatUse === CombatUse.Missile) return true;
  if (item.combatUse === CombatUse.TwoHanded) return true;
  return ((item.itemType ?? 0) & 0x8000) !== 0; // ItemType.Caster
}

/**
 * ItemHolder::IsMergeAttemptLegal @ 00586f30 in its quiet form (AutoWield
 * passes param_3 = 1, so no refusal line is shown): two different objects,
 * both stackable (maxStackSize > 1), neither being traded, the same wcid,
 * and room left in the target stack.
 */
export function isMergeAttemptLegal(
  item: AutoWieldItem, targetId: number, target: AutoWieldStack | undefined,
): boolean {
  if (!target || item.id === targetId) return false;
  if (!((item.maxStackSize ?? 0) > 1) || !((target.maxStackSize ?? 0) > 1)) return false;
  if (item.inTrade || target.inTrade) return false;
  if (item.weenieClassId === undefined || item.weenieClassId !== target.weenieClassId) return false;
  return (target.stackSize ?? 0) < (target.maxStackSize ?? 0);
}

/** ItemHolder::AttemptMerge's amount: GetObjectSplitSize (0 → 1) clamped to
 *  the room left in the target (maxStackSize - stackSize, stackSize 0 → 1). */
function attemptMergeAmount(item: AutoWieldItem, target: AutoWieldStack): number {
  const drag = Math.floor(item.dragAmount ?? item.stackSize ?? 0) || 1;
  const room = (target.maxStackSize ?? 0) - (Math.floor(target.stackSize ?? 0) || 1);
  return Math.max(0, Math.min(drag, room));
}

/** Armor/accessory chain order per the decompiled AutoWield: first FREE
 *  valid bit wields immediately; each occupied bit records its occupant
 *  as the blocking item (last one checked wins, matching retail's
 *  fall-through writes to blockingID). */
const ARMOR_CHAIN: Array<{ bit: number; notice: string }> = [
  { bit: EquipMask.TrinketOne, notice: "You're already wearing a trinket." },
  { bit: EquipMask.Cloak, notice: "You're already wearing a cloak." },
  { bit: EquipMask.SigilOne, notice: "You're already using aetheria of Lyr." },
  { bit: EquipMask.SigilTwo, notice: "You're already using aetheria of Kor." },
  { bit: EquipMask.SigilThree, notice: "You're already using aetheria of Tem." },
  { bit: EquipMask.HeadWear, notice: "You're already wearing a helm." },
  { bit: EquipMask.ChestArmor, notice: "You're already wearing chest armor." },
  { bit: EquipMask.AbdomenArmor, notice: "You're already wearing abdomen armor." },
  { bit: EquipMask.UpperArmArmor, notice: "You're already wearing upper arm armor." },
  { bit: EquipMask.LowerArmArmor, notice: "You're already wearing lower arm armor." },
  { bit: EquipMask.HandWear, notice: "You're already wearing hand armor." },
  { bit: EquipMask.UpperLegArmor, notice: "You're already wearing upper leg armor." },
  { bit: EquipMask.LowerLegArmor, notice: "You're already wearing lower leg armor." },
  { bit: EquipMask.FootWear, notice: "You're already wearing foot armor." },
];

const WEAPON_GROUP = EquipMask.MeleeWeapon | EquipMask.MissileWeapon
  | EquipMask.Held | EquipMask.TwoHanded; // 0x3500000, retail weaponReadySlot
const DUAL_WIELD_GROUP = EquipMask.MeleeWeapon | EquipMask.MissileWeapon
  | EquipMask.TwoHanded; // 0x2500000 — left-side gesture retargets to Shield

/**
 * Resolve where (and whether) a wield gesture lands, per retail
 * CPlayerSystem::AutoWield. Mirrors the decompiled check order exactly:
 * neck → trinket/cloak/sigils → armor slots → wrist/ring pairs (with
 * other-side fallback) → weapons/shield/ammo → clothes (shirt/pants/robe).
 *
 * @param item          the inventory item being wielded
 * @param occupiedMask  OR of every equipped item's wield location
 *                      (retail CPlayerSystem::inventoryMask)
 * @param equippedAt    occupant lookup by slot bits (0 = free)
 * @param side          gesture side; double-click is Right
 * @param allowOtherSide retail param_6 — jewelry falls to the other
 *                      hand/wrist when the preferred one is taken
 *                      (enabled on the double-click path)
 * @param stackOf       the stack fields of an equipped item — the weapon and
 *                      ammo branches first try ItemHolder::AttemptMerge into
 *                      the wielded stack (same wcid, room left) before
 *                      dequipping it
 */
export function resolveAutoWield(
  item: AutoWieldItem,
  occupiedMask: number,
  equippedAt: EquippedLookup,
  side: UISlotSide = UISlotSide.Right,
  allowOtherSide = true,
  stackOf?: (id: number) => AutoWieldStack | undefined,
): AutoWieldResolution {
  let valid = item.validLocations >>> 0;
  if ((valid & EquipMask.All) === 0) {
    return { kind: 'rejected', reason: 'not-wieldable' };
  }

  let blockingId = 0;
  let blockingNotice: string | undefined;
  let legalityNotice: string | undefined;
  const tryMerge = (targetId: number): AutoWieldResolution | null => {
    const target = stackOf?.(targetId);
    if (!isMergeAttemptLegal(item, targetId, target)) return null;
    return { kind: 'merge', targetId, amount: attemptMergeAmount(item, target!) };
  };
  const block = (bits: number, notice?: string) => {
    const occupant = equippedAt(bits);
    if (occupant !== 0) { blockingId = occupant; blockingNotice = notice; }
  };
  const finishBlocked = (): AutoWieldResolution => {
    if (blockingId === 0) {
      if (legalityNotice !== undefined) {
        return { kind: 'rejected', reason: 'ammo-stack-full', legalityNotice };
      }
      return { kind: 'rejected', reason: 'no-blocking-item' };
    }
    if (blockingId === item.id) return { kind: 'rejected', reason: 'self-blocking' };
    return { kind: 'blocked', blockingId, notice: blockingNotice };
  };

  // ── Neck first (decomp: the 0x8000 branch precedes the armor chain) ──
  if ((valid & EquipMask.NeckWear) !== 0) {
    if ((occupiedMask & EquipMask.NeckWear) === 0) {
      return { kind: 'wield', slot: EquipMask.NeckWear };
    }
    block(EquipMask.NeckWear, "You're already wearing jewelry on your neck.");
  }

  // ── Trinket / cloak / sigils / armor slots ──
  for (const { bit, notice } of ARMOR_CHAIN) {
    if ((valid & bit) === 0) continue;
    if ((occupiedMask & bit) === 0) return { kind: 'wield', slot: bit };
    block(bit, notice);
  }

  // ── Wrist / ring pairs — side-preferred with other-side fallback ──
  const wristValid = (valid & (EquipMask.WristWearLeft | EquipMask.WristWearRight)) !== 0;
  const ringValid = (valid & (EquipMask.FingerWearLeft | EquipMask.FingerWearRight)) !== 0;
  if (wristValid || ringValid) {
    const [prefer, other] = wristValid
      ? (side === UISlotSide.Left
        ? [EquipMask.WristWearLeft, EquipMask.WristWearRight]
        : [EquipMask.WristWearRight, EquipMask.WristWearLeft])
      : (side === UISlotSide.Left
        ? [EquipMask.FingerWearLeft, EquipMask.FingerWearRight]
        : [EquipMask.FingerWearRight, EquipMask.FingerWearLeft]);
    if ((occupiedMask & prefer) === 0) return { kind: 'wield', slot: prefer };
    if (allowOtherSide && equippedAt(prefer) !== item.id
      && (occupiedMask & other) === 0) {
      return { kind: 'wield', slot: other };
    }
    block(prefer, wristValid
      ? "You're already wearing jewelry on both wrists."
      : "You're already wearing jewelry on both hands.");
  }

  // ── Dual wield: left-side melee/missile/two-hander goes to the shield
  //    slot (decomp: valid & 0x2500000 && SLOT_SIDE_LEFT → valid = Shield) ──
  if ((valid & DUAL_WIELD_GROUP) !== 0 && side === UISlotSide.Left) {
    valid = EquipMask.Shield;
  }

  // ── Weapon ready slot (melee / missile / held / two-handed) ──
  const weaponBits = valid & WEAPON_GROUP;
  if (weaponBits !== 0) {
    if ((occupiedMask & WEAPON_GROUP) === 0) {
      const shieldItem = equippedAt(EquipMask.Shield);
      if (shieldItem !== 0 && blocksUseOfShield(item)) {
        // Two-hander / launcher / wand forces the shield off first.
        blockingId = shieldItem;
        blockingNotice = undefined;
      } else if (blockingId === 0) {
        // Retail also dequips mismatched-AmmoType ammo here; AmmoType is
        // not yet parsed client-side, so the server-side check covers it.
        return { kind: 'wield', slot: weaponBits };
      }
    } else {
      // Retail first tries a stack merge (throwing weapons); otherwise
      // the current weapon is the blocker and gets dequipped.
      const merge = tryMerge(equippedAt(WEAPON_GROUP));
      if (merge) return merge;
      block(WEAPON_GROUP);
    }
  }

  // ── Shield slot ──
  if ((valid & EquipMask.Shield) !== 0) {
    if ((occupiedMask & EquipMask.Shield) === 0) {
      return { kind: 'wield', slot: EquipMask.Shield };
    }
    block(EquipMask.Shield);
  }

  // ── Ammo slot ──
  if ((valid & EquipMask.MissileAmmo) !== 0) {
    if ((occupiedMask & EquipMask.MissileAmmo) === 0) {
      return { kind: 'wield', slot: EquipMask.MissileAmmo };
    }
    // Retail merges into the readied stack (AttemptMerge); a different
    // ammo is the blocker; the same ammo with no room is never dequipped —
    // "You cannot wield more %s" (NAME_PLURAL) when param_3 = 0.
    const ammoOccupant = equippedAt(EquipMask.MissileAmmo);
    const merge = tryMerge(ammoOccupant);
    if (merge) return merge;
    const occupantWcid = stackOf?.(ammoOccupant)?.weenieClassId;
    if (occupantWcid === undefined || occupantWcid !== item.weenieClassId) {
      block(EquipMask.MissileAmmo);
    } else {
      legalityNotice = AUTOWIELD_CANNOT_WIELD_MORE.replace(
        '%s', getPluralName(item.name ?? '', item.pluralName));
    }
  }

  // ── Clothes: shirt (ChestWear) / pants (UpperLegWear) / robe (both) ──
  //    (decomp block gated on valid & (Cloak | 0x1FF))
  const shirtBit = (valid & EquipMask.ChestWear) !== 0;
  const pantsBit = (valid & EquipMask.UpperLegWear) !== 0;
  const shirtOcc = (occupiedMask & EquipMask.ChestWear) !== 0;
  const pantsOcc = (occupiedMask & EquipMask.UpperLegWear) !== 0;
  if (shirtBit && pantsBit) {
    // Robe — retail refuses outright, no auto-dequip, message shown even
    // on double-click (not gated on the notice-suppression flag).
    if (shirtOcc || pantsOcc) {
      return {
        kind: 'rejected', reason: 'shirt-and-pants',
        notice: 'You must unwield your shirt and pants to wield that.',
      };
    }
    return { kind: 'wield', slot: EquipMask.ChestWear | EquipMask.UpperLegWear };
  }
  if (shirtBit) {
    if (!shirtOcc) return { kind: 'wield', slot: EquipMask.ChestWear };
    block(EquipMask.ChestWear);
  } else if (pantsBit) {
    if (!pantsOcc) return { kind: 'wield', slot: EquipMask.UpperLegWear };
    block(EquipMask.UpperLegWear);
  }

  return finishBlocked();
}

/** An auto-wield waiting on its blocker's dequip: the item to wield, the blocker, and the container the dequip sent it to. */
export interface PendingAutoWieldRetry {
  itemId: number;
  blockingId: number;
  /** Where the dequip's PutItemInContainer sent the blocker (the main pack, or a side pack when the main one is full). */
  containerId: number;
}

/**
 * Whether a server move (ServerSaysMoveItem: item → container) is the dequip an auto-wield waits on, so the wield is
 * tried again: CPlayerSystem::RecvNotice_ServerSaysMoveItem @ 00563260 (LAB_005633cf) retries AutoWield when the
 * blocker lands and the move's container is the one its dequip chose (`blockedID == param_5`), a side pack included.
 * Ours retried only for the main pack, so with the main pack full (111/102) the Leather Boots went into the Sack and the
 * Shoes were never wielded: "no answer from the server in 4 s" (Bulwark, 2026-10-16 07:31 and 12:24).
 */
export function autoWieldRetryDue(pending: PendingAutoWieldRetry | null, itemGuid: number, containerGuid: number): boolean {
  return !!pending && (itemGuid >>> 0) === (pending.blockingId >>> 0) && (containerGuid >>> 0) === (pending.containerId >>> 0);
}
