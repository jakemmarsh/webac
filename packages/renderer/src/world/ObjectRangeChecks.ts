/**
 * CORE.17.k.b.b.c.c.a.a.a — the retail client's object-range watch list.
 *
 * `CPlayerSystem` keeps `m_objectRangeCheckList` (a `List<ObjectRangeInfo>`)
 * that panels tied to a world object register on when they open and that
 * `CPlayerSystem::UseTime @ 00563110` walks once per frame through
 * `CalculateObjectRangeChecks @ 0055f360`:
 *
 *  - `RegisterObjectRangeHandler @ 005602d0`(handler, objectID, range,
 *    useRadii, ignoreZDelta, timeInterval, timeOut): any live entry with the
 *    same (handler, objectID) is queued for deletion, then a new one is
 *    inserted at the head with `m_nextUpdate = cur_time + timeInterval` and
 *    `m_executeAtTime = cur_time + timeOut`.
 *  - `UnregisterObjectRangeHandler @ 0055eb90` / `UnregisterAllObjectRangeHandlers
 *    @ 0055ebc0` only queue entries for deletion; the sweep removes them.
 *  - `CalculateObjectRangeChecks`: a queued entry is removed; otherwise once
 *    `m_nextUpdate < cur_time` it is re-armed (`cur_time + m_timeInterval`) and
 *    `ACCWeenieObject::ObjectsInRange @ 0058c1a0`(objectID, playerID, range,
 *    useRadii, ignoreZDelta) decides: out of range → `handler->OnObjectRangeExit
 *    (objectID)` and the entry is queued for deletion; in range with a
 *    positive `m_timeOut` whose `m_executeAtTime < cur_time` →
 *    `OnObjectRangeTimeout(objectID)` and the same deletion.
 *  - `ObjectsInRange`: BOTH physics objects must resolve through
 *    `CObjectMaint::GetObjectA` (a despawned object is "out of range");
 *    `ignoreZDelta` → `Position::xy_distance <= range`; else
 *    `CPhysicsObj::get_distance_to_object(useRadii)` <= range —
 *    `Position::cylinder_distance @ 005a97f0` with both bodies' radii and
 *    heights when useRadii, the plain 3D `Position::distance` otherwise.
 *
 * The registrants (each hides itself in OnObjectRangeExit when the id is its
 * own, and unregisters in OnVisibilityChanged(false)):
 *
 *  | UI                                            | range                          | useRadii | ignoreZ | interval                     | timeOut |
 *  |-----------------------------------------------|--------------------------------|----------|---------|------------------------------|---------|
 *  | gmSlumlordUI::RecvNotice_UpdateHouseProfile   | MaxLordDistance = 9.0          | true     | false   | CHECK_LORD_INTERVAL = 1.0    | 0       |
 *  | gmVendorUI::OpenVendor @ 004c4ba0             | the vendor's pwd._useRadius    | true     | false   | CHECK_GROUND_OBJECT_INTERVAL | 0       |
 *  | gmExternalContainerUI (OpenContainer)         | the container's _useRadius     | true     | false   | CHECK_GROUND_OBJECT_INTERVAL | 0       |
 *  | gmBookUI (a book not owned by the player)     | the book's _useRadius          | true     | false   | CHECK_GROUND_OBJECT_INTERVAL | 0       |
 *  | gmSecureTradeUI::RecvNotice_RegisterTrade     | 5.0                            | true     | false   | CHECK_TRADE_INTERVAL = 1.0   | 0       |
 *  | CPlayerSystem::RecvNotice_SetSelectedItem     | RADAR_INDOOR/OUTDOOR_RADIUS    | true     | true    | CHECK_SELECTED_OBJECT_INTERVAL | 0     |
 *
 * The constants are exe data (acclient.exe .rdata): MaxLordDistance is the
 * float at 0x7b66b8 (= 9.0), CHECK_LORD_INTERVAL the double at 0x7b6720
 * (= 1.0), CHECK_GROUND_OBJECT_INTERVAL the double at 0x7b4f58 (= 1.0),
 * CHECK_TRADE_INTERVAL the double at 0x7b6fe0 (= 1.0); the trade range is the
 * immediate 0x4014000000000000 (= 5.0) in RecvNotice_RegisterTrade;
 * RADAR_OUTDOOR_RADIUS / RADAR_INDOOR_RADIUS are the floats at 0x7cc6a0 /
 * 0x7cc6a4 (= 75 / 25) and CHECK_SELECTED_OBJECT_INTERVAL the double at
 * 0x7cc5c0 (= 1.0) — CORE.17.k.b.b.c.c.a.a.a.a.
 *
 * This module is the pure port: the list, its register / unregister / sweep
 * semantics, the ObjectsInRange metric, and the selected-object gate
 * (selectedObjectRadarRadius / shouldWatchSelectedObject). main.ts owns the
 * clock, the player / object bodies and the handlers (the slumlord dialog,
 * the vendor, the external container, the book, the trade, the selection).
 */
