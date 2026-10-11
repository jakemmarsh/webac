/**
 * metaf's `.af` text format (docs/vtank-parity-gaps.md §10.3): the readable
 * form of a VirindiTank meta (and of a single navroute) that players write
 * metas in, converted to and from the same meta / nav structures the `.met`
 * and `.nav` readers produce, so an `.af` imports and exports exactly as the
 * `.met` it stands for.
 *
 * metaf (J. Edwards) is GPL: this is implemented from its published format
 * description (metafREADME.af §4–5, metafReference.af §6–7: operation names,
 * their inputs, the nav node codes), not from its code. Format summary:
 * docs/vtank-formats.md §7.
 *
 * - `~~` starts a comment (outside a string); blank lines are ignored.
 * - A string is `{…}`; a brace inside one is doubled (`{{`, `}}`). Numbers are
 *   decimal with `.`; `h` inputs (landblocks, cells, object ids) are hex.
 * - `STATE: {name}`, then rules: `IF: <condition>` and `DO: <action>`. An
 *   All / Any / DoAll wraps the operations on the following, further-indented
 *   lines; `Not` takes the operation after it on the same line.
 * - After the states, `NAV: <tag> <circular|linear|follow|once>` and its nodes,
 *   one per line (pnt, prt, rcl, pau, cht, vnd, ptl, tlk, chk, jmp, flw).
 *   `EmbedNav <tag> {name} [{a b c d e f g}]` embeds one, optionally moved by
 *   the transform x' = a·x + b·y + e, y' = c·x + d·y + f, z' = z + g.
 * - A nav-only file is one `NAV:` section and nothing else.
 */
import { parseEmbeddedNav, parseMet, parseNav, RECALL_SPELLS, type MetRule, type MetValue, type NavNode, type NavRoute } from './vtank.js';
import type { Route, RoutineProfile } from './RoutineDoc.js';
import { exportMet, exportNav, vtankFile, vtFileName, vtNumber, type VTankExport } from './vtankExport.js';

const NL = '\r\n';

// ── names ──

const COND_IDS: Record<string, number> = {
  Never: 0, Always: 1, All: 2, Any: 3, ChatMatch: 4, MainSlotsLE: 5, SecsInStateGE: 6, NavEmpty: 7, Death: 8, VendorOpen: 9, VendorClosed: 10,
  ItemCountLE: 11, ItemCountGE: 12, MobsInDist_Name: 13, MobsInDist_Priority: 14, NeedToBuff: 15, NoMobsInDist: 16, BlockE: 17, CellE: 18,
  IntoPortal: 19, ExitPortal: 20, Not: 21, PSecsInStateGE: 22, SecsOnSpellGE: 23, BuPercentGE: 24, DistToRteGE: 25, Expr: 26, ChatCapture: 28,
};
const ACT_IDS: Record<string, number> = {
  None: 0, SetState: 1, Chat: 2, DoAll: 3, EmbedNav: 4, CallState: 5, Return: 6, DoExpr: 7, ChatExpr: 8, SetWatchdog: 9, ClearWatchdog: 10,
  GetOpt: 11, SetOpt: 12, CreateView: 13, DestroyView: 14, DestroyAllViews: 15,
};
const COND_NAMES = Object.fromEntries(Object.entries(COND_IDS).map(([k, v]) => [v, k])) as Record<number, string>;
const ACT_NAMES = Object.fromEntries(Object.entries(ACT_IDS).map(([k, v]) => [v, k])) as Record<number, string>;
const NAV_TYPES = ['circular', 'linear', 'follow', 'once'] as const;
const NODE_CODES: Record<string, number> = { pnt: 0, prt: 1, rcl: 2, pau: 3, cht: 4, vnd: 5, ptl: 6, tlk: 7, chk: 8, jmp: 9 };
const NODE_NAMES = Object.fromEntries(Object.entries(NODE_CODES).map(([k, v]) => [v, k])) as Record<number, string>;
const RECALL_BY_NAME = new Map(Object.entries(RECALL_SPELLS).map(([id, n]) => [n.toLowerCase(), Number(id)]));

// ── reading ──

type Tok = { s: string; str: boolean };
interface AfLine { n: number; indent: number; toks: Tok[] }

