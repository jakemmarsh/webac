/**
 * RELEASE.preworld-outcomes — how a player's pre-world flow ended, reported
 * to the bridge (`POST /client-preworld`, services/ws-tcp-bridge/src/
 * clientPreworld.ts → one `client_preworld` log line).
 *
 * Launch night showed sessions that closed seconds after the handshake and
 * visitors who sat on pre-world screens for an hour, with nothing saying
 * whether they were refused, broken or browsing. The page now reports:
 * login refused / connection failed (with the server's own code), the
 * character list (count only), character creation (ok, or the server's
 * CharGenVerificationResponse code), enter-world refused (CharacterError) or
 * entered (time from login), a server drop before the world, and leaving or
 * hiding the page on a pre-world screen (which screen, chargen step, time).
 *
 * RELEASE.preworld-boot-stage: while the screen is still 'boot' (main()
 * before the launcher) every event also says which boot step main() is in,
 * the download's progress (percent and KiB of the bytes announced), the DAT
 * cache verdict (cold / warm / partial / off) and the capability problems
 * found; boot_slow goes out once if boot passes BOOT_SLOW_MS, boot_failed when
 * main() throws.
 *
 * Privacy: only codes, counts, durations and fixed identifiers go out. The
 * payload is built from a closed set of fields here and re-validated field
 * by field on the bridge; no account, password, character name or typed text
 * is ever an input to this module. The page's `trace` id is random per page
 * load and rides on the WebSocket URL, so the bridge's session_open /
 * session_close carry the same id.
 */
import type { ConnectionEvent } from '@ac/network';
import { PASSWORD_MISMATCH_BOOT_REASON } from '../session/AccountBoot.js';
import { CharacterError, CharacterGenerationVerificationResponse, characterCreateErrorToken } from '@ac/shared';

export type PreworldOutcome =
  | 'login_refused' | 'connect_failed' | 'char_list' | 'char_error' | 'chargen_ok' | 'chargen_refused'
  | 'enter_refused' | 'enter_ok' | 'dropped' | 'page_hidden' | 'page_left' | 'page_reload' | 'boot_slow' | 'boot_failed';

export type PreworldScreen =
  | 'boot' | 'server-select' | 'connecting' | 'char-select' | 'chargen' | 'portal-space' | 'disconnected' | 'world';

/**
 * Why the page reloaded itself (page_reload's token): a world of another era
 * was picked on the launcher (switchEraFor), a new build arrived
 * (UpdateWatcher), or the epilogue's Device::Done relaunched. A deliberate
 * reload is never a walk-away, so it sends page_reload instead of page_left.
 */
export const RELOAD_REASONS = ['era_switch', 'update', 'epilogue'] as const;
export type ReloadReason = typeof RELOAD_REASONS[number];

/** What main.ts knows when it names the screen (preworldScreenFor). */
export interface PreworldScreenState {
  gameStarted: boolean;
  /** The Disconnected screen is up. */
  disconnected: boolean;
  /** The launcher (server select) is showing. */
  launcherActive: boolean;
  /** The launcher closed on a world of another era: its DATs are being checked / the reload is under way. */
  eraSwitchPending: boolean;
  /** GameUI's current screen ('character-select' is its default before any list arrives). */
  uiScreen: string | null;
  /** The portal-space tunnel hides the world. */
  portalSpace: boolean;
  /** This session's character list arrived (PreworldReporter.characterListReceived). */
  charListReceived: boolean;
}

/**
 * The pre-world screen the player is actually on. Character select and
 * chargen count only once this session's character list arrived: before
 * that GameUI's screen is its 'character-select' default while the page is
 * still connecting (a wrong password used to read screen="char-select").
 * An era switch leaves from the server select, not char select.
 */
export function preworldScreenFor(s: PreworldScreenState): PreworldScreen {
  if (s.gameStarted) return 'world';
  if (s.disconnected) return 'disconnected';
  if (s.launcherActive || s.eraSwitchPending) return 'server-select';
  if (s.charListReceived) {
    if (s.uiScreen === 'character-create') return 'chargen';
    if (s.uiScreen === 'character-select' && !s.portalSpace) return 'char-select';
  }
  if (s.portalSpace) return 'portal-space';
  return 'connecting';
}

