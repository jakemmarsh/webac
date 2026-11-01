/**
 * TELEMETRY.objsend-diagnostics — what the client held when the player asked
 * the server to resend every object it knows.
 *
 * ACE's player command `@objsend` ("Force resend of all visible objects known
 * to this player. Can fix rare cases of invisible object bugs", ACE
 * PlayerCommands.cs HandleObjSend: once per 5 minutes; for each known object
 * RemoveTrackedObject + TrackObject, a fresh CreateObject) is what a player
 * types when something the server says is there is not drawn. A Coldeve
 * player (2026-11-01) used it twice within 5 minutes after ~50 minutes of
 * portal trips and logged out 31 s later; nothing in our telemetry could say
 * whether our client had dropped objects.
 *
 * When the line goes to the server as Talk (CommandSystem.doCommand's
 * fall-through, the path every ACE '@' command takes; '/objsend' is '@objsend'
 * by then), one `objsend` event carries a snapshot of the object table, and
 * OBJSEND_AFTER_MS later one `objsend_after` carries a second snapshot plus
 * the CreateObjects that arrived in between, classified against the guids
 * the client held when the command went out: `createsNew` (not held then: it
 * had lost an object the server counts as known) and `createsKnown` (a resend
 * of one it held), plus `deletes` (DeleteObjects in the window). ACE's
 * HandleObjSend sends RemoveTrackedObject (a DeleteObject) before each
 * TrackObject, so a create's guid is never held at create time: the set must
 * be taken at the command (live test on local ACE, 2026-11-01: a fresh
 * character read createsNew=23 createsKnown=0 when classified at create).
 *
 * Snapshot (summarizeObjects): objects placed in the world within
 * OBJSEND_VIEW_M of the player are `inView`; each in-view object is exactly
 * one of drawn, `hiddenByState` (PhysicsState Hidden / NoDraw: the server hid
 * it), `culledByCell` (its env cell is not drawn this frame: normal indoors),
 * or unrendered:
 *  - `lostCell`: ObjectMaint took it out of the world because its cell is not
 *    loaded (CPhysicsObj::leave_visibility; ServerObjectManager.updateObjectMaint),
 *  - `noMesh`: it has a Setup but no built mesh (the Setup or a part was not
 *    resident and the streamed rebuild has not landed, or the build threw),
 *  - `detached`: a mesh that is not in the scene graph,
 *  - `invisible`: a mesh in the scene whose root is not visible for none of
 *    the reasons above.
 * `releasedInView` counts objects ObjectMaint deleted (out of sight 25 s)
 * whose last place is in view: ACE may still count them as known and send no
 * CreateObject for them until something about them changes.
 *
 * Eras: ACE (end of retail) and ACE-based classic servers have @objsend; GDLE
 * answers it as an unknown command (the event still shows what we held). The
 * AC1999 server has no equivalent (reference/ac1999 ClientCommands.cpp:
 * `comptrack resend` is an admin component dump), so main.ts turns the
 * reporter off for the 1999 protocol.
 *
 * Privacy: counts, a hex cell, wcids and ItemType bits only. No name, no
 * chat text (the command word is matched, never sent).
 */
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';

export const OBJSEND_OUTCOMES = ['objsend', 'objsend_after'] as const;
export type ObjsendOutcome = typeof OBJSEND_OUTCOMES[number];

/** The second snapshot's delay: ACE resends at once, so 5 s covers a slow link and the streamed rebuilds. */
export const OBJSEND_AFTER_MS = 5_000;
/** "In view": horizontal metres from the player (the radar's 75 m outdoors is wider; 60 m is what is plainly on screen). */
export const OBJSEND_VIEW_M = 60;
/** Most objsend commands reported per page (ACE allows one every 5 minutes). */
export const MAX_OBJSEND_EVENTS = 10;
/** How many of the most common wcids / ItemTypes among the unrendered are kept. */
export const OBJSEND_TOP = 5;

/** PhysicsState Hidden 0x4000 | NoDraw 0x20 (ACE PhysicsState.cs; ServerObjectManager PHYSICS_HIDE_MASK). */
const HIDE_MASK = 0x4000 | 0x20;

/** The command word: '/objsend' or '@objsend' (any case, optional trailing commas, any arguments). */
export function isObjsendCommand(line: string): boolean {
  const m = /^[@/](\S+)/.exec((line ?? '').trim());
  return !!m && m[1].replace(/,+$/, '').toLowerCase() === 'objsend';
}