/** A line's tokens: words and `{strings}` (doubled braces inside), up to a `~~` comment. */
function tokens(line: string, n: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '~' && line[i + 1] === '~') break;
    if (ch === '{') {
      let s = '';
      i++;
      for (;;) {
        if (i >= line.length) throw new Error(`line ${n}: a string isn't closed with }`);
        const c = line[i];
        if (c === '{') { if (line[i + 1] !== '{') throw new Error(`line ${n}: a { inside a string must be doubled`); s += '{'; i += 2; continue; }
        if (c === '}') { if (line[i + 1] === '}') { s += '}'; i += 2; continue; } i++; break; }
        s += c; i++;
      }
      out.push({ s, str: true });
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== ' ' && line[j] !== '\t' && line[j] !== '{' && !(line[j] === '~' && line[j + 1] === '~')) j++;
    out.push({ s: line.slice(i, j), str: false });
    i = j;
  }
  return out;
}

/** Leading whitespace as a depth: a tab is one level, as are four spaces. */
function indentOf(line: string): number {
  let d = 0, sp = 0;
  for (const ch of line) { if (ch === '\t') { d++; sp = 0; } else if (ch === ' ') { if (++sp === 4) { d++; sp = 0; } } else break; }
  return d;
}

const KEYWORDS = new Set(['STATE:', 'IF:', 'DO:', 'NAV:']);

class Args {
  i = 0;
  constructor(readonly toks: Tok[], readonly line: number, readonly what: string) {}
  private next(kind: string): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new Error(`line ${this.line}: ${this.what} needs ${kind}`);
    return t;
  }
  str(): string { const t = this.next('a {string}'); if (!t.str) throw new Error(`line ${this.line}: ${this.what}: expected a {string}, found "${t.s}"`); return t.s; }
  word(): string { const t = this.next('a name'); if (t.str) throw new Error(`line ${this.line}: ${this.what}: expected a name, found {${t.s}}`); return t.s; }
  int(): number { const w = this.word(); if (!/^-?\d+$/.test(w)) throw new Error(`line ${this.line}: ${this.what}: "${w}" isn't a whole number`); return Number(w); }
  num(): number { const w = this.word(); const v = Number(w); if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(w) || !Number.isFinite(v)) throw new Error(`line ${this.line}: ${this.what}: "${w}" isn't a number`); return v; }
  hex(): number { const w = this.word(); if (!/^(0x)?[0-9a-f]{1,8}$/i.test(w)) throw new Error(`line ${this.line}: ${this.what}: "${w}" isn't hexadecimal`); return parseInt(w.replace(/^0x/i, ''), 16) | 0; }
  get more(): boolean { return this.i < this.toks.length; }
  end(): void { if (this.more) throw new Error(`line ${this.line}: ${this.what}: unexpected "${this.toks[this.i].s}"`); }
}

const I = (v: number): MetValue => ({ t: 'i', v: v | 0 });
const S = (v: string): MetValue => ({ t: 's', v });
const D = (v: number): MetValue => ({ t: 'd', v });
const kv = (pairs: Array<[string, MetValue]>): MetValue => ({ t: 'table', cols: ['k', 'v'], rows: pairs.map(([k, v]) => [S(k), v]) });
const KV = (items: Array<[number, MetValue]>): MetValue => ({ t: 'table', cols: ['K', 'V'], rows: items.map(([id, d]) => [I(id), d]) });

/** The operations on `lines` (all deeper than their parent), siblings at the first line's depth. */
function blocks(lines: AfLine[]): Array<{ line: AfLine; children: AfLine[] }> {
  const out: Array<{ line: AfLine; children: AfLine[] }> = [];
  if (!lines.length) return out;
  const depth = lines[0].indent;
  for (const l of lines) {
    if (l.indent <= depth || !out.length) out.push({ line: l, children: [] });
    else out[out.length - 1].children.push(l);
  }
  return out;
}

interface EmbedRef { tag: string; name: string; transform?: number[]; fill: (content: string) => void }

