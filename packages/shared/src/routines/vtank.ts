/**
 * AGENT.vtank-import — VirindiTank's files into the routine document:
 * `.met` metas → states and rules, `.nav` navroutes → routes, `.utl`
 * (VTClassic) loot profiles → loot rules. Players' familiarity lives in these
 * files (docs/automation-and-plugins.md §5), so they import; anything this
 * engine cannot run exactly comes in switched off or as an `unsupported`
 * step that names what it was, never guessed.
 *
 * Formats (implemented from their layouts, not ported code; spec with
 * sources: docs/vtank-formats.md):
 * - `.met`: VTank's generic typed-value serialisation. A value is a tag line
 *   (`i` int, `s` string, `d` double, `ba` N + exactly N raw chars, `TABLE`
 *   ncols, names, types, nrows, rows) and its payload. The file is the
 *   CondAct table without its tag: per rule CType, AType, CData, AData,
 *   State. Condition ids 0–28, action ids 0–15 (metaf Enums.cs).
 * - `.nav`: `uTank2 NAV 1.2`, route type (1 circular, 2 linear, 3 follow,
 *   4 once), node count, nodes (type, E/W, N/S, Z, `0`, type fields).
 * - `.utl`: `UTL`, version, rule count; per rule name, expression,
 *   `pri;action;req…`, keep count (action 10), then each requirement as a
 *   char-length line and its data. First full match wins (file order).
 * All embedded lengths count line breaks as CRLF, so text is normalised to
 * CRLF before parsing.
 */
import type { LootAction, LootMatch, LootRule, Route, RoutineAction, RoutineCondition, RoutineProfile, RoutineRule, RoutineState, SalvageCombine } from './RoutineDoc.js';
import { ALL_MODULES_OFF } from './RoutineDoc.js';
import { vtCanonicalName, vtFromVTank } from './vtankOptions.js';
import { ubVerbOf } from './ubVerbs.js';

// ── text reader ──

const normDeg = (d: number): number => ((d % 360) + 360) % 360;

const crlf = (text: string): string => text.replace(/^﻿/, '').replace(/\r?\n/g, '\r\n');

class Reader {
  pos = 0;
  constructor(readonly text: string) {}
  get done(): boolean { return this.pos >= this.text.length; }
  line(): string {
    if (this.pos > this.text.length) throw new Error('unexpected end of file');
    const i = this.text.indexOf('\r\n', this.pos);
    const end = i < 0 ? this.text.length : i;
    const out = this.text.slice(this.pos, end);
    this.pos = i < 0 ? this.text.length + 1 : i + 2;
    return out;
  }
  chars(n: number): string {
    if (this.pos + n > this.text.length) throw new Error(`expected ${n} characters, file ends`);
    const out = this.text.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  int(): number {
    const l = this.line().trim();
    if (!/^-?\d+$/.test(l)) throw new Error(`expected an integer, found "${l}"`);
    return Number(l);
  }
  num(): number {
    const l = this.line().trim().replace(',', '.');
    const v = Number(l);
    if (!Number.isFinite(v)) throw new Error(`expected a number, found "${l}"`);
    return v;
  }
}

// ── .met ──

export type MetValue =
  | { t: 'i'; v: number }
  | { t: 's'; v: string }
  | { t: 'd'; v: number }
  | { t: 'ba'; v: string }
  | { t: 'table'; cols: string[]; rows: MetValue[][] };

function metValue(r: Reader): MetValue {
  const tag = r.line();
  switch (tag) {
    case 'i': return { t: 'i', v: r.int() };
    case 's': return { t: 's', v: r.line() };
    case 'd': return { t: 'd', v: r.num() };
    case 'ba': { const n = r.int(); return { t: 'ba', v: r.chars(n) }; }
    case 'TABLE': return metTable(r);
    default: throw new Error(`unknown value tag "${tag}"`);
  }
}

function metTable(r: Reader): MetValue {
  const ncols = r.int();
  const cols = Array.from({ length: ncols }, () => r.line());
  for (let i = 0; i < ncols; i++) r.line(); // column types: always "n"
  const nrows = r.int();
  const rows = Array.from({ length: nrows }, () => Array.from({ length: ncols }, () => metValue(r)));
  return { t: 'table', cols, rows };
}

export interface MetRule { cond: number; condData: MetValue; act: number; actData: MetValue; state: string }

/** The rules of a `.met`, in file order. */
export function parseMet(text: string): MetRule[] {
  const r = new Reader(crlf(text));
  if (r.line().trim() !== '1' || r.line().trim() !== 'CondAct') throw new Error('not a VirindiTank meta (no CondAct table)');
  const t = metTable(r);
  if (t.t !== 'table' || t.cols.join(',') !== 'CType,AType,CData,AData,State') throw new Error('unexpected meta columns');
  return t.rows.map((row, i) => {
    const [ct, at, cd, ad, st] = row;
    if (ct.t !== 'i' || at.t !== 'i' || st.t !== 's') throw new Error(`rule ${i + 1}: unexpected value types`);
    // VTank allows an empty state name; ours need one.
    return { cond: ct.v, condData: cd, act: at.v, actData: ad, state: st.v.trim() === '' ? '(unnamed)' : st.v };
  });
}

/** A lowercase k/v table as a map; a K/V table's rows as [id, data] pairs. */
const dict = (v: MetValue): Map<string, MetValue> => {
  const m = new Map<string, MetValue>();
  if (v.t === 'table') for (const [k, val] of v.rows) if (k.t === 's') m.set(k.v, val);
  return m;
};
const children = (v: MetValue): Array<{ id: number; data: MetValue }> =>
  v.t === 'table' ? v.rows.flatMap(([k, d]) => (k.t === 'i' ? [{ id: k.v, data: d }] : [])) : [];
const str = (v: MetValue | undefined): string => (v && (v.t === 's' || v.t === 'ba') ? v.v : '');
const num = (v: MetValue | undefined): number => (v && (v.t === 'i' || v.t === 'd') ? v.v : 0);

// ── .nav ──

export interface NavNode { type: number; ew: number; ns: number; z: number; extra: string[] }
export interface NavRoute { mode: 'circular' | 'linear' | 'follow' | 'once'; nodes: NavNode[]; follow?: { name: string; guid: number } }

const NODE_EXTRA_LINES: Record<number, number> = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 6, 7: 6, 8: 0, 9: 3 };
const NAV_MODES: Record<number, NavRoute['mode']> = { 1: 'circular', 2: 'linear', 3: 'follow', 4: 'once' };

function navBody(r: Reader): NavRoute {
  const head = r.line().trim();
  if (head !== 'uTank2 NAV 1.2') throw new Error(`not a VirindiTank navroute ("${head}")`);
  const mode = NAV_MODES[r.int()];
  if (!mode) throw new Error('unknown navroute type');
  if (mode === 'follow') return { mode, nodes: [], follow: { name: r.line(), guid: r.int() } };
  const count = r.int();
  const nodes: NavNode[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.int();
    const ew = r.num(); const ns = r.num(); const z = r.num();
    r.line(); // literal 0
    const n = NODE_EXTRA_LINES[type];
    if (n === undefined) throw new Error(`navroute point ${i + 1}: unknown type ${type}`);
    nodes.push({ type, ew, ns, z, extra: Array.from({ length: n }, () => r.line()) });
  }
  return { mode, nodes };
}

