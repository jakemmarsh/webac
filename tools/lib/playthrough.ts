/**
 * The "first hour" play-through (tools/ac1999-playthrough.ts, TOOL.ac1999-playthrough): the steps a new
 * player takes in their first hour, each followed by a health check of the client, and the report.
 *
 * Everything here is browser-free: it drives a {@link PlaythroughDriver}, which the tool implements with
 * Playwright and the in-page agent API (window.__acAgent, docs/agent-play.md) and the tests implement with a
 * fake (tests/verify-ac1999-playthrough-tool.ts). A step never fakes a pass: when the world makes it
 * impossible (no vendor near, no caster held, no safe creature) it is skipped and says why.
 *
 * Health after every step (assessHealth): no inventory request still pending (acDebug.inventoryRequest),
 * the busy cursor count back to 0 (acDebug.cursorState().busy), no "one item at a time" line, no refusal
 * the step didn't expect (spew lines, chat lines that read as refusals, client_refusal telemetry), no
 * console error, and the player alive (a death aborts the run).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentItem, AgentObject, AgentResult, AgentSelf, AgentSpell } from '../../packages/renderer/src/agent/types.ts';
import { INVENTORY_KINDS, compassPoint } from '../../packages/renderer/src/agent/format.ts';
import { REFUSAL_TEXT, isNoticeCode, isSpewNotice } from '../../packages/renderer/src/telemetry/RefusalReporter.ts';
import { AC1999_TOWN_ROWS } from '../../packages/renderer/src/agent/towns1999.ts';
import { parseMapCoordsText } from '../../packages/shared/src/mapCoordsText.ts';
import { overlayFiles, rowsOf, sqlFiles } from '../build-monster-tables.ts';

// ── Driver ──────────────────────────────────────────────────────────────────

/** What the client says about itself between steps. */
export interface ClientProbe {
  /** AgentScreen: 'world', 'character-select', 'portal-space', … */
  screen: string;
  /** acDebug.inventoryRequest(): the pending inventory request, or null. */
  inventoryRequest: unknown;
  /** acDebug.cursorState().busy: retail's m_cBusy. */
  busy: number;
  dead: boolean;
  /** Health as a fraction of its max, when in the world. */
  health: number | null;
  character: string | null;
}

/** A client_refusal event the page posted (telemetry/RefusalReporter.ts). */
export interface RefusalSeen {
  source: string; code: string; text: string | null; context: string;
  /** Where the player saw it (RefusalReporter REFUSAL_SINKS): 'spew', 'chat' or 'none' (nothing shown). */
  sink?: string;
  /**
   * A roll-up (the event's `first` false): the reporter posts a refusal once when it first happens on the page and its
   * repeats as one count about a minute later (REFUSAL_ROLLUP_MS), so a roll-up lands in whatever step is running then.
   * The EoR and Dark Majesty runs of 2026-10-23 blamed the give step's repeated "can't be given" on the relog step.
   * Its occurrences were judged where they happened (their spew and chat lines, and the first post): never a problem.
   */
  rollup?: boolean;
}

/** What the page said since the last drain. */
export interface Signals {
  /** Every chat line (the agent API's `[AC:Chat]` console lines), spew lines included. */
  chat: string[];
  /** Spew lines (GameUI.displayErrorText): the client's own refusals and notices. */
  spew: string[];
  /** Console errors and uncaught page errors (BENIGN_CONSOLE_ERRORS dropped). */
  consoleErrors: string[];
  refusals: RefusalSeen[];
}