function condition(a: Args, children: AfLine[]): [number, MetValue] {
  const name = a.word();
  const id = COND_IDS[name];
  if (id === undefined) throw new Error(`line ${a.line}: unknown condition "${name}"`);
  const sub = (what: string) => new Args(a.toks.slice(a.i), a.line, what);
  switch (name) {
    case 'All': case 'Any': a.end(); return [id, KV(blocks(children).map((b) => condition(new Args(b.line.toks, b.line.n, 'a condition'), b.children)))];
    case 'Not': { const inner = condition(sub('Not'), children); return [id, KV([inner])]; }
    case 'ChatMatch': { const r = a.str(); a.end(); return [id, S(r)]; }
    case 'MainSlotsLE': case 'SecsInStateGE': case 'PSecsInStateGE': case 'BuPercentGE': { const n = a.int(); a.end(); return [id, I(n)]; }
    case 'ItemCountLE': case 'ItemCountGE': { const c = a.int(); const n = a.str(); a.end(); return [id, kv([['n', S(n)], ['c', I(c)]])]; }
    case 'MobsInDist_Name': { const c = a.int(); const r = a.num(); const n = a.str(); a.end(); return [id, kv([['n', S(n)], ['c', I(c)], ['r', D(r)]])]; }
    case 'MobsInDist_Priority': { const c = a.int(); const r = a.num(); const p = a.int(); a.end(); return [id, kv([['p', I(p)], ['c', I(c)], ['r', D(r)]])]; }
    case 'NoMobsInDist': { const r = a.num(); a.end(); return [id, kv([['r', D(r)]])]; }
    case 'BlockE': case 'CellE': { const h = a.hex(); a.end(); return [id, I(h)]; }
    case 'SecsOnSpellGE': { const sec = a.int(); const sid = a.int(); a.end(); return [id, kv([['sid', I(sid)], ['sec', I(sec)]])]; }
    case 'DistToRteGE': { const d = a.num(); a.end(); return [id, kv([['dist', D(d)]])]; }
    case 'Expr': { const e = a.str(); a.end(); return [id, kv([['e', S(e)]])]; }
    case 'ChatCapture': { const p = a.str(); const c = a.str(); a.end(); return [id, kv([['p', S(p)], ['c', S(c)]])]; }
    default: a.end(); return [id, I(0)];
  }
}

function action(a: Args, children: AfLine[], embeds: EmbedRef[]): [number, MetValue] {
  const name = a.word();
  const id = ACT_IDS[name];
  if (id === undefined) throw new Error(`line ${a.line}: unknown action "${name}"`);
  switch (name) {
    case 'DoAll': a.end(); return [id, KV(blocks(children).map((b) => action(new Args(b.line.toks, b.line.n, 'an action'), b.children, embeds)))];
    case 'SetState': case 'Chat': { const s = a.str(); a.end(); return [id, S(s)]; }
    case 'DoExpr': case 'ChatExpr': { const e = a.str(); a.end(); return [id, kv([['e', S(e)]])]; }
    case 'CallState': { const st = a.str(); const ret = a.str(); a.end(); return [id, kv([['st', S(st)], ['ret', S(ret)]])]; }
    case 'SetWatchdog': { const r = a.num(); const t = a.num(); const s = a.str(); a.end(); return [id, kv([['s', S(s)], ['r', D(r)], ['t', D(t)]])]; }
    case 'GetOpt': { const o = a.str(); const v = a.str(); a.end(); return [id, kv([['o', S(o)], ['v', S(v)]])]; }
    case 'SetOpt': { const o = a.str(); const v = a.str(); a.end(); return [id, kv([['o', S(o)], ['v', S(v)]])]; }
    case 'CreateView': { const n = a.str(); const x = a.str(); a.end(); return [id, kv([['n', S(n)], ['x', { t: 'ba', v: x }]])]; }
    case 'DestroyView': { const n = a.str(); a.end(); return [id, kv([['n', S(n)]])]; }
    case 'ClearWatchdog': case 'DestroyAllViews': a.end(); return [id, kv([])];
    case 'EmbedNav': {
      const tag = a.word(); const nm = a.str();
      let transform: number[] | undefined;
      if (a.more) {
        const t = a.str().trim().split(/\s+/).map(Number);
        if (t.length !== 7 || !t.every(Number.isFinite)) throw new Error(`line ${a.line}: EmbedNav's transform is seven numbers {a b c d e f g}`);
        transform = t;
      }
      a.end();
      const v: { t: 'ba'; v: string } = { t: 'ba', v: '' };
      embeds.push({ tag, name: nm, ...(transform ? { transform } : {}), fill: (c) => { v.v = c; } });
      return [id, v];
    }
    default: a.end(); return [id, I(0)];
  }
}

