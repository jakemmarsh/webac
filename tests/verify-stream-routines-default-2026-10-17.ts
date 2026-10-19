/**
 * STREAM.routines-default (2026-10-17): routines fight for the stream pair, Claude decides and talks. Claude Arcanist
 * (mage: Flame Bolt V, Heal Self V, Heal Other V, Stamina to Mana Self V) and Claude Bulwark (mace and shield, no magic)
 * made no routine call in ~21,500 tool calls that day and died 16 times; each model decision took 4–7 s while three
 * monsters did ~10 HP/s, and `attack` / `cast repeat=true` never heal. Their hunting grounds: Mountain Keep 0x01D2
 * (Dread Mu-miyahs, storeys, monsters stuck on other floors) and the Tusker Habitat 0x5B47 (Tusker Liberator waves).
 *
 * Drives the real RoutineEngine / VtMacro / AgentApi on the fake host (with the end-of-retail spell table where the
 * macro needs it), the stream's own ready profiles (tools/stream/routines/), the brief and the player directory, and
 * the real Mountain Keep cell DAT for the Follow route.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { HAND_GRACE_MS } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { BEYOND_MACRO_DEFAULTS, beyondSetting } from '../packages/renderer/src/agent/beyondVtank.ts';
import { routineFromFile, routineSettings } from '../tools/ac-agent/tools.ts';
import { PLAYER_ROUTINE_FILE, preparePlayerDir } from '../tools/stream/player.ts';
import { fillBrief } from '../tools/stream/prompt.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ROUTINES = join(REPO, 'tools', 'stream', 'routines');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(ROUTINES, `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const ARCANIST = { profile: 'mage', character: 'Claude Arcanist' } as never;
const BULWARK = { profile: 'soldier', character: 'Claude Bulwark' } as never;

describe('each player has a ready profile, and the brief makes it the way fights run', () => {
  const brief = readFileSync(join(REPO, 'tools', 'stream', 'brief.md'), 'utf8');

  it('both profiles are valid routine profiles: the macro with VTank tabs, OnlyEngaged, ProtectFellows and their marks', () => {
    const mage = ready('mage');
    const soldier = ready('soldier');
    expect(mage.name).toBe('Arcanist fights');
    expect(soldier.name).toBe('Bulwark fights');
    for (const p of [mage, soldier]) {
      expect(p.macro).toBe(true);
      expect(p.vtank?.monsters[0]).toMatchObject({ name: '<DEFAULT>', on: ['A'] });
      expect(beyondSetting(p.settings!, 'OnlyEngaged')).toBe(true);
      expect(beyondSetting(p.settings!, 'ProtectFellows')).toBe(true);
      expect(beyondSetting(p.settings!, 'SkipUnreachableMonsters')).toBe(true);
    }
    expect(mage.settings).toMatchObject({ 'Recharge-Norm-HitP': 70, 'Recharge-Helper-HitP': 60, 'Recharge-Norm-Mana': 40, AttackDistance: 25, EnableBuffing: true });
    expect(mage.routes[0]).toMatchObject({ mode: 'follow', follow: 'Claude Bulwark' });
    expect(soldier.settings).toMatchObject({ 'Recharge-Norm-HitP': 55, 'Recharge-Norm-Stam': 20, AttackDistance: 12, EnableNav: false });
    expect(soldier.vtank?.consumables).toEqual(expect.arrayContaining(['Healing Kit', 'Stamina Elixir']));
  });

  it('the player directory gets the character\'s profile as routine.json, which `routine action=run file=routine.json` reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'acjs-stream-routines-'));
    try {
      for (const profile of ['mage', 'soldier'] as const) {
        const { dir } = preparePlayerDir(root, REPO, profile);
        const f = join(dir, PLAYER_ROUTINE_FILE);
        expect(readFileSync(f, 'utf8')).toBe(readFileSync(join(ROUTINES, `${profile}.json`), 'utf8'));
        const r = routineFromFile(f);
        expect('profile' in r && r.profile.name).toBe(profile === 'mage' ? 'Arcanist fights' : 'Bulwark fights');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the brief carries the profile: one call starts it, set= changes a mark, and what each does is said', () => {
    for (const [c, partner] of [[ARCANIST, 'Claude Bulwark'], [BULWARK, 'Claude Arcanist']] as const) {
      const text = fillBrief(brief, c, partner);
      expect(text).toContain('**Fights run under a routine.**');
      expect(text).toContain('`./ac routine action=run file=routine.json`');
      expect(text).toContain('set="Recharge-Norm-HitP=75,AttackDistance=20"');
      expect(text).toMatch(/Claude Arcanist's \(`Arcanist fights`\): bolts within 25 m.*Heal Self at 70% health.*Heal Other on Bulwark at 60%.*Stamina to Mana Self at 40% mana/s);
      expect(text).toMatch(/Claude Bulwark's \(`Bulwark fights`\): swings at what's within 12 m.*a healing kit \(or a health potion\) at 55% health, a stamina elixir or potion at 20% stamina/s);
      // attack / cast repeat are for one-off targets now; the lines steering fights to them are gone.
      expect(text).not.toContain('Attack ONE target at a time with `attack`');
      expect(text).not.toContain('healing kits and potions are for emergencies mid-fight');
      expect(text).toContain('are for a one-off target or something the routine can\'t do; say which when you use them instead');
      // Vitae (Jake, 2026-10-17: "13% vitae is not good"; "the vitae needs to be burned"): burned off first, easier
      // targets or leeching in fellowship range, no lone corpse runs through danger.
      expect(text).toMatch(/\*\*Vitae\*\* \(the death penalty\) lowers your max health, stamina and mana and every skill by its percentage \(not your attributes\) until XP works it off/);
      expect(text).toMatch(/burning it off comes first: with vitae, hunt easier targets than usual/);
      expect(text).toMatch(/stay back safe within fellowship range while your partner kills \(fellowship XP works vitae off like your own, at full share within a few hundred metres; your vitae line gives the live share range/);
      expect(text).toContain("Don't walk alone through a dangerous area to a corpse: go together or replace the gear.");
      // The permission check reads a dash or range between < and > as a shell pattern: none in the new lines.
      const para = text.slice(text.indexOf('**Fights run under a routine.**'), text.indexOf('**Mana** comes back'));
      expect(para).not.toMatch(/<[^>\n]*-[^>\n]*>/);
    }
  });

  it('set= gives typed settings for one run; a malformed one is refused with its usage', () => {
    expect(routineSettings('Recharge-Norm-HitP=75, AttackDistance=20,OnlyEngaged=false,BuffSet=Basics')).toEqual({ settings: { 'Recharge-Norm-HitP': 75, AttackDistance: 20, OnlyEngaged: false, BuffSet: 'Basics' } });
    expect(routineSettings(undefined)).toEqual({ settings: {} });
    const bad = routineSettings('HealAt70');
    expect('text' in bad && bad.text).toMatch(/is not Name=value/);
  });

  it('the beyond-VTank defaults leave an imported VTank profile as it was, but for the melee walk-in to the unreachable', () => {
    expect(BEYOND_MACRO_DEFAULTS).toEqual({ SkipUnreachableMonsters: true, ProtectFellows: false, ProtectFellowsDistance: 25, OnlyEngaged: false, WeighBoltsByDamage: true, BuffMinLandChance: 75, FollowLeash: 0, FollowThroughPortals: true, FightBeforeBuffs: 60, SeekLineOfFire: true });
    expect(beyondSetting({ protectfellows: 'on' }, 'ProtectFellows')).toBe(true);
    expect(beyondSetting({ ProtectFellowsDistance: '40' }, 'ProtectFellowsDistance')).toBe(40);
  });
});

/** A fake server's answer to each cast: "You cast X on yourself / on Y" (the macro counts a cast landed by it). */
function answerCasts(api: AgentApi, host: FakeHost, names: (id: number) => string | undefined): void {
  const send = host.cast;
  host.cast = (sid, t) => {
    const r = send(sid, t);
    const n = names(sid);
    if (n) api.pushChat(t === null ? `You cast ${n} on yourself` : `You cast ${n} on ${host.objs.get(t)?.name ?? '?'}`, 7);
    return r;
  };
}

