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
   * BUG.ac1999-inventory-placement-order — each container's contents in order, kept the way
   * retail's CObjectInventory keeps them: an items list and a containers list (IDList) per
   * container, keyed by `listKey(containerId, packs)`. A slot on the wire is an index into one of
   * these lists, and a contain-in INSERTS there and shifts the rest: EoL ServerSaysContainID
   * @ 0058be40 / AddContent @ 0058cce0 → IDList::AddAtNum @ 005add20; the 1999
   * ACCWeenieObject_AddContent @ 0x004e26d0 clamps the slot to the count and inserts the same
   * way. Both servers keep the same lists: ACE Container.TryAddToInventory shifts every
   * PlacementPosition at or past the new one; AC1999 Container_InsertInventoryItem inserts into
   * m_Items / m_Packs.
   *
   * Pre-fix this was one guid → slot map with no shifting, so a pick-up at slot 0 tied with the
   * item already at 0 and drew second (after it, by arrival), and each later slot-0 add (give,
   * buy, loot) queued behind the earlier ones instead of going first.
   */
  private _lists: Map<string, number[]> = new Map();
  /** Which list (listKey) holds each guid. A guid is in at most one, as in retail. */
  private _listOf: Map<number, string> = new Map();

  private static listKey(containerId: number, packs: boolean): string {
    return `${containerId >>> 0}:${packs ? 'packs' : 'items'}`;
  }

  /** IDList::RemoveByID @ 005addf0 on whichever list holds the guid (ACCWeenieObject::RemoveContent @ 0058cd70). */
  private unlist(guid: number): void {
    const key = this._listOf.get(guid);
    if (key === undefined) return;
    const list = this._lists.get(key);
    const at = list ? list.indexOf(guid) : -1;
    if (list && at >= 0) list.splice(at, 1);
    this._listOf.delete(guid);
  }

  /** Replace one list (IDList::Clear @ 005ade60, then IDList::Add for each guid in order). */
  private setList(key: string, guids: readonly number[]): void {
    for (const g of this._lists.get(key) ?? []) {
      if (this._listOf.get(g) === key) this._listOf.delete(g);
    }
    const list: number[] = [];
    this._lists.set(key, list);
    for (const g of guids) {
      this.unlist(g);
      list.push(g);
      this._listOf.set(g, key);
    }
  }

  /**
   * ACCObjectMaint::ViewObjectContents @ 00558a70: a container's whole contents in order (the
   * PlayerDescription's ContentProfile list for the player at login, a ViewContents for one of
   * the player's packs). Both lists are cleared, then each entry goes to the end of the items
   * list (containerType 0) or of the containers list (a pack or a foci).
   */
  setContainerContents(containerId: number, entries: ReadonlyArray<{ guid: number; containerType: number }>): void {
    this.setList(InventoryManager.listKey(containerId, false), entries.filter((e) => e.containerType === 0).map((e) => e.guid));
    this.setList(InventoryManager.listKey(containerId, true), entries.filter((e) => e.containerType !== 0).map((e) => e.guid));
  }

  /** FAITHFUL.572 — set one container's items (or `packs`) list to `guids`, in order, replacing it. */
  setPlacementOrder(guids: readonly number[], containerId = 0, packs = false): void {
    this.setList(InventoryManager.listKey(containerId, packs), guids);
  }

  /**
   * FAITHFUL.573 — move an item to `newIndex` (clamped) in its own container's order. Retail's
   * UpdateObject of a contained item puts it first this way (ACE RecipeManager
   * MoveItemToFirstContainerSlot). Items of that container no list names yet join after the
   * listed ones, in arrival order, so the move is made against what is shown.
   */
  reorderItem(itemId: number, newIndex: number): void {
    const item = this.items.get(itemId);
    if (!item) return;
    const key = this._listOf.get(itemId) ?? InventoryManager.listKey(item.containerId, false);
    const order = [...(this._lists.get(key) ?? [])];
    for (const it of this.items.values()) {
      if (!this._listOf.has(it.id) && it.containerId === item.containerId) order.push(it.id);
    }
    const from = order.indexOf(itemId);
    const to = Math.max(0, Math.min(newIndex, order.length - 1));
    if (from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, itemId);
    this.setList(key, order);
  }

  /**
   * ACCWeenieObject::ServerSaysMoveItem @ 0058dbb0 for a contain-in (InventoryPutObjInContainer
   * 0x22, both eras): out of the list it was in (RemoveContent), then inserted at `slot` in the
   * container's items list, or its containers list when `packs` (the event's ContainerType is not
   * 0) — IDList::AddAtNum, which appends when the slot is past the end. Without a container the
   * item stays in the list it is in (or its own container's items list).
   */
  setSlotForItem(guid: number, slot: number, containerId?: number, packs = false): void {
    const key = containerId !== undefined
      ? InventoryManager.listKey(containerId, packs)
      : this._listOf.get(guid) ?? InventoryManager.listKey(this.items.get(guid)?.containerId ?? 0, false);
    this.unlist(guid);
    let list = this._lists.get(key);
    if (!list) { list = []; this._lists.set(key, list); }
    list.splice(Math.max(0, Math.min(slot >>> 0, list.length)), 0, guid);
    this._listOf.set(guid, key);
  }

  /**
   * webac#29 — a CreateObject (or re-sent create) of an object that names a container: retail's
   * ACCObjectMaint::SetWeenieDesc @ 00557a20 (1999: 0x004df510) looks the object up in that
   * container's list (GetPlaceInItemsList / GetPlaceInContainersList, -1 when absent), takes 0 when
   * it is not there, and calls ServerSaysMoveItem(container, place) → AddContent. So an object the
   * container already lists keeps its place, and one it doesn't goes FIRST. A guid listed under the
   * same container in either list counts as already there. True when the order changed.
   */
  containOnCreate(guid: number, containerId: number, packs = false): boolean {
    const cur = this._listOf.get(guid);
    if (cur === InventoryManager.listKey(containerId, false) || cur === InventoryManager.listKey(containerId, true)) return false;
    this.setSlotForItem(guid, 0, containerId, packs);
    return true;
  }

  /**
   * ServerSaysMoveItem with no container (a wield, 0x23): the item leaves its container's list
   * (RemoveContent), so the items after it move up and the server's later slots line up.
   */
  leaveContainer(guid: number): void {
    this.unlist(guid);
  }

  /** One container's list in order (guids the client may not hold yet included). */
  containerOrder(containerId: number, packs = false): number[] {
    return [...(this._lists.get(InventoryManager.listKey(containerId, packs)) ?? [])];
  }

  /**
   * Listed items first, by their index in their container's list; then items no list names, in
   * Map insertion (CreateObject arrival) order.
   */
  private sortByPlacement(items: InventoryItem[]): InventoryItem[] {
    if (this._listOf.size === 0) return items;
    const rank = new Map<number, number>();
    for (const list of this._lists.values()) list.forEach((g, i) => rank.set(g, i));
    return items.sort((a, b) => {
      const ai = rank.get(a.id);
      const bi = rank.get(b.id);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return 0;
    });
  }

  /**
   * Get all items in inventory, each container's in its list order (see {@link sortByPlacement}),
   * otherwise in Map insertion order (i.e. ObjectCreate arrival order).
   */
  getAll(): InventoryItem[] {
    return this.sortByPlacement([...this.items.values()]);
  }

  /** Get items in a specific container (0 = root), honoring placement order. */
  getByContainer(containerId: number): InventoryItem[] {
    return this.sortByPlacement([...this.items.values()].filter(i => i.containerId === containerId));
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
    // It left the player: out of its container's list (ServerSaysMoveItem → RemoveContent).
    this.unlist(id);
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
    this._lists.clear();
    this._listOf.clear();
  }
}
