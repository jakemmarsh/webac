/**
 * BUG.telemetry-duplicate-resend — one client event, logged once.
 *
 * Production, build 327ed434 (AC1999, 2026-10-15): one logout logged two
 * client_world world_left lines 1 ms apart, identical but for `lateMs=0` on
 * the second. The page's telemetry outbox (renderer
 * telemetry/TelemetryOutbox.ts) keeps an event whose fetch promise rejected
 * and sends it again; a logout is followed by the epilogue's page reload, and
 * a keepalive fetch that was delivered still rejects as its page unloads, so
 * the event went twice. Any send that fails AFTER delivery can do this, so the
 * page gives every event an id (`eid`) when it is first posted and keeps it on
 * every resend, and the bridge logs each id once.
 *
 * Bounded memory: at most RECENT_IDS_MAX ids, each forgotten after
 * RECENT_IDS_TTL_MS (a resend comes within seconds; the outbox only holds an
 * event while its page lives). An event without an id (an older page) is
 * always logged, as before.
 */

/** A page's event id: lowercase letters and digits (the client sends 12 hex). */
export const EVENT_ID_PATTERN = /^[a-z0-9]{8,32}$/;
export const RECENT_IDS_MAX = 4096;
export const RECENT_IDS_TTL_MS = 15 * 60_000;

/** `{ eid }` when the event carries a valid id, else nothing. */
export function eidField(v: unknown): { eid?: string } {
  return typeof v === 'string' && EVENT_ID_PATTERN.test(v) ? { eid: v } : {};
}

/** The ids logged recently, oldest first (a Map keeps insertion order). */
export class RecentEventIds {
  private readonly seenAt = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly max = RECENT_IDS_MAX,
    private readonly ttlMs = RECENT_IDS_TTL_MS,
  ) {}

  get size(): number { return this.seenAt.size; }

  /**
   * True when `eid` was already logged within the window (drop the event);
   * otherwise remembers it and returns false. A missing id is never a repeat.
   */
  repeat(eid: string | undefined | null): boolean {
    const at = this.now();
    this.expire(at);
    if (!eid) return false;
    if (this.seenAt.has(eid)) return true;
    this.seenAt.set(eid, at);
    if (this.seenAt.size > this.max) this.seenAt.delete(this.seenAt.keys().next().value as string);
    return false;
  }

  private expire(at: number): void {
    for (const [id, t] of this.seenAt) {
      if (at - t < this.ttlMs) break;
      this.seenAt.delete(id);
    }
  }
}
