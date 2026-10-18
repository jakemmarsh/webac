/**
 * AGENT.stream-reports-2026-10-18-0819: the AI stream pair's 07:18–08:20Z segment in Aerbax Haven (0x029E / 0x029F),
 * 2026-10-18, build 2994488e (reports stream/reports/{mage-2026-10-18T08-19-57-181Z, soldier-2026-10-18T08-19-50-665Z}-seg1.md;
 * transcripts stream/sessions/{mage,soldier}-2026-10-18-seg1.jsonl; page and chat logs mage.log / soldier.log / *.chat.log):
 * 1. "Arcanist fights" recast all seven Banes V on ten pieces at 07:19Z and 08:21Z, 5 and 6 minutes after the last round
 *    (every line "refreshing … Bane V"). Each was right after the segment's page reload (entering world 07:18:11,
 *    08:20:11): the gear-cast reckoning (AgentApi.gearCasts) and the macro's own item timers lived in the page only, so
 *    the first buff look after a reload judged every bane missing. The in-page rounds (07:47, 08:15) were 2 min before
 *    the end, as the rule says. Observe also listed "Lightning Bane V" as a buff not up while it was on all ten pieces.
 * 2. "Routine leaves an attacker untargeted after a kill": the target-died note said "X is on you, but you are not
 *    attacking it: ac_attack …" at the instant of the kill, before the routine's pick 1–1.5 s later (07:44:07, 07:59:04,
 *    08:09:29, 08:11:23Z it went for the very monster named), and Bulwark's hand attacks took over 20 times. Where it
 *    picked another: a Dark Marionette on Arcanist (ProtectFellows, by design; 08:17:48Z), or the same-named twin
 *    of the monster named (two Marionettes at 2 m, 08:22:15Z). Its next pick also had no rule for what hits you: the
 *    client's Auto Target selection (TargetLock) or the nearer monster won.
 * 3. Three Marionettes behind the west wall of 0x029F0144 read COMING AT YOU and stopped Bulwark's walks as a pack
 *    (08:12:19, 08:14:35, 08:17:29Z): 914c301d dropped a chaser's hold once he moved 4 m, so a fight's footwork never let
 *    its 20 s add up again.
 * 4. A buff just cast on Bulwark (Lightning Protection Other III, 15 min left) was folded into "+6 more", a count alone.
 *
 * Drives the real AgentApi / RoutineEngine / VtMacro / combatPlan on the fake host with the stream's real profiles and
 * the real end-of-retail spell table (DAT-gated for item 1).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VT_DEFAULT_MONSTER, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatBuffs, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { buildCombatFamilies, pickTarget, type CombatInput, type CombatMonster } from '../packages/renderer/src/agent/macro/combatPlan.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { READ_PAGE_STORAGE_JS, pickAgentStorage } from '../tools/ac-agent/pageStorage.ts';
import { ItemBuffLedger } from '../packages/renderer/src/agent/macro/itemBuffLedger.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const step = async (api: AgentApi, host: FakeHost, ms: number, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
};
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
  return out;
}
/** A Web Storage stand-in shared by two pages of one browser profile (the stream's page reload keeps its storage). */
const storage = (): Map<string, string> => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  return store;
};
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
const ME = 0x50000001;

// Arcanist's ten pieces at 07:14Z (the "You cast … on <item>" lines), ItemType Armor / Clothing as the page reports them.
const ARMOR = ['Leather Bracers', 'Leather Gauntlets', 'Leather Boots', 'Pathwarden Helm', 'Trousers', 'Platemail Pauldrons', 'Platemail Leggings', 'Baggy Shirt', 'Platemail Girth', 'Platemail Breastplate'];
const BANES = ['Acid Bane V', 'Bludgeon Bane V', 'Frost Bane V', 'Lightning Bane V', 'Flame Bane V', 'Piercing Bane V', 'Blade Bane V'];
const ARCANIST_SKILLS = [
  { id: 33, name: 'Life Magic', training: 'trained', base: 217, buffed: 255 },
  { id: 34, name: 'War Magic', training: 'specialized', base: 268, buffed: 316 },
  { id: 31, name: 'Creature Enchantment', training: 'trained', base: 217, buffed: 255 },
  { id: 32, name: 'Item Enchantment', training: 'trained', base: 217, buffed: 255 },
] as const;

