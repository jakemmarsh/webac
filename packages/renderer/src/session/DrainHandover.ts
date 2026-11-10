/**
 * The page's side of a bridge deploy (docs/bridge-handover.md).
 *
 * A deploy drains the old bridge: it keeps its sessions until they end, or
 * until BRIDGE_DRAIN_SECONDS (6 h) when it cuts them. Now it tells every tab
 * as the drain starts ({"bridgeDraining":true,"handover":true}), and the tab
 * moves its live session to the new deployment (NetConnection.handover:
 * same session, same character, only the WebSocket changes), at a safe
 * moment only. Safe means nothing a lost packet or a stall could turn into a
 * death: not in a combat stance, no fight on either side for
 * HANDOVER_COMBAT_QUIET_MS, no creature chasing or stuck to the character,
 * not dead, not in portal space or a teleport, no trade, vendor or blocking
 * dialog, no enter-world under way; and all of that for HANDOVER_SAFE_HOLD_MS
 * in a row, so a lull inside a fight doesn't count. A session that never
 * finds one stays on the old bridge until the drain's hard cut, as before;
 * the page's automatic resume then brings it back (reported as 'hard_cut').
 *
 * Telemetry: one 'handover' preworld outcome per move, with how long it took,
 * why ('safe' / 'hard_cut') and how ('adopt': the socket moved; 'relogin':
 * the resume logged back in), and `yieldedMs` when a running macro held for it.
 *
 * A running macro (agent/RoutineEngine.ts) is always fighting, so it never
 * found a safe moment and always took the hard cut (Coldeve, 2026-11-07 22:41Z
 * and 00:26Z: three macro tabs each deploy). While a handover is wanted
 * (yieldWanted: draining, the bridge can hand over, and no more than
 * HANDOVER_YIELD_MAX_MS since the notice) the macro yields: it finishes its
 * fight, starts nothing new, goes to peace and holds still, so the safe moment
 * comes; it tells this class so (noteYield). None of the safety rules above
 * change for it.
 */
import type { HandoverResult } from '@ac/network';
import type { HandoverPath, HandoverReason } from '../telemetry/PreworldReporter.js';
import { HANDOVER_RETRY_MS } from './RetryPolicy.js';

/** What the page knows about the character's situation right now. */
export interface HandoverSafety {
  /** In the world (false: at character select, where there's nothing to lose). */
  inWorld: boolean;
  /** An enter-world request or an automatic resume is under way. */
  entering: boolean;
  /** A combat stance (melee, missile, magic) rather than peace. */
  combatStance: boolean;
  dead: boolean;
  /** Portal space is up, or the server announced a teleport that hasn't landed. */
  portalSpace: boolean;
  trade: boolean;
  vendor: boolean;
  /** A blocking window (a confirmation, a popup, a message, a book), or null. */
  dialog: string | null;
  /** When the character last attacked or was attacked (either notification), on the host's clock; null: never. */
  lastCombatAt: number | null;
  /** Creatures chasing, facing to attack, or stuck to the character. */
  hostilesSeeking: number;
}

/** No attack either way for this long before a handover. */
export const HANDOVER_COMBAT_QUIET_MS = 15_000;
/** Safe this long in a row before the handover starts. */
export const HANDOVER_SAFE_HOLD_MS = 2_000;
/** How often the page looks. */
export const HANDOVER_POLL_MS = 500;
/**
 * A running macro holds for the handover for at most this long after the drain notice; after that it carries on, and
 * a session that still finds no safe moment takes the drain's hard cut as before. A calm macro needs the quiet period
 * plus the hold (about 17 s) after its last fight.
 */
export const HANDOVER_YIELD_MAX_MS = 120_000;

export type HandoverBlocker =
  | 'entering' | 'dead' | 'portal_space' | 'combat_stance' | 'recent_combat' | 'hostile' | 'trade' | 'vendor' | 'dialog';

