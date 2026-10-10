/**
 * CPlayerSystem::SelectNext @ 0055f9a0 — every selection-cycling key
 * (CPlayerSystem::OnAction @ 00561890 cases 4–0x14) and the Auto Target
 * fallback (ClientCombatSystem::AutoTarget @ 0056bc80 →
 * SelectNext(1, 1, SELECTION_TYPE_COMPASS_ITEM, 0)). Pure: the caller supplies
 * the candidates in player space and the predicates retail asks the object /
 * combat / fellowship systems.
 *
 * Each candidate is weighed by Get2DDistance @ 0055d7e0 plus
 * GetWeightedZDistance @ 0055d810 (|dz| × 1.2), and must sit within
 * GetRadarRadius @ 0055d880 (RADAR_OUTDOOR_RADIUS 75 / RADAR_INDOOR_RADIUS 25,
 * tested on the 2-D distance). Candidates are ordered by (distance, guid)
 * (CPlayerSystem::Farther @ 0055d830: a tie goes to the lower guid).
 *
 * The reference is the selection (selectedID, else prevSelectedID). With
 * `fromPlayer`, or when the reference is not in the world, the direction is
 * inverted and the reference becomes the player (distance 0) going outward or
 * the far edge (73728) going inward. Then an inward walk takes the farthest
 * candidate ordered before the reference and an outward walk the nearest one
 * ordered after it. So Closest X = SelectNext(1, 1) = the nearest; Previous X
 * = SelectNext(1, 0) = the next one nearer; Next X = SelectNext(0, 0) = the
 * next one farther. OnAction wraps a Previous / Next that changed nothing with
 * SelectNext(0, 1) (the farthest) / SelectNext(1, 1) (the nearest).
 */

import { selectedObjectRadarRadius } from '../world/ObjectRangeChecks.js';

/** GetWeightedZDistance's factor (___real_3ff3333333333333). */
export const Z_DISTANCE_WEIGHT = 1.2;
/** SelectNext's far sentinel distance (0x40f2000000000000). */
const FAR_DISTANCE = 73728.0;

/** UI_SELECTION_TYPE. */
export enum SelectionType {
  Item = 1,
  CompassItem = 2,
  Monster = 3,
  Player = 4,
  UnopenedCorpse = 5,
}

/** PublicWeenieDesc bitfield bits SelectNext reads. */
const BF_PLAYER = 0x8;
const BF_UI_HIDDEN = 0x80;
const BF_VENDOR = 0x200;
const BF_CORPSE = 0x2000;
/** BF_LIFESTONE | BF_PORTAL | BF_BINDSTONE: shown as compass items regardless of radar behavior. */
const BF_COMPASS_ALWAYS = 0x8044000;
/** PhysicsState bits: CLOAKED skips every selection, REPORT_COLLISIONS_AS_ENVIRONMENT skips combat picks. */
const PS_CLOAKED = 0x100000;
const PS_REPORT_COLLISIONS_AS_ENVIRONMENT = 0x200000;

export interface SelectNextCandidate {
  guid: number;
  /** Player-space offset (x, y horizontal; z up). */
  dx: number;
  dy: number;
  dz: number;
  /** PublicWeenieDesc _bitfield (ObjectDescriptionFlag). */
  bitfield: number;
  /** CPhysicsObj state (PhysicsState). */
  physicsState: number;
  /** ACCWeenieObject::InqShowableOnRadar. */
  showableOnRadar: boolean;
  /** In a cell (CPhysicsObj::cell != 0) and not being removed. */
  present: boolean;
  /** PublicWeenieDesc _radar_enum (RadarBehavior; 0 = Undef). SELECTION_TYPE_ITEM reads it. */
  radarEnum?: number;
  /** PublicWeenieDesc _wielderID. */
  wielderId?: number;
  /** ACCWeenieObject::HasCorpseBeenOpened. */
  corpseOpened?: boolean;
}

export interface SelectNextContext {
  playerGuid: number;
  outside: boolean;
  /** Combat mode is melee or missile: compass items narrow to attackable non-fellows. */
  meleeOrMissile: boolean;
  /** ClientCombatSystem::ObjectIsAttackable. */
  isAttackable(guid: number): boolean;
  /** ClientFellowshipSystem::IsFellow. */
  isFellow(guid: number): boolean;
}

