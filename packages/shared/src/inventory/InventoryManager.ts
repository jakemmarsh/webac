/**
 * InventoryManager — item storage with weight tracking and stacking.
 *
 * Reference: ACE.Server/WorldObjects/Player_Inventory.cs
 */

import { PropertyDataId, PropertyInt } from '../weenie-types.js';

export interface InventoryItem {
  id: number;            // unique instance ID
  weenieClassId: number; // weenie template ID
  name: string;
  /** CORE.10.e — WeenieHeaderFlag.PluralName from CreateObject; retail
   *  GetObjectName(NAME_APPROPRIATE) labels stacks of >=2 with this,
   *  falling back to client-side name+"s"/"es" when the server sent none
   *  (see shared getAppropriateName). */
  pluralName?: string;
  value: number;
  burden: number;        // weight per unit
  stackSize: number;
  maxStackSize: number;
  stackable: boolean;
  containerId: number;   // parent container ID (0 = player root)
  iconDid?: number;      // DAT texture ID for item icon (PropertyDataId.Icon = 8)
  validLocations?: number; // EquipMask bitmask of valid equip slots
  itemType?: number;     // ItemType bitmask from server
  guid?: number;         // server GUID (same as id when using forceId)
  uiEffects?: number;    // UiEffects flag mask — Magical/Poisoned/Fire/Frost/etc. (per ACE UiEffects.cs)
  usable?: number;       // ItemUseable bits (ACE Usable.cs) — high 16 (TargetMask) ≠ 0 ⇒ use-with-target item
  /** CORE.12 — ACE CombatUse.cs byte (Melee=1, Missile=2, Ammo=3, Shield=4,
   *  TwoHanded=5) from WeenieHeaderFlag.CombatUse. Drives the retail
   *  GetDefaultCombatMode weapon-slot check: a wielded weapon with
   *  CombatUse.Missile toggles into Missile mode, anything else Melee. */
  combatUse?: number;
  /** BUG.icon-overlay-underlay-dropped — WeenieHeaderFlag.IconOverlay DID,
   *  composited as a small badge in the icon's top-right corner (Aetheria
   *  tier number). 0/undefined = no overlay. */
  iconOverlayDid?: number;
  /** BUG.icon-overlay-underlay-dropped — WeenieHeaderFlag2.IconUnderlay
   *  DID, composited full-size behind the base icon (rare-item glow).
   *  0/undefined = no underlay. */
  iconUnderlayDid?: number;
  /** BUG.cooldown-id-duration-discarded — WeenieHeaderFlag2.Cooldown:
   *  ACE SharedCooldown group id; while recharging the player carries a
   *  cooldown enchantment with spell id 0x8000 + this, which drives the
   *  retail decile meter on the icon (see renderer ui/cooldownMeter.ts).
   *  0/undefined = item has no use cooldown. */
  cooldownId?: number;
  /** BUG.cooldown-id-duration-discarded — WeenieHeaderFlag2.CooldownDuration:
   *  full recharge seconds (ACE PropertyFloat.CooldownDuration), the decile
   *  meter's denominator. 0/undefined = not sent. */
  cooldownDuration?: number;
  /** BUG.structure-maxstructure-discarded — WeenieHeaderFlag.Structure
   *  ushort (ACE PropertyInt.Structure = 92): uses remaining on a
   *  limited-use item (healing kit, lockpick, mana stone). Numerator of
   *  the retail icon uses-remaining bar; 0 is meaningful (spent item,
   *  empty bar). undefined = not sent. */
  structure?: number;
  /** BUG.structure-maxstructure-discarded — WeenieHeaderFlag.MaxStructure
   *  ushort (ACE PropertyInt.MaxStructure = 91): total uses when fresh.
   *  Retail shows the bar only when this is > 0 and structure/maxStructure
   *  != 1.0 (UIElement_UIItem::UpdateStructureDisplay @ 004e17a0).
   *  0/undefined = item has no uses meter. */
  maxStructure?: number;
  /** BUG.weenie-targettype-discarded — WeenieHeaderFlag.TargetType uint
   *  (ACE PropertyInt.TargetType = 94): ItemType bitmask of legal
   *  use-with targets. Drives the retail client-side compatibility gate
   *  (ItemHolder::TargetCompatibleWithObject @ 00587520) before a
   *  UseWithTarget request is sent. 0/undefined = no restriction. */
  targetType?: number;
  /** BUG.clothingpriority-never-lands — WeenieHeaderFlag.Priority uint
   *  (ACE item.ClothingPriority, a CoverageMask): retail's layer-blend
   *  order for overlapping equipped surfaces on the paperdoll (cloak
   *  under armor). Flag written only when non-null server-side, so
   *  undefined = not sent (a real 0 is preserved). No renderer consumer
   *  yet — the layer-blend pass itself is a separate gap-audit item. */
  clothingPriority?: number;
  /** WeenieHeaderFlag.AmmoType — the ammunition a launcher uses / an ammo is. */
  ammoType?: number;
  /** CORE.17.o.a — the container's fixed grid size when it is opened as a
   *  side pack: WeenieHeaderFlag.ItemsCapacity from CreateObject, kept only
   *  for an Openable container (ObjectDescriptionFlag 0x1). Retail
   *  ItemList_UpdateContainerListSize @ 004e39e0 sets the list's
   *  0x10000015 attribute to it and UpdateFixedSlots @ 004e3910 sizes the
   *  list to exactly that many cells (UpdateEmptySlots @ 004e3700 pads the
   *  visible area only while the attribute is -1). undefined = not an
   *  openable container (visible-area padding); 0 = openable but no
   *  capacity on the wire (the retail unpack default); negative = the
   *  world DB's -1 (signed char on the wire), padding like retail. */
  itemsCapacity?: number;
  /** RECON.wielded-item-objdesc — the item's own CreateObject visual desc
   *  (PhysicsDesc setup + scale, ObjDesc palettes / texture maps / part
   *  swaps). Retail parents the item's own CPhysicsObj when it is held
   *  (SmartBox::DoParentEvent @ 00452290), so the held mesh is built from
   *  this. undefined = the CreateObject carried no setup. */
  visualDesc?: {
    setupId: number;
    objScale: number;
    basePalette: number;
    subPalettes: { paletteId: number; offset: number; length: number }[];
    textureChanges: { partIndex: number; oldTexture: number; newTexture: number }[];
    animPartChanges: { partIndex: number; partId: number }[];
    /** PhysicsDesc PhysicsState (LightingOn lights a held torch). */
    physicsState?: number;
    /** PhysicsDesc PhysicsScriptTable: PlayScripts on the held item. */
    peTableId?: number;
  };
  /** CORE.17.k.b.b.a.g.e — WeenieHeaderFlag.Spell ushort (ACE
   *  PropertyDataId.Spell): the item's built-in spell. The spell bar's
   *  endowment icon (gmSpellcastingUI::UpdateEndowmentIcon @ 004c6120) shows
   *  the wielded caster's one. 0/undefined = none. */
  spellDid?: number;
  /** CORE.17.k.b.b.c.c.a.a.c.a.a.a — WeenieHeaderFlag.MaterialType uint
   *  (ACE PropertyInt.MaterialType): PublicWeenieDesc._material_type, the
   *  salvage panel's IsItemSuitable input. 0/undefined = none. */
  materialType?: number;
  /** WeenieHeaderFlag.Workmanship float (ACE WorldObject.Workmanship): an item's
   *  workmanship, a salvage bag's average (ItemWorkmanship / NumItemsInMaterial).
   *  undefined = not sent. */
  workmanship?: number;
  /** PublicWeenieDesc._hook_type: the housing-hook mounts this item fits
   *  (ItemHolder::CheckHookStatus @ 00586e90). 0/undefined = none. */
  hookType?: number;
  /** CORE.17.k.b.b.c.c.a.a.c.a.a.a — the PublicWeenieDesc bitfield
   *  (ACE ObjectDescriptionFlag); the salvage panel refuses a Retained
   *  (0x01000000) item. undefined = not known. */
  objectDescFlags?: number;
}