/** A nav node line (after its code) as a NavNode. */
function node(code: string, a: Args): NavNode {
  const type = NODE_CODES[code];
  const x = a.num(), y = a.num(), z = a.num();
  const n = (v: number) => vtNumber(v);
  let extra: string[] = [];
  switch (code) {
    case 'prt': extra = [String(a.hex())]; break;
    case 'rcl': { const nm = a.str(); const id = RECALL_BY_NAME.get(nm.toLowerCase()); if (id === undefined) throw new Error(`line ${a.line}: "${nm}" isn't a recall spell a navroute can cast`); extra = [String(id)]; break; }
    case 'pau': extra = [n(a.num())]; break;
    case 'cht': extra = [a.str()]; break;
    case 'vnd': { const g = a.hex(); extra = [String(g), a.str()]; break; }
    case 'ptl': case 'tlk': { const tx = a.num(), ty = a.num(), tz = a.num(); const cls = a.int(); extra = [a.str(), String(cls), 'True', n(tx), n(ty), n(tz)]; break; }
    case 'jmp': { const h = a.num(); const sh = a.str(); if (!/^(true|false)$/i.test(sh)) throw new Error(`line ${a.line}: jmp's hold-shift is {True} or {False}`); const d = a.num(); extra = [n(h), /^true$/i.test(sh) ? 'True' : 'False', n(d)]; break; }
    default: break;
  }
  a.end();
  return { type, ew: x, ns: y, z, extra };
}

/** Text in metaf's `.af` form as either a meta's rules and navs, or a single navroute. */
export type AfFile = { kind: 'meta'; rules: MetRule[] } | { kind: 'nav'; nav: NavRoute };

/** Read a metaf `.af` file. Errors name the line. */
export function parseAf(text: string): AfFile {
  const lines: AfLine[] = [];
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const toks = tokens(raw, i + 1);
    if (toks.length) lines.push({ n: i + 1, indent: indentOf(raw), toks });
  });
  const navs = new Map<string, NavRoute>();
  const rules: MetRule[] = [];
  const embeds: EmbedRef[] = [];
  let state: string | null = null;
  let sawState = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const head = l.toks[0];
    if (head.str || !KEYWORDS.has(head.s)) throw new Error(`line ${l.n}: expected STATE:, IF:, DO: or NAV:, found "${head.s}"`);
    const body = (): AfLine[] => { const out: AfLine[] = []; while (i + 1 < lines.length && lines[i + 1].indent > l.indent && (lines[i + 1].toks[0].str || !KEYWORDS.has(lines[i + 1].toks[0].s))) out.push(lines[++i]); return out; };
    if (head.s === 'STATE:') {
      const a = new Args(l.toks.slice(1), l.n, 'STATE:');
      state = a.str(); a.end(); sawState = true;
      continue;
    }
    if (head.s === 'IF:') {
      if (state === null) throw new Error(`line ${l.n}: IF: outside a STATE:`);
      const cond = condition(new Args(l.toks.slice(1), l.n, 'IF:'), body());
      const next = lines[i + 1];
      if (!next || next.toks[0].s !== 'DO:' || next.toks[0].str) throw new Error(`line ${l.n}: every IF: is followed by a DO:`);
      i++;
      const dl = next;
      const children: AfLine[] = [];
      while (i + 1 < lines.length && lines[i + 1].indent > dl.indent && (lines[i + 1].toks[0].str || !KEYWORDS.has(lines[i + 1].toks[0].s))) children.push(lines[++i]);
      const act = action(new Args(dl.toks.slice(1), dl.n, 'DO:'), children, embeds);
      rules.push({ cond: cond[0], condData: cond[1], act: act[0], actData: act[1], state });
      continue;
    }
    if (head.s === 'DO:') throw new Error(`line ${l.n}: DO: without an IF:`);
    // NAV: tag type, then its nodes.
    const a = new Args(l.toks.slice(1), l.n, 'NAV:');
    const tag = a.word(); const type = a.word(); a.end();
    if (!(NAV_TYPES as readonly string[]).includes(type)) throw new Error(`line ${l.n}: a NAV: type is circular, linear, follow or once`);
    if (navs.has(tag)) throw new Error(`line ${l.n}: nav tag "${tag}" is used twice`);
    const nodes: NavNode[] = [];
    let follow: NavRoute['follow'];
    while (i + 1 < lines.length && (lines[i + 1].toks[0].str || !KEYWORDS.has(lines[i + 1].toks[0].s))) {
      const nl = lines[++i];
      const na = new Args(nl.toks, nl.n, 'a nav node');
      const code = na.word();
      if (code === 'flw') {
        if (type !== 'follow') throw new Error(`line ${nl.n}: flw belongs in a follow nav`);
        const g = na.hex(); const nm = na.str(); na.end();
        follow = { name: nm, guid: g };
        continue;
      }
      if (NODE_CODES[code] === undefined) throw new Error(`line ${nl.n}: unknown nav node "${code}"`);
      if (type === 'follow') throw new Error(`line ${nl.n}: a follow nav holds one flw node`);
      nodes.push(node(code, na));
    }
    navs.set(tag, { mode: type as NavRoute['mode'], nodes, ...(type === 'follow' ? { follow: follow ?? { name: '', guid: 0 } } : {}) });
  }
  if (!sawState) {
    // Nothing but comments: an empty meta (a .met with no rules).
    if (!navs.size) return { kind: 'meta', rules: [] };
    if (navs.size !== 1) throw new Error('a nav-only .af holds exactly one NAV:');
    return { kind: 'nav', nav: [...navs.values()][0] };
  }
  for (const e of embeds) {
    const nav = navs.get(e.tag);
    if (!nav) throw new Error(`EmbedNav names nav "${e.tag}", which isn't in the file`);
    const moved = e.transform ? transformNav(nav, e.transform) : nav;
    e.fill(`${e.name}${NL}${moved.mode === 'follow' ? 0 : moved.nodes.length}${NL}${writeNavText(moved)}`);
  }
  return { kind: 'meta', rules };
}

