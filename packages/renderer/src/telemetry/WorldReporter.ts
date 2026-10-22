/**
 * RELEASE.first-minute — what a player's first minute in the world was like,
 * reported to the bridge (`POST /client-preworld`, the pre-world reporter's
 * route; services/ws-tcp-bridge/src/clientWorld.ts → one `client_world` line).
 *
 * The pre-world reporter stops at enter_ok. Production showed new players
 * entering the world and closing the tab 15–60 s later on every server, while
 * headless and local first minutes looked fine. Per world entry the page now
 * sends ONE `first_minute` event: at 60 s in the world (exit "still_in"), or
 * when the player leaves sooner (tab closed, page hidden, logout, a drop),
 * whichever comes first. It says how the minute rendered (frames, median /
 * p95 / longest frame, a lost WebGL context, the GPU's class, the pixel
 * ratio and canvas size, the dynamic-resolution scale it settled on, whether
 * MSAA was off for software rendering and any adaptive draw-distance steps), when the world was first drawn after enter_ok,
 * where the player was at exit (world / portal space / …) with the streamed
 * DAT misses still unresolved, the first movement and world click, the
 * number of keypresses, the blocking window open at exit (welcome popup,
 * tutorial book) and for how long, and how many error reports the page made.
 * A session that outlives the first minute sends one light `world_left` when
 * it ends (closed tab / logout / drop) with its length.
 *
 * Overhead: frame() runs every rendered frame and only bumps counters in
 * preallocated storage (a fixed 1 ms frame-time histogram); everything else
 * is polled once a second or computed when the event is built.
 *
 * Privacy (the pre-world reporter's rules): codes, counts, durations and
 * closed class names only. The GPU renderer string is reduced to a class here
 * and never leaves the page; no key identity, typed text, name or chat is
 * ever an input to this module.
 */
import { boundNetDiagnostics, NET_DIAG_END_CAUSES } from '@ac/network';
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';
import { FRAME_PHASES, PHASE, opToken } from './MainThreadCost.js';

/** How the player left (closed set; `still_in` = in the world at 60 s). */
export const WORLD_EXITS = ['closed_tab', 'hidden', 'logout', 'disconnected', 'still_in'] as const;
export type WorldExit = typeof WORLD_EXITS[number];

/** Where the player was when the event went out (closed set; main.ts worldScreen). */
export const WORLD_SCREENS = ['world', 'portal_space', 'disconnected', 'char_select', 'connecting'] as const;
export type WorldScreen = typeof WORLD_SCREENS[number];

/** The blocking window on screen (GameUI.openBlockingWindow), closed set. */
export const WORLD_MODALS = ['popup', 'message', 'confirm', 'dialog', 'book'] as const;
export type WorldModal = typeof WORLD_MODALS[number];

/** The GPU's class from the unmasked renderer string; the string itself is never sent. */
export const GPU_CLASSES = ['integrated', 'discrete', 'software', 'unknown'] as const;
export type GpuClass = typeof GPU_CLASSES[number];

/**
 * BUG.hidden-tab-session-drop — what ended a dropped session, closed set: the
 * connection's ConnectionEvent.endCause (@ac/network DisconnectCause), or the
 * page's own verdicts: 'link_dead' = the 40 s DISCONNECT_TIME link check
 * (main.ts link tick), 'server_boot' = an AccountBoot / AccountBanned.
 */
export const WORLD_END_CAUSES = ['socket_closed', 'server_disconnect', 'server_net_error', 'server_silent', 'client_suspended', 'local', 'link_dead', 'server_boot'] as const;
export type WorldEndCause = typeof WORLD_END_CAUSES[number];

/** A drop's detail, from the 'disconnected' event (exit 'disconnected' only). */
export interface WorldDropDetail {
  endCause?: string | null;
  closeCode?: number | null;
  /**
   * OBS.dm-stall-diagnostics — the connection's NetDiagnostics at the end
   * (@ac/network NetDiagnostics.ts). Sent only for a session that went silent
   * or lost its socket (NET_DIAG_END_CAUSES), bounded field by field.
   */
  net?: unknown;
}

/** The bounded connection diagnostics an event carries (boundNetDiagnostics). */
export type WorldNetDiagnostics = NonNullable<ReturnType<typeof boundNetDiagnostics>>;

/** The first-minute window. */
export const FIRST_MINUTE_MS = 60_000;
/** A page sends at most this many world events (relogs, resumes). */
export const MAX_WORLD_EVENTS = 20;
/**
 * The frame-time histogram: 1 ms bins 0..HIST_MAX_MS-1, the last bin holds everything longer.
 * It reached only 250 ms, so the median and p95 of a 3-4 FPS minute (prod 2026-10-20: 294 ms
 * frames) both read 250, the cap: blind exactly for the minutes they exist to describe.
 * 2000 ms (0.5 FPS) holds every playable pace; the arrays are 8 KB each.
 */
export const HIST_MAX_MS = 2000;
/** A gap this long between frames is a stall of the tab (hidden, minimised), not a frame: not counted. */
const STALL_MS = 5_000;