export class InventoryManager {
  private items: Map<number, InventoryItem> = new Map();
  private _nextId = 1;
  /**
   * FAITHFUL.572 — guid → desired slot index, set from PlayerDescription's
   * inventory placement block at login. Items present here render first
   * in the order their index implies; items not present (e.g. picked up
   * mid-session before a save) sort after, in arrival order.
   */
  private _placementOrder: Map<number, number> = new Map();

  /**
   * FAITHFUL.572 — apply the inventory placement order from the server's
   * PlayerDescription. The guids array is the authoritative ordering the
   * user dragged into during their last session; ACE persists this via
   * `PlacementPosition` and ships it at login per
   * `reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs:401-416`.
   * Replaces any prior placement entirely.
   */
  setPlacementOrder(guids: number[]): void {
    this._placementOrder = new Map();
    for (let i = 0; i < guids.length; i++) {
      this._placementOrder.set(guids[i], i);
    }
  }

  /**
   * FAITHFUL.573 — relocate an item to a new slot in the local placement
   * order so the inventory grid updates immediately on drag-drop. Mirrors
   * the optimistic-local-update pattern used by other inventory mutations
   * (the authoritative PlacementPosition save ships to ACE via
   * `GameActionPutItemInContainer` per
   * `reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionPutItemInContainer.cs:9-13`,
   * but waiting for the server round-trip would leave the cell stale
   * until the next CreateObject re-emit at login).
   *
   * Algorithm: take the current sorted item list, splice the source item
   * out, splice it in at `newIndex` (clamped to [0, length-1]), then
   * rebuild `_placementOrder` so every visible item has an explicit
   * index. Items missing from the prior order (picked up mid-session
   * with no PlacementPosition) get included in their pre-sort position
   * so they participate in the ordering too.
   */
  reorderItem(itemId: number, newIndex: number): void {
    if (!this.items.has(itemId)) return;
    const sorted = this.getAll();
    const fromIndex = sorted.findIndex(i => i.id === itemId);
    if (fromIndex === -1) return;
    const clampedTarget = Math.max(0, Math.min(newIndex, sorted.length - 1));
    if (fromIndex === clampedTarget) return;
    const [moved] = sorted.splice(fromIndex, 1);
    sorted.splice(clampedTarget, 0, moved);
    this.setPlacementOrder(sorted.map(i => i.id));
  }

