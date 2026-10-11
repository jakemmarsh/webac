/**
 * AGENT.vtank-window — VirindiTank's macro from its tabs (agent/macro/
 * vtMacro.ts): the routine engine, the real agent API and the planners over
 * a fake host carrying the real end-of-retail spell table: it heals when
 * hurt (Vitals), debuffs and attacks what the Monsters tab says, and keeps
 * VTank's automatic buffs up when nothing is near.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { componentPurse, vtAttackHeight } from '../packages/renderer/src/agent/macro/vtMacro.ts';
import { autoAttackPower, swingElement, type PowerItem } from '../packages/renderer/src/agent/macro/attackPower.ts';
import { castConfirmed, castTargetsNamed, COMPONENTS_MISSING } from '../packages/renderer/src/agent/macro/castReply.ts';
import { ItemBuffLedger } from '../packages/renderer/src/agent/macro/itemBuffLedger.ts';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
// The short school names the game's agent host reports (main.ts schoolName), as live; the macro maps them to the skill names.
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

describe.skipIf(!existsSync(PORTAL))('VirindiTank\'s macro over the real spell table (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const known = ['Heal Self I', 'Strength Self I', 'Imperil Other I', 'Flame Bolt I'].map(id);
    host.spells = () => known.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) }; });
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 33, name: 'Life Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 31, name: 'Creature Enchantment', training: 'trained', base: 100, buffed: 100 },
    ];
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const vt = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
    name: 'VT', modules: { ...ALL_MODULES_OFF, buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once',
    settings: { EnableBuffing: false, AttackDistance: 30 }, vtank: emptyVtankData(), ...over,
  });

  /**
   * A fake server that answers every cast as ACE does: "You cast {spell} on yourself" (a self buff then shows
   * in the effects list), "You cast {spell} on {target}", or "{target} resists your spell" while `resist`
   * says so. An item buff cast on yourself is redirected to each worn piece (`worn`), one line per piece.
   */
  const serverAnswers = (opts: { resist?: (spellId: number) => boolean; worn?: string[]; itemSpells?: number[]; refuse?: (spellId: number) => string | null } = {}) => {
    const send = host.cast;
    host.cast = (sid, t) => {
      const r = send(sid, t);
      const s = table.spells.get(sid);
      if (!s) return r;
      const refused = opts.refuse?.(sid);
      if (refused) { api.pushChat(refused, 0x05); return r; }
      if (t === null && opts.itemSpells?.includes(sid)) { for (const w of opts.worn ?? []) api.pushChat(`You cast ${s.name} on ${w}`, 7); return r; }
      if (t === null) {
        api.pushChat(`You cast ${s.name} on yourself`, 7);
        if ((s.duration ?? 0) > 0) host.buffs = [...host.buffs.filter((b) => (b as { spellId?: number }).spellId !== sid), { spellId: sid, name: s.name, remaining: s.duration! } as never];
        return r;
      }
      const who = host.objs.get(t)?.name ?? (host.inv.find((i) => i.guid === t)?.name ?? '?');
      api.pushChat(opts.resist?.(sid) ? `${who} resists your spell` : `You cast ${s.name} on ${who}`, 7);
      return r;
    };
  };

  it('Vitals: hurt below Heal at, it casts the heal it knows on itself', async () => {
    host.me.health.current = Math.round(host.me.health.max * 0.3);
    api.routine.start(vt());
    await step(1500);
    expect(host.sent).toContain(`cast ${id('Heal Self I')} self`);
  });

  it('Monsters: the <DEFAULT> row with I on debuffs the monster with Imperil, then attacks with a bolt', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const data = emptyVtankData();
    data.monsters[0].on = ['I', 'A'];
    serverAnswers();
    api.routine.start(vt({ vtank: data }));
    await step(3000);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts[0]).toBe(`cast ${id('Imperil Other I')} 80005001`);
    expect(casts).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    // Landed: not cast again while it lasts.
    expect(casts.filter((x) => x === `cast ${id('Imperil Other I')} 80005001`)).toHaveLength(1);
  });

  it('a resisted debuff is cast again; only the server\'s "You cast …" line counts it on (VTank DebuffScheduler)', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const data = emptyVtankData();
    data.monsters[0].on = ['I', 'A'];
    let resists = 2;
    serverAnswers({ resist: (sid) => sid === id('Imperil Other I') && resists-- > 0 });
    api.routine.start(vt({ vtank: data }));
    await step(5000);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    const imperil = `cast ${id('Imperil Other I')} 80005001`;
    // Two resists, then it lands: three Imperils before the first bolt, and none after.
    expect(casts.slice(0, 3)).toEqual([imperil, imperil, imperil]);
    expect(casts.filter((x) => x === imperil)).toHaveLength(3);
    expect(casts.slice(3).length).toBeGreaterThan(0);
    expect(casts.slice(3).every((x) => x === `cast ${id('Flame Bolt I')} 80005001`)).toBe(true);
  });

  it('a debuff with no answer from the server is not counted as on: it is tried again', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const data = emptyVtankData();
    data.monsters[0].on = ['I', 'A'];
    api.routine.start(vt({ vtank: data }));
    await step(9000);
    expect(host.sent.filter((x) => x === `cast ${id('Imperil Other I')} 80005001`).length).toBeGreaterThanOrEqual(2);
  });

  it('a buff due by RebuffTimeRemainingSeconds is cast with a monster in range, before the attack; the idle top-off waits for no monster', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    serverAnswers();
    api.routine.start(vt({ settings: { EnableBuffing: true, AttackDistance: 30 } }));
    await step(3000);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts[0]).toBe(`cast ${id('Strength Self I')} self`);
    expect(casts).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    api.routine.stop();
    // 600 s left: above the rebuff line (300 s), below the idle top-off (1200 s). With the monster there it
    // fights; with it gone (idle, IdleBuffTopoff on) it tops the buff off.
    host.sent.length = 0;
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 600 }] as never;
    api.routine.start(vt({ settings: { EnableBuffing: true, AttackDistance: 30, IdleBuffTopoff: true } }));
    await step(2000);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toEqual([]);
    expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    host.objs.delete(0x80005001);
    await step(4000);
    expect(host.sent).toContain(`cast ${id('Strength Self I')} self`);
  });

  it('a buff that never takes rests after three tries, so it can\'t hold the fight up', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    serverAnswers({ refuse: (sid) => (sid === id('Strength Self I') ? 'Your spell fizzled.' : null) });
    api.routine.start(vt({ settings: { EnableBuffing: true, AttackDistance: 30 } }));
    await step(6000);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toHaveLength(3);
    expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
  });

  it('magic mode needs a wand on ACE: the macro wields a carried caster first; a server that keeps refusing gets spells left out, not asked forever', async () => {
    host.me.health.current = 10; // a heal is due
    host.me.combatMode = 'peace';
    host.inv = [{ guid: 0x50000097, name: 'Training Wand', where: 'main pack', type: 'Caster', itemType: 0x8000, fits: 'Held' }] as never;
    api.routine.start(vt({}));
    await step(1500);
    expect(host.sent).toContain('wield 50000097');
    api.routine.stop();
    // No caster at all, and the server turns magic mode back every time (ACE: no wand).
    host.inv = [] as never;
    host.sent.length = 0;
    host.setCombatMode = (m: string) => { host.sent.push(`mode ${m}`); };
    api.routine.start(vt({}));
    await step(6000);
    expect(host.sent.filter((x) => x === 'mode magic').length).toBeLessThanOrEqual(3);
    expect(api.routine.history().join('\n')).toMatch(/refusing magic mode/);
  });

  it('a monster a bolt can\'t reach ("no line of fire") is set aside and the bolt goes to the next one, not into the wall again', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    host.add({ guid: 0x80005002, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    const spells = host.spells;
    host.spells = () => spells().map((x) => (/Bolt/.test(x.name) ? { ...x, projectile: true } : x));
    (host as unknown as { lineOfFire: (g: number) => { dist: number; blockedAt: number | null } }).lineOfFire = (g) => (g === 0x80005001 ? { dist: 10, blockedAt: 1.4 } : { dist: 20, blockedAt: null });
    api.routine.start(vt({}));
    await step(3000);
    const bolts = host.sent.filter((x) => x.startsWith(`cast ${id('Flame Bolt I')}`));
    expect(bolts.length).toBeGreaterThan(0);
    expect(bolts.every((x) => x.endsWith('80005002'))).toBe(true);
    expect(api.routine.history().filter((h) => /no line of fire/.test(h)).length).toBeLessThanOrEqual(1);
  });

  it('UseBreakableTurnTo turns once per monster, then casts: a bearing that never settles within 2° (1 m away) no longer turns for ever', async () => {
    host.add({ guid: 0x80005001, name: 'Sparring Golem', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 20 });
    const spells = host.spells;
    host.spells = () => spells().map((x) => (/Bolt/.test(x.name) ? { ...x, projectile: true } : x));
    host.setYaw = () => {}; // the turn never lands within 2°
    api.routine.start(vt({}));
    await step(6000);
    expect(host.sent.some((x) => x.startsWith(`cast ${id('Flame Bolt I')} 80005001`))).toBe(true);
    expect(api.routine.history().filter((h) => /turning to face Sparring Golem/.test(h)).length).toBeLessThanOrEqual(2);
  });

  it('a wielded wand casts (its item type reaches the planner); before 2026-10-11 every weapon read as melee and the wand swung', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    host.inv = [{ guid: 0x50000093, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 }] as never;
    host.appraisalDatas.set(0x50000093, { int: { 45: 0x10 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraised.push(0x50000093);
    api.routine.start(vt({}));
    await step(3000);
    expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    expect(host.sent.some((x) => x.startsWith('attack '))).toBe(false);
  });

  it('a wielded bow loads the row\'s arrows (VTank\'s ammunition choice), examining them quietly first', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    host.inv = [
      { guid: 0x50000094, name: 'Yew Longbow', where: 'equipped', type: 'Missile Weapon', slot: 'MissileWeapon', itemType: 0x100 },
      { guid: 0x50000095, name: 'Acid Arrow', where: 'main pack', stack: 40, fits: 'MissileAmmo', itemType: 0x100 },
      { guid: 0x50000096, name: 'Fire Arrow', where: 'main pack', stack: 40, fits: 'MissileAmmo', itemType: 0x100 },
    ] as never;
    host.appraisalDatas.set(0x50000094, { int: { 50: 1 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraisalDatas.set(0x50000095, { int: { 50: 1, 44: 9, 45: 0x20 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraisalDatas.set(0x50000096, { int: { 50: 1, 44: 9, 45: 0x10 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    const data = emptyVtankData();
    data.monsters[0].damage = 6; // Fire
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: false, AttackDistance: 30 } }));
    await step(3000);
    expect(host.appraiseCalls.filter((c) => [0x50000094, 0x50000095, 0x50000096].includes(c.guid)).every((c) => c.quiet)).toBe(true);
    expect(host.sent).toContain('wield 50000096');
    expect(host.sent).not.toContain('wield 50000095');
  });

  it('Buffs: with nothing near and buffing on, it keeps VTank\'s automatic buffs up (Strength Self)', async () => {
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent).toContain(`cast ${id('Strength Self I')} self`);
    // Up already: nothing more to cast.
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    host.sent.length = 0;
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
  });

  it('a Monsters row with priority -1 is left alone, by the macro and by a rule\'s attack-nearest alike', async () => {
    host.add({ guid: 0x80005003, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    const data = emptyVtankData();
    data.monsters.push({ ...data.monsters[0], name: 'Pumpkin Buffer', priority: -1 });
    api.routine.start(vt({ vtank: data, states: [{ name: 'Default', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 30 }], do: [{ kind: 'attack-nearest', meters: 30 }] }] }] }));
    await step(2000);
    expect(host.sent.filter((x) => /^(attack|cast) /.test(x) && x.includes('80005003'))).toEqual([]);
  });

  it('a monster the macro fought and killed is its kill: the corpse is looted', async () => {
    host.add({ guid: 0x80005004, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    const data = emptyVtankData();
    serverAnswers();
    api.routine.start(vt({ vtank: data, settings: { AttackDistance: 30, EnableLooting: true } }));
    await step(2000);
    expect(host.sent.some((x) => x.startsWith('cast ') && x.endsWith('80005004'))).toBe(true);
    host.dying.add(0x80005004);
    await step(600);
    host.objs.delete(0x80005004);
    await step(8000);
    expect(api.routine.statsNow().kills).toBe(1);
    const log = api.routine.history().join('\n');
    // Buffs first (VTank buffs above Attack, 2026-10-11), then one loot try for the kill.
    expect(log, log).toMatch(/buff: [\s\S]*loot-nearby/);
    expect(log.match(/loot-nearby/g)).toHaveLength(1);
  });

  it('a dying monster is shown as dying and is no target: the macro takes the next one', async () => {
    host.add({ guid: 0x80005005, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: 0x80005006, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
    serverAnswers();
    host.dying.add(0x80005005);
    expect(api.snapshot({ radius: 30 }).nearby.find((o) => o.guid === 0x80005005)?.dying).toBe(true);
    expect(api.snapshot({ radius: 30 }).nearby.find((o) => o.guid === 0x80005006)?.dying).toBeUndefined();
    api.routine.start(vt({ settings: { AttackDistance: 30 } }));
    await step(2500);
    const hits = host.sent.filter((x) => /^(attack|cast) /.test(x));
    expect(hits.some((x) => x.includes('80005005'))).toBe(false);
    expect(hits.some((x) => x.includes('80005006'))).toBe(true);
  });

  it('Monster Priority Count Within Distance counts monsters whose row has exactly that priority', () => {
    host.add({ guid: 0x80005007, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    host.add({ guid: 0x80005008, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 27 });
    const data = emptyVtankData();
    data.monsters.push({ ...data.monsters[0], name: 'Drudge Slinker', priority: 3 });
    api.routine.start(vt({ vtank: data, states: [{ name: 'Default', rules: [
      { when: [{ kind: 'monster-priority-count', priority: 3, count: 1, meters: 20 }], do: [] },
      { when: [{ kind: 'monster-priority-count', priority: 1, count: 2, meters: 20 }], do: [] },
      { when: [{ kind: 'monster-priority-count', priority: 1, count: 1, meters: 20 }], do: [] },
    ] }] }));
    expect(api.routine.dryRun().map((r) => r.fires)).toEqual([true, false, true]);
  });

  /** The fake server: a cast of `spell` says "You cast …" and puts the enchantment on fresh (or, `fizzle`, fizzles). */
  const castLands = (spell: string, opts: { fizzle?: () => boolean } = {}) => {
    const k = id(spell);
    const send = host.cast;
    host.cast = (sid, t) => {
      const r = send(sid, t);
      if (sid === k) {
        if (opts.fizzle?.()) api.pushChat('Your spell fizzled.', 7);
        else { api.pushChat(`You cast ${spell} on yourself`, 7); host.buffs = [{ spellId: k, name: spell, remaining: 3600 }] as never; }
      }
      return r;
    };
  };

  it('Force Buff recasts every buff once, whatever time is left; Cancel stops the round', async () => {
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    castLands('Strength Self I');
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
    expect(api.routine.forceBuff().ok).toBe(true);
    expect(api.routine.status().forcingBuffs).toBe(true);
    await step(4000);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toHaveLength(1);
    await step(4000);
    expect(api.routine.status().forcingBuffs).toBe(false);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toHaveLength(1);
    api.routine.forceBuff();
    api.routine.cancelForceBuff();
    expect(api.routine.status().forcingBuffs).toBe(false);
  });

  it('Force Buff: a fizzled family is cast again; it counts done only once its enchantment is on', async () => {
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    let fizzles = 1;
    castLands('Strength Self I', { fizzle: () => fizzles-- > 0 });
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1000);
    api.routine.forceBuff();
    await step(12_000);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toHaveLength(2);
    expect(api.routine.history().join('\n')).toMatch(/Strength Self I didn't take \(Your spell fizzled\.\); casting it again/);
    expect(api.routine.status().forcingBuffs).toBe(false);
  });

  it('Force Buff: a family that never takes is given up after three casts', async () => {
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    castLands('Strength Self I', { fizzle: () => true });
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1000);
    api.routine.forceBuff();
    await step(30_000);
    expect(host.sent.filter((x) => x === `cast ${id('Strength Self I')} self`)).toHaveLength(3);
    expect(api.routine.history().join('\n')).toContain("Strength Self I didn't take after 3 casts; moving on");
    expect(api.routine.status().forcingBuffs).toBe(false);
  });

  it('Force Buff skips the auras of a weapon the Items tab lists Add (no buffs)', async () => {
    const bd = id('Aura of Blood Drinker Self I');
    const s = table.spells.get(bd)!;
    host.spells = () => [{ id: bd, name: s.name, school: 'Item', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), buff: true }];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 32, name: 'Item Enchantment', training: 'trained', base: 150, buffed: 150 }];
    host.inv = [{ guid: 0x50000091, name: 'Practice Sword', where: 'equipped', type: 'Melee Weapon', slot: 'MeleeWeapon' }] as never;
    host.buffs = [{ spellId: bd, name: s.name, remaining: 1800 }] as never;
    const data = emptyVtankData();
    data.items = [{ name: 'Practice Sword', noBuffs: true }];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true } }));
    await step(1000);
    api.routine.forceBuff();
    await step(4000);
    expect(host.sent.filter((x) => x.startsWith(`cast ${bd} `))).toEqual([]);
    expect(api.routine.status().forcingBuffs).toBe(false);
  });

  it('Cast Dispel Self / Use Dispel Items: a level-7 vuln on you is dispelled; a level-6 one is not', async () => {
    const eradicate = id('Eradicate Life Magic Self');
    const known = host.spells();
    const er = table.spells.get(eradicate)!;
    host.spells = () => [...known, { id: eradicate, name: er.name, school: 'Life Magic', level: 7, category: er.category, power: er.power, duration: 0, self: true }];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 33, name: 'Life Magic', training: 'trained', base: 400, buffed: 400 }];
    // The fire vuln family, levels by power: VI and VII.
    const fireVuln = [...table.spells].filter(([, s]) => s.category === table.spells.get(id('Fire Vulnerability Other I'))!.category && s.school === 2 && !(s.bitfield & 0x4)).sort((a, b) => a[1].power - b[1].power);
    const powers = [...new Set(fireVuln.map(([, s]) => s.power))];
    const at = (lvl: number) => fireVuln.find(([, s]) => s.power === powers[lvl - 1])!;
    host.buffs = [{ spellId: at(6)[0], name: at(6)[1].name, remaining: 60 }] as never;
    api.routine.start(vt({ settings: { CastDispelSelf: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith(`cast ${eradicate}`))).toEqual([]);
    host.buffs = [{ spellId: at(7)[0], name: at(7)[1].name, remaining: 60 }] as never;
    await step(1500);
    expect(host.sent).toContain(`cast ${eradicate} self`);
    // Use Dispel Items: a carried item whose spell (DID 28) is a dispel.
    api.routine.stop();
    host.sent.length = 0;
    host.inv = [{ guid: 0x50000071, name: 'Gem of Stillness', where: 'main pack', type: 'Gem' }] as never;
    host.appraised.push(0x50000071);
    host.appraisalDatas.set(0x50000071, { int: {}, float: {}, string: {}, bool: {}, did: { 28: eradicate }, spells: [] });
    api.routine.start(vt({ settings: { UseDispelItems: true } }));
    await step(1500);
    expect(host.sent).toContain('usewith 50000071 50000001');
  });

  it('Loot Only Rare Corpses: a kill is looted only after the server says you discovered a rare', async () => {
    host.add({ guid: 0x80005009, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    serverAnswers();
    api.routine.start(vt({ settings: { AttackDistance: 30, EnableLooting: true, LootOnlyRareCorpses: true } }));
    await step(2000);
    host.dying.add(0x80005009);
    await step(600);
    host.objs.delete(0x80005009);
    await step(4000);
    expect(api.routine.statsNow().kills).toBe(1);
    expect(api.routine.history().join('\n')).not.toMatch(/loot-nearby/);
    api.pushChat(`${api.snapshot({ max: 0 }).me!.name} has discovered the Pearl of Blood Drinking!`, 0);
    await step(9000);
    expect(api.routine.history().join('\n'), api.routine.history().join('\n')).toMatch(/loot-nearby/);
  });

  it('Excluded Scarab Types: a spell that needs an excluded scarab is not cast', async () => {
    (host as unknown as { spellComponents: (id: number) => string[] }).spellComponents = (sid) => (sid === id('Strength Self I') ? ['Lead Scarab', 'Prismatic Taper'] : ['Iron Scarab']);
    const data = emptyVtankData();
    data.excludedScarabs = ['lead scarab'];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith(`cast ${id('Strength Self I')}`))).toEqual([]);
  });

  it('weapon auras go on the wielded weapon, unless the Items tab lists it Add (no buffs)', async () => {
    // The melee damage aura (end of retail: an Aura on yourself).
    const bd = id('Aura of Blood Drinker Self I');
    const s = table.spells.get(bd)!;
    host.spells = () => [{ id: bd, name: s.name, school: 'Item Enchantment', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), buff: true }];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 32, name: 'Item Enchantment', training: 'trained', base: 150, buffed: 150 }];
    host.inv = [{ guid: 0x50000091, name: 'Practice Sword', where: 'equipped', type: 'Melee Weapon', slot: 'MeleeWeapon' }] as never;
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.some((x) => x.startsWith(`cast ${bd} `))).toBe(true);
    api.routine.stop();
    host.sent.length = 0;
    const data = emptyVtankData();
    data.items = [{ name: 'Practice Sword', noBuffs: true }];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true } }));
    await step(1500);
    expect(host.sent.filter((x) => x.startsWith(`cast ${bd} `))).toEqual([]);
  });

  it('Recharge boost: after switching to magic mode to recharge, a vital that regenerated past its level still gets the heal (first cast only)', async () => {
    const heal = `cast ${id('Heal Self I')} self`;
    const switchThenRegen = async () => {
      for (let i = 0; i < 30 && !host.sent.includes('mode magic'); i++) await step(100);
      expect(host.sent).toContain('mode magic');
      host.me.health.current = 45; // 90 %: above Heal at 75 % (37.5), within 40 points
      await step(3000);
    };
    host.me.health.current = 30;
    api.routine.start(vt());
    await switchThenRegen();
    // ClearLevelBoostFlagOnCast (on by default): the boost was for that one cast.
    expect(host.sent.filter((x) => x === heal)).toHaveLength(1);
    expect(api.routine.history().join('\n')).toMatch(/recharge boost/);

    // RechargeBoostAmount 0: no boost, so no heal once the vital is back over its level.
    api.routine.stop();
    host.sent.length = 0;
    host.me.combatMode = 'peace';
    host.me.health.current = 30;
    api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, RechargeBoostAmount: 0 } }));
    await switchThenRegen();
    expect(host.sent.filter((x) => x === heal)).toEqual([]);
  });

  it('Pea splitting: a listed component below SpellCompMin-Critical gets the Splitting Tool used on its pea, before healing', async () => {
    host.inv = [
      { guid: 0x50000a01, name: 'Splitting Tool', where: 'main pack', type: 'Misc' },
      { guid: 0x50000a02, name: 'Gold Pea', where: 'main pack', stack: 2, type: 'Spell Components' },
      { guid: 0x50000a03, name: 'Gold Scarab', where: 'main pack', stack: 3, type: 'Spell Components' },
    ] as never;
    host.me.health.current = 30;
    const data = emptyVtankData();
    data.consumables = ['Gold Scarab'];
    api.routine.start(vt({ vtank: data }));
    await step(1500);
    const acts = host.sent.filter((x) => /^(usewith|cast) /.test(x));
    expect(acts[0]).toBe('usewith 50000a01 50000a02');
    expect(acts).toContain(`cast ${id('Heal Self I')} self`);
    // The same pea is not split again while the server answers.
    expect(acts.filter((x) => x.startsWith('usewith'))).toHaveLength(1);

    // SplitPeas off: never.
    api.routine.stop();
    host.sent.length = 0;
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: false, AttackDistance: 30, SplitPeas: false } }));
    await step(8000);
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
  });

  it('Pea splitting below SpellCompMin-Normal waits until nothing else is to do (Add All Peas lists the pea itself)', async () => {
    host.inv = [
      { guid: 0x50000a01, name: 'Splitting Tool', where: 'main pack', type: 'Misc' },
      { guid: 0x50000a02, name: 'Gold Pea', where: 'main pack', type: 'Spell Components' },
      { guid: 0x50000a03, name: 'Gold Scarab', where: 'main pack', stack: 10, type: 'Spell Components' },
    ] as never;
    const data = emptyVtankData();
    data.consumables = ['Gold Pea'];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true, AttackDistance: 30 } }));
    await step(1500);
    // Buffing first (Strength Self): no split while a buff is due.
    expect(host.sent).toContain(`cast ${id('Strength Self I')} self`);
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
    // Buffs up: then the split, 10 < 20.
    host.buffs = [{ spellId: id('Strength Self I'), name: 'Strength Self I', remaining: 1800 }] as never;
    await step(1500);
    expect(host.sent).toContain('usewith 50000a01 50000a02');
  });

  it('Summon Pets: Custom Pet Range past Monster Range sees the far monster; PetDmg picks the essence by its UiEffects element', async () => {
    // A monster 40 m off: outside Monster Range (30), inside Custom Pet Range (50).
    host.add({ guid: 0x80005003, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 60 });
    host.inv = [
      { guid: 0x50000a01, name: 'Acid Grievver Essence (50)', where: 'main pack', uiEffects: 0x100 },
      { guid: 0x50000a02, name: 'Fire Grievver Essence (50)', where: 'main pack', uiEffects: 0x20 },
    ] as never;
    for (const g of [0x50000a01, 0x50000a02]) host.appraisalDatas.set(g, { int: { 266: 49052 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    // Summoning trained (VTank summons only then: MOSS SummonPetRule.IsSummoningTrained).
    const skills = (host as unknown as { skillList: () => unknown[] }).skillList();
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [...skills, { id: 54, name: 'Summoning', training: 'trained', base: 100, buffed: 100 }];
    const data = emptyVtankData();
    data.items = [{ name: 'Acid Grievver Essence (50)' }, { name: 'Fire Grievver Essence (50)' }];
    data.monsters[0].damage = 6; // Fire: PAuto summons the fire essence
    const settings = { EnableBuffing: false, AttackDistance: 30, SummonPets: true, PetRangeMode: 1, PetCustomRange: 50 };
    api.routine.start(vt({ vtank: data, settings }));
    await step(2000);
    expect(host.sent).toContain('use 50000a02');
    expect(host.sent).not.toContain('use 50000a01');
    expect(host.sent.some((x) => x.startsWith('cast ') || x.startsWith('attack '))).toBe(false); // nothing within Monster Range to fight
    api.routine.stop();
    host.sent.length = 0;
    // Monster Range as pet range (PetRangeMode 0): the far monster doesn't count.
    api.routine.start(vt({ vtank: data, settings: { ...settings, PetRangeMode: 0 } }));
    await step(2000);
    expect(host.sent.filter((x) => x.startsWith('use '))).toEqual([]);
  });

  it('AutoAttackPower: a Pierce row swings a slash + pierce sword at 0.2 (a thrust); a Slash row at a full bar', async () => {
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    host.me.combatMode = 'melee';
    host.inv = [{ guid: 0x50000301, name: 'Yaoji', where: 'equipped', type: 'Melee Weapon', slot: 'MeleeWeapon', itemType: 0x1 }] as never;
    host.appraisalDatas.set(0x50000301, { int: { 45: 0x3, 47: 0x3, 353: 2 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    const data = emptyVtankData();
    data.monsters[0].on = ['A'];
    data.monsters[0].damage = 0; // Pierce
    api.routine.start(vt({ vtank: data }));
    await step(3000);
    // The wielded sword is examined quietly for its damage and attack types, then swung as a thrust.
    expect(host.appraiseCalls.some((c) => c.guid === 0x50000301 && c.quiet)).toBe(true);
    expect(host.sent.filter((x) => x.startsWith('attack '))[0]).toBe('attack 80005001 0.2 medium');
    api.routine.stop();
    host.sent.length = 0;
    // Another monster (an attack order goes out once per target), a Slash row: a full bar.
    host.objs.delete(0x80005001);
    host.add({ guid: 0x80005002, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    host.pending = false;
    data.monsters[0].damage = 2; // Slash
    api.routine.start(vt({ vtank: data }));
    await step(3000);
    expect(host.sent.filter((x) => x.startsWith('attack '))[0]).toBe('attack 80005002 1 medium');
  });

  it('an armor bane is timed per worn piece from the server\'s reply, kept across a reload, and cast again when it runs out (VTank BuffedItems)', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    try {
      const bane = id('Acid Bane I');
      const s = table.spells.get(bane)!;
      const knowBane = (h: FakeHost) => {
        h.spells = () => [{ id: bane, name: s.name, school: 'Item', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), buff: true }];
        (h as unknown as { spellTableData: () => Table }).spellTableData = () => table;
        (h as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 32, name: 'Item Enchantment', training: 'trained', base: 150, buffed: 150 }];
        h.inv = [{ guid: 0x50000c01, name: 'Leather Coat', where: 'equipped', type: 'Armor', slot: 'Chest', itemType: 0x2 }, { guid: 0x50000c02, name: 'Leather Cap', where: 'equipped', type: 'Armor', slot: 'Head', itemType: 0x2 }] as never;
      };
      knowBane(host);
      serverAnswers({ worn: ['Leather Coat', 'Leather Cap'], itemSpells: [bane] });
      const settings = { EnableBuffing: true, AttackDistance: 30 };
      api.routine.start(vt({ settings }));
      await step(4000);
      // The client never sees the bane (it is on the armor, not on you): before 2026-10-11 it was cast forever.
      expect(host.sent.filter((x) => x === `cast ${bane} self`)).toHaveLength(1);
      api.routine.stop();

      // A reload: a new page (host, agent API, macro) for the same character reads the timers back.
      const h2 = new FakeHost();
      knowBane(h2);
      const api2 = new AgentApi(h2);
      api2.routine.start(vt({ settings }));
      for (let t = 0; t < 3000; t += 100) { run(api2, h2, 100); await vi.advanceTimersByTimeAsync(100); }
      expect(h2.sent.filter((x) => x === `cast ${bane} self`)).toEqual([]);
      // Within RebuffTimeRemainingSeconds of the end: due again.
      await vi.advanceTimersByTimeAsync(((s.duration ?? 0) - 250) * 1000);
      for (let t = 0; t < 3000; t += 100) { run(api2, h2, 100); await vi.advanceTimersByTimeAsync(100); }
      expect(h2.sent.filter((x) => x === `cast ${bane} self`).length).toBeGreaterThanOrEqual(1);
      api2.routine.stop();
    } finally { vi.unstubAllGlobals(); }
  });

  it('a components refusal teaches the macro the server charges them: it drops to the tier the pack can pay for (VTank BuffCastability)', async () => {
    const one = id('Strength Self I'), two = id('Strength Self II');
    const known = [one, two].map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: 'Creature', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, self: true, buff: true }; });
    host.spells = () => known;
    (host as unknown as { spellComponents: (id: number) => string[] }).spellComponents = (sid) => (sid === two ? ['Iron Scarab', 'Prismatic Taper', 'Prismatic Taper'] : ['Lead Scarab', 'Prismatic Taper']);
    host.inv = [{ guid: 0x50000d01, name: 'Lead Scarab', where: 'main pack', stack: 3 }, { guid: 0x50000d02, name: 'Prismatic Tapers', where: 'main pack', stack: 1 }] as never;
    // ACE: "You don't have all the components for this spell." for a tier the pack can't pay for.
    serverAnswers({ refuse: (sid) => (sid === two ? "You don't have all the components for this spell." : null) });
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(6000);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts).toEqual([`cast ${two} self`, `cast ${one} self`]);
  });

  it('"You don\'t have enough Mana": no cast is sent again until mana has come up (it had sent two a second)', async () => {
    const one = id('Strength Self I');
    const s1 = table.spells.get(one)!;
    host.spells = () => [{ id: one, name: s1.name, school: 'Creature', level: 1, category: s1.category, power: s1.power, duration: s1.duration ?? 0, self: true, buff: true }];
    let refuse = true;
    host.me.mana.current = 2;
    serverAnswers({ refuse: () => (refuse ? "You don't have enough Mana to cast this spell." : null) });
    api.routine.start(vt({ settings: { EnableBuffing: true } }));
    await step(10_000);
    const casts = () => host.sent.filter((x) => x === `cast ${one} self`).length;
    expect(casts()).toBe(1);
    // A mana tick or two is not the spell's cost: still nothing sent.
    host.me.mana.current = 4;
    await step(4000);
    expect(casts()).toBe(1);
    // Mana comes back: the buff goes out.
    refuse = false;
    host.me.mana.current = 30;
    await step(4000);
    expect(casts()).toBe(2);
  });

  describe('the blacklist and ghosts (BlacklistMonster*, DeleteGhostMonsters*)', () => {
    const two = () => {
      host.add({ guid: 0x80005001, name: 'Gate Guard', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
      host.add({ guid: 0x80005002, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    };
    const bolt = () => id('Flame Bolt I');
    const at = (g: number) => host.sent.filter((x) => x === `cast ${bolt()} ${g.toString(16)}`).length;

    it('a monster the server calls an invalid target (GDLE / AC1999 words, and ACE\'s) is blacklisted at once; the next is fought', async () => {
      for (const words of ['Gate Guard is an invalid target.', 'Flame Bolt I cannot be cast on Gate Guard.']) {
        host = new FakeHost();
        const send = host.cast;
        host.spells = () => [{ id: bolt(), name: 'Flame Bolt I', school: 'War', level: 1, category: table.spells.get(bolt())!.category, power: 1, duration: 0 }];
        (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
        (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 }];
        api.routine.stop();
        api = new AgentApi(host);
        host.cast = (sid, t) => { const r = send(sid, t); api.pushChat(t === 0x80005001 ? words : `You cast Flame Bolt I on ${host.objs.get(t ?? 0)?.name}`, 7); return r; };
        two();
        api.routine.start(vt({}));
        await step(3000);
        expect(at(0x80005001)).toBe(1);
        expect(at(0x80005002)).toBeGreaterThan(0);
        expect(api.routine.history().join('\n')).toMatch(/Gate Guard blacklisted for 120 s: the server says it is an invalid target/);
      }
    });

    it('casts the server never answers are misses: one past BlacklistMonsterAttemptCount blacklists it', async () => {
      two();
      // No serverAnswers: every cast goes unanswered.
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, BlacklistMonsterAttemptCount: 1 } }));
      await step(12_000);
      expect(at(0x80005001)).toBe(2);
      expect(at(0x80005002)).toBeGreaterThan(0);
      expect(api.routine.history().join('\n')).toMatch(/Gate Guard blacklisted for 120 s: 2 attempts in a row didn't reach it/);
    });

    it('a bolt the world stops ("Your missile attack hit the environment.", no "You cast" for a bolt on ACE) is a miss; a bolt that lands clears the count', async () => {
      two();
      const send = host.cast;
      let n = 0;
      let lands = true;
      // ACE answers a war bolt only with its damage line, or the wall it hit (ProjectileCollisionHelper). Every third lands.
      host.cast = (sid, t) => { const r = send(sid, t); const who = host.objs.get(t ?? 0)?.name; api.pushChat(lands && ++n % 3 === 0 ? `You scorch ${who} for 9 points with Flame Bolt I.` : 'Your missile attack hit the environment.', 0); return r; };
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, BlacklistMonsterAttemptCount: 2 } }));
      await step(6000);
      // Two misses, a hit (count cleared), two misses, a hit: never three in a row, never blacklisted.
      expect(at(0x80005001)).toBeGreaterThanOrEqual(5);
      expect(at(0x80005002)).toBe(0);
      lands = false; // from here every bolt hits the wall: the third miss in a row blacklists it
      await step(6000);
      expect(at(0x80005002)).toBeGreaterThan(0);
      expect(api.routine.history().join('\n')).toMatch(/Gate Guard blacklisted for 120 s: 3 attempts in a row/);
    });

    it('a bow\'s shots that hit the environment count against the monster shot at', async () => {
      two();
      host.inv = [{ guid: 0x50000071, name: 'Yumi', where: 'equipped', type: 'MissileWeapon', slot: 'MissileWeapon', itemType: 0x100 }] as never;
      const attack = host.attack;
      // Each attack order: two shots into the wall.
      host.attack = (g, p, h) => { attack(g, p, h); api.pushChat('Your missile attack hit the environment.', 0); api.pushChat('Your missile attack hit the environment.', 0); };
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, BlacklistMonsterAttemptCount: 1 } }));
      await step(15000);
      expect(host.sent.filter((x) => x.startsWith('attack 80005001')).length).toBe(1);
      const h = api.routine.history().join('\n');
      expect(h).toMatch(/Gate Guard blacklisted for 120 s: 2 attempts in a row didn't reach it/);
      expect(h).toMatch(/attacking Drudge Skulker/);
    });

    it('HP tracker: a listed monster whose health doesn\'t change for GhostDeleteHPTrackerSeconds is set aside as a ghost', async () => {
      two();
      (host as unknown as { monsterTable: () => Promise<Array<[string, string, number]>> }).monsterTable = async () => [['Gate Guard', 'f', 500], ['Drudge Skulker', 'f', 40]];
      serverAnswers();
      // The fake's selected target always reports half health: it never changes.
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, GhostDeleteHPTrackerSeconds: 3 } }));
      await step(2500);
      expect(at(0x80005001)).toBeGreaterThan(0);
      expect(at(0x80005002)).toBe(0);
      await step(4000);
      expect(api.routine.history().join('\n')).toMatch(/ghost monster Gate Guard set aside: its health hasn't changed in 3 s/);
      expect(at(0x80005002)).toBeGreaterThan(0);
      // Off: never set aside.
      api.routine.stop();
      host.sent.length = 0;
      api = new AgentApi(host);
      serverAnswers();
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, GhostDeleteHPTrackerSeconds: 3, DeleteGhostMonstersByHPTracker: false } }));
      await step(6500);
      expect(at(0x80005002)).toBe(0);
    });
  });

  describe('the combat-mode gate (VTank CombatModeGate)', () => {
    it('nothing is cast in magic mode until the server\'s stance says magic', async () => {
      host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
      host.me.serverMode = 'peace';
      // The client switches at once; the server's stance follows 500 ms later.
      host.setCombatMode = (m: string) => { host.sent.push(`mode ${m}`); host.me.combatMode = m as never; setTimeout(() => { host.me.serverMode = m as never; }, 500); };
      const serverAt: string[] = [];
      const send = host.cast;
      host.cast = (sid, t) => { serverAt.push(String(host.me.serverMode)); return send(sid, t); };
      serverAnswers();
      api.routine.start(vt({}));
      await step(3000);
      expect(host.sent).toContain('mode magic');
      expect(serverAt.length).toBeGreaterThan(0);
      expect(serverAt.every((m) => m === 'magic')).toBe(true);
    });

    it('drops to peace that never take: at DropToPeaceModeRetryCount the first Items-tab wand is wielded to clear the bugged state', async () => {
      host.me.combatMode = 'melee';
      host.setCombatMode = (m: string) => { host.sent.push(`mode ${m}`); }; // stuck: the client never leaves melee
      host.inv = [{ guid: 0x50000097, name: 'Training Wand', where: 'main pack', type: 'Caster', itemType: 0x8000, fits: 'Held' }] as never;
      const data = emptyVtankData();
      data.items = [{ name: 'Training Wand' }];
      api.routine.start(vt({ vtank: data, settings: { EnableBuffing: false, AttackDistance: 30, IdlePeaceMode: true, DropToPeaceModeRetryCount: 3, AutoCraftItems: false } }));
      await step(8000);
      expect(host.sent.filter((x) => x === 'mode peace').length).toBeGreaterThanOrEqual(2);
      expect(host.sent).toContain('wield 50000097');
      expect(api.routine.history().join('\n')).toMatch(/Macro detected bugged combat state/);
    });
  });

  it('RandomHelperBuffs: a random protection on a player within 18 m, at the best level you cast, every RandomHelperIntervalSeconds', async () => {
    const armor = id('Armor Other I');
    const s = table.spells.get(armor)!;
    host.spells = () => [{ id: armor, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, buff: true }];
    host.add({ guid: 0x50000aaa, name: 'Fellow Player', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 25 });
    host.add({ guid: 0x50000bbb, name: 'Far Player', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 60 });
    host.me.combatMode = 'magic';
    let r = 0;
    const rand = vi.spyOn(Math, 'random').mockImplementation(() => { r = (r + 0.137) % 1; return r; });
    try {
      serverAnswers();
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, RandomHelperBuffs: true, RandomHelperIntervalSeconds: 5, AutoCraftItems: false } }));
      await step(2000);
      expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([`cast ${armor} 50000aaa`]);
      await step(5000);
      expect(host.sent.filter((x) => x === `cast ${armor} 50000aaa`)).toHaveLength(2);
      expect(host.sent.some((x) => x.endsWith('50000bbb'))).toBe(false);
    } finally { rand.mockRestore(); }
    // Off (VTank's default): nothing.
    api.routine.stop();
    host.sent.length = 0;
    api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, AutoCraftItems: false } }));
    await step(3000);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
  });

  describe('VTank parity §1.5–§1.8 in the running macro (item debuffs, immunity, the turn, pets)', () => {
    const skulker = () => host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const imperil = () => `cast ${id('Imperil Other I')} 80005001`;

    it('an item\'s "<item> cast <debuff> on <monster>" line logs the debuff: it is not cast again while it lasts', async () => {
      skulker();
      const data = emptyVtankData();
      data.monsters[0].on = ['I', 'A'];
      serverAnswers({ resist: (sid) => sid === id('Imperil Other I') });
      api.routine.start(vt({ vtank: data }));
      await step(1500);
      expect(host.sent).toContain(imperil());
      // A cast-on-strike weapon (or a wand) put Imperil on it: ACE / AC1999 "<item> cast <spell> on <target>".
      api.pushChat('Imperiling Sword cast Imperil Other I on Drudge Skulker', 7);
      await step(300);
      host.sent.length = 0;
      await step(3000);
      expect(host.sent).not.toContain(imperil());
      expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    });

    it('"You fail to affect X with Y" (NonProjectileMagicImmune): no more debuffs at it; it is attacked', async () => {
      skulker();
      const data = emptyVtankData();
      data.monsters[0].on = ['I', 'A'];
      serverAnswers({ refuse: (sid) => (sid === id('Imperil Other I') ? 'You fail to affect Drudge Skulker with Imperil Other I' : null) });
      api.routine.start(vt({ vtank: data }));
      await step(4000);
      // Before 2026-10-11 it recast Imperil at it for ever and never attacked.
      expect(host.sent.filter((x) => x === imperil()).length).toBeLessThanOrEqual(2);
      expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    });

    it('the AC1999 server\'s "You fail to affect X because X cannot be harmed!" stops the debuffs too', async () => {
      skulker();
      const data = emptyVtankData();
      data.monsters[0].on = ['I', 'A'];
      serverAnswers({ refuse: (sid) => (sid === id('Imperil Other I') ? 'You fail to affect Drudge Skulker because Drudge Skulker cannot be harmed!' : null) });
      api.routine.start(vt({ vtank: data }));
      await step(4000);
      expect(host.sent.filter((x) => x === imperil()).length).toBeLessThanOrEqual(2);
      expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    });

    it('UseBreakableTurnTo (on by default): the macro faces a monster off to the side itself before the bolt', async () => {
      host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 95, y: 20 }); // due east
      serverAnswers();
      api.routine.start(vt({}));
      await step(2500);
      expect(api.routine.history().some((h) => /turning to face Drudge Skulker/.test(h))).toBe(true);
      expect(host.sent).toContain(`cast ${id('Flame Bolt I')} 80005001`);
      expect(Math.abs(api.self()!.heading - 90)).toBeLessThan(3);
      api.routine.stop();
      // Off: no turn of ours (the cast's own turn does it).
      host.me.yaw = 0;
      const before = api.routine.history().length;
      api.routine.start(vt({ settings: { EnableBuffing: false, AttackDistance: 30, UseBreakableTurnTo: false } }));
      await step(1500);
      expect(api.routine.history().slice(before).some((h) => /turning to face/.test(h))).toBe(false);
    });

    it('a grenade on the Consumables tab is wielded and thrown in missile mode; once it lands, the row\'s weapon again, with a fresh attack order', async () => {
      skulker();
      const SWORD = 0x50000c01, PHIAL = 0x50000c02;
      host.inv = [
        { guid: SWORD, name: 'Iron Sword', where: 'equipped', itemType: 0x1, slot: 'MeleeWeapon' },
        { guid: PHIAL, name: 'Iron Phial of Imperil', where: 'main pack', itemType: 0x100, fits: 'MissileWeapon', stack: 10 },
      ] as never;
      // The phial's examination: Spellcraft 400 and its cast-on-strike spell (ACE AppraiseInfo lists the ProcSpell).
      host.appraised.push(SWORD, PHIAL);
      host.appraisalDatas.set(SWORD, { int: { 45: 0x1 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
      host.appraisalDatas.set(PHIAL, { int: { 106: 400 }, float: {}, string: {}, bool: {}, did: {}, spells: ['Imperil Other I'] });
      host.wield = (g) => {
        host.sent.push(`wield ${g.toString(16)}`);
        host.inv = host.inv.map((i) => ({ ...i, where: i.guid === g ? 'equipped' : 'main pack' })) as never;
        return true;
      };
      const data = emptyVtankData();
      data.monsters[0].on = ['I', 'A'];
      data.items = [{ name: 'Iron Sword' }];
      data.consumables = ['Iron Phial of Imperil'];
      host.me.combatMode = 'melee';
      api.routine.start(vt({ vtank: data }));
      await step(9000);
      // Your Life Magic 100 against the phial's Spellcraft 400: the phial goes.
      expect(host.sent).toContain(`wield ${PHIAL.toString(16)}`);
      expect(host.sent).toContain('mode missile');
      expect(host.sent.some((x) => x.startsWith('attack 80005001'))).toBe(true);
      expect(host.sent).not.toContain(imperil());
      // It lands: the server says so, and the sword comes back for the attack, sent again.
      api.pushChat('Iron Phial of Imperil cast Imperil Other I on Drudge Skulker', 7);
      await step(15_000);
      expect(host.sent).toContain(`wield ${SWORD.toString(16)}`);
      // A new attack order with the sword, not "still fighting" on the throw's order (the weapon change ended it).
      const after = api.routine.history().slice(api.routine.history().findIndex((h) => /uses Iron Sword/.test(h)));
      expect(after.some((h) => /default p1: attacking Drudge Skulker/.test(h))).toBe(true);
      expect(host.sent).not.toContain(imperil());
    });

    it('Drain Auto reads the era\'s drain table from the host: at full health a martyr, not a drain (nothing to drain into)', async () => {
      skulker();
      const known = ['Drain Health Other I', "Martyr's Hecatomb I", 'Flame Bolt I'].map(id);
      host.spells = () => known.map((k) => { const sp = table.spells.get(k)!; return { id: k, name: sp.name, school: SCHOOLS[sp.school] ?? '', level: 1, category: sp.category, power: sp.power, duration: sp.duration ?? 0, ...(sp.school === 2 && /Martyr/.test(sp.name) ? { projectile: true } : {}) }; });
      const data = emptyVtankData();
      data.monsters[0].on = ['A'];
      data.monsters[0].damage = 10; // Drain Auto
      serverAnswers();
      // No table from the host: the best drain, as before the plan existed.
      api.routine.start(vt({ vtank: data }));
      await step(1500);
      expect(host.sent).toContain(`cast ${id('Drain Health Other I')} 80005001`);
      api.routine.stop();
      host.sent.length = 0;
      const { default: EOL_DRAINS } = await import('../packages/renderer/src/agent/macro/drains/eol.ts');
      (host as unknown as { drainTable: () => Promise<unknown> }).drainTable = async () => JSON.parse(EOL_DRAINS);
      api = new AgentApi(host);
      api.routine.start(vt({ vtank: data }));
      await step(1500);
      expect(host.sent).toContain(`cast ${id("Martyr's Hecatomb I")} 80005001`);
      expect(host.sent).not.toContain(`cast ${id('Drain Health Other I')} 80005001`);
    });

    describe('Summon Pets and refills', () => {
      const ESSENCE = 0x50000a02;
      const withSummoning = () => {
        const skills = (host as unknown as { skillList: () => unknown[] }).skillList();
        (host as unknown as { skillList: () => unknown[] }).skillList = () => [...skills, { id: 54, name: 'Summoning', training: 'trained', base: 100, buffed: 100 }];
      };
      const essence = (ints: Record<number, number> = {}, floats: Record<number, number> = {}) => {
        host.inv = [{ guid: ESSENCE, name: 'Fire Grievver Essence (50)', where: 'main pack', uiEffects: 0x20 }] as never;
        host.appraisalDatas.set(ESSENCE, { int: { 266: 49052, 280: 213, ...ints }, float: { 167: 45, ...floats }, string: {}, bool: {}, did: {}, spells: [] });
        const data = emptyVtankData();
        data.items = [{ name: 'Fire Grievver Essence (50)' }];
        data.monsters[0].damage = 6;
        return data;
      };
      const settings = { EnableBuffing: false, AttackDistance: 30, SummonPets: true };

      it('needs Summoning trained, no summoning cooldown running, and 3 m of room ahead; then summons once per cooldown', async () => {
        skulker();
        const data = essence();
        let cooldown = 30, room: boolean | null = false;
        (host as unknown as { cooldownRemaining: (id: number) => number }).cooldownRemaining = (cid) => (cid === 213 ? cooldown : 0);
        (host as unknown as { roomAhead: () => boolean | null }).roomAhead = () => room;
        api.routine.start(vt({ vtank: data, settings }));
        await step(2000);
        expect(host.sent).not.toContain(`use ${ESSENCE.toString(16)}`); // Summoning untrained
        api.routine.stop();
        withSummoning();
        api.routine.start(vt({ vtank: data, settings }));
        await step(2000);
        expect(host.sent).not.toContain(`use ${ESSENCE.toString(16)}`); // the cooldown runs
        cooldown = 0;
        await step(2000);
        expect(host.sent).not.toContain(`use ${ESSENCE.toString(16)}`); // no room for the pet
        room = null; // a client that can't tell counts as room
        await step(12_000);
        expect(host.sent.filter((x) => x === `use ${ESSENCE.toString(16)}`)).toHaveLength(1);
        // The essence's own 45 s CooldownDuration holds the next one even before the client shows the cooldown.
        await step(20_000);
        expect(host.sent.filter((x) => x === `use ${ESSENCE.toString(16)}`)).toHaveLength(1);
      });

      it('an essence of another Summoning Mastery than yours (the server\'s PropertyInt 362 for you) is not used', async () => {
        skulker();
        withSummoning();
        const data = essence({ 362: 3 });
        let mine = 1;
        (host as unknown as { charInt: (id: number) => number | undefined }).charInt = (pid) => (pid === 362 ? mine : undefined);
        api.routine.start(vt({ vtank: data, settings }));
        await step(3000);
        expect(host.sent).not.toContain(`use ${ESSENCE.toString(16)}`);
        mine = 3;
        await step(12_000);
        expect(host.sent).toContain(`use ${ESSENCE.toString(16)}`);
      });

      it('an essence down to PetRefillCount-Normal charges gets an Encapsulated Spirit, in peace mode', async () => {
        const data = essence({ 92: 1, 91: 50 });
        host.inv = [...host.inv, { guid: 0x50000b01, name: 'Encapsulated Spirit', where: 'main pack', stack: 5 }] as never;
        host.me.combatMode = 'melee';
        api.routine.start(vt({ vtank: data, settings }));
        await step(3000);
        expect(host.sent).toContain('mode peace');
        expect(host.sent).toContain(`usewith 50000b01 ${ESSENCE.toString(16)}`);
      });
    });
  });

  it('a profile without VirindiTank data keeps the plain macro (attack nearest)', async () => {
    host.add({ guid: 0x80005002, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    api.routine.start(vt({ vtank: undefined, settings: { AttackDistance: 30 } }));
    await step(1500);
    expect(host.sent.some((x) => x.startsWith('attack 80005002'))).toBe(true);
  });
});

describe('DefaultMeleeAttackHeight (VTank: 1 High, 2 Medium, 3 Low)', () => {
  it('is the height the macro\'s attacks start at', () => {
    expect(vtAttackHeight({})).toBe('medium');
    expect(vtAttackHeight({ DefaultMeleeAttackHeight: 1 })).toBe('high');
    expect(vtAttackHeight({ DefaultMeleeAttackHeight: 3 })).toBe('low');
    expect(vtAttackHeight({ DefaultMeleeAttackHeight: '3' })).toBe('low');
  });
});

describe('AutoAttackPower / UseRecklessness (VTank; MOSS AutoAttackPower)', () => {
  const sword = (ints: Record<number, number>, extra: Partial<PowerItem> = {}): PowerItem => ({ guid: 1, name: 'Sword', itemType: 0x1, equipped: true, slot: 'MeleeWeapon', ints, ...extra });
  const offWeapon: PowerItem = { guid: 2, name: 'Dagger', itemType: 0x1, equipped: true, slot: 'Shield', ints: { 45: 0x1 } };
  const shield: PowerItem = { guid: 3, name: 'Buckler', itemType: 0x2, equipped: true, slot: 'Shield' };
  const noReck = { UseRecklessness: false };
  const power = (element: Parameters<typeof autoAttackPower>[0]['element'], items: PowerItem[], settings: Record<string, string | number | boolean> = noReck, skills: Parameters<typeof autoAttackPower>[0]['skills'] = []) =>
    autoAttackPower({ element, items, settings, skills });
  it('the bar chooses the element on a slash + pierce weapon (ACE ThrustThreshold 0.33)', () => {
    const dual = sword({ 45: 0x3, 47: 0x3, 353: 2 });
    expect(power('pierce', [dual])).toBe(0.2);
    expect(power('slash', [dual])).toBe(1);
    expect(power(null, [dual])).toBe(1);
    // A pierce-only spear: nothing to choose, a full bar.
    expect(power('pierce', [sword({ 45: 0x2, 353: 11 })])).toBe(1);
    // Not examined yet: a full bar.
    expect(power('pierce', [sword(undefined as never)])).toBe(1);
  });
  it('triple-strike weapons: 0.49 dual wielding, a full bar with a shield, 0.2 alone', () => {
    const triple = sword({ 45: 0x3, 47: 0x40 | 0x80, 353: 2 });
    expect(power('pierce', [triple, offWeapon])).toBe(0.49);
    expect(power('pierce', [triple, shield])).toBe(1);
    expect(power('pierce', [triple])).toBe(0.2);
  });
  it('unarmed weapons punch (0) unless the row wants Slash from a slash + pierce one (0.5)', () => {
    expect(power('slash', [sword({ 45: 0x3, 353: 1 })])).toBe(0.5);
    expect(power('pierce', [sword({ 45: 0x3, 353: 1 })])).toBe(0);
    expect(power('bludgeon', [sword({ 45: 0x4, 353: 1 })])).toBe(0);
  });
  it('missile and bare hands take a full bar; Recklessness clamps to 0.11–0.9 only when trained', () => {
    const bow: PowerItem = { guid: 4, name: 'Bow', itemType: 0x100, equipped: true, slot: 'MissileWeapon' };
    const reck = { id: 50, name: 'Recklessness', training: 'specialized' as const, base: 200, buffed: 200 };
    expect(power('pierce', [bow])).toBe(1);
    expect(power(null, [])).toBe(1);
    expect(power('pierce', [bow], {}, [reck])).toBe(0.9);
    expect(power('pierce', [sword({ 45: 0x3, 353: 1 })], {}, [reck])).toBe(0.11);
    expect(power('pierce', [bow], {}, [{ ...reck, training: 'untrained' }])).toBe(1);
  });
  it('off: the player\'s own bar', () => {
    expect(power('pierce', [sword({ 45: 0x3 })], { AutoAttackPower: false })).toBe('bar');
    expect(power('pierce', [sword({ 45: 0x3 })], { AutoAttackPower: 'False' })).toBe('bar');
  });
  it('attack-nearest\'s element: Slash / Pierce as named, Auto the weapon\'s own', () => {
    expect(swingElement(0, undefined)).toBe('pierce');
    expect(swingElement(2, undefined)).toBe('slash');
    expect(swingElement(8, sword({ 45: 0x2 }))).toBe('pierce');
    expect(swingElement(8, sword({ 45: 0x3 }))).toBe('slash');
    expect(swingElement(6, sword({ 45: 0x3 }))).toBeNull();
  });
});

describe('the server\'s reply to a cast (castReply.ts): ACE, GDLE / AC1999 and ClassicACE word it the same', () => {
  const reply = (ok: boolean, ...lines: string[]) => ({ ok, message: ['casting X', ...lines.map((l) => `  ${l}`)].join('\n') });
  it('counts a cast only on its "You cast" line, and never with a resist, an immune target or a refusal', () => {
    expect(castConfirmed(reply(true, 'You say, "Zojak Taboth"', 'You cast Imperil Other I on Drudge Skulker'), 'Imperil Other I')).toBe(true);
    expect(castConfirmed(reply(true, 'You cast Imperil Other I on Drudge Skulker, but it is surpassed by Imperil Other III'), 'Imperil Other I')).toBe(true);
    expect(castConfirmed(reply(true, 'Drudge Skulker resists your spell'), 'Imperil Other I')).toBe(false);
    expect(castConfirmed(reply(true, 'You fail to affect Drudge Skulker with Imperil Other I'), 'Imperil Other I')).toBe(false);
    expect(castConfirmed(reply(true, 'You cast Imperil Other II on Drudge Skulker'), 'Imperil Other I')).toBe(false); // another spell
    expect(castConfirmed({ ok: true, message: 'casting X (no reply yet: …)' }, 'Imperil Other I')).toBe(false);
    expect(COMPONENTS_MISSING.test("You don't have all the components for this spell.")).toBe(true);
    expect(COMPONENTS_MISSING.test("You do not have all of this spell's components")).toBe(true);
  });
  it('names the items an item buff went on (one line per worn piece), not "yourself"', () => {
    const r = reply(true, 'You cast Acid Bane I on Leather Coat', 'You cast Acid Bane I on Leather Cap, refreshing Acid Bane I', 'You cast Acid Bane I on Studded Leather Boots, surpassing Acid Bane I');
    expect(castTargetsNamed(r, 'Acid Bane I')).toEqual(['Leather Coat', 'Leather Cap', 'Studded Leather Boots']);
    expect(castTargetsNamed(reply(true, 'You cast Strength Self I on yourself'), 'Strength Self I')).toEqual([]);
  });
  it('ClassicACE: a full stop, and a metaspell\'s words before the name ("You quickcast extended …")', () => {
    expect(castConfirmed(reply(true, 'You cast Imperil Other I on Drudge Skulker.'), 'Imperil Other I')).toBe(true);
    expect(castConfirmed(reply(true, 'You quickcast extended Imperil Other I on Drudge Skulker.'), 'Imperil Other I')).toBe(true);
    expect(castTargetsNamed(reply(true, 'You cast extended Acid Bane I on Leather Coat.'), 'Acid Bane I')).toEqual(['Leather Coat']);
  });
});

describe('ItemBuffLedger: VTank\'s BuffedItems timers', () => {
  const store = () => { const m = new Map<string, string>(); return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } }; };
  const coat = { guid: 0x50000c01, name: 'Leather Coat' };
  const cap = { guid: 0x50000c02, name: 'Leather Cap' };
  const me = { guid: 0x50000001, name: 'Claude Test' };
  const bane = (power: number, duration = 1800) => ({ id: 1000 + power, category: 162, power, duration });
  it('keeps the longest record of at least the wanted power; all worn pieces must be covered', () => {
    let t = 1_000_000;
    const { s } = store();
    const l = new ItemBuffLedger(() => t, () => s);
    l.bind(me);
    l.note([coat], bane(100));
    expect(l.remainingOn(coat, 162, 100)).toBe(1800);
    expect(l.remainingOn(coat, 162, 150)).toBeNull();          // a stronger one wanted: not covered
    expect(l.remainingOnAll([coat, cap], 162, 100)).toBeNull(); // the cap has none
    l.note([cap], bane(100));
    t += 600_000;
    expect(l.remainingOnAll([coat, cap], 162, 100)).toBe(1200);
    // A shorter recast doesn't shorten the record.
    l.note([coat], bane(100, 60));
    expect(l.remainingOn(coat, 162, 100)).toBe(1200);
    // Another item now under that guid: not the same item.
    expect(l.remainingOn({ guid: coat.guid, name: 'Chainmail Tunic' }, 162, 100)).toBeNull();
  });
  it('survives a reload for the same character, not for another; expires; death and a clock rollback clear it', () => {
    let t = 5_000_000;
    const { m, s } = store();
    const a = new ItemBuffLedger(() => t, () => s);
    a.bind(me);
    a.note([coat], bane(100));
    t += 100_000;
    const b = new ItemBuffLedger(() => t, () => s);
    b.bind(me);
    expect(b.remainingOn(coat, 162, 100)).toBe(1700);
    const other = new ItemBuffLedger(() => t, () => s);
    other.bind({ guid: 0x50000002, name: 'Someone Else' });
    expect(other.remainingOn(coat, 162, 100)).toBeNull();
    t += 1_800_000;
    b.expire();
    expect(b.size).toBe(0);
    b.note([coat], bane(100));
    b.clear(); // death
    expect(b.remainingOn(coat, 162, 100)).toBeNull();
    expect([...m.values()].some((v) => v.includes('Leather Coat'))).toBe(false);
    b.note([coat], bane(100));
    t -= 3_600_000; // the clock went back an hour
    expect(b.remainingOn(coat, 162, 100)).toBeNull();
  });
  it('works without browser storage (memory only)', () => {
    const l = new ItemBuffLedger(() => 0, () => null);
    l.bind(me);
    l.note([coat], bane(1));
    expect(l.remainingOn(coat, 162, 1)).toBe(1800);
  });
});

describe('componentPurse: can the pack pay for a spell (VTank BuffCastability; ACE GetRequiredComps counts)', () => {
  it('counts each component as often as the formula names it, over every stack, plural names included; worn items do not count', () => {
    const pay = componentPurse([
      { name: 'Lead Scarab', stack: 1 }, { name: 'Lead Scarab', stack: 1 },
      { name: 'Prismatic Tapers', stack: 3 }, { name: 'Hyssop' }, { name: 'Iron Scarab', where: 'equipped' },
    ]);
    expect(pay(['Lead Scarab', 'Prismatic Taper', 'Prismatic Taper', 'Prismatic Taper'])).toBe(true);
    expect(pay(['Lead Scarab', 'Lead Scarab', 'Hyssop'])).toBe(true);
    expect(pay(['Lead Scarab', 'Lead Scarab', 'Lead Scarab'])).toBe(false);
    expect(pay(['Prismatic Taper', 'Prismatic Taper', 'Prismatic Taper', 'Prismatic Taper'])).toBe(false);
    expect(pay(['Iron Scarab'])).toBe(false);
    expect(pay([])).toBe(true);
  });
});