const step = async (api: AgentApi, host: FakeHost, ms: number, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
};

const PORTAL = DAT_PATHS.portal;
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

describe.skipIf(!existsSync(PORTAL))('the ready profiles fight on the real spell table (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  const know = (names: string[]) => {
    const ids = names.map(id);
    host.spells = () => ids.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) }; });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  const MU = 0x80005001;
  /** A Tusker Liberator on you, hitting for `dmg` every second (the combat line places it on its creature). */
  const liberatorOnYou = (dmg: number) => {
    host.add({ guid: MU, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22, seeks: { guid: host.me.guid, kind: 'stick' } });
    let last = host.t;
    return () => {
      if (host.t - last < 1000 || host.me.health.current <= 1) return;
      last = host.t;
      host.me.health.current = Math.max(1, host.me.health.current - dmg);
      api.pushChat(`Tusker Liberator hits your chest for ${dmg} points of bludgeoning damage!`, 0x15);
    };
  };

  it('Arcanist bolts the Liberator on her, and heals herself the moment her health is under 70% (before the 60% vitals-low wake)', async () => {
    know(['Heal Self I', 'Flame Bolt I', 'Stamina to Mana Self I']);
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 33, name: 'Life Magic', training: 'trained', base: 150, buffed: 150 },
      { id: 34, name: 'War Magic', training: 'trained', base: 150, buffed: 150 },
    ];
    answerCasts(api, host, (sid) => table.spells.get(sid)?.name);
    host.me.health = { current: 100, max: 100 };
    host.me.combatMode = 'magic';
    host.inv = [{ guid: 0x50000093, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 }] as never;
    const hit = liberatorOnYou(4);
    const heal = `cast ${id('Heal Self I')} self`;
    api.routine.start(ready('mage'));
    // Above the mark (100 → 76 over six blows): bolts, no heal.
    await step(api, host, 6000, hit);
    expect(host.sent).toContain(`cast ${id('Flame Bolt I')} ${MU.toString(16)}`);
    expect(host.sent).not.toContain(heal);
    expect(host.me.health.current).toBeGreaterThanOrEqual(70);
    // Under 70% (still above 60%: no vitals-low event yet): the next decision heals.
    host.me.health.current = 67;
    const at = host.sent.length;
    await step(api, host, 2500, hit);
    expect(host.sent.slice(at)).toContain(heal);
  });

  it('Bulwark swings at the Liberator and drinks a Stamina Elixir when exhausted (stamina 0), then swings again', async () => {
    know([]);
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 300, buffed: 300 }];
    host.me.health = { current: 197, max: 197 };
    host.me.stamina = { current: 200, max: 297 };
    host.me.combatMode = 'melee';
    const ELIXIR = 0x50000201;
    host.inv = [
      { guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 },
      { guid: ELIXIR, name: 'Stamina Elixir', where: 'main pack', type: 'Food', itemType: 0x20, stack: 3 },
    ] as never;
    host.appraisalDatas.set(ELIXIR, { int: { 89: 4, 90: 100, 16: 8 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraised.push(ELIXIR);
    const hit = liberatorOnYou(3);
    // The elixir's 100 stamina, as the server gives it for a plain Use (ACE refuses a use-with-target of an elixir:
    // "Cannot use the Stamina Elixir with the Claude Bulwark", 2026-10-18).
    const use = host.use;
    host.use = (i) => { if (i === ELIXIR) host.me.stamina.current = Math.min(host.me.stamina.max, host.me.stamina.current + 100); return use(i); };
    api.routine.start(ready('soldier'));
    await step(api, host, 3000, hit);
    expect(host.sent.some((s) => s.startsWith(`attack ${MU.toString(16)}`)), host.sent.join('\n')).toBe(true);
    expect(host.sent.some((s) => s.startsWith(`use ${ELIXIR.toString(16)}`))).toBe(false);
    // Exhausted mid-swing: the swing's wait gives way within a slice and the elixir goes down.
    host.me.stamina.current = 0;
    const at = host.sent.length;
    await step(api, host, 2000, hit);
    const after = host.sent.slice(at);
    expect(after, after.join('\n')).toContain(`use ${ELIXIR.toString(16)}`);
    expect(after.some((s) => s.startsWith(`usewith ${ELIXIR.toString(16)}`))).toBe(false);
    // One elixir (it brought him back over the mark), and the fight goes on.
    expect(after.filter((s) => s === `use ${ELIXIR.toString(16)}`)).toHaveLength(1);
    expect(api.routine.status().acting).toMatch(/^combat/);
    expect(api.routine.history().join('\n')).toMatch(/recharge: stamina 0% < 20% \(Recharge-Norm-Stam\): Recharge With Food \(Stamina Elixir\)/);
  });

  describe('a monster that can\'t reach Bulwark is skipped (Mountain Keep 0x01D2, a storey down; one stuck behind a wall)', () => {
    const ROOM = 0x01d20150;
    const DOWN = 0x80005011, STUCK = 0x80005012, BESIDE = 0x80005013;
    beforeEach(() => {
      know([]);
      (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 300, buffed: 300 }];
      Object.assign(host.me, { cell: ROOM, x: 80, y: 20, z: 0, combatMode: 'melee' });
      host.me.health = { current: 197, max: 197 };
      host.inv = [{ guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 }] as never;
    });

    it('a Dread a storey down, running at him, is no target; with SkipUnreachableMonsters off (VTank) it would be swung at', async () => {
      host.add({ guid: DOWN, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 83, y: 22, z: -8, seeks: { guid: host.me.guid, kind: 'move' } });
      api.routine.start(ready('soldier'));
      await step(api, host, 4000);
      expect(api.observe().nearby.find((o) => o.guid === DOWN)?.comingAtYouStuck).toBe(true);
      expect(host.sent.some((s) => s.startsWith(`attack ${DOWN.toString(16)}`))).toBe(false);
      api.routine.stop();
      const p = ready('soldier');
      api.routine.start({ ...p, settings: { ...p.settings, SkipUnreachableMonsters: false } });
      await step(api, host, 3000);
      expect(host.sent.some((s) => s.startsWith(`attack ${DOWN.toString(16)}`))).toBe(true);
    });

    it('one aimed at him on his floor that gets no nearer for 20 s (behind a wall) is left alone; the one beside him is fought', async () => {
      host.add({ guid: STUCK, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 88, y: 20, z: 0, seeks: { guid: host.me.guid, kind: 'move' } });
      // The chase gets nowhere for 25 s, then it is AIMED AT YOU BUT NOT REACHING YOU.
      await step(api, host, 25_000);
      expect(api.observe().nearby.find((o) => o.guid === STUCK)?.comingAtYouStuck).toBe(true);
      api.routine.start(ready('soldier'));
      await step(api, host, 3000);
      expect(host.sent.some((s) => s.startsWith(`attack ${STUCK.toString(16)}`))).toBe(false);
      host.add({ guid: BESIDE, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 81, y: 20, z: 0, seeks: { guid: host.me.guid, kind: 'stick' } });
      api.pushChat('Dread Mu-miyah hits your chest for 6 points of bludgeoning damage!', 0x15);
      await step(api, host, 3000);
      expect(host.sent.some((s) => s.startsWith(`attack ${BESIDE.toString(16)}`)), host.sent.join('\n')).toBe(true);
      expect(host.sent.some((s) => s.startsWith(`attack ${STUCK.toString(16)}`))).toBe(false);
    });
  });

  it('OnlyEngaged: a Liberator standing idle 8 m off is not pulled; once it comes at Bulwark it is fought', async () => {
    know([]);
    host.me.combatMode = 'melee';
    host.inv = [{ guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 }] as never;
    host.add({ guid: MU, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
    api.routine.start(ready('soldier'));
    await step(api, host, 3000);
    expect(host.sent.some((s) => s.startsWith('attack '))).toBe(false);
    host.objs.get(MU)!.seeks = { guid: host.me.guid, kind: 'move' };
    await step(api, host, 2000);
    expect(host.sent.some((s) => s.startsWith(`attack ${MU.toString(16)}`))).toBe(true);
  });

  it('ProtectFellows: with one Liberator on Bulwark and one on Arcanist 20 m off (past his 12 m range), he goes for Arcanist\'s', async () => {
    know([]);
    host.me.combatMode = 'melee';
    host.inv = [{ guid: 0x50000090, name: 'Spiked Mace', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 }] as never;
    const ARC = 0x50000077, ON_ARC = 0x80005021, ON_ME = 0x80005022;
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0, x: 80, y: 40 });
    (host as unknown as { fellows: () => unknown[] }).fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 90, max: 173 }, stamina: { cur: 200, max: 231 }, mana: { cur: 200, max: 311 } }];
    host.add({ guid: ON_ARC, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, x: 80.8, y: 40, seeks: { guid: ARC, kind: 'stick' } });
    host.add({ guid: ON_ME, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20, seeks: { guid: host.me.guid, kind: 'stick' } });
    api.pushChat('Tusker Liberator hits your chest for 3 points of bludgeoning damage!', 0x15);
    api.routine.start(ready('soldier'));
    // He runs to it (an attack order on a monster 20 m off runs up first) and swings once there; never at his own first.
    await step(api, host, 8000);
    const first = host.sent.find((s) => s.startsWith('attack '));
    expect(first, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toMatch(new RegExp(`^attack ${ON_ARC.toString(16)}`));
    expect(host.me.y).toBeGreaterThan(35);
  });
});

