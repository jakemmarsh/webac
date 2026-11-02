/**
 * BUG.ac1999-drop-not-shown — an object the client knows without a world record (in our pack, worn,
 * in an open corpse or chest) that the server then places in the world with a position message
 * alone, no new CreateObject.
 *
 * Retail keeps ONE CPhysicsObj per known object, contained or not. An 0xF748 UpdatePosition for an
 * object with no cell puts it in the world: SmartBox::HandleReceivedPosition (EoL @ 00453fd0, 1999
 * SmartBox_HandleReceivedPosition @ 0x0040fb7d) unsets its parent and calls MoveOrTeleport (EoL
 * CPhysicsObj::MoveOrTeleport @ 00516330: `cell == 0` → SetPosition; 1999 CPhysicsObj_MoveOrTeleport
 * @ 0x004337b0: no cell → teleport_hook + SetPositionSimple). The pack side is the 0x19A
 * InventoryPutObjectIn3D's ServerSaysMoveItem, in either order.
 *
 * The AC1999 server drops exactly that way: FinishMoveItemTo3D (Server/Source/Monster.cpp) sends
 * 0x19A, then marks the dropper already aware of the item (SetMadeAwareOf, so its PVS pass sends
 * the dropper no 0xF745), then Movement_Teleport → Movement_UpdatePos → 0xF748. A rotting corpse
 * spills its contents the same way (Corpse.cpp BeginGracefulDestroy: InsertEntity + Movement_Teleport)
 * to anyone the server already counts as aware of them. Ours built no world object from a position
 * alone, so a dropped item stayed invisible until a relog re-sent its CreateObject.
 *
 * End of retail (ACE) and Dark Majesty (GDLE: FinishMoveItemTo3D without the SetMadeAwareOf) also
 * send a CreateObject; whichever arrives first makes the object and the other updates it in place.
 *
 * This keeps the latest CreateObject of every object created without a world record (and of each
 * world object we pick up or wield), and builds the world CreateObject from it when a position
 * names it.
 */
import { PhysicsTimestamp, type CreateObjectData } from '@ac/network';

/** The 0xF748 fields placing the object (ServerMessageHandler UpdatePositionData). */
export interface PlacingPosition {
  guid: number;
  landblock: number;
  x: number; y: number; z: number;
  rw: number; rx: number; ry: number; rz: number;
  placementId?: number;
  instanceSequence: number;
  positionSequence: number;
  teleportSequence: number;
}

export class NonWorldObjectRecords {
  private readonly records = new Map<number, CreateObjectData>();

  /** A CreateObject / UpdateObject that made no world record (own pack, worn, an open container's contents). */
  remember(data: CreateObjectData): void {
    this.records.set(data.guid >>> 0, data);
  }

  /**
   * A world object taken into one of our containers (a pick-up, a loot, a wield off the ground):
   * its world record leaves, and this keeps it for a later drop.
   */
  carryFromWorld(data: CreateObjectData, containerGuid: number, wielderGuid = 0): void {
    this.records.set(data.guid >>> 0, { ...data, containerId: containerGuid >>> 0, wielderId: wielderGuid >>> 0, position: null });
  }

  forget(guid: number): void {
    this.records.delete(guid >>> 0);
  }

  /** A SetStackSize (0x197) for a known object: its record carries the new count and value. */
  setStackSize(guid: number, stackSize: number, value: number): void {
    const rec = this.records.get(guid >>> 0);
    if (rec) this.records.set(guid >>> 0, { ...rec, stackSize, value });
  }

  has(guid: number): boolean {
    return this.records.has(guid >>> 0);
  }

  /** The kept CreateObject (the object as the server last described it), or undefined when not known. */
  get(guid: number): CreateObjectData | undefined {
    return this.records.get(guid >>> 0);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * An 0xF748 for an object with no world record: the CreateObject that puts it in the world at
   * that position (out of any container, off any wielder, the position's placement and stamps), or
   * null when the object is not known. The record is spent.
   */
  placeAt(p: PlacingPosition): CreateObjectData | null {
    const rec = this.records.get(p.guid >>> 0);
    if (!rec) return null;
    this.records.delete(p.guid >>> 0);
    const ts = [...(rec.timestamps ?? [])];
    ts[PhysicsTimestamp.Position] = p.positionSequence;
    ts[PhysicsTimestamp.Teleport] = p.teleportSequence;
    ts[PhysicsTimestamp.Instance] = p.instanceSequence;
    return {
      ...rec,
      containerId: 0,
      wielderId: 0,
      currentWieldedLocation: 0,
      // HandleReceivedPosition: unset_parent first.
      physicsParentId: 0,
      parentLocation: 0,
      position: { landblock: p.landblock >>> 0, x: p.x, y: p.y, z: p.z, rw: p.rw, rx: p.rx, ry: p.ry, rz: p.rz },
      // HandleReceivedPosition: SetPlacementFrame(placement_id) when the object has no animations.
      placement: p.placementId || rec.placement,
      velocityX: 0, velocityY: 0, velocityZ: 0,
      timestamps: ts,
    };
  }
}

/**
 * The 0xF748 step of HandleReceivedPosition for an object with no world record: when `records`
 * knows it, `create` makes it in the world at the position (the owner's CreateObject path) and the
 * placing record is returned; null = not known (the position applies as usual).
 */
export function placeKnownObjectByPosition(
  records: NonWorldObjectRecords,
  deps: { hasWorldObject(guid: number): boolean; create(data: CreateObjectData): void },
  p: PlacingPosition,
): CreateObjectData | null {
  if (deps.hasWorldObject(p.guid)) return null;
  const placed = records.placeAt(p);
  if (placed) deps.create(placed);
  return placed;
}