export function parseNav(text: string): NavRoute { return navBody(new Reader(crlf(text))); }

/** An EmbedNav action's `ba` content: name, node count, then a .nav body (empty when no nav was loaded). */
export function parseEmbeddedNav(content: string): { name: string; nav: NavRoute | null } {
  const r = new Reader(content);
  const name = r.line();
  if (r.done) return { name, nav: null };
  r.line(); // node count (the nav repeats it)
  if (r.done) return { name, nav: null };
  return { name, nav: navBody(r) };
}

/**
 * VTank map units (east / north positive; global metres / 240 − 101.95, as
 * ACE Position.GetMapCoords) → our "42.100N, 33.600E" form, which
 * parseMapCoords reads back with the same −101.95 origin: the same metre.
 */
export function navCoords(ew: number, ns: number): string {
  const f = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(3)}${v >= 0 ? pos : neg}`;
  return `${f(ns, 'N', 'S')}, ${f(ew, 'E', 'W')}`;
}

/** VTank's recall node spell ids (metaf NRecall.cs) and their spell names. */
export const RECALL_SPELLS: Record<number, string> = {
  48: 'Primary Portal Recall', 2647: 'Secondary Portal Recall', 1635: 'Lifestone Recall', 1636: 'Lifestone Sending',
  2645: 'Portal Recall', 2931: 'Recall Aphus Lassel', 2023: 'Recall the Sanctuary', 2943: 'Recall to the Singularity Caul',
  3865: 'Glenden Wood Recall', 2041: 'Aerlinthe Recall', 2813: 'Mount Lethe Recall', 2941: "Ulgrim's Recall", 4084: 'Bur Recall',
  4198: 'Paradox-touched Olthoi Infested Area Recall', 4128: 'Call of the Mhoire Forge', 4213: 'Colosseum Recall',
  5175: 'Facility Hub Recall', 5330: 'Gear Knight Invasion Area Camp Recall', 5541: 'Lost City of Neftet Recall', 4214: 'Return to the Keep',
  6150: 'Rynthid Recall', 6321: 'Viridian Rise Recall', 6322: 'Viridian Rise Great Tree Recall', 6325: 'Celestial Hand Stronghold Recall',
  6327: 'Radiant Blood Stronghold Recall', 6326: 'Eldrytch Web Stronghold Recall',
};

/** A Use Portal/NPC or NPC Talk point's object: name, class, `True`, then its E/W, N/S and Z. */
function objectRecord(n: NavNode): { objectClass?: number; at?: [number, number, number] } {
  const cls = Number(n.extra[1]);
  const at = [Number(n.extra[3]), Number(n.extra[4]), Number(n.extra[5])];
  return { ...(Number.isFinite(cls) ? { objectClass: cls } : {}), ...(at.every(Number.isFinite) ? { at: at as [number, number, number] } : {}) };
}

/** A navroute node's step on arrival, or null for a plain point; `problem` when it can't run. */
function nodeStep(n: NavNode): { do: RoutineAction[]; problem?: string } | { problem: string } | null {
  switch (n.type) {
    case 0: return null; // a plain point
    // Checkpoint: walked to like a point, then held until the server has you there.
    case 8: return { do: [{ kind: 'checkpoint' }] };
    case 2: { const id = Number(n.extra[0]); return { do: [{ kind: 'cast', spell: RECALL_SPELLS[id] ?? String(id), target: 'self' }] }; }
    case 3: return { do: [{ kind: 'wait', seconds: Math.max(0, Number(n.extra[0]) / 1000) }] };
    // A command we don't run (another plugin's /mt …, a /vt we lack) stays on the point as an unsupported step with
    // its text, so the route keeps it and an export writes it back (2026-10-11: three MossTank routes lost theirs).
    case 4: { const a = chatAction(n.extra[0] ?? '', { routes: [], problems: [], metName: '' }); const bad = a.find((x) => x.kind === 'unsupported'); return bad ? { do: a, problem: (bad as { what: string }).what } : { do: a }; }
    // Open Vendor: use the vendor and trade by the loot rules (the Route tab's Open Vendor makes the same two steps).
    case 5: return { do: [{ kind: 'use-object', name: n.extra[1] ?? '', ...(Number(n.extra[0]) ? { vt: { id: Number(n.extra[0]) } } : {}) }, { kind: 'sell-by-loot-rules', vendor: n.extra[1] ?? '' }] };
    // Use Portal/NPC and NPC Talk record the object's class and position: kept (vt) so an export writes them back.
    case 6: return { do: [{ kind: 'use-object', name: n.extra[0] ?? '', vt: objectRecord(n) }] };
    case 7: return { do: [{ kind: 'talk-to', name: n.extra[0] ?? '', vt: objectRecord(n) }] };
    case 9: return { do: [{ kind: 'jump', heading: normDeg(Number(n.extra[0]) || 0), ...(Number(n.extra[2]) > 0 ? { holdMs: Math.min(5000, Number(n.extra[2])) } : {}), ...(/^true$/i.test(n.extra[1] ?? '') ? { walk: true } : {}) }] };
    // The deprecated portal point: by object id (valid on the recording server only; the engine falls back to the portal nearest the point).
    case 1: { const id = Number(n.extra[0]); return Number.isFinite(id) ? { do: [{ kind: 'use-portal', id: id >>> 0 }] } : { problem: `a portal point with no object id ("${n.extra[0] ?? ''}")` }; }
    default: return { problem: `navroute step type ${n.type}` };
  }
}

/** A navroute as one of our routes: points, and on-arrival stops for its recall / pause / chat / use / jump steps. */
export function navToRoute(name: string, nav: NavRoute): { route: Route | null; problems: string[] } {
  if (nav.mode === 'follow') return { route: { name, mode: 'follow', points: [], ...(nav.follow?.name ? { follow: nav.follow.name } : {}) }, problems: [] };
  const points = nav.nodes.map((n) => navCoords(n.ew, n.ns));
  if (!points.length) return { route: null, problems: [`route "${name}" has no points`] };
  const stops: NonNullable<Route['stops']> = [];
  const problems: string[] = [];
  nav.nodes.forEach((n, i) => {
    const st = nodeStep(n);
    if (!st) return;
    if (st.problem) problems.push(`route "${name}" point ${i + 1}: ${'do' in st ? `can't run ${st.problem}; kept for export, skipped when walked` : `walked as a plain point (${st.problem})`}`);
    if ('do' in st) stops.push({ at: i, do: st.do });
  });
  // VTank's heights ride along (the engine walks map coordinates) so an exported .nav keeps them.
  const route: Route = { name, mode: nav.mode, points, z: nav.nodes.map((n) => n.z), ...(stops.length ? { stops } : {}) };
  if (problems.length) route.note = problems.map((x) => x.replace(`route "${name}" `, '')).join('; ');
  return { route, problems };
}

// ── meta → states ──

// `raw` keeps the meta element as read, so an export writes it back (vtankExport.ts).
const unsupportedCondition = (what: string, raw?: { id: number; data: MetValue }): RoutineCondition => ({ kind: 'unsupported', what, ...(raw ? { raw } : {}) });
const unsupportedAction = (what: string, raw?: { id: number; data: MetValue }): RoutineAction => ({ kind: 'unsupported', what, ...(raw ? { raw } : {}) });

/** A plain name when the regex is only literal text (our monster names match by substring). */
function literalName(re: string): string | null {
  const s = re.replace(/^\^/, '').replace(/\$$/, '');
  return /^[\w '’-]+$/.test(s) ? s : null;
}

interface ConvertCtx { routes: Route[]; problems: string[]; metName: string; usesNav?: boolean }

/** A plain value VTank options take ("true", "12", "Heavy"), or null when it's an expression. */
function settingLiteral(v: string): string | number | boolean | null {
  const t = v.trim();
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const bt = /^`([^`]*)`$/.exec(t);
  if (bt) return bt[1];
  return null;
}

/**
 * A Chat Command typed in the VirindiTank window's Edit Meta Rule: the same
 * conversion an imported one gets (VTank's own commands become our steps).
 */
export function vtankChatCommand(text: string, routeNames: string[]): RoutineAction[] {
  const routes: Route[] = routeNames.map((name) => ({ name, mode: 'circular', points: [] }));
  return chatAction(text, { routes, problems: [], metName: '' });
}

/** A meta Chat action: VTank's own commands become our steps; plugin and server commands can't run. */
/** VirindiTank's debug commands that the automation window handles (UtilityBelt's: ubVerbs.ts). */
const WINDOW_CHAT_COMMAND = /^\/(?:vt|vtank)\s+(?:dumpmetavars|listmetafunctions|metafunchelp|testspell|dumpspells|dumpskills|refresh)\b/i;
/** UtilityBelt's settings the client runs (`/ub opt set` of one reaches them; others stay a routine setting). */
const UB_SETTINGS_RUN = /^(Aliases\.Enabled|AutoTinker\.\w+|AutoVendor\.\w+|AutoXp\.\w+|EquipmentManager\.Think|GameEvents\.Enabled|InventoryManager\.(IGFailure|IGRange|IGThink|TreatStackAsSingleItem)|Jumper\.\w+|Plugin\.Portal\w+|QuestTracker\.AutoRequest)$/i;

function chatAction(text: string, ctx: ConvertCtx): RoutineAction[] {
  const t = text.trim();
  let m = /^\/(?:vt|vtank)\s+opt\s+set\s+(\S+)\s+(.+)$/i.exec(t);
  // VTank's option names are case-insensitive and its ranges are map units (yards / 240): ours are metres.
  if (m) { const lit = settingLiteral(m[2]); return [{ kind: 'set-setting', name: vtCanonicalName(m[1]), value: lit !== null ? vtFromVTank(m[1], lit) : m[2].trim() }]; }
  m = /^\/(?:vt|vtank)\s+setmetastate\s+(.+)$/i.exec(t);
  if (m) return [{ kind: 'set-state', state: m[1].trim() }];
  m = /^\/(?:vt|vtank)\s+loot\s+load\s+(.+)$/i.exec(t);
  if (m) return [{ kind: 'load-loot', set: m[1].trim().replace(/\.utl$/i, '') }];
  m = /^\/ub\s+mexec\s+(.+)$/i.exec(t);
  if (m) return [{ kind: 'expression', expr: m[1].trim() }];
  // UtilityBelt's jump: /ub jump[s][w][x][c] [heading] [hold ms] — s walk (Shift), w forward (x/c strafe: as forward).
  m = /^\/ub\s+jump(s?)([wxzc]?)\s*(-?\d+(?:\.\d+)?)?\s*(\d+)?\s*$/i.exec(t);
  if (m) return [{ kind: 'jump', ...(m[3] !== undefined ? { heading: normDeg(Number(m[3])) } : {}), ...(m[4] !== undefined ? { holdMs: Number(m[4]) } : {}), ...(m[2] ? { forward: true } : {}), ...(m[1] ? { walk: true } : {}) }];
  m = /^\/(?:vt|vtank)\s+nav\s+load\s+(.+)$/i.exec(t);
  if (m) {
    const name = m[1].trim();
    if (ctx.routes.some((r) => r.name === name)) { ctx.usesNav = true; return [{ kind: 'load-route', route: name }]; }
    return [unsupportedAction(`load navroute file "${name}" (import that .nav too)`, { id: 2, data: { t: 's', v: text } })];
  }
  // UtilityBelt's commands that are things a player does.
  m = /^\/ub\s+bc\s+(.+)$/i.exec(t); // broadcast to all your clients: here, the one
  if (m) return chatAction(m[1], ctx).map((a) => (a.kind === 'unsupported' && a.raw ? { ...a, raw: { id: 2, data: { t: 's', v: text } } } : a));
  m = /^\/ub\s+use[il]?\s+(.+)$/i.exec(t);
  if (m && !/\s+on\s+/i.test(m[1])) return [{ kind: 'use-object', name: m[1].trim() }];
  if (m) { const [item, target] = m[1].split(/\s+on\s+/i); return [/^(me|self)$/i.test(target.trim()) ? { kind: 'use-item', item: item.trim(), on: 'self' } : { kind: 'use-item', item: item.trim(), to: target.trim() }]; }
  m = /^\/ub\s+givei?\s+(?:(\d+)\s+)?(.+?)\s+to\s+(.+)$/i.exec(t);
  if (m) return [{ kind: 'give', item: m[2].trim(), to: m[3].trim(), ...(m[1] ? { count: Number(m[1]) } : {}) }];
  m = /^\/ub\s+combatstate\s+(peace|melee|missile|magic)\b/i.exec(t);
  if (m) return [{ kind: 'combat-mode', mode: m[1].toLowerCase() as 'peace' | 'melee' | 'missile' | 'magic' }];
  m = /^\/ub\s+opt\s+set\s+(\S+)\s+(.+)$/i.exec(t);
  if (m && UB_SETTINGS_RUN.test(m[1])) return [{ kind: 'say', text: t }];
  if (m) { const lit = settingLiteral(m[2]); return [{ kind: 'set-setting', name: `ub:${m[1]}`, value: lit ?? m[2].trim() }]; }
  if (/^\/ub\s+autovendor\b/i.test(t)) return [{ kind: 'sell-by-loot-rules', vendor: '' }];
  if (/^\/(?:vt|vtank)\s+stop\s*$/i.test(t)) return [{ kind: 'stop' }];
  // Commands the automation window runs as typed (VTankWindow.command, metaCommands.ts): kept as the chat line, which reaches it.
  if (WINDOW_CHAT_COMMAND.test(t) || ubVerbOf(t) !== null) return [{ kind: 'say', text: t }];
  if (/^\s*[/@]\s*(vt|ub|mt|vtank|utilitybelt|magtools|dt)\b/i.test(t) || /^\s*@/.test(t)) return [unsupportedAction(`chat command "${t}"`, { id: 2, data: { t: 's', v: text } })];
  return [{ kind: 'say', text: t }];
}

/** One VTank condition as ours: All / Any / Not keep their shape. */
function convertCondition(id: number, data: MetValue, ctx: ConvertCtx): RoutineCondition {
  const d = dict(data);
  switch (id) {
    case 0: return { kind: 'not', condition: { kind: 'always' } };
    case 1: return { kind: 'always' };
    case 2: return { kind: 'all', conditions: children(data).map((c) => convertCondition(c.id, c.data, ctx)) };
    case 3: return { kind: 'any', conditions: children(data).map((c) => convertCondition(c.id, c.data, ctx)) };
    case 4: return { kind: 'chat-matches', pattern: str(data) };
    case 5: return { kind: 'free-slots-below', slots: num(data) + 1 };
    case 6: return { kind: 'seconds-in-state', seconds: num(data) };
    case 11: return { kind: 'item-count-below', item: str(d.get('n')), count: num(d.get('c')) + 1 };
    case 12: return { kind: 'not', condition: { kind: 'item-count-below', item: str(d.get('n')), count: num(d.get('c')) } };
    case 13: {
      const name = literalName(str(d.get('n')));
      const count = Math.max(1, num(d.get('c')));
      if (name && count === 1) return { kind: 'monster-within', meters: num(d.get('r')), names: [name] };
      return { kind: 'monster-count', pattern: str(d.get('n')) || '.', count, meters: num(d.get('r')) };
    }
    case 16: return { kind: 'no-monster-within', meters: num(d.get('r')) };
    case 21: {
      const [c] = children(data);
      if (!c) return unsupportedCondition('an empty Not', { id, data });
      return { kind: 'not', condition: convertCondition(c.id, c.data, ctx) };
    }
    case 24: return { kind: 'burden-above', percent: Math.max(0, num(data) - 1) };
    case 28: {
      // The colour list is ';'-separated chat-type ids ("0;2"); empty means any.
      const raw = str(d.get('c')).trim();
      const colors = raw ? raw.split(';').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0) : [];
      return { kind: 'chat-capture', pattern: str(d.get('p')), ...(colors.length ? { colors } : {}) };
    }
    case 7: return { kind: 'route-done' };
    case 8: return { kind: 'died' };
    case 9: return { kind: 'vendor-open' };
    case 10: return { kind: 'vendor-closed' };
    case 14: return { kind: 'monster-priority-count', priority: num(d.get('p')), count: Math.max(1, num(d.get('c'))), meters: num(d.get('r')) };
    case 15: return { kind: 'need-buff' };
    case 17: return { kind: 'landblock', landblock: num(data) >>> 0 };
    case 18: return { kind: 'landcell', cell: num(data) >>> 0 };
    case 19: return { kind: 'portal-entered' };
    case 20: return { kind: 'portal-exited' };
    case 22: return { kind: 'seconds-in-state-persistent', seconds: num(data) };
    case 23: return { kind: 'spell-time-at-least', spell: '', spellId: num(d.get('sid')), seconds: num(d.get('sec')) };
    // Meta distances are yards (metaf reference: "DistToRteGE … (in yards)"), a game metre: ours as they are.
    case 25: return { kind: 'route-distance-at-least', meters: num(d.get('dist')) };
    case 26: return { kind: 'expression', expr: str(d.get('e')) };
    default: return unsupportedCondition(`VirindiTank condition type ${id}`, { id, data });
  }
}

