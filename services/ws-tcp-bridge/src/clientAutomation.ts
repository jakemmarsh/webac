/**
 * OBS.automation-usage — whether players use the in-game automation (the
 * Virindi Views-style plugin bar and its windows, VirindiTank-style
 * routines). The web client (renderer telemetry/AutomationReporter.ts) POSTs
 * these to the pre-world route, `POST /client-preworld`:
 *
 * - automation_offered: the bridge's routines answer for this page (the
 *   automation UI and the preview UI on or off for the account);
 * - routine_started / routine_stopped / routine_error: a run's kind, who
 *   drove it, why it ended and how long it ran (state changes only, capped
 *   per page);
 * - automation_summary: what one world session did (the bar, the windows
 *   opened, runs, run time, imports).
 *
 * Each accepted event becomes one JSON log line, `client_automation`, with
 * the page's `trace`, era and server, so usage counts by world.
 *
 * Privacy: as clientPreworld.ts — every field is a number in bounds, a
 * boolean, or a member of a closed list, re-checked here whatever the page
 * sent; anything else is dropped or nulled, so no profile, file or player
 * name, and no free text, can reach the log through this route.
 */
import { TRACE_PATTERN, lateField } from './clientPreworld.js';
import { eidField } from './eventIds.js';

export const AUTOMATION_OUTCOMES = ['automation_offered', 'routine_started', 'routine_stopped', 'routine_error', 'automation_summary'] as const;
export type AutomationOutcome = typeof AUTOMATION_OUTCOMES[number];
/** The plugin windows (renderer AutomationReporter PLUGIN_WINDOWS). */
export const PLUGIN_WINDOWS = [
  'vtank', 'vtank-panel', 'vtank-editor', 'history', 'remote', 'hotkeys', 'hotkeys-vvs',
  'ub-main', 'ub-dungeon', 'ub-landscape', 'goarrow', 'goarrow-arrow', 'vcs', 'magtools',
  'reporter', 'status-hud', 'status-hud-config', 'virindi-uis', 'splitpea', 'splitpea-edit', 'other',
] as const;
export const ROUTINE_DRIVERS = ['player', 'agent'] as const;
export const ROUTINE_KINDS = ['macro', 'meta', 'rules'] as const;
export const ROUTINE_STOP_REASONS = ['player', 'agent', 'died', 'rule', 'replaced'] as const;
export const ROUTINE_ERROR_PLACES = ['rule', 'loot', 'macro'] as const;
export const IMPORT_OUTCOMES = ['ok', 'partial', 'failed'] as const;
export const IMPORT_KINDS = ['met', 'nav', 'utl', 'usd', 'af', 'other'] as const;
export const AUTOMATION_EXITS = ['closed_tab', 'logout', 'disconnected'] as const;

interface Ids {
  era: string | null;
  server: string | null;
  trace: string | null;
  build: string | null;
  lateMs?: number;
  eid?: string;
}

type Driver = typeof ROUTINE_DRIVERS[number];
type Kind = typeof ROUTINE_KINDS[number];

export interface ClientAutomationOffered extends Ids { outcome: 'automation_offered'; automation: boolean | null; preview: boolean | null }
export interface ClientRoutineStarted extends Ids { outcome: 'routine_started'; kind: Kind | null; driver: Driver | null; nav: boolean | null; loot: boolean | null; example: boolean | null }
export interface ClientRoutineStopped extends Ids {
  outcome: 'routine_stopped'; kind: Kind | null; driver: Driver | null; reason: typeof ROUTINE_STOP_REASONS[number] | null; runMs: number | null; errors: number | null;
}
export interface ClientRoutineError extends Ids { outcome: 'routine_error'; kind: Kind | null; driver: Driver | null; where: typeof ROUTINE_ERROR_PLACES[number] | null }
export interface ClientAutomationSummary extends Ids {
  outcome: 'automation_summary';
  exit: typeof AUTOMATION_EXITS[number] | null;
  sessionMs: number | null;
  offered: boolean | null;
  preview: boolean | null;
  barShown: boolean | null;
  barToggles: number | null;
  barClicks: number | null;
  windows: Array<typeof PLUGIN_WINDOWS[number]> | null;
  starts: Record<Driver, number> | null;
  stops: Record<typeof ROUTINE_STOP_REASONS[number], number> | null;
  kinds: Kind[] | null;
  runMs: number | null;
  running: boolean | null;
  errors: number | null;
  imports: Record<typeof IMPORT_OUTCOMES[number], number> | null;
  importKinds: Array<typeof IMPORT_KINDS[number]> | null;
}
export type ClientAutomationEvent = ClientAutomationOffered | ClientRoutineStarted | ClientRoutineStopped | ClientRoutineError | ClientAutomationSummary;

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return allowed.find(a => a === v) ?? null;
}
function match(v: unknown, re: RegExp): string | null {
  return typeof v === 'string' && re.test(v) ? v : null;
}
function uint(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
/** The listed identifiers `v` holds, each once, in the list's order; null when not an array. */
function pickList<T extends string>(v: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(v)) return null;
  return allowed.filter(a => v.includes(a));
}
/** A count per listed key (each 0..max; a missing or bad count reads 0); null when not an object. */
function counts<T extends string>(v: unknown, keys: readonly T[], max: number): Record<T, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const out = {} as Record<T, number>;
  for (const k of keys) out[k] = uint(b[k], max) ?? 0;
  return out;
}

