/**
 * PaperDoll -- equipment paper doll display state management.
 *
 * Pure logic layer: no DOM manipulation. Tracks equipment slots
 * and their contents, syncing from the shared EquipmentSystem.
 */

import { EquipMask } from '@ac/shared';
import type { EquippedItem } from '@ac/shared';

export interface PaperDollSlot {
  mask: EquipMask;
  label: string;
  item: EquippedItem | null;
}

/** Slot definitions with human-readable labels for standard equipment positions. */
const SLOT_DEFINITIONS: Array<{ mask: EquipMask; label: string }> = [
  { mask: EquipMask.HeadWear, label: 'Head' },
  { mask: EquipMask.ChestArmor, label: 'Chest Armor' },
  { mask: EquipMask.ChestWear, label: 'Chest Wear' },
  { mask: EquipMask.AbdomenArmor, label: 'Abdomen Armor' },
  { mask: EquipMask.AbdomenWear, label: 'Abdomen Wear' },
  { mask: EquipMask.UpperArmArmor, label: 'Upper Arms' },
  { mask: EquipMask.UpperArmWear, label: 'Upper Arm Wear' },
  { mask: EquipMask.LowerArmArmor, label: 'Lower Arms' },
  { mask: EquipMask.LowerArmWear, label: 'Lower Arm Wear' },
  { mask: EquipMask.HandWear, label: 'Hands' },
  { mask: EquipMask.UpperLegArmor, label: 'Upper Legs' },
  { mask: EquipMask.UpperLegWear, label: 'Upper Leg Wear' },
  { mask: EquipMask.LowerLegArmor, label: 'Lower Legs' },
  { mask: EquipMask.LowerLegWear, label: 'Lower Leg Wear' },
  { mask: EquipMask.FootWear, label: 'Feet' },
  { mask: EquipMask.NeckWear, label: 'Neck' },
  { mask: EquipMask.WristWearLeft, label: 'Left Wrist' },
  { mask: EquipMask.WristWearRight, label: 'Right Wrist' },
  { mask: EquipMask.FingerWearLeft, label: 'Left Finger' },
  { mask: EquipMask.FingerWearRight, label: 'Right Finger' },
  { mask: EquipMask.MeleeWeapon, label: 'Main Hand' },
  { mask: EquipMask.Shield, label: 'Off Hand' },
  { mask: EquipMask.MissileWeapon, label: 'Missile Weapon' },
  { mask: EquipMask.MissileAmmo, label: 'Ammunition' },
  { mask: EquipMask.TrinketOne, label: 'Trinket' },
  { mask: EquipMask.Cloak, label: 'Cloak' },
];

export class PaperDoll {
  private slots: Map<EquipMask, PaperDollSlot> = new Map();
  private _visible = false;

  constructor() {
    for (const def of SLOT_DEFINITIONS) {
      this.slots.set(def.mask, {
        mask: def.mask,
        label: def.label,
        item: null,
      });
    }
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
  }

  toggle(): void {
    this._visible = !this._visible;
  }

  /**
   * Get all paper doll slots as an array.
   */
  getSlots(): PaperDollSlot[] {
    return [...this.slots.values()];
  }

  /**
   * Get a specific slot by its EquipMask.
   */
  getSlot(mask: EquipMask): PaperDollSlot | undefined {
    return this.slots.get(mask);
  }

  /**
   * Sync the paper doll slots from the EquipmentSystem's equipped item list.
   * Clears all slots first, then fills from the provided equipped items.
   */
  syncFromEquipment(equipped: EquippedItem[]): void {
    // Clear all slots
    for (const slot of this.slots.values()) {
      slot.item = null;
    }

    // Fill from equipped items
    for (const item of equipped) {
      const slot = this.slots.get(item.slot);
      if (slot) {
        slot.item = item;
      }
    }
  }

  /**
   * Check if a slot is filled with an item.
   */
  isSlotFilled(mask: EquipMask): boolean {
    const slot = this.slots.get(mask);
    return slot !== undefined && slot.item !== null;
  }

  /**
   * Get the count of currently equipped items.
   */
  get equippedCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.item !== null) count++;
    }
    return count;
  }
}
