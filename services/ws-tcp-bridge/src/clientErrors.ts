/**
 * RELEASE.error-reporting — crash reports from the web client.
 *
 * The client POSTs uncaught errors, unhandled promise rejections and WebGL
 * context losses to `POST /client-errors` on the bridge it already talks to
 * (renderer ErrorReporter.ts). The bridge keeps nothing: each accepted report
 * becomes one JSON log line (`client_error`) next to the session logs, and a
 * counter in /metrics. No third-party service, no account data: the client
 * never sends credentials, and this module scrubs query strings and anything
 * shaped like `password=` / `account=` again in case a message carried one.
 * The page's `trace` and the browser's random `bid` ride along (each only
 * when well formed), so a report joins that page's other lines.
 */

import { eidField } from './eventIds.js';
import { TRACE_PATTERN } from './clientPreworld.js';

/** A browser profile's random id (renderer LoginTags.browserId; clientPreworld identityFields). */
const BID_PATTERN = /^[0-9a-f]{8}$/;

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'webglcontextlost' | 'boot' | 'extension_error';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  /** OBS.client-error-identity — the page's trace id, as on its client_preworld / client_world / session lines. */
  trace?: string;
  /** This browser profile's random id, as on client_preworld login_refused / char_list lines. */
  bid?: string;
  message: string;
  stack: string | null;
  /** Source file of the error (path only). */
  source: string | null;
  line: number | null;
  column: number | null;
  /** The client build id (version.json), or 'dev'. */
  build: string | null;
  /** Coarse screen: launcher / char-select / world / … */
  screen: string | null;
  userAgent: string | null;
  /** Times this error repeated on the page before this report (client-side dedupe). */
  count: number;
  /** BOOT.webgl2-diagnosis — why WebGL 2 failed (a known cause; anything else is dropped). */
  webglCause?: WebGlFailureCause;
  /** The browser's creation-error statusMessage: plain characters only, at most WEBGL_STATUS_MAX. */
  webglStatus?: string;
  /**
   * TELEMETRY.extension-errors — on an extension_error (an uncaught error from a browser extension's own
   * script, at most one per page, not counted in the page's error count): the extension's id. Anything
   * not id-shaped is dropped.
   */
  extensionId?: string;
  /** The page's id for this report, the same on every resend (eventIds.ts): the bridge logs each once. */
  eid?: string;
}

/** The renderer's WEBGL_FAILURE_CAUSES (boot/WebGlDiagnosis.ts); the bridge doesn't import page code. */
export const WEBGL_FAILURE_CAUSES = [
  'blocklisted', 'acceleration_disabled', 'gpu_process_unavailable', 'context_lost_after_crash',
  'webgl1_only', 'no_webgl', 'unknown', 'disabled_by_policy', 'webgl2_blocked', 'webgl_turned_off',
  'blocked_in_page',
] as const;
export type WebGlFailureCause = typeof WEBGL_FAILURE_CAUSES[number];
export const WEBGL_STATUS_MAX = 120;

/** Re-validate the page's statusMessage: the same character set and length the page keeps, else dropped. */
function webglStatus(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^A-Za-z0-9\s.,:;()/_-]/g, '').replace(/\s+/g, ' ').trim().slice(0, WEBGL_STATUS_MAX).trim();
  return s.length > 0 ? scrubText(s) : null;
}

/** An extension id: Chrome's 32 a-p letters, Firefox's UUID / {UUID} / name@host, Safari's bundle-style ids. */
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9@._{}-]{1,80}$/;

export const CLIENT_ERROR_MAX_BODY = 16 * 1024;
const KINDS: readonly ClientErrorKind[] = ['error', 'unhandledrejection', 'webglcontextlost', 'boot', 'extension_error'];

/** Remove query strings / fragments from URLs and redact credential-shaped pairs. */
export function scrubText(text: string): string {
  return text
    // Drop ?query / #fragment, keeping a stack frame's :line:col after it.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"`)]*)[?#][^\s'"`)]*?(?=(?::\d+){1,2}(?=[\s)'"`]|$)|[\s'"`)]|$)/gi, '$1')
    .replace(/\b(password|passwd|pwd|account|acct|token|secret|ticket)(["']?\s*[:=]\s*["']?)[^\s&"',;)]+/gi, '$1$2[redacted]');
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const s = scrubText(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e7 ? v : null;
}

/** Validate and scrub a posted body; null when it is not a report. */
export function sanitizeClientError(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const kind = KINDS.find(k => k === b.kind);
  const message = text(b.message, 500);
  if (!kind || !message) return null;
  const trace = typeof b.trace === 'string' && TRACE_PATTERN.test(b.trace) ? b.trace : null;
  const bid = typeof b.bid === 'string' && BID_PATTERN.test(b.bid) ? b.bid : null;
  return {
    kind,
    ...(trace ? { trace } : {}),
    ...(bid ? { bid } : {}),
    message,
    stack: text(b.stack, 4000),
    source: text(b.source, 300),
    line: int(b.line),
    column: int(b.column),
    build: text(b.build, 64),
    screen: text(b.screen, 32),
    userAgent: text(b.userAgent, 300),
    count: Math.max(1, Math.min(int(b.count) ?? 1, 1e6)),
    ...(() => {
      const cause = WEBGL_FAILURE_CAUSES.find(c => c === b.webglCause);
      const status = cause ? webglStatus(b.webglStatus) : null;
      return { ...(cause ? { webglCause: cause } : {}), ...(status ? { webglStatus: status } : {}) };
    })(),
    ...(kind === 'extension_error' && typeof b.extensionId === 'string' && EXTENSION_ID_PATTERN.test(b.extensionId)
      ? { extensionId: b.extensionId } : {}),
    ...eidField(b.eid),
  };
}