export interface PlaythroughDriver {
  /** Enter the world (log in, creating a character if the account has none). */
  enterWorld(): Promise<{ ok: boolean; detail: string }>;
  /** A window.__acAgent surface method. */
  call<T = unknown>(method: string, args?: unknown[], timeoutMs?: number): Promise<T>;
  probe(): Promise<ClientProbe>;
  /** The panel flags (GameUI.getUIState() plus charPanelTab / socialTab), or null outside the world. */
  uiState(): Promise<Record<string, unknown> | null>;
  /** A chat line typed into the chat box's path (acDebug.sendChat): "@" commands as a player types them. */
  chat(text: string): Promise<void>;
  /** Signals since the last drain, without clearing them. */
  peek(): Signals;
  /** Signals since the last drain, cleared. */
  drain(): Signals;
  /**
   * Where the player and some objects are: 'outdoors' (a landscape cell), 'building' (an interior cell with the EnvCell
   * SeenOutside flag: a room on the landscape), 'dungeon' (an interior cell without it), or 'unknown'.
   */
  placeOf(guids: number[]): Promise<{ me: Place; objects: Record<number, Place> }>;
  /**
   * Click a HUD indicator (`#hud-indicator-<id>`) with the real mouse, as a player does. `found` false when the era draws
   * none; `lit` whether it was lit (enabled) when clicked: an unlit indicator ignores the click, as retail's does.
   */
  clickIndicator(id: string): Promise<{ found: boolean; lit: boolean }>;
  /**
   * Of these objects, the NPCs a gift can go to: creatures (ItemType 0x10) that are not players (ObjectDescriptionFlag
   * Player 0x8) and not attackable (Attackable 0x10). A Fletching Forge or a Tusker Shrine Statue is no creature.
   */
  npcCreatures(guids: number[]): Promise<number[]>;
  /** The open vendor window's stock with each item's ItemType (GameUI vendorData), or null when none is open. */
  vendorStock(): Promise<VendorStockRow[] | null>;
  /** Screenshot of the page; the file's path relative to the report dir, or null when none could be taken. */
  screenshot(name: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type Place = 'outdoors' | 'building' | 'dungeon' | 'unknown';

export const emptySignals = (): Signals => ({ chat: [], spew: [], consoleErrors: [], refusals: [] });

// ── Eras ────────────────────────────────────────────────────────────────────

export interface PanelSpec {
  id: string;
  title: string;
  /** Keymap actions that open it, first bound one wins (eras bind different ones). */
  actions: string[];
  /** The GameUI.getUIState() flag that says it is showing. */
  flag: string;
  /**
   * The HUD indicator that opens it when no key does (`#hud-indicator-<id>`). The 1999 client's Spells in Effect
   * panel has no command: its keymap's command names (client.exe) are only ten *Panel commands (Inventory, Map,
   * Skills, Attributes, SpellResearch, SpellComponents, Spellbook, Fellowship, Allegiance, Options; DEFAULT_MAP_1999_ROWS
   * binds them), so a 1999 player opened it by clicking the magic indicator, which is lit only while a spell is in effect.
   */
  indicator?: string;
}

export interface EraPlan {
  /** tools/ac-agent/eras.ts key. */
  key: string;
  /** The client's ?era= id, or null for end of retail. */
  id: string | null;
  label: string;
  defaultAccount: string;
  /** A chat command whose Yes / No confirmation the run answers No. */
  confirmCommand: { text: string; why: string };
  panels: PanelSpec[];
  /** World SQL trees (relative to a data root) holding the era's creature weenies, base first then overlays. */
  creatureSql: string[];
  /** The era's world SQL `3-Core` tree (relative to a data root): its vendors (9 WeenieDefaults/SQL/Vendor) and where they stand (6 LandBlockExtendedData). */
  worldCore: string | null;
  /** Towns [name, NS, EW] to walk into when no vendor is in view (1999: towns1999.ts); empty = no such walk. */
  towns: ReadonlyArray<readonly [string, number, number]>;
  /**
   * The server answers a sale that went through with a silent 0xA0 on the sold item. The AC1999 server does: its
   * log shows `[1999-VENDOR] 0x60 SellToVendor` and, about 35 ms later, `[1999-INVFAIL] sent 0xA0 item=<the sold
   * item> error=55`. The 1999 client prints a 0xA0 only for the request it has pending (docs/ac1999-support.md,
   * "0xA0 prints one line"), and the sale's is already answered, so the player sees nothing: the telemetry logs it
   * with sink none. A sale step there expects exactly that one event; anything shown still fails it.
   */
  saleEchoesInventoryFailed: boolean;
}

const PANELS: PanelSpec[] = [
  { id: 'inventory', title: 'Inventory', actions: ['Show/Hide Inventory Panel'], flag: 'inventoryVisible' },
  { id: 'attributes', title: 'Character (attributes)', actions: ['Show/Hide Attributes Page', 'Show/Hide Character Detail Panel'], flag: 'charPanelVisible' },
  { id: 'skills', title: 'Skills', actions: ['Show/Hide Skills Page'], flag: 'charPanelVisible' },
  { id: 'spellbook', title: 'Spellbook', actions: ['Show/Hide Spellbook Page', 'Show/Hide Spell Management Panel'], flag: 'magicVisible' },
  { id: 'components', title: 'Spell components', actions: ['Show/Hide Spell Components Page'], flag: 'magicVisible' },
  { id: 'map', title: 'Map', actions: ['Show/Hide Map Page', 'Show/Hide World Panel'], flag: 'mapPanelVisible' },
  { id: 'options', title: 'Options', actions: ['Show/Hide Options Panel'], flag: 'optionsPanelVisible' },
  { id: 'fellowship', title: 'Social / fellowship', actions: ['Show/Hide Fellowship Page', 'Show/Hide Social Panel'], flag: 'socialPanelVisible' },
];
/** After cast-self, so a 1999 run has a spell in effect and the indicator that opens it is lit. */
const EFFECTS_PANEL: PanelSpec = { id: 'effects', title: 'Effects (spells in effect)', actions: ['Show/Hide Positive Magic Panel'], flag: 'positiveEffectsVisible', indicator: 'effects-beneficial' };
const CREATE_SPELL: PanelSpec = { id: 'create-spell', title: 'Create spell (spell research)', actions: ['Show/Hide Spell Research Page'], flag: 'magicVisible' };

const EOR_CREATURES = ['world-db-raw/ACE-World-16PY/Database/3-Core/9 WeenieDefaults/SQL', 'world-db-raw/ACE-World-16PY-Patches/Database/Patches/9 WeenieDefaults'];

export const ERA_PLANS: Record<string, EraPlan> = {
  'ac1999-retail': {
    key: 'ac1999-retail', id: 'ac1999-retail', label: 'Retail November 1999 (AC1999 server)', defaultAccount: 'ptrun99',
    // Commands1999.ts doLifestone: 1999's @lifestone kills the character after a Yes / No (LIFESTONE_CONFIRM_1999).
    confirmCommand: { text: '@lifestone', why: "1999's @lifestone asks \"Do you really want to kill your character?\"" },
    // The Create Spell page exists only in 1999 (docs/ac1999-support.md, Spell Research panel).
    panels: [...PANELS.slice(0, 5), CREATE_SPELL, ...PANELS.slice(5)],
    creatureSql: ['reference/ac1999/Server/Database/AC1999-World/3-Core/9 WeenieDefaults/SQL'],
    worldCore: 'reference/ac1999/Server/Database/AC1999-World/3-Core',
    towns: AC1999_TOWN_ROWS,
    saleEchoesInventoryFailed: true,
  },
  eor: {
    key: 'eor', id: null, label: 'End of retail (local ACE)', defaultAccount: 'testacjs3',
    // End of retail's @lifestone teleports at once (DoLifestone @ 0056fc70); its @die asks first (DoDie, DIE_DIALOG_TEXT).
    confirmCommand: { text: '@die', why: "end of retail's @lifestone recalls with no question; its @die asks first" },
    panels: PANELS,
    creatureSql: EOR_CREATURES,
    worldCore: 'world-db-raw/ACE-World-16PY/Database/3-Core',
    towns: [],
    saleEchoesInventoryFailed: false,
  },
  'classicace-customdm': {
    key: 'classicace-customdm', id: 'classicace-customdm', label: 'Dark Majesty (ClassicACE CustomDM)', defaultAccount: 'agentapp99dm',
    confirmCommand: { text: '@die', why: 'the Dark Majesty client is end of retail\'s: @die asks first' },
    panels: PANELS,
    // Its world is in the classicace-db container, not in SQL files: the name rules alone pick the prey.
    creatureSql: [],
    worldCore: null,
    towns: [],
    saleEchoesInventoryFailed: false,
  },
};

export function eraPlan(key: string | undefined): EraPlan {
  const k = !key || key === 'end-of-retail' ? 'eor' : key === '1999' || key === 'ac1999' ? 'ac1999-retail' : key === 'dm' ? 'classicace-customdm' : key;
  const p = ERA_PLANS[k];
  if (!p) throw new Error(`unknown era "${key}" (have: ${Object.keys(ERA_PLANS).join(', ')})`);
  return p;
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface PlaythroughArgs {
  base: string;
  bridge: string;
  era: EraPlan;
  account: string;
  password: string;
  /** The name for a new character (an account with characters enters its own). */
  character: string;
  /** Extra page parameters (e.g. datSet=…). */
  query: string;
  out: string | null;
  gpu: boolean;
  headed: boolean;
  /** Only these step ids (comma list), for a quick re-run of one flow. */
  only: string[] | null;
  /** A data root (a checkout holding reference/ and world-db-raw/) to read the era's creature SQL from first. */
  dataRoot: string | null;
  /** A local Chrome profile directory to reuse (kept: a warm DAT cache), instead of a temporary one. */
  profile: string | null;
}

export function parsePlaythroughArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, random: () => number = Math.random): PlaythroughArgs {
  const get = (k: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${k}=`));
    if (eq) return eq.slice(k.length + 3);
    const i = argv.indexOf(`--${k}`);
    return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const era = eraPlan(get('era') ?? 'ac1999-retail');
  const account = get('account') ?? era.defaultAccount;
  const letters = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join('');
  let base = get('base') ?? env.AC_BASE ?? 'http://localhost:3000/';
  if (!/\/$/.test(base) && !base.includes('?')) base += '/';
  return {
    base,
    bridge: get('bridge') ?? env.AC_BRIDGE ?? 'ws://localhost:9090',
    era,
    account,
    password: get('password') ?? account,
    character: get('character') ?? `Firsthour ${letters[0].toUpperCase()}${letters.slice(1)}`,
    query: get('query') ?? env.AC_EXTRA_QUERY ?? '',
    out: get('out') ?? null,
    gpu: !argv.includes('--swiftshader'),
    headed: argv.includes('--headed'),
    only: get('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null,
    dataRoot: get('data-root') ?? null,
    profile: get('profile') ?? null,
  };
}

/** The game URL: autologin on the dev server (config/urlOverrides.ts), the agent API on. */
export function playthroughUrl(a: Pick<PlaythroughArgs, 'base' | 'bridge' | 'era' | 'account' | 'password' | 'query'>): string {
  const sep = a.base.includes('?') ? '&' : '?';
  return `${a.base}${sep}ace&agent&bridge=${a.bridge}&account=${encodeURIComponent(a.account)}&password=${encodeURIComponent(a.password)}`
    + `${a.era.id ? `&era=${a.era.id}` : ''}${a.query ? `&${a.query.replace(/^[?&]/, '')}` : ''}`;
}

// ── Health ──────────────────────────────────────────────────────────────────

/** The one refusal no step may produce: the pending-request lock (webac#12). */
export const ONE_ITEM_AT_A_TIME = /one item at a time/i;

/** Console errors that are not the client's: the browser's own fetches. */
export const BENIGN_CONSOLE_ERRORS: readonly RegExp[] = [
  /favicon\.ico/i,
  // Telemetry posts to the bridge's HTTP side (TelemetryOutbox, no-cors); a bridge without it is not a client fault.
  /\/client-preworld|\/__webac\/report/,
];

export function isBenignConsoleError(text: string): boolean {
  return BENIGN_CONSOLE_ERRORS.some((re) => re.test(text));
}

/**
 * Problems with the client after a step; `allow` lists the refusals that step expects (by text), `allowRefusal`
 * the client_refusal events it expects (by code, context and sink). Empty = healthy.
 */
export function assessHealth(probe: ClientProbe, s: Signals, allow: readonly RegExp[] = [], allowRefusal?: (r: RefusalSeen) => boolean): string[] {
  const out: string[] = [];
  const allowed = (t: string): boolean => allow.some((re) => re.test(t));
  if (probe.dead) out.push('the player is dead');
  if (probe.inventoryRequest !== null && probe.inventoryRequest !== undefined) out.push(`an inventory request is still pending: ${JSON.stringify(probe.inventoryRequest)}`);
  if (probe.busy > 0) out.push(`the busy cursor count is ${probe.busy}, not 0`);
  const oneItem = [...new Set([...s.spew, ...s.chat].filter((l) => ONE_ITEM_AT_A_TIME.test(l)))];
  for (const l of oneItem) out.push(`"${l}"`);
  const spew = new Set(s.spew);
  for (const l of s.spew) {
    // Notices are not refusals: the client's own notice list and each use's status line ("Approaching %s",
    // "Using the %s"), both from the client's literal tables (RefusalReporter.isSpewNotice, UseObject.ts).
    if (ONE_ITEM_AT_A_TIME.test(l) || isSpewNotice(l) || allowed(l)) continue;
    out.push(`unexpected refusal (spew): "${l}"`);
  }
  for (const l of s.chat) {
    // Spew lines reach the chat too (displayErrorText → addSystemMessage): judged above.
    if (spew.has(l) || ONE_ITEM_AT_A_TIME.test(l) || allowed(l) || !REFUSAL_TEXT.test(l)) continue;
    out.push(`unexpected refusal (chat): "${l}"`);
  }
  for (const r of s.refusals) {
    // The client's own spew refusals are judged by their full text above; the telemetry adds the server's codes,
    // silent ones included.
    if (r.source === 'client' && r.context === 'spew') continue;
    if (r.rollup) continue;
    // A server notice sent as a WeenieError (ACE's "Turbine Chat is enabled." at every login): RefusalReporter.NOT_REFUSAL_CODES.
    const num = /^we:0x([0-9a-f]+)$/i.exec(r.code);
    if (num && isNoticeCode(r.context, parseInt(num[1], 16))) continue;
    const t = `${r.code} ${r.context} ${r.text ?? ''}`;
    if (allowed(r.text ?? '') || allowed(t) || allowRefusal?.(r)) continue;
    out.push(`client_refusal ${r.code} (${r.context}${r.sink ? `, shown: ${r.sink}` : ''})${r.text ? `: "${r.text}"` : ' (no text shown)'}`);
  }
  for (const e of s.consoleErrors) if (!isBenignConsoleError(e)) out.push(`console error: ${e.slice(0, 300)}`);
  return out;
}

// ── Steps and the run ───────────────────────────────────────────────────────

export type StepStatus = 'ok' | 'skipped' | 'fail';

export interface StepOutcome {
  status: StepStatus;
  detail: string;
  screenshots?: string[];
  /** Refusals this step expects (an NPC turning down a gift, a fizzle): not counted against the client. */
  allow?: RegExp[];
  /** client_refusal events this step expects (the 1999 server's silent 0xA0 after a sale). */
  allowRefusal?: (r: RefusalSeen) => boolean;
}

export interface StepRecord {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
  problems: string[];
  screenshots: string[];
  ms: number;
  /** Signals the step produced, for the report's detail. */
  signals: Signals;
  /** What the step expected, kept to judge signals that arrive after it ended. */
  allow?: RegExp[];
  allowRefusal?: (r: RefusalSeen) => boolean;
}

/** Shared between steps: what an earlier step found for a later one. */
export interface RunState {
  character: string | null;
  vendor: { guid: number; name: string } | null;
  bought: { guid: number; name: string } | null;
  kill: { name: string; guid: number; corpse: number | null } | null;
  caster: { guid: number; name: string } | null;
  /** Why the supplies step bought no item of a kind (kit, food, caster, scroll): said by the step that then skips. */
  supplies: Partial<Record<SupplyKind, string>>;
}

export interface StepContext {
  driver: PlaythroughDriver;
  era: EraPlan;
  facts: CreatureFacts | null;
  /** The era's vendor spawns from its world data (loadVendorSpots), or null. */
  vendorSpots?: VendorSpot[] | null;
  /** What each NPC accepts as a gift, from the era's world data (loadGiveTables), or null. */
  giveTables?: GiveTables | null;
  state: RunState;
  log: (msg: string) => void;
}

export interface Step {
  id: string;
  title: string;
  run(ctx: StepContext): Promise<StepOutcome>;
  timeoutMs?: number;
  /** Abort the run when this step doesn't pass (entering the world). */
  required?: boolean;
}

export const ok = (detail: string, extra: Partial<StepOutcome> = {}): StepOutcome => ({ status: 'ok', detail, ...extra });
export const skip = (detail: string, extra: Partial<StepOutcome> = {}): StepOutcome => ({ status: 'skipped', detail, ...extra });
export const fail = (detail: string, extra: Partial<StepOutcome> = {}): StepOutcome => ({ status: 'fail', detail, ...extra });

/** Wait for the client to finish a step: no request pending and the busy count down, or `ms` gone. */
export async function settle(driver: PlaythroughDriver, ms: number): Promise<ClientProbe> {
  const end = driver.now() + ms;
  let p = await driver.probe();
  while ((p.inventoryRequest != null || p.busy > 0) && !p.dead && driver.now() < end) {
    await driver.sleep(500);
    p = await driver.probe();
  }
  return p;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); })])
    .finally(() => clearTimeout(timer));
};

export interface RunOptions {
  /** How long a step's request / busy count may take to clear (default 10 s). */
  settleMs?: number;
  /** How long after settling to wait for the step's last telemetry post (default 750 ms). */
  graceMs?: number;
  /** Default step timeout (default 180 s). */
  stepTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface RunResult { records: StepRecord[]; aborted: string | null }

/** Run the steps in order, checking the client's health after each. A death or a failed required step ends the run. */
export async function runPlaythrough(steps: Step[], ctx: StepContext, opts: RunOptions = {}): Promise<RunResult> {
  const { driver } = ctx;
  const log = opts.log ?? ctx.log;
  const records: StepRecord[] = [];
  let aborted: string | null = null;
  driver.drain();
  /** What arrived after a step's drain and before the next step began is that step's (a slow telemetry post). */
  const attributeLate = (): void => {
    const late = driver.drain();
    const last = records[records.length - 1];
    if (!last || !(late.chat.length + late.spew.length + late.consoleErrors.length + late.refusals.length)) return;
    for (const k of ['chat', 'spew', 'consoleErrors', 'refusals'] as const) (last.signals[k] as unknown[]).push(...late[k]);
    const more = assessHealth({ screen: 'world', inventoryRequest: null, busy: 0, dead: false, health: null, character: null }, late, last.allow, last.allowRefusal);
    if (more.length) { last.problems.push(...more.map((p) => `${p} (arrived after the step ended)`)); last.status = 'fail'; }
  };
  for (const step of steps) {
    attributeLate();
    const t0 = driver.now();
    log(`── ${step.id}: ${step.title}`);
    let outcome: StepOutcome;
    try {
      outcome = await withTimeout(step.run(ctx), step.timeoutMs ?? opts.stepTimeoutMs ?? 180_000, step.id);
    } catch (e) {
      outcome = fail(`threw: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    }
    let probe: ClientProbe;
    try { probe = await settle(driver, opts.settleMs ?? 10_000); } catch (e) {
      probe = { screen: 'unknown', inventoryRequest: null, busy: 0, dead: false, health: null, character: null };
      outcome = fail(`${outcome.detail}; and the client could not be read afterwards: ${String((e as Error)?.message ?? e)}`);
    }
    // A moment for the step's last telemetry post to arrive (the page posts each refusal as it happens).
    await driver.sleep(opts.graceMs ?? 750);
    const signals = driver.drain();
    const problems = assessHealth(probe, signals, outcome.allow ?? [], outcome.allowRefusal);
    const status: StepStatus = outcome.status === 'fail' || problems.length ? 'fail' : outcome.status;
    const rec: StepRecord = { id: step.id, title: step.title, status, detail: outcome.detail, problems, screenshots: outcome.screenshots ?? [], ms: driver.now() - t0, signals, allow: outcome.allow ?? [], allowRefusal: outcome.allowRefusal };
    records.push(rec);
    log(`   ${status}${status === 'ok' ? '' : `: ${outcome.detail}`}${problems.length ? `\n   problems: ${problems.join('; ')}` : ''}`);
    if (probe.dead) { aborted = `the player died during "${step.id}"`; break; }
    if (step.required && status !== 'ok') { aborted = `"${step.id}" did not pass, so nothing after it can run`; break; }
  }
  attributeLate();
  return { records, aborted };
}

// ── Report ──────────────────────────────────────────────────────────────────

export function statusLabel(r: Pick<StepRecord, 'status' | 'detail' | 'problems'>): string {
  if (r.status === 'ok') return 'ok';
  if (r.status === 'skipped') return `skipped (${r.detail})`;
  return `FAIL (${[r.detail, ...r.problems].filter(Boolean).join('; ')})`;
}

export function exitCode(res: RunResult): number {
  return res.aborted || res.records.some((r) => r.status === 'fail') ? 1 : 0;
}

const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(res: RunResult, meta: { era: EraPlan; url: string; account: string; character: string | null; started: Date; finished: Date }): string {
  const n = (s: StepStatus): number => res.records.filter((r) => r.status === s).length;
  const lines: string[] = [
    `# First-hour play-through: ${meta.era.label}`,
    '',
    `- Started ${meta.started.toISOString()}, finished ${meta.finished.toISOString()} (${Math.round((meta.finished.getTime() - meta.started.getTime()) / 1000)} s)`,
    `- Era \`${meta.era.key}\`, account \`${meta.account}\`, character ${meta.character ? `"${meta.character}"` : '(none entered)'}`,
    `- Page: \`${meta.url.replace(/password=[^&]*/, 'password=***')}\``,
    `- Result: **${exitCode(res) ? 'FAIL' : 'PASS'}**: ${n('ok')} ok, ${n('skipped')} skipped, ${n('fail')} failed${res.aborted ? `; ABORTED: ${res.aborted}` : ''}`,
    '',
    '| # | step | result | time |',
    '|---|---|---|---|',
    ...res.records.map((r, i) => `| ${i + 1} | ${mdCell(r.title)} (\`${r.id}\`) | ${mdCell(statusLabel(r))} | ${(r.ms / 1000).toFixed(1)} s |`),
    '',
    '## Steps',
  ];
  for (const r of res.records) {
    lines.push('', `### ${r.title} (\`${r.id}\`): ${r.status === 'fail' ? 'FAIL' : r.status}`, '', r.detail || '(no detail)');
    if (r.problems.length) lines.push('', 'Health problems:', ...r.problems.map((p) => `- ${p}`));
    const s = r.signals;
    const shown = [...new Set([...s.spew.map((l) => `spew: ${l}`), ...s.chat.filter((l) => !s.spew.includes(l)).map((l) => `chat: ${l}`)])];
    if (shown.length) lines.push('', '<details><summary>chat and spew lines</summary>', '', '```', ...shown.slice(0, 80), ...(shown.length > 80 ? [`… ${shown.length - 80} more`] : []), '```', '</details>');
    if (s.refusals.length) lines.push('', 'client_refusal events:', ...s.refusals.map((x) => `- ${x.source} ${x.code} (${x.context})${x.text ? `: ${x.text}` : ''}`));
    for (const p of r.screenshots) lines.push('', `![${r.id}](${p})`);
  }
  return `${lines.join('\n')}\n`;
}

// ── Creatures: what is safe to fight ────────────────────────────────────────

/** A creature's danger, from its era's world data. */
export interface CreatureFact {
  name: string;
  level: number;
  maxHealth: number;
  /** It has a spell book (the Red Phyntos Wasp's Frost Bolt I, a level 3 that killed a test character near Samsur). */
  casts: boolean;
  /** Its hardest body-part hit, damage + variance (weenie_properties_body_part d_Val × (1 + d_Var)). */
  maxHit: number;
  /** It is made holding a weapon (create list Wield 2 / WieldTreasure 10): its hits are the weapon's, not its body's. */
  armed: boolean;
  /** Merged: every weenie of this name (the fact itself holds the worst of each), to match one by the level the server sent. */
  variants?: CreatureFact[];
}
export type CreatureFacts = Map<string, CreatureFact>;

/** What may be fought by a fresh character with no help: no spells, low level, little health, small hits. */
export const PREY_LIMITS = { maxLevel: 6, maxHealth: 60, maxHit: 8 } as const;

/** Never fought, whatever the data says: kinds that cast, swarm or hit far above their level for a new character. */
export const NEVER_PREY = /phyntos wasp|bandit|thug|brigand|highwayman|assassin|olthoi|lugian|tusker|mattekar|virindi|golem|shadow|skeleton|zombie|undead|banderling|gromnie|reedshark|sclavus|knath|monouga|wisp|elemental|mosswart (shaman|chief)|drudge (sneak|lurker|ravener|robber|slinker|prowler|charger)/i;

/** With no world data for the era: only these, and only at a known low level. */
export const FALLBACK_PREY = /\b(rabbit|grey rat|russet rat|brown rat|drudge skulker|gnawer shreth|mosswart creeper)\b/i;

/** One creature weenie's SQL (ACE layout) → its danger facts, or null when it isn't an attackable creature. */
export function parseCreatureDanger(text: string): CreatureFact | null {
  const ints = new Map(rowsOf(text, 'weenie_properties_int').map((r) => [Number(r[1]), Number(r[2])]));
  if (((ints.get(1) ?? 0) & 0x10) === 0) return null;
  const bools = new Map(rowsOf(text, 'weenie_properties_bool').map((r) => [Number(r[1]), r[2]]));
  if (/^false$/i.test(bools.get(19) ?? '')) return null; // Attackable = False: an NPC
  const name = /\(\d+, *1, *'((?:[^'\\]|\\.|'')*)'\)/.exec(/INSERT INTO `weenie_properties_string`[\s\S]*?;\s*(?:\n|$)/.exec(text)?.[0] ?? '')?.[1]?.replace(/\\'|''/g, "'");
  if (!name) return null;
  const hp = rowsOf(text, 'weenie_properties_attribute_2nd').find((r) => Number(r[1]) === 1);
  const endurance = Number(rowsOf(text, 'weenie_properties_attribute').find((r) => Number(r[1]) === 2)?.[2] ?? 0);
  const maxHealth = hp && Number(hp[5]) > 0 ? Number(hp[5]) : (hp ? Number(hp[2]) : 0) + Math.round(endurance / 2);
  const maxHit = Math.max(0, ...rowsOf(text, 'weenie_properties_body_part').map((r) => Number(r[3]) * (1 + (Number(r[4]) || 0))).filter(Number.isFinite));
  const armed = rowsOf(text, 'weenie_properties_create_list').some((r) => Number(r[1]) === 2 || Number(r[1]) === 10);
  return { name, level: ints.get(25) ?? 0, maxHealth, casts: rowsOf(text, 'weenie_properties_spell_book').length > 0, maxHit: Math.round(maxHit * 10) / 10, armed };
}