describe.skipIf(!existsSync(DAT_PATHS.portal))('1. the Banes: a page reload keeps the gear-cast reckoning (needs DAT files)', () => {
  let table: Table;
  let host: FakeHost;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  /** One page of the stream: the host as it is (the same character and gear), a fresh AgentApi as a reload makes. */
  const page = (): AgentApi => {
    const api = new AgentApi(host);
    host.cast = (spell: number, t: number | null) => {
      host.sent.push(`cast ${spell} ${t === null ? 'self' : t.toString(16)}`);
      const s = table.spells.get(spell)!;
      setTimeout(() => { for (const piece of ARMOR) api.pushChat(`You cast ${s.name} on ${piece}, refreshing ${s.name}`, 0x07); }, 1500);
      return true;
    };
    return api;
  };
  /** The round of banes the routine cast on all ten pieces (07:14:36–07:15:09Z), as the page saw it land. */
  const round = (api: AgentApi): void => { for (const b of BANES) for (const piece of ARMOR) api.pushChat(`You cast ${b} on ${piece}, refreshing ${b}`, 0x07); };
  const baneCasts = (): string[] => host.sent.filter((x) => BANES.some((b) => x === `cast ${id(b)} self`));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T07:15:10.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    host.me.level = 51;
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [...ARCANIST_SKILLS];
    for (const s of ARCANIST_SKILLS) host.skills.set(s.id, { base: s.base, buffed: s.buffed });
    host.me.combatMode = 'magic';
    host.me.health = { current: 183, max: 183 };
    host.me.mana = { current: 400, max: 400 };
    host.inv = [
      { guid: 0x8000b535, name: 'Wand', where: 'equipped', slot: 'Held', mask: 0x01000000, validLocations: 0x01000000, itemType: 0x8000 },
      ...ARMOR.map((name, i): AgentItem => ({ guid: 0x8000c000 + i, name, where: 'equipped', itemType: i % 3 === 1 ? 0x4 : 0x2 })),
    ] as AgentItem[];
    const ids = BANES.map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 5, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('the spell table says 30 minutes for each Bane V (the estimate\'s duration was right)', () => {
    for (const b of BANES) expect(table.spells.get(id(b))!.duration, b).toBe(1800);
  });

  it('07:18Z reload, 5 min after the round: the new page still knows the banes (about 25 min left), so its routine casts none', async () => {
    storage();
    const first = page();
    round(first);
    run(first, host, 5 * 60_000, { physics: false });
    // The segment's reload: a new page, the same browser storage.
    const api = page();
    const g = api.observe().gearSpells ?? [];
    expect(g.map((x) => x.spell).sort()).toEqual([...BANES].sort());
    for (const x of g) { expect(x.items).toBe(10); expect(x.leftS).toBeGreaterThan(24 * 60); expect(x.leftS).toBeLessThanOrEqual(25 * 60); }
    // Nor are they "buffs you know that aren't up" (Lightning Bane V was, all hour).
    expect(api.observe().buffsMissing ?? []).not.toContain('Lightning Bane V');
    api.routine.start(ready('mage'));
    await step(api, host, 15_000);
    expect(baneCasts(), api.routine.history().join('\n')).toEqual([]);
    api.routine.stop();
  });

  it('the cause, with no browser storage: the reload forgets, and the routine recasts all seven, its log saying it judged them not on', async () => {
    vi.stubGlobal('localStorage', undefined);
    const first = page();
    round(first);
    run(first, host, 5 * 60_000, { physics: false });
    const api = page();
    expect(api.observe().gearSpells ?? []).toEqual([]);
    api.routine.start(ready('mage'));
    await step(api, host, 60_000);
    expect(new Set(baneCasts()).size, api.routine.history().join('\n')).toBe(7);
    expect(api.routine.history().join('\n')).toMatch(/buff: bane [A-Z] \[judged: not on your armor; no cast of it there seen landing\]: casting [A-Za-z]+ Bane V/);
    api.routine.stop();
  });

  it('28.5 min after the round (the rule\'s 2 min): it recasts, and the log says the time it judged was left', async () => {
    storage();
    const first = page();
    round(first);
    run(first, host, 28.5 * 60_000, { physics: false });
    const api = page();
    api.routine.start(ready('mage'));
    await step(api, host, 15_000);
    expect(baneCasts().length, api.routine.history().join('\n')).toBeGreaterThan(0);
    expect(api.routine.history().join('\n')).toMatch(/buff: bane A \[judged: 1m29s left on your armor, reckoned from the casts seen\]: casting Acid Bane V/);
    api.routine.stop();
  });

  it('an expiry line seen on one page is remembered by the next: that bane is due again', () => {
    storage();
    const first = page();
    round(first);
    run(first, host, 60_000, { physics: false });
    for (const piece of ARMOR) first.pushChat(`The spell Acid Bane V on ${piece} has expired.`, 0x07);
    run(first, host, 1000, { physics: false });
    const api = page();
    expect((api.observe().gearSpells ?? []).map((x) => x.spell)).not.toContain('Acid Bane V');
    expect(api.gearSpellLeftOn(ARMOR, table.spells.get(id('Acid Bane V'))!.category, table.spells.get(id('Acid Bane V'))!.power)).toBeNull();
    expect(api.gearSpellLeftOn(ARMOR, table.spells.get(id('Blade Bane V'))!.category, table.spells.get(id('Blade Bane V'))!.power)).toBeGreaterThan(28 * 60);
  });
});

