/**
 * FAITHFUL.272 — pure ping round-trip latency tracking for the 'server-load'
 * HUD indicator (LayoutDesc icon active=0x06001360, inactive=0x06001362).
 * Extracted from main.ts closure state so the latency math, the 250ms
 * "laggy" threshold decision, and the 3s in-flight-hang fallback can be
 * driven directly with injected timestamps instead of only being reachable
 * through the live 15s ping heartbeat.
 */

// 250ms is the latency cap above which AC retail noticeably lagged
// (rubber-banding, delayed casts). Below that the connection feels fine.
export const SERVER_LOAD_LATENCY_MS = 250;

// If a ping is still in flight this long, treat the server as overloaded
// without waiting for the matching response.
export const PING_HANG_FALLBACK_MS = 3000;

export interface PingResponseResult {
  latencyMs: number;
  indicatorActive: boolean;
}

export class PingLatencyTracker {
  private sentAtMs: number | null = null;
  private lastLatencyMs: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Call when a ping request is shipped. */
  requestSent(): void {
    this.sentAtMs = this.now();
  }

  /**
   * Call when the matching PingResponse arrives. Returns null if there was
   * no in-flight request (e.g. a stray/duplicate response).
   */
  responseReceived(): PingResponseResult | null {
    if (this.sentAtMs === null) return null;
    const latencyMs = this.now() - this.sentAtMs;
    this.lastLatencyMs = latencyMs;
    this.sentAtMs = null;
    return { latencyMs, indicatorActive: latencyMs > SERVER_LOAD_LATENCY_MS };
  }

  /** True if a request has been in flight for longer than the hang fallback. */
  isHung(): boolean {
    return this.sentAtMs !== null && this.now() - this.sentAtMs > PING_HANG_FALLBACK_MS;
  }

  /** Clear in-flight state (e.g. on disconnect/world teardown). */
  reset(): void {
    this.sentAtMs = null;
  }

  get lastLatency(): number | null {
    return this.lastLatencyMs;
  }
}
