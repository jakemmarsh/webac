/**
 * BUG.world-list-unreachable — failures that never reach the bridge, reported
 * through the web page's own origin instead.
 *
 * Production, 2026-10-19: a player's launcher read "The world list is
 * unavailable (Failed to fetch)", and two days of the bridge's nginx logs had
 * no failed GET /healthz or /servers from anyone but us: the request never got
 * there (an extension, a VPN, a DNS filter, the network). Every other report
 * (PreworldReporter, ErrorReporter) also goes to the bridge, so this kind of
 * failure was invisible. These reports go to the page's own origin,
 * `POST /__webac/report`, where a small Worker (deploy/web/cloudflare/
 * report-worker.mjs) logs one `web_report` line to Workers Logs with
 * Cloudflare's country / ASN / colo.
 *
 * Privacy: codes, counts, durations, the bridge's host name, the browser's
 * brand list and language only. No account, character, password or address
 * typed by the player (a custom bridge is never reported); Cloudflare sees
 * the client IP itself.
 */
import type { WorldListStep } from '../launcher/worldDirectory.js';

export const WEB_REPORT_PATH = '/__webac/report';

/**
 * The web hosts that serve the report Worker (deploy/web/cloudflare/
 * wrangler.jsonc routes). Anywhere else (localhost, a self-hosted copy) the
 * route does not exist, so nothing is sent.
 */
export const WEB_REPORT_HOSTS: readonly string[] = ['playwebac.com', 'next.playwebac.com'];

export type WebReportKind = 'world_list_failed' | 'launcher_connect_failed';
/** The world-list step, or the game WebSocket that never opened (a launcher login's CantSocket). */
export type WebReportStep = WorldListStep | 'websocket';

export interface WebReport {
  kind: WebReportKind;
  build: string;
  attempts: number;
  elapsedMs: number;
  failedStep: WebReportStep | null;
  errorName: string | null;
  errorMessage: string | null;
  online: boolean | null;
  bridgeHost: string | null;
  ua: string;
  lang: string | null;
}

export interface WebReportInput {
  kind: WebReportKind;
  build: string;
  attempts: number;
  elapsedMs: number;
  failedStep: WebReportStep | null;
  /** The underlying error (WorldDirectoryError.cause for a world-list load). */
  error: unknown;
  /** The bridge URL the request went to (ws:// / wss://); only its host is reported. */
  bridgeUrl: string;
}

type NavLike = {
  onLine?: boolean;
  userAgent?: string;
  language?: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string; version: string }> };
};

const MESSAGE_MAX = 120;
const UA_MAX = 160;

function hostOf(url: string): string | null {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** The browser as a short string: userAgentData's brand list when present, else the userAgent (≤160 chars). */
export function browserBrand(nav: NavLike | null | undefined): string {
  const brands = nav?.userAgentData?.brands;
  const s = Array.isArray(brands) && brands.length
    ? brands.map((b) => `${b.brand}/${b.version}`).join(', ')
    : (nav?.userAgent ?? '');
  return s.slice(0, UA_MAX);
}

/** The report body for `input` (a closed set of fields; strings bounded). */
export function buildWebReport(input: WebReportInput, nav: NavLike | null | undefined): WebReport {
  const err = input.error as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof err?.name === 'string' && err.name ? err.name.slice(0, 40) : null;
  const message = typeof err?.message === 'string' && err.message ? err.message.slice(0, MESSAGE_MAX) : null;
  return {
    kind: input.kind,
    build: input.build.slice(0, 40),
    attempts: Math.max(0, Math.round(input.attempts)),
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    failedStep: input.failedStep,
    errorName: name,
    errorMessage: message,
    online: typeof nav?.onLine === 'boolean' ? nav.onLine : null,
    bridgeHost: hostOf(input.bridgeUrl),
    ua: browserBrand(nav),
    lang: typeof nav?.language === 'string' ? nav.language.slice(0, 35) : null,
  };
}

/** The report URL for a page at `pageUrl`, or null where no report Worker serves it. */
export function webReportUrl(pageUrl: string, hosts: readonly string[] = WEB_REPORT_HOSTS): string | null {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) return null;
    return `${u.origin}${WEB_REPORT_PATH}`;
  } catch {
    return null;
  }
}

export interface WebReportTransport {
  sendBeacon?: (url: string, data: Blob) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

/**
 * Send `report` to the page's own origin: sendBeacon, else fetch keepalive.
 * Returns false when nothing was sent (not a reporting host, or no transport).
 * Never throws.
 */
export function sendWebReport(report: WebReport, pageUrl: string, t: WebReportTransport, hosts?: readonly string[]): boolean {
  const url = webReportUrl(pageUrl, hosts);
  if (!url) return false;
  const body = JSON.stringify(report);
  try {
    if (t.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return true;
  } catch { /* fall through to fetch */ }
  if (!t.fetch) return false;
  try {
    void t.fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The browser's transport (sendBeacon bound to navigator, global fetch). */
export function browserWebReportTransport(): WebReportTransport {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  return {
    sendBeacon: nav && typeof nav.sendBeacon === 'function' ? (u, d) => nav.sendBeacon(u, d) : undefined,
    fetch: typeof fetch === 'function' ? (u, i) => fetch(u, i) : undefined,
  };
}

/**
 * The launcher's world-list failure (LauncherScreen.onWorldListFailed): the
 * step and cause from loadWorldDirectory's WorldDirectoryError.
 */
export function worldListFailedReport(
  f: { attempts: number; elapsedMs: number; error: unknown }, bridgeUrl: string, build: string,
): WebReportInput {
  const e = f.error as { step?: unknown; cause?: unknown } | null | undefined;
  const step = e?.step === 'healthz' || e?.step === 'servers' || e?.step === 'json' ? e.step : null;
  return {
    kind: 'world_list_failed', build, attempts: f.attempts, elapsedMs: f.elapsedMs,
    failedStep: step, error: step && e?.cause !== undefined ? e.cause : f.error, bridgeUrl,
  };
}

/**
 * A launcher login whose game socket never opened (ID_NetError_CantSocket),
 * to the page's own bridge. Null for any other failure (the bridge saw those
 * and logs them) and for a custom bridge (an address the player typed).
 */
export function launcherConnectFailedReport(f: {
  netErrorId: string | null; connectUrl: string; bridgeUrl: string; sinceLoginMs: number; build: string;
}): WebReportInput | null {
  if (f.netErrorId !== 'ID_NetError_CantSocket') return null;
  const host = hostOf(f.connectUrl);
  if (!host || host !== hostOf(f.bridgeUrl)) return null;
  return {
    kind: 'launcher_connect_failed', build: f.build, attempts: 1, elapsedMs: f.sinceLoginMs,
    failedStep: 'websocket', error: { name: 'NetError', message: f.netErrorId }, bridgeUrl: f.bridgeUrl,
  };
}

/** Build and send one report from the running page (main.ts). */
export function reportFromPage(input: WebReportInput): boolean {
  if (typeof window === 'undefined') return false;
  return sendWebReport(buildWebReport(input, navigator as NavLike), window.location.href, browserWebReportTransport());
}