/** What summarizeObjects reads off a ServerObject (a structural slice, so tests can fake the table). */
export interface ObjsendObject {
  guid: number;
  weenieClassId: number;
  itemType: number;
  setupId: number;
  physicsState: number;
  worldX: number;
  worldZ: number;
  objCellId?: number;
  wielderId?: number;
  lostCell?: boolean;
  outOfWorld?: boolean;
  _culledByCell?: boolean;
  mesh: { visible: boolean; parent: unknown } | null;
}

export interface ObjsendCounts {
  /** Every object in the client's table (CreateObject, not deleted). */
  serverObjects: number;
  /** Placed in a cell in the world (not carried, contained, wielded or picked up). */
  placed: number;
  inView: number;
  unrendered: number;
  lostCell: number;
  noMesh: number;
  detached: number;
  invisible: number;
  hiddenByState: number;
  culledByCell: number;
  /** The most common wcids / ItemTypes among the unrendered, most common first. */
  topWcids: number[];
  topItemTypes: number[];
}

function top(counts: Map<number, number>): number[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, OBJSEND_TOP).map(([k]) => k);
}

/** Classify the client's objects around the viewer (render axes: X / Z horizontal). */
export function summarizeObjects(
  objects: Iterable<ObjsendObject>, viewer: { x: number; z: number; guid: number }, radiusM = OBJSEND_VIEW_M,
): ObjsendCounts {
  const c: ObjsendCounts = {
    serverObjects: 0, placed: 0, inView: 0, unrendered: 0, lostCell: 0, noMesh: 0, detached: 0, invisible: 0,
    hiddenByState: 0, culledByCell: 0, topWcids: [], topItemTypes: [],
  };
  const wcids = new Map<number, number>();
  const types = new Map<number, number>();
  const r2 = radiusM * radiusM;
  for (const o of objects) {
    c.serverObjects++;
    if (o.guid === viewer.guid || o.wielderId || o.outOfWorld || !o.objCellId) continue;
    c.placed++;
    const dx = o.worldX - viewer.x;
    const dz = o.worldZ - viewer.z;
    if (!(dx * dx + dz * dz <= r2)) continue;
    c.inView++;
    if ((o.physicsState & HIDE_MASK) !== 0) { c.hiddenByState++; continue; }
    let why: 'lostCell' | 'noMesh' | 'detached' | 'invisible' | null = null;
    if (o.lostCell) why = 'lostCell';
    else if (!o.mesh) { if (o.setupId) why = 'noMesh'; }
    else if (!o.mesh.parent) why = 'detached';
    else if (o._culledByCell) { c.culledByCell++; continue; }
    else if (!o.mesh.visible) why = 'invisible';
    if (!why) continue;
    c[why]++;
    c.unrendered++;
    const w = o.weenieClassId >>> 0;
    wcids.set(w, (wcids.get(w) ?? 0) + 1);
    const t = o.itemType >>> 0;
    types.set(t, (types.get(t) ?? 0) + 1);
  }
  c.topWcids = top(wcids);
  c.topItemTypes = top(types);
  return c;
}

/**
 * Released records (ServerObjectManager.releasedRecords) whose last place is within `radiusM` of the
 * player's last sent position, compared in the server's frame (landblock x · 192 + x, y · 192 + y).
 */
export function countReleasedInView(
  records: Iterable<{ position?: { landblock: number; x: number; y: number } | null }>,
  me: { cellId: number; x: number; y: number } | null, radiusM = OBJSEND_VIEW_M,
): { released: number; releasedInView: number } {
  const gx = (cell: number, x: number): number => ((cell >>> 24) & 0xff) * 192 + x;
  const gy = (cell: number, y: number): number => ((cell >>> 16) & 0xff) * 192 + y;
  let released = 0;
  let releasedInView = 0;
  for (const r of records) {
    released++;
    const p = r.position;
    if (!me || !me.cellId || !p || !p.landblock) continue;
    if (Math.hypot(gx(p.landblock, p.x) - gx(me.cellId, me.x), gy(p.landblock, p.y) - gy(me.cellId, me.y)) <= radiusM) releasedInView++;
  }
  return { released, releasedInView };
}

