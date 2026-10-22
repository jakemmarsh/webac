/**
 * Item-shortcut toolbar restore with retail deferred resolution.
 *
 * BUG.item-shortcut-restore-runs-before-inventory — ACE always delivers
 * PlayerDescription before every inventory GameMessageCreateObject
 * (Player_Networking.cs SendSelf() enqueues PlayerDescription at :216/:220
 * before SendInventoryAndWieldedItems() at :226; PlayerDescription rides
 * GameMessageGroup.UIQueue which NetworkSession.cs:192-244 flushes fully
 * before CreateObject's SmartboxQueue). A restore that resolves each
 * shortcut's item at PlayerDescription time therefore ALWAYS misses — the
 * inventory map is deterministically empty at that point.
 *
 * Retail handles exactly this ordering: gmToolbarUI::UpdateFromPlayerDesc
 * @ 004bf810 (called from RecvNotice_PlayerDescReceived @ 004bf980) first
 * calls FlushShortcuts, then walks all 0x12 (18) player-module shortcut
 * slots calling AddShortcut for each non-zero objectId. AddShortcut
 * @ 004bd9a0 registers the slot's item by ID unconditionally and, when
 * ClientObjMaintSystem::GetWeenieObject(objectId) is still null (the item's
 * CreateObject hasn't arrived), stores the slot via
 * UIElement_UIItem::SetDelayedShortcutNum @ 004e1230 (m_delayedShortcutNum)
 * so the numeral/icon binding completes once the weenie object exists.
 *
 * This class is that deferred binding: entries whose item is already known
 * resolve immediately; the rest wait in a pending map keyed by objectId and
 * resolve as the owning items' CreateObjects land. Retail rejects a second
 * shortcut to an item that already has one (CreateShortcutToItem @ 004bdac0
 * duplicate check), so one objectId maps to at most one slot.
 */

/** One PlayerDescription shortcut record (ACE Shortcut.cs: Index u32 +
 *  ObjectId u32 + SpellId u16 + Layer u16). */
export interface ShortcutRecord {
  index: number;
  objectId: number;
}

/** The subset of InventoryItem the toolbar slot needs. */
export interface ShortcutItemInfo {
  iconDid?: number;
  name: string;
  /** CORE.18.c.a — the shortcut is a UIItem: IconData::RenderIcons' inputs. */
  itemType?: number;
  uiEffects?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
  /**
   * The shortcut's object is the player (the main pack): RenderIcons'
   * ACCWeenieObject::IsThePlayer branch draws the UIASSET PlayerIcon on the
   * Container backdrop instead of an iconDid.
   */
  isThePlayer?: boolean;
}

/** Retail slot count: UpdateFromPlayerDesc iterates 0x12 slots (two rows
 *  of 9; matches GameUI's 18 UIItem toolbar slots from layout 0x21000037). */
export const ITEM_SHORTCUT_SLOT_COUNT = 18;

/** gmToolbarUI's outbound shortcut events (CM_Character::Event_AddShortCut /
 *  Event_RemoveShortCut), sent when RemoveShortcut / AddShortcut run with
 *  their "tell the server" flag set. */
export interface ShortcutSink {
  add(index: number, objectId: number): void;
  remove(index: number): void;
}

/** What CreateShortcutToItem asks of the target weenie. */
export interface ShortcutTarget {
  /** ACCWeenieObject::IsOwnedByPlayer. */
  owned: boolean;
  /** The icon inputs, when the weenie is known (GetWeenieObject != null). */
  item?: ShortcutItemInfo;
  /** gmToolbarUI::IsShortcutEligible @ 004bd1d0 (default true). */
  eligible?: boolean;
  /** GetObjectNameWide — the name the refusal notices format in. */
  name?: string;
}

/**
 * gmToolbarUI::ListenToGlobalMessage @ 004be4e0: the Quickslot commands.
 * Quickslot 1-12 (0x10000042-4d) and 13-18 (0x10000132-137) use the slot,
 * Select Quickslot 1-12 (0x1000004e-59) and 13-18 (0x10000138-13d) select
 * its object — UseShortcut(slot, use).
 */