/** Why now isn't safe, or null when it is. */
export function handoverBlocker(s: HandoverSafety, now: number): HandoverBlocker | null {
  if (s.entering) return 'entering';
  // Before the world (a login's tunnel) as much as in it.
  if (s.portalSpace) return 'portal_space';
  if (!s.inWorld) return null;
  if (s.dead) return 'dead';
  if (s.combatStance) return 'combat_stance';
  if (s.lastCombatAt !== null && now - s.lastCombatAt < HANDOVER_COMBAT_QUIET_MS) return 'recent_combat';
  if (s.hostilesSeeking > 0) return 'hostile';
  if (s.trade) return 'trade';
  if (s.vendor) return 'vendor';
  if (s.dialog) return 'dialog';
  return null;
}

export interface DrainHandoverHost {
  safety(): HandoverSafety;
  /** NetConnection.handover(): answered through onResult. */
  handover(): void;
  /** `yieldedMs`: a running macro held this long for the move (absent: none held). */
  report(r: { reason: HandoverReason; path: HandoverPath; ms: number; token?: string | null; yieldedMs?: number }): void;
  now(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(t: unknown): void;
  log?(text: string): void;
}

export class DrainHandover {
  /** The session's bridge is draining (a deploy). */
  private draining = false;
  /** When the drain notice arrived (host clock). */
  private drainingAt = 0;
  /** It can hand sessions over (it said so). */
  private capable = false;
  private inFlight = false;
  private startedAt = 0;
  private safeSince: number | null = null;
  private failures = 0;
  private nextTryAt = 0;
  private timer: unknown = null;
  /** The session ended while its bridge drained: the resume's arrival is reported (why, and since when). */
  private dropped: { at: number; reason: HandoverReason; yieldedMs: number | null } | null = null;
  /** A running macro started holding for this drain's handover at (host clock), and stopped (or the handover began) at. */
  private yieldFrom: number | null = null;
  private yieldTo: number | null = null;

  constructor(private readonly host: DrainHandoverHost) {}

  /** A handover is under way. */
  get busy(): boolean { return this.inFlight; }
  get isDraining(): boolean { return this.draining; }
  /**
   * How long the bridge has been draining with the session still on it, or null when it isn't.
   * Read by the world_left report (WorldReporter drainWaitMs), so a session that never found a safe
   * moment and then closed or was cut still says how long it waited (TELEMETRY.freeze-ending-in-close).
   */
  drainingForMs(): number | null {
    return this.draining ? Math.max(0, this.host.now() - this.drainingAt) : null;
  }

  /**
   * A running macro should hold for the handover now: the bridge drains and can hand the session over, and it is no
   * more than HANDOVER_YIELD_MAX_MS since the notice (or an attempt is under way). Players not running one are never
   * held: nothing else reads this.
   */
  yieldWanted(): boolean {
    if (!this.draining || !this.capable) return false;
    return this.inFlight || this.host.now() - this.drainingAt < HANDOVER_YIELD_MAX_MS;
  }

  /** The running macro started (true) or stopped (false) holding for the handover: reported as `yieldedMs`. */
  noteYield(on: boolean): void {
    const now = this.host.now();
    if (on) {
      if (!this.draining || this.yieldFrom !== null) return;
      this.yieldFrom = now;
      this.host.log?.('the running macro is holding for the handover');
    } else if (this.yieldFrom !== null && this.yieldTo === null) {
      this.yieldTo = now;
    }
  }

  /** How long a running macro held for this drain's handover, up to the attempt (or until now); null: none did. */
  private yieldedMs(): number | null {
    if (this.yieldFrom === null) return null;
    // Never past the cap: a macro mid-step there lets go at its next step, but the yield ended at the cap.
    const end = Math.min(this.yieldTo ?? this.host.now(), this.drainingAt + HANDOVER_YIELD_MAX_MS);
    return Math.max(0, end - this.yieldFrom);
  }

