/**
 * TELEMETRY.portal-use-failed — a portal the player tried that did nothing.
 *
 * A Levistras player (an ACE server with custom content) reported that the
 * exit portal of the custom "Scrivener's Annex" dungeon (landblock 0x0135)
 * did nothing, and logged in inside the annex twice. The stock exit portal
 * there works in our client (verified on local ACE, 2026-10-21), and we cannot
 * see that server's custom portal data. This event is what explains the next
 * "portal does nothing", for any player on any server.
 *
 * A watch starts when the player tries a portal (an object whose
 * ObjectDescriptionFlag has Portal 0x40000 or whose ItemType has Portal
 * 0x10000):
 * - `use`: a Use on it (double-click, the Use key or button, ac_use), whether
 *   or not the client sent the Use (`useSent` false + `held` say why not);
 * - `walk_in`: the player's body began to touch the portal's physics shape
 *   (main.ts, each 100 ms: the body's Setup spheres against the portal's —
 *   bodyTouchesPortal, the sphere-sphere test a server transition makes —
 *   else, with either shape unknown, the body's middle within the portal's
 *   part-array reach). `closest` is the body's nearest horizontal approach to
 *   the portal's centre during the watch.
 *
 * GDLE (Dark Majesty) has no Use for a walk-in: the portal acts only when the
 * server's own transition of the player sweeps the player's spheres into the
 * portal's (CPhysicsObj::report_object_collision → CPortal::DoCollision), and
 * the server learns where we are from a MoveToState (a swept transition),
 * a once-a-second AutonomousPosition (SetPositionSimple: a placement at the
 * point, no sweep) and its own simulation between them. A walk-in the server
 * never collided with ends here as a failure with no WeenieError
 * (BUG.gdle-walkin-portal-silent, progress.md 2026-10-24).
 *
 * It ends well when the server teleports us (PlayerTeleport 0xF751, which
 * starts portal space): one light `portal_used` with the ms from the try to
 * the teleport. With no teleport within PORTAL_REPLY_MS of the last sign of
 * progress (the try, a UseDone, a step of the server's walk to the portal)
 * it ends as one `portal_use_failed`, carrying what came back meanwhile: the
 * UseDone code, every WeenieError code, and the first server chat line about
 * portals as a template.
 *
 * PORTAL_REPLY_MS (5 s): ACE runs a portal's use as soon as the player is in
 * range (Portal.cs ActOnUse → WorldManager.ThreadSafeTeleport → Player.Teleport,
 * which sends PlayerTeleport at once, or 1 s later when it first clears fog:
 * Player_Location.cs Teleport), and a refusal comes back as a WeenieError from
 * Portal.cs CheckUseRequirements at the same moment. Portal.cs's own
 * minTimeSinceLastPortal is 3.5 s (a second try inside it after a refusal gets
 * no answer at all). Five seconds covers the fog delay and a slow link
 * without folding two tries into one; the server's walk extends the wait
 * while the player is still moving, up to PORTAL_MAX_WAIT_MS.
 *
 * Limits: one event per portal per PORTAL_RATE_MS (a player walking back and
 * forth through a dead portal reports it once a minute), at most
 * MAX_FAILED_EVENTS / MAX_USED_EVENTS per page.
 *
 * Privacy (the pre-world reporter's rules): numbers, booleans, closed tokens.
 * No object or player name. Chat is reduced to a template (digits → '#') and
 * only for a server line that speaks of portals, teleporting, a destination,
 * a quest or a recall; any other line is only counted.
 *
 * Transport: the world reporter's route, `POST /client-preworld`, logged by
 * the bridge as `client_world` (services/ws-tcp-bridge/src/clientWorld.ts).
 * Eras: all three; the inputs (Use, UseDone, WeenieError, PlayerTeleport) are
 * the same messages from ACE, GDLE and the AC1999 server.
 */
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';

export const PORTAL_OUTCOMES = ['portal_use_failed', 'portal_used'] as const;
export type PortalOutcome = typeof PORTAL_OUTCOMES[number];