export function quickslotCommand(actionId: number): { slot: number; use: boolean } | null {
  if (actionId >= 0x10000042 && actionId <= 0x1000004d) return { slot: actionId - 0x10000042, use: true };
  if (actionId >= 0x1000004e && actionId <= 0x10000059) return { slot: actionId - 0x1000004e, use: false };
  if (actionId >= 0x10000132 && actionId <= 0x10000137) return { slot: actionId - 0x10000132 + 12, use: true };
  if (actionId >= 0x10000138 && actionId <= 0x1000013d) return { slot: actionId - 0x10000138 + 12, use: false };
  return null;
}

/**
 * gmToolbarUI::IsShortcutEligible @ 004bd1d0: a stuck object (pwd bitfield
 * 0x4, BF_STUCK) and a creature (InqType & 0x10) are refused unless the
 * ACCWeenieObject vtable +0x10 says yes, and a vendor's stock (container ==
 * ClientUISystem::vendorID) is always refused. That virtual is
 * ACCWeenieObject::IsPlayer @ 0058c890 (`pwd._bitfield >> 3 & 1`, BF_PLAYER;
 * the primary vtable @ 0x7e3ea0 read from acclient.exe: +0x10 = 0058c890,
 * +0x18 = InqType 0058c8d0), so a player, the main pack included, is
 * eligible. CreateShortcutToItem then asks IsOwnedByPlayer, which is true
 * for the player itself (IsOwnedByObject @ 0058ceb0: id == player_id).
 */
export function isShortcutEligible(o: { isPlayer: boolean; stuck: boolean; itemType: number; vendorItem?: boolean }): boolean {
  if (o.stuck && !o.isPlayer) return false;
  if ((o.itemType & 0x10) !== 0 && !o.isPlayer) return false;
  return !o.vendorItem;
}

/** ListenToGlobalMessage case 0x1000010d ("Create Shortcut"): CreateShortcutToItem(selectedID, -1, true, false). */
export const CREATE_SHORTCUT_ACTION = 0x1000010d;

/** acclient.exe .rdata literals CreateShortcutToItem raises through SendNotice_DisplayStringInfo(0x1a). */
export const shortcutIneligibleText = (name: string): string => `You cannot make a shortcut to the ${name}`;
export const shortcutDuplicateText = (name: string): string => `There is already a shortcut to the ${name}`;
export const SHORTCUT_NO_FREE_SLOTS_TEXT = 'There are no free shortcut slots';

export class ItemShortcutRestorer {
  /** objectId → toolbar slot index awaiting the item's CreateObject. */
  private pending = new Map<number, number>();
  /** gmToolbarUI::m_shortcutSlots — the object each of the 18 slots holds (0 = empty). */
  private slots: number[] = new Array(ITEM_SHORTCUT_SLOT_COUNT).fill(0);
  /**
   * The slots this era's toolbar has (eraClientRules().shortcutSlots; BUG.ac1999-spell-tabs):
   * 18 for end of retail, 9 for the 1999 tray (ShortCutManager::AddShortCut @ 0x586f00 refuses an
   * index past 8). Slots past it hold nothing, take nothing and are never sent.
   */
  private slotCount = ITEM_SHORTCUT_SLOT_COUNT;

  constructor(
    private setIcon: (index: number, iconDid: number | undefined, title: string, item?: ShortcutItemInfo) => void,
    private sink?: ShortcutSink,
  ) {}

  /** Set the era's slot count (1..18); any slot past it is emptied locally (nothing is sent). */
  setSlotCount(count: number): void {
    this.slotCount = Number.isInteger(count) ? Math.max(1, Math.min(ITEM_SHORTCUT_SLOT_COUNT, count)) : ITEM_SHORTCUT_SLOT_COUNT;
    for (let i = this.slotCount; i < ITEM_SHORTCUT_SLOT_COUNT; i++) {
      const id = this.slots[i];
      if (!id) continue;
      this.slots[i] = 0;
      if (this.pending.get(id) === i) this.pending.delete(id);
      this.setIcon(i, undefined, '');
    }
  }

  /** The slots this toolbar has. */
  get slotCountInUse(): number { return this.slotCount; }

  /** The first empty slot the toolbar has, or -1. */
  private firstEmpty(): number {
    for (let i = 0; i < this.slotCount; i++) if (!this.slots[i]) return i;
    return -1;
  }

