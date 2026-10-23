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
 *
 * TELEMETRY.refusal-name-safety (defence in depth): build 1e71a1abb705's pages sent other players' names in
 * server texts ("Reemer has given you permission to loot his or her kills."). A text that still carries a
 * capitalized word outside the shared template vocabulary, a quoted string or a speech shape
 * (RefusalTextSafety.textCarriesUnknownWord) is dropped here; the event keeps its code and context.
 */
import { TRACE_PATTERN, lateField } from './clientPreworld.js';
import { eidField } from './eventIds.js';
import { textCarriesUnknownWord } from '../../../packages/shared/src/util/RefusalTextSafety.js';

export const REFUSAL_OUTCOMES = ['refusal'] as const;
export const REFUSAL_SOURCES = ['client', 'server'] as const;
export const REFUSAL_CONTEXTS = ['spew', 'weenie_error', 'weenie_error_str', 'use_done', 'inventory_failed', 'server_text', 'transient'] as const;
export const REFUSAL_SINKS = ['spew', 'chat', 'none'] as const;
/** we:0x<hex> (a server code) or c: / t: and the template's FNV-1a hash. */
export const REFUSAL_CODE = /^(we:0x[0-9a-f]{1,8}|[ct]:[0-9a-f]{8})$/;
/** The page's template: printable ASCII without a digit, at most 120 characters. */
export const REFUSAL_TEXT = /^[\x20-\x2f\x3a-\x7e]{1,120}$/;
const SESSION_MS = 7 * 24 * 3600_000;
/** TELEMETRY.refusal-context — the pending inventory request's kind (renderer RefusalTemplates.ts). */
export const REFUSAL_PENDING = ['merge', 'split', 'move', 'pick_up', 'put_in_container', 'drop', 'wield', 'shop_event', 'give'] as const;
/** Where the selection is. */
export const REFUSAL_SELECTION = ['none', 'self', 'pack', 'worn', 'world', 'unknown'] as const;
/** BUG.cast-flood-remaining — what pressed Cast (renderer RefusalTemplates.ts CAST_INPUTS). */
export const REFUSAL_CAST_INPUT = ['key', 'mouse', 'agent'] as const;

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
  /** TELEMETRY.refusal-context: present only when the page sent a valid value. */
  pending?: typeof REFUSAL_PENDING[number];
  pendingMs?: number;
  spellTargetType?: number;
  selection?: typeof REFUSAL_SELECTION[number];
  selectionType?: number;
  prevSelection?: typeof REFUSAL_SELECTION[number];
  prevSelectionType?: number;
  selectionGoneMs?: number;
  castInput?: typeof REFUSAL_CAST_INPUT[number];
  castGapMs?: number;
}

/** The context fields, each kept only when valid (closed tokens, bounded numbers). */
function refusalContextFields(b: Record<string, unknown>): Partial<ClientRefusalEvent> {
  const out: Partial<ClientRefusalEvent> = {};
  const pending = pick(b.pending, REFUSAL_PENDING); if (pending) out.pending = pending;
  const pendingMs = uint(b.pendingMs, SESSION_MS); if (pendingMs !== null) out.pendingMs = pendingMs;
  const stt = uint(b.spellTargetType, 0xffffffff); if (stt !== null) out.spellTargetType = stt;
  const sel = pick(b.selection, REFUSAL_SELECTION); if (sel) out.selection = sel;
  const selT = uint(b.selectionType, 0xffffffff); if (selT !== null) out.selectionType = selT;
  const prev = pick(b.prevSelection, REFUSAL_SELECTION); if (prev) out.prevSelection = prev;
  const prevT = uint(b.prevSelectionType, 0xffffffff); if (prevT !== null) out.prevSelectionType = prevT;
  const gone = uint(b.selectionGoneMs, SESSION_MS); if (gone !== null) out.selectionGoneMs = gone;
  const castInput = pick(b.castInput, REFUSAL_CAST_INPUT); if (castInput) out.castInput = castInput;
  const castGap = uint(b.castGapMs, SESSION_MS); if (castGap !== null) out.castGapMs = castGap;
  return out;
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

/** The page's template, or null when it isn't one or might carry a name. */
export function refusalText(v: unknown): string | null {
  const t = match(v, REFUSAL_TEXT);
  return t !== null && !textCarriesUnknownWord(t) ? t : null;
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
    text: refusalText(b.text),
    context: pick(b.context, REFUSAL_CONTEXTS),
    sink: pick(b.sink, REFUSAL_SINKS),
    action: uint(b.action, 0xffff),
    count: count !== null && count >= 1 ? count : null,
    first: typeof b.first === 'boolean' ? b.first : null,
    windowMs: uint(b.windowMs, SESSION_MS),
    ...refusalContextFields(b),
  };
}
