/**
 * NET.client-suspended-endcause — whether a silence was the server's or our
 * own thread's.
 *
 * Every drop check measures silence as now − the last packet received, which
 * also grows while our own thread is not running (a sleeping laptop, a frozen
 * tab): 2026-10-16 production, a laptop asleep 29 min ended its session as
 * 'server_silent' on waking (net.tickGapMaxMs 1744556, txAgoMs 66). The
 * receiving thread's tick loop feeds a ThreadStallClock; a drop check asks
 * silenceIsOwnStall() and reports 'client_suspended' instead. The drop itself
 * is unchanged: only its label.
 *
 * NET.stale-receive-after-wake — a receive just after waking does not prove
 * the server was there. A WebSocket's messages that reached the machine while
 * the worker was frozen (or that the bridge sent into a sleeping host's TCP
 * window and its retransmit delivers once the network is back) are handed to
 * the worker after it resumes, and the connection stamps a receive when it
 * processes it (Date.now() in handlePacket), not when it arrived.
 * 2026-11-02 production: a Safari Mac asleep ~8 h (tickGapMaxMs 29009725)
 * dropped 40 s after one such receive (rxAgoMs 40010) as 'link_dead', though
 * the bridge saw the server send nothing for 8 h (serverQuietMs 28990418,
 * bytesFromServer = bytesToBrowser) and the server had acknowledged nothing
 * of ours since before the sleep (srvAckAdvAgoMs 29052408 ≈ the stop + 43 s).
 * So a receive within STALE_RECEIVE_GRACE_MS of a stop's end counts as part
 * of the stop unless the server acknowledged a packet we sent after waking:
 * only a live server can do that (a buffered packet was sent before it).
 */

/** The shortest stop worth remembering: the page's 40 s DISCONNECT_TIME, the shortest drop limit of any check. */
export const THREAD_STALL_MIN_MS = 40_000;

/**
 * How long after a stop's end a receive may still be one held through it
 * (NET.stale-receive-after-wake). The 2026-11-02 sample's came within 2.7 s
 * of waking (srvAckAdvAgoMs − tickGapMaxMs − rxAgoMs: the stop ended at most
 * 42.7 s before the drop, the receive 40.0 s before), and in fact before the
 * worker's second 100 ms tick, or its own 140 s check would have ended the
 * session first. The grace leaves room for a woken laptop rejoining its
 * Wi-Fi before the bridge's TCP retransmit lands. A live server answers our
 * first post-wake keepalive (sent on the first tick, then every 3 s) well
 * inside it, which `answered` records.
 */
export const STALE_RECEIVE_GRACE_MS = 10_000;

/**
 * BUG.linkcheck-verdict-after-freeze — the shortest gap between two of the
 * receiving thread's ticks that counts as the thread stopped, not just slow
 * timers (a background worker ticks at 1 Hz at worst; its 3 s keepalive
 * already starves past this). Stops from this up to THREAD_STALL_MIN_MS are
 * summed per silence (ThreadStallClock.frozenSinceReceive): a machine that
 * freezes in pieces, none long enough to be a stop of its own.
 */
export const FROZEN_GAP_MIN_MS = 5_000;

/** The receiving thread's most recent stop: how long ago it ended and how long it lasted. */
export interface ThreadStall {
  agoMs: number;
  lengthMs: number;
  /** The server acknowledged a packet we sent after the stop ended: it was alive once we woke. */
  answered?: boolean;
}

/**
 * A connection's link sample (getLinkStatus): retail LinkStatusHolder's
 * connected + seconds since the last packet, plus the receiving thread's
 * latest stop so the page's 40 s check can tell whose silence it was.
 */
export interface LinkSample {
  connected: boolean;
  secondsSinceLastPacket: number;
  stall?: ThreadStall | null;
  /**
   * BUG.linkcheck-verdict-after-freeze — how much of the current silence the
   * receiving thread spent stopped in stops of FROZEN_GAP_MIN_MS up to
   * THREAD_STALL_MIN_MS (ThreadStallClock.frozenSinceReceive). A thread that
   * is not running hears nothing, so that part of the silence is not the
   * server's. Longer stops are `stall`, not this.
   */
  frozenMs?: number;
}