/** metaf's EmbedNav transform {a b c d e f g}: x' = a·x + b·y + e, y' = c·x + d·y + f, z' = z + g (node and target positions). */
export function transformNav(nav: NavRoute, t: number[]): NavRoute {
  const [a, b, c, d, e, f, g] = t;
  const mv = (x: number, y: number, z: number): [number, number, number] => [a * x + b * y + e, c * x + d * y + f, z + g];
  return {
    ...nav,
    nodes: nav.nodes.map((n) => {
      const [ew, ns, z] = mv(n.ew, n.ns, n.z);
      let extra = n.extra;
      if (n.type === 6 || n.type === 7) { const [tx, ty, tz] = mv(Number(n.extra[3]), Number(n.extra[4]), Number(n.extra[5])); extra = [n.extra[0], n.extra[1], n.extra[2], vtNumber(tx), vtNumber(ty), vtNumber(tz)]; }
      return { ...n, ew, ns, z, extra };
    }),
  };
}

/** A NavRoute as `.nav` text (the body an Embed Nav carries). */
export function writeNavText(nav: NavRoute): string {
  const mode = { circular: 1, linear: 2, follow: 3, once: 4 }[nav.mode];
  const lines = ['uTank2 NAV 1.2', String(mode)];
  if (nav.mode === 'follow') lines.push(nav.follow?.name ?? '', String((nav.follow?.guid ?? 0) | 0));
  else {
    lines.push(String(nav.nodes.length));
    for (const n of nav.nodes) lines.push(String(n.type), vtNumber(n.ew), vtNumber(n.ns), vtNumber(n.z), '0', ...n.extra);
  }
  return lines.join(NL) + NL;
}

// ── writing ──

const esc = (s: string): string => `{${s.replace(/\{/g, '{{').replace(/\}/g, '}}')}}`;
const hex = (v: number): string => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const tabs = (n: number): string => '\t'.repeat(n);
const dictOf = (v: MetValue): Map<string, MetValue> => { const m = new Map<string, MetValue>(); if (v.t === 'table') for (const [k, x] of v.rows) if (k.t === 's') m.set(k.v, x); return m; };
const kids = (v: MetValue): Array<[number, MetValue]> => (v.t === 'table' ? v.rows.flatMap(([k, d]) => (k.t === 'i' ? [[k.v, d] as [number, MetValue]] : [])) : []);
const sv = (v: MetValue | undefined): string => (v && (v.t === 's' || v.t === 'ba') ? v.v : '');
const nv = (v: MetValue | undefined): number => (v && (v.t === 'i' || v.t === 'd') ? v.v : 0);
const iv = (v: MetValue | undefined): string => String(Math.trunc(nv(v)));
const dv = (v: MetValue | undefined): string => vtNumber(nv(v));

