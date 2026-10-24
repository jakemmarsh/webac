import { ContainerType, ItemType, ObjectDescriptionFlag } from '@ac/shared';

/**
 * CORE.17.o.b — UIElement_ItemList::ItemList_UpdateContainerListSize @
 * 004e39e0: the list parented to a container takes that container's
 * pwd._itemsCapacity, except that a container whose bitfield lacks Openable
 * (0x1) and is not the player is a ZERO-cell list. The result drives the
 * list: >= 0 → attribute 0x10000015 = capacity + UpdateFixedSlots (exactly
 * that many cells); -1 → UpdateEmptySlots (visible-area padding).
 */
export function itemListCapacity(objectDescFlags: number, itemsCapacity: number, isPlayer = false): number {
  if (!isPlayer && (objectDescFlags & ObjectDescriptionFlag.Openable) === 0) return 0;
  return itemsCapacity;
}

/**
 * CORE.18.c — the cell count of a horizontal UIElement_ItemList row whose
 * size ItemList_UpdateContainerListSize @ 004e39e0 set to `capacity`:
 * >= 0 → UpdateFixedSlots @ 004e3910 (exactly that many cells; never fewer
 * than the objects it lists); -1 → UpdateEmptySlots @ 004e3700's p95 = -1
 * arm: while n cells take less than the view, (viewW − n·cellW) / cellW
 * empty UIItems (state 0x1000001c) are appended — the list fills its
 * visible width. The open-container strip's nested list 0x10000067 is such a
 * row (p95 = -1, cell template 0x1000033f: 36 px): at the dock's 480 px a
 * chest (ContainersCapacity -1) shows 13 empty cells, as the retail frame
 * does.
 */
export function horizontalListCellCount(itemCount: number, capacity: number, viewW: number, cellW: number): number {
  if (capacity >= 0) return Math.max(capacity, itemCount);
  const used = itemCount * cellW;
  return used < viewW ? itemCount + Math.floor((viewW - used) / cellW) : itemCount;
}

/**
 * BUG.viewcontents-containertype-discarded — state for the currently open
 * external container (chest/corpse/hook), including nested containers.
 *
 * Mirrors the retail client's per-object CObjectInventory split
 * (ACCObjectMaint::ViewObjectContents @00558a70 in
 * reference/client-eol/decomp/acclient-decompiled.c): every ContentProfile
 * whose m_uContainerProperties is non-zero (ContainerType.Container = 1 or
 * ContainerType.Foci = 2, per ACE ContainerType.cs) goes into a separate
 * _containersList, so a nested pack/foci found inside a chest or corpse is
 * distinguishable from a plain item and can be viewed on its own.
 *
 * ACE's Container.SendInventory (Container.cs:786-808) sends, in order:
 *   1. GameEventViewContents for the opened container itself,
 *   2. one GameEventViewContents for EACH nested container inside it,
 *   3. CreateObject messages for all items (including nested contents).
 * Pre-fix, step 2 clobbered the whole panel state (each ViewContents reset
 * openContainerGuid), so a chest holding a pack showed only the pack's
 * contents. This tracker routes a ViewContents for an already-tracked
 * nested container into that container's own item list instead.
 */

export interface OpenContainerItem {
  guid: number;
  name: string;
  /** CORE.10.e — WeenieHeaderFlag.PluralName ('' = not sent); stack rows
   *  of >=2 label with it per retail GetObjectName(NAME_APPROPRIATE). */
  pluralName: string;
  iconDid: number;
  stackSize: number;
  /** Direct parent: the open container's guid, or a nested container's guid. */
  containerId: number;
  /**
   * True for ContainerType.Container / ContainerType.Foci per the
   * authoritative ViewContents entry; falls back to the CreateObject
   * ItemType.Container bit when no ViewContents entry was seen.
   */
  isContainer: boolean;
  /** CORE.18.c.a — what IconData::RenderIcons reads besides the icon DID
   *  (ITEM_TYPE backdrop, UiEffects tint, custom overlay / underlay). */
  itemType?: number;
  uiEffects?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
  /**
   * CORE.17.o.b — the resolved list capacity of a nested container
   * (itemListCapacity of its CreateObject bitfield + ItemsCapacity):
   * >= 0 fixed cells, -1 padding. Undefined for a plain item or a
   * container whose CreateObject has not arrived.
   */
  itemsCapacity?: number;
}