function convertAction(id: number, data: MetValue, ctx: ConvertCtx): RoutineAction[] {
  const d = dict(data);
  switch (id) {
    case 0: return [];
    case 1: return [{ kind: 'set-state', state: str(data) }];
    case 2: return chatAction(str(data), ctx);
    case 3: return children(data).flatMap((c) => convertAction(c.id, c.data, ctx));
    case 4: {
      const { name, nav } = parseEmbeddedNav(str(data));
      if (!nav) return [unsupportedAction(`load navroute "${name}" (empty)`, { id, data })];
      ctx.usesNav = true;
      let routeName = (name && name !== '[None]' ? name : `${ctx.metName} route`).trim();
      for (let n = 2; ctx.routes.some((r) => r.name === routeName); n++) routeName = `${name || ctx.metName} (${n})`;
      const { route, problems } = navToRoute(routeName, nav);
      ctx.problems.push(...problems);
      if (!route) return [unsupportedAction(`load navroute "${name}"`, { id, data })];
      ctx.routes.push(route);
      // VTank's Embed Nav loads the route; its macro walks it (the profile's macro is on).
      return [{ kind: 'load-route', route: route.name }];
    }
    case 5: return [{ kind: 'call-state', state: str(d.get('st')), returnTo: str(d.get('ret')) }];
    case 6: return [{ kind: 'return' }];
    case 7: return [{ kind: 'expression', expr: str(d.get('e')) }];
    case 8: return [{ kind: 'expression', expr: `chatbox[${str(d.get('e'))}]` }];
    case 9: return [{ kind: 'set-watchdog', state: str(d.get('s')), meters: num(d.get('r')), seconds: Math.max(1, num(d.get('t'))) }];
    case 10: return [{ kind: 'clear-watchdog' }];
    case 11: return [{ kind: 'expression', expr: `setvar[${str(d.get('v'))},vtgetsetting[${str(d.get('o'))}]]` }];
    case 12: {
      const lit = settingLiteral(str(d.get('v')));
      return lit !== null ? [{ kind: 'set-setting', name: vtCanonicalName(str(d.get('o'))), value: vtFromVTank(str(d.get('o')), lit) }] : [{ kind: 'expression', expr: `vtsetsetting[${str(d.get('o'))},${str(d.get('v'))}]` }];
    }
    case 13: return [{ kind: 'create-view', name: str(d.get('n')), xml: str(d.get('x')) }];
    case 14: return [{ kind: 'destroy-view', name: str(d.get('n')) }];
    case 15: return [{ kind: 'destroy-all-views' }];
    default: return [unsupportedAction(`VirindiTank action type ${id}`, { id, data })];
  }
}