/** Merge same-named creatures: the worst of each danger, with every weenie kept as a variant. */
export function mergeCreatureFacts(all: CreatureFact[]): CreatureFacts {
  const m: CreatureFacts = new Map();
  for (const c of all) {
    const k = c.name.toLowerCase();
    const was = m.get(k);
    const variants = [...(was?.variants ?? []), { ...c, variants: undefined }];
    m.set(k, was
      ? { name: was.name, level: Math.max(was.level, c.level), maxHealth: Math.max(was.maxHealth, c.maxHealth), casts: was.casts || c.casts, maxHit: Math.max(was.maxHit, c.maxHit), armed: was.armed || c.armed, variants }
      : { ...c, variants });
  }
  return m;
}

/**
 * The facts to judge a creature by: the weenies of its name at the level the server sent (the worst of them),
 * else the worst of every weenie of that name. Drudge Skulkers run level 2 to 8 in end of retail: the level-2
 * one by Holtburg is judged as level 2, an unknown-level one as level 8.
 */
export function factFor(f: CreatureFact, level: number | undefined): CreatureFact {
  const same = level === undefined ? [] : (f.variants ?? []).filter((v) => v.level === level);
  if (!same.length) return f;
  return same.reduce((a, b) => ({ name: a.name, level: a.level, maxHealth: Math.max(a.maxHealth, b.maxHealth), casts: a.casts || b.casts, maxHit: Math.max(a.maxHit, b.maxHit), armed: a.armed || b.armed }));
}

/** The era's creature facts from its world SQL under the first data root that has it; null when none does. */
export function loadCreatureFacts(era: EraPlan, roots: string[]): { facts: CreatureFacts; from: string } | null {
  if (!era.creatureSql.length) return null;
  for (const root of roots) {
    const trees = era.creatureSql.map((d) => join(root, d));
    if (!existsSync(trees[0])) continue;
    const files = overlayFiles(trees.map((t) => [...sqlFiles(join(t, 'Creature')), ...sqlFiles(join(t, 'Cow'))]));
    const facts = mergeCreatureFacts(files.flatMap((f) => { const c = parseCreatureDanger(readFileSync(f, 'utf8')); return c ? [c] : []; }));
    if (facts.size) return { facts, from: trees[0] };
  }
  return null;
}