/**
 * BUG.stack-merge-not-found — the server messages retail's UIQueueManager
 * hands to ACCWeenieObject::ServerSaysMoveItem @ 0058dbb0 (whose param_5 = 1
 * raises RecvNotice_ServerSaysMoveItem, and UIElement_ItemList::RecvNotice_
 * ServerSaysMoveItem @ 004e5110 re-lists the object). The same messages in all
 * three eras (Inventory1999 maps the 1999 server's 0x22 / 0x23 / 0x24 / 0x19A
 * onto them):
 *   0x0022 ContainID          → ServerSaysMoveItem(container, slot, …)
 *   0x0023 WieldObject        → ServerSaysMoveItem(0, 0, wielder, location): no container
 *   0x019A PutObjectIn3D      → ServerSaysMoveItem(0, 0, 0, 0, 1)
 *   0x0024 InventoryRemove    → ACCWeenieObject::ServerSaysRemove @ 0058e4c0 = ServerSaysMoveItem(0, 0, 0, 0, 1)
 *   0xF747 DeleteObject       → ObjectBeingDeleted @ 0058e4d0 → Remove @ 0058dd20 = ServerSaysMoveItem(0, …)
 * ACE ends a merge that uses up a corpse's or chest's stack with only 0x0024
 * for it (Player_Inventory.cs:3096; the contained stack's Destroy broadcasts
 * nothing), so before this the stack stayed in the strip and every later
 * merge of it drew "Source stack not found!".
 */
export type ServerMoveMessage =
  | { kind: 'containId'; containerGuid: number }
  | { kind: 'wield' }
  | { kind: 'putIn3D' }
  | { kind: 'remove' }
  | { kind: 'delete' };

/** The _containerID ServerSaysMoveItem gives the object for `message` (0 = in no container). */
export function serverMoveContainer(message: ServerMoveMessage): number {
  return message.kind === 'containId' ? message.containerGuid >>> 0 : 0;
}

interface TrackedData {
  name: string;
  pluralName: string;
  iconDid: number;
  stackSize: number;
  itemType: number;
  uiEffects?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
}

/** CORE.18.c.a — the RenderIcons inputs a tracked object carries. */
type IconLook = { uiEffects?: number; iconOverlayDid?: number; iconUnderlayDid?: number };
function iconLookOf(d: IconLook): IconLook {
  const out: IconLook = {};
  if (d.uiEffects) out.uiEffects = d.uiEffects;
  if (d.iconOverlayDid) out.iconOverlayDid = d.iconOverlayDid;
  if (d.iconUnderlayDid) out.iconUnderlayDid = d.iconUnderlayDid;
  return out;
}

export class OpenContainerTracker {
  private mainGuid = 0;
  /** Nested container guids (ContainerType != NonContainer), in ViewContents order. */
  private subGuids: number[] = [];
  /** guid → ContainerType from the authoritative ViewContents entry. */
  private types = new Map<number, number>();
  /** guid → direct parent container guid, in insertion order. */
  private parents = new Map<number, number>();
  /** guid → display data from CreateObject / local inventory. */
  private data = new Map<number, TrackedData>();
  /** CORE.17.o.b — guid → resolved list capacity (itemListCapacity), for the
   *  open container itself and any nested container whose data we saw. */
  private capacities = new Map<number, number>();
  /** CORE.18.c — guid → resolved nested-container list capacity
   *  (itemListCapacity of the bitfield + _containersCapacity): the size rule
   *  of m_containerList, which reads _containersCapacity (containerList set). */
  private containerCapacities = new Map<number, number>();
  /** RELEASE.gdle-contents-before-viewcontents — contained objects seen before their container's 0x196 (insertion order; capped). */
  private early = new Map<number, { guid: number; containerId: number; name: string; pluralName?: string; iconDid: number; stackSize: number; itemType: number; objectDescFlags?: number; itemsCapacity?: number } & IconLook>();
  /** …and the 0x196 lists of nested containers not yet known (GDLE sends a pack's list before the pack). */
  private earlyLists = new Map<number, Array<{ guid: number; containerType: number }>>();
  private static readonly EARLY_CAP = 2048;

  /** Guid of the currently open container, 0 when none. */
  get openGuid(): number {
    return this.mainGuid;
  }

  /** Whether this guid is tracked as contents (any nesting level). */
  has(guid: number): boolean {
    return this.parents.has(guid);
  }

  /** Whether this guid is a tracked nested container of the open container. */
  isSubContainer(guid: number): boolean {
    return this.subGuids.includes(guid);
  }