/** The chargen wizard's pages (CharacterCreate.ts CreateStep, in order). */
export const CHARGEN_STEP_NAMES = ['heritage', 'profession', 'skills', 'appearance', 'town', 'summary'] as const;
export type ChargenStepName = typeof CHARGEN_STEP_NAMES[number];

/**
 * RELEASE.preworld-boot-stage — where main() is while the screen is 'boot'
 * (before the launcher), in boot order. A closed list: main.ts sets each one
 * as it reaches that await.
 *  - capability: the browser capability probe.
 *  - capability_prompt: the "Before you continue" screen (soft problems) waits for a click;
 *    a hard problem's screen never resolves.
 *  - era: which era's DATs this load uses (planEraDats: hosted-file probes).
 *  - patch_check: the cache interrogation (HEAD requests; the ranged splash wait).
 *  - patch_download: the streamed set's boot (pointer, boot/local/skeleton packs, pre-world art)
 *    and every whole-DAT load (portal, world portal, cell, language, highres).
 *  - side_tables: the weenie side-table JSON fetches.
 *  - dat_parse: the DAT tables (MasterProperty, StringTables, SpellTable, …).
 *  - renderer_init: the scene, WebGL renderer and keymaps.
 *  - world_init: terrain materials, sky and the world systems' setup.
 *  - bridge_probe: waiting for the bridge health probe (bounded by its timeout).
 *  - ui_init: building the game UI, up to the launcher.
 */
export const BOOT_STAGES = [
  'capability', 'capability_prompt', 'era', 'patch_check', 'patch_download', 'side_tables', 'dat_parse',
  'renderer_init', 'world_init', 'bridge_probe', 'ui_init',
] as const;
export type BootStage = typeof BOOT_STAGES[number];

/**
 * The browser DAT cache's verdict for this boot: warm (nothing came over the
 * network), cold (everything did), partial (some), off (no OPFS storage:
 * every load is cold). Null until the patch knows.
 */
export const BOOT_CACHE_STATES = ['cold', 'warm', 'partial', 'off'] as const;
export type BootCacheState = typeof BOOT_CACHE_STATES[number];

/**
 * The cache verdict from what this boot's loads reported: `fromNetwork` /
 * `fromCache` are any measure (files, bytes) of what each source served; only
 * whether each is zero matters. No OPFS storage is 'off'; nothing known yet is null.
 */
export function bootCacheVerdict(o: { storage: boolean; fromNetwork: number; fromCache: number }): BootCacheState | null {
  if (!o.storage) return 'off';
  const net = o.fromNetwork > 0;
  const cached = o.fromCache > 0;
  if (!net && !cached) return null;
  return net ? (cached ? 'partial' : 'cold') : 'warm';
}

/** Boot/Capability.ts CapabilityProblem ids. */
export const CAPABILITY_ISSUES = ['webgl2', 'websocket', 'memory', 'pointer', 'software_gpu'] as const;
export type CapabilityIssue = typeof CAPABILITY_ISSUES[number];

/** A boot still on screen 'boot' this long after the reporter started sends one boot_slow. */
export const BOOT_SLOW_MS = 20_000;

/** The patch meter's events (ui/PatchScreen.ts PatchEvent), as far as boot progress reads them. */
export type BootPatchEvent = { kind: 'begin'; expected: number } | { kind: 'downloaded'; bytes: number } | { kind: 'end' } | { kind: string };

/** Exactly what goes on the wire: no other field exists. */
export interface PreworldEvent {
  outcome: PreworldOutcome;
  era: string;
  server: string | null;
  trace: string;
  build: string;
  screen: PreworldScreen;
  step: ChargenStepName | null;
  code: number | null;
  table: number | null;
  token: string | null;
  count: number | null;
  pageMs: number;
  screenMs: number;
  /**
   * Since this connect attempt's socket opened and its login request went out
   * (loginStarted). Null when the attempt's socket never opened (a
   * CantSocket): connectAttempt clears the previous session's mark, so a
   * failed reconnect never reports time since an older login.
   */
  sinceLoginMs: number | null;
  sinceEnterMs: number | null;
  /** RELEASE.preworld-boot-stage — set only while the screen is 'boot' (else null). */
  stage: BootStage | null;
  /**
   * Download percent (0–100) over the bytes the patch announced plus what a
   * streamed set added after its Begin (bootPatchGrew); null before any Begin.
   * Equals the meter's percent except while a set's pre-world art loads (the
   * meter, whose Begin never grew, already reads 100 there).
   */
  progress: number | null;
  /** Bytes downloaded / announced (with bootPatchGrew's), in KiB (null before the patch announced a total). */
  doneKB: number | null;
  totalKB: number | null;
  cache: BootCacheState | null;
  /** Capability problems the probe found (null when none). */
  caps: CapabilityIssue[] | null;
}

