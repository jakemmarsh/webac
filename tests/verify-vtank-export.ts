/**
 * AGENT.vtank-export (docs/vtank-parity-gaps.md §10.1) — the routine document
 * back out as VirindiTank's .met / .nav / .utl. Every test drives the real
 * exporter and reads its output back with the real importer: what the format
 * holds comes back equal, what it can't hold is reported, and the community
 * corpus (reference/vtank-corpus, gitignored; skipped when absent, as on CI)
 * survives import → export → import.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_MODULES_OFF, type LootRule, type Route, type RoutineProfile,
  emptyRoutineDoc, evalExpr, exportMet, exportNav, exportUtl, exportVTank, importVTank, metToProfile, navToRoute, parseExpr, parseMet, parseNav, parseUtl,
  salvageCombineBlock, splitNameLookaheads, utlToLoot, validateRoutineDoc, vtExprString, vtFileName, vtNumber, type ExprHost,
} from '../packages/shared/src/routines/index.js';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const fx = (f: string) => readFileSync(resolve(__dirname, 'fixtures', 'vtank', f), 'latin1');
const reimportMet = (p: RoutineProfile) => metToProfile(p.name, parseMet(exportMet(p).text)).value;
const reimportNav = (r: Route) => navToRoute(r.name, parseNav(exportNav(r).text)).route;
const reimportUtl = (rules: LootRule[]) => utlToLoot(parseUtl(exportUtl('x', rules).text)).value;

describe('VirindiTank\'s text conventions', () => {
  it('numbers as .NET\'s "R" writes them (15 significant digits, exponent below 1e-4)', () => {
    expect(vtNumber(42.1)).toBe('42.1');
    expect(vtNumber(0)).toBe('0');
    expect(vtNumber(12345)).toBe('12345');
    expect(vtNumber(-0.000395833452542623)).toBe('-0.000395833452542623');
    expect(vtNumber(2.08333134651184e-5)).toBe('2.08333134651184E-05');
    expect(vtNumber(89.7681676228841)).toBe('89.7681676228841');
    expect(vtNumber(1e15)).toBe('1E+15');
    // 0.1 + 0.2 needs 17 digits to read back as itself.
    expect(Number(vtNumber(0.1 + 0.2))).toBe(0.1 + 0.2);
  });

  it('file names as VTank names them, without characters Windows forbids', () => {
    expect(vtFileName('Hunt', 'met')).toBe('Hunt.met');
    expect(vtFileName('TNGharuToAnnex.nav', 'nav')).toBe('TNGharuToAnnex.nav');
    expect(vtFileName('a/b:c?', 'utl')).toBe('a_b_c_.utl');
  });

  it('every line ends CRLF and each embedded length counts it as two', () => {
    const met = exportMet(importVTank([{ name: 'hunt.met', text: fx('hunt.met') }], null, 'Hunt').value).text;
    expect(met.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const ba = /\r\nba\r\n(\d+)\r\n/.exec(met)!;
    const start = ba.index + ba[0].length;
    expect(met.slice(start + Number(ba[1]), start + Number(ba[1]) + 3)).toBe('s\r\n');
  });
});

describe('.met', () => {
  const profile = (states: RoutineProfile['states'], routes: Route[] = []): RoutineProfile => ({
    name: 'Hunt', modules: { ...ALL_MODULES_OFF }, initialState: states[0]?.name ?? 'Default', states, loot: [], buffSets: [], routes, ruleFiring: 'once',
  });

  it('the fixture comes back the same after export and import', () => {
    const p1 = importVTank([{ name: 'hunt.met', text: fx('hunt.met') }, { name: 'loot.utl', text: fx('loot.utl') }], null, 'Hunt').value;
    const e = exportMet(p1);
    expect(e.fileName).toBe('Hunt.met');
    const p2 = importVTank([{ name: 'hunt.met', text: e.text }, { name: 'loot.utl', text: fx('loot.utl') }], null, 'Hunt').value;
    expect(p2).toEqual(p1);
    // VTank's file order (states interleaved) is kept, so the rules keep their numbers.
    expect(parseMet(e.text).map((r) => r.state)).toEqual(parseMet(fx('hunt.met')).map((r) => r.state));
  });

  it('every condition and action the format holds comes back equal', () => {
    const route: Route = { name: 'runback', mode: 'once', points: ['42.100N, 33.600E', '42.000N, 33.700E'], z: [0.39, 0.4], stops: [{ at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] }] };
    const rules: RoutineProfile['states'][number]['rules'] = [
      { when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'runback' }] },
      { when: [{ kind: 'not', condition: { kind: 'always' } }], do: [{ kind: 'set-state', state: 'Other' }] },
      { when: [{ kind: 'any', conditions: [{ kind: 'chat-matches', pattern: '^You have been' }, { kind: 'landblock', landblock: 0x8bb30000 }] }], do: [{ kind: 'call-state', state: 'Other', returnTo: 'Default' }] },
      { when: [{ kind: 'free-slots-below', slots: 3 }, { kind: 'seconds-in-state', seconds: 30 }], do: [{ kind: 'return' }] },
      { when: [{ kind: 'item-count-below', item: 'Mana Charge', count: 2 }], do: [{ kind: 'expression', expr: 'setvar[x,1]' }] },
      { when: [{ kind: 'not', condition: { kind: 'item-count-below', item: 'Pyreal', count: 500 } }], do: [{ kind: 'expression', expr: 'chatbox[hello]' }] },
      { when: [{ kind: 'monster-within', meters: 25, names: ['Drudge'] }], do: [{ kind: 'expression', expr: 'setvar[v,vtgetsetting[AttackDistance]]' }] },
      { when: [{ kind: 'monster-count', pattern: '^Olthoi', count: 3, meters: 12.5 }], do: [{ kind: 'expression', expr: 'vtsetsetting[EnableCombat,getvar[c]]' }] },
      { when: [{ kind: 'monster-priority-count', priority: 2, count: 3, meters: 12.5 }], do: [{ kind: 'set-setting', name: 'EnableCombat', value: false }] },
      { when: [{ kind: 'no-monster-within', meters: 40 }], do: [{ kind: 'set-setting', name: 'AttackDistance', value: 19.992 }, { kind: 'set-setting', name: 'ub:VideoPatch', value: true }] },
      { when: [{ kind: 'route-done' }, { kind: 'died' }, { kind: 'vendor-open' }, { kind: 'vendor-closed' }], do: [{ kind: 'set-watchdog', state: 'Other', meters: 5, seconds: 30 }] },
      { when: [{ kind: 'need-buff' }, { kind: 'landcell', cell: 0xa9b40019 }, { kind: 'portal-entered' }, { kind: 'portal-exited' }], do: [{ kind: 'clear-watchdog' }] },
      { when: [{ kind: 'seconds-in-state-persistent', seconds: 10 }, { kind: 'spell-time-at-least', spell: '', spellId: 2, seconds: 600 }], do: [{ kind: 'create-view', name: 'v', xml: '<view title="x"><control type="button" name="b" text="Go"/></view>' }] },
      { when: [{ kind: 'burden-above', percent: 150 }, { kind: 'route-distance-at-least', meters: 40 }], do: [{ kind: 'destroy-view', name: 'v' }, { kind: 'destroy-all-views' }] },
      { when: [{ kind: 'expression', expr: 'getvar[x]==1' }, { kind: 'chat-capture', pattern: '^(?<who>\\w+) says', colors: [0, 2] }], do: [{ kind: 'say', text: '/f hello' }] },
      { when: [{ kind: 'always' }], do: [
        { kind: 'use-object', name: 'Portal to Holtburg' }, { kind: 'use-item', item: 'Healing Kit', on: 'self' }, { kind: 'use-item', item: 'Legendary Key', to: 'Legendary Armor Chest' },
        { kind: 'give', item: 'Pyreal', to: 'Arbiter', count: 3 }, { kind: 'combat-mode', mode: 'magic' }, { kind: 'jump', heading: 180, holdMs: 1000, forward: true, walk: true },
        { kind: 'sell-by-loot-rules', vendor: '' }, { kind: 'stop' },
      ] },
    ];
    const p = profile([{ name: 'Default', rules: rules.map((r, i) => ({ ...r, label: `Rule ${i + 1}` })) }, { name: 'Other', rules: [] }], [route]);
    const e = exportMet(p);
    const back = reimportMet(p);
    expect(back.states).toEqual(p.states);
    expect(back.routes).toEqual(p.routes);
    expect(back.initialState).toBe('Default');
    expect(e.problems).toEqual([]);
    expect(validateRoutineDoc({ ...emptyRoutineDoc('local-eor', 'a'), profiles: [back] })).toEqual([]);
  });

  it('ours that VTank says another way come back as the same test (an expression, a Not, an Any)', () => {
    const p = profile([{ name: 'Default', rules: [
      { label: 'Rule 1', when: [{ kind: 'vital-below', vital: 'health', percent: 50 }], do: [{ kind: 'set-state', state: 'Default' }] },
      { label: 'Rule 2', when: [{ kind: 'near', coords: '42.1N, 33.6E', meters: 30 }], do: [{ kind: 'set-state', state: 'Default' }] },
      { label: 'Rule 3', when: [{ kind: 'unassigned-xp-above', xp: 5000 }], do: [{ kind: 'set-state', state: 'Default' }] },
      { label: 'Rule 4', when: [{ kind: 'monster-within', meters: 20 }], do: [{ kind: 'set-state', state: 'Default' }] },
      { label: 'Rule 5', when: [{ kind: 'monster-within', meters: 20, names: ['Drudge', 'Mite'] }], do: [{ kind: 'set-state', state: 'Default' }] },
      { label: 'Rule 6', when: [{ kind: 'no-monster-within', meters: 20, names: ['Drudge'] }], do: [{ kind: 'cast', spell: 'Portal Recall', target: 'self' }] },
    ] }]);
    const back = reimportMet(p).states[0].rules.map((r) => r.when[0]);
    expect(back[3]).toEqual({ kind: 'not', condition: { kind: 'no-monster-within', meters: 20 } });
    expect(back[4]).toEqual({ kind: 'any', conditions: [{ kind: 'monster-within', meters: 20, names: ['Drudge'] }, { kind: 'monster-within', meters: 20, names: ['Mite'] }] });
    expect(back[5]).toEqual({ kind: 'not', condition: { kind: 'monster-within', meters: 20, names: ['Drudge'] } });
    expect(reimportMet(p).states[0].rules[5].do).toEqual([{ kind: 'expression', expr: 'actiontrycastbyid[2645]' }]);
    // The expressions run in VTank's meta language as our conditions do (our evaluator, the same functions VTank has).
    const host = (health: number, at: { ns: number; ew: number }, xp: number): ExprHost => ({
      getVar: () => undefined, setVar: () => {}, clearVar: () => false, clearAllVars: () => {}, now: () => 0, echo: () => {},
      vital: (v) => (v === 1 ? { base: 100, current: health, buffedMax: 100 } : null),
      playerCoords: () => ({ kind: 'coords', ns: at.ns, ew: at.ew, z: 0 }),
      charProp: (kind, id) => (kind === 'quad' && id === 2 ? xp : undefined),
    });
    const holds = (i: number, h: ExprHost) => !!evalExpr(parseExpr((back[i] as { expr: string }).expr), h);
    const near = { ns: 42.1, ew: 33.6 };
    expect(holds(0, host(40, near, 0))).toBe(true);
    expect(holds(0, host(60, near, 0))).toBe(false);
    expect(holds(1, host(100, { ns: 42.1, ew: 33.6 + 20 / 240 }, 0))).toBe(true);
    expect(holds(1, host(100, { ns: 42.1, ew: 33.6 + 40 / 240 }, 0))).toBe(false);
    expect(holds(2, host(100, near, 6000))).toBe(true);
    expect(holds(2, host(100, near, 4000))).toBe(false);
    expect(vtExprString('42.1N, 33.6E')).toBe('\\4\\2\\.\\1N\\, \\3\\3\\.\\6E');
  });

  it('what a .met can\'t hold is reported: a spell by name, steps VTank has no action for, a switched-off rule, names', () => {
    const p = profile([
      { name: 'Hunt', rules: [
        { label: 'Low health', when: [{ kind: 'buff-missing', spell: 'Strength Self I' }], do: [{ kind: 'cast', spell: 'Heal Self I' }, { kind: 'set-state', state: 'Hunt' }] },
        { label: 'Off', disabled: true, when: [{ kind: 'died' }], do: [{ kind: 'attack-nearest' }, { kind: 'wait', seconds: 1 }] },
      ] },
      { name: 'Unused', rules: [] },
    ]);
    const e = exportMet(p);
    expect(e.problems).toEqual([
      'state "Hunt" Low health: "Strength Self I" missing (VTank\'s buff test is its own buff list) isn\'t a VirindiTank condition; written as Never',
      'state "Hunt" Low health: casting Heal Self I isn\'t a VirindiTank meta action; left out',
      'state "Hunt" Off: switched off here; VirindiTank has no off switch, so it\'s written as All(Never, …)',
      'state "Hunt" Off: attacking isn\'t a VirindiTank meta action; left out',
      'state "Hunt" Off: waiting isn\'t a VirindiTank meta action; left out',
      'rule names aren\'t kept (a .met has none): "Low health", "Off"',
      'state "Unused" has no rules and nothing goes to it; a .met can\'t hold it',
    ]);
    const back = reimportMet(p).states[0].rules;
    // A switched-off rule still never fires there: Never in front.
    expect(back[1].when).toEqual([{ kind: 'not', condition: { kind: 'always' } }, { kind: 'died' }]);
    expect(back[1].do).toEqual([{ kind: 'unsupported', what: 'no action', raw: { id: 0, data: { t: 'i', v: 0 } } }]);
  });

  it('what the importer couldn\'t run goes back as VTank had it (chat commands, unknown types, a missing loot profile)', () => {
    const met = ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', '3',
      'i', '27', 'i', '2', 'i', '7', 's', '/ub myquests', 's', 'Default',
      'i', '1', 'i', '2', 'i', '0', 's', '/vt loot load Hunting.utl', 's', 'Default',
      'i', '1', 'i', '99', 'i', '0', 'i', '5', 's', 'Default', ''].join('\r\n');
    const p1 = importVTank([{ name: 'x.met', text: met }], null, 'X').value;
    expect(p1.states[0].rules.every((r) => r.disabled)).toBe(true);
    const out = exportMet(p1).text;
    expect(out).toContain('i\r\n27\r\ni\r\n2\r\ni\r\n7\r\ns\r\n/ub myquests\r\n');
    expect(out).toContain('s\r\n/vt loot load Hunting\r\n');
    expect(out).toContain('i\r\n1\r\ni\r\n99\r\ni\r\n0\r\ni\r\n5\r\n');
    expect(importVTank([{ name: 'x.met', text: out }], null, 'X').value).toEqual(p1);
  });

  it('a route the meta loads goes in as an Embed Nav; one it doesn\'t have is /vt nav load, reported', () => {
    const p = profile([{ name: 'Default', rules: [{ label: 'Rule 1', when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'gone' }, { kind: 'load-loot', set: 'Hunting' }] }] }],
      [{ name: 'spare', mode: 'circular', points: ['1N, 1E'] }]);
    expect(exportMet(p).problems).toEqual([
      'state "Default" Rule 1: route "gone" isn\'t in this profile; written as /vt nav load (VirindiTank reads gone.nav from its folder)',
      'state "Default" Rule 1: loads loot profile "Hunting"; VirindiTank reads Hunting.utl from its folder (export it too)',
      'route(s) "spare" aren\'t used by the meta; export each as its .nav',
    ]);
  });
});

describe('.nav', () => {
  it('the fixture comes back the same', () => {
    const r = navToRoute('holtburg-loop', parseNav(fx('holtburg-loop.nav'))).route!;
    expect(r.z).toEqual([0.39, 0.39, 0.39]);
    expect(reimportNav(r)).toEqual(r);
  });

  it('every point type comes back: recall, pause, chat, open vendor, portal / NPC, NPC talk, jump; heights kept', () => {
    const r: Route = {
      name: 'Errands', mode: 'linear', points: ['42.100N, 33.600E', '42.200N, 33.700E', '0.020S, 10.000W', '1.000N, 1.000E', '2.000N, 2.000E', '3.000N, 3.000E', '4.000N, 4.000E', '5.000N, 5.000E', '6.000N, 6.000E'],
      z: [0.39, 0.4, -0.000395833452542623, 1, 2, 3, 4, 5, 6],
      stops: [
        { at: 1, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] },
        { at: 2, do: [{ kind: 'wait', seconds: 5 }] },
        { at: 3, do: [{ kind: 'say', text: '/f on my way' }] },
        { at: 4, do: [{ kind: 'use-object', name: 'Thomas the Grocer', vt: { id: -2147000000 } }, { kind: 'sell-by-loot-rules', vendor: 'Thomas the Grocer' }] },
        { at: 5, do: [{ kind: 'use-object', name: 'Portal to Holtburg', vt: { objectClass: 14, at: [33.61, 42.11, 0.39] } }] },
        { at: 6, do: [{ kind: 'talk-to', name: 'Sean the Speedy', vt: { objectClass: 37, at: [4.01, 4.02, 4] } }] },
        { at: 7, do: [{ kind: 'jump', heading: 180, holdMs: 500, walk: true }] },
        { at: 8, do: [{ kind: 'use-item', item: 'Healing Kit', on: 'self' }] },
      ],
    };
    const e = exportNav(r);
    expect(e.problems).toEqual([]);
    expect(e.fileName).toBe('Errands.nav');
    expect(parseNav(e.text).nodes.map((n) => n.type)).toEqual([0, 2, 3, 4, 5, 6, 7, 9, 4]);
    expect(reimportNav(r)).toEqual(r);
  });

  it('a Chat point whose command we don\'t run (another plugin\'s /mt …) is kept on the point and written back, not dropped', () => {
    const nav = ['uTank2 NAV 1.2', '2', '2', '0', '33.6', '42.1', '0.39', '0', '4', '33.7', '42.2', '0.39', '0', '/mt give Pyreal to Bob'].join('\r\n') + '\r\n';
    const { route, problems } = navToRoute('Errand', parseNav(nav));
    expect(problems).toEqual(['route "Errand" point 2: can\'t run chat command "/mt give Pyreal to Bob"; kept for export, skipped when walked']);
    expect(route!.stops).toEqual([{ at: 1, do: [{ kind: 'unsupported', what: 'chat command "/mt give Pyreal to Bob"', raw: { id: 2, data: { t: 's', v: '/mt give Pyreal to Bob' } } }] }]);
    const out = exportNav(route!);
    expect(parseNav(out.text).nodes.map((n) => [n.type, n.extra])).toEqual([[0, []], [4, ['/mt give Pyreal to Bob']]]);
    expect(reimportNav(route!)).toEqual(route);
  });

  it('Follow keeps the player by name and says VTank also wants their id; circular and once keep their type', () => {
    const f: Route = { name: 'F', mode: 'follow', points: [], follow: 'Leader' };
    const e = exportNav(f);
    expect(e.text).toBe('uTank2 NAV 1.2\r\n3\r\nLeader\r\n0\r\n');
    expect(reimportNav(f)).toEqual(f);
    expect(e.problems).toEqual(['route "F": follows "Leader" by name; VirindiTank also wants their object id (written 0, pick them again there)']);
    for (const mode of ['circular', 'once'] as const) expect(reimportNav({ name: 'R', mode, points: ['1.000N, 1.000E'], z: [0] })?.mode).toBe(mode);
  });

  it('several steps at one point become several VTank points there; what a point can\'t do is reported', () => {
    const r: Route = { name: 'R', mode: 'once', points: ['1.000N, 1.000E', '2.000N, 2.000E'], stops: [
      { at: 0, do: [{ kind: 'wait', seconds: 2 }, { kind: 'say', text: '/ls' }] },
      { at: 1, do: [{ kind: 'attack-nearest' }, { kind: 'use-object', name: 'Lever', vt: { objectClass: 8 } }] },
    ] };
    const e = exportNav(r);
    expect(parseNav(e.text).nodes.map((n) => [n.type, n.ew, n.ns])).toEqual([[3, 1, 1], [4, 1, 1], [6, 2, 2]]);
    expect(e.problems).toEqual([
      'route "R" point 2: attacking isn\'t a VirindiTank navroute step; left out',
      'route "R": 2 point(s) have no recorded height; written at height 0',
      'route "R": 1 Use Portal/NPC or NPC Talk point(s) have no recorded object kind or position; written as a portal (14) or NPC (37) standing at the point',
    ]);
  });
});

describe('.utl', () => {
  it('the fixture comes back the same', () => {
    const l = utlToLoot(parseUtl(fx('loot.utl'))).value;
    const e = exportUtl('loot', l);
    expect(e.problems).toEqual([]);
    expect(e.text.startsWith('UTL\r\n1\r\n5\r\n')).toBe(true);
    expect(reimportUtl(l)).toEqual(l);
  });

  it('every requirement the format holds comes back equal', () => {
    const rules: LootRule[] = [
      { label: 'Props', action: 'keep', match: { name: '^Pyreals?$', valueAtLeast: 500, valueAtMost: 9000, burdenAtMost: 200, types: ['Armor'], props: [
        { kind: 'int', key: 9, op: 'le', value: 3 }, { kind: 'int', key: 45, op: 'ge', value: 1 }, { kind: 'int', key: 105, op: 'eq', value: 10 },
        { kind: 'int', key: 131, op: 'ne', value: 3 }, { kind: 'int', key: 179, op: 'flag', value: 1 }, { kind: 'did', key: 52, op: 'eq', value: 23308 },
        { kind: 'float', key: 22, op: 'le', value: 0.5 }, { kind: 'float', key: 13, op: 'ge', value: 1.2 }, { kind: 'string', key: 7, op: 'match', value: 'Jake' },
      ] } },
      { label: 'Spells', action: 'salvage', match: { spells: { match: 'Legendary', notMatch: 'Minor', count: 2 }, spellCountAtLeast: 3, minDamageAtLeast: 12.5, descFlags: 0x10000 } },
      { label: 'One spell', action: 'sell', match: { spells: { match: 'Epic', count: 1 }, totalRatingsAtLeast: 10 } },
      { label: 'Colours', action: 'keep', match: { colours: [
        { rgb: [255, 195, 46], maxHue: 10, maxSV: 0.1 }, { rgb: [70, 6, 87], maxHue: 12, maxSV: 0.2, slots: [1] },
        { rgb: [195, 8, 16], maxHue: 10, maxSV: 0.1, slots: [1, 2], group: 'Amuli Coat (Collar/Shoulder)' },
      ], palettes: [{ slot: 1, palette: 3055 }] } },
      { label: 'You', action: 'keep-up-to', count: 5, match: { freeSlotsAtLeast: 5, characterLevelAtLeast: 10, characterLevelAtMost: 50, characterSkills: [{ skill: 34, atLeast: 200 }, { skill: 6, baseMin: 10, baseMax: 300 }] } },
      { label: 'Off', action: 'ignore', disabled: true, match: { name: 'Junk' } },
      { label: 'Two names', action: 'keep', match: { name: '(?=[\\s\\S]*?(?:Gem))(?=[\\s\\S]*?(?:(Great|Lesser)))' } },
    ];
    const e = exportUtl('Everything', rules);
    expect(e.problems).toEqual([]);
    expect(e.fileName).toBe('Everything.utl');
    expect(reimportUtl(rules)).toEqual(rules);
    expect(splitNameLookaheads(rules[6].match.name!)).toEqual(['Gem', '(Great|Lesser)']);
  });

  it('what VTClassic had that we can\'t run goes back as written (Read / User actions, unknown requirements)', () => {
    const utl = ['UTL', '1', '3', 'Read me', '', '0;4;7', '4', '33', 'Foci', '', '0;1;7;2001', '4', '38', '6', '12.5', 'Plugin', '', '0;6;7', '4', '33', ''].join('\r\n');
    const l = utlToLoot(parseUtl(utl)).value;
    // Read (4) is our 'read' (built 2026-10-11); User2 (6) loots like Keep and keeps its id for the export.
    expect(l[0]).toMatchObject({ action: 'read' });
    expect(l[0].vtc).toBeUndefined();
    expect(l[0].disabled).toBeUndefined();
    expect(l[1].vtc).toEqual({ reqs: [{ type: 7, lines: ['38'] }, { type: 2001, lines: ['12.5'] }] });
    expect(l[2]).toMatchObject({ action: 'keep', vtc: { action: 6 }, note: 'VTClassic action User2: looted and kept' });
    expect(l[2].disabled).toBeUndefined();
    const out = exportUtl('x', l).text;
    // Written back byte for byte.
    expect(out).toBe(utl);
    expect(reimportUtl(l)).toEqual(l);
  });

  it('what a .utl can\'t hold is reported, and the rule is written switched off (never broader)', () => {
    const rules: LootRule[] = [
      { label: 'Appraised', action: 'sell', note: 'mine', match: { appraisal: 'Bloodstone' } },
      { label: 'Two kinds', action: 'keep', match: { types: ['Armor', 'Jewelry'], valueAtLeast: 1000 } },
    ];
    const e = exportUtl('x', rules);
    expect(e.problems).toEqual([
      'loot rule 1 "Appraised": can\'t write appraisal text /Bloodstone/ (VTClassic tests properties, not the appraisal text); the rule is written switched off',
      'loot rule 1 "Appraised": its note isn\'t kept (a .utl has none)',
      'loot rule 2 "Two kinds": matches any of 2 item types; written as 2 rules, one per type',
    ]);
    const back = reimportUtl(rules);
    expect(back[0]).toMatchObject({ disabled: true, action: 'sell' });
    // Any of two types = two adjacent rules (first match wins), the same items either way.
    expect(back.slice(1).map((r) => r.match)).toEqual([{ types: ['Armor'], valueAtLeast: 1000 }, { types: ['Jewelry'], valueAtLeast: 1000 }]);
  });

  it('the SalvageCombine hook writes VTClassic\'s block after the rules', () => {
    const block = salvageCombineBlock({ defaultCombine: '1-6, 7-8, 9, 10', materials: [{ material: 32, combine: '1-10' }] });
    const e = exportUtl('x', [], { blocks: [block] });
    expect(e.text).toBe('UTL\r\n1\r\n0\r\nSalvageCombine\r\n33\r\n1\r\n1-6, 7-8, 9, 10\r\n1\r\n32\r\n1-10\r\n');
    expect(parseUtl(e.text)).toEqual([]);
  });

  it('characters VirindiTank\'s files can\'t hold are reported', () => {
    expect(exportUtl('x', [{ label: 'Snow ☃', action: 'keep', match: {} }]).problems).toEqual(['characters VirindiTank\'s files can\'t hold (Windows-1252) are written as "?": ☃']);
  });
});

describe('a profile\'s files', () => {
  it('exportVTank: the meta, the Auto-Navigation route, the loot set in use; null for one it lacks', () => {
    const p = importVTank([{ name: 'hunt.met', text: fx('hunt.met') }, { name: 'loot.utl', text: fx('loot.utl') }, { name: 'holtburg-loop.nav', text: fx('holtburg-loop.nav') }], null, 'Hunt').value;
    expect(exportVTank(p, 'met')!.fileName).toBe('Hunt.met');
    expect(exportVTank(p, 'nav')!.fileName).toBe('Holtburg loop.nav');
    expect(exportVTank(p, 'nav', 'holtburg-loop')!.fileName).toBe('holtburg-loop.nav');
    expect(exportVTank(p, 'utl')!.fileName).toBe('Hunt.utl');
    expect(exportVTank(p, 'utl', 'LOOT')!.fileName).toBe('loot.utl');
    expect(exportVTank(p, 'nav', 'nope')).toBeNull();
    expect(exportVTank(p, 'utl', 'nope')).toBeNull();
  });
});

describe('UtilityBelt\'s /ub use X on Y uses the item on the object named Y', () => {
  it('imports as use-item to Y, and the engine uses it on that object', async () => {
    const met = ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', '1', 'i', '1', 'i', '2', 'i', '0', 's', '/ub use Legendary Key on Legendary Armor Chest', 's', 'Default', ''].join('\r\n');
    const p = importVTank([{ name: 'k.met', text: met }], null, 'K').value;
    expect(p.states[0].rules[0].do).toEqual([{ kind: 'use-item', item: 'Legendary Key', to: 'Legendary Armor Chest' }]);
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.inv.push({ guid: 0x80001010, name: 'Legendary Key', where: 'main pack', stack: 1 });
    host.add({ guid: 0x80001020, name: 'Legendary Armor Chest', x: 81, y: 21 });
    api.routine.start({ ...p, macro: false });
    run(api, host, 600); await vi.advanceTimersByTimeAsync(0);
    expect(host.sent).toContain('usewith 80001010 80001020');
    api.routine.stop();
    vi.useRealTimers();
  });
});

const CORPUS = process.env.ACJS_VTANK_CORPUS ?? resolve(__dirname, '..', 'reference', 'vtank-corpus');
describe.skipIf(!existsSync(CORPUS))('the community corpus: import → export → import is stable (reference/vtank-corpus)', () => {
  it('every .met, .nav and .utl comes back the same (portal-by-id and checkpoint points included)', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const files = walk(CORPUS).filter((f) => /\.(met|nav|utl)$/i.test(f));
    expect(files.length).toBeGreaterThan(300);
    const differ: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      const name = f.replace(/^.*[\\/]/, '');
      const stem = name.replace(/\.(met|nav|utl)$/i, '');
      let a: unknown; let b: unknown;
      if (/\.met$/i.test(f)) {
        a = importVTank([{ name, text }], null, stem).value;
        b = importVTank([{ name, text: exportMet(a as RoutineProfile).text }], null, stem).value;
      } else if (/\.nav$/i.test(f)) {
        a = navToRoute(stem, parseNav(text)).route;
        if (!a) continue; // an empty .nav imports as nothing
        b = navToRoute(stem, parseNav(exportNav(a as Route).text)).route;
      } else {
        a = utlToLoot(parseUtl(text)).value;
        b = utlToLoot(parseUtl(exportUtl(stem, a as LootRule[]).text)).value;
      }
      // Equal as values (the order of an object's keys is no part of the document).
      if (!isDeepStrictEqual(a, b)) differ.push(f.slice(CORPUS.length));
    }
    // The 13 community routes with a deprecated type-1 portal point (by object id) round-trip too, as use-portal steps.
    expect(differ).toEqual([]);
  });
});

describe('a loot profile\'s salvage-bag bands go out with its .utl (SalvageCombine block)', () => {
  it('bands parsed from a .utl (salvage.ts fields) are written back and read again', async () => {
    const r = await import('../packages/shared/src/routines/index.ts');
    const sc = { default: '1-6, 7-8, 9, 10', materials: { '20': '1-10' }, valueModes: { '20': 500 } };
    const p = { name: 'Hunt', modules: {}, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], lootSets: { Salv: [] }, salvageCombineSets: { Salv: sc }, buffSets: [], routes: [] } as unknown as RoutineProfile;
    const out = r.exportVTank(p, 'utl', 'Salv')!;
    expect(out.text).toContain('SalvageCombine');
    expect(r.parseUtlFile(out.text).salvageCombine).toEqual(sc);
    // A profile with no bands writes no block (VTClassic's defaults then apply on import).
    expect(r.exportVTank({ ...p, salvageCombineSets: undefined }, 'utl', 'Salv')!.text).not.toContain('SalvageCombine');
  });
});
