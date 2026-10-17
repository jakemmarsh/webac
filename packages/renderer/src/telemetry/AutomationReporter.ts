/**
 * OBS.automation-usage — whether players use the in-game automation: the
 * Virindi Views-style plugin bar and its windows (the "preview UI",
 * BRIDGE_PREVIEW_ACCOUNTS) and VirindiTank-style routines (the automation
 * engine and its windows, BRIDGE_AUTOMATION_ACCOUNTS). Routines run in the
 * page and are kept in browser storage, so without this nothing tells us
 * whether anyone runs one.
 *
 * Reported to the bridge on the pre-world route (`POST /client-preworld`;
 * services/ws-tcp-bridge/src/clientAutomation.ts → one `client_automation`
 * line). Its own event kind rather than more world_left fields: these are
 * per page (an offer, a run that spans relogs), sparse (most sessions never
 * open a plugin window, so most world sessions send none), and counted by
 * world on their own line; world events stay one shape per world entry.
 *
 * Events, on state changes only:
 * - automation_offered: the bridge's routines answer (automation / preview UI
 *   on for this account). Once per page per distinct answer.
 * - routine_started / routine_stopped (with a closed reason and the run's
 *   length) / routine_error (the first failed action of a run, a closed
 *   place token). At most MAX_ROUTINE_EVENTS per page: a meta that stops
 *   and restarts all evening can't flood, and the summary still counts it.
 * - automation_summary: when a world session ends (WorldReporter's end of
 *   session, every exit), what the session did: the bar shown / toggled /
 *   clicked, the plugin windows opened (closed id list), runs by driver and
 *   stop reason, total run time, action errors and VirindiTank imports.
 *   Sent only when the session used something.
 *
 * Privacy (the pre-world reporter's rules): closed tokens, counts and
 * durations. No profile, rule, route or loot name, no file name, no chat:
 * a profile is reduced here to its kind (VTank macro / meta / plain rules)
 * and whether it is the shipped example, and an imported file to its
 * extension from a closed list.
 *
 * Eras: one page in all three; the offer comes from the bridge's answer to
 * the routines request, which both connection classes (ClientConnection,
 * era1999/Connection1999) relay. Splitpea's windows exist only in AC1999.
 */
import { EXAMPLE_HUNT_PROFILE, type RoutineProfile } from '@ac/shared';
import { TelemetryOutbox, defaultTelemetrySend, type TelemetrySend } from './TelemetryOutbox.js';

export const AUTOMATION_OUTCOMES = ['automation_offered', 'routine_started', 'routine_stopped', 'routine_error', 'automation_summary'] as const;
export type AutomationOutcome = typeof AUTOMATION_OUTCOMES[number];

/**
 * The plugin windows (GameUI's window keys, and the bar's entry ids): VirindiTank's window, its docked
 * panel and editor and its own small windows; VHS; UtilityBelt and its maps; GoArrow; VCS; Mag-Tools;
 * VirindiReporter / Virindi HUDs' windows; Splitpea (AC1999 only). Anything else counts as 'other'.
 */
export const PLUGIN_WINDOWS = [
  'vtank', 'vtank-panel', 'vtank-editor', 'history', 'remote', 'hotkeys', 'hotkeys-vvs',
  'ub-main', 'ub-dungeon', 'ub-landscape', 'goarrow', 'goarrow-arrow', 'vcs', 'magtools',
  'reporter', 'status-hud', 'status-hud-config', 'virindi-uis', 'splitpea', 'splitpea-edit', 'other',
] as const;
export type PluginWindow = typeof PLUGIN_WINDOWS[number];

