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
  /** How long before the report the page's 1 s tick last ran: a large gap = its JavaScript was not running (frozen / suspended). */
  lastBeatAgoMs?: number | null;
  /** How long the session's bridge had been draining without a handover when it ended; null = not draining. */
  drainWaitMs?: number | null;
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
  /** PERF.slow-first-minute-diagnostics (renderer WorldReporter): why a first minute was slow. */
  frameMeanMs?: number | null;
  workMedianMs?: number | null;
  workP95Ms?: number | null;
  longTaskMs?: number | null;
  drawCalls?: number | null;
  triangles?: number | null;
  landblock?: string | null;
  browser?: typeof BROWSER_FAMILIES[number] | null;
  browserMajor?: number | null;
  os?: typeof OS_FAMILIES[number] | null;
  gpuName?: string | null;
  cores?: number | null;
  memGb?: number | null;
  /** PERF.slow-first-minute-diagnostics, second pass: which part of the page's code the minute went to. */
  phaseMs?: Partial<Record<typeof FRAME_PHASES[number], number>> | null;
  netHandlerMs?: number | null;
  streamHandlerMs?: number | null;
  longestHandlerMs?: number | null;
  longestHandlerOp?: string | null;
  longTaskMaxMs?: number | null;
  programs?: number | null;
  programsCreated?: number | null;
  geometries?: number | null;
  textures?: number | null;
  sceneObjects?: number | null;
  compileMs?: number | null;
  serverObjects?: number | null;
  /** BUG.hud-text-blank-font-sheet — page totals: blank bitmap-font sheets (rebuilt) and lost 2D canvas contexts. */
  fontSheetBad?: number | null;
  canvas2dLost?: number | null;
}

/** frameStep's phases (renderer telemetry/MainThreadCost.ts FRAME_PHASES): phaseMs keeps only these keys. */
export const FRAME_PHASES = ['nav', 'tags', 'agent', 'routine', 'ub', 'mag', 'physics', 'sweep', 'anim', 'sync', 'camera', 'fx', 'stream', 'hud', 'lod', 'warmup', 'render'] as const;
/** phaseMs holds at most this many phases (the renderer sends its ten largest). */
export const MAX_PHASE_KEYS = 10;
/** A per-frame phase mean, ms, at most this. */
export const MAX_PHASE_MS = 5000;

/** Mean ms per frame by phase: whitelisted keys, numbers 0..MAX_PHASE_MS at 0.1 ms; null when not an object. */
function phaseMs(v: unknown): Partial<Record<typeof FRAME_PHASES[number], number>> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Partial<Record<typeof FRAME_PHASES[number], number>> = {};
  let n = 0;
  // The page's order (largest first) is kept; unknown keys are dropped.
  for (const k of Object.keys(v)) {
    if (!(FRAME_PHASES as readonly string[]).includes(k)) continue;
    const x = (v as Record<string, unknown>)[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > MAX_PHASE_MS) continue;
    if (n++ >= MAX_PHASE_KEYS) break;
    out[k as typeof FRAME_PHASES[number]] = Math.round(x * 10) / 10;
  }
  return out;
}

/** Closed sets, as the renderer's WorldReporter BROWSER_FAMILIES / OS_FAMILIES. */
export const BROWSER_FAMILIES = ['chrome', 'edge', 'firefox', 'safari', 'opera', 'other'] as const;
export const OS_FAMILIES = ['windows', 'mac', 'linux', 'chromeos', 'android', 'ios', 'other'] as const;
const MEM_GB = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
/**
 * The renderer's frame / work histogram cap (WorldReporter HIST_MAX_MS): medians and p95s up to it.
 * It was 250 ms, which read every 3-4 FPS minute as 250 (2026-10-20). Accepting up to 2000 here
 * before the web build sends them keeps a newer page's slow minutes from reading as null.
 */
export const FRAME_HIST_MAX_MS = 2000;

