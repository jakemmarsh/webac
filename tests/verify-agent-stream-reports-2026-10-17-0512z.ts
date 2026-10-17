/**
 * Agent-tool fixes from the stream players' 2026-10-17 05:12Z reports (segment 04:11–05:12Z, build d75b5396;
 * progress.md 2026-10-17, "05:12Z reports, non-movement"):
 *  1. A fellow inside a town building far off gets map coordinates on the fellows line ("251 m S, up 51 m" read as
 *     stale while Bulwark really was at the Holtburg scrivener's).
 *  2. filter=junk appraises unknown candidates first, so attuned ones (Attuned 114, appraisal-only) are left out.
 *  3. A fellow-aggro / aggro read late about a monster now well past its range is dropped.
 *  4. raise times=N that can't pay for even one says so; amount= is times=.
 *  5. A lifestone use waits for the bind line and says "linked" (or that no bind was heard).
 *  6. A repeat cast already under its until_health says so plainly instead of "0 times".
 * Each drives the shipped AgentApi / tools code (fake host: tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { filterInventory, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { TOOLS, TOOL_CALLER, withArgAliases, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const FELLOW = 0x50000002;
const fellows = () => [{ guid: FELLOW, name: 'Claude Bulwark', health: { cur: 188, max: 188 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];

/** Run the fake clock (host time and timers) until `p` answers, at most `ms`. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('1. a far fellow inside a town building gets map coordinates', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.fellows = fellows;
  });
  afterEach(() => vi.useRealTimers());

  it('Bulwark in the scrivener building 0xA9B30103, ~150 m S: coordinates and "inside a building"', () => {
    host.cellSealed = (c: number) => (c & 0xffff) >= 0x100 && false;
    host.add({ guid: FELLOW, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0xa9b30103, x: 82, y: 60, z: 145 });
    const f = api.observe().fellows![0];
    expect(f.dist).toBeGreaterThan(140);
    expect(f.coords).toMatch(/^\d+\.\dN, \d+\.\dE inside a building$/);
    expect(formatObservation(api.observe())).toMatch(/fellows: Claude Bulwark 100% HP, 15\d m S, up 51 m, at \d+\.\dN, \d+\.\dE inside a building/);
  });

  it('out on the landscape: coordinates, no "inside"', () => {
    host.add({ guid: FELLOW, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0xa9b30019, x: 82, y: 60 });
    expect(api.observe().fellows![0].coords).toMatch(/^\d+\.\dN, \d+\.\dE$/);
  });

  it('a sealed (dungeon) cell gets none, and a fellow near you gets none', () => {
    host.cellSealed = () => true;
    host.add({ guid: FELLOW, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0xa9b30103, x: 82, y: 60 });
    expect(api.observe().fellows![0].coords).toBeUndefined();
    host.cellSealed = () => false;
    host.objs.get(FELLOW)!.cell = 0xa9b40019;
    host.objs.get(FELLOW)!.y = 22;
    expect(api.observe().fellows![0].coords).toBeUndefined();
  });
});

describe('2. filter=junk leaves attuned items out, appraising unknown ones first', () => {
  let host: FakeHost;
  let api: AgentApi;
  const MNEMO = 0x8000b334, OIL = 0x800035be;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [
      { guid: MNEMO, name: 'A Small Mnemosyne', where: 'main pack', itemType: 0x80, value: 0 },
      { guid: OIL, name: 'Oil of Rendering', where: 'main pack', itemType: 0x80, value: 0 },
    ];
    const blank = { float: {}, string: {}, bool: {}, did: {}, spells: [] };
    host.appraisalDatas.set(MNEMO, { int: { 114: 1 }, ...blank });
    host.appraisalDatas.set(OIL, { int: {}, ...blank });
  });
  afterEach(() => vi.useRealTimers());

  it('before any appraisal both read as junk; junkChecked appraises them quietly and drops the attuned one', async () => {
    expect(filterInventory(api.inventory(), 'junk').items.map((i) => i.guid)).toEqual([MNEMO, OIL]);
    const items = await api.junkChecked();
    expect(host.appraiseCalls).toEqual([{ guid: MNEMO, quiet: true }, { guid: OIL, quiet: true }]);
    expect(filterInventory(items, 'junk').items.map((i) => i.guid)).toEqual([OIL]);
  });

  it('waits for appraisals that answer later, at most JUNK_APPRAISE_MS', async () => {
    const real = host.appraisalData;
    let open = false;
    host.appraisalData = (g: number) => (open ? real(g) : null);
    setTimeout(() => { open = true; }, 800);
    const p = api.junkChecked();
    await vi.advanceTimersByTimeAsync(1200);
    const items = await p;
    expect(filterInventory(items, 'junk').items.map((i) => i.guid)).toEqual([OIL]);
  });

  it('ac_inventory filter=junk calls junkChecked (an older page without it gets the plain list)', async () => {
    const calls: string[] = [];
    const c: ToolCaller = {
      notice: null,
      async call<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === 'junkChecked') return [{ guid: OIL, name: 'Oil of Rendering', where: 'main pack', itemType: 0x80, value: 0 }] as T;
        if (method === 'packSlots') return null as T;
        return [] as T;
      },
    };
    const out = await TOOL_CALLER.run(c, () => tool('ac_inventory').run({ filter: 'junk' }));
    expect(calls[0]).toBe('junkChecked');
    expect(out.text).toMatch(/1 junk item/);
    expect(out.text).not.toMatch(/Mnemosyne/);
    const old: ToolCaller = { notice: null, async call<T>(method: string): Promise<T> { calls.push(method); if (method === 'junkChecked') throw new Error('unknown agent method: junkChecked'); return (method === 'packSlots' ? null : []) as T; } };
    calls.length = 0;
    await TOOL_CALLER.run(old, () => tool('ac_inventory').run({ filter: 'junk' }));
    expect(calls).toEqual(['junkChecked', 'inventory', 'packSlots']);
    calls.length = 0;
    await TOOL_CALLER.run(c, () => tool('ac_inventory').run({ filter: 'weapon' }));
    expect(calls[0]).toBe('inventory');
  });
});

describe('3. a late fellow-aggro / aggro about a monster now far off is dropped', () => {
  let host: FakeHost;
  let api: AgentApi;
  const MOSS = 0x80002c6e;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.fellows = fellows;
    host.add({ guid: FELLOW, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 36 });
    host.add({ guid: MOSS, name: 'Mudlurk Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 44 });
  });
  afterEach(() => vi.useRealTimers());

  const late = async (type: 'fellow-aggro' | 'aggro'): Promise<number> => {
    const p = api.waitFor({ types: [type], sinceSeq: 0 }, 50);
    await vi.advanceTimersByTimeAsync(100);
    return (await p).length;
  };

  it('8 m from the fellow when raised, 140 m off 25 s later: not delivered', async () => {
    api.push('fellow-aggro', 'Mudlurk Mosswart #80002c6e (level not known yet) is coming at your fellow Claude Bulwark, 8 m from them (running at them); Claude Bulwark is 16 m N of you, 100% health', MOSS, undefined, FELLOW);
    host.t += 25_000;
    host.objs.get(MOSS)!.y = 176;
    expect(await late('fellow-aggro')).toBe(0);
  });

  it('still near the fellow 25 s later: delivered; and read at once it is delivered wherever the monster is', async () => {
    api.push('fellow-aggro', 'Mudlurk Mosswart … coming at your fellow Claude Bulwark; Claude Bulwark is 16 m N of you, 100% health', MOSS, undefined, FELLOW);
    host.t += 25_000;
    host.objs.get(MOSS)!.y = 50;
    expect(await late('fellow-aggro')).toBe(1);
  });

  it('an aggro at you: dropped once the monster is past AGGRO_RANGE_M + margin', async () => {
    api.push('aggro', 'Mudlurk Mosswart is coming at you', MOSS);
    host.t += 10_000;
    host.objs.get(MOSS)!.y = 20 + AgentApi.AGGRO_RANGE_M + AgentApi.THREAT_GONE_MARGIN_M + 5;
    expect(await late('aggro')).toBe(0);
    host.objs.get(MOSS)!.y = 20 + AgentApi.AGGRO_RANGE_M;
    expect(await late('aggro')).toBe(1);
  });
});

describe('4. raise times=: as many as the XP covers, and says when not even one', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { host = new FakeHost(); api = new AgentApi(host); });

  it('XP for two of ten: two raises, then why it stopped', () => {
    host.xp = 50;
    const r = api.raise('Heavy Weapons', 10);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Heavy Weapons 77 → 79 \(2 raises: 20 \+ 20 = 40 XP\); stopped: raising Heavy Weapons costs 20 XP; you have 10 unassigned$/);
  });

  it('XP for none of ten: says the first alone costs more', () => {
    host.xp = 10;
    const r = api.raise('Heavy Weapons', 10);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('raising Heavy Weapons costs 20 XP; you have 10 unassigned (not even one of the 10 raises asked: times= raises as many as your XP covers, and the next raise alone costs more)');
    expect(api.raise('Heavy Weapons', 1).message).toBe('raising Heavy Weapons costs 20 XP; you have 10 unassigned');
  });

  it('amount= is times=', () => {
    expect(withArgAliases(tool('ac_raise'), { stat: 'Melee Defense', amount: 5 })).toEqual({ stat: 'Melee Defense', times: 5 });
    expect(withArgAliases(tool('ac_raise'), { skill: 'Healing', amount: 2 })).toEqual({ stat: 'Healing', times: 2 });
  });
});

describe('5. using a lifestone reports the bind', () => {
  let host: FakeHost;
  let api: AgentApi;
  const STONE = 0x7a9b404f;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.add({ guid: STONE, name: 'Life Stone', itemType: 0x80, objectDescFlags: 0x4000, x: 80, y: 21.5 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a buff line first, the attune line ~6 s later: both, and "linked"', async () => {
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      setTimeout(() => api.pushChat('Pumpkin Buffer cast Incantation of Bludgeoning Protection Other on you', 0x07), 300);
      setTimeout(() => api.pushChat('You have attuned your spirit to this Lifestone. You will resurrect here after you die.', 0x07), 5700);
      return true;
    };
    const r = (await settle(api, host, api.use(STONE), 30_000))!;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Pumpkin Buffer cast/);
    expect(r.message).toMatch(/You have attuned your spirit to this Lifestone/);
    expect(r.message).toMatch(/linked to Life Stone: you will resurrect here when you die/);
  });

  it('no bind line: says so, and how to retry', async () => {
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      setTimeout(() => api.pushChat('Pumpkin Buffer cast Incantation of Bludgeoning Protection Other on you', 0x07), 300);
      return true;
    };
    const r = (await settle(api, host, api.use(STONE), 30_000))!;
    expect(r.message).toMatch(/no word of a bind within 10 s/);
    expect(r.message).not.toMatch(/linked to/);
  });

  it('"You have moved too far!" ends the wait with no bind claimed', async () => {
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      setTimeout(() => api.pushChat('You have moved too far!', 0x1a), 5500);
      return true;
    };
    const r = (await settle(api, host, api.use(STONE), 30_000))!;
    expect(r.message).toMatch(/You have moved too far!/);
    expect(r.message).not.toMatch(/linked to|no word of a bind/);
  });
});

describe('6. a repeat cast already under its until_health', () => {
  let host: FakeHost;
  let api: AgentApi;
  const DREAD = 0x80001a17;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
  });
  afterEach(() => vi.useRealTimers());

  // Since 2026-10-17 19:18Z (Viamontian Lab, a refusal at 38% among three Footmen, death 15 s later): a call never comes
  // back empty for a threshold the caller set. One cast is made, then the repeat ends on until_health, saying so.
  it('17% under 60%: one cast, then the repeat ends on your own until_health, said so', async () => {
    host.me.health = { current: 28, max: 162 };
    let r: AgentResult | undefined;
    void api.castRepeat('Flame Bolt I', DREAD, { untilHealth: 0.6 }).then((x) => { r = x; });
    for (let t = 0; t < 20_000 && !r; t += 200) await vi.advanceTimersByTimeAsync(200);
    expect(host.sent.filter((s) => s.startsWith('cast 27'))).toHaveLength(1);
    expect(r!.message).toMatch(/^cast Flame Bolt I at Dread Mu-miyah 1 time \(repeat\); stopped: your own until_health: your health was already under the 60% you set when this began \(28\/162\), so one cast was made and the repeat ended there/);
    expect(api.observe().me?.task).toBeNull();
  });

  it('the default limit is named as the default; until_health=0 casts at any health', async () => {
    host.me.health = { current: 5, max: 50 };
    let r: AgentResult | undefined;
    void api.castRepeat('Flame Bolt I', DREAD, {}).then((x) => { r = x; });
    for (let t = 0; t < 20_000 && !r; t += 200) await vi.advanceTimersByTimeAsync(200);
    expect(r!.message).toMatch(/your health was already under the 60% default when this began/);
    host.sent = [];
    void api.castRepeat('Flame Bolt I', DREAD, { untilHealth: 0 });
    await vi.advanceTimersByTimeAsync(300);
    expect(host.sent.some((s) => s.startsWith('cast 27'))).toBe(true);
  });
});