import { getMeleeCylinderDistance } from '../controllers/CombatController.js';

/** `MaxLordDistance` — acclient.exe .rdata 0x7b66b8 (float). */
export const MAX_LORD_DISTANCE = 9.0;
/** `CHECK_LORD_INTERVAL` — .rdata 0x7b6720 (double), seconds. */
export const CHECK_LORD_INTERVAL_S = 1.0;
/** `CHECK_GROUND_OBJECT_INTERVAL` — .rdata 0x7b4f58 (double), seconds (vendor / container / book). */
export const CHECK_GROUND_OBJECT_INTERVAL_S = 1.0;
/** `CHECK_TRADE_INTERVAL` — .rdata 0x7b6fe0 (double), seconds. */
export const CHECK_TRADE_INTERVAL_S = 1.0;
/** gmSecureTradeUI::RecvNotice_RegisterTrade's immediate range (0x4014000000000000). */
export const TRADE_RANGE = 5.0;
/**
 * CORE.17.k.b.b.c.c.a.a.a.a — `RADAR_OUTDOOR_RADIUS` — .rdata 0x7cc6a0 (float):
 * the `fld dword [0x7cc6a0]` RecvNotice_SetSelectedItem @ 00560720 takes when
 * `SmartBox::is_player_outside` is non-zero (metres, ground-plane).
 */
export const RADAR_OUTDOOR_RADIUS = 75.0;
/** `RADAR_INDOOR_RADIUS` — .rdata 0x7cc6a4 (float): the `je` path (not outside). */
export const RADAR_INDOOR_RADIUS = 25.0;
/** `CHECK_SELECTED_OBJECT_INTERVAL` — .rdata 0x7cc5c0 (double), seconds. */
export const CHECK_SELECTED_OBJECT_INTERVAL_S = 1.0;

/**
 * The radius `CPlayerSystem::RecvNotice_SetSelectedItem @ 00560720` (and the
 * re-register in `CPlayerSystem::OnObjectRangeExit @ 00560870`) watches the
 * selected object at: `SmartBox::is_player_outside(smartbox)` picks
 * RADAR_OUTDOOR_RADIUS, else RADAR_INDOOR_RADIUS — the same pair the radar
 * dial ranges over.
 */
export function selectedObjectRadarRadius(isPlayerOutside: boolean): number {
  return isPlayerOutside ? RADAR_OUTDOOR_RADIUS : RADAR_INDOOR_RADIUS;
}

/** The ownership facts RecvNotice_SetSelectedItem tests before it registers. */
export interface SelectedObjectOwnership {
  /** `ACCWeenieObject::IsOwnedByPlayer` — the item is in the player's own inventory / wielded. */
  ownedByPlayer: boolean;
  /** `IsOwnedByObject(ClientUISystem::groundObject)` — it sits in the open ground container. */
  inGroundContainer: boolean;
  /** `IsOwnedByObject(ClientUISystem::vendorID)` — a row of the open vendor's stock. */
  ownedByVendor: boolean;
  /** `IsOwnedByObject(ClientTradeSystem::m_iidTradePartner)` — an item on the partner's side of the trade. */
  ownedByTradePartner: boolean;
}

/**
 * `RecvNotice_SetSelectedItem @ 00560720`'s gate: the previous selection's
 * entry is queued regardless; the new object is watched only when it resolves
 * (the caller's job) and none of the four owners claims it — an item owned by
 * the trade partner short-circuits to `set_selected_object_id` (goto
 * LAB_00560844), the other three fold into `bVar8 = false`.
 */
export function shouldWatchSelectedObject(o: SelectedObjectOwnership): boolean {
  return !o.ownedByPlayer && !o.inGroundContainer && !o.ownedByVendor && !o.ownedByTradePartner;
}

/** ObjectRangeHandler — the two virtuals CalculateObjectRangeChecks calls. */
export interface ObjectRangeHandler {
  /** vtable slot 0: the object left the range (or no longer exists). */
  onObjectRangeExit(objectId: number): void;
  /** vtable slot 1: still in range when `timeOut` elapsed (only with timeOut > 0). */
  onObjectRangeTimeout?(objectId: number): void;
}

/** ObjectRangeInfo — one list entry, field for field. */
export interface ObjectRangeInfo {
  handler: ObjectRangeHandler;
  objectId: number;
  range: number;
  useRadii: boolean;
  ignoreZDelta: boolean;
  timeInterval: number;
  timeOut: number;
  nextUpdate: number;
  executeAtTime: number;
  queuedForDeletion: boolean;
}