export interface FirstMinuteEvent {
  outcome: 'first_minute';
  era: string;
  server: string | null;
  trace: string;
  build: string;
  exit: WorldExit;
  /** Since enter_ok; null when still in the world at 60 s. */
  leftAfterMs: number | null;
  /** This entry was the automatic resume after a drop (SessionLifecycle), not a fresh enter. */
  resumed: boolean;
  /** The page was hidden when the world came up (the player tabbed away during the load). */
  startedHidden: boolean;
  /** Animation frames in the minute (portal space included) and frames that drew the world. */
  frames: number;
  worldFrames: number;
  frameMedianMs: number | null;
  frameP95Ms: number | null;
  frameMaxMs: number | null;
  contextLost: boolean;
  gpu: GpuClass;
  /** devicePixelRatio to the nearest 0.25. */
  dpr: number | null;
  /** The canvas's CSS size, rounded down to 100 px. */
  canvasW: number | null;
  canvasH: number | null;
  /** PERF.render-adapt — the world buffer's scale at the event, percent of full (scene/DynamicResolution.ts). */
  renderScalePct: number;
  /** The world context was created without MSAA (software rendering, scene/RenderScale.ts). */
  msaaOff: boolean;
  /** Adaptive draw-distance steps below the player's setting at the event (0 = none). */
  drawDistanceSteps: number;
  /** enter_ok → the first frame that drew the world with no portal space over it; null if never. */
  worldDrawnMs: number | null;
  screen: WorldScreen;
  /** Streamed-DAT reads that missed and have not landed (null when the DATs are not streamed). */
  unresolvedMisses: number | null;
  firstMoveMs: number | null;
  firstClickMs: number | null;
  keys: number;
  modal: WorldModal | null;
  modalMs: number | null;
  errors: number;
  /**
   * PERF.slow-first-minute-diagnostics (2026-10-20: ~10% of end-of-retail first minutes ran at 3-4 fps,
   * discrete GPUs included, with nothing to say why). The mean frame interval, uncapped (the median /
   * p95 histogram stops at HIST_MAX_MS, 250 ms until 2026-10-20).
   */
  frameMeanMs?: number | null;
  /** Our own JS per frame (frameStep: update + render submit), 1 ms histogram capped at HIST_MAX_MS. */
  workMedianMs?: number | null;
  workP95Ms?: number | null;
  /** Main-thread long tasks (> 50 ms) in the minute, total ms; null where the browser has no longtask timing. */
  longTaskMs?: number | null;
  /** Per drawn world frame, means: renderer draw calls and triangles (three.js renderer.info: the whole frame, both passes of an indoor view (IndoorView.renderIndoorView)). */
  drawCalls?: number | null;
  triangles?: number | null;
  /** The player's landblock at the event, 4 hex digits (XXYY), or null. */
  landblock?: string | null;
  /** The browser and OS family + major version (closed sets), the WebGL renderer string, and the device's cores / memory. */
  browser?: BrowserFamily;
  browserMajor?: number | null;
  os?: OsFamily;
  gpuName?: string | null;
  cores?: number | null;
  memGb?: number | null;
  /**
   * PERF.slow-first-minute-diagnostics, second pass (2026-10-20: a 294 ms-a-frame minute on an RX 7900 XTX
   * with frameStep at 117 ms and 34.6 s of long tasks, so ~22 s ran outside frameStep). frameStep's mean
   * ms per measured frame by phase (MainThreadCost FRAME_PHASES), the ten largest, 0.1 ms; null when unmeasured.
   */
  phaseMs?: Partial<Record<typeof FRAME_PHASES[number], number>> | null;
  /** Synchronous main-thread ms in the minute: server-message handling (onSessionEvent) and streamed-DAT landings / rebuilds. */
  netHandlerMs?: number | null;
  streamHandlerMs?: number | null;
  /** The single longest of those handler calls and its op ("objectCreate", "m:f745", "ge:13", "s:bundle"). */
  longestHandlerMs?: number | null;
  longestHandlerOp?: string | null;
  /** The longest single long task in the minute (null where the browser has no longtask timing). */
  longTaskMaxMs?: number | null;
  /** three.js at the event: live WebGL programs, geometries and textures (renderer.info). */
  programs?: number | null;
  geometries?: number | null;
  textures?: number | null;
  /** WebGL programs created in the minute (a program thrown away and rebuilt counts again). */
  programsCreated?: number | null;
  /** The render + warmup phase ms of the frames in which programs were created (their compile cost, roughly). */
  compileMs?: number | null;
  /** Object3Ds under the world scene, counted at the event; live server objects at the event. */
  sceneObjects?: number | null;
  serverObjects?: number | null;
  /** Exit 'disconnected': what ended the session, and the socket's close code (1006 = dropped with no close frame). */
  endCause?: WorldEndCause | null;
  closeCode?: number | null;
  /** OBS.dm-stall-diagnostics — the connection's state when a silent / closed session ended. */
  net?: WorldNetDiagnostics;
}