/** Fed by a connection's own tick loop; remembers its most recent stop longer than THREAD_STALL_MIN_MS. */
export class ThreadStallClock {
  private lastTickAt = 0;
  private stallEndAt = 0;
  private stallMs = 0;
  /** Our last sent sequence when the latest stop ended (null: not tracked by this connection). */
  private sentAtWake: number | null = null;
  private answered = false;
  /** Sum of the shorter stops (FROZEN_GAP_MIN_MS..THREAD_STALL_MIN_MS) since the last receive, and that receive's time. */
  private frozenSinceRx = 0;
  private lastReceiveAt = 0;

  /** A new session: forget past stops; `now` = the loop's start (0 = the first tick starts it). */
  reset(now = 0): void {
    this.lastTickAt = now;
    this.stallEndAt = this.stallMs = 0;
    this.sentAtWake = null;
    this.answered = false;
    this.frozenSinceRx = this.lastReceiveAt = 0;
  }

  /** One tick of the loop; `sentSeq` = the last sequence we have sent so far (for serverAcked). */
  tick(now: number, sentSeq?: number): void {
    const gap = this.lastTickAt ? now - this.lastTickAt : 0;
    this.frozenSinceRx += this.frozenPart(now);
    this.lastTickAt = now;
    if (gap > THREAD_STALL_MIN_MS) {
      this.stallEndAt = now;
      this.stallMs = gap;
      this.sentAtWake = sentSeq ?? null;
      this.answered = false;
    }
  }

  /** A packet from the server was handled now: a new silence starts (BUG.linkcheck-verdict-after-freeze). */
  received(now: number): void {
    this.lastReceiveAt = now;
    this.frozenSinceRx = 0;
  }

  /**
   * BUG.linkcheck-verdict-after-freeze — how long, since the last receive,
   * the thread was stopped in stops of FROZEN_GAP_MIN_MS..THREAD_STALL_MIN_MS
   * (one still in progress counts). 0 before any.
   */
  frozenSinceReceive(now: number): number {
    return this.frozenSinceRx + this.frozenPart(now);
  }

  /**
   * The gap from the last tick to `now` when it is a shorter stop, and none
   * when a receive came inside it: a packet handed over on waking, before the
   * first tick, means the stop ended before that receive, and the silence
   * starts after it.
   */
  private frozenPart(now: number): number {
    const gap = this.lastTickAt ? now - this.lastTickAt : 0;
    if (gap <= FROZEN_GAP_MIN_MS || gap > THREAD_STALL_MIN_MS || this.lastReceiveAt > this.lastTickAt) return 0;
    return gap;
  }

  /** The server acknowledged our packets through `seq` (its AckSequence: the highest it received). */
  serverAcked(seq: number): void {
    if (this.stallMs && this.sentAtWake !== null && seq > this.sentAtWake) this.answered = true;
  }

  /**
   * The most recent stop, counting one still in progress (no tick yet since
   * waking: a sample taken before the loop's first tick after a sleep), or
   * null when there has been none.
   */
  latest(now: number): ThreadStall | null {
    const pending = this.lastTickAt ? now - this.lastTickAt : 0;
    if (pending > THREAD_STALL_MIN_MS) return { agoMs: 0, lengthMs: pending };
    if (this.stallMs === 0) return null;
    return { agoMs: Math.max(0, now - this.stallEndAt), lengthMs: this.stallMs, answered: this.answered };
  }
}

/**
 * A drop after `silenceMs` without data, against a `limitMs` drop limit, is
 * our own stop's doing when the thread stopped longer than the limit and
 * either
 *  - the stop ended inside the silence (after the last receive) and the
 *    quiet since it ended is still within the limit, or
 *  - the last receive came within STALE_RECEIVE_GRACE_MS after the stop
 *    ended (one held through it: NET.stale-receive-after-wake), the quiet
 *    since the stop is within the limit plus that grace, and the server has
 *    acknowledged nothing we sent after waking.
 * Otherwise the server really went quiet. A silence within the limit is no
 * drop and never ours.
 */
export function silenceIsOwnStall(stall: ThreadStall | null | undefined, silenceMs: number, limitMs: number): boolean {
  if (!stall || stall.lengthMs <= limitMs || silenceMs <= limitMs) return false;
  if (stall.agoMs < silenceMs) return stall.agoMs <= limitMs;
  return !stall.answered && stall.agoMs - silenceMs <= STALE_RECEIVE_GRACE_MS && stall.agoMs <= limitMs + STALE_RECEIVE_GRACE_MS;
}
