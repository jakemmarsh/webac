/**
 * PERF.agent-tick-cost (2026-10-21) — the automation tick cost real players 56 ms (Windows, RTX 4070 SUPER) and
 * 86 ms (Intel Mac) a call, every frame at ~7 fps, after long macro runs. The routine's looks (and the VirindiTank
 * window's stand-by read of your name) were full observations, and each one's "buffs not up" asked, for every buff
 * family, whether your gear's spells covered it: the inventory read again and the whole spell table walked by name
 * for each remembered gear cast (kept per character in browser storage, so a routine user's dozen banes came back
 * every page). These run the real AgentApi / RoutineEngine over the fake host with a routine user's state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance as perfHooks } from 'node:perf_hooks';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { FakeHost } from './_harness/agentFake.ts';

/** The real clock (fake timers stand in for performance.now). */
const realNow = perfHooks.now.bind(perfHooks);

type Row = { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number };
/** A spell table that counts the rows any walk over it visits. */
class CountingTable extends Map<number, Row> {
  visited = 0;
  override values(): MapIterator<Row> {
    const it = super.values();
    const self = this;
    return (function* () { for (const v of it) { self.visited++; yield v; } })() as MapIterator<Row>;
  }
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const BUFF = 0x4; // SpellFlags.Beneficial
/** ~6,000 rows like the end-of-retail table: 200 creature-buff families of 7 levels, filler, and the item spells last. */
function bigTable(): { table: CountingTable; known: AgentSpell[]; itemSpells: string[] } {
  const table = new CountingTable();
  const known: AgentSpell[] = [];
  let id = 1;
  for (let f = 0; f < 200; f++) {
    for (let l = 0; l < 7; l++, id++) {
      const name = `Focus Family ${f} Self ${ROMAN[l]}`;
      table.set(id, { name, desc: '', category: 1000 + f, school: 4, bitfield: BUFF, power: 50 * (l + 1), duration: 1800 });
      known.push({ id, name, school: 'Creature', level: l + 1, category: 1000 + f, power: 50 * (l + 1), duration: 1800, buff: true });
    }
  }
  for (; id < 5900; id++) table.set(id, { name: `Filler Spell ${id}`, desc: '', category: 1, school: 1, bitfield: 0, power: 1 });
  const itemSpells: string[] = [];
  for (let k = 0; k < 12; k++, id++) {
    const name = `Gear Bane ${k} VI`;
    table.set(id, { name, desc: '', category: 3000 + k, school: 3, bitfield: BUFF, power: 300, duration: 3600 });
    itemSpells.push(name);
  }
  return { table, known, itemSpells };
}

const macroProfile = (): RoutineProfile => ({
  name: 'Default', modules: { ...ALL_MODULES_OFF, vitals: true, combat: true, looting: true, navigation: true, buffs: true, inventory: true },
  initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [],
  macro: true, ruleFiring: 'once', settings: {}, vtank: emptyVtankData(),
});

describe('a routine user\'s tick stays cheap (PERF.agent-tick-cost)', () => {
  let host: FakeHost;
  let store: Map<string, string>;
  let table: CountingTable;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    host = new FakeHost();
    const big = bigTable();
    table = big.table;
    const known = big.known;
    host.spells = () => known;
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: table });
    host.skills.set(31, { base: 300, buffed: 350 }); // Creature Enchantment
    host.inv = Array.from({ length: 250 }, (_, i) => ({ guid: 0x70000000 + i, name: `Item ${i}`, where: i < 20 ? 'equipped' : 'main pack', value: 100 + i })) as never;
    // The last page's macro cast its banes on every worn piece a minute ago (AgentApi gearCasts, per character).
    const worn = host.inv.filter((i) => i.where === 'equipped').map((i) => i.name.toLowerCase());
    store.set(`acAgent.gearCasts.${host.me.name}`, JSON.stringify(big.itemSpells.map((n) => [n.toLowerCase(), Date.now() - 60_000, worn])));
    for (let i = 0; i < 18; i++) host.add({ guid: 0x80000000 + i, name: `Npc ${i}`, itemType: 0x10, x: 30 + i, y: 60 });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const ticks = async (api: AgentApi, n: number): Promise<number[]> => {
    const per: number[] = [];
    for (let i = 0; i < n; i++) {
      host.t += 100; vi.advanceTimersByTime(100);
      const t0 = realNow(); api.tick(); per.push(realNow() - t0);
      if (i % 10 === 0) await vi.advanceTimersByTimeAsync(0);
    }
    return per;
  };
  const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;

  it('a player\'s look walks the spell table once for its gear casts (an index), not per buff family and cast', () => {
    const api = new AgentApi(host);
    api.snapshot();
    const first = table.visited;
    // The index is built once: at most one pass over the table.
    expect(first).toBeLessThanOrEqual(table.size);
    for (let i = 0; i < 20; i++) api.snapshot();
    // Before: every look walked ~5,900 rows for each of 12 gear casts per uncovered family (~200): millions per look.
    expect(table.visited - first).toBe(0);
  });

