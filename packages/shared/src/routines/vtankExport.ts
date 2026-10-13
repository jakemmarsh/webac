/**
 * AGENT.vtank-export (docs/vtank-parity-gaps.md §10.1) — the routine document
 * back out as VirindiTank's files, which players share: a profile's meta →
 * `.met`, a route → `.nav`, a loot rule list → `.utl` (VTClassic). The
 * layouts are the ones the importer reads (docs/vtank-formats.md, "Writing");
 * implemented from that spec, not ported code.
 *
 * Round trip: importing an exported file gives back the same document for
 * everything the format holds, and for files that came from VirindiTank,
 * import → export → import is stable (tests/verify-vtank-export.ts runs the
 * community corpus). What a file can't hold is never dropped silently: each
 * export returns `problems`, one line per thing written differently or left
 * out, for the window, `/vt … save` and ac_routines to show.
 *
 * Text conventions VirindiTank writes: CRLF line ends (the embedded lengths
 * count them as 2), doubles as .NET's round-trip "R" form (15 significant
 * digits, else 17; exponent below 1e-4 as "2.08333134651184E-05"), ints as
 * signed int32.
 */
import type { LootMatch, LootRule, PropTest, Route, RoutineAction, RoutineCondition, RoutineProfile, RoutineRule, SalvageCombine, VtObjectRecord } from './RoutineDoc.js';
import {
  DECAL_FLOAT_KEYS, DECAL_INT_KEYS, OBJECT_CLASS_FLAGS, OBJECT_CLASS_TYPES, RECALL_SPELLS, VTCLASSIC_COLOR_SLOTS, type MetValue, type UtlRule,
} from './vtank.js';
import { vtToVTank } from './vtankOptions.js';
import { encodeWindows1252 } from '../encoding/Windows1252.js';

/** One exported file: its name as VirindiTank names them (<name>.met / .nav / .utl), its text, and what it couldn't hold. */
export interface VTankExport { fileName: string; text: string; problems: string[] }

/** The file as handed over: VirindiTank reads its files as Windows-1252, so say when a character won't survive that. */
function done(fileName: string, text: string, problems: string[]): VTankExport {
  const bytes = encodeWindows1252(text);
  const lost = new Set<string>();
  for (let i = 0; i < text.length; i++) if (bytes[i] === 0x3f && text[i] !== '?') lost.add(text[i]);
  if (lost.size) problems.push(`characters VirindiTank's files can't hold (Windows-1252) are written as "?": ${[...lost].slice(0, 10).join(' ')}`);
  return { fileName, text, problems };
}

/** An exported file as handed over (the Windows-1252 check included): for the other writers (vtankUsd.ts, vtankAf.ts). */
export function vtankFile(fileName: string, text: string, problems: string[]): VTankExport { return done(fileName, text, problems); }

const NL = '\r\n';

/** A number as .NET's "R" format writes it (VTank and VTClassic are .NET Framework programs). */
export function vtNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const fmt = (prec: number): string => {
    const [mant, ex] = n.toExponential(prec - 1).split('e');
    const exp = Number(ex);
    const digits = mant.replace('-', '').replace('.', '').replace(/0+$/, '') || '0';
    const sign = n < 0 ? '-' : '';
    if (exp > -5 && exp < prec) {
      if (exp >= 0) {
        const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
        const frac = digits.slice(exp + 1);
        return `${sign}${int}${frac ? `.${frac}` : ''}`;
      }
      return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
    }
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  };
  const g15 = fmt(15);
  return Number(g15) === n ? g15 : fmt(17);
}

/** A file name VirindiTank (and a browser download) can use: the name with characters Windows forbids replaced. */
export function vtFileName(name: string, ext: 'met' | 'nav' | 'utl' | 'usd' | 'af'): string {
  const stem = name.replace(new RegExp(`\\.${ext}$`, 'i'), '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'unnamed';
  return `${stem}.${ext}`;
}

/** A single-line text field: VirindiTank's line-oriented files can't hold a line break inside one. */
function oneLine(v: string, what: string, problems: string[]): string {
  if (!/[\r\n]/.test(v)) return v;
  problems.push(`${what}: line breaks written as spaces (a VirindiTank line can't hold one)`);
  return v.replace(/\r?\n|\r/g, ' ');
}

// ── .nav ──

const NAV_MODE_IDS: Record<Route['mode'], number> = { circular: 1, linear: 2, follow: 3, once: 4 };
const RECALL_IDS: Record<string, number> = Object.fromEntries(Object.entries(RECALL_SPELLS).map(([id, name]) => [name.toLowerCase(), Number(id)]));

/** Our "42.100N, 33.600E" as VTank's map units (east / north positive). */
export function navUnits(coords: string): { ew: number; ns: number } | null {
  const m = /(\d+(?:\.\d+)?)\s*([NS])\s*[, ]\s*(\d+(?:\.\d+)?)\s*([EW])/i.exec(coords);
  if (!m) return null;
  return { ns: Number(m[1]) * (/s/i.test(m[2]) ? -1 : 1), ew: Number(m[3]) * (/w/i.test(m[4]) ? -1 : 1) };
}

/** A route step as the chat line a VirindiTank Chat point or meta Chat Command sends, or null when none says it. */
function chatLine(a: RoutineAction, problems: string[], where: string): string | null {
  switch (a.kind) {
    case 'say': return oneLine(a.text, where, problems);
    case 'set-setting': {
      if (a.name.startsWith('ub:')) return `/ub opt set ${a.name.slice(3)} ${String(a.value)}`;
      return `/vt opt set ${a.name} ${settingText(a.name, a.value)}`;
    }
    case 'load-loot': return `/vt loot load ${a.set}`;
    case 'expression': return `/ub mexec ${oneLine(a.expr, where, problems)}`;
    case 'use-object': return `/ub use ${a.name}`;
    case 'use-item':
      if (a.to) return `/ub use ${a.item} on ${a.to}`;
      // UtilityBelt names what to use it on; "your selection" has no name to write.
      if (a.on === 'target') return null;
      return `/ub use ${a.item}${a.on === 'self' ? ' on me' : ''}`;
    case 'give': return `/ub give ${a.count !== undefined ? `${a.count} ` : ''}${a.item} to ${a.to}`;
    case 'combat-mode': return `/ub combatstate ${a.mode}`;
    case 'stop': return '/vt stop';
    case 'sell-by-loot-rules':
      if (a.vendor) problems.push(`${where}: sells to the vendor you have open (UtilityBelt's /ub autovendor names none, not "${a.vendor}")`);
      return '/ub autovendor';
    case 'jump': {
      if (a.holdMs !== undefined && a.heading === undefined) problems.push(`${where}: a jump's hold time needs a heading in /ub jump; written without it`);
      const hd = a.heading !== undefined ? ` ${vtNumber(a.heading)}${a.holdMs !== undefined ? ` ${Math.round(a.holdMs)}` : ''}` : '';
      return `/ub jump${a.walk ? 's' : ''}${a.forward ? 'w' : ''}${hd}`;
    }
    case 'unsupported': {
      const raw = a.raw as { id: number; data: MetValue } | undefined;
      if (raw && raw.id === 2 && raw.data.t === 's') return raw.data.v;
      return null;
    }
    default: return null;
  }
}

/** The values the importer reads as a plain setting (vtank.ts settingLiteral): true/false, a number, a `backticked` string. */
const isSettingLiteral = (v: string): boolean => /^(true|false)$/i.test(v.trim()) || /^-?\d+(\.\d+)?$/.test(v.trim()) || /^`[^`]*`$/.test(v.trim());

/** A VTank option value as `/vt opt set` and Set VT Option take it: VTank's units, strings in backticks. */
function settingText(name: string, v: string | number | boolean): string {
  const t = vtToVTank(name, v);
  if (typeof t === 'boolean') return t ? 'true' : 'false';
  if (typeof t === 'number') return vtNumber(t);
  return `\`${t}\``;
}

