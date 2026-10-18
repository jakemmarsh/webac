/**
 * Stream reports, 2026-10-17 17:10Z (segment 2, 16:08–17:10Z, build 7bddbaec; Claude Arcanist and Claude Bulwark on the
 * local end-of-retail ACE server, Tusker Habitat 0x5B47). Each item's cause, from the transcripts and page logs:
 *
 * 1. Arcanist's "late wakes": of his 95 waits, 17 handed back events 10–42 s old, and every one of those returned at
 *    once (0.2–0.5 s): the events had queued while he ran other calls (repeat casts of 5–12 s, buffs, says, raises),
 *    since a wait counts from the last look. No wait that slept woke more than 3 s after its event (no delivery delay
 *    in the daemon or page). They came oldest first, with target-died lines his own casts had already reported and a
 *    task-done for a cast that had answered "not needed" in 0.3 s. Now such a wait starts with a NOW line (who is on
 *    you, who died since, your selection, vitals, fellows), an old target-died says when and that your cast said so,
 *    and a task-done its call answered is never handed back.
 * 2. Arcane Enlightenment Self V fizzled twice (16:56:07Z, 16:57:01Z, WeenieError 0x402) at "253 against 200: about
 *    98%". The chance is right: ACE rolls CreatureSkill.Current, round((Focus 228 + Self 229) / 4) = 114, + 114 init
 *    and ranks, + 5 Jack of All Trades (PropertyInt 326 = 1 in the shard), + 20 Creature Enchantment Mastery III = 253;
 *    SkillCheck.GetMagicSkillChance(253, 200) = 97.6%. No vitae then, every buff up. 3 fizzles in about 259 casts.
 * 3. "Run 204 → 205" was right: Quickness 112 → 113 at 16:56:00Z had moved Run's base 203 → 204 (Run is Quickness / 1),
 *    and the server said "Your base Run skill is now 205!". An attribute raise now names the skills it moves.
 * 4. "up 2m" (observe: the Liberator's feet 2 m over Bulwark's) and the attack's "drops 2 m to the floor below" measured
 *    different things: the doorway route to its ledge came down onto it by a 2 m drop from higher up. The run-up note now
 *    says the target's height from you, and where the drop lands from your floor.
 * 5. Bulwark's stay_with walks stopped 13 times on aggro: 10 for Liberators that reached him within seconds, 1 for a
 *    pack-mate of the one he walked to, and 2 for chasers on another floor (#8000cac9 9 m up, which never got down;
 *    #80000f68 7 m down). A chaser a storey off no longer stops a walk; it does once it is on your floor.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, magicSkillChance, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { formatEvents } from '../packages/renderer/src/agent/format.ts';
import { GameUI } from '../packages/renderer/src/ui/GameUI.ts';
import { SkillTable, type SkillBase } from '../packages/dat-parser/src/file-types/SkillTable.ts';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.ts';
import { computeSkillFormula } from '@ac/shared';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const ARC = 0x500000a3, BULWARK = 0x500000a4;
const LIB = (guid: number, o: Partial<AgentHostObject> = {}): Partial<AgentHostObject> & { guid: number; name: string } =>
  ({ guid, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, level: 60, ...o });

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, maxMs = 30_000, each?: () => void): Promise<T> {
  let out: T | undefined;
  let done = false;
  void p.then((r) => { out = r; done = true; });
  for (let t = 0; t < maxMs && !done; t += 100) { each?.(); run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(0); }
  if (!done) throw new Error('never answered');
  return out as T;
}

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = new FakeHost();
  api = new AgentApi(host);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. a wait whose events piled up says how things stand now, first', () => {
  const CB3C = 0x8000cb3c, CB18 = 0x8000cb18, CB99 = 0x8000cb99;
  beforeEach(() => {
    host.me.name = 'Claude Arcanist'; host.me.guid = ARC; host.me.level = 47;
    host.me.health = { current: 173, max: 177 }; host.me.mana = { current: 330, max: 331 };
    host.spells = () => [{ id: 84, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 60 }];
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: { cur: 182, max: 192 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
  });

  it('16:56:07Z: a NOW head (who is on you, who died, vitals), an old kill says when and that the cast said so, no answered task-done', async () => {
    // #cb3c dies before the bolt: the repeat cast answers "not needed" at once, and reports the kill.
    host.add(LIB(CB3C, { x: 82, y: 24 }));
    run(api, host, 300, { physics: false });
    host.dying.add(CB3C);
    const r = await settle(api, host, api.cast('Flame Bolt V', CB3C, { repeat: true }));
    expect(r.message.split('\n')[0]).toBe('Flame Bolt V not needed: Tusker Liberator died before your first cast at it (no cast made, no mana spent; pick the next target)');
    api.push('target-died', `Tusker Liberator #${CB3C.toString(16)} died`, CB3C);
    host.objs.delete(CB3C);
    // Meanwhile #cb18 comes at him (its aggro the page's own) and starts swinging; #cb99 comes too, then dies to Bulwark.
    host.add(LIB(CB18, { x: 80, y: 22, seeks: { guid: ARC, kind: 'move' } }));
    host.add(LIB(CB99, { x: 78, y: 18 }));
    api.push('aggro', 'Tusker Liberator #8000cb99 (level 60) is coming at you, 3 m S (running at you)', CB99);
    run(api, host, 22_000, { physics: false });
    host.dying.add(CB99);
    host.me.health = { current: 105, max: 177 };
    api.pushChat('Tusker Liberator grazes your abdomen for 3 points of bludgeoning damage!', 0x15);
    run(api, host, 1000, { physics: false });
    const p = api.wait({ types: ['task-done', 'target-died', 'aggro'] }, 10);
    vi.advanceTimersByTime(20);
    const evs = await p;
    expect(evs[0].type).toBe('now');
    expect(evs[0].text).toMatch(/^2 events came over the last 2[34] s, while you weren't waiting \(your other calls ran meanwhile\); they follow oldest first\. As of now: 1 attacking you: Tusker Liberator #8000cb18 \(1× in 10 s\); dead since your last look: (Tusker Liberator|creature) #8000cb3c, Tusker Liberator #8000cb99; you: health 105\/177 \(59%\), mana 330\/331 \(100%\); fellows: Claude Bulwark 95%$/);
    // The kill his own cast reported, read 23 s late: when, and that the cast said so. The cast's task-done is gone, and
    // so is the aggro of the Liberator that died since.
    expect(evs.slice(1).map((e) => `${e.type}: ${e.text}`)).toEqual([
      'target-died: Tusker Liberator #8000cb3c died [23 s ago; your cast\'s reply said so]',
      expect.stringMatching(/^aggro: Tusker Liberator #8000cb18 \(level 60\) is coming at you, 2 m N \(running at you\) \[23 s ago; now 2 m N of you\]$/),
    ]);
    expect(formatEvents(evs).split('\n')[0]).toMatch(/^ {2}NOW: 2 events came over the last/);
  });

  it('fresh events (under 10 s old) come with no head', async () => {
    host.add(LIB(CB18, { x: 80, y: 30, seeks: { guid: ARC, kind: 'move' } }));
    api.push('aggro', 'Tusker Liberator #8000cb18 (level 60) is coming at you, 10 m N (running at you)', CB18);
    run(api, host, 4000, { physics: false });
    const p = api.wait({ types: ['aggro'] }, 10);
    vi.advanceTimersByTime(20);
    const evs = await p;
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.some((e) => e.type === 'now')).toBe(false);
  });

  it('a quick task-done reaches a wait asked beside its call, never a later one (16:55:50Z "not needed", read at 16:56:13Z)', async () => {
    host.add(LIB(CB3C, { x: 82, y: 24 }));
    run(api, host, 300, { physics: false });
    host.dying.add(CB3C);
    const beside = api.wait({ types: ['task-done'] }, 5000);
    const r = await settle(api, host, api.cast('Flame Bolt V', CB3C, { repeat: true }));
    expect(r.message).toMatch(/not needed/);
    expect((await beside).map((e) => e.type)).toEqual(['task-done']);
    // No newer task started (a say, a raise and plain casts start none): still history for a later wait.
    run(api, host, 20_000, { physics: false });
    const later = api.wait({ types: ['task-done'], sinceSeq: 0 }, 1000);
    vi.advanceTimersByTime(1100);
    expect(await later).toEqual([]);
  });
});

describe('2. the fizzle chance said is ACE\'s, from the skill the server rolls', () => {
  it('GetMagicSkillChance(253, 200) is 97.6%: two fizzles in a row are about 0.06%, three in ~259 casts about what 2% gives', () => {
    const c = magicSkillChance(253, 200);
    expect(c).toBeCloseTo(0.9766, 3);
    expect(Math.round(c * 100)).toBe(98);
    expect((1 - c) ** 2).toBeCloseTo(0.00055, 4);
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('the end-of-retail DAT: Arcane Enlightenment Self V and Creature Enchantment\'s formula', () => {
    let spells: SpellTable;
    let skills: SkillTable;
    beforeAll(() => {
      const db = openDat(DAT_PATHS.portal);
      spells = new SpellTable(db.getReader(0x0e00000e));
      skills = new SkillTable(db.getReader(0x0e000004));
    });

    it('power 200, Creature Enchantment (school 4); his 253 is round((228 + 229) / 4) + 114 + 5 (Jack of All Trades) + 20', () => {
      const ae = spells.spells.get(682)!;
      expect(ae.name).toBe('Arcane Enlightenment Self V');
      expect(ae.power).toBe(200);
      expect(ae.school).toBe(4);
      const f = skills.skills.get(31)!.formula; // Creature Enchantment
      const attr = (v: Record<number, number>) => (id: number): number => v[id] ?? 0;
      const buffed = computeSkillFormula(f, attr({ 5: 228, 6: 229 }));
      const base = computeSkillFormula(f, attr({ 5: 198, 6: 199 }));
      expect(buffed).toBe(114);
      // The sheet's base 213 = formula(base attributes) + init + ranks.
      const initRanks = 213 - base;
      expect(buffed + initRanks + 5 + 20).toBe(253);
    });
  });
});

describe('3. an attribute raise names the skills whose base it moves', () => {
  const run1: SkillBase['formula'] = { w: 0, x: 1, y: 0, z: 1, attr1: 3, attr2: 0 };

  it('Quickness 112 → 113 moves Run 203 → 204 (a synthetic Run: Quickness / 1)', () => {
    const table = new Map([[24, { formula: run1 } as SkillBase], [31, { formula: { w: 0, x: 1, y: 1, z: 4, attr1: 5, attr2: 6 } } as SkillBase]]);
    const attrs = { quickness: { base: 112 }, focus: { base: 198 }, self: { base: 199 } };
    const skills = [
      { id: 24, name: 'Run', status: 'Trained', base: 203 },
      { id: 31, name: 'Creature Enchantment', status: 'Trained', base: 213 },
    ];
    expect(GameUI.attributeRaiseSkillShifts(3, attrs, skills, table)).toEqual([{ name: 'Run', from: 203, to: 204 }]);
    // Focus 198 → 199: (199 + 199) / 4 = 99.5 rounds to 100 (from 99.25 → 99): Creature Enchantment moves too.
    expect(GameUI.attributeRaiseSkillShifts(5, attrs, skills, table)).toEqual([{ name: 'Creature Enchantment', from: 213, to: 214 }]);
    // An untrained skill isn't named.
    expect(GameUI.attributeRaiseSkillShifts(3, attrs, [{ id: 24, name: 'Run', status: 'Untrained', base: 203 }], table)).toEqual([]);
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('the end-of-retail SkillTable', () => {
    let skills: SkillTable;
    beforeAll(() => { skills = new SkillTable(openDat(DAT_PATHS.portal).getReader(0x0e000004)); });
    it('Run is Quickness / 1: Arcanist\'s Quickness raise moved it 203 → 204', () => {
      const attrs = { strength: { base: 129 }, endurance: { base: 127 }, quickness: { base: 112 }, coordination: { base: 89 }, focus: { base: 198 }, self: { base: 199 } };
      expect(GameUI.attributeRaiseSkillShifts(3, attrs, [{ id: 24, name: 'Run', status: 'Trained', base: 203 }], skills.skills)).toEqual([{ name: 'Run', from: 203, to: 204 }]);
    });
  });

  it('the raise reply says it: "Quickness 112 → 113 (…); with it the base of Run 203 → 204"', () => {
    host.raise = () => ({ ok: true, message: 'raised Quickness 112 → 113 (63,637 XP)', name: 'Quickness', from: 112, to: 113, cost: 63_637, shifts: [{ name: 'Run', from: 203, to: 204 }] });
    expect(api.raise('quickness').message).toBe('Quickness 112 → 113 (1 raise, 63,637 XP); with it the base of Run 203 → 204');
    let q = 112;
    host.raise = () => { q++; return { ok: true, message: '', name: 'Quickness', from: q - 1, to: q, cost: 100, shifts: [{ name: 'Run', from: q + 90, to: q + 91 }] }; };
    expect(api.raise('quickness', 2).message).toBe('Quickness 112 → 114 (2 raises: 100 + 100 = 200 XP); with it the base of Run 203 → 205');
  });
});

describe('4. the run-up note says each height from you', () => {
  const UPPER = 0xa9b40150, LEDGE = 0xa9b40151;
  const D7C1 = 0x8000d7c1;
  beforeEach(() => {
    host.me.combatMode = 'melee';
    host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    host.attackPending = () => false;
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 160, max: 166 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 69.5, y: 20.2, z: 100 });
  });

  it('16:33:46Z: a Liberator 2 m up, reached by a 2 m drop from higher up: "2 m up from you", landing "2 m up from your floor"', () => {
    host.add(LIB(D7C1, { cell: LEDGE, x: 61, y: 20, z: 102 }));
    host.routeTo = [{ x: 66, y: 20, z: 104, drop: 2, landing: 102 } as { x: number; y: number; z: number }];
    run(api, host, 200, { physics: false });
    const r = api.attack(D7C1);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('the run-up to Tusker Liberator #8000d7c1 (2 m up from you) has a one-way 2.0 m drop on the way, landing 2 m up from your floor, leaving Claude Arcanist (1 m from you) on this floor, so no attack was started. Let it come to you, or go down together: tell them you\'re dropping (ac_say text="/f dropping here, come down after me"), and with them beside you at the edge, ac_attack target=#8000d7c1 far=true drop=true (they come down after you)');
  });

  it('heightFromYou: "at your height" under a metre', () => {
    expect(AgentApi.heightFromYou(0.4)).toBe('at your height');
    expect(AgentApi.heightFromYou(-3.2)).toBe('3 m down from you');
    expect(AgentApi.heightFromYou(0.2, 'your floor')).toBe("at your floor's height");
  });
});

describe('5. a chaser a storey off doesn\'t stop a walk; on your floor it does', () => {
  const CAC9 = 0x8000cac9, UPSTAIRS = 0xa9b40150;
  let surface: Record<string, (...a: unknown[]) => Promise<AgentResult>>;
  beforeEach(() => {
    host.me.level = 45;
    surface = api.surface() as unknown as typeof surface;
  });

  it('16:34:53Z: #8000cac9 running at him from 9 m up: the walk goes on; once it is down on his floor, it stops', async () => {
    host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 120 });
    const lib = host.add(LIB(CAC9, { cell: UPSTAIRS, x: 95, y: 40, z: host.me.z + 9 }));
    let n = 0;
    const r = await settle(api, host, surface.walkTo('Far Post'), 40_000, () => {
      if (++n === 5) lib.seeks = { guid: host.me.guid, kind: 'move' };
      if (n === 5) { lib.x = host.me.x + 6; lib.y = host.me.y; }
      // Keeps over him, a floor up, until it finds the way down.
      if (n > 5 && n < 60) { lib.x = host.me.x + 6; lib.y = host.me.y; }
      if (n === 60) Object.assign(lib, { cell: host.me.cell, x: host.me.x + 15, y: host.me.y, z: host.me.z });
    });
    expect(n).toBeGreaterThanOrEqual(60);
    expect(r).toMatchObject({ ok: false, aggro: true });
    expect(r.message).toMatch(/^stopped [0-9.]+ m short: Tusker Liberator #8000cac9 \(level 60\) is coming at you, 15 m E \(running at you\)/);
  });

  it('a caster turned to face you from another floor still stops it (a floor doesn\'t stop a spell)', async () => {
    host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 120 });
    const lib = host.add(LIB(CAC9, { name: 'Tusker Redeemer', cell: UPSTAIRS, x: 95, y: 40, z: host.me.z + 9 }));
    let n = 0;
    const r = await settle(api, host, surface.walkTo('Far Post'), 40_000, () => {
      if (++n === 5) lib.seeks = { guid: host.me.guid, kind: 'turn' };
      lib.x = host.me.x + 8; lib.y = host.me.y;
    });
    expect(r).toMatchObject({ ok: false, aggro: true });
    expect(r.message).toMatch(/Tusker Redeemer #8000cac9 \(level 60\) is coming at you, 8 m E \(turned to face you\)/);
  });
});
