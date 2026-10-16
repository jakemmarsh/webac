/**
 * Agent-tool fixes from the stream players' 2026-10-16 06:13Z reports (progress.md 2026-10-16, "fix7"):
 *  1. `spells filter=Other` listed the Swift Killer Others but none of the Blood Drinker Others: the page cut the
 *     matches at max (40) with no word that more matched.
 *  2. `wait timeout_s=120` outran the stream players' 120 s Bash limit: one ac_wait now runs 100 s at most and says so.
 *  3. A re-equipped Tower Shield "showed no sign of its spells activating": ACE sends no line when an item's spell
 *     lands on the item itself, so the equip reply now names the item's spells that are on.
 * Each drives the shipped tools / format / AgentApi code (fake host: tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatSpells } from '../packages/renderer/src/agent/format.ts';
import type { AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { AC_WAIT_MAX_S, TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost } from './_harness/agentFake.ts';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

/** A level-6 Arcanist's book in the order the client lists it: many "Other" spells before the Blood Drinkers. */
function arcanistBook(): AgentSpell[] {
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI'];
  const out: AgentSpell[] = [];
  let id = 1000;
  for (const fam of ['Strength Other', 'Endurance Other', 'Coordination Other', 'Quickness Other', 'Focus Other', 'Willpower Other']) {
    for (const r of roman) out.push({ id: id++, name: `${fam} ${r}`, school: 'Creature', level: roman.indexOf(r) + 1 });
  }
  for (const r of roman) out.push({ id: id++, name: `Aura of Swift Killer Other ${r}`, school: 'Item', level: roman.indexOf(r) + 1 });
  for (const r of roman) out.push({ id: id++, name: `Aura of Blood Drinker Other ${r}`, school: 'Item', level: roman.indexOf(r) + 1 });
  out.push({ id: id++, name: 'Flame Bolt I', school: 'War', level: 1 });
  return out;
}