/**
 * A physics body as ObjectsInRange sees it, in the renderer's Three.js axes
 * (x / z on the ground plane, y up = AC's Z). `radius` / `height` are the
 * collision cylinder (CPartArray::GetRadius / GetHeight); `y` is the body's
 * origin (its feet), like `Position.frame.m_fOrigin.z`.
 */
export interface RangeBody {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

/** `ACCWeenieObject::ObjectsInRange` resolved onto two bodies (either missing → 0). */
export type ObjectsInRangeFn = (objectId: number, range: number, useRadii: boolean, ignoreZDelta: boolean) => boolean;

/**
 * `ACCWeenieObject::ObjectsInRange @ 0058c1a0` — `object` is the watched
 * object's body, `player` the local player's. Ghidra renders the compare as
 * `(d < range) != (d == range)`, i.e. `d <= range`.
 */
export function objectsInRange(
  object: RangeBody | null | undefined,
  player: RangeBody | null | undefined,
  range: number,
  useRadii: boolean,
  ignoreZDelta: boolean,
): boolean {
  if (!object || !player) return false;
  const dx = player.x - object.x;
  const dy = player.y - object.y;
  const dz = player.z - object.z;
  let d: number;
  if (ignoreZDelta) {
    // Position::xy_distance — the ground-plane distance.
    d = Math.sqrt(dx * dx + dz * dz);
  } else if (useRadii) {
    // CPhysicsObj::get_distance_to_object(useRadii) → Position::cylinder_distance
    // (this = the object, other = the player).
    d = getMeleeCylinderDistance(dx, dy, dz, object.radius, object.height, player.radius, player.height);
  } else {
    // Position::distance — the plain 3D distance.
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return d <= range;
}

/** `CPlayerSystem::m_objectRangeCheckList` + the three list methods + the sweep. */
export class ObjectRangeChecks {
  private readonly list: ObjectRangeInfo[] = [];

  /** `RegisterObjectRangeHandler @ 005602d0` — `now` is Timer::cur_time in seconds. */
  register(
    handler: ObjectRangeHandler,
    objectId: number,
    range: number,
    useRadii: boolean,
    ignoreZDelta: boolean,
    timeInterval: number,
    timeOut: number,
    now: number,
  ): void {
    for (const e of this.list) {
      if (e.handler === handler && e.objectId === objectId) e.queuedForDeletion = true;
    }
    // List::insert(head, …) — the new entry goes in front.
    this.list.unshift({
      handler, objectId, range, useRadii, ignoreZDelta, timeInterval, timeOut,
      nextUpdate: now + timeInterval,
      executeAtTime: now + timeOut,
      queuedForDeletion: false,
    });
  }

  /** `UnregisterObjectRangeHandler @ 0055eb90` — queue only; the sweep removes. */
  unregister(handler: ObjectRangeHandler, objectId: number): void {
    for (const e of this.list) {
      if (e.handler === handler && e.objectId === objectId) e.queuedForDeletion = true;
    }
  }

  /** `UnregisterAllObjectRangeHandlers @ 0055ebc0`. */
  unregisterAll(handler: ObjectRangeHandler): void {
    for (const e of this.list) {
      if (e.handler === handler) e.queuedForDeletion = true;
    }
  }

  /**
   * `CalculateObjectRangeChecks @ 0055f360` — once per frame from
   * CPlayerSystem::UseTime. `now` is Timer::cur_time in seconds.
   */
  update(now: number, inRange: ObjectsInRangeFn): void {
    for (let i = 0; i < this.list.length;) {
      const e = this.list[i];
      if (e.queuedForDeletion) {
        this.list.splice(i, 1);
        continue;
      }
      if (e.nextUpdate < now) {
        e.nextUpdate = now + e.timeInterval;
        if (!inRange(e.objectId, e.range, e.useRadii, e.ignoreZDelta)) {
          e.handler.onObjectRangeExit(e.objectId);
          e.queuedForDeletion = true;
        } else if (e.timeOut > 0 && e.executeAtTime < now) {
          e.handler.onObjectRangeTimeout?.(e.objectId);
          e.queuedForDeletion = true;
        }
      }
      i++;
    }
  }

  /** Live (not queued) entries — for the harness / debugging. */
  active(): ReadonlyArray<Readonly<ObjectRangeInfo>> {
    return this.list.filter((e) => !e.queuedForDeletion);
  }

  /** Is (handler, objectId) live on the list? */
  isRegistered(handler: ObjectRangeHandler, objectId: number): boolean {
    return this.list.some((e) => e.handler === handler && e.objectId === objectId && !e.queuedForDeletion);
  }
}