  clear(): void {
    this.mainGuid = 0;
    this.subGuids = [];
    this.types.clear();
    this.parents.clear();
    this.data.clear();
    this.capacities.clear();
    this.containerCapacities.clear();
  }

  /**
   * CORE.17.o.b — record a container's list capacity from its
   * ObjectDescriptionFlags + ItemsCapacity (the ground object's ServerObject
   * at open, or a nested container's CreateObject).
   */
  setContainerCapacity(guid: number, objectDescFlags: number, itemsCapacity: number, containersCapacity?: number): void {
    this.capacities.set(guid, itemListCapacity(objectDescFlags, itemsCapacity));
    if (containersCapacity !== undefined) {
      this.containerCapacities.set(guid, itemListCapacity(objectDescFlags, containersCapacity));
    }
  }

  /**
   * CORE.18.c — the capacity to size the strip's nested-container list with
   * when parented to this container: >= 0 fixed cells, -1 visible-area
   * padding (also the answer while unknown — the attribute's default).
   */
  containerListCapacity(guid: number): number {
    return this.containerCapacities.get(guid) ?? -1;
  }

  /**
   * The list capacity to size a pack tab's grid with: >= 0 fixed cells,
   * -1 visible-area padding — which is also the answer for a container whose
   * capacity is unknown (retail's attribute defaults to -1 until a parent
   * container is set).
   */
  listCapacity(guid: number): number {
    return this.capacities.get(guid) ?? -1;
  }

  /**
   * Route a ViewContents event. Returns 'opened' when it (re)opens a
   * container (panel must be shown/reset), or 'sub' when it fills in a
   * nested container's contents (panel state must NOT be reset).
   */
  viewContents(containerGuid: number, items: Array<{ guid: number; containerType: number }>): 'opened' | 'sub' {
    const isSub = this.mainGuid !== 0
      && containerGuid !== this.mainGuid
      && this.parents.has(containerGuid);
    if (!isSub) {
      this.clear();
      this.mainGuid = containerGuid;
    }
    this.listContents(containerGuid, items);
    // RELEASE.gdle-contents-before-viewcontents — the nested containers'
    // own lists that arrived before them, then every object whose
    // CreateObject came before this ViewContents.
    for (const sub of [...this.subGuids]) {
      const early = this.earlyLists.get(sub);
      if (!early) continue;
      this.earlyLists.delete(sub);
      this.listContents(sub, early);
    }
    this.adoptEarlyObjects();
    return isSub ? 'sub' : 'opened';
  }

  private listContents(containerGuid: number, items: ReadonlyArray<{ guid: number; containerType: number }>): void {
    for (const item of items) {
      this.types.set(item.guid, item.containerType);
      this.parents.set(item.guid, containerGuid);
      if (item.containerType !== ContainerType.NonContainer && containerGuid === this.mainGuid) {
        if (!this.subGuids.includes(item.guid)) this.subGuids.push(item.guid);
      }
    }
  }

  /**
   * RELEASE.gdle-contents-before-viewcontents — GDLE-based servers (GDL-
   * Classic / Seedsow, the AC1999 server) open a container with
   * CContainerWeenie::MakeAwareViewContent (Seedsow Source/Container.cpp
   * :1014-1050): a CreateObject for every pack and item FIRST (each pack's
   * own contents and 0x196 before the pack), then the container's 0x196 —
   * all through one FIFO (PacketController QueueNetMessage / FlushQueued
   * NetMessages). ACE sends the 0x196 first (Container.cs SendInventory).
   * Retail handles either order: a CreateObject makes the weenie object
   * whatever its container, and ACCObjectMaint::ViewObjectContents @
   * 00558a70 only records the id lists, which the container UI resolves
   * against the objects it already holds. Pre-fix a contained object that
   * arrived before its container's 0x196 was never listed: every first open
   * of a GDLE corpse or chest showed an empty strip.
   *
   * Record a CreateObject whose container is not (yet) the open one.
   */
  noteContainedObject(d: { guid: number; containerId: number; name: string; pluralName?: string; iconDid: number; stackSize: number; itemType: number; objectDescFlags?: number; itemsCapacity?: number } & IconLook): void {
    if (!d.containerId) return;
    this.early.delete(d.guid);
    this.early.set(d.guid, { ...d });
    if (this.early.size > OpenContainerTracker.EARLY_CAP) {
      const oldest = this.early.keys().next().value;
      if (oldest !== undefined) this.early.delete(oldest);
    }
  }

