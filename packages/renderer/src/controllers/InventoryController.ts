/**
 * InventoryController -- item pickup/drop/equip/use pipeline for the renderer.
 *
 * Wraps the shared InventoryManager and EquipmentSystem from PlayerState,
 * providing a unified action interface with logging for the UI layer.
 * Pure logic: no DOM or Three.js.
 */

import { EquipMask } from '@ac/shared';
import type { InventoryItem, EquippedItem, EquipResult } from '@ac/shared';
import type { PlayerState } from '../player/PlayerState.js';

/* ------------------------------------------------------------------ */
/*  Public interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface ItemAction {
  type: 'pickup' | 'drop' | 'equip' | 'unequip' | 'use' | 'destroy' | 'give' | 'split' | 'stack';
  itemId: number;
  success: boolean;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  InventoryController                                                */
/* ------------------------------------------------------------------ */

export class InventoryController {
  private _playerState: PlayerState | null = null;
  private _actionLog: ItemAction[] = [];
  private _maxLogSize = 50;

  setPlayerState(state: PlayerState): void {
    this._playerState = state;
  }

  /* ── Item operations ────────────────────────────────────────────── */

  /**
   * Pick up an item and add it to the player's inventory.
   * Checks encumbrance before adding.
   */
  pickupItem(item: Omit<InventoryItem, 'id'>): ItemAction {
    if (!this._playerState) {
      return this._logAction('pickup', 0, false, 'No player state available.');
    }

    if (!this.canPickup(item.burden * item.stackSize)) {
      return this._logAction('pickup', 0, false, 'You are too encumbered to pick that up.');
    }

    const id = this._playerState.inventory.addItem(item);
    return this._logAction('pickup', id, true, `You pick up ${item.name}.`);
  }

  /**
   * Drop an item from inventory onto the ground.
   * Unequips the item first if it is currently equipped.
   */
  dropItem(itemId: number): ItemAction {
    if (!this._playerState) {
      return this._logAction('drop', itemId, false, 'No player state available.');
    }

    const item = this._playerState.inventory.getItem(itemId);
    if (!item) {
      return this._logAction('drop', itemId, false, 'Item not found in inventory.');
    }

    // If equipped, unequip first
    if (this._playerState.equipment.isEquipped(itemId)) {
      this._playerState.equipment.unequipItem(itemId);
    }

    const removed = this._playerState.inventory.removeItem(itemId);
    if (!removed) {
      return this._logAction('drop', itemId, false, 'Failed to drop item.');
    }

    return this._logAction('drop', itemId, true, `You drop ${removed.name}.`);
  }

  /**
   * Equip an item from inventory to a specific equipment slot.
   */
  equipItem(itemId: number, slot: EquipMask): ItemAction {
    if (!this._playerState) {
      return this._logAction('equip', itemId, false, 'No player state available.');
    }

    const item = this._playerState.inventory.getItem(itemId);
    if (!item) {
      return this._logAction('equip', itemId, false, 'Item not found in inventory.');
    }

    // BUG.eor-autowear-priority-pass — the client's own wield request takes
    // nothing off. Retail's UIAttemptWield @ 0058d590 only sends the event;
    // the paperdoll's inventoryMask / clothingPriorityMask change only when
    // the server moves an object (gmPaperDollUI::ServerSaysMoveItem
    // @ 004a4b50). AutoWear has already refused any wear whose ClothingPriority
    // overlaps a worn piece, and AutoWield frees its blocker with a server
    // move first, so nothing the server keeps worn may leave our record here.
    // Evicting by overlapping EquipMask bits (pre-fix) dropped a worn
    // Breeches (AbdomenWear|UpperLegWear) when a Tunic (Chest|Abdomen|
    // UpperArm) went on, and the next Pants were sent to ACE, which refused
    // "You must remove your Breeches to wield Pants" (prod 2026-10-23).
    const result: EquipResult = this._playerState.equipment.equipItem(item, slot, false);
    if (!result.success) {
      return this._logAction(
        'equip', itemId, false,
        result.error ?? 'Failed to equip item.',
      );
    }

    // Return unequipped items back to inventory root container
    if (result.unequipped) {
      for (const unequipped of result.unequipped) {
        // The item is already in inventory; just mark it as unequipped
        // (EquipmentSystem handles slot removal, item stays in InventoryManager)
      }
    }

    return this._logAction('equip', itemId, true, `You equip ${item.name}.`);
  }