describe('1b. the daemon carries the macro\'s item timers across a launch (the root cause: only acAgent.* keys were carried)', () => {
  it('a ledger written on one launch reads back on the next through the saved page storage', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    let wall = Date.parse('2026-10-18T07:15:09Z');
    const ledger = new ItemBuffLedger(() => wall, () => store);
    const me = { guid: 0x50000a11, name: 'Claude Arcanist' };
    ledger.bind(me);
    const coat = { guid: 0x8000c000, name: 'Leather Bracers' };
    ledger.note([coat], { id: 2093, category: 159, power: 200, duration: 1800 });
    mem.set('acAgent.places.Claude Arcanist', '[]');
    mem.set('someGameSetting', '1');
    // What the daemon saves at shutdown (pageStorage.pickAgentStorage over the page's localStorage), and its page read.
    const saved = pickAgentStorage(mem);
    expect(saved.map(([k]) => k).sort()).toEqual(['acAgent.places.Claude Arcanist', 'acjs.vtank.itemTimers.v1.claude arcanist.50000a11']);
    const page = new Function('localStorage', 'location', `return ${READ_PAGE_STORAGE_JS}`)({ length: mem.size, key: (i: number) => [...mem.keys()][i], getItem: (k: string) => mem.get(k) ?? null }, { origin: 'http://localhost:3133' }) as { items: Array<[string, string]> };
    expect(page.items.map(([k]) => k)).toContain('acjs.vtank.itemTimers.v1.claude arcanist.50000a11');
    // The next launch: a fresh storage holding only what was carried; 5 min later the bane has 25 min left.
    const next = new Map(saved);
    wall += 5 * 60_000;
    const again = new ItemBuffLedger(() => wall, () => ({ getItem: (k: string) => next.get(k) ?? null, setItem: (k: string, v: string) => void next.set(k, v) }));
    again.bind(me);
    expect(again.remainingOn(coat, 159, 200)).toBe(25 * 60);
  });
});

