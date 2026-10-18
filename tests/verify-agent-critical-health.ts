/**
 * Claude Arcanist nearly died (end of retail, local ACE, build 27c4bd37, 2026-10-16 19:57–19:59Z): a Grievver/Olthoi
 * pack hit him from 19:57:55, he started `walk_to 54.7N 32.9E stay_with=Claude Bulwark flee=true` at 19:58:04 and went
 * from 146 to 26 HP while the walk ran on ("still in progress") and his `wait types=task-done,fellow-low,death` slept;
 * it woke only on the walk's end at 19:58:37, and `cast spell="Heal Self"` then answered "fits 4 of your spells: name
 * one" (a 4 s round trip at 26 HP). Now: a walk (flee too) stops at critical health and asks "heal or keep running?",
 * every wait wakes on critical health and death whatever its types, and a family named without a level casts the
 * highest level you can land. Driven through the real AgentApi on the fake host, and the real tool table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { TOOLS } from '../tools/ac-agent/tools.ts';
import { HOSTED_GUIDE } from '../tools/ac-agent/hostedGuide.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(t); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('critical health during a flee walk and a wait', () => {
  let host: FakeHost;
  let api: AgentApi;
  const GRIEVVER = 0x80004201;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.wall = () => false;
    host.me.health = { current: 146, max: 146 };
    host.add({ guid: GRIEVVER, name: 'Grievver', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 16 });
    run(api, host, 200);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** A Grievver hit for `n` (the chat line and the health it takes). */
  const hit = (n: number): void => {
    host.me.health = { ...host.me.health, current: Math.max(0, host.me.health.current - n) };
    api.pushChat(`The Grievver bites your upper leg for ${n} points of piercing damage!`, 0x15);
  };

  it('a flee walk keeps running through hits above the critical line, then stops below it and says heal or keep running', async () => {
    const p = api.walkTo('200m north', { within: 1, flee: true, onAwayKeepGoing: true });
    // 12 damage a second: 146 → 26 over ten seconds (the 19:58:04–19:58:37 fall, compressed).
    let healthAtCheck = 0;
    const r = (await settle<AgentResult>(api, host, p, 30_000, (t) => {
      if (t % 1000 === 0) hit(12);
      if (t === 4000) healthAtCheck = host.me.health.current;
    }))!;
    // Still running at 4 s (98/146, 67%): flee keeps going while hit, as asked.
    expect(healthAtCheck).toBeGreaterThan(146 * 0.4);
    expect(r).toMatchObject({ ok: false, critical: true });
    expect(r.message).toMatch(/^stopped [\d.]+ m short: health (\d+)\/146 \(\d+%\), below the critical 40%; on you: Grievver.*Heal or keep running\? Heal now \(ac_cast spell="Heal Self" target=self.*the same ac_walk_to flee=true again keeps going until health falls another 10%/s);
    const left = Number(/health (\d+)\/146/.exec(r.message)![1]);
    // Stopped at the first tick under 40% (58.4), not run down to 26.
    expect(left).toBeLessThan(146 * 0.4);
    expect(left).toBeGreaterThan(146 * 0.4 - 13);
    expect([...host.keys].filter((k) => /^Key[WSAD]$/.test(k))).toEqual([]);
  });

  it('a flee walk asked again under the line runs on until health falls another 10% of max', async () => {
    host.me.health = { current: 50, max: 146 };
    run(api, host, 200);
    const p = api.walkTo('200m north', { within: 1, flee: true, onAwayKeepGoing: true });
    const r = (await settle<AgentResult>(api, host, p, 30_000, (t) => { if (t % 1000 === 500) hit(5); }))!;
    expect(r.critical).toBe(true);
    expect(r.message).toMatch(/health (\d+)\/146 \(\d+%\), 10% of your health lower than when this walk began/);
    // 50/146 (34%) − 10% = 24%: 45 and 40 ran on, 35 (24%) stopped it.
    expect(host.me.health.current).toBe(35);
  });

  it('one hit of 20%+ that leaves you under 60% stops a flee walk too', async () => {
    host.me.health = { current: 100, max: 146 };
    run(api, host, 200);
    const p = api.walkTo('200m north', { within: 1, flee: true, onAwayKeepGoing: true });
    const r = (await settle<AgentResult>(api, host, p, 10_000, (t) => { if (t === 1000) hit(35); }))!;
    expect(r.critical).toBe(true);
    expect(r.message).toMatch(/health 65\/146 \(45%\), one hit took 35 \(24%\)/);
  });

  it('a wait for task-done,fellow-low,death (no vitals-low) during the flee walk wakes at the critical line, saying so', async () => {
    void api.walkTo('200m north', { within: 1, flee: true, onAwayKeepGoing: true });
    const w = api.wait({ types: ['task-done', 'fellow-low', 'death'] }, 60_000);
    const evs = (await settle(api, host, w, 30_000, (t) => { if (t % 1000 === 0) hit(12); }))!;
    // Woken by the walk stopping at the line (it says why), not after a run down to 26.
    expect(evs.map((e) => e.type)).toEqual(['task-done']);
    expect(evs[0].text).toMatch(/health (\d+)\/146 \(\d+%\), below the critical 40%.*Heal or keep running\?/);
    expect(host.me.health.current).toBeGreaterThan(146 * 0.4 - 13);
    // The critical alarm follows it for the next wait.
    const next = (await settle(api, host, api.wait({ types: ['task-done'] }, 1000), 2000))!;
    expect(next.map((e) => e.text).join('\n')).toMatch(/CRITICAL, below 40%/);
  });

  it('a wait for task-done,fellow-low,death wakes on critical health while something else runs on through the hits (a routine walk)', async () => {
    void api.walkTo('200m north', { within: 1, stopWhenAttacked: false });
    const w = api.wait({ types: ['task-done', 'fellow-low', 'death'] }, 60_000);
    const evs = (await settle(api, host, w, 30_000, (t) => { if (t % 1000 === 0) hit(12); }))!;
    expect(evs.map((e) => e.type)).toEqual(['vitals-low']);
    expect(evs[0].text).toMatch(/^health \d+\/146 \(\d+%\): CRITICAL, below 40%\. Heal now .* this wakes every wait$/);
    // The 60% crossing on the way (not asked for) did not wake it: only the critical line did.
    expect(host.me.health.current).toBeLessThan(146 * 0.4);
    expect(host.me.health.current).toBeGreaterThan(146 * 0.4 - 13);
  });

  it('a chat_match wait wakes on critical health and on death', async () => {
    const w = api.wait({ chatMatch: 'Bulwark says' }, 60_000);
    const evs = (await settle(api, host, w, 5000, (t) => { if (t === 500) hit(100); }))!;
    expect(evs.map((e) => e.type)).toContain('vitals-low');
    const w2 = api.wait({ types: ['tell'] as never }, 60_000);
    const evs2 = (await settle(api, host, w2, 5000, (t) => { if (t === 500) { host.me.health = { ...host.me.health, current: 0 }; host.me.dead = true; } }))!;
    expect(evs2.map((e) => e.type)).toContain('death');
  });

  it('critical alarms again at each further 10% fall, and is stale once healed back over the line', async () => {
    hit(90); // 56/146 (38%)
    run(api, host, 200);
    hit(16); // 40 (27%): more than 10% lower
    run(api, host, 200);
    const crits = api.eventsSince(0).filter((e) => /CRITICAL/.test(e.text));
    expect(crits).toHaveLength(2);
    host.me.health = { current: 120, max: 146 };
    run(api, host, 200);
    const w = api.wait({ types: ['death'], sinceSeq: 0 }, 1000);
    const evs = (await settle(api, host, w, 2000))!;
    expect(evs.filter((e) => /CRITICAL/.test(e.text))).toEqual([]);
  });

  it('a run into a portal does not stop at critical health (getting through is the escape)', async () => {
    host.me.health = { current: 30, max: 146 };
    run(api, host, 200);
    host.add({ guid: 0x7adb5036, name: 'Dungeon Fern', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 32 });
    const p = api.walkTo(0x7adb5036, { within: 0.5, enterPortal: true, flee: true });
    const r = (await settle<AgentResult>(api, host, p, 20_000, (t) => { if (t % 1000 === 0) hit(4); }));
    expect(r?.critical).toBeUndefined();
    expect(Math.hypot(host.me.x - 80, host.me.y - 32)).toBeLessThan(1.5);
  });

  it('the tool texts say it', () => {
    const walk = TOOLS.find((t) => t.name === 'ac_walk_to')!;
    expect(JSON.stringify(walk)).toMatch(/stops at critical health \(under 40%/);
    const wait = TOOLS.find((t) => t.name === 'ac_wait')!;
    expect(JSON.stringify(wait)).toMatch(/always wakes on your death and on your health reaching the critical line/);
    const cast = TOOLS.find((t) => t.name === 'ac_cast')!;
    expect(JSON.stringify(cast)).toMatch(/A name without a level \(\\"Heal Self\\"\) casts the highest level of it you know that you can land/);
    expect(HOSTED_GUIDE).toMatch(/A flee walk stops at critical health \("Heal or keep running\?"\)/);
  });
});

