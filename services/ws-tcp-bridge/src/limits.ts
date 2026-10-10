/**
 * Abuse limits for the public bridge (RELEASE Phase 2): token buckets for
 * per-session message/byte rates, a sliding-window counter for per-IP new
 * connections, keyed concurrency counters (per IP, per target server), and
 * the client-IP resolution that honours X-Forwarded-For only behind a
 * trusted proxy.
 */
import { normalizeAddress } from './bridgeUtil.js';

/** Classic token bucket: `ratePerSec` tokens refill continuously up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  /** Take `cost` tokens if available. Returns false (and takes nothing) otherwise. */
  tryTake(cost = 1): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Per-key "at most `limit` hits per `windowMs`" (exact sliding window). */
export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  /** Record a hit for `key`; true if it is within the limit. Rejected hits are
   *  not recorded, so a client hammering a closed door does not extend its ban. */
  hit(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter(x => x > cutoff);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
  /** Drop keys with no hits inside the window (call periodically). */
  sweep(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [k, list] of this.hits) {
      if (list.every(x => x <= cutoff)) this.hits.delete(k);
    }
  }
  get size(): number { return this.hits.size; }
}

/** Concurrency counter per key (sessions per IP, sessions per server). */
export class KeyedCounter {
  private readonly counts = new Map<string, number>();
  get(key: string): number { return this.counts.get(key) ?? 0; }
  inc(key: string): number { const n = this.get(key) + 1; this.counts.set(key, n); return n; }
  dec(key: string): number {
    const n = Math.max(0, this.get(key) - 1);
    if (n === 0) this.counts.delete(key); else this.counts.set(key, n);
    return n;
  }
  entries(): [string, number][] { return [...this.counts.entries()]; }
}

/**
 * Closes a session only on SUSTAINED abuse: a few dropped messages (a burst
 * over the token bucket) are tolerated; more than `maxDrops` drops inside
 * `windowMs` means the peer is flooding and should be cut off.
 */
export class AbuseMeter {
  private drops: number[] = [];
  constructor(
    private readonly maxDrops: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  /** Record one dropped message; true when the session should be closed. */
  recordDrop(): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    this.drops = this.drops.filter(x => x > cutoff);
    this.drops.push(t);
    return this.drops.length > this.maxDrops;
  }
}

/**
 * The client's IP. Without a trusted proxy this is the socket peer address —
 * X-Forwarded-For is ignored, since any client can send it. With
 * `trustProxyHops` = N (BRIDGE_TRUST_PROXY), the Nth entry from the RIGHT of
 * X-Forwarded-For is used: each trusted proxy appends the address it saw, so
 * the rightmost N entries are written by our own proxies and anything to
 * their left is client-controlled. Falls back to the peer address when the
 * header is missing or shorter than N.
 */
export function clientIp(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  trustProxyHops: number,
  /** BRIDGE_CLIENT_IP_HEADER: a single-value header the edge proxy overwrites
   *  with the connecting client (Railway: x-real-ip). Wins when present. */
  clientIpHeader?: string,
): string {
  const peer = normalizeAddress(remoteAddress ?? 'unknown');
  if (trustProxyHops <= 0) return peer;
  if (clientIpHeader) {
    const h = headers[clientIpHeader.toLowerCase()];
    const v = (Array.isArray(h) ? h[0] : h)?.trim();
    if (v && /^[0-9a-fA-F:.]+$/.test(v)) return normalizeAddress(v);
  }
  const raw = headers['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (!value) return peer;
  const parts = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length < trustProxyHops) return peer;
  return normalizeAddress(parts[parts.length - trustProxyHops]);
}

/** Loopback peers (local dev tools, the dev client) skip per-IP limits. */
export function isLoopbackAddress(ip: string): boolean {
  const a = normalizeAddress(ip);
  return a === '::1' || a.startsWith('127.');
}