export interface ImportResult<T> { value: T; problems: string[] }

/** Every unsupported step in a condition (through Not / Any / All) or an action list. */
function unsupportedIn(xs: Array<RoutineCondition | RoutineAction>): string[] {
  return xs.flatMap((x) => (x.kind === 'unsupported' ? [x.what] : x.kind === 'not' ? unsupportedIn([x.condition]) : x.kind === 'any' || x.kind === 'all' ? unsupportedIn(x.conditions) : []));
}

/** What keeps a condition from ever holding here: an unsupported check, unless an Any has a branch without one. */
function blockersOf(c: RoutineCondition): string[] {
  if (c.kind === 'unsupported') return [c.what];
  if (c.kind === 'not') return unsupportedIn([c.condition]);
  if (c.kind === 'all') return c.conditions.flatMap(blockersOf);
  if (c.kind === 'any') { const each = c.conditions.map(blockersOf); return each.length && each.every((b) => b.length) ? each.flat() : []; }
  return [];
}

/**
 * A meta as a routine profile. VTank's own combat, looting, buffing and
 * navigation run from its settings, not the meta, so the profile's macro is
 * on with VTank's default settings (the metas then switch them with
 * vtsetsetting / /vt opt set, as in VTank).
 */
export function metToProfile(name: string, rules: MetRule[], fileName = `${name}.met`): ImportResult<RoutineProfile> {
  const ctx: ConvertCtx = { routes: [], problems: [], metName: name };
  const states: RoutineState[] = [];
  const stateFor = (n: string): RoutineState => {
    let s = states.find((x) => x.name === n);
    if (!s) { s = { name: n, rules: [] }; states.push(s); }
    return s;
  };
  rules.forEach((mr, i) => {
    const cond = convertCondition(mr.cond, mr.condData, ctx);
    // A top-level All is the rule's own condition list (ours are ANDed); anything else is its one condition.
    const when = cond.kind === 'all' ? (cond.conditions.length ? cond.conditions : [{ kind: 'always' } as RoutineCondition]) : [cond];
    const actions = convertAction(mr.act, mr.actData, ctx);
    const doList = actions.length ? actions : [unsupportedAction('no action', { id: mr.act, data: mr.actData })];
    const rule: RoutineRule = { label: `Rule ${i + 1}`, when, do: doList };
    // Only what stops the rule from ever running switches it off; an Any branch it can't test just never holds.
    const blocked = [...when.flatMap(blockersOf), ...unsupportedIn(doList)];
    if (blocked.length) {
      rule.disabled = true;
      rule.note = `From VirindiTank; can't run: ${blocked.join('; ')}`;
    }
    for (const b of new Set(unsupportedIn([...when, ...doList]))) ctx.problems.push(`state "${mr.state}" rule ${i + 1}: ${b}`);
    stateFor(mr.state).rules.push(rule);
  });
  if (!states.length) states.push({ name: 'Default', rules: [] });
  // Targets of Set State that the meta never defines still need to exist.
  // VTank allows an empty state name; ours need one (the rules' own states are renamed on parse).
  for (const s of states) for (const r of s.rules) for (const a of r.do) {
    if ((a.kind === 'set-state' || a.kind === 'call-state' || a.kind === 'set-watchdog') && a.state.trim() === '') a.state = '(unnamed)';
    if (a.kind === 'call-state' && a.returnTo.trim() === '') a.returnTo = '(unnamed)';
  }
  for (const s of [...states]) for (const r of s.rules) for (const a of r.do) {
    if (a.kind === 'set-state' || a.kind === 'set-watchdog') stateFor(a.state);
    if (a.kind === 'call-state') { stateFor(a.state); stateFor(a.returnTo); }
  }
  const initial = states.find((s) => s.name === 'Default')?.name ?? states[0].name;
  return {
    value: {
      name, description: `Imported from VirindiTank meta ${fileName}`,
      modules: { ...ALL_MODULES_OFF, combat: true, looting: true, navigation: true, vitals: true, buffs: true, inventory: true },
      initialState: initial, states, loot: [], buffSets: [], routes: ctx.routes,
      // VTank's macro fights, loots and walks the loaded route from its settings, outside the meta.
      macro: true,
      ruleFiring: 'once',
      settings: { EnableCombat: true, EnableLooting: true, EnableNav: true, EnableBuffing: false, AttackDistance: 20 },
    },
    problems: ctx.problems,
  };
}