const SESSION_MS = 7 * 24 * 3600_000;
/** Counts within one world session (runs, clicks, imports, action errors). */
const MAX_COUNT = 100_000;

export function isAutomationOutcome(v: unknown): v is AutomationOutcome {
  return pick(v, AUTOMATION_OUTCOMES) !== null;
}

/** Validate a posted automation event field by field; null when it is not one. Unknown fields are dropped. */
export function sanitizeClientAutomation(body: unknown): ClientAutomationEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const outcome = pick(b.outcome, AUTOMATION_OUTCOMES);
  if (!outcome) return null;
  const ids: Ids = {
    era: match(b.era, /^[a-z0-9-]{1,32}$/),
    server: match(b.server, /^[A-Za-z0-9._-]{1,64}$/),
    trace: match(b.trace, TRACE_PATTERN),
    build: match(b.build, /^[A-Za-z0-9._-]{1,64}$/),
    ...lateField(b.lateMs, SESSION_MS),
    ...eidField(b.eid),
  };
  switch (outcome) {
    case 'automation_offered':
      return { outcome, ...ids, automation: bool(b.automation), preview: bool(b.preview) };
    case 'routine_started':
      return { outcome, ...ids, kind: pick(b.kind, ROUTINE_KINDS), driver: pick(b.driver, ROUTINE_DRIVERS), nav: bool(b.nav), loot: bool(b.loot), example: bool(b.example) };
    case 'routine_stopped':
      return {
        outcome, ...ids, kind: pick(b.kind, ROUTINE_KINDS), driver: pick(b.driver, ROUTINE_DRIVERS),
        reason: pick(b.reason, ROUTINE_STOP_REASONS), runMs: uint(b.runMs, SESSION_MS), errors: uint(b.errors, MAX_COUNT),
      };
    case 'routine_error':
      return { outcome, ...ids, kind: pick(b.kind, ROUTINE_KINDS), driver: pick(b.driver, ROUTINE_DRIVERS), where: pick(b.where, ROUTINE_ERROR_PLACES) };
    case 'automation_summary':
      return {
        outcome, ...ids,
        exit: pick(b.exit, AUTOMATION_EXITS),
        sessionMs: uint(b.sessionMs, SESSION_MS),
        offered: bool(b.offered),
        preview: bool(b.preview),
        barShown: bool(b.barShown),
        barToggles: uint(b.barToggles, MAX_COUNT),
        barClicks: uint(b.barClicks, MAX_COUNT),
        windows: pickList(b.windows, PLUGIN_WINDOWS),
        starts: counts(b.starts, ROUTINE_DRIVERS, MAX_COUNT),
        stops: counts(b.stops, ROUTINE_STOP_REASONS, MAX_COUNT),
        kinds: pickList(b.kinds, ROUTINE_KINDS),
        runMs: uint(b.runMs, SESSION_MS),
        running: bool(b.running),
        errors: uint(b.errors, MAX_COUNT),
        imports: counts(b.imports, IMPORT_OUTCOMES, MAX_COUNT),
        importKinds: pickList(b.importKinds, IMPORT_KINDS),
      };
  }
}