interface WriteCtx { navs: Array<{ tag: string; nav: NavRoute }>; problems: string[] }

/** A condition as its line text (after the indent) and its child lines at depth `depth + 1`. */
function condText(id: number, data: MetValue, depth: number, ctx: WriteCtx): { head: string; lines: string[] } {
  const name = COND_NAMES[id];
  const d = dictOf(data);
  const nest = (): string[] => kids(data).flatMap(([cid, cd]) => { const c = condText(cid, cd, depth + 1, ctx); return [tabs(depth + 1) + c.head, ...c.lines]; });
  switch (name) {
    case undefined: ctx.problems.push(`condition type ${id} has no metaf name; written as Never`); return { head: `Never ~~ VirindiTank condition type ${id}`, lines: [] };
    case 'All': case 'Any': return { head: name, lines: nest() };
    case 'Not': { const [c] = kids(data); if (!c) return { head: 'Not Never', lines: [] }; const inner = condText(c[0], c[1], depth, ctx); return { head: `Not ${inner.head}`, lines: inner.lines }; }
    case 'ChatMatch': return { head: `${name} ${esc(sv(data))}`, lines: [] };
    case 'MainSlotsLE': case 'SecsInStateGE': case 'PSecsInStateGE': case 'BuPercentGE': return { head: `${name} ${iv(data)}`, lines: [] };
    case 'ItemCountLE': case 'ItemCountGE': return { head: `${name} ${iv(d.get('c'))} ${esc(sv(d.get('n')))}`, lines: [] };
    case 'MobsInDist_Name': return { head: `${name} ${iv(d.get('c'))} ${dv(d.get('r'))} ${esc(sv(d.get('n')))}`, lines: [] };
    case 'MobsInDist_Priority': return { head: `${name} ${iv(d.get('c'))} ${dv(d.get('r'))} ${iv(d.get('p'))}`, lines: [] };
    case 'NoMobsInDist': return { head: `${name} ${dv(d.get('r'))}`, lines: [] };
    case 'BlockE': case 'CellE': return { head: `${name} ${hex(nv(data))}`, lines: [] };
    case 'SecsOnSpellGE': return { head: `${name} ${iv(d.get('sec'))} ${iv(d.get('sid'))}`, lines: [] };
    case 'DistToRteGE': return { head: `${name} ${dv(d.get('dist'))}`, lines: [] };
    case 'Expr': return { head: `${name} ${esc(sv(d.get('e')))}`, lines: [] };
    case 'ChatCapture': return { head: `${name} ${esc(sv(d.get('p')))} ${esc(sv(d.get('c')))}`, lines: [] };
    default: return { head: name, lines: [] };
  }
}

function actText(id: number, data: MetValue, depth: number, ctx: WriteCtx): { head: string; lines: string[] } {
  const name = ACT_NAMES[id];
  const d = dictOf(data);
  switch (name) {
    case undefined: ctx.problems.push(`action type ${id} has no metaf name; written as None`); return { head: `None ~~ VirindiTank action type ${id}`, lines: [] };
    case 'DoAll': return { head: name, lines: kids(data).flatMap(([aid, ad]) => { const a = actText(aid, ad, depth + 1, ctx); return [tabs(depth + 1) + a.head, ...a.lines]; }) };
    case 'SetState': case 'Chat': return { head: `${name} ${esc(sv(data))}`, lines: [] };
    case 'DoExpr': case 'ChatExpr': return { head: `${name} ${esc(sv(d.get('e')))}`, lines: [] };
    case 'CallState': return { head: `${name} ${esc(sv(d.get('st')))} ${esc(sv(d.get('ret')))}`, lines: [] };
    case 'SetWatchdog': return { head: `${name} ${dv(d.get('r'))} ${dv(d.get('t'))} ${esc(sv(d.get('s')))}`, lines: [] };
    case 'GetOpt': case 'SetOpt': return { head: `${name} ${esc(sv(d.get('o')))} ${esc(sv(d.get('v')))}`, lines: [] };
    case 'CreateView': {
      const x = sv(d.get('x'));
      if (/[\r\n]/.test(x)) ctx.problems.push(`CreateView "${sv(d.get('n'))}": its XML's line breaks are written as spaces (an .af string is one line)`);
      return { head: `${name} ${esc(sv(d.get('n')))} ${esc(x.replace(/\r?\n|\r/g, ' '))}`, lines: [] };
    }
    case 'DestroyView': return { head: `${name} ${esc(sv(d.get('n')))}`, lines: [] };
    case 'EmbedNav': {
      const e = parseEmbeddedNav(sv(data));
      const tag = `nav${ctx.navs.length}`;
      ctx.navs.push({ tag, nav: e.nav ?? { mode: 'once', nodes: [] } });
      return { head: `${name} ${tag} ${esc(e.name)}`, lines: [] };
    }
    default: return { head: name, lines: [] };
  }
}

