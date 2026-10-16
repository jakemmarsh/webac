/**
 * The stream players' reports from the Sclavus camp (end-of-retail local ACE, segment 13:26–13:52 UTC 2026-10-16, build
 * 71a232b9; reports stream/reports/{mage-…T13-53-09-073Z,soldier-…T13-52-23-222Z}-seg1.md, transcripts
 * stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl, page logs mage.log / soldier.log, chat logs *.chat.log):
 *  1. "Hit by, but not placed: Essa Sclavus" in the open (cell 0xA3AD0033, 13:50): four Essas listed 8.7–11.2 m off,
 *     standing still while their javelins nicked Bulwark for 0–2 (they stayed put when he backed 30 m south). The
 *     missile-wielder check read host.objects(), which the page fills only with objects in the world; a wielded
 *     javelin is out of it (CreateObject with a physics parent), so no monster ever counted as a shooter live.
 *  2. stay_with stopped "hasn't moved for 12 s" while Arcanist rebuffed: her spell words came, then 66 s of thinking
 *     and /f (13:39:48–13:41:14); and with her standing inside the 15 m leash, but past 11 m.
 *  3. Auras cast at Bulwark 59 m off: a bare "Out of Range!" twice (they reach 25 m).
 *  4. `use item="Health Potion"`: "no object matching" with a Potion of Healing in the pack.
 *  5. `follow distance=` was refused (it is within=).
 * Each drives the shipped AgentApi / tools code against the fake host (tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, nameMatchScore } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { TOOL_BY_NAME, TOOL_CALLER, inputSchema } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { FakeHost } from './_harness/agentFake.ts';

/** Run the page's ticks every 100 ms until the promise settles (or `ms` pass); `each` runs before every tick. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) {
    each?.();
    host.t += 100;
    vi.advanceTimersByTime(100);
    host.physics(100);
    api.tick();
    await Promise.resolve(); await Promise.resolve();
  }
  return out;
}

describe('1. an Essa Sclavus throwing javelins from 9–15 m is placed (cell 0xA3AD0033, 13:50 UTC)', () => {
  // The guids and distances of Bulwark's last observe: four Essas 8.7, 9.8, 10.3, 11.2 m N.
  const ESSAS = [[0x80005ab9, 8.7], [0x80007315, 9.8], [0x8000714f, 10.3], [0x80007152, 11.2]] as const;
  const JAVELIN = 0x80005aba;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    for (const [g, d] of ESSAS) host.add({ guid: g, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 20 + d, level: 30 });
    // The javelin the first Essa holds (ACE-World wielded treasure 169: Javelin wcid 320, ItemType MissileWeapon 256).
    host.add({ guid: JAVELIN, name: 'Javelin', itemType: 0x100, objectDescFlags: 0, cell: null, wielderId: 0x80005ab9 });
    // As the page lists them: objects() only what is in the world (main.ts skips outOfWorld), wielded() what is held.
    const all = (): AgentHostObject[] => [...host.objs.values()];
    host.objects = () => all().filter((o) => !o.wielderId).values();
    (host as unknown as { wielded: () => Iterable<AgentHostObject> }).wielded = () => all().filter((o) => !!o.wielderId);
  });
  afterEach(() => vi.useRealTimers());

  it('the transcript\'s javelin nicks go to the Essa holding the javelin, 8.7 m off; observe says ATTACKING YOU, not "not placed"', () => {
    api.pushChat('Reckless! Essa Sclavus nicks your lower leg for 2 points of piercing damage!', 0x15);
    api.pushChat('Reckless! Essa Sclavus nicks your upper arm for 1 point of piercing damage!', 0x15);
    expect([...api.attackersOfMe()]).toEqual([[0x80005ab9, 2]]);
    expect(api.attackersUnplaced()).toEqual([]);
    expect(formatObservation(api.observe())).not.toMatch(/not placed/);
  });

  it('read from objects() alone (as before) the same lines were "not placed": the held javelin is not in it', () => {
    (host as unknown as { wielded?: unknown }).wielded = undefined;
    api.pushChat('Essa Sclavus nicks your lower leg for 1 point of piercing damage!', 0x15);
    expect(api.attackersUnplaced()).toEqual([{ name: 'Essa Sclavus', count: 1 }]);
  });

  it('with no missile weapon held, an Essa 8.7 m off is still beyond a swing (8 m): unplaced, as before', () => {
    host.objs.get(JAVELIN)!.itemType = 0x1; // a Spear
    api.pushChat('Essa Sclavus nicks your lower leg for 1 point of piercing damage!', 0x15);
    expect(api.attackersUnplaced()).toEqual([{ name: 'Essa Sclavus', count: 1 }]);
  });
});

describe('2. stay_with waits on a fellow in a round of buffs, and one standing inside the leash is beside you', () => {
  const ARCANIST = 0x500000a3;
  const vitals = { cur: 40, max: 50 };
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 18 });
    host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('her words 2–10 s apart then 24 s of thinking between casts (13:39:48–13:40:08 UTC): the walk waits, then goes on with her', async () => {
    // Her chants as Bulwark heard them, from the moment his walk stopped for her (13:39:46): +2, +12, +20, +22 s, then
    // the next at +46 s (her 66 s think shortened to 24 s), then she comes north.
    const words = [2000, 12_000, 20_000, 22_000, 46_000];
    let stoppedAt: number | null = null;
    const her = (): void => {
      if (stoppedAt === null && !host.keys.has('KeyW') && host.me.y - 18 > 15) stoppedAt = host.t;
      if (stoppedAt === null) return;
      const since = host.t - stoppedAt;
      if (words.some((w) => since >= w && since < w + 100)) api.pushChat('Claude Arcanist says, "Helkas Quareth"', 0x11);
      if (since > 50_000) host.objs.get(ARCANIST)!.y += 0.5;
    };
    const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, her);
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(r!.message).not.toMatch(/hasn't moved/);
    expect(log).toMatch(/Claude Arcanist is casting; waiting on/);
  });

  it('standing still with no words at all still ends it "hasn\'t moved" (idle is not busy)', async () => {
    const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 60_000);
    expect(r!.message).toMatch(/hasn't moved for 1\d s/);
  });

  it('she comes to 13 m back (inside the 15 m leash, past 11 m) and stands: the walk goes on (was "hasn\'t moved")', async () => {
    let stopAt: number | null = null;
    let stoodAt: number | null = null;
    const her = (): void => {
      const a = host.objs.get(ARCANIST)!;
      if (stopAt === null && !host.keys.has('KeyW') && host.me.y > 40) stopAt = host.me.y - 13;
      if (stopAt === null) { a.y += 0.25; return; }
      if (a.y < stopAt) { a.y = Math.min(a.y + 0.4, stopAt); return; }
      stoodAt ??= host.t;
      if (host.t - stoodAt > 6000) a.y += 0.38;
    };
    const r = await settle(api, host, api.walkTo('70m north', { stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 120_000, her);
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(log).toMatch(/Claude Arcanist caught up \(13 m\); on/);
  });
});

describe('3. a spell cast farther than it reaches is refused before it goes, with the metres to close', () => {
  const BULWARK = 0x500000a4;
  const AURA = { id: 6003, name: 'Aura of Defender Other V', school: 'Item', level: 5, range: 25 };
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.spells = () => [AURA, { id: 2, name: 'Heal Other V', school: 'Life', level: 5, range: 44 }];
    host.me.combatMode = 'magic';
  });
  afterEach(() => vi.useRealTimers());

  it('Bulwark 58.7 m off (13:46 UTC): not sent; says it reaches 25 m, he is 58.7 m away, walk 35 m closer', async () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 20 + 58.7 });
    const r = await settle(api, host, api.cast('Aura of Defender Other V', 'Claude Bulwark'), 5000);
    expect(host.sent.filter((s) => s.startsWith('cast'))).toEqual([]);
    expect(r).toEqual({ ok: false, message: 'Aura of Defender Other V not cast: out of range: Aura of Defender Other V reaches 25 m for you (longer as your Item ranks grow); Claude Bulwark is 58.7 m away: walk 35 m closer (ac_walk_to target=#500000a4 within=23)' });
  });

  it('inside the reach it goes out; the server\'s own "Out of Range!" refusal gets the same note', async () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 20 + 24.5 });
    host.cast = (id, t) => {
      host.sent.push(`cast ${id} ${t?.toString(16)}`);
      setTimeout(() => { api.pushChat('Casting Aura of Defender Other V', 0x00); api.pushUseDone(0x3f8, 'MissileOutOfRange', 'Out of Range!'); }, 300);
      return true;
    };
    const r = await settle(api, host, api.cast('Aura of Defender Other V', 'Claude Bulwark'), 10_000);
    expect(host.sent).toContain('cast 6003 500000a4');
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain('the server refused it: Out of Range! (MissileOutOfRange)');
    expect(r?.message).toContain('(Aura of Defender Other V reaches 25 m for you (longer as your Item ranks grow); Claude Bulwark is 24.5 m away)');
  });

  it('a metre of slack: 25.8 m for a 25 m reach still goes to the server', async () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 20 + 25.8 });
    await settle(api, host, api.cast('Aura of Defender Other V', 'Claude Bulwark'), 5000);
    expect(host.sent).toContain('cast 6003 500000a4');
  });
});

describe('4. item names: every word in any order, with synonyms ("Health Potion" for the Potion of Healing)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [
      { guid: 0x80001e78, name: 'Potion of Healing', where: 'main pack', itemType: 0x80, stack: 12 },
      { guid: 0x80001e90, name: 'Mana Draught', where: 'main pack', itemType: 0x80 },
      { guid: 0x80001ea0, name: 'Healing Kit', where: 'main pack', itemType: 0x80 },
    ];
  });
  afterEach(() => vi.useRealTimers());

  it('the scores: a synonym match ranks under every closer one', () => {
    expect(nameMatchScore('Health Potion', 'Potion of Healing')).toBe(1);
    expect(nameMatchScore('mana potion', 'Mana Draught')).toBe(1);
    expect(nameMatchScore('Elixir of Stamina', 'Stamina Potion')).toBe(1);
    expect(nameMatchScore('potion healing', 'Potion of Healing')).toBe(2);
    expect(nameMatchScore('Health Potion', 'Mana Draught')).toBe(0);
  });

  it('use item="Health Potion" uses the Potion of Healing (Bulwark, 13:49 UTC: "no object matching")', async () => {
    const tool = TOOL_BY_NAME.get('ac_use')!;
    const calls: Array<[string, unknown[]]> = [];
    const caller = { notice: null, call: async <T,>(m: string, a: unknown[]) => { calls.push([m, a]); return { ok: true, message: 'x' } as T; } };
    await TOOL_CALLER.run(caller, () => tool.run(parseCliArgs(tool, ['item=Health Potion'])));
    expect(calls[0][1][0]).toBe('Health Potion');
    expect(api.resolve('Health Potion', 'inventory')).toBe(0x80001e78);
    expect(api.resolve('Health Potion')).toBe(0x80001e78);
  });

  it('two different items only loosely matched: names both instead of guessing', async () => {
    host.inv.push({ guid: 0x80001eb0, name: 'Healing Elixir', where: 'main pack', itemType: 0x80 });
    const r = await settle(api, host, api.use('Health Potion'), 2000);
    expect(r).toEqual({ ok: false, message: '"Health Potion" could be Potion of Healing #80001e78, Healing Elixir #80001eb0: name one (or its #id)' });
    expect(host.sent).toEqual([]);
  });

  it('nothing matches: lists what you carry sharing a word', async () => {
    const r = await settle(api, host, api.use('Stamina Potion'), 2000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toBe('no object matching "Stamina Potion" nearby or in your inventory; you carry Potion of Healing #80001e78, Mana Draught #80001e90: name one (or its #id)');
  });
});

describe('5. distance= is within= for follow and walk_to', () => {
  it('the CLI takes follow distance=20 and walk_to distance=5 as numbers, sent as within', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const caller = { notice: null, call: async <T,>(m: string, a: unknown[]) => { calls.push([m, a]); return { ok: true, message: 'x' } as T; } };
    const follow = TOOL_BY_NAME.get('ac_follow')!;
    const walk = TOOL_BY_NAME.get('ac_walk_to')!;
    await TOOL_CALLER.run(caller, () => follow.run(parseCliArgs(follow, ['target=Claude Bulwark', 'distance=20'])));
    await TOOL_CALLER.run(caller, () => walk.run(parseCliArgs(walk, ['target=Claude Bulwark', 'distance=5'])));
    expect(calls[0]).toEqual(['follow', ['Claude Bulwark', { within: 20, durationMs: null }]]);
    expect((calls[1][1][1] as { within: number }).within).toBe(5);
    // within= wins when both are given; the MCP schema lists distance as a number.
    await TOOL_CALLER.run(caller, () => follow.run(parseCliArgs(follow, ['target=Claude Bulwark', 'within=8', 'distance=20'])));
    expect((calls[2][1][1] as { within: number }).within).toBe(8);
    expect((inputSchema(follow).properties as Record<string, { type: string }>).distance.type).toBe('number');
  });
});