/** Who started or stopped a run: the player's own windows and /vt commands, or the agent API (Claude, agent tools). */
export const ROUTINE_DRIVERS = ['player', 'agent'] as const;
export type RoutineDriver = typeof ROUTINE_DRIVERS[number];
/** A profile's kind: VirindiTank's macro (macro: true), a meta (ruleFiring 'once'), or plain rules. */
export const ROUTINE_KINDS = ['macro', 'meta', 'rules'] as const;
export type RoutineKind = typeof ROUTINE_KINDS[number];
/** Why a run ended (RoutineEngine.stop): the player, the agent API, StopMacroOnDeath, its own Stop rule, or another start. */
export const ROUTINE_STOP_REASONS = ['player', 'agent', 'died', 'rule', 'replaced'] as const;
export type RoutineStopReason = typeof ROUTINE_STOP_REASONS[number];
/** Where a run's action failed (RoutineEngine): a rule's actions, Loot this Container, the macro's own steps. */
export const ROUTINE_ERROR_PLACES = ['rule', 'loot', 'macro'] as const;
export type RoutineErrorPlace = typeof ROUTINE_ERROR_PLACES[number];
/** A VirindiTank import: everything carried over, some of it switched off, or nothing read. */
export const IMPORT_OUTCOMES = ['ok', 'partial', 'failed'] as const;
export type ImportOutcome = typeof IMPORT_OUTCOMES[number];
/** The imported files' kinds (by extension), closed. */
export const IMPORT_KINDS = ['met', 'nav', 'utl', 'usd', 'af', 'other'] as const;
export type ImportKind = typeof IMPORT_KINDS[number];
/** How the world session ended (WorldReporter's exits). */
export const AUTOMATION_EXITS = ['closed_tab', 'logout', 'disconnected'] as const;
export type AutomationExit = typeof AUTOMATION_EXITS[number];

/** A page sends at most this many automation events in all. */
export const MAX_AUTOMATION_EVENTS = 30;
/** Of which at most this many routine_started / routine_stopped / routine_error. */
export const MAX_ROUTINE_EVENTS = 12;

/** What RoutineEngine says about a run (its onLifecycle). */
export type RoutineLifecycleEvent =
  | { type: 'start'; profile: RoutineProfile; driver: RoutineDriver }
  | { type: 'stop'; reason: RoutineStopReason }
  | { type: 'error'; where: RoutineErrorPlace };

interface Ids { era: string; server: string | null; trace: string; build: string }

export interface AutomationOfferedEvent extends Ids {
  outcome: 'automation_offered';
  automation: boolean;
  preview: boolean;
}
export interface RoutineStartedEvent extends Ids {
  outcome: 'routine_started';
  kind: RoutineKind;
  driver: RoutineDriver;
  /** The profile walks a route / has loot rules / is the shipped example (EXAMPLE_HUNT_PROFILE). */
  nav: boolean;
  loot: boolean;
  example: boolean;
}
export interface RoutineStoppedEvent extends Ids {
  outcome: 'routine_stopped';
  kind: RoutineKind;
  driver: RoutineDriver;
  reason: RoutineStopReason;
  runMs: number;
  errors: number;
}
export interface RoutineErrorEvent extends Ids {
  outcome: 'routine_error';
  kind: RoutineKind;
  driver: RoutineDriver;
  where: RoutineErrorPlace;
}
export interface AutomationSummaryEvent extends Ids {
  outcome: 'automation_summary';
  exit: AutomationExit;
  sessionMs: number;
  /** The bridge's answer this page (null: never asked, a dev build). */
  offered: boolean | null;
  preview: boolean | null;
  /** The bar was on screen this session; /automation bar toggles; icon clicks. */
  barShown: boolean;
  barToggles: number;
  barClicks: number;
  /** Plugin windows opened this session (closed list, each once). */
  windows: PluginWindow[];
  starts: Record<RoutineDriver, number>;
  stops: Record<RoutineStopReason, number>;
  kinds: RoutineKind[];
  /** Time routines ran this session (a run still going counts up to now), and whether one still was. */
  runMs: number;
  running: boolean;
  errors: number;
  imports: Record<ImportOutcome, number>;
  importKinds: ImportKind[];
}

export type AutomationEvent = AutomationOfferedEvent | RoutineStartedEvent | RoutineStoppedEvent | RoutineErrorEvent | AutomationSummaryEvent;

export interface AutomationReporterOptions {
  endpoint: string | null;
  build: string;
  trace: string;
  era: () => string;
  server: () => string | null;
  now?: () => number;
  send?: TelemetrySend;
}

/** A profile's kind, as the reports name it. */
export function routineKind(p: Pick<RoutineProfile, 'macro' | 'ruleFiring'>): RoutineKind {
  if (p.macro) return 'macro';
  return p.ruleFiring === 'once' ? 'meta' : 'rules';
}

/** A file name's import kind (its extension only). */
export function importKind(fileName: string): ImportKind {
  const ext = /\.([a-z]{2,3})$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return (IMPORT_KINDS as readonly string[]).includes(ext) ? ext as ImportKind : 'other';
}

function pluginWindow(id: string): PluginWindow {
  return (PLUGIN_WINDOWS as readonly string[]).includes(id) ? id as PluginWindow : 'other';
}

