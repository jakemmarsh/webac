/**
 * The telemetry transport (PreworldReporter, WorldReporter, ErrorReporter)
 * and the outbox that keeps an event the network refused.
 *
 * Production, build 633db4ab (AC1999, 2026-10-14): a page left the world
 * and sat on the connecting screen for 8 s before the player reloaded, and
 * no world_left ever reached the bridge. Every way out of the world reports
 * world_left, but a drop is exactly when the network is gone: the old
 * transport used navigator.sendBeacon first, which only says the request
 * was queued, and nothing retried a beacon the browser could not deliver.
 *
 * Now, while the page is visible, events go by fetch (keepalive, no-cors:
 * an opaque answer resolves, a network failure rejects), and a rejected
 * event waits here and goes again: on the reporters' tick (at most every
 * RETRY_MS), when the browser says it is back online, and when the page is
 * hidden or leaving. A hidden or unloading page uses sendBeacon (the most
 * reliable send at unload; its fate is unknown, so it is never retried).
 * An event that went late carries `lateMs` (time since its first failed
 * send) when the outbox is told to stamp it, so the bridge's log time is not
 * mistaken for when it happened.
 *
 * BUG.telemetry-duplicate-resend (production, build 327ed434, AC1999,
 * 2026-10-15): one logout logged world_left twice, 1 ms apart, the second
 * with lateMs=0. The logout's keepalive fetch was delivered, then its promise
 * rejected as the epilogue's relaunch reloaded the page, and the pagehide
 * resent it. A rejected promise does not mean the bridge never got the
 * event (a keepalive request outlives its page; a slow delivered request can
 * still fail), so every JSON event gets an id (`eid`) when it is first
 * posted, kept unchanged on every resend, and the bridge logs each id once
 * (services/ws-tcp-bridge/src/eventIds.ts). The outbox still resends what
 * was refused: a lost world_left costs more than a duplicate the bridge drops.
 */

/** A transport: returns a promise when it can tell a failed send (rejects then); anything else is ignored. */
export type TelemetrySend = (url: string, body: string) => unknown;

/** At most this many refused events wait (the oldest goes first when full). */
export const OUTBOX_MAX = 10;
/** A tick retries the waiting events at most this often. */
export const RETRY_MS = 5_000;

function pageHidden(): boolean {
  try { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch { return false; }
}

function beacon(url: string, body: string): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }));
  } catch { return false; }
}

/**
 * The browser transport. Visible page: fetch keepalive (a failure rejects,
 * so the outbox can keep the event). Hidden or unloading page: sendBeacon,
 * falling back to fetch when the browser refuses the beacon.
 */
export function defaultTelemetrySend(url: string, body: string): void | Promise<unknown> {
  const hasFetch = typeof fetch === 'function';
  if ((pageHidden() || !hasFetch) && beacon(url, body)) return;
  if (!hasFetch) return Promise.reject(new Error('no transport'));
  return fetch(url, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, keepalive: true, mode: 'no-cors' });
}

interface Held { url: string; body: string; firstFailedAt: number }

let idCounter = 0;

/**
 * A new event id: 12 lowercase hex digits (48 random bits from Web Crypto,
 * which every browser that runs the client has). Without it, the clock and a
 * per-page counter in base 36 (no pseudo-random source), which still tells this
 * page's events apart.
 */
export function newEventId(): string {
  const bytes = new Uint8Array(6);
  try {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    idCounter = (idCounter + 1) % 1_679_616; // 36^4
    const clock = Math.floor(Date.now() * 1000 + (typeof performance !== 'undefined' ? performance.now() * 1000 : 0) % 1000);
    return `${clock.toString(36)}${idCounter.toString(36).padStart(4, '0')}`.slice(-24);
  }
}

export class TelemetryOutbox {
  private queue: Held[] = [];
  private lastRetryAt = -Infinity;

  constructor(
    private readonly send: TelemetrySend,
    private readonly now: () => number,
    /** Add `lateMs` to a JSON object body when it goes again (the bridge's sanitizer must know the field). */
    private readonly stampLate = false,
  ) {}

  /** Events waiting for the network. */
  get pending(): number { return this.queue.length; }

  /**
   * Send now; keep it if the transport says the send failed. Never throws. A
   * JSON object body gets its event id (`eid`) here, once: every resend
   * carries the same one, so the bridge can drop a repeat.
   */
  post(url: string, body: string): void {
    this.attempt({ url, body: withEventId(body), firstFailedAt: Number.NaN });
  }

  /**
   * Send the waiting events again. `force` skips the RETRY_MS spacing (the
   * browser came back online, the page is being hidden or leaving).
   */
  retry(force = false): void {
    if (!this.queue.length) return;
    const at = this.now();
    if (!force && at - this.lastRetryAt < RETRY_MS) return;
    this.lastRetryAt = at;
    const held = this.queue;
    this.queue = [];
    for (const h of held) this.attempt(h);
  }

  /**
   * online → retry. The owner calls retry(true) from its own pagehide and
   * visibilitychange (hidden) handlers, so a waiting event goes by beacon
   * before the page can go.
   */
  install(win: Pick<Window, 'addEventListener'>): void {
    win.addEventListener('online', () => this.retry(true));
  }

  private attempt(h: Held): void {
    const retried = !Number.isNaN(h.firstFailedAt);
    const body = retried && this.stampLate ? withLate(h.body, Math.max(0, Math.round(this.now() - h.firstFailedAt))) : h.body;
    let r: unknown;
    try { r = this.send(h.url, body); } catch { return; /* a transport that throws is broken, not offline */ }
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      (r as Promise<unknown>).then(undefined, () => this.hold(retried ? h : { ...h, firstFailedAt: this.now() }));
    }
  }

  private hold(h: Held): void {
    this.queue.push(h);
    if (this.queue.length > OUTBOX_MAX) this.queue.shift();
  }
}

function withEventId(body: string): string {
  try {
    const o = JSON.parse(body) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o) || 'eid' in o) return body;
    return JSON.stringify({ ...(o as Record<string, unknown>), eid: newEventId() });
  } catch { return body; }
}

function withLate(body: string, lateMs: number): string {
  try {
    const o = JSON.parse(body) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return body;
    return JSON.stringify({ ...(o as Record<string, unknown>), lateMs });
  } catch { return body; }
}
