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

export const PREWORLD_OUTCOMES = [
  'login_refused', 'connect_failed', 'char_list', 'char_error', 'chargen_ok', 'chargen_refused',
  'enter_refused', 'enter_ok', 'dropped', 'page_hidden', 'page_left', 'page_reload', 'boot_slow', 'boot_failed',
] as const;
export type PreworldOutcome = typeof PREWORLD_OUTCOMES[number];

export const PREWORLD_SCREENS = [
  'boot', 'server-select', 'connecting', 'char-select', 'chargen', 'portal-space', 'disconnected', 'world',
] as const;
export type PreworldScreen = typeof PREWORLD_SCREENS[number];

export const CHARGEN_STEPS = ['heritage', 'profession', 'skills', 'appearance', 'town', 'summary'] as const;

/** RELEASE.preworld-boot-stage — main()'s boot steps before the launcher (PreworldReporter BOOT_STAGES). */
export const BOOT_STAGES = [
  'capability', 'capability_prompt', 'era', 'patch_check', 'patch_download', 'side_tables', 'dat_parse',
  'renderer_init', 'world_init', 'bridge_probe', 'ui_init',
] as const;
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
}

export const CLIENT_PREWORLD_MAX_BODY = 2 * 1024;

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
  };
}