/** What main.ts reads at each snapshot. */
export interface ObjsendSnapshot extends ObjsendCounts {
  /** ms since the client last placed the player by a teleport (a PlayerTeleport's arrival: portal, recall, lifestone; a context-changing correction); null = none this session. */
  msSinceTeleport: number | null;
  /** The player's cell, 8 hex digits; null when unknown. */
  playerCell: string | null;
  /** Released records (ObjectMaint deleted, kept for the server's next word) in all / within the view radius. */
  released: number;
  releasedInView: number;
  /** DAT files being fetched and files a build missed that have not landed (streamed sets; null = whole DATs). */
  pendingLoads: number | null;
  unresolvedMisses: number | null;
  /** The player is in portal space (the world hidden). */
  portalSpace: boolean;
}

interface Ids { era: string; server: string | null; trace: string; build: string }

export interface ObjsendEvent extends Ids, ObjsendSnapshot {
  outcome: ObjsendOutcome;
  /** The command's ordinal on this page (pairs an objsend with its objsend_after). */
  seq: number;
  /** objsend_after only: CreateObjects since the objsend, for guids the client did not / did hold at the objsend; DeleteObjects since. */
  createsNew?: number;
  createsKnown?: number;
  deletes?: number;
}

export interface ObjsendReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  /** The server has @objsend (false for the AC1999 protocol). */
  enabled: () => boolean;
  /** The snapshot now; null when not in the world. */
  snapshot: () => ObjsendSnapshot | null;
  /** Every guid in the client's object table now (taken at the objsend). */
  heldGuids: () => Iterable<number>;
  now?: () => number;
  send?: TelemetrySend;
  schedule?: (fn: () => void, ms: number) => void;
}

function safe<T>(f: (() => T) | undefined, fallback: T): T {
  if (!f) return fallback;
  try { return f(); } catch { return fallback; }
}

export class ObjsendReporter {
  private readonly outbox: TelemetryOutbox;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private sent = 0;
  private seq = 0;
  /** Open windows (an objsend whose after-snapshot has not gone): their create counts. */
  private readonly windows = new Set<{ held: Set<number>; createsNew: number; createsKnown: number; deletes: number }>();

  constructor(private readonly opts: ObjsendReporterOptions) {
    const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, now, true);
    this.schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
  }

  /**
   * A command line went to the server as Talk (CommandSystem's serverCommandSent). An objsend reports the
   * snapshot now and another OBJSEND_AFTER_MS later. Returns whether it reported.
   */
  commandSent(line: string): boolean {
    if (!isObjsendCommand(line) || !safe(this.opts.enabled, false)) return false;
    if (this.sent >= MAX_OBJSEND_EVENTS) return false;
    const before = safe(this.opts.snapshot, null);
    if (!before) return false;
    this.sent++;
    const seq = ++this.seq;
    this.post({ outcome: 'objsend', ...this.ids(), seq, ...before });
    const held = new Set<number>();
    for (const g of safe(this.opts.heldGuids, [] as Iterable<number>)) held.add(g >>> 0);
    const win = { held, createsNew: 0, createsKnown: 0, deletes: 0 };
    this.windows.add(win);
    this.schedule(() => {
      this.windows.delete(win);
      const after = safe(this.opts.snapshot, null);
      if (!after) return;
      this.post({ outcome: 'objsend_after', ...this.ids(), seq, ...after, createsNew: win.createsNew, createsKnown: win.createsKnown, deletes: win.deletes });
    }, OBJSEND_AFTER_MS);
    return true;
  }

  /** A CreateObject arrived: counted inside each objsend window against the guids held at its command. */
  objectCreated(guid: number): void {
    const g = guid >>> 0;
    for (const w of this.windows) { if (w.held.has(g)) w.createsKnown++; else w.createsNew++; }
  }

  /** A DeleteObject arrived: counted inside each objsend window. */
  objectDeleted(): void {
    for (const w of this.windows) w.deletes++;
  }

  /** online → retry; a hidden or leaving page sends what waits by beacon. */
  install(win: Pick<Window, 'addEventListener'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    this.outbox.install(win);
    win.addEventListener('pagehide', () => this.outbox.retry(true));
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.outbox.retry(true); });
  }

  private ids(): Ids {
    return { era: safe(this.opts.era, 'unknown'), server: safe(this.opts.server, null), trace: this.opts.trace, build: this.opts.build };
  }

  private post(ev: ObjsendEvent): void {
    if (!this.opts.endpoint) return;
    this.outbox.retry();
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
