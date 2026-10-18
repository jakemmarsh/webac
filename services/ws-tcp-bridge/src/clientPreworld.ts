/**
 * RELEASE.preworld-outcomes — how a player's pre-world flow ended.
 *
 * The web client POSTs one small event to `POST /client-preworld` (renderer
 * telemetry/PreworldReporter.ts) when a login is refused, the character
 * list arrives, a character is created or refused, the world is entered or
 * refused, or the page closes (or reloads itself: page_reload) on a pre-world screen. Each accepted event
 * becomes one JSON log line (`client_preworld`) beside session_open /
 * session_close; the page's random `trace` id is also on its WebSocket URL,
 * so session_open carries the same id.
 *
 * Privacy: every field is a code, a number, or a string that must match a
 * closed pattern (identifier tokens, a fixed screen list); anything else is
 * dropped. No free text survives, so an account, character name or anything
 * a player typed cannot reach the log through this route. The bridge logs
 * the address itself, as it does for client_error.
 */

import { eidField } from './eventIds.js';
import { netDiagField, type NetDiag } from './netDiag.js';

export const PREWORLD_OUTCOMES = [
  'login_refused', 'connect_failed', 'char_list', 'char_error', 'chargen_ok', 'chargen_refused',
  'chargen_sent', 'chargen_blocked',
  'enter_refused', 'enter_ok', 'dropped', 'page_hidden', 'page_left', 'page_reload', 'boot_slow', 'boot_failed',
  'enter_retry', 'left_for_launcher', 'resume_ended', 'login_retry', 'handover', 'boot_done',
] as const;
export type PreworldOutcome = typeof PREWORLD_OUTCOMES[number];

export const PREWORLD_SCREENS = [
  'boot', 'server-select', 'connecting', 'resuming', 'char-select', 'chargen', 'portal-space', 'disconnected', 'world',
] as const;
export type PreworldScreen = typeof PREWORLD_SCREENS[number];

/**
 * A draining bridge's session moving to the new deployment (outcome 'handover'): why it moved —
 * 'safe' (the page found a safe moment and handed it over) or 'hard_cut' (the drain's cap closed it,
 * and the page's resume brought it back) — and how: 'adopt' (the new bridge took the session's
 * socket over; the server never saw a change) or 'relogin' (a fresh login and enter).
 */
export const HANDOVER_REASONS = ['safe', 'hard_cut'] as const;
export const HANDOVER_PATHS = ['adopt', 'relogin'] as const;

export const CHARGEN_STEPS = ['heritage', 'profession', 'skills', 'appearance', 'town', 'summary'] as const;

/** RELEASE.preworld-boot-stage — main()'s boot steps before the launcher (PreworldReporter BOOT_STAGES). */
export const BOOT_STAGES = [
  'capability', 'capability_prompt', 'era', 'patch_check', 'patch_download', 'world_cache', 'side_tables', 'dat_parse',
  'renderer_init', 'world_init', 'bridge_probe', 'ui_init',
] as const;
/** A streamed DAT set's scope (renderer StreamingDats StreamScope; PreworldReporter BOOT_STREAM_SCOPES). */
export const BOOT_STREAM_SCOPES = ['all', 'interface', 'world'] as const;
/** At most this many streamed sets boot per page (an era's interface set and its world set). */
export const MAX_BOOT_STREAMS = 2;
const MAX_STREAM_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_STREAM_OBJECTS = 10_000_000;
const MAX_STREAM_MS = 24 * 3600_000;

/** One streamed set's open (PreworldReporter BootStreamReport). */
export interface BootStream {
  scope: typeof BOOT_STREAM_SCOPES[number];
  ms: number;
  worldCacheMs: number;
  worldCached: boolean;
  netBytes: number;
  cacheBytes: number;
  cacheObjects: number;
}
export const BOOT_CACHE_STATES = ['cold', 'warm', 'partial', 'off'] as const;
export const CAPABILITY_ISSUES = ['webgl2', 'websocket', 'memory', 'pointer', 'software_gpu'] as const;
/** The largest download a boot announces, in KiB (16 GiB: every whole DAT is ~1.4 GB). */
const MAX_KB = 16 * 1024 * 1024;

export interface ClientPreworldEvent {
  outcome: PreworldOutcome;
  era: string | null;
  server: string | null;
  trace: string | null;
  build: string | null;
  screen: PreworldScreen | null;
  step: string | null;
  code: number | null;
  table: number | null;
  token: string | null;
  count: number | null;
  pageMs: number | null;
  screenMs: number | null;
  sinceLoginMs: number | null;
  sinceEnterMs: number | null;
  stage: typeof BOOT_STAGES[number] | null;
  progress: number | null;
  doneKB: number | null;
  totalKB: number | null;
  cache: typeof BOOT_CACHE_STATES[number] | null;
  caps: Array<typeof CAPABILITY_ISSUES[number]> | null;
  /**
   * Each streamed set's open (how long, how much of it the warm-cache world
   * wait took, cache vs network): boot-screen events, boot_done and the
   * page's first char_list. Absent otherwise or when nothing valid came.
   */
  stream?: BootStream[];
  /**
   * The event went out late: the network refused its first send (renderer
   * telemetry/TelemetryOutbox.ts) and this is how long it waited. Absent on
   * an event that went at once; the log line's time is when it arrived.
   */
  lateMs?: number;
  /** The page's id for this event, the same on every resend (eventIds.ts): the bridge logs each once. */
  eid?: string;
  /** OBS.dm-stall-diagnostics — 'dropped' only: the connection's state when a silent / closed session ended (netDiag.ts). */
  net?: NetDiag;
  /** 'handover' only: from the handover's start (or the hard cut) to back in the world, in ms; why and how (HANDOVER_REASONS / _PATHS). */
  handoverMs?: number;
  reason?: typeof HANDOVER_REASONS[number];
  path?: typeof HANDOVER_PATHS[number];
}