// ── .utl ──

export interface UtlRequirement { type: number; lines: string[] }
export interface UtlRule { name: string; action: number; keepCount?: number; reqs: UtlRequirement[] }

export function parseUtl(text: string): UtlRule[] { return parseUtlFile(text).rules; }

/**
 * A .utl's rules and its SalvageCombine block (VTClassic UTLFileExtraBlockManager: after the rules,
 * `<blockTypeId>`, `<lengthChars>`, that many chars, until the end; unknown blocks are skipped by length).
 * No block: `salvageCombine` is absent (VTank then uses VTClassic's defaults).
 */
export function parseUtlFile(text: string): { rules: UtlRule[]; salvageCombine?: SalvageCombine } {
  const r = new Reader(crlf(text));
  const rules = utlRules(r);
  let salvageCombine: SalvageCombine | undefined;
  // The rules are the profile; a damaged block after them is skipped, not a reason to refuse the file.
  try {
    while (!r.done) {
      const id = r.line().trim();
      if (id === '') continue;
      if (r.done) break;
      const len = r.int();
      // A block cut short (a hand-edited file) is read as far as it goes.
      const chunk = r.chars(Math.min(len, Math.max(0, r.text.length - r.pos)));
      if (id === 'SalvageCombine') salvageCombine = parseSalvageCombineBlock(chunk) ?? salvageCombine;
    }
  } catch { /* the blocks read so far stand */ }
  return { rules, ...(salvageCombine ? { salvageCombine } : {}) };
}

/**
 * The SalvageCombine block's body (UTLBlock_SalvageCombine.Read): format version, the default band
 * string, a count of material overrides and that many (material, bands) line pairs, then (newer blocks
 * only) a count of value-mode materials and that many (material, value) pairs. Null when it is cut
 * short before the override count.
 */
export function parseSalvageCombineBlock(chunk: string): SalvageCombine | null {
  const lines = chunk.split('\r\n');
  if (lines.length < 2) return null;
  let i = 1;
  const out: SalvageCombine = { default: lines[i++] };
  const int = (): number | null => { const l = (lines[i++] ?? '').trim(); return /^-?\d+$/.test(l) ? Number(l) : null; };
  const n = int();
  if (n === null) return null;
  const materials: Record<string, string> = {};
  for (let k = 0; k < n && i < lines.length; k++) { const m = int(); const bands = lines[i++] ?? ''; if (m !== null) materials[String(m)] = bands; }
  out.materials = materials;
  if (i >= lines.length || (lines[i] ?? '').trim() === '') return out;
  const v = int();
  if (v === null || v <= 0) return out;
  const valueModes: Record<string, number> = {};
  for (let k = 0; k < v && i < lines.length; k++) { const m = int(); const val = int(); if (m !== null && val !== null) valueModes[String(m)] = val; }
  out.valueModes = valueModes;
  return out;
}

/**
 * Data lines each requirement type reads (VTClassic LootRules.cs, each class's Read(); MIT, Copyright (c)
 * 2009-2010 VirindiPlugins): what a version-0 .utl, which has no length codes, needs to read one.
 */
export const UTL_V0_LINES: Record<number, number> = {
  0: 1, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 1, 7: 1, 8: 1, 9: 3, 10: 1, 11: 2, 12: 2, 13: 2, 14: 5, 15: 6, 16: 6, 17: 2,
  1000: 2, 1001: 1, 1002: 1, 1003: 1, 1004: 3, 2000: 1, 2001: 1, 2003: 2, 2005: 2, 2006: 1, 2007: 1, 2008: 3, 9999: 1,
};

function utlRules(r: Reader): UtlRule[] {
  let first = r.line().trim();
  let version = 0;
  if (first === 'UTL') { version = r.int(); first = r.line().trim(); }
  if (version > 1) throw new Error(`VTClassic profile version ${version} is newer than this importer knows`);
  const count = Number(first);
  if (!Number.isInteger(count) || count < 0) throw new Error('not a VTClassic loot profile');
  const rules: UtlRule[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.line();
    if (version >= 1) r.line(); // expression (unused)
    const big = r.line().split(';').map((x) => x.trim()).filter((x) => x !== '');
    const action = Number(big[1]);
    const types = big.slice(2).map(Number);
    const keepCount = action === 10 ? r.int() : undefined;
    const reqs: UtlRequirement[] = types.map((type) => {
      if (version >= 1) {
        const len = r.int();
        const chunk = r.chars(len);
        return { type, lines: chunk.split('\r\n').filter((l, j, a) => j < a.length - 1 || l !== '') };
      }
      // Version 0 has no length codes: each requirement reads its own number of lines (UTL_V0_LINES).
      const n = UTL_V0_LINES[type];
      if (n === undefined) throw new Error(`version-0 VTClassic profile: requirement type ${type} is unknown, and the file gives no length to skip it`);
      const lines: string[] = [];
      for (let k = 0; k < n; k++) lines.push(r.line());
      return { type, lines };
    });
    rules.push({ name, action, ...(keepCount !== undefined ? { keepCount } : {}), reqs });
  }
  return rules;
}

