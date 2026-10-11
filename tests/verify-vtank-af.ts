/**
 * metaf's `.af` text format (docs/vtank-parity-gaps.md §10.3,
 * packages/shared/src/routines/vtankAf.ts): an `.af` imports exactly as the
 * `.met` / `.nav` it stands for, every condition, action and nav node reads
 * and writes, and a profile exports as `.af`. Implemented from metaf's
 * published format description (metaf is GPL; none of its code is used).
 *
 * Fixtures: tests/fixtures/vtank/hunt.af and holtburg-loop.af are our own,
 * hand-written equivalents of hunt.met and holtburg-loop.nav. The community
 * corpus (reference/vtank-corpus, gitignored) runs when present: every .met
 * there survives .met → .af → import, and metaf's own `.af` output (MossTank's
 * fixtures) imports the same as its `.met` / `.nav` twin.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  afToVTankText, exportAf, exportNavAf, importVTankFiles, metToAf, navToAf, parseAf, parseMet, parseNav, transformNav, vtankFileKind,
  type MetRule, type MetValue,
} from '../packages/shared/src/routines/index.ts';

const fx = (n: string): string => readFileSync(resolve(__dirname, 'fixtures/vtank', n), 'latin1');
/**
 * A profile without the file names its import notes carry, and without the "Rule N" labels (numbered in
 * file order): an .af lists each state's rules together, as metaf requires, so a .met whose states
 * interleave (hunt.met: Fight, Sell, Fight) numbers them differently. Each state's rules keep their order.
 */
const strip = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\.(af|met|nav)\b/g, '').replace(/"label":"Rule \d+",?/g, ''));

const I = (v: number): MetValue => ({ t: 'i', v });
const S = (v: string): MetValue => ({ t: 's', v });
const D = (v: number): MetValue => ({ t: 'd', v });
const kv = (pairs: Array<[string, MetValue]>): MetValue => ({ t: 'table', cols: ['k', 'v'], rows: pairs.map(([k, v]) => [S(k), v]) });
const KV = (items: Array<[number, MetValue]>): MetValue => ({ t: 'table', cols: ['K', 'V'], rows: items.map(([id, d]) => [I(id), d]) });