export interface PreworldReporterOptions {
  /** Full POST URL, or null to report nothing (no bridge configured). */
  endpoint: string | null;
  build: string;
  /** The era id (EraProfile.id). */
  era: () => string;
  /** The launcher world id (Servers.xml id), or null for a custom / local world. */
  server: () => string | null;
  screen: () => PreworldScreen;
  /** The chargen page while the screen is 'chargen'. */
  chargenStep?: () => ChargenStepName | null;
  now?: () => number;
  /** A random id for this page load; generated when absent. */
  trace?: string;
  /** Transport; defaults to navigator.sendBeacon, falling back to fetch keepalive. */
  send?: (url: string, body: string) => void;
}

/** A page sends at most this many events (the bridge also caps each address). */
export const MAX_PREWORLD_EVENTS = 40;

/**
 * Tell `onAttempt` whenever `conn.connect` starts a connect attempt, so every
 * path that connects (each call site in main.ts, and any later one) resets
 * the reporter's per-session state before the attempt can fail. Returns `conn`.
 */
export function reportConnectAttempts<C extends { connect(account: string, password: string): void }>(conn: C, onAttempt: () => void): C {
  const connect = conn.connect.bind(conn);
  conn.connect = (account: string, password: string): void => {
    try { onAttempt(); } catch { /* reporting must never throw */ }
    connect(account, password);
  };
  return conn;
}

const PRE_WORLD = new Set<PreworldScreen>(['boot', 'server-select', 'connecting', 'char-select', 'chargen', 'portal-space', 'disconnected']);

function defaultSend(url: string, body: string): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return;
  } catch { /* fall through */ }
  void fetch(url, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, keepalive: true, mode: 'cors' }).catch(() => {});
}

