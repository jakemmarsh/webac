/**
 * Character creation lists only the heritages whose DAT label isn't blank
 * (ui/HeritageRows.ts; Jake, 2026-10-06: hide the classic eras' ten blank
 * rows). The ClassicACE Infiltration and CustomDM language DATs blank every
 * heritage label but Aluvian, Gharu'ndim and Sho; end of retail names all
 * thirteen. Random never lands on an unlisted heritage, and end of retail's
 * roll sequence is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERITAGE_ROWS, visibleHeritageRows, heritageListed } from '../packages/renderer/src/ui/HeritageRows';
import { randomizeHeritageGroup, scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize';
import { parseStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { ERA_PROFILES, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const CLASSIC_KEEPS = new Set([HERITAGE_ROWS[0].labelId, HERITAGE_ROWS[1].labelId, HERITAGE_ROWS[2].labelId]);
/** A language DAT the way the ClassicACE sets ship it: the other ten labels are "". */
const classicStrings = (id: number): string | null => (CLASSIC_KEEPS.has(id) ? `name-${id}` : HERITAGE_ROWS.some((r) => r.labelId === id) ? '' : null);

describe('heritage rows', () => {
  it('end of retail lists all thirteen in DAT order; a blank label hides its row; a missing one shows the fallback', () => {
    expect(visibleHeritageRows((id) => `n${id}`).map((r) => r.key)).toEqual(HERITAGE_ROWS.map((r) => r.key));
    const classic = visibleHeritageRows(classicStrings);
    expect(classic.map((r) => r.key)).toEqual([1, 2, 3]);
    expect(classic[1].label).toBe(`name-${HERITAGE_ROWS[1].labelId}`);
    expect(visibleHeritageRows(() => null).map((r) => r.label)).toEqual(HERITAGE_ROWS.map((r) => r.fallback));
    expect(heritageListed(4, classicStrings)).toBe(false);
    expect(heritageListed(1, classicStrings)).toBe(true);
    expect(heritageListed(99, classicStrings)).toBe(true); // no row: nothing to hide
  });

  it('Random redraws a roll that lands on an unlisted heritage; end of retail is unchanged', () => {
    const listed = (h: number) => heritageListed(h, classicStrings);
    // 0.999 → RollDice(1, 4) = 4 (Viamontian): unlisted on a classic era, redrawn among 1..3.
    for (const rand of [0, 16383, 32767]) {
      const h = randomizeHeritageGroup(scriptedRandomSource([rand], [0.999]), true, listed);
      expect([1, 2, 3]).toContain(h);
    }
    expect(randomizeHeritageGroup(scriptedRandomSource([0], [0.999]), true, () => true)).toBe(4);
    expect(randomizeHeritageGroup(scriptedRandomSource([0], [0.999]), true)).toBe(4);
    const src = scriptedRandomSource([0], [0.5]);
    expect(randomizeHeritageGroup(src, true, listed)).toBe(3); // a listed roll: no redraw
    expect(src.randCalls).toBe(0);
  });
});

const INF = resolve(__dirname, '..', 'dat-sets/classicace-infiltration-1.9/client_local_English.dat');
const hasDats = existsSync(INF) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('against the real language DATs', () => {
  const stringsOf = (path: string): ((id: number) => string | null) => {
    const db = openDat(path);
    const map = new Map<number, string>();
    for (const fid of db.listFileIds(0x23)) {
      for (const e of parseStringTable(db.getReader(fid)).entries) map.set(e.id, e.strings.join(''));
    }
    return (id) => map.get(id) ?? null;
  };
  let infiltration: (id: number) => string | null;
  let eor: (id: number) => string | null;
  beforeAll(() => { infiltration = stringsOf(INF); eor = stringsOf(DAT_PATHS.local); });

  it('Infiltration lists Aluvian, Gharu\'ndim and Sho; end of retail lists all thirteen', () => {
    expect(visibleHeritageRows(infiltration).map((r) => r.label)).toEqual(['Aluvian', "Gharu'ndim", 'Sho']);
    expect(visibleHeritageRows(eor)).toHaveLength(13);
  });

  it('Classic Dereth names all thirteen (it keeps end of retail\'s language DAT), but its era allows three', () => {
    const allowed = new Set(ERA_PROFILES['classic-dereth'].heritages);
    const defined = (h: number) => allowed.has(h);
    expect(visibleHeritageRows(eor, defined).map((r) => r.label)).toEqual(['Aluvian', "Gharu'ndim", 'Sho']);
  });
});

describe('a world/era that lacks heritages (the defined predicate)', () => {
  it('hides undefined heritages from the list and from Random, whatever the labels say', () => {
    const names = (id: number) => `n${id}`; // every label present (end of retail\'s language DAT)
    const defined = (h: number) => h <= 3;
    expect(visibleHeritageRows(names, defined).map((r) => r.key)).toEqual([1, 2, 3]);
    expect(heritageListed(4, names, defined)).toBe(false);
    expect(heritageListed(2, names, defined)).toBe(true);
    // ToD's roll reaches Viamontian (4): redrawn among the defined ones.
    const listed = (h: number) => heritageListed(h, names, defined);
    for (const rand of [0, 16383, 32767]) expect([1, 2, 3]).toContain(randomizeHeritageGroup(scriptedRandomSource([rand], [0.999]), true, listed));
  });

  it('every Dark Majesty-era profile allows Aluvian, Gharu\'ndim and Sho; end of retail sets no list', () => {
    for (const id of ['classic-dereth', 'classicace-customdm', 'classicace-infiltration']) expect(ERA_PROFILES[id].heritages).toEqual([1, 2, 3]);
    expect(ERA_PROFILES[EOR_ERA_ID].heritages).toBeUndefined();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('GameUI.chargenHeritageDefined = world CharGen ∩ era list', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('with neither every heritage counts; the CharGen alone, the era list alone, and both intersect', () => {
    const ui = new GameUICtor(domWindow.document.createElement('div'));
    expect([1, 4, 13].every((h) => ui.chargenHeritageDefined(h))).toBe(true);
    ui.charGen = { heritageGroups: new Map([[1, {}], [2, {}], [3, {}], [4, {}]]) };
    expect([1, 4].every((h) => ui.chargenHeritageDefined(h))).toBe(true);
    expect(ui.chargenHeritageDefined(5)).toBe(false);
    ui.eraHeritages = new Set([1, 2, 3]);
    expect([1, 2, 3].map((h) => ui.chargenHeritageDefined(h))).toEqual([true, true, true]);
    expect(ui.chargenHeritageDefined(4)).toBe(false); // in the CharGen, not in the era
    ui.charGen = null;
    expect(ui.chargenHeritageDefined(4)).toBe(false); // era list alone
    expect(ui.chargenHeritageDefined(2)).toBe(true);
  });
});
