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
  /** Runs `fn` once the current synchronous run of submits is over (default queueMicrotask). */
  afterSync?: (fn: () => void) => void;
}

/**
 * What the pacer held (BUG.pacer-burst-telemetry, 2026-11-16): playwebac.com reported a pacer engagement with
 * txPaced=129 (Seedsow, trace 4b166f6470f68817) whose movement snapshot showed movement was not the burst. These name
 * what was: the held sends' message labels (NetDiagnostics messageLabel: "f7b1:<action>" for a GameAction, else the
 * opcode), the largest synchronous run of submits that had to be held, and the longest time a held queue took to empty.
 */
export interface PacedStats {
  /** The most-held message labels, most first (at most SendPacer.TOP_LABELS). */
  top: Array<{ op: string; n: number }>;
  /** The most submits in one synchronous run that had a send held. */
  burstMax: number;
  /** The longest a held queue took to empty, ms (a queue still emptying counts its time so far). */
  drainMaxMs: number;
  /** Sends waiting now. */
  pending: number;
}

export class SendPacer {
  /**
   * Half the bridge's 200/s and 150 of its 400 burst: the rest stays for ack
   * packets, retransmits and the agent relay's text frames, which the bridge
   * counts in the same bucket.
   */
  static readonly RATE_PER_SEC = 100;
  static readonly BURST = 150;
  /** Held labels reported, and distinct labels counted (later ones count as "other"). */
  static readonly TOP_LABELS = 8;
  static readonly MAX_LABELS = 64;

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
  private readonly afterSync: (fn: () => void) => void;
  private readonly heldLabels = new Map<string, number>();
  private syncRun = 0;
  private burstMax = 0;
  private drainStartedAt: number | null = null;
  private drainMaxMs = 0;

  constructor(opts: SendPacerOptions = {}) {
    this.rate = opts.ratePerSec ?? SendPacer.RATE_PER_SEC;
    this.burst = opts.burst ?? SendPacer.BURST;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.afterSync = opts.afterSync ?? ((fn) => queueMicrotask(fn));
    this.tokens = this.burst;
    this.refilledAt = this.now();
  }

  /** Sends waiting for a token. */
  get pending(): number { return this.queue.length; }

  /**
   * Run `send` now when a token is free and nothing waits ahead of it, else queue it. `label` names the message
   * (messageLabel) for the held-send histogram (pacedStats).
   */
  submit(send: () => void, label = 'unknown'): void {
    if (this.syncRun++ === 0) this.afterSync(() => { this.syncRun = 0; });
    this.refill();
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      send();
      return;
    }
    if (this.queue.length === 0) {
      console.warn(`[AC:NET] Outgoing burst past ${this.burst} messages: pacing sends at ${this.rate}/s`);
      this.drainStartedAt ??= this.now();
    }
    this.queue.push(send);
    this.deferred++;
    this.burstMax = Math.max(this.burstMax, this.syncRun);
    const key = this.heldLabels.has(label) || this.heldLabels.size < SendPacer.MAX_LABELS ? label : 'other';
    this.heldLabels.set(key, (this.heldLabels.get(key) ?? 0) + 1);
    this.schedule();
  }

  /** What the pacer held since the last reset (the session start, or pacedStats(true)). */
  pacedStats(reset = false): PacedStats {
    const ongoing = this.drainStartedAt !== null ? Math.max(0, Math.round(this.now() - this.drainStartedAt)) : 0;
    const out: PacedStats = {
      top: [...this.heldLabels].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, SendPacer.TOP_LABELS).map(([op, n]) => ({ op, n })),
      burstMax: this.burstMax,
      drainMaxMs: Math.max(this.drainMaxMs, ongoing),
      pending: this.queue.length,
    };
    if (reset) this.resetStats();
    return out;
  }

  private resetStats(): void {
    this.heldLabels.clear();
    this.burstMax = 0;
    this.drainMaxMs = 0;
  }

  /** Drop everything waiting (the session ended; its sequencing is reset). */
  clear(): void {
    this.queue.length = 0;
    this.drainStartedAt = null;
    this.resetStats();
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
    if (this.queue.length === 0 && this.drainStartedAt !== null) {
      this.drainMaxMs = Math.max(this.drainMaxMs, Math.round(this.now() - this.drainStartedAt));
      this.drainStartedAt = null;
    }
    this.schedule();
  }
}