  /**
   * Unequip an item from a specific slot back into inventory.
   */
  unequipItem(slot: EquipMask): ItemAction {
    if (!this._playerState) {
      return this._logAction('unequip', 0, false, 'No player state available.');
    }

    const item = this._playerState.equipment.unequipSlot(slot);
    if (!item) {
      return this._logAction('unequip', 0, false, 'No item equipped in that slot.');
    }

    return this._logAction('unequip', item.id, true, `You unequip ${item.name}.`);
  }

  /**
   * Use an item (e.g. consume food, read a scroll, activate an object).
   * The actual use-effect is application-specific; this logs the intent.
   */
  useItem(itemId: number): ItemAction {
    if (!this._playerState) {
      return this._logAction('use', itemId, false, 'No player state available.');
    }

    const item = this._playerState.inventory.getItem(itemId);
    if (!item) {
      return this._logAction('use', itemId, false, 'Item not found in inventory.');
    }

    // Consumables are removed after use (stackSize decremented)
    // For non-stackable items this is a no-op on the inventory side;
    // the caller decides whether to remove the item.
    return this._logAction('use', itemId, true, `You use ${item.name}.`);
  }

  /**
   * Destroy an item, permanently removing it from inventory and equipment.
   */
  destroyItem(itemId: number): ItemAction {
    if (!this._playerState) {
      return this._logAction('destroy', itemId, false, 'No player state available.');
    }

    const item = this._playerState.inventory.getItem(itemId);
    if (!item) {
      return this._logAction('destroy', itemId, false, 'Item not found in inventory.');
    }

    // Unequip if equipped
    if (this._playerState.equipment.isEquipped(itemId)) {
      this._playerState.equipment.unequipItem(itemId);
    }

    this._playerState.inventory.removeItem(itemId);
    return this._logAction('destroy', itemId, true, `You destroy ${item.name}.`);
  }

  /**
   * Split a stackable item into two stacks.
   */
  splitStack(itemId: number, amount: number): ItemAction {
    if (!this._playerState) {
      return this._logAction('split', itemId, false, 'No player state available.');
    }

    const item = this._playerState.inventory.getItem(itemId);
    if (!item) {
      return this._logAction('split', itemId, false, 'Item not found in inventory.');
    }

    if (!item.stackable) {
      return this._logAction('split', itemId, false, 'That item cannot be split.');
    }

    if (amount <= 0 || amount >= item.stackSize) {
      return this._logAction('split', itemId, false, 'Invalid split amount.');
    }

    const newId = this._playerState.inventory.splitStack(itemId, amount);
    if (newId === null) {
      return this._logAction('split', itemId, false, 'Failed to split stack.');
    }

    return this._logAction(
      'split', itemId, true,
      `You split ${item.name} into stacks of ${item.stackSize} and ${amount}.`,
    );
  }

  /* ── Queries ────────────────────────────────────────────────────── */

  /**
   * Check if the player can pick up an item with the given burden.
   * Compares current burden + item burden against the strength-based max.
   */
  canPickup(burden: number): boolean {
    if (!this._playerState) return false;
    return (this.currentBurden + burden) <= this.maxBurden;
  }

  /**
   * Find all inventory items matching a given weenie class ID.
   */
  getItemsOfType(weenieClassId: number): InventoryItem[] {
    if (!this._playerState) return [];
    return this._playerState.inventory.findByWeenieClass(weenieClassId);
  }

