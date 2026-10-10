/**
 * Which session events place OUR player somewhere new — the events the
 * portal-space gate (PortalSpaceGate.ts) holds until the destination is
 * resident — and the DAT roots an object's appearance reads.
 *
 *  - login / re-creation: CreateObject for our guid carrying a position
 *    (main.ts objectCreate → startGame, or handleTeleportToPosition when the
 *    game already started);
 *  - teleport arrival: the UpdatePosition 0xF748 for our guid while a
 *    PlayerTeleport is pending (main.ts onUpdatePosition → handleTeleportToPosition).
 *
 * Pure: main.ts passes the state (our guid, teleport pending) it already keeps.
 */
import { GameMessageOpcode } from '@ac/network/GameMessageOpcode.js';
import { type FileKey, fileKey } from './DatStore.js';

export interface ArrivalContext {
  /** Our character's guid (null before Enter World). */
  playerGuid: number | null;
  /** A PlayerTeleport arrived and its destination UpdatePosition has not. */
  teleportPending: boolean;
}

/** The appearance fields of a CreateObject that pick DAT files. */
export interface AppearanceRefs {
  setupId: number;
  motionTableId?: number;
  basePalette?: number;
  subPalettes?: ReadonlyArray<{ paletteId: number }>;
  textureChanges?: ReadonlyArray<{ newTexture: number }>;
  animPartChanges?: ReadonlyArray<{ partId: number }>;
  /** PhysicsDesc DefaultScript (0x33), when the object overrides its Setup's. */
  defaultScript?: number;
  /** PhysicsDesc PeTable (0x34): its Hidden / UnHide scripts play on every arrival (HiddenStateScripts). */
  peTableId?: number;
}

interface MinimalEvent { type: string; data?: unknown }

/** The destination cell id (0xXXYYCCCC) an event moves our player to, or null. */
export function arrivalCellOf(event: MinimalEvent, ctx: ArrivalContext): number | null {
  if (ctx.playerGuid === null) return null;
  if (event.type === 'objectCreate') {
    const d = event.data as { guid?: number; position?: { landblock: number } | null } | undefined;
    if (d && d.guid === ctx.playerGuid && d.position) return d.position.landblock >>> 0;
    return null;
  }
  if (event.type === 'message' && ctx.teleportPending) {
    const m = event.data as { type?: string; opcode?: number; payload?: Uint8Array } | undefined;
    if (!m || m.type === 'event' || m.opcode !== GameMessageOpcode.UpdatePosition || !m.payload || m.payload.byteLength < 12) return null;
    const dv = new DataView(m.payload.buffer, m.payload.byteOffset, m.payload.byteLength);
    // UpdatePosition: u32 guid, u32 PositionFlags, then the position's u32 cell id (ServerMessageHandler.handleUpdatePosition).
    if (dv.getUint32(0, true) !== ctx.playerGuid) return null;
    return dv.getUint32(8, true);
  }
  return null;
}

/** The DAT files an object's model build starts from (DatClosure walks the rest). */
export function appearanceRoots(a: AppearanceRefs): FileKey[] {
  const out = new Set<FileKey>();
  const add = (id: number | undefined) => { if (id) out.add(fileKey('portal', id >>> 0)); };
  add(a.setupId);
  add(a.motionTableId);
  add(a.basePalette);
  for (const p of a.subPalettes ?? []) add(p.paletteId);
  for (const t of a.textureChanges ?? []) add(t.newTexture);
  for (const p of a.animPartChanges ?? []) add(p.partId);
  if (a.defaultScript && a.defaultScript >>> 24 === 0x33) add(a.defaultScript);
  if (a.peTableId && a.peTableId >>> 24 === 0x34) add(a.peTableId);
  return [...out];
}

/** The icon fields of a CreateObject (IconData: the icon and its custom underlay / overlay). */
export interface IconRefs {
  iconId?: number;
  iconOverlayId?: number;
  iconUnderlayId?: number;
}

/**
 * The DAT files an object's UI icon starts from (RELEASE.streaming-regression-gate):
 * the icon and its custom layers; DatClosure walks a paletted icon's palette.
 * `extra` adds the composite's table-picked layers (type backdrop, UiEffects
 * tint) when the caller can resolve them (GameUI.itemIconFileIds).
 */
export function iconRoots(d: IconRefs, extra: readonly number[] = []): FileKey[] {
  const out = new Set<FileKey>();
  for (const id of [d.iconId, d.iconOverlayId, d.iconUnderlayId, ...extra]) if (id) out.add(fileKey('portal', id >>> 0));
  return [...out];
}

/**
 * Roots for every CreateObject among queued session events (the gate's
 * beforeRelease pass): each object's model and its icon, so the login
 * inventory / paperdoll draw their icons when the hold releases.
 */
export function queuedObjectRoots(events: readonly MinimalEvent[]): FileKey[] {
  const out = new Set<FileKey>();
  for (const e of events) {
    if (e.type !== 'objectCreate') continue;
    const d = e.data as (AppearanceRefs & IconRefs) | undefined;
    if (!d) continue;
    if (d.setupId) for (const k of appearanceRoots(d)) out.add(k);
    for (const k of iconRoots(d)) out.add(k);
  }
  return [...out];
}