describe('2. the next target after a kill', () => {
  // The fight at 08:17:47Z in 0x029F012C: Pristine Doll #80008e20 (Bulwark's pull) dies; Pristine Doll #800086d1 and
  // Dark Marionette #80007340 are left beside him and Arcanist.
  const DEAD = 0x80008e20, PRISTINE = 0x800086d1, DARK = 0x80007340;
  const input = (monsters: CombatMonster[], over: Partial<CombatInput> = {}): CombatInput => ({
    monsters, rows: [{ ...structuredClone(VT_DEFAULT_MONSTER), on: ['A'] }], spells: [], skills: [], items: [], itemNames: [], wielded: {},
    stance: 'melee', settings: { AttackDistance: 12, TargetLock: true, TargetSelectMethod: 1 }, castLog: [], now: 0, selectedGuid: null,
    families: buildCombatFamilies({ spells: new Map() }), lastTarget: DEAD, ...over,
  });
  const pristine = (extra: Partial<CombatMonster> = {}): CombatMonster => ({ guid: PRISTINE, name: 'Pristine Doll', dist: 2.9, relBearing: 40, ...extra });
  const dark = (extra: Partial<CombatMonster> = {}): CombatMonster => ({ guid: DARK, name: 'Dark Marionette', dist: 2.1, relBearing: 10, ...extra });

  describe('combatPlan.pickTarget', () => {
    it('the one hitting you goes before the client\'s Auto Target selection (TargetLock) and before a nearer one', () => {
      expect(pickTarget(input([pristine({ hittingYou: true }), dark()], { selectedGuid: DARK }))?.guid).toBe(PRISTINE);
      expect(pickTarget(input([pristine({ hittingYou: true }), dark()]))?.guid).toBe(PRISTINE);
      // Before: the selection (or the nearer one) won, hitting or not.
      expect(pickTarget(input([pristine(), dark()], { selectedGuid: DARK }))?.guid).toBe(DARK);
    });
    it('ProtectFellows still comes first: one on a fellow before one hitting you (08:17:48Z, the Dark Marionette on Arcanist)', () => {
      expect(pickTarget(input([pristine({ hittingYou: true }), dark({ onFellow: true })], { selectedGuid: DARK }))?.guid).toBe(DARK);
      expect(pickTarget(input([pristine({ hittingYou: true }), dark({ onFellow: true })]))?.guid).toBe(DARK);
    });
    it('the player\'s own pick (selected by hand) wins over both', () => {
      expect(pickTarget(input([pristine({ hittingYou: true }), dark({ onFellow: true })], { selectedGuid: PRISTINE, pickedByHand: PRISTINE }))?.guid).toBe(PRISTINE);
      expect(pickTarget(input([pristine({ hittingYou: true, onFellow: true }), dark()], { selectedGuid: DARK, pickedByHand: DARK }))?.guid).toBe(DARK);
    });
    it('mid-fight nothing changes: the selection it is on stays first while another hits you', () => {
      expect(pickTarget(input([pristine({ hittingYou: true }), dark()], { selectedGuid: DARK, lastTarget: DARK }))?.guid).toBe(DARK);
    });
  });

  describe('the routine ("Bulwark fights") and the kill\'s note', () => {
    let host: FakeHost;
    let api: AgentApi;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      host = new FakeHost();
      host.me.name = 'Claude Bulwark';
      host.me.level = 48;
      host.me.combatMode = 'melee';
      host.me.health = { current: 192, max: 192 };
      host.attackPending = () => false;
      (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 300, buffed: 300 }];
      host.inv = [{ guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 }] as never;
      // A sword arm knows no spells; the macro only wants the table loaded (an empty one here).
      const empty = { spells: new Map() };
      (host as unknown as { spellTableData: () => unknown }).spellTableData = () => empty;
      api = new AgentApi(host);
    });
    afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it('a Dark Marionette nearer, a Pristine Doll hitting him: after the kill the routine goes for the Pristine, and the note says the routine picks', async () => {
      host.add({ guid: DEAD, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, seeks: { guid: ME, kind: 'stick' } });
      api.routine.start(ready('soldier'));
      await step(api, host, 1500);
      expect(host.sent.find((s) => s.startsWith('attack ')) ?? '', `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toMatch(new RegExp(`^attack ${DEAD.toString(16)}`));
      // Mid-fight a Dark Marionette comes up beside him (nearer, aimed at him, no blow yet) and a Pristine Doll hits him.
      host.add({ guid: DARK, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.5, seeks: { guid: ME, kind: 'stick' } });
      host.add({ guid: PRISTINE, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 82.5, y: 20, seeks: { guid: ME, kind: 'stick' } });
      await step(api, host, 500);
      const since = api.observe().seq;
      api.pushChat('Pristine Doll hits your chest for 9 points of bludgeoning damage!', 0x15);
      host.dying.add(DEAD);
      await step(api, host, 2000);
      const after = host.sent.filter((s) => s.startsWith('attack ')).slice(-1)[0];
      expect(after, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toMatch(new RegExp(`^attack ${PRISTINE.toString(16)}`));
      const died = (await api.waitFor({ types: ['target-died'], sinceSeq: since }, 0))[0];
      expect(died.text).toMatch(new RegExp(`died; Pristine Doll #${PRISTINE.toString(16)} is on you \\(1× in 10 s\\); since the kill your routine "Bulwark fights" attacked it$`));
      // As pushed, before the pick: the routine's word, not "but you are not attacking it".
      const raw = api.eventsSince(since).find((e) => e.type === 'target-died')!.text;
      expect(raw).toMatch(/; your routine "Bulwark fights" picks the next target itself \(one on a fellow first, then one hitting you\): ac_wait, or ac_attack target=#800086d1 to choose it yourself$/);
    });

    it('with no routine running, the note is as before', async () => {
      host.add({ guid: DEAD, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20 });
      host.add({ guid: PRISTINE, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 82.5, y: 20, seeks: { guid: ME, kind: 'stick' } });
      const since = api.observe().seq;
      expect(api.attack(DEAD).ok).toBe(true);
      run(api, host, 1000, { physics: false });
      api.pushChat('Pristine Doll hits your chest for 9 points of bludgeoning damage!', 0x15);
      host.dying.add(DEAD);
      run(api, host, 300, { physics: false });
      const evs = await api.waitFor({ types: ['target-died'], sinceSeq: since }, 0);
      expect(evs[0].text).toMatch(/Pristine Doll #800086d1 is on you \(1× in 10 s\), but you are not attacking it: ac_attack target=#800086d1 to fight it$/);
    });
  });
});