const KIND_NAMES: Partial<Record<RoutineAction['kind'], string>> = {
  cast: 'casting a spell', 'cast-buffs': 'casting a buff set', 'attack-nearest': 'attacking', 'loot-nearby': 'looting',
  'walk-to': 'walking to coordinates', wait: 'waiting', train: 'spending XP', 'follow-route': 'following a route', 'talk-to': 'talking to an NPC',
  // Beyond VTank, Jake 2026-10-12.
  pull: 'pulling a monster', 'hold-position': 'holding position', 'release-position': 'releasing the held position',
  'loot-corpse': 'looting a named corpse', recall: 'an abortable recall', 'flee-to': 'fleeing to coordinates',
};
const what = (a: RoutineAction): string => (a.kind === 'unsupported' ? a.what : a.kind === 'cast' ? `casting ${a.spell}` : KIND_NAMES[a.kind] ?? a.kind);

/** One stop's steps as navroute nodes (several nodes may share a point); problems for steps a node can't hold. */
function stopNodes(steps: RoutineAction[], at: { ew: number; ns: number; z: number }, where: string, problems: string[], unknown: { n: number }): Array<{ type: number; extra: string[] }> {
  const out: Array<{ type: number; extra: string[] }> = [];
  // Name, Decal object class, the literal True, and where the object stands: as recorded (vt), else the point.
  const objLines = (name: string, vt: VtObjectRecord | undefined, cls: number) => {
    if (vt?.objectClass === undefined || !vt.at) unknown.n++;
    const [ew, ns, z] = vt?.at ?? [at.ew, at.ns, at.z];
    return [name, String(vt?.objectClass ?? cls), 'True', vtNumber(ew), vtNumber(ns), vtNumber(z)];
  };
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i];
    const next = steps[i + 1];
    if (a.kind === 'use-object' && next?.kind === 'sell-by-loot-rules' && (!next.vendor || next.vendor === a.name)) {
      out.push({ type: 5, extra: [String((a.vt?.id ?? 0) | 0), a.name] }); // Open Vendor: the vendor's id (as recorded) and name
      i++;
      continue;
    }
    switch (a.kind) {
      case 'sell-by-loot-rules': if (a.vendor) { out.push({ type: 5, extra: ['0', a.vendor] }); continue; } break;
      // VTank's Use Portal/NPC is mostly portals (232 of 300 in the community routes); NPC Talk is an NPC.
      // A use with no point record came from a Chat point's /ub use (or predates the record): written back that way.
      case 'use-object': if (a.vt) { out.push({ type: 6, extra: objLines(a.name, a.vt, 14) }); continue; } break;
      case 'talk-to': out.push({ type: 7, extra: objLines(a.name, a.vt, 37) }); continue;
      case 'wait': out.push({ type: 3, extra: [String(Math.round(a.seconds * 1000))] }); continue;
      case 'checkpoint': out.push({ type: 8, extra: [] }); continue;
      // The deprecated portal point keeps its object id as VTank wrote it (an int32).
      case 'use-portal': out.push({ type: 1, extra: [String(a.id | 0)] }); continue;
      case 'cast': {
        const id = a.target !== 'target' ? RECALL_IDS[a.spell.toLowerCase()] : undefined;
        if (id !== undefined) { out.push({ type: 2, extra: [String(id)] }); continue; }
        break;
      }
      // A run-forward jump is UtilityBelt's /ub jumpw (a Chat point); VTank's own jump point jumps in place.
      case 'jump':
        if (a.forward) break;
        if (a.heading === undefined) problems.push(`${where}: a jump point faces a heading; written facing north (0)`);
        out.push({ type: 9, extra: [vtNumber(a.heading ?? 0), a.walk ? 'True' : 'False', vtNumber(Math.round(a.holdMs ?? 0))] });
        continue;
      default: break;
    }
    // A chat command we don't run, kept as read (the importer's unsupported step): its own text back.
    if (a.kind === 'unsupported' && a.raw?.id === 2 && typeof (a.raw.data as { v?: unknown }).v === 'string') { out.push({ type: 4, extra: [(a.raw.data as { v: string }).v] }); continue; }
    if (a.kind === 'load-route' || a.kind === 'follow-route') { problems.push(`${where}: loading route "${a.route}" from a point isn't a VTank step (its /vt nav load reads a .nav file); written as that chat command`); out.push({ type: 4, extra: [`/vt nav load ${a.route}`] }); continue; }
    const chat = chatLine(a, problems, where);
    if (chat !== null) { out.push({ type: 4, extra: [chat] }); continue; }
    problems.push(`${where}: ${what(a)} isn't a VirindiTank navroute step; left out`);
  }
  return out;
}