  /* ── Action log ─────────────────────────────────────────────────── */

  get actionLog(): ReadonlyArray<ItemAction> {
    return this._actionLog;
  }

  clearActionLog(): void {
    this._actionLog.length = 0;
  }

  /* ── Gold (Pyreal) management ──────────────────────────────────── */

  private static readonly PYREAL_WCID = 273;

  /** Get the player's total pyreal count. */
  getGold(): number {
    if (!this._playerState) return 0;
    const pyreals = this._playerState.inventory.findByWeenieClass(InventoryController.PYREAL_WCID);
    return pyreals.reduce((sum, p) => sum + p.stackSize, 0);
  }

  /** Add pyreals to the player's inventory. */
  addGold(amount: number): void {
    if (!this._playerState || amount <= 0) return;
    // Add a new pyreal stack (addItem will merge into existing if possible)
    this._playerState.inventory.addItem({
      weenieClassId: InventoryController.PYREAL_WCID,
      name: 'Pyreal',
      value: 1,
      burden: 0,
      stackSize: amount,
      maxStackSize: 25000,
      stackable: true,
      containerId: 0,
    });
  }

  /** Remove pyreals from the player's inventory. Returns false if not enough gold. */
  removeGold(amount: number): boolean {
    if (!this._playerState || amount <= 0) return true;
    const pyreals = this._playerState.inventory.findByWeenieClass(InventoryController.PYREAL_WCID);
    const total = pyreals.reduce((sum, p) => sum + p.stackSize, 0);
    if (total < amount) return false;

    let remaining = amount;
    for (const p of pyreals) {
      if (remaining <= 0) break;
      const removed = this._playerState.inventory.removeFromStack(p.id, remaining);
      remaining -= removed;
    }
    return true;
  }

  /** Remove the first item matching a weenie class ID from inventory. */
  removeItem(weenieClassId: number): boolean {
    if (!this._playerState) return false;
    const items = this._playerState.inventory.findByWeenieClass(weenieClassId);
    if (items.length === 0) return false;
    const item = items[0];
    // If equipped, unequip first
    if (this._playerState.equipment.isEquipped(item.id)) {
      this._playerState.equipment.unequipItem(item.id);
    }
    const removed = this._playerState.inventory.removeItem(item.id);
    return removed !== null;
  }

  /* ── Burden tracking ────────────────────────────────────────────── */

  /**
   * Total burden of all inventory items (including equipped items).
   */
  get currentBurden(): number {
    if (!this._playerState) return 0;
    return this._playerState.inventory.totalBurden;
  }

  /**
   * Maximum burden the player can carry — PlayerState.encumbranceCapacity:
   * ACE Player.GetEncumbranceCapacity (Player_Inventory.cs:46-51) over the
   * BUFFED Strength plus the Increased Carrying Capacity augmentation.
   *
   * STATS.burden-capacity-augs-buffs — the server's PropertyInt.
   * EncumbranceCapacity is NOT preferred any more: ACE sends it only as a
   * snapshot at augmentation time (AugmentationDevice.cs:122-123), so a later
   * Strength buff/debuff left it stale, and the retail client never reads it
   * (CACQualities::InqLoad @ 0058f130 recomputes from enchanted Strength).
   */
  get maxBurden(): number {
    if (!this._playerState) return 0;
    return this._playerState.encumbranceCapacity;
  }

  /* ── Internal helpers ───────────────────────────────────────────── */

  private _logAction(
    type: ItemAction['type'],
    itemId: number,
    success: boolean,
    message: string,
  ): ItemAction {
    const action: ItemAction = { type, itemId, success, message };
    this._actionLog.push(action);
    if (this._actionLog.length > this._maxLogSize) {
      this._actionLog.splice(0, this._actionLog.length - this._maxLogSize);
    }
    return action;
  }
}
