/**
 * BUG.vtank-embed-nav-duplicate-route — a meta that embeds the same nav twice (VTank's Embed Nav action)
 * imports one route, and both load actions name it. FearFactoryFellowV2.met embeds RynthidToGeilla.nav
 * twice with the same three points; the dropdown showed "RynthidToGeilla.nav" and "RynthidToGeilla.nav (2)".
 * Different contents under one name still get "(2)": VTank loaded whichever was embedded at that action.
 * The real meta is in reference/vtank-corpus (gitignored; skipped when absent, as on CI).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { importVTank, metToProfile, parseMet, sameRoute, type MetRule, type RoutineAction, type RoutineProfile } from '../packages/shared/src/routines/index.js';

const loads = (p: RoutineProfile): string[] => p.states.flatMap((s) => s.rules.flatMap((r) => r.do)).flatMap((a: RoutineAction) => (a.kind === 'load-route' ? [a.route] : []));

const navText = (mode: number, pts: Array<[number, number]>): string => ['uTank2 NAV 1.2', String(mode), String(pts.length), ...pts.flatMap(([ew, ns]) => ['0', String(ew), String(ns), '0', '0'])].join('\r\n') + '\r\n';
const embed = (name: string, mode: number, pts: Array<[number, number]>): MetValue => ({ t: 'ba', v: `${name}\r\n${pts.length}\r\n${navText(mode, pts)}` });
type MetValue = MetRule['actData'];
const rule = (state: string, actData: MetValue): MetRule => ({ cond: 0, condData: { t: 'i', v: 0 }, act: 4, actData, state });

const A: Array<[number, number]> = [[-63.3, -61.6], [-63.2, -61.6], [-63.1, -61.5]];
const B: Array<[number, number]> = [[10, 20], [11, 21]];

describe('Embed Nav: the same nav embedded twice is one route', () => {
  it('two identical same-named embeds: one route, both actions load it', () => {
    const r = metToProfile('Twice', [rule('Default', embed('Loop.nav', 2, A)), rule('Back', embed('Loop.nav', 2, A))]);
    expect(r.value.routes.map((x) => x.name)).toEqual(['Loop.nav']);
    expect(loads(r.value)).toEqual(['Loop.nav', 'Loop.nav']);
  });

  it('different contents under one name keep "(2)" (never merged)', () => {
    const r = metToProfile('Two', [rule('Default', embed('Loop.nav', 2, A)), rule('Back', embed('Loop.nav', 2, B))]);
    expect(r.value.routes.map((x) => x.name)).toEqual(['Loop.nav', 'Loop.nav (2)']);
    expect(loads(r.value)).toEqual(['Loop.nav', 'Loop.nav (2)']);
    // The same points walked another way (linear vs circular) are a different route too.
    const m = metToProfile('Mode', [rule('Default', embed('Loop.nav', 2, A)), rule('Back', embed('Loop.nav', 1, A)), rule('Again', embed('Loop.nav', 1, A))]);
    expect(m.value.routes.map((x) => x.name)).toEqual(['Loop.nav', 'Loop.nav (2)']);
    expect(loads(m.value)).toEqual(['Loop.nav', 'Loop.nav (2)', 'Loop.nav (2)']);
    expect(m.value.routes[0].mode).not.toBe(m.value.routes[1].mode);
  });

  it('sameRoute ignores key order and compares every field', () => {
    const a = { name: 'x', mode: 'circular' as const, points: ['1N, 1E'], z: [0] };
    expect(sameRoute(a, { z: [0], points: ['1N, 1E'], mode: 'circular', name: 'x' })).toBe(true);
    expect(sameRoute(a, { ...a, z: [1] })).toBe(false);
    expect(sameRoute(a, { ...a, note: 'n' })).toBe(false);
  });
});

describe('.nav import: the same file again is the route already there', () => {
  const nav = navText(2, A);
  it('an identical re-import adds no copy; a different same-named file still gets "(2)"', () => {
    const once = importVTank([{ name: 'Loop.nav', text: nav }], null, 'P');
    const again = importVTank([{ name: 'Loop.nav', text: nav }], once.value, 'P');
    expect(again.value.routes.map((x) => x.name)).toEqual(['Loop']);
    const other = importVTank([{ name: 'Loop.nav', text: navText(2, B) }], again.value, 'P');
    expect(other.value.routes.map((x) => x.name)).toEqual(['Loop', 'Loop (2)']);
    // Re-importing the second one finds it under "(2)": still no third copy.
    const twice = importVTank([{ name: 'Loop.nav', text: navText(2, B) }], other.value, 'P');
    expect(twice.value.routes.map((x) => x.name)).toEqual(['Loop', 'Loop (2)']);
  });
});

const MET = resolve(__dirname, '..', 'reference', 'vtank-corpus', 'asherons-call-metas', 'legendary_quests', 'FearFactory', 'FearFactoryFellowV2.met');
describe.skipIf(!existsSync(MET))('FearFactoryFellowV2.met (reference/vtank-corpus)', () => {
  let p: RoutineProfile;
  beforeAll(() => { p = metToProfile('FearFactoryFellowV2', parseMet(readFileSync(MET, 'latin1')), 'FearFactoryFellowV2.met').value; });
  it('one RynthidToGeilla.nav route, and both of its load actions point at it', () => {
    expect(p.routes.filter((r) => r.name.startsWith('RynthidToGeilla.nav')).map((r) => r.name)).toEqual(['RynthidToGeilla.nav']);
    expect(p.routes.find((r) => r.name === 'RynthidToGeilla.nav')!.points).toHaveLength(3);
    expect(loads(p).filter((n) => n.startsWith('RynthidToGeilla'))).toEqual(['RynthidToGeilla.nav', 'RynthidToGeilla.nav']);
    expect(p.routes.some((r) => / \(\d+\)$/.test(r.name))).toBe(false);
  });
});