/** A route's nav body (from "uTank2 NAV 1.2"), the node count, and what it couldn't hold. */
function navBody(r: Route, problems: string[]): { text: string; count: number } {
  const lines = ['uTank2 NAV 1.2', String(NAV_MODE_IDS[r.mode])];
  const label = `route "${r.name}"`;
  if (r.mode === 'follow') {
    // VTank's Follow route names the player and their object id; the id is only valid on the recording server, and ours follows by name.
    lines.push(oneLine(r.follow ?? '', label, problems), '0');
    if (r.follow) problems.push(`${label}: follows "${r.follow}" by name; VirindiTank also wants their object id (written 0, pick them again there)`);
    if (r.points.length) problems.push(`${label}: a Follow navroute has no points; its ${r.points.length} point(s) are left out`);
    return { text: lines.join(NL) + NL, count: 0 };
  }
  const nodes: string[][] = [];
  let noHeight = 0;
  const unknown = { n: 0 };
  if (r.note) problems.push(`${label}: what its import couldn't carry over stays out (${r.note})`);
  r.points.forEach((pt, i) => {
    const u = navUnits(pt);
    const where = `${label} point ${i + 1}`;
    if (!u) { problems.push(`${where}: "${pt}" isn't map coordinates; left out`); return; }
    const h = r.z?.[i];
    if (h === null || h === undefined || r.z?.length !== r.points.length) noHeight++;
    const z = typeof h === 'number' && r.z?.length === r.points.length ? h : 0;
    const steps = r.stops?.filter((s) => s.at === i).flatMap((s) => s.do) ?? [];
    const made = steps.length ? stopNodes(steps, { ...u, z }, where, problems, unknown) : [];
    const head = [vtNumber(u.ew), vtNumber(u.ns), vtNumber(z), '0'];
    if (!made.length) { nodes.push(['0', ...head]); return; }
    for (const n of made) nodes.push([String(n.type), ...head, ...n.extra]);
  });
  if (noHeight) problems.push(`${label}: ${noHeight} point(s) have no recorded height; written at height 0`);
  if (unknown.n) problems.push(`${label}: ${unknown.n} Use Portal/NPC or NPC Talk point(s) have no recorded object kind or position; written as a portal (14) or NPC (37) standing at the point`);
  lines.push(String(nodes.length));
  for (const n of nodes) lines.push(...n);
  return { text: lines.join(NL) + NL, count: nodes.length };
}

/** A route as a `.nav` file. */
export function exportNav(r: Route): VTankExport {
  const problems: string[] = [];
  const { text } = navBody(r, problems);
  return done(vtFileName(r.name, 'nav'), text, problems);
}

// ── .met ──

const I = (v: number): MetValue => ({ t: 'i', v: Math.trunc(v) | 0 });
const S = (v: string): MetValue => ({ t: 's', v });
const D = (v: number): MetValue => ({ t: 'd', v });
const BA = (v: string): MetValue => ({ t: 'ba', v });
const kv = (pairs: Array<[string, MetValue]>): MetValue => ({ t: 'table', cols: ['k', 'v'], rows: pairs.map(([k, v]) => [S(k), v]) });
const KV = (items: Array<[number, MetValue]>): MetValue => ({ t: 'table', cols: ['K', 'V'], rows: items.map(([id, d]) => [I(id), d]) });

/** A typed value in .met text (each line CRLF-ended; a `ba` value is its length and exactly that many characters). */
export function writeMetValue(v: MetValue): string {
  switch (v.t) {
    case 'i': return `i${NL}${v.v | 0}${NL}`;
    // A line break inside a string would end the line early (text fields are reported by oneLine; names can't hold one).
    case 's': return `s${NL}${v.v.replace(/\r?\n|\r/g, ' ')}${NL}`;
    case 'd': return `d${NL}${vtNumber(v.v)}${NL}`;
    case 'ba': return `ba${NL}${v.v.length}${NL}${v.v}`;
    case 'table': return `TABLE${NL}${v.cols.length}${NL}${v.cols.map((c) => c + NL).join('')}${v.cols.map(() => `n${NL}`).join('')}${v.rows.length}${NL}${v.rows.map((row) => row.map(writeMetValue).join('')).join('')}`;
  }
}

/** The text after `name[` when the whole expression is that one call (`chatbox[...]`), else null. */
function soleCall(expr: string, fn: string): string | null {
  if (!expr.toLowerCase().startsWith(`${fn}[`) || !expr.endsWith(']')) return null;
  let depth = 0;
  for (let i = fn.length; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return i === expr.length - 1 ? expr.slice(fn.length + 1, -1) : null; }
  }
  return null;
}

/** A literal string inside a VTank meta expression: everything but letters and spaces escaped (wiki Meta_Expressions). */
export function vtExprString(s: string): string { return s.replace(/[^A-Za-z ]/g, (c) => `\\${c}`); }

interface MetCtx { profile: RoutineProfile; problems: string[]; embedded: Set<string> }

const VITAL_IDS = { health: 1, stamina: 2, mana: 3 } as const;