/** Decal ObjectClass → the item type label our loot rules match (only the classes that are one ItemType). */
export const OBJECT_CLASS_TYPES: Record<number, string> = {
  1: 'Melee Weapon', 2: 'Armor', 3: 'Clothing', 4: 'Jewelry', 6: 'Food', 7: 'Money', 8: 'Misc', 9: 'Missile Weapon',
  10: 'Container', 11: 'Gem', 12: 'Spell Components', 13: 'Key', 14: 'Portal', 15: 'Promissory Note', 16: 'Mana Stone',
  31: 'Caster', 39: 'Tinkering Material',
};
/** Decal object classes that are an ObjectDescriptionFlag rather than an item type: HealingKit, Lockpick, Book. */
export const OBJECT_CLASS_FLAGS: Record<number, number> = { 29: 0x10000, 30: 0x20000, 33: 0x100 };
/**
 * VTClassic's armour groups → subpalette slots, from ColorSlots.Default.xml
 * (http://www.virindi.net/repos/virindi_public, VTClassic Shared; MIT, Copyright (c) 2009-2010 VirindiPlugins).
 */
export const VTCLASSIC_COLOR_SLOTS: Record<string, number[]> = {
  "Amuli Coat (Chest)": [0],
  "Amuli Coat (Collar/Shoulder)": [1, 2],
  "Amuli Coat (Arms/Trim)": [3, 4, 5, 6, 7],
  "Amuli Legs (Base)": [0, 1],
  "Amuli Legs (Trim)": [2, 3],
  "Celdon (Base)": [0],
  "Celdon (Veins)": [1, 2],
  "Chiran Coat (Base/Arms)": [0, 1],
  "Chiran Coat (Stripes)": [2, 3, 4],
  "Chiran Legs (Girth)": [1],
  "Chiran Legs (Legs)": [2, 3],
  "Chiran Legs (Trim)": [0],
  "Chiran Helm (Horns)": [0],
  "Chiran Helm (Base)": [1],
  "Haebrean BP (Chest) *": [0],
  "Haebrean BP (Ornaments)": [1],
  "Haebrean BP (Trim)": [2],
  "Haebrean Girth (Base) *": [0],
  "Haebrean Girth (Belt/Scales)": [1, 2],
  "Haebrean Helm (Base)": [0],
  "Haebrean Helm (Mask)": [1],
  "Haebrean Pauldrons (Base) *": [0],
  "Haebrean Pauldrons (Ornaments)": [1],
  "Lorica BP (Veins)": [0, 1],
  "Lorica BP (Base)": [2, 3],
  "Lorica BP (Neck/Trim) *": [4],
  "Lorica Legs (Base)": [0],
  "Lorica Legs (Knees/Belt/Crotch) *": [1, 2],
  "Lorica Legs (Legs) *": [3],
  "Nariyid BP (Circle/Lines)": [0, 1],
  "Nariyid BP (Base)": [2],
  "Nariyid BP (Shoulders)": [3],
  "Nariyid Girth (Base) *": [0],
  "Nariyid Girth (Belt/Lines)": [2],
  "Nariyid Girth (Ornaments)": [3],
  "Nariyid Sleeves (Shoulders)": [0],
  "Nariyid Sleeves (Upper Arm)": [1, 2],
  "Nariyid Sleeves (Lower Arm)": [3],
  "Olthoi BP (Base)": [0],
  "Olthoi BP (Veins)": [1],
  "Olthoi Alduressa Legs (Girth: Base)": [0, 1, 2],
  "Olthoi Alduressa Legs (Girth: Lines)": [3],
  "Olthoi Alduressa Legs (Legs: Lines)": [4, 5],
  "Olthoi Amuli Coat (Base) *": [0, 1],
  "Olthoi Amuli Coat (Trim)": [2],
  "Olthoi Amuli Coat (Shoulders)": [3],
  "Olthoi Amuli Legs (Trim)": [6, 7, 8],
  "Olthoi Koujia Kabuton (Base)": [0],
  "Olthoi Koujia Kabuton (Horns)": [1],
  "Olthoi Koujia Legs (Base)": [0, 1, 2],
  "Olthoi Koujia Legs (Sides/Shins)": [3, 4, 5],
  "Scalemail Cuirass (Base)": [0],
  "Scalemail Cuirass (Bumps)": [1],
  "Scalemail Cuirass (Belt)": [2],
  "Tenassa Legs (Line at Side)": [0],
  "Tenassa Legs (Base)": [1],
  "Tenassa Legs (Hilight)": [2],
  "Tenassa BP (Shoulders)": [0],
  "Tenassa BP (Base)": [1],
  "Yoroi Cuirass (Base)": [0, 1],
  "Yoroi Cuirass (Belt)": [2],
  "Yoroi Girth (Base)": [0],
  "Yoroi Girth (Belt)": [1],
};

/**
 * VTClassic's eLootAction → ours. Read (4) takes the item and reads a scroll you can learn. User1–User5 (5–9) are
 * for other plugins; VTank loots them like Keep (MOSS LootAction: every action but NoLoot is picked up), so they
 * import as Keep with their id kept for export.
 */
export const UTL_ACTIONS: Record<number, LootAction> = { 0: 'ignore', 1: 'keep', 2: 'salvage', 3: 'sell', 4: 'read', 5: 'keep', 6: 'keep', 7: 'keep', 8: 'keep', 9: 'keep', 10: 'keep-up-to' };

/**
 * Loot rules imported before Read and User1–5 had actions (before 2026-10-11) were stored switched
 * off with the note "VTClassic action Read|UserN has no equivalent" and the action id in `vtc`. This
 * turns them into what the importer makes now, in place, so stored profiles need no re-import.
 * Returns how many rules changed.
 */
export function upgradeStoredLootRules(doc: unknown): number {
  const profiles = (doc as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(profiles)) return 0;
  let n = 0;
  const fix = (rules: unknown) => {
    if (!Array.isArray(rules)) return;
    for (const r of rules as LootRule[]) {
      const id = r?.vtc?.action;
      if (!r?.disabled || typeof id !== 'number' || id < 4 || id > 9 || !/has no equivalent$/.test(r.note ?? '')) continue;
      r.action = UTL_ACTIONS[id];
      delete r.disabled;
      if (id === 4) { delete r.note; delete r.vtc!.action; if (!r.vtc!.reqs) delete r.vtc; }
      else r.note = `VTClassic action User${id - 4}: looted and kept`;
      n++;
    }
  };
  for (const p of profiles as Array<{ loot?: unknown; lootSets?: Record<string, unknown> }>) {
    fix(p?.loot);
    for (const set of Object.values(p?.lootSets ?? {})) fix(set);
  }
  return n;
}
const UTL_REQ_NAMES: Record<number, string> = {
  0: 'spell name matches', 6: 'damage percent', 8: 'spell count', 9: 'spells match', 10: 'minimum damage', 11: 'property flag', 12: 'property equals',
  13: 'property not equal', 14: 'similar colour', 15: 'similar colour on armour type', 16: 'similar colour in slot', 17: 'exact palette in slot',
  1000: 'character skill', 1001: 'character free pack slots', 1002: 'character level at least', 1003: 'character level at most', 1004: 'character base skill',
  2000: 'buffed median damage', 2001: 'buffed missile damage', 2003: 'buffed property', 2005: 'buffed property', 2006: 'buffed tinked damage',
  2007: 'total ratings', 2008: 'buffed tinked target melee',
};
/**
 * Decal's synthesized value keys (VTClassic Constants.cs) as the ACE property
 * an appraisal reports: IntValueKey StackCount → int StackSize 12, MaxDamage →
 * int Damage 44, IconUnderlay → DID IconUnderlay 52; DoubleValueKey SlashProt…
 * ColdProt → float ArmorModVs* 13–19, Variance → DamageVariance 22,
 * AttackBonus → WeaponOffense 62, DamageBonus → DamageMod 63,
 * SalvageWorkmanship → int ItemWorkmanship 105. Below 0x10000 a key is the
 * ACE property id itself.
 */
