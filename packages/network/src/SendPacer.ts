/**
 * BUG.movetostate-burst-abuse-close (2026-11-10) — the outgoing game-message
 * pacer: a token bucket in front of every sequenced game-message send.
 *
 * The bridge drops a session's WebSocket messages past 200/s (burst 400) and
 * closes the session for abuse after more than 200 drops in 10 s
 * (services/ws-tcp-bridge bridgeUtil.ts msgRatePerSec / msgBurst, AbuseMeter).
 * A client path that sent hundreds of game actions in one synchronous run
 * (playwebac.com 2026-11-10 00:40:33Z: a run of MoveToStates from the agent's
 * stops) got the player's session closed. Retail never sends that fast — its
 * FlowQueue bundles a frame's messages into the few packets it sends a tick —
 * so a normal session never comes near this bucket. A burst past it is held
 * and sent in order as tokens come back, rather than reaching the bridge as
 * a flood it drops (every dropped sequenced packet wedges the session in
 * NAKs anyway) and then closes for.
 *
 * Sends stay strictly in submit order: once anything is queued, every later
 * submit queues behind it. Sequence numbers / ISAAC keys are taken when a
 * send actually runs, so a held send changes nothing on the wire but its time.
 */
export interface SendPacerOptions {
  /** Sends per second the bucket refills at. */
  ratePerSec?: number;
  /** Sends that may go at once from a full bucket. */
  burst?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SendPacer {
  /**
   * Half the bridge's 200/s and 150 of its 400 burst: the rest stays for ack
   * packets, retransmits and the agent relay's text frames, which the bridge
   * counts in the same bucket.
   */
  static readonly RATE_PER_SEC = 100;
  static readonly BURST = 150;

  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private tokens: number;
  private refilledAt: number;
  private readonly queue: Array<() => void> = [];
  private timer: unknown = null;
  /** Sends that had to wait for a token (this session): a burst the pacer held back. */
  deferred = 0;

  constructor(opts: SendPacerOptions = {}) {
    this.rate = opts.ratePerSec ?? SendPacer.RATE_PER_SEC;
    this.burst = opts.burst ?? SendPacer.BURST;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.tokens = this.burst;
    this.refilledAt = this.now();
  }

  /** Sends waiting for a token. */
  get pending(): number { return this.queue.length; }

  /** Run `send` now when a token is free and nothing waits ahead of it, else queue it. */
  submit(send: () => void): void {
    this.refill();
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      send();
      return;
    }
    if (this.queue.length === 0) console.warn(`[AC:NET] Outgoing burst past ${this.burst} messages: pacing sends at ${this.rate}/s`);
    this.queue.push(send);
    this.deferred++;
    this.schedule();
  }

  /** Drop everything waiting (the session ended; its sequencing is reset). */
  clear(): void {
    this.queue.length = 0;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.tokens = this.burst;
    this.refilledAt = this.now();
  }

  private refill(): void {
    const t = this.now();
    const dt = t - this.refilledAt;
    if (dt > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (dt * this.rate) / 1000);
      this.refilledAt = t;
    }
  }

  private schedule(): void {
    if (this.timer !== null || this.queue.length === 0) return;
    const wait = Math.max(1, Math.ceil(((1 - this.tokens) * 1000) / this.rate));
    this.timer = this.setTimer(() => { this.timer = null; this.drain(); }, wait);
  }

  private drain(): void {
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      const send = this.queue.shift()!;
      try { send(); } catch (e) { console.error('[AC:NET] A paced send failed', e); }
    }
    this.schedule();
  }
}