/** How the player tried the portal. */
export const PORTAL_TRIGGERS = ['use', 'walk_in'] as const;
export type PortalTrigger = typeof PORTAL_TRIGGERS[number];

/**
 * Why the client did not send a Use it was asked for (main.ts sendUseActionNow):
 * the target no longer resolves (GAP.88), the inventory-request gate refused it
 * (a pending request or an attack), or UseObject decided no Use goes out.
 */
export const PORTAL_USE_HELD = ['stale', 'busy', 'decided'] as const;
export type PortalUseHeld = typeof PORTAL_USE_HELD[number];

/** ObjectDescriptionFlag.Portal (ACE ObjectDescriptionFlag.cs) and ItemType.Portal (ItemType.cs). */
export const ODF_PORTAL = 0x00040000;
export const ITEM_TYPE_PORTAL = 0x00010000;
/** PhysicsState bits (ACE PhysicsState.cs). */
const PS_ETHEREAL = 0x4;
const PS_REPORT_COLLISIONS = 0x8;

export const PORTAL_REPLY_MS = 5_000;
export const PORTAL_MAX_WAIT_MS = 30_000;
export const PORTAL_RATE_MS = 60_000;
export const MAX_FAILED_EVENTS = 20;
export const MAX_USED_EVENTS = 30;
/** WeenieError codes kept per event. */
export const MAX_ERROR_CODES = 4;
/** A chat template's longest. */
export const MAX_TEMPLATE_CHARS = 96;

/** A portal object as the client sees it. */
export function isPortalObject(o: { itemType?: number; objectDescFlags?: number } | null | undefined): boolean {
  if (!o) return false;
  return (((o.objectDescFlags ?? 0) & ODF_PORTAL) !== 0) || (((o.itemType ?? 0) & ITEM_TYPE_PORTAL) !== 0);
}

/**
 * The player's body overlaps a portal's shape: horizontal distance within the portal's reach plus the
 * body's radius (touching counts: a solid portal stops the body at its edge), and the portal's base
 * between 1.5 m below the feet and 2 m above them. Render-frame metres.
 */
export function overlapsPortal(horizontalM: number, portalBaseAboveFeetM: number, reachM: number, bodyRadiusM: number): boolean {
  if (!Number.isFinite(horizontalM) || !Number.isFinite(portalBaseAboveFeetM)) return false;
  return horizontalM <= Math.max(0, reachM) + bodyRadiusM + 0.05 && portalBaseAboveFeetM >= -1.5 && portalBaseAboveFeetM <= 2;
}

/**
 * The body touches the portal the way a server transition finds it: any of the body's Setup spheres
 * within (radius sum) of any of the portal's, centres at the objects' origins plus each sphere's height
 * (both Setups' spheres sit on the vertical axis: the portal 0x020001B3 and the heritage bodies).
 * `portalBaseAboveFeetM` = the portal's origin height minus the feet. Empty shapes never touch.
 */
export function bodyTouchesPortal(
  horizontalM: number, portalBaseAboveFeetM: number,
  body: readonly { z: number; radius: number }[], portal: readonly { z: number; radius: number }[],
): boolean {
  if (!Number.isFinite(horizontalM) || !Number.isFinite(portalBaseAboveFeetM)) return false;
  for (const b of body) {
    for (const p of portal) {
      const dz = portalBaseAboveFeetM + p.z - b.z;
      if (Math.hypot(horizontalM, dz) <= b.radius + p.radius) return true;
    }
  }
  return false;
}

/** A server chat line worth a template: it speaks of portals or teleports. */
const PORTAL_CHAT = /portal|teleport|destination|quest|recall|summon/i;

/** A chat line as a template: printable ASCII, every number (hex too) as '#', at most MAX_TEMPLATE_CHARS; null when not about portals. */
export function chatTemplate(text: string): string | null {
  if (!PORTAL_CHAT.test(text)) return null;
  const t = text
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/[0-9]+(?:\.[0-9]+)?/g, '#')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEMPLATE_CHARS);
  return t || null;
}