/** Whether a creature may be fought, and why not. */
export function preyVerdict(o: Pick<AgentObject, 'name' | 'level'>, facts: CreatureFacts | null): { ok: boolean; why: string } {
  if (NEVER_PREY.test(o.name)) return { ok: false, why: 'a kind never fought here' };
  const all = facts?.get(o.name.toLowerCase());
  if (facts && all) {
    const f = factFor(all, o.level);
    if (f.casts) return { ok: false, why: 'casts spells' };
    if (f.armed) return { ok: false, why: 'wields a weapon' };
    if (f.level > PREY_LIMITS.maxLevel) return { ok: false, why: `level ${f.level}` };
    if (f.maxHealth > PREY_LIMITS.maxHealth) return { ok: false, why: `${f.maxHealth} health` };
    if (f.maxHit > PREY_LIMITS.maxHit) return { ok: false, why: `hits up to ${f.maxHit}` };
    return { ok: true, why: `level ${f.level}, ${f.maxHealth} health, hits up to ${f.maxHit}, no spells (world data)` };
  }
  if (facts) return { ok: false, why: 'not in the era\'s world data' };
  if (!FALLBACK_PREY.test(o.name)) return { ok: false, why: 'not on the no-data allow list' };
  if (o.level === undefined || o.level > PREY_LIMITS.maxLevel) return { ok: false, why: o.level === undefined ? 'level unknown' : `level ${o.level}` };
  return { ok: true, why: `level ${o.level}, on the no-data allow list` };
}

/**
 * Whether a creature `dz` metres up or down and `dist` metres off can be walked to. Indoors: the same floor (AgentApi
 * FLOOR_APART_M, 2.5 m: another floor is another room's way round). Outdoors: hills are fine (the 1999 run passed over
 * every rabbit on the gentle dunes near Samsur, 8 to 26 m up or down at 60+ m), a cliff is not: the average grade from
 * here to there at most PREY_MAX_GRADE, well under the steepest ground a body walks up (FloorZ 0.664, a 1.13 grade),
 * plus a few metres for a creature standing on a rock right beside you.
 */
export function preyReachable(dz: number, dist: number, sameFloorOnly: boolean): boolean {
  if (sameFloorOnly) return Math.abs(dz) < PREY_FLOOR_APART_M;
  return Math.abs(dz) <= PREY_MAX_GRADE * dist + 3;
}
export const PREY_FLOOR_APART_M = 2.5;
export const PREY_MAX_GRADE = 0.7;

/**
 * Whether the floor rule applies between the player and a creature: the player in a dungeon, or the creature in an
 * interior cell (a building's room or a dungeon). A player in a building's room fighting a creature on the landscape
 * walks out of the door: the grade rule (run 2 of 2026-10-23 started in a Holtburg shop, 0xA9B00111, and the flat
 * "indoors" rule passed over every rabbit outside).
 */
export function sameFloorOnly(me: Place, creature: Place): boolean {
  return me === 'dungeon' || creature === 'building' || creature === 'dungeon';
}

/** The nearest creature that may be fought (within reach, walkable to), with every refusal said. */
export function pickPrey(nearby: AgentObject[], facts: CreatureFacts | null, opts: { maxDist?: number; sameFloor?: (o: AgentObject) => boolean; exclude?: number[] } = {}): { prey: AgentObject | null; why: string; rejected: string[] } {
  const maxDist = opts.maxDist ?? 150;
  const rejected: string[] = [];
  const sorted = nearby.filter((o) => o.kind === 'monster').sort((a, b) => a.dist - b.dist);
  for (const o of sorted) {
    if (opts.exclude?.includes(o.guid)) continue;
    if (o.health !== undefined && o.health <= 0) continue;
    if (o.dist > maxDist) { rejected.push(`${o.name} (${o.dist.toFixed(0)} m off)`); continue; }
    const floor = opts.sameFloor?.(o) ?? false;
    if (!preyReachable(o.dz, o.dist, floor)) { rejected.push(`${o.name} (${o.dz.toFixed(0)} m ${o.dz > 0 ? 'up' : 'down'} at ${o.dist.toFixed(0)} m${floor ? ': another floor' : ': a cliff'})`); continue; }
    const v = preyVerdict(o, facts);
    if (!v.ok) { rejected.push(`${o.name}: ${v.why}`); continue; }
    return { prey: o, why: v.why, rejected };
  }
  return { prey: null, why: '', rejected };
}

/** "40m S": a walk_to offset away from a bearing. */
export function awayFrom(bearing: number, metres: number): string {
  return `${metres}m ${compassPoint(bearing + 180)}`;
}

/** A vendor's spawn in the era's world data: its name, cell and global position (metres, landblock × 192 + local). */
export interface VendorSpot { name: string; wcid: number; cell: number; x: number; y: number; general?: boolean }

/**
 * A general goods vendor, by its name or its weenie class name: a Shopkeeper, Grocer, Provisioner, Peddler or Trader
 * buys most kinds (the 1999 Hudriffa is `holtburgsouthoutpostshopkeep`). The EoR run of 2026-10-23 sold to Ladim the
 * Bowyer, who buys none of a Quarrel, Cabbage or Torch, and sold the supplies none.
 */
export const GENERAL_VENDOR = /shop ?keep|grocer|general|provision|peddler|trader|merchant|outfitter|supplies|store/i;

/** Vendor weenie class ids → names, from the file names under `9 WeenieDefaults/SQL/Vendor` ("04433 Hudriffa.sql"). */
export function vendorWeenies(files: string[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const f of files) {
    const r = /^(\d+) (.+)\.sql$/.exec(f.slice(f.lastIndexOf('/') + 1));
    if (r) m.set(Number(r[1]), r[2]);
  }
  return m;
}

/** The vendor spawns in one landblock's instance SQL (ACE layout: `VALUES (guid, wcid, cell, x, y, z, …)`). */
export function vendorSpotsIn(sql: string, vendors: Map<number, string>): VendorSpot[] {
  const out: VendorSpot[] = [];
  for (const m of sql.matchAll(/VALUES \(0x[0-9A-Fa-f]+,\s*(\d+),\s*0x([0-9A-Fa-f]{8}),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/g)) {
    const wcid = Number(m[1]);
    const name = vendors.get(wcid);
    if (!name) continue;
    const cell = parseInt(m[2], 16) >>> 0;
    out.push({ name, wcid, cell, x: ((cell >>> 24) & 0xff) * 192 + Number(m[3]), y: ((cell >>> 16) & 0xff) * 192 + Number(m[4]) });
  }
  return out;
}

/** Every vendor spawn in the era's world data under the first data root that has it, or null. */
export function loadVendorSpots(era: EraPlan, roots: string[]): VendorSpot[] | null {
  if (!era.worldCore) return null;
  for (const root of roots) {
    const core = join(root, era.worldCore);
    const vdir = join(core, '9 WeenieDefaults/SQL/Vendor');
    const ldir = join(core, '6 LandBlockExtendedData/SQL');
    if (!existsSync(vdir) || !existsSync(ldir)) continue;
    const files = sqlFiles(vdir);
    const vendors = vendorWeenies(files);
    const general = new Set<number>();
    for (const f of files) {
      const head = readFileSync(f, 'utf8').slice(0, 600);
      const m = /VALUES \((\d+), '([^']*)'/.exec(head);
      const id = m ? Number(m[1]) : NaN;
      if (m && (GENERAL_VENDOR.test(m[2]) || GENERAL_VENDOR.test(vendors.get(id) ?? ''))) general.add(id);
    }
    const spots = readdirSync(ldir).filter((f) => f.endsWith('.sql'))
      .flatMap((f) => vendorSpotsIn(readFileSync(join(ldir, f), 'utf8'), vendors))
      .map((v) => ({ ...v, general: general.has(v.wcid) }));
    if (spots.length) return spots;
  }
  return null;
}

/** The nearest vendor spawn to a global position within `maxM` metres, or null. */
export function nearestVendorSpot(spots: VendorSpot[] | null, at: { x: number; y: number } | null, maxM = 1500, onlyGeneral = false): (VendorSpot & { dist: number }) | null {
  if (!spots || !at) return null;
  let best: (VendorSpot & { dist: number }) | null = null;
  for (const v of spots) {
    if (onlyGeneral && !v.general) continue;
    const dist = Math.hypot(v.x - at.x, v.y - at.y);
    if (dist <= maxM && (!best || dist < best.dist)) best = { ...v, dist };
  }
  return best;
}

