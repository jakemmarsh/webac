/**
 * AGENT.stream-reports-2026-10-18-0717: the AI stream pair's 06:16–07:18Z segment in Aerbax Laboratory (0x029E) and
 * Aerbax Haven (0x029F), 2026-10-18, build 914c301d (reports stream/reports/{mage-2026-10-18T07-17-56-732Z,
 * soldier-2026-10-18T07-17-05-635Z}-seg1.md; transcripts stream/sessions/{mage,soldier}-2026-10-18-seg1.jsonl; page and
 * chat logs mage.log / soldier.log / *.chat.log):
 * 1. "Arcanist fights" never recast Invulnerability Self IV (it ran out at 06:28 and 06:59Z; he recast it by hand). His
 *    Melee Defense is untrained (101) and VTank keeps up only trained skills' buffs, so the family was never wanted; and
 *    once wanted, VTank's SpellDiffExcessThreshold-Buff 5 would pick VI at 59% (Creature Enchantment 255 against 250).
 * 2. "Bulwark fights"' Adept Healing Kit healed 81 (07:14:43.9), but the attack task re-sent its attack request during the
 *    bandaging (07:14:42.7) and ACE answered "You're too busy!" (Player_Melee: IsBusy), read as the kit failing. His
 *    hand `use item="Excellent Healing Kit"` then armed target mode and the routine's Marionette pick took it: "You
 *    can't heal that!".
 * 3. "turning to face … then 5–9 s before the bolt": each log line was stamped when its step ENDED (a bolt's step is its
 *    whole cast, ~3.5 s to the server's UseDone), and a bolt with no damage line was waited on the full 8 s.
 * 4. stay_with "Claude Bulwark is out of sight (too far behind, or not a fellow)": he had logged out 0.1 s before.
 * 5. Bulwark's walks stopped for "packs" of Marionettes L26–35 (him L48) that his routine killed at once.
 * 6. Mana stones listed with no charge: Arcanist used empty ones on his empty bracelets ("That item doesn't have enough
 *    Mana").
 * 7. Max mana 78↔98 and stamina 258↔278 with no word why (Feeblemind / Frailty Other III); attack's far=true leash.
 *
 * Drives the real AgentApi / RoutineEngine / VtMacro / planBuffs on the fake host with the stream's real profiles and
 * the real end-of-retail spell table (DAT-gated). Item 4 is a logout, not a route, so no cell DAT is needed for it.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSkill, PlanSpell, RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { ALL_MODULES_OFF } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { BEYOND_MACRO_DEFAULTS } from '../packages/renderer/src/agent/beyondVtank.ts';
import { formatInventory, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { buildBuffFamilies, planBuffs, type BuffFamilies } from '../packages/renderer/src/agent/macro/buffPlan.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
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
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
const FULL_SCHOOLS: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };
const ME = 0x50000001;

// Arcanist at 06:16Z (his character sheet): the magic schools at 255 buffed, Melee Defense untrained at 101.
const ARCANIST_SKILLS = [
  { id: 33, name: 'Life Magic', training: 'trained', base: 217, buffed: 255 },
  { id: 34, name: 'War Magic', training: 'specialized', base: 268, buffed: 316 },
  { id: 31, name: 'Creature Enchantment', training: 'trained', base: 217, buffed: 255 },
  { id: 32, name: 'Item Enchantment', training: 'trained', base: 217, buffed: 255 },
  { id: 6, name: 'Melee Defense', training: 'untrained', base: 101, buffed: 101 },
] as const;

describe.skipIf(!existsSync(DAT_PATHS.portal))('1. Invulnerability Self on the real end-of-retail spell table (needs DAT files)', () => {
  let table: Table;
  let families: BuffFamilies;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  const plan = (name: string): PlanSpell => {
    const k = id(name), s = table.spells.get(k)!;
    return { id: k, name: s.name, school: FULL_SCHOOLS[s.school], category: s.category, power: s.power, self: (s.bitfield & 0x8) !== 0, buff: (s.bitfield & 0x4) !== 0 && (s.duration ?? 0) !== 0 } as PlanSpell;
  };
  const skills = (): PlanSkill[] => ARCANIST_SKILLS.map((s) => ({ ...s }));
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
    families = buildBuffFamilies(table);
  });

  describe('planBuffs', () => {
    const input = (over: Partial<Parameters<typeof planBuffs>[0]> = {}): Parameters<typeof planBuffs>[0] => ({
      spells: [plan('Invulnerability Self IV'), plan('Invulnerability Self VI')], skills: skills(), active: [], settings: {},
      extraBuffs: [], blacklistedBuffs: [], idle: false, families, ...over,
    });

    it('the cause: Melee Defense untrained, so VTank never wants the family; it is reported as untrained, not dropped silently', () => {
      const b = planBuffs(input());
      expect(b.wanted.map((x) => x.spell.name)).toEqual([]);
      expect(b.untrained.map((x) => [x.skill, x.spell.name])).toEqual([['Melee Defense', 'Invulnerability Self VI']]);
    });

    it('with Extra Buff Spells (mage.json) and the 75% landing bar: IV, with VI named at 59%', () => {
      const extra = ready('mage').vtank!.extraBuffs;
      expect(extra).toEqual(['Invulnerability Self IV']);
      const b = planBuffs(input({ extraBuffs: extra, minChance: 0.75 }));
      expect(b.wanted.map((x) => x.spell.name)).toEqual(['Invulnerability Self IV']);
      expect(b.untrained).toEqual([]);
      const st = b.wanted[0].stronger!;
      expect(st.spell.name).toBe('Invulnerability Self VI');
      expect(Math.round(st.chance! * 100)).toBe(59);
      expect(st.bar).toBe(0.75);
    });

    it('VTank\'s rule alone (no bar) takes VI: 250 + SpellDiffExcessThreshold-Buff 5 is within 255', () => {
      const b = planBuffs(input({ extraBuffs: ['Invulnerability Self IV'] }));
      expect(b.wanted.map((x) => x.spell.name)).toEqual(['Invulnerability Self VI']);
    });

    it('an Extra Buff Spells name with no level finds its family too', () => {
      const b = planBuffs(input({ extraBuffs: ['Invulnerability Self'], minChance: 0.75 }));
      expect(b.wanted.map((x) => x.spell.name)).toEqual(['Invulnerability Self IV']);
    });

    it('sweep, every family: Impenetrability VI (Item Enchantment 255 against 250, cast twice at 06:18:57–06:19:03Z) gives way to V under the bar', () => {
      const b = planBuffs(input({ spells: [plan('Impenetrability V'), plan('Impenetrability VI')], minChance: 0.75 }));
      expect(b.wanted.map((x) => x.spell.name)).toEqual(['Impenetrability V']);
      expect(planBuffs(input({ spells: [plan('Impenetrability V'), plan('Impenetrability VI')] })).wanted.map((x) => x.spell.name)).toEqual(['Impenetrability VI']);
    });

    it('a level that lands at 75% or better is kept (VI with Creature Enchantment 270 is 93%)', () => {
      const s = skills().map((x) => (x.id === 31 ? { ...x, buffed: 270 } : x));
      const b = planBuffs(input({ skills: s, extraBuffs: ['Invulnerability Self IV'], minChance: 0.75 }));
      expect(b.wanted.map((x) => x.spell.name)).toEqual(['Invulnerability Self VI']);
      expect(BEYOND_MACRO_DEFAULTS.BuffMinLandChance).toBe(75);
    });
  });

  describe('the routine ("Arcanist fights")', () => {
    let host: FakeHost;
    let api: AgentApi;
    const know = (names: string[]) => {
      const ids = names.map(id);
      host.spells = () => ids.map((k) => {
        const s = table.spells.get(k)!;
        return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
      });
    };
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      host = new FakeHost();
      host.me.name = 'Claude Arcanist';
      host.me.level = 50;
      (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
      (host as unknown as { skillList: () => unknown[] }).skillList = () => [...ARCANIST_SKILLS];
      for (const s of ARCANIST_SKILLS) host.skills.set(s.id, { base: s.base, buffed: s.buffed });
      host.me.combatMode = 'magic';
      host.me.health = { current: 183, max: 183 };
      host.me.mana = { current: 329, max: 329 };
      host.inv = [{ guid: 0x8000b535, name: 'Wand', where: 'equipped', slot: 'Held', mask: 0x01000000, validLocations: 0x01000000, itemType: 0x8000 }];
      know(['Invulnerability Self IV', 'Invulnerability Self VI']);
      host.cast = (spell: number, t: number | null) => {
        host.sent.push(`cast ${spell} ${t === null ? 'self' : t.toString(16)}`);
        const s = table.spells.get(spell)!;
        setTimeout(() => {
          api.pushChat(`You cast ${s.name} on yourself, refreshing ${s.name}`, 0x07);
          host.buffs = host.buffs.map((b) => (b.name.startsWith('Invulnerability Self') ? { spellId: spell, name: s.name, remaining: 1800, beneficial: true } : b));
        }, 1500);
        return true;
      };
      api = new AgentApi(host);
    });
    afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it('06:26:46Z, Invulnerability Self IV at 1m44s: the routine recasts IV (not VI at 59%) and the log says why', async () => {
      host.buffs = [{ spellId: id('Invulnerability Self IV'), name: 'Invulnerability Self IV', remaining: 104, beneficial: true }];
      api.routine.start(ready('mage'));
      await step(api, host, 12_000);
      const casts = host.sent.filter((x) => x.startsWith('cast '));
      expect(casts, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toContain(`cast ${id('Invulnerability Self IV')} self`);
      expect(casts).not.toContain(`cast ${id('Invulnerability Self VI')} self`);
      expect(api.routine.history().join('\n')).toMatch(/buff: Extra Buff Spells \(Invulnerability Self IV: the best you land reliably; Invulnerability Self VI is 59% to land \(your Creature Enchantment 255 against its 250\), under the 75% BuffMinLandChance/);
    });

    it('without the Extra Buff Spells entry: not cast, and the log says once that its skill is untrained', async () => {
      host.buffs = [{ spellId: id('Invulnerability Self IV'), name: 'Invulnerability Self IV', remaining: 104, beneficial: true }];
      const p = ready('mage');
      api.routine.start({ ...p, vtank: { ...p.vtank!, extraBuffs: [] } });
      await step(api, host, 12_000);
      expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
      const log = api.routine.history().join('\n');
      expect(log).toMatch(/buff: not kept up, the skill untrained \(VTank buffs trained skills only; Extra Buff Spells adds one\): Invulnerability Self \(Melee Defense untrained\)/);
      expect(log.match(/not kept up, the skill untrained/g)).toHaveLength(1);
    });

    it('3. the log line of a bolt is stamped when it began, with how long it ran (was: at its end, read as a 5–9 s wait after the turn)', async () => {
      know(['Flame Bolt I']);
      const DOLL = 0x800075fc;
      host.add({ guid: DOLL, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 32, level: 35 });
      let busyUntil = -1;
      host.busy = () => host.t < busyUntil;
      host.cast = (spell: number, t: number | null) => {
        host.sent.push(`cast ${spell} ${t === null ? 'self' : t.toString(16)}`);
        busyUntil = host.t + 3900;
        setTimeout(() => { api.pushChat('Casting Flame Bolt I', 0x11); api.pushChat('You say, "Zojak Quaguz"', 0x11); }, 400);
        setTimeout(() => api.pushChat('You burn Dark Marionette for 43 points with Flame Bolt I.', 0x15), 3000);
        return true;
      };
      vi.setSystemTime(new Date('2026-10-18T07:14:18.000Z'));
      const p = ready('mage');
      api.routine.start({ ...p, settings: { ...p.settings, OnlyEngaged: false, EnableBuffing: false, UseBreakableTurnTo: false } });
      await step(api, host, 6000);
      const line = api.routine.history().find((l) => /Flame Bolt I/.test(l) && /\(took \d+\.\d s\)/.test(l));
      expect(line, api.routine.history().join('\n')).toBeDefined();
      expect(line).toMatch(/^07:14:1[89] combat: .*: casting Flame Bolt I at Dark Marionette.* \(took [34]\.\d s\)$/);
    });
  });
});

describe('2. a kit mid-fight: no attack request goes out while the use is in progress, and a bare kit use goes on you', () => {
  const MARIONETTE = 0x80007618, KIT = 0x80007476, STONE = 0x800034f4;
  let host: FakeHost;
  let api: AgentApi;
  let busyUntil: number;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Bulwark', level: 48, combatMode: 'melee', health: { current: 79, max: 192 } };
    host.add({ guid: MARIONETTE, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.2, level: 26 });
    busyUntil = -1;
    host.busy = () => host.t < busyUntil;
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the attack task holds its next request while the client is busy with a use (ACE answers it "You\'re too busy!"), then sends it', async () => {
    const r = api.attack(MARIONETTE);
    expect(r.ok).toBe(true);
    await step(api, host, 300);
    expect(host.sent.filter((s) => s.startsWith('attack '))).toHaveLength(1);
    // The swing ends (AttackDone) and the routine's kit goes out: the client is busy until the server's UseDone, 2.5 s on.
    host.pending = false;
    busyUntil = host.t + 2500;
    await step(api, host, 2400);
    expect(host.sent.filter((s) => s.startsWith('attack ')), host.sent.join('\n')).toHaveLength(1);
    await step(api, host, 2000);
    expect(host.sent.filter((s) => s.startsWith('attack '))).toHaveLength(2);
  });

  it('without a use in progress the next request goes out as before (1.5 s after the last ended)', async () => {
    api.attack(MARIONETTE);
    await step(api, host, 300);
    host.pending = false;
    await step(api, host, 1800);
    expect(host.sent.filter((s) => s.startsWith('attack '))).toHaveLength(2);
  });

  it('use item="Excellent Healing Kit" with a Marionette selected heals you: a use-with-target on you, never the plain use that arms target mode', async () => {
    host.inv = [{ guid: KIT, name: 'Excellent Healing Kit', where: 'main pack', itemType: 0x80, objectDescFlags: 0x10000 }];
    host.add({ guid: KIT, name: 'Excellent Healing Kit', itemType: 0x80, objectDescFlags: 0x10000, useability: 0x002c0008, containerId: ME, cell: null });
    host.target = MARIONETTE;
    host.useWithTarget = (s: number, t: number) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => api.pushChat('You heal yourself for 81 Health points. Your Excellent Healing Kit has 5 uses left.', 0x1a), 1000);
      return true;
    };
    const r = await settle(api, host, api.use('Excellent Healing Kit'), 15_000);
    expect(host.sent).toContain(`usewith ${KIT.toString(16)} ${ME.toString(16)}`);
    expect(host.sent).not.toContain(`use ${KIT.toString(16)}`);
    expect(r?.message).toMatch(/^used Excellent Healing Kit on yourself:\n {2}You heal yourself for 81 Health points/);
    expect(r?.message).toMatch(/a healing kit used with no target goes on you/);
  });

  it('sweep: another carried item used ON something (a mana stone) is not sent as a plain use; the reply says use_on', async () => {
    host.inv = [{ guid: STONE, name: 'Mana Stone', where: 'main pack', itemType: 0x80000, uiEffects: 0 }];
    host.add({ guid: STONE, name: 'Mana Stone', itemType: 0x80000, objectDescFlags: 0, useability: 0x000a0008, containerId: ME, cell: null });
    host.target = MARIONETTE;
    const r = await settle(api, host, api.use('Mana Stone'), 5_000);
    expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^Mana Stone not used: it is used on something.*ac_use_on item="Mana Stone" target=<what to use it on> \(target=self shares a charged stone/);
  });
});

describe('3. bolts: the cast is over once the client is free and a short flight has passed; the routine\'s log says how long a step took', () => {
  const DOLL = 0x800075fc;
  let host: FakeHost;
  let api: AgentApi;
  let busyUntil: number;
  let hitAt: number | null;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', level: 51, combatMode: 'magic', mana: { current: 300, max: 329 } };
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 30 }];
    host.add({ guid: DOLL, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 32, level: 35 });
    busyUntil = -1;
    hitAt = null;
    host.busy = () => host.t < busyUntil;
    // As the live client: the send holds the busy count until the server's UseDone ~3.9 s on (07:14:18.08 → 21.99Z).
    host.cast = (spell: number, t: number | null) => {
      host.sent.push(`cast ${spell} ${t === null ? 'self' : t!.toString(16)}`);
      busyUntil = host.t + 3900;
      setTimeout(() => { api.pushChat('Casting Flame Bolt I', 0x11); api.pushChat('You say, "Zojak Quaguz"', 0x11); }, 400);
      if (hitAt !== null) setTimeout(() => api.pushChat('You burn Dark Marionette for 43 points with Flame Bolt I.', 0x15), hitAt);
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a bolt with no damage line ends 1.5 s after the client is free (was the full 8 s)', async () => {
    const t0 = host.t;
    const r = await settle(api, host, api.cast('Flame Bolt I', DOLL), 12_000);
    expect(r?.message).toMatch(/no hit seen/);
    expect(host.t - t0).toBeGreaterThanOrEqual(3900 + 1500);
    expect(host.t - t0).toBeLessThan(6500);
  });

  it('a hit that comes before the UseDone is the outcome, as before', async () => {
    hitAt = 3000;
    const r = await settle(api, host, api.cast('Flame Bolt I', DOLL), 12_000);
    expect(r?.message.split('\n')[1]).toBe('  You burn Dark Marionette for 43 points with Flame Bolt I.');
  });

  it('a late hit inside the flight wait still counts', async () => {
    hitAt = 4800;
    const r = await settle(api, host, api.cast('Flame Bolt I', DOLL), 12_000);
    expect(r?.message).toMatch(/You burn Dark Marionette for 43 points/);
    expect(r?.message).not.toMatch(/no hit seen/);
  });

  it('a host that never says busy waits for the outcome as before (no early end)', async () => {
    host.busy = () => false;
    const t0 = host.t;
    const r = await settle(api, host, api.cast('Flame Bolt I', DOLL), 12_000);
    expect(r?.message).toMatch(/no hit seen/);
    expect(host.t - t0).toBeGreaterThanOrEqual(7500);
  });
});

describe('4. stay_with: a fellow who logged out is named as gone, not "out of sight"', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', level: 51 };
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 80, y: 120 });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('07:17:06Z: "Claude Bulwark has left your Fellowship." then the walk stops saying so', async () => {
    host.fellows = () => [];
    api.pushChat('Claude Bulwark has left your Fellowship.', 0x1a);
    const r = await settle(api, host, api.walkTo('Chest', { stayWith: 'Claude Bulwark' }), 20_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Claude Bulwark left your fellowship \d+ s ago \(logged out, or quit it\), so there is no one to stay with here: wait for them to come back, or ask in \/f where to meet them/);
  });

  it('a stay_with name that never was a fellow keeps the old answer', async () => {
    host.fellows = () => [];
    const r = await settle(api, host, api.walkTo('Chest', { stayWith: 'Claude Bulwark' }), 20_000);
    expect(r?.message).toMatch(/Claude Bulwark is out of sight \(too far behind, or not a fellow\)/);
  });
});

describe('5. a walk your routine covers: a pack of mild monsters well below you is walked on past; one at your level still stops it', () => {
  let host: FakeHost;
  let api: AgentApi;
  const fightProfile = (): RoutineProfile => ({
    name: 'Bulwark fights', modules: { ...ALL_MODULES_OFF, combat: true },
    initialState: 'Hunt', loot: [], buffSets: [], routes: [],
    states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }] }] }],
  });
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.level = 48; host.me.health = { current: 192, max: 192 };
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const walkTo = (): Promise<AgentResult> => (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}) as Promise<AgentResult>;
  const chasers = (list: Array<[string, number]>): number[] => list.map(([name, level], i) => {
    const g = 0x80007a00 + i;
    host.add({ guid: g, name, itemType: 0x10, objectDescFlags: 0x10, x: 100 + i, y: 20 + i * 2, level, seeks: { guid: ME, kind: 'move' } });
    return g;
  });
  const chase = (gs: number[]) => () => { for (const g of gs) { const o = host.objs.get(g)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } } };

  it('Marionette L26, Marionette L26, Dark Marionette L35 (him L48): walked on, the routine takes them', async () => {
    api.routine.start(fightProfile());
    const p = walkTo();
    const gs = chasers([['Marionette', 26], ['Marionette', 26], ['Dark Marionette', 35]]);
    const r = await settle(api, host, p, 40_000, chase(gs));
    expect(r?.message).toMatch(/^arrived/);
    expect(r?.message).toMatch(/passed 3 mild chasers \(Marionette ×2, Dark Marionette: well below you, nothing that hurt; your routine takes them\)/);
  });

  it('two Innocuous Dolls L46 and a Marionette: two weigh, no pack: walked on', async () => {
    api.routine.start(fightProfile());
    const p = walkTo();
    const gs = chasers([['Innocuous Doll', 46], ['Innocuous Doll', 46], ['Marionette', 26]]);
    const r = await settle(api, host, p, 40_000, chase(gs));
    expect(r?.message).toMatch(/^arrived/);
  });

  it('three Pristine Dolls L60 still stop it, saying the rule', async () => {
    api.routine.start(fightProfile());
    const p = walkTo();
    const gs = chasers([['Pristine Doll', 60], ['Pristine Doll', 60], ['Pristine Doll', 60]]);
    const r = await settle(api, host, p, 15_000, chase(gs));
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Pristine Doll #80007a0\d \(level 60\) is coming at you/);
    expect(r?.message).toMatch(/\(a pack: 3 near your level; your routine "[^"]+" takes mild ones\)\./);
  });

  it('a Dark Marionette whose kind\'s Lightning Bolt took 110 of 192 stops it, low level or not', async () => {
    api.routine.start(fightProfile());
    api.pushChat('Critical hit! Dark Marionette blasts you for 110 points with Lightning Bolt III.', 0x15);
    const p = walkTo();
    const gs = chasers([['Dark Marionette', 35]]);
    const r = await settle(api, host, p, 15_000, chase(gs));
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Dark Marionette #80007a00 \(level 35\) is coming at you/);
    expect(r?.message).toMatch(/\(its kind's Lightning Bolt III took 110 of your 192 health; your routine "[^"]+" takes mild ones\)\./);
  });

  it('six coming at once stop it whatever their levels (a crowd)', async () => {
    api.routine.start(fightProfile());
    const p = walkTo();
    const gs = chasers(Array.from({ length: 6 }, (): [string, number] => ['Marionette', 26]));
    const r = await settle(api, host, p, 15_000, chase(gs));
    expect(r?.message).toMatch(/\(a crowd of 6; your routine "[^"]+" takes mild ones\)\./);
  });
});

describe('6. mana stones: inventory and gear say each one\'s charge, and an empty one\'s refusal says why', () => {
  const STONE = 0x800034f4, CHARGED = 0x80004749, BRACELET = 0x8000e96c;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', level: 51 };
    host.inv = [
      { guid: STONE, name: 'Mana Stone', where: 'main pack', type: 'Mana Stone', itemType: 0x80000, uiEffects: 0, value: 50 },
      { guid: CHARGED, name: 'Minor Mana Stone', where: 'main pack', type: 'Mana Stone', itemType: 0x80000, uiEffects: 1, value: 250 },
      { guid: BRACELET, name: 'Bracelet', where: 'equipped', slot: 'LeftBracelet', itemType: 0x8 },
    ];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('before an appraisal, by the glow (UiEffects Magical, ACE ManaStone.SetUiEffect): EMPTY with how to charge, or charged', () => {
    const text = formatInventory(api.inventory());
    expect(text).toMatch(/#800034f4 Mana Stone {2}\(Mana Stone, value 50, EMPTY mana stone: holds no mana, so it fills nothing; charge it by using it on an item you don't need that holds mana \(ac_use_on the stone with target= that item\): it drains the item and the item is DESTROYED; a retained item refuses\)/);
    expect(text).toMatch(/#80004749 Minor Mana Stone {2}\(Mana Stone, value 250, charged: holds mana \(appraise it for how much\); ac_use_on it with target=self shares it among your worn items/);
  });

  it('after an appraisal, by ItemCurMana: the mana it holds, or empty with its efficiency', () => {
    host.appraised.push(STONE, CHARGED);
    host.appraisalDatas.set(STONE, { int: {}, float: { 87: 0.5 }, string: {}, bool: {}, did: {}, spells: [] });
    host.appraisalDatas.set(CHARGED, { int: { 107: 4496 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    const rows = api.inventory();
    expect(rows.find((i) => i.guid === STONE)?.manaStone).toEqual({ charged: false, efficiency: 0.5 });
    expect(rows.find((i) => i.guid === CHARGED)?.manaStone).toEqual({ charged: true, mana: 4496 });
    const text = formatInventory(rows);
    expect(text).toMatch(/EMPTY mana stone: .* \(it keeps 50% of the item's mana\)/);
    expect(text).toMatch(/Minor Mana Stone {2}\(Mana Stone, value 250, charged: 4,496 mana;/);
  });

  it('observe\'s gear-out-of-mana line names the stones, all empty here', () => {
    host.inv = host.inv.filter((i) => i.guid !== CHARGED);
    api.pushChat('Your Bracelet is out of Mana.', 0x1a);
    const text = formatObservation(api.observe());
    expect(text).toMatch(/gear out of mana \(its spells are off\): Bracelet #8000e96c: .*; your mana stones are all EMPTY \(Mana Stone #800034f4\): an empty stone gives nothing; charge it by using it on an item you don't need/);
  });

  it('use_on an empty stone on the empty bracelet: "That item doesn\'t have enough Mana." is explained, not left as the bracelet\'s fault', async () => {
    host.useWithTarget = (s: number, t: number) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => api.pushChat("That item doesn't have enough Mana.", 0x1a), 300);
      return true;
    };
    const r = await settle(api, host, api.useOnReported(STONE, BRACELET), 15_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^used Mana Stone on Bracelet:\n {2}That item doesn't have enough Mana\.\n {2}\(your Mana Stone is EMPTY: an empty stone gives no mana, it takes it: used on an item that holds mana it drains it and the item is destroyed; Bracelet has none to give\. Use a charged stone \(ac_inventory shows each stone's charge\), or charge this one by using it on an item you don't need/);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('7a. a lowered maximum vital names the debuff behind it (real spell table, needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Bulwark', level: 48, health: { current: 182, max: 182 }, stamina: { current: 99, max: 258 }, mana: { current: 78, max: 78 } };
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    // The end-of-retail SecondaryAttributeTable: Maximum Health and Stamina from Endurance (2), Mana from Self (6).
    host.vitalAttributes = () => ({ health: [2], stamina: [2], mana: [6] });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('07:15:23Z: Feeblemind (−20 Self) and Frailty (−20 Endurance) on him; Lightning Vulnerability and Weakness lower no vital', () => {
    host.buffs = [
      { spellId: id('Lightning Vulnerability Other III'), name: 'Lightning Vulnerability Other III', remaining: 30, beneficial: false },
      { spellId: id('Weakness Other III'), name: 'Weakness Other III', remaining: 49, beneficial: false },
      { spellId: id('Feeblemind Other III'), name: 'Feeblemind Other III', remaining: 70, beneficial: false },
      { spellId: id('Frailty Other III'), name: 'Frailty Other III', remaining: 97, beneficial: false },
    ];
    const text = formatObservation(api.observe());
    expect(text).toMatch(/\n {2}max mana 78 lowered by Feeblemind Other III \(−20 Self, which Maximum Mana is drawn from, 1m10s left\); max health 182 and stamina 258 lowered by Frailty Other III \(−20 Endurance, which Maximum Health and Stamina are drawn from, 1m37s left\): back up when it ends, or a dispel takes it off/);
    expect(text).not.toMatch(/lowered by (Weakness|Lightning Vulnerability)/);
  });

  it('no lowering debuff: no line', () => {
    host.buffs = [{ spellId: id('Weakness Other III'), name: 'Weakness Other III', remaining: 49, beneficial: false }];
    expect(formatObservation(api.observe())).not.toMatch(/lowered by/);
  });
});

describe('7b. attack past the fellow leash says the rule and its numbers', () => {
  const DOLL = 0x80007b75, ARCANIST = 0x500000a5;
  it('a Pristine Doll 54 m S with Arcanist 2 m away: the refusal names the 12 m / 15 m leash and far=true', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Bulwark', level: 48, combatMode: 'melee' };
    host.add({ guid: DOLL, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 20 - 54, level: 60 });
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 22 });
    host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: { cur: 183, max: 183 }, stamina: { cur: 200, max: 247 }, mana: { cur: 300, max: 329 } }];
    const api = new AgentApi(host);
    run(api, host, 200, { physics: false });
    const r = api.attack(DOLL);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Pristine Doll #80007b75 is 54 m S: running up to it leaves Claude Arcanist \(2 m from you now\) \d+ m behind, so no attack was started \(the fellow leash: past 12 m a melee attack runs up only when every fellow beside you stays within 15 m of you there; far=true lifts it\)\. /);
    expect(r.message).toMatch(/ac_attack target=#80007b75 far=true to go anyway$/);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
