/**
 * BUG.movetostate-burst-abuse-close — one `move_limiter` client_world event the first time in a world session that an
 * outgoing limiter engages: MovementSync's MoveToState budget or identical-repeat cap, or the connection's SendPacer.
 * Normal play never engages any of them; the 2026-11-10 flood (about one MoveToState per frame for ~1.9 s, an agent's
 * macro running) did, and its source was not found from the code. The event carries what was sending: the MoveToStates
 * in the last 500 ms, the movement-state fields that kept changing between consecutive sends, the MovementSync paths
 * that sent them, the inputs the recent movement events came from, the frame rate, and whether a routine ran.
 * Closed vocabularies and counts only: no text, no names (the bridge checks each field: clientWorld.ts
 * sanitizeClientMoveLimiter).
 */
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';
import type { MoveLimiterSnapshot } from '../network/MovementSync.js';
import type { MovementEventSource } from '../scene/CameraController.js';
import type { RoutineDriver, RoutineKind } from './AutomationReporter.js';

export const MOVE_LIMITERS = ['budget', 'repeat', 'pacer'] as const;
export type MoveLimiter = typeof MOVE_LIMITERS[number];

interface Ids { era: string; server: string | null; trace: string; build: string }

export interface MoveLimiterEvent extends Ids {
  outcome: 'move_limiter';
  limiter: MoveLimiter;
  /** MoveToStates sent in the last 500 ms. */
  recent: number;
  /** MovementState fields that differed between consecutive recent MoveToStates. */
  fields: string[];
  /** The MovementSync paths that sent the recent MoveToStates, oldest first. */
  origins: string[];
  /** The inputs the recent movement events came from, oldest first. */
  sources: string[];
  fps: number;
  /** The routine running, if any. */
  driver: RoutineDriver | null;
  kind: RoutineKind | null;
  /** Game-message sends the connection's pacer held back so far. */
  txPaced: number | null;
}

export interface MoveLimiterReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  /** What else the event says, read when it fires. */
  context: () => { sources: readonly MovementEventSource[]; fps: number; routine: { driver: RoutineDriver; kind: RoutineKind } | null; txPaced: number | null };
  now?: () => number;
  send?: TelemetrySend;
}

function safe<T>(f: () => T, fallback: T): T {
  try { return f(); } catch { return fallback; }
}

export class MoveLimiterReporter {
  private readonly outbox: TelemetryOutbox;
  private said = false;
  /** Limiter engagements this world session (the first is reported). */
  engaged = 0;

  constructor(private readonly opts: MoveLimiterReporterOptions) {
    const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, now, true);
  }

  /** A world session began: the next engagement is reported again. */
  sessionStarted(): void {
    this.said = false;
    this.engaged = 0;
  }

  /** A limiter engaged; the session's first is posted. Returns whether it posted. */
  engage(limiter: MoveLimiter, snap: MoveLimiterSnapshot): boolean {
    this.engaged++;
    if (this.said) return false;
    this.said = true;
    const c = safe(this.opts.context, { sources: [], fps: 0, routine: null, txPaced: null });
    const ev: MoveLimiterEvent = {
      outcome: 'move_limiter',
      era: safe(this.opts.era, 'unknown'), server: safe(this.opts.server, null), trace: this.opts.trace, build: this.opts.build,
      limiter,
      recent: snap.recent,
      fields: [...snap.fields],
      origins: [...snap.origins],
      sources: [...c.sources],
      fps: Math.max(0, Math.round(c.fps)),
      driver: c.routine?.driver ?? null,
      kind: c.routine?.kind ?? null,
      txPaced: c.txPaced,
    };
    if (!this.opts.endpoint) return true;
    this.outbox.retry();
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
    return true;
  }

  /** online → retry; a hidden or leaving page sends what waits by beacon. */
  install(win: Pick<Window, 'addEventListener'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    this.outbox.install(win);
    win.addEventListener('pagehide', () => this.outbox.retry(true));
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.outbox.retry(true); });
  }
}