  /** The slot holding `objectId`'s shortcut, or -1 (RemoveShortcut's ItemList_IsInList walk). */
  slotOf(objectId: number): number {
    return objectId ? this.slots.indexOf(objectId) : -1;
  }

  /** The object in slot `index` (0 = empty). */
  objectAt(index: number): number {
    return index >= 0 && index < this.slotCount ? this.slots[index] ?? 0 : 0;
  }

  /**
   * gmToolbarUI::RemoveShortcut @ 004bd450: find the slot holding the
   * object, flush it, and — when `send` — Event_RemoveShortCut(slot).
   * Returns the slot, or -1 when the object has no shortcut.
   */
  removeShortcut(objectId: number, send: boolean): number {
    const slot = this.slotOf(objectId);
    if (slot === -1) return -1;
    this.slots[slot] = 0;
    if (this.pending.get(objectId) === slot) this.pending.delete(objectId);
    this.setIcon(slot, undefined, '');
    if (send) this.sink?.remove(slot);
    return slot;
  }

  /**
   * gmToolbarUI::AddShortcut @ 004bd9a0: an out-of-range slot takes the
   * first empty one (none → nothing happens); a zero object is ignored.
   * The slot is flushed and bound to the object (deferred when the weenie is
   * not known yet — SetDelayedShortcutNum), and `send` raises
   * Event_AddShortCut(slot, object).
   */
  addShortcut(objectId: number, index: number, item: ShortcutItemInfo | undefined, send: boolean): void {
    let slot = index;
    if (slot < 0 || slot >= this.slotCount) {
      slot = this.firstEmpty();
      if (slot === -1) return;
    }
    if (!objectId) return;
    const prev = this.slots[slot];
    if (prev && this.pending.get(prev) === slot) this.pending.delete(prev);
    this.slots[slot] = objectId;
    if (item) {
      this.pending.delete(objectId);
      this.setIcon(slot, item.iconDid, item.name, item);
    } else {
      this.setIcon(slot, undefined, '');
      this.pending.set(objectId, slot);
    }
    if (send) this.sink?.add(slot, objectId);
  }

  /**
   * gmToolbarUI::CreateShortcutToItem @ 004bdac0 (objectId, index,
   * placeInBackpack = param_3, quiet = param_4). `target` is null when the
   * weenie is unknown (GetWeenieObject null → nothing). An ineligible object
   * is refused with "You cannot make a shortcut to the %s"; one the player
   * does not own is refused the same way unless `placeInBackpack`, which
   * asks CPlayerSystem::PlaceInBackpack (`pickUp`) and carries on only when
   * that request went out. Index -1 looks for the object already on the bar
   * ("There is already a shortcut to the %s") and an empty slot ("There are
   * no free shortcut slots"); otherwise the object's old shortcut is removed
   * and it is added at `index` (-1 = AddShortcut's first empty slot), both
   * told to the server. `quiet` suppresses every notice. Returns the 0x1a
   * notice to show, or null.
   */
  createShortcutToItem(
    objectId: number, index: number, target: ShortcutTarget | null,
    placeInBackpack: boolean, quiet: boolean, pickUp: () => boolean = () => false,
  ): string | null {
    if (!objectId || !target) return null;
    const name = target.name ?? target.item?.name ?? '';
    if (target.eligible === false) return quiet ? null : shortcutIneligibleText(name);
    if (!target.owned) {
      if (!placeInBackpack) return quiet ? null : shortcutIneligibleText(name);
      if (!pickUp()) return null;
    }
    if (index === -1) {
      if (this.slotOf(objectId) !== -1) return quiet ? null : shortcutDuplicateText(name);
      if (this.firstEmpty() === -1) return quiet ? null : SHORTCUT_NO_FREE_SLOTS_TEXT;
    }
    this.removeShortcut(objectId, true);
    this.addShortcut(objectId, index, target.item, true);
    return null;
  }

  /** gmToolbarUI::RemoveShortcutInSlotNum @ 004bd4f0: remove whatever slot `index` holds; returns that object (0 = none). */
  removeShortcutInSlot(index: number, send: boolean): number {
    const objectId = this.objectAt(index);
    if (!objectId) return 0;
    this.removeShortcut(objectId, send);
    return objectId;
  }

