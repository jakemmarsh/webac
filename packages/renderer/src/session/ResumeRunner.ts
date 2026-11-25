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
 * BUG.sleep-darkwake-resume-loop — a resume that began from the machine
 * sleeping (SessionLifecycle.holdWhileHidden) waits, before the network
 * check, while the page is hidden: for the page's 'visibilitychange' to
 * visible, however long, then goes on at once. A sleeping Mac dark-wakes
 * about every 17 min; each wake found the session dead ('client_suspended'),
 * resumed it in the hidden tab, and the re-sleep dropped it again (prod
 * 2026-11-15, FrostfACE: 15 unattended logins in a few hours). The hold is
 * the attempt already granted, so it spends nothing (no attempt, no grace,
 * no page cap); the connecting screen stays up, so the player opening the
 * lid sees it reconnect. Other causes (a socket close, a drain's cut, a
 * silent server) never hold: a background window must come back from a blip.
 *
 * OBS.resume-offline-wait (prod 2026-11-25 21:04Z, trace 532dcc84ba768e0a:
 * an in-world socket_closed drop resumed 35 s later, and the bridge saw no
 * attempt and no connect_failed in between) — the offline wait reported
 * nothing but a console line, so the monitor could not tell a device with no
 * network from a stalled resume. It now reports through the hidden-tab hold's
 * own channel (`onHold` → PreworldReporter 'resume_held'): 'offline' when the
 * wait begins, then 'back_online' (the 'online' event came) or 'offline_grace'
 * (the grace ran out and the attempt went anyway), each with heldMs = how long
 * it waited. A wait dropped by a cancel / newer schedule reports no end; an
 * attempt due while online, or with no grace left, never reports.
 *
 * Part of the named automatic-reconnect browser-UX exception (CLAUDE.md).
 */
import type { SessionLifecycle } from './SessionLifecycle.js';
import { RESUME_ONLINE_SETTLE_MS } from './RetryPolicy.js';

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

/**
 * BUG.resume-hung-socket / BUG.resume-outage-fast-fail — whether a resume
 * attempt's failure means the network (or the bridge) could not be reached,
 * so it is given back while RESUME_UNREACHABLE_GRACE_MS lasts
 * (SessionLifecycle.nextResumeDelay): the browser was offline, or the
 * attempt's socket never opened at all, whether it timed out
 * (`openTimedOut`) or failed on its own (`openFailed`). On a real outage
 * with Wi-Fi still associated, Chrome fails a WebSocket open in well under a
 * second (DNS, ERR_INTERNET_DISCONNECTED, ERR_NETWORK_CHANGED) while
 * navigator.onLine stays true (prod 2026-11-08: a ~65 s outage spent the
 * whole char-select resume in 38 s). A server's answer, a refusal included,
 * comes on a socket that opened, so it is never this.
 */
export function attemptFoundNoNetwork(
  event: { openTimedOut?: boolean; openFailed?: boolean; serverNetError?: unknown },
  offline: boolean,
): boolean {
  if (event.serverNetError) return false;
  return offline || event.openTimedOut === true || event.openFailed === true;
}

/** The page's visibility: document.visibilityState and its 'visibilitychange' event. */
export interface VisibilitySource {
  isHidden(): boolean;
  /** Call `fn` on each change to visible; returns the unsubscribe. */
  onVisible(fn: () => void): () => void;
}

/** The VisibilitySource of a document. */
export function documentVisibilitySource(d: {
  visibilityState?: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}): VisibilitySource {
  return {
    isHidden: () => d.visibilityState === 'hidden',
    onVisible: (fn) => {
      const h = () => { if (d.visibilityState !== 'hidden') fn(); };
      d.addEventListener('visibilitychange', h);
      return () => d.removeEventListener('visibilitychange', h);
    },
  };
}

/** What a held resume attempt reports (PreworldReporter 'resume_held' token). */
export type ResumeHoldPhase = 'held' | 'released' | 'offline' | 'back_online' | 'offline_grace';

export interface ResumeRunnerOptions {
  lifecycle: Pick<SessionLifecycle, 'resumingAfterDrop' | 'unreachableGraceLeftMs' | 'noteNetworkOut'> & { readonly holdWhileHidden?: boolean };
  /** Open the attempt's connection (NetConnection.connect with the session's credentials). */
  connect(): void;
  online: OnlineSource;
  /** BUG.sleep-darkwake-resume-loop — absent: never held. */
  visibility?: VisibilitySource;
  /**
   * A held attempt. The hidden-tab hold: 'held' when the wait begins, 'released' (with how long) when
   * the page shows. OBS.resume-offline-wait, the offline wait: 'offline' when it begins, then
   * 'back_online' or 'offline_grace' (with how long).
   */
  onHold?(phase: ResumeHoldPhase, heldMs: number): void;
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
  private heldSince: number | null = null;

  constructor(private readonly o: ResumeRunnerOptions) {}

  /** The attempt due is waiting for the browser to come back online. */
  get waitingForNetwork(): boolean {
    return this.waiting;
  }

  /** BUG.sleep-darkwake-resume-loop — the attempt due is held until the page is visible. */
  get heldWhileHidden(): boolean {
    return this.heldSince !== null;
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
    this.heldSince = null;
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
    if (this.o.lifecycle.holdWhileHidden === true && this.o.visibility?.isHidden() === true) { this.holdUntilVisible(gen); return; }
    if (!this.o.online.isOffline()) { this.fire(gen); return; }
    this.o.lifecycle.noteNetworkOut(this.now());
    const left = this.o.lifecycle.unreachableGraceLeftMs(this.now());
    if (left <= 0) { this.fire(gen); return; }
    this.o.log?.(`[AC] ACE: the browser is offline — waiting up to ${Math.round(left / 1000)} s for the network before the next resume attempt`);
    this.waiting = true;
    const since = this.now();
    this.o.onHold?.('offline', 0);
    let settled = false;
    const done = (why: 'online' | 'grace') => {
      if (settled || gen !== this.generation) return;
      settled = true;
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.timer !== null) (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
      this.o.onHold?.(why === 'grace' ? 'offline_grace' : 'back_online', Math.max(0, this.now() - since));
      if (why === 'grace') { this.waiting = false; this.fire(gen); return; }
      this.o.log?.('[AC] ACE: back online — resuming');
      this.arm(RESUME_ONLINE_SETTLE_MS, () => { this.waiting = false; this.fire(gen); });
    };
    this.unsubscribe = this.o.online.onOnline(() => done('online'));
    this.arm(left, () => done('grace'));
  }

  private holdUntilVisible(gen: number): void {
    const since = this.now();
    this.heldSince = since;
    this.o.log?.('[AC] ACE: the machine slept and this tab is hidden — the resume waits until the tab is shown');
    this.o.onHold?.('held', 0);
    this.unsubscribe = this.o.visibility!.onVisible(() => {
      if (gen !== this.generation || this.heldSince === null) return;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.heldSince = null;
      if (!this.o.lifecycle.resumingAfterDrop) return; // a logout, a give-up or the launcher ended it meanwhile
      const heldMs = Math.max(0, this.now() - since);
      this.o.log?.(`[AC] ACE: the tab is shown — resuming (held ${Math.round(heldMs / 1000)} s)`);
      this.o.onHold?.('released', heldMs);
      this.due(gen);
    });
  }

  private fire(gen: number): void {
    if (gen !== this.generation || !this.o.lifecycle.resumingAfterDrop) return;
    this.o.connect();
  }
}