function randomTrace(): string {
  const bytes = new Uint8Array(8);
  // Every browser that runs the client has Web Crypto; without it the trace
  // only needs to tell this page's lines apart, so the clock serves.
  try { crypto.getRandomValues(bytes); } catch {
    let t = Date.now() * 1000 + Math.floor((typeof performance !== 'undefined' ? performance.now() : 0) * 1000);
    for (let i = 0; i < 8; i++) { bytes[i] = t & 0xff; t = Math.floor(t / 256); }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The reporter's name for a CharacterCreate CreateStep value (null when out of range). */
export function chargenStepName(step: number): ChargenStepName | null {
  return CHARGEN_STEP_NAMES[step] ?? null;
}

/** A code-shaped token (ID_NetError_CantSocket, CharacterError names); anything else is dropped. */
/** Client-side NetErrors that report the server refusing the login (see connectionError). */
const SERVER_REFUSAL_NET_ERRORS: ReadonlySet<string> = new Set([
  'ID_ConnectionError_NetVersionMismatch',
  'ID_ConnectionError_ServerClosedConnection',
]);

function safeToken(t: string | null | undefined): string | null {
  return t && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(t) ? t : null;
}

/**
 * A boot reason (AccountBoot 0xF7DC's String16L) as a closed token: the
 * strings the servers actually send, each its own token, never the text
 * itself (an admin's free-text reason could name anyone).
 *  - ACE AuthenticationHandler.cs:174 (ClassicACE :217) wrong password.
 *  - ACE AuthenticationHandler.cs:114 / CharacterHandler.cs:139, ClassicACE :189 client version.
 *  - ACE / ClassicACE DDDHandler.cs dat_newer_warning_msg / dat_older_warning_msg (defaults
 *    "Your DAT files are newer than expected" / "Your DAT files are incomplete", PropertyManager.cs:677-678).
 *  - ACE PlayerManager.cs:818 world closed; :140 forced log off by system (a second login of an in-world character).
 *  - ACE DeveloperCommands.cs:2470 forced log off by an admin; SentinelCommands.cs:333 boot " - <reason>" (or none).
 *  - ClassicACE AuthenticationHandler.cs:265 VPN / proxy refused.
 *  - GDLE / AC1999 CNetwork::KickClient (Network.cpp): an empty reason (u32 0).
 */
export function bootReasonToken(reason: string | null | undefined): string {
  const r = reason ?? '';
  if (r === '') return 'boot_no_reason';
  if (r === PASSWORD_MISMATCH_BOOT_REASON) return 'boot_password_mismatch';
  if (r.startsWith(' because your client is not the correct version') || r.startsWith(' because you are not running the correct executable file version')) return 'boot_client_version';
  if (r.startsWith(' because ') && r.includes('DAT files are newer')) return 'boot_dat_newer';
  if (r.startsWith(' because ') && r.includes('DAT files are incomplete')) return 'boot_dat_incomplete';
  if (r === ' because the world is now closed') return 'boot_world_closed';
  if (r === ' because the character was forced to log off by system') return 'boot_forced_logoff_system';
  if (r === ' because the character was forced to log off by an admin') return 'boot_forced_logoff_admin';
  if (r.startsWith(' Connections from VPN / proxy disallowed')) return 'boot_vpn_blocked';
  if (r.startsWith(' - ')) return 'boot_admin';
  return 'boot_other';
}

/** The launcher world id in a bridge connect URL (`?server=`), or null. */
export function serverIdFromUrl(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('server');
    return id && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : null;
  } catch { return null; }
}

/** The `server` token for a login through a custom bridge (no ?server= on our bridge to name it). */
export const CUSTOM_BRIDGE_SERVER = 'custom-bridge';

/**
 * The `server` field for a pre-world event: the multi-mode bridge's
 * `?server=<id>`, or `custom-bridge` for a launcher Custom… world (its
 * address is something the player typed, so never logged). A connect_failed
 * with no server at all left a 1999 → custom-bridge failure (2026-10-13)
 * looking like a broken era-switch login to a listed world.
 */
export function preworldServerFor(connectUrl: string, world: { kind: string } | null): string | null {
  return serverIdFromUrl(connectUrl) ?? (world?.kind === 'custom' ? CUSTOM_BRIDGE_SERVER : null);
}

export class PreworldReporter {
  readonly trace: string;
  private readonly now: () => number;
  private readonly send: (url: string, body: string) => void;
  private readonly startedAt: number;
  private sent = 0;
  private loginAt: number | null = null;
  private enterAt: number | null = null;
  private charListSeen = false;
  private screenKey = '';
  private screenSince: number;
  private readonly hiddenOn = new Set<string>();
  private left = false;
  /** The screen when the page began to unload (pageUnloading): every later sample reads it. */
  private unloadSample: { screen: PreworldScreen; step: ChargenStepName | null } | null = null;
  private stage: BootStage = 'capability';
  private patchTotal = -1;
  private patchDone = 0;
  /**
   * Bytes a streamed set added to its own total after its one Begin (the
   * pre-world art, StreamingDats.openStreamingDats): the meter's Begin never
   * carries them, but its Downloaded events do, so the reporter's total adds them.
   */
  private patchGrown = 0;
  private cache: BootCacheState | null = null;
  private caps: CapabilityIssue[] = [];
  private bootSlowSent = false;

  constructor(private readonly opts: PreworldReporterOptions) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.send = opts.send ?? defaultSend;
    this.trace = opts.trace && /^[a-z0-9]{8,32}$/.test(opts.trace) ? opts.trace : randomTrace();
    this.startedAt = this.now();
    this.screenSince = this.startedAt;
  }

  /** The bridge's event URL for a ws(s):// bridge URL (null when it isn't one). */
  static endpointFor(bridgeUrl: string): string | null {
    try {
      const u = new URL(bridgeUrl);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
      return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/client-preworld`;
    } catch { return null; }
  }

  /** `url` with this page's trace id on it, so the bridge's session lines carry it too. */
  tagUrl(url: string): string {
    try {
      const u = new URL(url);
      u.searchParams.set('trace', this.trace);
      return u.toString();
    } catch { return url; }
  }

  // ── Where the page decides an outcome ────────────────────────────────

  /**
   * A new connect attempt begins (NetConnection.connect: the page load, the
   * launcher's ENTER after the World box, the Disconnected screen's relaunch,
   * the auto-resume). The previous session's state goes: its character list
   * no longer makes the screen char select, and its login / enter marks no
   * longer time this attempt. loginStarted alone cannot do this, because a
   * socket that never opens never fires 'connected'.
   */
  connectAttempt(): void {
    this.loginAt = null;
    this.charListSeen = false;
    this.enterAt = null;
  }

  /** The bridge socket opened and the login request is going out (both eras' 'connected'). */
  loginStarted(): void {
    this.loginAt = this.now();
    this.charListSeen = false;
    this.enterAt = null;
  }

  /** This session's character list arrived (reset by connectAttempt / loginStarted): char select / chargen are real screens. */
  get characterListReceived(): boolean {
    return this.charListSeen;
  }

  /** The server's character list arrived: the login is accepted. */
  characterList(count: number): void {
    this.charListSeen = true;
    this.report('char_list', { count: Math.max(0, Math.min(1000, Math.trunc(count))) });
  }

  /** A CharacterGenerationVerificationResponse: Ok, or the refusal code with its string-table token (ID_Character_Err_*). */
  chargenResult(responseCode: number): void {
    if (responseCode === CharacterGenerationVerificationResponse.Ok) this.report('chargen_ok', { code: responseCode });
    else this.report('chargen_refused', { code: responseCode >>> 0, token: safeToken(characterCreateErrorToken(responseCode)) });
  }

  /** CharacterEnterWorldRequest went out (character select, or straight after creation). */
  enterRequested(): void {
    this.enterAt = this.now();
  }

  /** The world is up (gameStarted). */
  enteredWorld(): void {
    const at = this.now();
    this.report('enter_ok', {
      sinceEnterMs: this.enterAt !== null ? Math.round(at - this.enterAt) : null,
    });
    this.enterAt = null;
  }

  /**
   * A connection 'error' the page acts on (after its own retry filters):
   * a CharacterError (both eras), a server NetError (GDLE / AC1999 refusal)
   * or a client-side NetError (socket, login timeout, version). `token` is
   * the notice token the page shows for it.
   */
  connectionError(event: Pick<ConnectionEvent, 'characterError' | 'serverNetError' | 'netErrorId'>, token: string | null = null): void {
    if (event.characterError !== undefined) {
      const code = event.characterError >>> 0;
      const name = safeToken(token) ?? safeToken(CharacterError[code]);
      if (this.enterAt !== null) {
        this.enterAt = null;
        this.report('enter_refused', { code, token: name });
      } else if (!this.charListSeen) {
        this.report('login_refused', { code, token: name });
      } else {
        this.report('char_error', { code, token: name });
      }
      return;
    }
    if (event.serverNetError) {
      this.report('login_refused', {
        code: event.serverNetError.stringId >>> 0, table: event.serverNetError.tableId >>> 0, token: safeToken(token),
      });
      return;
    }
    // The AC1999 server's version-reject grant, and its grant followed by silence (a session it dropped
    // at once, e.g. a banned account: ID_ConnectionError_ServerClosedConnection), are the server saying
    // no; the rest are the client giving up (no socket: ID_NetError_CantSocket; no answer:
    // ID_ConnectionError_ClientTimedOutServer).
    if (event.netErrorId) {
      this.report(SERVER_REFUSAL_NET_ERRORS.has(event.netErrorId) ? 'login_refused' : 'connect_failed', { token: safeToken(event.netErrorId) });
    }
  }

  /**
   * AccountBoot (0xF7DC) before the world: ACE's wrong-password refusal, a
   * version / DAT refusal, a duplicate login. Classified by phase like a
   * CharacterError; the reason goes out only as bootReasonToken's code.
   */
  accountBoot(reason: string | null | undefined): void {
    const token = bootReasonToken(reason);
    if (this.enterAt !== null) {
      this.enterAt = null;
      this.report('enter_refused', { token });
    } else {
      this.report(this.charListSeen ? 'char_error' : 'login_refused', { token });
    }
  }

  /** AccountBanned (0xF7C1): always a refused login; code = the ban's seconds to expiry as sent (0 / negative = permanent). */
  accountBanned(secondsUntilExpiry: number): void {
    this.report('login_refused', { token: 'boot_banned', code: Number.isFinite(secondsUntilExpiry) ? secondsUntilExpiry >>> 0 : null });
  }

  /** The server ended the session before the world (the Disconnected screen). */
  dropped(code: number | null = null, token: string | null = null): void {
    this.report('dropped', { code, token: safeToken(token) });
  }

  // ── Boot (RELEASE.preworld-boot-stage) ───────────────────────────────

  /** main() reached this boot step. */
  bootStage(stage: BootStage): void {
    if ((BOOT_STAGES as readonly string[]).includes(stage)) this.stage = stage;
  }

  /** The capability probe's problem ids (closed list; anything else is dropped). */
  capabilityIssues(ids: readonly string[]): void {
    this.caps = CAPABILITY_ISSUES.filter((id) => ids.includes(id));
  }

  /** A patch meter event, before the connect gate holds it: begin = total bytes, downloaded = bytes, end = all done. */
  bootPatchEvent(event: BootPatchEvent): void {
    if (event.kind === 'begin' && 'expected' in event) {
      this.patchTotal = Math.max(0, Math.trunc(event.expected));
    } else if (event.kind === 'downloaded' && 'bytes' in event) {
      this.patchDone += Math.max(0, Math.trunc(event.bytes));
    } else if (event.kind === 'end') {
      if (this.patchTotal < 0) this.patchTotal = 0;
      this.patchDone = Math.max(this.patchDone, this.patchTotal + this.patchGrown);
    }
  }

  /**
   * A streamed set's byte total grew after its Begin (StreamedPatchFeed's
   * `grew`): the extra bytes join the announced total, so done and total
   * describe the same download. Every Begin re-announces only the meter's
   * running total, which never includes these, so they stay added on top.
   */
  bootPatchGrew(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) this.patchGrown += Math.trunc(bytes);
  }

  /** The DAT cache's verdict (a later call replaces an earlier one). */
  bootCache(state: BootCacheState | null): void {
    this.cache = state !== null && (BOOT_CACHE_STATES as readonly string[]).includes(state) ? state : null;
  }

  /** The boot's state right now: what boot events carry. */
  bootSnapshot(): Pick<PreworldEvent, 'stage' | 'progress' | 'doneKB' | 'totalKB' | 'cache' | 'caps'> {
    const total = this.patchTotal < 0 ? -1 : this.patchTotal + this.patchGrown;
    return {
      stage: this.stage,
      progress: total < 0 ? null : total === 0 ? 100 : Math.min(100, Math.trunc((this.patchDone * 100) / total)),
      doneKB: total < 0 ? null : Math.trunc(this.patchDone / 1024),
      totalKB: total < 0 ? null : Math.trunc(total / 1024),
      cache: this.cache,
      caps: this.caps.length ? [...this.caps] : null,
    };
  }

  /** main() failed (its catch): the stage it was in, and the error's class name only. */
  bootFailed(errorName: string | null = null): void {
    this.report('boot_failed', { token: safeToken(errorName) });
  }

  /**
   * The 1 s tick: re-sample the screen, and once the page has sat on 'boot'
   * BOOT_SLOW_MS send one boot_slow (so a visitor who waits it out is heard too).
   */
  tick(): void {
    const { screen } = this.sample();
    if (this.bootSlowSent || this.left || screen !== 'boot') return;
    if (this.now() - this.startedAt < BOOT_SLOW_MS) return;
    this.bootSlowSent = true;
    this.report('boot_slow', {});
  }

  // ── Leaving ──────────────────────────────────────────────────────────

  /** Re-read the screen; resets the time-on-screen clock when it changed. Cheap; call often. */
  sample(): { screen: PreworldScreen; step: ChargenStepName | null } {
    if (this.unloadSample) return { ...this.unloadSample };
    let screen: PreworldScreen = 'boot';
    let step: ChargenStepName | null = null;
    try { screen = this.opts.screen(); } catch { /* keep boot */ }
    if (screen === 'chargen') {
      try { step = this.opts.chargenStep?.() ?? null; } catch { step = null; }
    }
    const key = screen;
    if (key !== this.screenKey) { this.screenKey = key; this.screenSince = this.now(); }
    return { screen, step };
  }

  /** The tab went to the background on a pre-world screen (once per screen + step). */
  pageHidden(): void {
    const { screen, step } = this.sample();
    if (!PRE_WORLD.has(screen) || this.left) return;
    const key = `${screen}|${step ?? ''}`;
    if (this.hiddenOn.has(key)) return;
    this.hiddenOn.add(key);
    this.report('page_hidden', {});
  }

  /** The page is going away (pagehide) on a pre-world screen. Once. */
  pageLeft(): void {
    if (this.left) return;
    const { screen } = this.sample();
    if (!PRE_WORLD.has(screen)) return;
    this.left = true;
    this.report('page_left', {});
  }

  /**
   * The page began to unload (beforeunload), called BEFORE the unload path
   * logs the character off (session/PlayerModuleSave.ts
   * installUnloadSessionClose). That logoff tears the world down
   * (gameStarted false, the session gone), so a screen read afterwards says
   * 'connecting' and every in-world tab close used to report a pre-world
   * page_left (production, build aaa40225). The screen is fixed here, as the
   * player left it: from the world nothing more is reported (no page_left,
   * no page_hidden); from a pre-world screen the pagehide that follows
   * reports that screen.
   */
  pageUnloading(): void {
    if (this.unloadSample) return;
    const s = this.sample();
    this.unloadSample = s;
    if (!PRE_WORLD.has(s.screen)) this.left = true;
  }

  /**
   * The page is about to reload itself on purpose (an era switch, a new
   * build, the epilogue's relaunch): one page_reload with the reason as its
   * token (on a pre-world screen), and the pagehide / hide that follow are
   * not reported as the player leaving.
   */
  leavingForReload(reason: ReloadReason): void {
    if (this.left) return;
    this.left = true;
    const { screen } = this.sample();
    if (!PRE_WORLD.has(screen) || !(RELOAD_REASONS as readonly string[]).includes(reason)) return;
    this.report('page_reload', { token: reason });
  }

  /**
   * pagehide → page_left, visibilitychange (hidden) → page_hidden, and a 1 s
   * tick: a screen sample so time-on-screen is measured from when the screen
   * showed, and the boot_slow check.
   */
  install(win: Pick<Window, 'addEventListener' | 'setInterval'>, doc: Pick<Document, 'addEventListener'> & { visibilityState?: string }): void {
    win.addEventListener('pagehide', () => this.pageLeft());
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') this.pageHidden(); });
    win.setInterval(() => { this.tick(); }, 1000);
  }

  // ── Transport ────────────────────────────────────────────────────────

  private report(outcome: PreworldOutcome, f: Partial<Pick<PreworldEvent, 'code' | 'table' | 'token' | 'count' | 'sinceEnterMs'>>): void {
    if (!this.opts.endpoint || this.sent >= MAX_PREWORLD_EVENTS) return;
    const { screen, step } = this.sample();
    const at = this.now();
    let era = 'unknown';
    let server: string | null = null;
    try { era = this.opts.era(); } catch { /* unknown */ }
    try { server = this.opts.server(); } catch { /* null */ }
    const body: PreworldEvent = {
      outcome,
      era,
      server,
      trace: this.trace,
      build: this.opts.build,
      screen,
      step,
      code: f.code ?? null,
      table: f.table ?? null,
      token: f.token ?? null,
      count: f.count ?? null,
      pageMs: Math.round(at - this.startedAt),
      screenMs: Math.round(at - this.screenSince),
      sinceLoginMs: this.loginAt !== null ? Math.round(at - this.loginAt) : null,
      sinceEnterMs: f.sinceEnterMs ?? null,
      ...(screen === 'boot' ? this.bootSnapshot()
        : { stage: null, progress: null, doneKB: null, totalKB: null, cache: null, caps: null }),
    };
    this.sent++;
    try { this.send(this.opts.endpoint, JSON.stringify(body)); } catch { /* reporting must never throw */ }
  }
}