describe('cast "Heal Self" with no level', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Arcanist's book at 19:58: Heal Self I, III, IV, V; Life Magic 220.
    host.spells = () => [
      { id: 6, name: 'Heal Self I', school: 'Life Magic', level: 1, power: 1, self: true },
      { id: 1160, name: 'Heal Self III', school: 'Life Magic', level: 3, power: 100, self: true },
      { id: 1161, name: 'Heal Self IV', school: 'Life Magic', level: 4, power: 150, self: true },
      { id: 1162, name: 'Heal Self V', school: 'Life Magic', level: 5, power: 200, self: true },
      { id: 1163, name: 'Heal Self VI', school: 'Life Magic', level: 6, power: 250, self: true },
      { id: 27, name: 'Flame Bolt I', school: 'War Magic', level: 1, power: 1 },
    ];
    host.skills.set(33, { base: 220, buffed: 220 });
    host.me.combatMode = 'magic';
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const castNow = async (spell: string): Promise<AgentResult> => {
    const p = api.cast(spell, null);
    let out: AgentResult | null = null;
    void p.then((x) => { out = x; });
    // The cast goes out at once (no "name one" round trip); the reply line ends it.
    const t0 = host.t;
    for (let i = 0; i < 50 && !host.sent.some((s) => s.startsWith('cast ')) && !out; i++) { run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
    expect(out, JSON.stringify(out)).toBeNull();
    expect(host.t - t0).toBeLessThan(1000);
    expect(host.sent.filter((s) => s.startsWith('cast '))).toHaveLength(1);
    api.pushChat('You cast Heal Self V and restore 90 points of your health.', 0x1c);
    for (let i = 0; i < 20 && !out; i++) { run(api, host, 200); await Promise.resolve(); await Promise.resolve(); }
    return out!;
  };

  it('casts the highest level you can land (V at 220 vs 200; VI at 250 is too far), naming why', async () => {
    const r = await castNow('Heal Self');
    expect(host.sent).toContain('cast 1162 self');
    expect(r.message).toMatch(/^casting Heal Self V on yourself \(no level named: the highest of yours you can land, \d+% to land; Heal Self VI is higher but \d+% to land \(your Life Magic 220 against its 250\): name it to try it\)/);
  });

  it('a named level is cast as named, with no note', async () => {
    const r = await castNow('Heal Self IV');
    expect(host.sent).toContain('cast 1161 self');
    expect(r.message).toMatch(/^casting Heal Self IV on yourself\n/);
  });

  it('none 75% to land: the likeliest, said so', async () => {
    host.skills.set(33, { base: 40, buffed: 40 });
    const book = host.spells().filter((s) => s.id !== 6);
    host.spells = () => book;
    const r = await castNow('Heal Self');
    expect(host.sent).toContain('cast 1160 self');
    expect(r.message).toMatch(/no level named: none of yours is 75% to land, so the likeliest/);
  });
});
