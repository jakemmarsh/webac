/**
 * The agent tool table — one definition per tool, shared by the MCP server
 * (mcp-server.ts: each entry becomes an MCP tool) and the CLI (cli.ts: each
 * entry becomes a subcommand with key=value args). Add a tool here and both
 * front ends get it.
 */
import {
  filterInventory, formatEvents, formatInventory, formatInventoryFiltered, formatObservation, formatSpells, formatTrace, packSlotsText,
} from '../../packages/renderer/src/agent/format.ts';
import type { AgentEvent, AgentItem, AgentPackSlots, AgentObservation, AgentResult, AgentSpell, AgentStatus, AgentTracePoint } from '../../packages/renderer/src/agent/types.ts';
import { formatGear } from '../../packages/renderer/src/agent/gear.ts';
import { AgentClient, DEFAULT_PROFILE, requireClient, startDaemon } from './client.ts';
import { listInfos, type DaemonInfo } from './state.ts';
import { AGENT_ERAS, ERA_IDS } from './eras.ts';
import { NOTE_KINDS, type Journal, type NoteKind, addNote, formatJournal, loadJournal, saveJournal } from './journal.ts';
import { RoutineStore } from './routineStore.ts';
import { encodeWindows1252 } from '../../packages/shared/src/encoding/Windows1252.ts';
import { EXAMPLE_HUNT_PROFILE, ROUTINE_SCHEMA_VERSION, explainProfile, exportVTankFile, importVTankFiles, validateRoutineDoc, type RoutineDoc, type RoutineProfile } from '../../packages/shared/src/routines/index.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { findDaemon } from './client.ts';

const journalOf = (info: DaemonInfo) => loadJournal(info.era ?? 'eor', info.account, info.character);

export interface ToolOutput {
  text: string;
  jpegBase64?: string;
  isError?: boolean;
}

type Props = Record<string, { type: 'string' | 'number' | 'boolean'; description: string; enum?: string[] }>;

export interface AgentTool {
  name: string;
  description: string;
  props: Props;
  required?: string[];
  /** Other names an argument goes by (alias → the argument), e.g. pick_up's target= for item= (argAliases). */
  aliases?: Record<string, string>;
  run(args: Record<string, any>): Promise<ToolOutput>;
}

const PROFILE_PROP = { profile: { type: 'string' as const, description: `Session profile (default "${DEFAULT_PROFILE}"; only needed when several are running)` } };