  /** The session's bridge started draining (`handover`: it can hand the session over). */
  onDraining(handover: boolean): void {
    if (this.draining && this.capable === handover) return;
    if (!this.draining) { this.drainingAt = this.host.now(); this.yieldFrom = null; this.yieldTo = null; }
    this.draining = true;
    this.capable = handover;
    this.safeSince = null;
    this.failures = 0;
    this.nextTryAt = 0;
    this.host.log?.(handover ? 'the bridge is draining: handing the session over at the next safe moment'
      : 'the bridge is draining and can\'t hand sessions over: staying until it closes');
    if (handover && this.timer === null) {
      this.timer = (this.host.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(() => this.tick(), HANDOVER_POLL_MS);
    }
  }

  /** One look: hand over once it has been safe for HANDOVER_SAFE_HOLD_MS. */
  tick(): void {
    if (!this.draining || !this.capable || this.inFlight) return;
    const now = this.host.now();
    if (now < this.nextTryAt) return;
    const blocker = handoverBlocker(this.host.safety(), now);
    if (blocker) { this.safeSince = null; return; }
    if (this.safeSince === null) { this.safeSince = now; return; }
    if (now - this.safeSince < HANDOVER_SAFE_HOLD_MS) return;
    this.inFlight = true;
    this.startedAt = now;
    // A macro's hold counts up to here: what follows is the move itself.
    if (this.yieldFrom !== null && this.yieldTo === null) this.yieldTo = now;
    this.host.log?.('safe moment: handing the session over to the new bridge');
    this.host.handover();
  }

  /** The connection's answer ('handover' event). */
  onResult(r: HandoverResult): void {
    if (!this.inFlight) return;
    this.inFlight = false;
    this.safeSince = null;
    const yielded = this.yieldedMs();
    const y = yielded !== null ? { yieldedMs: yielded } : {};
    if (r.ok) {
      this.host.log?.(`handed over in ${r.ms} ms${yielded !== null ? ` (the macro held ${Math.round(yielded / 1000)} s for it)` : ''}`);
      this.host.report({ reason: 'safe', path: 'adopt', ms: r.ms, ...y });
      this.stop();
      return;
    }
    const token = `${r.stage}_${r.reason}`.replace(/[^A-Za-z0-9_]/g, '_');
    this.host.log?.(`handover failed at ${r.stage}: ${r.reason}${r.released ? ' (the session ended: resuming)' : ''}`);
    this.host.report({ reason: 'safe', path: 'adopt', ms: r.ms, token, ...y });
    if (r.released) {
      // The session is gone; the resume brings it back and is reported from where this began.
      this.stop();
      this.dropped = { at: this.startedAt, reason: 'safe', yieldedMs: yielded };
      return;
    }
    if (this.failures >= HANDOVER_RETRY_MS.length) {
      this.host.log?.('giving up on the handover: staying on this bridge until it closes');
      this.stop();
      return;
    }
    this.nextTryAt = this.host.now() + HANDOVER_RETRY_MS[this.failures++];
  }

  /** The session ended (not deliberately): while draining, that is the hard cut (or a drop), and the resume follows. */
  onSessionDropped(): void {
    if (this.draining && !this.dropped) this.dropped = { at: this.host.now(), reason: 'hard_cut', yieldedMs: this.yieldedMs() };
    this.stop();
  }

  /** Back in the world after a resume: report a move that came by re-login. */
  onEnteredWorld(): void {
    const d = this.dropped;
    this.dropped = null;
    if (d) this.host.report({ reason: d.reason, path: 'relogin', ms: this.host.now() - d.at, ...(d.yieldedMs !== null ? { yieldedMs: d.yieldedMs } : {}) });
  }

  /** A deliberate logout, a launcher return, giving up: nothing to report. */
  reset(): void {
    this.dropped = null;
    this.stop();
  }

  private stop(): void {
    this.draining = false;
    this.capable = false;
    this.inFlight = false;
    this.safeSince = null;
    this.yieldFrom = null;
    this.yieldTo = null;
    if (this.timer !== null) (this.host.clearInterval ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
  }
}