  /**
   * gmToolbarUI::GetFirstEmptyShortcutToTheRightOf @ 004bd560: the first
   * empty slot after `index`, else the first empty slot from 0 up to
   * `index` (inclusive), else -1.
   */
  firstEmptyRightOf(index: number): number {
    for (let i = index + 1; i < this.slotCount; i++) if (!this.slots[i]) return i;
    for (let i = 0; i <= index && i < this.slotCount; i++) if (!this.slots[i]) return i;
    return -1;
  }

  /** gmToolbarUI::IsShortcutSlotAvailable @ 004bd5e0. */
  isSlotAvailable(index: number): boolean {
    return index >= 0 && index < this.slotCount && !this.slots[index];
  }

  /** gmToolbarUI::m_lastShortcutNumDragged — the slot the shortcut in flight left (-1 = none). */
  private lastDragged = -1;
  /** The object of the shortcut in flight (the drag element's item; 0 = none). */
  private draggedObject = 0;

  /**
   * gmToolbarUI::RecvNotice_ItemListBeginDrag @ 004bd930: picking a shortcut
   * up removes it at once (told to the server) and remembers its slot; it
   * comes back only if it is dropped on a slot. Returns the object (0 = the
   * slot was empty, nothing happens).
   */
  beginShortcutDrag(index: number): number {
    const objectId = this.objectAt(index);
    if (!objectId) return 0;
    this.removeShortcut(objectId, true);
    this.lastDragged = index;
    this.draggedObject = objectId;
    return objectId;
  }

  /**
   * gmToolbarUI::HandleDropRelease @ 004be7c0, a real item (not an alias)
   * dropped on slot `index`: the slot's old shortcut is removed, the item is
   * made a shortcut there (CreateShortcutToItem(…, true, false): unowned
   * objects are picked up first), and the displaced object moves to the
   * first empty slot to the right. Returns the 0x1a notice, or null.
   */
  dropItemOnSlot(objectId: number, index: number, target: ShortcutTarget | null, pickUp: () => boolean): string | null {
    if (!objectId) return null;
    const displaced = this.removeShortcutInSlot(index, true);
    const notice = this.createShortcutToItem(objectId, index, target, true, false, pickUp);
    if (displaced && displaced !== objectId) {
      const to = this.firstEmptyRightOf(index);
      if (to !== -1) this.addShortcut(displaced, to, this.itemOf?.(displaced), true);
    }
    return notice;
  }

  /**
   * HandleDropRelease, a shortcut (DROPITEM_IS_SHORTCUT) dropped on slot
   * `index`: the slot's old object is removed, the dragged one is added
   * there, and the displaced one takes the slot the drag started from when
   * that is still free — a swap.
   */
  dropShortcutOnSlot(index: number): void {
    const objectId = this.draggedObject;
    this.draggedObject = 0;
    if (!objectId) return;
    const displaced = this.removeShortcutInSlot(index, true);
    this.addShortcut(objectId, index, this.itemOf?.(objectId), true);
    if (displaced && displaced !== objectId && this.isSlotAvailable(this.lastDragged)) {
      this.addShortcut(displaced, this.lastDragged, this.itemOf?.(displaced), true);
    }
    this.lastDragged = -1;
  }

  /** A shortcut drag ended anywhere but a slot: it stays removed (BeginDrag already told the server). */
  endShortcutDrag(): void {
    this.lastDragged = -1;
    this.draggedObject = 0;
  }

  /** ClientObjMaintSystem::GetWeenieObject for re-adds (the icon inputs; undefined = defer). */
  itemOf?: (objectId: number) => ShortcutItemInfo | undefined;

  private createShortcutToItemQuiet(objectId: number, index: number, target: ShortcutTarget): void {
    this.createShortcutToItem(objectId, index, target, false, true);
  }

  /**
   * gmToolbarUI::RecvNotice_FullMergingItem @ 004be9b0 — raised by
   * ItemHolder::AttemptMerge @ 005878f0 after UIAttemptMerge(src → dst):
   * the merged-away stack's shortcut is removed (told to the server) and,
   * when it had one, the destination stack takes that same slot.
   */
  fullMergingItem(srcId: number, dstId: number, dst: ShortcutTarget): void {
    const slot = this.removeShortcut(srcId, true);
    if (slot !== -1) this.createShortcutToItemQuiet(dstId, slot, dst);
  }

