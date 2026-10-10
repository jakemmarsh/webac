/**
 * InventoryPanel -- grid-based inventory panel state management.
 *
 * Pure logic layer: no DOM manipulation. Tracks slot selection,
 * item layout, and aggregate stats for the inventory UI.
 * Syncs from the shared InventoryManager.
 */

import type { InventoryItem } from '@ac/shared';

export interface InventorySlot {
  item: InventoryItem | null;
  selected: boolean;
}

export class InventoryPanel {
  private slots: InventorySlot[] = [];
  private _selectedSlot = -1;
  private _visible = false;

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
  }

  toggle(): void {
    this._visible = !this._visible;
  }

  get selectedSlot(): number {
    return this._selectedSlot;
  }

  get selectedItem(): InventoryItem | null {
    if (this._selectedSlot < 0 || this._selectedSlot >= this.slots.length) {
      return null;
    }
    return this.slots[this._selectedSlot].item;
  }

  get itemCount(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (slot.item !== null) count++;
    }
    return count;
  }

  get totalBurden(): number {
    let total = 0;
    for (const slot of this.slots) {
      if (slot.item) {
        total += slot.item.burden * slot.item.stackSize;
      }
    }
    return total;
  }

  get totalValue(): number {
    let total = 0;
    for (const slot of this.slots) {
      if (slot.item) {
        total += slot.item.value * slot.item.stackSize;
      }
    }
    return total;
  }

  /**
   * Sync the panel slots from the InventoryManager's item list.
   * Rebuilds the slot array, preserving selection if the item still exists.
   */
  syncFromInventory(items: InventoryItem[]): void {
    const previousSelectedItemId =
      this._selectedSlot >= 0 && this._selectedSlot < this.slots.length
        ? this.slots[this._selectedSlot].item?.id ?? null
        : null;

    this.slots = items.map((item) => ({
      item,
      selected: false,
    }));

    // Re-select previous item if it still exists
    if (previousSelectedItemId !== null) {
      const newIndex = this.slots.findIndex(
        (s) => s.item !== null && s.item.id === previousSelectedItemId,
      );
      if (newIndex >= 0) {
        this._selectedSlot = newIndex;
        this.slots[newIndex].selected = true;
      } else {
        this._selectedSlot = -1;
      }
    } else {
      this._selectedSlot = -1;
    }
  }

  /**
   * Select a slot by index. Deselects the previously selected slot.
   */
  selectSlot(index: number): void {
    if (index < 0 || index >= this.slots.length) return;

    // Deselect previous
    if (this._selectedSlot >= 0 && this._selectedSlot < this.slots.length) {
      this.slots[this._selectedSlot].selected = false;
    }

    this._selectedSlot = index;
    this.slots[index].selected = true;
  }

  /**
   * Clear the current selection.
   */
  clearSelection(): void {
    if (this._selectedSlot >= 0 && this._selectedSlot < this.slots.length) {
      this.slots[this._selectedSlot].selected = false;
    }
    this._selectedSlot = -1;
  }

  /**
   * Get a slot by index, or null if out of range.
   */
  getSlot(index: number): InventorySlot | null {
    if (index < 0 || index >= this.slots.length) return null;
    return this.slots[index];
  }

  /**
   * Find the slot index containing an item with the given ID.
   * @returns slot index, or -1 if not found
   */
  findItemSlot(itemId: number): number {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].item !== null && this.slots[i].item!.id === itemId) {
        return i;
      }
    }
    return -1;
  }
}
