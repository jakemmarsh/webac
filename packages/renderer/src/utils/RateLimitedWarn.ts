/**
 * A console.warn channel for failures that used to be swallowed by a silent
 * `catch {}` on a hot path (landblock streaming, appearance rebuilds): every
 * failure is COUNTED, but at most one line is printed per `intervalMs`, and
 * the line carries the running count plus the latest failure's detail. Never
 * routes to in-game chat (project rule: no diagnostics in chat).
 */
export class RateLimitedWarn {
  private lastAt = -Infinity;
  private suppressed = 0;
  /** Total failures reported on this channel. */
  count = 0;

  constructor(
    private readonly tag: string,
    private readonly intervalMs = 5000,
    private readonly now: () => number = () => performance.now(),
    private readonly sink: (...args: unknown[]) => void = (...a) => console.warn(...a),
  ) {}

  /** Record one failure; prints if the interval has elapsed since the last printed line. */
  warn(detail: string, err?: unknown): void {
    this.count++;
    const t = this.now();
    if (t - this.lastAt < this.intervalMs) {
      this.suppressed++;
      return;
    }
    this.lastAt = t;
    const more = this.suppressed > 0 ? ` (+${this.suppressed} suppressed)` : '';
    this.suppressed = 0;
    const why = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
    this.sink(`[${this.tag}] ${detail}${why} — ${this.count} total${more}`);
  }
}