/** The slow-first-minute fields, each only when the client sent it (older builds send none). */
function perfFields(b: Record<string, unknown>): Partial<ClientFirstMinuteEvent> {
  const out: Partial<ClientFirstMinuteEvent> = {};
  const set = <K extends keyof ClientFirstMinuteEvent>(k: K, v: ClientFirstMinuteEvent[K]): void => { if (k in b) out[k] = v; };
  set('frameMeanMs', uint(b.frameMeanMs, 5_000));
  set('workMedianMs', uint(b.workMedianMs, FRAME_HIST_MAX_MS));
  set('workP95Ms', uint(b.workP95Ms, FRAME_HIST_MAX_MS));
  set('longTaskMs', uint(b.longTaskMs, MINUTE_MS));
  set('drawCalls', uint(b.drawCalls, 1_000_000));
  set('triangles', uint(b.triangles, 100_000_000));
  set('landblock', match(b.landblock, /^[0-9a-f]{4}$/));
  set('browser', pick(b.browser, BROWSER_FAMILIES));
  set('browserMajor', uint(b.browserMajor, 999));
  set('os', pick(b.os, OS_FAMILIES));
  set('gpuName', match(b.gpuName, /^[\x20-\x7e]{1,96}$/));
  set('cores', uint(b.cores, 256));
  set('memGb', typeof b.memGb === 'number' && MEM_GB.includes(b.memGb) ? b.memGb : null);
  set('phaseMs', phaseMs(b.phaseMs));
  set('netHandlerMs', uint(b.netHandlerMs, MINUTE_MS));
  set('streamHandlerMs', uint(b.streamHandlerMs, MINUTE_MS));
  set('longestHandlerMs', uint(b.longestHandlerMs, MINUTE_MS));
  set('longestHandlerOp', match(b.longestHandlerOp, /^[A-Za-z0-9:_]{1,24}$/));
  set('longTaskMaxMs', uint(b.longTaskMaxMs, MINUTE_MS));
  set('programs', uint(b.programs, 100_000));
  set('programsCreated', uint(b.programsCreated, 1_000_000));
  set('geometries', uint(b.geometries, 10_000_000));
  set('textures', uint(b.textures, 10_000_000));
  set('sceneObjects', uint(b.sceneObjects, 10_000_000));
  set('compileMs', uint(b.compileMs, MINUTE_MS));
  set('serverObjects', uint(b.serverObjects, 1_000_000));
  set('fontSheetBad', uint(b.fontSheetBad, 1_000_000));
  set('canvas2dLost', uint(b.canvas2dLost, 1_000_000));
  return out;
}

/**
 * TELEMETRY.portal-use-failed — a portal the player used or walked into that did nothing within 5 s
 * of the last progress (renderer telemetry/PortalUseReporter.ts; ACE Portal.cs), and the light
 * success event with the try → PlayerTeleport time. One per portal per minute per page.
 */
export const PORTAL_OUTCOMES = ['portal_use_failed', 'portal_used'] as const;
export const PORTAL_TRIGGERS = ['use', 'walk_in'] as const;
export const PORTAL_USE_HELD = ['stale', 'busy', 'decided'] as const;
/** A portal watch's longest wait (renderer PORTAL_MAX_WAIT_MS 30 s, with slack for a late tick). */
const PORTAL_WAIT_MS = 120_000;

export interface ClientPortalUseFailedEvent extends WorldIds {
  outcome: 'portal_use_failed';
  trigger: typeof PORTAL_TRIGGERS[number] | null;
  wcid: number | null;
  itemType: number | null;
  descFlags: number | null;
  physicsState: number | null;
  ethereal: boolean | null;
  reportCollisions: boolean | null;
  useRadius: number | null;
  reach: number | null;
  dx: number | null;
  dy: number | null;
  dz: number | null;
  dist: number | null;
  endDist: number | null;
  playerCell: string | null;
  portalCell: string | null;
  useSent: boolean | null;
  held: typeof PORTAL_USE_HELD[number] | null;
  attempts: number | null;
  overlapped: boolean | null;
  serverWalk: boolean | null;
  useDone: number | null;
  weenieErrors: number[] | null;
  chatLines: number | null;
  chatType: number | null;
  chatTemplate: string | null;
  waitedMs: number | null;
}

export interface ClientPortalUsedEvent extends WorldIds {
  outcome: 'portal_used';
  trigger: typeof PORTAL_TRIGGERS[number] | null;
  wcid: number | null;
  ms: number | null;
  useSent: boolean | null;
  serverWalk: boolean | null;
  attempts: number | null;
}

/** A finite number within ±max, rounded to `decimals` places (metres). */
function metres(v: unknown, max: number, decimals: 1 | 2): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) return null;
  const k = decimals === 2 ? 100 : 10;
  return Math.round(v * k) / k + 0; // + 0: no -0 in the log
}
const U32 = 0xffff_ffff;

