/**
 * Stream reports, 2026-10-18 18:28–19:28Z: Claude Arcanist (mage) and Claude Bulwark (soldier) in Aerbax Laboratory
 * 0x029E and Aerbax Haven 0x029F on the local end-of-retail ACE server. Transcripts {mage,soldier}-2026-10-18-seg1.jsonl.
 *
 * 1. "Rebuffs on entry come before defending myself": "Arcanist fights" came out of the Lab portal (18:40:05Z) into two
 *    Innocuous Dolls, one 1.4 m off hitting him, and its first steps were Invulnerability Self VI and Acid / Bludgeon /
 *    Frost Bane V (one new Chainmail Breastplate lacked them) until he bolted by hand at 18:40:17Z. VTank's own order
 *    (MOSS MacroRuleTable) is BuffSelfNormal above Attack, so this was VTank's behaviour; FightBeforeBuffs (beyond VTank,
 *    60 s) now holds a rebuff while a monster you can fight in range is on you or coming at you.
 * 2. "Routine log is missing timings": the 19:21:09–28Z round of eleven self buffs all landed (Life Magic Mastery Self III
 *    showed 23m47s left at 19:27:21Z); nine were under the 2 s "took" bar. Every step of 0.5 s or more now says.
 * 3. Bulwark's walk-stop loop: every Haven stop said "its kind's Drain Mana Other III took 22 of your 205 health". ACE
 *    names the vital ("You lose 22 points of mana due to …", WorldObject_Magic), and the seen-kinds note kept a mana
 *    drain as health taken. Only health counts now, and a mana / stamina drain stored by an older session is read by the
 *    era's spell table ("Drains 20% of the target's Mana …"). The same number had stopped Arcanist's repeat Flame Bolt.
 * 4. Stale fellow-aggro batches: a walk's 27 s handed Bulwark one Marionette three times plus two stuck ones (19:18:48Z).
 *    A wait now hands over only the newest alert per creature, and none for one aimed elsewhere by now.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { openDat } from './_harness/dat.ts';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
const ME = 0x50000001;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe.skipIf(!existsSync(PORTAL))('1 and 2. the routine fights what is on you before rebuffing, and every cast step says its time', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  let host: FakeHost;
  let api: AgentApi;
  /** Server replies due later (host time): a cast's "You cast …" comes `castMs` after it goes out, as a real cast's does. */
  let due: Array<{ at: number; fn: () => void }>;
  let castMs: number;
  const DOLL = 0x8000c8d4;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, combatMode: 'magic' };
    const known = ['Strength Self I', 'Flame Bolt I'].map(id);
    host.spells = () => known.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) }; });
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 33, name: 'Life Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 31, name: 'Creature Enchantment', training: 'trained', base: 100, buffed: 100 },
    ];
    due = [];
    castMs = 0;
    const send = host.cast;
    host.cast = (sid, t) => {
      const r = send(sid, t);
      const s = table.spells.get(sid)!;
      const reply = (): void => {
        if (t === null) {
          api.pushChat(`You cast ${s.name} on yourself`, 7);
          host.buffs = [...host.buffs.filter((b) => (b as { spellId?: number }).spellId !== sid), { spellId: sid, name: s.name, remaining: s.duration! } as never];
        } else api.pushChat(`You cast ${s.name} on ${host.objs.get(t)?.name ?? '?'}`, 7);
      };
      if (castMs > 0) due.push({ at: host.t + castMs, fn: reply });
      else reply();
      return r;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const step = async (ms: number, each?: () => void): Promise<void> => {
    for (let t = 0; t < ms; t += 100) {
      for (const d of due.filter((x) => x.at <= host.t)) { due.splice(due.indexOf(d), 1); d.fn(); }
      each?.();
      run(api, host, 100);
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  const vt = (settings: Record<string, string | number | boolean> = {}): RoutineProfile => ({
    name: 'Arcanist fights', modules: { ...ALL_MODULES_OFF, buffs: true, vitals: true, combat: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once',
    settings: { EnableBuffing: true, AttackDistance: 30, ...settings }, vtank: emptyVtankData(),
  });
  /** An Innocuous Doll 1.4 m off, on you, hitting you every second (18:40:05Z). */
  const dollOnYou = (): (() => void) => {
    host.add({ guid: DOLL, name: 'Innocuous Doll', itemType: 0x10, objectDescFlags: 0x10, level: 50, x: 81, y: 21, seeks: { guid: ME, kind: 'stick' } });
    let n = 0;
    return () => { if (host.objs.has(DOLL) && ++n % 10 === 0) api.pushChat('Innocuous Doll scratches your hand for 1 point of slashing damage!', 0x15); };
  };
  const casts = (): string[] => host.sent.filter((x) => x.startsWith('cast '));

  it('a doll hitting you: the bolt goes out before the due buff, the log says the buff waits, and the buff goes once it is dead', async () => {
    const hits = dollOnYou();
    api.pushChat('Innocuous Doll scratches your hand for 1 point of slashing damage!', 0x15);
    api.routine.start(vt());
    await step(3000, hits);
    const log = api.routine.history().join('\n');
    expect(casts()[0], `${casts().join('\n')}\n${log}`).toBe(`cast ${id('Flame Bolt I')} ${DOLL.toString(16)}`);
    expect(casts()).not.toContain(`cast ${id('Strength Self I')} self`);
    expect(log).toMatch(/buff: waiting for the fight: the fight first \(FightBeforeBuffs\): Innocuous Doll on you; Strength Self I \(attribute Strength \[judged: not on you\]\) waits until it is over, or 60 s of it/);
    // Said once, not every step.
    expect(log.match(/buff: waiting for the fight/g)).toHaveLength(1);
    host.dying.add(DOLL);
    await step(600);
    host.objs.delete(DOLL);
    await step(3000);
    expect(casts()).toContain(`cast ${id('Strength Self I')} self`);
  });

  it('FightBeforeBuffs 0 is VTank\'s order: the buff first, the doll on you or not', async () => {
    const hits = dollOnYou();
    api.pushChat('Innocuous Doll scratches your hand for 1 point of slashing damage!', 0x15);
    api.routine.start(vt({ FightBeforeBuffs: 0 }));
    await step(3000, hits);
    expect(casts()[0]).toBe(`cast ${id('Strength Self I')} self`);
  });

  it('a long fight: past FightBeforeBuffs seconds of it the buff goes in (it never runs the buffs out)', async () => {
    const hits = dollOnYou();
    // The doll never dies: every bolt is answered, no kill.
    api.pushChat('Innocuous Doll scratches your hand for 1 point of slashing damage!', 0x15);
    api.routine.start(vt({ FightBeforeBuffs: 5 }));
    await step(3000, hits);
    expect(casts()).not.toContain(`cast ${id('Strength Self I')} self`);
    await step(5000, hits);
    expect(casts()).toContain(`cast ${id('Strength Self I')} self`);
  });

  it('a monster in range that is neither on you nor coming at you holds nothing (VTank\'s order, unchanged)', async () => {
    host.add({ guid: DOLL, name: 'Innocuous Doll', itemType: 0x10, objectDescFlags: 0x10, level: 50, x: 80, y: 35 });
    api.routine.start(vt());
    await step(3000);
    expect(casts()[0]).toBe(`cast ${id('Strength Self I')} self`);
  });

  it('2. a 1.5 s self buff\'s log line says "(took 1.5 s)"; the 2 s bar left it without one', async () => {
    castMs = 1500;
    api.routine.start(vt());
    await step(4000);
    const log = api.routine.history().join('\n');
    expect(log, log).toMatch(/buff: .*casting Strength Self I on yourself.*\(took 1\.\d s\)/);
  });
});

describe('3. a mana or stamina drain is no health taken: a doll that drains mana is a mild chaser your routine takes', () => {
  let host: FakeHost;
  let api: AgentApi;
  const fight = (): RoutineProfile => ({
    name: 'Bulwark fights', modules: { ...ALL_MODULES_OFF, combat: true },
    initialState: 'Hunt', loot: [], buffSets: [], routes: [],
    states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }] }] }],
  });
  // The era's spell table, as far as these lines need it (the end-of-retail descriptions, read from the DAT).
  const table = {
    spells: new Map([
      [1262, { name: 'Drain Mana Other III', desc: "Drains 20% of the target's Mana and gives it to the caster.", category: 91, school: 2, bitfield: 0x13, power: 150 }],
      [1197, { name: 'Enfeeble Other III', desc: "Drains 16-31 points of the target's Stamina.", category: 82, school: 2, bitfield: 0x13, power: 150 }],
      [1239, { name: 'Drain Health Other III', desc: "Drains 25% of the target's Health and gives 133% of it to the caster.", category: 87, school: 2, bitfield: 0x13, power: 150 }],
    ]),
  };
  const DOLL = 0x8000dd24;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.level = 50; host.me.health = { current: 205, max: 205 };
    (host as unknown as { spellTableData: () => typeof table }).spellTableData = () => table;
    api = new AgentApi(host);
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 });
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const walkTo = (): Promise<AgentResult> => (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}) as Promise<AgentResult>;
  const doll = (): (() => void) => {
    host.add({ guid: DOLL, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 95, y: 20, level: 50, seeks: { guid: ME, kind: 'move' } });
    return () => { const o = host.objs.get(DOLL)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } };
  };
  /** What the Haven's dolls were seen doing (their kind's hits up to 8, then a mana drain of 22). */
  const seenDolls = (vital: 'mana' | 'health'): void => {
    host.add({ guid: 0x8000aaaa, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, level: 50 });
    api.pushChat('Innocent Doll scratches your hand for 8 points of slashing damage!', 0x15);
    api.pushChat(`You lose 22 points of ${vital} due to Innocent Doll casting ${vital === 'mana' ? 'Drain Mana Other III' : 'Drain Health Other III'} on you`);
    host.objs.delete(0x8000aaaa);
  };

  it('a mana drain (ACE: "You lose 22 points of mana due to …"): the walk goes on past the doll, and observe shows no number for it', async () => {
    seenDolls('mana');
    expect(api.seenText('Innocent Doll')).toBe('casts Drain Mana Other III; hits up to 8');
    api.routine.start(fight());
    const p = walkTo();
    const r = await settle(api, host, p, 40_000, doll());
    expect(r?.message, r?.message).toMatch(/^arrived/);
    expect(r?.message).not.toMatch(/took 22 of your 205 health/);
  });

  it('a health drain of 22 (over a tenth of 205) still stops it, naming the spell', async () => {
    seenDolls('health');
    api.routine.start(fight());
    const p = walkTo();
    const r = await settle(api, host, p, 15_000, doll());
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Innocent Doll #8000dd24 \(level 50\) is coming at you/);
    expect(r?.message).toMatch(/this one: its kind's Drain Health Other III took 22 of your 205 health\./);
  });

  it('a mana drain stored as health by an older session (the stream pages keep seen kinds per character) is read by the spell table', async () => {
    const store = new Map<string, string>([['acAgent.seenKinds.Claude Test', JSON.stringify([['innocent doll', { spells: [['Drain Mana Other III', 22], ['Enfeeble Other III', 30]], maxHit: 8, words: false }]])]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    api = new AgentApi(host);
    expect(api.seenText('Innocent Doll')).toBe('casts Drain Mana Other III, Enfeeble Other III; hits up to 8');
    api.routine.start(fight());
    const p = walkTo();
    const r = await settle(api, host, p, 40_000, doll());
    expect(r?.message, r?.message).toMatch(/^arrived/);
  });

  it('AC1999\'s line names the spell first ("due to Drain Mana Other III casting Innocent Doll on you"): read the right way round', () => {
    host.add({ guid: 0x8000aaaa, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, level: 50 });
    api.pushChat('You lose 25 points of health due to Drain Health Other III casting Innocent Doll on you');
    expect(api.seenText('Innocent Doll')).toBe('casts Drain Health Other III (25)');
    expect(api.seenText('Drain Health Other III')).toBeNull();
  });

  it('the line itself mends the stored number: a mana drain seen again sets it to 0', () => {
    const store = new Map<string, string>([['acAgent.seenKinds.Claude Test', JSON.stringify([['innocent doll', { spells: [['Drain Mana Other III', 22]], maxHit: 8, words: false }]])]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    (host as unknown as { spellTableData: () => null }).spellTableData = () => null;
    api = new AgentApi(host);
    expect(api.seenText('Innocent Doll')).toBe('casts Drain Mana Other III (22); hits up to 8');
    host.add({ guid: 0x8000aaaa, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, level: 50 });
    api.pushChat('You lose 19 points of mana due to Innocent Doll casting Drain Mana Other III on you');
    expect(api.seenText('Innocent Doll')).toBe('casts Drain Mana Other III; hits up to 8');
    expect(store.get('acAgent.seenKinds.Claude Test')).toContain('["Drain Mana Other III",0]');
  });
});

describe('4. a wait hands over only alerts that still hold: the newest per creature, none for one aimed elsewhere now', () => {
  let host: FakeHost;
  let api: AgentApi;
  const ARC = 0x500000a3;
  const STUCK = 0x8000ca48, HOME = 0x8000d9a6, DEAD = 0x8000c7db, MINE = 0x8000d77a;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 75, y: 15 });
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 184, max: 184 }, stamina: { cur: 250, max: 250 }, mana: { cur: 330, max: 330 } }];
    // Marionettes behind a wall from Arcanist: one stays facing her, one went home; a third dies.
    host.add({ guid: STUCK, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, level: 26, x: 75, y: 3, seeks: { guid: ARC, kind: 'move' } });
    host.add({ guid: HOME, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, level: 26, x: 70, y: 2, seeks: { guid: ARC, kind: 'move' } });
    host.add({ guid: DEAD, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, level: 35, x: 72, y: 4, seeks: { guid: ARC, kind: 'move' } });
    host.add({ guid: MINE, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 86, y: 25, seeks: { guid: ME, kind: 'move' } });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  /** A wait read at once (its empty answer after a 50 ms timeout, on the fake clock). */
  const read = async (f: Parameters<AgentApi['wait']>[0]) => { const p = api.wait(f, 50); await vi.advanceTimersByTimeAsync(60); return p; };

  it('the 19:18:48Z batch: one alert for the stuck Marionette (its newest), none for the one gone home or the dead one', async () => {
    api.push('fellow-aggro', 'Marionette #8000ca48 (level 26) is coming at your fellow Claude Arcanist, 9 m from them and 15 m S of you (running at them); Claude Arcanist is 14 m S of you, 100% health', STUCK, undefined, ARC);
    api.push('fellow-aggro', 'Marionette #8000d9a6 (level 26) is coming at your fellow Claude Arcanist, 18 m from them and 19 m S of you (running at them); Claude Arcanist is 7 m SW of you, 99% health', HOME, undefined, ARC);
    api.push('fellow-aggro', 'Dark Marionette #8000c7db (level 35) is coming at your fellow Claude Arcanist, 17 m from them and 19 m S of you (running at them); Claude Arcanist is 7 m SW of you, 99% health', DEAD, undefined, ARC);
    api.push('fellow-aggro', 'Marionette #8000ca48 (level 26) is coming at your fellow Claude Arcanist, 18 m from them and 20 m S of you (running at them); Claude Arcanist is 7 m SW of you, 99% health', STUCK, undefined, ARC);
    api.push('fellow-aggro', 'Marionette #8000ca48 (level 26) keeps facing your fellow Claude Arcanist, 18 m from them and 21 m S of you (running at them), but it hasn\'t come closer to them in 20 s: stuck, or it can\'t path round to them. No more fellow-aggro for it until it closes in on them.', STUCK, undefined, ARC);
    api.push('aggro', 'Pristine Doll #8000d77a (level not known yet) is coming at you, 8 m NE (running at you)', MINE);
    run(api, host, 1000, { physics: false });
    // Meanwhile the walk ran on: the second Marionette turned for home, the Dark Marionette died.
    host.objs.get(HOME)!.seeks = { guid: 0, kind: 'position' };
    host.dying.add(DEAD);
    run(api, host, 4000, { physics: false });
    const evs = await read({ types: ['fellow-aggro', 'aggro'] });
    const about = (g: number) => evs.filter((e) => (e.type === 'fellow-aggro' || e.type === 'aggro') && e.guid === g);
    // One, the newest said of it (the page's own sampling adds its own alert as it watches; whichever came last).
    expect(about(STUCK), evs.map((e) => e.text).join('\n')).toHaveLength(1);
    expect(about(STUCK)[0].seq).toBe(Math.max(...api.eventsSince(0).filter((e) => e.type === 'fellow-aggro' && e.guid === STUCK).map((e) => e.seq)));
    expect(about(HOME)).toHaveLength(0);
    expect(about(DEAD)).toHaveLength(0);
    // Still coming at you: kept, with where it is now.
    expect(about(MINE)).toHaveLength(1);
    expect(about(MINE)[0].text).toMatch(/is coming at you, 8 m NE \(running at you\) \[\d+ s ago; now /);
  });

  it('an aggro whose monster went for someone else by the time it is read is left out; one read at once is kept', async () => {
    api.push('aggro', 'Pristine Doll #8000d77a (level not known yet) is coming at you, 8 m NE (running at you)', MINE);
    expect((await read({ types: ['aggro'] })).filter((e) => e.guid === MINE)).toHaveLength(1);
    api.push('aggro', 'Pristine Doll #8000d77a (level not known yet) is coming at you, 8 m NE (running at you)', MINE);
    run(api, host, 1000, { physics: false });
    host.objs.get(MINE)!.seeks = { guid: ARC, kind: 'move' };
    run(api, host, 4000, { physics: false });
    const late = await read({ types: ['aggro'], sinceSeq: 1 });
    expect(late.filter((e) => e.type === 'aggro' && e.guid === MINE), late.map((e) => e.text).join('\n')).toHaveLength(0);
  });
});
