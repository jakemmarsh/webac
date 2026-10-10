/**
 * EquipmentSystem — equipment slot management with wield requirements.
 *
 * Reference: ACE.Server/WorldObjects/Player_Equipment.cs
 *            ACE.Server/WorldObjects/Player_Inventory.cs:2125-2229
 *              (CheckWieldRequirement)
 */

import { EquipMask } from '../game-types.js';
import { WieldRequirementType } from '../ace-enums.js';
import type { InventoryItem } from './InventoryManager.js';

export interface EquippedItem extends InventoryItem {
  slot: EquipMask;
}

export interface WieldRequirement {
  /**
   * ACE WieldRequirementType enum value (per WieldRequirement.cs):
   * 1=Skill, 2=RawSkill, 3=Attrib, 4=RawAttrib, 5=SecondaryAttrib,
   * 6=RawSecondaryAttrib, 7=Level, 8=Training, 9=IntStat, 10=BoolStat,
   * 11=CreatureType, 12=HeritageType. Server source is PropertyInt 158/270/273/276.
   * Pre-FAITHFUL.103 the comment here read "(1=level, 2=skill, 7=attribute)"
   * — wrong per ACE — and `checkWieldRequirements` dispatched on `type === 1`
   * as Level. Fixed to use the symbolic WieldRequirementType.Level (=7).
   */
  type: number;
  skillOrAttr: number; // which skill or attribute (depends on type)
  difficulty: number;  // minimum value required
}

export interface EquipResult {
  success: boolean;
  error?: string;
  unequipped?: EquippedItem[]; // items that were unequipped to make room
}

export class EquipmentSystem {
  private equipped: Map<EquipMask, EquippedItem> = new Map();

  /** Get all equipped items. */
  getAll(): EquippedItem[] {
    return [...this.equipped.values()];
  }

  /** Get item in a specific slot. */
  getSlot(slot: EquipMask): EquippedItem | undefined {
    return this.equipped.get(slot);
  }

  /** Check if a slot is occupied. */
  isSlotOccupied(slot: EquipMask): boolean {
    return this.equipped.has(slot);
  }

  /** Get total burden of equipped items. */
  get totalBurden(): number {
    let total = 0;
    for (const item of this.equipped.values()) {
      total += item.burden;
    }
    return total;
  }

  /** Get total armor level from all equipped armor. */
  getTotalArmorLevel(armorLevelProperty: (item: EquippedItem) => number): number {
    let total = 0;
    for (const item of this.equipped.values()) {
      total += armorLevelProperty(item);
    }
    return total;
  }

  /**
   * Check wield requirements against character stats.
   * @param requirements - array of wield requirements from the item
   * @param getSkillValue - function to look up skill/attribute values
   * @param characterLevel - character's current level
   */
  checkWieldRequirements(
    requirements: WieldRequirement[],
    getSkillValue: (type: number, id: number) => number,
    characterLevel: number,
  ): { met: boolean; reason?: string } {
    for (const req of requirements) {
      if (req.type === WieldRequirementType.Level) {
        // Level requirement (kind=7 per ACE WieldRequirement.cs)
        if (characterLevel < req.difficulty) {
          return { met: false, reason: `Requires level ${req.difficulty}` };
        }
      } else {
        // Skill / attribute / vital / heritage / creature-type / training
        // requirement. Authoritative check is server-side via
        // CheckWieldRequirement (ACE Player_Inventory.cs:2125); this is the
        // client-side preview used by the UI.
        const value = getSkillValue(req.type, req.skillOrAttr);
        if (value < req.difficulty) {
          return { met: false, reason: `Requires ${req.skillOrAttr} of ${req.difficulty} (you have ${value})` };
        }
      }
    }
    return { met: true };
  }

  /**
   * Equip an item to the specified slot.
   *
   * `evictOverlaps` (default true) is the client's own optimistic equip: what
   * covers any of the slots comes off, as the server will move it. A wield the
   * SERVER reports (CreateObject with a wielder, WieldObject) passes false: the
   * server already decided what is worn, and a real conflict is taken off by
   * its own request first (the client's auto-dequip, ACE
   * Player_Inventory.cs:1664), each confirmed by the server — so a sibling
   * whose mask merely overlaps stays — a
   * starting shirt (…|AbdomenWear) and trousers (AbdomenWear|UpperLegWear|…)
   * are both worn, and evicting by overlap kept whichever arrived last
   * (BUG.paperdoll-overlapping-clothing-evicted, 2026-10-10).
   * @returns EquipResult with success status and any unequipped items
   */
  equipItem(item: InventoryItem, slot: EquipMask, evictOverlaps = true): EquipResult {
    const unequipped: EquippedItem[] = [];

    // An item is worn in one place: an earlier entry for it (the optimistic
    // equip under the slot the client chose, then the server's WieldObject
    // under the location it chose) goes, or the item is listed twice.
    for (const [s, eq] of this.equipped) if (eq.id === item.id) this.equipped.delete(s);

    // Whatever already covers any of these slots comes off (a pair of
    // leggings worn as UpperLeg|LowerLeg is replaced by the next pair, not
    // kept beside it).
    for (const [s, eq] of this.equipped) {
      if (s === slot || (evictOverlaps && ((s as number) & (slot as number)) !== 0)) {
        unequipped.push(eq);
        this.equipped.delete(s);
      }
    }

    const equipped: EquippedItem = { ...item, slot };
    this.equipped.set(slot, equipped);

    return { success: true, unequipped };
  }