export interface WorldLeftEvent {
  outcome: 'world_left';
  era: string;
  server: string | null;
  trace: string;
  build: string;
  exit: Exclude<WorldExit, 'hidden' | 'still_in'>;
  sessionMs: number;
  contextLost: boolean;
  errors: number;
  /** Exit 'disconnected': what ended the session, and the socket's close code. */
  endCause?: WorldEndCause | null;
  closeCode?: number | null;
  /** How long the page had been hidden when the session ended; null when it was visible. */
  hiddenMs?: number | null;
  /**
   * Page-lifecycle freezes (document 'freeze') during the session, and their total length so far.
   * A freeze still open when the report is built (no 'resume' yet: the tab closed while frozen)
   * counts, up to the report (TELEMETRY.freeze-ending-in-close). Null where the browser has no
   * page-lifecycle events (Firefox, Safari: COMPAT.telemetry-browser-unknowns), so "no freeze" is
   * never claimed where a freeze could not have been seen.
   */
  freezes?: number | null;
  frozenMs?: number | null;
  /**
   * How long before this report the page's 1 s telemetry tick last ran (since the enter when it
   * never ran). Up to ~1 s on a running visible page and ~60 s on a hidden one (Chrome's intensive
   * timer throttling); far more means the page's JavaScript was not running: a page-lifecycle
   * freeze, an OS suspend, or a main thread stalled (TELEMETRY.freeze-ending-in-close).
   */
  lastBeatAgoMs?: number;
  /**
   * How long the session's bridge had been draining (a deploy) with the session not yet handed over,
   * when the session ended; null when it was not draining (session/DrainHandover.ts). A session that
   * never found a safe moment, then closed or was cut, reports its wait here.
   */
  drainWaitMs?: number | null;
  /** OBS.dm-stall-diagnostics — the connection's state when a silent / closed session ended. */
  net?: WorldNetDiagnostics;
}

export type WorldEvent = FirstMinuteEvent | WorldLeftEvent;

/** What main.ts supplies; each is read only when an event is built or once a second. */
export interface WorldReporterSources {
  /** How long the session's bridge has been draining without a handover, or null (DrainHandover.drainingForMs). */
  drainWaitMs?: () => number | null;
  screen?: () => WorldScreen;
  modal?: () => WorldModal | null;
  unresolvedMisses?: () => number | null;
  /** Total error reports the page has made (ErrorReporter.reportCount). */
  errors?: () => number;
  /** The player's movement input is active (CameraController.isMoving); polled per frame. */
  moving?: () => boolean;
  canvas?: () => { width: number; height: number } | null;
  dpr?: () => number;
  hidden?: () => boolean;
  /** Dynamic resolution's scale, 0..1 (1 = full; DynamicResolution.scale). */
  renderScale?: () => number;
  /** The world context has no MSAA (RenderScale.contextAntialias false). */
  msaaOff?: () => boolean;
  /** Adaptive draw-distance steps (DynamicResolution.distanceSteps). */
  drawDistanceSteps?: () => number;
  /** The last rendered frame's draw calls and triangles (three.js renderer.info.render). */
  drawStats?: () => { calls: number; triangles: number } | null;
  /** The player's landblock, 0xXXYY, or null. */
  landblock?: () => number | null;
  /** WebGL programs created so far, a running total (MainThreadCost ProgramCreationCounter); read per measured frame. */
  programsCreated?: () => number | null;
  /** renderer.info at the event: live programs, geometries, textures. */
  rendererState?: () => { programs: number; geometries: number; textures: number } | null;
  /** Object3Ds under the world scene (counted once, at the event). */
  sceneObjects?: () => number | null;
  /** Live server objects (ServerObjectManager), at the event. */
  serverObjects?: () => number | null;
}

/** A HandlerMeter as the reporter reads it (MainThreadCost). */
export interface HandlerCostMeter {
  readonly totalMs: number;
  readonly longestMs: number;
  readonly longestOp: string | null;
  reset(): void;
}

/** phaseMs keeps the largest this many phases. */
export const MAX_PHASE_KEYS = 10;
/** A per-frame phase mean above this is not a frame phase (the bridge's bound too). */
export const MAX_PHASE_MS = 5000;

export const BROWSER_FAMILIES = ['chrome', 'edge', 'firefox', 'safari', 'opera', 'other'] as const;
export type BrowserFamily = typeof BROWSER_FAMILIES[number];
export const OS_FAMILIES = ['windows', 'mac', 'linux', 'chromeos', 'android', 'ios', 'other'] as const;
export type OsFamily = typeof OS_FAMILIES[number];