/** What main.ts reads off a portal and the player, at the try and at the end. */
export interface PortalSnapshot {
  wcid: number;
  itemType: number;
  descFlags: number;
  physicsState: number;
  useRadius: number;
  /** The portal's part-array radius (agent fixtureReach), m. */
  reach: number;
  /** Player → portal in the server's frame: east, north, up (m); null when either position is unknown. */
  rel: { dx: number; dy: number; dz: number } | null;
  playerCell: number | null;
  portalCell: number | null;
}

interface Ids { era: string; server: string | null; trace: string; build: string }

export interface PortalUseFailedEvent extends Ids {
  outcome: 'portal_use_failed';
  trigger: PortalTrigger;
  wcid: number;
  itemType: number;
  descFlags: number;
  physicsState: number;
  ethereal: boolean;
  reportCollisions: boolean;
  /** m, 0.01. */
  useRadius: number;
  reach: number;
  /**
   * Player → portal at the try, server frame (east, north, up), m 0.1; and the horizontal distance at the
   * try and at the end. "Player" is the last AutonomousPosition sent (where the server was last told we
   * are), not the body: walking in, it trails the body by up to a second of running.
   */
  dx: number | null;
  dy: number | null;
  dz: number | null;
  dist: number | null;
  endDist: number | null;
  /** Cells, 8 hex digits: the player's at the try and the portal's. */
  playerCell: string | null;
  portalCell: string | null;
  /** The client sent a Use; when it did not for a use, why (PORTAL_USE_HELD). */
  useSent: boolean;
  held: PortalUseHeld | null;
  /** Uses of this portal during the watch (a player double-clicking again counts). */
  attempts: number;
  /** The body overlapped the portal at some point during the watch. */
  overlapped: boolean;
  /** The body's closest horizontal approach to the portal's centre during the watch, m 0.01; null = not measured. */
  closest: number | null;
  /** The server moved the player during the watch (its MoveTo toward the portal). */
  serverWalk: boolean;
  /** The UseDone code that came back (0 = done, no error); null = no UseDone. */
  useDone: number | null;
  /** WeenieError / WeenieErrorWithString codes that came back, in order. */
  weenieErrors: number[];
  /** Server chat lines in the watch, the first portal line's ChatMessageType and template. */
  chatLines: number;
  chatType: number | null;
  chatTemplate: string | null;
  /** From the try to the verdict. */
  waitedMs: number;
}

export interface PortalUsedEvent extends Ids {
  outcome: 'portal_used';
  trigger: PortalTrigger;
  wcid: number;
  /** The try → PlayerTeleport (portal space starts). */
  ms: number;
  useSent: boolean;
  serverWalk: boolean;
  attempts: number;
}

export type PortalEvent = PortalUseFailedEvent | PortalUsedEvent;

export interface PortalUseReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  /** The portal and the player now; null when the object is gone. */
  snapshot: (guid: number) => PortalSnapshot | null;
  now?: () => number;
  send?: TelemetrySend;
}

interface Watch {
  guid: number;
  trigger: PortalTrigger;
  startedAt: number;
  progressAt: number;
  snap: PortalSnapshot;
  useSent: boolean;
  held: PortalUseHeld | null;
  attempts: number;
  overlapped: boolean;
  closest: number | null;
  serverWalk: boolean;
  useDone: number | null;
  errors: number[];
  chatLines: number;
  chatType: number | null;
  chatTemplate: string | null;
}

function safe<T>(f: (() => T) | undefined, fallback: T): T {
  if (!f) return fallback;
  try { return f(); } catch { return fallback; }
}
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const cellHex = (c: number | null): string | null => (c === null || !Number.isFinite(c) || c === 0 ? null : (c >>> 0).toString(16).padStart(8, '0'));
const horiz = (rel: PortalSnapshot['rel']): number | null => (rel ? r1(Math.hypot(rel.dx, rel.dy)) : null);
const u32 = (v: number): number => (Number.isFinite(v) ? v >>> 0 : 0);