  /**
   * A CreateObject that may belong to an external container: tracked when it
   * belongs to the open one (true — the panel must refresh), else, when it
   * names a container, kept for that container's 0x196 (false).
   */
  acceptCreateObject(d: { guid: number; containerId: number; name: string; pluralName?: string; iconDid: number; stackSize: number; itemType: number; objectDescFlags?: number; itemsCapacity?: number } & IconLook): boolean {
    if (this.trackCreateObject(d)) return true;
    this.noteContainedObject(d);
    return false;
  }

  /** Whether CreateObjects already named this guid as their container (a GDLE nested pack whose 0x196 precedes its own CreateObject). */
  hasEarlyContentsFor(containerGuid: number): boolean {
    for (const r of this.early.values()) if (r.containerId === containerGuid) return true;
    return false;
  }

  /** Keep a not-yet-known nested container's 0x196 list for when its parent is opened. */
  noteEarlyContentsList(containerGuid: number, items: ReadonlyArray<{ guid: number; containerType: number }>): void {
    this.earlyLists.set(containerGuid, items.map((i) => ({ guid: i.guid, containerType: i.containerType })));
    if (this.earlyLists.size > OpenContainerTracker.EARLY_CAP) {
      const oldest = this.earlyLists.keys().next().value;
      if (oldest !== undefined) this.earlyLists.delete(oldest);
    }
  }

  /** The object is gone (DeleteObject): drop any early record of it. */
  forgetEarly(guid: number): void {
    this.early.delete(guid);
    this.earlyLists.delete(guid);
  }

  /** How many early objects the last viewContents listed (0 against ACE's order). */
  adoptedOnLastView = 0;

  private adoptEarlyObjects(): void {
    this.adoptedOnLastView = 0;
    if (this.mainGuid === 0) return;
    for (const [guid, r] of [...this.early]) {
      // Only what a 0x196 listed (ViewObjectContents' id lists decide): a
      // record kept from an earlier open of an item since taken by someone
      // else is not listed again, and stays out.
      const listed = this.parents.get(guid);
      if (listed === undefined) continue;
      this.early.delete(guid);
      if (this.trackCreateObject({ ...r, containerId: listed })) this.adoptedOnLastView++;
    }
  }

  /**
   * Track a CreateObject that belongs to the open container (directly or
   * inside a nested container). Returns false when unrelated.
   */
  trackCreateObject(d: { guid: number; containerId: number; name: string; pluralName?: string; iconDid: number; stackSize: number; itemType: number; objectDescFlags?: number; itemsCapacity?: number } & IconLook): boolean {
    if (this.mainGuid === 0) return false;
    const belongs = d.containerId === this.mainGuid
      || this.subGuids.includes(d.containerId)
      || this.parents.has(d.guid);
    if (!belongs) return false;
    this.early.delete(d.guid);
    if (!this.parents.has(d.guid)) this.parents.set(d.guid, d.containerId);
    this.data.set(d.guid, { name: d.name, pluralName: d.pluralName ?? '', iconDid: d.iconDid, stackSize: d.stackSize, itemType: d.itemType, ...iconLookOf(d) });
    // CORE.17.o.b — a nested container's own list capacity (its tab's grid).
    if (d.objectDescFlags !== undefined && d.itemsCapacity !== undefined) {
      this.setContainerCapacity(d.guid, d.objectDescFlags, d.itemsCapacity);
    }
    // Fallback for a container the ViewContents didn't mark (shouldn't
    // happen against ACE, which always writes the ContainerType — but the
    // ItemType.Container bit is the same signal the player-side pack
    // tracking uses).
    if (!this.types.has(d.guid) && (d.itemType & ItemType.Container) !== 0
        && d.containerId === this.mainGuid && !this.subGuids.includes(d.guid)) {
      this.subGuids.push(d.guid);
    }
    return true;
  }

  /** Track an item the player stored into the open container (no CreateObject follows). */
  trackStoredItem(guid: number, d: { name: string; pluralName?: string; iconDid: number; stackSize: number; itemType?: number; itemsCapacity?: number } & IconLook): void {
    if (this.mainGuid === 0) return;
    this.parents.set(guid, this.mainGuid);
    this.data.set(guid, { name: d.name, pluralName: d.pluralName ?? '', iconDid: d.iconDid, stackSize: d.stackSize, itemType: d.itemType ?? 0, ...iconLookOf(d) });
    // CORE.17.o.b — a stored pack keeps the (already gated) InventoryItem
    // capacity; undefined (no Openable bit on its CreateObject) pads.
    if (d.itemsCapacity !== undefined) this.capacities.set(guid, d.itemsCapacity);
    if ((d.itemType ?? 0) & ItemType.Container && !this.subGuids.includes(guid)) {
      this.subGuids.push(guid);
    }
  }