  it('a running macro, and the stand-by between runs, stay well under a millisecond-scale budget per tick and do not grow', async () => {
    const api = new AgentApi(host);
    const p = macroProfile();
    let standbyAsks = 0;
    // main.ts: the VirindiTank window's stand-by profile, read with the character's name.
    api.routine.standby = () => { standbyAsks++; return api.characterName() ? p : null; };
    const idle = await ticks(api, 100);
    // The stand-by is asked once per step (500 ms), not every tick.
    expect(standbyAsks).toBeGreaterThanOrEqual(19);
    expect(standbyAsks).toBeLessThanOrEqual(21);
    api.routine.start(p);
    const run = await ticks(api, 600);
    // Measured on an M3 Max: ~118 ms idle and ~105 ms running per tick before; ~0.05 and ~0.5 ms after.
    expect(mean(idle.slice(10))).toBeLessThan(5);
    expect(mean(run.slice(20))).toBeLessThan(10);
    // No growth over the run.
    expect(mean(run.slice(-200))).toBeLessThan(Math.max(2, mean(run.slice(20, 220)) * 3));
  });

  it('a routine\'s looks leave out the player\'s sections; the player\'s own look still has them', async () => {
    const api = new AgentApi(host);
    let windowReads = 0;
    const openWindows = host.openWindows;
    host.openWindows = () => { windowReads++; return openWindows(); };
    api.routine.start(macroProfile());
    await ticks(api, 50);
    expect(windowReads).toBe(0);
    const lean = api.look({ radius: 60 });
    expect(lean.nearby.length).toBeGreaterThan(0);
    expect(lean.me?.name).toBe(host.me.name);
    expect(lean.remembered).toEqual([]);
    expect(lean.buffsMissing).toBeUndefined();
    const full = api.snapshot();
    expect(windowReads).toBe(1);
    expect(full.buffsMissing?.length).toBeGreaterThan(0);
    expect(full.gearSpells?.length).toBe(12);
    // look() and snapshot() agree on what they both say.
    expect(full.me).toEqual(lean.me);
    expect(full.nearby).toEqual(lean.nearby);
    expect(api.self()).toEqual(full.me);
    expect(api.characterName()).toBe(full.me?.name);
    expect(api.currentScreen()).toBe(full.screen);
  });

  it('while a routine looks lean, worn items\' mana is still re-read by quiet appraisals', async () => {
    const api = new AgentApi(host);
    api.routine.start(macroProfile());
    await ticks(api, 30);
    const worn = host.inv.filter((i) => i.where === 'equipped').map((i) => i.guid);
    expect(new Set(host.appraiseCalls.filter((c) => c.quiet && worn.includes(c.guid)).map((c) => c.guid)).size).toBe(worn.length);
  });
});

describe('gear spells still cover buffs by category and power (missingBuffs through the index)', () => {
  let host: FakeHost;
  let store: Map<string, string>;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    host = new FakeHost();
    const table = new Map<number, Row>([
      [1, { name: 'Acid Bane V', desc: '', category: 500, school: 3, bitfield: BUFF, power: 250, duration: 3600 }],
      [2, { name: 'Acid Bane VI', desc: '', category: 500, school: 3, bitfield: BUFF, power: 300, duration: 3600 }],
      [3, { name: 'Strength Self VI', desc: '', category: 1, school: 4, bitfield: BUFF, power: 300, duration: 1800 }],
    ]);
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: table });
    host.spells = () => [
      { id: 2, name: 'Acid Bane VI', school: 'Item', level: 6, category: 500, power: 300, duration: 3600, buff: true },
      { id: 3, name: 'Strength Self VI', school: 'Creature', level: 6, category: 1, power: 300, duration: 1800, buff: true },
    ];
    host.inv = [{ guid: 0x70000001, name: 'Leather Coat', where: 'equipped' }, { guid: 0x70000002, name: 'Old Boots', where: 'main pack' }] as never;
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const castOn = (spell: string, agoS: number, items: string[]): void => {
    store.set(`acAgent.gearCasts.${host.me.name}`, JSON.stringify([[spell.toLowerCase(), Date.now() - agoS * 1000, items]]));
  };

  it('a cast with time left on worn gear covers its family; a weaker one does not; one on a piece in the pack does not', () => {
    castOn('Acid Bane VI', 60, ['leather coat']);
    expect(new AgentApi(host).snapshot().buffsMissing).toEqual(['Strength Self VI']);
    castOn('Acid Bane V', 60, ['leather coat']);
    expect(new AgentApi(host).snapshot().buffsMissing).toEqual(['Acid Bane VI', 'Strength Self VI']);
    castOn('Acid Bane VI', 60, ['old boots']);
    expect(new AgentApi(host).snapshot().buffsMissing).toEqual(['Acid Bane VI', 'Strength Self VI']);
  });

  it('a cast whose duration has run out covers nothing, and the gear-spells line still names it from the table', () => {
    castOn('Acid Bane VI', 3700, ['leather coat']);
    const obs = new AgentApi(host).snapshot();
    expect(obs.buffsMissing).toContain('Acid Bane VI');
    expect(obs.gearSpells).toEqual([{ spell: 'Acid Bane VI', items: 1, castAgoS: 3700, leftS: 0 }]);
  });

  it('the macro\'s gearSpellLeftOn reads the same cast', () => {
    castOn('Acid Bane VI', 600, ['leather coat']);
    const api = new AgentApi(host);
    expect(api.gearSpellLeftOn(['Leather Coat'], 500, 300)).toBeCloseTo(3000, -1);
    expect(api.gearSpellLeftOn(['Leather Coat'], 500, 301)).toBeNull();
  });
});
