/**
 * TELEMETRY.refusal-events — a refusal the player saw (renderer telemetry/RefusalReporter.ts).
 *
 * The page POSTs these to `POST /client-preworld` with outcome `refusal`: the first
 * of each (source, code) on the page at once, then a per-minute count of its
 * repeats. Each accepted event becomes one JSON log line, `client_refusal`, carrying
 * the page's era, server and trace, so tools/watch-refusals.sh can flag a new
 * (era, code) pair before a player reports it.
 *
 * Privacy: as clientWorld.ts. Every field is a closed token, a bounded number or a
 * pattern-checked string; `text` is the page's template (names already '_', no
 * digit allowed: numbers are '#'), so a name or a typed number never reaches the log
 * through this route. Unknown fields are dropped.
 */
import { TRACE_PATTERN, lateField } from './clientPreworld.js';
import { eidField } from './eventIds.js';

export const REFUSAL_OUTCOMES = ['refusal'] as const;
export const REFUSAL_SOURCES = ['client', 'server'] as const;
export const REFUSAL_CONTEXTS = ['spew', 'weenie_error', 'weenie_error_str', 'use_done', 'inventory_failed', 'server_text', 'transient'] as const;
export const REFUSAL_SINKS = ['spew', 'chat', 'none'] as const;
/** we:0x<hex> (a server code) or c: / t: and the template's FNV-1a hash. */
export const REFUSAL_CODE = /^(we:0x[0-9a-f]{1,8}|[ct]:[0-9a-f]{8})$/;
/** The page's template: printable ASCII without a digit, at most 120 characters. */
export const REFUSAL_TEXT = /^[\x20-\x2f\x3a-\x7e]{1,120}$/;
const SESSION_MS = 7 * 24 * 3600_000;

export interface ClientRefusalEvent {
  outcome: 'refusal';
  era: string | null;
  server: string | null;
  trace: string | null;
  build: string | null;
  lateMs?: number;
  eid?: string;
  source: typeof REFUSAL_SOURCES[number] | null;
  code: string | null;
  text: string | null;
  context: typeof REFUSAL_CONTEXTS[number] | null;
  sink: typeof REFUSAL_SINKS[number] | null;
  action: number | null;
  count: number | null;
  first: boolean | null;
  windowMs: number | null;
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return allowed.find(a => a === v) ?? null;
}
function match(v: unknown, re: RegExp): string | null {
  return typeof v === 'string' && re.test(v) ? v : null;
}
function uint(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

export function isRefusalOutcome(v: unknown): boolean {
  return pick(v, REFUSAL_OUTCOMES) !== null;
}

/** Validate a posted refusal field by field; null when it is not one, or carries no code. */
export function sanitizeClientRefusal(body: unknown): ClientRefusalEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const outcome = pick(b.outcome, REFUSAL_OUTCOMES);
  if (!outcome) return null;
  const code = match(b.code, REFUSAL_CODE);
  if (!code) return null;
  const count = uint(b.count, 1_000_000);
  return {
    outcome,
    era: match(b.era, /^[a-z0-9-]{1,32}$/),
    server: match(b.server, /^[A-Za-z0-9._-]{1,64}$/),
    trace: match(b.trace, TRACE_PATTERN),
    build: match(b.build, /^[A-Za-z0-9._-]{1,64}$/),
    ...lateField(b.lateMs, SESSION_MS),
    ...eidField(b.eid),
    source: pick(b.source, REFUSAL_SOURCES),
    code,
    text: match(b.text, REFUSAL_TEXT),
    context: pick(b.context, REFUSAL_CONTEXTS),
    sink: pick(b.sink, REFUSAL_SINKS),
    action: uint(b.action, 0xffff),
    count: count !== null && count >= 1 ? count : null,
    first: typeof b.first === 'boolean' ? b.first : null,
    windowMs: uint(b.windowMs, SESSION_MS),
  };
}