/** One of our conditions as a VTank condition (type id and data); what it can't say becomes Never and a problem. */
function metCondition(c: RoutineCondition, where: string, ctx: MetCtx): [number, MetValue] {
  const never = (why: string): [number, MetValue] => { ctx.problems.push(`${where}: ${why} isn't a VirindiTank condition; written as Never`); return [0, I(0)]; };
  const lit = (n: string) => /^[\w '’-]+$/.test(n);
  const mobs = (name: string, count: number, meters: number): [number, MetValue] => [13, kv([['n', S(name)], ['c', I(count)], ['r', D(meters)]])];
  switch (c.kind) {
    case 'always': return [1, I(0)];
    case 'not':
      if (c.condition.kind === 'always') return [0, I(0)];
      if (c.condition.kind === 'item-count-below') return [12, kv([['n', S(c.condition.item)], ['c', I(c.condition.count)]])];
      return [21, KV([metCondition(c.condition, where, ctx)])];
    case 'all': return [2, KV(c.conditions.map((x) => metCondition(x, where, ctx)))];
    case 'any': return [3, KV(c.conditions.map((x) => metCondition(x, where, ctx)))];
    case 'chat-matches': return [4, S(oneLine(c.pattern, where, ctx.problems))];
    case 'free-slots-below': return [5, I(c.slots - 1)];
    case 'seconds-in-state': return [6, I(Math.round(c.seconds))];
    case 'item-count-below': return [11, kv([['n', S(c.item)], ['c', I(c.count - 1)]])];
    case 'monster-within': {
      const names = c.names ?? [];
      // No names: some monster within range = Not(No monsters within).
      if (!names.length) return [21, KV([[16, kv([['r', D(c.meters)]])]])];
      const one = (n: string) => mobs(lit(n) ? n : n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 1, c.meters);
      return names.length === 1 ? one(names[0]) : [3, KV(names.map(one))];
    }
    case 'no-monster-within': {
      const names = c.names ?? [];
      if (!names.length) return [16, kv([['r', D(c.meters)]])];
      const one = (n: string) => mobs(lit(n) ? n : n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 1, c.meters);
      return [21, KV([names.length === 1 ? one(names[0]) : [3, KV(names.map(one))]])];
    }
    case 'monster-count': return mobs(c.pattern, c.count, c.meters);
    case 'monster-priority-count': return [14, kv([['p', I(c.priority)], ['c', I(c.count)], ['r', D(c.meters)]])];
    case 'burden-above': return [24, I(c.percent + 1)];
    case 'landblock': return [17, I(c.landblock)];
    case 'landcell': return [18, I(c.cell)];
    case 'route-done': return [7, I(0)];
    case 'died': return [8, I(0)];
    case 'vendor-open': return [9, I(0)];
    case 'vendor-closed': return [10, I(0)];
    case 'need-buff': return [15, I(0)];
    case 'portal-entered': return [19, I(0)];
    case 'portal-exited': return [20, I(0)];
    case 'seconds-in-state-persistent': return [22, I(Math.round(c.seconds))];
    case 'spell-time-at-least':
      if (c.spellId === undefined) return never(`time left on "${c.spell}" (VTank names the spell by id)`);
      return [23, kv([['sid', I(c.spellId)], ['sec', I(Math.round(c.seconds))]])];
    case 'route-distance-at-least': return [25, kv([['dist', D(c.meters)]])];
    case 'expression': return [26, kv([['e', S(oneLine(c.expr, where, ctx.problems))]])];
    case 'chat-capture': return [28, kv([['p', S(oneLine(c.pattern, where, ctx.problems))], ['c', S((c.colors ?? []).join(';'))]])];
    // Ours that VTank says with an expression (the same test, written in its meta language).
    case 'vital-below': case 'vital-above': {
      const id = VITAL_IDS[c.vital];
      return [26, kv([['e', S(`getcharvital_current[${id}]*100/getcharvital_buffedmax[${id}]${c.kind === 'vital-below' ? '<' : '>'}${vtNumber(c.percent)}`)]])];
    }
    case 'near': return [26, kv([['e', S(`coordinatedistanceflat[coordinateparse[${vtExprString(c.coords)}],getplayercoordinates[]]<=${vtNumber(c.meters)}`)]])];
    case 'unassigned-xp-above': return [26, kv([['e', S(`getcharquadprop[2]>${vtNumber(c.xp)}`)]])];
    case 'buff-missing': return never(`"${c.spell}" missing (VTank's buff test is its own buff list)`);
    // Beyond VTank, Jake 2026-10-12: no VirindiTank condition (nor meta expression) can say these.
    case 'attackers-at-least': return never(`${c.count}+ creatures attacking you`);
    case 'being-cast-at': return never('a spell coming at you');
    case 'no-monster-near': return never(`no monster within ${c.meters} m of ${c.coords ?? c.object}`);
    case 'my-corpse-within': return never(`your corpse within ${c.meters} m`);
    case 'unsupported': {
      const raw = c.raw as { id: number; data: MetValue } | undefined;
      if (raw) return [raw.id, raw.data];
      return never(c.what);
    }
  }
}

/** A route as an Embed Nav's `ba` content: name, node count, then the .nav body. */
function embedNav(r: Route, ctx: MetCtx): MetValue {
  const { text, count } = navBody(r, ctx.problems);
  return BA(`${r.name}${NL}${count}${NL}${text}`);
}

/** One of our actions as a VTank action, or null (with a problem) when VTank has none. */
function metAction(a: RoutineAction, where: string, ctx: MetCtx): [number, MetValue] | null {
  const chat = (t: string): [number, MetValue] => [2, S(t)];
  switch (a.kind) {
    case 'set-state': return [1, S(a.state)];
    case 'call-state': return [5, kv([['st', S(a.state)], ['ret', S(a.returnTo)]])];
    case 'return': return [6, I(0)];
    case 'set-watchdog': return [9, kv([['s', S(a.state)], ['r', D(a.meters)], ['t', D(a.seconds)]])];
    case 'clear-watchdog': return [10, kv([])];
    case 'create-view': return [13, kv([['n', S(a.name)], ['x', BA(a.xml.replace(/\r?\n/g, NL))]])];
    case 'destroy-view': return [14, kv([['n', S(a.name)]])];
    case 'destroy-all-views': return [15, kv([])];
    case 'expression': {
      const e = oneLine(a.expr, where, ctx.problems);
      const chatbox = soleCall(e, 'chatbox');
      if (chatbox !== null) return [8, kv([['e', S(chatbox)]])];
      const get = /^setvar\[([^,[\]]*),vtgetsetting\[([^,[\]]*)\]\]$/i.exec(e);
      if (get) return [11, kv([['o', S(get[2])], ['v', S(get[1])]])];
      const set = soleCall(e, 'vtsetsetting');
      const comma = set?.indexOf(',') ?? -1;
      // Set VT Option with a literal value imports as set-setting, so only an expression value came from one.
      if (set !== null && comma > 0 && !/[[\]]/.test(set.slice(0, comma)) && !isSettingLiteral(set.slice(comma + 1))) return [12, kv([['o', S(set.slice(0, comma))], ['v', S(set.slice(comma + 1))]])];
      return [7, kv([['e', S(e)]])];
    }
    case 'set-setting':
      if (a.name.startsWith('ub:')) return chat(`/ub opt set ${a.name.slice(3)} ${String(a.value)}`);
      return [12, kv([['o', S(a.name)], ['v', S(settingText(a.name, a.value))]])];
    case 'load-route': case 'follow-route': {
      const r = ctx.profile.routes.find((x) => x.name === a.route);
      if (a.kind === 'follow-route') ctx.problems.push(`${where}: following route "${a.route}" is written as VTank's Embed Nav (its macro then walks it)`);
      if (!r) { ctx.problems.push(`${where}: route "${a.route}" isn't in this profile; written as /vt nav load (VirindiTank reads ${a.route}.nav from its folder)`); return chat(`/vt nav load ${a.route}`); }
      ctx.embedded.add(r.name);
      return [4, embedNav(r, ctx)];
    }
    case 'load-loot':
      ctx.problems.push(`${where}: loads loot profile "${a.set}"; VirindiTank reads ${vtFileName(a.set, 'utl')} from its folder (export it too)`);
      return chat(`/vt loot load ${a.set}`);
    case 'cast': {
      const id = a.target !== 'target' ? RECALL_IDS[a.spell.toLowerCase()] : undefined;
      if (id !== undefined) return [7, kv([['e', S(`actiontrycastbyid[${id}]`)]])];
      break;
    }
    case 'unsupported': {
      const raw = a.raw as { id: number; data: MetValue } | undefined;
      if (raw) return [raw.id, raw.data];
      break;
    }
    default: {
      const t = chatLine(a, ctx.problems, where);
      if (t !== null) return chat(t);
    }
  }
  ctx.problems.push(`${where}: ${what(a)} isn't a VirindiTank meta action; left out`);
  return null;
}

/** What makes the importer switch a rule off (its unsupported checks), as import computes it. */
function importBlocked(r: RoutineRule): boolean {
  const unsup = (xs: Array<RoutineCondition | RoutineAction>): boolean => xs.some((x) => x.kind === 'unsupported' || (x.kind === 'not' && unsup([x.condition])) || ((x.kind === 'any' || x.kind === 'all') && unsup(x.conditions)));
  const blocks = (c: RoutineCondition): boolean => c.kind === 'unsupported' || (c.kind === 'not' && unsup([c.condition])) || (c.kind === 'all' && c.conditions.some(blocks)) || (c.kind === 'any' && c.conditions.length > 0 && c.conditions.every(blocks));
  return r.when.some(blocks) || unsup(r.do);
}

/**
 * The order to write the rules in: the meta's own file order when the rules still carry the
 * importer's "Rule N" labels in order within each state (VTank interleaves states), else state by state.
 */
function ruleOrder(p: RoutineProfile): Array<{ state: string; rule: RoutineRule }> {
  const flat = p.states.flatMap((s) => s.rules.map((rule) => ({ state: s.name, rule })));
  const n = (r: RoutineRule) => Number(/^Rule (\d+)$/.exec(r.label ?? '')?.[1] ?? NaN);
  const nums = flat.map((x) => n(x.rule));
  const ordered = nums.every(Number.isFinite) && new Set(nums).size === nums.length
    && p.states.every((s) => s.rules.every((r, i) => i === 0 || n(r) > n(s.rules[i - 1])));
  return ordered ? [...flat].sort((a, b) => n(a.rule) - n(b.rule)) : flat;
}

/** A profile's meta (its states and rules) as a `.met` file. */
export function exportMet(p: RoutineProfile): VTankExport {
  const ctx: MetCtx = { profile: p, problems: [], embedded: new Set() };
  const rows: string[] = [];
  const order = ruleOrder(p);
  // VTank starts a meta in Default (the importer: Default, else the first state).
  const firstState = order[0]?.state;
  const starts = p.states.some((s) => s.name === 'Default') ? 'Default' : firstState;
  if (p.initialState !== starts) ctx.problems.push(`starts in "${p.initialState}"; VirindiTank starts a meta in Default${starts && starts !== 'Default' ? ` (here: "${starts}")` : ''}`);
  const named: string[] = [];
  order.forEach(({ state, rule }, i) => {
    const where = `state "${state}" ${rule.label ?? `rule ${i + 1}`}`;
    if (rule.label && !/^Rule \d+$/.test(rule.label)) named.push(rule.label);
    if (rule.note && !rule.note.startsWith('From VirindiTank')) ctx.problems.push(`${where}: its note isn't kept (a .met has no notes)`);
    let cond = metCondition(rule.when.length === 1 ? rule.when[0] : { kind: 'all', conditions: rule.when }, where, ctx);
    // VTank has no off switch: a rule switched off here is written with Never in front.
    if (rule.disabled && !importBlocked(rule)) {
      ctx.problems.push(`${where}: switched off here; VirindiTank has no off switch, so it's written as All(Never, …)`);
      cond = [2, KV([[0, I(0)], ...(cond[0] === 2 && cond[1].t === 'table' ? cond[1].rows.map(([k, d]) => [(k as { v: number }).v, d] as [number, MetValue]) : [cond])])];
    }
    const acts = rule.do.map((a) => metAction(a, where, ctx)).filter((x): x is [number, MetValue] => x !== null);
    const act: [number, MetValue] = acts.length === 1 ? acts[0] : acts.length ? [3, KV(acts)] : [0, I(0)];
    rows.push(writeMetValue(I(cond[0])) + writeMetValue(I(act[0])) + writeMetValue(cond[1]) + writeMetValue(act[1]) + writeMetValue(S(oneLine(state, where, ctx.problems))));
  });
  if (named.length) ctx.problems.push(`rule names aren't kept (a .met has none): ${named.slice(0, 5).map((x) => `"${x}"`).join(', ')}${named.length > 5 ? ` and ${named.length - 5} more` : ''}`);
  // A state exists in a .met only through its rules or a rule that goes to it.
  const targets = new Set(p.states.flatMap((s) => s.rules.flatMap((r) => r.do.flatMap((a) => (a.kind === 'set-state' || a.kind === 'set-watchdog' ? [a.state] : a.kind === 'call-state' ? [a.state, a.returnTo] : [])))));
  for (const s of p.states) if (!s.rules.length && !targets.has(s.name) && !(p.states.length === 1 && s.name === 'Default')) ctx.problems.push(`state "${s.name}" has no rules and nothing goes to it; a .met can't hold it`);
  if (p.ruleFiring !== 'once') ctx.problems.push('its rules fire every step here; a VirindiTank rule fires once each time its condition becomes true');
  const unused = p.routes.filter((r) => !ctx.embedded.has(r.name)).map((r) => r.name);
  if (unused.length) ctx.problems.push(`route(s) ${unused.map((x) => `"${x}"`).join(', ')} aren't used by the meta; export each as its .nav`);
  if (p.loot.length || Object.keys(p.lootSets ?? {}).length) ctx.problems.push('its loot rules are a VTClassic .utl, not part of the .met; export them from Looting');
  const header = ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', String(order.length)].join(NL) + NL;
  return done(vtFileName(p.name, 'met'), header + rows.join(''), ctx.problems);
}

// ── .utl ──

/** An extra block after a .utl's rules: its type name and its text (VTClassic UTLFileExtraBlockManager). */
export interface UtlExtraBlock { type: string; body: string }

/**
 * VTClassic's SalvageCombine block (docs/vtank-formats.md §3.5): which workmanship ranges combine,
 * by default and per material, and the per-material value modes. The hook for the salvage work:
 * pass the profile's salvage settings here and the block to exportUtl.
 */
export function salvageCombineBlock(sc: { defaultCombine: string; materials?: Array<{ material: number; combine: string }>; values?: Array<{ material: number; value: number }> }): UtlExtraBlock {
  const lines = ['1', sc.defaultCombine, String(sc.materials?.length ?? 0), ...(sc.materials ?? []).flatMap((m) => [String(m.material), m.combine])];
  if (sc.values) lines.push(String(sc.values.length), ...sc.values.flatMap((v) => [String(v.material), String(Math.trunc(v.value))]));
  return { type: 'SalvageCombine', body: lines.join(NL) + NL };
}

const ACTION_IDS: Record<LootRule['action'], number> = { ignore: 0, keep: 1, salvage: 2, sell: 3, read: 4, 'keep-up-to': 10 };
const TYPE_CLASSES: Record<string, number> = Object.fromEntries(Object.entries(OBJECT_CLASS_TYPES).map(([id, t]) => [t.toLowerCase(), Number(id)]));
const FLAG_CLASSES: Array<[number, number]> = Object.entries(OBJECT_CLASS_FLAGS).map(([id, f]) => [f, Number(id)]);
/** ACE property → Decal key, where the importer reads a Decal key as that property (DIDs only have Decal keys). */
const DID_DECAL: Record<number, number> = Object.fromEntries(Object.entries(DECAL_INT_KEYS).filter(([, k]) => k.kind === 'did').map(([dk, k]) => [k.key, Number(dk)]));
const FLOAT_DECAL: Record<number, number> = Object.fromEntries(Object.entries(DECAL_FLOAT_KEYS).filter(([, k]) => k.kind === 'float').map(([dk, k]) => [k.key, Number(dk)]));

/** The importer's "all of these names" regex ((?=[\s\S]*?(?:a))(?=…)…) back into its names, else null. */
export function splitNameLookaheads(re: string): string[] | null {
  const head = '(?=[\\s\\S]*?(?:';
  if (!re.startsWith(head)) return null;
  const out: string[] = [];
  let i = 0;
  while (i < re.length) {
    if (!re.startsWith(head, i)) return null;
    let depth = 0;
    let j = i + head.length;
    let cls = false;
    for (; j < re.length; j++) {
      const ch = re[j];
      if (ch === '\\') { j++; continue; }
      if (cls) { if (ch === ']') cls = false; continue; }
      if (ch === '[') cls = true;
      else if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
    }
    if (re.slice(j, j + 2) !== '))') return null;
    out.push(re.slice(i + head.length, j));
    i = j + 2;
  }
  return out.length > 1 ? out : null;
}

/** One loot rule's requirements as VTClassic's (type, data lines), and what it can't test. */
function utlRequirements(m: LootMatch, where: string, problems: string[]): { reqs: Array<{ type: number; lines: string[] }>; classes: number[]; cant: string[] } {
  const reqs: Array<{ type: number; lines: string[] }> = [];
  const classes: number[] = [];
  const cant: string[] = [];
  const n = vtNumber;
  if (m.name !== undefined) for (const name of splitNameLookaheads(m.name) ?? [m.name]) reqs.push({ type: 1, lines: [oneLine(name, where, problems), '1'] });
  if (m.valueAtLeast !== undefined) reqs.push({ type: 3, lines: [n(m.valueAtLeast), '19'] });
  if (m.valueAtMost !== undefined) reqs.push({ type: 2, lines: [n(m.valueAtMost), '19'] });
  if (m.burdenAtMost !== undefined) reqs.push({ type: 2, lines: [n(m.burdenAtMost), '5'] });
  for (const t of m.types ?? []) {
    const cls = TYPE_CLASSES[t.toLowerCase()];
    if (cls !== undefined) classes.push(cls); else cant.push(`item type "${t}" (no VTClassic object class)`);
  }
  if (m.descFlags) {
    let left = m.descFlags;
    for (const [flag, cls] of FLAG_CLASSES) if (left & flag) { reqs.push({ type: 7, lines: [String(cls)] }); left &= ~flag; }
    if (left) cant.push(`item flags 0x${left.toString(16)} (no VTClassic object class)`);
  }
  for (const p of m.props ?? []) {
    const req = propReq(p);
    if (req) reqs.push(...req); else cant.push(`${p.kind} property ${p.key} ${p.op} ${String(p.value)}`);
  }
  for (const sp of m.spells ? [m.spells, ...(m.moreSpells ?? [])] : m.moreSpells ?? []) {
    if (sp.count === 1 && !sp.notMatch) reqs.push({ type: 0, lines: [sp.match] });
    else reqs.push({ type: 9, lines: [sp.match, sp.notMatch ?? '', String(sp.count)] });
  }
  if (m.spellCountAtLeast !== undefined) reqs.push({ type: 8, lines: [n(m.spellCountAtLeast)] });
  if (m.minDamageAtLeast !== undefined) reqs.push({ type: 10, lines: [n(m.minDamageAtLeast)] });
  for (const c of m.colours ?? []) {
    const base = [String(c.rgb[0]), String(c.rgb[1]), String(c.rgb[2]), n(c.maxHue), n(c.maxSV)];
    if (c.group && VTCLASSIC_COLOR_SLOTS[c.group]) reqs.push({ type: 15, lines: [...base, c.group] });
    else if (!c.slots) reqs.push({ type: 14, lines: base });
    else if (c.slots.length === 1) reqs.push({ type: 16, lines: [...base, String(c.slots[0])] });
    else cant.push(`a colour near ${c.rgb.join(',')} in slots ${c.slots.join(', ')} (VTClassic tests one slot or a named armour group)`);
  }
  for (const pl of m.palettes ?? []) reqs.push({ type: 17, lines: [String(pl.slot), String(pl.palette)] });
  if (m.totalRatingsAtLeast !== undefined) reqs.push({ type: 2007, lines: [n(m.totalRatingsAtLeast)] });
  if (m.freeSlotsAtLeast !== undefined) reqs.push({ type: 1001, lines: [n(m.freeSlotsAtLeast)] });
  if (m.characterLevelAtLeast !== undefined) reqs.push({ type: 1002, lines: [n(m.characterLevelAtLeast)] });
  if (m.characterLevelAtMost !== undefined) reqs.push({ type: 1003, lines: [n(m.characterLevelAtMost)] });
  for (const s of m.characterSkills ?? []) {
    if (s.atLeast !== undefined) reqs.push({ type: 1000, lines: [n(s.atLeast), String(s.skill)] });
    if (s.baseMin !== undefined || s.baseMax !== undefined) reqs.push({ type: 1004, lines: [String(s.skill), n(s.baseMin ?? 0), n(s.baseMax ?? 999999)] });
  }
  if (m.appraisal !== undefined) cant.push(`appraisal text /${m.appraisal}/ (VTClassic tests properties, not the appraisal text)`);
  return { reqs, classes, cant };
}

/** A property test as VTClassic requirement(s), or null when it has no Decal value key. */
function propReq(p: PropTest): Array<{ type: number; lines: string[] }> | null {
  const v = typeof p.value === 'number' ? vtNumber(p.value) : p.value;
  if (p.kind === 'string') return p.op === 'match' ? [{ type: 1, lines: [String(p.value), String(p.key)] }] : null;
  if (p.kind === 'int' || p.kind === 'did') {
    const key = p.kind === 'did' ? DID_DECAL[p.key] : p.key < 0x10000 ? p.key : undefined;
    if (key === undefined || typeof p.value !== 'number') return null;
    const type = { le: 2, ge: 3, eq: 12, ne: 13, flag: 11 }[p.op as 'le'];
    return type ? [{ type, lines: [v, String(key)] }] : null;
  }
  if (p.kind === 'float') {
    const key = p.key < 0x10000 && !FLOAT_DECAL[p.key] ? p.key : FLOAT_DECAL[p.key] ?? p.key;
    if (typeof p.value !== 'number') return null;
    if (p.op === 'le') return [{ type: 4, lines: [v, String(key)] }];
    if (p.op === 'ge') return [{ type: 5, lines: [v, String(key)] }];
    if (p.op === 'eq') return [{ type: 4, lines: [v, String(key)] }, { type: 5, lines: [v, String(key)] }];
    return null;
  }
  return null;
}

/**
 * One loot rule as the VTClassic rule its editor shows (ui/automation/lootEditor.ts): the rule's
 * requirements in VTClassic's types and order of writing, its action id and Keep # count, an
 * Enable/Disable requirement when it is switched off, and the requirements an import kept as written
 * (`vtc.reqs`). `cant` lists what VTClassic can't hold (an appraisal regex, several item types: rules
 * made in the docked panel's editor); utlToLoot of `rule` gives the rule back for everything else.
 */
export function lootRuleToUtl(r: LootRule): { rule: UtlRule; cant: string[] } {
  const scratch: string[] = [];
  const { reqs, classes, cant } = utlRequirements(r.match, 'loot rule', scratch);
  const raw = r.vtc?.reqs ?? [];
  reqs.push(...raw.map((q) => ({ type: q.type, lines: [...q.lines] })));
  if (r.match.unsupported && !raw.length) cant.push(r.match.unsupported);
  if (classes.length > 1) cant.push(`any of ${classes.length} item types (VTClassic's ObjectClass is one class)`);
  else if (classes.length === 1) reqs.unshift({ type: 7, lines: [String(classes[0])] });
  let action = ACTION_IDS[r.action];
  if (r.vtc?.action !== undefined && r.action === 'keep') action = r.vtc.action;
  if (r.disabled && r.vtc?.action === undefined) reqs.push({ type: 9999, lines: ['true'] });
  const rule: UtlRule = { name: r.label ?? '', action, reqs };
  if (action === 10) rule.keepCount = Math.max(1, Math.trunc(r.count ?? 1));
  return { rule, cant };
}

/**
 * Loot rules as a VTClassic `.utl` (version 1). `blocks` are extra blocks written after the rules
 * (SalvageCombine: salvageCombineBlock).
 */
export function exportUtl(name: string, rules: LootRule[], opts: { blocks?: UtlExtraBlock[] } = {}): VTankExport {
  const problems: string[] = [];
  const out: string[] = ['UTL', '1'];
  const written: string[] = [];
  let count = 0;
  rules.forEach((r, i) => {
    const where = `loot rule ${i + 1}${r.label ? ` "${r.label}"` : ''}`;
    const { reqs, classes, cant } = utlRequirements(r.match, where, problems);
    // The importer's kept requirements (what this engine can't test) go back as VTClassic had them.
    const raw = r.vtc?.reqs ?? [];
    reqs.push(...raw.map((q) => ({ type: q.type, lines: [...q.lines] })));
    if (r.match.unsupported && !raw.length) cant.push(r.match.unsupported);
    let action = ACTION_IDS[r.action];
    if (r.vtc?.action !== undefined && r.action === 'keep') action = r.vtc.action;
    const off = (r.disabled && r.vtc?.action === undefined) || cant.length > 0;
    if (cant.length) problems.push(`${where}: can't write ${cant.join('; ')}; the rule is written switched off`);
    if (off) reqs.push({ type: 9999, lines: ['true'] });
    if (r.note && !/^VTClassic action /.test(r.note)) problems.push(`${where}: its note isn't kept (a .utl has none)`);
    // Our types are "any of"; VTClassic's ObjectClass is one class: one rule per type, adjacent, so the first match still wins.
    const cls = (c: number) => ({ type: 7, lines: [String(c)] });
    const variants = classes.length > 1 ? classes.map((c) => [cls(c), ...reqs]) : [[...classes.map(cls), ...reqs]];
    if (variants.length > 1) problems.push(`${where}: matches any of ${classes.length} item types; written as ${variants.length} rules, one per type`);
    for (const v of variants) {
      const lines: string[] = [oneLine(r.label ?? '', where, problems), '', ['0', String(action), ...v.map((q) => String(q.type))].join(';')];
      if (action === 10) lines.push(String(Math.max(1, Math.trunc(r.count ?? 1))));
      for (const q of v) {
        const data = q.lines.map((l) => l + NL).join('');
        lines.push(String(data.length), ...q.lines);
      }
      written.push(lines.join(NL) + NL);
      count++;
    }
  });
  out.push(String(count));
  let text = out.join(NL) + NL + written.join('');
  for (const b of opts.blocks ?? []) text += `${b.type}${NL}${b.body.length}${NL}${b.body}`;
  return done(vtFileName(name, 'utl'), text, problems);
}

// ── the profile's files ──

/** The loot set the profile uses (VirindiTank's Looting profile): its name and rules. */
export function activeLoot(p: RoutineProfile): { name: string; rules: LootRule[] } {
  if (p.lootSet && p.lootSets?.[p.lootSet]) return { name: p.lootSet, rules: p.lootSets[p.lootSet] };
  return { name: p.name, rules: p.loot };
}

/**
 * One of a profile's VirindiTank files: `met` its meta; `nav` a route (by name;
 * default the Auto-Navigation route, else the first); `utl` a loot set (by
 * name; default the Looting profile, else the profile's own rules). Null when
 * there is no such route or loot set.
 */
export function exportVTank(p: RoutineProfile, kind: 'met' | 'nav' | 'utl', which?: string): VTankExport | null {
  if (kind === 'met') return exportMet(p);
  if (kind === 'nav') {
    const want = which ?? p.navRoute ?? p.routes[0]?.name;
    const r = p.routes.find((x) => x.name === want) ?? p.routes.find((x) => x.name.toLowerCase() === String(want).toLowerCase());
    return r ? exportNav(r) : null;
  }
  // The loot profile's salvage-bag bands go back as its SalvageCombine block (salvage.ts reads the same fields).
  const blocks = (sc: SalvageCombine | undefined): { blocks?: UtlExtraBlock[] } => (sc ? { blocks: [salvageCombineBlock({
    defaultCombine: sc.default,
    materials: Object.entries(sc.materials ?? {}).map(([m, combine]) => ({ material: Number(m), combine })),
    ...(sc.valueModes ? { values: Object.entries(sc.valueModes).map(([m, value]) => ({ material: Number(m), value })) } : {}),
  })] } : {});
  if (which === undefined) { const l = activeLoot(p); return exportUtl(l.name, l.rules, blocks(p.salvageCombineSets?.[l.name] ?? p.salvageCombine)); }
  const key = Object.keys(p.lootSets ?? {}).find((k) => k.toLowerCase() === which.toLowerCase());
  if (key) return exportUtl(key, p.lootSets![key], blocks(p.salvageCombineSets?.[key]));
  return which.toLowerCase() === p.name.toLowerCase() ? exportUtl(p.name, p.loot, blocks(p.salvageCombine)) : null;
}
