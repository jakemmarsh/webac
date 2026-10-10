/**
 * Client-side FIFO of casts sent to the server but not yet confirmed.
 *
 * FAITHFUL.219 — the cast handler queues a cast at packet-send time; the
 * War/Void projectile visual only fires once the server confirms the cast
 * went through (HearSpeech echoing our own incantation), never on a
 * client-side coin flip. FAITHFUL.222 drains it on spell-failure
 * WeenieErrors so the FIFO can't desync under fast cast+reject sequences.
 *
 * BUG.death-doesnt-clear-pending-casts — ACE's Player_Death.cs Die() calls
 * FailCast(false) unconditionally when the player dies mid-cast
 * (CombatMode.Magic && MagicState.IsCasting), ending the server's cast
 * state via SendUseDoneEvent(None). A cast still in this queue at the
 * moment of death is therefore already dead server-side; clear() drops it
 * instead of leaving it to the 8s TTL prune (which kept the HUD busy/cast
 * indicator lit after death).
 */
export interface PendingCast {
  spellId: number;
  targetGuid: number | null;
  sentAt: number;
}

export const PENDING_CAST_TTL_MS = 8000;

export class PendingCastQueue {
  private readonly casts: PendingCast[] = [];
  private readonly ttlMs: number;

  constructor(ttlMs: number = PENDING_CAST_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get length(): number {
    return this.casts.length;
  }

  /** Drop entries older than the TTL (oldest-first, since the queue is FIFO-ordered by sentAt). */
  prune(now: number = Date.now()): void {
    while (this.casts.length > 0 && now - this.casts[0].sentAt > this.ttlMs) {
      this.casts.shift();
    }
  }

  push(spellId: number, targetGuid: number | null, now: number = Date.now()): void {
    this.prune(now);
    this.casts.push({ spellId, targetGuid, sentAt: now });
  }

  /** Consume (FIFO) the oldest pending cast, pruning stale entries first. */
  consumeNext(now: number = Date.now()): PendingCast | null {
    this.prune(now);
    return this.casts.shift() ?? null;
  }

  /** BUG.death-doesnt-clear-pending-casts — drop everything (see class doc). */
  clear(): void {
    this.casts.length = 0;
  }
}