  /**
   * BUG.inventory-put-slot-itemtype-unused — upsert a single guid→slot
   * entry into the placement order for a live server-confirmed move
   * (pickup, vendor buy, trade, corpse loot, server-side reshuffle), sent
   * via `GameEventItemServerSaysContainId.PlacementPosition` per
   * `reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventItemServerSaysContainId.cs:10-13`.
   * Unlike {@link setPlacementOrder}, this does not replace the whole
   * order — only the moved item's slot is updated, so other items'
   * saved positions (from login or earlier live moves) are preserved.
   */
  setSlotForItem(guid: number, slot: number): void {
    this._placementOrder.set(guid, slot);
  }

  /**
   * Sort comparator that honors {@link setPlacementOrder} when set:
   * items with a saved index come first (in index order), then items
   * without a saved index in their original Map insertion order.
   */
  private placementCompare(a: InventoryItem, b: InventoryItem): number {
    const ai = this._placementOrder.get(a.id);
    const bi = this._placementOrder.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return 0;
  }

  /**
   * Get all items in inventory, ordered per the server-supplied placement
   * order ({@link setPlacementOrder}) when one is set, otherwise in
   * Map insertion order (i.e. ObjectCreate arrival order).
   */
  getAll(): InventoryItem[] {
    const items = [...this.items.values()];
    if (this._placementOrder.size === 0) return items;
    return items.sort((a, b) => this.placementCompare(a, b));
  }

  /** Get items in a specific container (0 = root), honoring placement order. */
  getByContainer(containerId: number): InventoryItem[] {
    const items = [...this.items.values()].filter(i => i.containerId === containerId);
    if (this._placementOrder.size === 0) return items;
    return items.sort((a, b) => this.placementCompare(a, b));
  }

  /** Get an item by instance ID. */
  getItem(id: number): InventoryItem | undefined {
    return this.items.get(id);
  }

  /**
   * BUG.structure-maxstructure-discarded — apply a
   * GameMessagePublicUpdatePropertyInt broadcast to the inventory item it
   * targets, so the icon uses-remaining bar drains live as uses are
   * consumed. ACE emit sites: Healer.cs:191 (healing kit use), Lock.cs:94
   * (lockpick use), PetDevice.cs:94 (pet summon) — each sends
   * PropertyInt.Structure (92) with the new remaining-uses count;
   * PetDevice.cs:576 refills via the same key. MaxStructure (91) is
   * accepted for completeness (tinkering recipes can raise it).
   *
   * Returns true when a tracked item's field changed (callers mark the
   * inventory UI dirty), false for unknown guids or unrelated keys.
   */
  applyPublicPropertyInt(guid: number, key: number, value: number): boolean {
    const item = this.items.get(guid);
    if (!item) return false;
    if (key === PropertyInt.Structure) { item.structure = value; return true; }
    if (key === PropertyInt.MaxStructure) { item.maxStructure = value; return true; }
    // ManaStone.SetUiEffect (ACE ManaStone.cs:52) and recipes
    // (RecipeManager.cs:737) re-flag a held item's UiEffects.
    if (key === PropertyInt.UiEffects) { item.uiEffects = value; return true; }
    return false;
  }

  /**
   * A GameMessagePublicUpdatePropertyDataID for a held item: its icon,
   * overlay or underlay (ACE CorePlating.cs:186/294 sets a pack item's
   * IconOverlay with no UpdateObject after). Our own items have no
   * ServerObject, so this is their only mirror. Returns true on a change.
   */
  applyPublicPropertyDataId(guid: number, key: number, value: number): boolean {
    const item = this.items.get(guid);
    if (!item) return false;
    if (key === PropertyDataId.Icon) { item.iconDid = value; return true; }
    if (key === PropertyDataId.IconOverlay) { item.iconOverlayDid = value || undefined; return true; }
    if (key === PropertyDataId.IconUnderlay) { item.iconUnderlayDid = value || undefined; return true; }
    return false;
  }