/** The reference the walk starts from: selectedID, else prevSelectedID. */
export interface SelectNextReference {
  guid: number;
  /** Player-space offset of the reference object; null when it is not in the world (no object / no cell). */
  offset: { dx: number; dy: number; dz: number } | null;
}

/**
 * SelectNext's reference: CObjectMaint::GetObjectA(selectedID or
 * prevSelectedID). The player is in CObjectMaint like any object, so a self
 * reference sits at offset 0; only a missing or cell-less object is null.
 * `worldOffset` is the reference's offset when it is a world object in a cell.
 */
export function selectNextReference(
  refGuid: number,
  playerGuid: number,
  worldOffset: { dx: number; dy: number; dz: number } | null,
): SelectNextReference {
  if (refGuid !== 0 && refGuid === playerGuid) return { guid: refGuid, offset: { dx: 0, dy: 0, dz: 0 } };
  return { guid: refGuid, offset: worldOffset };
}

/** SELECTION_TYPE_COMPASS_ITEM's eligibility switch case. */
export function isCompassItem(c: SelectNextCandidate, ctx: SelectNextContext): boolean {
  if ((c.bitfield & BF_COMPASS_ALWAYS) === 0 && !c.showableOnRadar) return false;
  if (!ctx.meleeOrMissile) return true;
  return ctx.isAttackable(c.guid)
    && !ctx.isFellow(c.guid)
    && (c.bitfield & BF_VENDOR) === 0
    && (c.physicsState & PS_REPORT_COLLISIONS_AS_ENVIRONMENT) === 0;
}

/** SelectNext's per-type switch: true when the candidate is of the asked type. */
export function matchesSelectionType(type: SelectionType, c: SelectNextCandidate, ctx: SelectNextContext): boolean {
  switch (type) {
    case SelectionType.Item:
      if ((c.wielderId ?? 0) !== 0) return false;
      return (c.radarEnum ?? 0) === 0 || (c.bitfield & BF_COMPASS_ALWAYS) !== 0;
    case SelectionType.CompassItem:
      return isCompassItem(c, ctx);
    case SelectionType.Monster:
      return ctx.isAttackable(c.guid)
        && (c.bitfield & BF_VENDOR) === 0
        && c.showableOnRadar
        && !ctx.isFellow(c.guid);
    case SelectionType.Player:
      return (c.bitfield & BF_PLAYER) !== 0 && c.showableOnRadar;
    case SelectionType.UnopenedCorpse:
      return (c.bitfield & BF_CORPSE) !== 0 && !c.corpseOpened;
  }
}

const weighted = (dx: number, dy: number, dz: number): number => Math.hypot(dx, dy) + Math.abs(dz) * Z_DISTANCE_WEIGHT;

/** Farther @ 0055d830: (d1, g1) orders after (d2, g2). */
function farther(d1: number, g1: number, d2: number, g2: number): boolean {
  return d1 > d2 || (d1 === d2 && (g1 >>> 0) > (g2 >>> 0));
}

/**
 * SelectNext(forward, fromPlayer, type, ownedOnly): the guid it selects, 0
 * when it selects nothing (the selection is left alone).
 */