export const cellTarget = (cell: number): string => `0x${(cell >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** The nearest town to map coordinates text ("42.1N, 33.6E") within `maxUnits` map units (0.1 = 24 m), or null. */
export function nearestTown(coords: string | null | undefined, towns: EraPlan['towns'], maxUnits = 6): { name: string; at: string; units: number } | null {
  const c = coords ? parseMapCoordsText(coords) : null;
  if (!c) return null;
  let best: { name: string; at: string; units: number } | null = null;
  for (const [name, ns, ew] of towns) {
    const units = Math.hypot(c.ns - ns, c.ew - ew);
    if (units <= maxUnits && (!best || units < best.units)) best = { name, at: `${Math.abs(ns).toFixed(1)}${ns < 0 ? 'S' : 'N'}, ${Math.abs(ew).toFixed(1)}${ew < 0 ? 'W' : 'E'}`, units };
  }
  return best;
}

// ── Vendor listing ──────────────────────────────────────────────────────────

export interface VendorRow { guid: number; name: string; price: number; service: boolean }

/** The rows of the agent's vendor listing (AgentApi.vendorView): "  #<hex> <name>  <price>[  (stack n)][  (service: …)]". */
export function parseVendorListing(message: string): VendorRow[] {
  const out: VendorRow[] = [];
  for (const line of message.split('\n')) {
    const m = /^\s+#([0-9a-f]+) (.+?)  (\d+)(.*)$/.exec(line);
    if (m) out.push({ guid: parseInt(m[1], 16) >>> 0, name: m[2], price: Number(m[3]), service: /\(service:/.test(m[4]) });
  }
  return out;
}

/** The cheapest goods (not a service) the purse pays for. */
export function cheapestAffordable(rows: VendorRow[], purse: number | undefined): VendorRow | null {
  const goods = rows.filter((r) => !r.service && r.price > 0 && (purse === undefined || r.price <= purse)).sort((a, b) => a.price - b.price);
  return goods[0] ?? null;
}

/** A vendor's item with its ItemType, as the vendor window holds it. */
export interface VendorStockRow { guid: number; name: string; price: number; itemType?: number; service?: boolean }

/** What the later steps need and a fresh character may not hold: a healing kit, food, a caster, a spell scroll. */
export type SupplyKind = 'kit' | 'food' | 'caster' | 'scroll';
export const SUPPLY_KINDS: readonly SupplyKind[] = ['kit', 'caster', 'food', 'scroll'];

const asItem = (r: VendorStockRow): AgentItem => ({ guid: r.guid, name: r.name, where: 'vendor', itemType: r.itemType });
/** Whether a vendor's item is of a kind: by its ItemType where the window has it (INVENTORY_KINDS), else by name. */
export function supplyMatches(kind: SupplyKind, r: VendorStockRow): boolean {
  if (r.service) return false;
  const it = asItem(r);
  switch (kind) {
    case 'kit': return INVENTORY_KINDS.kit(it) && /heal/i.test(r.name);
    case 'scroll': return INVENTORY_KINDS.scroll(it);
    case 'caster': return r.itemType !== undefined ? (r.itemType & 0x8000) !== 0 : /\b(wand|staff|orb|sceptre|scepter|baton)\b/i.test(r.name);
    case 'food': return r.itemType !== undefined ? INVENTORY_KINDS.food(it) : /\b(bread|apple|meat|cheese|fish|egg|pie|cake|stew|grapes|cabbage|carrot|mushroom)\b/i.test(r.name);
  }
}
/** Whether the pack already holds one of a kind (so nothing need be bought). */
export function holdsSupply(kind: SupplyKind, inv: AgentItem[]): boolean {
  return inv.some((i) => kind === 'caster' ? ((i.itemType ?? 0) & 0x8000) !== 0
    : kind === 'kit' ? INVENTORY_KINDS.kit(i) && /heal/i.test(i.name)
      : INVENTORY_KINDS[kind](i));
}

/**
 * What to buy for the later steps: per kind not already held, the cheapest the purse still pays for, in
 * SUPPLY_KINDS order (the kit and a caster first: they unlock the most). Each kind not bought says why.
 */
export function planSupplies(stock: VendorStockRow[], inv: AgentItem[], purse: number): { buy: Array<{ kind: SupplyKind; row: VendorStockRow }>; why: Partial<Record<SupplyKind, string>> } {
  const buy: Array<{ kind: SupplyKind; row: VendorStockRow }> = [];
  const why: Partial<Record<SupplyKind, string>> = {};
  let left = purse;
  for (const kind of SUPPLY_KINDS) {
    if (holdsSupply(kind, inv)) continue;
    const rows = stock.filter((r) => supplyMatches(kind, r)).sort((a, b) => a.price - b.price);
    if (!rows.length) { why[kind] = 'the vendor sells none'; continue; }
    if (rows[0].price > left) { why[kind] = `the cheapest at the vendor, ${rows[0].name}, costs ${rows[0].price} and ${left} pyreals are left`; continue; }
    buy.push({ kind, row: rows[0] });
    left -= rows[0].price;
  }
  return { buy, why };
}

// ── Step definitions ────────────────────────────────────────────────────────

type Obs = { me: AgentSelf | null; nearby: AgentObject[]; remembered: AgentObject[]; dialogs: Array<{ text: string; buttons: string[] }>; windows?: string[] };
const observe = (ctx: StepContext, o: Record<string, unknown>): Promise<Obs> => ctx.driver.call<Obs>('observe', [o], 60_000);
const self = (ctx: StepContext): Promise<AgentSelf | null> => ctx.driver.call<AgentSelf | null>('self');
const shots = async (ctx: StepContext, ...names: string[]): Promise<string[]> => (await Promise.all(names.map((n) => ctx.driver.screenshot(n)))).filter((p): p is string => !!p);
const msg = (r: AgentResult | null | undefined): string => (r?.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' / ').slice(0, 400);

export const enterWorldStep: Step = {
  id: 'enter-world', title: 'Enter the world', required: true, timeoutMs: 420_000,
  async run(ctx) {
    const r = await ctx.driver.enterWorld();
    if (!r.ok) return fail(r.detail);
    const me = await self(ctx);
    if (!me) return fail('the page is in the world but the agent API has no character');
    ctx.state.character = me.name;
    return ok(`${r.detail}; in the world as ${me.name}, level ${me.level}, at ${me.coords ?? me.cell}`, { screenshots: await shots(ctx, 'enter-world') });
  },
};

const NO_KEY = /has no key bound|no key or keymap action/i;

export function panelStep(p: PanelSpec): Step {
  return {
    id: `panel-${p.id}`, title: `Open and close: ${p.title}`, timeoutMs: 60_000,
    async run(ctx) {
      const { driver } = ctx;
      await driver.call('close', ['all']);
      await driver.sleep(400);
      let used: string | null = null;
      const tried: string[] = [];
      for (const action of p.actions) {
        const r = await driver.call<AgentResult>('press', [action]);
        if (r.ok) { used = `${action}: ${r.message}`; break; }
        if (NO_KEY.test(r.message)) { tried.push(r.message); continue; }
        return fail(`pressing "${action}" failed: ${r.message}`);
      }
      if (!used && p.indicator) return indicatorPanel(ctx, p, tried);
      if (!used) return skip(`no key opens it in this era (${tried.join('; ')})`);
      await driver.sleep(900);
      const open = await driver.uiState();
      if (!open?.[p.flag]) return fail(`${used}, and the panel did not open (${p.flag} is ${String(open?.[p.flag])})`, { screenshots: await shots(ctx, `panel-${p.id}-not-open`) });
      const screenshots = await shots(ctx, `panel-${p.id}`);
      const tab = p.id === 'attributes' || p.id === 'skills' ? ` (character tab: ${String(open.charPanelTab)})` : p.id === 'fellowship' ? ` (social tab: ${String(open.socialTab)})` : '';
      const again = await driver.call<AgentResult>('press', [p.actions.find((a) => used!.startsWith(a))!]);
      await driver.sleep(900);
      const after = await driver.uiState();
      if (after?.[p.flag]) {
        await driver.call('close', ['all']);
        return fail(`opened with ${used}${tab}, but pressing it again (${again.message}) left it open`, { screenshots });
      }
      return ok(`opened with ${used}${tab}; the same key closed it`, { screenshots });
    },
  };
}

/** A panel with no key in this era, opened and closed by its HUD indicator, as that era's players did. */
async function indicatorPanel(ctx: StepContext, p: PanelSpec, tried: string[]): Promise<StepOutcome> {
  const { driver } = ctx;
  const first = await driver.clickIndicator(p.indicator!);
  if (!first.found) return skip(`no key opens it in this era (${tried.join('; ')}), and no ${p.indicator} indicator is drawn`);
  if (!first.lit) return skip(`no key opens it in this era; its indicator is unlit (nothing in effect), so it does not open`);
  await driver.sleep(900);
  if (!(await driver.uiState())?.[p.flag]) return fail(`clicked the lit ${p.indicator} indicator, and the panel did not open`, { screenshots: await shots(ctx, `panel-${p.id}-not-open`) });
  const screenshots = await shots(ctx, `panel-${p.id}`);
  await driver.clickIndicator(p.indicator!);
  await driver.sleep(900);
  if ((await driver.uiState())?.[p.flag]) {
    await driver.call('close', ['all']);
    return fail(`opened by its indicator, but a second click left it open`, { screenshots });
  }
  return ok(`opened by clicking the ${p.indicator} indicator (no key in this era); a second click closed it`, { screenshots });
}

export const vendorBuyStep: Step = {
  id: 'vendor-buy', title: 'Walk to a vendor and buy an item', timeoutMs: 240_000,
  async run(ctx) {
    const { driver } = ctx;
    const inView = async (): Promise<AgentObject[]> => {
      const o = await observe(ctx, { filter: 'vendor', radius: 400, max: 10 });
      return [...o.nearby, ...o.remembered].filter((x) => x.kind === 'vendor').sort((a, b) => a.dist - b.dist);
    };
    const pickVendor = (vs: AgentObject[], want?: string): AgentObject | undefined =>
      vs.find((x) => want !== undefined && x.name === want) ?? vs.find((x) => GENERAL_VENDOR.test(x.name)) ?? vs[0];
    let seen = await inView();
    let v: AgentObject | undefined = seen.find((x) => GENERAL_VENDOR.test(x.name));
    let walked = '';
    if (!v && ctx.vendorSpots?.length) {
      // A general goods vendor buys what we sell and sells the supplies: prefer one within 600 m to a specialist in view.
      const at = await driver.call<{ x: number; y: number } | null>('where');
      const gen = nearestVendorSpot(ctx.vendorSpots, at, 600, true);
      const seenNames = new Set(seen.map((x) => x.name));
      if (gen) {
        if (!seenNames.has(gen.name)) {
          const w = await driver.call<AgentResult>('walkTo', [cellTarget(gen.cell), { stopOnAggro: false }], 200_000);
          walked = ` (walked to the general vendor ${gen.name}'s room ${cellTarget(gen.cell)}, ${gen.dist.toFixed(0)} m, from the world data: ${msg(w)})`;
          seen = await inView();
        }
        v = pickVendor(seen, gen.name);
      }
    }
    if (!v) v = seen[0];
    if (!v) {
      // Shopkeepers stand indoors, out of view (or out of the server's range) from the start spot: walk to the nearest
      // one the era's world data places, into its room by its cell (walk_to routes through the building's door).
      // Run 2 of 2026-10-23 started in another Holtburg building (0xA9B00111) with Hudriffa (0xA9B00102) out of view.
      const spot = ctx.vendorSpots?.length ? nearestVendorSpot(ctx.vendorSpots, await driver.call<{ x: number; y: number } | null>('where')) : null;
      if (spot) {
        const w = await driver.call<AgentResult>('walkTo', [cellTarget(spot.cell), { stopOnAggro: false }], 200_000);
        walked = ` (walked to ${spot.name}'s room ${cellTarget(spot.cell)}, ${spot.dist.toFixed(0)} m, from the world data: ${msg(w)})`;
        v = pickVendor(await inView(), spot.name);
      }
    }
    if (!v) {
      // No world data: walk into the nearest town, as a player does.
      const town = nearestTown((await self(ctx))?.coords, ctx.era.towns);
      if (town) {
        const w = await driver.call<AgentResult>('walkTo', [town.at, { stopOnAggro: false }], 200_000);
        walked += ` (walked into ${town.name} at ${town.at} first: ${msg(w)})`;
        v = pickVendor(await inView());
      }
    }
    if (!v) return skip(`no vendor in view or remembered within 400 m${walked}`);
    const opened = await driver.call<AgentResult>('vendorAt', [v.guid, null], 200_000);
    if (!opened.ok) return fail(`${v.name} #${v.guid.toString(16)} (${v.dist.toFixed(0)} m): ${msg(opened)}`);
    ctx.state.vendor = { guid: v.guid, name: v.name };
    const screenshots = await shots(ctx, 'vendor-open');
    const me = await self(ctx);
    const pick = cheapestAffordable(parseVendorListing(opened.message), me?.pyreals);
    if (!pick) return skip(`${v.name} sells nothing ${me?.pyreals ?? 0} pyreals pay for`, { screenshots });
    const before = new Set((await driver.call<AgentItem[]>('inventory')).map((i) => i.guid));
    const bought = await driver.call<AgentResult>('buy', [pick.guid, 1, v.guid], 60_000);
    if (!bought.ok) return fail(`buying ${pick.name} (${pick.price}) from ${v.name}: ${msg(bought)}`, { screenshots });
    const fresh = (await driver.call<AgentItem[]>('inventory')).filter((i) => !before.has(i.guid));
    const got = fresh.find((i) => i.name.toLowerCase() === pick.name.toLowerCase()) ?? fresh[0];
    if (!got) return fail(`the buy of ${pick.name} answered "${msg(bought)}" but nothing new is in the pack`, { screenshots });
    ctx.state.bought = { guid: got.guid, name: got.name };
    return ok(`at ${v.name}${walked}: bought ${got.name} #${got.guid.toString(16)} for ${pick.price}`, { screenshots });
  },
};

/**
 * ACE's answer to a sell list holding an item the vendor won't take: an InventoryServerSaveFailed with WeenieError None
 * (0x0000) that nothing shows (Player_Commerce.HandleActionSellItem). Expected once a sale attempt was refused.
 */
export const refusedSaleEcho = (r: RefusalSeen): boolean => r.source === 'server' && r.context === 'inventory_failed' && r.code === 'we:0x0000' && r.sink === 'none';