  /**
   * Remove an item (e.g. taken by the player). Removing a nested container
   * also drops its tab and all items inside it (they move with the pack).
   */
  remove(guid: number): void {
    const subIdx = this.subGuids.indexOf(guid);
    if (subIdx >= 0) {
      this.subGuids.splice(subIdx, 1);
      for (const [g, parent] of [...this.parents]) {
        if (parent === guid) {
          this.parents.delete(g);
          this.types.delete(g);
          this.data.delete(g);
        }
      }
    }
    this.parents.delete(guid);
    this.types.delete(guid);
    this.data.delete(guid);
    this.capacities.delete(guid);
    this.early.delete(guid);
  }

  /**
   * RELEASE.open-container-stale-members — ACCWeenieObject::ServerSaysMoveItem
   * for an object this list holds: retail's UIElement_ItemList::RecvNotice_
   * ServerSaysMoveItem @ 004e5110 drops the cell when the object leaves the
   * list's container and adds it where it lands. `newContainer` 0 is the
   * removal ACCWeenieObject::Remove @ 0058dd20 runs from ObjectBeingDeleted
   * @ 0058e4d0 (a DeleteObject), which also destroys a deleted pack's
   * contents. Moves inside the open container (into / out of a nested pack)
   * re-parent. Returns true when the list changed.
   */
  serverSaysMove(guid: number, newContainer: number): boolean {
    if (!this.parents.has(guid)) {
      this.early.delete(guid);
      return false;
    }
    const staysInside = newContainer !== 0 && newContainer !== guid
      && (newContainer === this.mainGuid || this.subGuids.includes(newContainer));
    if (!staysInside) {
      if (guid === this.mainGuid) return false; // the open container itself: its own close path
      this.remove(guid);
      return true;
    }
    if (this.parents.get(guid) === newContainer) return false;
    this.parents.set(guid, newContainer);
    return true;
  }

  /**
   * BUG.stack-merge-not-found — serverSaysMove for one server message, with
   * the container the object lands in read the way retail's dispatch reads
   * it (serverMoveContainer). Every message retail runs through
   * ACCWeenieObject::ServerSaysMoveItem goes through here, so no message can
   * leave a stale cell in the open container's strip.
   */
  serverSaysMoveFor(guid: number, message: ServerMoveMessage): boolean {
    return this.serverSaysMove(guid, serverMoveContainer(message));
  }

  /** Update a tracked stack's size; returns false when the guid isn't tracked. */
  updateStackSize(guid: number, stackSize: number): boolean {
    const d = this.data.get(guid);
    if (!d) return false;
    d.stackSize = stackSize;
    return true;
  }

  /** [openGuid, ...nested container guids] — pack-tab list for the panel. */
  packGuids(): number[] {
    return this.mainGuid === 0 ? [] : [this.mainGuid, ...this.subGuids];
  }

  /** Guids directly inside the open container (not nested contents). */
  mainLevelGuids(): number[] {
    const out: number[] = [];
    for (const [g, parent] of this.parents) {
      if (parent === this.mainGuid) out.push(g);
    }
    return out;
  }

  /** All tracked guids (any nesting level), insertion order. */
  allGuids(): number[] {
    return [...this.parents.keys()];
  }

  /** Panel item list: every tracked guid with display data + container flags. */
  items(): OpenContainerItem[] {
    const out: OpenContainerItem[] = [];
    for (const [guid, containerId] of this.parents) {
      const d = this.data.get(guid);
      const type = this.types.get(guid);
      const isContainer = type !== undefined
        ? type !== ContainerType.NonContainer
        : ((d?.itemType ?? 0) & ItemType.Container) !== 0;
      out.push({
        guid,
        name: d?.name ?? '???',
        pluralName: d?.pluralName ?? '',
        iconDid: d?.iconDid ?? 0,
        stackSize: d?.stackSize ?? 1,
        containerId,
        isContainer,
        itemsCapacity: this.capacities.get(guid),
        ...(d ? { itemType: d.itemType, ...iconLookOf(d) } : {}),
      });
    }
    return out;
  }
}