/** A caller standing in for the page: its `spells` filters as AgentApi.spells does, through the real API. */
function pageCaller(api: AgentApi): ToolCaller & { calls: Array<{ method: string; args: unknown[]; timeoutMs?: number }> } {
  const calls: Array<{ method: string; args: unknown[]; timeoutMs?: number }> = [];
  return {
    calls,
    notice: null,
    async call<T>(method: string, args: unknown[] = [], timeoutMs?: number): Promise<T> {
      calls.push({ method, args, timeoutMs });
      if (method === 'spells') return api.spells(String(args[0] ?? ''), Number(args[1])) as T;
      if (method === 'wait') return [] as T;
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe('1. spells filter=Other: what is past max is said, not dropped', () => {
  it('the Blood Drinker Others that came after the 40th "Other" are counted, and max= shows them', async () => {
    const host = new FakeHost();
    const book = arcanistBook();
    host.spells = () => book;
    const api = new AgentApi(host);
    const c = pageCaller(api);
    const t = (await TOOL_CALLER.run(c, () => tool('ac_spells').run({ filter: 'Other' }))).text;
    expect(t).toContain('Aura of Swift Killer Other I');
    expect(t).not.toContain('Blood Drinker');
    expect(t.split('\n')).toHaveLength(41);
    expect(t.split('\n').at(-1)).toBe('  … 8 more match (48 in all): narrow the filter or pass max=48');
    // The tool asks the page for every match and cuts them itself.
    expect(c.calls[0]).toMatchObject({ method: 'spells', args: ['Other', 100_000] });
    const all = (await TOOL_CALLER.run(c, () => tool('ac_spells').run({ filter: 'Other', max: 48 }))).text;
    expect(all).toContain('Aura of Blood Drinker Other VI');
    expect(all).not.toContain('more match');
    const bd = (await TOOL_CALLER.run(c, () => tool('ac_spells').run({ filter: 'Drinker' }))).text;
    expect(bd.split('\n')).toHaveLength(6);
  });

  it('formatSpells without a max lists everything (the supervisor\'s and old callers\' shape)', () => {
    expect(formatSpells(arcanistBook()).split('\n')).toHaveLength(49);
    expect(formatSpells([])).toBe('(no matching spells)');
  });
});

describe('2. ac_wait answers inside a 120 s tool limit', () => {
  it(`timeout_s=120 runs ${AC_WAIT_MAX_S} s and says it was cut; 45 runs 45 with no note`, async () => {
    const c = pageCaller(new AgentApi(new FakeHost()));
    expect(AC_WAIT_MAX_S).toBeLessThanOrEqual(100);
    const long = (await TOOL_CALLER.run(c, () => tool('ac_wait').run({ timeout_s: 120 }))).text;
    expect(long).toBe('(nothing within 100 s)\n(timeout_s=120 was cut to 100 s, the longest one wait runs: call ac_wait again to keep waiting)');
    // The page waits 100 s and the RPC 5 s more: under 120 s of wall time with the CLI's start-up.
    expect(c.calls[0]).toMatchObject({ method: 'wait', args: [expect.anything(), 100_000], timeoutMs: 105_000 });
    expect((await TOOL_CALLER.run(c, () => tool('ac_wait').run({ timeout_s: 45 }))).text).toBe('(nothing within 45 s)');
    expect(c.calls[1].args[1]).toBe(45_000);
    expect(String((tool('ac_wait').props.timeout_s as { description: string }).description)).toContain('max 100');
  });
});

describe('3. equipping an item with spells says which are on', () => {
  const SHIELD = 0x80000d01;
  // Spell ids per ACE SpellId.cs (Impenetrability5 1485, BludgeonBane5 1515, FrostBane3 1525, WillpowerSelf3).
  const NAMES = new Map<number, string>([[1485, 'Impenetrability V'], [1515, 'Bludgeon Bane V'], [1525, 'Frost Bane III'], [1447, 'Willpower Self III'], [5000, 'Cast-on-strike Proc']]);
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map([...NAMES].map(([id, name]) => [id, { name, desc: '', category: 0, school: 3, bitfield: 0, power: 0 }])) });
    host.inv = [{ guid: SHIELD, name: 'Tower Shield', where: 'main pack', uiEffects: 0x1 }];
    host.wield = (g) => { host.inv = [{ ...host.inv[0], where: 'equipped' }]; return g === SHIELD; };
  });
  afterEach(() => vi.useRealTimers());

  it('the Tower Shield\'s Impenetrability V, Bludgeon Bane V and Frost Bane III (on the shield: ACE says nothing) are named', async () => {
    // The quiet appraisal's answer after the wield: ACE AppraiseInfo.AddEnchantments lists the shield's enchantments.
    host.appraise = (g, quiet) => {
      host.appraiseCalls.push({ guid: g, quiet: !!quiet });
      host.appraised.push(g);
      host.appraisalDatas.set(g, { int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [], spellIds: [1485, 1515, 1525], activeSpellIds: [1485, 1515, 1525] });
    };
    const p = api.equip('Tower Shield');
    await vi.advanceTimersByTimeAsync(6000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^equipped Tower Shield/);
    expect(r.message).toContain('\n  its spells now on: Impenetrability V, Bludgeon Bane V, Frost Bane III');
    expect(r.message).not.toContain('not on:');
    expect(host.appraiseCalls).toEqual([{ guid: SHIELD, quiet: true }]);
  });

  it('a spell on you counts (your enchantments); one on neither is named as not on', async () => {
    host.buffs = [{ spellId: 1447, name: 'Willpower Self III', remaining: -1 }];
    host.appraise = (g) => {
      host.appraised.push(g);
      host.appraisalDatas.set(g, { int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [], spellIds: [1485, 1447, 5000], activeSpellIds: [1485] });
    };
    const p = api.equip('Tower Shield');
    await vi.advanceTimersByTimeAsync(6000);
    const msg = (await p).message;
    expect(msg).toContain('its spells now on: Impenetrability V, Willpower Self III');
    expect(msg).toMatch(/\n {2}not on: Cast-on-strike Proc \(/);
  });

  it('a plain item (not magical, never appraised) is not appraised and the reply is unchanged', async () => {
    host.inv = [{ guid: SHIELD, name: 'Tower Shield', where: 'main pack' }];
    const p = api.equip('Tower Shield');
    await vi.advanceTimersByTimeAsync(6000);
    expect((await p).message).toBe('equipped Tower Shield');
    expect(host.appraiseCalls).toEqual([]);
  });
});
