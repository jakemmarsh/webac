/**
 * BUG.resume-hung-socket — runs an automatic resume's next attempt (the
 * in-world resume and the chargen resume share it: main.ts scheduleResume).
 *
 * After the attempt's delay (SessionLifecycle.nextResumeDelay) the attempt
 * connects, unless the browser says it is offline (navigator.onLine false):
 * then it waits for the window's 'online' event (plus a short settle, so DNS
 * and routes come up behind the interface) before connecting, so the attempt
 * isn't spent on a network that isn't there. The wait is bounded by what is
 * left of RESUME_UNREACHABLE_GRACE_MS; when that runs out the attempt goes
 * anyway (it fails as before and counts). The connecting screen stays up the
 * whole time. Nothing connects once the resume is over (a deliberate logout,
 * back in the world, given up) or after a newer schedule / cancel.
 *
 * Part of the named automatic-reconnect browser-UX exception (CLAUDE.md).
 */
import type { SessionLifecycle } from './SessionLifecycle.js';

/** The page's view of the network: navigator.onLine and the window's 'online' event. */
export interface OnlineSource {
  /** True only when the browser says it has no network (navigator.onLine === false). */
  isOffline(): boolean;
  /** Call `fn` on the next 'online' event; returns the unsubscribe. */
  onOnline(fn: () => void): () => void;
}

/** The OnlineSource of a window (or a worker scope): navigator.onLine + 'online'. */
export function windowOnlineSource(w: {
  navigator?: { onLine?: boolean };
  addEventListener(type: 'online', fn: () => void): void;
  removeEventListener(type: 'online', fn: () => void): void;
}): OnlineSource {
  return {
    isOffline: () => w.navigator?.onLine === false,
    onOnline: (fn) => {
      const h = () => fn();
      w.addEventListener('online', h);
      return () => w.removeEventListener('online', h);
    },
  };
}

/** After 'online', the wait before connecting: the interface is up, its DNS and routes a moment later. */
export const RESUME_ONLINE_SETTLE_MS = 1000;

export interface ResumeRunnerOptions {
  lifecycle: Pick<SessionLifecycle, 'resumingAfterDrop' | 'unreachableGraceLeftMs' | 'noteNetworkOut'>;
  /** Open the attempt's connection (NetConnection.connect with the session's credentials). */
  connect(): void;
  online: OnlineSource;
  log?(text: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export class ResumeRunner {
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private waiting = false;

  constructor(private readonly o: ResumeRunnerOptions) {}

  /** The attempt due is waiting for the browser to come back online. */
  get waitingForNetwork(): boolean {
    return this.waiting;
  }

  /** Run the next attempt after `delayMs` (replacing any attempt still pending). */
  schedule(delayMs: number): void {
    this.cancel();
    const gen = this.generation;
    this.arm(delayMs, () => this.due(gen));
  }

  /** Drop the pending attempt (and any wait for the network). */
  cancel(): void {
    this.generation++;
    this.waiting = false;
    if (this.timer !== null) (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private arm(ms: number, fn: () => void): void {
    this.timer = (this.o.setTimer ?? ((f, t) => setTimeout(f, t)))(() => { this.timer = null; fn(); }, ms);
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private due(gen: number): void {
    if (gen !== this.generation || !this.o.lifecycle.resumingAfterDrop) return; // gave up or logged out meanwhile
    if (!this.o.online.isOffline()) { this.fire(gen); return; }
    this.o.lifecycle.noteNetworkOut(this.now());
    const left = this.o.lifecycle.unreachableGraceLeftMs(this.now());
    if (left <= 0) { this.fire(gen); return; }
    this.o.log?.(`[AC] ACE: the browser is offline — waiting up to ${Math.round(left / 1000)} s for the network before the next resume attempt`);
    this.waiting = true;
    let settled = false;
    const done = (why: 'online' | 'grace') => {
      if (settled || gen !== this.generation) return;
      settled = true;
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer !== null) (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
      if (why === 'grace') { this.waiting = false; this.fire(gen); return; }
      this.o.log?.('[AC] ACE: back online — resuming');
      this.arm(RESUME_ONLINE_SETTLE_MS, () => { this.waiting = false; this.fire(gen); });
    };
    this.unsubscribe = this.o.online.onOnline(() => done('online'));
    this.arm(left, () => done('grace'));
  }

  private fire(gen: number): void {
    if (gen !== this.generation || !this.o.lifecycle.resumingAfterDrop) return;
    this.o.connect();
  }
}
