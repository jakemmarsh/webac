/**
 * RELEASE.error-reporting — crash reports to the bridge (`POST /client-errors`,
 * services/ws-tcp-bridge/src/clientErrors.ts), so failures on players'
 * machines are visible in the bridge logs.
 *
 * Reported: uncaught errors, unhandled promise rejections, WebGL context
 * loss, and boot failures the page reports itself. Never reported: account
 * names, passwords, chat, or anything from the URL's query string (stripped
 * here and again on the bridge). One report per distinct error; repeats only
 * bump a count sent with the next distinct report, and a page sends at most
 * MAX_REPORTS.
 */
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';

export type ErrorKind = 'error' | 'unhandledrejection' | 'webglcontextlost' | 'boot';

export interface ErrorReport {
  kind: ErrorKind;
  message: string;
  stack: string | null;
  source: string | null;
  line: number | null;
  column: number | null;
  build: string;
  screen: string;
  userAgent: string;
  count: number;
  /** BOOT.webgl2-diagnosis — on the boot report of a browser without WebGL 2: why (WebGlDiagnosis.ts). */
  webglCause?: string;
  /** The browser's creation-error statusMessage, clipped to plain characters. */
  webglStatus?: string;
}

export interface ErrorReporterOptions {
  /** Full POST URL, or null to report nothing (no bridge configured). */
  endpoint: string | null;
  build: string;
  /** The current screen name (launcher / char-select / world / …). */
  screen: () => string;
  userAgent?: string;
  /** As PreworldReporterOptions.send (TelemetryOutbox): a rejected promise keeps the report to go again. */
  send?: TelemetrySend;
}

export const MAX_REPORTS = 20;

/** Browser warnings delivered as window errors that are not failures (see install()). */
export const BENIGN_ERROR = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;

/** Drop query strings and fragments from URLs (they carried ?account=&password= in dev links). */
export function stripUrlQueries(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"`)]*)[?#][^\s'"`)]*?(?=(?::\d+){1,2}(?=[\s)'"`]|$)|[\s'"`)]|$)/gi, '$1');
}

export class ErrorReporter {
  private readonly seen = new Map<string, number>();
  private sent = 0;
  private reports = 0;
  private readonly outbox: TelemetryOutbox;

  constructor(private readonly opts: ErrorReporterOptions) {
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, () => Date.now());
  }

  /** The bridge's report URL for a ws(s):// bridge URL (null when it isn't one). */
  static endpointFor(bridgeUrl: string): string | null {
    try {
      const u = new URL(bridgeUrl);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
      return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/client-errors`;
    } catch { return null; }
  }

  /**
   * Every error the page reported (repeats and ones past MAX_REPORTS
   * included), sent or not: RELEASE.first-minute counts the errors in a
   * player's first minute in the world from it (WorldReporter).
   */
  get reportCount(): number { return this.reports; }

  report(kind: ErrorKind, message: string, detail: {
    stack?: string | null; source?: string | null; line?: number | null; column?: number | null;
    webglCause?: string | null; webglStatus?: string | null;
  } = {}): void {
    this.reports++;
    if (!this.opts.endpoint) return;
    const msg = stripUrlQueries(String(message || 'Unknown error')).slice(0, 500);
    const source = detail.source ? stripUrlQueries(detail.source) : null;
    const key = `${kind}|${msg}|${source ?? ''}:${detail.line ?? ''}`;
    const prior = this.seen.get(key);
    if (prior !== undefined) { this.seen.set(key, prior + 1); return; }
    if (this.sent >= MAX_REPORTS) return;
    this.seen.set(key, 1);
    this.sent++;
    const body: ErrorReport = {
      kind,
      message: msg,
      stack: detail.stack ? stripUrlQueries(detail.stack).slice(0, 4000) : null,
      source,
      line: detail.line ?? null,
      column: detail.column ?? null,
      build: this.opts.build,
      screen: this.safeScreen(),
      userAgent: (this.opts.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')).slice(0, 300),
      count: 1,
      ...(detail.webglCause ? { webglCause: detail.webglCause.slice(0, 32) } : {}),
      ...(detail.webglStatus ? { webglStatus: stripUrlQueries(detail.webglStatus).slice(0, 120) } : {}),
    };
    this.outbox.retry();
    this.outbox.post(this.opts.endpoint, JSON.stringify(body));
  }

  private safeScreen(): string {
    try { return this.opts.screen(); } catch { return 'unknown'; }
  }

  /** Listen for uncaught errors and unhandled rejections on `win`. */
  install(win: Pick<Window, 'addEventListener'>): void {
    // Reports the network refused go again when it is back, as the page leaves, and before the next report.
    this.outbox.install(win);
    win.addEventListener('pagehide', () => this.outbox.retry(true));
    win.addEventListener('error', (ev: Event) => {
      const e = ev as ErrorEvent;
      if (!e.message && !e.error) return; // a resource load error (img/script 404), not a script error
      // Chrome raises a benign window error when ResizeObserver callbacks change
      // layout within one frame; nothing failed (the first report from a real
      // player, 2026-10-12, was this). Not a crash: don't report it.
      if (BENIGN_ERROR.test(e.message ?? '')) return;
      this.report('error', e.message || String(e.error), {
        stack: e.error instanceof Error ? e.error.stack ?? null : null,
        source: e.filename || null, line: e.lineno || null, column: e.colno || null,
      });
    });
    win.addEventListener('unhandledrejection', (ev: Event) => {
      const reason = (ev as PromiseRejectionEvent).reason;
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      this.report('unhandledrejection', message, { stack: reason instanceof Error ? reason.stack ?? null : null });
    });
  }

  /** Report a lost WebGL context on `canvas` (GPU reset, driver crash, out of memory). */
  watchCanvas(canvas: Pick<HTMLCanvasElement, 'addEventListener'>): void {
    canvas.addEventListener('webglcontextlost', () => this.report('webglcontextlost', 'WebGL context lost'));
  }
}