export const DECAL_INT_KEYS: Record<number, { kind: 'int' | 'did'; key: number }> = {
  218103814: { kind: 'int', key: 12 }, 218103842: { kind: 'int', key: 44 }, 218103850: { kind: 'did', key: 52 },
  // Type → ItemType 1, Coverage → ClothingPriority 4, EquipableSlots → ValidLocations 9, DamageType 45;
  // Icon → DID Icon 8, IconOverlay → DID IconOverlay 50.
  218103808: { kind: 'int', key: 1 }, 218103821: { kind: 'int', key: 4 }, 218103822: { kind: 'int', key: 9 },
  218103841: { kind: 'int', key: 45 }, 218103809: { kind: 'did', key: 8 }, 218103849: { kind: 'did', key: 50 },
};
export const DECAL_FLOAT_KEYS: Record<number, { kind: 'float' | 'int'; key: number }> = {
  167772160: { kind: 'float', key: 13 }, 167772161: { kind: 'float', key: 14 }, 167772162: { kind: 'float', key: 15 },
  167772163: { kind: 'float', key: 18 }, 167772164: { kind: 'float', key: 19 }, 167772165: { kind: 'float', key: 17 },
  167772166: { kind: 'float', key: 16 }, 167772169: { kind: 'int', key: 105 }, 167772171: { kind: 'float', key: 22 },
  167772172: { kind: 'float', key: 62 }, 167772174: { kind: 'float', key: 63 },
};
export const DECAL_SPELL_COUNT = 218103838;
const intKey = (k: number): { kind: 'int' | 'did'; key: number } | null => (k < 0x10000 ? { kind: 'int', key: k } : DECAL_INT_KEYS[k] ?? null);
const floatKey = (k: number): { kind: 'float' | 'int'; key: number } | null => (k < 0x10000 ? { kind: 'float', key: k } : DECAL_FLOAT_KEYS[k] ?? null);

const PROP_VALUE = 19;
const PROP_BURDEN = 5;
const STRING_NAME = 1;

/** VTClassic rules as our loot rules, in order; requirements we can't test are kept and stop the rule matching. */
export function utlToLoot(rules: UtlRule[]): ImportResult<LootRule[]> {
  const problems: string[] = [];
  const out = rules.map((u, i): LootRule => {
    const match: LootMatch = {};
    const cant: string[] = [];
    const raw: UtlRequirement[] = [];
    const names: string[] = [];
    const props: NonNullable<LootMatch['props']> = [];
    let disabled = false;
    // Each spell requirement must hold: the first is `spells`, any more are `moreSpells` (before 2026-10-11 the last one replaced the others).
    const spell = (t: NonNullable<LootMatch['spells']>) => { if (!match.spells) match.spells = t; else (match.moreSpells ??= []).push(t); };
    const intTest = (key: number, op: 'le' | 'ge' | 'eq' | 'ne' | 'flag', value: number, label: string) => {
      if (key === DECAL_SPELL_COUNT && op === 'ge') { match.spellCountAtLeast = value; return; }
      const k = intKey(key);
      if (k) props.push({ kind: k.kind, key: k.key, op, value }); else cant.push(`${label} on Decal key ${key}`);
    };
    for (const q of u.reqs) {
      const [a, b] = q.lines;
      const before = cant.length;
      switch (q.type) {
        case 0: spell({ match: a ?? '', count: 1 }); break;
        case 1: if (Number(b) === STRING_NAME) names.push(a); else if (Number(b) < 0x10000) props.push({ kind: 'string', key: Number(b), op: 'match', value: a }); else cant.push(`string property ${b} matches /${a}/`); break;
        case 2: if (Number(b) === PROP_VALUE) match.valueAtMost = Math.min(match.valueAtMost ?? Infinity, Number(a)); else if (Number(b) === PROP_BURDEN) match.burdenAtMost = Math.min(match.burdenAtMost ?? Infinity, Number(a)); else intTest(Number(b), 'le', Number(a), 'property ≤'); break;
        case 3: if (Number(b) === PROP_VALUE) match.valueAtLeast = Math.max(match.valueAtLeast ?? -Infinity, Number(a)); else intTest(Number(b), 'ge', Number(a), 'property ≥'); break;
        case 4: case 5: { const k = floatKey(Number(b)); if (k) props.push({ kind: k.kind, key: k.key, op: q.type === 4 ? 'le' : 'ge', value: Number(String(a).replace(',', '.')) }); else cant.push(`float property ${b} ${q.type === 4 ? '≤' : '≥'} ${a}`); break; }
        case 7: {
          const t = OBJECT_CLASS_TYPES[Number(a)];
          const f = OBJECT_CLASS_FLAGS[Number(a)];
          if (t) match.types = [t]; else if (f) match.descFlags = (match.descFlags ?? 0) | f; else cant.push(`object class ${a}`);
          break;
        }
        case 8: match.spellCountAtLeast = Math.max(match.spellCountAtLeast ?? -Infinity, Number(a)); break;
        case 9: spell({ match: a ?? '', ...(b ? { notMatch: b } : {}), count: Math.max(1, Number(q.lines[2]) || 1) }); break;
        case 11: intTest(Number(b), 'flag', Number(a), 'property flag'); break;
        case 12: intTest(Number(b), 'eq', Number(a), 'property equals'); break;
        case 13: intTest(Number(b), 'ne', Number(a), 'property not equal'); break;
        case 14: case 15: case 16: {
          const [r, g, bl, h, sv, extra] = q.lines;
          const c = { rgb: [Number(r), Number(g), Number(bl)] as [number, number, number], maxHue: Number(String(h).replace(',', '.')), maxSV: Number(String(sv).replace(',', '.')) };
          if (q.type === 14) (match.colours ??= []).push(c);
          else if (q.type === 16) (match.colours ??= []).push({ ...c, slots: [Number(extra)] });
          else if (VTCLASSIC_COLOR_SLOTS[extra ?? '']) (match.colours ??= []).push({ ...c, slots: VTCLASSIC_COLOR_SLOTS[extra!], group: extra });
          else cant.push(`armour group "${extra}" (not in VTClassic's colour slot table)`);
          break;
        }
        case 17: (match.palettes ??= []).push({ slot: Number(a), palette: Number(b) }); break;
        case 2007: match.totalRatingsAtLeast = Math.max(match.totalRatingsAtLeast ?? -Infinity, Number(String(a).replace(',', '.'))); break;
        case 10: match.minDamageAtLeast = Math.max(match.minDamageAtLeast ?? -Infinity, Number(String(a).replace(',', '.'))); break;
        case 1000: (match.characterSkills ??= []).push({ skill: Number(b), atLeast: Number(a) }); break;
        case 1001: match.freeSlotsAtLeast = Math.max(match.freeSlotsAtLeast ?? -Infinity, Number(a)); break;
        case 1002: match.characterLevelAtLeast = Math.max(match.characterLevelAtLeast ?? -Infinity, Number(a)); break;
        case 1003: match.characterLevelAtMost = Math.min(match.characterLevelAtMost ?? Infinity, Number(a)); break;
        case 1004: (match.characterSkills ??= []).push({ skill: Number(a), baseMin: Number(b), baseMax: Number(q.lines[2]) }); break;
        case 9999: if (/^true$/i.test(a ?? '')) disabled = true; break;
        default: cant.push(`${UTL_REQ_NAMES[q.type] ?? `requirement type ${q.type}`}${q.lines.length ? ` (${q.lines.join(', ')})` : ''}`);
      }
      if (cant.length > before) raw.push({ type: q.type, lines: [...q.lines] });
    }
    // Several name requirements must all match: one regex with a lookahead per pattern.
    if (props.length) match.props = props;
    if (names.length === 1) match.name = names[0];
    else if (names.length > 1) match.name = names.map((n) => `(?=[\\s\\S]*?(?:${n}))`).join('');
    const action = UTL_ACTIONS[u.action];
    const rule: LootRule = { label: u.name, action: action ?? 'keep', match };
    if (action === 'keep-up-to') rule.count = Math.max(1, u.keepCount ?? 1);
    if (cant.length) { match.unsupported = cant.join('; '); problems.push(`loot rule ${i + 1} "${u.name}": can't test ${cant.join('; ')}`); }
    const user = u.action >= 5 && u.action <= 9;
    if (user) rule.note = `VTClassic action User${u.action - 4}: looted and kept`;
    if (!action) { disabled = true; rule.note = `VTClassic action ${u.action} has no equivalent`; problems.push(`loot rule ${i + 1} "${u.name}": ${rule.note}`); }
    if (disabled) rule.disabled = true;
    // Kept as written so an export (vtankExport.ts) writes them back.
    if (!action || user || raw.length) rule.vtc = { ...(!action || user ? { action: u.action } : {}), ...(raw.length ? { reqs: raw } : {}) };
    return rule;
  });
  return { value: out, problems };
}