export function isPortalOutcome(v: unknown): boolean {
  return pick(v, PORTAL_OUTCOMES) !== null;
}

/** Validate a posted portal event field by field (the world events' ids and rules); null when it is not one. */
export function sanitizeClientPortal(body: unknown): ClientPortalEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const outcome = pick(b.outcome, PORTAL_OUTCOMES);
  if (!outcome) return null;
  return sanitizePortal(outcome, worldIds(b), b);
}

function sanitizePortal(outcome: typeof PORTAL_OUTCOMES[number], ids: WorldIds, b: Record<string, unknown>): ClientPortalUseFailedEvent | ClientPortalUsedEvent {
  const common = {
    trigger: pick(b.trigger, PORTAL_TRIGGERS),
    wcid: uint(b.wcid, U32),
    useSent: bool(b.useSent),
    serverWalk: bool(b.serverWalk),
    attempts: uint(b.attempts, 1000),
  };
  if (outcome === 'portal_used') return { outcome, ...ids, ...common, ms: uint(b.ms, PORTAL_WAIT_MS) };
  const codes = Array.isArray(b.weenieErrors) ? b.weenieErrors.slice(0, 4).map((c) => uint(c, U32)).filter((c): c is number => c !== null) : null;
  return {
    outcome, ...ids, ...common,
    itemType: uint(b.itemType, U32),
    descFlags: uint(b.descFlags, U32),
    physicsState: uint(b.physicsState, U32),
    ethereal: bool(b.ethereal),
    reportCollisions: bool(b.reportCollisions),
    useRadius: metres(b.useRadius, 1000, 2),
    reach: metres(b.reach, 1000, 2),
    dx: metres(b.dx, 100_000, 1),
    dy: metres(b.dy, 100_000, 1),
    dz: metres(b.dz, 100_000, 1),
    dist: metres(b.dist, 100_000, 1),
    endDist: metres(b.endDist, 100_000, 1),
    playerCell: match(b.playerCell, /^[0-9a-f]{8}$/),
    portalCell: match(b.portalCell, /^[0-9a-f]{8}$/),
    held: pick(b.held, PORTAL_USE_HELD),
    overlapped: bool(b.overlapped),
    useDone: uint(b.useDone, U32),
    weenieErrors: codes,
    chatLines: uint(b.chatLines, 10_000),
    chatType: uint(b.chatType, U32),
    // The page's template: printable ASCII, numbers already '#'; a digit here means it is not one.
    chatTemplate: match(b.chatTemplate, /^[\x20-\x2f\x3a-\x7e]{1,96}$/),
    waitedMs: uint(b.waitedMs, PORTAL_WAIT_MS),
  };
}

export type ClientWorldEvent = ClientFirstMinuteEvent | ClientWorldLeftEvent;
export type ClientPortalEvent = ClientPortalUseFailedEvent | ClientPortalUsedEvent;

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

function worldIds(b: Record<string, unknown>): WorldIds {
  return {
    era: match(b.era, /^[a-z0-9-]{1,32}$/),
    server: match(b.server, /^[A-Za-z0-9._-]{1,64}$/),
    trace: match(b.trace, TRACE_PATTERN),
    build: match(b.build, /^[A-Za-z0-9._-]{1,64}$/),
    ...lateField(b.lateMs, SESSION_MS),
    ...eidField(b.eid),
  };
}

export function isWorldOutcome(v: unknown): v is WorldOutcome {
  return pick(v, WORLD_OUTCOMES) !== null;
}

/** Validate a posted world event field by field; null when it is not one. Unknown fields are dropped. */
export function sanitizeClientWorld(body: unknown): ClientWorldEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const outcome = pick(b.outcome, WORLD_OUTCOMES);
  if (!outcome) return null;
  const ids = worldIds(b);
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
      ...('lastBeatAgoMs' in b ? { lastBeatAgoMs: uint(b.lastBeatAgoMs, SESSION_MS) } : {}),
      ...('drainWaitMs' in b ? { drainWaitMs: uint(b.drainWaitMs, SESSION_MS) } : {}),
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
    frameMedianMs: uint(b.frameMedianMs, FRAME_HIST_MAX_MS),
    frameP95Ms: uint(b.frameP95Ms, FRAME_HIST_MAX_MS),
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
    ...perfFields(b),
  };
}