function safe<T>(f: () => T, fallback: T): T {
  try { return f(); } catch { return fallback; }
}

const zeroStarts = (): Record<RoutineDriver, number> => ({ player: 0, agent: 0 });
const zeroStops = (): Record<RoutineStopReason, number> => ({ player: 0, agent: 0, died: 0, rule: 0, replaced: 0 });
const zeroImports = (): Record<ImportOutcome, number> => ({ ok: 0, partial: 0, failed: 0 });

export class AutomationReporter {
  private readonly now: () => number;
  private readonly outbox: TelemetryOutbox;
  private sent = 0;
  private routineSent = 0;

  // ── The page: the bridge's answer ──
  private automation: boolean | null = null;
  private preview: boolean | null = null;
  private offeredSent: string | null = null;

  // ── The run going now ──
  private run: { kind: RoutineKind; driver: RoutineDriver; startedAt: number; countedFrom: number; errors: number; errorSent: boolean } | null = null;

  // ── This world session ──
  private enterAt: number | null = null;
  private barShown = false;
  private barToggles = 0;
  private barClicks = 0;
  private windows = new Set<PluginWindow>();
  private starts = zeroStarts();
  private stops = zeroStops();
  private kinds = new Set<RoutineKind>();
  private runMs = 0;
  private errors = 0;
  private imports = zeroImports();
  private importKinds = new Set<ImportKind>();

