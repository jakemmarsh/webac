/**
 * ROUTINE.self-buff-only-self (2026-10-17 00:02:32Z, Claude Arcanist on tools/stream/routines/mage.json): the routine log
 * said "buff: trained skill Shield: Shield Mastery Other IV can't be cast on yourself: it goes on someone else only"
 * every buff cycle. The macro's self-buff planner (buffPlan.planBuffs) took the best spell of each wanted family, and a
 * Self and an Other spell share a family (the spell table's category), so knowing only Shield Mastery Other IV it picked
 * that. VTank buffs only itself (BuffSelfNormal / BuffSelfIdle), and the client refuses a creature-only Other spell on you
 * (ObjectCompatibleWithSpellTargetType @ 00567230: its target type must share a bit with 0x8107; AgentApi.spellCastsOnYou).
 *
 * Drives the real RoutineEngine / VtMacro / AgentApi on the fake host with the end-of-retail spell table (target types
 * included, as main.ts's host gives them).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi, spellCastsOnYou } from '../packages/renderer/src/agent/AgentApi.ts';
import { buildBuffFamilies, planBuffs } from '../packages/renderer/src/agent/macro/buffPlan.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const mage = (): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', 'mage.json'));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};

const PORTAL = DAT_PATHS.portal;
type Row = { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType: number };
type Table = { spells: Map<number, Row> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

const step = async (api: AgentApi, host: FakeHost, ms: number): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
};

describe.skipIf(!existsSync(PORTAL))('the routine self-buffs only with spells that can go on you (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  /** The spells you know, as main.ts's host lists them (self / buff flags, family, power, duration, target type). */
  const know = (names: string[]) => {
    const ids = names.map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return {
        id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, targetType: s.nonComponentTargetType >>> 0,
        ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}),
      };
    });
  };
  const SKILLS = [
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 250, buffed: 250 },
    { id: 33, name: 'Life Magic', training: 'trained', base: 250, buffed: 250 },
    { id: 34, name: 'War Magic', training: 'trained', base: 250, buffed: 250 },
    { id: 48, name: 'Shield', training: 'trained', base: 150, buffed: 150 },
  ];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => SKILLS;
    host.me.health = { current: 200, max: 200 };
    host.me.mana = { current: 400, max: 400 };
    host.me.stamina = { current: 300, max: 300 };
    host.me.combatMode = 'magic';
    host.inv = [{ guid: 0x50000093, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 }] as never;
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the table: Shield Mastery Other IV is creature-only (the client refuses it on you), its Self twin shares its family', () => {
    const other = table.spells.get(id('Shield Mastery Other IV'))!;
    const self = table.spells.get(id('Shield Mastery Self IV'))!;
    expect(other.nonComponentTargetType & 0x8107).toBe(0);
    expect(other.bitfield & 0x8).toBe(0);
    expect(self.bitfield & 0x8).toBe(0x8);
    expect(self.category).toBe(other.category);
  });

  it('knowing only Shield Mastery Other IV: never cast as a self buff, said once ("no self version known: Shield Mastery Self"); Strength Self still goes up', async () => {
    know(['Shield Mastery Other IV', 'Strength Self I']);
    api.routine.start(mage());
    await step(api, host, 30_000);
    const log = api.routine.history().join('\n');
    const other = id('Shield Mastery Other IV');
    expect(host.sent.filter((s) => s.startsWith(`cast ${other} `)), log).toEqual([]);
    expect(log).not.toContain("can't be cast on yourself");
    expect(log.match(/no self version known: Shield Mastery Self\b/g), log).toHaveLength(1);
    expect(log).toContain('Shield Mastery Other IV goes on someone else only');
    expect(host.sent, log).toContain(`cast ${id('Strength Self I')} self`);
  });

  it('knowing both sides, the Self spell is the one cast on you (even a lower level), and nothing is noted', async () => {
    know(['Shield Mastery Other IV', 'Shield Mastery Self I']);
    api.routine.start(mage());
    await step(api, host, 15_000);
    const log = api.routine.history().join('\n');
    expect(host.sent, log).toContain(`cast ${id('Shield Mastery Self I')} self`);
    expect(host.sent.some((s) => s.startsWith(`cast ${id('Shield Mastery Other IV')} `))).toBe(false);
    expect(log).not.toContain('no self version known');
  });

  it('Heal Other still goes on a fellow under Recharge-Helper-HitP (the helper picks Other spells)', async () => {
    know(['Heal Other I', 'Shield Mastery Other IV']);
    const BUL = 0x50000078;
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0, x: 84, y: 20 });
    (host as unknown as { fellows: () => unknown[] }).fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 50, max: 200 }, stamina: { cur: 200, max: 200 }, mana: { cur: 100, max: 100 } }];
    api.routine.start(mage());
    await step(api, host, 10_000);
    const log = api.routine.history().join('\n');
    expect(host.sent, log).toContain(`cast ${id('Heal Other I')} ${BUL.toString(16)}`);
    expect(host.sent.some((s) => s.startsWith(`cast ${id('Shield Mastery Other IV')} `))).toBe(false);
  });

  it('the planner alone: an Other-only family is in noSelf, not wanted; without the rule (no castsOnYou) it was planned', () => {
    know(['Shield Mastery Other IV']);
    const spells = api.spells('', 1000).map((s) => ({ id: s.id, name: s.name, school: 'Creature Enchantment', category: s.category!, power: s.power!, self: !!s.self, buff: !!s.buff, duration: s.duration ?? 0, targetType: s.targetType }));
    const families = buildBuffFamilies(table as never, SKILLS.map((s) => [s.id, s.name] as [number, string]));
    const base = { spells, skills: SKILLS as never, active: [], settings: { EnableBuffing: true }, extraBuffs: [], blacklistedBuffs: [], idle: false, families };
    const fixed = planBuffs({ ...base, castsOnYou: spellCastsOnYou });
    expect(fixed.wanted.map((b) => b.spell.name)).toEqual([]);
    expect(fixed.noSelf.map((n) => [n.other.name, n.why])).toEqual([['Shield Mastery Other IV', 'trained skill Shield']]);
    expect(planBuffs(base).wanted.map((b) => b.spell.name)).toEqual(['Shield Mastery Other IV']);
  });
});
