/**
 * RELEASE.first-minute — what a player's first minute in the world was like,
 * and how long the world session lasted.
 *
 * The web client (renderer telemetry/WorldReporter.ts) POSTs these to the
 * pre-world route, `POST /client-preworld`, with outcome `first_minute`
 * (one per world entry: at 60 s in the world, or when the player leaves
 * sooner) or `world_left` (a session that outlived its first minute ended).
 * Each accepted event becomes one JSON log line, `client_world`, carrying the
 * page's `trace` id like client_preworld and session_open do.
 *
 * Privacy: as clientPreworld.ts — every field is a number in bounds, a
 * boolean, or a member of a closed list; anything else is dropped, so no
 * name, typed text or GPU string can reach the log through this route.
 */
import { TRACE_PATTERN, lateField } from './clientPreworld.js';
import { eidField } from './eventIds.js';
import { netDiagField, type NetDiag } from './netDiag.js';

export const WORLD_OUTCOMES = ['first_minute', 'world_left'] as const;
export type WorldOutcome = typeof WORLD_OUTCOMES[number];
export const WORLD_EXITS = ['closed_tab', 'hidden', 'logout', 'disconnected', 'still_in'] as const;
/** world_left's exits: a real end of the session (never a hidden tab or still_in). */
export const WORLD_LEFT_EXITS = ['closed_tab', 'logout', 'disconnected'] as const;
export const WORLD_SCREENS = ['world', 'portal_space', 'disconnected', 'char_select', 'connecting'] as const;
export const WORLD_MODALS = ['popup', 'message', 'confirm', 'dialog', 'book'] as const;
export const GPU_CLASSES = ['integrated', 'discrete', 'software', 'unknown'] as const;
/** BUG.hidden-tab-session-drop — what ended a dropped session (renderer WorldReporter WORLD_END_CAUSES). */
export const WORLD_END_CAUSES = ['socket_closed', 'server_disconnect', 'server_net_error', 'server_silent', 'client_suspended', 'local', 'link_dead', 'server_boot'] as const;

interface WorldIds {
  era: string | null;
  server: string | null;
  trace: string | null;
  build: string | null;
  /**
   * The event went out late (renderer telemetry/TelemetryOutbox.ts): the
   * network refused its first send, typically the world_left of a drop, and
   * this is how long it waited. Absent on an event that went at once.
   */
  lateMs?: number;
  /** The page's id for this event, the same on every resend (eventIds.ts): the bridge logs each once. */
  eid?: string;
}

/** A session that outlived its first minute ended. */
export interface ClientWorldLeftEvent extends WorldIds {
  outcome: 'world_left';
  exit: typeof WORLD_LEFT_EXITS[number] | null;
  sessionMs: number | null;
  contextLost: boolean | null;
  errors: number | null;
  /** Exit 'disconnected': what ended the session, and the browser socket's close code. */
  endCause?: typeof WORLD_END_CAUSES[number] | null;
  closeCode?: number | null;
  /** How long the page had been hidden at the end (null = visible), and its page-lifecycle freezes. */
  hiddenMs?: number | null;
  freezes?: number | null;
  frozenMs?: number | null;
  /** OBS.dm-stall-diagnostics — the connection's state when a silent / closed session ended (netDiag.ts). */
  net?: NetDiag;
}

/** The first minute after enter_ok (renderer WorldReporter FirstMinuteEvent). */
export interface ClientFirstMinuteEvent extends WorldIds {
  outcome: 'first_minute';
  exit: typeof WORLD_EXITS[number] | null;
  leftAfterMs: number | null;
  resumed: boolean | null;
  startedHidden: boolean | null;
  frames: number | null;
  worldFrames: number | null;
  frameMedianMs: number | null;
  frameP95Ms: number | null;
  frameMaxMs: number | null;
  contextLost: boolean | null;
  gpu: typeof GPU_CLASSES[number] | null;
  dpr: number | null;
  canvasW: number | null;
  canvasH: number | null;
  /** Dynamic resolution's scale at the event, percent of full (renderer scene/DynamicResolution.ts). */
  renderScalePct: number | null;
  /** The world context had no MSAA (software rendering). */
  msaaOff: boolean | null;
  /** Adaptive draw-distance steps below the player's setting. */
  drawDistanceSteps: number | null;
  worldDrawnMs: number | null;
  screen: typeof WORLD_SCREENS[number] | null;
  unresolvedMisses: number | null;
  firstMoveMs: number | null;
  firstClickMs: number | null;
  keys: number | null;
  modal: typeof WORLD_MODALS[number] | null;
  modalMs: number | null;
  errors: number | null;
  endCause?: typeof WORLD_END_CAUSES[number] | null;
  closeCode?: number | null;
  /** OBS.dm-stall-diagnostics — the connection's state when a silent / closed session ended (netDiag.ts). */
  net?: NetDiag;
}