  /** Get total count of items. */
  get count(): number {
    return this.items.size;
  }

  /** Get total burden (weight) of all items. */
  get totalBurden(): number {
    let total = 0;
    for (const item of this.items.values()) {
      total += item.burden * item.stackSize;
    }
    return total;
  }

  /** Get total value of all items. */
  get totalValue(): number {
    let total = 0;
    for (const item of this.items.values()) {
      total += item.value * item.stackSize;
    }
    return total;
  }

  /**
   * Add an item to inventory.
   * If stackable and a matching stack exists, merge into existing stack.
   * @param item - item data (without id)
   * @param forceId - optional pre-set ID (e.g. server GUID). If not provided, auto-generates.
   * @returns the item instance ID
   */
  addItem(item: Omit<InventoryItem, 'id'>, forceId?: number): number {
    // GAP.19 — server-authoritative items (forceId = wire guid) must NEVER
    // auto-merge locally: the server already decided stacking and reports
    // it via SetStackSize / CreateObject / RemoveObject. Pre-fix, the new
    // stack a StackableSplit creates was folded into the source stack
    // client-side and its guid dropped, silently corrupting stack counts
    // and orphaning the server's stack (unusable in later drags/merges).
    // Local auto-merge remains for the guid-less legacy/solo path.
    if (forceId === undefined && item.stackable && item.stackSize > 0) {
      for (const existing of this.items.values()) {
        if (existing.weenieClassId === item.weenieClassId &&
            existing.containerId === item.containerId &&
            existing.stackable &&
            existing.stackSize < existing.maxStackSize) {
          const canAdd = existing.maxStackSize - existing.stackSize;
          const toAdd = Math.min(canAdd, item.stackSize);
          existing.stackSize += toAdd;
          if (toAdd >= item.stackSize) {
            return existing.id; // Fully merged
          }
          // Partially merged — create new item with remainder
          item = { ...item, stackSize: item.stackSize - toAdd };
        }
      }
    }

    const id = forceId ?? this._nextId++;
    this.items.set(id, { ...item, id });
    return id;
  }

  /**
   * Remove an item from inventory.
   * @returns the removed item, or undefined if not found
   */
  removeItem(id: number): InventoryItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    return item;
  }

  /**
   * Remove a quantity from a stack. If quantity >= stackSize, removes the item entirely.
   * @returns actual quantity removed
   */
  removeFromStack(id: number, quantity: number): number {
    const item = this.items.get(id);
    if (!item) return 0;

    if (quantity >= item.stackSize) {
      this.items.delete(id);
      return item.stackSize;
    }

    item.stackSize -= quantity;
    return quantity;
  }

  /**
   * Split a stack into two items.
   * @returns the new item's ID, or null if split failed
   */
  splitStack(id: number, splitAmount: number): number | null {
    const item = this.items.get(id);
    if (!item || !item.stackable) return null;
    if (splitAmount <= 0 || splitAmount >= item.stackSize) return null;

    item.stackSize -= splitAmount;
    const newId = this._nextId++;
    this.items.set(newId, {
      ...item,
      id: newId,
      stackSize: splitAmount,
    });
    return newId;
  }

  /**
   * Merge two stacks of the same item type.
   * @returns true if merge succeeded
   */
  mergeStacks(sourceId: number, targetId: number): boolean {
    const source = this.items.get(sourceId);
    const target = this.items.get(targetId);
    if (!source || !target) return false;
    if (source.weenieClassId !== target.weenieClassId) return false;
    if (!source.stackable || !target.stackable) return false;

    const canAdd = target.maxStackSize - target.stackSize;
    if (canAdd <= 0) return false;

    const toAdd = Math.min(canAdd, source.stackSize);
    target.stackSize += toAdd;
    source.stackSize -= toAdd;

    if (source.stackSize <= 0) {
      this.items.delete(sourceId);
    }
    return true;
  }

  /**
   * Move an item to a different container.
   */
  moveToContainer(itemId: number, containerId: number): boolean {
    const item = this.items.get(itemId);
    if (!item) return false;
    item.containerId = containerId;
    return true;
  }

  /**
   * Find items by weenie class ID.
   */
  findByWeenieClass(weenieClassId: number): InventoryItem[] {
    return [...this.items.values()].filter(i => i.weenieClassId === weenieClassId);
  }

  /**
   * Check if inventory contains at least `count` of a given weenie class.
   */
  hasItem(weenieClassId: number, count = 1): boolean {
    let total = 0;
    for (const item of this.items.values()) {
      if (item.weenieClassId === weenieClassId) {
        total += item.stackSize;
        if (total >= count) return true;
      }
    }
    return false;
  }

  /** Clear all items. */
  clear(): void {
    this.items.clear();
  }
}