export class PortalUseReporter {
  private readonly now: () => number;
  private readonly outbox: TelemetryOutbox;
  private watch: Watch | null = null;
  private failedSent = 0;
  private usedSent = 0;
  /** guid → when its last event went (the per-portal rate). */
  private readonly lastEventAt = new Map<number, number>();
  /** Portals the body overlapped at the last check; null = take the next check as the baseline (after a teleport, at entry). */
  private overlapping: Set<number> | null = null;

  constructor(private readonly opts: PortalUseReporterOptions) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, this.now, true);
  }

  /** The portal under watch (tests, the agent trace). */
  get watching(): number | null { return this.watch?.guid ?? null; }

  /**
   * The player used `guid`. `sent` false with `held` = the client kept the Use. Not a portal: nothing.
   * A use of the portal already watched counts as another attempt and restarts the wait.
   */
  useAttempt(guid: number, o: { itemType?: number; objectDescFlags?: number } | null | undefined, sent: boolean, held: PortalUseHeld | null = null): void {
    if (!isPortalObject(o)) return;
    const at = this.now();
    const w = this.watch;
    if (w && w.guid === guid >>> 0) {
      w.attempts++;
      w.progressAt = at;
      if (sent) { w.useSent = true; w.held = null; } else if (!w.useSent) w.held = held;
      return;
    }
    this.begin(guid, 'use', at, sent, sent ? null : held);
  }

  /**
   * The portals the player's body overlaps now (main.ts, every 100 ms in the world). A portal newly
   * overlapped starts a walk-in watch unless one is running for it; the first check after a teleport or
   * a world entry only records where the body stands (arriving on a portal is no try).
   */
  overlaps(guids: Iterable<number>): void {
    const now = new Set<number>();
    for (const g of guids) now.add(g >>> 0);
    const before = this.overlapping;
    this.overlapping = now;
    if (before === null) return;
    for (const g of now) {
      if (before.has(g)) continue;
      const w = this.watch;
      if (w && w.guid === g) { w.overlapped = true; w.progressAt = this.now(); continue; }
      this.begin(g, 'walk_in', this.now(), false, null);
    }
  }

  /** The body's horizontal distance (m) to the portal under watch now (main.ts, each check); keeps the closest. */
  approach(guid: number, horizontalM: number): void {
    const w = this.watch;
    if (!w || w.guid !== guid >>> 0 || !Number.isFinite(horizontalM) || horizontalM < 0) return;
    if (w.closest === null || horizontalM < w.closest) w.closest = horizontalM;
  }

  /** The server moved the player (a MoveTo / MoveToPosition, our own movement event). */
  serverMovement(): void {
    const w = this.watch;
    if (!w) return;
    w.serverWalk = true;
    w.progressAt = this.now();
  }

  /** UseDone came back (0 = done). */
  useDone(code: number): void {
    const w = this.watch;
    if (!w) return;
    if (w.useDone === null || code !== 0) w.useDone = u32(code);
    w.progressAt = this.now();
  }

  /** A WeenieError or WeenieErrorWithString came back (its code only). */
  weenieError(code: number): void {
    const w = this.watch;
    if (!w || w.errors.length >= MAX_ERROR_CODES) return;
    w.errors.push(u32(code));
  }

  /** A server chat line (ServerMessage 0xF7E0): counted; the first portal line's template kept. */
  serverChat(text: string, chatType: number): void {
    const w = this.watch;
    if (!w) return;
    w.chatLines++;
    if (w.chatTemplate !== null) return;
    const t = chatTemplate(text ?? '');
    if (t !== null) { w.chatTemplate = t; w.chatType = u32(chatType); }
  }

  /** PlayerTeleport: the server took us (portal space starts). The watch ends well; overlaps re-baseline. */
  teleported(): void {
    this.overlapping = null;
    const w = this.watch;
    this.watch = null;
    if (!w) return;
    const at = this.now();
    if (!this.allowed(w.guid, at) || this.usedSent >= MAX_USED_EVENTS) return;
    this.usedSent++;
    this.post({
      outcome: 'portal_used', ...this.ids(), trigger: w.trigger, wcid: u32(w.snap.wcid),
      ms: Math.max(0, Math.round(at - w.startedAt)), useSent: w.useSent, serverWalk: w.serverWalk, attempts: w.attempts,
    });
  }

  /** Entered or left the world (any way): a watch from the last session is dropped unreported. */
  reset(): void {
    this.watch = null;
    this.overlapping = null;
  }

  /** The verdict clock: main.ts calls it every 100 ms; `moving` = the player's body is moving now. */
  tick(moving: boolean): void {
    this.outbox.retry();
    const w = this.watch;
    if (!w) return;
    const at = this.now();
    if (moving && w.serverWalk) w.progressAt = at;
    if (at - w.progressAt < PORTAL_REPLY_MS && at - w.startedAt < PORTAL_MAX_WAIT_MS) return;
    this.watch = null;
    if (!this.allowed(w.guid, at) || this.failedSent >= MAX_FAILED_EVENTS) return;
    this.failedSent++;
    const end = safe(() => this.opts.snapshot(w.guid), null);
    const s = w.snap;
    this.post({
      outcome: 'portal_use_failed', ...this.ids(), trigger: w.trigger,
      wcid: u32(s.wcid), itemType: u32(s.itemType), descFlags: u32(s.descFlags), physicsState: u32(s.physicsState),
      ethereal: (s.physicsState & PS_ETHEREAL) !== 0,
      reportCollisions: (s.physicsState & PS_REPORT_COLLISIONS) !== 0,
      useRadius: r2(Math.max(0, s.useRadius || 0)),
      reach: r2(Math.max(0, s.reach || 0)),
      dx: s.rel ? r1(s.rel.dx) : null,
      dy: s.rel ? r1(s.rel.dy) : null,
      dz: s.rel ? r1(s.rel.dz) : null,
      dist: horiz(s.rel),
      endDist: horiz(end?.rel ?? null),
      playerCell: cellHex(s.playerCell),
      portalCell: cellHex(s.portalCell),
      useSent: w.useSent,
      held: w.useSent ? null : w.held,
      attempts: w.attempts,
      overlapped: w.overlapped,
      closest: w.closest === null ? null : r2(w.closest),
      serverWalk: w.serverWalk,
      useDone: w.useDone,
      weenieErrors: [...w.errors],
      chatLines: w.chatLines,
      chatType: w.chatType,
      chatTemplate: w.chatTemplate,
      waitedMs: Math.max(0, Math.round(at - w.startedAt)),
    });
  }

  /** online → retry; a hidden or leaving page sends what waits by beacon. */
  install(win: Pick<Window, 'addEventListener'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    this.outbox.install(win);
    win.addEventListener('pagehide', () => this.outbox.retry(true));
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.outbox.retry(true); });
  }

  private begin(guid: number, trigger: PortalTrigger, at: number, sent: boolean, held: PortalUseHeld | null): void {
    const snap = safe(() => this.opts.snapshot(guid >>> 0), null);
    if (!snap) return;
    this.watch = {
      guid: guid >>> 0, trigger, startedAt: at, progressAt: at, snap,
      useSent: sent, held, attempts: trigger === 'use' ? 1 : 0, overlapped: trigger === 'walk_in', closest: null,
      serverWalk: false, useDone: null, errors: [], chatLines: 0, chatType: null, chatTemplate: null,
    };
  }

  /** One event per portal per PORTAL_RATE_MS; records the send. */
  private allowed(guid: number, at: number): boolean {
    const last = this.lastEventAt.get(guid);
    if (last !== undefined && at - last < PORTAL_RATE_MS) return false;
    this.lastEventAt.set(guid, at);
    if (this.lastEventAt.size > 256) {
      for (const [g, t] of this.lastEventAt) if (at - t >= PORTAL_RATE_MS) this.lastEventAt.delete(g);
    }
    return true;
  }

  private ids(): Ids {
    return { era: safe(this.opts.era, 'unknown'), server: safe(this.opts.server, null), trace: this.opts.trace, build: this.opts.build };
  }

  private post(ev: PortalEvent): void {
    if (!this.opts.endpoint) return;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