/** Refusals a sale may get: a vendor that doesn't buy that kind. */
/** A use refused because the server had the target (a vendor mid-emote) or the player busy. */
export const VENDOR_BUSY = /too busy/i;
export const VENDOR_BUSY_WAIT_MS = 3_000;
const SALE_REFUSED = /cannot be sold|can't be sold|unsellable|not interested|doesn't (buy|want)|won't buy|no value/i;

/**
 * After a sale that went through: the era's silent 0xA0 echo (EraPlan.saleEchoesInventoryFailed): a server
 * InventoryServerSaveFailed with error 55 (0x37, "Unable to move to object!") that the player was not shown (sink none).
 * Shown anywhere, or any other code, it still fails the step.
 */
export function saleEcho(era: EraPlan): ((r: RefusalSeen) => boolean) | undefined {
  if (!era.saleEchoesInventoryFailed) return undefined;
  return (r) => r.source === 'server' && r.context === 'inventory_failed' && r.code === 'we:0x0037' && r.sink === 'none';
}

export const vendorSellStep: Step = {
  id: 'vendor-sell', title: 'Sell an item to the vendor', timeoutMs: 180_000,
  async run(ctx) {
    const { driver, state } = ctx;
    if (!state.vendor) return skip('no vendor window was opened');
    const inv = await driver.call<AgentItem[]>('inventory');
    const candidates = [
      ...(state.bought ? inv.filter((i) => i.guid === state.bought!.guid) : []),
      ...inv.filter((i) => i.where !== 'equipped' && INVENTORY_KINDS.sell(i) && i.guid !== state.bought?.guid),
    ].slice(0, 3);
    if (!candidates.length) return skip('nothing in the pack a vendor pays for');
    const tries: string[] = [];
    for (const it of candidates) {
      const r = await driver.call<AgentResult>('sell', [it.guid, null, state.vendor.guid], 60_000);
      if (r.ok) {
        const screenshots = await shots(ctx, 'vendor-sold');
        await driver.call('close', ['vendor']);
        const echo = saleEcho(ctx.era);
        return ok(`sold ${it.name} #${it.guid.toString(16)} to ${state.vendor.name}: ${msg(r)}${tries.length ? ` (after: ${tries.join('; ')})` : ''}`,
          { screenshots, allow: [SALE_REFUSED], allowRefusal: (x) => (tries.length > 0 && refusedSaleEcho(x)) || !!echo?.(x) });
      }
      if (!SALE_REFUSED.test(r.message)) return fail(`selling ${it.name}: ${msg(r)}`, { allow: [SALE_REFUSED] });
      tries.push(`${it.name}: ${msg(r)}`);
    }
    await driver.call('close', ['vendor']);
    return skip(`${state.vendor.name} buys none of ${candidates.map((c) => c.name).join(', ')}`, { allow: [SALE_REFUSED], allowRefusal: refusedSaleEcho });
  },
};

export const vendorSuppliesStep: Step = {
  id: 'vendor-supplies', title: 'Buy what the later steps use (healing kit, caster, food, scroll)', timeoutMs: 240_000,
  async run(ctx) {
    const { driver, state } = ctx;
    if (!state.vendor) { for (const k of SUPPLY_KINDS) state.supplies[k] = 'no vendor was found'; return skip('no vendor was found'); }
    let opened = await driver.call<AgentResult>('vendorAt', [state.vendor.guid, null], 200_000);
    // The AC1999 server refuses a use while the TARGET is mid-motion (UseChecked: the vendor's
    // "Thank you" after the sale), "You're too busy!", as it would the 1999 client; a player waits.
    const busy = !opened.ok && VENDOR_BUSY.test(opened.message);
    if (busy) {
      await driver.sleep(VENDOR_BUSY_WAIT_MS);
      opened = await driver.call<AgentResult>('vendorAt', [state.vendor.guid, null], 200_000);
    }
    const allow = busy ? [VENDOR_BUSY] : [];
    if (!opened.ok) {
      const still = VENDOR_BUSY.test(opened.message) ? ' (still "You\'re too busy!" after waiting: a real busy-state problem)' : '';
      return fail(`reopening ${state.vendor.name}${still}: ${msg(opened)}`, { allow });
    }
    // The window's own rows carry ItemType; the listing's text has names and prices only.
    const stock = (await driver.vendorStock()) ?? parseVendorListing(opened.message);
    const inv = await driver.call<AgentItem[]>('inventory');
    const plan = planSupplies(stock, inv, (await self(ctx))?.pyreals ?? 0);
    Object.assign(state.supplies, plan.why);
    const said: string[] = [];
    for (const { kind, row } of plan.buy) {
      const r = await driver.call<AgentResult>('buy', [row.guid, 1, state.vendor.guid], 60_000);
      if (!r.ok) {
        await driver.call('close', ['vendor']);
        return fail(`buying ${row.name} (${kind}, ${row.price}) from ${state.vendor.name}: ${msg(r)}`, { allow });
      }
      said.push(`${kind}: ${row.name} for ${row.price}`);
    }
    const screenshots = await shots(ctx, 'vendor-supplies');
    await driver.call('close', ['vendor']);
    const notBought = Object.entries(plan.why).map(([k, w]) => `${k}: ${w}`);
    const waited = busy ? ` (reopened after "too busy": waited ${VENDOR_BUSY_WAIT_MS / 1000} s)` : '';
    if (!said.length) return skip(`nothing to buy from ${state.vendor.name}${notBought.length ? ` (${notBought.join('; ')})` : ' (every kind already held)'}${waited}`, { screenshots, allow });
    return ok(`bought ${said.join(', ')}${notBought.length ? `; not bought: ${notBought.join('; ')}` : ''}${waited}`, { screenshots, allow });
  },
};

/** The agent's "nothing happened" end to an attack (AgentApi: no swings either way for 20 s). */
export const NO_SWINGS = /no swings either way/i;

export interface FightResult { outcome: 'killed' | 'retreated' | 'dead' | 'lost' | 'refused'; detail: string }

/** Fight one creature to its death, backing off below half health. `attackArgs` is the attack's options (a wand casts). */
export async function fight(ctx: StepContext, target: AgentObject, timeoutMs = 120_000): Promise<FightResult> {
  const { driver } = ctx;
  const r = await driver.call<AgentResult>('attack', [target.guid, {}], 60_000);
  if (!r.ok && !r.targetGone) return { outcome: 'refused', detail: msg(r) };
  if (r.targetGone) return { outcome: 'killed', detail: `it was already dead: ${msg(r)}` };
  const end = driver.now() + timeoutMs;
  let nudged = false;
  while (driver.now() < end) {
    const evs = await driver.call<Array<{ type: string; text: string; guid?: number }>>('waitFor', [{ types: ['target-died', 'death', 'vitals-low', 'target-lost'], healthBelow: 0.5 }, 4000], 15_000).catch(() => []);
    const me = await self(ctx);
    if (!me || me.dead || evs.some((e) => e.type === 'death')) return { outcome: 'dead', detail: 'the character died' };
    const died = evs.find((e) => e.type === 'target-died' && (e.guid === undefined || e.guid === target.guid));
    if (died) return { outcome: 'killed', detail: died.text };
    if (me.health.cur / Math.max(1, me.health.max) < 0.5) {
      const w = await driver.call<AgentResult>('walkTo', [awayFrom(target.bearing, 40), { flee: true, stopOnAggro: false }], 60_000).catch((e: Error) => ({ ok: false, message: e.message }));
      return { outcome: 'retreated', detail: `health fell to ${Math.round((100 * me.health.cur) / me.health.max)}%: backed off (${msg(w)})` };
    }
    if (evs.some((e) => e.type === 'target-lost')) return { outcome: 'lost', detail: evs.find((e) => e.type === 'target-lost')!.text };
    // An attack that stopped (the server ended the swings) is sent once more, as a player clicks again.
    if (!nudged && driver.now() > end - timeoutMs / 2) {
      nudged = true;
      const again = await driver.call<AgentResult>('attack', [target.guid, {}], 60_000);
      if (again.targetGone) return { outcome: 'killed', detail: msg(again) };
    }
  }
  return { outcome: 'lost', detail: `not dead after ${Math.round(timeoutMs / 1000)} s` };
}

async function findPrey(ctx: StepContext, exclude: number[] = []): Promise<{ prey: AgentObject | null; note: string }> {
  const o = await observe(ctx, { filter: 'monster', radius: 150, max: 40, levels: true });
  const places = await ctx.driver.placeOf(o.nearby.filter((x) => x.kind === 'monster').map((x) => x.guid));
  const p = pickPrey(o.nearby, ctx.facts, { exclude, sameFloor: (x) => sameFloorOnly(places.me, places.objects[x.guid] ?? 'unknown') });
  return { prey: p.prey, note: p.prey ? p.why : `no safe creature within 150 m${p.rejected.length ? ` (passed over: ${p.rejected.slice(0, 8).join('; ')})` : ' (none in view)'}` };
}