/** Which kind of VirindiTank file this is, by name or content. */
export function vtankKind(fileName: string, text: string): 'met' | 'nav' | 'utl' | null {
  const ext = /\.(met|nav|utl)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'met' || ext === 'nav' || ext === 'utl') return ext;
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('uTank2 NAV')) return 'nav';
  if (/^1\r?\nCondAct/.test(t)) return 'met';
  if (t.startsWith('UTL')) return 'utl';
  return null;
}

/**
 * Import VirindiTank files into one profile: a .met makes the profile (or
 * replaces its states), a .nav adds a route, a .utl replaces its loot rules.
 * `base` is the profile to add to (a copy is returned); without one the
 * profile is new.
 */
export function importVTank(files: Array<{ name: string; text: string }>, base: RoutineProfile | null, profileName: string): ImportResult<RoutineProfile> {
  const problems: string[] = [];
  let p: RoutineProfile = base ? structuredClone(base) : {
    name: profileName, modules: { ...ALL_MODULES_OFF, combat: true, looting: true, navigation: true, vitals: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [],
  };
  const stem = (f: string) => f.replace(/^.*[\\/]/, '').replace(/\.(met|nav|utl)$/i, '');
  // Metas first (they replace states), then routes and loot.
  const order = { met: 0, nav: 1, utl: 2 } as const;
  const typed = files.map((f) => ({ ...f, kind: vtankKind(f.name, f.text) }));
  for (const f of typed.filter((x) => !x.kind)) problems.push(`${f.name}: not a VirindiTank .met, .nav or .utl file`);
  for (const f of typed.filter((x) => x.kind).sort((a, b) => order[a.kind!] - order[b.kind!])) {
    try {
      if (f.kind === 'met') {
        const r = metToProfile(profileName, parseMet(f.text), f.name.replace(/^.*[\\/]/, ''));
        p = { ...r.value, name: p.name, loot: p.loot.length ? p.loot : r.value.loot, buffSets: p.buffSets, routes: [...p.routes.filter((x) => !r.value.routes.some((y) => y.name === x.name)), ...r.value.routes] };
        problems.push(...r.problems.map((x) => `${f.name}: ${x}`));
      } else if (f.kind === 'nav') {
        let name = stem(f.name);
        for (let n = 2; p.routes.some((r) => r.name === name); n++) name = `${stem(f.name)} (${n})`;
        const r = navToRoute(name, parseNav(f.text));
        if (r.route) p.routes.push(r.route);
        problems.push(...r.problems.map((x) => `${f.name}: ${x}`));
      } else {
        const file = parseUtlFile(f.text);
        const r = utlToLoot(file.rules);
        // Every loot profile is a named set (/vt loot load switches); the first one is the active rules.
        p.lootSets = { ...(p.lootSets ?? {}), [stem(f.name)]: r.value };
        // Its SalvageCombine bands go with it (VTank's CombineSalvage reads the loaded profile's).
        if (file.salvageCombine) p.salvageCombineSets = { ...(p.salvageCombineSets ?? {}), [stem(f.name)]: file.salvageCombine };
        if (!typed.some((x) => x.kind === 'utl' && x !== f && typed.indexOf(x) < typed.indexOf(f))) {
          p.loot = r.value;
          if (file.salvageCombine) p.salvageCombine = file.salvageCombine; else delete p.salvageCombine;
        }
        problems.push(...r.problems.map((x) => `${f.name}: ${x}`));
      }
    } catch (e) {
      problems.push(`${f.name}: could not read it (${(e as Error).message})`);
    }
  }
  // /vt loot load names a .utl file: point it at the imported set of that name, or say which file to import.
  const sets = Object.keys(p.lootSets ?? {});
  const fixLoot = (actions: RoutineAction[]): { actions: RoutineAction[]; missing: string[] } => {
    const missing: string[] = [];
    const out = actions.map((a): RoutineAction => {
      if (a.kind !== 'load-loot') return a;
      const hit = sets.find((k) => k.toLowerCase() === a.set.toLowerCase());
      if (hit) return { kind: 'load-loot', set: hit };
      missing.push(a.set);
      return unsupportedAction(`load loot profile "${a.set}" (import ${a.set}.utl too)`, { id: 2, data: { t: 's', v: `/vt loot load ${a.set}` } });
    });
    return { actions: out, missing };
  };
  for (const st of p.states) for (const r of st.rules) {
    const f = fixLoot(r.do);
    r.do = f.actions;
    if (!f.missing.length) continue;
    r.disabled = true;
    r.note = `${r.note ? `${r.note}; ` : 'From VirindiTank; '}can't run: ${f.missing.map((m) => `load loot profile "${m}" (import ${m}.utl too)`).join('; ')}`;
    problems.push(...f.missing.map((m) => `state "${st.name}" ${r.label ?? 'rule'}: load loot profile "${m}" (import ${m}.utl too)`));
  }
  for (const rt of p.routes) for (const stop of rt.stops ?? []) {
    const f = fixLoot(stop.do);
    stop.do = f.actions;
    problems.push(...f.missing.map((m) => `route "${rt.name}" point ${stop.at + 1}: load loot profile "${m}" (import ${m}.utl too)`));
  }
  return { value: p, problems };
}