export function selectNext(
  candidates: Iterable<SelectNextCandidate>,
  ctx: SelectNextContext,
  ref: SelectNextReference,
  forward: boolean,
  fromPlayer: boolean,
  type: SelectionType,
  ownedOnly = false,
): number {
  let inward = forward;
  let refDist: number;
  if (fromPlayer || ref.offset === null) {
    inward = !inward;
    refDist = inward ? FAR_DISTANCE : 0;
  } else {
    refDist = weighted(ref.offset.dx, ref.offset.dy, ref.offset.dz);
  }
  const refGuid = ref.guid >>> 0;
  let bestDist = inward ? 0 : FAR_DISTANCE;
  let bestGuid = 0;
  const radius = selectedObjectRadarRadius(ctx.outside);
  for (const c of candidates) {
    if (c.guid === 0 || c.guid === ctx.playerGuid) continue;
    if ((c.bitfield & BF_UI_HIDDEN) !== 0) continue;
    if (!matchesSelectionType(type, c, ctx)) continue;
    if (ownedOnly && (c.wielderId ?? 0) === ctx.playerGuid) continue;
    if (!c.present || (c.physicsState & PS_CLOAKED) !== 0) continue;
    const flat = Math.hypot(c.dx, c.dy);
    if (flat > radius) continue;
    if ((c.guid >>> 0) === refGuid && !fromPlayer) continue;
    const dist = flat + Math.abs(c.dz) * Z_DISTANCE_WEIGHT;
    const take = inward
      ? farther(dist, c.guid, bestDist, bestGuid) && !farther(dist, c.guid, refDist, refGuid)
      : !farther(dist, c.guid, bestDist, bestGuid) && farther(dist, c.guid, refDist, refGuid);
    if (take) { bestDist = dist; bestGuid = c.guid; }
  }
  return bestGuid;
}

/** SelectNext(forward, fromPlayer, SELECTION_TYPE_COMPASS_ITEM, false) from the player: the guid to select, 0 for none. */
export function selectNextCompassItem(candidates: Iterable<SelectNextCandidate>, ctx: SelectNextContext): number {
  return selectNext(candidates, ctx, { guid: 0, offset: null }, true, true, SelectionType.CompassItem);
}

/** The cycling commands of CPlayerSystem::OnAction @ 00561890. */
export type SelectCycle = 'closest' | 'previous' | 'next';

/**
 * OnAction's Closest / Previous / Next case for `type`: Closest =
 * SelectNext(1, 1); Previous = SelectNext(1, 0), and when the selection did
 * not change, SelectNext(0, 1); Next = SelectNext(0, 0), else SelectNext(1, 1).
 * Closest Item passes ownedOnly (case 7). Returns the guid to select, 0 to
 * leave the selection alone.
 */
export function selectCycle(
  candidates: readonly SelectNextCandidate[],
  ctx: SelectNextContext,
  ref: SelectNextReference,
  type: SelectionType,
  cycle: SelectCycle,
): number {
  if (cycle === 'closest') return selectNext(candidates, ctx, ref, true, true, type, type === SelectionType.Item);
  const forward = cycle === 'previous';
  const pick = selectNext(candidates, ctx, ref, forward, false, type);
  if (pick !== 0) return pick;
  return selectNext(candidates, ctx, ref, !forward, true, type);
}

/**
 * The fellowship's PackableHashTable<ulong, Fellow> iteration order
 * (begin @ 0048e9e0 over add @ 00569790): bucket guid % tableSize ascending,
 * and each bucket's chain newest-first (add links at the head).
 * `guids` is in insertion (packet) order.
 */
export function fellowIterationOrder(guids: readonly number[], tableSize: number): number[] {
  if (tableSize <= 0) return [...guids];
  return guids
    .map((g, i) => ({ g, i, b: (g >>> 0) % tableSize }))
    .sort((x, y) => x.b - y.b || y.i - x.i)
    .map((e) => e.g);
}

/**
 * ClientFellowshipSystem::SelectNextFellow @ 005694f0: the fellow after the
 * selected one; the first fellow when the selection is the last fellow or not
 * a fellow. Returns null to leave the selection alone (no fellowship / empty).
 */
export function selectNextFellow(order: readonly number[], selected: number): number | null {
  if (order.length === 0) return null;
  const i = order.indexOf(selected);
  if (i >= 0 && i + 1 < order.length) return order[i + 1];
  return order[0];
}

/**
 * ClientFellowshipSystem::SelectPreviousFellow @ 005695c0: the fellow before
 * the selected one; the last fellow when the selection is the first fellow or
 * not a fellow. An empty fellowship selects 0 (retail's SetSelectedObject(0)).
 */
export function selectPreviousFellow(order: readonly number[], selected: number): number {
  const i = order.indexOf(selected);
  if (i > 0) return order[i - 1];
  return order.length > 0 ? order[order.length - 1] : 0;
}