/** Browser and OS family + major version from a user-agent string (closed sets; the string itself is never sent). */
export function browserOf(ua: string | null | undefined): { browser: BrowserFamily; browserMajor: number | null; os: OsFamily } {
  const u = ua ?? '';
  const ver = (re: RegExp): number | null => { const m = re.exec(u); const n = m ? parseInt(m[1], 10) : NaN; return Number.isFinite(n) && n >= 0 && n < 1000 ? n : null; };
  let browser: BrowserFamily = 'other';
  let browserMajor: number | null = null;
  if (/Edg\//.test(u)) { browser = 'edge'; browserMajor = ver(/Edg\/(\d+)/); }
  else if (/OPR\//.test(u)) { browser = 'opera'; browserMajor = ver(/OPR\/(\d+)/); }
  else if (/Firefox\//.test(u)) { browser = 'firefox'; browserMajor = ver(/Firefox\/(\d+)/); }
  else if (/Chrome\/|CriOS\//.test(u)) { browser = 'chrome'; browserMajor = ver(/(?:Chrome|CriOS)\/(\d+)/); }
  else if (/Safari\//.test(u)) { browser = 'safari'; browserMajor = ver(/Version\/(\d+)/); }
  const os: OsFamily = /Windows/.test(u) ? 'windows'
    : /iPhone|iPad|iPod/.test(u) ? 'ios'
    : /Android/.test(u) ? 'android'
    : /CrOS/.test(u) ? 'chromeos'
    : /Mac OS X|Macintosh/.test(u) ? 'mac'
    : /Linux/.test(u) ? 'linux' : 'other';
  return { browser, browserMajor, os };
}

/** A WebGL renderer string as sent: printable ASCII, at most 96 characters (null when hidden or empty). */
export function gpuNameOf(renderer: string | null | undefined): string | null {
  const t = (renderer ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 96);
  return t || null;
}

/** navigator.deviceMemory's values (GiB); anything else reads as unknown. */
const MEM_GB = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;

export interface WorldReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  now?: () => number;
  /** As PreworldReporterOptions.send: a rejected promise keeps the event to go again. */
  send?: TelemetrySend;
}

/**
 * The GPU class of an UNMASKED_RENDERER_WEBGL string (ANGLE wraps it:
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 …)"). Apple silicon and
 * AMD APUs ("AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics") are
 * integrated; Radeon RX / Pro and Intel Arc are discrete.
 */
export function classifyGpu(renderer: string | null | undefined): GpuClass {
  const r = (renderer ?? '').toLowerCase();
  if (!r) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(r)) return 'software';
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/.test(r)) return 'discrete';
  if (/intel.*\barc\b|\barc a\d/.test(r)) return 'discrete';
  if (/radeon\s*(\(tm\)\s*)?(rx|pro|r9|r7|vii|hd \d{4})/.test(r)) return 'discrete';
  if (/intel|iris|uhd graphics|hd graphics|apple|\bm\d\b|mali|adreno|powervr|videocore|radeon.*graphics|vega \d+/.test(r)) return 'integrated';
  if (/radeon|amd/.test(r)) return 'discrete';
  return 'unknown';
}

/** WebGL RENDERER strings that name the browser, not the GPU (the masked values). */
const MASKED_RENDERERS = new Set(['webkit webgl', 'mozilla', 'webkit', 'google inc.', '']);
/** gl.RENDERER (0x1F01). */
const GL_RENDERER = 0x1f01;

/**
 * The unmasked renderer string of a WebGL context (null when the browser hides it).
 * COMPAT.telemetry-browser-unknowns — gl.RENDERER first: Firefox (110+) already returns the
 * sanitized GPU name there ("Radeon R9 200 Series, or similar") and logs a deprecation warning
 * for every WEBGL_debug_renderer_info request, so the extension is asked only when RENDERER is
 * the masked browser name (Chrome, Safari: "WebKit WebGL").
 */
export function unmaskedRenderer(gl: { getExtension(name: string): unknown; getParameter(p: number): unknown } | null | undefined): string | null {
  try {
    if (!gl) return null;
    const plain = gl.getParameter(GL_RENDERER);
    if (typeof plain === 'string' && !MASKED_RENDERERS.has(plain.trim().toLowerCase())) return plain;
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const v = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

/** The `q` quantile (0..1) of a 1 ms histogram holding `n` samples. */
function histQuantile(hist: Uint32Array, n: number, q: number): number | null {
  if (n === 0) return null;
  const rank = Math.max(1, Math.ceil(q * n));
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= rank) return i;
  }
  return hist.length - 1;
}

/** A scale 0..1 as a whole percent (1..100); anything unusable reads as full. */
function scalePct(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.min(100, Math.max(1, Math.round(v * 100))) : 100;
}

/** 0xXXYY as 4 hex digits; anything else null. */
function landblockHex(v: number | null): string | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff ? v.toString(16).padStart(4, '0') : null;
}

/** A first-minute total in ms is at most this (the bridge's bound: 60 s with slack for a late tick). */
const MINUTE_CAP_MS = 120_000;

/** The draw-distance ladder has six entries: at most five steps down. */
export const MAX_DRAW_DISTANCE_STEPS = 5;

/** A drop's endCause (closed set) and close code (a WebSocket code, 1000–4999). */
function dropFields(drop: WorldDropDetail | undefined): { endCause: WorldEndCause | null; closeCode: number | null; net?: WorldNetDiagnostics } {
  const cause = drop?.endCause;
  const code = drop?.closeCode;
  const endCause = (WORLD_END_CAUSES as readonly string[]).includes(cause ?? '') ? cause as WorldEndCause : null;
  const net = endCause !== null && NET_DIAG_END_CAUSES.includes(endCause) ? boundNetDiagnostics(drop?.net) : null;
  return {
    endCause,
    closeCode: typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null,
    ...(net ? { net } : {}),
  };
}

/** A count as sent: a whole number 0..max (clamped), else null. */
function count(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : null;
}

/** A session-length field's cap (the bridge's SESSION_MS: 7 days). */
const SESSION_CAP_MS = 7 * 24 * 3600_000;

function safe<T>(f: (() => T) | undefined, fallback: T): T {
  if (!f) return fallback;
  try { return f(); } catch { return fallback; }
}

export class WorldReporter {
  private readonly now: () => number;
  private readonly outbox: TelemetryOutbox;
  private src: WorldReporterSources = {};
  private sent = 0;
  private gpu: GpuClass = 'unknown';

  // ── The current world session (null enterAt = not in the world) ──
  private enterAt: number | null = null;
  private resumed = false;
  private startedHidden = false;
  /** The first-minute event went out for this session. */
  private minuteSent = false;
  private errorsAtEnter = 0;
  private contextLost = false;
  private frames = 0;
  private worldFrames = 0;
  private lastFrameAt: number | null = null;
  private readonly hist = new Uint32Array(HIST_MAX_MS + 1);
  private intervals = 0;
  private intervalSum = 0;
  private maxFrame = 0;
  private readonly workHist = new Uint32Array(HIST_MAX_MS + 1);
  private works = 0;
  private drawCallSum = 0;
  private triangleSum = 0;
  private drawSamples = 0;
  /** Long-task ms in this session's first minute (null: no longtask timing in this browser). */
  private longTaskMs: number | null = null;
  private longTasksSupported = false;
  private longTaskMax = 0;
  /** Phase sums over the measured frames (FRAME_PHASES order). */
  private readonly phaseSum = new Float64Array(FRAME_PHASES.length);
  private phaseFrames = 0;
  private compileSum = 0;
  /** The program-creation total at the session's start and at the last measured frame (null: no source). */
  private programsAtEnter: number | null = null;
  private programsLast: number | null = null;
  private meters: { net: HandlerCostMeter; stream: HandlerCostMeter } | null = null;
  private device: Pick<FirstMinuteEvent, 'browser' | 'browserMajor' | 'os' | 'cores' | 'memGb'> = {};
  private gpuName: string | null = null;
  private worldDrawnAt: number | null = null;
  private firstMoveAt: number | null = null;
  private firstClickAt: number | null = null;
  private keys = 0;
  private modal: WorldModal | null = null;
  private modalSince = 0;
  /** When the page last went hidden (null while visible); page-wide, not per session. */
  private hiddenSince: number | null = null;
  /** Page-lifecycle freezes this session ('freeze' → 'resume'). */
  private freezes = 0;
  private frozenMs = 0;
  /**
   * COMPAT.telemetry-browser-unknowns — false once install() finds no document 'freeze' event
   * (only Chromium has the Page Lifecycle API; https://caniuse.com/mdn-api_document_freeze_event).
   */
  private freezeEventsSupported = true;
  private frozenAt: number | null = null;
  /** The last 1 s tick this session (the enter until one runs): when the page's JavaScript last ran on its own. */
  private lastBeatAt = 0;

  constructor(private readonly opts: WorldReporterOptions) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, this.now, true);
  }

  /** Events the network refused, waiting to go again (TelemetryOutbox). */
  get pendingSends(): number { return this.outbox.pending; }

  /** main.ts's state readers (set once the game objects exist). */
  setSources(src: WorldReporterSources): void {
    this.src = { ...this.src, ...src };
  }

  /** The server-message and streamed-DAT handler meters (MainThreadCost); reset at each world entry. */
  setHandlerMeters(net: HandlerCostMeter, stream: HandlerCostMeter): void {
    this.meters = { net, stream };
  }

  /** The renderer's GPU class (classifyGpu of the unmasked string, read once at renderer init). */
  setGpu(gpu: GpuClass, rendererName?: string | null): void {
    this.gpu = (GPU_CLASSES as readonly string[]).includes(gpu) ? gpu : 'unknown';
    if (rendererName !== undefined) this.gpuName = gpuNameOf(rendererName);
  }

  /** The device: navigator's user agent, cores and memory (read once at install). */
  setDevice(nav: { userAgent?: string; hardwareConcurrency?: number; deviceMemory?: number } | null | undefined): void {
    const cores = nav?.hardwareConcurrency;
    const mem = nav?.deviceMemory;
    this.device = {
      ...browserOf(nav?.userAgent),
      cores: typeof cores === 'number' && Number.isInteger(cores) && cores > 0 && cores <= 256 ? cores : null,
      memGb: typeof mem === 'number' && (MEM_GB as readonly number[]).includes(mem) ? mem : null,
    };
  }

  /** A main-thread long task finished (PerformanceObserver 'longtask'); counted inside the first minute only. */
  longTask(durationMs: number): void {
    if (this.enterAt === null || this.minuteSent || !(durationMs > 0)) return;
    this.longTaskMs = (this.longTaskMs ?? 0) + durationMs;
    if (durationMs > this.longTaskMax) this.longTaskMax = durationMs;
  }

  get inWorld(): boolean { return this.enterAt !== null; }

  /** OBS.automation-usage — told when a world session starts and ends (every exit), as AutomationReporter is. */
  private readonly starts: Array<() => void> = [];
  private readonly ends: Array<(exit: 'closed_tab' | 'logout' | 'disconnected') => void> = [];
  onSessionStart(f: () => void): void { this.starts.push(f); }
  onSessionEnd(f: (exit: 'closed_tab' | 'logout' | 'disconnected') => void): void { this.ends.push(f); }

  /** The world is up (gameStarted, beside PreworldReporter.enteredWorld). `resumed`: the auto-resume after a drop. */
  enteredWorld(resumed = false): void {
    if (this.enterAt !== null) this.left('disconnected');
    const at = this.now();
    this.enterAt = at;
    this.resumed = resumed;
    this.startedHidden = safe(this.src.hidden, false);
    if (this.startedHidden && this.hiddenSince === null) this.hiddenSince = at;
    this.freezes = 0;
    this.frozenMs = 0;
    this.lastBeatAt = at;
    this.minuteSent = false;
    this.errorsAtEnter = safe(this.src.errors, 0);
    this.contextLost = false;
    this.frames = 0;
    this.worldFrames = 0;
    this.lastFrameAt = null;
    this.hist.fill(0);
    this.intervals = 0;
    this.intervalSum = 0;
    this.maxFrame = 0;
    this.workHist.fill(0);
    this.works = 0;
    this.drawCallSum = 0;
    this.triangleSum = 0;
    this.drawSamples = 0;
    this.longTaskMs = this.longTasksSupported ? 0 : null;
    this.longTaskMax = 0;
    this.phaseSum.fill(0);
    this.phaseFrames = 0;
    this.compileSum = 0;
    const programs = safe(this.src.programsCreated, null);
    this.programsAtEnter = typeof programs === 'number' && Number.isFinite(programs) ? programs : null;
    this.programsLast = this.programsAtEnter;
    if (this.meters) { this.meters.net.reset(); this.meters.stream.reset(); }
    this.worldDrawnAt = null;
    this.firstMoveAt = null;
    this.firstClickAt = null;
    this.keys = 0;
    this.modal = null;
    this.modalSince = at;
    this.pollModal(at);
    for (const f of this.starts) { try { f(); } catch { /* a listener never breaks the report */ } }
  }

  /**
   * One animation frame (main.ts frameStep with draw). `worldDrawn`: this frame
   * drew the 3D world with no portal space over it. Counters only. `phases`:
   * this frame's ms per FRAME_PHASES phase (MainThreadCost FramePhaseTimer.frameMs).
   */
  frame(now: number, worldDrawn: boolean, workMs?: number, phases?: ArrayLike<number>): void {
    if (this.enterAt === null || this.minuteSent) return;
    this.frames++;
    let created = false;
    if (this.src.programsCreated) {
      const total = safe(this.src.programsCreated, null);
      if (typeof total === 'number' && Number.isFinite(total)) {
        if (this.programsLast === null) { this.programsLast = total; this.programsAtEnter ??= total; }
        created = total > this.programsLast;
        this.programsLast = total;
      }
    }
    if (phases && phases.length === FRAME_PHASES.length) {
      for (let i = 0; i < FRAME_PHASES.length; i++) {
        const v = phases[i];
        if (v > 0 && Number.isFinite(v)) this.phaseSum[i] += v;
      }
      this.phaseFrames++;
      if (created) this.compileSum += Math.max(0, phases[PHASE.render] || 0) + Math.max(0, phases[PHASE.warmup] || 0);
    }
    if (workMs !== undefined && workMs >= 0 && Number.isFinite(workMs)) {
      this.workHist[workMs >= HIST_MAX_MS ? HIST_MAX_MS : Math.floor(workMs)]++;
      this.works++;
    }
    if (worldDrawn) {
      const d = safe(this.src.drawStats, null);
      if (d && d.calls >= 0 && d.triangles >= 0) { this.drawCallSum += d.calls; this.triangleSum += d.triangles; this.drawSamples++; }
    }
    if (this.lastFrameAt !== null) {
      const dt = now - this.lastFrameAt;
      if (dt >= 0 && dt < STALL_MS) {
        this.hist[dt >= HIST_MAX_MS ? HIST_MAX_MS : Math.floor(dt)]++;
        this.intervals++;
        this.intervalSum += dt;
        if (dt > this.maxFrame) this.maxFrame = dt;
      }
    }
    this.lastFrameAt = now;
    if (worldDrawn) {
      this.worldFrames++;
      if (this.worldDrawnAt === null) this.worldDrawnAt = now;
    }
    if (this.firstMoveAt === null && this.src.moving) {
      let moving = false;
      try { moving = this.src.moving(); } catch { /* no movement */ }
      if (moving) this.firstMoveAt = now;
    }
  }

  /** A press on the world canvas (select / use / mouse-look). */
  worldClick(): void {
    if (this.enterAt !== null && !this.minuteSent && this.firstClickAt === null) this.firstClickAt = this.now();
  }

  /** A key went down (not a repeat). Counted only; the key itself is never read. */
  keyDown(): void {
    if (this.enterAt !== null && !this.minuteSent) this.keys++;
  }

  /** The WebGL context was lost. */
  contextLostNow(): void {
    if (this.enterAt !== null) this.contextLost = true;
  }

  /** The 1 s tick: the blocking window's open time, and the 60 s mark. */
  tick(): void {
    this.outbox.retry();
    if (this.enterAt === null) return;
    const at = this.now();
    this.lastBeatAt = at;
    this.pollModal(at);
    if (!this.minuteSent && at - this.enterAt >= FIRST_MINUTE_MS) this.sendFirstMinute('still_in', at);
  }

  /** The page went to the background: the first minute ends there (the session goes on). */
  hidden(): void {
    if (this.hiddenSince === null) this.hiddenSince = this.now();
    if (this.enterAt === null || this.minuteSent) return;
    this.sendFirstMinute('hidden', this.now());
  }

  /** The page is visible again. */
  visible(): void {
    this.hiddenSince = null;
  }

  /** document 'freeze' (Chrome's page lifecycle: the page and its workers stop running). */
  frozen(): void {
    if (this.frozenAt === null) this.frozenAt = this.now();
  }

  /** document 'resume' after a freeze. */
  pageResumed(): void {
    if (this.frozenAt === null) return;
    if (this.enterAt !== null) {
      this.freezes++;
      this.frozenMs += this.openFreezeMs(this.now());
    }
    this.frozenAt = null;
  }

  /** The open freeze's length inside this session up to `at` (0 when none is open). */
  private openFreezeMs(at: number): number {
    if (this.frozenAt === null || this.enterAt === null) return 0;
    return Math.max(0, at - Math.max(this.frozenAt, this.enterAt));
  }

  /**
   * The world session ended (tab closed / logout / drop). Idempotent: only the
   * first call of a session counts. `drop`: the 'disconnected' event's
   * endCause / closeCode (BUG.hidden-tab-session-drop).
   */
  left(exit: 'closed_tab' | 'logout' | 'disconnected', drop?: WorldDropDetail): void {
    if (this.enterAt === null) return;
    const at = this.now();
    const detail = exit === 'disconnected' ? dropFields(drop) : {};
    if (!this.minuteSent) {
      this.sendFirstMinute(exit, at, detail);
    } else {
      this.post({
        outcome: 'world_left', ...this.ids(), exit,
        sessionMs: Math.round(at - this.enterAt),
        contextLost: this.contextLost,
        errors: this.errorsSince(),
        ...detail,
        hiddenMs: this.hiddenSince === null ? null : Math.max(0, Math.round(at - Math.max(this.hiddenSince, this.enterAt))),
        // A freeze still open (the tab closed or the session dropped before 'resume') counts up to
        // now. The session ends here, so a later 'resume' (enterAt null) adds nothing.
        freezes: this.freezeEventsSupported ? this.freezes + (this.frozenAt !== null ? 1 : 0) : null,
        frozenMs: this.freezeEventsSupported ? Math.round(this.frozenMs + this.openFreezeMs(at)) : null,
        lastBeatAgoMs: count(Math.max(0, at - this.lastBeatAt), SESSION_CAP_MS) ?? 0,
        drainWaitMs: count(safe(this.src.drainWaitMs, null), SESSION_CAP_MS),
      });
    }
    this.enterAt = null;
    for (const f of this.ends) { try { f(exit); } catch { /* a listener never breaks the report */ } }
  }

  /** pagehide / visibilitychange (hidden) / the 1 s tick / the canvas's webglcontextlost. */
  install(
    win: Pick<Window, 'addEventListener' | 'setInterval'>,
    doc: Pick<Document, 'addEventListener'> & { visibilityState?: string },
    canvas?: Pick<HTMLCanvasElement, 'addEventListener'> | null,
  ): void {
    // A drop's world_left goes out when the network may be gone: it waits and goes again
    // (online, hidden, leaving, the tick).
    win.addEventListener('pagehide', () => { this.left('closed_tab'); this.outbox.retry(true); });
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') { this.hidden(); this.outbox.retry(true); } else this.visible();
    });
    this.freezeEventsSupported = 'onfreeze' in doc;
    doc.addEventListener('freeze', () => this.frozen());
    doc.addEventListener('resume', () => this.pageResumed());
    doc.addEventListener('keydown', ((e: KeyboardEvent) => { if (!e.repeat) this.keyDown(); }) as EventListener, true);
    canvas?.addEventListener('pointerdown', () => this.worldClick());
    canvas?.addEventListener('webglcontextlost', () => this.contextLostNow());
    this.installLongTasks();
    this.outbox.install(win);
    win.setInterval(() => this.tick(), 1000);
  }

  /** PerformanceObserver 'longtask' (Chromium); elsewhere longTaskMs stays null. */
  private installLongTasks(): void {
    try {
      const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
      if (!PO || !(PO.supportedEntryTypes ?? []).includes('longtask')) return;
      new PO((list) => { for (const e of list.getEntries()) this.longTask(e.duration); }).observe({ entryTypes: ['longtask'] });
      this.longTasksSupported = true;
      if (this.enterAt !== null && !this.minuteSent && this.longTaskMs === null) this.longTaskMs = 0;
    } catch { /* no longtask timing */ }
  }

  // ── Building and sending ─────────────────────────────────────────

  private pollModal(at: number): void {
    const m = safe(this.src.modal, null);
    const kind = m !== null && (WORLD_MODALS as readonly string[]).includes(m) ? m : null;
    if (kind !== this.modal) { this.modal = kind; this.modalSince = at; }
  }

  private errorsSince(): number {
    return Math.max(0, safe(this.src.errors, 0) - this.errorsAtEnter);
  }

  private ids(): Pick<FirstMinuteEvent, 'era' | 'server' | 'trace' | 'build'> {
    return { era: safe(this.opts.era, 'unknown'), server: safe(this.opts.server, null), trace: this.opts.trace, build: this.opts.build };
  }

  private sendFirstMinute(exit: WorldExit, at: number, detail: Pick<FirstMinuteEvent, 'endCause' | 'closeCode' | 'net'> = {}): void {
    const enterAt = this.enterAt!;
    this.minuteSent = true;
    this.pollModal(at);
    const rel = (t: number | null): number | null => (t === null ? null : Math.max(0, Math.round(t - enterAt)));
    const screen = safe(this.src.screen, 'world' as WorldScreen);
    const canvas = safe(this.src.canvas, null);
    const dpr = safe(this.src.dpr, NaN);
    this.post({
      outcome: 'first_minute', ...this.ids(), exit,
      leftAfterMs: exit === 'still_in' ? null : rel(at),
      resumed: this.resumed,
      startedHidden: this.startedHidden,
      frames: this.frames,
      worldFrames: this.worldFrames,
      frameMedianMs: histQuantile(this.hist, this.intervals, 0.5),
      frameP95Ms: histQuantile(this.hist, this.intervals, 0.95),
      frameMaxMs: this.intervals ? Math.round(this.maxFrame) : null,
      contextLost: this.contextLost,
      gpu: this.gpu,
      dpr: Number.isFinite(dpr) && dpr > 0 ? Math.min(8, Math.max(0.25, Math.round(dpr * 4) / 4)) : null,
      canvasW: canvas ? Math.max(0, Math.floor(canvas.width / 100) * 100) : null,
      canvasH: canvas ? Math.max(0, Math.floor(canvas.height / 100) * 100) : null,
      renderScalePct: scalePct(safe(this.src.renderScale, 1)),
      msaaOff: safe(this.src.msaaOff, false) === true,
      drawDistanceSteps: Math.min(MAX_DRAW_DISTANCE_STEPS, Math.max(0, Math.floor(safe(this.src.drawDistanceSteps, 0)) || 0)),
      worldDrawnMs: rel(this.worldDrawnAt),
      screen: (WORLD_SCREENS as readonly string[]).includes(screen) ? screen : 'world',
      unresolvedMisses: safe(this.src.unresolvedMisses, null),
      firstMoveMs: rel(this.firstMoveAt),
      firstClickMs: rel(this.firstClickAt),
      keys: this.keys,
      modal: this.modal,
      modalMs: this.modal !== null ? Math.max(0, Math.round(at - this.modalSince)) : null,
      errors: this.errorsSince(),
      frameMeanMs: this.intervals ? Math.round(this.intervalSum / this.intervals) : null,
      workMedianMs: histQuantile(this.workHist, this.works, 0.5),
      workP95Ms: histQuantile(this.workHist, this.works, 0.95),
      longTaskMs: this.longTaskMs === null ? null : Math.round(this.longTaskMs),
      drawCalls: this.drawSamples ? Math.round(this.drawCallSum / this.drawSamples) : null,
      triangles: this.drawSamples ? Math.round(this.triangleSum / this.drawSamples) : null,
      landblock: landblockHex(safe(this.src.landblock, null)),
      ...this.device,
      gpuName: this.gpuName,
      ...this.costFields(),
      ...detail,
    });
  }

  /** PERF.slow-first-minute-diagnostics, second pass: where the minute's main thread went. */
  private costFields(): Pick<FirstMinuteEvent, 'phaseMs' | 'netHandlerMs' | 'streamHandlerMs' | 'longestHandlerMs' | 'longestHandlerOp'
    | 'longTaskMaxMs' | 'programs' | 'geometries' | 'textures' | 'programsCreated' | 'compileMs' | 'sceneObjects' | 'serverObjects'> {
    let phaseMs: FirstMinuteEvent['phaseMs'] = null;
    if (this.phaseFrames > 0) {
      const means = FRAME_PHASES.map((p, i) => [p, Math.min(MAX_PHASE_MS, Math.round(this.phaseSum[i] / this.phaseFrames * 10) / 10)] as const)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_PHASE_KEYS);
      phaseMs = Object.fromEntries(means);
    }
    const m = this.meters;
    const longest = m ? (m.net.longestMs >= m.stream.longestMs ? m.net : m.stream) : null;
    const longestOp = longest && longest.longestOp !== null && longest.longestMs > 0
      ? opToken(longest === m!.stream ? `s:${longest.longestOp}` : longest.longestOp) : null;
    const rs = safe(this.src.rendererState, null);
    const programsNow = safe(this.src.programsCreated, null);
    return {
      phaseMs,
      netHandlerMs: m ? count(m.net.totalMs, MINUTE_CAP_MS) : null,
      streamHandlerMs: m ? count(m.stream.totalMs, MINUTE_CAP_MS) : null,
      longestHandlerMs: longestOp !== null ? count(longest!.longestMs, MINUTE_CAP_MS) : null,
      longestHandlerOp: longestOp,
      longTaskMaxMs: this.longTaskMs === null ? null : count(this.longTaskMax, MINUTE_CAP_MS),
      programs: count(rs?.programs, 100_000),
      geometries: count(rs?.geometries, 10_000_000),
      textures: count(rs?.textures, 10_000_000),
      programsCreated: this.programsAtEnter !== null && typeof programsNow === 'number' ? count(programsNow - this.programsAtEnter, 1_000_000) : null,
      compileMs: this.phaseFrames > 0 && this.programsAtEnter !== null ? count(this.compileSum, MINUTE_CAP_MS) : null,
      sceneObjects: count(safe(this.src.sceneObjects, null), 10_000_000),
      serverObjects: count(safe(this.src.serverObjects, null), 1_000_000),
    };
  }

  private post(ev: WorldEvent): void {
    if (!this.opts.endpoint || this.sent >= MAX_WORLD_EVENTS) return;
    this.sent++;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