  constructor(private readonly opts: AutomationReporterOptions) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.outbox = new TelemetryOutbox(opts.send ?? defaultTelemetrySend, this.now, true);
  }

  /** Events the network refused, waiting to go again. */
  get pendingSends(): number { return this.outbox.pending; }

  // ── The bridge's routines answer (main.ts 'automationAccess' then 'previewAccess') ──

  /** The automation UI is (not) offered to this account. */
  automationAccess(on: boolean): void { this.automation = on === true; }

  /** The preview UI (the plugin bar) is (not) offered; the answer is whole: report it if it changed. */
  previewAccess(on: boolean): void {
    this.preview = on === true;
    const automation = this.automation ?? false;
    const key = `${automation}/${this.preview}`;
    if (key === this.offeredSent) return;
    this.offeredSent = key;
    this.post({ outcome: 'automation_offered', ...this.ids(), automation, preview: this.preview });
  }

  // ── The plugin bar and windows (GameUI.pluginUsage) ──

  /** The bar was drawn on screen. */
  barOnScreen(): void { if (this.enterAt !== null) this.barShown = true; }
  /** `/automation bar` showed or hid it. */
  barToggled(): void { if (this.enterAt !== null) this.barToggles++; }
  /** An icon on the bar was clicked; `opening` when it opened its window. */
  barClicked(id: string, opening: boolean): void {
    if (this.enterAt === null) return;
    this.barClicks++;
    if (opening) this.windows.add(pluginWindow(id));
  }
  /** A plugin window opened (from the bar, a chat command or another window). */
  windowOpened(id: string): void { if (this.enterAt !== null) this.windows.add(pluginWindow(id)); }

  /** A VirindiTank import (the editor's Import, the loot editor's File → Open). */
  imported(outcome: ImportOutcome, fileNames: readonly string[]): void {
    if (!(IMPORT_OUTCOMES as readonly string[]).includes(outcome)) return;
    this.imports[outcome]++;
    for (const f of fileNames.slice(0, 16)) this.importKinds.add(importKind(String(f)));
  }

  // ── Runs (RoutineEngine.onLifecycle) ──

  routine(e: RoutineLifecycleEvent): void {
    const at = this.now();
    if (e.type === 'start') {
      const p = e.profile;
      const kind = routineKind(p);
      const driver: RoutineDriver = e.driver === 'player' ? 'player' : 'agent';
      this.run = { kind, driver, startedAt: at, countedFrom: at, errors: 0, errorSent: false };
      this.starts[driver]++;
      this.kinds.add(kind);
      this.postRoutine({
        outcome: 'routine_started', ...this.ids(), kind, driver,
        nav: !!p.navRoute || (p.routes?.length ?? 0) > 0,
        loot: (p.loot?.length ?? 0) > 0 || Object.keys(p.lootSets ?? {}).length > 0,
        example: p.name === EXAMPLE_HUNT_PROFILE.name,
      });
      return;
    }
    const run = this.run;
    if (!run) return;
    if (e.type === 'error') {
      if (!(ROUTINE_ERROR_PLACES as readonly string[]).includes(e.where)) return;
      run.errors++;
      this.errors++;
      if (run.errorSent) return;
      run.errorSent = true;
      this.postRoutine({ outcome: 'routine_error', ...this.ids(), kind: run.kind, driver: run.driver, where: e.where });
      return;
    }
    const reason: RoutineStopReason = (ROUTINE_STOP_REASONS as readonly string[]).includes(e.reason) ? e.reason : 'agent';
    this.run = null;
    this.stops[reason]++;
    this.runMs += Math.max(0, at - run.countedFrom);
    this.postRoutine({
      outcome: 'routine_stopped', ...this.ids(), kind: run.kind, driver: run.driver, reason,
      runMs: Math.max(0, Math.round(at - run.startedAt)), errors: run.errors,
    });
  }

  // ── World sessions (main.ts: beside WorldReporter) ──

  /** The world is up: a new session's counters. A run still going carries on into it. */
  enteredWorld(): void {
    const at = this.now();
    this.enterAt = at;
    this.barShown = false;
    this.barToggles = 0;
    this.barClicks = 0;
    this.windows.clear();
    this.starts = zeroStarts();
    this.stops = zeroStops();
    this.kinds.clear();
    this.runMs = 0;
    this.errors = 0;
    if (this.run) { this.run.countedFrom = at; this.kinds.add(this.run.kind); }
    // Imports made at character select (the editor is open there too) count in the session that follows.
  }

  /** The world session ended (WorldReporter.onSessionEnd): the summary, when the session used anything. */
  worldLeft(exit: AutomationExit): void {
    if (this.enterAt === null) return;
    const at = this.now();
    const enterAt = this.enterAt;
    this.enterAt = null;
    let runMs = this.runMs;
    if (this.run) { runMs += Math.max(0, at - this.run.countedFrom); this.run.countedFrom = at; }
    const importsTotal = this.imports.ok + this.imports.partial + this.imports.failed;
    const used = this.barToggles > 0 || this.barClicks > 0 || this.windows.size > 0 || this.starts.player + this.starts.agent > 0
      || this.run !== null || importsTotal > 0 || runMs > 0;
    if (used) {
      this.post({
        outcome: 'automation_summary', ...this.ids(),
        exit: (AUTOMATION_EXITS as readonly string[]).includes(exit) ? exit : 'disconnected',
        sessionMs: Math.max(0, Math.round(at - enterAt)),
        offered: this.automation, preview: this.preview,
        barShown: this.barShown, barToggles: this.barToggles, barClicks: this.barClicks,
        windows: PLUGIN_WINDOWS.filter((w) => this.windows.has(w)),
        starts: { ...this.starts }, stops: { ...this.stops },
        kinds: ROUTINE_KINDS.filter((k) => this.kinds.has(k)),
        runMs: Math.round(runMs), running: this.run !== null, errors: this.errors,
        imports: { ...this.imports },
        importKinds: IMPORT_KINDS.filter((k) => this.importKinds.has(k)),
      });
    }
    this.imports = zeroImports();
    this.importKinds.clear();
  }

  /** The reporters' 1 s tick: a refused event goes again. */
  tick(): void { this.outbox.retry(); }

  /** online → retry; a hidden or leaving page sends what waits by beacon; the 1 s tick. */
  install(win: Pick<Window, 'addEventListener' | 'setInterval'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    this.outbox.install(win);
    win.setInterval(() => this.tick(), 1000);
    win.addEventListener('pagehide', () => this.outbox.retry(true));
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.outbox.retry(true); });
  }

  // ── Sending ──

  private ids(): Ids {
    return { era: safe(this.opts.era, 'unknown'), server: safe(this.opts.server, null), trace: this.opts.trace, build: this.opts.build };
  }

  private postRoutine(ev: RoutineStartedEvent | RoutineStoppedEvent | RoutineErrorEvent): void {
    if (this.routineSent >= MAX_ROUTINE_EVENTS) return;
    if (this.post(ev)) this.routineSent++;
  }

  private post(ev: AutomationEvent): boolean {
    if (!this.opts.endpoint || this.sent >= MAX_AUTOMATION_EVENTS) return false;
    this.sent++;
    this.outbox.post(this.opts.endpoint, JSON.stringify(ev));
    return true;
  }
}
