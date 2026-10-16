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
 */

/** The shortest stop worth remembering: the page's 40 s DISCONNECT_TIME, the shortest drop limit of any check. */
export const THREAD_STALL_MIN_MS = 40_000;

/** The receiving thread's most recent stop: how long ago it ended and how long it lasted. */
export interface ThreadStall {
  agoMs: number;
  lengthMs: number;
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
}

/** Fed by a connection's own tick loop; remembers its most recent stop longer than THREAD_STALL_MIN_MS. */
export class ThreadStallClock {
  private lastTickAt = 0;
  private stallEndAt = 0;
  private stallMs = 0;

  /** A new session: forget past stops; `now` = the loop's start (0 = the first tick starts it). */
  reset(now = 0): void {
    this.lastTickAt = now;
    this.stallEndAt = this.stallMs = 0;
  }

  /** One tick of the loop. */
  tick(now: number): void {
    const gap = this.lastTickAt ? now - this.lastTickAt : 0;
    this.lastTickAt = now;
    if (gap > THREAD_STALL_MIN_MS) {
      this.stallEndAt = now;
      this.stallMs = gap;
    }
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
    return { agoMs: Math.max(0, now - this.stallEndAt), lengthMs: this.stallMs };
  }
}

/**
 * A drop after `silenceMs` without data, against a `limitMs` drop limit, is
 * our own stop's doing when the thread stopped longer than the limit inside
 * the silence (the stop ended after the last receive) and the quiet since it
 * ended is still within the limit. Otherwise the server really went quiet.
 */
export function silenceIsOwnStall(stall: ThreadStall | null | undefined, silenceMs: number, limitMs: number): boolean {
  return !!stall && stall.lengthMs > limitMs && stall.agoMs < silenceMs && stall.agoMs <= limitMs;
}