/**
 * The route's body limit (client_preworld and client_world share it). 4 KiB since
 * OBS.dm-stall-tx-ring: a worst-case first_minute with a full txRecent ring is ~2.4 KiB.
 */
export const CLIENT_PREWORLD_MAX_BODY = 4 * 1024;

/** A random page id: what the client puts on its WebSocket URL and on each event. */
export const TRACE_PATTERN = /^[a-z0-9]{8,32}$/;

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return allowed.find(a => a === v) ?? null;
}

function match(v: unknown, re: RegExp): string | null {
  return typeof v === 'string' && re.test(v) ? v : null;
}

function uint(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

/** A list of listed identifiers (each at most once, in the list's order); null when not an array or none is listed. */
function pickList<T extends string>(v: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(v)) return null;
  const out = allowed.filter(a => v.includes(a));
  return out.length ? out : null;
}

/** The trace id on a WebSocket upgrade URL (`?trace=`), or null. */
export function traceFromUrl(url: string | undefined): string | null {
  try {
    return match(new URL(url ?? '/', 'http://bridge.local').searchParams.get('trace'), TRACE_PATTERN);
  } catch { return null; }
}

const MAX_MS = 7 * 24 * 3600_000;

/** `{ lateMs }` when the event carries a valid one (it went out late), else nothing. */
export function lateField(v: unknown, max: number): { lateMs?: number } {
  const n = uint(v, max);
  return n === null ? {} : { lateMs: n };
}

/** Validate a posted body field by field; null when it is not an event. Unknown fields are dropped. */
export function sanitizeClientPreworld(body: unknown): ClientPreworldEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const outcome = pick(b.outcome, PREWORLD_OUTCOMES);
  if (!outcome) return null;
  return {
    outcome,
    era: match(b.era, /^[a-z0-9-]{1,32}$/),
    server: match(b.server, /^[A-Za-z0-9._-]{1,64}$/),
    trace: match(b.trace, TRACE_PATTERN),
    build: match(b.build, /^[A-Za-z0-9._-]{1,64}$/),
    screen: pick(b.screen, PREWORLD_SCREENS),
    step: pick(b.step, CHARGEN_STEPS),
    code: uint(b.code, 0xffffffff),
    table: uint(b.table, 0xffffffff),
    token: match(b.token, /^[A-Za-z][A-Za-z0-9_]{0,79}$/),
    count: uint(b.count, 1000),
    pageMs: uint(b.pageMs, MAX_MS),
    screenMs: uint(b.screenMs, MAX_MS),
    sinceLoginMs: uint(b.sinceLoginMs, MAX_MS),
    sinceEnterMs: uint(b.sinceEnterMs, MAX_MS),
    stage: pick(b.stage, BOOT_STAGES),
    progress: uint(b.progress, 100),
    doneKB: uint(b.doneKB, MAX_KB),
    totalKB: uint(b.totalKB, MAX_KB),
    cache: pick(b.cache, BOOT_CACHE_STATES),
    caps: pickList(b.caps, CAPABILITY_ISSUES),
    ...streamField(b.stream),
    ...lateField(b.lateMs, MAX_MS),
    ...eidField(b.eid),
    ...(outcome === 'dropped' ? netDiagField(b.net) : {}),
    ...(outcome === 'handover' ? handoverFields(b) : {}),
  };
}

/**
 * `{ stream }` when the body carries valid streamed-set reports: each entry
 * needs a known scope and every number in bounds (an entry with any field
 * out of bounds is dropped whole), one per scope, at most MAX_BOOT_STREAMS.
 */
export function streamField(v: unknown): { stream?: BootStream[] } {
  if (!Array.isArray(v)) return {};
  const out: BootStream[] = [];
  for (const e of v.slice(0, 16)) { // the 4 KiB body holds few more
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    const scope = pick(r.scope, BOOT_STREAM_SCOPES);
    const ms = uint(r.ms, MAX_STREAM_MS);
    const worldCacheMs = uint(r.worldCacheMs, MAX_STREAM_MS);
    const netBytes = uint(r.netBytes, MAX_STREAM_BYTES);
    const cacheBytes = uint(r.cacheBytes, MAX_STREAM_BYTES);
    const cacheObjects = uint(r.cacheObjects, MAX_STREAM_OBJECTS);
    if (!scope || ms === null || worldCacheMs === null || netBytes === null || cacheBytes === null || cacheObjects === null
      || typeof r.worldCached !== 'boolean' || out.some((o) => o.scope === scope)) continue;
    out.push({ scope, ms, worldCacheMs, worldCached: r.worldCached, netBytes, cacheBytes, cacheObjects });
    if (out.length >= MAX_BOOT_STREAMS) break;
  }
  return out.length ? { stream: out } : {};
}

/** The 'handover' outcome's own fields, each only when valid. */
function handoverFields(b: Record<string, unknown>): Pick<ClientPreworldEvent, 'handoverMs' | 'reason' | 'path'> {
  const ms = uint(b.handoverMs, 24 * 3600_000);
  const reason = pick(b.reason, HANDOVER_REASONS);
  const path = pick(b.path, HANDOVER_PATHS);
  return { ...(ms !== null ? { handoverMs: ms } : {}), ...(reason ? { reason } : {}), ...(path ? { path } : {}) };
}