describe('3. a chaser stuck behind a wall stays held while it gets no closer, as you walk', () => {
  // 0x029F0144's west wall: Dark Marionettes #80007dbf / #80007dc2 and Marionette #80007cd8, 16–24 m W, "the long way
  // round, 56 m by the doorways" (08:06:06Z).
  const M = 0x80007dbf;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = 0x029f0144; host.cellSealed = () => true; host.me.level = 48;
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const stuck = (g = M): boolean | undefined => api.observe().nearby.find((o) => o.guid === g)?.comingAtYouStuck;
  const add = (g: number, x: number, y = 20, name = 'Dark Marionette'): void => void host.add({ guid: g, name, itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x, y, z: 94, seeks: { guid: ME, kind: 'move' } });

  it('held; you fight about the room, 5 m and 9 m this way and that: still AIMED AT YOU BUT NOT REACHING YOU, no new aggro', () => {
    add(M, 96);
    run(api, host, 25_000, { physics: false });
    expect(stuck()).toBe(true);
    const seq0 = api.observe().seq;
    for (const x of [85, 76, 84, 80]) { host.me.x = x; run(api, host, 3000, { physics: false }); expect(stuck(), `at x=${x}`).toBe(true); }
    expect(api.eventsSince(seq0).filter((e) => e.type === 'aggro')).toEqual([]);
  });

  it('it slides along its wall as you walk by (its own place nearer your spot, its distance no less): still held', () => {
    add(M, 96, 20);
    run(api, host, 25_000, { physics: false });
    const seq0 = api.observe().seq;
    for (let i = 1; i <= 6; i++) { host.me.y = 20 + i * 2; host.objs.get(M)!.y = 20 + i * 2; run(api, host, 1000, { physics: false }); }
    expect(stuck()).toBe(true);
    expect(api.eventsSince(seq0).filter((e) => e.type === 'aggro')).toEqual([]);
  });

  it('it frees itself and comes 3 m nearer than when held: an aggro event at once, and the flag goes', () => {
    add(M, 96);
    run(api, host, 25_000, { physics: false });
    const seq0 = api.observe().seq;
    host.objs.get(M)!.x = 92;
    run(api, host, 500, { physics: false });
    expect(stuck()).toBeFalsy();
    expect(api.eventsSince(seq0).some((e) => e.type === 'aggro' && /Dark Marionette #80007dbf .* is coming at you/.test(e.text))).toBe(true);
  });

  it('nearer by both measures but the doorway route to it is still the long way round (56 m for 12 m): still held', () => {
    add(M, 96);
    run(api, host, 25_000, { physics: false });
    vi.spyOn(api, 'floorRoute').mockReturnValue({ len: 56, drops: 0, dropM: 0, leaps: 0 });
    const seq0 = api.observe().seq;
    host.objs.get(M)!.x = 92;
    run(api, host, 500, { physics: false });
    expect(stuck()).toBe(true);
    expect(api.eventsSince(seq0).filter((e) => e.type === 'aggro')).toEqual([]);
  });

  it('three held behind the wall, his routine running: a walk past them is not stopped for a pack (08:17:29Z: "3 coming at once")', async () => {
    const gs = [0x80007dbf, 0x80007dc2, 0x80007cd8];
    add(gs[0], 96, 20); add(gs[1], 98, 22); add(gs[2], 99, 18, 'Marionette');
    for (const g of gs) host.objs.get(g)!.level = 60; // weigh them whatever their level: the hold alone must keep the walk going
    const fight: RoutineProfile = { ...ready('soldier') };
    api.routine.start(fight);
    run(api, host, 25_000, { physics: false });
    for (const g of gs) expect(stuck(g)).toBe(true);
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, cell: host.me.cell, x: 80, y: 40, z: 94 });
    const walk = (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {});
    const r = await settle(api, host, walk, 40_000);
    expect(r?.message, r?.message).toMatch(/^arrived/);
  });
});