describe('the engine around the routine (no DAT needed)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  const KIT = 0x50000301, MON = 0x80006001;
  const rules = (): RoutineProfile => ({
    name: 'Rules hunt', modules: { ...ALL_MODULES_OFF, vitals: true, combat: true }, initialState: 'Hunt', loot: [], buffSets: [], routes: [],
    states: [{ name: 'Hunt', rules: [
      { label: 'Low health', when: [{ kind: 'vital-below', vital: 'health', percent: 60 }], do: [{ kind: 'use-item', item: 'Healing Kit', on: 'self' }, { kind: 'wait', seconds: 1 }] },
      { label: 'Fight', when: [{ kind: 'monster-within', meters: 30 }], do: [{ kind: 'attack-nearest', meters: 30 }] },
    ] }],
  });

  it('a rules profile\'s fight gives way to the heal rule above it mid-fight (it waited out the whole fight, up to 2 minutes)', async () => {
    host.inv = [{ guid: KIT, name: 'Healing Kit', where: 'main pack', type: 'Healer' }] as never;
    host.add({ guid: MON, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    api.routine.start(rules());
    await step(api, host, 1500);
    expect(host.sent.filter((s) => s.startsWith(`attack ${MON.toString(16)}`))).toHaveLength(1);
    host.me.health.current = 25; // 50 %
    await step(api, host, 1500);
    expect(host.sent).toContain(`usewith ${KIT.toString(16)} ${host.me.guid.toString(16)}`);
    expect(api.routine.history().join('\n')).toMatch(/broke off Drudge Skulker for "Low health"/);
  });

  it('the player\'s own walk holds the routine while it runs and 3 s after; then it carries on by itself', async () => {
    host.add({ guid: MON, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    api.routine.start(rules());
    await step(api, host, 1000);
    expect(host.sent.filter((s) => s.startsWith('attack '))).toHaveLength(1);
    const surface = api.surface() as { walkTo: (t: string, o?: object) => Promise<{ ok: boolean; message: string }> };
    let done: { ok: boolean } | null = null;
    void surface.walkTo('6m south').then((r) => { done = r; });
    await step(api, host, 500);
    expect(api.routine.status().heldFor).toBe('walk_to');
    for (let i = 0; i < 100 && !done; i++) await step(api, host, 100);
    expect(done).not.toBeNull();
    // The walk ended the server's swing.
    host.pending = false;
    const at = host.sent.length;
    await step(api, host, HAND_GRACE_MS - 500);
    expect(host.sent.slice(at).filter((s) => s.startsWith('attack '))).toEqual([]);
    await step(api, host, 1500);
    expect(api.routine.status().heldFor).toBeUndefined();
    // Carrying on: the fight rule again, running back up to the Skulker and swinging.
    expect(api.routine.status().acting).toBe('Fight');
    await step(api, host, 6000);
    expect(host.sent.slice(at).some((s) => s.startsWith(`attack ${MON.toString(16)}`)), `${host.sent.join('\n')}\n${api.routine.history().join('\n')}\n${JSON.stringify(api.observe().me)}`).toBe(true);
    expect(api.routine.history().join('\n')).toMatch(/holding: you took over \(walk_to\)[\s\S]*carrying on after your walk_to/);
  });

  it('reading commands (observe, wait, say) never hold it; a paused routine is not touched', async () => {
    host.add({ guid: MON, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    api.routine.start(rules());
    const surface = api.surface() as Record<string, (...a: unknown[]) => unknown>;
    surface.observe();
    surface.say('/f pulling the left one');
    expect(api.routine.status().heldFor).toBeUndefined();
    api.routine.pause();
    surface.turn('east');
    expect(api.routine.status().heldFor).toBeUndefined();
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Arcanist\'s Follow route in the real Mountain Keep (0x01D2)', () => {
  const LB = 0x01d20000;
  const C = (n: number): number => (LB | n) >>> 0;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 120_000);

  it('follows Bulwark down from the fountain wing onto the −6 deck by the doorway route (not along flat trail corners on the floor above)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
      host.me.health = { current: 173, max: 173 };
      host.me.name = 'Claude Arcanist';
      const BUL = 0x50000088;
      // Bulwark walks from beside her to the deck (0x01D20124 at −6, which the server files under 0x01D20127), past a drop.
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, cell: C(0x2a6), x: 89, y: -61, z: 0 });
      try {
        let moved = false;
        const near = () => {
          const b = host.objs.get(BUL)!;
          return Math.hypot(b.x - host.me.x, b.y - host.me.y) <= 9 && Math.abs(b.z - host.me.z) < 2;
        };
        const r = await host.run(C(0x2a6), { x: 90, y: -60, z: 0 }, async (api) => {
          api.routine.start(ready('mage'));
          return { ok: true, message: 'started' };
        }, { maxMs: 1000 });
        expect(r.ok).toBe(true);
        const api = (host as unknown as { api: AgentApi }).api;
        let t = 0;
        await host.run(C(0x2a6), { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), {
          maxMs: 150_000, sameApi: true,
          each: () => {
            t += 100;
            if (!moved && t >= 2000) { Object.assign(host.objs.get(BUL)!, { cell: C(0x127), x: 86.3, y: -67.8, z: -6 }); moved = true; }
            if (moved && t > 4000 && near()) throw new Error('arrived');
          },
        }).catch((e: Error) => { if (e.message !== 'arrived') throw e; });
        expect(near(), `${host.me.x.toFixed(1)}, ${host.me.y.toFixed(1)}, z ${host.me.z.toFixed(1)}\n${api.routine.history().join('\n')}`).toBe(true);
        expect(host.me.z).toBeCloseTo(-6, 0);
      } finally { host.dispose(); }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 300_000);
});
