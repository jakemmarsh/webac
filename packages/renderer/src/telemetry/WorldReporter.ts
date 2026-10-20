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
/** The frame-time histogram: 1 ms bins 0..HIST_MAX_MS-1, the last bin holds everything longer. */
export const HIST_MAX_MS = 250;
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
   * p95 histogram stops at HIST_MAX_MS).
   */
  frameMeanMs?: number | null;
  /** Our own JS per frame (frameStep: update + render submit), 1 ms histogram capped at HIST_MAX_MS. */
  workMedianMs?: number | null;
  workP95Ms?: number | null;
  /** Main-thread long tasks (> 50 ms) in the minute, total ms; null where the browser has no longtask timing. */
  longTaskMs?: number | null;
  /** Per drawn world frame, means: renderer draw calls and triangles (three.js renderer.info: the whole frame outdoors, the last pass of an indoor view). */
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
  /** Page-lifecycle freezes (document 'freeze') during the session, and their total length so far. */
  freezes?: number;
  frozenMs?: number;
  /** OBS.dm-stall-diagnostics — the connection's state when a silent / closed session ended. */
  net?: WorldNetDiagnostics;
}

export type WorldEvent = FirstMinuteEvent | WorldLeftEvent;

/** What main.ts supplies; each is read only when an event is built or once a second. */
export interface WorldReporterSources {
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
}

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

/** The unmasked renderer string of a WebGL context (null when the browser hides it). */
export function unmaskedRenderer(gl: { getExtension(name: string): unknown; getParameter(p: number): unknown } | null | undefined): string | null {
  try {
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const v = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    return typeof v === 'string' ? v : null;
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
  private frozenAt: number | null = null;

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
   * drew the 3D world with no portal space over it. Counters only.
   */
  frame(now: number, worldDrawn: boolean, workMs?: number): void {
    if (this.enterAt === null || this.minuteSent) return;
    this.frames++;
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
      this.frozenMs += Math.max(0, this.now() - Math.max(this.frozenAt, this.enterAt));
    }
    this.frozenAt = null;
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
        freezes: this.freezes,
        frozenMs: Math.round(this.frozenMs),
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
      ...detail,
    });
  }

  private post(ev: WorldEvent): void {
    if (!this.opts.endpoint || this.sent >= MAX_WORLD_EVENTS) return;
    this.sent++;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
  }
}