describe('reading .af', () => {
  it('our hand-written hunt.af is the same profile as hunt.met; holtburg-loop.af the same route as the .nav', () => {
    const a = importVTankFiles([{ name: 'hunt.af', text: fx('hunt.af') }], null, 'hunt');
    const b = importVTankFiles([{ name: 'hunt.met', text: fx('hunt.met') }], null, 'hunt');
    expect(a.problems).toEqual(b.problems);
    expect(strip(a.value)).toEqual(strip(b.value));
    expect(parseAf(fx('holtburg-loop.af'))).toEqual({ kind: 'nav', nav: parseNav(fx('holtburg-loop.nav')) });
    expect(vtankFileKind('hunt.af', '')).toBe('af');
    expect(vtankFileKind('noext', fx('hunt.af'))).toBe('af');
  });

  it('strings in braces with doubled braces inside; ~~ comments outside them; tabs or four spaces', () => {
    const r = parseAf([
      'STATE: {a {{b}} c}  ~~ a comment',
      '    IF: ChatMatch {x ~~ y}}}',
      '        DO: Chat {/say {{hi}}}',
    ].join('\n'));
    expect(r).toEqual({ kind: 'meta', rules: [{ cond: 4, condData: S('x ~~ y}'), act: 2, actData: S('/say {hi}'), state: 'a {b} c' }] });
  });

  it('nesting follows the indentation: All / Any / DoAll wrap the deeper lines, Not takes the operation on its line', () => {
    const r = parseAf([
      'STATE: {S}',
      '\tIF:\tAll',
      '\t\t\tNot Any',
      '\t\t\t\tDeath',
      '\t\t\t\tNavEmpty',
      '\t\t\tAlways',
      '\t\tDO:\tDoAll',
      '\t\t\t\tDoAll',
      '\t\t\t\t\tNone',
      '\t\t\t\tReturn',
    ].join('\r\n'));
    expect(r).toEqual({ kind: 'meta', rules: [{
      cond: 2, condData: KV([[21, KV([[3, KV([[8, I(0)], [7, I(0)]])]])], [1, I(0)]]),
      act: 3, actData: KV([[3, KV([[0, I(0)]])], [6, I(0)]]), state: 'S',
    }] });
  });

  it('an EmbedNav names a NAV: below; its transform moves every point (and a Use target) as metaf documents', () => {
    const text = [
      'STATE: {Default}',
      '\tIF:\tAlways',
      '\t\tDO:\tEmbedNav hive {H90} {1 0 0 1 0 -0.8 0}',
      'NAV: hive linear',
      '\tpnt 10 20 0.5',
      '\tptl 10 20 0.5 11 21 0.6 14 {Hive Portal}',
    ].join('\n');
    const r = parseAf(text);
    if (r.kind !== 'meta') throw new Error('meta');
    const ba = r.rules[0].actData;
    expect(ba.t).toBe('ba');
    const v = (ba as { v: string }).v;
    expect(v.startsWith('H90\r\n2\r\nuTank2 NAV 1.2\r\n2\r\n2\r\n')).toBe(true);
    const nav = parseNav(v.split('\r\n').slice(2).join('\r\n'));
    expect(nav.nodes.map((n) => [n.ew, n.ns, n.z])).toEqual([[10, 19.2, 0.5], [10, 19.2, 0.5]]);
    expect(nav.nodes[1].extra).toEqual(['Hive Portal', '14', 'True', '11', '20.2', '0.6']);
    expect(transformNav(nav, [0, 1, 1, 0, 0, 0, 1]).nodes[0]).toMatchObject({ ew: 19.2, ns: 10, z: 1.5 });
  });

  it('errors name the line', () => {
    expect(() => parseAf('STATE: {A}\n\tIF:\tSomething\n\t\tDO:\tNone')).toThrow(/line 2: unknown condition "Something"/);
    expect(() => parseAf('STATE: {A}\n\tIF:\tAlways')).toThrow(/line 2: every IF: is followed by a DO:/);
    expect(() => parseAf('STATE: {A}\n\tIF:\tChatMatch {open\n\t\tDO:\tNone')).toThrow(/line 2: a string isn't closed/);
    expect(() => parseAf('STATE: {A}\n\tIF:\tAlways\n\t\tDO:\tEmbedNav nope {x}')).toThrow(/nav "nope", which isn't in the file/);
    expect(() => parseAf('NAV: n once\n\trcl 1 2 3 {Not A Recall}')).toThrow(/line 2: "Not A Recall" isn't a recall spell/);
    expect(importVTankFiles([{ name: 'bad.af', text: 'IF: Always' }], null, 'x').problems[0]).toMatch(/^bad\.af: could not read it \(line 1: IF: outside a STATE:\)/);
  });
});

describe('writing .af', () => {
  // Every condition (0–26, 28) and action (0–15) with its data as the .met holds it.
  const conds: Array<[number, MetValue]> = [
    [0, I(0)], [1, I(0)], [2, KV([[1, I(0)]])], [3, KV([])], [4, S('^You {say}')], [5, I(3)], [6, I(10)], [7, I(0)], [8, I(0)], [9, I(0)], [10, I(0)],
    [11, kv([['n', S('Prismatic Taper')], ['c', I(25)]])], [12, kv([['n', S('Mana Charge')], ['c', I(2)]])],
    [13, kv([['n', S('Drudge.*')], ['c', I(5)], ['r', D(13.7)]])], [14, kv([['p', I(2)], ['c', I(6)], ['r', D(4.7)]])], [15, I(0)],
    [16, kv([['r', D(20.6)]])], [17, I(0x8b370000 | 0)], [18, I(0x8b37e3a1 | 0)], [19, I(0)], [20, I(0)], [21, KV([[8, I(0)]])], [22, I(15)],
    [23, kv([['sid', I(4291)], ['sec', I(120)]])], [24, I(110)], [25, kv([['dist', D(12.5)]])], [26, kv([['e', S('getvar[x]==1')]])],
    [28, kv([['p', S('(?<who>.+) says')], ['c', S('2;4')]])],
  ];
  const acts: Array<[number, MetValue]> = [
    [0, I(0)], [1, S('Fight')], [2, S('/vt nav load x')], [3, KV([[1, S('A')], [2, S('/say hi')]])],
    [5, kv([['st', S('Do')], ['ret', S('Back')]])], [6, I(0)], [7, kv([['e', S('setvar[a,1]')]])], [8, kv([['e', S('\\/t me, hi')]])],
    [9, kv([['s', S('Stuck')], ['r', D(12.3)], ['t', D(4.6)]])], [10, kv([])], [11, kv([['o', S('OpenDoors')], ['v', S('doors')]])],
    [12, kv([['o', S('OpenDoors')], ['v', S('true')]])], [13, kv([['n', S('v')], ['x', { t: 'ba', v: '<view title="{x}"/>' }]])], [14, kv([['n', S('v')]])], [15, kv([])],
  ];

  it('every condition and action reads back exactly as written', () => {
    const rules: MetRule[] = [
      ...conds.map(([cond, condData]) => ({ cond, condData, act: 0, actData: I(0), state: 'Conds' })),
      ...acts.map(([act, actData]) => ({ cond: 1, condData: I(0), act, actData, state: 'Acts' })),
    ];
    const af = metToAf(rules);
    expect(af).toMatch(/\tIF:\tBlockE 8B370000\r\n/);
    expect(af).toMatch(/\tIF:\tChatMatch \{\^You \{\{say\}\}\}\r\n/);
    expect(af).toMatch(/\t\tDO:\tSetWatchdog 12\.3 4\.6 \{Stuck\}\r\n/);
    const back = parseAf(af);
    expect(back).toEqual({ kind: 'meta', rules });
  });

  it('every nav node and route type reads back', () => {
    const nodes = [
      { type: 0, ew: 33.6, ns: 42.1, z: 0.39, extra: [] },
      { type: 1, ew: 1, ns: 2, z: 3, extra: [String(0x7a9b0001 | 0)] },
      { type: 2, ew: 1, ns: 2, z: 3, extra: ['1635'] },
      { type: 3, ew: 1, ns: 2, z: 3, extra: ['5000'] },
      { type: 4, ew: 1, ns: 2, z: 3, extra: ['/ub use {Gateway}'] },
      { type: 5, ew: 1, ns: 2, z: 3, extra: [String(0x80000123 | 0), 'Shopkeeper Renald'] },
      { type: 6, ew: 1, ns: 2, z: 3, extra: ['Portal to Holtburg', '14', 'True', '1.5', '2.5', '3.5'] },
      { type: 7, ew: 1, ns: 2, z: 3, extra: ['Town Crier', '37', 'True', '1.5', '2.5', '3.5'] },
      { type: 8, ew: 1, ns: 2, z: 3, extra: [] },
      { type: 9, ew: 1, ns: 2, z: 3, extra: ['180', 'True', '500'] },
    ];
    for (const mode of ['circular', 'linear', 'once'] as const) {
      const nav = { mode, nodes };
      expect(parseAf(navToAf(nav))).toEqual({ kind: 'nav', nav });
    }
    const follow = { mode: 'follow' as const, nodes: [], follow: { name: 'Leader', guid: 0x50000aaa } };
    expect(navToAf(follow)).toMatch(/\tflw 50000AAA \{Leader\}/);
    expect(parseAf(navToAf(follow))).toEqual({ kind: 'nav', nav: follow });
  });

  it('a profile exports as .af (its meta, or a route): importing that gives the same profile', () => {
    const p = importVTankFiles([{ name: 'hunt.met', text: fx('hunt.met') }], null, 'hunt').value;
    const out = exportAf(p);
    expect(out.fileName).toBe('hunt.af');
    expect(out.text).toMatch(/^STATE: \{Default\}\r\n\tIF:\tAlways\r\n\t\tDO:\tEmbedNav nav0 \{Holtburg loop\}\r\n/m);
    expect(strip(importVTankFiles([{ name: 'hunt.af', text: out.text }], null, 'hunt').value)).toEqual(strip(p));
    const nav = exportNavAf(p.routes[0]);
    expect(nav.fileName).toBe('Holtburg loop.af');
    expect(afToVTankText(nav.text).kind).toBe('nav');
    expect(importVTankFiles([{ name: 'x.af', text: nav.text }], null, 'x').value.routes[0].points).toEqual(p.routes[0].points);
  });
});

const CORPUS = process.env.ACJS_VTANK_CORPUS ?? resolve(__dirname, '..', 'reference', 'vtank-corpus');
// metaf's own output beside the .met / .nav it came from: MossTank's test fixtures (GPL, so kept out of the
// repo in reference/vtank-mosstank/{af,met,nav}, gitignored).
const MOSS = process.env.ACJS_VTANK_MOSSTANK ?? resolve(__dirname, '..', 'reference', 'vtank-mosstank');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
describe.skipIf(!existsSync(CORPUS) && !existsSync(MOSS))('the community corpus in .af (reference/vtank-corpus, reference/vtank-mosstank)', () => {
  it('every .met: .met → .af → import is the same profile as importing the .met', () => {
    const files = [...walk(CORPUS), ...walk(MOSS)].filter((f) => /\.met$/i.test(f));
    let n = 0;
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      let rules: MetRule[];
      try { rules = parseMet(text); } catch { continue; }
      const a = importVTankFiles([{ name: 'x.met', text }], null, 'X').value;
      const b = importVTankFiles([{ name: 'x.af', text: metToAf(rules) }], null, 'X').value;
      expect(b, f).toEqual(a);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });

  it('metaf\'s own .af output imports the same as its .met / .nav twin', () => {
    const afs = walk(MOSS).filter((f) => /\.af$/i.test(f));
    let n = 0;
    for (const f of afs) {
      const stem = basename(f).replace(/\.af$/i, '');
      const parsed = parseAf(readFileSync(f, 'latin1'));
      const twin = join(dirname(dirname(f)), parsed.kind === 'meta' ? 'met' : 'nav', `${stem}.${parsed.kind === 'meta' ? 'met' : 'nav'}`);
      if (!existsSync(twin)) continue;
      const a = importVTankFiles([{ name: `${stem}.af`, text: readFileSync(f, 'latin1') }], null, 'X').value;
      const b = importVTankFiles([{ name: `${stem}.${parsed.kind === 'meta' ? 'met' : 'nav'}`, text: readFileSync(twin, 'latin1') }], null, 'X').value;
      expect(strip(a), f).toEqual(strip(b));
      n++;
    }
    if (afs.length) expect(n).toBeGreaterThan(0);
  });
});