  /**
   * GAP.10 — apply a server stack-size update to an equipped stack (arrows,
   * thrown weapons). equipItem stores a COPY of the inventory item, so the
   * SetStackSize flow (ACE UpdateAmmoAfterLaunch → GameMessageSetStackSize)
   * must update the equipment-slot copy too or the wielded ammo count goes
   * stale after every shot.
   * @returns true if an equipped item with that id was updated.
   */
  updateStackSize(itemId: number, stackSize: number): boolean {
    for (const item of this.equipped.values()) {
      if (item.id === itemId) {
        item.stackSize = stackSize;
        return true;
      }
    }
    return false;
  }

  /**
   * Mirror changed fields from the inventory record onto the equipped
   * copy (equipItem stores a COPY): UiEffects / icon updates on a worn item.
   * @returns true if an equipped item with that id was updated.
   */
  syncFrom(item: InventoryItem): boolean {
    let hit = false;
    for (const eq of this.equipped.values()) {
      if (eq.id !== item.id) continue;
      eq.uiEffects = item.uiEffects;
      eq.iconDid = item.iconDid;
      eq.iconOverlayDid = item.iconOverlayDid;
      eq.iconUnderlayDid = item.iconUnderlayDid;
      eq.structure = item.structure;
      eq.maxStructure = item.maxStructure;
      hit = true;
    }
    return hit;
  }

  /**
   * Unequip an item from a slot.
   * @returns the unequipped item, or undefined if slot was empty
   */
  unequipSlot(slot: EquipMask): EquippedItem | undefined {
    const item = this.equipped.get(slot);
    if (!item) return undefined;
    this.equipped.delete(slot);
    return item;
  }

  /**
   * Unequip a specific item by instance ID.
   */
  unequipItem(itemId: number): EquippedItem | undefined {
    for (const [slot, item] of this.equipped) {
      if (item.id === itemId) {
        this.equipped.delete(slot);
        return item;
      }
    }
    return undefined;
  }

  /** Check if a specific item is equipped (by instance ID). */
  isEquipped(itemId: number): boolean {
    for (const item of this.equipped.values()) {
      if (item.id === itemId) return true;
    }
    return false;
  }

  /** Get the slot an item is equipped in. */
  getItemSlot(itemId: number): EquipMask | undefined {
    for (const [slot, item] of this.equipped) {
      if (item.id === itemId) return slot;
    }
    return undefined;
  }

  /** Clear all equipment. */
  clear(): void {
    this.equipped.clear();
  }
}

/**
 * BUG.equip-unequip-optimistic-no-rollback — the client mutates
 * EquipmentSystem optimistically (ahead of the server's confirmation) so
 * the paperdoll feels responsive on drag/double-click/context-menu equip
 * and unequip. ACE rejects wield/unequip in several cases (CheckWield
 * Requirements failure, weapon collision, conflicting slot, IsBusy,
 * Stuck, over-burden, corpse target, TradeItemBeingTraded, AttunedItem,
 * pet-device target — see Player_Inventory.cs's
 * DoHandleActionGetAndWieldItem / HandleActionPutItemInContainer_Verify)
 * by sending GameEventInventoryServerSaveFailed(itemGuid) with NO
 * corrective wield/put event, so without tracking the optimistic change
 * the client's equipment state is left permanently diverged from the
 * server's. This tracker records what each optimistic mutation changed,
 * keyed by the item's own guid (matching the itemGuid ACE echoes on both
 * confirmation and rejection), so a rejection can be reverted and a
 * confirmation can discard the now-unneeded rollback record.
 */
export type PendingEquipmentAction =
  | { kind: 'equip'; targetSlot: EquipMask; evicted: EquippedItem | undefined }
  | { kind: 'unequip'; slot: EquipMask; item: EquippedItem };

export class OptimisticEquipmentTracker {
  private pending: Map<number, PendingEquipmentAction> = new Map();

  /** Record an optimistic equip: itemId was just placed into targetSlot, evicting `evicted` (if any). */
  recordEquip(itemId: number, targetSlot: EquipMask, evicted: EquippedItem | undefined): void {
    this.pending.set(itemId, { kind: 'equip', targetSlot, evicted });
  }

  /** Record an optimistic unequip: `item` was just removed from `slot`. */
  recordUnequip(itemId: number, slot: EquipMask, item: EquippedItem): void {
    this.pending.set(itemId, { kind: 'unequip', slot, item });
  }

  /** Server confirmed the action — the optimistic mutation no longer needs a rollback. */
  confirm(itemId: number): void {
    this.pending.delete(itemId);
  }

  /** Whether itemId has an outstanding optimistic mutation awaiting confirmation. */
  hasPending(itemId: number): boolean {
    return this.pending.has(itemId);
  }

  /**
   * Server rejected the action (InventoryServerSaveFailed). Reverts the
   * mutation on `equipment` if one is pending for this itemGuid.
   * @returns true if a rollback was applied.
   */
  rollback(itemId: number, equipment: EquipmentSystem): boolean {
    const action = this.pending.get(itemId);
    if (!action) return false;
    this.pending.delete(itemId);
    if (action.kind === 'equip') {
      equipment.unequipItem(itemId);
      if (action.evicted) equipment.equipItem(action.evicted, action.targetSlot);
    } else {
      equipment.equipItem(action.item, action.slot);
    }
    return true;
  }
}