describe('4. observe\'s buffs: the one just cast on you first, and "+N more" by name', () => {
  // Bulwark's 22 buffs at 08:17:22Z, Lightning Protection Other III among them.
  const names = ['Armor Other V', 'Invulnerability Other V', 'Strength Other IV', 'Endurance Other III', 'Quickness Other V', 'Blade Protection Other V', 'Bludgeoning Protection Other V', 'Piercing Protection Other V', 'Heavy Weapon Mastery Other V', 'Regeneration Other V', 'Fire Protection Other V', 'Shield Mastery Other IV', 'Aura of Blood Drinker Other V', 'Aura of Swift Killer Other V', 'Aura of Defender Other V', 'Acid Protection Other III', 'Cold Protection Other III', 'Rejuvenation Other V', 'Healing Mastery Other V', 'Coordination Other IV', 'Focus Other IV'];

  it('formatBuffs: one landed 8 s ago with 15 min left is listed first and said so; the folded ones are named', () => {
    const buffs = [...names.map((name, i) => ({ name, remaining: 300 + i * 20 })), { name: 'Lightning Protection Other III', remaining: 900, landedAgoS: 8 }];
    const line = formatBuffs(buffs);
    expect(line).toMatch(/^buffs \(22\): Lightning Protection Other III 15m \(just landed, 8s ago\), Armor Other V 5m, /);
    expect(line).toMatch(/, \+6 more: Acid Protection Other III, Cold Protection Other III, Rejuvenation Other V, Healing Mastery Other V, Coordination Other IV, Focus Other IV$/);
    // One that landed long ago sorts by its time left again.
    expect(formatBuffs([{ name: 'A', remaining: 900, landedAgoS: 600 }, { name: 'B', remaining: 100 }])).toBe('buffs (2): B 1m40s, A 15m');
  });

  it('the page: what was on you at the first look has no landing; a new one, and a refreshed one, are said as just landed', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.buffs = names.map((name, i) => ({ name, remaining: 600 + i * 10, beneficial: true }));
    run(api, host, 2000, { physics: false });
    expect(formatObservation(api.observe())).not.toMatch(/just landed/);
    host.buffs.push({ name: 'Lightning Protection Other III', remaining: 900, beneficial: true });
    run(api, host, 3000, { physics: false });
    const text = formatObservation(api.observe());
    expect(text).toMatch(/^buffs \(22\): Lightning Protection Other III 1[45]m\d*s? \(just landed, 3s ago\), /m);
    expect(text).toMatch(/\+6 more: /);
    // Armor Other V recast (its time left back up): just landed too, newest first.
    host.buffs[0] = { name: 'Armor Other V', remaining: 1800, beneficial: true };
    run(api, host, 1000, { physics: false });
    expect(formatObservation(api.observe())).toMatch(/^buffs \(22\): Armor Other V (29m\d*s?|30m) \(just landed, \d+s ago\), Lightning Protection Other III /m);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