export const killStep: Step = {
  id: 'kill', title: 'Kill a weak creature near the start', timeoutMs: 240_000,
  async run(ctx) {
    const { prey, note } = await findPrey(ctx);
    if (!prey) return skip(note);
    ctx.log(`   prey: ${prey.name} #${prey.guid.toString(16)} ${prey.dist.toFixed(0)} m (${note})`);
    const f = await fight(ctx, prey);
    if (f.outcome === 'dead') return fail(`died fighting ${prey.name}: ${f.detail}`);
    if (f.outcome === 'refused') return fail(`the attack on ${prey.name} was refused: ${f.detail}`);
    // The attack never swinging at a reachable creature is a client fault until shown otherwise: a FAIL, said plainly.
    if (f.outcome === 'lost' && NO_SWINGS.test(f.detail)) return fail(`ATTACK NEVER SWUNG at ${prey.name} (${prey.dist.toFixed(0)} m, ${note}): ${f.detail}`);
    if (f.outcome !== 'killed') return skip(`${prey.name}: ${f.detail}`);
    await ctx.driver.sleep(2500);
    const c = await observe(ctx, { filter: 'corpse', radius: 40, max: 10 });
    const corpse = c.nearby.filter((x) => x.kind === 'corpse' && x.name.toLowerCase().includes(prey.name.toLowerCase())).sort((a, b) => a.dist - b.dist)[0];
    ctx.state.kill = { name: prey.name, guid: prey.guid, corpse: corpse?.guid ?? null };
    return ok(`killed ${prey.name} (${note}): ${f.detail}${corpse ? `; its corpse is #${corpse.guid.toString(16)}` : '; no corpse seen'}`, { screenshots: await shots(ctx, 'kill') });
  },
};

export const corpseOpenStep: Step = {
  id: 'corpse-open', title: 'Open the corpse', timeoutMs: 90_000,
  async run(ctx) {
    const g = ctx.state.kill?.corpse;
    if (!g) return skip(ctx.state.kill ? 'the kill left no corpse in view' : 'nothing was killed');
    const r = await ctx.driver.call<AgentResult>('use', [g, {}], 60_000);
    await ctx.driver.sleep(1500);
    const o = await observe(ctx, { max: 0 });
    const open = (o.windows ?? []).some((w) => w.startsWith('Container'));
    const screenshots = await shots(ctx, 'corpse-open');
    if (!r.ok || !open) return fail(`use of the corpse: ${msg(r)}; container window ${open ? 'open' : 'not open'}`, { screenshots });
    await ctx.driver.call('close', ['container']);
    return ok(`opened: ${msg(r)}`, { screenshots });
  },
};

export const lootWalkAwayStep: Step = {
  id: 'loot-walk-away', title: 'Start looting, then walk away mid-loot', timeoutMs: 120_000,
  async run(ctx) {
    const { driver } = ctx;
    const g = ctx.state.kill?.corpse;
    if (!g) return skip('no corpse to loot');
    const loot = driver.call<AgentResult>('loot', [g, null], 90_000).catch((e: Error) => ({ ok: false, message: e.message } as AgentResult));
    await driver.sleep(1800);
    const me = await self(ctx);
    const walk = await driver.call<AgentResult>('walkTo', [awayFrom(me?.heading ?? 0, 15), { stopOnAggro: false }], 60_000);
    const l = await loot;
    await driver.sleep(1500);
    const o = await observe(ctx, { max: 0 });
    const still = (o.windows ?? []).filter((w) => w.startsWith('Container'));
    return ok(`loot answered "${msg(l)}"; the walk away answered "${msg(walk)}"${still.length ? '; the container window is still open 15 m away' : '; the container window closed'}`, { screenshots: await shots(ctx, 'loot-walk-away') });
  },
};

export const lootRestStep: Step = {
  id: 'loot-rest', title: 'Go back and loot each item', timeoutMs: 150_000,
  async run(ctx) {
    const g = ctx.state.kill?.corpse;
    if (!g) return skip('no corpse to loot');
    const r = await ctx.driver.call<AgentResult>('loot', [g, null], 120_000);
    const screenshots = await shots(ctx, 'loot-rest');
    await ctx.driver.call('close', ['container']).catch(() => undefined);
    if (r.ok || /nothing|empty|no items/i.test(r.message)) return ok(msg(r), { screenshots });
    if (/not in view|rotted|no corpse/i.test(r.message)) return skip(msg(r), { screenshots });
    return fail(msg(r), { screenshots });
  },
};

const noneHeld = (ctx: StepContext, kind: SupplyKind, what = 'none held'): string =>
  `${what}${ctx.state.supplies[kind] ? ` (not bought: ${ctx.state.supplies[kind]})` : ''}`;

function useItemStep(id: string, title: string, supply: SupplyKind, kind: (i: AgentItem) => boolean, allow: RegExp): Step {
  return {
    id, title, timeoutMs: 60_000,
    async run(ctx) {
      const it = (await ctx.driver.call<AgentItem[]>('inventory')).find((i) => i.where !== 'equipped' && kind(i));
      if (!it) return skip(noneHeld(ctx, supply));
      const r = await ctx.driver.call<AgentResult>('use', [it.guid, {}], 45_000);
      await ctx.driver.sleep(1000);
      const screenshots = await shots(ctx, id);
      if (r.ok) return ok(`${it.name}: ${msg(r)}`, { screenshots, allow: [allow] });
      if (allow.test(r.message)) return ok(`${it.name}: refused as expected: ${msg(r)}`, { screenshots, allow: [allow] });
      return fail(`${it.name}: ${msg(r)}`, { screenshots, allow: [allow] });
    },
  };
}

export const readScrollStep = useItemStep('read-scroll', 'Read a scroll', 'scroll', INVENTORY_KINDS.scroll, /trained|already know|cannot learn|can't learn|not skilled|learn/i);
export const eatFoodStep = useItemStep('use-food', 'Use food', 'food', INVENTORY_KINDS.food, /full|already|don't need|no need/i);
export const healKitStep = useItemStep('use-healing-kit', 'Use a healing kit', 'kit', (i) => INVENTORY_KINDS.kit(i) && /heal/i.test(i.name), /full|already|don't need|no need|not hurt|trained/i);

/** The server's refusal of a cast for want of components (ACE YouDontHaveAllTheComponents). */
export const COMPONENTS_MISSING = /don't have all the components/i;

/** A cast's expected misses: a fizzle, a resist, too little mana, out of reach. */
const CAST_MISSES = /fizzle|resist|mana|out of range|too far|not enough|lack/i;

export const magicModeStep: Step = {
  id: 'magic-mode', title: 'Enter magic mode with a held caster', timeoutMs: 90_000,
  async run(ctx) {
    const { driver } = ctx;
    const caster = (await driver.call<AgentItem[]>('inventory')).find((i) => ((i.itemType ?? 0) & 0x8000) !== 0);
    if (!caster) return skip(noneHeld(ctx, 'caster', 'no caster (wand, staff, orb) held'));
    if (caster.where !== 'equipped') {
      const e = await driver.call<AgentResult>('equip', [caster.guid, null], 45_000);
      if (!e.ok) return fail(`equipping ${caster.name}: ${msg(e)}`);
    }
    ctx.state.caster = { guid: caster.guid, name: caster.name };
    const m = await driver.call<AgentResult>('combatMode', ['magic']);
    for (let i = 0; i < 10; i++) { await driver.sleep(500); if ((await self(ctx))?.combatMode === 'magic') break; }
    const me = await self(ctx);
    const screenshots = await shots(ctx, 'magic-mode');
    if (me?.combatMode !== 'magic') return fail(`asked for magic mode (${msg(m)}), and the mode is ${me?.combatMode}`, { screenshots });
    return ok(`${caster.name} wielded; in magic mode`, { screenshots });
  },
};

const spellsKnown = (ctx: StepContext): Promise<AgentSpell[]> => ctx.driver.call<AgentSpell[]>('spells', ['', 400]);

export const castAtCreatureStep: Step = {
  id: 'cast-creature', title: 'Select a spell and cast it at a creature', timeoutMs: 240_000,
  async run(ctx) {
    if (!ctx.state.caster) return skip('not in magic mode (no caster)');
    const atCreature = (await spellsKnown(ctx)).filter((s) => !s.self && !s.buff && ((s.targetType ?? 0x10) & 0x10) !== 0);
    const spell = atCreature.find((s) => /war/i.test(s.school)) ?? atCreature.find((s) => /life|creature/i.test(s.school));
    if (!spell) return skip('no spell known that is cast at a creature');
    const { prey, note } = await findPrey(ctx, ctx.state.kill ? [ctx.state.kill.guid] : []);
    if (!prey) return skip(note);
    // Into the spell's reach first, as a player walks up (the DM run cast from 45.6 m with a 33.5 m reach).
    let walked = '';
    if (spell.range && prey.dist > spell.range - 2) {
      const within = Math.max(4, Math.floor(spell.range - 4));
      const w = await ctx.driver.call<AgentResult>('walkTo', [prey.guid, { within, stopOnAggro: false }], 90_000);
      walked = ` (walked within ${within} m first: ${msg(w)})`;
    }
    const r = await ctx.driver.call<AgentResult>('cast', [spell.id, prey.guid, null], 60_000);
    const screenshots = await shots(ctx, 'cast-creature');
    if (!r.ok && COMPONENTS_MISSING.test(r.message)) {
      // Expected for a character with no components (the Dark Majesty run's); with components held, a real refusal.
      const held = (await ctx.driver.call<AgentItem[]>('inventory')).filter((i) => INVENTORY_KINDS.component(i));
      if (!held.length) return skip(`${spell.name}: the server wants components and the character holds none${walked}: ${msg(r)}`, { screenshots, allow: [CAST_MISSES, COMPONENTS_MISSING] });
      return fail(`${spell.name} at ${prey.name}: refused for components while holding ${held.map((i) => i.name).join(', ')}${walked}: ${msg(r)}`, { screenshots, allow: [CAST_MISSES] });
    }
    if (!r.ok && !CAST_MISSES.test(r.message) && !r.targetGone) return fail(`${spell.name} at ${prey.name}${walked}: ${msg(r)}`, { screenshots, allow: [CAST_MISSES] });
    // The creature comes at you now: finish it (a wand in hand, the attack casts).
    const f = await fight(ctx, prey);
    if (f.outcome === 'dead') return fail(`died fighting ${prey.name} after the cast: ${f.detail}`, { screenshots, allow: [CAST_MISSES] });
    return ok(`${spell.name} at ${prey.name} (${note})${walked}: ${msg(r)}; then ${f.outcome}: ${f.detail}`, { screenshots, allow: [CAST_MISSES] });
  },
};

export const castAtSelfStep: Step = {
  id: 'cast-self', title: 'Cast a spell at yourself', timeoutMs: 90_000,
  async run(ctx) {
    if (!ctx.state.caster) return skip('not in magic mode (no caster)');
    const spell = (await spellsKnown(ctx)).find((s) => s.self || (s.buff && ((s.targetType ?? 0x10) & 0x10) !== 0));
    if (!spell) return skip('no spell known that goes on yourself');
    const r = await ctx.driver.call<AgentResult>('cast', [spell.id, 'self', null], 60_000);
    const screenshots = await shots(ctx, 'cast-self');
    await ctx.driver.call('combatMode', ['peace']);
    if (r.ok || CAST_MISSES.test(r.message)) return ok(`${spell.name}: ${msg(r)}`, { screenshots, allow: [CAST_MISSES] });
    return fail(`${spell.name}: ${msg(r)}`, { screenshots, allow: [CAST_MISSES] });
  },
};

/** An NPC's no to a gift. */
const GIVE_REFUSED = /doesn't know what to do with that|not interested|doesn't want|does not want|won't accept|refus|can't be given|cannot be given|does not accept|isn't interested|no use for|hands? it back|gives? it back|action cancelled/i;

/**
 * Items worth trying to give: not worn or wielded, not attuned, worth something (a value-0 item is usually a quest or
 * starter item the server won't let go of: the 1999 Welcome Letter, "can't be given", WeenieError 0x3EF), and not a
 * kind a player keeps or this run still needs (money, packs, keys, components, writables, kits, casters, weapons).
 * Cheapest first.
 */
export function giveCandidates(inv: AgentItem[]): AgentItem[] {
  const keep = (i: AgentItem): boolean => i.where === 'equipped' || i.attuned === true || (i.value ?? 0) <= 0
    || INVENTORY_KINDS.money(i) || INVENTORY_KINDS.pack(i) || INVENTORY_KINDS.key(i) || INVENTORY_KINDS.weapon(i)
    || INVENTORY_KINDS.component(i) || ((i.itemType ?? 0) & 0x2000) !== 0 || INVENTORY_KINDS.kit(i);
  return inv.filter((i) => !keep(i)).sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
}

/** The server's no to the item itself (try another), as against the NPC's no to a gift it could take. */
const NOT_GIVEABLE = /can't be given|cannot be given/i;

/**
 * What each NPC takes, from the era's world data: an NPC's Give emotes (weenie_properties_emote category 6, ACE
 * EmoteCategory.Give) name the item classes it accepts (EmoteManager: a give whose item has a Give emote goes through;
 * any other is refused). Map of NPC name (lower case) → accepted weenie class ids.
 */
export type GiveTables = Map<string, Set<number>>;

export function parseGiveTable(text: string): { name: string; accepts: number[] } | null {
  if (!text.includes('/* Give */')) return null;
  const name = /\(\d+, *1, *'((?:[^'\\]|\\.|'')*)'\)/.exec(/INSERT INTO `weenie_properties_string`[\s\S]*?;\s*(?:\n|$)/.exec(text)?.[0] ?? '')?.[1]?.replace(/\\'|''/g, "'");
  if (!name) return null;
  const accepts = [...text.matchAll(/\(\d+,\s*6 \/\* Give \*\/,\s*[\d.]+,\s*(\d+)/g)].map((m) => Number(m[1]));
  return accepts.length ? { name, accepts } : null;
}

export function loadGiveTables(era: EraPlan, roots: string[]): GiveTables | null {
  if (!era.worldCore) return null;
  for (const root of roots) {
    const dir = join(root, era.worldCore, '9 WeenieDefaults/SQL');
    if (!existsSync(dir)) continue;
    const m: GiveTables = new Map();
    for (const f of sqlFiles(dir)) {
      const t = parseGiveTable(readFileSync(f, 'utf8'));
      if (!t) continue;
      const k = t.name.toLowerCase();
      const set = m.get(k) ?? new Set<number>();
      for (const w of t.accepts) set.add(w);
      m.set(k, set);
    }
    return m;
  }
  return null;
}

/** An NPC near and an item held that its Give emotes accept, or null. */
export function acceptedGift(npcs: AgentObject[], inv: AgentItem[], tables: GiveTables | null | undefined): { npc: AgentObject; item: AgentItem } | null {
  if (!tables) return null;
  for (const npc of [...npcs].sort((a, b) => a.dist - b.dist)) {
    const takes = tables.get(npc.name.toLowerCase());
    const item = takes && inv.find((i) => i.where !== 'equipped' && !i.attuned && i.wcid !== undefined && takes.has(i.wcid));
    if (item) return { npc, item };
  }
  return null;
}

export const giveStep: Step = {
  id: 'give-npc', title: 'Give an item to an NPC', timeoutMs: 180_000,
  async run(ctx) {
    const o = await observe(ctx, { filter: 'npc', radius: 80, max: 20 });
    const near = o.nearby.filter((x) => x.kind === 'npc');
    // Only real NPCs: a creature, not a player, not attackable (the EoR run gave to a Fletching Forge, the DM run to a
    // Tusker Shrine Statue: both answered "doesn't know what to do with that").
    const creatures = new Set(near.length ? await ctx.driver.npcCreatures(near.map((x) => x.guid)) : []);
    const npcs = near.filter((x) => creatures.has(x.guid)).sort((a, b) => a.dist - b.dist);
    if (!npcs.length) return skip(`no NPC creature within 80 m${near.length ? ` (passed over, not creatures: ${near.map((x) => x.name).join(', ')})` : ''}`);
    const inv = await ctx.driver.call<AgentItem[]>('inventory');
    // Something an NPC here takes, by the world data's Give emotes: the gift a quest would make.
    const match = acceptedGift(npcs, inv, ctx.giveTables);
    if (match) {
      // One of a stack (a beggar takes a Pyreal: never the whole purse).
      const r = await ctx.driver.call<AgentResult>('give', [match.item.guid, match.npc.guid, (match.item.stack ?? 1) > 1 ? 1 : null], 90_000);
      const screenshots = await shots(ctx, 'give-npc');
      if (r.ok) return ok(`gave ${match.item.name} to ${match.npc.name}, who takes it (a Give emote in the world data): ${msg(r)}`, { screenshots, allow: [GIVE_REFUSED] });
      return fail(`${match.npc.name} has a Give emote for ${match.item.name}, but the give answered: ${msg(r)}`, { screenshots, allow: [GIVE_REFUSED] });
    }
    const npc = npcs[0];
    // Attuned (PropertyInt 114) travels only in an appraisal: examine the candidates first, as a player would, so one the
    // server won't let go of (the 1999 Calling Stone, Welcome Letter: "can't be given") is left out.
    for (const it of giveCandidates(inv).filter((i) => !i.appraised).slice(0, 5)) {
      await ctx.driver.call('appraise', [it.guid], 20_000).catch(() => undefined);
    }
    await ctx.driver.call('close', ['examine']).catch(() => undefined);
    const items = giveCandidates(await ctx.driver.call<AgentItem[]>('inventory')).slice(0, 3);
    if (!items.length) return skip('nothing giveable held (only worn gear, money, packs, keys, weapons, components, writables, kits, casters, or items worth nothing)', { allow: [GIVE_REFUSED] });
    const tried: string[] = [];
    for (const item of items) {
      const r = await ctx.driver.call<AgentResult>('give', [item.guid, npc.guid, null], 90_000);
      if (r.ok) return ok(`gave ${item.name} to ${npc.name}: ${msg(r)}${tried.length ? ` (after: ${tried.join('; ')})` : ''}`, { screenshots: await shots(ctx, 'give-npc'), allow: [GIVE_REFUSED] });
      if (NOT_GIVEABLE.test(r.message)) { tried.push(`${item.name}: ${msg(r)}`); continue; }
      if (GIVE_REFUSED.test(r.message)) return ok(`${npc.name} turned down ${item.name} (nothing held is on its Give list): ${msg(r)}`, { screenshots: await shots(ctx, 'give-npc'), allow: [GIVE_REFUSED] });
      return fail(`giving ${item.name} to ${npc.name}: ${msg(r)}`, { screenshots: await shots(ctx, 'give-npc'), allow: [GIVE_REFUSED] });
    }
    return skip(`the server lets none of them be given: ${tried.join('; ')}`, { allow: [GIVE_REFUSED] });
  },
};

const UNKNOWN_COMMAND = /unknown command|not a valid command|unrecognized|invalid command|no such command|isn't a command/i;
const ownLine = (l: string): boolean => /^you (say|tell)\b/i.test(l);

export function chatCommandStep(cmd: string): Step {
  const id = `cmd-${cmd.replace(/^@/, '')}`;
  return {
    id, title: `Type ${cmd}`, timeoutMs: 30_000,
    async run(ctx) {
      const before = ctx.driver.peek().chat.length;
      await ctx.driver.chat(cmd);
      let reply: string[] = [];
      for (let i = 0; i < 12 && !reply.length; i++) {
        await ctx.driver.sleep(500);
        reply = ctx.driver.peek().chat.slice(before).filter((l) => !ownLine(l));
      }
      const screenshots = await shots(ctx, id);
      // Any answer is the command's own output (help text reads as refusals: "… is not allowed …").
      const allow = [/[\s\S]*/];
      if (!reply.length) return fail(`no answer to ${cmd} within 6 s`, { screenshots, allow });
      if (reply.some((l) => UNKNOWN_COMMAND.test(l))) return skip(`this era doesn't know ${cmd}: "${reply.find((l) => UNKNOWN_COMMAND.test(l))}"`, { screenshots, allow });
      return ok(`${reply.length} line${reply.length === 1 ? '' : 's'}: "${reply[0].slice(0, 160)}"${reply.length > 1 ? ' …' : ''}`, { screenshots, allow });
    },
  };
}

export function confirmNoStep(era: EraPlan): Step {
  const cmd = era.confirmCommand.text;
  return {
    id: `cmd-${cmd.replace(/^@/, '')}-no`, title: `Type ${cmd} and answer No`, timeoutMs: 45_000,
    async run(ctx) {
      const { driver } = ctx;
      const where0 = await driver.call<{ x: number; y: number } | null>('where');
      await driver.chat(cmd);
      let dialogs: Obs['dialogs'] = [];
      for (let i = 0; i < 12 && !dialogs.length; i++) { await driver.sleep(500); dialogs = (await observe(ctx, { max: 0 })).dialogs ?? []; }
      if (!dialogs.length) return fail(`${cmd}: no Yes / No question appeared within 6 s (${era.confirmCommand.why})`, { screenshots: await shots(ctx, 'confirm-missing') });
      const screenshots = await shots(ctx, 'confirm-dialog');
      const d = dialogs[dialogs.length - 1];
      const no = d.buttons.find((b) => /^no$/i.test(b)) ?? d.buttons.find((b) => /no|cancel/i.test(b));
      if (!no) return fail(`the question "${d.text}" has no No button (buttons: ${d.buttons.join(', ')})`, { screenshots });
      const r = await driver.call<AgentResult>('dialog', [no, null]);
      await driver.sleep(3000);
      const left = (await observe(ctx, { max: 0 })).dialogs ?? [];
      const me = await self(ctx);
      const where1 = await driver.call<{ x: number; y: number } | null>('where');
      const moved = where0 && where1 ? Math.hypot(where1.x - where0.x, where1.y - where0.y) : 0;
      if (!r.ok) return fail(`pressing ${no}: ${msg(r)}`, { screenshots });
      if (left.some((x) => x.text === d.text)) return fail(`the question is still open after ${no}`, { screenshots });
      if (me?.dead || moved > 20) return fail(`answered ${no}, and the character ${me?.dead ? 'died' : `moved ${moved.toFixed(0)} m`} anyway`, { screenshots });
      return ok(`"${d.text}" [${d.buttons.join('/')}]: answered ${no}; nothing happened`, { screenshots });
    },
  };
}

export const logoutAndBackStep: Step = {
  id: 'logout-relogin', title: 'Log out to character select and back in', timeoutMs: 240_000,
  async run(ctx) {
    const { driver } = ctx;
    const name = ctx.state.character;
    if (!name) return fail('no character name to enter with');
    await driver.call('logout');
    let p = await driver.probe();
    for (let i = 0; i < 120 && p.screen !== 'character-select'; i++) { await driver.sleep(500); p = await driver.probe(); }
    if (p.screen !== 'character-select') return fail(`not at character select 60 s after logging out (screen: ${p.screen})`, { screenshots: await shots(ctx, 'logout-stuck') });
    const screenshots = await shots(ctx, 'character-select');
    const r = await driver.call<AgentResult>('enterWorld', [name], 120_000);
    if (!r.ok) return fail(`entering again as ${name}: ${msg(r)}`, { screenshots });
    await driver.sleep(3000);
    p = await driver.probe();
    if (p.screen !== 'world') return fail(`entered (${msg(r)}), but the screen is ${p.screen}`, { screenshots });
    return ok(`at character select, then back in: ${msg(r)}`, { screenshots: [...screenshots, ...(await shots(ctx, 'back-in-world'))] });
  },
};

/** The whole first hour, in a new player's order, for one era. */
export function playthroughSteps(era: EraPlan): Step[] {
  return [
    enterWorldStep,
    ...era.panels.map(panelStep),
    vendorBuyStep,
    vendorSellStep,
    vendorSuppliesStep,
    killStep,
    corpseOpenStep,
    lootWalkAwayStep,
    lootRestStep,
    readScrollStep,
    eatFoodStep,
    healKitStep,
    magicModeStep,
    castAtCreatureStep,
    castAtSelfStep,
    panelStep(EFFECTS_PANEL),
    giveStep,
    chatCommandStep('@help'),
    chatCommandStep('@loc'),
    chatCommandStep('@version'),
    confirmNoStep(era),
    logoutAndBackStep,
  ];
}

/** The steps to run: all, or `only` (the world entry always runs first). */
export function selectSteps(all: Step[], only: string[] | null): Step[] {
  if (!only) return all;
  const unknown = only.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown step id(s): ${unknown.join(', ')} (have: ${all.map((s) => s.id).join(', ')})`);
  return all.filter((s) => s.required || only.includes(s.id));
}

export const freshState = (): RunState => ({ character: null, vendor: null, bought: null, kill: null, caster: null, supplies: {} });