/** A guid argument: "#1a2b", "0x1a2b", "1a2b" (hex, as observe prints them) or a decimal number. */
export function parseGuid(v: unknown): number {
  if (typeof v === 'number') return v >>> 0;
  const s = String(v ?? '').trim().replace(/^#/, '');
  if (!s) throw new Error('missing guid');
  const n = /^0x/i.test(s) || /[a-f]/i.test(s) || s.length >= 6 ? parseInt(s.replace(/^0x/i, ''), 16) : parseInt(s, 10);
  if (!Number.isFinite(n)) throw new Error(`bad guid: ${v}`);
  return n >>> 0;
}

/** A target that is a guid or a name to search for nearby. */
function guidOrName(v: unknown): number | string {
  const s = String(v ?? '').trim();
  // An object id in decimal (a JSON number: 2147494839 is 0x80002AB7): nine or ten digits are never an 8-digit hex id.
  if (/^\d{9,10}$/.test(s) && Number(s) <= 0xffffffff) return Number(s);
  return /^(#|0x)?[0-9a-f]+$/i.test(s) && (/^(#|0x)/i.test(s) || s.length >= 6) ? parseGuid(s) : s;
}

/**
 * The longest one ac_wait runs, in seconds. The stream players' Bash tool gives up on a command at 120 s and
 * backgrounds it (a `wait timeout_s=120`, 2026-10-16), so a wait plus the CLI's start-up and the RPC's 5 s margin
 * stays well under that. The hosted connector caps lower still (its maxWaitMs).
 */
export const AC_WAIT_MAX_S = 100;

// A target that died or went before the cast or swing (targetGone) is an expected outcome, not an error: the CLI's exit
// code stays 0 and MCP's isError unset ("gone from view" read as a failure in a stream player's Bash, 2026-10-16 12:53).
export const result = (r: AgentResult): ToolOutput => ({ text: r.message, isError: !r.ok && !r.targetGone });

/**
 * What a game tool calls: one agent-API method by name. The local daemon
 * (AgentClient) is the default; the bridge's hosted connector swaps in its
 * relay to the player's own tab (useCaller), so one tool table serves both.
 */
export interface ToolCaller {
  call<T = unknown>(method: string, args?: unknown[], timeoutMs?: number): Promise<T>;
  notice: string | null;
  /** The hosted connector's own view of this connection (ac_status): the bridge knows it without asking the tab. */
  connection?(): HostedConnection;
  /** The longest ac_wait this caller allows (the hosted connector caps it below the client's tool timeout). */
  maxWaitMs?: number;
  /** Hosted, several linked tabs (multiboxing): the caller for the tab a tool's `account` names. */
  forTab?(name: string): ToolCaller;
}

/** What the bridge knows about a hosted connection (docs/hosted-agent-connector.md §3, ac_status). */
export interface HostedConnection {
  account: string;
  /** The characters this grant may play ('any', or the names). */
  characters: 'any' | string[];
  /** none: no logged-in tab; off: a tab with Claude switched off; on: Claude can play it. */
  tab: 'none' | 'off' | 'on';
  character: string | null;
  screen: string | null;
  /** Multiboxing: every tab this connection plays (tools take account= to pick one). */
  linked?: Array<{ account: string; tab: 'none' | 'off' | 'on'; character: string | null; screen: string | null }>;
}

/** ac_status's text, from the bridge's view and the tab's own (either can be missing). */
export function formatStatus(conn: HostedConnection | null, tab: AgentStatus | null, tabError: string | null): string {
  const lines: string[] = [];
  if (conn?.linked && conn.linked.length > 1) {
    // Multiboxing: every linked tab, then this one's detail.
    lines.push(`this connection plays ${conn.linked.length} accounts, one tab each; pass account= to pick (the account, or its character in the world):`);
    for (const l of conn.linked) lines.push(`  ${l.account}: ${l.tab === 'none' ? 'not open' : l.tab === 'off' ? 'open, Claude switched off' : l.character ? `in the world as ${l.character}` : (l.screen ?? 'open')}`);
  }
  if (conn) {
    lines.push(`account ${conn.account}; this connection plays ${conn.characters === 'any' ? 'any of its characters' : `only ${conn.characters.join(', ')}`}`);
    if (conn.tab === 'none') lines.push('game: not open. The player logs in at playwebac.com in a browser tab; Claude cannot log in.');
    else if (conn.tab === 'off') lines.push('game: open, but Claude is switched off in that tab (the player types /automation pair or /automation claude)');
  }
  if (tab) {
    lines.push(`screen: ${tab.screen}${tab.character ? `; in the world: ${tab.character}` : ''}`);
    if (tab.screen === 'character-select') {
      const chars = tab.characters.filter((c) => !c.pendingDeletion).map((c) => c.name);
      lines.push(chars.length ? `characters: ${chars.join(', ')}. Enter with ac_enter_world.` : 'no characters on this account (Claude does not create characters)');
    }
    if (tab.goal) lines.push(`goal: ${tab.goal}`);
    if (tab.control === 'player') lines.push('control: the player took over. Acting calls are refused until they have been idle 60 s; reading still works.');
    else if (tab.control === 'paused') lines.push('control: paused by the player. Every call is refused until they type /automation resume.');
  } else if (tabError && (!conn || conn.tab === 'on')) lines.push(`game: ${tabError}`);
  return lines.join('\n');
}
/** The caller for this request when one is set (the hosted connector runs each MCP call inside one). */
export const TOOL_CALLER = new AsyncLocalStorage<ToolCaller>();
/** Hosted: the connection's caller, or the linked tab `profile` (the hosted tools' `account`) names. Local: that daemon. */
const callerFor = (profile?: string): ToolCaller => {
  const hosted = TOOL_CALLER.getStore();
  if (hosted) return profile && hosted.forTab ? hosted.forTab(profile) : hosted;
  return requireClient(profile);
};
/** The tools that need the local daemon itself (its browser, its files): not served by the hosted connector. */
export const LOCAL_ONLY_TOOLS = new Set(['ac_start', 'ac_stop', 'ac_sessions', 'ac_click']);
/**
 * The hosted connector serves every other tool through the player's tab
 * (Jake, 2026-10-10: "why doesn't it have all the same tools as the CLI"):
 * the screenshot is the tab's own 3D view, the journal lives in the player's
 * browser, routines in the game's routine store. Left out: starting or
 * stopping a session (that is the player's login; ac_status and
 * ac_enter_world stand in) and ac_click (the tab's screenshot has no UI to
 * aim at).
 */
const isHosted = (): boolean => !!TOOL_CALLER.getStore()?.connection;

/** A screenshot: the local daemon's browser window, or (hosted) the tab's own 3D view. */
async function screenshotOf(c: ToolCaller, profile?: string): Promise<string> {
  return isHosted() ? c.call<string>('screenshot') : requireClient(profile).screenshot();
}

/** The character's journal and where it is kept: the daemon's files, or (hosted) the player's browser. */
async function journalFor(c: ToolCaller, profile?: string): Promise<{ j: Journal; save(j: Journal): Promise<void> }> {
  if (!isHosted()) {
    const info = requireClient(profile).info;
    return { j: journalOf(info), save: async (x) => saveJournal(x) };
  }
  const st = await c.call<AgentStatus>('status');
  const stored = await c.call<Journal | null>('journalLoad');
  const j: Journal = stored ?? { character: st.character ?? 'unknown', account: c.connection?.().account ?? '', era: 'live', notes: [] };
  return { j, save: async (x) => { await c.call('journalSave', [x]); } };
}

type RoutinesPut = { ok: true; doc: RoutineDoc } | { ok: false; issues: Array<{ path: string; message: string }> };
/** An account's routines for this caller: the local files, or (hosted) the game's own routine store through the tab. */
function hostedRoutines(c: ToolCaller): { label: string; get(): Promise<RoutineDoc>; put(doc: unknown): Promise<RoutinesPut> } {
  type Sync = { ok: true; doc: unknown } | { ok: false; message: string; issues?: Array<{ path: string; message: string }> };
  return {
    label: 'your game',
    get: async () => {
      const r = await c.call<Sync>('routinesLoad');
      if (!r.ok) throw new Error(r.message);
      return r.doc as RoutineDoc;
    },
    put: async (doc) => {
      const issues = validateRoutineDoc(doc);
      if (issues.length) return { ok: false, issues };
      const r = await c.call<Sync>('routinesSave', [doc]);
      return r.ok ? { ok: true, doc: r.doc as RoutineDoc } : { ok: false, issues: r.issues ?? [{ path: '', message: r.message }] };
    },
  };
}

/** Put a pending "the session reloaded" notice in front of a tool's output. */
function withNotice(c: ToolCaller, out: ToolOutput): ToolOutput {
  if (!c.notice) return out;
  const n = c.notice;
  c.notice = null;
  return { ...out, text: `NOTE: ${n}\n\n${out.text}` };
}

function act(name: string, description: string, props: Props, required: string[], toArgs: (a: Record<string, any>) => unknown[], timeoutMs = 120_000): AgentTool {
  return {
    name, description, props: { ...props, ...PROFILE_PROP }, required,
    async run(a) {
      const c = callerFor(a.profile);
      return withNotice(c, result(await c.call<AgentResult>(name.replace(/^ac_/, '').replace(/_([a-z])/g, (_, x) => x.toUpperCase()), toArgs(a), timeoutMs)));
    },
  };
}

/** ac_cast's repeat arguments as the page's CastRepeatOptions (null: a single cast). */
export function castRepeatArgs(a: Record<string, any>): { repeat: true; untilHealth?: number; maxCasts?: number; maxMs?: number } | null {
  if (!(a.repeat === true || a.repeat === 'true')) return null;
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const h = num(a.until_health), n = num(a.max_casts), t = num(a.max_s);
  // A fraction (0.4) or a percent (40), as vitals_below takes: until_health=0.4 was read as 0.4% (2026-10-12).
  const frac = h === undefined ? undefined : Math.min(Math.max(h > 1 ? h / 100 : h, 0), 1);
  return { repeat: true, ...(frac !== undefined ? { untilHealth: frac } : {}), ...(n !== undefined ? { maxCasts: n } : {}), ...(t !== undefined ? { maxMs: t * 1000 } : {}) };
}

/**
 * AC_AGENT_ATTACH (e.g. "chrome", set in Claude Desktop's config) makes a bare ac_start play the human's own
 * logged-in character on the live servers; naming a local-server choice (era, base, profile, a new
 * character) still starts a local test session.
 */
export function defaultAttach(a: Record<string, unknown>, env: string | undefined = process.env.AC_AGENT_ATTACH): string | undefined {
  if (!env) return undefined;
  const local = ['era', 'base', 'profile', 'character', 'template', 'heritage', 'gender', 'town', 'seed', 'attributes', 'skills', 'headless'].some((k) => a[k] !== undefined);
  return local ? undefined : env;
}

/** A tell someone sent you: the wait's line for "tell" (your own "You tell …" echo is a (tell) line too). */
export const INCOMING_TELL = '^\\(tell\\) (?!You tell\\b)';
/** Your own speech as the wait sees it: "(say) You say, …", "(channel) [Fellowship] You say, …", "(tell) You tell …". */
const OWN_SPEECH = '\\([\\w-]+\\) (?:\\[[^\\]]*\\] )?You (?:say|tell)\\b';

/**
 * ac_wait's arguments as the page's wait filter. "tell" (and "tells") is not an event type but the
 * tool lists it: it means a tell someone sent you, so it waits for those (a types=tell wait never
 * woke, 2026-10-10); beside "chat" it adds nothing. Other names pass through.
 *
 * chat_match wakes on chat lines matching it, never on your own speech (a wait for "Arcanist" woke on
 * Bulwark's own "You tell Claude Arcanist, …", 2026-10-13). With "tell" it is OR, as the tool says
 * ("with types it also wakes on those types"): a tell from anyone OR a matching line. It used to be
 * AND (a tell that also matched), so the stream brief's `types=…,tell chat_match="] <partner> says"`
 * slept through every one of the partner's /f lines and woke on no tell either ("missed chat wakeups",
 * second stream rehearsal 2026-10-13).
 */
export function waitFilter(a: Record<string, any>): { types?: string[]; chatMatch?: string; sinceSeq?: number; healthBelow?: number; manaBelow?: number; staminaBelow?: number; fellowBelow?: number } {
  let types = a.types ? String(a.types).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
  const raw: string | undefined = a.chat_match === undefined || a.chat_match === '' ? undefined : String(a.chat_match);
  // An invalid regex is matched as plain text (the page's own fallback can't see inside the wrapper below).
  const valid = (re: string): boolean => { try { new RegExp(re, 'i'); return true; } catch { return false; } };
  const userMatch = raw === undefined ? undefined : valid(raw) ? raw : raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Lookaheads from the line's start, so the player's own pattern (anchors, alternation) means what it says.
  let chatMatch = userMatch === undefined ? undefined : `^(?!${OWN_SPEECH})(?=[\\s\\S]*?(?:${userMatch}))`;
  if (types?.some((t) => t === 'tell' || t === 'tells')) {
    const anyChat = types.includes('chat');
    types = types.filter((t) => t !== 'tell' && t !== 'tells');
    // "chat" already wakes on every line, a tell included. Narrowing chat to tells there made a
    // types=chat,tell wait sleep through fellowship lines (Arcanist, 2026-10-11).
    if (!anyChat) chatMatch = chatMatch ? `${INCOMING_TELL}|${chatMatch}` : INCOMING_TELL;
    if (!types.length) types = undefined;
  }
  const since = a.since_seq === undefined || a.since_seq === '' ? undefined : Number(a.since_seq);
  // A vital mark as a fraction (0.6) or a percentage (60).
  const mark = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.min(n > 1 ? n / 100 : n, 1);
  };
  const marks = { healthBelow: mark(a.vitals_below ?? a.health_below), manaBelow: mark(a.mana_below), staminaBelow: mark(a.stamina_below) };
  if (types && Object.values(marks).some((m) => m !== undefined) && !types.includes('vitals-low')) types = [...types, 'vitals-low'];
  // A fellow's health mark: a fellow-low wait.
  const fellowBelow = mark(a.fellow_below);
  if (types && fellowBelow !== undefined && !types.includes('fellow-low')) types = [...types, 'fellow-low'];
  return {
    ...(types ? { types } : {}), ...(chatMatch ? { chatMatch } : {}), ...(since !== undefined && Number.isFinite(since) ? { sinceSeq: since } : {}),
    ...Object.fromEntries(Object.entries(marks).filter(([, m]) => m !== undefined)),
    ...(fellowBelow !== undefined ? { fellowBelow } : {}),
  };
}

async function observeText(c: ToolCaller, a: Record<string, any>): Promise<string> {
  const obs = await c.call<AgentObservation>('observe', [{ radius: a.radius, max: a.max, filter: a.filter }]);
  return formatObservation(obs);
}

/**
 * ac_routines action=export: one of a profile's VirindiTank files as text (kind met | nav | utl | usd | af;
 * which= a route or loot set), so Claude can hand a player their .met / .nav / .utl, its .usd settings, or
 * its meta (or, with which=, a route) in metaf's .af form. The file's text follows a "--- name ---" line, after
 * what it couldn't hold.
 */
export function exportRoutineFile(doc: RoutineDoc, a: Record<string, any>): ToolOutput & { file?: { name: string; text: string } } {
  const kind = String(a.kind ?? 'met').toLowerCase();
  if (kind !== 'met' && kind !== 'nav' && kind !== 'utl' && kind !== 'usd' && kind !== 'af') return { text: 'kind must be met, nav, utl, usd or af', isError: true };
  const want = a.name ? String(a.name).toLowerCase() : null;
  const p = want ? doc.profiles.find((x) => x.name.toLowerCase() === want) : doc.profiles.length === 1 ? doc.profiles[0] : null;
  if (!p) return { text: want ? `no profile "${a.name}" (have: ${doc.profiles.map((x) => x.name).join(', ') || 'none'})` : `pass name= (the profile; have: ${doc.profiles.map((x) => x.name).join(', ') || 'none'})`, isError: true };
  // No game here to name a .usd's items and spells: what the profile kept by id is written back as it was.
  const f = exportVTankFile(p, kind, a.which === undefined || a.which === '' ? undefined : String(a.which));
  if (!f) return { text: kind === 'nav' || kind === 'af' ? `"${p.name}" has no route${a.which ? ` "${a.which}"` : 's'} (have: ${p.routes.map((r) => r.name).join(', ') || 'none'})` : `"${p.name}" has no loot set "${a.which}" (have: ${Object.keys(p.lootSets ?? {}).join(', ') || 'only its own rules'})`, isError: true };
  const head = f.problems.length ? [`not carried over exactly (${f.problems.length}):`, ...f.problems.map((x) => `  ${x}`)] : ['everything carried over'];
  return { text: [`${f.fileName} from "${p.name}"`, ...head, '', `--- ${f.fileName} ---`, f.text].join('\n'), file: { name: f.fileName, text: f.text } };
}

/** ac_routines through the hosted connector: the account's routines in the player's own game, text in place of files. */
async function hostedRoutinesTool(c: ToolCaller, a: Record<string, any>): Promise<ToolOutput> {
  const store = hostedRoutines(c);
  const account = c.connection?.().account ?? 'this account';
  const action = routinesAction(a.action);
  if (action === 'example') return { text: JSON.stringify(EXAMPLE_HUNT_PROFILE, null, 2) };
  const parseDoc = (): { body: unknown } | ToolOutput => {
    if (!a.doc) return { text: 'pass doc= (the whole routine document as JSON text)', isError: true };
    try { return { body: JSON.parse(String(a.doc)) }; } catch (e) { return { text: `doc is not JSON: ${(e as Error).message}`, isError: true }; }
  };
  if (action === 'validate') {
    const f = parseDoc();
    if (!('body' in f)) return f;
    const issues = validateRoutineDoc(f.body);
    return issues.length ? { text: issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n'), isError: true } : { text: 'valid' };
  }
  const doc = await store.get();
  const pick = (n?: string) => doc.profiles.filter((p) => !n || p.name.toLowerCase() === String(n).toLowerCase());
  if (action === 'list') {
    return { text: doc.profiles.length
      ? `${account}:\n${doc.profiles.map((p) => `  ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')}${doc.characters ? `\ncharacters: ${Object.entries(doc.characters).map(([k, v]) => `${k} → ${v}`).join(', ')}` : ''}`
      : `${account} has no routines yet (start from: ac_routines action=example)` };
  }
  if (action === 'show') return { text: JSON.stringify(a.name ? pick(a.name)[0] ?? null : doc, null, 2) };
  if (action === 'export') { const { file: _f, ...out } = exportRoutineFile(doc, a); return out; }
  if (action === 'explain') {
    const ps = pick(a.name);
    return { text: ps.length ? ps.map(explainProfile).join('\n\n') : `no profile${a.name ? ` "${a.name}"` : 's'} for ${account}` };
  }
  if (action === 'set') {
    const f = parseDoc();
    if (!('body' in f)) return f;
    const r = await store.put(f.body);
    return r.ok
      ? { text: `stored ${r.doc.profiles.length} profile(s) in ${store.label}\n\n${r.doc.profiles.map(explainProfile).join('\n\n')}` }
      : { text: `not stored:\n${r.issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
  }
  if (action === 'import') {
    let files: Array<{ name: string; text: string }>;
    try { files = JSON.parse(String(a.files_json ?? '')); } catch { return { text: 'pass files_json= ([{"name":"Hunt.met","text":"…"}], each VirindiTank file\'s text)', isError: true }; }
    if (!Array.isArray(files) || !files.every((f) => f && typeof f.name === 'string' && typeof f.text === 'string')) return { text: 'files_json must be [{"name","text"}, …]', isError: true };
    const name = String(a.name ?? files.find((f) => /\.(met|af|usd)$/i.test(f.name))?.name.replace(/^.*[\\/]/, '').replace(/\.(met|af|usd)$/i, '') ?? 'Imported');
    const base = doc.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
    const r = importVTankFiles(files, base, base?.name ?? name);
    const put = await store.put({ ...doc, profiles: [...doc.profiles.filter((p) => p !== base), r.value] });
    if (!put.ok) return { text: `not stored:\n${put.issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
    return { text: [`imported into "${r.value.name}" in ${store.label}`, ...(r.problems.length ? ['', `not carried over exactly (${r.problems.length}):`, ...r.problems.slice(0, 40).map((x) => `  ${x}`)] : []), '', explainProfile(r.value)].join('\n') };
  }
  return { text: `unknown action "${action}" (${ROUTINES_ACTIONS.join(', ')})`, isError: true };
}

/**
 * ac_routine file=: one profile from a JSON file (a profile, or a routine document with `name` picking one of its
 * profiles), checked as a stored one would be (validateRoutineDoc). The stream players' ready profiles
 * (tools/stream/routines/) start this way in one call, nothing stored.
 */
export function routineFromFile(path: string, name?: string): { profile: RoutineProfile } | { text: string; isError: true } {
  let body: unknown;
  try { body = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { text: `can't read ${path}: ${(e as Error).message}`, isError: true }; }
  const isDoc = !!body && typeof body === 'object' && Array.isArray((body as { profiles?: unknown }).profiles);
  const doc = isDoc ? body : { schemaVersion: ROUTINE_SCHEMA_VERSION, account: 'file', server: 'file', updatedAt: new Date(0).toISOString(), profiles: [body] };
  const issues = validateRoutineDoc(doc);
  if (issues.length) return { text: `${path}: not a routine profile:\n${issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
  const ps = (doc as RoutineDoc).profiles;
  const p = name ? ps.find((x) => x.name.toLowerCase() === name.toLowerCase()) : ps.length === 1 ? ps[0] : undefined;
  if (!p) return { text: `${path}: ${name ? `no profile "${name}"` : 'pass name='} (have: ${ps.map((x) => x.name).join(', ')})`, isError: true };
  return { profile: p };
}

/** ac_routine set=: "Name=value, Name=value" as settings (numbers and true/false typed). */
export function routineSettings(raw: unknown): { settings: Record<string, string | number | boolean> } | { text: string; isError: true } {
  const out: Record<string, string | number | boolean> = {};
  if (raw === undefined || raw === null || String(raw).trim() === '') return { settings: out };
  for (const part of String(raw).split(',').map((x) => x.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    if (at <= 0) return { text: `set: "${part}" is not Name=value (e.g. set="Recharge-Norm-HitP=70,AttackDistance=20")`, isError: true };
    const k = part.slice(0, at).trim(), v = part.slice(at + 1).trim();
    out[k] = /^(true|false)$/i.test(v) ? /^true$/i.test(v) : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return { settings: out };
}

/** ac_routines' actions; list is what a bare `routines` does (both stream players typed `./ac routines`, 2026-10-16). */
export const ROUTINES_ACTIONS = ['list', 'show', 'explain', 'example', 'validate', 'set', 'import', 'export'] as const;
/** ac_routine's actions; status is what a bare `routine` does. */
export const ROUTINE_ACTIONS = ['run', 'pause', 'resume', 'stop', 'status', 'dryrun'] as const;
/** The action asked for, or the default when none was given ("unknown action undefined" before, 2026-10-16). */
export function routinesAction(a: unknown, fallback = 'list'): string {
  return a === undefined || a === null || String(a).trim() === '' ? fallback : String(a).trim().toLowerCase();
}

/**
 * The required arguments a call left out, with a usage line: the MCP clients check the schema, the CLI didn't, so
 * `./ac raise` sent the stat "undefined" and `./ac routines` read as action "undefined" (2026-10-16). Null: all there.
 */
export function missingRequired(t: AgentTool, args0: Record<string, unknown>): string | null {
  const a = withArgAliases(t, args0);
  const missing = (t.required ?? []).filter((k) => a[k] === undefined || a[k] === null || a[k] === '');
  if (!missing.length) return null;
  return `${t.name}: missing ${missing.join(', ')} (usage: ${usageLine(t)})`;
}

/** "raise stat=… [times=…]": a tool's arguments as the CLI takes them (required bare, optional in brackets). */
export function usageLine(t: AgentTool): string {
  const aliases = argAliases(t);
  const args = Object.keys(t.props).filter((k) => k !== 'profile' && !(k in aliases)).map((k) => ((t.required ?? []).includes(k) ? `${k}=…` : `[${k}=…]`)).join(' ');
  return `${t.name.replace(/^ac_/, '')} ${args}`;
}

/** Argument names players reach for that mean the same thing (a group's words point at whichever one a tool takes). */
const ARG_SYNONYMS: readonly (readonly string[])[] = [
  ['target', 'item', 'object', 'name', 'who', 'what', 'thing', 'npc', 'monster', 'creature', 'corpse', 'container', 'chest', 'id', 'guid', 'recipient', 'to'],
  ['stat', 'skill', 'attribute', 'attr', 'vital', 'stat_name'],
  ['spell', 'spell_name', 'magic'],
  ['text', 'message', 'msg', 'say', 'line', 'words'],
  ['times', 'count', 'n', 'repeat_count', 'raises'],
  ['amount', 'quantity', 'qty', 'number', 'stack'],
  ['timeout_s', 'timeout', 'seconds', 'secs', 'wait', 'time', 'duration_s', 'duration', 'max_s'],
  ['filter', 'kind', 'type', 'search', 'query', 'match'],
  ['radius', 'range', 'distance', 'within'],
  ['action', 'do', 'command', 'cmd', 'op'],
  ['key', 'keys', 'binding'],
  ['slot', 'location', 'where'],
];

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * The argument a tool takes that an unknown one most likely meant: a near spelling ("spel" → spell), a word that
 * means the same (target= on raise → stat=, the stream's `raise target="Magic Defense"`, 2026-10-16), else the one
 * required argument still missing. Null when nothing fits.
 */
export function closestArg(t: AgentTool, key: string, given: Record<string, unknown> = {}): string | null {
  const k = key.toLowerCase();
  const aliases = argAliases(t);
  const names = Object.keys(t.props).filter((n) => n !== 'profile' && !(n in aliases));
  if (!names.length) return null;
  const near = names.map((n) => ({ n, d: editDistance(k, n) })).filter((x) => x.d <= Math.max(1, Math.floor(Math.min(k.length, x.n.length) / 3))).sort((a, b) => a.d - b.d);
  if (near.length) return near[0].n;
  const prefix = names.find((n) => k.length >= 3 && (n.startsWith(k) || k.startsWith(n)) && n.length >= 3);
  if (prefix) return prefix;
  const group = ARG_SYNONYMS.find((g) => g.includes(k));
  if (group) {
    const same = names.find((n) => group.includes(n) && given[n] === undefined);
    if (same) return same;
  }
  const missing = (t.required ?? []).filter((n) => given[n] === undefined && !(n in aliases));
  // A word for "the thing to act on" (target=, name=) means the one required argument still missing.
  if (missing.length === 1 && group) return missing[0];
  return null;
}

/** The refusal for an argument a tool doesn't take, naming the one it most likely meant (closestArg) and the usage. */
export function unknownArgMessage(t: AgentTool, key: string, given: Record<string, unknown> = {}): string {
  const best = closestArg(t, key, given);
  const short = t.name.replace(/^ac_/, '');
  return `${t.name}: unknown argument "${key}"${best ? `: ${short} takes ${best}=, not ${key}=` : ''} (usage: ${usageLine(t)})`;
}

/**
 * The first argument of a call a tool doesn't take, as unknownArgMessage words it; null when all are known. `extra`
 * names keys a front end handles itself (the hosted connector's account).
 */
export function unknownArgs(t: AgentTool, args: Record<string, unknown>, extra: readonly string[] = []): string | null {
  const bad = Object.keys(args).find((k) => !(k in t.props) && k !== 'profile' && !extra.includes(k) && args[k] !== undefined);
  return bad ? unknownArgMessage(t, bad, args) : null;
}

export const TOOLS: AgentTool[] = [
  {
    name: 'ac_start',
    description: 'Start (or reconnect to) your Asheron\'s Call game session: opens a game window, logs in on the profile\'s own account and enters the world, creating a character if needed. Takes ~30 s–3 min the first time. Returns your first observation.',
    props: {
      ...PROFILE_PROP,
      character: { type: 'string', description: 'Character name to create on a new account (letters/spaces, ≤32 chars). Default "Claude <Profile>".' },
      template: { type: 'string', description: 'Profession for a NEW character, by the chargen\'s own names (e.g. "War Mage", "Soldier", "Bow Hunter", "Life Caster"; per era). Default: the random roll.' },
      heritage: { type: 'string', description: 'Heritage for a NEW character (e.g. Aluvian, Gharu\'ndim, Sho, Viamontian; per era).' },
      gender: { type: 'string', description: 'male | female, for a NEW character.' },
      town: { type: 'string', description: 'Starting town for a NEW character (e.g. Holtburg, Shoushi, Yaraq, Sanamar; per era).' },
      seed: { type: 'number', description: 'Pin the appearance roll (default: a fresh random look).' },
      attributes: { type: 'string', description: 'Attributes for a NEW character, set in this order and each kept once set, e.g. "strength=10, endurance=100, coordination=10, quickness=10, focus=100, self=100" (the chargen\'s points must cover them; applied after template=).' },
      skills: { type: 'string', description: 'Skills for a NEW character by name, e.g. "Weapon Tinkering=specialized; Armor Tinkering=trained; Item Tinkering=trained" (credits permitting; applied after template=). It is the whole build: trained skills not listed are untrained, free ones stay. A tinkerer is a custom build; there is no Tinkerer template.' },
      headless: { type: 'boolean', description: 'No visible window (default false: a window opens so a human can watch).' },
      era: { type: 'string', description: `Which era's local server to play: ${ERA_IDS.map((k) => `${k} (${AGENT_ERAS[k].label})`).join(', ')}. Default eor. Each era is its own session (profile claude-<era>).`, enum: ERA_IDS },
      base: { type: 'string', description: 'Game page origin to use, e.g. your own Vite to verify uncommitted work (default: a snapshot of the committed tree on its own Vite, which other sessions\' file saves can\'t reload).' },
      attach: { type: 'string', description: 'Play the human\'s OWN character instead, on any server (playwebac.com included): "chrome" opens (or reuses) a Chrome window at https://playwebac.com/?agent where the human logs in and enters the world themselves; or a DevTools endpoint like http://127.0.0.1:9222. Profile "me". Stopping never logs them out. With character=, only the tab in the world as that character is driven (several game tabs in one Chrome: give each its own profile=).' },
    },
    async run(a) {
      const attach = a.attach ?? defaultAttach(a);
      const { info, started } = await startDaemon({ profile: a.profile, character: a.character, headless: a.headless, base: a.base, era: a.era, template: a.template, heritage: a.heritage, gender: a.gender, town: a.town, seed: a.seed, attributes: a.attributes, skills: a.skills, attach, ...(attach && a.character ? { attachCharacter: a.character } : {}) });
      const c = new AgentClient(info);
      const st = await c.status().catch(() => null);
      if (st?.attached && !st.ready) {
        return {
          text: `Attached to ${st.url}, profile ${info.profile}. Nobody is in the world in that tab yet: ask the human to log in and enter with their character there (their password stays with them), then call ac_observe${info.profile === 'me' ? '' : ` profile=${info.profile}`} or ac_wait. If the page has no ?agent in its address, they reload it at https://playwebac.com/?agent first.`,
        };
      }
      const era = AGENT_ERAS[info.era ?? 'eor'];
      return {
        text: [
          started
            ? st?.attached
              ? `Attached: profile ${info.profile}, playing "${st.character}" in the human's own tab (${st.url}). This is their real character on a live server: play as they asked, as a plain player, and answer people who talk to you.`
              : `Started: profile ${info.profile}, ${era?.label ?? info.era}, account ${info.account}.`
            : `Already running (since ${info.startedAt}): profile ${info.profile} is "${info.character}", ${era?.label ?? info.era}, account ${info.account}. Profiles are shared by every session on this machine: if you didn't start this one, another Claude may be playing it, so pick your own profile= instead.`,
          ...(era?.notes ? [`Era note: ${era.notes}`] : []),
          '', formatJournal(journalOf(info)), '', await observeText(c, {}),
        ].join('\n'),
      };
    },
  },
  {
    name: 'ac_stop',
    description: 'Log out and close the game session (an attached one only lets go of the human\'s tab: they stay logged in).',
    props: { ...PROFILE_PROP },
    async run(a) {
      const c = requireClient(a.profile);
      await c.shutdown();
      return { text: `stopped ${c.info.profile}` };
    },
  },
  {
    name: 'ac_sessions',
    description: 'List running game sessions (profiles).',
    props: {},
    async run() {
      const all = listInfos();
      return { text: all.length ? all.map((i) => `${i.profile}: account ${i.account}, "${i.character}", since ${i.startedAt}`).join('\n') : 'no sessions running' };
    },
  },
  {
    name: 'ac_observe',
    description: 'Look around: your vitals, map coordinates, facing, target, nearby objects (nearest first; distance and direction relative to your facing) and chat/system lines since your last look. Object ids look like #8000123a; pass them to other tools.',
    props: {
      ...PROFILE_PROP,
      radius: { type: 'number', description: 'Metres (default 60).' },
      max: { type: 'number', description: 'Max objects listed (default 25).' },
      filter: { type: 'string', description: 'Only objects whose name or kind contains this text (e.g. "monster", "Drudge", "corpse").' },
    },
    async run(a) { const c = callerFor(a.profile); return withNotice(c, { text: await observeText(c, a) }); },
  },
  {
    name: 'ac_look',
    description: 'Look around properly: a screenshot of what your character sees plus the text observation, in one call. Use it whenever you arrive somewhere new or the list alone doesn\'t tell you what the place is like.',
    props: { ...PROFILE_PROP },
    async run(a) {
      const c = callerFor(a.profile);
      const jpegBase64 = await screenshotOf(c, a.profile);
      const text = await observeText(c, { max: 15 });
      return withNotice(c, { text, jpegBase64 });
    },
  },
  {
    name: 'ac_note',
    description: 'Write in your character\'s journal, which you\'ll see again next session: a goal, something done (closes the goal it names), a place, a person, an event, or an idea. Keep notes short and specific ("Blacksmith in the Academy wants his bellows back from the thrungus in the gardens").',
    props: {
      ...PROFILE_PROP,
      kind: { type: 'string', description: NOTE_KINDS.join(' | '), enum: [...NOTE_KINDS] },
      text: { type: 'string', description: 'The note.' },
    },
    required: ['kind', 'text'],
    async run(a) {
      const c = callerFor(a.profile);
      const kind = String(a.kind) as NoteKind;
      if (!NOTE_KINDS.includes(kind)) return { text: `kind must be one of ${NOTE_KINDS.join(', ')}`, isError: true };
      const obs = await c.call<AgentObservation>('observe', [{ max: 0 }]).catch(() => null);
      const where = obs?.me ? (obs.me.coords ?? `indoors ${obs.me.cell}`) : undefined;
      const store = await journalFor(c, a.profile);
      const j = addNote(store.j, kind, String(a.text), where);
      await store.save(j);
      return { text: `noted (${kind}). ${j.notes.length} notes in ${j.character}'s journal.` };
    },
  },
  {
    name: 'ac_journal',
    description: 'Read your character\'s journal: open goals and the latest places, people and events you noted in earlier sessions.',
    props: { ...PROFILE_PROP },
    async run(a) { const { j } = await journalFor(callerFor(a.profile), a.profile); return { text: formatJournal(j) }; },
  },
  {
    name: 'ac_screenshot',
    description: 'A screenshot of the game window (for terrain, buildings, dungeons, or checking what the UI shows).',
    props: { ...PROFILE_PROP },
    async run(a) { return { text: isHosted() ? 'screenshot (the 3D view; panels and chat are not in it)' : 'screenshot', jpegBase64: await screenshotOf(callerFor(a.profile), a.profile) }; },
  },
  {
    name: 'ac_click',
    description: 'Click the game window at a position in the last ac_screenshot (pixels from its top-left), as the mouse would: for panels and buttons the other tools do not cover (e.g. the Automation panel, opened with ac_say text=/automation). Take a screenshot after to see what changed.',
    props: {
      ...PROFILE_PROP,
      x: { type: 'number', description: 'Pixels from the screenshot\'s left edge.' },
      y: { type: 'number', description: 'Pixels from the screenshot\'s top edge.' },
      button: { type: 'string', description: 'left (default) or right.', enum: ['left', 'right'] },
      modifiers: { type: 'string', description: 'Keys held during the click, comma-separated: ctrl, shift, alt (e.g. ctrl for a Ctrl+click).' },
      to_x: { type: 'number', description: 'Drag instead of click: press at (x, y) and release here (with to_y), e.g. to move a window or, with modifiers=ctrl, the VVS bar.' },
      to_y: { type: 'number', description: 'The drag\'s release point, with to_x.' },
      text: { type: 'string', description: 'Then type this into what the click focused (a text box in a plugin window), with the real keyboard; "\\n" presses Enter.' },
    },
    required: ['x', 'y'],
    async run(a) {
      const c = requireClient(a.profile);
      const mods = typeof a.modifiers === 'string' ? a.modifiers.split(',').map((m: string) => m.trim()).filter(Boolean) : [];
      const to = a.to_x !== undefined && a.to_y !== undefined ? { x: Number(a.to_x), y: Number(a.to_y) } : undefined;
      const text = typeof a.text === 'string' ? a.text.replace(/\\n/g, '\n') : undefined;
      await c.click(Number(a.x), Number(a.y), a.button === 'right' ? 'right' : 'left', mods, to, text);
      return withNotice(c, { text: to ? `dragged (${Math.round(Number(a.x))}, ${Math.round(Number(a.y))}) to (${Math.round(to.x)}, ${Math.round(to.y)})` : `clicked (${Math.round(Number(a.x))}, ${Math.round(Number(a.y))})` });
    },
  },
  {
    name: 'ac_wait',
    description: 'Sleep until something happens instead of polling: returns as soon as a matching event arrives (chat, tell, death, target-died, task-done, vitals-low, attacked, attackers-up, cast-at-you, aggro, fellow-aggro, fellow-low, buff-expired, object-added, level-up, portal), or after timeout. It counts from your last ac_observe or ac_wait, so something that arrived since then (a tell between your observe and this wait) returns at once. Use after starting a walk or an attack.',
    props: {
      ...PROFILE_PROP,
      types: { type: 'string', description: 'Comma-separated event types to wake on (default: any). Whatever you ask, a wait always wakes on your death and on your health reaching the critical line (under 40%, and again at each further 10% fall: a vitals-low saying CRITICAL). Types: chat, dialog, task-done, target-died, target-lost, vitals-low (health below half, or below vitals_below; also any single hit taking over a quarter of your health), attacked (any incoming attack, even a 0-damage hit or a miss), attackers-up (one more creature is attacking you than a moment ago), cast-at-you (a spell landed on, missed or was resisted by you, or a creature nearby spoke a spell\'s words), aggro (a monster started coming at you: running at you, turned to face you, or closing in; its name, level and distance, before it hits; one that then gets no closer for 20 s, stuck or behind a wall it can\'t path round, or that stays a floor up or down for 8 s, is said once and then stays quiet until it comes 3 m nearer on your floor or attacks), fellow-aggro (a monster started coming at or fighting one of your fellows), fellow-low (a fellow\'s health fell below 60%, or below fellow_below, or one hit took a quarter of it), buff-expired (one of your buffs ended, or an item spell on your gear did: which, and the others with 2 min or less left), death, object-added, portal, level-up, screen.' },
      vitals_below: { type: 'number', description: 'vitals-low mark for health for this wait: a fraction (0.7) or percent (70). Default 0.6. Wakes when health falls below it (or a further tenth below where it was, if it already was). Heal early: a fragile caster at about 70%, a tank at about 60%, before the next pull.' },
      fellow_below: { type: 'number', description: 'fellow-low mark for your fellows\' health for this wait: a fraction (0.7) or percent (70). Default 0.6 (always on). A fragile caster partner at about 70% is the time to heal them.' },
      mana_below: { type: 'number', description: 'Likewise for mana (no mark unless given).' },
      stamina_below: { type: 'number', description: 'Likewise for stamina (no mark unless given).' },
      chat_match: { type: 'string', description: 'Wake on chat lines matching this regex (case-insensitive), e.g. a partner\'s name or "] Name says" for their /f and channel lines; never on your own speech. Alone it waits only for such a line; with types it also wakes on those types (with tell: any tell to you, or a matching line).' },
      timeout_s: { type: 'number', description: `Seconds (default 20, max ${AC_WAIT_MAX_S}: a call always answers before a 120 s tool limit; a longer value is cut to ${AC_WAIT_MAX_S} s and the reply says so; call it again to keep waiting).` },
      since_seq: { type: 'number', description: 'Only events after this seq (default: since your last ac_observe or ac_wait).' },
    },
    async run(a) {
      const c = callerFor(a.profile);
      const asked = Math.max(Number(a.timeout_s ?? 20) || 20, 1) * 1000;
      const timeout = Math.min(asked, c.maxWaitMs ?? AC_WAIT_MAX_S * 1000);
      const filter = waitFilter(a);
      // A page from before ac_wait counted from the last look (an older playwebac.com build, local or through
      // the hosted relay, whose errors read "unknown agent method: wait" / "unknown method wait"): its waitFor.
      const evs = await c.call<AgentEvent[]>('wait', [filter, timeout], timeout + 5000)
        .catch((e: Error) => { if (/unknown (?:agent )?method:? wait\b/.test(String(e?.message ?? e))) return c.call<AgentEvent[]>('waitFor', [filter, timeout], timeout + 5000); throw e; });
      const capped = asked > timeout ? `\n(timeout_s=${asked / 1000} was cut to ${timeout / 1000} s, the longest one wait runs: call ac_wait again to keep waiting)` : '';
      return withNotice(c, { text: (evs.length ? formatEvents(evs) : `(nothing within ${timeout / 1000} s)`) + capped });
    },
  },
  {
    name: 'ac_inventory',
    description: 'Your inventory: first the gear slots (the paperdoll: head, chest … feet, neck, wrists, rings, shield, weapon, ammo, each with what you wear there and its armor level, or EMPTY), then the main pack and side packs with ids; each wearable pack item says the slots it would fill (EMPTY ones named), what it would replace, its armor level against yours, and its wield requirements once appraised.',
    props: { ...PROFILE_PROP, filter: { type: 'string', description: 'Only some items, each with where it is: a kind (weapon, armor, clothing, jewelry, scroll, book, kit, potion, food, salvage, gem, key, component, pack, manastone, money, worn; junk = carried items no vendor buys (value 0) that aren\'t money, keys, gems, writables, packs, components, mana stones or salvage; sell = what a vendor pays for, most valuable first) or text in the name ("Healing"). Default: everything, gear first. The first line counts your pack slots (main pack and each side pack): a loot finding none free is refused per item ("… is completely full!") whatever your burden.' } },
    async run(a) {
      const c = callerFor(a.profile);
      // A junk list appraises the unknown candidates first, so attuned ones (known only from an appraisal) are left
      // out; a page from before junkChecked answers with the plain list.
      const junk = a.filter !== undefined && filterInventory([], String(a.filter)).kind === 'junk';
      const items = junk ? await c.call<AgentItem[]>('junkChecked', [], 10_000).catch(() => c.call<AgentItem[]>('inventory')) : await c.call<AgentItem[]>('inventory');
      // Pages from before packSlots (an older playwebac.com build) answer without the line.
      const slots = await c.call<AgentPackSlots | null>('packSlots').catch(() => null);
      const body = a.filter === undefined || String(a.filter).trim() === '' ? formatInventory(items) : formatInventoryFiltered(items, String(a.filter));
      const known = !!slots && Array.isArray(slots.packs) && typeof slots.free === 'number';
      return { text: known ? `${packSlotsText(slots!)}\n${body}` : body };
    },
  },
  {
    name: 'ac_gear',
    description: 'Just the gear slots (the paperdoll): the gaps by name first, then every body part and the neck, wrists, rings, shield, weapon and ammo slots with what you wear there and its armor level, or EMPTY, then each pack item you could wear: the slots it fills, what it replaces, its armor level against yours, its wield requirements (ac_appraise an item to learn them); last, your corpses (where, what is on them, time left before they rot).',
    props: { ...PROFILE_PROP },
    async run(a) {
      const c = callerFor(a.profile);
      // A page from before the corpses read answers without the line.
      return { text: formatGear(await c.call<AgentItem[]>('inventory'), { corpses: await c.call<string | null>('corpses').catch(() => null) }) };
    },
  },
  {
    name: 'ac_spells',
    description: 'Spells in your spellbook, optionally filtered by name/school text. Lists the first `max`, then says how many more match (narrow the filter or raise max to see them).',
    props: { ...PROFILE_PROP, filter: { type: 'string', description: 'Text to match (e.g. "Flame Bolt", "Life", "Self").' }, max: { type: 'number', description: 'Default 40.' } },
    // Every match from the page, cut here so the reply can say what was left out: filter=Other stopped at 40 with
    // the Swift Killer Others and silently dropped every Blood Drinker Other after them (2026-10-16).
    async run(a) { return { text: formatSpells(await callerFor(a.profile).call<AgentSpell[]>('spells', [a.filter ?? '', 100_000]), Number(a.max ?? 40) || 40) }; },
  },
  {
    name: 'ac_status',
    description: 'Where things stand: which account and characters this connection plays, whether the game tab is open and has Claude on, the screen (character select / world / portal space), the character in the world, and your goal line. Call it first, and after any "not open" or "disconnected" error.',
    props: { ...PROFILE_PROP },
    async run(a) {
      const c = callerFor(a.profile);
      const conn = c.connection?.() ?? null;
      let tab: AgentStatus | null = null;
      let err: string | null = null;
      if (!conn || conn.tab === 'on') { try { tab = await c.call<AgentStatus>('status'); } catch (e) { err = (e as Error).message; } }
      return withNotice(c, { text: formatStatus(conn, tab, err) || '(no status)' });
    },
  },
  {
    name: 'ac_enter_world',
    description: 'At character select, enter the world as one of the account\'s characters, the way the player does (that character\'s row, then Enter). Claude never creates or deletes characters. Waits until you are in the world (up to 60 s).',
    props: { ...PROFILE_PROP, character: { type: 'string', description: 'The character\'s name, as ac_status lists it.' } },
    required: ['character'],
    async run(a) {
      const c = callerFor(a.profile);
      return withNotice(c, result(await c.call<AgentResult>('enterWorld', [String(a.character ?? '')], 70_000)));
    },
  },
  {
    name: 'ac_goal',
    description: 'Tell the player what you are doing: sets your goal line (e.g. "farm drudges near Holtburg until level 20"), shown in their chat and in ac_status. An empty text clears it.',
    props: { ...PROFILE_PROP, text: { type: 'string', description: 'The goal, one line (≤ 200 characters).' } },
    async run(a) {
      const c = callerFor(a.profile);
      return withNotice(c, result(await c.call<AgentResult>('goal', [String(a.text ?? '')])));
    },
  },
  {
    name: 'ac_character',
    description: 'Your character sheet: attributes, vitals, skills (with training), level, XP and unassigned XP.',
    props: { ...PROFILE_PROP },
    async run(a) { return { text: await callerFor(a.profile).call<string>('characterSheet') }; },
  },
  {
    name: 'ac_fellowship',
    description: 'Fellowship, through the fellowship pane: action=show (default; members, leader, XP sharing, whether you accept requests), create (name=…), recruit (target= a nearby player; they get a 30 s dialog to accept with ac_dialog button=Yes), quit, leader / dismiss (name= a fellow), open, close, disband, requests (name=accept|ignore: the "Ignore Fellowship Requests" option; a character ignoring requests can\'t be recruited), auto (name=on|off: automatically accept requests). Leader-only actions are refused for others, as the pane\'s buttons are.',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', enum: ['show', 'create', 'recruit', 'quit', 'leader', 'dismiss', 'open', 'close', 'disband', 'requests', 'auto'], description: 'What to do (default show).' },
      name: { type: 'string', description: 'create: the fellowship name (≤ 34 characters). leader / dismiss: the fellow. requests: accept | ignore. auto: on | off.' },
      target: { type: 'string', description: 'recruit: the player (id or name nearby).' },
    },
    async run(a) {
      const c = callerFor(a.profile);
      const action = a.action ?? 'show';
      const arg = action === 'recruit' ? (a.target ? guidOrName(a.target) : undefined) : a.name;
      if (action === 'recruit' && !arg) return { text: 'recruit needs target= (the player to recruit)', isError: true };
      if (action === 'show') return withNotice(c, result(await c.call<AgentResult>('fellowship', ['show'])));
      return withNotice(c, result(await c.call<AgentResult>('fellowship', [action, arg], 60_000)));
    },
  },
  {
    name: 'ac_allegiance',
    description: 'Allegiance, through the allegiance pane: action=show (patron, vassals, monarch), swear (swear to a nearby player: the server walks you over and asks them in a dialog that expires in 30 s; returns in about 5 s so you can answer it on the patron\'s profile with ac_dialog button=Yes right away), or break (from your patron; with target=<vassal name>, release that vassal).',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', enum: ['show', 'swear', 'break'], description: 'show (default), swear, or break.' },
      target: { type: 'string', description: 'swear: the player (id or name nearby). break: a vassal\'s name (omit to break from your patron).' },
    },
    async run(a) {
      const c = callerFor(a.profile);
      const action = a.action ?? 'show';
      if (action === 'show') return { text: await c.call<string>('allegiance') };
      if (action === 'swear') {
        if (!a.target) return { text: 'swear needs target= (the player to swear to)', isError: true };
        return withNotice(c, result(await c.call<AgentResult>('swearAllegiance', [guidOrName(a.target)], 60_000)));
      }
      if (action === 'break') return withNotice(c, result(await c.call<AgentResult>('breakAllegiance', a.target ? [String(a.target)] : [])));
      return { text: `unknown action "${action}" (show, swear, break)`, isError: true };
    },
  },
  act('ac_say', 'Type a line into chat exactly as a player would: plain text is said aloud; "/tell Name, msg", "/f msg", emotes like "*wave*" and the retail "/" commands work. A tell\'s name is everything before the first comma (retail): the answer says when the name part isn\'t the player it starts with ("/tell Claude Bulwark hi, there" goes to "Claude Bulwark hi"). "@" server commands are refused (agents play as players); @tell / @t work as /tell.', { text: { type: 'string', description: 'The chat line.' } }, ['text'], (a) => [String(a.text)]),
  act('ac_select', 'Select an object (it becomes your target).', { target: { type: 'string', description: 'Object id (#…) or a name to find nearby.' } }, ['target'], (a) => [guidOrName(a.target)]),
  act('ac_use', 'Use an object the way double-clicking does: talk to an NPC, open a door/chest/corpse, enter a portal, use a lifestone, eat/drink an item. You walk to it automatically. A portal is walked to through any hits (asking for it is asking to get there); flee=true does the same for anything else (a door, a lifestone). A door marked "opened by a lever or switch, not by hand" can\'t be used: the answer names the levers, switches and plates in view by it; using one of those reports any door near you that swung open or shut. Using an open door shuts it.', {
    target: { type: 'string', description: 'Object id (#…) or a name to find nearby.' },
    flee: { type: 'boolean', description: 'Keep walking to it while monsters hit you, as walk_to flee=true does (always so for a portal). Default: being hit stops the walk.' },
  }, ['target'], (a) => [guidOrName(a.target), ...(a.flee === true || a.flee === 'true' ? [{ flee: true }] : [])], 120_000),
  act('ac_use_on', 'Use an item from your pack on a target (e.g. a healing kit on yourself, a key on a door, a tool on another item).', {
    item: { type: 'string', description: 'Item id or name in your inventory.' },
    target: { type: 'string', description: 'Target id or name ("self" for yourself).' },
  }, ['item', 'target'], (a) => [guidOrName(a.item), String(a.target) === 'self' ? 'self' : guidOrName(a.target)]),
  act('ac_walk_to', 'Walk/run to an object, map coordinates ("42.1N, 33.6E"), a distance and direction from where you stand ("10m north", "25 m NE", "10m NNW", "10m 330°", "5m ahead", "3 m left"; map coordinates: 0.1 = 24 m), or a room of the dungeon or building you are in by its cell id (target=0x01850148: a room of your dungeon, or a room or outdoor cell of any landblock on the landscape, through its building\'s door; world-query and lore print cell ids in hex). A fellow out of your sight in a dungeon is walked to where they were last seen (it says so, and whether they are there now). Paths round walls and through doorways, and jumps or drops off ledges, across gaps and onto platforms where no walk leads (never a fall your health can\'t take); the result says when it jumped or dropped. Returns when you arrive, get stuck, or after timeout; check ac_observe after. Being hit stops it unless the way on leads away from everything hitting you, you are going to a fellow with monsters on them, or flee=true (running away). A monster starting to come at you (running at you, turning to face you, closing in) stops it too, while it is still metres off, naming it, its level and distance (stop_on_aggro=false walks on). Outdoors it keeps 10 m clear of monsters near the way (15 m of one well above your level) and says which it went round; when no way keeps clear it walks past them and says so (avoid_monsters=false walks straight). It names a fellow left far behind; stay_with=<fellow> keeps you together: you run as always, and stop to wait whenever they fall stay_within behind, until they are beside you (and it says when they stopped or went elsewhere). To keep up with someone, use ac_follow.', {
    target: { type: 'string', description: 'Object id (#…), nearby object name (of several with that name, the one a walk reaches), map coordinates like "42.1N, 33.6E", an offset like "10m north" / "5m ahead" (compass N…NW, or ahead / back / left / right of your facing), or a cell id (0x039C0104: that room; a building\'s room or an outdoor cell of any landblock on the landscape too).' },
    within: { type: 'number', description: 'Stop this close, metres (default 2: beside it, on its floor). 5 or more is a range to stand at (a bolt\'s, a pull\'s): the straight distance, whatever floor it is on, and the answer says when the line to it is blocked.' },
    timeout_s: { type: 'number', description: 'Give up after this long (default: by distance, about 3 m/s + 30 s, 60 s to 10 min).' },
    flee: { type: 'boolean', description: 'Keep going while monsters hit you (running away). Default: stop when hit, unless the way on leads away from every attacker. Any walk (flee too) stops at critical health (under 40%, or one hit taking 20% that leaves you under 60%) and says "Heal or keep running?": heal standing, or ask the walk again, which then runs on until health falls another 10% of your max.' },
    stay_with: { type: 'string', description: 'A fellow\'s name: stay together. You run as always (never a walk to let them catch up); when they are more than stay_within metres behind you stop once and wait until they are within 4 m (or have stopped near you), then run on together. While they are casting or fighting you wait on quietly. Indoors, one standing still off your way (on another floor, or round a wall in another branch) is gone back to once first, then you go on together (it says so). Ends early, saying so, if they stand still doing nothing, head elsewhere or go on past you another way.' },
    stay_within: { type: 'number', description: 'With stay_with: how far behind they may fall, metres (default 15).' },
    drop: { type: 'boolean', description: 'With stay_with: the way may drop off a ledge or down a floor opening (one way) with them: it waits at the edge until they are with you, then goes down (tell them first, so they follow). Default off: at such an edge, with them on your floor, the walk stops and says so.' },
    stop_on_aggro: { type: 'boolean', description: 'Stop when a monster starts coming at you (default true; one already coming when you set off doesn\'t stop it). false walks on, through hits too, as flee does (it still stops at critical health, 40%). flee=true never stops for it.' },
    avoid_monsters: { type: 'boolean', description: 'Outdoors, route round monsters near the way, 10 m clear (15 m of one well above your level), as a player goes round a camp. Indoors, stop before coming within their wake range (18 m on ACE, 40 m on GDLE servers) of 2 or more monsters not yet awake, naming them. Default true; off with flee. false walks the straight way, and on into them.' },
    line: { type: 'boolean', description: 'For a caster or archer walking up to a target: arrive only with an open line of fire to it as well as within `within`. Walled off, it closes in 1.5 m at a time (round the wall) until the line opens, and at worst stops beside it saying the line is still shut. Without it, an arrival by a monster still says when the line is shut.' },
  }, ['target'], (a) => [/[NS]\s*,?\s*[\d.]+\s*[EW]/i.test(String(a.target)) ? String(a.target) : guidOrName(a.target), { within: a.within, ...(a.line === true || a.line === 'true' ? { line: true } : {}), ...(a.timeout_s !== undefined ? { timeoutMs: Number(a.timeout_s) * 1000 } : {}), ...(a.flee ? { flee: true } : {}), ...(a.stay_with ? { stayWith: String(a.stay_with) } : {}), ...(a.stay_within !== undefined ? { stayWithin: Number(a.stay_within) } : {}), ...(a.drop === true || a.drop === 'true' ? { drop: true } : {}), ...(a.stop_on_aggro === false || a.stop_on_aggro === 'false' ? { stopOnAggro: false } : {}), ...(a.avoid_monsters === false || a.avoid_monsters === 'false' ? { avoidMonsters: false } : {}) }], 320_000),
  act('ac_follow', 'Follow a player (your fellow): run to within `within` metres of them, stand while they stay near, and run again once they are 3 m past that (never a walk), re-aiming as they go, until they stop (they stand beside you 30 s: they arrived, or are busy there; at most 10 minutes, then it says "still following" and you follow again) or duration_s ends when you give one, you are hit (unless flee=true, or they have monsters on them: then the follow goes on through the hits to them; once you are beside them a hit ends it, flee or not), a monster starts coming at you (unless stop_on_aggro=false), they go out of sight, or you start something else (any action, or ac_stop_moving). One already out of your sight when asked (a dungeon shows you only the rooms in sight of yours) is first walked to where they were last seen, then followed if they are in sight from there. Like VirindiTank\'s Follow (retail had no follow command). Long follows answer "still in progress"; ac_wait types=task-done hears the end.', {
    target: { type: 'string', description: 'The player to follow: name or id.' },
    within: { type: 'number', description: 'How close to keep, metres (default 4).' },
    duration_s: { type: 'number', description: 'Follow this long, seconds (at most 600), whether they stop or not. Default: until they stop beside you (30 s standing), at most 600.' },
    flee: { type: 'boolean', description: 'Keep following while you are hit (e.g. running to your tank with monsters on you), as walk_to flee=true does. Default: being hit stops it.' },
    stop_on_aggro: { type: 'boolean', description: 'Stop when a monster starts coming at you, and indoors before following them within wake range (18 m on ACE) of 2 or more monsters not yet awake (default true). false follows on through hits too, until you are beside them.' },
  }, ['target'], (a) => [guidOrName(a.target), { within: a.within ?? null, durationMs: a.duration_s !== undefined ? Math.min(Number(a.duration_s), 600) * 1000 : null, ...(a.flee === true || a.flee === 'true' ? { flee: true } : {}), ...(a.stop_on_aggro === false || a.stop_on_aggro === 'false' ? { stopOnAggro: false } : {}) }], 640_000),
  act('ac_turn', 'Turn to face a compass bearing (0 = north, 90 = east), a compass point (N, NNW, west-southwest: all 16), your left / right / back, or an object.', { toward: { type: 'string', description: 'Bearing in degrees ("330" or "330°"), a compass point, left / right / back, or an object id / name.' } }, ['toward'], (a) => [/^-?\d+(\.\d+)?$/.test(String(a.toward)) && String(a.toward).length < 6 ? Number(a.toward) : guidOrName(a.toward)]),
  act('ac_move', 'Hold a movement key for a while (fine control, e.g. backing off or strafing around an obstacle).', {
    direction: { type: 'string', description: 'forward | backward | strafe_left | strafe_right | turn_left | turn_right', enum: ['forward', 'backward', 'strafe_left', 'strafe_right', 'turn_left', 'turn_right'] },
    seconds: { type: 'number', description: 'How long (default 1, max 10).' },
  }, ['direction'], (a) => [String(a.direction), Math.min(Number(a.seconds ?? 1), 10)], 20_000),
  act('ac_dialog', 'Press a button on an open dialog (popups, Yes/No confirmations) — observe lists them as DIALOG lines. A modal dialog can block other actions until answered.', {
    button: { type: 'string', description: 'Button label, e.g. "OK", "Yes", "No".' },
    index: { type: 'number', description: 'Which dialog (the DIALOG number in observe); default newest.' },
  }, ['button'], (a) => [String(a.button), a.index]),
  act('ac_map', 'A text floor plan around you, built from the game\'s own movement collision: @ you, . floor you can walk to, : reachable floor over 1 m up/down, # walls/drops/unreachable, v a ledge you can drop off, ! a drop that would hurt too much, J floor only a jump reaches, and nearby objects as letters with a legend. North is up, 1 character = 1 m. Use it to see rooms, doorways and exits when deciding where to go; ac_walk_to already paths around walls on its own.', {
    radius: { type: 'number', description: 'Metres around you (5–25, default 15).' },
  }, [], (a) => [{ radius: a.radius }]),
  act('ac_close', 'Close an open window the way its close box does: name="Social", "Container", "Inventory", "Vendor", "Examine" … (observe lists them under "windows open"), or "all" (what Escape does, plus an open chest/corpse). Pop-up DIALOG lines are answered with ac_dialog instead.', {
    name: { type: 'string', description: 'A window name from observe ("windows open: …"), or "all" (default).' },
  }, [], (a) => [String(a.name ?? 'all')]),
  act('ac_press', 'Press a key binding as the keyboard would: a keymap action name (e.g. "Show/Hide Inventory", "Toggle Autorun") or a key code ("F9", "Ctrl+KeyI"). Use ac_keys to look names up.', {
    key: { type: 'string', description: 'Action name or key code.' },
  }, ['key'], (a) => [String(a.key)]),
  {
    // Without target= a read of the open window ('vendor', READ_METHODS); with one, an action ('vendorAt': walks there
    // and uses the vendor as ac_use does, so it takes its turn with the other acting calls and the player's control).
    name: 'ac_vendor',
    description: 'List what a vendor sells, with prices: the open vendor window, or target=<the vendor> (opened first with the same use ac_use makes, walking there, when it isn\'t the one open).',
    props: {
      ...PROFILE_PROP,
      target: { type: 'string', description: 'The vendor: name or id. Default: the vendor window already open.' },
      filter: { type: 'string', description: 'Only some of the list, as ac_inventory filter= does: text in the name ("stamina", "Heal Other") or a kind (service: a spell the vendor casts on you, scroll, potion, kit, note). Default: everything.' },
    },
    async run(a) {
      const c = callerFor(a.profile);
      const has = a.target !== undefined && a.target !== null && a.target !== '';
      const f = a.filter === undefined || a.filter === null || String(a.filter).trim() === '' ? null : String(a.filter);
      // The filter goes last, and only when given, so a page from before it (it takes no filter) still answers.
      const tail = f === null ? [] : [f];
      return withNotice(c, result(await c.call<AgentResult>(has ? 'vendorAt' : 'vendor', has ? [guidOrName(a.target), ...tail] : tail, 120_000)));
    },
  },
  act('ac_buy', 'Buy from the open vendor.', {
    item: { type: 'string', description: 'Merchandise name or id (from ac_vendor).' },
    amount: { type: 'number', description: 'How many (default 1).' },
  }, ['item'], (a) => [guidOrName(a.item), a.amount ?? null]),
  {
    name: 'ac_sell',
    description: 'Sell an item from your inventory to the open vendor; items= sells several, one after another, each answered on its own line.',
    props: {
      ...PROFILE_PROP,
      item: { type: 'string', description: 'Inventory item name or id.' },
      items: { type: 'string', description: 'Several items to sell: names or ids separated by commas ("Studded Leather Basinet, #8000c1d2"), or a JSON list. Each is sold whole (amount= is for item= alone).' },
      amount: { type: 'number', description: 'For stacks (default: whole stack).' },
    },
    // item= or items=: neither alone is required (missingRequired would refuse items= by itself).
    required: [],
    async run(a) {
      const c = callerFor(a.profile);
      const list = sellList(a.items);
      if (!list.length) {
        if (a.item === undefined || a.item === null || a.item === '') return { text: 'ac_sell: name the item (item=…) or items (items="A, B")', isError: true };
        return withNotice(c, result(await c.call<AgentResult>('sell', [guidOrName(a.item), a.amount ?? null])));
      }
      const all = a.item !== undefined && a.item !== null && a.item !== '' ? [String(a.item), ...list] : list;
      const out: string[] = [];
      let failed = 0;
      for (const it of all) {
        const r = await c.call<AgentResult>('sell', [guidOrName(it), null]);
        if (!r.ok) failed++;
        out.push(`${it}: ${r.message.replace(/\n/g, '\n    ')}`);
      }
      return withNotice(c, { text: [`sold ${all.length - failed} of ${all.length}:`, ...out.map((l) => `  ${l}`)].join('\n'), ...(failed === all.length ? { isError: true } : {}) });
    },
  },
  act('ac_trade', 'Secure trade with another player (open it with ac_use on them): view, add an item, accept, decline, reset or close.', {
    action: { type: 'string', description: 'view | add | accept | decline | reset | close', enum: ['view', 'add', 'accept', 'decline', 'reset', 'close'] },
    item: { type: 'string', description: 'For add: inventory item name or id.' },
  }, [], (a) => [a.action ?? 'view', a.item === undefined ? null : guidOrName(a.item)]),
  act('ac_jump', 'Jump. Hold longer to jump higher and further (as holding the jump key charges the power bar); forward=true runs forward through the jump (to cross a gap or get off a ledge), walk=true walks it.', {
    hold_ms: { type: 'number', description: 'How long the jump key is held, ms (50–3000, default 350; about 1000 = full power).' },
    forward: { type: 'boolean', description: 'Hold forward through the jump.' },
    walk: { type: 'boolean', description: 'A walking (shorter) jump.' },
  }, [], (a) => [{ holdMs: a.hold_ms === undefined ? undefined : Number(a.hold_ms), forward: a.forward === true || a.forward === 'true', walk: a.walk === true || a.walk === 'true' }]),
  act('ac_stop_moving', 'Stop any movement or walk task, and (as retail\'s Stop Moving does) the server\'s own run-up to a melee target: you stop where you are and the attack is cancelled.', {}, [], () => []),
  act('ac_combat_mode', 'Switch stance: peace, melee, missile or magic (wields what you have equipped for it).', { mode: { type: 'string', description: 'peace | melee | missile | magic', enum: ['peace', 'melee', 'missile', 'magic'] } }, ['mode'], (a) => [String(a.mode)]),
  act('ac_attack', 'Attack a creature with your weapon (switches to the right stance, faces it and keeps swinging until it dies, you stop, or the timeout). Melee runs up to it first; indoors, a target on another floor whose run-up would leave a fellow on your floor behind is refused unless far=true, and so is one more than 12 m off whose run-up would leave a fellow at your side more than 15 m behind. With a bow, crossbow, atlatl or thrown weapon it shoots from where you stand when the target is in your weapon\'s reach (its examine Range; less uphill, where the arc falls short) with a clear line, and otherwise closes in only until it is: the reply says which, with the distance and your reach. "Out of Range!" from the server closes in further (twice at most). With a wand, staff or orb wielded (or in magic mode) it fights with spells: the best War or Void attack spell you know and can cast (bolt, arc, or a streak to finish), chosen as the VirindiTank macro chooses, cast again and again until it dies, closing in first only when the spell can\'t reach or a wall is in the way; the reply names the spell, or says why there is none. Use ac_wait for target-died.', {
    target: { type: 'string', description: 'Creature id or name (default: current target, else the nearest monster).' },
    height: { type: 'string', description: 'high | medium | low (default medium)', enum: ['high', 'medium', 'low'] },
    power: { type: 'number', description: 'Power/accuracy 0..1 (default 0.6).' },
    next: { type: 'boolean', description: 'Opt-in chaining: when this target dies, attack the next monster on you (or on a fellow within 30 m) at once, and so on while next=true holds; the target-died event names each next one (never one on another floor from a fellow beside you). Default off: the client\'s Auto Target only selects the next attacker, it never swings at it.' },
    far: { type: 'boolean', description: 'Melee only: go for a target on another floor (a storey up or down indoors), or one more than 12 m off, even though the run there leaves a fellow standing on your floor (or at your side) behind. Default off: such an attack is refused with where it is, the way there, and what to do instead.' },
    drop: { type: 'boolean', description: 'Melee only: the run-up may drop off a ledge or down a floor opening (one way) while a fellow stands on your floor. Default off: such a run-up is refused (or stops at the edge) saying how far it drops and who stays up; far=true alone does not allow it.' },
  }, [], (a) => [a.target === undefined ? null : guidOrName(a.target), { height: a.height, power: a.power, ...(a.next === true || a.next === 'true' ? { next: true } : {}), ...(a.far === true || a.far === 'true' ? { far: true } : {}), ...(a.drop === true || a.drop === 'true' ? { drop: true } : {}) }]),
  act('ac_cast', 'Cast a spell by name or id at a target (or yourself). Switches to magic stance first. One cast per call, unless repeat=true: then it keeps casting the same spell at the same target, each as soon as the client lets you (as a player pressing the bolt key again does), and answers one summary (each cast\'s result, damage dealt, your vitals, why it stopped). It stops when the target dies or goes, your mana won\'t pay for another, the server refuses a cast (no line of fire, out of range, too busy twice), your health falls below until_health (default 60%: heal before the next bolt, a fragile caster earlier still), a monster other than the target that is real danger starts attacking you (it casts spells, one of its hits took 10% or more of your health, or it is above your level; a milder one is cast on through and named under "joined in meanwhile"), or after max_casts / max_s; any other action or ac_stop_moving stops it too. A long repeat answers "still in progress": ac_wait types=task-done,target-died hears the summary.', {
    spell: { type: 'string', description: 'Spell name (e.g. "Flame Bolt I") or id. A name without a level ("Heal Self") casts the highest level of it you know that you can land (75%+ past the fizzle roll, else the likeliest), and the reply says which.' },
    target: { type: 'string', description: 'Target id/name, or "self" (default: current target for hostile spells, else self).' },
    repeat: { type: 'boolean', description: 'Keep casting it at the target until a stop condition (not on yourself).' },
    until_health: { type: 'number', description: 'With repeat: stop when your health is below this, a fraction (0.7) or percent (70) (default 0.6; 0 never stops for health). A caster with under 100 HP is two or three hits from dead: 0.7 leaves time to heal.' },
    max_casts: { type: 'number', description: 'With repeat: stop after this many casts (default 20, at most 100).' },
    max_s: { type: 'number', description: 'With repeat: stop after this many seconds (default 120, at most 600).' },
  }, ['spell'], (a) => [/^\d+$/.test(String(a.spell)) ? Number(a.spell) : String(a.spell), a.target === undefined ? null : (String(a.target) === 'self' ? 'self' : guidOrName(a.target)), castRepeatArgs(a)], 640_000),
  act('ac_pick_up', 'Pick up an item from the ground or from an open container/corpse into your pack.', { item: { type: 'string', description: 'Item id or name.' } }, ['item'], (a) => [guidOrName(a.item)]),
  act('ac_loot', 'Open a corpse/chest and take everything (or only items whose name matches).', {
    target: { type: 'string', description: 'Corpse/chest id or name (default: nearest corpse).' },
    container: { type: 'string', description: 'Same as target (older name).' },
    match: { type: 'string', description: 'Regex of item names to take (default: all).' },
  }, [], (a) => { const t = a.target ?? a.container; return [t === undefined ? null : guidOrName(t), a.match ?? null]; }, 90_000),
  act('ac_drop', 'Drop an item from your inventory on the ground.', { item: { type: 'string', description: 'Item id or name.' } }, ['item'], (a) => [guidOrName(a.item)]),
  act('ac_give', 'Give an item to an NPC or player (quest turn-ins work this way). A give refused because one of you was busy ("too busy to accept gifts", "one item at a time") is tried once more after 3 s; the reply says so.', {
    item: { type: 'string', description: 'Item id or name.' },
    target: { type: 'string', description: 'Recipient id or name.' },
    amount: { type: 'number', description: 'For stacks (default: whole stack).' },
  }, ['item', 'target'], (a) => [guidOrName(a.item), guidOrName(a.target), a.amount ?? null]),
  act('ac_equip', 'Wield or wear an item from your pack. Without slot= the client picks the place, as a double-click does: a free wrist or ring finger when one is free (the right first), and with both taken it replaces the RIGHT one. slot= puts it on that paperdoll slot, as dragging it there does: whatever is in that slot is taken off into your pack first. The reply names the slot it went to and anything it took off.', {
    item: { type: 'string', description: 'Item id or name (its material too: "Bronze Bracelet").' },
    slot: { type: 'string', description: 'Paperdoll slot: left wrist, right wrist, left ring, right ring, neck, weapon, shield, missile, ammo, held, two-handed, trinket, cloak (or an EquipMask name, e.g. WristWearLeft). Armor and clothing go where they fit whatever you name.' },
  }, ['item'], (a) => [guidOrName(a.item), a.slot ?? null]),
  act('ac_unequip', 'Take off a worn or wielded item into your main pack (the drag off the paperdoll). ac_inventory shows what is worn where.', { item: { type: 'string', description: 'Item id or name.' } }, ['item'], (a) => [guidOrName(a.item)]),
  {
    name: 'ac_move_item',
    description: 'Move items between your packs: into a side pack (a Sack, Pack or Pouch you carry) or back to the main pack, as dragging one onto the pack\'s icon in the inventory does. item= moves one, items= several, filter= every carried item of a kind (junk, salvage, potion … as ac_inventory filter=) or name, until the pack is full. to= names the pack: "side" (the side pack with the most room, the default), "main", its name ("Sack") or #id, or its pack slot (1 = the first side pack). Each move is reported once the server has moved it, or with its refusal. ac_inventory\'s first line counts each pack\'s slots. Worn items: ac_unequip first.',
    props: {
      ...PROFILE_PROP,
      item: { type: 'string', description: 'Inventory item name or id.' },
      items: { type: 'string', description: 'Several items: names or ids separated by commas, or a JSON list.' },
      filter: { type: 'string', description: 'Every carried item of this kind or name (as ac_inventory filter=), e.g. junk, salvage, "Mu-miyah".' },
      to: { type: 'string', description: 'side (default) | main | a side pack\'s name or #id | its pack slot number.' },
      max: { type: 'number', description: 'filter=: at most this many (default 50).' },
    },
    aliases: { target: 'item', pack: 'to' },
    required: [],
    async run(a) {
      const to = a.to === undefined || a.to === null || String(a.to).trim() === '' ? null : String(a.to);
      const filter = a.filter !== undefined && a.filter !== null && String(a.filter).trim() !== '' ? String(a.filter) : null;
      const list = [...(a.item !== undefined && a.item !== null && a.item !== '' ? [String(a.item)] : []), ...sellList(a.items)];
      if (!filter && !list.length) return { text: 'ac_move_item: name the item (item=…), items (items="A, B") or a kind (filter=junk)', isError: true };
      const c = callerFor(a.profile);
      if (filter) return withNotice(c, result(await c.call<AgentResult>('moveItems', [filter, to, Number(a.max ?? 50) || 50], 240_000)));
      if (list.length === 1) return withNotice(c, result(await c.call<AgentResult>('moveItem', [guidOrName(list[0]), to])));
      const out: string[] = [];
      let failed = 0;
      for (const it of list) {
        const r = await c.call<AgentResult>('moveItem', [guidOrName(it), to]);
        if (!r.ok) failed++;
        out.push(`${it}: ${r.message.replace(/\n/g, '\n    ')}`);
      }
      return withNotice(c, { text: [`moved ${list.length - failed} of ${list.length}:`, ...out.map((l) => `  ${l}`)].join('\n'), ...(failed === list.length ? { isError: true } : {}) });
    },
  },
  act('ac_appraise', 'Examine (ID) an object: full properties once the server answers.', { target: { type: 'string', description: 'Object id or name.' } }, ['target'], (a) => [guidOrName(a.target)], 20_000),
  {
    name: 'ac_keys',
    description: 'Look up keymap actions and their keys (e.g. filter "inventory", "spell", "camera").',
    props: { ...PROFILE_PROP, filter: { type: 'string', description: 'Text in the action name.' } },
    async run(a) { return { text: await callerFor(a.profile).call<string>('keys', [a.filter ?? '']) }; },
  },
  {
    name: 'ac_trace',
    description: 'Where your character has been (position, cell, height, facing, task) every 0.5 s — for working out what just happened (stuck, fell, clipped into something).',
    props: { ...PROFILE_PROP, seconds: { type: 'number', description: 'How far back (default 30, max 120).' } },
    async run(a) { return { text: formatTrace(await callerFor(a.profile).call<AgentTracePoint[]>('trace', [Math.min(Number(a.seconds ?? 30), 120)])) }; },
  },
  {
    name: 'ac_routines',
    description: 'Read and configure an account\'s automation routines (per account, kept between sessions; no game session needed). action: list (profiles), show (JSON), explain (plain words), example (a worked profile to edit), validate (a document file), set (store a whole document from file= after validating), import (VirindiTank .met / .nav / .utl / .usd files, or metaf .af text, from files=, into profile name=: a meta makes the states, a nav adds a route, a loot profile replaces the loot rules, a .usd settings file sets the options and the Monsters / Items / Consumables / Buffs tabs; anything that cannot run exactly is switched off and listed), export (profile name= as a VirindiTank file the player can use or share: kind=met its meta, kind=nav a route, kind=utl its loot rules, kind=usd its settings and tabs, kind=af its meta (or with which= a route) in metaf\'s .af text; which= picks the route or loot set; returns the file text after what it could not hold, and out= also writes it locally). Defaults to the running session\'s account; pass account= (and server=) for any other, e.g. a player who asked you to set up their routines. Routines only do what a player can (no "@" commands).',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', description: 'list (the default) | show | explain | example | validate | set | import | export', enum: [...ROUTINES_ACTIONS] },
      account: { type: 'string', description: 'Account name (default: the session\'s).' },
      server: { type: 'string', description: 'Server id (default: local-<era> of the session, else local-eor).' },
      name: { type: 'string', description: 'Profile name for show/explain (default: all).' },
      file: { type: 'string', description: 'For validate/set: path to the whole routine document (JSON).' },
      files: { type: 'string', description: 'For import: comma-separated paths of VirindiTank .met / .nav / .utl / .usd files or metaf .af files.' },
      doc: { type: 'string', description: 'Through the hosted connector (no files): for validate/set, the whole routine document as JSON text.' },
      files_json: { type: 'string', description: 'Through the hosted connector: for import, JSON [{"name":"Hunt.met","text":"…"}] with each VirindiTank file\'s text.' },
      kind: { type: 'string', description: 'For export: met (the meta, routes embedded), nav (a route), utl (loot rules), usd (settings and the Monsters / Items / Consumables / Buffs tabs) or af (the meta, or with which= a route, in metaf\'s .af text). Default met.', enum: ['met', 'nav', 'utl', 'usd', 'af'] },
      which: { type: 'string', description: 'For export: the route (kind=nav or af; default the Auto-Navigation route for nav) or loot set (kind=utl; default the one in use).' },
      out: { type: 'string', description: 'For export, local only: also write the file to this path (Windows-1252, as VirindiTank reads it).' },
    },
    async run(a) {
      if (isHosted()) return hostedRoutinesTool(callerFor(a.profile), a);
      const info = findDaemon(a.profile);
      const account = String(a.account ?? info?.account ?? '');
      const server = String(a.server ?? `local-${info?.era ?? 'eor'}`);
      const store = new RoutineStore();
      const action = routinesAction(a.action);
      if (action === 'example') return { text: JSON.stringify(EXAMPLE_HUNT_PROFILE, null, 2) };
      const readFile = (): { body: unknown } | { text: string; isError: true } => {
        if (!a.file) return { text: 'pass file= (a JSON routine document)', isError: true };
        try { return { body: JSON.parse(readFileSync(String(a.file), 'utf8')) }; } catch (e) { return { text: `can't read ${a.file}: ${(e as Error).message}`, isError: true }; }
      };
      // validate checks a file alone: no account (nor a running session to take one from).
      if (action === 'validate') {
        const f = readFile();
        if (!('body' in f)) return f;
        const issues = validateRoutineDoc(f.body);
        return issues.length ? { text: issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n'), isError: true } : { text: 'valid' };
      }
      if (!account) return { text: 'pass account= (no game session is running to take it from)', isError: true };
      const doc = store.get(server, account);
      const pick = (n?: string) => doc.profiles.filter((p) => !n || p.name.toLowerCase() === String(n).toLowerCase());
      if (action === 'list') {
        return { text: doc.profiles.length
          ? `${server}/${account} (updated ${doc.updatedAt}):\n${doc.profiles.map((p) => `  ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')}${doc.characters ? `\ncharacters: ${Object.entries(doc.characters).map(([c, p]) => `${c} → ${p}`).join(', ')}` : ''}`
          : `${server}/${account} has no routines yet (start from: ac_routines action=example)` };
      }
      if (action === 'show') return { text: JSON.stringify(a.name ? pick(a.name)[0] ?? null : doc, null, 2) };
      if (action === 'export') {
        const { file, ...out } = exportRoutineFile(doc, a);
        if (file && a.out) {
          try { writeFileSync(String(a.out), encodeWindows1252(file.text)); } catch (e) { return { text: `can't write ${a.out}: ${(e as Error).message}`, isError: true }; }
          return { ...out, text: `wrote ${a.out}\n${out.text}` };
        }
        return out;
      }
      if (action === 'explain') {
        const ps = pick(a.name);
        return { text: ps.length ? ps.map(explainProfile).join('\n\n') : `no profile${a.name ? ` "${a.name}"` : 's'} for ${server}/${account}` };
      }
      if (action === 'set') {
        const f = readFile();
        if (!('body' in f)) return f;
        const r = store.put(server, account, f.body);
        return r.ok
          ? { text: `stored ${r.doc.profiles.length} profile(s) for ${server}/${account}\n\n${r.doc.profiles.map(explainProfile).join('\n\n')}` }
          : { text: `not stored:\n${r.issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
      }
      if (action === 'import') {
        if (!a.files) return { text: 'pass files= (comma-separated .met / .nav / .utl paths)', isError: true };
        const paths = String(a.files).split(',').map((x) => x.trim()).filter(Boolean);
        const files: Array<{ name: string; text: string }> = [];
        for (const f of paths) {
          // VTank writes ASCII / Windows-1252; latin1 keeps every byte.
          try { files.push({ name: f, text: readFileSync(f, 'latin1') }); } catch (e) { return { text: `can't read ${f}: ${(e as Error).message}`, isError: true }; }
        }
        const name = String(a.name ?? paths.find((f) => /\.(met|af|usd)$/i.test(f))?.replace(/^.*[\\/]/, '').replace(/\.(met|af|usd)$/i, '') ?? 'Imported');
        const base = doc.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
        const r = importVTankFiles(files, base, base?.name ?? name);
        const next = { ...doc, profiles: [...doc.profiles.filter((p) => p !== base), r.value] };
        const put = store.put(server, account, next);
        if (!put.ok) return { text: `not stored:\n${put.issues.map((i) => `${i.path || '(document)'}: ${i.message}`).join('\n')}`, isError: true };
        const off = r.value.states.flatMap((st) => st.rules).filter((x) => x.disabled).length + r.value.loot.filter((x) => x.disabled || x.match.unsupported).length;
        return { text: [`imported into "${r.value.name}" for ${server}/${account}: ${r.value.states.length} states, ${r.value.states.reduce((t, st) => t + st.rules.length, 0)} rules, ${r.value.routes.length} routes, ${r.value.loot.length} loot rules (${off} switched off)`,
          ...(r.problems.length ? ['', `not carried over exactly (${r.problems.length}):`, ...r.problems.slice(0, 40).map((x) => `  ${x}`), ...(r.problems.length > 40 ? [`  … and ${r.problems.length - 40} more`] : [])] : []),
          '', explainProfile(r.value)].join('\n') };
      }
      return { text: `unknown action "${action}" (${ROUTINES_ACTIONS.join(', ')})`, isError: true };
    },
  },
  {
    name: 'ac_routine',
    description: 'Run one of the account\'s stored routines on your character (ac_routines configures them): action=dryrun shows which rule of the current state would fire now and why (check before running), run starts it, status shows its state, recent actions and this run\'s stats, pause/resume hold it, stop stops it. The routine acts through the same player actions as the other tools.',
    props: {
      ...PROFILE_PROP,
      action: { type: 'string', description: 'run | pause | resume | stop | status (the default) | dryrun', enum: [...ROUTINE_ACTIONS] },
      name: { type: 'string', description: 'For run/dryrun: the profile name (default: the one assigned to this character, else the only one).' },
      server: { type: 'string', description: 'Server id the routines are stored under (default local-<era>).' },
      file: { type: 'string', description: 'For run/dryrun, local only: run a profile from this JSON file (one profile, or a whole routine document with name= picking one) instead of the stored ones; nothing is stored.' },
      set: { type: 'string', description: 'For run/dryrun: settings to change for this run, "Name=value" separated by commas (e.g. "Recharge-Norm-HitP=70,AttackDistance=20"); the profile itself is not changed.' },
    },
    async run(a) {
      const c = callerFor(a.profile);
      const action = routinesAction(a.action, 'status');
      if ((action === 'run' || action === 'dryrun') && a.file && !isHosted()) {
        const f = routineFromFile(String(a.file), a.name === undefined ? undefined : String(a.name));
        if ('text' in f) return f;
        const set = routineSettings(a.set);
        if ('text' in set) return set;
        const prof = { ...f.profile, settings: { ...(f.profile.settings ?? {}), ...set.settings } };
        if (action === 'run') {
          const r = await c.call<AgentResult>('routineStart', [prof]);
          return result({ ...r, message: `${r.message} (from ${a.file}${Object.keys(set.settings).length ? `; ${Object.entries(set.settings).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''})` });
        }
        const v = await c.call<Array<{ rule: string; fires: boolean; enabled: boolean; off?: boolean; why: string[] }>>('routineDryRun', [prof]);
        const first = v.findIndex((x) => x.fires);
        return { text: [`"${prof.name}" from ${a.file}, state "${prof.initialState}":`, ...v.map((x, i) => `  ${i === first ? '▶' : ' '} ${x.rule}${x.off ? ' [off]' : x.enabled ? '' : ' [module off]'}: ${x.why.join(', ')}`), first < 0 ? (prof.macro ? '  (no rule would fire now: the macro fights, heals and buffs from its settings)' : '  (no rule would fire now)') : ''].join('\n') };
      }
      if (action === 'stop') return result(await c.call<AgentResult>('routineStop'));
      if (action === 'pause') return result(await c.call<AgentResult>('routinePause'));
      if (action === 'resume') return result(await c.call<AgentResult>('routineResume'));
      if (action === 'status') {
        const st = await c.call<{ running: boolean; paused: boolean; profile: string | null; state: string | null; acting: string | null; last: string[] }>('routineStatus');
        const s = await c.call<{ startedAt: number | null; xpGained: number; kills: number; deaths: number; kept: number; left: number; sold: number; rebuffs: number }>('routineStats');
        const stats = s.startedAt !== null ? `  this run: ${s.kills} kills, ${s.deaths} deaths, ${s.xpGained.toLocaleString('en-US')} XP, kept ${s.kept} · left ${s.left} · sold ${s.sold}, ${s.rebuffs} rebuffs` : '';
        return { text: st.running ? [`${st.paused ? 'paused' : 'running'} "${st.profile}" in state "${st.state}"${st.acting ? `, acting: ${st.acting}` : ''}`, ...(stats ? [stats] : []), ...st.last.map((l) => `  ${l}`)].join('\n') : ['no routine running', ...(stats ? [stats] : []), ...st.last.map((l) => `  ${l}`)].join('\n') };
      }
      // The game client loads its own account's routines through the bridge (AGENT.routine-store-auth);
      // the local files are the fallback for a bridge without /routines. Hosted: the game's store only.
      const hosted = isHosted();
      const who = hosted
        ? { account: c.connection?.().account ?? '', character: (await c.call<AgentStatus>('status')).character ?? '' }
        : { account: requireClient(a.profile).info.account, character: requireClient(a.profile).info.character };
      let doc = hosted ? await hostedRoutines(c).get() : new RoutineStore().get(String(a.server ?? `local-${requireClient(a.profile).info.era ?? 'eor'}`), who.account);
      let source = hosted ? 'your game' : 'local files';
      if (!hosted && (a.server === undefined || a.server === null)) {
        type Loaded = { ok: boolean; doc?: RoutineDoc; message?: string };
        const fromPage: Loaded = await c.call<Loaded>('routinesLoad').catch((e: Error): Loaded => ({ ok: false, message: e.message }));
        if (fromPage.ok && fromPage.doc) { doc = fromPage.doc; source = 'the bridge'; } else source = `local files (bridge: ${fromPage.message})`;
      }
      const wanted = a.name ?? doc.characters?.[who.character] ?? (doc.profiles.length === 1 ? doc.profiles[0].name : undefined);
      const prof = doc.profiles.find((p) => p.name.toLowerCase() === String(wanted ?? '').toLowerCase());
      if (!prof) return { text: `no routine ${wanted ? `"${wanted}" ` : ''}for ${who.account} in ${source} (have: ${doc.profiles.map((p) => p.name).join(', ') || 'none — configure one with ac_routines'})`, isError: true };
      if (action === 'run') {
        const set = routineSettings(a.set);
        if ('text' in set) return set;
        const r = await c.call<AgentResult>('routineStart', [Object.keys(set.settings).length ? { ...prof, settings: { ...(prof.settings ?? {}), ...set.settings } } : prof]);
        return result({ ...r, message: `${r.message} (from ${source})` });
      }
      if (action === 'dryrun') {
        const st = await c.call<{ running: boolean; profile: string | null }>('routineStatus');
        const running = st.running && st.profile === prof.name;
        const v = await c.call<Array<{ rule: string; fires: boolean; enabled: boolean; off?: boolean; why: string[] }>>('routineDryRun', [running ? null : prof]);
        const first = v.findIndex((x) => x.fires);
        return { text: [`"${prof.name}", state "${prof.initialState}"${running ? ' (running)' : ''}:`, ...v.map((x, i) => `  ${i === first ? '▶' : ' '} ${x.rule}${x.off ? ' [off]' : x.enabled ? '' : ' [module off]'}: ${x.why.join(', ')}`), first < 0 ? '  (no rule would fire now)' : ''].join('\n') };
      }
      return { text: `unknown action "${action}" (${ROUTINE_ACTIONS.join(', ')})`, isError: true };
    },
  },
  act('ac_raise', 'Spend unassigned XP to raise an attribute, vital or skill by one step (or several with times). stat= names it; skill= works the same.', {
    stat: { type: 'string', description: 'Attribute (Strength…), vital (Health/Stamina/Mana) or skill name (e.g. "War Magic"); skill= is the same argument.' },
    times: { type: 'number', description: 'Raises at most this many (default 1): as many as your unassigned XP covers, stopping at the first it can\'t pay for (times=50 spends all it can). amount= is the same argument.' },
  }, ['stat'], (a) => [String(a.stat), Number(a.times ?? 1) || 1, ...(a[RAISE_WORD] ? [a[RAISE_WORD]] : [])]),
  act('ac_train_skill', 'Spend skill credits to train an untrained skill (e.g. "Life Magic", "Creature Enchantment", "Healing"). ac_character lists each untrained skill\'s cost in credits and your credits. A trained magic school lets you learn its spells from scrolls (ac_use the scroll).', {
    skill: { type: 'string', description: 'Skill name.' },
  }, ['skill'], (a) => [String(a.skill)]),
];

/**
 * The tools that name one object and take it as item= or target= alike: pick_up took only item= while use, loot and
 * appraise take target= ("ac_pick_up: unknown argument \"target\"", Bulwark 2026-10-16). give and use_on name two
 * (item= the thing, target= whom), so they keep both meanings apart.
 */
export const ONE_OBJECT_TOOLS = ['ac_pick_up', 'ac_drop', 'ac_equip', 'ac_unequip', 'ac_sell', 'ac_appraise', 'ac_select', 'ac_use', 'ac_loot', 'ac_attack'] as const;

/** The other name each one-object tool takes for its object (alias → the argument it means). */
export function argAliases(t: Pick<AgentTool, 'name' | 'props' | 'aliases'>): Record<string, string> {
  if (t.aliases) return t.aliases;
  if (!(ONE_OBJECT_TOOLS as readonly string[]).includes(t.name)) return {};
  if (t.props.item && !t.props.target) return { target: 'item' };
  if (t.props.target && !t.props.item) return { item: 'target' };
  return {};
}

/** A call's arguments with an alias moved onto the argument it means (the canonical one wins when both are given). */
export function withArgAliases(t: Pick<AgentTool, 'name' | 'props' | 'aliases'>, a: Record<string, any>): Record<string, any> {
  const al = argAliases(t);
  if (!Object.keys(al).some((k) => a[k] !== undefined)) return a;
  const out = { ...a };
  for (const [alias, real] of Object.entries(al)) {
    if (out[alias] === undefined) continue;
    if (out[real] === undefined || out[real] === null || out[real] === '') out[real] = out[alias];
    delete out[alias];
  }
  return out;
}

/**
 * sell items=: a list as a comma (or semicolon / newline) separated string or a JSON array. "sell items=…" was refused
 * as an unknown argument (Arcanist, 2026-10-16 23:17Z): a player hands a vendor several things at once.
 */
export function sellList(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { const j = JSON.parse(s); if (Array.isArray(j)) return sellList(j); } catch { /* not JSON: a plain list */ } }
  return s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
}

/** Each tool with one time argument: the others' names for it (alias → its own). */
export const TIME_ARG_ALIASES: Readonly<Record<string, Record<string, string>>> = {
  ac_wait: { duration_s: 'timeout_s', seconds: 'timeout_s' },
  ac_walk_to: { duration_s: 'timeout_s', seconds: 'timeout_s' },
  ac_follow: { timeout_s: 'duration_s', seconds: 'duration_s' },
  ac_move: { duration_s: 'seconds', timeout_s: 'seconds' },
  ac_cast: { timeout_s: 'max_s', duration_s: 'max_s' },
};

// skill= is stat= for raise: "raise skill=Healing" was refused with "takes stat=" a dozen times in a segment (Bulwark,
// Arcanist, 2026-10-16), and a skill is half of what raise raises.
// amount= is times= ("raise amount=max" was refused as an unknown argument, Bulwark 2026-10-17 05:00Z).
// raise has one name argument, so every word players reach for names it: across the 2026-10-16/17 stream
// transcripts ~200 raises were refused for target= (78), name= (56), skill= (50, aliased since), attribute= (12) …
for (const t of TOOLS) if (t.name === 'ac_raise') t.aliases = { skill: 'stat', target: 'stat', name: 'stat', attribute: 'stat', vital: 'stat', what: 'stat', amount: 'times' };

/**
 * Which kind a raise was asked for by its word (attribute=, vital=, skill=), kept past the aliasing so the page can say
 * when the name is the other kind: `raise attribute="Stamina"` raised the Maximum Stamina vital with no word that
 * Stamina isn't an attribute (Endurance feeds it; Arcanist, 2026-10-17 20:23:25Z).
 */
export const RAISE_WORD = '__raiseWord';
export function raiseWord(a: Record<string, unknown>): 'attribute' | 'vital' | 'skill' | null {
  const given = (k: string): boolean => a[k] !== undefined && a[k] !== null && a[k] !== '';
  if (given('stat')) return null;
  for (const k of ['attribute', 'vital', 'skill'] as const) if (given(k)) return k;
  return null;
}

// distance= is within= for the walks: "follow distance=" was refused as an unknown argument (Arcanist, 2026-10-16).
// The time argument by the other tools' names, where the tool has only the one: "follow … timeout_s=40" was refused
// (ac_wait's and walk_to's name; follow's is duration_s), and Arcanist sent it again as duration_s=40 (2026-10-17
// 17:52:51Z). ac_trace's seconds= (how far back, not how long) and ac_jump's hold_ms= keep their own names only.
for (const t of TOOLS) {
  const time = TIME_ARG_ALIASES[t.name];
  if (t.name === 'ac_walk_to' || t.name === 'ac_follow') t.aliases = { distance: 'within', ...time };
  else if (time) t.aliases = { ...t.aliases, ...time };
}

// Each one-object tool lists its alias (so the CLI and an MCP schema with additionalProperties: false take it) and
// reads its arguments through withArgAliases. An alias has its argument's type (distance= is a number, as within=).
for (const t of TOOLS) {
  const al = argAliases(t);
  if (!Object.keys(al).length) continue;
  t.aliases = al;
  for (const [alias, real] of Object.entries(al)) t.props = { ...t.props, [alias]: { type: t.props[real]?.type ?? 'string', description: `Same as ${real} (either name works).` } };
  const run = t.run.bind(t);
  t.run = t.name === 'ac_raise'
    ? (a) => { const w = raiseWord(a); return run({ ...withArgAliases(t, a), ...(w ? { [RAISE_WORD]: w } : {}) }); }
    : (a) => run(withArgAliases(t, a));
}

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * JSON Schema for a tool's arguments (MCP inputSchema). A required argument that has an alias is left to
 * missingRequired (either name satisfies it), so a client that checks the schema takes the alias alone.
 */
export function inputSchema(t: AgentTool): Record<string, unknown> {
  const aliased = new Set(Object.values(argAliases(t)));
  return { type: 'object', properties: t.props, required: (t.required ?? []).filter((k) => !aliased.has(k)), additionalProperties: false };
}