export type ClientWorldEvent = ClientFirstMinuteEvent | ClientWorldLeftEvent;

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
/** A whole percent 1..100 (the render scale). */
function pct(v: unknown): number | null {
  const n = uint(v, 100);
  return n !== null && n >= 1 ? n : null;
}
/** A device pixel ratio in quarter steps, 0.25–8. */
function dpr(v: unknown): number | null {
  return typeof v === 'number' && v >= 0.25 && v <= 8 && Number.isInteger(v * 4) ? v : null;
}
/** A canvas dimension the page rounded down to 100 px (at most 16000). */
function px100(v: unknown): number | null {
  const n = uint(v, 16_000);
  return n !== null && n % 100 === 0 ? n : null;
}

/** A WebSocket close code (1000–4999). */
function closeCode(v: unknown): number | null {
  const n = uint(v, 4999);
  return n !== null && n >= 1000 ? n : null;
}
/** The drop fields, present only when the page sent them (older pages do not). */
function dropFields(b: Record<string, unknown>): { endCause?: typeof WORLD_END_CAUSES[number] | null; closeCode?: number | null; net?: NetDiag } {
  return {
    ...('endCause' in b ? { endCause: pick(b.endCause, WORLD_END_CAUSES) } : {}),
    ...('closeCode' in b ? { closeCode: closeCode(b.closeCode) } : {}),
    ...netDiagField(b.net),
  };
}

const MINUTE_MS = 120_000; // a first-minute timing (60 s, with slack for a late tick)
const SESSION_MS = 7 * 24 * 3600_000;
/** Frames in one minute: 60 s at a 500 Hz display, with headroom. */
const MAX_FRAMES = 60_000;

export function isWorldOutcome(v: unknown): v is WorldOutcome {
  return pick(v, WORLD_OUTCOMES) !== null;
}

/** Validate a posted world event field by field; null when it is not one. Unknown fields are dropped. */
export function sanitizeClientWorld(body: unknown): ClientWorldEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const outcome = pick(b.outcome, WORLD_OUTCOMES);
  if (!outcome) return null;
  const ids = {
    era: match(b.era, /^[a-z0-9-]{1,32}$/),
    server: match(b.server, /^[A-Za-z0-9._-]{1,64}$/),
    trace: match(b.trace, TRACE_PATTERN),
    build: match(b.build, /^[A-Za-z0-9._-]{1,64}$/),
    ...lateField(b.lateMs, SESSION_MS),
    ...eidField(b.eid),
  };
  if (outcome === 'world_left') {
    return {
      outcome, ...ids,
      exit: pick(b.exit, WORLD_LEFT_EXITS),
      sessionMs: uint(b.sessionMs, SESSION_MS),
      contextLost: bool(b.contextLost),
      errors: uint(b.errors, 100_000),
      ...dropFields(b),
      ...('hiddenMs' in b ? { hiddenMs: uint(b.hiddenMs, SESSION_MS) } : {}),
      ...('freezes' in b ? { freezes: uint(b.freezes, 100_000) } : {}),
      ...('frozenMs' in b ? { frozenMs: uint(b.frozenMs, SESSION_MS) } : {}),
    };
  }
  return {
    outcome, ...ids,
    exit: pick(b.exit, WORLD_EXITS),
    leftAfterMs: uint(b.leftAfterMs, MINUTE_MS),
    resumed: bool(b.resumed),
    startedHidden: bool(b.startedHidden),
    frames: uint(b.frames, MAX_FRAMES),
    worldFrames: uint(b.worldFrames, MAX_FRAMES),
    frameMedianMs: uint(b.frameMedianMs, 250),
    frameP95Ms: uint(b.frameP95Ms, 250),
    frameMaxMs: uint(b.frameMaxMs, MINUTE_MS),
    contextLost: bool(b.contextLost),
    gpu: pick(b.gpu, GPU_CLASSES),
    dpr: dpr(b.dpr),
    canvasW: px100(b.canvasW),
    canvasH: px100(b.canvasH),
    renderScalePct: pct(b.renderScalePct),
    msaaOff: bool(b.msaaOff),
    drawDistanceSteps: uint(b.drawDistanceSteps, 5),
    worldDrawnMs: uint(b.worldDrawnMs, MINUTE_MS),
    screen: pick(b.screen, WORLD_SCREENS),
    unresolvedMisses: uint(b.unresolvedMisses, 1_000_000),
    firstMoveMs: uint(b.firstMoveMs, MINUTE_MS),
    firstClickMs: uint(b.firstClickMs, MINUTE_MS),
    keys: uint(b.keys, 100_000),
    modal: pick(b.modal, WORLD_MODALS),
    modalMs: uint(b.modalMs, SESSION_MS),
    errors: uint(b.errors, 100_000),
    ...dropFields(b),
  };
}