  /**
   * gmToolbarUI::RecvNotice_ServerSaysMoveItem @ 004bf2b0 — the server moved
   * (or, through ACCWeenieObject::Remove @ 0058dd20 → ServerSaysMoveItem(this,
   * 0), deleted) `objectId`: when a slot holds it and the weenie is gone or
   * no longer IsOwnedByPlayer (sold, given, dropped, stored in a chest, used
   * up), RemoveShortcutInSlotNum(slot, true) clears the slot and tells the
   * server (Event_RemoveShortCut). A move between the player's own packs
   * keeps it. Retail raises the notice only for an object the client knows
   * (ServerSaysMoveItem is an ACCWeenieObject method), so a slot still
   * waiting on its weenie (SetDelayedShortcutNum — a GDLE ContainID ahead of
   * the item's CreateObject at login) is not a removal. Returns the cleared
   * slot, or -1.
   */
  serverSaysMoveItem(objectId: number, ownedByPlayer: boolean): number {
    if (!objectId || ownedByPlayer) return -1;
    const slot = this.slotOf(objectId);
    if (slot === -1 || this.pending.get(objectId) === slot) return -1;
    this.removeShortcutInSlot(slot, true);
    return slot;
  }

  /**
   * PlayerDescription arrived. Mirrors UpdateFromPlayerDesc: flush every
   * slot first (a re-sent description replaces the whole bar — also clears
   * the previous character's icons after a switch), then bind each record,
   * resolving immediately when the item is already known and deferring
   * otherwise. Returns counts for the caller's log line.
   */
  restoreFromDescription(
    shortcuts: ShortcutRecord[],
    getItem: (objectId: number) => ShortcutItemInfo | undefined,
  ): { restored: number; deferred: number } {
    this.pending.clear();
    for (let i = 0; i < ITEM_SHORTCUT_SLOT_COUNT; i++) {
      this.slots[i] = 0;
      this.setIcon(i, undefined, '');
    }
    let restored = 0;
    let deferred = 0;
    for (const sc of shortcuts) {
      // Retail AddShortcut ignores out-of-range slots and zero objectIds
      // (`if ((pUVar1 != 0) && (param_1 != 0))`).
      if (sc.index < 0 || sc.index >= this.slotCount) continue;
      if (!sc.objectId) continue;
      this.slots[sc.index] = sc.objectId;
      const item = getItem(sc.objectId);
      if (item) {
        this.setIcon(sc.index, item.iconDid, item.name, item);
        restored++;
      } else {
        this.pending.set(sc.objectId, sc.index);
        deferred++;
      }
    }
    return { restored, deferred };
  }

  /**
   * An own-inventory item became known (its CreateObject landed). If a
   * shortcut slot was waiting on this guid, bind it now — the retail
   * m_delayedShortcutNum completion. Returns true when a slot resolved.
   */
  onItemKnown(objectId: number, item: ShortcutItemInfo): boolean {
    const slot = this.pending.get(objectId);
    if (slot === undefined) return false;
    this.pending.delete(objectId);
    if (this.slots[slot] !== objectId) return false;
    this.setIcon(slot, item.iconDid, item.name, item);
    return true;
  }

  /** Character switch/teardown — drop unresolved deferrals so the next
   *  character doesn't inherit stale assignments. */
  clear(): void {
    this.pending.clear();
    this.slots.fill(0);
  }

  /** Test/diagnostic visibility into the deferred set. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * The toolbar's half of every server move / delete handler (main.ts
 * `toolbarObjectMoved`): gmToolbarUI::RecvNotice_ServerSaysMoveItem @ 004bf2b0
 * with ownership read AFTER the move was applied — `held` is whether the
 * client still holds the object then (a drag-drop's optimistic DropItem has
 * already taken it out of the pack by the time 0x19A arrives). The player's
 * own id (the main pack) never moves. Returns the cleared slot, or -1.
 */
export function toolbarObjectMoved(bar: ItemShortcutRestorer, objectId: number, o: { isThePlayer: boolean; held: boolean }): number {
  if (o.isThePlayer) return -1;
  return bar.serverSaysMoveItem(objectId, o.held);
}