/** A nav's section: `NAV: tag type` and its node lines. */
function navSection(tag: string, nav: NavRoute, problems: string[]): string[] {
  const out = [`NAV: ${tag} ${nav.mode}`];
  if (nav.mode === 'follow') { out.push(`\tflw ${hex(nav.follow?.guid ?? 0)} ${esc(nav.follow?.name ?? '')}`); return out; }
  for (const n of nav.nodes) {
    const code = NODE_NAMES[n.type];
    const pos = `${vtNumber(n.ew)} ${vtNumber(n.ns)} ${vtNumber(n.z)}`;
    const x = n.extra;
    switch (code) {
      case 'prt': out.push(`\tprt ${pos} ${hex(Number(x[0]))}`); break;
      case 'rcl': {
        const nm = RECALL_SPELLS[Number(x[0])];
        if (!nm) { problems.push(`nav ${tag}: recall spell ${x[0]} has no metaf name; written as a plain point`); out.push(`\tpnt ${pos}`); break; }
        out.push(`\trcl ${pos} ${esc(nm)}`); break;
      }
      case 'pau': out.push(`\tpau ${pos} ${x[0]}`); break;
      case 'cht': out.push(`\tcht ${pos} ${esc(x[0] ?? '')}`); break;
      case 'vnd': out.push(`\tvnd ${pos} ${hex(Number(x[0]))} ${esc(x[1] ?? '')}`); break;
      case 'ptl': case 'tlk': out.push(`\t${code} ${pos} ${x[3]} ${x[4]} ${x[5]} ${x[1]} ${esc(x[0] ?? '')}`); break;
      case 'jmp': out.push(`\tjmp ${pos} ${x[0]} ${esc(/^true$/i.test(x[1] ?? '') ? 'True' : 'False')} ${x[2]}`); break;
      default: out.push(`\t${code ?? 'pnt'} ${pos}`);
    }
  }
  return out;
}

const HEADER = ['~~ Written by acjs in metaf\'s .af text format (https://github.com/JJEII/metaf); metaf converts it to a VirindiTank file.', ''];

/** A meta's rules as `.af` text (states in their first-appearance order, then the embedded navs). */
export function metToAf(rules: MetRule[], problems: string[] = []): string {
  const ctx: WriteCtx = { navs: [], problems };
  const states: string[] = [];
  for (const r of rules) if (!states.includes(r.state)) states.push(r.state);
  const out = [...HEADER];
  for (const st of states) {
    out.push(`STATE: ${esc(st)}`);
    for (const r of rules.filter((x) => x.state === st)) {
      const c = condText(r.cond, r.condData, 2, ctx);
      out.push(`\tIF:\t${c.head}`, ...c.lines);
      const a = actText(r.act, r.actData, 3, ctx);
      out.push(`\t\tDO:\t${a.head}`, ...a.lines);
    }
  }
  for (const n of ctx.navs) out.push('', ...navSection(n.tag, n.nav, problems));
  return out.join(NL) + NL;
}

/** A navroute as a nav-only `.af`. */
export function navToAf(nav: NavRoute, problems: string[] = []): string {
  return [...HEADER, ...navSection('nav0', nav, problems)].join(NL) + NL;
}

/** A profile's meta as an `.af` file: the `.met` it exports, in metaf's form (what the .met can't hold is reported the same). */
export function exportAf(p: RoutineProfile): VTankExport {
  const met = exportMet(p);
  const problems = [...met.problems];
  return vtankFile(vtFileName(p.name, 'af'), metToAf(parseMet(met.text), problems), problems);
}

/** A route as a nav-only `.af` file. */
export function exportNavAf(r: Route): VTankExport {
  const nav = exportNav(r);
  const problems = [...nav.problems];
  return vtankFile(vtFileName(r.name, 'af'), navToAf(parseNav(nav.text), problems), problems);
}
